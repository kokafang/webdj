import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const realm = vm.createContext({});
vm.runInContext(await readFile(new URL('../extension/pitch-native.js', import.meta.url), 'utf8'), realm);
const Pitch = realm.WebDJPitchNative;

class Parameter {
  constructor(value = 0) { this.value = value; this.events = []; }
  setValueAtTime(value, at) { this.value = value; this.events.push({ value, at, kind: 'set' }); }
  linearRampToValueAtTime(value, at) { this.value = value; this.events.push({ value, at, kind: 'linear' }); }
  cancelScheduledValues(at) { this.events = this.events.filter((event) => event.at < at); }
}
class Node {
  constructor(type) { this.type = type; this.connections = []; }
  connect(destination, output = 0, input = 0) { this.connections.push({ destination, output, input }); return destination; }
  disconnect(destination) { this.connections = destination ? this.connections.filter((connection) => connection.destination !== destination) : []; }
}
function fakeContext() {
  const context = {
    sampleRate: 48000, currentTime: 0, state: 'running', nodes: [], sources: [],
    createGain() { const node = new Node('gain'); node.gain = new Parameter(1); this.nodes.push(node); return node; },
    createDelay(maximum) { const node = new Node('delay'); node.delayTime = new Parameter(0); node.maximum = maximum; this.nodes.push(node); return node; },
    createChannelSplitter(count) { const node = new Node('splitter'); node.count = count; this.nodes.push(node); return node; },
    createBuffer(channels, length, sampleRate) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: (channel) => data[channel] };
    },
    createBufferSource() {
      const source = new Node('source'); source.playbackRate = new Parameter(1);
      source.start = (at = 0, offset = 0) => { source.started = { at, offset }; };
      source.stop = (at = 0) => { source.stopped = at; };
      this.sources.push(source); this.nodes.push(source); return source;
    },
  };
  return context;
}

// Independent sample renderer: consumes the production control buffer and source
// speed, interpolates its channels, then evaluates delayed input samples. It
// does not reuse the implementation's ratio/window generation to make output.
function simulateControlSource(source, inputHz, duration = 2, sampleRate = 48000) {
  const output = new Float64Array(Math.round(duration * sampleRate));
  const buffer = source.buffer;
  const speed = source.playbackRate.value;
  const controls = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel));
  function value(channel, position) {
    const index = Math.floor(position);
    const fraction = position - index;
    return controls[channel][index] * (1 - fraction) + controls[channel][(index + 1) % buffer.length] * fraction;
  }
  for (let i = 0; i < output.length; i++) {
    const at = i / sampleRate;
    const position = ((at - source.started.at) * buffer.sampleRate * speed + source.started.offset * buffer.sampleRate) % buffer.length;
    if (position < 0) continue;
    const firstTime = at - value(0, position), secondTime = at - value(1, position);
    const first = firstTime < 0 ? 0 : Math.sin(2 * Math.PI * inputHz * firstTime);
    const second = secondTime < 0 ? 0 : Math.sin(2 * Math.PI * inputHz * secondTime);
    output[i] = value(2, position) * first + value(3, position) * second;
  }
  return output;
}
function frequencyByCrossings(samples, sampleRate = 48000, startSeconds = 0.4) {
  const crossings = [];
  for (let i = Math.ceil(startSeconds * sampleRate) + 1; i < samples.length; i++) {
    if (samples[i - 1] < 0 && samples[i] >= 0) crossings.push((i - 1 - samples[i - 1] / (samples[i] - samples[i - 1])) / sampleRate);
  }
  assert.ok(crossings.length > 50, 'A substantial audible signal is required');
  return (crossings.length - 1) / (crossings.at(-1) - crossings[0]);
}
function amplitudeAt(samples, hz, sampleRate = 48000) {
  let real = 0, imaginary = 0;
  const start = sampleRate; // one settled second, exact DFT frequencies below
  for (let i = start; i < samples.length; i++) {
    const angle = 2 * Math.PI * hz * i / sampleRate;
    real += samples[i] * Math.cos(angle); imaginary += samples[i] * Math.sin(angle);
  }
  return 2 * Math.hypot(real, imaginary) / (samples.length - start);
}

test('semitone ratios and bounds are exact; unsupported values cannot reach AudioParams', () => {
  assert.equal(Pitch.ratioForSemitones(0), 1);
  assert.equal(Pitch.ratioForSemitones(12), 2);
  assert.equal(Pitch.ratioForSemitones(-12), 0.5);
  assert.ok(Math.abs(Pitch.ratioForSemitones(7) - 1.4983070768766815) < 1e-12);
  for (const value of [NaN, Infinity, -Infinity, 12.1, -12.1, '7', null, undefined]) assert.throws(() => Pitch.ratioForSemitones(value));
});

test('native delay controls use complementary windows, bounded delay and one aligned looping source', () => {
  const context = fakeContext(), processor = Pitch.create(context);
  processor.setSemitones(7);
  const source = context.sources.at(-1);
  assert.equal(source.loop, true);
  assert.equal(source.buffer.numberOfChannels, 4);
  assert.equal(source.started.offset, 0);
  const [delayA, delayB, gainA, gainB] = [0, 1, 2, 3].map((channel) => source.buffer.getChannelData(channel));
  for (let i = 0; i < source.buffer.length; i++) {
    assert.ok(delayA[i] >= 0 && delayA[i] <= 0.15);
    assert.ok(delayB[i] >= 0 && delayB[i] <= 0.15);
    assert.ok(gainA[i] >= 0 && gainA[i] <= 1);
    assert.ok(Math.abs(gainA[i] + gainB[i] - 1) < 1e-6);
  }
  assert.ok(gainA[0] < 1e-6);
  assert.ok(Math.abs(gainB[0] - 1) < 1e-6);
  processor.dispose();
});

for (const [semitones, expected] of [[12, 880], [-12, 220], [7, 659.2551138257398], [-7, 293.6647679174076]]) {
  test(`production controls render 440Hz at ${semitones > 0 ? '+' : ''}${semitones} semitones as ${expected.toFixed(3)}Hz`, (t) => {
    const context = fakeContext(), processor = Pitch.create(context);
    processor.setSemitones(semitones);
    const samples = simulateControlSource(context.sources.at(-1), 440);
    const measured = frequencyByCrossings(samples);
    t.diagnostic(`Independent renderer measured ${measured.toFixed(6)} Hz`);
    assert.ok(Math.abs(measured - expected) < 0.6, `measured ${measured} Hz, expected ${expected} Hz`);
    if (semitones === 12) {
      assert.ok(amplitudeAt(samples, 880) > 0.8, 'Shifted signal should remain audible');
      assert.ok(amplitudeAt(samples, 440) < 0.02, 'Original frequency must not be mixed into the wet result');
    }
    processor.dispose();
  });
}

test('a non-window-aligned tone stays near the intended octave without relying on a special input frequency', (t) => {
  const context = fakeContext(), processor = Pitch.create(context);
  processor.setSemitones(12);
  const measured = frequencyByCrossings(simulateControlSource(context.sources.at(-1), 437.3));
  t.diagnostic(`Non-aligned 437.3 Hz source measured ${measured.toFixed(6)} Hz; ideal 874.6 Hz`);
  assert.ok(Math.abs(measured - 874.6) / 874.6 < 0.01, `measured ${measured} Hz`);
  processor.dispose();
});

test('instances are independent and zero is explicit dry without retaining wet gain', () => {
  const a = fakeContext(), b = fakeContext();
  const pa = Pitch.create(a), pb = Pitch.create(b);
  const dryA = pa.input.connections.find((connection) => connection.destination.type === 'gain').destination;
  const dryB = pb.input.connections.find((connection) => connection.destination.type === 'gain').destination;
  pa.setSemitones(12); pb.setSemitones(-12);
  assert.equal(a.sources.at(-1).playbackRate.value, 1);
  assert.equal(b.sources.at(-1).playbackRate.value, 0.5);
  assert.equal(dryA.gain.events.at(-1).value, 0);
  assert.equal(dryB.gain.events.at(-1).value, 0);
  a.currentTime = 0.5;
  pa.setSemitones(0);
  assert.equal(dryA.gain.events.at(-1).value, 1);
  assert.equal(dryB.gain.events.at(-1).value, 0);
  assert.equal(b.sources.at(-1).stopped, undefined);
  assert.equal(pa.input.connections.some((connection) => connection.destination === pa.output), false);
  assert.ok(a.sources.every((source) => Number.isFinite(source.stopped)));
  pa.dispose(); pb.dispose();
});

test('rapid pitch changes hold current gain before prewarm and retiring sources stay alive through the fade', () => {
  const context = fakeContext(), processor = Pitch.create(context);
  processor.setSemitones(12);
  context.currentTime = 0.5;
  processor.setSemitones(-12);
  const first = context.sources[0];
  const firstStop = first.stopped;
  context.currentTime = 0.52;
  processor.setSemitones(7);
  assert.ok(first.stopped > firstStop, 'Reschedule the still-audible retiring source until the latest fade completes');
  const source = context.sources.at(-1);
  const gates = context.nodes.filter((node) => node.type === 'gain' && node.connections.some((connection) => connection.destination === processor.output));
  assert.ok(gates.every((node) => node.gain.events.every((event) => Number.isFinite(event.value) && event.value >= 0 && event.value <= 1)));
  assert.equal(source.started.at, context.currentTime);
  processor.dispose(); processor.dispose();
  assert.equal(processor.input.connections.length, 0);
  assert.equal(processor.output.connections.length, 0);
  assert.throws(() => processor.setSemitones(1));
});
