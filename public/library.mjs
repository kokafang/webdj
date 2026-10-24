import {parseVideoUrl} from './video-url.mjs';
const STORE='webdj-online-library-v1';
export const trackId=v=>`${v.platform}:${v.id}:${v.part}`;
export function makeTrack(video){return {id:trackId(video),platform:video.platform,videoId:video.id,part:video.part,url:video.canonicalUrl,title:`${video.platform==='youtube'?'YouTube':'Bilibili'} · ${video.id}`,key:'',duration:null,description:'',categoryIds:['personal-imports'],thumbnail:video.platform==='youtube'?`https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`:'',available:true};}
export function parseLinks(text){
  if(typeof text!=='string'||text.length>100000)throw new Error('一次最多粘贴 10 万字');
  const urls=text.replaceAll('\\&','&').match(/https?:\/\/[^\s<>"\[\]（）]+/g)||[];
  const tracks=new Map(),invalid=[];
  for(const raw of urls){try{const v=parseVideoUrl(raw.replace(/[),，。;；]+$/,''));tracks.set(trackId(v),makeTrack(v));}catch{invalid.push(raw);}}
  return {tracks:[...tracks.values()],invalid};
}
export function createLibrary(seed,storage){
  let state={imports:[],overrides:{}};
  try{const saved=JSON.parse(storage.getItem(STORE));if(saved&&Array.isArray(saved.imports)&&saved.overrides&&typeof saved.overrides==='object')state=saved;}catch{}
  const persist=next=>{storage.setItem(STORE,JSON.stringify(next));state=next;};
  function list(){
    const map=new Map();
    for(const t of [...seed.tracks,...state.imports]){
      try{const v=parseVideoUrl(t.url);const patch=state.overrides[t.id]||{};map.set(t.id,{...t,...patch,platform:v.platform,videoId:v.id,part:v.part,url:v.canonicalUrl,available:true});}catch{}
    }
    return {tracks:[...map.values()],categories:[...seed.categories,{id:'personal-imports',name:'我的导入'}],localCount:map.size,canManage:true};
  }
  function update(id,patch){
    const existing=list().tracks.find(t=>t.id===id);if(!existing)throw new Error('素材不存在');
    const clean={};
    for(const [key,value]of Object.entries(patch)){
      if(['title','key'].includes(key)){if(typeof value!=='string'||value.length>(key==='title'?300:40)||/[\r\n\x00]/.test(value)||(key==='title'&&!value.trim()))throw new Error('名称或调性无效');clean[key]=value.trim();}
      else if(key==='duration'){if(!Number.isFinite(value)||value<0||value>604800)throw new Error('时长无效');clean[key]=value;}
      else if(key==='categoryIds'){if(!Array.isArray(value)||!value.every(id=>list().categories.some(c=>c.id===id)))throw new Error('分类无效');clean[key]=[...new Set(value)];}
      else throw new Error('不支持的字段');
    }
    persist({...state,overrides:{...state.overrides,[id]:{...state.overrides[id],...clean}}});return list().tracks.find(t=>t.id===id);
  }
  function add(tracks){
    const known=new Map(list().tracks.map(t=>[t.url,t])),added=[];
    for(const t of tracks){const clean=makeTrack(parseVideoUrl(t.url));if(!known.has(clean.url)){added.push(clean);known.set(clean.url,clean);}}
    if(added.length)persist({...state,imports:[...state.imports,...added]});return added;
  }
  return {list,update,add};
}
