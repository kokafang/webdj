import {extension} from './extension-client.mjs';
export const RANGES={pitch:[-12,12,1],speed:[10,400,1],volume:[0,100,1],high:[-26,6,.5],mid:[-26,6,.5],low:[-26,6,.5]};
export class OnlineAudio{
  constructor(video,onError,letter){
    this.video=video;this.onError=onError;this.letter=letter;this.values={pitch:0,speed:100,volume:100,high:0,mid:0,low:0};this.pending=new Map();this.sending=false;
    this.stopTransition={reset(){},refresh(){}};this.seekTransition={cancel(){}};
    video.addEventListener('processingchange',()=>{
      const s=video.audioState;if(!s?.enabled){this.connected=false;return;}
      if(!this.connected){this.connected=true;extension.send(this.letter,{op:'set-fade',enabled:this.fade!==false}).catch(()=>{});extension.send(this.letter,{op:'set-loop',enabled:video.loop}).catch(()=>{});}
      const actual={pitch:s.semitones,speed:s.speedPercent,volume:s.volumePercent,...s.eq};
      for(const [name,value]of Object.entries(actual))if(Number.isFinite(value)&&!this.pending.has(name)&&this.inflight!==name)this.values[name]=value;
      video.dispatchEvent(new Event('audiovalueschange'));
    });
  }
  prepare(){}
  async resume(){}
  setPlaybackFade(value){this.fade=value;if(this.video.processing)extension.send(this.letter,{op:'set-fade',enabled:value}).catch(this.onError);}
  set(name,value){
    const range=RANGES[name];if(!range||!Number.isFinite(value)||value<range[0]||value>range[1]||Math.abs(value/range[2]-Math.round(value/range[2]))>1e-8)throw new Error('控制数值超出范围');
    if(!this.video.processing){
      if(name==='volume'&&this.video.player?.setVolume)this.video.player.setVolume(value);
      else if(name==='speed'&&this.video.player?.getAvailablePlaybackRates){const rates=this.video.player.getAvailablePlaybackRates();if(!rates.includes(value/100))throw new Error('此精度需要 WebDJ 扩展；可先使用原播放器速度菜单');this.video.player.setPlaybackRate(value/100);}
      else throw new Error('此控制需要 WebDJ Chrome 扩展，并先播放视频');
      this.values[name]=value;return;
    }
    this.pending.set(name,value);this.values[name]=value;void this.flush();
  }
  async flush(){
    if(this.sending)return;this.sending=true;
    const generation=this.video.generation;
    while(this.pending.size&&generation===this.video.generation){
      const [name,value]=this.pending.entries().next().value;this.pending.delete(name);this.inflight=name;
      const command=name==='pitch'?{op:'set',semitones:value}:name==='speed'?{op:'set-speed',speedPercent:value}:name==='volume'?{op:'set-volume',volumePercent:value}:{op:'set-eq',band:name,gainDb:value};
      try{const s=await extension.send(this.letter,command);if(generation===this.video.generation)this.video.receive(s);}
      catch(e){if(generation===this.video.generation){this.onError(e.message);const s=this.video.audioState;if(!this.pending.has(name))this.values[name]=name==='pitch'?s?.semitones??0:name==='speed'?s?.speedPercent??100:name==='volume'?s?.volumePercent??100:s?.eq?.[name]??0;}}
      this.inflight=null;this.video.dispatchEvent(new Event('audiovalueschange'));
    }
    this.sending=false;if(this.pending.size)void this.flush();
  }
  reset(){
    if(!this.video.source||!this.video.processing){this.pending.clear();Object.assign(this.values,{pitch:0,speed:100,high:0,mid:0,low:0});return;}
    for(const name of ['pitch','speed','high','mid','low'])this.set(name,name==='speed'?100:0);
  }
  level(){return this.video.audioState?.level||0;}
}
