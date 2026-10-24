export const SITE_ORIGIN='https://webdj-player-lab-jfg.jiafengfeng.chatgpt.site';
export const LAB_ORIGIN='http://127.0.0.1:51946';
export const FRAME_ORIGIN='http://127.0.0.1:51947';
function urlOf(value){try{return new URL(value);}catch{return null;}}
export function isHostPage(value){
 const u=urlOf(value);if(!u||u.username||u.password)return false;
 return (u.protocol==='http:'&&['127.0.0.1','localhost'].includes(u.hostname)&&(['/','/index.html'].includes(u.pathname)||(u.origin===LAB_ORIGIN&&u.pathname==='/lab.html'))&&u.searchParams.get('ui-preview')!=='1')||(u.origin==='https://kokafang.github.io'&&u.pathname.startsWith('/webdj/'))||(u.origin===SITE_ORIGIN&&['/','/studio'].includes(u.pathname));
}
export function isPlayerFrame(value,parentUrl){
 const u=urlOf(value),p=urlOf(parentUrl);if(!u||!p||u.username||u.password)return false;
 if(p.origin===LAB_ORIGIN&&u.origin===FRAME_ORIGIN&&['/frame.html','/cors-frame.html'].includes(u.pathname))return true;
 if(['https://www.youtube.com','https://www.youtube-nocookie.com'].includes(u.origin))return /^\/embed\/[\w-]{11}$/.test(u.pathname);
 if(u.origin==='https://player.bilibili.com'&&u.pathname==='/player.html')return /^BV[A-Za-z0-9]{10}$/.test(u.searchParams.get('bvid')||'')||/^[1-9]\d*$/.test(u.searchParams.get('aid')||'');
 return false;
}
export function trustedHost(sender,state,session){
 return !!(state&&sender?.tab?.id===state.tabId&&sender.frameId===0&&sender.documentId===state.rootDocumentId&&sender.url===state.rootUrl&&isHostPage(sender.url)&&session===state.session);
}
export function validateCommand(command){
 if(!command||typeof command!=='object'||Array.isArray(command))return false;
 const fields={arm:[],probe:[],status:[],transport:['action','time'],'set-fade':['enabled'],'set-loop':['enabled'],'set-fx':['values','send','enabled'],bypass:[],enable:['semitones'],set:['semitones'],'set-speed':['speedPercent'],'set-volume':['volumePercent'],'set-eq':['band','gainDb'],'reset-eq':[]};
 if(!Object.hasOwn(command,'op')||!Object.hasOwn(fields,command.op))return false;
 if(Object.keys(command).some(key=>key!=='op'&&!fields[command.op].includes(key)))return false;
 if(command.op==='transport')return ['play','pause','seek'].includes(command.action)&&(command.action==='seek'?Number.isFinite(command.time)&&command.time>=0&&command.time<=604800:command.time===undefined);
 if(['set-fade','set-loop'].includes(command.op))return typeof command.enabled==='boolean';
 if(command.op==='set-fx'){
  const ranges={decay:[.5,12,.1],predelay:[0,150,1],tone:[800,16000,100],shimmer:[0,100,1],interval:[-12,12,1],return:[0,100,1]};
  return typeof command.enabled==='boolean'&&Number.isInteger(command.send)&&command.send>=0&&command.send<=100&&command.values&&Object.keys(command.values).length===6&&Object.entries(ranges).every(([k,[min,max,step]])=>Number.isFinite(command.values[k])&&command.values[k]>=min&&command.values[k]<=max&&Math.abs(command.values[k]/step-Math.round(command.values[k]/step))<1e-7);
 }
 const pitch=value=>Number.isFinite(value)&&Math.abs(value)<=12;
 if(command.op==='set')return pitch(command.semitones);
 if(command.op==='enable')return command.semitones===undefined||pitch(command.semitones);
 if(command.op==='set-speed')return Number.isInteger(command.speedPercent)&&command.speedPercent>=10&&command.speedPercent<=400;
 if(command.op==='set-volume')return Number.isInteger(command.volumePercent)&&command.volumePercent>=0&&command.volumePercent<=100;
 if(command.op==='set-eq')return ['low','mid','high'].includes(command.band)&&Number.isFinite(command.gainDb)&&command.gainDb>=-26&&command.gainDb<=6&&Number.isInteger(command.gainDb*2);
 return true;
}
export function validBinding(binding,current,parentUrl){
 return !!(binding&&current&&current.parentFrameId===0&&binding.frameId===current.frameId&&binding.documentId===current.documentId&&binding.url===current.url&&isPlayerFrame(current.url,parentUrl));
}
