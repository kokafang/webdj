(function installWebDJPitchNative(scope) {
  'use strict';
  const VERSION = 'native-dual-delay-1';
  if (scope.WebDJPitchNative && scope.WebDJPitchNative.version === VERSION) return;

  // Experimental granular pitch shift. x(t - d(t)) has local frequency ratio
  // 1 - d'(t); a descending delay therefore raises pitch. Two grains overlap
  // half a period apart, with complementary Hann windows masking each reset.
  const WINDOW_SECONDS = 0.1;
  const BASE_DELAY_SECONDS = 0.006;
  const FADE_SECONDS = 0.04;
  const buffersByContext = new WeakMap();

  function ratioForSemitones(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < -12 || value > 12) {
      throw new RangeError('变调必须是 -12 到 +12 之间的有限半音数。');
    }
    return Math.pow(2, value / 12);
  }

  function controlsFor(context, ascendingPitch) {
    let cache = buffersByContext.get(context);
    if (!cache) { cache = new Map(); buffersByContext.set(context, cache); }
    const key = ascendingPitch ? 'up' : 'down';
    if (cache.has(key)) return cache.get(key);
    const length = Math.max(8, Math.round(WINDOW_SECONDS * context.sampleRate));
    const duration = length / context.sampleRate;
    const buffer = context.createBuffer(4, length, context.sampleRate);
    const channels = [0, 1, 2, 3].map((channel) => buffer.getChannelData(channel));
    for (let i = 0; i < length; i++) {
      const phase = i / length;
      const otherPhase = (phase + 0.5) % 1;
      channels[0][i] = BASE_DELAY_SECONDS + duration * (ascendingPitch ? 1 - phase : phase);
      channels[1][i] = BASE_DELAY_SECONDS + duration * (ascendingPitch ? 1 - otherPhase : otherPhase);
      const gain = 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
      channels[2][i] = gain;
      channels[3][i] = 1 - gain;
    }
    const result = { buffer, duration, maximumDelay: BASE_DELAY_SECONDS + duration };
    cache.set(key, result);
    return result;
  }

  function create(context) {
    if (!context || !Number.isFinite(context.sampleRate) || context.sampleRate <= 0 || context.state === 'closed') {
      throw new TypeError('需要可用的 AudioContext 或 OfflineAudioContext。');
    }
    for (const name of ['createGain', 'createDelay', 'createBuffer', 'createBufferSource', 'createChannelSplitter']) {
      if (typeof context[name] !== 'function') throw new TypeError('当前浏览器缺少原生 Web Audio 节点。');
    }
    const input = context.createGain();
    const output = context.createGain();
    const dryNode = context.createGain();
    input.gain.value = 1;
    output.gain.value = 1;
    input.connect(dryNode);
    dryNode.connect(output);
    const branches = new Set();
    let disposed = false;
    let targetSemitones = 0;

    function envelope(node, value) {
      node.gain.setValueAtTime(value, context.currentTime);
      return { node, from: value, to: value, start: context.currentTime, end: context.currentTime };
    }
    const dry = envelope(dryNode, 1);
    function gainAt(state, time) {
      if (time <= state.start) return state.from;
      if (time >= state.end) return state.to;
      return state.from + (state.to - state.from) * (time - state.start) / (state.end - state.start);
    }
    function fade(state, target, start, end, now) {
      const current = gainAt(state, now);
      // Keep the actual instantaneous envelope, including a previous future
      // warm-up hold. AudioParam.value alone may expose a scheduled target.
      state.node.gain.cancelScheduledValues(now);
      state.node.gain.setValueAtTime(current, now);
      if (start > now) state.node.gain.setValueAtTime(current, start);
      state.node.gain.linearRampToValueAtTime(target, end);
      Object.assign(state, { from: current, to: target, start, end });
    }
    function safelyDisconnect(node, destination) {
      try { if (destination) node.disconnect(destination); else node.disconnect(); } catch {}
    }
    function release(branch) {
      if (branch.released) return;
      branch.released = true;
      branches.delete(branch);
      branch.source.onended = null;
      try { branch.source.stop(context.currentTime); } catch {}
      safelyDisconnect(input, branch.delays[0]);
      safelyDisconnect(input, branch.delays[1]);
      for (const node of [branch.source, branch.splitter, ...branch.delays, ...branch.windows, branch.gate.node]) safelyDisconnect(node);
    }
    function makeBranch(ratio, now) {
      const controls = controlsFor(context, ratio > 1);
      const delays = [context.createDelay(controls.maximumDelay + 0.02), context.createDelay(controls.maximumDelay + 0.02)];
      const windows = [context.createGain(), context.createGain()];
      const gate = envelope(context.createGain(), 0);
      const source = context.createBufferSource();
      const splitter = context.createChannelSplitter(4);
      source.buffer = controls.buffer;
      source.loop = true;
      source.loopStart = 0;
      source.loopEnd = controls.duration;
      // The control buffer lasts exactly one delay-window duration. Its playback
      // rate is |1-ratio|, making the delay slope +/-(1-ratio) seconds/second.
      source.playbackRate.setValueAtTime(Math.abs(1 - ratio), now);
      source.connect(splitter);
      for (let index = 0; index < 2; index++) {
        delays[index].delayTime.value = 0;
        windows[index].gain.value = 0;
        splitter.connect(delays[index].delayTime, index);
        splitter.connect(windows[index].gain, index + 2);
        input.connect(delays[index]);
        delays[index].connect(windows[index]);
        windows[index].connect(gate.node);
      }
      gate.node.connect(output);
      const branch = { source, splitter, delays, windows, gate, maximumDelay: controls.maximumDelay, stoppedAt: Infinity, released: false };
      branches.add(branch);
      source.onended = () => release(branch);
      // Offset is buffer time, not playback-rate-scaled time. Both grains and
      // windows share this single source, so they cannot drift out of phase.
      source.start(now, 0);
      return branch;
    }

    function setSemitones(value) {
      if (disposed) throw new Error('变调处理器已释放。');
      const ratio = ratioForSemitones(value);
      if (value === targetSemitones) return { semitones: value, ratio, mode: value === 0 ? 'dry' : 'pitch' };
      const now = context.currentTime;
      const next = value === 0 ? null : makeBranch(ratio, now);
      // Start the next branch muted and fill its delay memory while the old
      // signal remains audible. Only then crossfade; never add dry at full gain.
      const start = next ? now + next.maximumDelay + 128 / context.sampleRate : now;
      const end = start + FADE_SECONDS;
      fade(dry, next ? 0 : 1, start, end, now);
      for (const branch of [...branches]) {
        if (branch === next) continue;
        if (branch.stoppedAt <= now || gainAt(branch.gate, now) <= 1e-7) {
          release(branch);
          continue;
        }
        fade(branch.gate, 0, start, end, now);
        branch.stoppedAt = end + 128 / context.sampleRate;
        // Repeated stop() calls replace a pending stop. A rapid subsequent
        // change must keep the currently audible old branch alive until its fade.
        branch.source.stop(branch.stoppedAt);
      }
      if (next) fade(next.gate, 1, start, end, now);
      targetSemitones = value === 0 ? 0 : value;
      return { semitones: targetSemitones, ratio, mode: next ? 'pitch' : 'dry' };
    }
    function bypass() { return setSemitones(0); }
    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const branch of [...branches]) release(branch);
      safelyDisconnect(input);
      safelyDisconnect(dryNode);
      safelyDisconnect(output);
      // Do not close/resume the caller-owned context. A MediaElementAudioSource
      // already rerouted through it needs bypass(), not dispose(), to stay heard.
    }
    return { input, output, setSemitones, bypass, dispose };
  }

  scope.WebDJPitchNative = Object.freeze({ version: VERSION, ratioForSemitones, create });
})(globalThis);
