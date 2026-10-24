import test from 'node:test';import assert from 'node:assert/strict';
import {isHostPage,isPlayerFrame,trustedHost,validateCommand,validBinding,SITE_ORIGIN} from '../extension/protocol.js';
test('activation permits configured online hosts and fixture only',()=>{
 for(const url of [SITE_ORIGIN+'/',SITE_ORIGIN+'/studio','http://127.0.0.1:51960/','https://kokafang.github.io/webdj/','http://127.0.0.1:51946/lab.html'])assert.ok(isHostPage(url));
 for(const url of [SITE_ORIGIN+'/manage','https://youtube.com/','http://127.0.0.1:51946/secret','http://127.0.0.1:51946/lab.html?ui-preview=1','http://127.0.0.1:51946/lab.html?x=1&ui-preview=1',SITE_ORIGIN+'.evil.test/',SITE_ORIGIN.replace('https:','http:'),'https://name:pass@'+new URL(SITE_ORIGIN).host+'/'])assert.equal(isHostPage(url),false,url);
});
test('only official embed frames and scoped fixture can be targeted',()=>{
 assert.ok(isPlayerFrame('https://www.youtube.com/embed/Ru4Ukst8YLo',SITE_ORIGIN));
 assert.ok(isPlayerFrame('https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7',SITE_ORIGIN));
 for(const url of ['https://www.youtube.com/watch?v=Ru4Ukst8YLo','https://www.youtube.com.evil.test/embed/Ru4Ukst8YLo','https://player.bilibili.com/','http://127.0.0.1:51947/frame.html'])assert.equal(isPlayerFrame(url,SITE_ORIGIN),false);
 assert.ok(isPlayerFrame('http://127.0.0.1:51947/frame.html','http://127.0.0.1:51946/lab.html'));
});
test('host identity checks session, exact tab and top document',()=>{
 const s={tabId:4,rootDocumentId:'main',rootUrl:SITE_ORIGIN+'/',session:'known'};const sender={tab:{id:4},frameId:0,documentId:'main',url:s.rootUrl};
 assert.ok(trustedHost(sender,s,'known'));
 for(const patch of [{tab:{id:5}},{frameId:7},{documentId:'old'},{url:SITE_ORIGIN+'/studio'}])assert.equal(trustedHost({...sender,...patch},s,'known'),false);
 assert.equal(trustedHost(sender,s,'wrong'),false);
});
test('a binding cannot survive navigation, reassignment or nested frames',()=>{
 const a={frameId:2,documentId:'A',url:'https://www.youtube.com/embed/Ru4Ukst8YLo'},current={...a,parentFrameId:0};
 assert.ok(validBinding(a,current,SITE_ORIGIN));
 for(const patch of [{frameId:3},{documentId:'B'},{parentFrameId:2},{url:'https://www.youtube.com/embed/jfKfPfyJRdk'}])assert.equal(validBinding(a,{...current,...patch},SITE_ORIGIN),false);
});
test('commands reject unbounded, nonnumeric and arbitrary properties',()=>{
 for(const op of ['probe','enable','bypass','status'])assert.ok(validateCommand({op}));
 assert.ok(validateCommand({op:'set',semitones:-12}));assert.ok(validateCommand({op:'enable',semitones:12}));
 for(const command of [{op:'set'},{op:'set',semitones:'2'},{op:'set',semitones:Infinity},{op:'set',semitones:13},{op:'fetch',url:'https://example.com'},{op:'status',eval:'x'},null])assert.equal(validateCommand(command),false);
});


test('speed and EQ commands enforce operation-specific values and properties',()=>{
 for(const speedPercent of [10,25,73,100,127,400])assert.ok(validateCommand({op:'set-speed',speedPercent}));
 for(const speedPercent of [9,401,100.5,'100',NaN,Infinity,undefined])assert.equal(validateCommand({op:'set-speed',speedPercent}),false);
 for(const band of ['low','mid','high'])for(const gainDb of [-26,-6.5,0,6])assert.ok(validateCommand({op:'set-eq',band,gainDb}));
 for(const command of [
  {op:'set-eq',band:'bass',gainDb:0},{op:'set-eq',band:'low',gainDb:6.5},{op:'set-eq',band:'low',gainDb:-26.5},{op:'set-eq',band:'mid',gainDb:.1},{op:'set-eq',band:'high',gainDb:'0'},
  {op:'set-speed',speedPercent:100,semitones:3},{op:'status',semitones:2},{op:'reset-eq',band:'low'},{op:'bypass',speedPercent:100},{op:'toString'},
 ])assert.equal(validateCommand(command),false,JSON.stringify(command));
 assert.ok(validateCommand({op:'reset-eq'}));
});


test('output volume is an independently bounded operation',()=>{
 for(const volumePercent of [0,1,73,99,100])assert.ok(validateCommand({op:'set-volume',volumePercent}));
 for(const volumePercent of [-1,101,73.5,NaN,Infinity,'50',null,undefined])assert.equal(validateCommand({op:'set-volume',volumePercent}),false);
 assert.equal(validateCommand({op:'set-volume',volumePercent:50,speedPercent:100}),false);
 assert.equal(validateCommand({op:'bypass',volumePercent:100}),false);
});


test('automatic arm is a strict no-argument operation',()=>{
 assert.equal(validateCommand({op:'arm'}),true);
 for(const command of [{op:'arm',semitones:0},{op:'arm',speedPercent:100},{op:'arm',volumePercent:100},{op:'arm',autoplay:true},{op:'arm',session:'x'},{op:'arm',args:[]},Object.create({op:'arm'})])assert.equal(validateCommand(command),false);
});
