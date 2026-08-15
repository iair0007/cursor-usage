'use strict';

// Stands in for the real extension host (src/panel.ts) so the bundled webview
// (media/main.js, built from src/webview/main.js) can run standalone in a
// plain browser tab, driven by Playwright, against the fixture data in
// data.js. Must be loaded before media/main.js, since that module calls
// acquireVsCodeApi() at import time.

(function () {
  const DATA = window.__DEMO_DATA__;
  // Pre-seeds the "seen" flag for the Simulator's one-time intro dialog
  // (src/webview/main.js's SIM_INTRO_KEY) so the recorded walkthrough goes
  // straight to the Simulator's actual content instead of a modal explaining
  // it — the modal is real product UI, just not what a first-look demo beat
  // should spend its seconds on.
  let webviewState = { prefs: { 'cursorUsage.simIntroSeen': '1' } };

  function respond(id, result) {
    window.postMessage({ type: 'rpc-result', id, result }, '*');
  }

  function respondError(id, error) {
    window.postMessage({ type: 'rpc-result', id, error }, '*');
  }

  function handleRpc(id, method, params) {
    try {
      switch (method) {
        case 'status':
          return respond(id, DATA.status);
        case 'usage':
          // The real host filters by params.startDate/endDate too, but the
          // client re-filters everything client-side (filterByRange), so
          // handing back the full fixture set is equivalent and simpler.
          return respond(id, DATA.usage);
        case 'pricing':
          return respond(id, DATA.pricing);
        case 'budget':
          return respond(id, DATA.budget);
        case 'sessionTitles': {
          const ids = Array.isArray(params?.ids) ? params.ids : [];
          const titles = {};
          for (const wid of ids) if (DATA.sessionTitles[wid]) titles[wid] = DATA.sessionTitles[wid];
          return respond(id, { titles });
        }
        case 'prefsGet':
          return respond(id, webviewState.prefs || {});
        case 'prefsSet': {
          webviewState.prefs = webviewState.prefs || {};
          if (params.value == null) delete webviewState.prefs[params.key];
          else webviewState.prefs[params.key] = String(params.value);
          return respond(id, { ok: true });
        }
        case 'log':
          return respond(id, { ok: true });
        case 'copyText':
          return respond(id, { ok: true });
        case 'focusCursorChat':
          return respond(id, { opened: false });
        case 'exportCsv':
          return respond(id, { ok: true });
        default:
          return respondError(id, `Unknown method: ${method}`);
      }
    } catch (e) {
      return respondError(id, String(e && e.message || e));
    }
  }

  window.acquireVsCodeApi = function () {
    return {
      postMessage(msg) {
        if (msg && msg.type === 'rpc') {
          // Mirrors the real host's async round trip so loading states are
          // visible for a beat instead of resolving instantly.
          setTimeout(() => handleRpc(msg.id, msg.method, msg.params), 40);
        }
      },
      getState() {
        return webviewState.vscodeState || undefined;
      },
      setState(s) {
        webviewState.vscodeState = s;
        return s;
      },
    };
  };
})();
