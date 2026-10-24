import {isHostPage,isPlayerFrame,trustedHost,validateCommand,validBinding} from './protocol.js';
const queues=new Map();
const key=id=>`webdj-tab-${id}`;
const read=async id=>(await chrome.storage.session.get(key(id)))[key(id)];
const save=state=>chrome.storage.session.set({[key(state.tabId)]:state});
const clear=id=>chrome.storage.session.remove(key(id));
function serial(tabId,fn){const prev=queues.get(tabId)||Promise.resolve();const next=prev.catch(()=>{}).then(fn);queues.set(tabId,next);void next.catch(()=>{}).finally(()=>{if(queues.get(tabId)===next)queues.delete(tabId);});return next;}
const failure=message=>({ok:false,phase:'error',message});
async function currentRoot(tabId){const fs=await chrome.webNavigation.getAllFrames({tabId});return fs?.find(f=>f.frameId===0);}
async function activate(tab){
 if(!tab?.id||!isHostPage(tab.url)){await chrome.action.setBadgeText({tabId:tab?.id,text:'限本页'});return;}
 await serial(tab.id,async()=>{
  const root=await currentRoot(tab.id);if(!root||!isHostPage(root.url))return;
  let state=await read(tab.id);
  if(!state||state.rootDocumentId!==root.documentId||state.rootUrl!==root.url){state={tabId:tab.id,rootDocumentId:root.documentId,rootUrl:root.url,session:crypto.randomUUID(),frames:{},bindings:{}};await save(state);}
  await chrome.scripting.executeScript({target:{tabId:tab.id,documentIds:[root.documentId]},world:'ISOLATED',files:['host.js']});
  await chrome.action.setBadgeText({tabId:tab.id,text:'LAB'});
  await chrome.action.setBadgeBackgroundColor({tabId:tab.id,color:'#718d34'});
 });
}
async function discover(state){
 const all=await chrome.webNavigation.getAllFrames({tabId:state.tabId}),fresh={};
 for(const f of all||[]){
  if(f.parentFrameId!==0||!f.documentId||!isPlayerFrame(f.url,state.rootUrl))continue;
  const previous=state.frames[f.documentId];
  fresh[f.documentId]={frameId:f.frameId,documentId:f.documentId,url:f.url,token:previous?.token||crypto.randomUUID(),engineLoaded:previous?.engineLoaded||false};
 }
 state.frames=fresh;
 for(const side of ['a','b','c','d']){const b=state.bindings[side];if(b&&!fresh[b.documentId])delete state.bindings[side];}
 await save(state);
 const errors=[];
 for(const frame of Object.values(fresh)){
  try{
   const config={session:state.session,token:frame.token,frameId:frame.frameId,documentId:frame.documentId,parentOrigin:new URL(state.rootUrl).origin};
   await chrome.scripting.executeScript({target:{tabId:state.tabId,documentIds:[frame.documentId]},world:'ISOLATED',func:config=>{globalThis.__WEBDJ_PITCH_BRIDGE_CONFIG=config;},args:[config]});
   await chrome.scripting.executeScript({target:{tabId:state.tabId,documentIds:[frame.documentId]},world:'ISOLATED',files:['bridge.js']});
  }catch(e){errors.push(String(e.message||e));}
 }
 return {ok:true,count:Object.keys(fresh).length,errors};
}
async function handle(message,sender){
 const tabId=sender?.tab?.id;if(!Number.isInteger(tabId))return failure('此入口只在 WebDJ 页面内使用。');
 return serial(tabId,async()=>{
  const root=await currentRoot(tabId);
  if(message?.type==='HOST_INIT'){
   // Only the current top document can bootstrap. Reject stale senders before mutating any session.
   if(!root||root.frameId!==0||typeof root.documentId!=='string'||!root.documentId||sender.frameId!==0||sender.documentId!==root.documentId||sender.url!==root.url||!isHostPage(root.url))return failure('拒绝来自其他页面或过期文档的初始化。');
   let state=await read(tabId);
   if(!state||state.rootDocumentId!==root.documentId||state.rootUrl!==root.url){state={tabId,rootDocumentId:root.documentId,rootUrl:root.url,session:crypto.randomUUID(),frames:{},bindings:{}};await save(state);}
   return {ok:true,session:state.session,engineVersion:5};
  }
  const state=await read(tabId);if(!state)return failure('请刷新 WebDJ 页面以初始化扩展。');
  if(!root||root.documentId!==state.rootDocumentId||root.url!==state.rootUrl){await clear(tabId);return failure('页面已经变化，请刷新 WebDJ 页面。');}
  if(!trustedHost(sender,state,message?.session))return failure('拒绝来自其他页面或过期会话的控制。');
  if(message.type==='DISCOVER')return discover(state);
  if(!['a','b','c','d'].includes(message.side))return failure('播放器编号无效。');
  if(message.type==='BIND'){
   const f=state.frames[message.documentId];
   if(!f||f.frameId!==message.frameId||f.token!==message.token)return failure('播放器身份已过期，请重新连接。');
   const current=await chrome.webNavigation.getFrame({tabId,frameId:f.frameId});
   if(!validBinding(f,{...current,frameId:f.frameId},state.rootUrl))return failure('播放器已切换，请重新连接。');
   if(Object.entries(state.bindings).some(([side,b])=>side!==message.side&&b.documentId===f.documentId))return failure('不能把同一播放器同时绑定到不同 Deck。');
   state.bindings[message.side]={...f};await save(state);return {ok:true};
  }
  if(message.type!=='COMMAND'||!validateCommand(message.command))return failure('不支持的音频操作。');
  const binding=state.bindings[message.side];
  if(!binding)return failure('请先连接对应播放器。');
  const frame=await chrome.webNavigation.getFrame({tabId,frameId:binding.frameId});
  if(!validBinding(binding,{...frame,frameId:binding.frameId},state.rootUrl)){
   delete state.bindings[message.side];await save(state);return failure('视频已经切换，请重新连接。');
  }
  const target={tabId,documentIds:[binding.documentId]};
  if(!state.frames[binding.documentId]?.engineLoaded){
   await chrome.scripting.executeScript({target,world:'MAIN',files:['pitch-native.js','eq-native.js','reverb-native.js','stop-native.js','frame-engine.js']});
   state.frames[binding.documentId].engineLoaded=true;await save(state);
  }
  const result=await chrome.scripting.executeScript({target,world:'MAIN',func:async command=>{
   if(!globalThis.WebDJFrameEngine)return {ok:false,phase:'error',message:'播放器中的音频引擎未能初始化。'};
   if(globalThis.WebDJFrameEngine.version!==5||globalThis.WebDJFrameEngineUpgradeRequired)return {ok:false,phase:'refresh-required',enabled:false,requiresReconnect:true,message:'扩展已更新，请刷新 WebDJ 页面后重新连接。'};
   return globalThis.WebDJFrameEngine.command(command);
  },args:[message.command]});
  return result[0]?.result||failure('播放器没有返回结果，请重新连接。');
 });
}
chrome.action.onClicked.addListener(tab=>{void activate(tab).catch(async e=>{console.warn('WebDJ activation:',String(e.message||e));await chrome.action.setBadgeText({tabId:tab.id,text:'错误'});});});
chrome.runtime.onMessage.addListener((message,sender,sendResponse)=>{
 if(!['HOST_INIT','DISCOVER','BIND','COMMAND'].includes(message?.type))return false;
 void handle(message,sender).then(sendResponse,e=>sendResponse(failure(String(e.message||e))));return true;
});
chrome.webNavigation.onCommitted.addListener(details=>{
 if(details.frameId===0)void serial(details.tabId,async()=>{
  const state=await read(details.tabId);
  if(details.documentId&&details.documentId===state?.rootDocumentId)return;
  await clear(details.tabId);
 });
});
chrome.tabs.onRemoved.addListener(tabId=>{void serial(tabId,()=>clear(tabId));});
