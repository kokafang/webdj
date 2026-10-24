const SAMPLES = [[60, 'C4'], [63, 'Ds4'], [66, 'Fs4'], [69, 'A4'], [72, 'C5']];
const NOTES = ['C', 'C♯ / D♭', 'D', 'D♯ / E♭', 'E', 'F', 'F♯ / G♭', 'G', 'G♯ / A♭', 'A', 'A♯ / B♭', 'B', 'C'];
const SHORTCUTS = ['KeyA', 'KeyW', 'KeyS', 'KeyE', 'KeyD', 'KeyF', 'KeyT', 'KeyG', 'KeyY', 'KeyH', 'KeyU', 'KeyJ', 'KeyK'];
const BLACK_POSITIONS = new Map([[1, 1], [3, 2], [6, 4], [8, 5], [10, 6]]);

export function mountPiano({notify}) {
  const root = document.createElement('aside');
  root.className = 'piano';
  root.setAttribute('aria-label', '调性参考钢琴');
  root.innerHTML = `<button class="piano-tab" aria-controls="piano-panel" aria-expanded="false" title="展开钢琴"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 4h18v16H3zM9 4v16M15 4v16" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7 4h4v9H7zM13 4h4v9h-4z" fill="currentColor"/></svg><span>钢琴</span><span class="piano-chevron" aria-hidden="true">‹</span></button>
    <section id="piano-panel" class="piano-panel" aria-label="钢琴 C4 到 C5" hidden inert>
      <div class="piano-head"><h2>PIANO <span>C4—C5</span></h2><button class="piano-close" aria-label="收起钢琴">收起 ›</button></div>
      <div class="piano-controls"><output class="piano-note" aria-live="polite">准备中…</output><label>音量<input class="piano-volume" aria-label="钢琴音量" type="range" min="0" max="100" value="60"></label></div>
      <div class="piano-keys" role="group" aria-label="一个八度琴键"></div>
      <div class="piano-foot"><span>原声钢琴</span><a href="./audio/piano/CREDITS.txt" target="_blank" rel="noopener" title="钢琴采样与授权">Salamander · Alexander Holm</a></div>
    </section>`;
  document.body.append(root);
  const tab = root.querySelector('.piano-tab'), panel = root.querySelector('.piano-panel');
  const noteDisplay = root.querySelector('.piano-note'), volume = root.querySelector('.piano-volume');
  const keybed = root.querySelector('.piano-keys');
  const keys = NOTES.map((name, index) => {
    const key = document.createElement('button');
    key.type = 'button';
    key.className = 'piano-key ' + (BLACK_POSITIONS.has(index) ? 'black' : 'white');
    if (BLACK_POSITIONS.has(index)) key.style.setProperty('--position', BLACK_POSITIONS.get(index));
    key.dataset.midi = 60 + index;
    key.setAttribute('aria-label', name.split(' / ').map(note => note + (index === 12 ? 5 : 4)).join(' / '));
    key.setAttribute('aria-pressed', 'false');
    key.disabled = true;
    const label = document.createElement('span');
    label.className = 'piano-key-name';
    label.textContent = name.replace(' / ', '\n');
    const shortcut = document.createElement('small');
    shortcut.textContent = SHORTCUTS[index].slice(3);
    shortcut.setAttribute('aria-hidden', 'true');
    key.append(label, shortcut);
    keybed.append(key);
    return key;
  });

  let opened = false, ready = false, preparing = null, context, master;
  const buffers = new Map(), held = new Map(), voices = new Set();
  // Prefetch locally; the audio context is only created/unlocked by a user gesture.
  const encoded = new Map();
  function fetchSample(name) {
    if (!encoded.has(name)) encoded.set(name, fetch(`./audio/piano/${name}.mp3`)
      .then(response => { if (!response.ok) throw new Error('钢琴音色未加载'); return response.arrayBuffer(); })
      .catch(error => { encoded.delete(name); throw error; }));
    return encoded.get(name);
  }
  for (const [, name] of SAMPLES) fetchSample(name).catch(() => {});

  async function prepare() {
    try {
      if (!context) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        context = new AudioContext({latencyHint: 'interactive'});
        master = context.createGain();
        master.gain.value = Number(volume.value) / 100;
        master.connect(context.destination);
      }
      // Call resume synchronously in the opening gesture, before fetching/decoding.
      const resume = context.resume();
      if (!preparing) preparing = Promise.all(SAMPLES.map(async ([midi, name]) => {
        if (!buffers.has(midi)) buffers.set(midi, await context.decodeAudioData((await fetchSample(name)).slice(0)));
      })).catch(error => { preparing = null; throw error; });
      await Promise.all([resume, preparing]);
      ready = true;
      keys.forEach(key => key.disabled = false);
      noteDisplay.textContent = '♪';
    } catch (error) {
      noteDisplay.textContent = '音色未加载';
      notify('钢琴音色未加载，请收起后重新打开');
    }
  }

  function updateKey(index) {
    const active = [...held.values()].some(voice => voice.index === index);
    keys[index].classList.toggle('pressed', active);
    keys[index].setAttribute('aria-pressed', String(active));
  }
  function release(voice, immediately = false) {
    if (voice.released) return;
    voice.released = true;
    const now = context.currentTime;
    const releaseAt = immediately ? now : Math.max(now, voice.started + 0.09);
    voice.gain.gain.cancelScheduledValues(now);
    voice.gain.gain.setValueAtTime(0.85, releaseAt);
    voice.gain.gain.exponentialRampToValueAtTime(0.0001, releaseAt + (immediately ? 0.03 : 0.22));
    voice.source.stop(releaseAt + (immediately ? 0.04 : 0.24));
  }
  function stop(id) {
    const voice = held.get(id);
    if (!voice) return;
    held.delete(id);
    release(voice);
    updateKey(voice.index);
  }
  function stopAll() {
    held.clear();
    for (const voice of voices) release(voice, true);
    keys.forEach((_, index) => updateKey(index));
  }
  function start(index, id) {
    if (!opened || !ready || held.has(id)) return;
    const resumed = context.resume();
    // A cancelled touch or a closed panel must never play after async resume.
    const token = {index};
    held.set(id, token);
    updateKey(index);
    resumed.then(() => {
      if (held.get(id) !== token || !opened) return;
      const midi = 60 + index;
      const [sampleMidi] = SAMPLES.reduce((best, candidate) => Math.abs(candidate[0] - midi) < Math.abs(best[0] - midi) ? candidate : best);
      const source = context.createBufferSource(), gain = context.createGain();
      source.buffer = buffers.get(sampleMidi);
      source.playbackRate.value = 2 ** ((midi - sampleMidi) / 12);
      gain.gain.value = 0.85;
      source.connect(gain).connect(master);
      const voice = {index, source, gain, started: context.currentTime, released: false};
      held.set(id, voice);
      voices.add(voice);
      // Bound overlapping release tails during fast playing.
      if (voices.size > 24) release(voices.values().next().value, true);
      source.onended = () => {
        source.disconnect(); gain.disconnect(); voices.delete(voice);
        if (held.get(id) === voice) { held.delete(id); updateKey(index); }
      };
      source.start();
      noteDisplay.textContent = keys[index].getAttribute('aria-label');
    }).catch(() => {
      if (held.get(id) === token) { held.delete(id); updateKey(index); }
      notify('请再点一次琴键开启声音');
    });
  }
  // Pending notes have no source yet. Removing their token cancels the resume callback.
  function end(id) {
    const voice = held.get(id);
    if (!voice) return;
    if (voice.source) stop(id);
    else { held.delete(id); updateKey(voice.index); }
  }
  function toggle(value) {
    opened = value;
    tab.setAttribute('aria-expanded', String(opened));
    tab.title = opened ? '收起钢琴' : '展开钢琴';
    panel.inert = !opened;
    if (opened) {
      panel.hidden = false;
      root.classList.add('is-open');
      prepare();
    } else {
      stopAll();
      root.classList.remove('is-open');
      panel.hidden = true;
      if (panel.contains(document.activeElement)) tab.focus({preventScroll: true});
    }
  }
  tab.addEventListener('click', () => toggle(!opened));
  root.querySelector('.piano-close').addEventListener('click', () => toggle(false));
  volume.addEventListener('input', () => {
    if (master) master.gain.setTargetAtTime(Number(volume.value) / 100, context.currentTime, 0.015);
  });
  for (const [index, key] of keys.entries()) {
    key.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      key.focus({preventScroll: true});
      key.setPointerCapture(event.pointerId);
      start(index, 'pointer-' + event.pointerId);
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      key.addEventListener(type, event => end('pointer-' + event.pointerId));
    }
    key.addEventListener('keydown', event => {
      if (!['Space', 'Enter'].includes(event.code)) return;
      event.preventDefault();
      if (!event.repeat) start(index, 'button-' + event.code);
    });
    key.addEventListener('keyup', event => {
      if (!['Space', 'Enter'].includes(event.code)) return;
      event.preventDefault(); end('button-' + event.code);
    });
    key.addEventListener('blur', () => { end('button-Space'); end('button-Enter'); });
    // Screen-reader button activation may only dispatch a click.
    key.addEventListener('click', event => {
      if (event.detail !== 0) return;
      const id = 'accessible-' + index;
      start(index, id);
      setTimeout(() => end(id), 180);
    });
  }
  document.addEventListener('keydown', event => {
    if (!opened || event.target.closest?.('input, textarea, select, [contenteditable], dialog') || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.code === 'Escape') { toggle(false); return; }
    const index = SHORTCUTS.indexOf(event.code);
    if (index < 0) return;
    event.preventDefault();
    if (!event.repeat) start(index, 'keyboard-' + event.code);
  });
  document.addEventListener('keyup', event => end('keyboard-' + event.code));
  window.addEventListener('blur', stopAll);
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopAll(); });
  window.addEventListener('pagehide', stopAll);
}
