import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as protocol from '../extension/protocol.js';

const text = (await readFile(new URL('../extension/background.js', import.meta.url), 'utf8')).replace(/^import[^\n]+\n/, 'const {isHostPage,isPlayerFrame,trustedHost,validateCommand,validBinding} = protocol;\n');
const clone = value => value === undefined ? undefined : structuredClone(value);
function event() { return { listener: null, addListener(fn) { this.listener = fn; }, fire(...args) { return this.listener?.(...args); } }; }
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  const tabId = 10;
  const rootUrl = `${protocol.SITE_ORIGIN}/`;
  const env = {
    tabId, rootUrl, values: {}, calls: [], processed: [], frameGlobals: new Map(),
    frames: [
      { frameId: 0, parentFrameId: -1, documentId: 'root-1', url: rootUrl },
      { frameId: 1, parentFrameId: 0, documentId: 'deck-a-1', url: 'https://www.youtube.com/embed/Ru4Ukst8YLo' },
      { frameId: 2, parentFrameId: 0, documentId: 'deck-b-1', url: 'https://player.bilibili.com/player.html?bvid=BV1GJ411x7h7' },
      { frameId: 3, parentFrameId: 1, documentId: 'nested-1', url: 'https://www.youtube.com/embed/jfKfPfyJRdk' },
      { frameId: 4, parentFrameId: 0, documentId: 'unrelated-1', url: 'https://example.org/' },
    ],
  };
  let serial = 0;
  const chrome = {
    storage: { session: {
      async get(key) { return { [key]: clone(env.values[key]) }; },
      async set(values) { Object.assign(env.values, clone(values)); },
      async remove(key) { delete env.values[key]; },
    } },
    webNavigation: {
      async getAllFrames({ tabId }) { return tabId === env.tabId ? clone(env.frames) : undefined; },
      async getFrame({ frameId }) { return clone(env.frames.find(frame => frame.frameId === frameId)); },
      onCommitted: event(),
    },
    tabs: { onRemoved: event() },
    action: { onClicked: event(), async setBadgeText() {}, async setBadgeBackgroundColor() {} },
    runtime: { onMessage: event() },
    scripting: { async executeScript(call) {
      env.calls.push(call);
      if (env.beforeExecute) await env.beforeExecute(call);
      const documentId = call.target.documentIds?.[0];
      const frame = env.frames.find(frame => frame.documentId === documentId);
      if (!frame) throw new Error(`No document ${documentId}`);
      if (call.files?.includes('frame-engine.js')) {
        env.frameGlobals.set(documentId, { WebDJFrameEngine: { version: 5, async command(command) {
          env.processed.push({ documentId, command: clone(command) });
          return { ok: true, phase: 'active', enabled: true, semitones: command.semitones || 0, source: documentId };
        } } });
      }
      if (call.func && call.world === 'MAIN') {
        const context = vm.createContext({ ...env.frameGlobals.get(documentId), command: clone(call.args[0]) });
        const result = await vm.runInContext(`(${call.func.toString()})(command)`, context);
        return [{ documentId, frameId: frame.frameId, result }];
      }
      return [{ documentId, frameId: frame.frameId }];
    } },
  };
  env.chrome = chrome;
  env.restart = () => {
    for (const item of [chrome.action.onClicked, chrome.runtime.onMessage, chrome.webNavigation.onCommitted, chrome.tabs.onRemoved]) item.listener = null;
    vm.runInContext(text, vm.createContext({ chrome, protocol, crypto: { randomUUID: () => `nonce-${++serial}` }, URL, console }));
  };
  env.sender = () => ({ tab: { id: tabId }, frameId: 0, documentId: env.frames[0].documentId, url: env.frames[0].url });
  env.request = (message, sender = env.sender()) => new Promise(resolve => {
    assert.equal(chrome.runtime.onMessage.fire(message, sender, resolve), true, 'asynchronous response channel remains open');
  });
  env.state = () => env.values[`webdj-tab-${tabId}`];
  env.activate = async () => {
    chrome.action.onClicked.fire({ id: tabId, url: env.frames[0].url });
    await tick();
    const init = await env.request({ type: 'HOST_INIT' });
    assert.equal(init.ok, true);
    env.session = init.session;
    return init;
  };
  env.discover = () => env.request({ type: 'DISCOVER', session: env.session });
  env.bind = async (side, documentId) => {
    const frame = env.state().frames[documentId];
    return env.request({ type: 'BIND', session: env.session, side, token: frame.token, frameId: frame.frameId, documentId });
  };
  env.command = (side, command) => env.request({ type: 'COMMAND', session: env.session, side, command });
  env.restart();
  return env;
}
async function boundFixture() {
  const env = fixture();
  await env.activate();
  await env.discover();
  assert.equal((await env.bind('a', 'deck-a-1')).ok, true);
  assert.equal((await env.bind('b', 'deck-b-1')).ok, true);
  return env;
}

test('toolbar activation discovers only direct allowed frames and injects a scoped bridge', async () => {
  const env = fixture();
  assert.equal(env.state(), undefined);
  await env.activate();
  const discovery = await env.discover();
  assert.equal(discovery.count, 2);
  assert.deepEqual(Object.keys(env.state().frames).sort(), ['deck-a-1', 'deck-b-1']);
  const bridges = env.calls.filter(call => call.files?.includes('bridge.js'));
  assert.deepEqual(bridges.map(call => call.target.documentIds[0]).sort(), ['deck-a-1', 'deck-b-1']);
  assert.ok(bridges.every(call => call.world === 'ISOLATED'));
  assert.equal(env.calls.some(call => call.world === 'MAIN'), false);
});

test('binding rejects forged tokens and duplicate A/B use of the same frame', async () => {
  const env = fixture();
  await env.activate(); await env.discover();
  const frame = env.state().frames['deck-a-1'];
  const rejected = await env.request({ type: 'BIND', session: env.session, side: 'a', frameId: frame.frameId, documentId: frame.documentId, token: 'wrong' });
  assert.equal(rejected.ok, false);
  assert.equal((await env.bind('a', 'deck-a-1')).ok, true);
  assert.equal((await env.bind('b', 'deck-a-1')).ok, false);
});

test('commands route to exact A/B document identities and load each engine once', async () => {
  const env = await boundFixture();
  assert.equal((await env.command('a', { op: 'enable', semitones: 5 })).source, 'deck-a-1');
  assert.equal((await env.command('b', { op: 'enable', semitones: -5 })).source, 'deck-b-1');
  assert.equal((await env.command('a', { op: 'set', semitones: 2 })).source, 'deck-a-1');
  assert.deepEqual(env.processed.map(item => [item.documentId, item.command.semitones]), [['deck-a-1', 5], ['deck-b-1', -5], ['deck-a-1', 2]]);
  const engines = env.calls.filter(call => call.files?.includes('frame-engine.js'));
  assert.equal(engines.length, 2);
  assert.ok(engines.every(call => call.world === 'MAIN' && call.target.documentIds.length === 1));
});

test('same frameId with a new document is rejected before processing and requires new binding', async () => {
  const env = await boundFixture();
  await env.command('a', { op: 'enable', semitones: 5 });
  env.frames[1] = { ...env.frames[1], documentId: 'deck-a-2' };
  assert.equal((await env.command('a', { op: 'set', semitones: 4 })).ok, false);
  assert.equal(env.processed.length, 1);
  assert.equal(env.state().bindings.a, undefined);
  await env.discover();
  assert.equal((await env.bind('a', 'deck-a-2')).ok, true);
  assert.equal((await env.command('a', { op: 'enable', semitones: 4 })).source, 'deck-a-2');
});

test('navigation after validation cannot redirect a pending command into a replacement document', async () => {
  const env = await boundFixture();
  await env.command('a', { op: 'enable', semitones: 5 });
  env.beforeExecute = call => {
    if (call.func && call.world === 'MAIN') env.frames[1] = { ...env.frames[1], documentId: 'deck-a-2' };
  };
  const result = await env.command('a', { op: 'set', semitones: 7 });
  assert.equal(result.ok, false);
  assert.equal(env.processed.length, 1);
  assert.match(result.message, /No document/);
});

test('service worker restart preserves session and bindings without duplicating audio engine injection', async () => {
  const env = await boundFixture();
  await env.command('a', { op: 'enable', semitones: 5 });
  const session = env.session;
  env.restart();
  const init = await env.request({ type: 'HOST_INIT' });
  assert.equal(init.session, session);
  assert.equal((await env.command('a', { op: 'bypass' })).source, 'deck-a-1');
  assert.equal(env.calls.filter(call => call.files?.includes('frame-engine.js')).length, 1);
});

test('foreign sender and old session cannot issue commands on a valid binding', async () => {
  const env = await boundFixture();
  const message = { type: 'COMMAND', session: env.session, side: 'a', command: { op: 'enable', semitones: 3 } };
  for (const patch of [{ frameId: 1, documentId: 'deck-a-1' }, { tab: { id: 11 } }, { documentId: 'old-root' }, { url: `${protocol.SITE_ORIGIN}/studio` }]) {
    assert.equal((await env.request(message, { ...env.sender(), ...patch })).ok, false);
  }
  assert.equal((await env.request({ ...message, session: 'old-session' })).ok, false);
  assert.equal(env.processed.length, 0);
});

test('top document navigation and tab removal clear persisted authorization', async () => {
  const env = await boundFixture();
  const previous = env.session;
  env.frames[0] = { ...env.frames[0], documentId: 'root-2' };
  env.chrome.webNavigation.onCommitted.fire({ tabId: env.tabId, frameId: 0 });
  await tick();
  assert.equal(env.state(), undefined);
  assert.equal((await env.command('a', { op: 'enable', semitones: 3 })).ok, false);
  await env.activate();
  assert.notEqual(env.session, previous);
  env.chrome.tabs.onRemoved.fire(env.tabId);
  await tick();
  assert.equal(env.state(), undefined);
});


test('speed and EQ route independently, with EQ dependency installed before frame engine', async () => {
 const env=await boundFixture();
 const commands=[['a',{op:'set-speed',speedPercent:73}],['b',{op:'set-speed',speedPercent:127}],['a',{op:'set-eq',band:'low',gainDb:-6.5}],['b',{op:'reset-eq'}],['a',{op:'set-volume',volumePercent:0}],['b',{op:'set-volume',volumePercent:73}]];
 for(const [side,command] of commands)assert.equal((await env.command(side,command)).ok,true);
 assert.deepEqual(env.processed.map(v=>[v.documentId,v.command]),commands.map(([side,c])=>[`deck-${side}-1`,c]));
 assert.ok(env.calls.filter(v=>v.files?.includes('frame-engine.js')).every(v=>v.files.indexOf('eq-native.js')<v.files.indexOf('frame-engine.js')));
});

test('old audio engines require refresh and are never sent new commands', async () => {
 const env=await boundFixture();await env.command('a',{op:'enable'});
 const old=env.frameGlobals.get('deck-a-1');old.WebDJFrameEngine.version=2;
 const count=env.processed.length,result=await env.command('a',{op:'set-speed',speedPercent:73});
 assert.equal(result.phase,'refresh-required');assert.equal(result.ok,false);assert.equal(env.processed.length,count);
});


test('automatic HOST_INIT bootstraps only the verified current top document without a toolbar click', async()=>{
 for(const url of [protocol.SITE_ORIGIN+'/',protocol.SITE_ORIGIN+'/studio?crate=personal','http://127.0.0.1:51946/lab.html']){
  const env=fixture();env.frames[0].url=url;
  const init=await env.request({type:'HOST_INIT'});
  assert.equal(init.ok,true,url);assert.equal(typeof init.session,'string');assert.equal(init.engineVersion,5);
  assert.equal(env.state().rootUrl,url);assert.equal(env.state().rootDocumentId,'root-1');
  assert.equal(env.calls.length,0,'Bootstrap must not inject or process media');
  const again=await env.request({type:'HOST_INIT'});assert.equal(again.session,init.session);
 }
});

test('automatic HOST_INIT rejects foreign, subframe, missing and stale identities without authorization',async()=>{
 for(const patch of [{frameId:1,documentId:'deck-a-1'},{tab:{id:11}},{documentId:'old-root'},{documentId:undefined},{frameId:undefined},{url:protocol.SITE_ORIGIN+'/studio'},{url:'https://example.org/'},{tab:{id:'10'}}]){
  const env=fixture();const result=await env.request({type:'HOST_INIT'},{...env.sender(),...patch});
  assert.equal(result.ok,false,JSON.stringify(patch));assert.deepEqual(env.values,{});assert.equal(env.calls.length,0);
 }
 for(const url of [protocol.SITE_ORIGIN+'/manage',protocol.SITE_ORIGIN+'/studio/','http://127.0.0.1:51947/lab.html','http://127.0.0.1:51946/frame.html','http://127.0.0.1:51946/lab.html?ui-preview=1','http://127.0.0.1:51946/lab.html?x=1&ui-preview=1','https://example.org/']){
  const env=fixture();env.frames[0].url=url;
  assert.equal((await env.request({type:'HOST_INIT'})).ok,false,url);assert.deepEqual(env.values,{});
 }
});

test('no command, bind or discovery message can bootstrap authorization',async()=>{
 const env=fixture();
 for(const message of [{type:'DISCOVER',session:'unknown'},{type:'BIND',session:'unknown',side:'a',documentId:'deck-a-1',frameId:1,token:'forged'},{type:'COMMAND',session:'unknown',side:'a',command:{op:'arm'}}]){
  assert.equal((await env.request(message)).ok,false);assert.equal(env.state(),undefined);
 }
 assert.equal(env.calls.length,0);
});

test('concurrent automatic initialization keeps one session and toolbar remains a refresh fallback',async()=>{
 const env=fixture();const init=await Promise.all(Array.from({length:6},()=>env.request({type:'HOST_INIT'})));
 assert.ok(init.every(result=>result.ok&&result.session===init[0].session));
 await env.activate();assert.equal(env.session,init[0].session);
 assert.equal(env.calls.filter(call=>call.files?.includes('host.js')).length,1);
});

test('a new valid top document creates a new session while stale HOST_INIT cannot erase or acquire it',async()=>{
 const env=await boundFixture(),oldSender=env.sender(),oldSession=env.session;
 env.frames[0]={...env.frames[0],documentId:'root-2'};
 const before=clone(env.state());
 assert.equal((await env.request({type:'HOST_INIT'},oldSender)).ok,false);assert.deepEqual(env.state(),before);
 const current=await env.request({type:'HOST_INIT'});assert.equal(current.ok,true);assert.notEqual(current.session,oldSession);
 assert.deepEqual(env.state().frames,{});assert.deepEqual(env.state().bindings,{});
 assert.equal((await env.request({type:'HOST_INIT'},oldSender)).ok,false);assert.equal(env.state().session,current.session);
 assert.equal((await env.request({type:'COMMAND',session:oldSession,side:'a',command:{op:'arm'}},oldSender)).ok,false);
 assert.equal(env.processed.length,0);
});

test('arm routes to the exact bound document with a v5 engine and never accepts extra arguments',async()=>{
 const env=fixture();const init=await env.request({type:'HOST_INIT'});env.session=init.session;
 await env.discover();assert.equal((await env.bind('a','deck-a-1')).ok,true);
 assert.equal((await env.command('a',{op:'arm',semitones:0})).ok,false);assert.equal(env.processed.length,0);
 assert.equal((await env.command('a',{op:'arm'})).source,'deck-a-1');
 assert.deepEqual(env.processed,[{documentId:'deck-a-1',command:{op:'arm'}}]);
 env.frameGlobals.get('deck-a-1').WebDJFrameEngine.version=3;
 const result=await env.command('a',{op:'arm'});
 assert.equal(result.phase,'refresh-required');assert.equal(env.processed.length,1);
});

test('manifest automatically loads only the top host UI with unchanged permissions',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../extension/manifest.json',import.meta.url),'utf8'));
 assert.equal(manifest.version,'1.0.0');assert.equal(manifest.minimum_chrome_version,'124');
 assert.deepEqual(manifest.permissions,['scripting','storage','webNavigation']);
 assert.ok(manifest.host_permissions.includes('https://kokafang.github.io/*'));assert.ok(!manifest.host_permissions.includes('<all_urls>'));assert.ok(!manifest.permissions.includes('tabCapture'));
 assert.equal(manifest.content_scripts.length,1);
 const entry=manifest.content_scripts[0];
 assert.deepEqual(entry.js,['host.js']);assert.equal(entry.run_at,'document_idle');assert.equal(entry.all_frames,false);
 assert.deepEqual(entry.matches,['http://127.0.0.1/*','http://localhost/*','https://kokafang.github.io/webdj/*']);
 assert.ok(!entry.matches.some(value=>value.includes('youtube')||value.includes('bilibili')));
});

test('late top-document commit preserves the new automatic session but a different document clears it',async()=>{
 const env=fixture();const previous=await env.request({type:'HOST_INIT'});
 env.frames[0]={...env.frames[0],documentId:'root-2'};
 const initializing=env.request({type:'HOST_INIT'});
 // Chrome can deliver this notification after the new content script has queued its initialization.
 env.chrome.webNavigation.onCommitted.fire({tabId:env.tabId,frameId:0,documentId:'root-2'});
 const current=await initializing;await tick();
 assert.equal(current.ok,true);assert.notEqual(current.session,previous.session);
 assert.equal(env.state()?.session,current.session,'A late commit for the initialized document must preserve its authorization');
 env.session=current.session;await env.discover();assert.equal((await env.bind('a','deck-a-1')).ok,true);
 assert.equal((await env.command('a',{op:'arm'})).source,'deck-a-1');
 env.frames[0]={...env.frames[0],documentId:'root-3'};
 env.chrome.webNavigation.onCommitted.fire({tabId:env.tabId,frameId:0,documentId:'root-3'});
 await tick();assert.equal(env.state(),undefined);
 assert.equal((await env.command('a',{op:'arm'})).ok,false);
 assert.equal(env.processed.length,1,'The old binding must not process commands after a different document commits');
});


test('C and D bind to independent direct frames and cannot steal A or B',async()=>{
 const env=await boundFixture();
 env.frames.push({frameId:5,parentFrameId:0,documentId:'deck-c-1',url:'https://www.youtube.com/embed/pryXW1noXpI'},{frameId:6,parentFrameId:0,documentId:'deck-d-1',url:'https://www.youtube.com/embed/wQyHPJ56aNg'});
 await env.discover();
 assert.equal((await env.bind('c','deck-a-1')).ok,false);
 assert.equal((await env.bind('c','deck-c-1')).ok,true);
 assert.equal((await env.bind('d','deck-c-1')).ok,false);
 assert.equal((await env.bind('d','deck-d-1')).ok,true);
 assert.equal((await env.command('c',{op:'set-speed',speedPercent:10})).source,'deck-c-1');
 assert.equal((await env.command('d',{op:'set-eq',band:'low',gainDb:-26})).source,'deck-d-1');
 assert.equal((await env.command('a',{op:'status'})).source,'deck-a-1');
});
