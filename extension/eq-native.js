(function installWebDJEQNative(scope) {
  'use strict';
  const VERSION = 'native-three-band-eq-1';
  if (scope.WebDJEQNative && scope.WebDJEQNative.version === VERSION) return;

  // DJ-style EQ mode: -26 to +6 dB, center detent 0 dB. This is a broad
  // browser approximation, not a reproduction of Pioneer DSP coefficients.
  // DJM-A9 manual p90 specifies gains at 20 Hz / 1 kHz / 20 kHz; those are
  // response reference points, NOT hard crossovers. Our shelves transition
  // at 250 Hz / 4 kHz, with a 1 kHz bell (Q=0.7). Web Audio shelf Q is unused.
  // Sources: https://www.pioneerdj.com/en/product/dj-mixers/djm-a9/
  // Manufacturer manual mirror (official download was unavailable):
  // https://device.report/m/4f2bec2cb369f109cec5f31304adbaa1b6de73184c970af4ea2668f4c381f301_optim.pdf
  // https://www.w3.org/TR/webaudio/#BiquadFilterNode
  // This is finite-cut EQ, NOT a full-kill isolator. No hidden attenuation,
  // limiter, or parallel dry signal: boosts really boost and require headroom.
  const FADE_SECONDS = 0.03;
  const BAND_NAMES = Object.freeze(['low', 'mid', 'high']);
  const BAND_CONFIG = Object.freeze({
    low: Object.freeze({ type: 'lowshelf', frequency: 250 }),
    mid: Object.freeze({ type: 'peaking', frequency: 1000, Q: 0.7 }),
    high: Object.freeze({ type: 'highshelf', frequency: 4000 }),
  });

  function validateBand(band, gainDb) {
    if (!BAND_NAMES.includes(band)) throw new RangeError('EQ 频段必须是 low、mid 或 high。');
    if (typeof gainDb !== 'number' || !Number.isFinite(gainDb) || gainDb < -26 || gainDb > 6 || !Number.isInteger(gainDb * 2)) {
      throw new RangeError('EQ 增益必须为 -26 到 +6 dB，步长为 0.5 dB。');
    }
    return gainDb === 0 ? 0 : gainDb;
  }

  function create(context) {
    if (!context || !Number.isFinite(context.sampleRate) || context.sampleRate <= 8000 || context.state === 'closed' ||
        typeof context.createGain !== 'function' || typeof context.createBiquadFilter !== 'function') {
      throw new TypeError('需要可用的 AudioContext 或 OfflineAudioContext。');
    }
    const nodes = [];
    let disposed = false;
    const states = new Map();
    function disconnect(node) { try { node.disconnect(); } catch {} }
    function own(node) { nodes.push(node); return node; }
    let input, output;
    try {
      input = own(context.createGain());
      output = own(context.createGain());
      input.gain.value = 1;
      output.gain.value = 1;
      let previous = input;
      for (const band of BAND_NAMES) {
        const config = BAND_CONFIG[band];
        const filter = own(context.createBiquadFilter());
        filter.type = config.type;
        filter.frequency.value = config.frequency;
        if (config.Q !== undefined) filter.Q.value = config.Q;
        filter.detune.value = 0;
        filter.gain.setValueAtTime(0, context.currentTime);
        previous.connect(filter);
        previous = filter;
        states.set(band, { filter, from: 0, target: 0, start: context.currentTime, end: context.currentTime });
      }
      previous.connect(output);
    } catch (error) {
      nodes.forEach(disconnect);
      throw error;
    }

    function getSettings() {
      return { low: states.get('low').target, mid: states.get('mid').target, high: states.get('high').target };
    }
    function change(state, target, now) {
      if (state.target === target) return;
      const progress = state.end <= state.start ? 1 : Math.min(1, Math.max(0, (now - state.start) / (state.end - state.start)));
      const current = state.from + (state.target - state.from) * progress;
      // Track the linear envelope ourselves: AudioParam.value may expose a
      // scheduled endpoint. A quick drag must start at the current dB value.
      const param = state.filter.gain;
      param.cancelScheduledValues(now);
      param.setValueAtTime(current, now);
      param.linearRampToValueAtTime(target, now + FADE_SECONDS);
      Object.assign(state, { from: current, target, start: now, end: now + FADE_SECONDS });
    }
    function requireActive() { if (disposed) throw new Error('EQ 处理器已释放。'); }
    function setBand(band, gainDb) {
      requireActive();
      const gain = validateBand(band, gainDb);
      change(states.get(band), gain, context.currentTime);
      return getSettings();
    }
    function reset() {
      requireActive();
      const now = context.currentTime;
      for (const state of states.values()) change(state, 0, now);
      return getSettings();
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const state of states.values()) state.filter.gain.cancelScheduledValues(context.currentTime);
      nodes.forEach(disconnect);
      // Caller owns the context and media source. Normal restore uses reset();
      // dispose() is teardown, never a way to restore an already-routed media.
    }
    return { input, output, setBand, reset, getSettings, dispose };
  }

  scope.WebDJEQNative = Object.freeze({ version: VERSION, create });
})(globalThis);
