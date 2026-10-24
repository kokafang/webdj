(()=>{
const STOP_FADE=1;
const END_FADE_LEAD=.08;

// Keep the instantaneous gain ourselves when replacing a future end ramp.
// Repeated hold/ramp edits must not inherit a scheduled target of zero as the
// current value and cut the last part of the fade short.
class StopEnvelope {
  constructor(context,param){this.context=context;this.param=param;this.points=[[context.currentTime,param.value]];}
  valueAt(time){
    let [start,from]=this.points[0];
    for(const [end,to]of this.points.slice(1)){
      if(time<end)return end===start?to:from+(to-from)*Math.max(0,(time-start)/(end-start));
      start=end;from=to;
    }
    return from;
  }
  set(to,seconds=0,delay=0){
    const time=this.context.currentTime,current=this.valueAt(time),param=this.param;
    param.cancelScheduledValues(time);param.setValueAtTime(current,time);
    const points=[[time,current]];
    const ramp=(value,at)=>{param.linearRampToValueAtTime(value,at);points.push([at,value]);};
    if(delay>0){ramp(1,time+Math.min(.03,delay));param.setValueAtTime(1,time+delay);points.push([time+delay,1]);}
    if(seconds>0)ramp(to,time+delay+seconds);
    else {param.setValueAtTime(to,time+delay);points.push([time+delay,to]);}
    this.points=points;
  }
}

// Fade while the decoder is still running. Reacting to a native pause/ended
// event would be too late: its samples have already stopped arriving.
class StopTransition {
  constructor(video,{envelope,isRunning,onChange=()=>{}}){
    Object.assign(this,{video,envelope,isRunning,onChange});
    this.enabled=true;this.pausing=false;this.timer=null;this.playing=!video.paused;
    video.addEventListener('play',()=>{
      this.playing=false;
      // Rearm before `playing`: starting inside the final second must fade
      // from an audible level, not keep the previous pause's zero gain.
      if(!this.pausing)this.envelope(1,0);
    });
    video.addEventListener('playing',()=>{this.playing=true;this.refresh();});
    for(const type of ['timeupdate','durationchange','ratechange','seeked'])video.addEventListener(type,()=>this.refresh());
    for(const type of ['waiting','seeking'])video.addEventListener(type,()=>{this.playing=false;this.refresh();});
    for(const type of ['pause','ended'])video.addEventListener(type,()=>{
      this.clear();this.playing=false;this.envelope(this.enabled?0:1,0);this.onChange();
    });
    for(const type of ['emptied','loadstart','error'])video.addEventListener(type,()=>this.reset());
  }
  remaining(){
    const {duration,currentTime,playbackRate}=this.video;
    if(!Number.isFinite(duration)||duration<=0||!Number.isFinite(currentTime)||!Number.isFinite(playbackRate)||playbackRate<=0)return Infinity;
    return Math.max(0,(duration-currentTime)/playbackRate);
  }
  endIn(){
    const remaining=this.remaining();
    if(!Number.isFinite(remaining))return remaining;
    return Math.max(0,remaining-Math.min(END_FADE_LEAD,this.video.duration/this.video.playbackRate*.1));
  }
  clear(){clearTimeout(this.timer);this.timer=null;this.pausing=false;}
  reset(){this.clear();this.playing=false;this.envelope(1,0);this.onChange();}
  refresh(){
    if(this.pausing)return;
    const v=this.video;
    if(!this.enabled){this.envelope(1,.03);return;}
    if(v.paused||v.ended){this.envelope(0,0);return;}
    const remaining=this.remaining();
    if(!this.playing||v.seeking||v.loop||!this.isRunning()||!Number.isFinite(remaining)){
      this.envelope(1,.03);return;
    }
    // AudioParam automation, not requestAnimationFrame, drives the final second
    // so hidden decks and background tabs keep their scheduled ending envelope.
    // Decoders can report their final frame slightly before currentTime reaches
    // duration, especially with time stretching. Leave a short silent margin so
    // EOF cannot cut off the last audible part of the ramp.
    const available=this.endIn();
    this.envelope(0,Math.min(STOP_FADE,available),Math.max(0,available-STOP_FADE));
  }
  requestPause(){
    if(this.pausing)return;
    if(this.video.paused||this.video.ended||!this.enabled||!this.isRunning()){this.finish();return;}
    this.pausing=true;
    const seconds=this.video.loop?STOP_FADE:Math.min(STOP_FADE,this.endIn());
    this.envelope(0,seconds);this.onChange();
    this.timer=setTimeout(()=>this.finish(),seconds*1000);
  }
  finish(){
    this.clear();this.video.pause();this.playing=false;
    this.envelope(this.enabled?0:1,0);this.onChange();
  }
  cancelPause(){this.clear();this.refresh();this.onChange();}
  beforeSeek(){this.cancelPause();}
  setEnabled(value){
    this.enabled=Boolean(value);
    if(!this.enabled&&this.pausing)this.finish();else this.refresh();
    this.onChange();
  }
}

globalThis.WebDJStop=Object.freeze({StopTransition,StopEnvelope});
})();
