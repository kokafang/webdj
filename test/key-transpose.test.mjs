import test from 'node:test';
import assert from 'node:assert/strict';
import {transposeKey,describeKey} from '../public/key-transpose.mjs';

test('transposes positive and negative semitones while preserving major/minor and accidental style',()=>{
  for(const [key,shift,expected] of [
    ['Dm',2,'Em'],['Am',-2,'Gm'],['B♭m',-1,'Am'],['E♭m',2,'Fm'],
    ['F#m',-2,'Em'],['C# Major',2,'D# Major'],['EbMajor',-2,'DbMajor'],
    ['C',1,'C♯'],['C',-1,'B'],['B',1,'C'],['A minor',2,'B minor'],
    ['D小调',2,'E小调'],['F大调',-2,'D♯大调'],['C♭m',1,'Cm'],['B#m',1,'C#m'],
  ])assert.equal(transposeKey(key,shift),expected,`${key} ${shift}`);
});

test('handles the Crate alternative-key notation and Camelot notation',()=>{
  assert.equal(transposeKey('Dm / D',2),'Em / E');
  assert.equal(transposeKey('Bm/B',-2),'Am/A');
  assert.equal(transposeKey(' Em / E ',1),'Fm / F');
  assert.equal(transposeKey('8A',1),'3A');
  assert.equal(transposeKey('8B',-1),'1B');
  assert.equal(transposeKey('12A',2),'2A');
});

test('zero and octaves preserve the original notation; unknown input is never guessed',()=>{
  for(const key of ['F#m','B♭m','EbMajor','Dm / D','8A']){
    for(const shift of [0,12,-12])assert.equal(transposeKey(key,shift),key);
  }
  for(const key of ['',null,undefined,'—','unknown','Dm?','C / unknown','13A','Am /'])assert.equal(transposeKey(key,2),null);
  for(const shift of [NaN,Infinity,0.5,'2'])assert.equal(transposeKey('Am',shift),null);
});

test('full key names pair each mode with its correctly spelled relative',()=>{
  for(const [key,label,relative] of [
    ['A','A Major','F♯ Minor'],['F','F Major','D Minor'],['Am','A Minor','C Major'],
    ['A M','A Major','F♯ Minor'],['a minor','A Minor','C Major'],
    ['EbMajor','E♭ Major','C Minor'],['C# Major','C♯ Major','A♯ Minor'],
    ['B♭m','B♭ Minor','D♭ Major'],['E♭m','E♭ Minor','G♭ Major'],
    ['D小调','D Minor','F Major'],['F大调','F Major','D Minor'],
    ['G♭','G♭ Major','E♭ Minor'],['F#m','F♯ Minor','A Major'],
    ['C♭','C♭ Major','A♭ Minor'],['B#','B♯ Major','G𝄪 Minor'],
    ['8A','A Minor','C Major'],['8B','C Major','A Minor'],
  ])assert.deepEqual(describeKey(key),[{label,relative,relativeMode:label.endsWith('Major')?'Minor':'Major'}],key);
});

test('main and relative keys transpose together, including alternatives and octave reset',()=>{
  assert.deepEqual(describeKey('A',2),[{label:'B Major',relative:'G♯ Minor',relativeMode:'Minor'}]);
  assert.deepEqual(describeKey('Am',-2),[{label:'G Minor',relative:'B♭ Major',relativeMode:'Major'}]);
  assert.deepEqual(describeKey('B♭m',1),[{label:'B Minor',relative:'D Major',relativeMode:'Major'}]);
  assert.deepEqual(describeKey('Dm / D',2),[
    {label:'E Minor',relative:'G Major',relativeMode:'Major'},
    {label:'E Major',relative:'C♯ Minor',relativeMode:'Minor'},
  ]);
  for(const key of ['A','F#m','B♭m','Dm / D','8A'])for(const shift of [12,-12])assert.deepEqual(describeKey(key,shift),describeKey(key));
});

test('relative keys are never invented for unknown modes or malformed input',()=>{
  for(const key of ['',null,undefined,'—','unknown','Dm?','C / unknown','Am /','D dorian','13A'])assert.equal(describeKey(key),null);
  for(const shift of [NaN,Infinity,.5,'2'])assert.equal(describeKey('Am',shift),null);
});
