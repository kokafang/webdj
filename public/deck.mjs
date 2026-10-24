import {OnlineAudio as DeckAudio} from './online-audio.mjs';
import {OnlineMedia} from './online-media.mjs';
import {transposeKey,describeKey} from './key-transpose.mjs';
export const formatTime=s=>Number.isFinite(s)?`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`:'—';
// Each half of the physical fader has its own scale, with normal speed at center.
export function speedToPosition(percent){
  const speed=Math.max(10,Math.min(400,percent));
  return speed<=100?(speed-10)/90*500:500+(speed-100)/300*500;
}
export function positionToSpeed(position){
  const p=Math.max(0,Math.min(1000,position));
  return Math.round(p<=500?10+p/500*90:100+(p-500)/500*300);
}
export function makeDeck(letter,{onImport,onEdit,onDuration,onUrl,notify}) {
  const root=document.createElement('section');root.className='deck';root.dataset.deck=letter;root.setAttribute('aria-label','Deck '+letter);
  root.innerHTML=`<div class="video-frame"><span class="deck-state" role="status" hidden></span><video controls playsinline preload="metadata" aria-label="Deck ${letter} 播放器" hidden></video><button class="empty-video"><span class="empty-orbit">${letter}</span><strong>放入一段声音</strong><span>从唱片箱选择 <b>↗</b></span></button><div class="audio-art" hidden><span>♫</span><small>ONLINE</small></div><div class="video-error" role="alert" hidden></div></div>
  <div class="track-meta"><div class="track-title-line"><h2>等待你的第一张唱片</h2><button class="edit-track" disabled aria-label="打开 Deck ${letter} 来源网页">↗</button></div><div class="track-facts"><button class="key-button" disabled><span>调性</span><span class="key-values" aria-live="polite" aria-atomic="true"><s class="key-original" hidden></s><span class="key-arrow" aria-hidden="true" hidden>→</span><b class="key-current">—</b></span></button><span class="duration">时长 —</span><span class="file-tag">在线视频</span></div></div>
  <div class="mixer"><div class="eq-section"><div class="section-label">EQUALIZER <button class="small-reset" data-reset="eq">归零</button></div><div class="eq-stack"></div></div><div class="fader-section" data-field="pitch"></div><div class="fader-section" data-field="speed"></div><div class="fader-section volume-section" data-field="volume"></div></div>
  <div class="deck-bottom"><button class="choose-file">Load</button><label class="loop-label"><input type="checkbox" aria-label="Deck ${letter} 循环播放">循环</label><button class="effects-reset">音效复位</button><span class="meter" aria-label="Deck ${letter} 输出电平"><i></i></span></div>
  <form class="link-form"><input type="url" aria-label="Deck ${letter} 来源链接" placeholder="粘贴 YouTube / Bilibili 链接"><button type="submit">装入 ↗</button></form>`;
  let track=null,audience=false;
  const video=new OnlineMedia(root.querySelector('video'),letter); const status=root.querySelector('.deck-state');
  const audio=new DeckAudio(video,error=>notify(error?.message||error),letter);
  const keyButton=root.querySelector('.key-button'),originalKey=root.querySelector('.key-original'),currentKey=root.querySelector('.key-current'),keyArrow=root.querySelector('.key-arrow');
  const liveKey=document.createElement('span'),relativeKey=document.createElement('small');
  liveKey.className='key-live';relativeKey.className='key-relative';relativeKey.hidden=true;
  currentKey.replaceWith(liveKey);liveKey.append(currentKey,relativeKey);
  function updateKey(){
    const original=track?.key?.trim()||'—';
    const shifted=audio.values.pitch!==0&&!['—','-'].includes(original);
    const originalDetails=describeKey(original),details=describeKey(original,audio.values.pitch);
    const originalLabel=originalDetails?.map(k=>k.label).join(' / ')||original;
    const current=details?.map(k=>k.label).join(' / ')||(shifted?(transposeKey(original,audio.values.pitch)||'—'):original);
    originalKey.textContent=originalLabel;originalKey.hidden=!shifted;keyArrow.hidden=!shifted;currentKey.textContent=current;
    relativeKey.textContent=details?.map(k=>k.relative).join(' / ')||'';relativeKey.hidden=!details;
    const relativeDescription=details?.map(k=>`${k.label}，关系${k.relativeMode==='Minor'?'小':'大'}调 ${k.relative}`).join('；')||'';
    relativeKey.title=relativeDescription;
    keyButton.classList.toggle('transposed',shifted);
    keyButton.setAttribute('aria-label',`Deck ${letter} 调性，${shifted?`原调性 ${originalLabel}，当前调性 `:''}${relativeDescription||(current==='—'?'未确定':current)}`);
  }
  updateKey();
  const controls=new Map();
  const names={high:'高',mid:'中',low:'低',pitch:'变调',speed:'速度',volume:'音量'};
  function display(field,value){return field==='pitch'?(value>0?'+':'')+value:field==='speed'||field==='volume'?value+'%':(value>0?'+':'')+value+' dB';}
  function updateControl(field,value) {
    const c=controls.get(field);c.input.value=field==='speed'?speedToPosition(value):value;c.out.textContent=display(field,value);
    if(field==='speed'){
      c.input.setAttribute('aria-valuenow',value);
      c.input.setAttribute('aria-valuetext',`${value}% · ${value/100}×`);
    }
    if(c.knob)c.knob.style.setProperty('--angle',(value<=0?value/26*135:value/6*135)+'deg');
    if(c.number && document.activeElement!==c.number)c.number.value=value;
    if(field==='pitch')updateKey();
  }
  function set(field,value) {try{audio.set(field,value);updateControl(field,value);}catch(e){notify(e.message);updateControl(field,audio.values[field]);}}
  for(const field of ['high','mid','low']) {
    const row=document.createElement('div');row.className='eq-row';row.innerHTML=`<label class="knob"><input type="range" min="-26" max="6" step="0.5" value="0" aria-label="Deck ${letter} ${names[field]}频 EQ"><span class="knob-face"><i></i></span></label><span class="eq-name">${names[field]}<output>0 dB</output></span><button class="eq-zero" aria-label="Deck ${letter} ${names[field]}频归零">↺</button>`;
    const input=row.querySelector('input'),knob=row.querySelector('.knob');
    controls.set(field,{input,out:row.querySelector('output'),knob});updateControl(field,0);
    input.addEventListener('input',()=>set(field,Number(input.value)));
    row.querySelector('button').onclick=()=>set(field,0);
    let drag=null;
    input.addEventListener('pointerdown',e=>{if(e.button!==0)return;e.preventDefault();input.focus();input.setPointerCapture(e.pointerId);drag={y:e.clientY,value:audio.values[field]};});
    input.addEventListener('pointermove',e=>{if(!drag)return;set(field,Math.max(-26,Math.min(6,Math.round((drag.value+(drag.y-e.clientY)/4)*2)/2)));});
    const end=()=>{drag=null;};input.addEventListener('pointerup',end);input.addEventListener('pointercancel',end);
    root.querySelector('.eq-stack').append(row);
  }
  for(const field of ['pitch','speed','volume']) {
    const wrap=root.querySelector(`[data-field="${field}"]`),range={pitch:[-12,12,0],speed:[0,1000,500],volume:[0,100,100]}[field],initial=field==='speed'?100:range[2];
    wrap.innerHTML=`<div class="section-label">${names[field]}</div><div class="fader-value">${field==='speed'?`<input type="number" min="10" max="400" step="1" value="100" aria-label="Deck ${letter} 速度百分比">`:''}<output>${display(field,initial)}</output>${field==='pitch'?'<small>半音</small>':''}</div><div class="fader-track"><div class="fader-ticks" aria-hidden="true"></div><input type="range" min="${range[0]}" max="${range[1]}" value="${range[2]}" step="${field==='speed'?'any':'1'}" ${field==='speed'?'aria-valuemin="10" aria-valuemax="400"':''} aria-label="Deck ${letter} ${names[field]}"></div><button class="fader-reset">${field==='pitch'?'归零':field==='speed'?'原速':'100%'}</button>`;
    const input=wrap.querySelector('input[type=range]'),number=wrap.querySelector('input[type=number]');
    controls.set(field,{input,number,out:wrap.querySelector('output')});
    updateControl(field,initial);
    input.oninput=()=>set(field,field==='speed'?positionToSpeed(Number(input.value)):Number(input.value));wrap.querySelector('button').onclick=()=>set(field,initial);
    if(number){
      const commit=()=>{if(number.value===''||!number.validity.valid){notify('速度请输入 10–400 的整数');number.value=audio.values.speed;return;}set('speed',Number(number.value));};
      number.onchange=commit;number.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();commit();number.blur();}};
      input.addEventListener('keydown',e=>{
        const delta={ArrowUp:1,ArrowRight:1,ArrowDown:-1,ArrowLeft:-1,PageUp:10,PageDown:-10}[e.key];
        if(delta===undefined&&e.key!=='Home'&&e.key!=='End')return;
        e.preventDefault();set('speed',e.key==='Home'?10:e.key==='End'?400:Math.max(10,Math.min(400,audio.values.speed+delta)));
      });
    }
  }
  function reset(){try{audio.reset();for(const field of controls.keys())updateControl(field,audio.values[field]);}catch(e){notify(e.message);}}
  root.querySelector('[data-reset=eq]').onclick=()=>['high','mid','low'].forEach(x=>set(x,0));root.querySelector('.effects-reset').onclick=reset;
  root.querySelector('.loop-label input').onchange=e=>{video.loop=e.target.checked;};
  root.querySelector('.choose-file').onclick=()=>onImport(letter);root.querySelector('.empty-video').onclick=()=>onImport(letter);
  root.querySelector('.edit-track').onclick=()=>{if(track)window.open(track.url,'_blank','noopener');};root.querySelector('.key-button').onclick=()=>track&&onEdit(track);
  root.querySelector('form').onsubmit=e=>{e.preventDefault();onUrl(root.querySelector('input[type=url]').value,letter);};
  function updateMeta(next){track=next;root.querySelector('h2').textContent=track.title;updateKey();root.querySelector('.duration').textContent='时长 '+formatTime(track.duration);}
  function state(text,attention=false){status.textContent=attention?text:'';status.hidden=!attention;}
  video.addEventListener('loadedmetadata',()=>{if(track){root.querySelector('.duration').textContent='时长 '+formatTime(video.duration);if(Number.isFinite(video.duration)&&Math.abs((track.duration||0)-video.duration)>.5)onDuration(track,video.duration);}state('已就绪');});
  video.addEventListener('play',()=>state(''));video.addEventListener('waiting',()=>state('缓冲中',true));video.addEventListener('seeking',()=>state('加载中',true));video.addEventListener('playing',()=>state(''));video.addEventListener('seeked',()=>state(''));video.addEventListener('canplay',()=>state(''));video.addEventListener('pause',()=>state('已暂停'));video.addEventListener('ended',()=>state('已结束'));
  video.addEventListener('error',()=>{const error=root.querySelector('.video-error');error.textContent='平台未能播放此视频，可点击标题旁的箭头到来源网站查看。';error.hidden=false;state('播放失败',true);});
  let tick=0;function meter(){if(++tick%4===0)root.querySelector('.meter i').style.width=(audio.level()*100)+'%';requestAnimationFrame(meter);}requestAnimationFrame(meter);
  function load(next){if(!next.available)return;audio.pending.clear();Object.assign(audio.values,{pitch:0,speed:100,volume:100,high:0,mid:0,low:0});for(const field of controls.keys())updateControl(field,audio.values[field]);
    updateMeta(next);video.poster=next.thumbnail||'';video.src=next.url;video.hidden=false;video.load();root.querySelector('.empty-video').hidden=true;root.querySelector('.video-error').hidden=true;root.querySelector('.audio-art').hidden=true;root.querySelector('.edit-track').disabled=false;root.querySelector('.key-button').disabled=audience;root.querySelector('input[type=url]').value=next.url||'';state('加载中',true);
    root.querySelector('.mixer').removeAttribute('inert');root.querySelector('.mixer').classList.remove('waiting');capabilities();
  }
  root.querySelector('.mixer').setAttribute('inert','');root.querySelector('.mixer').classList.add('waiting');root.querySelector('.effects-reset').disabled=true;
  function capabilities(){
    for(const [name,c]of controls){const allowed=!!track&&(video.processing||(['speed','volume'].includes(name)&&!!video.player?.getPlayerState));c.input.disabled=!allowed;if(c.number)c.number.disabled=!allowed;c.input.closest('.eq-row,.fader-section').classList.toggle('unavailable',!allowed);}
    root.querySelector('.effects-reset').disabled=!video.processing;
    root.querySelector('[data-reset=eq]').disabled=!video.processing;
    root.querySelectorAll('.eq-zero').forEach(b=>b.disabled=!video.processing);
    if(track)state(video.processing?'':(video.audioState?.message&&video.audioState.ok===false?'音频未连接':'扩展音效未连接'),!video.processing);
  }
  video.addEventListener('processingchange',capabilities);
  video.addEventListener('audiovalueschange',()=>{for(const name of controls.keys())updateControl(name,audio.values[name]);});
  function setAudience(value){audience=value;root.querySelector('.empty-video>span:last-child').textContent=value?'从唱片箱选择 ↗':'从唱片箱选择 ↗';root.querySelector('.key-button').disabled=value||!track;}
  return {root,video,load,updateMeta,setAudience,setSeekFade:value=>audio.setPlaybackFade(value),get track(){return track;}};
}

