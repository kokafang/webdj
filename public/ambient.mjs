const $=id=>document.getElementById(id);
// Cache tiny source frames, then blend them along an independently moving seam.
// Pausing a player freezes its image, not the ambient motion.
export function mountAmbientLight(decks) {
  const width=160,height=90,clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));
  const stage=document.createElement('div');stage.className='ambient-stage';stage.setAttribute('aria-hidden','true');
  const glow=document.createElement('div');glow.className='ambient-fallback';stage.append(glow);
  const canvas=document.createElement('canvas');canvas.className='ambient-flow';canvas.width=width;canvas.height=height;stage.append(canvas);
  const context=canvas.getContext('2d',{alpha:false}),output=context?.createImageData(width,height);
  const film=document.createElement('div');film.className='ambient-film';stage.append(film);document.body.prepend(stage);
  const button=document.createElement('button');button.id='ambient-toggle';button.className='ambient-toggle';button.type='button';button.innerHTML='<span aria-hidden="true">◉</span> 氛围光';
  $('appearance-settings').append(button);
  const reduced=matchMedia('(prefers-reduced-motion: reduce)'),mobile=matchMedia('(max-width: 680px)');
  let enabled=true,timer=null;
  try{enabled=localStorage.getItem('webdj-ambient')!=='off';}catch{}
  const layers=decks.map(deck=>{
    const source=document.createElement('canvas');source.width=width;source.height=height;
    return {root:deck.root,video:deck.video,context:source.getContext('2d',{alpha:false,willReadFrequently:true}),cover:null,pixels:null,lastTime:-1,lastSampleAt:-Infinity,version:0,failed:false,usedCover:false};
  });
  const visible=layer=>!layer.root.closest('.deck-pair')?.hidden;
  function sample(layer,force=false){
    if(!enabled||document.hidden||!visible(layer)||layer.failed||!layer.context)return;
    const {video,context:ctx}=layer,now=performance.now();
    if(!force&&now-layer.lastSampleAt<(mobile.matches?250:125))return;
    try{
      const frameReady=video.readyState>=2&&video.videoWidth&&video.videoHeight;
      const useCover=layer.cover&&(!frameReady||(video.paused&&video.currentTime===0));
      if(useCover){if(!force&&layer.usedCover)return;ctx.drawImage(layer.cover,0,0,width,height);layer.usedCover=true;}
      else if(frameReady){if(!force&&!layer.usedCover&&layer.lastTime===video.currentTime)return;ctx.drawImage(video.element,0,0,width,height);layer.lastTime=video.currentTime;layer.usedCover=false;}
      else return;
      layer.pixels=ctx.getImageData(0,0,width,height).data;layer.lastSampleAt=now;
    }catch{layer.failed=true;layer.pixels=null;}
  }
  function render(now=performance.now()){
    if(!enabled||document.hidden||!context)return;
    const pair=layers.filter(visible),left=pair[0]?.pixels||pair[1]?.pixels,right=pair[1]?.pixels||left;
    canvas.classList.toggle('has-frame',!!left);
    if(!left)return;
    const t=reduced.matches?0:now/1000,data=output.data;
    for(let y=0;y<height;y++){
      const v=y/(height-1),seam=.5+.19*Math.sin(t*.65)+.14*Math.sin(v*Math.PI*2+t*.9)+.06*Math.sin(v*Math.PI*4-t*.7);
      const dx=Math.sin(v*6.28+t*.72)*width*.055,dy=Math.sin(t*.45+v*3.14)*height*.045;
      const ly=clamp(Math.round(y+dy),0,height-1),ry=clamp(Math.round(y-dy),0,height-1);
      for(let x=0;x<width;x++){
        const f=clamp((x/(width-1)-seam+.13)/.26,0,1),mix=f*f*(3-2*f);
        const li=(ly*width+clamp(Math.round(x+dx),0,width-1))*4,ri=(ry*width+clamp(Math.round(x-dx),0,width-1))*4,i=(y*width+x)*4;
        data[i]=left[li]*(1-mix)+right[ri]*mix;data[i+1]=left[li+1]*(1-mix)+right[ri+1]*mix;data[i+2]=left[li+2]*(1-mix)+right[ri+2]*mix;data[i+3]=255;
      }
    }
    context.putImageData(output,0,0);
  }
  function stop(){clearTimeout(timer);timer=null;}
  function running(){return enabled&&!document.hidden&&!reduced.matches&&!!context&&layers.some(l=>visible(l)&&l.pixels);}
  function tick(){timer=null;if(!running())return;layers.forEach(l=>sample(l));render();timer=setTimeout(tick,mobile.matches?100:1000/15);}
  function wake(){stop();if(running())timer=setTimeout(tick,mobile.matches?100:1000/15);}
  function refresh(){layers.forEach(l=>sample(l,true));render();wake();}
  for(const layer of layers){
    const {video}=layer;
    video.addEventListener('loadstart',()=>{
      layer.lastTime=-1;layer.lastSampleAt=-Infinity;layer.cover=null;layer.pixels=null;layer.failed=false;layer.usedCover=false;
      const version=++layer.version;
      if(video.poster){const cover=new Image();cover.crossOrigin='anonymous';cover.onload=()=>{if(layer.version!==version)return;layer.cover=cover;refresh();};cover.src=video.poster;}
      render();wake();
    });
    for(const event of ['loadeddata','seeked','pause','ended','playing'])video.addEventListener(event,refresh);
    video.addEventListener('error',()=>{layer.failed=true;layer.pixels=null;render();wake();});
    video.addEventListener('emptied',()=>{layer.version++;layer.pixels=null;layer.cover=null;render();wake();});
  }
  function apply(){document.body.classList.toggle('ambient-off',!enabled);button.setAttribute('aria-pressed',String(enabled));button.setAttribute('aria-label',enabled?'关闭氛围光':'开启氛围光');stop();if(enabled)refresh();}
  button.onclick=()=>{enabled=!enabled;try{localStorage.setItem('webdj-ambient',enabled?'on':'off');}catch{}apply();};
  document.addEventListener('visibilitychange',()=>{stop();if(!document.hidden)refresh();});
  reduced.addEventListener('change',()=>{stop();refresh();});
  window.addEventListener('deckbankchange',refresh);
  window.addEventListener('pagehide',stop);window.addEventListener('pageshow',refresh);
  apply();
}
