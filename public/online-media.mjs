import {parseVideoUrl,buildEmbedUrl} from './video-url.mjs';
import {extension} from './extension-client.mjs';
let youtubeReady;
function youtubeAPI(){
  if(globalThis.YT?.Player)return Promise.resolve(globalThis.YT);
  return youtubeReady||=new Promise((resolve,reject)=>{
    const previous=window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady=()=>{previous?.();resolve(window.YT);};
    const script=document.createElement('script');script.src='https://www.youtube.com/iframe_api';
    script.onerror=()=>{youtubeReady=null;reject(new Error('YouTube API 暂不可用'));};document.head.append(script);
  });
}
export class OnlineMedia extends EventTarget{
  constructor(placeholder,letter){
    super();this.letter=letter;this.frame=document.createElement('iframe');this.frame.id='player-'+letter.toLowerCase();this.frame.className='online-player';
    this.frame.title=`Deck ${letter} 官方播放器`;this.frame.allow='autoplay; encrypted-media; fullscreen; picture-in-picture';this.frame.allowFullscreen=true;
    this.frame.referrerPolicy='strict-origin-when-cross-origin';this.frame.hidden=true;placeholder.replaceWith(this.frame);
    this.element=document.createElement('canvas');this.element.width=160;this.element.height=90;
    this.state={paused:true,ended:false,duration:NaN,currentTime:0,volume:1,muted:false,playbackRate:1,readyState:0};
    this.poster='';this.source='';this.generation=0;this.processing=false;this.audioState=null;this.hasFrame=false;this.loopValue=false;
    extension.addEventListener('state',e=>{const d=e.detail;if(d.side!==letter.toLowerCase()||d.src!==this.frame.src)return;this.receive(d.result);});
    this.timer=setInterval(()=>{
      if(!this.player||this.processing)return;
      try{this.update({currentTime:this.player.getCurrentTime(),duration:this.player.getDuration(),volume:this.player.getVolume()/100,muted:this.player.isMuted(),playbackRate:this.player.getPlaybackRate()});}catch{}
    },500);
    window.addEventListener('pagehide',()=>clearInterval(this.timer),{once:true});
  }
  update(values){
    const old=this.state;this.state={...old,...values};
    if(this.state.duration>0&&this.state.duration!==old.duration)this.dispatchEvent(new Event('loadedmetadata'));
    if(this.state.paused!==old.paused){this.dispatchEvent(new Event(this.state.paused?'pause':'play'));if(!this.state.paused)this.dispatchEvent(new Event('playing'));}
    if(this.state.ended&&!old.ended){this.dispatchEvent(new Event('ended'));if(this.loop)this.play().catch(()=>{});}
    this.dispatchEvent(new Event('timeupdate'));
  }
  receive(result){
    if(!result)return;this.audioState=result;this.processing=!!result.enabled;
    if(result.media)this.update(result.media);
    this.dispatchEvent(new Event('processingchange'));
    if(result.frame){const generation=this.generation,img=new Image();img.onload=()=>{if(generation!==this.generation)return;this.element.getContext('2d').drawImage(img,0,0,160,90);this.hasFrame=true;this.dispatchEvent(new Event('loadeddata'));};img.src=result.frame;}
  }
  load(){
    const generation=++this.generation,video=parseVideoUrl(this.source);this.video=video;
    this.player?.destroy();this.player=null;this.processing=false;this.audioState=null;this.hasFrame=false;
    this.state={paused:true,ended:false,duration:NaN,currentTime:0,volume:1,muted:false,playbackRate:1,readyState:0};
    // YT.destroy removes its iframe. Reinsert the same direct-child slot.
    if(!this.frame.isConnected)this.container.append(this.frame);
    this.frame.src=buildEmbedUrl(video,location.origin);this.frame.hidden=false;
    this.dispatchEvent(new Event('loadstart'));this.dispatchEvent(new Event('processingchange'));
    if(video.platform==='youtube')youtubeAPI().then(YT=>{
      if(generation!==this.generation)return;
      this.player=new YT.Player(this.frame,{events:{
        onReady:()=>{if(generation!==this.generation)return;this.player.setVolume(100);this.dispatchEvent(new Event('canplay'));this.dispatchEvent(new Event('processingchange'));},
        onStateChange:e=>{if(generation!==this.generation||this.processing)return;this.update({paused:e.data!==1,ended:e.data===0,duration:this.player.getDuration(),currentTime:this.player.getCurrentTime()});},
        onError:()=>{if(generation===this.generation)this.dispatchEvent(new Event('error'));}
      }});
    }).catch(()=>{});
  }
  async play(){if(this.processing)return extension.send(this.letter,{op:'transport',action:'play'});if(this.player?.playVideo)return this.player.playVideo();throw new Error('请在原播放器中点击播放');}
  pause(){if(this.processing)extension.send(this.letter,{op:'transport',action:'pause'}).catch(()=>{});else this.player?.pauseVideo?.();}
  get src(){return this.source;}set src(v){this.source=v;this.container=this.frame.parentElement||this.container;}
  get hidden(){return this.frame.hidden;}set hidden(v){this.frame.hidden=v;}
  get paused(){return this.state.paused;}get ended(){return this.state.ended;}
  get duration(){return this.state.duration;}get currentTime(){return this.state.currentTime;}
  get readyState(){return this.hasFrame?2:0;}get videoWidth(){return this.hasFrame?160:0;}get videoHeight(){return this.hasFrame?90:0;}
  get loop(){return this.loopValue;}set loop(value){this.loopValue=!!value;if(this.processing)extension.send(this.letter,{op:'set-loop',enabled:this.loopValue}).catch(()=>{});}
  get volume(){return this.state.volume;}get muted(){return this.state.muted;}
  get playbackRate(){return this.state.playbackRate;}
}
