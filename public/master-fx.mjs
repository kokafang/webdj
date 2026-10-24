import {masterAudio,SEND_LETTERS} from './master-audio.mjs';
import {FX_PARAMETERS} from './reverb.mjs';

export function mountMasterFX(root,{notify}){
  root.className='master-fx';root.setAttribute('aria-labelledby','master-fx-title');
  root.innerHTML=`<header class="fx-heading"><div><span class="fx-eyebrow">MASTER FX</span><h2 id="master-fx-title">Shimmer Reverb</h2></div><div class="fx-actions"><button type="button" class="fx-enable" role="switch" aria-label="Shimmer Reverb 效果开关" aria-checked="true"><i aria-hidden="true"></i><span>开</span></button><button type="button" class="fx-reset">复位</button></div></header><div class="fx-body"><fieldset class="fx-sends"><legend>SEND</legend><div class="fx-send-controls"></div></fieldset><fieldset class="fx-parameters"><legend>REVERB</legend><div class="fx-parameter-controls"></div></fieldset></div>`;
  const controls=new Map();
  function format(name,value,p){
    if(name==='decay')return value.toFixed(1)+' s';
    if(name==='tone')return (value/1000).toFixed(1)+' kHz';
    if(name==='interval')return (value>0?'+':'')+value+' 半音';
    return value+(p.unit==='%'?'%':' '+p.unit);
  }
  const ratio=(value,p)=>p.log?Math.log(value/p.min)/Math.log(p.max/p.min):(value-p.min)/(p.max-p.min);
  function render(name,value){
    const {input,output,knob,p}=controls.get(name);
    input.value=value;output.value=format(name,value,p);input.setAttribute('aria-valuetext',output.value);
    knob.style.setProperty('--fx-angle',(-135+ratio(value,p)*270)+'deg');
    knob.style.setProperty('--fx-fill',ratio(value,p)*270+'deg');
    knob.classList.toggle('has-send',name.startsWith('send-')&&value>0);
  }
  function set(name,value){
    try{
      if(name.startsWith('send-'))masterAudio.setSend(name.slice(-1),value);else masterAudio.set(name,value);
      render(name,value);masterAudio.resume().catch(e=>notify(e.message));
    }catch(e){notify(e.message);render(name,name.startsWith('send-')?masterAudio.sends[name.slice(-1)]:masterAudio.values[name]);}
  }
  function add(name,p,parent){
    const label=document.createElement('label');label.className='fx-control';label.dataset.fx=name;
    label.innerHTML=`<span class="fx-control-name">${p.label}</span><span class="fx-knob"><input type="range" min="${p.min}" max="${p.max}" step="${p.step}" value="${p.initial}" aria-label="${p.aria||'混响 '+p.label}"><span class="fx-knob-face" aria-hidden="true"><i></i></span></span><output></output>`;
    const input=label.querySelector('input'),knob=label.querySelector('.fx-knob'),output=label.querySelector('output');
    controls.set(name,{input,output,knob,p});render(name,p.initial);parent.append(label);
    input.oninput=()=>set(name,Number(input.value));
    let drag=null;
    input.addEventListener('pointerdown',e=>{
      if(e.button!==0)return;e.preventDefault();input.focus();input.setPointerCapture(e.pointerId);
      drag={y:e.clientY,start:ratio(Number(input.value),p),id:e.pointerId};
      masterAudio.resume().catch(e=>notify(e.message));
    });
    input.addEventListener('pointermove',e=>{
      if(!drag||e.pointerId!==drag.id)return;
      const position=Math.max(0,Math.min(1,drag.start+(drag.y-e.clientY)/(e.shiftKey?640:160)));
      const raw=p.log?p.min*(p.max/p.min)**position:p.min+position*(p.max-p.min);
      const value=Math.max(p.min,Math.min(p.max,Number((Math.round(raw/p.step)*p.step).toFixed(3))));
      set(name,value);
    });
    for(const event of ['pointerup','pointercancel','lostpointercapture'])input.addEventListener(event,()=>{drag=null;});
    input.addEventListener('dblclick',()=>set(name,p.initial));
  }
  for(const letter of SEND_LETTERS)add('send-'+letter,{label:letter,aria:`Deck ${letter} Send`,min:0,max:100,step:1,initial:0,unit:'%'},root.querySelector('.fx-send-controls'));
  for(const [name,p]of Object.entries(FX_PARAMETERS))add(name,{...p,log:name==='tone'},root.querySelector('.fx-parameter-controls'));
  const enabled=root.querySelector('.fx-enable');
  function syncEnabled(){enabled.setAttribute('aria-checked',String(masterAudio.enabled));enabled.querySelector('span').textContent=masterAudio.enabled?'开':'关';root.classList.toggle('fx-bypassed',!masterAudio.enabled);}
  enabled.onclick=()=>{masterAudio.setEnabled(!masterAudio.enabled);syncEnabled();masterAudio.resume().catch(e=>notify(e.message));};
  root.querySelector('.fx-reset').onclick=()=>{
    masterAudio.reset();syncEnabled();
    for(const letter of SEND_LETTERS)render('send-'+letter,0);
    for(const [name,value]of Object.entries(masterAudio.values))render(name,value);
  };
}
