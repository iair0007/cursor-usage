'use strict';

// Demo-only runtime for the recorded walkthrough. Not part of the shipped
// extension — harness.html loads it after media/main.js. Three jobs:
//
//   1. A fake mouse cursor + click ripple that track real pointer events, so
//      the video shows where record.mjs's Playwright actions are pointing
//      instead of interactions happening invisibly. Purely visual
//      (`pointer-events: none`), so nothing here can intercept a real click.
//   2. A subtitle player. record.mjs hands it a beat's narration already split
//      into chunks (script.mjs's captionChunks) plus the measured length of
//      that beat's audio; it advances the chunks on its own timer, so subtitle
//      changes don't have to be interleaved with Playwright's own actions.
//   3. Rendering the status-bar slide's mock pill and hover tooltip from the
//      real fixture data, mirroring the format strings in src/statusBar.ts and
//      src/shared/usageLogic.ts — so the numbers on screen stay honest (and
//      regenerate with the fixtures) rather than being hardcoded prose.

(function () {
  // -------------------------------------------------------------------------
  // 1. Cursor + click ripple
  // -------------------------------------------------------------------------

  const cursor = document.getElementById('demoCursor');
  if (cursor) {
    document.addEventListener('mousemove', (e) => {
      cursor.style.transform = `translate(${e.clientX - 2}px, ${e.clientY - 2}px)`;
      cursor.style.opacity = '1';
    }, true);

    document.addEventListener('mousedown', (e) => {
      const ripple = document.createElement('div');
      ripple.className = 'demo-click-ripple';
      ripple.style.left = `${e.clientX}px`;
      ripple.style.top = `${e.clientY}px`;
      document.body.appendChild(ripple);
      ripple.addEventListener('animationend', () => ripple.remove());
      cursor.classList.add('demo-cursor-active');
      setTimeout(() => cursor.classList.remove('demo-cursor-active'), 200);
    }, true);

    // The closing card has nothing to point at, and a cursor parked over the
    // title just reads as a stray artifact. It fades back in on the next real
    // mouse move, so nothing else has to un-hide it.
    window.__demoCursor = {
      hide() { cursor.style.opacity = '0'; },
    };
  }

  // -------------------------------------------------------------------------
  // 2. Subtitles
  // -------------------------------------------------------------------------

  const captionEl = document.getElementById('demoCaption');
  let captionTimers = [];

  function clearCaptionTimers() {
    for (const t of captionTimers) clearTimeout(t);
    captionTimers = [];
  }

  /**
   * Shows/hides the subtitle as a popover rather than by toggling a class.
   *
   * Top-layer elements paint in promotion order, so re-showing the popover is
   * also how the subtitle gets back above a native <dialog> that opened after
   * it — see raise(). Wrapped in try/catch because show/hidePopover throws if
   * the element is already in the state being asked for.
   */
  function showCaption(text) {
    if (!captionEl) return;
    if (!text) {
      try { captionEl.hidePopover(); } catch { /* already hidden */ }
      captionEl.textContent = '';
      return;
    }
    captionEl.textContent = text;
    try { captionEl.showPopover(); } catch { /* already shown */ }
  }

  window.__demoCaptions = {
    /**
     * Shows `chunks` in order across `totalMs`, giving each chunk a share of
     * the time proportional to its length — a rough stand-in for how long the
     * voice spends on it, which is close enough that subtitles land with the
     * audio without needing per-word timings from the synthesizer.
     */
    play(chunks, totalMs) {
      clearCaptionTimers();
      if (!chunks || !chunks.length) {
        showCaption(null);
        return;
      }
      const totalChars = chunks.reduce((sum, c) => sum + c.length, 0) || 1;
      let elapsed = 0;
      for (const chunk of chunks) {
        const at = elapsed;
        captionTimers.push(setTimeout(() => showCaption(chunk), at));
        elapsed += Math.max(900, Math.round((totalMs * chunk.length) / totalChars));
      }
      // No timer hides the final chunk: it stays up until the next beat
      // replaces it, rather than blinking out early when the measured beat
      // runs a little longer than the audio it was sized against.
    },
    /**
     * Re-promotes the subtitle to the top of the top layer. Call after opening
     * a native modal <dialog>, which would otherwise paint over it.
     */
    raise() {
      if (!captionEl || !captionEl.textContent) return;
      try { captionEl.hidePopover(); } catch { /* not open */ }
      try { captionEl.showPopover(); } catch { /* raced with a chunk change */ }
    },
    clear() {
      clearCaptionTimers();
      showCaption(null);
    },
  };

  // -------------------------------------------------------------------------
  // 3. Status-bar slide: pill text + hover tooltip, from the fixture data
  // -------------------------------------------------------------------------

  const DATA = window.__DEMO_DATA__;
  const pill = document.getElementById('mockPill');
  const tooltip = document.getElementById('mockTooltip');
  if (!DATA || !pill || !tooltip) return;

  const money = (n) => `$${Number(n).toFixed(2)}`;
  const shortDate = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  /** Mirrors quotaFillBar(..., 5, 'dots') in src/shared/usageLogic.ts. */
  function fillBar(used, limit, segments = 5) {
    if (!(limit > 0)) return '';
    const ratio = Math.min(1, Math.max(0, used / limit));
    const exact = ratio * segments;
    const filled = Math.min(segments, Math.floor(exact));
    const hasHalf = filled < segments && exact - filled >= 0.5;
    return '●'.repeat(filled) + (hasHalf ? '◐' : '') + '○'.repeat(segments - filled - (hasHalf ? 1 : 0));
  }

  const budget = DATA.budget || {};
  const runway = budget.runway || {};
  const quota = DATA.usage?.quota || {};
  const events = DATA.usage?.events || [];
  const cycleEvents = events.filter((e) => e.timestamp >= budget.cycleStartMs);
  const cycleCost = cycleEvents.reduce((sum, e) => sum + (e.chargedCents || 0) / 100, 0);
  const cycleLabel = `${shortDate(new Date(budget.cycleStartMs).toISOString())} – ${shortDate(quota.resetIso)}`;

  // statusBarText()'s budget branch: "$spent/$budget <fill> · <reset>".
  pill.textContent = `📊 ${money(budget.spentDollars)}/${money(budget.budgetDollars)} `
    + `${fillBar(budget.spentDollars, budget.budgetDollars)} · ${shortDate(quota.resetIso)}`;

  // The hover card, line for line as src/statusBar.ts builds it for a
  // budget-metered plan with no fixed request quota.
  const lines = [
    `Token cost (this cycle): <strong>${money(cycleCost)}</strong>`,
    `Requests (this cycle): <strong>${cycleEvents.length.toLocaleString('en-US')}</strong>`,
    `Budget: <strong>${money(budget.spentDollars)} / ${money(budget.budgetDollars)}</strong> (${runway.percentUsed.toFixed(0)}%)`,
    `At ${money(runway.dailySpend)}/day (cycle average): <strong>~${Math.round(runway.daysToExhaustion)} days of budget left</strong>`,
    `Stays in budget at up to <strong>${money(runway.safeDailySpend)}/day</strong>`,
    `Plan: ${DATA.usage?.plan?.membershipType || 'business'}`,
    `Account: ${DATA.status?.email || ''}`,
  ];

  tooltip.innerHTML = `<div class="ide-tooltip-title"><strong>Cursor Usage</strong> — ${cycleLabel} (current cycle)</div>`
    + `<ul>${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`
    + `<div class="ide-tooltip-foot">Click to open the dashboard</div>`;
})();
