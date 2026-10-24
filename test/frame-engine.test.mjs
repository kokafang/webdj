import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../extension/frame-engine.js', import.meta.url), 'utf8');
const stopSource=await readFile(new URL('../extension/stop-native.js',import.meta.url),'utf8');
const origin = 'http://localhost:54901';
function media(options = {}) {
  const listeners = new Map();
  const writes = [];
  const item = { currentTime: 42, tagName: 'VIDEO', currentSrc: `${origin}/tone.wav`, readyState: 4, crossOrigin: null, paused: false, ended: false, playCalls: 0, pauseCalls: 0, writes, ...options };
  for (const [key, initial] of Object.entries({ muted: false, volume: 0.7, playbackRate: 1, preservesPitch: true })) {
    let value = options[key] ?? initial;
    Object.defineProperty(item, key, { configurable: true, get: () => value, set(next) { writes.push(key); if (key === 'volume' && options.rejectVolume) throw Error('volume rejected'); if (key === 'volume' && options.ignoreVolume) return; if (key === 'playbackRate' && options.rejectRate?.(next)) throw Error('unsupported rate'); if (key === 'preservesPitch' && options.ignorePreservesPitch) return; value = next; if (key === 'playbackRate' && options.syncRateChange) item.emit?.('ratechange'); } });
  }
  item.play = () => { item.playCalls++; };
  item.pause = () => { item.pauseCalls++; };
  item.addEventListener = (type, callback) => listeners.set(type, [...(listeners.get(type) || []), callback]);
  item.emit = type => { for (const callback of listeners.get(type) || []) callback({ type }); };
  return item;
}
function environment(options = {}) {
  const env = { media: options.media || [media()], contexts: [], dsps: [], eqs: [], gains: [], stopGains: [], analysers: [], signal: options.signal ?? 0.25, outputFrequency: options.outputFrequency ?? 0, sourceCalls: 0 };
  const attached = new WeakSet();
  const documentListeners = new Map();
  env.documentEvent = (type, details = {}) => { for (const callback of documentListeners.get(type) || []) callback({ type, isTrusted: true, ...details }); };
  function node(kind) {
    return { kind, connections: [], connect(target) { if (kind === 'source' && options.failSourceConnect && !this.failed) { this.failed = true; throw Error('connect failure'); } this.connections.push(target); return target; }, disconnect() { this.connections = []; } };
  }
  class FakeAudioContext {
    constructor() { this.state = 'suspended'; this.currentTime = 0; this.sampleRate = 48000; this.destination = node('destination'); this.gainCount=0; this.closeCalls = 0; this.resumeCalls = 0; this.listeners = new Map(); env.contexts.push(this); }
    createGain() {
      if (options.gainError) throw Error('gain unavailable');
      const gain = node('volume');
      gain.gain = { value: 1, events: [],
        cancelScheduledValues(time) { this.events.push(['cancel', time]); },
        setValueAtTime(value, time) { this.value = value; this.events.push(['set', value, time]); },
        linearRampToValueAtTime(value, time) { if (env.rejectVolumeTarget?.(value)) throw Error('gain rejected'); this.value = value; this.events.push(['ramp', value, time]); },
      };
      (this.gainCount++%2===0?env.gains:env.stopGains).push(gain); return gain;
    }
    createAnalyser() {
      if (options.failOutputAnalyser && env.analysers.length) throw Error('diagnostic unavailable');
      const analyser = node('analyser');
      analyser.getFloatTimeDomainData = data => {
        if (analyser.fftSize === 4096) {
          for (let i = 0; i < data.length; i++) data[i] = (options.outputAmplitude ?? 0.3) * (env.gains[0]?.gain.value ?? 1) * Math.sin(2 * Math.PI * env.outputFrequency * i / this.sampleRate);
        } else data.fill(env.signal);
      };
      env.analysers.push(analyser);
      return analyser;
    }
    createMediaElementSource(element) {
      env.sourceCalls++;
      if (options.sourceError || attached.has(element)) { const error = Error('already connected'); error.name = options.sourceError || 'InvalidStateError'; throw error; }
      attached.add(element); this.source = node('source'); return this.source;
    }
    addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]); }
    emit(type) { for (const callback of this.listeners.get(type) || []) callback({ type }); }
    async resume() { this.resumeCalls++; if (options.resumeGate) await options.resumeGate; if (options.resumeError) throw Error('resume blocked'); this.state = options.staySuspended ? 'suspended' : 'running'; }
    async close() { this.closeCalls++; this.state = 'closed'; }
  }
  const sandbox = {
    URL, Float32Array, console, clearTimeout,
    setTimeout: (callback, delay) => setTimeout(callback, options.timeoutMs ?? delay),
    location: { href: options.frameUrl || `${origin}/frame.html`, origin: options.frameUrl ? new URL(options.frameUrl).origin : origin },
    document: { createElement:()=>({getContext:()=>({drawImage(){}}),toDataURL:()=>null}), documentElement: {}, addEventListener(type, callback) { documentListeners.set(type, [...(documentListeners.get(type) || []), callback]); }, querySelectorAll: () => env.media, contains: element => env.media.includes(element) },
    MutationObserver: class { constructor(callback) { env.mutate = callback; } observe() {} },
    AudioContext: FakeAudioContext,
    WebDJEQNative: { create(context) {
      if (options.eqError) throw Error('EQ unavailable');
      const eq = { input: node('eq-input'), output: node('eq-output'), settings: { low: 0, mid: 0, high: 0 }, changes: [], resetCalls: 0, disposeCalls: 0,
        setBand(band, db) { if (env.rejectEq?.(band, db)) throw Error('EQ rejected'); this.changes.push([band, db]); this.settings[band] = db; },
        reset() { this.resetCalls++; if (env.rejectEqReset) throw Error('EQ reset failed'); this.settings = { low: 0, mid: 0, high: 0 }; },
        getSettings() { return { ...this.settings }; }, dispose() { this.disposeCalls++; }, context };
      env.eqs.push(eq); return eq;
    } },
    WebDJPitchNative: { create(context) {
      if (options.dspError) throw Error('dsp unavailable');
      const dsp = { input: node('input'), output: node('output'), changes: [], dryCalls: 0, disposeCalls: 0, setSemitones(value) { this.changes.push(value); }, bypass() { this.dryCalls++; }, dispose() { this.disposeCalls++; }, context };
      env.dsps.push(dsp); return dsp;
    } },
  };
  if (options.existingEngine) sandbox.WebDJFrameEngine = options.existingEngine;
  env.vm = vm.createContext(sandbox);
  vm.runInContext(stopSource, env.vm);
  vm.runInContext(source, env.vm);
  env.command = command => env.vm.WebDJFrameEngine.command(command);
  return env;
}
function untouched(item, initialVolumeWrites = 0) {
  assert.equal(item.playCalls, 0);
  assert.equal(item.pauseCalls, 0);
  assert.deepEqual(item.writes, Array(initialVolumeWrites).fill('volume'));
}

test('probe and status do not create audio nodes or change native playback', async () => {
  const env = environment();
  assert.equal((await env.command({ op: 'probe' })).canEnable, true);
  assert.equal((await env.command({ op: 'status' })).phase, 'idle');
  assert.equal(env.contexts.length, 0);
  untouched(env.media[0]);
});

test('unsafe CORS is refused before any media rerouting', async () => {
  const env = environment({ media: [media({ currentSrc: 'https://cdn.example.net/video.mp4' })] });
  const result = await env.command({ op: 'enable', semitones: 3 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'unsafe-cors');
  assert.equal(env.sourceCalls, 0);
  assert.equal(env.contexts.length, 0);
});

test('only one ready media is accepted; unloaded and ambiguous players are refused', async () => {
  for (const items of [[media(), media()], [media({ readyState: 1 })], [media({ currentSrc: '' })]]) {
    const env = environment({ media: items });
    assert.equal((await env.command({ op: 'enable' })).ok, false);
    assert.equal(env.sourceCalls, 0);
  }
});

test('an explicit enable redirects exactly once and confirms real input before active', async () => {
  const env = environment({ signal: 0 });
  const result = await env.command({ op: 'enable', semitones: 3 });
  assert.equal(result.phase, 'awaiting-signal');
  assert.equal(result.verified, false);
  assert.equal(result.semitones, 3);
  env.signal = 0.25;
  assert.equal((await env.command({ op: 'status' })).phase, 'active');
  assert.equal((await env.command({ op: 'status' })).verified, true);
  assert.equal(env.sourceCalls, 1);
  untouched(env.media[0], 1);
});

test('CORS-declared and same-origin blob are candidates, never proof of audible signal', async () => {
  for (const item of [media({ currentSrc: 'https://cdn.example.net/a.mp4', crossOrigin: 'anonymous' }), media({ currentSrc: `blob:${origin}/tone-id` })]) {
    const env = environment({ media: [item], signal: 0 });
    assert.equal((await env.command({ op: 'probe' })).canEnable, true);
    assert.equal((await env.command({ op: 'enable' })).phase, 'awaiting-signal');
    assert.equal((await env.command({ op: 'status' })).verified, false);
  }
});

test('paused media and suspended AudioContext never claim successful audio', async () => {
  const paused = environment({ media: [media({ paused: true })] });
  assert.equal((await paused.command({ op: 'enable' })).phase, 'awaiting-signal');
  untouched(paused.media[0], 1);
  const suspended = environment({ staySuspended: true });
  const result = await suspended.command({ op: 'enable' });
  assert.equal(result.phase, 'suspended');
  assert.equal(result.verified, false);
});

test('bypass preserves live dry path, source reuse, and later adjustments', async () => {
  const env = environment();
  await env.command({ op: 'enable', semitones: 7 });
  const result = await env.command({ op: 'bypass' });
  assert.equal(result.phase, 'bypassed');
  assert.equal(result.enabled, true);
  assert.equal(result.semitones, 0);
  assert.equal(env.contexts[0].state, 'running');
  assert.equal(env.contexts[0].closeCalls, 0);
  assert.equal(env.dsps[0].disposeCalls, 0);
  assert.equal((await env.command({ op: 'set', semitones: -4 })).semitones, -4);
  await env.command({ op: 'enable', semitones: 2 });
  assert.equal(env.sourceCalls, 1);
  untouched(env.media[0], 1);
});

test('source change immediately bypasses, rejects set, and explicit reconnect reuses source', async () => {
  const env = environment();
  await env.command({ op: 'enable', semitones: 4 });
  const before = env.dsps[0].dryCalls;
  env.media[0].currentSrc = `${origin}/other.wav`;
  env.media[0].emit('loadedmetadata');
  const status = await env.command({ op: 'status' });
  assert.equal(status.requiresReconnect, true);
  assert.equal(status.enabled, false);
  assert.equal(status.semitones, 0);
  assert.equal(env.dsps[0].dryCalls, before + 1);
  assert.equal((await env.command({ op: 'set', semitones: 2 })).errorCode, 'not-enabled');
  assert.equal((await env.command({ op: 'enable', semitones: -2 })).phase, 'active');
  assert.equal(env.sourceCalls, 1);
});

test('media replacement leaves the old source dry and never automatically attaches the new one', async () => {
  const env = environment();
  const previous = env.media[0];
  await env.command({ op: 'enable', semitones: 6 });
  env.media = [media()];
  env.mutate();
  assert.equal((await env.command({ op: 'status' })).requiresReconnect, true);
  assert.equal(env.sourceCalls, 1);
  await env.command({ op: 'enable', semitones: -6 });
  assert.equal(env.sourceCalls, 2);
  assert.equal(env.contexts[0].state, 'running');
  untouched(previous, 1);
  untouched(env.media[0], 1);
});

test('other extension attachment failure is explained without touching native media', async () => {
  const env = environment({ sourceError: 'InvalidStateError' });
  const result = await env.command({ op: 'enable' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'media-already-connected');
  assert.match(result.message, /Transpose/);
  assert.equal(env.contexts[0].closeCalls, 1);
  untouched(env.media[0]);
});

test('DSP setup failure occurs before media rerouting', async () => {
  const env = environment({ dspError: true });
  assert.equal((await env.command({ op: 'enable' })).errorCode, 'engine-setup-failed');
  assert.equal(env.sourceCalls, 0);
  assert.equal(env.contexts[0].closeCalls, 1);
});

test('post-routing failure retains a direct source-to-output path and live context', async () => {
  const env = environment({ failSourceConnect: true });
  const result = await env.command({ op: 'enable' });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'processing-route-failed');
  const context = env.contexts[0];
  assert.equal(context.source.connections[0], env.gains[0]);
  assert.deepEqual(env.gains[0].connections, [context.destination]);
  assert.equal(context.state, 'running');
  assert.equal(context.closeCalls, 0);
});

test('source changes during async resume cannot enable stale processing', async () => {
  let release;
  const resumeGate = new Promise(resolve => { release = resolve; });
  const env = environment({ resumeGate });
  const pending = env.command({ op: 'enable', semitones: 5 });
  await Promise.resolve();
  env.media[0].currentSrc = `${origin}/replacement.wav`;
  release();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.requiresReconnect, true);
  assert.deepEqual(env.dsps[0].changes, []);
});

test('two frame engines retain independent state and repeated injection is idempotent', async () => {
  const a = environment();
  const b = environment();
  await a.command({ op: 'enable', semitones: 5 });
  await b.command({ op: 'enable', semitones: -5 });
  const originalApi = a.vm.WebDJFrameEngine;
  vm.runInContext(source, a.vm);
  assert.equal(a.vm.WebDJFrameEngine, originalApi);
  await a.command({ op: 'bypass' });
  assert.equal((await b.command({ op: 'status' })).semitones, -5);
  assert.equal((await a.command({ op: 'status' })).semitones, 0);
});

test('invalid settings and unconnected set do not attach or mutate audio', async () => {
  const env = environment();
  assert.equal((await env.command({ op: 'set', semitones: 2 })).errorCode, 'not-enabled');
  for (const semitones of [-13, 13, Infinity, NaN, '2', null]) {
    assert.equal((await env.command({ op: 'enable', semitones })).errorCode, 'invalid-semitones');
  }
  assert.equal(env.sourceCalls, 0);
  assert.equal((await env.command({ op: 'unknown' })).errorCode, 'invalid-command');
});


test('blocked audio activation has a bounded failure and does not block later commands', async () => {
  const env = environment({ resumeGate: new Promise(() => {}), timeoutMs: 1 });
  const result = await env.command({ op: 'enable', semitones: 4 });
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'audio-activation-required');
  assert.equal(result.enabled, false);
  assert.deepEqual(env.dsps[0].changes, []);
  assert.equal((await env.command({ op: 'set', semitones: 2 })).errorCode, 'not-enabled');
  assert.equal(env.contexts[0].closeCalls, 0);
  untouched(env.media[0]);
});


test('fixture output frequency measures samples independently of requested semitones without a second destination path', async () => {
  const fixtureOrigin = 'http://127.0.0.1:51947';
  const env = environment({ frameUrl: `${fixtureOrigin}/frame.html?frequency=440`, media: [media({ currentSrc: `${fixtureOrigin}/tone.wav` })], outputFrequency: 880 });
  const result = await env.command({ op: 'enable', semitones: 12 });
  assert.ok(Math.abs(result.outputFrequencyHz - 880) <= 0.1);
  const outputAnalyser = env.analysers.find(node => node.fftSize === 4096);
  assert.ok(outputAnalyser);
  assert.deepEqual(env.dsps[0].output.connections, [env.eqs[0].input]);
  assert.equal(env.gains[0].connections.filter(node => node === env.contexts[0].destination).length, 1);
  assert.equal(env.gains[0].connections.filter(node => node === outputAnalyser).length, 1);
  assert.deepEqual(outputAnalyser.connections, []);
  await env.command({ op: 'set', semitones: -12 });
  assert.ok(Math.abs((await env.command({ op: 'status' })).outputFrequencyHz - 880) <= 0.1, 'must read samples, not calculate expected pitch');
  env.outputFrequency = 330;
  assert.ok(Math.abs((await env.command({ op: 'status' })).outputFrequencyHz - 330) <= 0.1);
  env.outputFrequency = 440;
  assert.ok(Math.abs((await env.command({ op: 'bypass' })).outputFrequencyHz - 440) <= 0.1);
});

test('output probe is absent on real platforms, lookalike origins, and the CORS-refusal fixture', async () => {
  for (const frameUrl of ['https://www.youtube.com/embed/M7lc1UVf-VE', 'https://player.bilibili.com/player.html', 'http://localhost:51947/frame.html', 'http://127.0.0.1:51947/cors-frame.html']) {
    const frameOrigin = new URL(frameUrl).origin;
    const env = environment({ frameUrl, media: [media({ currentSrc: `${frameOrigin}/tone.wav` })], outputFrequency: 880 });
    const result = await env.command({ op: 'enable', semitones: 12 });
    assert.equal(Object.hasOwn(result, 'outputFrequencyHz'), false);
    assert.equal(env.analysers.length, 1);
    assert.deepEqual(env.dsps[0].output.connections, [env.eqs[0].input]);
    assert.deepEqual(env.eqs[0].output.connections, [env.stopGains[0]]);
    assert.deepEqual(env.gains[0].connections, [env.contexts[0].destination]);
  }
});

test('fixture reports no output frequency for silence, paused, suspended, or stale media', async () => {
  const fixtureOrigin = 'http://127.0.0.1:51947';
  const env = environment({ frameUrl: `${fixtureOrigin}/frame.html`, media: [media({ currentSrc: `${fixtureOrigin}/tone.wav` })] });
  assert.equal((await env.command({ op: 'enable' })).outputFrequencyHz, null);
  env.outputFrequency = 440;
  env.media[0].paused = true;
  assert.equal((await env.command({ op: 'status' })).outputFrequencyHz, null);
  env.media[0].paused = false;
  env.contexts[0].state = 'suspended';
  assert.equal((await env.command({ op: 'status' })).outputFrequencyHz, null);
  env.contexts[0].state = 'running';
  env.media[0].currentSrc = `${fixtureOrigin}/new.wav`;
  assert.equal((await env.command({ op: 'status' })).outputFrequencyHz, null);
});

test('fixture diagnostic analyser failure leaves the original audio route usable', async () => {
  const fixtureOrigin = 'http://127.0.0.1:51947';
  const env = environment({ frameUrl: `${fixtureOrigin}/frame.html`, media: [media({ currentSrc: `${fixtureOrigin}/tone.wav` })], failOutputAnalyser: true });
  const result = await env.command({ op: 'enable', semitones: 3 });
  assert.equal(result.ok, true);
  assert.equal(result.enabled, true);
  assert.equal(result.outputFrequencyHz, null);
  assert.deepEqual(env.dsps[0].output.connections, [env.eqs[0].input]);
    assert.deepEqual(env.eqs[0].output.connections, [env.stopGains[0]]);
    assert.deepEqual(env.gains[0].connections, [env.contexts[0].destination]);
  assert.equal(env.contexts[0].closeCalls, 0);
});


const plain = value => JSON.parse(JSON.stringify(value));
function playbackUntouched(item) {
  assert.equal(item.playCalls, 0);
  assert.equal(item.pauseCalls, 0);
  assert.equal(item.currentTime, 42);
  assert.equal(item.volume, 1);
  assert.equal(item.muted, false);
  assert.ok(item.writes.every(key => ['volume', 'playbackRate', 'preservesPitch'].includes(key)));
}

test('speed uses native pitch preservation and keeps the independent pitch and EQ settings', async () => {
  const env = environment({ media: [media({ preservesPitch: false })] });
  await env.command({ op: 'enable', semitones: 5 });
  await env.command({ op: 'set-eq', band: 'low', gainDb: -8.5 });
  const changes = env.dsps[0].changes.length;
  const result = await env.command({ op: 'set-speed', speedPercent: 151 });
  assert.equal(result.speedPercent, 151);
  assert.equal(result.requestedSpeedPercent, 151);
  assert.equal(result.preservesPitch, true);
  assert.equal(result.speedOverridden, false);
  assert.equal(result.semitones, 5);
  assert.deepEqual(plain(result.eq), { low: -8.5, mid: 0, high: 0 });
  assert.equal(env.dsps[0].changes.length, changes);
  assert.equal(env.media[0].playbackRate, 1.51);
  playbackUntouched(env.media[0]);
});

test('speed endpoints and fractional EQ controls remain independent across frames', async () => {
  const a = environment(); const b = environment();
  await a.command({ op: 'enable', semitones: 6 });
  await b.command({ op: 'enable', semitones: -6 });
  await a.command({ op: 'set-speed', speedPercent: 25 });
  await b.command({ op: 'set-speed', speedPercent: 400 });
  await a.command({ op: 'set-eq', band: 'high', gainDb: 5.5 });
  await b.command({ op: 'set-eq', band: 'mid', gainDb: -26 });
  assert.equal((await a.command({ op: 'status' })).speedPercent, 25);
  assert.equal((await b.command({ op: 'status' })).speedPercent, 400);
  assert.deepEqual(plain((await a.command({ op: 'status' })).eq), { low: 0, mid: 0, high: 5.5 });
  assert.deepEqual(plain((await b.command({ op: 'status' })).eq), { low: 0, mid: -26, high: 0 });
});

test('individual resets only reset their own control; bypass resets all controls without stopping audio', async () => {
  const env = environment();
  await env.command({ op: 'enable', semitones: 4 });
  await env.command({ op: 'set-speed', speedPercent: 125 });
  await env.command({ op: 'set-eq', band: 'low', gainDb: -4 });
  let result = await env.command({ op: 'set', semitones: 0 });
  assert.equal(result.speedPercent, 125); assert.equal(result.eq.low, -4);
  await env.command({ op: 'set', semitones: 4 });
  result = await env.command({ op: 'set-speed', speedPercent: 100 });
  assert.equal(result.semitones, 4); assert.equal(result.eq.low, -4);
  await env.command({ op: 'set-speed', speedPercent: 125 });
  result = await env.command({ op: 'reset-eq' });
  assert.equal(result.semitones, 4); assert.equal(result.speedPercent, 125);
  assert.deepEqual(plain(result.eq), { low: 0, mid: 0, high: 0 });
  await env.command({ op: 'set-eq', band: 'high', gainDb: 6 });
  result = await env.command({ op: 'bypass' });
  assert.equal(result.phase, 'bypassed'); assert.equal(result.semitones, 0); assert.equal(result.speedPercent, 100);
  assert.deepEqual(plain(result.eq), { low: 0, mid: 0, high: 0 });
  assert.equal(result.enabled, true);
  assert.equal(env.contexts[0].closeCalls, 0);
  playbackUntouched(env.media[0]);
});

test('native rate overrides are reported without a write-back loop', async () => {
  const env = environment();
  await env.command({ op: 'enable', semitones: 3 });
  await env.command({ op: 'set-speed', speedPercent: 150 });
  env.media[0].playbackRate = 1.75;
  const writes = env.media[0].writes.length;
  env.media[0].emit('ratechange');
  const result = await env.command({ op: 'status' });
  assert.equal(result.speedPercent, 175); assert.equal(result.requestedSpeedPercent, 150); assert.equal(result.speedOverridden, true);
  assert.equal(result.semitones, 3);
  await env.command({ op: 'status' });
  assert.equal(env.media[0].writes.length, writes);
  env.media[0].playbackRate = 1.5;
  env.media[0].preservesPitch = false;
  assert.equal((await env.command({ op: 'status' })).speedOverridden, true);
});

test('enable and CORS or activation failures never reset native speed', async () => {
  for (const options of [{}, { resumeError: true }, { media: [media({ currentSrc: 'https://unsafe.example/a.mp4', playbackRate: 1.25, preservesPitch: false })] }]) {
    const env = environment({ media: [media({ playbackRate: 1.25, preservesPitch: false })], ...options });
    const probe = await env.command({ op: 'probe' });
    if (probe.ok) assert.equal(probe.speedPercent, 125);
    await env.command({ op: 'enable', semitones: 2 });
    assert.equal(env.media[0].playbackRate, 1.25);
    assert.equal(env.media[0].preservesPitch, false);
    untouched(env.media[0], options.resumeError || options.media ? 0 : 1);
  }
});

test('unsupported or rejected speed preserves previous pitch, EQ and native settings', async () => {
  const env = environment({ media: [media({ playbackRate: 1.25, preservesPitch: false, rejectRate: rate => rate === 1.5 })] });
  await env.command({ op: 'enable', semitones: 2 });
  await env.command({ op: 'set-eq', band: 'mid', gainDb: 2 });
  const result = await env.command({ op: 'set-speed', speedPercent: 150 });
  assert.equal(result.ok, false); assert.equal(result.errorCode, 'speed-rejected');
  assert.equal(result.speedPercent, 125); assert.equal(result.preservesPitch, false);
  assert.equal(result.semitones, 2); assert.equal(result.eq.mid, 2);
  assert.equal(result.requestedSpeedPercent, null);
  delete env.media[0].preservesPitch;
  assert.equal((await env.command({ op: 'set-speed', speedPercent: 150 })).errorCode, 'preserves-pitch-unavailable');
});

test('a failed pitch-preserving setter never changes the speed', async () => {
  const env = environment({ media: [media({ preservesPitch: false, ignorePreservesPitch: true })] });
  await env.command({ op: 'enable' });
  const result = await env.command({ op: 'set-speed', speedPercent: 130 });
  assert.equal(result.ok, false); assert.equal(result.speedPercent, 100); assert.equal(result.preservesPitch, false);
  assert.equal(env.media[0].writes.includes('playbackRate'), false);
});

test('invalid speed and EQ requests do not mutate any control', async () => {
  const env = environment();
  for (const op of [{ op: 'set-speed', speedPercent: 125 }, { op: 'set-eq', band: 'low', gainDb: 1 }, { op: 'reset-eq' }]) assert.equal((await env.command(op)).errorCode, 'not-enabled');
  await env.command({ op: 'enable', semitones: 2 });
  for (const speedPercent of [9, 401, 125.5, NaN, Infinity, '125', null]) assert.equal((await env.command({ op: 'set-speed', speedPercent })).errorCode, 'invalid-speed');
  for (const [band, gainDb] of [['low', -26.5], ['mid', 6.5], ['high', 0.1], ['wrong', 0], ['low', '2'], ['low', NaN]]) assert.equal((await env.command({ op: 'set-eq', band, gainDb })).errorCode, 'invalid-eq');
  assert.equal(env.eqs[0].changes.length, 0);
  untouched(env.media[0], 1);
});

test('source replacement drops speed ownership, resets audio effects, and never writes into new media', async () => {
  const env = environment();
  await env.command({ op: 'enable', semitones: 5 });
  await env.command({ op: 'set-speed', speedPercent: 150 });
  await env.command({ op: 'set-eq', band: 'low', gainDb: -12 });
  env.media[0].currentSrc = `${origin}/second.wav`;
  env.media[0].playbackRate = 1.1;
  env.media[0].emit('loadedmetadata');
  const writes = env.media[0].writes.length;
  let result = await env.command({ op: 'status' });
  assert.equal(result.requiresReconnect, true); assert.equal(result.requestedSpeedPercent, null);
  assert.equal(result.speedPercent, 110); assert.equal(result.semitones, 0);
  assert.deepEqual(plain(result.eq), { low: 0, mid: 0, high: 0 });
  assert.equal((await env.command({ op: 'bypass' })).ok, false);
  assert.equal((await env.command({ op: 'set-speed', speedPercent: 100 })).ok, false);
  assert.equal(env.media[0].writes.length, writes);
  result = await env.command({ op: 'enable' });
  assert.equal(result.speedPercent, 110); assert.equal(env.sourceCalls, 1);
});

test('EQ construction failure occurs before media rerouting', async () => {
  const env = environment({ eqError: true });
  assert.equal((await env.command({ op: 'enable' })).ok, false);
  assert.equal(env.sourceCalls, 0);
  assert.equal(env.dsps[0].disposeCalls, 1);
  assert.equal(env.contexts[0].closeCalls, 1);
});

test('EQ setter rejection rolls back only EQ and preserves pitch and speed', async () => {
  const env = environment();
  await env.command({ op: 'enable', semitones: 3 });
  await env.command({ op: 'set-speed', speedPercent: 120 });
  await env.command({ op: 'set-eq', band: 'mid', gainDb: 2 });
  env.rejectEq = (band, gain) => band === 'low' && gain === -4;
  const result = await env.command({ op: 'set-eq', band: 'low', gainDb: -4 });
  assert.equal(result.ok, false); assert.equal(result.errorCode, 'eq-rejected');
  assert.equal(result.semitones, 3); assert.equal(result.speedPercent, 120);
  assert.deepEqual(plain(result.eq), { low: 0, mid: 2, high: 0 });
});

test('partial full-reset failure is reported instead of claiming normal speed', async () => {
  const env = environment({ media: [media({ playbackRate: 1.5, rejectRate: rate => rate === 1 })] });
  await env.command({ op: 'enable', semitones: 6 });
  await env.command({ op: 'set-eq', band: 'low', gainDb: -6 });
  const result = await env.command({ op: 'bypass' });
  assert.equal(result.ok, false); assert.equal(result.speedPercent, 150); assert.equal(result.semitones, 0);
  assert.match(result.message, /全部复位未完成/);
  assert.deepEqual(plain(result.eq), { low: 0, mid: 0, high: 0 });
});

test('existing old engine is retained and marked for refresh instead of replacing live routing', async () => {
  const old = Object.freeze({ version: 3, command: async () => ({ ok: true }) });
  const env = environment({ existingEngine: old });
  assert.equal(env.vm.WebDJFrameEngine, old);
  assert.equal(env.vm.WebDJFrameEngineUpgradeRequired.requiredVersion, 5);
  assert.match(env.vm.WebDJFrameEngineUpgradeRequired.message, /刷新/);
  assert.equal(env.contexts.length, 0);
});


test('synchronous native ratechange does not cause a recursive setter or reset other controls', async () => {
  const env = environment({ media: [media({ syncRateChange: true })] });
  await env.command({ op: 'enable', semitones: 3 });
  await env.command({ op: 'set-eq', band: 'high', gainDb: 3 });
  let result = await env.command({ op: 'set-speed', speedPercent: 137 });
  assert.equal(result.speedPercent, 137); assert.equal(result.semitones, 3); assert.equal(result.eq.high, 3);
  assert.equal(env.media[0].writes.filter(key => key === 'playbackRate').length, 1);
  result = await env.command({ op: 'bypass' });
  assert.equal(result.phase, 'bypassed'); assert.equal(result.speedPercent, 100);
  assert.equal(env.media[0].writes.filter(key => key === 'playbackRate').length, 2);
});

test('changing EQ or native speed after full reset never retains a misleading bypassed status', async () => {
  const env = environment();
  await env.command({ op: 'enable' }); await env.command({ op: 'bypass' });
  let result = await env.command({ op: 'set-eq', band: 'mid', gainDb: 1 });
  assert.notEqual(result.phase, 'bypassed'); assert.equal(result.eq.mid, 1);
  assert.doesNotMatch(result.message, /已全部复位/);
  await env.command({ op: 'bypass' });
  env.media[0].playbackRate = 1.25; env.media[0].emit('ratechange');
  result = await env.command({ op: 'status' });
  assert.notEqual(result.phase, 'bypassed'); assert.equal(result.speedOverridden, true);
  assert.doesNotMatch(result.message, /已全部复位/);
});

test('EQ reset failure reports the pitch already reset while preserving actual speed', async () => {
  const env = environment();
  await env.command({ op: 'enable', semitones: 4 });
  await env.command({ op: 'set-speed', speedPercent: 125 });
  await env.command({ op: 'set-eq', band: 'low', gainDb: -4 });
  env.rejectEqReset = true;
  const result = await env.command({ op: 'bypass' });
  assert.equal(result.ok, false); assert.equal(result.semitones, 0); assert.equal(result.speedPercent, 125); assert.equal(result.eq.low, -4);
  assert.match(result.message, /全部复位未完成/);
});

test('each frame has an independent post-EQ output gain; faders never write native volume or other controls', async () => {
  const a = environment(); const b = environment();
  await a.command({ op: 'enable', semitones: 4 });
  await b.command({ op: 'enable', semitones: -3 });
  await a.command({ op: 'set-speed', speedPercent: 125 });
  await a.command({ op: 'set-eq', band: 'low', gainDb: -8 });
  const nativeWrites = [...a.media[0].writes];
  const result = await a.command({ op: 'set-volume', volumePercent: 35 });
  assert.equal(result.volumePercent, 35); assert.equal(result.nativeVolumePercent, 100);
  assert.equal(result.semitones, 4); assert.equal(result.speedPercent, 125); assert.equal(result.eq.low, -8);
  assert.deepEqual(a.eqs[0].output.connections, [a.stopGains[0]]);
  assert.deepEqual(a.gains[0].connections, [a.contexts[0].destination]);
  assert.equal(a.gains[0].gain.value, 0.35);
  assert.equal((await b.command({ op: 'status' })).volumePercent, 100);
  assert.equal(b.gains[0].gain.value, 1);
  assert.deepEqual(a.media[0].writes, nativeWrites);
  assert.equal(a.media[0].playCalls, 0); assert.equal(a.media[0].pauseCalls, 0); assert.equal(a.media[0].currentTime, 42);
});

test('volume uses exact zero and unity endpoints with 30 ms linear ramps', async () => {
  const env = environment(); await env.command({ op: 'enable' });
  const param = env.gains[0].gain;
  assert.equal((await env.command({ op: 'set-volume', volumePercent: 0 })).volumePercent, 0);
  assert.deepEqual(param.events.slice(-3), [['cancel', 0], ['set', 1, 0], ['ramp', 0, 0.03]]);
  env.contexts[0].currentTime = 0.03;
  assert.equal((await env.command({ op: 'set-volume', volumePercent: 100 })).volumePercent, 100);
  assert.deepEqual(param.events.slice(-3), [['cancel', 0.03], ['set', 0, 0.03], ['ramp', 1, 0.06]]);
});

test('rapid fader changes continue from the current envelope instead of its scheduled endpoint', async () => {
  const env = environment(); await env.command({ op: 'enable' });
  await env.command({ op: 'set-volume', volumePercent: 0 });
  env.contexts[0].currentTime = 0.015;
  await env.command({ op: 'set-volume', volumePercent: 75 });
  assert.deepEqual(env.gains[0].gain.events.slice(-3), [['cancel', 0.015], ['set', 0.5, 0.015], ['ramp', 0.75, 0.045]]);
});

test('invalid or unconnected volume changes never attach or change any parameter', async () => {
  const env = environment();
  assert.equal((await env.command({ op: 'set-volume', volumePercent: 50 })).errorCode, 'not-enabled');
  assert.equal(env.contexts.length, 0); untouched(env.media[0]);
  await env.command({ op: 'enable' });
  const events = [...env.gains[0].gain.events];
  for (const volumePercent of [-1, 101, 0.5, NaN, Infinity, '50', null, undefined]) {
    assert.equal((await env.command({ op: 'set-volume', volumePercent })).errorCode, 'invalid-volume');
  }
  assert.deepEqual(env.gains[0].gain.events, events);
  assert.equal((await env.command({ op: 'status' })).volumePercent, 100);
  untouched(env.media[0], 1);
});

test('native volume initialization waits for successful activation and never unmutes or starts playback', async () => {
  let release;
  const resumeGate = new Promise(resolve => { release = resolve; });
  const env = environment({ resumeGate, media: [media({ muted: true })] });
  const pending = env.command({ op: 'enable' });
  await Promise.resolve();
  assert.equal(env.media[0].volume, 0.7); untouched(env.media[0]);
  release();
  const result = await pending;
  assert.equal(result.nativeVolumePercent, 100); assert.equal(env.media[0].volume, 1);
  assert.equal(env.media[0].muted, true); untouched(env.media[0], 1);
  const options = { staySuspended: true };
  const suspended = environment(options);
  await suspended.command({ op: 'enable' });
  assert.equal(suspended.media[0].volume, 0.7); untouched(suspended.media[0]);
  options.staySuspended = false;
  assert.equal((await suspended.command({ op: 'enable' })).nativeVolumePercent, 100);
  untouched(suspended.media[0], 1);
});

test('every setup or activation refusal preserves native volume', async () => {
  for (const options of [
    { media: [media({ currentSrc: 'https://unsafe.example/video.mp4' })] },
    { dspError: true }, { eqError: true }, { gainError: true },
    { sourceError: 'InvalidStateError' }, { failSourceConnect: true }, { resumeError: true },
  ]) {
    const env = environment(options);
    assert.equal((await env.command({ op: 'enable' })).ok, false);
    assert.equal(env.media[0].volume, 0.7); untouched(env.media[0]);
    if (options.gainError) assert.equal(env.sourceCalls, 0, 'gain must exist before rerouting media');
  }
});

test('rejected native volume remains usable and reports actual value without retries', async () => {
  for (const rejection of [{ rejectVolume: true }, { ignoreVolume: true }]) {
    const env = environment({ media: [media({ ...rejection, muted: true })] });
    let result = await env.command({ op: 'enable', semitones: 2 });
    assert.equal(result.ok, true); assert.equal(result.enabled, true);
    assert.equal(result.nativeVolumePercent, 70); assert.equal(result.volumePercent, 100);
    assert.equal(env.media[0].muted, true);
    result = await env.command({ op: 'set-volume', volumePercent: 40 });
    assert.equal(result.volumePercent, 40); assert.equal(result.nativeVolumePercent, 70);
    await env.command({ op: 'status' }); await env.command({ op: 'enable' }); await env.command({ op: 'bypass' });
    untouched(env.media[0], 1);
  }
});

test('native volume changes after initialization are reported but never overwritten by faders, resets, or reconnect', async () => {
  const env = environment(); await env.command({ op: 'enable' });
  env.media[0].volume = 0.2;
  const writes = [...env.media[0].writes];
  await env.command({ op: 'set-volume', volumePercent: 25 });
  await env.command({ op: 'bypass' }); await env.command({ op: 'enable' });
  const result = await env.command({ op: 'status' });
  assert.equal(result.nativeVolumePercent, 20); assert.equal(result.volumePercent, 25);
  assert.deepEqual(env.media[0].writes, writes);
});

test('zero outer volume survives effect resets, source changes and explicit reconnect', async () => {
  const env = environment(); await env.command({ op: 'enable', semitones: 6 });
  await env.command({ op: 'set-volume', volumePercent: 0 });
  await env.command({ op: 'set-speed', speedPercent: 150 });
  await env.command({ op: 'set-eq', band: 'high', gainDb: 6 });
  let result = await env.command({ op: 'bypass' });
  assert.equal(result.phase, 'bypassed'); assert.equal(result.volumePercent, 0); assert.equal(env.gains[0].gain.value, 0);
  env.media[0].volume = 0.3;
  const writes = [...env.media[0].writes];
  env.media[0].currentSrc = `${origin}/next.wav`; env.media[0].emit('loadedmetadata');
  result = await env.command({ op: 'status' });
  assert.equal(result.requiresReconnect, true); assert.equal(result.volumePercent, 0);
  assert.equal((await env.command({ op: 'set-volume', volumePercent: 100 })).ok, false);
  result = await env.command({ op: 'enable' });
  assert.equal(result.volumePercent, 0); assert.equal(result.nativeVolumePercent, 30);
  assert.equal(env.gains[0].gain.value, 0); assert.deepEqual(env.media[0].writes, writes);
});

test('replacement media inherits the Deck fader before rerouting and previous media retains its dry gain', async () => {
  const env = environment(); await env.command({ op: 'enable' });
  await env.command({ op: 'set-volume', volumePercent: 0 });
  const previous = env.media[0];
  env.media = [media()]; env.mutate();
  const result = await env.command({ op: 'enable' });
  assert.equal(result.volumePercent, 0); assert.equal(result.nativeVolumePercent, 100);
  assert.equal(env.gains[0].gain.value, 0); assert.equal(env.gains[1].gain.value, 0);
  assert.deepEqual(env.gains[1].gain.events[0], ['set', 0, 0]);
  assert.equal(env.contexts[0].closeCalls, 0); untouched(previous, 1); untouched(env.media[0], 1);
  await env.command({ op: 'set-volume', volumePercent: 40 });
  env.media = [previous]; env.mutate();
  assert.equal((await env.command({ op: 'enable' })).volumePercent, 40);
  assert.equal(env.gains[0].gain.value, 0.4); assert.equal(env.sourceCalls, 2, 'previous media source is reused');
});

test('post-routing recovery cannot bypass the muted Deck gain', async () => {
  const options = {};
  const env = environment(options); await env.command({ op: 'enable' });
  await env.command({ op: 'set-volume', volumePercent: 0 });
  options.failSourceConnect = true;
  env.media = [media()]; env.mutate();
  const result = await env.command({ op: 'enable' });
  assert.equal(result.ok, false); assert.equal(result.volumePercent, 0);
  assert.equal(env.contexts[1].source.connections[0], env.gains[1]);
  assert.deepEqual(env.gains[1].connections, [env.contexts[1].destination]);
  assert.equal(env.gains[1].gain.value, 0); untouched(env.media[0]);
});

test('fader rejection recovers its previous target without changing any other controls', async () => {
  const env = environment(); await env.command({ op: 'enable', semitones: 3 });
  await env.command({ op: 'set-speed', speedPercent: 120 });
  await env.command({ op: 'set-eq', band: 'low', gainDb: -4 });
  env.rejectVolumeTarget = value => value === 0.4;
  const writes = [...env.media[0].writes];
  const result = await env.command({ op: 'set-volume', volumePercent: 40 });
  assert.equal(result.ok, false); assert.equal(result.errorCode, 'volume-rejected');
  assert.equal(result.volumePercent, 100); assert.equal(env.gains[0].gain.value, 1);
  assert.equal(result.semitones, 3); assert.equal(result.speedPercent, 120); assert.equal(result.eq.low, -4);
  assert.deepEqual(env.media[0].writes, writes);
});

test('fixture analyser follows the output fader and reports no frequency at zero gain', async () => {
  const fixtureOrigin = 'http://127.0.0.1:51947';
  const env = environment({ frameUrl: `${fixtureOrigin}/frame.html`, media: [media({ currentSrc: `${fixtureOrigin}/tone.wav` })], outputFrequency: 440 });
  await env.command({ op: 'enable' });
  const output = env.analysers.find(analyser => analyser.fftSize === 4096);
  assert.deepEqual(env.eqs[0].output.connections, [env.stopGains[0]]);
  assert.deepEqual(env.gains[0].connections, [env.contexts[0].destination, output]);
  assert.deepEqual(output.connections, []);
  let result = await env.command({ op: 'set-volume', volumePercent: 0 });
  assert.equal(result.outputFrequencyHz, null); assert.equal(result.verified, true, 'input signal is distinct from fader silence');
  result = await env.command({ op: 'set-volume', volumePercent: 100 });
  assert.equal(result.outputFrequencyHz, 440);
});

const settleAuto = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };

test('arm prepares a graph before media exists but never reroutes while waiting', async () => {
  const env = environment({ media: [] });
  const result = await env.command({ op: 'arm' });
  assert.equal(result.ok, true); assert.equal(result.armed, true); assert.equal(result.enabled, false);
  assert.equal(result.phase, 'waiting-media'); assert.equal(result.requiresReconnect, false);
  assert.equal(env.contexts.length, 1); assert.equal(env.dsps.length, 1); assert.equal(env.eqs.length, 1);
  assert.equal(env.sourceCalls, 0);
  env.media = [media({ paused: true })]; env.documentEvent('loadeddata');
  await settleAuto();
  const ready = await env.command({ op: 'status' });
  assert.equal(ready.enabled, true); assert.equal(ready.armed, true); assert.equal(ready.phase, 'awaiting-signal');
  assert.equal(env.sourceCalls, 1); assert.equal(env.contexts.length, 1);
  assert.equal(env.media[0].paused, true); untouched(env.media[0], 1);
});

test('arm never redirects loaded media into a suspended context or changes native playback while waiting', async () => {
  const options = { staySuspended: true, media: [media({ paused: true, muted: true })] };
  const env = environment(options);
  const result = await env.command({ op: 'arm' });
  assert.equal(result.ok, true); assert.equal(result.phase, 'waiting-play'); assert.equal(result.enabled, false);
  assert.equal(env.sourceCalls, 0); untouched(env.media[0]);
  await settleAuto();
  options.staySuspended = false;
  env.documentEvent('pointerdown');
  await settleAuto();
  const active = await env.command({ op: 'status' });
  assert.equal(active.enabled, true); assert.equal(active.phase, 'awaiting-signal');
  assert.equal(env.media[0].muted, true); assert.equal(env.media[0].paused, true); untouched(env.media[0], 1);
});

test('a native gesture can activate the prepared graph before a lazy media source becomes ready', async () => {
  const options = { staySuspended: true, media: [media({ readyState: 0, currentSrc: '', paused: true })] };
  const env = environment(options);
  await env.command({ op: 'arm' }); await settleAuto();
  assert.equal(env.sourceCalls, 0);
  options.staySuspended = false; env.documentEvent('keydown'); await settleAuto();
  assert.equal(env.contexts[0].state, 'running'); assert.equal(env.sourceCalls, 0);
  env.media[0].currentSrc = `${origin}/lazy.wav`; env.media[0].readyState = 2;
  env.documentEvent('canplay'); await settleAuto();
  assert.equal((await env.command({ op: 'status' })).enabled, true);
  assert.equal(env.media[0].playCalls, 0); assert.equal(env.sourceCalls, 1);
});

test('pending or rejected automatic activation stays a bounded waiting state and recovers on native play', async () => {
  const options = { resumeError: true };
  const env = environment(options);
  let result = await env.command({ op: 'arm' }); await settleAuto();
  assert.equal(result.ok, true); assert.equal(result.phase, 'waiting-play'); assert.equal(env.sourceCalls, 0);
  assert.equal(env.contexts[0].resumeCalls, 1, 'no rejection retry loop'); untouched(env.media[0]);
  options.resumeError = false; env.documentEvent('play'); await settleAuto();
  result = await env.command({ op: 'status' }); assert.equal(result.enabled, true); assert.equal(env.sourceCalls, 1);
  const blocked = environment({ resumeGate: new Promise(() => {}) });
  result = await blocked.command({ op: 'arm' });
  assert.equal(result.ok, true); assert.equal(result.phase, 'waiting-play'); assert.equal(blocked.sourceCalls, 0);
  assert.equal((await blocked.command({ op: 'status' })).armed, true, 'status never awaits resume');
});

test('repeated arm, play events and mutations do not reset an already connected Deck', async () => {
  const env = environment(); await env.command({ op: 'arm' }); await settleAuto();
  await env.command({ op: 'set', semitones: 5 }); await env.command({ op: 'set-speed', speedPercent: 125 });
  await env.command({ op: 'set-eq', band: 'mid', gainDb: -3 }); await env.command({ op: 'set-volume', volumePercent: 0 });
  const dryCalls = env.dsps[0].dryCalls, writes = [...env.media[0].writes];
  for (let i = 0; i < 3; i++) { await env.command({ op: 'arm' }); env.documentEvent('play'); env.documentEvent('canplay'); env.mutate(); }
  await settleAuto();
  const result = await env.command({ op: 'status' });
  assert.equal(result.semitones, 5); assert.equal(result.speedPercent, 125); assert.equal(result.eq.mid, -3); assert.equal(result.volumePercent, 0);
  assert.equal(env.sourceCalls, 1); assert.equal(env.dsps[0].dryCalls, dryCalls); assert.deepEqual(env.media[0].writes, writes);
});

test('armed source changes and replacement media reconnect on events while preserving the Deck fader', async () => {
  const env = environment(); await env.command({ op: 'arm' }); await settleAuto();
  await env.command({ op: 'set', semitones: 5 }); await env.command({ op: 'set-volume', volumePercent: 0 });
  env.media[0].currentSrc = `${origin}/new.wav`; env.media[0].emit('loadedmetadata');
  let result = await env.command({ op: 'status' });
  assert.equal(result.requiresReconnect, false); assert.equal(result.armed, true);
  await settleAuto(); result = await env.command({ op: 'status' });
  assert.equal(result.enabled, true); assert.equal(result.semitones, 0); assert.equal(result.volumePercent, 0); assert.equal(env.sourceCalls, 1);
  env.media = [media({ paused: true })]; env.mutate(); await settleAuto();
  result = await env.command({ op: 'status' });
  assert.equal(result.enabled, true); assert.equal(result.volumePercent, 0); assert.equal(env.sourceCalls, 2); assert.equal(env.gains[1].gain.value, 0);
  untouched(env.media[0], 1);
});

test('automatic connection preserves strict CORS and media ambiguity refusal', async () => {
  for (const items of [[media({ currentSrc: 'https://unsafe.example/a.mp4' })], [media(), media()]]) {
    const env = environment({ media: items });
    const result = await env.command({ op: 'arm' });
    assert.equal(result.ok, false); assert.equal(result.armed, true); assert.equal(env.sourceCalls, 0);
    for (const item of items) untouched(item);
  }
});

test('a failed auto attachment is not retried by polling or repeated DOM mutations; explicit arm can retry', async () => {
  const env = environment({ sourceError: 'InvalidStateError' });
  const result = await env.command({ op: 'arm' }); await settleAuto();
  assert.equal(result.ok, false); assert.equal(result.errorCode, 'media-already-connected');
  const calls = env.sourceCalls;
  env.mutate(); env.documentEvent('canplay'); await settleAuto(); await env.command({ op: 'status' });
  assert.equal(env.sourceCalls, calls);
  await env.command({ op: 'arm' }); assert.equal(env.sourceCalls, calls + 1);
  untouched(env.media[0]);
});

test('armed independent frames do not activate, reset, or mute each other', async () => {
  const a = environment({ media: [media({ readyState: 0, currentSrc: '' })] }); const b = environment();
  await a.command({ op: 'arm' }); await b.command({ op: 'arm' }); await settleAuto();
  await b.command({ op: 'set', semitones: -5 }); await b.command({ op: 'set-volume', volumePercent: 42 });
  assert.equal(a.sourceCalls, 0); assert.equal(b.sourceCalls, 1);
  a.media[0].currentSrc = `${origin}/ready.wav`; a.media[0].readyState = 2; a.documentEvent('playing'); await settleAuto();
  assert.equal((await a.command({ op: 'status' })).volumePercent, 100);
  const result = await b.command({ op: 'status' }); assert.equal(result.semitones, -5); assert.equal(result.volumePercent, 42);
});

test('armed context interruption resumes the same effects without re-enabling or resetting them', async () => {
  const options = {};
  const env = environment(options); await env.command({ op: 'arm' }); await settleAuto();
  await env.command({ op: 'set', semitones: 4 }); await env.command({ op: 'set-eq', band: 'low', gainDb: -4 });
  const dryCalls = env.dsps[0].dryCalls;
  options.staySuspended = true; env.contexts[0].state = 'suspended'; env.documentEvent('play'); await settleAuto();
  let result = await env.command({ op: 'status' }); assert.equal(result.enabled, false); assert.equal(result.phase, 'waiting-play');
  options.staySuspended = false; env.documentEvent('pointerdown'); await settleAuto();
  result = await env.command({ op: 'status' }); assert.equal(result.enabled, true); assert.equal(result.semitones, 4); assert.equal(result.eq.low, -4);
  assert.equal(env.dsps[0].dryCalls, dryCalls); assert.equal(env.sourceCalls, 1);
});

test('a trusted gesture retries resume even when the pre-gesture autoplay request is still pending', async () => {
  const options = { resumeGate: new Promise(() => {}) };
  const env = environment(options); await env.command({ op: 'arm' });
  assert.equal(env.contexts[0].resumeCalls, 1); assert.equal(env.sourceCalls, 0);
  options.resumeGate = null;
  env.documentEvent('pointerdown', { isTrusted: false }); await settleAuto();
  assert.equal(env.sourceCalls, 0, 'synthetic gesture cannot bypass the pending activation');
  env.documentEvent('pointerdown', { isTrusted: true }); await settleAuto();
  assert.equal(env.contexts[0].resumeCalls, 2); assert.equal(env.sourceCalls, 1);
  assert.equal((await env.command({ op: 'status' })).enabled, true);
});

test('automatic activation uses the latest ready source after an asynchronous resume', async () => {
  let release;
  const env = environment({ resumeGate: new Promise(resolve => { release = resolve; }) });
  await env.command({ op: 'arm' });
  const previous = env.media[0];
  env.media = [media({ currentSrc: `${origin}/replacement.wav` })]; env.mutate();
  release(); await settleAuto();
  const result = await env.command({ op: 'status' });
  assert.equal(result.enabled, true); assert.equal(env.sourceCalls, 1); assert.equal(env.contexts.length, 1);
  untouched(previous); untouched(env.media[0], 1);
});

test('missing auto-connection dependencies request extension reload and remain errors during polling', async () => {
  const env = environment();
  delete env.vm.WebDJEQNative;
  let result = await env.command({ op: 'arm' });
  assert.equal(result.ok, false); assert.equal(result.phase, 'refresh-required'); assert.equal(result.requiresReconnect, true);
  assert.match(result.message, /重新加载扩展/); assert.equal(env.sourceCalls, 0);
  result = await env.command({ op: 'status' });
  assert.equal(result.ok, false); assert.equal(result.phase, 'refresh-required'); assert.equal(result.requiresReconnect, true);
  untouched(env.media[0]);
});

test('temporary buffering retains the attached graph and effects without allocating a prepared graph', async () => {
  const env = environment(); await env.command({ op: 'arm' }); await settleAuto();
  await env.command({ op: 'set', semitones: 4 }); await env.command({ op: 'set-volume', volumePercent: 0 });
  const dryCalls = env.dsps[0].dryCalls;
  env.media[0].readyState = 1; env.documentEvent('play'); env.mutate(); await settleAuto();
  let result = await env.command({ op: 'status' });
  assert.equal(result.enabled, true); assert.equal(result.volumePercent, 0); assert.equal(result.semitones, 4);
  assert.equal(env.contexts.length, 1); assert.equal(env.sourceCalls, 1); assert.equal(env.dsps[0].dryCalls, dryCalls);
  env.media[0].readyState = 4; env.documentEvent('canplay'); await settleAuto();
  result = await env.command({ op: 'status' }); assert.equal(result.semitones, 4); assert.equal(env.contexts.length, 1);
});

test('terminal missing-dependency failure is not repeatedly prepared by DOM or play events', async () => {
  const env = environment({ media: [] });
  delete env.vm.WebDJEQNative;
  await env.command({ op: 'arm' });
  let dependencyReads = 0;
  Object.defineProperty(env.vm, 'WebDJEQNative', { get() { dependencyReads++; return undefined; } });
  env.mutate(); env.documentEvent('play'); env.documentEvent('pointerdown'); await settleAuto();
  assert.equal(dependencyReads, 0);
  assert.equal((await env.command({ op: 'status' })).phase, 'refresh-required');
  await env.command({ op: 'arm' }); assert.equal(dependencyReads, 1, 'only explicit retry rechecks dependencies');
});

test('an unused prepared graph adopts the latest zero fader before a replacement is attached', async () => {
  const env = environment(); await env.command({ op: 'arm' }); await settleAuto();
  const item = env.media[0], original = item.currentSrc;
  item.currentSrc = ''; item.readyState = 0; env.documentEvent('emptied'); await settleAuto();
  assert.equal(env.contexts.length, 2, 'a replacement graph was prepared while no source was ready');
  item.currentSrc = original; item.readyState = 4; env.documentEvent('canplay'); await settleAuto();
  await env.command({ op: 'set-volume', volumePercent: 0 });
  assert.equal(env.gains[1].gain.value, 1, 'unused graph still has its creation-time value');
  env.media = [media()]; env.mutate(); await settleAuto();
  assert.equal((await env.command({ op: 'status' })).volumePercent, 0);
  assert.equal(env.gains[1].gain.value, 0);
  assert.deepEqual(env.gains[1].gain.events.slice(-2), [['cancel', 0], ['set', 0, 0]], 'synchronize before rerouting without a loud fade');
  assert.equal(env.sourceCalls, 2); assert.equal(env.contexts.length, 2);
});


test('one-cent extension commands preserve fractional pitch independently of other audio controls',async()=>{
 const env=environment();await env.command({op:'enable'});await env.command({op:'set-speed',speedPercent:125});await env.command({op:'set-volume',volumePercent:37});await env.command({op:'set-eq',band:'low',gainDb:-6});
 for(const semitones of [.01,-.01,1.23,-1.23,11.99,0]){const s=await env.command({op:'set',semitones});assert.equal(s.ok,true);assert.equal(s.semitones,semitones);assert.equal(env.dsps[0].changes.at(-1),semitones);assert.equal(s.speedPercent,125);assert.equal(s.volumePercent,37);assert.equal(s.eq.low,-6);}
});
