/* Per-frame experimental processing; only explicit speed commands change native rate. */
(function installFrameEngine(global) {
  'use strict';
  if (global.WebDJFrameEngine) {
    if (global.WebDJFrameEngine.version !== 5) global.WebDJFrameEngineUpgradeRequired = { requiredVersion: 5, message: '扩展已更新，请刷新播放器或页面后重新连接；旧音频通路保持不变。' };
    return;
  }
  delete global.WebDJFrameEngineUpgradeRequired;

  const fixtureOutputProbe = global.location.origin === 'http://127.0.0.1:51947' && new URL(global.location.href).pathname === '/frame.html';
  const records = new WeakMap();
  let current = null;
  let prepared = null;
  let armed = false;
  let autoQueued = false;
  let autoListenersInstalled = false;
  let blockedAutoSource = null;
  let autoTerminal = false;
  let deckVolumePercent = 100;
  let fadeEnabled=true;
  const frameCanvas=global.document.createElement('canvas');frameCanvas.width=160;frameCanvas.height=90;
  let lastFrameAt=0,frameImage=null;
  const VOLUME_FADE_SECONDS = 0.03;
  let enabled = false;
  let reconnect = false;
  let phase = 'idle';
  let message = '尚未接管音频。';
  let errorCode;
  let mutation = Promise.resolve();

  function mediaList() {
    return [...global.document.querySelectorAll('video, audio')];
  }
  function present(media) {
    return global.document.contains(media);
  }
  function loadedSource(media) {
    return String(media.currentSrc || '');
  }
  function preflight() {
    const candidates = mediaList().filter(media => media.readyState >= 2 && loadedSource(media));
    if (candidates.length !== 1) {
      return { ok: false, code: candidates.length ? 'ambiguous-media' : 'media-not-ready', message: candidates.length ? '发现多个已加载媒体，无法确定应处理哪一个；未接管。' : '先点视频播放，画面开始后再连接。' };
    }
    const media = candidates[0];
    let url;
    try { url = new URL(loadedSource(media), global.location.href); } catch {
      return { ok: false, code: 'invalid-source', message: '无法识别媒体来源；未接管。' };
    }
    const sameOrigin = url.origin !== 'null' && url.origin === global.location.origin;
    const corsMode = media.crossOrigin;
    const corsCandidate = (url.protocol === 'https:' || url.protocol === 'http:') && (corsMode === 'anonymous' || corsMode === 'use-credentials');
    if (!((sameOrigin && ['http:', 'https:', 'blob:'].includes(url.protocol)) || corsCandidate)) {
      return { ok: false, code: 'unsafe-cors', message: '媒体来源未满足同源或已声明 CORS 的检查；为避免播放器变成静音，未接管。' };
    }
    return { ok: true, media, src: loadedSource(media), source: { kind: media.tagName.toLowerCase(), origin: url.origin, mode: sameOrigin ? (url.protocol === 'blob:' ? 'same-origin-blob' : 'same-origin') : 'cors-candidate' } };
  }
  function fail(code, text) {
    phase = 'error';
    if (armed && !enabled && current) blockedAutoSource = { media: current.media, src: current.src };
    message = text;
    errorCode = code;
    return snapshot(false);
  }
  function dry(record) {
    record.dsp?.bypass();
    record.semitones = 0;
    record.eq?.reset();
    record.eqSettings = { low: 0, mid: 0, high: 0 };
    record.bypassed = true;
  }
  function invalidate(text) {
    if (!current || reconnect) return;
    try { dry(current); } catch {
      phase = 'recovery-required';
      message = '媒体已变化，恢复原声通路失败；请刷新此播放器后重试。';
      enabled = false;
      reconnect = true;
      errorCode = 'dry-route-failed';
      return;
    }
    enabled = false;
    reconnect = true;
    current.requestedSpeedPercent = null;
    phase = armed ? 'waiting-media' : 'reconnect-required';
    if (armed) scheduleAuto();
    message = text || '媒体已变化，已切回原声通路；请重新连接。';
    errorCode = undefined;
  }
  function checkSource() {
    if (!current || reconnect) return;
    if (!present(current.media) || loadedSource(current.media) !== current.src) {
      invalidate();
    } else if (mediaList().filter(media => media.readyState >= 2 && loadedSource(media)).length > 1) {
      invalidate('播放器出现多个已加载媒体，已切回原声通路；请确认后重新连接。');
    }
  }
  function signalPresent(record) {
    if (record.context.state !== 'running' || record.media.paused || record.media.ended || record.media.muted || record.media.volume === 0) return false;
    record.analyser.getFloatTimeDomainData(record.samples);
    return record.samples.some(value => Number.isFinite(value) && Math.abs(value) > 0.00001);
  }
  function outputFrequency(record) {
    if (!fixtureOutputProbe || !enabled || reconnect || !record?.outputAnalyser || record.context.state !== 'running' || record.media.paused || record.media.ended || record.media.muted || record.media.volume === 0) return null;
    try {
      const samples = record.outputSamples;
      record.outputAnalyser.getFloatTimeDomainData(samples);
      let first = -1;
      let last = -1;
      let crossings = 0;
      let peak = 0;
      for (let i = 1; i < samples.length; i++) {
        const before = samples[i - 1];
        const after = samples[i];
        if (!Number.isFinite(before) || !Number.isFinite(after)) return null;
        peak = Math.max(peak, Math.abs(after));
        if (before <= 0 && after > 0) {
          const position = i - 1 + (-before) / (after - before);
          if (first < 0) first = position;
          last = position;
          crossings++;
        }
      }
      if (peak < 0.00001 || crossings < 3 || last <= first) return null;
      const frequency = (crossings - 1) * record.context.sampleRate / (last - first);
      return Number.isFinite(frequency) && frequency > 0 ? Math.round(frequency * 10) / 10 : null;
    } catch {
      // This optional fixture diagnostic must never alter audio or fail a command.
      return null;
    }
  }
  function speedState(record, media = record?.media) {
    const rate = Number(media?.playbackRate);
    const speedPercent = Number.isFinite(rate) ? Math.round(rate * 100000000) / 1000000 : null;
    const preservesPitch = typeof media?.preservesPitch === 'boolean' ? media.preservesPitch : null;
    const requestedSpeedPercent = record?.requestedSpeedPercent ?? null;
    return { speedPercent, requestedSpeedPercent, preservesPitch, speedOverridden: requestedSpeedPercent !== null && (speedPercent === null || Math.abs(speedPercent - requestedSpeedPercent) > 0.000001 || preservesPitch !== true) };
  }
  function volumeState(record, media = record?.media) {
    const nativeVolume = media?.volume;
    return { volumePercent: record?.volumePercent ?? deckVolumePercent, nativeVolumePercent: typeof nativeVolume === 'number' && Number.isFinite(nativeVolume) ? Math.round(nativeVolume * 1000000) / 10000 : null };
  }
  function setOutputVolume(record, volumePercent) {
    if (volumePercent === record.volumePercent) return;
    const now = record.context.currentTime;
    const envelope = record.volumeEnvelope;
    const progress = envelope.end <= envelope.start ? 1 : Math.min(1, Math.max(0, (now - envelope.start) / (envelope.end - envelope.start)));
    const actual = envelope.from + (envelope.target - envelope.from) * progress;
    const target = volumePercent / 100;
    const param = record.volumeNode.gain;
    try {
      // AudioParam.value can expose a scheduled endpoint. Continue the current
      // linear envelope when a fast drag replaces an in-flight ramp.
      param.cancelScheduledValues(now);
      param.setValueAtTime(actual, now);
      param.linearRampToValueAtTime(target, now + VOLUME_FADE_SECONDS);
    } catch {
      try {
        param.cancelScheduledValues(now);
        param.setValueAtTime(actual, now);
        param.linearRampToValueAtTime(envelope.target, now + VOLUME_FADE_SECONDS);
        record.volumeEnvelope = { from: actual, target: envelope.target, start: now, end: now + VOLUME_FADE_SECONDS };
      } catch {
        enabled = false;
        throw Object.assign(new Error('音量设置与恢复未完成，请刷新播放器。'), { code: 'volume-recovery-required' });
      }
      throw Object.assign(new Error('音量设置未生效，已保留此前推子目标值。'), { code: 'volume-rejected' });
    }
    record.volumeEnvelope = { from: actual, target, start: now, end: now + VOLUME_FADE_SECONDS };
    record.volumePercent = volumePercent;
    deckVolumePercent = volumePercent;
  }
  function initializeNativeVolume(record) {
    if (record.nativeVolumeInitialized || record.context.state !== 'running') return;
    // Once per media element, only after processing setup and activation succeed.
    // Rejected writes remain usable and are reported through nativeVolumePercent.
    record.nativeVolumeInitialized = true;
    try { if (record.media.volume !== 1) record.media.volume = 1; } catch { /* Do not retry or change native mute. */ }
  }
  function readEq(record) {
    const settings = record.eq.getSettings();
    if (!settings || !['low', 'mid', 'high'].every(band => Number.isFinite(settings[band]))) throw new Error('EQ 未返回有效状态。');
    return { low: settings.low, mid: settings.mid, high: settings.high };
  }
  function setSpeed(record, speedPercent) {
    const media = record.media;
    if (typeof media.preservesPitch !== 'boolean') throw Object.assign(new Error('此播放器未提供可确认的音高保持能力，速度未改变。'), { code: 'preserves-pitch-unavailable' });
    const previousRate = media.playbackRate;
    const previousPreservesPitch = media.preservesPitch;
    const previousRequested = record.requestedSpeedPercent;
    const sameMedia = () => present(media) && loadedSource(media) === record.src;
    try {
      if (!media.preservesPitch) media.preservesPitch = true;
      if (media.preservesPitch !== true) throw new Error('音高保持设置未生效。');
      if (!sameMedia()) throw new Error('媒体在设置过程中发生变化。');
      if (Math.abs(media.playbackRate - speedPercent / 100) > 0.00000001) media.playbackRate = speedPercent / 100;
      if (!sameMedia()) throw new Error('媒体在设置过程中发生变化。');
      if (Math.abs(media.playbackRate - speedPercent / 100) > 0.00000001 || !media.preservesPitch) throw new Error('播放器未接受所请求的速度。');
      record.requestedSpeedPercent = speedPercent;
    } catch (error) {
      if (!sameMedia()) {
        checkSource();
        record.requestedSpeedPercent = null;
        throw Object.assign(new Error('媒体在速度设置过程中发生变化，已停止写入；请重新连接。'), { code: 'reconnect-required' });
      }
      record.requestedSpeedPercent = previousRequested;
      let restored = false;
      if (present(media) && loadedSource(media) === record.src) {
        try {
          if (media.playbackRate !== previousRate) media.playbackRate = previousRate;
          if (media.preservesPitch !== previousPreservesPitch) media.preservesPitch = previousPreservesPitch;
          restored = media.playbackRate === previousRate && media.preservesPitch === previousPreservesPitch;
        } catch { /* Report the actual values instead of claiming rollback. */ }
      }
      throw Object.assign(new Error(restored ? '播放器未接受速度设置，已保留此前速度和音高保持设置。' : '速度设置失败，恢复状态未确认；请查看实际速度并手动恢复或重新连接。'), { code: restored ? 'speed-rejected' : 'speed-recovery-required' });
    }
  }
  function operationFailure(code, text) {
    return { ...snapshot(false), message: text, errorCode: code };
  }
  function mediaSnapshot(){
    const media=current?.media||mediaList().find(m=>m.readyState>=1);
    if(!media)return {};
    let level=0;
    if(current?.context.state==='running'&&!media.paused){current.analyser.getFloatTimeDomainData(current.samples);for(const value of current.samples)level=Math.max(level,Math.abs(value));}
    if(Date.now()-lastFrameAt>500&&media.readyState>=2){lastFrameAt=Date.now();try{frameCanvas.getContext('2d').drawImage(media,0,0,160,90);frameImage=frameCanvas.toDataURL('image/jpeg',.5);}catch{frameImage=null;}}
    return {level:Math.min(1,level*(current?.volumePercent??100)/100),frame:frameImage,media:{currentTime:media.currentTime,duration:Number.isFinite(media.duration)?media.duration:null,paused:media.paused,ended:media.ended,playbackRate:media.playbackRate,volume:media.volume,muted:media.muted}};
  }
  function snapshot(ok = true) {
    if (enabled && current && !reconnect) {
      if (current.context.state !== 'running') {
        phase = armed ? 'waiting-play' : 'suspended';
        if (armed) enabled = false;
        message = armed ? '等待视频播放。' : '音频处理尚未运行；请在播放器操作后重新连接。';
      } else if (current.bypassed && current.semitones === 0 && Object.values(current.eqSettings).every(value => value === 0) && speedState(current).speedPercent === 100) {
        phase = 'bypassed';
        message = '已全部复位：原调、100% 速度、EQ 零位；播放位置和音量保持不变。';
      } else {
        if (signalPresent(current)) current.verified = true;
        phase = current.verified ? 'active' : 'awaiting-signal';
        message = current.verified ? '已检测到音频输入；独立变调已连接，音质与延迟仍属实验。' : '处理通路已连接，但尚未检测到音频；请在原播放器播放。不能据此确认变调成功。';
      }
    }
    const speed = speedState(current);
    if (enabled && speed.speedOverridden) message += ' 原生播放器已覆盖速度或音高保持设置；当前显示实际值，不自动抢写。';
    else if (enabled && speed.speedPercent !== 100 && speed.preservesPitch !== true) message += ' 当前音高保持未开启，无法确认速度与调性独立。';
    return {
      ...mediaSnapshot(), ...speed, ...volumeState(current), eq: { ...(current?.eqSettings || { low: 0, mid: 0, high: 0 }) },
      ok, phase, message, semitones: current?.semitones || 0,
      armed, enabled, verified: !!(enabled && current?.verified && !reconnect),
      ...(current ? { source: current.source, contextState: current.context.state, paused: !!current.media.paused } : {}),
      ...(errorCode ? { errorCode } : {}),
      requiresReconnect: phase === 'refresh-required' || (reconnect && !armed),
      ...(fixtureOutputProbe ? { outputFrequencyHz: outputFrequency(current) } : {}),
    };
  }
  function watch(record) {
    const onSource = event => {
      if (record !== current) return;
      if (event.type === 'emptied' || (event.type === 'loadstart' && record.media.readyState < 2)) invalidate();
      else checkSource();
    };
    for (const type of ['emptied', 'loadstart', 'loadedmetadata', 'ratechange']) record.media.addEventListener(type, onSource);
  }
  function discardPrepared(record) {
    if (!record || record.sourceNode) return;
    try { record.dsp?.dispose(); } catch {}
    try { record.eq?.dispose(); } catch {}
    try { record.volumeNode?.disconnect(); } catch {}
    try { Promise.resolve(record.context.close()).catch(() => {}); } catch {}
    if (prepared === record) prepared = null;
  }
  function prepareRecord() {
    const AudioContext = global.AudioContext || global.webkitAudioContext;
    if (!AudioContext) throw Object.assign(new Error('浏览器音频引擎不可用。'), { code: 'engine-unavailable' });
    if (!global.WebDJPitchNative?.create || !global.WebDJEQNative?.create) throw Object.assign(new Error('请先重新加载扩展，再刷新 WebDJ。'), { code: 'refresh-required' });
    const context = new AudioContext();
    const record = { context, media: null, sourceNode: null, semitones: 0, verified: false, volumePercent: deckVolumePercent,
      volumeEnvelope: { from: deckVolumePercent / 100, target: deckVolumePercent / 100, start: context.currentTime, end: context.currentTime },
      nativeVolumeInitialized: false, eqSettings: { low: 0, mid: 0, high: 0 }, requestedSpeedPercent: null, resumePending: false };
    try {
      // Preparation is safe before a source is loaded: no media is redirected.
      record.dsp = global.WebDJPitchNative.create(context); record.dsp.bypass();
      record.eq = global.WebDJEQNative.create(context); record.eq.reset();
      record.volumeNode = context.createGain();
      record.volumeNode.gain.setValueAtTime(deckVolumePercent / 100, context.currentTime);
      record.analyser = context.createAnalyser(); record.analyser.fftSize = 256;
      record.samples = new Float32Array(256);
      record.dsp.output.connect(record.eq.input);
      record.stopGain=context.createGain();record.stopEnvelope=new global.WebDJStop.StopEnvelope(context,record.stopGain.gain);
      record.eq.output.connect(record.stopGain);record.stopGain.connect(record.volumeNode);
      record.volumeNode.connect(context.destination);
      record.analyser.connect(record.dsp.input);
      record.outputAnalyser = null; record.outputSamples = null;
      if (fixtureOutputProbe) {
        try {
          record.outputAnalyser = context.createAnalyser();
          record.outputAnalyser.fftSize = 4096; record.outputAnalyser.smoothingTimeConstant = 0;
          record.outputSamples = new Float32Array(4096);
          record.volumeNode.connect(record.outputAnalyser);
        } catch { record.outputAnalyser = null; record.outputSamples = null; }
      }
      context.addEventListener?.('statechange', () => { if (armed && context.state === 'running') scheduleAuto(); });
      return record;
    } catch {
      discardPrepared(record);
      throw Object.assign(new Error('音频处理节点创建失败；未接管。'), { code: 'engine-setup-failed' });
    }
  }
  function attachRecord(record, candidate) {
    if (record.sourceNode) return record;
    if (record.context.state !== 'running') throw Object.assign(new Error('等待原生播放启用音频。'), { code: 'audio-activation-required' });
    try {
      // Prepared graphs may outlive fader changes on another media element.
      // Match the current Deck gain before redirecting, with no audible ramp.
      if (record.volumePercent !== deckVolumePercent) {
        const now = record.context.currentTime, target = deckVolumePercent / 100;
        record.volumeNode.gain.cancelScheduledValues(now);
        record.volumeNode.gain.setValueAtTime(target, now);
        record.volumePercent = deckVolumePercent;
        record.volumeEnvelope = { from: target, target, start: now, end: now };
      }
      // Only a running, fully constructed graph may redirect the media element.
      record.sourceNode = record.context.createMediaElementSource(candidate.media);
      record.media = candidate.media; record.src = candidate.src; record.source = candidate.source;
      records.set(candidate.media, record);
      if (prepared === record) prepared = null;
      record.sourceNode.connect(record.analyser);
      record.stop=new global.WebDJStop.StopTransition(record.media,{envelope:(to,seconds,delay)=>record.stopEnvelope.set(to,seconds,delay),isRunning:()=>record.context.state==='running'});
      record.stop.setEnabled(fadeEnabled);
      watch(record);
      return record;
    } catch (error) {
      if (record.sourceNode) {
        try {
          record.sourceNode.disconnect(); record.sourceNode.connect(record.volumeNode);
          try { record.dsp.dispose(); } catch {}
          try { record.eq.dispose(); } catch {}
          record.broken = true; record.dsp = null; record.eq = null;
          return record;
        } catch { throw Object.assign(new Error('原声恢复失败，请刷新播放器。'), { code: 'recovery-required' }); }
      }
      discardPrepared(record);
      if (error.name === 'InvalidStateError') throw Object.assign(new Error('媒体可能已被 Transpose、其他扩展或播放器音频节点接管。请停用冲突功能并刷新播放器后重试。'), { code: 'media-already-connected' });
      throw Object.assign(new Error('媒体音频接管失败；未接管。'), { code: 'engine-setup-failed' });
    }
  }
  function activateRecord(record, candidate, semitones) {
    if (current && current !== record) dry(current);
    current = record;
    setOutputVolume(record, deckVolumePercent);
    if (record.src !== candidate.src) record.requestedSpeedPercent = null;
    record.src = candidate.src; record.source = candidate.source;
    record.verified = false; reconnect = false; enabled = false;
    dry(record);
    if (record.broken) return fail('processing-route-failed', '处理链连接失败，已保留原声通路；请刷新播放器。');
    record.dsp.setSemitones(semitones); record.semitones = semitones; record.bypassed = false;
    enabled = true; record.autoConnected = true; errorCode = undefined;
    initializeNativeVolume(record); checkSource();
    return snapshot(!reconnect);
  }
  function waitForMedia(ready) {
    enabled = false; phase = ready ? 'waiting-play' : 'waiting-media'; errorCode = undefined;
    message = ready ? '等待视频播放。' : '等待视频加载。';
    return snapshot();
  }
  function requestAutoResume(record, fromGesture = false) {
    if (!record || record.context.state === 'running' || (record.resumePending && !fromGesture)) return;
    record.resumePending = true;
    try {
      // Called directly from trusted pointer/keyboard events when available.
      Promise.resolve(record.context.resume()).then(() => {
        record.resumePending = false;
        if (armed && record.context.state === 'running') scheduleAuto();
      }, () => { record.resumePending = false; });
    } catch { record.resumePending = false; }
  }
  function autoFailure(error, candidate) {
    enabled = false;
    blockedAutoSource = candidate ? { media: candidate.media, src: candidate.src } : null;
    if (error.code === 'refresh-required') {
      autoTerminal = true;
      phase = 'refresh-required'; message = error.message; errorCode = error.code;
      return { ...snapshot(false), requiresReconnect: true };
    }
    return fail(error.code || 'audio-setup-failed', error.message || '音频连接失败。');
  }
  function attemptAuto() {
    if (!armed) return snapshot();
    if (autoTerminal) return snapshot(false);
    checkSource();
    const candidate = preflight();
    if (candidate.ok && blockedAutoSource?.media === candidate.media && blockedAutoSource.src === candidate.src) return snapshot(false);
    const existingMedia = current && present(current.media) && loadedSource(current.media) === current.src;
    const sameCandidate = candidate.ok ? candidate.media === current?.media && candidate.src === current?.src : candidate.code === 'media-not-ready';
    if ((enabled || current?.autoConnected) && existingMedia && !reconnect && sameCandidate) {
      if (current.context.state !== 'running') { requestAutoResume(current); if (current.context.state !== 'running') return waitForMedia(true); }
      enabled = true; return snapshot();
    }
    if (!candidate.ok && candidate.code !== 'media-not-ready') return autoFailure({ code: candidate.code, message: candidate.message });
    try {
      // Arm prepares one unbound graph even before YouTube creates currentSrc.
      const record = candidate.ok && records.get(candidate.media) || (prepared ||= prepareRecord());
      requestAutoResume(record);
      if (!candidate.ok) return waitForMedia(false);
      if (record.context.state !== 'running') return waitForMedia(true);
      const latest = preflight();
      if (!latest.ok || latest.media !== candidate.media || latest.src !== candidate.src) return waitForMedia(false);
      const result = activateRecord(attachRecord(record, candidate), candidate, 0);
      if (!result.ok) blockedAutoSource = { media: candidate.media, src: candidate.src };
      return result;
    } catch (error) { return autoFailure(error, candidate.ok ? candidate : null); }
  }
  function scheduleAuto() {
    if (!armed || autoQueued) return;
    autoQueued = true;
    const task = mutation.then(() => { autoQueued = false; return attemptAuto(); });
    mutation = task.catch(error => { autoQueued = false; return autoFailure(error); });
  }
  function installAutoListeners() {
    if (autoListenersInstalled) return;
    autoListenersInstalled = true;
    for (const type of ['loadeddata', 'canplay', 'loadedmetadata', 'play', 'playing', 'emptied', 'loadstart']) {
      global.document.addEventListener?.(type, scheduleAuto, true);
    }
    const gesture = event => {
      if (!armed || event.isTrusted === false) return;
      // An autoplay-blocked resume promise may still be pending. A trusted
      // gesture must invoke resume again inside this event, not wait for it.
      requestAutoResume(current, true); requestAutoResume(prepared, true); scheduleAuto();
    };
    global.document.addEventListener?.('pointerdown', gesture, true);
    global.document.addEventListener?.('keydown', gesture, true);
  }
  function resumeWithin(context) {
    // A blocked AudioContext.resume() may otherwise remain pending indefinitely.
    return new Promise((resolve, reject) => {
      const timeout = global.setTimeout(() => reject(Object.assign(new Error('浏览器尚未允许音频处理；请先在原播放器点击播放，再重新连接。'), { code: 'audio-activation-required' })), 1500);
      Promise.resolve().then(() => context.resume()).then(() => {
        global.clearTimeout(timeout);
        resolve();
      }, error => {
        global.clearTimeout(timeout);
        reject(error);
      });
    });
  }
  function semitonesFor(command, fallback) {
    const value = command.semitones === undefined ? fallback : command.semitones;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < -12 || value > 12) throw new Error('半音值必须是 -12 到 12 之间的数字。');
    return value;
  }
  async function run(command) {
    checkSource();
    if (!command || !['transport', 'set-fx', 'set-fade', 'set-loop', 'arm', 'probe', 'enable', 'set', 'set-speed', 'set-eq', 'reset-eq', 'set-volume', 'bypass', 'status'].includes(command.op)) return { ok: false, phase: 'error', message: '未知音频操作。', errorCode: 'invalid-command', semitones: current?.semitones || 0 };
    if(command.op==='set-loop'){const media=current?.media||mediaList().find(m=>m.readyState>=1);if(media)media.loop=!!command.enabled;return snapshot();}
    if(command.op==='set-fade'){fadeEnabled=!!command.enabled;current?.stop?.setEnabled(fadeEnabled);return snapshot();}
    if(command.op==='transport'){
      const media=current?.media||mediaList().find(m=>m.readyState>=1);if(!media)return operationFailure('media-not-ready','视频尚未加载');
      try{
        if(command.action==='play'){current?.stop?.cancelPause();await media.play();}
        else if(command.action==='pause'){if(current?.stop)current.stop.requestPause();else media.pause();}
        else if(command.action==='seek'){current?.stop?.beforeSeek();media.currentTime=Math.max(0,Math.min(media.duration||command.time,command.time));}
        return snapshot();
      }catch{return operationFailure('transport-failed','请在原播放器中操作播放');}
    }
    if(command.op==='set-fx'){
      if(!enabled||!current)return operationFailure('not-enabled','音频尚未连接');
      try{
        if(command.send>0&&!current.reverb){current.reverb=new global.WebDJReverb.ShimmerReverb(current.context,command.values);current.send=current.context.createGain();current.send.gain.value=0;current.volumeNode.connect(current.send);current.send.connect(current.reverb.input);current.reverb.output.connect(current.context.destination);}
        if(current.reverb){for(const [name,value]of Object.entries(command.values))current.reverb.set(name,value);current.reverb.setEnabled(command.enabled);current.send.gain.setTargetAtTime(command.send/100,current.context.currentTime,.03);}
        return snapshot();
      }catch{return operationFailure('fx-failed','混响未能生效');}
    }
    if (command.op === 'arm') { armed = true; blockedAutoSource = null; autoTerminal = false; installAutoListeners(); return attemptAuto(); }
    if (command.op === 'status') return snapshot(!['error', 'recovery-required', 'refresh-required'].includes(phase));
    if (command.op === 'probe') {
      const candidate = preflight();
      return candidate.ok ? { ...snapshot(), phase: enabled ? phase : 'ready', message: enabled ? message : '发现一个可测试媒体；仅点击连接后才接管，尚未验证实际音频。', source: candidate.source, paused: !!candidate.media.paused, ...speedState(current?.media === candidate.media ? current : null, candidate.media), ...volumeState(current?.media === candidate.media ? current : null, candidate.media), canEnable: true } : { ...snapshot(false), phase: 'unavailable', message: candidate.message, errorCode: candidate.code, canEnable: false };
    }
    if (command.op === 'bypass') {
      if (!current) return { ...snapshot(), phase: 'idle', message: '尚未接管，无需恢复。' };
      if (reconnect) return operationFailure('reconnect-required', '媒体已经变化，请重新连接当前媒体后再全部复位。');
      try {
        dry(current);
        setSpeed(current, 100);
        await resumeWithin(current.context);
        checkSource();
        errorCode = undefined;
        if (reconnect) return snapshot();
        phase = current.context.state === 'running' ? 'bypassed' : 'suspended';
        message = phase === 'bypassed' ? '已全部复位：原调、100% 速度、EQ 零位；播放位置和音量保持不变。' : '原声通路已连接，但音频上下文暂停；请操作播放器后重试。';
        return snapshot();
      } catch (error) {
        enabled = false;
        return fail(error.code || 'dry-route-failed', '全部复位未完成；部分设置可能已归零。' + (error.code ? error.message : '请重试，必要时刷新此播放器。'));
      }
    }
    if (['set-speed', 'set-eq', 'reset-eq', 'set-volume'].includes(command.op)) {
      if (command.op === 'set-volume' && (!Number.isInteger(command.volumePercent) || command.volumePercent < 0 || command.volumePercent > 100)) return operationFailure('invalid-volume', '音量必须是 0 到 100 之间的整数百分比。');
      if (command.op === 'set-speed' && (!Number.isInteger(command.speedPercent) || command.speedPercent < 10 || command.speedPercent > 400)) return operationFailure('invalid-speed', '速度必须是 10 到 400 之间的整数百分比。');
      if (command.op === 'set-eq' && (!['low', 'mid', 'high'].includes(command.band) || !Number.isFinite(command.gainDb) || command.gainDb < -26 || command.gainDb > 6 || !Number.isInteger(command.gainDb * 2))) return operationFailure('invalid-eq', 'EQ 频段必须是 low/mid/high，增益须在 -26 到 +6 dB，步进 0.5 dB。');
      if (!enabled || reconnect || !current || current.broken) return operationFailure('not-enabled', '请先明确连接当前媒体，再调整音频。');
      if (command.op === 'set-volume') {
        try { setOutputVolume(current, command.volumePercent); return snapshot(); }
        catch (error) { return operationFailure(error.code || 'volume-rejected', error.message); }
      }
      if (command.op === 'set-speed') {
        try { setSpeed(current, command.speedPercent); current.bypassed = false; return snapshot(); }
        catch (error) { return operationFailure(error.code || 'speed-rejected', error.message); }
      }
      const previous = { ...current.eqSettings };
      try {
        if (command.op === 'reset-eq') current.eq.reset();
        else current.eq.setBand(command.band, command.gainDb);
        const actual = readEq(current);
        const expected = command.op === 'reset-eq' ? { low: 0, mid: 0, high: 0 } : { ...previous, [command.band]: command.gainDb };
        if (!['low', 'mid', 'high'].every(band => actual[band] === expected[band])) throw new Error('EQ 设置未按请求生效。');
        current.eqSettings = actual;
        current.bypassed = false;
        return snapshot();
      } catch {
        try {
          for (const band of ['low', 'mid', 'high']) current.eq.setBand(band, previous[band]);
          current.eqSettings = readEq(current);
          if (!['low', 'mid', 'high'].every(band => current.eqSettings[band] === previous[band])) throw new Error('EQ 恢复未确认。');
          return operationFailure('eq-rejected', 'EQ 设置失败，已保留此前 EQ；速度和变调未改变。');
        } catch {
          enabled = false;
          return fail('eq-recovery-required', 'EQ 设置及恢复未完成；请尝试全部复位，必要时刷新播放器。');
        }
      }
    }
    let semitones;
    try { semitones = semitonesFor(command, command.op === 'set' ? NaN : 0); } catch (error) {
      return { ...snapshot(false), message: error.message, errorCode: 'invalid-semitones' };
    }
    if (command.op === 'set') {
      if (!enabled || reconnect || !current || current.broken) return { ...snapshot(false), message: '请先明确连接当前媒体，再调整半音。', errorCode: 'not-enabled' };
      try { current.dsp.setSemitones(semitones); current.semitones = semitones; current.bypassed = false; return snapshot(); } catch {
        try { dry(current); } catch { enabled = false; return fail('recovery-required', '变调失败且原声恢复失败；请刷新此播放器。'); }
        enabled = false;
        return fail('processing-failed', '变调设置失败，已切回原声通路。');
      }
    }
    const candidate = preflight();
    if (!candidate.ok) return { ...snapshot(false), message: candidate.message, errorCode: candidate.code };
    try {
      const record = records.get(candidate.media) || (prepared ||= prepareRecord());
      await resumeWithin(record.context);
      const latest = preflight();
      if (!latest.ok || latest.media !== candidate.media || latest.src !== candidate.src) {
        enabled = false; reconnect = true; phase = 'reconnect-required'; message = '媒体已变化，请重新连接。';
        return snapshot(false);
      }
      if (record.context.state !== 'running') { enabled = false; phase = 'suspended'; message = '等待原生播放启用音频。'; return snapshot(); }
      return activateRecord(attachRecord(record, candidate), candidate, semitones);
    } catch (error) {
      enabled = false;
      try { if (current) dry(current); } catch { return fail('recovery-required', '接管失败且原声恢复失败；请刷新此播放器。'); }
      return fail(error.code || 'audio-resume-failed', error.code ? error.message : '音频处理未启动，已保留原声通路；请操作播放器后重新连接。');
    }
  }
  if (global.MutationObserver && global.document.documentElement) {
    new global.MutationObserver(() => { checkSource(); if (armed) scheduleAuto(); }).observe(global.document.documentElement, { childList: true, subtree: true });
  }
  global.WebDJFrameEngine = Object.freeze({
    version: 5,
    command(command) {
      // Status/probe stay cheap; writes execute in order across async resume().
      if (command?.op === 'status' || command?.op === 'probe') return run(command);
      const result = mutation.then(() => run(command));
      mutation = result.catch(() => {});
      return result;
    },
  });
})(globalThis);
