/* Runs in the isolated top-frame world; UI stays in the website. */
(()=>{
  if(!document.querySelector('meta[name="webdj-online"]')||globalThis.__webdjOnlineHost)return;
  globalThis.__webdjOnlineHost=true;
  const CHANNEL='webdj-online-v1',PROTOCOL='webdj-pitch-v1',sides=['a','b','c','d'];
  const frames=new Map();let session=null,discovering=false,stopped=false,discoveryTimer;
  const post=message=>window.postMessage({channel:CHANNEL,direction:'extension',...message},location.origin);
  const send=message=>chrome.runtime.sendMessage({...message,session});
  function current(side){return document.querySelector(`#player-${side}`);}
  async function discover(){
    if(discovering||stopped)return;discovering=true;
    try{
      if(!session){const init=await chrome.runtime.sendMessage({type:'HOST_INIT'});if(!init?.ok)throw new Error(init?.message);session=init.session;post({type:'ready'});}
      for(const side of sides){const frame=current(side);const previous=frames.get(side);if(!frame?.src||frame.src==='about:blank'){frames.delete(side);continue;}if(!previous||previous.src!==frame.src||previous.frame!==frame)frames.set(side,{frame,src:frame.src,bound:false,binding:false,polling:false});}
      const result=await send({type:'DISCOVER'});if(!result?.ok)return;
      for(const record of frames.values())record.frame.contentWindow?.postMessage({protocol:PROTOCOL,type:'HELLO',session},new URL(record.src).origin);
    }catch{session=null;}finally{discovering=false;}
  }
  window.addEventListener('message',async event=>{
    const m=event.data;
    if(event.source===window&&event.origin===location.origin&&m?.channel===CHANNEL&&m.direction==='page'){
      if(m.type==='hello'){if(session)post({type:'ready'});else void discover();return;}
      if(m.type!=='command'||!sides.includes(m.side)||!Number.isInteger(m.id))return;
      const record=frames.get(m.side);
      if(!record?.bound||record.src!==current(m.side)?.src||m.src!==record.src){post({type:'reply',id:m.id,result:{ok:false,message:'播放器尚未连接，请先在视频中播放'}});return;}
      try{const result=await send({type:'COMMAND',side:m.side,command:m.command});if(frames.get(m.side)!==record)return;post({type:'reply',id:m.id,result});if(result)post({type:'state',side:m.side,src:record.src,result});}
      catch{post({type:'reply',id:m.id,result:{ok:false,message:'扩展已更新，请刷新页面'}});}return;
    }
    if(!session||m?.protocol!==PROTOCOL||m.type!=='READY'||m.session!==session)return;
    const found=[...frames].find(([,r])=>r.frame.contentWindow===event.source&&new URL(r.src).origin===event.origin);
    if(!found)return;const [side,record]=found;
    if(record.binding||record.documentId===m.documentId&&record.bound)return;
    record.binding=true;
    try{
      const result=await send({type:'BIND',side,frameId:m.frameId,documentId:m.documentId,token:m.token});
      if(!result?.ok||frames.get(side)!==record)return;
      record.documentId=m.documentId;record.bound=true;
      const state=await send({type:'COMMAND',side,command:{op:'arm'}});if(frames.get(side)===record)post({type:'state',side,src:record.src,result:state});
    }catch{record.bound=false;}finally{record.binding=false;}
  });
  async function poll(side,record){
    if(!record.bound||record.polling||record.src!==current(side)?.src)return;record.polling=true;
    try{const result=await send({type:'COMMAND',side,command:{op:'status'}});if(frames.get(side)!==record)return;if(result?.requiresReconnect)record.bound=false;post({type:'state',side,src:record.src,result});}catch{record.bound=false;}finally{record.polling=false;}
  }
  const pollTimer=setInterval(()=>{if(!document.hidden)for(const [side,record]of frames)void poll(side,record);},350);
  discoveryTimer=setInterval(()=>void discover(),1600);
  window.addEventListener('pagehide',()=>{stopped=true;clearInterval(pollTimer);clearInterval(discoveryTimer);},{once:true});
  void discover();
})();
