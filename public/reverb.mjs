export const FX_PARAMETERS=Object.freeze({
  decay:{label:'衰减',min:.5,max:12,step:.1,initial:5,unit:'s'},
  predelay:{label:'预延迟',min:0,max:150,step:1,initial:25,unit:'ms'},
  tone:{label:'明暗',min:800,max:16000,step:100,initial:6500,unit:'Hz'},
  shimmer:{label:'Shimmer',min:0,max:100,step:1,initial:35,unit:'%'},
  interval:{label:'音程',min:-12,max:12,step:1,initial:12,unit:'半音'},
  return:{label:'返回',min:0,max:100,step:1,initial:35,unit:'%'}
});
export const FX_DEFAULTS=Object.freeze(Object.fromEntries(Object.entries(FX_PARAMETERS).map(([key,p])=>[key,p.initial])));
export function validateParameter(name,value){
  const p=FX_PARAMETERS[name];
  if(!p||!Number.isFinite(value)||value<p.min||value>p.max||Math.abs(value/p.step-Math.round(value/p.step))>1e-7)
    throw new RangeError('效果参数超出范围');
  return value;
}
export function smooth(context,param,value,seconds=.04){
  const now=context.currentTime;
  if(param.cancelAndHoldAtTime)param.cancelAndHoldAtTime(now);
  else {const previous=param.value;param.cancelScheduledValues(now);param.setValueAtTime(previous,now);}
  param.linearRampToValueAtTime(value,now+seconds);
}
// Independent dense stereo reflections with −60 dB amplitude at `decay`.
// Energy normalization prevents longer tails becoming unintentionally louder.
export function impulseData(sampleRate,decay,seed=0x52e7){
  if(!Number.isFinite(sampleRate)||sampleRate<8000||sampleRate>192000||!Number.isFinite(decay)||decay<.1||decay>12)
    throw new RangeError('无效的混响脉冲参数');
  const length=Math.ceil(sampleRate*(decay*1.1+.02));
  return [0,1].map(channel=>{
    let state=(seed+channel*0x9e3779b9)>>>0,energy=0;
    const data=new Float32Array(length);
    for(let i=0;i<length;i++){
      state=(Math.imul(state,1664525)+1013904223)>>>0;
      const time=i/sampleRate;
      const envelope=Math.min(1,time/.012)*Math.exp(-Math.LN10*3*time/decay)*Math.min(1,(length-1-i)/(sampleRate*.02));
      data[i]=(state/2147483648-1)*envelope;energy+=data[i]*data[i];
    }
    const scale=1/Math.sqrt(energy||1);
    for(let i=0;i<length;i++)data[i]*=scale;
    return data;
  });
}
function impulse(context,decay,seed){
  const data=impulseData(context.sampleRate,decay,seed);
  const buffer=context.createBuffer(2,data[0].length,context.sampleRate);
  data.forEach((channel,index)=>buffer.copyToChannel(channel,index));return buffer;
}
class Hall {
  constructor(context,decay){
    this.context=context;this.input=context.createGain();this.output=context.createGain();
    this.current=this.make(decay,1);this.pending=null;this.timer=null;this.fading=false;this.disposed=false;
  }
  make(decay,gain){
    const node=this.context.createConvolver(),gate=this.context.createGain();
    node.normalize=false;node.buffer=impulse(this.context,decay);
    gate.gain.value=gain;this.input.connect(node);node.connect(gate);gate.connect(this.output);
    return {node,gate};
  }
  release(branch){this.input.disconnect(branch.node);branch.node.disconnect();branch.gate.disconnect();}
  setDecay(decay){
    this.pending=decay;
    if(!this.fading){clearTimeout(this.timer);this.timer=setTimeout(()=>this.replace(),140);}
  }
  replace(){
    if(this.disposed||this.pending===null)return;
    const next=this.make(this.pending,0);this.pending=null;this.previous=this.current;this.current=next;this.fading=true;
    smooth(this.context,this.previous.gate.gain,0,.18);smooth(this.context,next.gate.gain,1,.18);
    this.timer=setTimeout(()=>{
      // At most two kernels, even when decay is dragged rapidly.
      this.release(this.previous);this.previous=null;this.fading=false;
      if(this.pending!==null)this.replace();
    },220);
  }
  dispose(){
    this.disposed=true;clearTimeout(this.timer);
    this.release(this.current);if(this.previous)this.release(this.previous);
    this.input.disconnect();this.output.disconnect();
  }
}
export class ShimmerReverb {
  constructor(context,values=FX_DEFAULTS){
    this.context=context;this.values={...FX_DEFAULTS,...values};this.enabled=true;
    for(const [name,value]of Object.entries(this.values))validateParameter(name,value);
    this.input=context.createGain();this.output=context.createGain();
    this.gate=context.createGain();this.predelay=context.createDelay(.2);
    this.highpass=context.createBiquadFilter();this.highpass.type='highpass';this.highpass.frequency.value=120;this.highpass.Q.value=.5;
    this.hall=new Hall(context,this.values.decay);
    this.pitch=globalThis.WebDJPitchNative.create(context);this.pitch.setSemitones(this.values.interval);
    this.diffuser=context.createConvolver();this.diffuser.normalize=false;this.diffuser.buffer=impulse(context,.8,0xa83e);
    this.normal=context.createGain();this.shifted=context.createGain();
    this.tone=context.createBiquadFilter();this.tone.type='lowpass';this.tone.Q.value=.5;
    this.protection=context.createDynamicsCompressor();
    this.protection.threshold.value=-6;this.protection.knee.value=12;this.protection.ratio.value=12;
    this.protection.attack.value=.003;this.protection.release.value=.2;
    this.input.connect(this.gate);this.gate.connect(this.predelay);this.predelay.connect(this.highpass);this.highpass.connect(this.hall.input);
    this.hall.output.connect(this.normal);this.normal.connect(this.tone);
    // Pitch the tail and diffuse it again. Feed-forward keeps extreme settings
    // finite without a regenerative feedback loop on the performance output.
    this.hall.output.connect(this.pitch.input);this.pitch.output.connect(this.diffuser);
    this.diffuser.connect(this.shifted);this.shifted.connect(this.tone);
    this.tone.connect(this.protection);this.protection.connect(this.output);
    this.predelay.delayTime.value=this.values.predelay/1000;this.tone.frequency.value=this.values.tone;
    this.output.gain.value=this.values.return/100;this.mix(false);
  }
  mix(ramp=true){
    const angle=this.values.shimmer/100*Math.PI/2;
    const gains=[Math.cos(angle),Math.sin(angle)];
    [this.normal,this.shifted].forEach((node,i)=>ramp?smooth(this.context,node.gain,gains[i]):node.gain.value=gains[i]);
  }
  set(name,value){
    validateParameter(name,value);if(value===this.values[name])return;
    this.values[name]=value;
    if(name==='decay')this.hall.setDecay(value);
    else if(name==='predelay')smooth(this.context,this.predelay.delayTime,value/1000,.08);
    else if(name==='tone')smooth(this.context,this.tone.frequency,value);
    else if(name==='shimmer')this.mix();
    else if(name==='interval')this.pitch.setSemitones(value);
    else if(name==='return')smooth(this.context,this.output.gain,this.enabled?value/100:0);
  }
  setEnabled(enabled){
    this.enabled=Boolean(enabled);
    smooth(this.context,this.gate.gain,this.enabled?1:0);
    smooth(this.context,this.output.gain,this.enabled?this.values.return/100:0);
  }
  dispose(){
    this.hall.dispose();this.pitch.dispose();
    for(const node of [this.input,this.output,this.gate,this.predelay,this.highpass,this.diffuser,this.normal,this.shifted,this.tone,this.protection])node.disconnect();
  }
}
