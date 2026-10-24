import test from 'node:test';
import assert from 'node:assert/strict';
import {impulseData,FX_PARAMETERS,FX_DEFAULTS,validateParameter} from '../public/reverb.mjs';
import {MasterAudio} from '../public/master-audio.mjs';

test('all effect limits are finite and validated without clamping corrupt state',()=>{
  for(const [name,p]of Object.entries(FX_PARAMETERS)){
    for(const value of [p.min,p.max,p.initial])assert.equal(validateParameter(name,value),value);
    for(const value of [NaN,Infinity,p.min-p.step,p.max+p.step,p.min+p.step/2,'5',null])assert.throws(()=>validateParameter(name,value),RangeError);
  }
  assert.throws(()=>validateParameter('unknown',1));
});
test('stereo impulses are bounded, normalized and decorrelated at every decay limit',()=>{
  for(const decay of [.5,5,12]){
    const [a,b]=impulseData(48000,decay);let correlation=0;
    for(const data of [a,b]){
      assert.ok(data.length<=48000*13.23);assert.equal(Math.abs(data[0]),0);assert.equal(Math.abs(data.at(-1)),0);
      let energy=0;for(const value of data){assert.ok(Number.isFinite(value));energy+=value*value;}
      assert.ok(Math.abs(energy-1)<1e-6);
    }
    for(let i=0;i<a.length;i++)correlation+=a[i]*b[i];
    assert.ok(Math.abs(correlation)<.05);
    assert.deepEqual(a,impulseData(48000,decay)[0]);
  }
});
test('impulse decay parameter describes approximately 60 dB amplitude loss per duration',()=>{
  for(const decay of [1,5,12]){
    const rate=24000,[a]=impulseData(rate,decay);
    const energy=start=>{let sum=0;for(let i=Math.round(start*rate);i<Math.round((start+.06)*rate);i++)sum+=a[i]**2;return sum;};
    const db=10*Math.log10(energy(.05+decay)/energy(.05));
    assert.ok(db<-58&&db>-62,`${decay}s: ${db} dB`);
  }
});
test('invalid impulse dimensions cannot allocate unbounded audio buffers',()=>{
  for(const [rate,decay]of [[0,5],[48000,NaN],[48000,13],[48000,-1],[Infinity,5],[1000000,12]])assert.throws(()=>impulseData(rate,decay));
});
test('FX defaults and edits leave contexts lazy and sends muted until requested',()=>{
  const engine=new MasterAudio(()=>{throw Error('unexpected audio initialization');});
  assert.deepEqual(engine.sends,{A:0,B:0,C:0,D:0});assert.deepEqual(engine.values,FX_DEFAULTS);
  engine.set('shimmer',70);engine.setEnabled(false);engine.setSend('A',0);engine.reset();
  assert.equal(engine.connected.size,0);assert.throws(()=>engine.setSend('A',50),/扩展/);assert.equal(engine.enabled,true);
  for(const letter of ['A','B','C','D'])for(const value of [-1,101,.5,NaN,'10'])assert.throws(()=>engine.setSend(letter,value),RangeError);
  assert.throws(()=>engine.setSend('E',0),RangeError);assert.deepEqual(engine.values,FX_DEFAULTS);
});
