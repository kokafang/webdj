const wordmark=document.querySelector('.masthead .wordmark');
if(wordmark){
  const trigger=document.createElement('button');
  trigger.type='button';trigger.id='show-follow-card';trigger.className='follow-trigger';trigger.textContent='关注';
  trigger.title='小红书扫码关注';trigger.setAttribute('aria-label','小红书扫码关注');trigger.setAttribute('aria-haspopup','dialog');trigger.setAttribute('aria-controls','follow-card-dialog');
  const info=document.createElement('div');info.className='header-info';wordmark.after(info);info.append(trigger);
  mountAbout(info);
  const dialog=document.createElement('dialog');dialog.id='follow-card-dialog';dialog.className='follow-dialog';dialog.setAttribute('aria-labelledby','follow-card-title');
  dialog.innerHTML=`<div class="follow-dialog-head"><h2 id="follow-card-title">小红书 · Jiafeng</h2><button type="button" class="follow-close" aria-label="关闭关注卡" autofocus>×</button></div><img class="follow-card-image" src="./images/jiafeng-xiaohongshu.png" width="2220" height="2160" alt="Jiafeng高嘉丰的小红书介绍与原始关注码，小红书号 229201320" decoding="async"><p class="follow-error" role="alert" hidden>关注卡暂时无法加载，请刷新页面。</p>`;
  document.body.append(dialog);
  const close=dialog.querySelector('.follow-close'),card=dialog.querySelector('img');
  trigger.addEventListener('click',()=>{if(!dialog.open)dialog.showModal();});
  close.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>trigger.focus({preventScroll:true}));
  dialog.addEventListener('click',event=>{
    if(event.target!==dialog)return;
    const r=dialog.getBoundingClientRect();
    if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();
  });
  card.addEventListener('error',()=>{card.hidden=true;dialog.querySelector('.follow-error').hidden=false;});
}

function mountAbout(host){
  const header=host.closest('.masthead'),wordmark=header.querySelector('.wordmark');
  const trigger=document.createElement('button');
  trigger.type='button';trigger.id='show-about';trigger.className='follow-trigger about-trigger';trigger.textContent='About';
  trigger.setAttribute('aria-controls','about-marquee');trigger.setAttribute('aria-pressed','false');
  host.append(trigger);
  const surface=document.createElement('section');surface.id='about-marquee';surface.className='about-surface';surface.hidden=true;
  surface.setAttribute('role','region');surface.setAttribute('aria-label','网页 DJ 介绍');
  surface.innerHTML=`<div class="about-track"><div class="about-copy">
<p>网页 DJ (Web DJ) 是高嘉丰自创的一种实验性音乐演出形式，用互联网视频拼贴成音乐。</p>
      <p>演出全程手动，不使用任何 AI。</p>
      <p>在这场表演里，不同文化相互交织，不同音乐风格彼此碰撞，来自互联网各处的声音被重新组合，形成不断变化的音乐。</p>
  </div></div>`;
  const track=surface.querySelector('.about-track'),copy=surface.querySelector('.about-copy');
  const duplicate=copy.cloneNode(true);duplicate.setAttribute('aria-hidden','true');track.append(duplicate);
  const settings=document.createElement('section');settings.className='about-settings';
  settings.innerHTML=`<fieldset class="about-mode-options"><legend>About 显示方式</legend><label><input type="radio" name="about-mode" value="header"><span>顶部白条</span></label><label><input type="radio" name="about-mode" value="screen"><span>全屏叠字</span></label></fieldset><button type="button" class="about-motion-toggle" role="switch" aria-label="滚动文字" aria-checked="true"><span>滚动文字</span><small>开</small></button>`;
  const settingsDialog=document.querySelector('#settings-dialog');
  settingsDialog.querySelector('.manage-settings').before(settings);
  const motionToggle=settings.querySelector('.about-motion-toggle'),reduced=matchMedia('(prefers-reduced-motion: reduce)');
  let mode='header',motion=!reduced.matches,active=false,frame=null,last=0,position=0,cycle=0,speed=0;
  try{mode=localStorage.getItem('webdj-about-mode')==='screen'?'screen':'header';motion=!reduced.matches&&localStorage.getItem('webdj-about-motion')!=='off';}catch{}
  function persist(key,value){try{localStorage.setItem(key,value);}catch{}}
  function stop(){if(frame!==null)cancelAnimationFrame(frame);frame=null;last=0;}
  function sync(){
    trigger.setAttribute('aria-pressed',String(active));trigger.title=active?'收起介绍':'网页 DJ 是什么';
    settings.querySelectorAll('[name=about-mode]').forEach(input=>input.checked=input.value===mode);
    motionToggle.setAttribute('aria-checked',String(motion));motionToggle.querySelector('small').textContent=motion?'开':'暂停';
  }
  function tick(now){
    frame=null;if(!active||!motion||document.hidden||!cycle)return;
    const elapsed=last?Math.min(64,now-last):0;last=now;
    position=(position+elapsed*speed)%cycle;surface.scrollLeft=position;
    frame=requestAnimationFrame(tick);
  }
  function start(){stop();if(active&&motion&&!document.hidden&&cycle)frame=requestAnimationFrame(tick);}
  function measure(reset=false){
    if(!active)return;
    const fraction=cycle?position/cycle:0;
    cycle=copy.getBoundingClientRect().width;speed=parseFloat(getComputedStyle(surface).fontSize)*1.1/1000;
    position=reset?0:fraction*cycle;surface.scrollLeft=position;start();
  }
  function place(reset=true){
    stop();surface.dataset.mode=mode;surface.hidden=!active;header.classList.toggle('about-in-header',active&&mode==='header');
    if(mode==='header')header.insertBefore(surface,wordmark);else document.body.append(surface);
    sync();measure(reset);
  }
  function setActive(value){active=value;place(true);}
  function setMode(value,save=true){mode=value==='screen'?'screen':'header';if(save)persist('webdj-about-mode',mode);place(true);}
  function setMotion(value,save=true){motion=value;if(save)persist('webdj-about-motion',value?'on':'off');sync();start();}
  trigger.addEventListener('click',()=>setActive(!active));
  settings.querySelectorAll('[name=about-mode]').forEach(input=>input.addEventListener('change',()=>{if(input.checked)setMode(input.value);}));
  motionToggle.addEventListener('click',()=>setMotion(!motion));
  document.addEventListener('keydown',event=>{if(event.key==='Escape'&&active&&!document.querySelector('dialog[open]'))setActive(false);});
  document.addEventListener('visibilitychange',()=>document.hidden?stop():start());
  window.addEventListener('resize',()=>measure());
  window.addEventListener('pagehide',stop);window.addEventListener('pageshow',()=>measure());
  reduced.addEventListener('change',()=>{if(reduced.matches)setMotion(false,false);});
  window.addEventListener('storage',event=>{
    if(event.key==='webdj-about-mode')setMode(event.newValue,false);
    if(event.key==='webdj-about-motion')setMotion(event.newValue!=='off',false);
    if(event.key===null){setMode('header',false);setMotion(!reduced.matches,false);}
  });
  place();
}
