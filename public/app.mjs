import {makeDeck} from './deck.mjs';
import {DECK_LETTERS,mountDeckBanks} from './deck-banks.mjs';
import {makeCrate} from './crate.mjs';
import {mountPiano} from './piano.mjs';
import {mountMasterFX} from './master-fx.mjs';
import {mountAmbientLight} from './ambient.mjs';
import {createLibrary,parseLinks,makeTrack} from './library.mjs';
import {parseVideoUrl} from './video-url.mjs';
import {extension} from './extension-client.mjs';
const $=id=>document.getElementById(id);
let library={tracks:[],categories:[]},store,editing,importTarget=null,toastTimer;
function notify(text){clearTimeout(toastTimer);$('toast').textContent=text;$('toast').hidden=false;toastTimer=setTimeout(()=>$('toast').hidden=true,4500);}
window.addEventListener('webdj-error',e=>notify(e.detail));
mountPiano({notify});mountMasterFX($('master-fx'),{notify});
function importLinks(target=null){importTarget=target;$('import-text').value='';$('import-summary').textContent='';$('import-dialog').showModal();}
function edit(track){editing=track;$('edit-title').value=track.title;$('edit-key').value=track.key||'';$('edit-category').replaceChildren();
  for(const c of library.categories){const option=document.createElement('option');option.value=c.id;option.textContent=c.name;$('edit-category').append(option);}$('edit-category').value=track.categoryIds[0]||'personal-imports';$('edit-dialog').showModal();}
const decks={};
function load(track,letter){if(!track)return;deckBanks.show(letter);decks[letter].load(track);if(innerWidth<=680)decks[letter].root.scrollIntoView({block:'start',behavior:'smooth'});try{localStorage.setItem('webdj-online-deck-'+letter,track.id);}catch{}}
function refresh(){library=store.list();$('library-count').textContent=`${library.tracks.length} 份素材`;crate.setLibrary(library);for(const deck of Object.values(decks))if(deck.track){const next=library.tracks.find(t=>t.id===deck.track.id);if(next)deck.updateMeta(next);}}
function saveDuration(track,duration){try{store.update(track.id,{duration});refresh();}catch{}}
async function enrich(track){
  if(track.platform!=='youtube'||!track.title.startsWith('YouTube ·'))return;
  try{const url=new URL('https://www.youtube.com/oembed');url.search=new URLSearchParams({url:track.url,format:'json'});const r=await fetch(url,{signal:AbortSignal.timeout(5000)});if(!r.ok)return;const data=await r.json();if(typeof data.title==='string'&&store.list().tracks.find(t=>t.id===track.id)?.title===track.title){store.update(track.id,{title:data.title.slice(0,300)});refresh();}}catch{}
}
function fromUrl(input,letter){try{const video=parseVideoUrl(input),track=library.tracks.find(t=>t.url===video.canonicalUrl)||makeTrack(video);store.add([track]);refresh();load(library.tracks.find(t=>t.url===video.canonicalUrl),letter);void enrich(track);}catch(e){notify(e.message);}}
for(const letter of DECK_LETTERS){decks[letter]=makeDeck(letter,{onImport:()=>crate.open(),onEdit:edit,onDuration:saveDuration,onUrl:fromUrl,notify});$('decks').append(decks[letter].root);}
const deckBanks=mountDeckBanks($('decks'),decks,$('deck-bank-navigation'));
const crate=makeCrate({onLoad:load,onImport:importLinks,onEdit:edit,notify});
mountAmbientLight(Object.values(decks));
let fade=true;try{fade=localStorage.getItem('webdj-seek-fade')!=='off';}catch{}
function setFade(value){fade=value;for(const deck of Object.values(decks))deck.setSeekFade(value);$('seek-fade-toggle').setAttribute('aria-checked',String(value));$('seek-fade-state').textContent=value?'停止 · 开':'关';}
setFade(fade);$('seek-fade-toggle').onclick=()=>{setFade(!fade);try{localStorage.setItem('webdj-seek-fade',fade?'on':'off');}catch{}};
extension.addEventListener('ready',()=>{$('extension-state').textContent='Chrome 扩展已连接';});
if(extension.connected)$('extension-state').textContent='Chrome 扩展已连接';
for(const id of ['import-top','import-crate','import-settings'])$(id).onclick=()=>{if($('settings-dialog').open)$('settings-dialog').close();importLinks();};
$('open-settings').onclick=()=>$('settings-dialog').showModal();$('view-all').onclick=()=>{$('settings-dialog').close();crate.open(true);};
$('refresh-library').onclick=()=>{refresh();notify('唱片箱已刷新');};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('edit-form').onsubmit=e=>{e.preventDefault();if(!editing)return;try{const category=$('edit-category').value;store.update(editing.id,{title:$('edit-title').value,key:$('edit-key').value,categoryIds:category===editing.categoryIds[0]?editing.categoryIds:[category]});refresh();$('edit-dialog').close();notify('已保存到当前浏览器');}catch(error){notify(error.message);}};
$('import-text').oninput=()=>{try{const p=parseLinks($('import-text').value);$('import-summary').textContent=`识别到 ${p.tracks.length} 个视频${p.invalid.length?' · '+p.invalid.length+' 个链接未识别':''}`;}catch(e){$('import-summary').textContent=e.message;}};
$('import-form').onsubmit=e=>{e.preventDefault();try{const p=parseLinks($('import-text').value);if(!p.tracks.length)throw new Error('没有识别到完整视频链接');const added=store.add(p.tracks);refresh();$('import-dialog').close();if(importTarget&&added[0])load(added[0],importTarget);else crate.open(true);notify(`已导入 ${added.length} 条，跳过 ${p.tracks.length-added.length} 条重复链接`);for(const t of added)void enrich(t);}catch(error){notify(error.message);}};
$('export-library').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(library,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='webdj-library.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
try{
  const response=await fetch('./library.json');if(!response.ok)throw new Error('唱片箱读取失败');
  let storage;try{localStorage.setItem('webdj-storage-check','1');localStorage.removeItem('webdj-storage-check');storage=localStorage;}catch{const memory=new Map();storage={getItem:k=>memory.get(k),setItem:(k,v)=>memory.set(k,v)};notify('浏览器禁止保存；本次修改会在关闭后丢失');}
  store=createLibrary(await response.json(),storage);refresh();
  for(const letter of DECK_LETTERS){let id;try{id=localStorage.getItem('webdj-online-deck-'+letter);}catch{}const track=library.tracks.find(t=>t.id===id);if(track)decks[letter].load(track);}
}catch(e){$('library-count').textContent='唱片箱未连接';notify(e.message);}
