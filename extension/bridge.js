/* ISOLATED world. Only proves which direct child window owns a scoped token. */
(() => {
  'use strict';
  const PROTOCOL = 'webdj-pitch-v1';
  const KEY = '__WEBDJ_PITCH_BRIDGE_V1';

  function readConfig(input) {
    if (!input || typeof input.session !== 'string' || !input.session || typeof input.token !== 'string' || !input.token || !Number.isInteger(input.frameId) || input.frameId <= 0 || typeof input.documentId !== 'string' || !input.documentId || typeof input.parentOrigin !== 'string') return null;
    try {
      const origin = new URL(input.parentOrigin);
      if (!['https:', 'http:'].includes(origin.protocol) || origin.origin !== input.parentOrigin) return null;
    } catch { return null; }
    return { session: input.session, token: input.token, frameId: input.frameId, documentId: input.documentId, parentOrigin: input.parentOrigin };
  }

  const initial = readConfig(globalThis.__WEBDJ_PITCH_BRIDGE_CONFIG);
  if (!initial || window.parent === window) return;
  if (globalThis[KEY]?.refresh) {
    globalThis[KEY].refresh(initial);
    return;
  }
  let config = initial;
  function receive(event) {
    const message = event.data;
    if (event.source !== window.parent || event.origin !== config.parentOrigin || !message || message.protocol !== PROTOCOL || message.type !== 'HELLO' || message.session !== config.session) return;
    window.parent.postMessage({ protocol: PROTOCOL, type: 'READY', session: config.session, token: config.token, frameId: config.frameId, documentId: config.documentId }, config.parentOrigin);
  }
  window.addEventListener('message', receive);
  globalThis[KEY] = Object.freeze({
    refresh(input) { const next = readConfig(input); if (next) config = next; },
    dispose() { window.removeEventListener('message', receive); delete globalThis[KEY]; },
  });
})();
