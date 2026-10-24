import test from 'node:test';
import assert from 'node:assert/strict';
import {splitPitch,stepPitch,coarsePitch,describeKey} from '../public/key-transpose.mjs';

test('one-cent steps are exact, carry at 100 cents and cancel without drift',()=>{
 for(const direction of [-1,1]){let pitch=0;for(let i=1;i<=125;i++){pitch=stepPitch(pitch,direction);assert.equal(pitch,direction*i/100);}assert.deepEqual(splitPitch(pitch),{semitones:direction,cents:direction*25});for(let i=0;i<125;i++)pitch=stepPitch(pitch,-direction);assert.equal(pitch,0);assert.deepEqual(splitPitch(pitch),{semitones:0,cents:0});}
 assert.deepEqual(splitPitch(-.01),{semitones:0,cents:-1});assert.deepEqual(splitPitch(.99),{semitones:0,cents:99});
});
test('semitone buttons preserve fractional tuning and range endpoints never overshoot',()=>{
 assert.equal(stepPitch(.23,100),1.23);assert.equal(stepPitch(-1.23,-100),-2.23);
 assert.equal(stepPitch(.01,-100),-.99);assert.equal(stepPitch(11.99,100),12);assert.equal(stepPitch(-11.99,-1),-12);
 assert.equal(stepPitch(12,1),12);assert.equal(stepPitch(-12,-100),-12);
 assert.equal(coarsePitch(1.23,3),3.23);assert.equal(coarsePitch(-1.23,-3),-3.23);assert.equal(coarsePitch(11.23,12),12);
 for(const value of [NaN,Infinity,-12.01,12.01,'1'])assert.throws(()=>splitPitch(value));
 assert.throws(()=>stepPitch(0,.5));assert.throws(()=>coarsePitch(0,1.5));
});
test('microtuning keeps full main and relative keys available',()=>{
 for(const value of [.01,.99,-.01,-.99,1.01,-1.01]){const pitch=splitPitch(value);const key=describeKey('A Major',pitch.semitones)[0];assert.ok(key.label.endsWith('Major'));assert.ok(key.relative.endsWith('Minor'));}
 assert.equal(describeKey('A Major',splitPitch(1.01).semitones)[0].label,'A♯ Major');
});

import {OnlineAudio} from '../public/online-audio.mjs';
import {extension} from '../public/extension-client.mjs';
test('online cents travel to the extension as fractional semitones',async()=>{
 const send=extension.send,received=[];extension.send=async(side,command)=>{received.push({side,command});return {ok:true};};
 try{const video=new EventTarget();Object.assign(video,{processing:true,generation:1,receive(){}});const audio=new OnlineAudio(video,()=>{},'C');
  for(const value of [.01,-.01,1.23,-1.23,11.99,0]){audio.set('pitch',value);await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(received.at(-1),{side:'C',command:{op:'set',semitones:value}});}
  for(const value of [.001,12.01,NaN])assert.throws(()=>audio.set('pitch',value));
 }finally{extension.send=send;}
});
