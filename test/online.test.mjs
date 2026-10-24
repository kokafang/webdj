import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createLibrary,parseLinks} from '../public/library.mjs';
import {parseVideoUrl,buildEmbedUrl} from '../public/video-url.mjs';
import {validateCommand} from '../extension/protocol.js';
import {FX_DEFAULTS} from '../public/reverb.mjs';
import {createServer} from '../server.mjs';

test('bulk pasted links normalize, deduplicate and reject unsafe hosts',()=>{
  const result=parseLinks('消息 https://youtu.be/pryXW1noXpI https://www.youtube.com/watch?v=pryXW1noXpI&list=123 [https://www.bilibili.com/video/BV1GJ411x7h7?p=2] https://evil.test/watch?v=pryXW1noXpI');
  assert.equal(result.tracks.length,2);assert.equal(result.invalid.length,1);assert.equal(result.tracks[1].part,2);
  for(const url of ['javascript:alert(1)','https://youtube.com.evil.test/watch?v=pryXW1noXpI','https://user:password@www.youtube.com/watch?v=pryXW1noXpI'])assert.throws(()=>parseVideoUrl(url));
  const embed=new URL(buildEmbedUrl(parseVideoUrl(result.tracks[0].url),'https://kokafang.github.io'));
  assert.equal(embed.hostname,'www.youtube.com');assert.equal(embed.searchParams.get('autoplay'),'0');assert.equal(embed.searchParams.get('origin'),'https://kokafang.github.io');
});
test('personal imports and key edits persist without altering the seed or another browser',()=>{
  const values=new Map(),storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
  const seed={categories:[],tracks:[]},store=createLibrary(seed,storage);
  const tracks=parseLinks('https://youtu.be/pryXW1noXpI').tracks;
  assert.equal(store.add(tracks).length,1);assert.equal(store.add(tracks).length,0);
  store.update(tracks[0].id,{title:'Rudra Veena',key:'A Minor',categoryIds:['personal-imports']});
  assert.equal(createLibrary(seed,storage).list().tracks[0].key,'A Minor');
  assert.equal(createLibrary(seed,{getItem:()=>null,setItem(){}}).list().tracks.length,0);
  assert.equal(seed.tracks.length,0);assert.throws(()=>store.update(tracks[0].id,{url:'https://evil.test'}));
  assert.throws(()=>store.update(tracks[0].id,{categoryIds:['missing']}));
});
test('library write failure does not claim persistence',()=>{
  const store=createLibrary({tracks:[],categories:[]},{getItem:()=>null,setItem(){throw Error('quota');}});
  assert.throws(()=>store.add(parseLinks('https://youtu.be/pryXW1noXpI').tracks),/quota/);assert.equal(store.list().tracks.length,0);
});
test('published seed contains canonical sources and no local media or private source paths',async()=>{
  const seed=JSON.parse(await readFile(new URL('../public/library.json',import.meta.url),'utf8'));
  assert.equal(seed.tracks.length,184);
  const allowed=new Set(['id','platform','videoId','part','url','title','key','description','categoryIds','thumbnail','duration','available']);
  for(const track of seed.tracks){assert.equal(parseVideoUrl(track.url).id,track.videoId);for(const key of Object.keys(track))assert.ok(allowed.has(key),key);assert.equal(track.duration,null);assert.ok(track.thumbnail.startsWith('https://'));}
  assert.ok(!JSON.stringify(seed).includes('/Users/'));
});
test('extension validates complete FX settings and transport bounds',()=>{
  const fx={op:'set-fx',values:{...FX_DEFAULTS},enabled:true,send:50};
  assert.equal(validateCommand(fx),true);
  for(const change of [{send:101},{send:'50'},{enabled:'yes'},{values:{...FX_DEFAULTS,decay:999}},{values:{...FX_DEFAULTS,extra:1}}])assert.equal(validateCommand({...fx,...change}),false);
  assert.equal(validateCommand({op:'transport',action:'seek',time:60}),true);
  assert.equal(validateCommand({op:'transport',action:'seek',time:Infinity}),false);
  assert.equal(validateCommand({op:'transport',action:'eval'}),false);
});
test('development server serves only public assets and never exposes the vault or extension internals',async()=>{
  const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const base=`http://127.0.0.1:${server.address().port}`;
    for(const pathname of ['/','/app.mjs','/library.json'])assert.equal((await fetch(base+pathname)).status,200);
    for(const pathname of ['/server.mjs','/extension/background.js','/.env','/%2e%2e%2fpackage.json','/media/example.mp4','/api/export'])assert.equal((await fetch(base+pathname)).status,404,pathname);
    assert.equal((await fetch(base+'/',{method:'POST'})).status,405);
  }finally{await new Promise(resolve=>server.close(resolve));}
});
