const CHANNEL='webdj-online-v1';
class ExtensionClient extends EventTarget{
  constructor(){super();this.connected=false;this.pending=new Map();this.sequence=0;
    if(typeof window==='undefined')return;
    window.addEventListener('message',e=>{
      if(e.source!==window||e.origin!==location.origin||e.data?.channel!==CHANNEL||e.data.direction!=='extension')return;
      const m=e.data;
      if(m.type==='ready'){this.connected=true;this.dispatchEvent(new Event('ready'));}
      if(m.type==='state')this.dispatchEvent(new CustomEvent('state',{detail:m}));
      if(m.type==='reply'){const p=this.pending.get(m.id);if(p){clearTimeout(p.timer);this.pending.delete(m.id);m.result?.ok===false?p.reject(new Error(m.result.message||'扩展操作失败')):p.resolve(m.result);}}
    });
    window.postMessage({channel:CHANNEL,direction:'page',type:'hello'},location.origin);
  }
  send(side,command){
    if(!this.connected)return Promise.reject(new Error('需要 WebDJ Chrome 扩展'));
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('播放器尚未连接，请先在视频中播放'));},4500);
      this.pending.set(id,{resolve,reject,timer});
      window.postMessage({channel:CHANNEL,direction:'page',type:'command',id,side:side.toLowerCase(),src:document.getElementById('player-'+side.toLowerCase())?.src,command},location.origin);
    });
  }
}
export const extension=new ExtensionClient();
