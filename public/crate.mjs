import {clampPosition,edgeVelocity,dragIntent,dragPosition,snapPosition} from './shelf-math.mjs';
import {formatTime} from './deck.mjs';
import {describeKey} from './key-transpose.mjs';
const $=id=>document.getElementById(id);
function element(tag,className,text){const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=text;return el;}
function keyLabel(key){
  const label=element('span','crate-key'),details=describeKey(key);
  label.append(element('span','crate-key-primary',details?.map(k=>k.label).join(' / ')||key||'调性未标注'));
  if(details){label.append(element('small','crate-key-relative',details.map(k=>k.relative).join(' / ')));label.title=details.map(k=>`${k.label}，关系${k.relativeMode==='Minor'?'小':'大'}调 ${k.relative}`).join('；');}
  return label;
}
export function makeCrate({onLoad,onImport,onEdit,onInspect,notify}) {
  const root=$('crate'),browser=$('crate-browser');
  let library={tracks:[],categories:[]},filter='all',category='',query='',filtered=[],position=0,selectedId=null,frame=null,velocity=0,lastTime=0,drag=null,suppressClickUntil=0;
  const shelf=element('div','record-shelf');shelf.tabIndex=0;shelf.setAttribute('role','listbox');shelf.setAttribute('aria-label','唱片架，左右方向键选曲');
  const inspected=new Set();let returnScrollY=0;
  function stop(snap=true){velocity=0;lastTime=0;if(frame!==null)cancelAnimationFrame(frame);frame=null;if(snap)move(snapPosition(position,filtered.length));}
  function layout(){if(root.hidden)return;const bottom=Math.max(...[...document.querySelectorAll('.video-frame')].filter(el=>el.getClientRects().length).map(el=>el.getBoundingClientRect().bottom))+12;
    // Keep covers full-size. Short viewports get a Crate in the page instead of tiny rows.
    const chrome=['.crate-head','.crate-filters','.categories','.crate-bottom'].reduce((height,selector)=>height+root.querySelector(selector).getBoundingClientRect().height,0);
    const naturalHeight=Math.ceil(chrome+(shelf.querySelector('.record.selected')?.offsetHeight||320)+34);
    const inline=window.innerWidth<=680||window.innerHeight-(bottom+window.scrollY)-14<naturalHeight;
    root.style.setProperty('--crate-natural-height',naturalHeight+'px');
    root.classList.toggle('inline',inline);root.style.setProperty('--crate-top',Math.max(12,bottom)+'px');
  }
  function open(all=false){if(all){filter='all';document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('active',b.dataset.filter===filter));applyFilters();}
    if(root.hidden)returnScrollY=window.scrollY;
    root.hidden=false;document.body.classList.add('crate-open');$('open-crate').setAttribute('aria-expanded','true');layout();
    if(root.classList.contains('inline'))root.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
    $('close-crate').focus({preventScroll:true});
  }
  function close(){stop();root.hidden=true;document.body.classList.remove('crate-open');$('open-crate').setAttribute('aria-expanded','false');if(root.classList.contains('inline'))window.scrollTo({top:returnScrollY,behavior:'instant'});$('open-crate').focus({preventScroll:true});}
  function selected(){return filtered[snapPosition(position,filtered.length)];}
  function updateSelection(){const t=selected();selectedId=t?.id||null;$('selection-count').textContent=t?`${snapPosition(position,filtered.length)+1} / ${filtered.length}`:'';
    const info=$('selection-info'),actions=$('selection-actions');info.replaceChildren();actions.replaceChildren();if(!t){layout();return;}if(t.available&&t.duration==null&&!inspected.has(t.id)){inspected.add(t.id);onInspect?.(t);}
    const title=element('strong','',t.title),meta=element('small','selection-meta');info.append(title);meta.append(keyLabel(t.key),` · ${formatTime(t.duration)} · ${t.platform==='youtube'?'YouTube':'Bilibili'}`);info.append(meta);
    const editable=library.canManage!==false;info.tabIndex=editable?0:-1;if(editable){info.setAttribute('role','button');info.setAttribute('aria-label','编辑 '+t.title);}else{info.removeAttribute('role');info.removeAttribute('aria-label');}info.onclick=()=>editable&&onEdit(t);info.onkeydown=e=>{if(editable&&e.key==='Enter')onEdit(t);};
    if(t.available){for(const deck of ['A','B','C','D']){const btn=element('button','load-deck','Load to '+deck);btn.onclick=()=>{close();onLoad(t,deck);};actions.append(btn);}}
    else {const btn=element('button','load-deck','＋ 导入对应文件');btn.onclick=()=>onImport(null,t.id);actions.append(btn);}
    const copy=element('button','copy-link','Copy Link');copy.disabled=!t.url;copy.onclick=async()=>{try{if(navigator.clipboard){await navigator.clipboard.writeText(t.url);}else{const field=element('textarea');field.value=t.url;field.style.cssText='position:fixed;left:-9999px';document.body.append(field);field.select();const copied=document.execCommand('copy');field.remove();if(!copied)throw Error('copy');}notify('来源链接已复制');}catch{notify('无法复制，请从素材来源栏复制链接');}};actions.append(copy);layout();
  }
  function paint(){const index=snapPosition(position,filtered.length);shelf.querySelectorAll('.record').forEach(button=>{const i=Number(button.dataset.index),d=i-position;button.style.setProperty('--distance',d);button.style.setProperty('--turn',Math.max(-67,Math.min(67,d*-67))+'deg');button.style.setProperty('--scale',Math.max(.74,1-Math.abs(d)*.10));button.style.setProperty('--order',20-Math.round(Math.abs(d)*2));button.hidden=Math.abs(d)>5.5;button.classList.toggle('selected',i===index);button.setAttribute('aria-selected',String(i===index));});}
  function move(next){position=clampPosition(next,filtered.length);const id=selected()?.id;paint();if(id!==selectedId)updateSelection();}
  function renderRecords(){shelf.replaceChildren();
    const colors=['#dce6cc','#e6e6db','#cddbcf','#e7dfd3','#dce1e6','#e5e5c9'];
    filtered.forEach((track,index)=>{const button=element('button','record');button.type='button';button.dataset.index=index;button.tabIndex=-1;button.setAttribute('role','option');button.setAttribute('aria-label',track.title);const art=element('span','record-art');art.style.setProperty('--cover',colors[index%colors.length]);art.append(element('small','',track.platform==='youtube'?'YOUTUBE':'BILIBILI'));if(track.thumbnail){const image=element('img','record-thumbnail');image.src=track.thumbnail;image.alt='';image.loading='lazy';image.decoding='async';image.draggable=false;image.onerror=()=>{image.remove();art.classList.remove('has-thumbnail');};art.append(image);art.classList.add('has-thumbnail');}art.append(element('b','',track.title.replace(/[^\p{L}\p{N}]/gu,'').slice(0,2).toUpperCase()||'DJ'));if(track.available)art.append(element('small','record-status',''));
      const label=element('span','record-label'),key=element('small','record-key');key.append(keyLabel(track.key));label.append(element('strong','',track.title),key);button.append(art,label);button.onclick=()=>{if(performance.now()<suppressClickUntil)return;stop(false);move(index);};shelf.append(button);
    });paint();
    for(const [className,text,offset] of [['prev','‹',-1],['next','›',1]]){const b=element('button','shelf-arrow '+className,text);b.setAttribute('aria-label',offset<0?'上一张':'下一张');b.onclick=e=>{e.stopPropagation();stop(false);move(Math.round(position)+offset);};shelf.append(b);}
  }
  function applyFilters(){stop(false);const q=query.toLocaleLowerCase();filtered=library.tracks.filter(t=>(filter==='all'||t.categoryIds.includes('personal-imports'))&&(!category||t.categoryIds.includes(category))&&(!q||[t.title,t.key,t.description||''].some(s=>s.toLocaleLowerCase().includes(q))));position=Math.max(0,filtered.findIndex(t=>t.id===selectedId));browser.replaceChildren();
    if(!filtered.length){const empty=element('div','crate-empty');empty.append(element('strong','',query||category?'这里暂时没有唱片。':'把声音带进来。'),element('p','',query||category?'换一个分类或搜索词试试。':'粘贴 YouTube 或 Bilibili 链接。'));if(!query&&!category){const b=element('button','','＋ 导入链接');b.onclick=()=>onImport();empty.append(b);}browser.append(empty);}
    else {browser.append(shelf);renderRecords();}updateSelection();
  }
  function setLibrary(next){library=next;$('available-count').textContent=next.localCount;$('categories').replaceChildren();
    for(const c of [{id:'',name:'全部分类'},...next.categories]){const b=element('button',c.id===category?'active':'',c.name);b.onclick=()=>{category=c.id;setLibrary(library);};$('categories').append(b);}applyFilters();}
  function run(time){const elapsed=lastTime?Math.min(.05,(time-lastTime)/1000):0;lastTime=time;move(position+velocity*elapsed);if(!velocity||(position===0&&velocity<0)||(position===filtered.length-1&&velocity>0)){stop();return;}frame=requestAnimationFrame(run);}
  shelf.addEventListener('pointerdown',e=>{if(e.pointerType==='mouse')return;stop();drag={id:e.pointerId,x:e.clientX,y:e.clientY,start:position,intent:'pending',spacing:parseFloat(getComputedStyle(shelf).getPropertyValue('--record-step'))||200};});
  shelf.addEventListener('pointermove',e=>{if(root.hidden)return;
    if(drag&&drag.id===e.pointerId){const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(drag.intent==='pending')drag.intent=dragIntent(dx,dy);if(drag.intent==='horizontal'){shelf.setPointerCapture(e.pointerId);e.preventDefault();move(dragPosition(drag.start,dx,drag.spacing,filtered.length));}return;}
    if(e.pointerType!=='mouse'||matchMedia('(prefers-reduced-motion: reduce)').matches||e.target.closest('.shelf-arrow'))return;const rect=shelf.getBoundingClientRect();velocity=edgeVelocity(e.clientX-rect.left,rect.width,5);if(!velocity)stop();else if(frame===null)frame=requestAnimationFrame(run);
  });
  const end=e=>{if(!drag||drag.id!==e.pointerId)return;if(drag.intent==='horizontal')suppressClickUntil=performance.now()+250;if(shelf.hasPointerCapture(e.pointerId))shelf.releasePointerCapture(e.pointerId);drag=null;stop();};shelf.addEventListener('pointerup',end);shelf.addEventListener('pointercancel',end);shelf.addEventListener('pointerleave',()=>{if(!drag)stop();});
  shelf.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();stop(false);move(Math.round(position)+(e.key==='ArrowLeft'||e.key==='ArrowUp'?-1:1));}});
  window.addEventListener('resize',()=>{stop();layout();});window.addEventListener('scroll',layout,{passive:true});window.addEventListener('blur',()=>stop());document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!root.hidden&&!document.querySelector('dialog[open]'))close();});
  $('open-crate').onclick=()=>open();$('close-crate').onclick=close;$('search').oninput=e=>{query=e.target.value;applyFilters();};document.querySelectorAll('[data-filter]').forEach(b=>b.onclick=()=>{filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.classList.toggle('active',x===b));applyFilters();});
  return {setLibrary,open,close};
}
