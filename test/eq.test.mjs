import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../extension/eq-native.js', import.meta.url), 'utf8');
const realm = vm.createContext({});
vm.runInContext(script, realm);
const EQ = realm.WebDJEQNative;

class Parameter {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(value, at) { this.value = value; this.events.push({ kind: 'set', value, at }); }
  linearRampToValueAtTime(value, at) { this.value = value; this.events.push({ kind: 'linear', value, at }); }
  cancelScheduledValues(at) { this.events = this.events.filter((event) => event.at < at); }
}
class Node {
  constructor(kind) { this.kind = kind; this.connections = []; }
  connect(destination) { this.connections.push(destination); return destination; }
  disconnect() { this.connections = []; }
}
function fakeContext(sampleRate = 48000) {
  return {
    sampleRate, currentTime: 0, state: 'running', nodes: [],
    createGain() {
      const node = new Node('gain'); node.gain = new Parameter(1);
      this.nodes.push(node); return node;
    },
    createBiquadFilter() {
      const node = new Node('biquad'); node.type = 'lowpass';
      node.frequency = new Parameter(350); node.Q = new Parameter(1);
      node.gain = new Parameter(); node.detune = new Parameter();
      this.nodes.push(node); return node;
    },
  };
}
function filtersFor(processor) {
  const filters = [];
  let node = processor.input;
  while (node !== processor.output) {
    assert.equal(node.connections.length, 1, 'Exactly one serial signal path; no parallel dry duplication');
    node = node.connections[0];
    if (node.kind === 'biquad') filters.push(node);
  }
  assert.equal(filters.length, 3);
  return filters;
}

// Independent RBJ/Web Audio equations. Production only configures native nodes;
// this model measures the resulting settings and is not a browser DSP test.
function coefficients(node, sampleRate) {
  const A = 10 ** (node.gain.value / 40);
  const w = 2 * Math.PI * node.frequency.value / sampleRate;
  const c = Math.cos(w), s = Math.sin(w);
  if (node.type === 'peaking') {
    const alpha = s / (2 * node.Q.value);
    return { b: [1 + alpha * A, -2 * c, 1 - alpha * A], a: [1 + alpha / A, -2 * c, 1 - alpha / A] };
  }
  // Web Audio shelves have slope S=1 and ignore Q.
  const k = Math.sqrt(2 * A) * s;
  if (node.type === 'lowshelf') return {
    b: [A * (A + 1 - (A - 1) * c + k), 2 * A * (A - 1 - (A + 1) * c), A * (A + 1 - (A - 1) * c - k)],
    a: [A + 1 + (A - 1) * c + k, -2 * (A - 1 + (A + 1) * c), A + 1 + (A - 1) * c - k],
  };
  assert.equal(node.type, 'highshelf');
  return {
    b: [A * (A + 1 + (A - 1) * c + k), -2 * A * (A - 1 + (A + 1) * c), A * (A + 1 + (A - 1) * c - k)],
    a: [A + 1 - (A - 1) * c + k, 2 * (A - 1 - (A + 1) * c), A + 1 - (A - 1) * c - k],
  };
}
function responseDb(filters, sampleRate, hz) {
  const w = 2 * Math.PI * hz / sampleRate;
  function magnitude(xs) {
    return Math.hypot(xs[0] + xs[1] * Math.cos(w) + xs[2] * Math.cos(2 * w), -xs[1] * Math.sin(w) - xs[2] * Math.sin(2 * w));
  }
  return filters.reduce((sum, node) => {
    const { a, b } = coefficients(node, sampleRate);
    return sum + 20 * Math.log10(magnitude(b) / magnitude(a));
  }, 0);
}
function simulateSine(filters, sampleRate, hz) {
  let samples = Float64Array.from({ length: sampleRate }, (_, i) => 0.1 * Math.sin(2 * Math.PI * hz * i / sampleRate));
  for (const node of filters) {
    const { a, b } = coefficients(node, sampleRate);
    const output = new Float64Array(samples.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < samples.length; i++) {
      const x = samples[i];
      const y = (b[0] * x + b[1] * x1 + b[2] * x2 - a[1] * y1 - a[2] * y2) / a[0];
      output[i] = y; x2 = x1; x1 = x; y2 = y1; y1 = y;
    }
    samples = output;
  }
  let sum = 0;
  for (let i = sampleRate / 2; i < samples.length; i++) sum += samples[i] ** 2;
  return 20 * Math.log10(Math.sqrt(sum / (sampleRate / 2)) / (0.1 / Math.sqrt(2)));
}
function settings(processor) { return { ...processor.getSettings() }; }

test('neutral EQ is unity across the audible band and preserves a single serial path', () => {
  const context = fakeContext(); const processor = EQ.create(context);
  const filters = filtersFor(processor);
  assert.deepEqual(settings(processor), { low: 0, mid: 0, high: 0 });
  assert.equal(processor.input.gain.value, 1); assert.equal(processor.output.gain.value, 1);
  for (const hz of [20, 70, 250, 1000, 4000, 13000, 20000]) assert.ok(Math.abs(responseDb(filters, 48000, hz)) < 1e-8);
  assert.ok(Math.abs(simulateSine(filters, 48000, 1000)) < 1e-8);
});

test('measured band gains support real cuts and boosts at 44.1, 48 and 96 kHz', (t) => {
  for (const sampleRate of [44100, 48000, 96000]) {
    const processor = EQ.create(fakeContext(sampleRate));
    const filters = filtersFor(processor);
    for (const [band, hz] of [['low', 20], ['mid', 1000], ['high', 20000]]) {
      for (const gain of [-26, -6, 0, 6]) {
        processor.reset(); processor.setBand(band, gain);
        const measured = simulateSine(filters, sampleRate, hz);
        assert.ok(Math.abs(measured - gain) < 0.15, `${sampleRate} ${band} ${gain} dB: measured ${measured}`);
        assert.ok(Math.abs(responseDb(filters, sampleRate, hz) - measured) < 0.01);
      }
    }
    t.diagnostic(`${sampleRate} Hz: low 20 Hz, mid 1 kHz, high 20 kHz sine gains within 0.15 dB`);
  }
});

test('bands have smooth overlapping responses, not abrupt or full-kill cutoffs', () => {
  const processor = EQ.create(fakeContext()); const filters = filtersFor(processor);
  processor.setBand('low', -26);
  assert.ok(Math.abs(responseDb(filters, 48000, 250) + 13) < 1e-8, 'Shelf transition is half the gain in dB');
  assert.ok(Math.abs(responseDb(filters, 48000, 8000)) < 0.01, 'Low cut leaves distant highs intact');
  processor.reset(); processor.setBand('mid', -26);
  assert.ok(responseDb(filters, 48000, 700) < -3 && responseDb(filters, 48000, 1400) < -3);
  processor.reset(); processor.setBand('high', 6);
  assert.ok(Math.abs(responseDb(filters, 48000, 4000) - 3) < 1e-8);
});

test('every supported gain remains finite across frequency and gain combinations', () => {
  for (const sampleRate of [44100, 48000, 96000]) {
    const processor = EQ.create(fakeContext(sampleRate)); const filters = filtersFor(processor);
    for (let gain = -26; gain <= 6; gain += 0.5) {
      for (const band of ['low', 'mid', 'high']) processor.setBand(band, gain);
      for (let i = 0; i <= 128; i++) {
        const db = responseDb(filters, sampleRate, 20 * (1000 ** (i / 128)));
        assert.ok(Number.isFinite(db) && db > -79 && db < 19);
      }
    }
  }
});

test('two instances remain independent through band changes and reset; snapshots cannot change settings', () => {
  const context = fakeContext(), a = EQ.create(context), b = EQ.create(context);
  a.setBand('low', -26); b.setBand('mid', 6);
  const bEvents = filtersFor(b).map((filter) => structuredClone(filter.gain.events));
  const snapshot = a.getSettings(); snapshot.low = 999;
  assert.equal(a.getSettings().low, -26);
  context.currentTime = 1; a.reset();
  assert.deepEqual(settings(a), { low: 0, mid: 0, high: 0 });
  assert.deepEqual(settings(b), { low: 0, mid: 6, high: 0 });
  assert.deepEqual(filtersFor(b).map((filter) => filter.gain.events), bEvents);
});

test('rapid changes ramp from the current gain and settle to exact unity without restarting identical targets', () => {
  const context = fakeContext(), processor = EQ.create(context), [low] = filtersFor(processor);
  processor.setBand('low', 6);
  assert.equal(low.gain.events.at(-1).kind, 'linear');
  assert.equal(low.gain.events.at(-1).at, 0.03);
  context.currentTime = 0.015; processor.setBand('low', -26);
  assert.deepEqual(low.gain.events.at(-2), { kind: 'set', value: 3, at: 0.015 });
  const count = low.gain.events.length; processor.setBand('low', -26);
  assert.equal(low.gain.events.length, count);
  context.currentTime = 0.03; processor.reset();
  assert.deepEqual(low.gain.events.at(-2), { kind: 'set', value: -11.5, at: 0.03 });
  assert.deepEqual(low.gain.events.at(-1), { kind: 'linear', value: 0, at: 0.06 });
});

test('invalid values never reach AudioParams and dispose is independent and idempotent', () => {
  for (const context of [null, {}, { ...fakeContext(), state: 'closed' }, fakeContext(NaN)]) assert.throws(() => EQ.create(context));
  const context = fakeContext(), a = EQ.create(context), b = EQ.create(context), nodes = [...context.nodes];
  for (const gain of [NaN, Infinity, -Infinity, '0', null, undefined, -26.5, 6.5, 0.1]) assert.throws(() => a.setBand('low', gain));
  for (const band of ['LOW', 'bass', '__proto__', 'toString', null]) assert.throws(() => a.setBand(band, 1));
  assert.deepEqual(settings(a), { low: 0, mid: 0, high: 0 });
  const aNodes = nodes.slice(0, nodes.length / 2);
  a.dispose(); a.dispose();
  assert.ok(aNodes.every((node) => node.connections.length === 0));
  assert.equal(filtersFor(b).length, 3);
  assert.throws(() => a.setBand('low', 1)); assert.throws(() => a.reset());
  assert.equal(context.state, 'running', 'Caller-owned AudioContext must remain open');
  const previous = realm.WebDJEQNative; vm.runInContext(script, realm); assert.equal(realm.WebDJEQNative, previous);
});
