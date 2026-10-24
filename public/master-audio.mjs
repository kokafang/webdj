import {FX_DEFAULTS,validateParameter} from './reverb.mjs';
import {extension} from './extension-client.mjs';
export const SEND_LETTERS=Object.freeze(['A','B','C','D']);
export class MasterAudio{
  constructor(){this.values={...FX_DEFAULTS};this.sends={A:0,B:0,C:0,D:0};this.enabled=true;this.connected=new Set();this.pending=new Set();this.timer=null;
    extension.addEventListener('state',e=>{const {side,result,src}=e.detail,letter=side.toUpperCase();if(typeof document!=='undefined'&&document.getElementById('player-'+side)?.src!==src)return;const was=this.connected.has(letter);if(result?.enabled)this.connected.add(letter);else this.connected.delete(letter);if(!was&&result?.enabled)this.schedule(letter);});
  }
  async resume(){}
  schedule(letter){this.pending.add(letter);clearTimeout(this.timer);this.timer=setTimeout(()=>this.flush(),80);}
  flush(){for(const letter of this.pending){if(this.connected.has(letter))extension.send(letter,{op:'set-fx',values:this.values,send:this.sends[letter],enabled:this.enabled}).catch(e=>{if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('webdj-error',{detail:e.message}));});}this.pending.clear();}
  setSend(letter,value){if(!SEND_LETTERS.includes(letter)||!Number.isInteger(value)||value<0||value>100)throw new RangeError('Send 请输入 0–100');if(value>0&&!this.connected.has(letter))throw new Error(`Deck ${letter} 混响需要扩展音频连接`);this.sends[letter]=value;this.schedule(letter);}
  set(name,value){validateParameter(name,value);this.values[name]=value;for(const letter of this.connected)this.schedule(letter);}
  setEnabled(value){this.enabled=!!value;for(const letter of this.connected)this.schedule(letter);}
  reset(){for(const letter of SEND_LETTERS){this.sends[letter]=0;this.schedule(letter);}this.values={...FX_DEFAULTS};this.enabled=true;}
}
export const masterAudio=new MasterAudio();
