import test from 'node:test';
import assert from 'node:assert/strict';
import {speedToPosition,positionToSpeed} from '../public/deck.mjs';
import {OnlineAudio} from '../public/online-audio.mjs';

test('speed endpoints and normal speed occupy bottom, center and top',()=>{
  for(const [speed,position] of [[10,0],[55,250],[100,500],[250,750],[400,1000]]){
    assert.equal(speedToPosition(speed),position);
    assert.equal(positionToSpeed(position),speed);
  }
});
test('every integer percentage survives the inverse mapping in ascending order',()=>{
  let previous=-1;
  for(let speed=10;speed<=400;speed++){
    const position=speedToPosition(speed);
    assert.ok(position>previous);assert.equal(positionToSpeed(position),speed);previous=position;
  }
  assert.equal(positionToSpeed(-10),10);assert.equal(positionToSpeed(1010),400);
  assert.equal(speedToPosition(0),0);assert.equal(speedToPosition(450),1000);
});
test('precise speed refuses unsupported native rates instead of displaying fake success',()=>{
  const audio=new OnlineAudio(new EventTarget(),()=>{},'A');audio.video.player={getAvailablePlaybackRates:()=>[.25,.5,1,1.5,2],setPlaybackRate(value){audio.actual=value;}};
  audio.set('speed',150);assert.equal(audio.actual,1.5);
  for(const speed of [9,10,73,401,10.5,NaN])assert.throws(()=>audio.set('speed',speed));
  assert.equal(audio.values.speed,150);assert.equal(audio.actual,1.5);
});
