'use strict';

// Webview port of the original Cursor Usage Dashboard app.js.
// Differences from the web app: data arrives over a postMessage RPC bridge to
// the extension host (no HTTP server), Chart.js is bundled locally, prefs use
// the webview state API, and CSV export / clipboard go through VS Code.

import Chart from 'chart.js/auto';
import {
  parsePricing,
  matchPricing,
  estimateTokenCost,
  displayModel,
  cacheSavingsFor,
  num,
  normModel,
  normalize,
  summarize,
  comparisonWindow,
  detectBillingMode,
  detectPlanChange,
  modelCostDeltas,
  percentile,
  projectExhaustionDate,
  groupByDay,
  filterByRange,
} from './logic.js';

const vscode = acquireVsCodeApi();

// ---------------------------------------------------------------------------
// RPC bridge to the extension host
// ---------------------------------------------------------------------------

const rpcPending = new Map();
let rpcSeq = 0;

/**
 * Bridges a call to the extension host. Always settles: if the host never
 * posts back an rpc-result (a bug on that side, or a message that got lost),
 * this rejects after `timeoutMs` instead of leaving callers (and the loading
 * spinner) hanging forever with no explanation.
 */
function rpc(method, params, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    const timer = setTimeout(() => {
      rpcPending.delete(id);
      reject(new Error(`"${method}" timed out waiting for a response from the extension. Run "Cursor Usage: Show Logs" to see what happened.`));
    }, timeoutMs);
    rpcPending.set(id, {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    });
    vscode.postMessage({ type: 'rpc', id, method, params });
  });
}

window.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (msg?.type === 'rpc-result') {
    const p = rpcPending.get(msg.id);
    if (!p) return;
    rpcPending.delete(msg.id);
    if (msg.error) {
      const err = new Error(msg.error);
      err.authError = Boolean(msg.authError);
      p.reject(err);
    } else {
      p.resolve(msg.result);
    }
  } else if (msg?.type === 'refresh') {
    load();
  }
});

// ---------------------------------------------------------------------------
// Persistence — webview state instead of localStorage
// ---------------------------------------------------------------------------

const persisted = vscode.getState() || {};
const storage = {
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(persisted, key) ? persisted[key] : null;
  },
  setItem(key, value) {
    persisted[key] = String(value);
    vscode.setState(persisted);
  },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const ANALYZE_THRESHOLD_DEFAULTS = {
  modelDominancePct: 40,
  cacheHitWarnPct: 30,
  coldStartInputTokens: 3000,
  coldStartCount: 5,
  heavyOutputTokens: 2000,
  heavyOutputCount: 3,
};

const state = {
  all: [],
  filtered: [],
  /** True once a load has settled, so views can tell "no data" from "not fetched yet". */
  loaded: false,
  pricing: null,
  sortKey: 'timestampMs',
  sortDir: 'desc',
  page: 1,
  pageSize: 25,
  panel: 'requests',
  /** Analyze tab sub-view: 'findings' | 'compare'. */
  analyzePanel: 'findings',
  appView: 'overview',
  simMode: 'request',
  simRequestId: null,
  simCompareSelected: null,
  simCompareFilterRequestId: null,
  simCompareSortKey: 'estCost',
  simCompareSortDir: 'asc',
  simCompareContext: null,
  analyzeTemplateId: 'overview',
  charts: {},
  chartsReady: false,
  datePreset: '30d',
  costMode: 'value', // 'value' (what-if API-equivalent) | 'billed' (actual charges)
  plan: null,
  budget: null,
  /** Local day (YYYY-MM-DD) billing switched to the current system, once seen. */
  planChangeDay: null,
  /** The auto-switch to the current-plan range happens once, not on every load. */
  planChangeAnnounced: false,
  trend: {
    key: null,
    /** summarize() of the baseline period — drives the ▲/▼ badges. */
    previous: null,
    /** Baseline events, kept so the comparison can break the change down by model. */
    previousEvents: null,
    /** Which window to compare against: 'previous' | 'prevMonth' | 'custom'. */
    mode: 'previous',
    customStart: '',
    customEnd: '',
    /** The resolved baseline window, for labelling the columns. */
    range: null,
    loading: false,
    error: null,
  },
  analyzeThresholds: { ...ANALYZE_THRESHOLD_DEFAULTS },
  /** Severity of the banner currently shown, so view switches can keep the ones that still apply. */
  alertType: null,
  /** Note to fold into the next load's banner (see takePendingNotice). */
  pendingNotice: null,
};

const $ = (id) => document.getElementById(id);

const fmt = {
  money(v) { return v == null ? '—' : `$${v.toFixed(2)}`; },
  num(v) { return v.toLocaleString('en-US'); },
  pct(v) { return v == null ? '—' : `${v.toFixed(1)}%`; },
  date(ms) {
    if (!ms) return '—';
    return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  },
  shortDate(s) {
    if (!s) return '';
    return new Date(s + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  },
};

/**
 * HTML-escapes a value for interpolation into markup.
 *
 * Quotes are escaped too, not just the angle brackets: most uses here land
 * inside an attribute (`data-id="…"`, `value="…"`, `title="…"`), and the model
 * names, kinds and ids being interpolated come from cursor.com's API rather
 * than from this extension — a value carrying a quote would otherwise close the
 * attribute and let the rest of it be parsed as markup.
 */
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STORAGE_KEY = 'cursorUsageDashboardPrefs';
const COST_MODE_KEY = 'cursorUsageDashboardCostMode';
const COMPARE_MODELS_KEY = 'cursorUsageDashboardCompareModels';
const ANALYZE_PREFS_KEY = 'cursorUsageDashboardAnalyzePrefs';

// ---------------------------------------------------------------------------
// Theme-aware chart colors (VS Code CSS variables)
// ---------------------------------------------------------------------------

function themeColor(varName, fallback) {
  const v = getComputedStyle(document.body).getPropertyValue(varName).trim();
  return v || fallback;
}

function chartMuted() { return themeColor('--vscode-descriptionForeground', '#64748b'); }
function chartGrid() { return themeColor('--vscode-editorWidget-border', 'rgba(128,128,128,0.2)'); }
function chartTooltipBg() { return themeColor('--vscode-editorWidget-background', '#1e293b'); }
function chartTooltipFg() { return themeColor('--vscode-editorWidget-foreground', '#f8fafc'); }

// ---------------------------------------------------------------------------
// Plan & cost mode
// ---------------------------------------------------------------------------

function isFreePlan() {
  return Boolean(state.plan?.membershipType?.startsWith('free'));
}

function planLabel() {
  const t = state.plan?.membershipType;
  if (!t || t === 'unknown') return null;
  const labels = {
    free: 'Free plan',
    free_trial: 'Pro trial',
    pro: 'Pro plan',
    pro_plus: 'Pro+ plan',
    ultra: 'Ultra plan',
    business: 'Business plan',
    enterprise: 'Enterprise plan',
  };
  return labels[t] || `${t} plan`;
}

// Mirrors the status bar's default warn/critical thresholds (cursorUsage.statusBar.warnAtPercent/
// criticalAtPercent) — the webview has no direct access to those settings, so this uses the same defaults.
const PLAN_CYCLE_WARN_PCT = 80;
const PLAN_CYCLE_CRITICAL_PCT = 95;

const RING_CIRCUMFERENCE = 97.39; // 2 * PI * r, r = 15.5 (must match the SVG circle radius)

/**
 * Renders the prominent Plan & cycle panel at the top of the dashboard, or
 * hides it entirely if Cursor returned nothing usable for this account.
 *
 * Three honest states, not one generic "quota" number:
 *  - a real fixed request limit was found -> fill ring + bar with exact
 *    numbers, including when usage has gone over the limit.
 *  - no fixed limit, but Cursor reports a real (nonzero) usage count for
 *    this cycle -> show that count plainly, no bar (nothing to divide by).
 *  - no fixed limit AND nothing meaningful to show (e.g. a stuck 0 while
 *    the loaded period clearly has real requests) -> explain why instead of
 *    displaying a number that would just be wrong.
 *  - nothing at all -> hide the panel; the rest of the dashboard still works.
 */
function renderPlanCycle(quota, hardLimit) {
  const card = $('planCycleCard');
  if (!card) return;

  const label = planLabel();
  if (!label && !quota) {
    card.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  card.classList.remove('plan-cycle-warning', 'plan-cycle-critical');
  $('planCycleName').textContent = label || 'Unknown plan';

  const resetEl = $('planCycleReset');
  if (quota?.resetIso) {
    const resetDate = new Date(quota.resetIso);
    resetEl.textContent = Number.isNaN(resetDate.getTime())
      ? ''
      : `Resets ${resetDate.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  } else {
    resetEl.textContent = '';
  }

  const barRow = $('planCycleBarRow');
  const ring = $('planCycleRing');
  const noteEl = $('planCycleNote');
  const hasLimit = quota && quota.limit != null && quota.limit > 0 && quota.used != null;
  // A count with no fixed limit is only worth showing if it looks real — a
  // stuck 0 next to a period with actual loaded requests is more likely an
  // untracked bucket than genuinely zero usage.
  const hasMeaningfulCountOnly = quota && !hasLimit && quota.used > 0;

  if (hasLimit) {
    const pctExact = (quota.used / quota.limit) * 100; // uncapped — used for numbers and severity
    const pctVisual = Math.min(100, pctExact); // capped — used for the bar/ring fill
    const overLimit = quota.used > quota.limit;

    barRow.classList.remove('hidden');
    ring.classList.remove('hidden');
    $('planCycleBarFill').style.width = `${pctVisual}%`;
    $('planCycleRingFill').style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - pctVisual / 100)}`;
    $('planCycleBarLabel').textContent = overLimit
      ? `${fmt.num(quota.used)} / ${fmt.num(quota.limit)} · limit reached (${fmt.pct(pctExact)})`
      : `${fmt.num(quota.used)} / ${fmt.num(quota.limit)} (${fmt.pct(pctExact)})`;

    if (overLimit || pctExact >= PLAN_CYCLE_CRITICAL_PCT) card.classList.add('plan-cycle-critical');
    else if (pctExact >= PLAN_CYCLE_WARN_PCT) card.classList.add('plan-cycle-warning');

    const notes = [];
    if (overLimit) {
      notes.push(`You've used ${fmt.num(quota.used - quota.limit)} more request${quota.used - quota.limit === 1 ? '' : 's'} than this cycle's included amount.`);
    } else if (quota.startOfCycleIso) {
      const sinceMs = new Date(quota.startOfCycleIso).getTime();
      if (!Number.isNaN(sinceMs)) {
        const exhaustion = projectExhaustionDate(quota.used, quota.limit, sinceMs);
        if (exhaustion) {
          const days = Math.max(0, Math.round((exhaustion.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
          notes.push(days <= 0
            ? 'At this pace, you’ve already used this cycle’s included requests.'
            : `At this pace: ~${days} day${days === 1 ? '' : 's'} until included requests run out.`);
        }
      }
    }
    if (hardLimit) notes.push(`Usage-based spend cap: $${hardLimit.toFixed(2)}/mo.`);
    noteEl.textContent = notes.join(' ');
    renderPlanCycleScope('quota', quota);
  } else if (budgetRunwayState()) {
    renderBudgetCycle(card, budgetRunwayState(), barRow, ring, noteEl, hardLimit, quota);
  } else if (hasMeaningfulCountOnly) {
    barRow.classList.add('hidden');
    ring.classList.add('hidden');
    const notes = [`${fmt.num(quota.used)} requests this cycle · no fixed limit found for this plan.`];
    if (hardLimit) notes.push(`Usage-based spend cap: $${hardLimit.toFixed(2)}/mo.`);
    noteEl.textContent = notes.join(' ');
    renderPlanCycleScope('quota', quota);
  } else {
    barRow.classList.add('hidden');
    ring.classList.add('hidden');
    renderPlanCycleScope(null, quota);
    const notes = [];
    if (quota) {
      notes.push(
        'This plan meters usage by token cost rather than by a request count, '
        + 'so there is no quota to fill — the cards below are the figures to watch.',
      );
    }
    if (hardLimit) notes.push(`Usage-based spend cap: $${hardLimit.toFixed(2)}/mo.`);
    noteEl.textContent = notes.join(' ');
  }
}

/**
 * Notices a plan change in the events just loaded, reveals the "Current plan"
 * preset, and — the first time it's seen — switches to it.
 *
 * Mixing two billing systems in one total is the thing that made "Month to
 * date" read $202 when cursor.com said $2.79, so once we know where the change
 * happened, the range that only covers the current system is the honest
 * default. Only automatic once: after that the choice is the user's, and their
 * saved preset is respected.
 *
 * Returns true when it kicked off a reload, so the caller stops rendering the
 * range being replaced.
 */
function applyPlanChangeDiscovery() {
  const change = detectPlanChange(state.all);
  if (change) {
    state.planChangeDay = change.dayKey;
    savePrefs({
      preset: state.datePreset,
      startDate: $('startDate').value,
      endDate: $('endDate').value,
      planChangeDay: change.dayKey,
    });
  }
  $('planPresetBtn')?.classList.toggle('hidden', !state.planChangeDay);
  if (!change || state.planChangeAnnounced || state.datePreset === 'plan') return false;

  state.planChangeAnnounced = true;
  const range = getRangeForPreset('plan');
  if (!range) return false;
  applyDateRange(range.start, range.end, 'plan');
  // Queued rather than shown: the reload below ends with its own banner, which
  // would replace this one immediately.
  //
  // Written from where the user now is, not from where they were. By the time
  // this appears the range has already been switched to "Current plan", so
  // "the range you picked" named something no longer on screen and "pick
  // another period" read as an instruction rather than an option.
  const earlier = `${fmt.num(change.legacyRequestsBefore)} request${change.legacyRequestsBefore === 1 ? '' : 's'}`;
  state.pendingNotice = `Your plan's billing changed on ${fmt.shortDate(change.dayKey)}, so this switched to the "Current plan" period. `
    + `The ${earlier} before that date were priced per request, and mixing those dollars with today's would give a total that matches neither. `
    + 'Pick any other period to see them.';
  void load();
  return true;
}

/**
 * Warning for a loaded range that straddles the plan's billing change.
 *
 * Keyed on the events actually loaded rather than on the dates, so it fires for
 * any range holding both kinds of request — a preset, a custom range, or a
 * saved one restored on startup — and stays silent for a range that sits
 * wholly on one side, where the totals are internally consistent.
 */
function planChangeSpanNote() {
  const legacy = state.all.filter((e) => e.billingRegime === 'usage').length;
  const metered = state.all.length - legacy;
  if (!legacy || !metered) return '';
  const changed = state.planChangeDay ? ` on ${fmt.shortDate(state.planChangeDay)}` : '';
  return ` This range spans your plan's billing change${changed}: ${fmt.num(legacy)} of these requests`
    + ` were priced per request and ${fmt.num(metered)} by token cost, so the totals below add up two`
    + ' pricing systems. Use "Current plan" for figures comparable with cursor.com.';
}

/** The budget projection, or null when no budget is known (nothing to project against). */
function budgetRunwayState() {
  return state.budget?.runway ?? null;
}

/** "Aug 9" — the short form used when naming a cycle boundary in prose. */
function formatDayMonth(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/**
 * The day the current billing cycle began, from whichever source knows it.
 *
 * Every figure on this card — requests used, budget spent, and the daily pace
 * derived from it — is measured from that day, while the filter bar directly
 * above the card can be showing any range at all. Naming the date is what makes
 * "$25.28 spent" and "$6.52/day" reconcilable when the period chip says "Today".
 */
function cycleStartLabel(quota) {
  if (quota?.startOfCycleIso) {
    const ms = new Date(quota.startOfCycleIso).getTime();
    const label = formatDayMonth(ms);
    if (label) return label;
  }
  return formatDayMonth(state.budget?.cycleStartMs);
}

/**
 * Says, once, that this card is cycle-scoped — the period selected above does
 * not move any number on it.
 */
function renderPlanCycleScope(kind, quota) {
  const el = $('planCycleScope');
  if (!el) return;
  if (!kind) {
    el.classList.add('hidden');
    el.textContent = '';
    return;
  }
  const since = cycleStartLabel(quota);
  const window = since ? `the current billing cycle (since ${since})` : 'the current billing cycle';
  el.textContent = kind === 'quota'
    ? `Requests here are counted over ${window} — not the period selected above.`
    : `Spend here is measured over ${window} — not the period selected above.`;
  el.classList.remove('hidden');
}

function formatDays(days) {
  if (days < 1) return 'less than a day';
  const whole = Math.round(days);
  return `${whole} day${whole === 1 ? '' : 's'}`;
}

/**
 * Budget-plan counterpart of the request-quota gauge: how much of the monthly
 * budget is gone, how long it lasts at the current pace, and what daily spend
 * still fits the cycle. Phrased around the reset date, because a budget that
 * refills is a pacing problem, not a countdown to zero.
 */
function renderBudgetCycle(card, runway, barRow, ring, noteEl, hardLimit, quota) {
  const pctVisual = Math.min(100, Math.max(0, runway.percentUsed));
  barRow.classList.remove('hidden');
  ring.classList.remove('hidden');
  $('planCycleBarFill').style.width = `${pctVisual}%`;
  $('planCycleRingFill').style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - pctVisual / 100)}`;
  $('planCycleBarLabel').textContent = runway.overBudget
    ? `${fmt.money(runway.spentDollars)} / ${fmt.money(runway.budgetDollars)} · over budget (${fmt.pct(runway.percentUsed)})`
    : `${fmt.money(runway.spentDollars)} / ${fmt.money(runway.budgetDollars)} (${fmt.pct(runway.percentUsed)})`;

  if (runway.overBudget || runway.percentUsed >= PLAN_CYCLE_CRITICAL_PCT) card.classList.add('plan-cycle-critical');
  else if (runway.percentUsed >= PLAN_CYCLE_WARN_PCT) card.classList.add('plan-cycle-warning');

  const notes = [];
  if (runway.overBudget) {
    notes.push(`You're ${fmt.money(-runway.remainingDollars)} over this cycle's budget.`);
  } else if (runway.dailySpend == null) {
    notes.push(`${fmt.money(runway.remainingDollars)} left this cycle — too early in the cycle to project a pace.`);
  } else {
    // The pace is spend ÷ days elapsed in this cycle, so a day of heavy use
    // early on reads as a modest daily rate. Saying which days it averages is
    // the difference between a figure the user can check and one that looks
    // invented — especially when the period chip above says "Today".
    const since = cycleStartLabel(quota);
    const pace = `At ${fmt.money(runway.dailySpend)}/day (average${since ? ` since ${since}` : ' over this cycle'})`;
    if (runway.exhaustsBeforeReset === true) {
      notes.push(`${pace}, the ${fmt.money(runway.budgetDollars)} budget runs out in ${formatDays(runway.daysToExhaustion)}`
        + ` — ${formatDays(runway.daysUntilReset - runway.daysToExhaustion)} before the cycle resets.`);
    } else if (runway.exhaustsBeforeReset === false) {
      notes.push(`${pace}, you'll finish the cycle inside budget with about ${fmt.money(runway.remainingDollars - runway.dailySpend * runway.daysUntilReset)} to spare.`);
    } else {
      notes.push(`${pace}, ${fmt.money(runway.remainingDollars)} lasts about ${formatDays(runway.daysToExhaustion)}.`);
    }
    if (runway.safeDailySpend != null) {
      notes.push(`Up to ${fmt.money(runway.safeDailySpend)}/day keeps you within it until the reset.`);
    }
  }
  if (state.budget?.source === 'setting') {
    notes.push('Budget from your settings (cursorUsage.budget.monthlyDollars).');
  } else if (state.budget?.source === 'hardLimit') {
    notes.push('Budget from your usage-based spend cap.');
  }
  if (hardLimit && state.budget?.source !== 'hardLimit') notes.push(`Usage-based spend cap: $${hardLimit.toFixed(2)}/mo.`);
  noteEl.textContent = notes.join(' ');
  renderPlanCycleScope('budget', quota);
}

/** Events re-mapped so `cost` reflects the active cost mode. */
function applyCostMode(events) {
  if (state.costMode !== 'billed') return events;
  return events.map((e) => ({ ...e, cost: e.billedCost }));
}

/**
 * What the `cost` field currently means, for headings and column labels.
 *
 * The Costs toggle re-points every cost figure at either the what-if token
 * value or the amount actually billed, so a heading hard-coded to "Token cost"
 * is a wrong label on half of the dashboard's states — the same mistake the
 * KPI card already avoids by rewriting its own label.
 */
function costModeLabel() {
  return state.costMode === 'billed' ? 'Billed cost' : 'Token cost';
}

function costModeNoun() {
  return state.costMode === 'billed' ? 'billed cost' : 'token cost';
}

/** Re-labels the static headings that describe whatever `cost` currently is. */
function applyCostModeLabels() {
  const label = costModeLabel();
  const billed = state.costMode === 'billed';
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  set('colCostLabelText', label);
  set('tableCostDesc', billed
    ? 'What your plan actually charged per request (not the flat usage fee). Hover ⓘ on column headers for help.'
    : 'Token cost per request (not the flat usage fee). Hover ⓘ on column headers for help.');
  set('chartCostTitle', `Daily ${costModeNoun()}`);
  set('chartCostDesc', billed
    ? 'How billed spend changed day to day'
    : 'How spend changed day to day · excludes flat usage fees');
  set('chartModelsDesc', billed ? 'Top models by billed spend' : 'Top models by token/API spend');
}

function setCostMode(mode) {
  state.costMode = mode;
  storage.setItem(COST_MODE_KEY, mode);
  document.querySelectorAll('.cost-mode-btn').forEach((btn) => {
    const active = btn.dataset.costMode === mode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  applyCostModeLabels();
  state.page = 1;
  destroyCharts();
  refresh();
}

// ---------------------------------------------------------------------------
// Date range presets & persistence
// ---------------------------------------------------------------------------

function toDateInputValue(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function todayAtMidnight() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function getRangeForPreset(preset) {
  const end = todayAtMidnight();
  const start = new Date(end);
  if (preset === 'today') {
    // start = end
  } else if (preset === '7d') {
    start.setDate(start.getDate() - 6);
  } else if (preset === '30d') {
    start.setDate(start.getDate() - 29);
  } else if (preset === 'mtd') {
    start.setDate(1);
  } else if (preset === 'plan') {
    // Only offered once a plan change has actually been seen in the data.
    if (!state.planChangeDay) return null;
    return { start: state.planChangeDay, end: toDateInputValue(end), preset };
  } else {
    return null;
  }
  return { start: toDateInputValue(start), end: toDateInputValue(end), preset };
}

function detectPreset(start, end) {
  for (const preset of ['today', 'plan', '7d', '30d', 'mtd']) {
    const r = getRangeForPreset(preset);
    if (r && r.start === start && r.end === end) return preset;
  }
  return 'custom';
}

function loadPrefs() {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Merges into whatever is already stored, so a caller only has to name the keys
 * it owns. Callers write disjoint slices — the date range, the comparison
 * baseline, the Analyze template — and a replacing write would silently drop
 * every slice but its own.
 */
function savePrefs(prefs) {
  try {
    // planChangeDay is discovered, not chosen, so state is authoritative for it.
    const merged = { ...loadPrefs(), planChangeDay: state.planChangeDay, ...prefs };
    storage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // ignore
  }
}

// The cost-mode buttons share the .preset-btn class for styling only — they
// carry data-cost-mode, not data-preset. Period wiring must never match them,
// or applying a date preset silently clears the What-if/Billed highlight (and
// clicking What-if/Billed fires the period handler with an undefined preset).
const PRESET_BTN_SELECTOR = '.preset-btn[data-preset]';

// The Requests and Analyze tab strips share .view-tab for styling only. Each
// carries its own data attribute, and both selectors must stay scoped to it:
// an unscoped '.view-tab' matched the other strip's buttons, and
// setPanel(undefined) lit every tab whose data-panel was also undefined.
const VIEW_TAB_SELECTOR = '.view-tab[data-panel]';
const ANALYZE_TAB_SELECTOR = '.view-tab[data-analyze-panel]';

const PRESET_LABELS = {
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
  mtd: 'Month to date',
  plan: 'Current plan',
  custom: 'Custom',
};

function setActivePreset(preset) {
  document.querySelectorAll(PRESET_BTN_SELECTOR).forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.preset === preset);
  });
  state.datePreset = preset;
}

function applyDateRange(start, end, preset) {
  $('startDate').value = start;
  $('endDate').value = end;
  const resolved = preset || detectPreset(start, end);
  setActivePreset(resolved);
  savePrefs({ preset: resolved, startDate: start, endDate: end });
  updateFilterSummary();
}

const COMPARE_MODES = ['previous', 'prevMonth', 'custom'];

/** Restores the comparison baseline chosen in a previous session. */
function initPeriodComparePrefs() {
  const prefs = loadPrefs();
  if (COMPARE_MODES.includes(prefs?.compareMode)) state.trend.mode = prefs.compareMode;
  if (prefs?.compareStart) state.trend.customStart = prefs.compareStart;
  if (prefs?.compareEnd) state.trend.customEnd = prefs.compareEnd;
  if ($('compareStartDate')) $('compareStartDate').value = state.trend.customStart;
  if ($('compareEndDate')) $('compareEndDate').value = state.trend.customEnd;
  // A stored "custom" with no dates would leave the panel prompting forever.
  if (state.trend.mode === 'custom' && !(state.trend.customStart && state.trend.customEnd)) {
    state.trend.mode = 'previous';
  }
}

function initDateRange() {
  const prefs = loadPrefs();
  if (prefs?.planChangeDay) {
    state.planChangeDay = prefs.planChangeDay;
    // Known from a previous session: no need to re-announce the switch.
    state.planChangeAnnounced = true;
    $('planPresetBtn')?.classList.remove('hidden');
  }
  if (prefs?.preset && prefs.preset !== 'custom') {
    // A stored preset can no longer be resolvable — "Current plan" saved in an
    // earlier session whose planChangeDay didn't come back, or a preset name
    // this version dropped. Falling through to the saved dates (and then to the
    // default) beats throwing out of init(), which would leave the dashboard
    // rendered but with none of its controls wired up.
    const range = getRangeForPreset(prefs.preset);
    if (range) {
      applyDateRange(range.start, range.end, prefs.preset);
      return;
    }
  }
  if (prefs?.startDate && prefs?.endDate) {
    applyDateRange(prefs.startDate, prefs.endDate, 'custom');
    return;
  }
  const range = getRangeForPreset('30d');
  applyDateRange(range.start, range.end, '30d');
}

function onPresetClick(preset) {
  if (preset === 'custom') {
    setActivePreset('custom');
    savePrefs({
      preset: 'custom',
      startDate: $('startDate').value,
      endDate: $('endDate').value,
    });
    updateFilterSummary();
    return;
  }
  const range = getRangeForPreset(preset);
  if (!range) return;
  applyDateRange(range.start, range.end, preset);
  load();
}

function onDateInputChange() {
  const start = $('startDate').value;
  const end = $('endDate').value;
  if (!start || !end) return;
  const preset = detectPreset(start, end);
  setActivePreset(preset);
  savePrefs({ preset, startDate: start, endDate: end });
  load();
}

/**
 * Shows the single banner under the toolbar, with a dismiss control.
 *
 * The type is remembered: an error or warning is a statement about the data
 * currently on screen and stays put when the user switches views, while the
 * "Loaded N requests" confirmation is only meaningful next to the request log.
 */
function showAlert(type, msg) {
  const el = $('alert');
  state.alertType = type;
  el.className = `alert ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = '<span class="alert-msg"></span><button type="button" class="alert-close" aria-label="Dismiss message">✕</button>';
  el.querySelector('.alert-msg').textContent = msg;
  el.classList.remove('hidden');
}

function hideAlert() {
  state.alertType = null;
  $('alert')?.classList.add('hidden');
}

/**
 * A one-off note queued by an earlier step, to be shown with the next load's
 * banner. The plan-change switch used to post its explanation and immediately
 * trigger the reload that overwrote it, so the one message that explains why
 * the range moved was on screen for a fraction of a second.
 */
function takePendingNotice() {
  const notice = state.pendingNotice;
  state.pendingNotice = null;
  return notice ? `${notice} ` : '';
}

/** Toolbar/loading state for an in-flight fetch. */
function setBusy(busy) {
  document.body.classList.toggle('is-loading', busy);
  document.body.setAttribute('aria-busy', busy ? 'true' : 'false');
  $('loading')?.classList.toggle('hidden', !busy);
  const refreshBtn = $('refreshBtn');
  if (refreshBtn) {
    refreshBtn.disabled = busy;
    refreshBtn.textContent = busy ? 'Refreshing…' : 'Refresh';
  }
  const exportBtn = $('exportBtn');
  if (exportBtn) exportBtn.disabled = busy;
}

function toMs(dateStr, endOfDay) {
  const d = new Date(dateStr + 'T00:00:00');
  if (endOfDay) d.setHours(23, 59, 59, 999);
  return d.getTime();
}

// ---------------------------------------------------------------------------
// Filtering & aggregation
// ---------------------------------------------------------------------------

function applyFilters(events) {
  const model = $('modelFilter').value;
  return events.filter((e) => !model || e.modelRaw === model);
}

function sortEvents(events) {
  const dir = state.sortDir === 'asc' ? 1 : -1;
  return [...events].sort((a, b) => {
    const av = a[state.sortKey];
    const bv = b[state.sortKey];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv) * dir;
    return (av - bv) * dir;
  });
}

function pageSlice(events) {
  const totalPages = Math.max(1, Math.ceil(events.length / state.pageSize));
  if (state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * state.pageSize;
  return { rows: events.slice(start, start + state.pageSize), totalPages, start, end: Math.min(start + state.pageSize, events.length) };
}

function sumRows(rows, key) {
  return rows.reduce((s, e) => s + (e[key] ?? 0), 0);
}

function updateFilterSummary() {
  const modelVal = $('modelFilter').value;
  const modelLabel = modelVal ? displayModel(modelVal) : 'All models';
  const period = PRESET_LABELS[state.datePreset] || 'Custom';
  const parts = [
    period,
    `${fmt.shortDate($('startDate').value)} – ${fmt.shortDate($('endDate').value)}`,
    modelLabel,
  ];
  $('filterSummary').textContent = parts.join(' · ');
}

// ---------------------------------------------------------------------------
// Analytics charts
// ---------------------------------------------------------------------------

const CHART_COLORS = ['#2563eb', '#7c3aed', '#059669', '#d97706', '#db2777', '#0891b2', '#64748b'];

function costByModel(events) {
  const map = {};
  for (const e of events) {
    if (e.cost == null) continue;
    map[e.model] = (map[e.model] || 0) + e.cost;
  }
  return Object.entries(map).sort((a, b) => b[1] - a[1]);
}

function topModelsWithOther(entries, limit = 6) {
  if (entries.length <= limit) return entries;
  const top = entries.slice(0, limit);
  const otherSum = entries.slice(limit).reduce((s, [, v]) => s + v, 0);
  if (otherSum > 0) top.push(['Other', otherSum]);
  return top;
}

function truncateLabel(label, max = 22) {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function formatChartMoney(v) {
  return `$${Number(v).toFixed(2)}`;
}

function formatChartTokens(v) {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return String(Math.round(v));
}

/**
 * Explains a range that spans a plan change, in the terms cursor.com's usage
 * page uses. Without it the headline blends token-metered spend with requests
 * priced by the older per-request plan, producing a figure that matches
 * neither page — and looks like the extension is inventing money.
 */
function planChangeNote(summary, { short = false } = {}) {
  // Keyed on the presence of per-request rows, not on the range straddling the
  // change: a range entirely before it (say "Last month") shows a large token
  // figure against cursor.com's $0 and needs the same explanation.
  if (!summary.legacyRequestCount) return '';
  const requests = `${fmt.num(summary.legacyRequestCount)} request${summary.legacyRequestCount === 1 ? '' : 's'}`;
  const metered = `cursor.com meters ${fmt.money(summary.meteredTotal)} for this range`;
  // The stat card is one of three in a grid — the long form there would make it
  // several lines taller than its neighbours, so it gets the headline only.
  if (short) {
    return `${metered} · ${requests} priced per request under your previous plan`;
  }
  const legacy = `${requests} (${fmt.money(summary.legacyTokenValue)} of token value) were priced per request `
    + `under your previous plan — ${fmt.money(summary.legacyFeeTotal)} in flat fees — so its spend view doesn't count them`;
  return `${metered}. ${summary.meteredCount ? 'The other ' : 'All '}${legacy}.`;
}

/** ▲/▼ delta badge vs the previous equal-length period; null when there's nothing to compare or the baseline is 0. */
function trendBadge(current, previous) {
  if (previous == null || !(previous > 0)) return '';
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 1) return '<span class="trend-badge trend-flat">flat vs prior period</span>';
  const up = pct > 0;
  return `<span class="trend-badge ${up ? 'trend-up' : 'trend-down'}">${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(0)}% vs prior period</span>`;
}

function renderAnalyticsStats(events, summary, previousSummary) {
  const el = $('analyticsStats');
  if (!el) return;
  const byDay = groupByDay(events);
  const dayCount = Object.keys(byDay).length || 1;
  const avgDaily = summary.totalCost / dayCount;
  const topModel = costByModel(events)[0];
  const tokens = tokenTotals(events);
  const totalTok = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  const cachePct = totalTok > 0 ? (tokens.cacheRead / totalTok) * 100 : 0;

  el.innerHTML = `
    <div class="analytics-stat"><span>Total ${esc(costModeNoun())}</span><strong>${fmt.money(summary.totalCost)}</strong><small>${fmt.num(summary.count)} requests</small>${trendBadge(summary.totalCost, previousSummary?.totalCost)}</div>
    <div class="analytics-stat"><span>Avg / day</span><strong>${fmt.money(avgDaily)}</strong><small>${fmt.num(dayCount)} days</small></div>
    <div class="analytics-stat"><span>Top model</span><strong>${esc(topModel ? topModel[0] : '—')}</strong><small>${topModel ? fmt.money(topModel[1]) : '—'}</small></div>
    <div class="analytics-stat"><span>Cache read share</span><strong>${fmt.pct(cachePct)}</strong><small>${fmt.money(summary.totalSavings)} saved</small></div>`;
}

// ---------------------------------------------------------------------------
// Period comparison
// ---------------------------------------------------------------------------

/** "Jul 15 – Aug 13" for a window in epoch ms. */
function windowLabel(window) {
  if (!window) return '—';
  const d = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const start = d(window.startMs);
  const end = d(window.endMs);
  return start === end ? start : `${start} – ${end}`;
}

/** Whole days a window spans, counting both ends. */
function windowDays(window) {
  if (!window) return 0;
  return Math.max(1, Math.round((window.endMs - window.startMs) / (24 * 60 * 60 * 1000)));
}

/**
 * A signed delta, coloured by what the movement means rather than by its sign:
 * spending more is amber and spending less is green, but for cache savings
 * that flips — `betterWhen: 'up'` says which direction is the good one.
 *
 * "No change" is judged at the precision actually on screen. Comparing the raw
 * floats instead would print "$0.07 vs $0.06 · no change" (a real difference
 * rounded away) or "+$0.07 (+0%)" (a real difference the percentage rounds
 * away) — both read as the panel contradicting itself.
 */
function deltaCell(current, baseline, format = fmt.money, betterWhen = 'down') {
  if (format(current) === format(baseline)) return '<span class="delta delta-flat">no change</span>';
  const delta = current - baseline;
  const up = delta > 0;
  const sign = up ? '+' : '−';
  // The values differ on screen but the gap is under one displayed unit — say
  // "<$0.01" rather than "$0.00", which reads as no difference at all.
  const smallestUnit = format === fmt.num ? 1 : 0.01;
  const exactMagnitude = format(Math.abs(delta));
  const belowUnit = exactMagnitude === format(0);
  // "<$0.01" carries its own qualifier; "+<$0.01" reads as two operators in a
  // row. Direction still comes through in the colour and the percentage.
  const magnitude = belowUnit ? `<${format(smallestUnit)}` : `${sign}${exactMagnitude}`;

  let pct = ' (new)';
  if (baseline > 0) {
    const exact = Math.abs((delta / baseline) * 100);
    // A visible dollar move whose percentage rounds to zero is "<1%", never "0%".
    pct = exact < 0.5 ? ' (<1%)' : ` (${sign}${exact.toFixed(0)}%)`;
  } else if (baseline === 0 && current === 0) {
    pct = '';
  }

  const good = betterWhen === 'up' ? up : !up;
  return `<span class="delta ${good ? 'delta-down' : 'delta-up'}">${magnitude}${esc(pct)}</span>`;
}

function compareMetricRow(label, current, baseline, format = fmt.money, betterWhen = 'down') {
  return `<tr>
      <th scope="row">${esc(label)}</th>
      <td>${format(current)}</td>
      <td>${format(baseline)}</td>
      <td>${deltaCell(current, baseline, format, betterWhen)}</td>
    </tr>`;
}

/**
 * Side-by-side view of the selected period and its baseline, plus which models
 * account for the difference.
 *
 * Both windows are always named in the column headers. The whole point of the
 * panel is that two periods are on screen at once, so a figure that doesn't say
 * which period it belongs to is worse than no figure at all.
 */
function renderComparison() {
  const panel = $('comparePanel');
  if (!panel) return;

  const modeButtons = document.querySelectorAll('.compare-mode-btn');
  modeButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.compareMode === state.trend.mode);
  });
  $('compareCustomFields')?.classList.toggle('hidden', state.trend.mode !== 'custom');

  const statusEl = $('compareStatus');
  const bodyEl = $('compareBody');
  const noteEl = $('compareNote');
  const setStatus = (text) => {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('hidden', !text);
  };

  // Nothing loaded at all: the panel would be a grid of em-dashes.
  if (!state.loaded) {
    setStatus('Load a date range to compare periods.');
    bodyEl.innerHTML = '';
    noteEl.classList.add('hidden');
    return;
  }

  if (state.trend.mode === 'custom' && !state.trend.range) {
    setStatus('Pick both ends of the period you want to compare against.');
    bodyEl.innerHTML = '';
    noteEl.classList.add('hidden');
    return;
  }

  if (state.trend.loading) {
    setStatus(`Loading ${windowLabel(state.trend.range)}…`);
    noteEl.classList.add('hidden');
    return;
  }

  if (state.trend.error) {
    setStatus(state.trend.error);
    bodyEl.innerHTML = '';
    noteEl.classList.add('hidden');
    return;
  }

  const baseline = state.trend.previous;
  const baselineEvents = state.trend.previousEvents;
  if (!baseline || !baselineEvents) {
    setStatus('No comparison loaded yet.');
    bodyEl.innerHTML = '';
    noteEl.classList.add('hidden');
    return;
  }

  setStatus('');
  const current = summarize(state.filtered);
  const currentWindow = { startMs: toMs($('startDate').value), endMs: toMs($('endDate').value, true) };
  const baseWindow = state.trend.range;

  // An empty baseline makes every delta "+100% (new)", which is noise dressed
  // as insight — say plainly that there's nothing on the other side.
  if (!baselineEvents.length) {
    bodyEl.innerHTML = `<p class="compare-empty">No requests in ${esc(windowLabel(baseWindow))}, so there's nothing to compare against.
      ${state.trend.mode === 'previous' ? 'Try a longer period, or pick a custom baseline.' : 'Pick a different baseline.'}</p>`;
    noteEl.classList.add('hidden');
    return;
  }

  const curDays = windowDays(currentWindow);
  const baseDays = windowDays(baseWindow);
  const curByModel = Object.fromEntries(costByModel(state.filtered));
  const baseByModel = Object.fromEntries(costByModel(baselineEvents));
  const deltas = modelCostDeltas(curByModel, baseByModel);

  const costNoun = costModeNoun();
  bodyEl.innerHTML = `
    <table class="compare-table">
      <thead>
        <tr>
          <th scope="col"></th>
          <th scope="col">
            <span class="compare-col-label">This period</span>
            <span class="compare-col-range">${esc(windowLabel(currentWindow))}</span>
            <span class="compare-col-days">${fmt.num(curDays)} day${curDays === 1 ? '' : 's'}</span>
          </th>
          <th scope="col">
            <span class="compare-col-label">Compared with</span>
            <span class="compare-col-range">${esc(windowLabel(baseWindow))}</span>
            <span class="compare-col-days">${fmt.num(baseDays)} day${baseDays === 1 ? '' : 's'}</span>
          </th>
          <th scope="col">Change</th>
        </tr>
      </thead>
      <tbody>
        ${compareMetricRow(`Total ${costNoun}`, current.totalCost, baseline.totalCost)}
        ${compareMetricRow('Requests', current.count, baseline.count, fmt.num)}
        ${compareMetricRow('Avg / request', current.avg ?? 0, baseline.avg ?? 0)}
        ${compareMetricRow('Avg / day', current.totalCost / curDays, baseline.totalCost / baseDays)}
        ${compareMetricRow('Cache savings', current.totalSavings, baseline.totalSavings, fmt.money, 'up')}
      </tbody>
    </table>

    <h4 class="compare-subhead">What moved, by model</h4>
    <table class="compare-table compare-models">
      <thead>
        <tr>
          <th scope="col">Model</th>
          <th scope="col">${esc(windowLabel(currentWindow))}</th>
          <th scope="col">${esc(windowLabel(baseWindow))}</th>
          <th scope="col">Change</th>
        </tr>
      </thead>
      <tbody>
        ${deltas.map((d) => `<tr>
            <th scope="row">${esc(d.model)}${d.baseline === 0 ? ' <span class="compare-tag">new</span>' : ''}${d.current === 0 ? ' <span class="compare-tag compare-tag-gone">stopped</span>' : ''}</th>
            <td>${fmt.money(d.current)}</td>
            <td>${fmt.money(d.baseline)}</td>
            <td>${deltaCell(d.current, d.baseline)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  // Two caveats that make an honest reading of the numbers possible. Both are
  // artefacts of the windows, not of the usage, and both have burned readers of
  // the ▲/▼ badge that this panel exists to explain.
  const notes = [];
  if (currentWindow.endMs > Date.now()) {
    notes.push('This period includes today, which isn\'t over yet — expect it to look lower than a comparison period of whole days.');
  }
  if (curDays !== baseDays) {
    notes.push(`The two periods aren't the same length (${fmt.num(curDays)} vs ${fmt.num(baseDays)} days) — compare "Avg / day" rather than the totals.`);
  }
  noteEl.textContent = notes.join(' ');
  noteEl.classList.toggle('hidden', !notes.length);
}

function chartDefaults() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: chartMuted(), font: { size: 11 }, boxWidth: 12 } },
      tooltip: {
        backgroundColor: chartTooltipBg(),
        titleColor: chartTooltipFg(),
        bodyColor: chartTooltipFg(),
        titleFont: { size: 12 },
        bodyFont: { size: 11 },
        padding: 10,
        cornerRadius: 8,
      },
    },
  };
}

function destroyCharts() {
  Object.values(state.charts).forEach((c) => c.destroy());
  state.charts = {};
  state.chartsReady = false;
}

function currentTrendKey() {
  const { mode, customStart, customEnd } = state.trend;
  return `${$('startDate').value}|${$('endDate').value}|${$('modelFilter').value}|${state.costMode}`
    + `|${mode}|${mode === 'custom' ? `${customStart}..${customEnd}` : ''}`;
}

function renderCharts(events) {
  destroyCharts();

  // Nothing to plot: say so instead of leaving four blank axes on screen, which
  // reads as a rendering failure rather than an empty period.
  const emptyNote = $('analyticsEmpty');
  const hasData = events.length > 0;
  emptyNote?.classList.toggle('hidden', hasData);
  ['analyticsStats', 'analyticsChartMain', 'analyticsChartRow'].forEach((id) => {
    $(id)?.classList.toggle('hidden', !hasData);
  });
  if (!hasData) return;

  const summary = summarize(events);
  const previousForThisView = state.trend.key === currentTrendKey() ? state.trend.previous : null;
  renderAnalyticsStats(events, summary, previousForThisView);

  const defaults = chartDefaults();
  const muted = chartMuted();
  const grid = chartGrid();

  const byDay = groupByDay(events);
  const days = Object.keys(byDay).sort();
  const dayLabels = days.map((d) => {
    const dt = new Date(d + 'T12:00:00');
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  });

  state.charts.cost = new Chart($('chartCost'), {
    type: 'line',
    data: {
      labels: dayLabels,
      datasets: [{
        label: costModeLabel(),
        data: days.map((d) => byDay[d]),
        borderColor: '#2563eb',
        backgroundColor: 'rgba(37,99,235,0.06)',
        fill: true,
        tension: 0.35,
        pointRadius: days.length > 14 ? 0 : 4,
        pointHoverRadius: 5,
        borderWidth: 2,
      }],
    },
    options: {
      ...defaults,
      plugins: {
        ...defaults.plugins,
        legend: { display: false },
        tooltip: {
          ...defaults.plugins.tooltip,
          callbacks: { label: (ctx) => ` ${formatChartMoney(ctx.parsed.y)}` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: muted, maxTicksLimit: 10, font: { size: 11 } } },
        y: {
          grid: { color: grid },
          ticks: { color: muted, callback: (v) => formatChartMoney(v), font: { size: 11 } },
          beginAtZero: true,
        },
      },
    },
  });

  const modelCost = topModelsWithOther(costByModel(events));
  const modelLabels = modelCost.map(([m]) => truncateLabel(m));
  const modelFull = modelCost.map(([m]) => m);

  state.charts.models = new Chart($('chartModels'), {
    type: 'bar',
    data: {
      labels: modelLabels,
      datasets: [{
        label: costModeLabel(),
        data: modelCost.map(([, v]) => v),
        backgroundColor: modelCost.map((_, i) => CHART_COLORS[i % CHART_COLORS.length]),
        borderRadius: 4,
        barThickness: 18,
      }],
    },
    options: {
      ...defaults,
      indexAxis: 'y',
      plugins: {
        ...defaults.plugins,
        legend: { display: false },
        tooltip: {
          ...defaults.plugins.tooltip,
          callbacks: {
            title: (items) => modelFull[items[0].dataIndex] || items[0].label,
            label: (ctx) => ` ${formatChartMoney(ctx.parsed.x)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: grid },
          ticks: { color: muted, callback: (v) => formatChartMoney(v), font: { size: 10 } },
          beginAtZero: true,
        },
        y: { grid: { display: false }, ticks: { color: muted, font: { size: 11 } } },
      },
    },
  });

  const tokens = tokenTotals(events);
  const tokenRows = [
    ['Cache read', tokens.cacheRead],
    ['Input', tokens.input],
    ['Output', tokens.output],
    ['Cache write', tokens.cacheWrite],
  ].filter(([, v]) => v > 0);
  const useLog = tokens.cacheRead > 0 && tokens.cacheRead / Math.max(tokens.input, tokens.output, 1) > 20;

  state.charts.tokens = new Chart($('chartTokens'), {
    type: 'bar',
    data: {
      labels: tokenRows.map(([l]) => l),
      datasets: [{
        label: 'Tokens',
        data: tokenRows.map(([, v]) => v),
        backgroundColor: ['#059669', '#2563eb', '#7c3aed', '#d97706'],
        borderRadius: 4,
        barThickness: 22,
      }],
    },
    options: {
      ...defaults,
      indexAxis: 'y',
      plugins: {
        ...defaults.plugins,
        legend: { display: false },
        tooltip: {
          ...defaults.plugins.tooltip,
          callbacks: {
            label: (ctx) => {
              const total = tokenRows.reduce((s, [, v]) => s + v, 0);
              const pct = total > 0 ? ((ctx.parsed.x / total) * 100).toFixed(1) : 0;
              return ` ${fmt.num(ctx.parsed.x)} (${pct}%)`;
            },
          },
        },
      },
      scales: {
        x: {
          type: useLog ? 'logarithmic' : 'linear',
          grid: { color: grid },
          ticks: {
            color: muted,
            callback: (v) => formatChartTokens(v),
            font: { size: 10 },
          },
          beginAtZero: !useLog,
        },
        y: { grid: { display: false }, ticks: { color: muted, font: { size: 11 } } },
      },
    },
  });

  state.chartsReady = true;
}

function populateModelFilter(events) {
  const models = [...new Set(events.map((e) => e.modelRaw))].sort();
  const prev = $('modelFilter').value;
  $('modelFilter').innerHTML = '<option value="">All models</option>'
    + models.map((m) => `<option value="${esc(m)}">${esc(displayModel(m))}</option>`).join('');
  if (models.includes(prev)) $('modelFilter').value = prev;
}

function tokenTotals(events) {
  return events.reduce(
    (acc, e) => ({
      input: acc.input + e.inputTokens,
      output: acc.output + e.outputTokens,
      cacheRead: acc.cacheRead + e.cacheReadTokens,
      cacheWrite: acc.cacheWrite + e.cacheWriteTokens,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function tip(text) {
  return `<span class="tip" tabindex="0" role="note" aria-label="${esc(text)}" data-tip="${esc(text)}">ⓘ</span>`;
}

/**
 * Gives the markup's static ⓘ markers the same accessible name their help text
 * already provides visually — without it a screen reader announces a focusable
 * "ⓘ" with no content, since the text lives in a CSS-only tooltip.
 */
function decorateTips(root = document) {
  root.querySelectorAll('.tip[data-tip]:not([aria-label])').forEach((el) => {
    el.setAttribute('role', 'note');
    el.setAttribute('aria-label', el.dataset.tip);
  });
}

const KPI_PLACEHOLDER_IDS = ['kpiRequests', 'kpiTotalCost', 'kpiSavings', 'kpiAvg'];
const KPI_SUB_IDS = ['kpiRequestsSub', 'kpiCostSub', 'kpiSavingsSub', 'kpiAvgSub'];

function renderKpis(summary) {
  // Same rule as the Overview: with no settled load behind the current filter,
  // show placeholders rather than a $0.00 that reads as a real zero.
  if (!state.loaded) {
    KPI_PLACEHOLDER_IDS.forEach((id) => { $(id).textContent = '—'; });
    KPI_SUB_IDS.forEach((id) => { $(id).innerHTML = ''; });
    $('kpiCostFees')?.classList.add('hidden');
    $('billingNotice')?.classList.add('hidden');
    return;
  }

  const isFiltered = summary.eventCount < state.all.length;

  $('kpiRequests').textContent = fmt.num(summary.count);
  const noCacheEst = summary.costMode === 'billed'
    ? summary.valueTotal + summary.totalSavings
    : summary.noCache;
  $('kpiRequestsSub').innerHTML = `Est. without cache: ${fmt.money(noCacheEst)} ${tip('What the token value would have been if every cache-read token was billed at full input-token price instead of the discounted cache-read rate. Always based on what-if pricing.')}`;
  if (summary.notCounted > 0) {
    $('kpiRequestsSub').innerHTML += `<br><span class="kpi-muted">+ ${fmt.num(summary.notCounted)} errored/aborted/no-op events not counted ${tip('The events API also returns errored or aborted generations and rows with no tokens and no charge. Cursor\'s own usage page doesn\'t count those as requests, so neither does this number. They still appear in the request log below.')}</span>`;
  }
  if (isFiltered) {
    $('kpiRequestsSub').innerHTML += `<br><span class="kpi-muted">Filtered from ${fmt.num(state.all.length)} total</span>`;
  }

  $('kpiTotalCost').textContent = fmt.money(summary.totalCost);
  const labelEl = $('kpiCostLabelText');
  let costSub;
  if (summary.costMode === 'billed') {
    if (labelEl) labelEl.textContent = 'Billed cost';
    costSub = `What-if token value: ${fmt.money(summary.valueTotal)}`;
  } else {
    if (labelEl) labelEl.textContent = isFreePlan() ? 'Token cost (what-if)' : 'Token cost';
    costSub = summary.billingMode === 'token'
      ? `Total billed (token-based plan)`
      : `Model/API token charges only`;
    if (summary.billedKnown) costSub += ` · actually billed: ${fmt.money(summary.billedTotal)}`;
  }
  costSub += ` · ${fmt.num(summary.withCost)} requests`;
  $('kpiCostSub').textContent = costSub;

  const feeEl = $('kpiCostFees');
  if (feeEl) {
    if (summary.hasUsageFees) {
      feeEl.textContent = `+ ${fmt.money(summary.totalRequestFees)} flat usage fees (separate per-request charge, not included above)`;
      feeEl.classList.remove('hidden');
    } else {
      feeEl.classList.add('hidden');
    }
  }

  $('kpiSavings').textContent = fmt.money(summary.totalSavings);
  const savingsPct = noCacheEst > 0 ? (summary.totalSavings / noCacheEst) * 100 : null;
  $('kpiSavingsSub').innerHTML = savingsPct != null
    ? `${fmt.pct(savingsPct)} of est. cost without cache ${tip('Share of the no-cache estimate that cache discounted reads saved you.')}`
    : '—';

  $('kpiAvg').textContent = fmt.money(summary.avg);
  $('kpiAvgSub').textContent = summary.avgNoCache != null
    ? `Avg without cache: ${fmt.money(summary.avgNoCache)}`
    : '—';

  const billingEl = $('billingNotice');
  if (billingEl && state.appView !== 'usage') {
    billingEl.classList.add('hidden');
  } else if (billingEl) {
    const messages = {
      usage: 'Your plan bills a flat <strong>usage fee per request</strong> (often $0.04) separately from <strong>token cost</strong>. Token cost is what drives optimization.',
      token: 'Your plan uses <strong>token-based billing</strong>. The Cost column shows <code>chargedCents</code> from Cursor — the full amount billed per request (model + fees).',
      mixed: 'This date range spans a <strong>plan change</strong>: older requests use usage-based fees ($0.04/request + token cost), newer ones use token-based billing. Each row is labeled automatically.',
      unknown: 'Cost data is shown per request. Check the Cost column and token breakdown for details.',
    };
    const planNote = isFreePlan()
      ? `You're on the <strong>${esc(planLabel() || 'Free plan')}</strong> — requests are <strong>not actually billed</strong>; costs shown in What-if mode are the API-equivalent value of your tokens. `
      : (planLabel() ? `Plan: <strong>${esc(planLabel())}</strong>. ` : '');
    // The full reconciliation belongs here rather than in a stat card: this
    // banner is full width, and it's the same place the plan-change and
    // billing-mode explanations already live.
    const planChange = planChangeNote(summary);
    const planChangeHtml = planChange ? ` <strong>${esc(planChange)}</strong>` : '';
    billingEl.innerHTML = `${planNote}${messages[summary.billingMode] || messages.unknown}${planChangeHtml} Cache savings use each request's model pricing from <a href="https://cursor.com/docs/models-and-pricing">Cursor docs</a> (Auto requests use Auto rates). Compare with the <a href="https://cursor.com/dashboard/usage">official dashboard</a>.`;
    billingEl.classList.remove('hidden');
  }
}

function renderTable(events, summary) {
  const { rows, totalPages, start, end } = pageSlice(events);
  const costs = events.map((e) => e.cost).filter((c) => c != null);
  const p75 = percentile(costs, 0.75);
  const showUsageFee = summary.hasUsageFees;

  $('colUsageFee').classList.toggle('hidden', !showUsageFee);
  document.querySelectorAll('th#colUsageFee, td.usage-fee').forEach((el) => {
    el.classList.toggle('hidden', !showUsageFee);
  });

  $('tableBody').innerHTML = rows.map((e) => {
    const expensive = e.cost != null && e.cost >= (p75 || 0.25);
    const savingsTitle = e.pricingLabel
      ? ` title="Used ${esc(e.pricingLabel)} pricing: cache-read × (input − cache-read rate)"`
      : (e.cacheReadTokens > 0 ? ' title="No matching model pricing — savings unavailable"' : '');
    return `<tr class="${expensive ? 'expensive' : ''}">
      <td>${fmt.date(e.timestampMs)}</td>
      <td>${esc(e.model)}</td>
      <td class="cost">${fmt.money(e.cost)}</td>
      <td class="usage-fee${showUsageFee ? '' : ' hidden'}">${e.requestCharge != null ? fmt.money(e.requestCharge) : '—'}</td>
      <td class="savings"${savingsTitle}>${e.cacheSavings != null ? fmt.money(e.cacheSavings) : '—'}</td>
      <td class="tokens">${fmt.num(e.inputTokens)}</td>
      <td class="tokens">${fmt.num(e.outputTokens)}</td>
      <td class="tokens">${fmt.num(e.cacheReadTokens)}</td>
      <td class="tokens">${fmt.num(e.cacheWriteTokens)}</td>
      <td class="tokens">${fmt.num(e.totalTokens)}</td>
      <td><button type="button" class="btn-link btn-compare" data-id="${esc(e.id)}">Compare</button></td>
    </tr>`;
  }).join('');

  const pageCost = sumRows(rows.filter((e) => e.cost != null), 'cost');
  const pageFees = sumRows(rows.filter((e) => e.requestCharge != null), 'requestCharge');
  const pageSavings = sumRows(rows.filter((e) => e.cacheSavings != null), 'cacheSavings');
  const feeCol = `<td class="usage-fee${showUsageFee ? '' : ' hidden'}">${fmt.money(pageFees)}</td>`;
  $('tableFoot').innerHTML = `<tr>
    <td colspan="2">Page subtotal (${rows.length} rows)</td>
    <td class="cost">${fmt.money(pageCost)}</td>
    ${feeCol}
    <td class="savings">${fmt.money(pageSavings)}</td>
    <td colspan="6" style="text-align:right;color:var(--muted)">
      Grand total: ${fmt.num(summary.count)} requests${summary.notCounted > 0 ? ` (${fmt.num(summary.eventCount)} events)` : ''} · ${fmt.money(summary.totalCost)} ${esc(costModeNoun())}
      ${summary.hasUsageFees ? ` · ${fmt.money(summary.totalRequestFees)} usage fees` : ''}
    </td>
  </tr>`;

  $('pageInfo').textContent = events.length
    ? `Showing ${start + 1}–${end} of ${fmt.num(events.length)}`
    : 'No rows';
  $('prevPage').disabled = state.page <= 1;
  $('nextPage').disabled = state.page >= totalPages;

  // Scoped to this table — an unscoped selector also stripped the simulator
  // compare table's sort indicator every time the request log re-rendered.
  document.querySelectorAll('#requestsTable th[data-sort]').forEach((th) => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    const sorted = th.dataset.sort === state.sortKey;
    if (sorted) {
      th.classList.add(state.sortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
    th.setAttribute('aria-sort', sorted ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
  });
}

function setPanel(panel) {
  state.panel = panel;
  document.querySelectorAll(VIEW_TAB_SELECTOR).forEach((tab) => {
    const active = tab.dataset.panel === panel;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  $('panelRequests').classList.toggle('hidden', panel !== 'requests');
  $('panelAnalytics').classList.toggle('hidden', panel !== 'analytics');

  // Rendered even with nothing loaded — renderCharts() puts up its own empty
  // note, and skipping it here used to leave the previous range's charts (or a
  // blank grid) on screen after switching tabs.
  if (panel === 'analytics') renderCharts(state.filtered);
}

/** Findings vs. period comparison, the two views on the Analyze tab. */
function setAnalyzePanel(panel) {
  state.analyzePanel = panel;
  document.querySelectorAll(ANALYZE_TAB_SELECTOR).forEach((tab) => {
    const active = tab.dataset.analyzePanel === panel;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  // One place decides which of the three boxes (empty note, findings,
  // comparison) is visible, so a sub-tab switch can't leave two of them up.
  renderAnalyze();
}

/** The baseline window for the current selection, or null if it can't be resolved. */
function currentBaselineWindow() {
  const startStr = $('startDate').value;
  const endStr = $('endDate').value;
  if (!startStr || !endStr) return null;
  return comparisonWindow({
    startMs: toMs(startStr),
    endMs: toMs(endStr, true),
    mode: state.trend.mode,
    customStartMs: state.trend.customStart ? toMs(state.trend.customStart) : null,
    customEndMs: state.trend.customEnd ? toMs(state.trend.customEnd, true) : null,
  });
}

/**
 * Fetches the baseline period (same model filter + cost mode) so Analytics can
 * show "▲12% vs prior period" badges and the model-by-model breakdown of what
 * changed. Cached per range/baseline/filter/cost-mode combo; re-renders only
 * the stats row and the comparison panel when it lands, so the charts above
 * never flicker or reflow.
 */
async function loadTrendComparison() {
  const startStr = $('startDate').value;
  const endStr = $('endDate').value;
  if (!startStr || !endStr || !state.pricing) return;

  const modelVal = $('modelFilter').value;
  const key = currentTrendKey();
  if (state.trend.key === key) return;
  state.trend.key = key;
  // The baseline belongs to the range that was loaded before this one. Keeping
  // it while the new one is in flight would compare this period against a
  // different period's total and label it "vs prior period".
  state.trend.previous = null;
  state.trend.previousEvents = null;
  state.trend.error = null;

  const window = currentBaselineWindow();
  state.trend.range = window;
  if (!window) {
    // Custom baseline with a half-filled picker: prompt for the missing end
    // rather than silently comparing against something the user didn't choose.
    state.trend.loading = false;
    renderComparison();
    return;
  }

  state.trend.loading = true;
  renderComparison();

  try {
    const usage = await rpc('usage', { startDate: window.startMs, endDate: window.endMs });
    if (state.trend.key !== key) return; // superseded by a newer request
    const normOpts = { freePlan: isFreePlan() };
    let events = (usage.events || []).map((raw) => normalize(raw, state.pricing, normOpts));
    if (modelVal) events = events.filter((e) => e.modelRaw === modelVal);
    events = applyCostMode(events);
    state.trend.previousEvents = events;
    state.trend.previous = summarize(events);
  } catch (e) {
    if (state.trend.key !== key) return;
    state.trend.previous = null;
    state.trend.previousEvents = null;
    state.trend.error = e?.message || 'Could not load the comparison period.';
  }

  if (state.trend.key !== key) return;
  state.trend.loading = false;
  if (state.panel === 'analytics' && state.appView === 'usage') {
    renderAnalyticsStats(state.filtered, summarize(state.filtered), state.trend.previous);
  }
  if (state.appView === 'analyze') renderComparison();
  if (state.appView === 'overview') {
    // Rebuilt through the same helper renderOverview() uses: writing the badge
    // on its own here dropped the plan-change reconciliation note that shares
    // this line, so the explanation for a figure cursor.com prices differently
    // vanished a second after it appeared.
    $('ovCostSub').innerHTML = overviewCostSubHtml(summarize(state.filtered));
  }
}

/** The Overview cost card's sub-line: trend badge plus any plan-change note. */
function overviewCostSubHtml(summary) {
  const trend = state.trend.key === currentTrendKey() && state.trend.previous
    ? trendBadge(summary.totalCost, state.trend.previous.totalCost)
    : '';
  const planChange = planChangeNote(summary, { short: true });
  return planChange ? `${trend}<span class="ov-stat-note">${esc(planChange)}</span>` : trend;
}

function refresh() {
  const baseEvents = applyFilters(state.all);
  state.filtered = sortEvents(applyCostMode(baseEvents));
  const summary = summarize(state.filtered);
  summary.costMode = state.costMode;
  summary.valueTotal = baseEvents.reduce((s, e) => s + (e.valueCost ?? 0), 0);
  summary.billedTotal = baseEvents.reduce((s, e) => s + (e.billedCost ?? 0), 0);
  summary.billedKnown = baseEvents.some((e) => e.billedCost != null);
  updateFilterSummary();
  renderKpis(summary);

  if (state.panel === 'requests') {
    renderTable(state.filtered, summary);
  } else {
    renderCharts(state.filtered);
  }

  if (state.appView === 'simulator' && state.simMode === 'request') {
    populateSimRequestPicker(state.simRequestId);
    runCompareFromRequest();
  }

  if (state.appView === 'analyze') {
    renderAnalyze();
  }

  if (state.appView === 'overview') {
    renderOverview();
  }
}

/** Highest-severity finding worth surfacing on the simple Overview screen. */
function pickTopFinding(findings) {
  if (!findings?.length) return null;
  return findings.find((f) => f.severity === 'high')
    || findings.find((f) => f.severity === 'medium')
    || findings[0];
}

let ovSparklineChart = null;

function destroyOvSparkline() {
  if (ovSparklineChart) {
    ovSparklineChart.destroy();
    ovSparklineChart = null;
  }
}

function renderOvSparkline(events) {
  const box = $('ovSparklineEmpty');
  const canvas = $('ovSparkline');
  if (!canvas) return;

  const byDay = groupByDay(events);
  const days = Object.keys(byDay).sort();
  destroyOvSparkline();

  if (!days.length) {
    canvas.classList.add('hidden');
    box?.classList.remove('hidden');
    return;
  }
  canvas.classList.remove('hidden');
  box?.classList.add('hidden');

  const labels = days.map((d) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  const values = days.map((d) => byDay[d]);
  const accent = themeColor('--vscode-textLink-foreground', '#2563eb');

  ovSparklineChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: accent,
        backgroundColor: `color-mix(in srgb, ${accent} 12%, transparent)`,
        fill: true,
        tension: 0.35,
        borderWidth: 2,
        pointRadius: (ctx) => (ctx.dataIndex === values.length - 1 ? 4 : 0),
        pointHoverRadius: 5,
        pointBackgroundColor: accent,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: chartTooltipBg(),
          titleColor: chartTooltipFg(),
          bodyColor: chartTooltipFg(),
          padding: 8,
          cornerRadius: 8,
          callbacks: { label: (ctx) => ` ${formatChartMoney(ctx.parsed.y)}` },
        },
      },
      scales: {
        x: { display: false },
        y: { display: false, beginAtZero: true },
      },
    },
  });
}

/**
 * Renders the simple Overview screen from data already loaded for the
 * Requests tab (state.filtered/state.all) — no separate fetch. Handles the
 * zero-events and not-signed-in cases gracefully rather than assuming data
 * is present.
 */
function renderOverview() {
  if (!$('overviewView')) return;

  // No settled load behind the current filter (first paint, or a failed
  // fetch). Show placeholders, never numbers: a $0.00 here reads as a real
  // zero for the selected period, and leftover values read as if they were
  // this period's.
  if (!state.loaded) {
    $('ovCost').textContent = '—';
    $('ovCostSub').innerHTML = '';
    $('ovRequests').textContent = '—';
    $('ovRequestsSub').textContent = '';
    $('ovSavings').textContent = '—';
    $('ovSavingsSub').textContent = '';
    $('ovTrendRange').textContent = '';
    // The canned empty-state text ("No requests in this period yet") would be a
    // claim about data we never got — say nothing about the period instead.
    $('ovSparklineEmpty').textContent = 'No usage data loaded.';
    renderOvSparkline([]);
    $('ovInsightPanel').classList.add('hidden');
    return;
  }
  $('ovSparklineEmpty').textContent = 'No requests in this period yet.';

  const events = state.filtered;
  const summary = summarize(events);

  const freePlan = isFreePlan();
  const showWhatIfPrefix = state.costMode === 'value' && freePlan;
  $('ovCostLabel').textContent = costModeLabel();
  $('ovCost').textContent = `${showWhatIfPrefix ? '~' : ''}${fmt.money(summary.totalCost)}`;
  $('ovCostSub').innerHTML = overviewCostSubHtml(summary);

  $('ovRequests').textContent = fmt.num(summary.count);
  $('ovRequestsSub').textContent = summary.count
    ? `${fmt.num(summary.withCostCounted)} with cost data${summary.notCounted > 0 ? ` · ${fmt.num(summary.notCounted)} errored/aborted not counted` : ''}`
    : 'No requests in this period';

  $('ovSavings').textContent = fmt.money(summary.totalSavings);
  // Cache savings are always a what-if estimate (tokens × published rates), so
  // the "share of cost without cache" they're compared against has to be the
  // what-if baseline too. In Billed mode summary.noCache is built from billed
  // dollars, which on a plan that bills nothing per request made this read
  // "100% of cost without cache" — or vanish entirely at $0 billed.
  const noCacheValue = events.reduce((s, e) => s + (e.valueCost ?? 0), 0) + summary.totalSavings;
  const savingsPct = noCacheValue > 0 ? (summary.totalSavings / noCacheValue) * 100 : null;
  $('ovSavingsSub').textContent = savingsPct != null ? `${fmt.pct(savingsPct)} of est. cost without cache` : '';

  const rangeLabel = `${fmt.shortDate($('startDate').value)} – ${fmt.shortDate($('endDate').value)}`;
  $('ovTrendRange').textContent = rangeLabel;
  renderOvSparkline(events);

  const insightPanel = $('ovInsightPanel');
  if (events.length) {
    const data = computeAnalyzeData(events, summary);
    const top = pickTopFinding(data.findings);
    if (top) {
      insightPanel.classList.remove('hidden');
      $('ovInsightCard').className = `finding-card ov-insight-card severity-${top.severity}`;
      $('ovInsightCard').innerHTML = `
        <h4>${esc(top.title)}</h4>
        <p>${esc(top.body)}</p>
        <span class="finding-action">→ ${esc(top.action)}</span>`;
    } else {
      insightPanel.classList.add('hidden');
    }
  } else {
    insightPanel.classList.add('hidden');
  }

  void loadTrendComparison();
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/**
 * Sequence number of the most recently started load.
 *
 * Every load reads the date inputs when it starts and renders when it ends, so
 * two in flight at once (a fast one started after a slow one — clicking Refresh
 * twice, or editing both date fields) would render in completion order: the
 * slow, older range would land last and sit under the toolbar showing the newer
 * one. A load that is no longer the latest throws its result away instead.
 */
let loadSeq = 0;

async function load() {
  const start = toMs($('startDate').value);
  const end = toMs($('endDate').value, true);
  if (!start || !end) {
    showAlert('error', 'Pick a valid date range.');
    return;
  }
  if (start > end) {
    showAlert('error', 'The "From" date is after the "To" date — pick a valid range.');
    return;
  }

  const seq = ++loadSeq;
  updateFilterSummary();
  setBusy(true);

  try {
    const [usage, pricingData, budget] = await Promise.all([
      rpc('usage', { startDate: start, endDate: end }),
      rpc('pricing').catch(() => ({ markdown: '' })),
      // Budget spend is always the current cycle, never the selected range —
      // a projection built from "Today" would be meaningless. Non-fatal: the
      // rest of the dashboard works without it.
      rpc('budget').catch(() => null),
    ]);
    if (seq !== loadSeq) return;
    state.budget = budget;

    state.pricing = parsePricing(pricingData.markdown || '');
    state.plan = usage.plan || null;
    const normOpts = { freePlan: isFreePlan() };
    const normalized = (usage.events || []).map((raw) => normalize(raw, state.pricing, normOpts));
    state.all = filterByRange(normalized, start, end);
    // Not signed in is not "zero usage" — keep the placeholders in that case.
    state.loaded = usage.authMode !== 'none';
    state.page = 1;
    destroyCharts();
    renderPlanCycle(usage.quota, usage.hardLimit);
    // Must run before refresh(): applyFilters() reads the model select, and a
    // model that only existed in the previous range has to be gone from it
    // before the new events are filtered.
    populateModelFilter(state.all);
    populateSimulatorModels();

    // The request picker reads state.filtered, which only refresh() updates —
    // so it has to come after, or it lists the previous range's requests.
    const switchedToPlanRange = applyPlanChangeDiscovery();
    if (switchedToPlanRange) return; // load() re-entered with the narrower range

    const render = () => {
      refresh();
      populateSimRequestPicker(state.simRequestId);
    };

    if (usage.authMode === 'none') {
      showAlert('warn', `${takePendingNotice()}Not signed in. Open Cursor while logged into your account, or run "Cursor Usage: Set Session Token Manually" from the command palette.`);
      render();
      return;
    }

    if (!state.all.length) {
      showAlert('warn', `${takePendingNotice()}No usage events in this date range.`);
      render();
      return;
    }

    if (usage.email || planLabel()) {
      $('authLabel').textContent = [usage.email ? `Signed in as ${usage.email}` : null, planLabel()]
        .filter(Boolean).join(' — ');
    }
    const fallbackNote = state.pricing.fallback
      ? ' Using bundled fallback pricing (couldn\'t reach cursor.com\'s pricing page) — cost estimates may be slightly out of date.'
      : '';
    const countedAll = state.all.filter((e) => e.counted !== false).length;
    const plural = (n, word) => `${fmt.num(n)} ${word}${n === 1 ? '' : 's'}`;
    const loadedLabel = countedAll < state.all.length
      ? `Loaded ${plural(countedAll, 'request')} (${plural(state.all.length, 'event')} incl. errored/aborted)`
      : `Loaded ${plural(state.all.length, 'request')}`;
    const notice = takePendingNotice();
    // The one-time auto-switch notice announces the change on its own; every
    // other visit to a range that straddles it needs the same warning, or the
    // totals silently mix two pricing systems (the "Month to date" case).
    const spanNote = notice ? '' : planChangeSpanNote();
    showAlert(
      spanNote ? 'warn' : 'info',
      `${notice}${loadedLabel}${usage.email ? ` for ${usage.email}` : ''}${planLabel() ? ` (${planLabel()})` : ''}.${spanNote}${fallbackNote}`,
    );
    // refresh() already re-renders the overview and analyze views.
    render();
    if (state.appView === 'simulator') refreshSimulator();
  } catch (err) {
    if (seq !== loadSeq) return;
    // Drop whatever was loaded before: it belongs to a different (older)
    // query, and leaving it on screen under the new filter reads as if the
    // numbers were for the range now shown in the toolbar.
    state.all = [];
    state.loaded = false;
    destroyCharts();
    refresh();
    populateSimRequestPicker(null);
    showAlert('error', err.authError
      ? `${err.message} — your Cursor session may have expired. Re-open Cursor logged in, or run "Cursor Usage: Set Session Token Manually".`
      : err.message);
  } finally {
    // A superseded load must not clear the busy state: the load that replaced
    // it is still running, and its own finally will do this.
    if (seq === loadSeq) setBusy(false);
  }
}

/**
 * RFC 4180 field: quote anything containing a delimiter, quote or newline, and
 * double any embedded quotes. Model names and kinds come from cursor.com, so a
 * value with a comma in it would otherwise shift every later column of that row.
 */
function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportCsv() {
  if (!state.filtered.length) {
    showAlert('warn', 'Nothing to export — no requests in the current filter.');
    return;
  }
  // meteredCost/billingRegime are appended, not inserted: existing columns keep
  // their positions for anything already parsing this file. They're what makes
  // a row-by-row reconciliation against cursor.com's usage export possible.
  const headers = ['time', 'model', 'modelRaw', 'whatIfCost', 'billedCost', 'usageFee', 'cacheSavings', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'meteredCost', 'billingRegime'];
  const rows = state.filtered.map((e) => [
    // Rows the API sent without a usable timestamp are left blank rather than
    // stamped 1970-01-01, which would read as a real (and very old) date.
    e.timestampMs ? new Date(e.timestampMs).toISOString() : '',
    e.model,
    e.modelRaw,
    e.valueCost ?? '',
    e.billedCost ?? '',
    e.requestCharge ?? '',
    e.cacheSavings ?? '',
    e.inputTokens,
    e.outputTokens,
    e.cacheReadTokens,
    e.cacheWriteTokens,
    e.totalTokens,
    e.planMeteredCost ?? '',
    e.billingRegime,
  ]);
  const csv = [headers.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n');
  const filename = `cursor-usage-${$('startDate').value}-${$('endDate').value}.csv`;
  rpc('exportCsv', { csv, filename }).catch((e) => showAlert('error', `Export failed: ${e.message}`));
}

// ---------------------------------------------------------------------------
// Analyze — insights + Cursor Chat brief
// ---------------------------------------------------------------------------

const ANALYZE_THRESHOLD_FIELDS = [
  { key: 'modelDominancePct', label: 'Model dominates spend at', suffix: '% of cost', min: 1, max: 100 },
  { key: 'cacheHitWarnPct', label: 'Warn on cache hit rate below', suffix: '%', min: 0, max: 100 },
  { key: 'coldStartInputTokens', label: 'Cold start: input tokens above', suffix: 'tokens', min: 0, max: 1000000 },
  { key: 'coldStartCount', label: 'Cold start: flag when more than', suffix: 'requests', min: 0, max: 10000 },
  { key: 'heavyOutputTokens', label: 'Heavy output: output tokens above', suffix: 'tokens', min: 0, max: 1000000 },
  { key: 'heavyOutputCount', label: 'Heavy output: flag when more than', suffix: 'requests', min: 0, max: 10000 },
];

const ANALYZE_SCOPES = [
  { id: 'summary', label: 'Period summary', hint: 'KPIs, billing mode, date range' },
  { id: 'modelBreakdown', label: 'Spend by model', hint: 'Cost, request count, avg per model' },
  { id: 'cacheStats', label: 'Cache health', hint: 'Hit rate, cold starts, savings' },
  { id: 'tokenMix', label: 'Token mix', hint: 'Input / output / cache proportions' },
  { id: 'topRequests', label: 'Top 10 expensive requests', hint: 'Date, model, tokens, cost' },
  { id: 'dailyTrend', label: 'Daily spend trend', hint: 'One row per day, not per request' },
  { id: 'findings', label: 'Dashboard findings', hint: 'Pre-computed recommendations from this tab' },
];

const ANALYZE_TEMPLATES = [
  {
    id: 'overview',
    title: 'Overall spend review',
    desc: 'Main drivers and what to do next',
    prompt: 'Review my Cursor usage for this period. Summarize the main cost drivers, flag anything unusual, and give me 3–5 prioritized actions to optimize spend without hurting productivity.',
    scopes: ['summary', 'modelBreakdown', 'topRequests', 'findings', 'dailyTrend'],
  },
  {
    id: 'reduce-cost',
    title: 'Cut costs',
    desc: 'Expensive requests and quick wins',
    prompt: 'Help me reduce Cursor token spend. Focus on my most expensive requests and patterns. Suggest concrete changes (model choice, cache habits, prompt size) ranked by impact vs effort.',
    scopes: ['summary', 'topRequests', 'cacheStats', 'findings'],
  },
  {
    id: 'auto-vs-named',
    title: 'Auto vs named models',
    desc: 'When to stay on Auto vs pick a model',
    prompt: 'I mostly use Auto. Based on this usage data, explain when Auto is worth it vs when I should pin a cheaper or more capable named model. Be specific to my request patterns — not generic advice.',
    scopes: ['summary', 'modelBreakdown', 'topRequests', 'tokenMix'],
  },
  {
    id: 'cache',
    title: 'Improve cache usage',
    desc: 'Reuse context, avoid cold starts',
    prompt: 'Analyze my cache read/write patterns and cold-start behavior. How much am I leaving on the table? Give practical habits to increase cache hits in Cursor agent sessions.',
    scopes: ['summary', 'cacheStats', 'topRequests', 'findings'],
  },
  {
    id: 'custom',
    title: 'Custom question',
    desc: 'You write the question',
    prompt: 'Answer my question using only the usage data provided below. If something is not in the data, say so — do not invent numbers.',
    scopes: ['summary', 'modelBreakdown', 'cacheStats', 'topRequests', 'findings'],
  },
];

function loadAnalyzePrefs() {
  try {
    const raw = storage.getItem(ANALYZE_PREFS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveAnalyzePrefs() {
  try {
    storage.setItem(ANALYZE_PREFS_KEY, JSON.stringify({
      templateId: state.analyzeTemplateId,
      scopes: getSelectedAnalyzeScopes(),
      thresholds: state.analyzeThresholds,
    }));
  } catch {
    // ignore
  }
}

function getSelectedAnalyzeScopes() {
  return [...document.querySelectorAll('#analyzeScopes input:checked')].map((el) => el.value);
}

function applyTemplateScopes(templateId) {
  const tpl = ANALYZE_TEMPLATES.find((t) => t.id === templateId);
  if (!tpl) return;
  document.querySelectorAll('#analyzeScopes input').forEach((el) => {
    el.checked = tpl.scopes.includes(el.value);
  });
}

function computeAnalyzeData(events, summary, thresholds = state.analyzeThresholds) {
  const byModel = {};
  const byModelCount = {};
  for (const e of events) {
    byModel[e.model] = (byModel[e.model] || 0) + (e.cost ?? 0);
    byModelCount[e.model] = (byModelCount[e.model] || 0) + 1;
  }
  const modelRows = Object.entries(byModel)
    .map(([model, cost]) => ({
      model,
      cost,
      count: byModelCount[model],
      pct: summary.totalCost > 0 ? (cost / summary.totalCost) * 100 : 0,
      avg: byModelCount[model] ? cost / byModelCount[model] : 0,
    }))
    .sort((a, b) => b.cost - a.cost);

  const tokens = tokenTotals(events);
  const totalTok = tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite;
  const withCache = events.filter((e) => e.cacheReadTokens > 0);
  const coldStarts = events.filter((e) => e.cacheReadTokens === 0 && e.inputTokens > thresholds.coldStartInputTokens);
  const highOutput = events.filter((e) => e.outputTokens > thresholds.heavyOutputTokens);
  const expensive = [...events].filter((e) => e.cost != null).sort((a, b) => b.cost - a.cost).slice(0, 10);
  const costs = events.map((e) => e.cost).filter((c) => c != null);
  const p75 = percentile(costs, 0.75) ?? 0;
  const dailyRows = Object.entries(groupByDay(events)).sort(([a], [b]) => a.localeCompare(b));
  const autoRow = modelRows.find((r) => r.model === 'Auto');
  const autoPct = summary.totalCost > 0 && autoRow ? (autoRow.cost / summary.totalCost) * 100 : 0;

  const cacheHitRate = events.length ? (withCache.length / events.length) * 100 : 0;
  const avgCacheRead = events.length
    ? events.reduce((s, e) => s + e.cacheReadTokens, 0) / events.length
    : 0;

  const findings = buildAnalyzeFindings(events, summary, {
    modelRows, tokens, totalTok, withCache, coldStarts, highOutput, expensive, autoPct, cacheHitRate, p75,
  }, thresholds);

  return {
    summary,
    modelRows,
    tokens,
    totalTok,
    cache: { withCache: withCache.length, coldStarts: coldStarts.length, cacheHitRate, avgCacheRead, totalSavings: summary.totalSavings },
    expensive,
    dailyRows,
    findings,
    p75,
  };
}

function buildAnalyzeFindings(events, summary, ctx, thresholds = state.analyzeThresholds) {
  const findings = [];
  const top = ctx.modelRows[0];

  if (top && summary.totalCost > 0 && top.pct >= thresholds.modelDominancePct) {
    findings.push({
      severity: 'high',
      title: `${top.model} dominates spend`,
      body: `${fmt.pct(top.pct)} of ${costModeNoun()} (${fmt.money(top.cost)} across ${fmt.num(top.count)} requests).`,
      action: top.model === 'Auto'
        ? 'Review expensive Auto requests — pin a cheaper model for simple edits.'
        : `Try Auto or a lighter model for routine tasks instead of ${top.model}.`,
    });
  }

  if (summary.totalSavings > 0 && summary.noCache > 0) {
    const pct = (summary.totalSavings / summary.noCache) * 100;
    findings.push({
      severity: 'positive',
      title: 'Cache is working',
      body: `Estimated ${fmt.money(summary.totalSavings)} saved (${fmt.pct(pct)} of no-cache cost).`,
      action: 'Keep long agent threads open — restarting chats loses cached context.',
    });
  } else if (ctx.cacheHitRate < thresholds.cacheHitWarnPct && events.length > 10) {
    findings.push({
      severity: 'medium',
      title: 'Low cache hit rate',
      body: `Only ${fmt.pct(ctx.cacheHitRate)} of requests used cache reads.`,
      action: 'Avoid new chats mid-task; let the agent reuse the same conversation.',
    });
  }

  if (ctx.coldStarts.length > thresholds.coldStartCount) {
    findings.push({
      severity: 'medium',
      title: `${ctx.coldStarts.length} cold starts`,
      body: 'Large fresh input with no cache reads — you paid full input price.',
      action: 'Continue existing threads instead of opening new ones for related work.',
    });
  }

  if (ctx.highOutput.length > thresholds.heavyOutputCount) {
    findings.push({
      severity: 'medium',
      title: 'Heavy output requests',
      body: `${ctx.highOutput.length} requests exceeded 2k output tokens.`,
      action: 'Ask for focused diffs or smaller scopes; output tokens often cost more than input.',
    });
  }

  if (ctx.expensive.length && ctx.p75 > 0) {
    const topReq = ctx.expensive[0];
    findings.push({
      severity: 'high',
      title: 'Spike requests add up',
      body: `Top request: ${fmt.money(topReq.cost)} on ${fmt.date(topReq.timestampMs)} (${fmt.num(topReq.totalTokens)} tokens).`,
      action: 'Use Simulator → Compare on expensive rows to see if a cheaper model fits.',
    });
  }

  if (summary.hasUsageFees && summary.totalRequestFees > 0) {
    findings.push({
      severity: 'medium',
      title: 'Flat usage fees separate from tokens',
      body: `${fmt.money(summary.totalRequestFees)} in per-request fees on top of ${fmt.money(summary.totalCost)} ${costModeNoun()}.`,
      action: 'Fewer, larger agent turns can reduce fee overhead on usage-based plans.',
    });
  }

  if (!findings.length) {
    findings.push({
      severity: 'positive',
      title: 'Usage looks balanced',
      body: 'No major red flags in this filtered view.',
      action: 'Try a narrower date range or model filter to drill into specifics.',
    });
  }

  return findings;
}

function renderAnalyzeHero(data, events) {
  const { summary } = data;
  const topModel = data.modelRows[0];
  const headline = topModel
    ? `Most spend on <strong>${esc(topModel.model)}</strong> (${fmt.pct(topModel.pct)})`
    : 'Usage overview';

  $('analyzeHero').innerHTML = `
    <h2>${headline}</h2>
    <p>${fmt.num(summary.count)} requests · ${fmt.money(summary.totalCost)} ${esc(costModeNoun())}${summary.hasUsageFees ? ` · ${fmt.money(summary.totalRequestFees)} usage fees` : ''}</p>
    <div class="analyze-hero-stats">
      <div class="analyze-hero-stat"><span>Avg / request</span><strong>${fmt.money(summary.avg)}</strong></div>
      <div class="analyze-hero-stat"><span>Cache saved</span><strong>${fmt.money(summary.totalSavings)}</strong></div>
      <div class="analyze-hero-stat"><span>Cache hit rate</span><strong>${fmt.pct(data.cache.cacheHitRate)}</strong></div>
      <div class="analyze-hero-stat"><span>Models used</span><strong>${fmt.num(data.modelRows.length)}</strong></div>
    </div>`;
}

function renderAnalyzeFindings(findings) {
  $('analyzeFindings').innerHTML = findings.map((f) => `
    <article class="finding-card severity-${f.severity}">
      <h4>${esc(f.title)}</h4>
      <p>${esc(f.body)}</p>
      <span class="finding-action">→ ${esc(f.action)}</span>
    </article>`).join('');
}

function renderAnalyzeModelPanel(modelRows, totalCost) {
  const rows = modelRows.slice(0, 8).map((r) => `
    <tr>
      <td>${esc(r.model)}</td>
      <td class="num">${fmt.money(r.cost)}</td>
      <td class="num">${fmt.num(r.count)}</td>
      <td class="num">${fmt.money(r.avg)}</td>
      <td>
        <div class="bar-cell">
          <div class="bar-track"><div class="bar-fill" style="width:${Math.min(r.pct, 100)}%"></div></div>
          <span class="num">${fmt.pct(r.pct)}</span>
        </div>
      </td>
    </tr>`).join('');

  $('analyzeModelPanel').innerHTML = `
    <h3>Spend by model</h3>
    <p class="panel-desc">${fmt.money(totalCost)} total ${esc(costModeNoun())} in this view</p>
    <table class="analyze-table">
      <thead><tr><th>Model</th><th class="num">Cost</th><th class="num">Reqs</th><th class="num">Avg</th><th>Share</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No data</td></tr>'}</tbody>
    </table>`;
}

function renderAnalyzeCachePanel(data) {
  const { cache, tokens, totalTok } = data;
  const pct = (n) => (totalTok > 0 ? fmt.pct((n / totalTok) * 100) : '—');

  $('analyzeCachePanel').innerHTML = `
    <h3>Cache & tokens</h3>
    <p class="panel-desc">How context reuse affects cost</p>
    <div class="cache-stat-grid">
      <div class="cache-stat"><span>Requests with cache reads</span><strong>${fmt.num(cache.withCache)} (${fmt.pct(cache.cacheHitRate)})</strong></div>
      <div class="cache-stat"><span>Cold starts (&gt;${fmt.num(state.analyzeThresholds.coldStartInputTokens)} input, no cache)</span><strong>${fmt.num(cache.coldStarts)}</strong></div>
      <div class="cache-stat"><span>Est. cache savings</span><strong>${fmt.money(cache.totalSavings)}</strong></div>
      <div class="cache-stat"><span>Avg cache read / request</span><strong>${fmt.num(Math.round(cache.avgCacheRead))}</strong></div>
      <div class="cache-stat"><span>Cache read tokens</span><strong>${fmt.num(tokens.cacheRead)} (${pct(tokens.cacheRead)})</strong></div>
      <div class="cache-stat"><span>Output tokens</span><strong>${fmt.num(tokens.output)} (${pct(tokens.output)})</strong></div>
    </div>`;
}

function renderAnalyzeExpensivePanel(expensive) {
  const rows = expensive.map((e) => `
    <tr>
      <td>${fmt.date(e.timestampMs)}</td>
      <td>${esc(e.model)}</td>
      <td class="num">${fmt.money(e.cost)}</td>
      <td class="num">${fmt.num(e.cacheReadTokens)}</td>
      <td class="num">${fmt.num(e.totalTokens)}</td>
      <td><button type="button" class="btn-link btn-compare" data-id="${esc(e.id)}">Compare</button></td>
    </tr>`).join('');

  $('analyzeExpensivePanel').innerHTML = `
    <h3>Most expensive requests</h3>
    <p class="panel-desc">Open Simulator to replay token profile against other models</p>
    <table class="analyze-table">
      <thead><tr><th>Time</th><th>Model</th><th class="num">Cost</th><th class="num">Cache read</th><th class="num">Total tok</th><th></th></tr></thead>
      <tbody>${rows || '<tr><td colspan="6">No cost data</td></tr>'}</tbody>
    </table>`;
}

function renderThresholdInputs() {
  const el = $('analyzeThresholds');
  if (!el) return;
  el.innerHTML = ANALYZE_THRESHOLD_FIELDS.map((f) => `
    <label class="threshold-field">
      ${esc(f.label)}
      <span class="threshold-field-row">
        <input type="number" data-threshold="${esc(f.key)}" min="${f.min}" max="${f.max}" value="${state.analyzeThresholds[f.key]}">
        <span>${esc(f.suffix)}</span>
      </span>
    </label>`).join('');
}

function initAnalyzeSidebar() {
  if ($('analyzeTemplates')?.children.length) return;

  const prefs = loadAnalyzePrefs();
  if (prefs?.templateId) state.analyzeTemplateId = prefs.templateId;
  if (prefs?.thresholds) {
    state.analyzeThresholds = { ...ANALYZE_THRESHOLD_DEFAULTS, ...prefs.thresholds };
  }

  $('analyzeTemplates').innerHTML = ANALYZE_TEMPLATES.map((t) => `
    <button type="button" class="template-card${t.id === state.analyzeTemplateId ? ' active' : ''}" data-template="${esc(t.id)}" role="option">
      <strong>${esc(t.title)}</strong>
      <span>${esc(t.desc)}</span>
    </button>`).join('');

  $('analyzeScopes').innerHTML = ANALYZE_SCOPES.map((s) => `
    <label class="scope-item">
      <input type="checkbox" value="${esc(s.id)}">
      <span>${esc(s.label)}<small>${esc(s.hint)}</small></span>
    </label>`).join('');

  renderThresholdInputs();

  const tpl = ANALYZE_TEMPLATES.find((t) => t.id === state.analyzeTemplateId) || ANALYZE_TEMPLATES[0];
  const savedScopes = prefs?.scopes;
  document.querySelectorAll('#analyzeScopes input').forEach((el) => {
    el.checked = savedScopes?.length ? savedScopes.includes(el.value) : tpl.scopes.includes(el.value);
  });
}

function buildBriefSectionSummary(data, events) {
  const { summary } = data;
  const lines = [
    `- Period: ${PRESET_LABELS[state.datePreset] || 'Custom'} (${$('startDate').value} to ${$('endDate').value})`,
    `- Requests: ${summary.count}${summary.notCounted > 0 ? ` (+${summary.notCounted} errored/aborted events excluded)` : ''}${events.length < state.all.length ? ` (filtered from ${state.all.length} loaded)` : ''}`,
    `- ${costModeLabel()}: ${fmt.money(summary.totalCost)}`,
    `- Avg ${costModeNoun()} / request: ${fmt.money(summary.avg)}`,
    `- Cache savings (est.): ${fmt.money(summary.totalSavings)}`,
    `- Billing: ${summary.billingMode}`,
    // Without this the same brief means two different things depending on a
    // toggle the reader can't see.
    `- Cost basis: ${state.costMode === 'billed'
      ? 'what the plan actually billed'
      : 'what-if — API-equivalent value of the tokens, not necessarily charged'}`,
  ];
  if (planLabel()) lines.push(`- Plan: ${planLabel()}${isFreePlan() ? ' (costs are what-if API-equivalent values, nothing actually billed)' : ''}`);
  if (summary.hasUsageFees) lines.push(`- Usage fees (flat): ${fmt.money(summary.totalRequestFees)}`);
  const modelFilter = $('modelFilter').value;
  if (modelFilter) lines.push(`- Model filter: ${displayModel(modelFilter)}`);
  return lines.join('\n');
}

function buildBriefSectionModels(modelRows) {
  return modelRows.map((r) =>
    `- ${r.model}: ${fmt.money(r.cost)} (${fmt.num(r.count)} reqs, avg ${fmt.money(r.avg)}, ${fmt.pct(r.pct)} of spend)`,
  ).join('\n');
}

function buildBriefSectionCache(data) {
  const { cache, tokens, totalTok } = data;
  return [
    `- Cache hit rate: ${fmt.pct(cache.cacheHitRate)} (${fmt.num(cache.withCache)} requests)`,
    `- Cold starts: ${fmt.num(cache.coldStarts)}`,
    `- Total cache savings (est.): ${fmt.money(cache.totalSavings)}`,
    `- Token mix: input ${fmt.num(tokens.input)}, output ${fmt.num(tokens.output)}, cache read ${fmt.num(tokens.cacheRead)}, cache write ${fmt.num(tokens.cacheWrite)} (${fmt.num(totalTok)} total)`,
  ].join('\n');
}

function buildBriefSectionTokenMix(data) {
  const { tokens, totalTok } = data;
  if (!totalTok) return '- No token data';
  const pct = (n) => `${fmt.pct((n / totalTok) * 100)}`;
  return [
    `- Input: ${fmt.num(tokens.input)} (${pct(tokens.input)})`,
    `- Output: ${fmt.num(tokens.output)} (${pct(tokens.output)})`,
    `- Cache read: ${fmt.num(tokens.cacheRead)} (${pct(tokens.cacheRead)})`,
    `- Cache write: ${fmt.num(tokens.cacheWrite)} (${pct(tokens.cacheWrite)})`,
  ].join('\n');
}

function buildBriefSectionTopRequests(expensive) {
  return expensive.map((e, i) =>
    `${i + 1}. ${fmt.date(e.timestampMs)} · ${e.model} · cost ${fmt.money(e.cost)} · in/out/cacheR ${fmt.num(e.inputTokens)}/${fmt.num(e.outputTokens)}/${fmt.num(e.cacheReadTokens)}`,
  ).join('\n');
}

function buildBriefSectionDaily(dailyRows) {
  return dailyRows.map(([day, cost]) => `- ${day}: ${fmt.money(cost)}`).join('\n');
}

function buildBriefSectionFindings(findings) {
  return findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.title} — ${f.body} → ${f.action}`).join('\n');
}

function buildCursorBrief() {
  const events = state.filtered;
  if (!events.length) return '';
  const data = computeAnalyzeData(events, summarize(events));
  const tpl = ANALYZE_TEMPLATES.find((t) => t.id === state.analyzeTemplateId) || ANALYZE_TEMPLATES[0];
  const scopes = getSelectedAnalyzeScopes();
  const customQ = $('analyzeCustomQ')?.value?.trim();

  const parts = [
    '# Cursor usage analysis brief',
    '',
    'This data was exported from my Cursor Usage Dashboard extension (already loaded — **do not call any API**). Analyze only what is below.',
    '',
    '## Your task',
    customQ || tpl.prompt,
    '',
  ];

  if (scopes.includes('summary')) {
    parts.push('## Period summary', buildBriefSectionSummary(data, events), '');
  }
  if (scopes.includes('modelBreakdown')) {
    parts.push('## Spend by model', buildBriefSectionModels(data.modelRows), '');
  }
  if (scopes.includes('cacheStats')) {
    parts.push('## Cache health', buildBriefSectionCache(data), '');
  }
  if (scopes.includes('tokenMix')) {
    parts.push('## Token mix', buildBriefSectionTokenMix(data), '');
  }
  if (scopes.includes('topRequests')) {
    parts.push('## Top expensive requests (max 10)', buildBriefSectionTopRequests(data.expensive), '');
  }
  if (scopes.includes('dailyTrend')) {
    parts.push(`## Daily ${costModeNoun()}`, buildBriefSectionDaily(data.dailyRows), '');
  }
  if (scopes.includes('findings')) {
    parts.push('## Dashboard findings (rule-based)', buildBriefSectionFindings(data.findings), '');
  }

  parts.push(
    '---',
    'Notes for the model:',
    '- Auto optimizes for task success and uses the Auto+Composer pool — not always the cheapest rate card.',
    '- Cheaper models in comparisons assume the same token counts; real usage may differ.',
    '- Token cost excludes flat per-request usage fees unless noted in summary.',
  );

  return parts.join('\n');
}

function updateBriefPreview() {
  const preview = $('analyzeBriefPreview');
  if (!preview) return;
  preview.value = state.filtered.length ? buildCursorBrief() : '';
}

function renderAnalyze() {
  const empty = $('analyzeEmpty');
  const content = $('analyzeContent');
  if (!empty || !content) return;

  // The comparison is worth showing with an empty period — "0 requests here
  // against 120 last week" is a finding — so only the findings view collapses
  // into the empty state, and the sub-tabs stay available either way.
  const hasData = state.filtered.length > 0;
  const onCompare = state.analyzePanel === 'compare';
  $('analyzeTabs')?.classList.toggle('hidden', !state.loaded);
  empty.classList.toggle('hidden', hasData || onCompare);
  $('analyzeCompare')?.classList.toggle('hidden', !onCompare);
  content.classList.toggle('hidden', !hasData || onCompare);

  if (onCompare) {
    renderComparison();
    void loadTrendComparison();
    return;
  }
  if (!hasData) return;

  initAnalyzeSidebar();
  const summary = summarize(state.filtered);
  const data = computeAnalyzeData(state.filtered, summary);

  renderAnalyzeHero(data, state.filtered);
  renderAnalyzeFindings(data.findings);
  renderAnalyzeModelPanel(data.modelRows, summary.totalCost);
  renderAnalyzeCachePanel(data);
  renderAnalyzeExpensivePanel(data.expensive);
  updateBriefPreview();
}

async function copyCursorBrief() {
  const text = buildCursorBrief();
  if (!text) return;
  try {
    await rpc('copyText', { text });
    // Best-effort: also try to bring Cursor's chat panel into focus so
    // there's less to hunt for. Never populates or sends the prompt itself —
    // there's no reliable way to do that across Cursor versions, and doing
    // it wrong could submit an unreviewed prompt on the user's behalf. Falls
    // back to the plain "paste it yourself" message if unsupported here.
    let opened = false;
    try {
      opened = Boolean((await rpc('focusCursorChat')).opened);
    } catch {
      opened = false;
    }
    const status = $('copyBriefStatus');
    if (status) {
      status.textContent = opened
        ? 'Copied — Cursor Chat is open, press ⌘/Ctrl+V then Enter'
        : 'Copied — paste in Cursor Chat';
      setTimeout(() => { status.textContent = ''; }, 4000);
    }
  } catch {
    $('analyzeBriefPreview').value = text;
    $('analyzeBriefPreview').closest('details')?.setAttribute('open', 'open');
    showAlert('info', 'Could not copy automatically — select the preview text and copy manually.');
  }
  saveAnalyzePrefs();
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

function getCompareModels(pricing) {
  const models = [{ key: 'default', label: 'Auto' }];
  for (const m of pricing.models) {
    if (m.input != null) models.push({ key: m.name, label: m.display });
  }
  return models;
}

function requestOptionLabel(e) {
  return `${fmt.date(e.timestampMs)} · ${e.model} · ${fmt.num(e.totalTokens)} tok · ${fmt.money(e.cost)}`;
}

function isSameModel(modelKey, eventModelRaw) {
  const a = normModel(modelKey);
  const b = normModel(eventModelRaw);
  if (a === b) return true;
  if (a === 'default' && (b === 'default' || b.includes('auto'))) return true;
  if (b === 'default' && (a === 'default' || a.includes('auto'))) return true;
  return false;
}

function tokensFromEvent(e) {
  return {
    input: e.inputTokens,
    output: e.outputTokens,
    cacheRead: e.cacheReadTokens,
    cacheWrite: e.cacheWriteTokens,
  };
}

function populateSimulatorModels() {
  if (!state.pricing || !$('simModel')) return;
  const options = [{ key: 'default', label: 'Auto' }];
  for (const m of state.pricing.models) {
    if (m.input != null) options.push({ key: m.name, label: m.display });
  }
  $('simModel').innerHTML = options
    .map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`)
    .join('');
}

function populateSimRequestPicker(selectedId) {
  const el = $('simRequest');
  if (!el) return;
  const events = state.filtered.length ? state.filtered : state.all;
  if (!events.length) {
    el.innerHTML = '<option value="">No requests loaded</option>';
    state.simRequestId = null;
    return;
  }
  const sorted = [...events].sort((a, b) => b.timestampMs - a.timestampMs);
  el.innerHTML = sorted
    .map((e) => `<option value="${esc(e.id)}">${esc(requestOptionLabel(e))}</option>`)
    .join('');
  const pick = selectedId && sorted.some((e) => e.id === selectedId) ? selectedId : sorted[0].id;
  el.value = pick;
  state.simRequestId = pick;
}

function formatDiff(diff) {
  if (diff == null) return '—';
  if (Math.abs(diff) < 0.005) return 'same';
  if (diff < 0) return `−${fmt.money(-diff)}`;
  return `+${fmt.money(diff)}`;
}

const DEFAULT_COMPARE_HINTS = [
  'claude-4-6-sonnet',
  'claude-4-5-sonnet',
  'gpt-5-2',
  'composer-2-5',
  'claude-4-5-haiku',
];

function defaultCompareSelection(models) {
  const hinted = models.filter((m) => DEFAULT_COMPARE_HINTS.some((h) => m.key.includes(h) || h.includes(m.key)));
  if (hinted.length >= 2) return new Set(hinted.slice(0, 4).map((m) => m.key));
  return new Set(models.slice(0, Math.min(4, models.length)).map((m) => m.key));
}

function loadCompareModelPrefs() {
  try {
    const raw = storage.getItem(COMPARE_MODELS_KEY);
    const keys = raw ? JSON.parse(raw) : null;
    return Array.isArray(keys) ? keys : null;
  } catch {
    return null;
  }
}

function saveCompareModelPrefs(keys) {
  try {
    storage.setItem(COMPARE_MODELS_KEY, JSON.stringify(keys));
  } catch {
    // ignore
  }
}

function initCompareModelPrefs() {
  const stored = loadCompareModelPrefs();
  if (stored?.length) state.simCompareSelected = new Set(stored);
}

function resolveCompareSelection(models) {
  if (state.simCompareSelected?.size) {
    const available = new Set(models.map((m) => m.key));
    const kept = [...state.simCompareSelected].filter((k) => available.has(k));
    if (kept.length) return new Set(kept);
  }
  const stored = loadCompareModelPrefs();
  if (stored?.length) {
    const available = new Set(models.map((m) => m.key));
    const restored = stored.filter((k) => available.has(k));
    if (restored.length) return new Set(restored);
  }
  return defaultCompareSelection(models);
}

function saveCompareModelSelection() {
  const checked = [...document.querySelectorAll('#simCompareModelFilters input:checked')].map((el) => el.value);
  state.simCompareSelected = new Set(checked);
  saveCompareModelPrefs(checked);
  updateComparePickerLabel();
}

function applyCompareModelSearch(query) {
  const q = query.trim().toLowerCase();
  document.querySelectorAll('#simCompareModelFilters .sim-picker-item').forEach((item) => {
    const label = item.dataset.label || '';
    item.classList.toggle('hidden', Boolean(q && !label.includes(q)));
  });
  const empty = $('simCompareSearchEmpty');
  if (!empty) return;
  const visible = document.querySelectorAll('#simCompareModelFilters .sim-picker-item:not(.hidden)').length;
  empty.classList.toggle('hidden', visible > 0 || !q);
}

function updateComparePickerLabel() {
  const label = $('simComparePickerLabel');
  const list = $('simCompareModelFilters');
  if (!label || !list) return;

  const checked = [...list.querySelectorAll('input:checked')];
  const total = list.querySelectorAll('input').length;
  if (!checked.length) {
    label.textContent = 'Select models…';
    return;
  }
  if (checked.length === total) {
    label.textContent = `All models (${total})`;
    return;
  }
  if (checked.length === 1) {
    label.textContent = checked[0].nextElementSibling?.textContent || '1 model';
    return;
  }
  if (checked.length === 2) {
    const names = checked.map((el) => el.nextElementSibling?.textContent).filter(Boolean);
    label.textContent = names.join(', ');
    return;
  }
  label.textContent = `${checked.length} models selected`;
}

function setComparePickerOpen(open) {
  const btn = $('simComparePickerBtn');
  const menu = $('simComparePickerMenu');
  const search = $('simCompareSearch');
  if (!btn || !menu) return;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  menu.classList.toggle('hidden', !open);
  if (open) {
    search?.focus();
  } else if (search) {
    search.value = '';
    applyCompareModelSearch('');
  }
}

function toggleComparePicker() {
  const menu = $('simComparePickerMenu');
  if (!menu) return;
  setComparePickerOpen(menu.classList.contains('hidden'));
}

function getCompareModelSelection() {
  if (state.simCompareSelected) return state.simCompareSelected;
  return new Set([...document.querySelectorAll('#simCompareModelFilters input:checked')].map((el) => el.value));
}

function populateCompareModelFilters(event) {
  const container = $('simCompareModelFilters');
  if (!container || !state.pricing) return;

  const models = getCompareModels(state.pricing).filter((m) => !isSameModel(m.key, event.modelRaw));
  const requestChanged = state.simCompareFilterRequestId !== event.id;
  if (!requestChanged && container.children.length) return;

  state.simCompareFilterRequestId = event.id;
  const selected = resolveCompareSelection(models);
  state.simCompareSelected = selected;

  container.innerHTML = models.map((m) => {
    const checked = selected.has(m.key);
    return `<label class="sim-picker-item" data-label="${esc(m.label.toLowerCase())}">
      <input type="checkbox" value="${esc(m.key)}" ${checked ? 'checked' : ''}>
      <span>${esc(m.label)}</span>
    </label>`;
  }).join('');
  applyCompareModelSearch($('simCompareSearch')?.value || '');
  updateComparePickerLabel();
}

/**
 * The cost the simulator compares model rates against.
 *
 * Always the what-if token value, never the Billed figure: the comparison
 * prices this request's tokens at each model's published rates, so the baseline
 * has to be the same kind of number. With the Costs toggle on Billed, `cost`
 * is what the plan charged — often $0 for included or free-plan requests, which
 * made every alternative model look infinitely more expensive.
 */
function actualTokenCost(event) {
  return event.valueCost ?? event.tokenCost ?? event.cost ?? null;
}

function buildCompareRows(event) {
  const tokens = tokensFromEvent(event);
  const actualCost = actualTokenCost(event);
  const actualRow = {
    key: event.modelRaw,
    label: event.model,
    estCost: actualCost,
    savings: event.cacheSavings,
    diff: null,
    isActual: true,
  };

  const altRows = [];
  for (const m of getCompareModels(state.pricing)) {
    if (isSameModel(m.key, event.modelRaw)) continue;
    const rates = matchPricing(m.key, state.pricing);
    if (!rates) continue;
    const estCost = estimateTokenCost(rates, tokens);
    const savings = cacheSavingsFor({ cacheRead: tokens.cacheRead }, rates);
    const diff = actualCost != null && estCost != null ? estCost - actualCost : null;
    altRows.push({ key: m.key, label: rates.label, estCost, savings, diff, isActual: false });
  }
  return { actualRow, altRows };
}

function sortCompareRows(rows, key, dir) {
  const d = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === 'label') return a.label.localeCompare(b.label) * d;
    const av = a[key];
    const bv = b[key];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    if (typeof av === 'string') return av.localeCompare(bv) * d;
    return (av - bv) * d;
  });
}

function renderCompareRow(row) {
  if (row.isActual) {
    return `<tr class="row-actual">
      <td>${esc(row.label)} <span class="sim-tag">actual</span></td>
      <td>${fmt.money(row.estCost)}</td>
      <td>—</td>
      <td>${row.savings != null ? fmt.money(row.savings) : '—'}</td>
    </tr>`;
  }
  const rowClass = row.diff != null && row.diff < -0.005 ? 'row-cheaper' : row.diff > 0.005 ? 'row-pricier' : '';
  const diffClass = row.diff != null && row.diff < -0.005 ? 'diff-save' : row.diff > 0.005 ? 'diff-more' : '';
  return `<tr class="${rowClass}">
    <td>${esc(row.label)}</td>
    <td>${fmt.money(row.estCost)}</td>
    <td class="${diffClass}">${formatDiff(row.diff)}</td>
    <td>${row.savings != null ? fmt.money(row.savings) : '—'}</td>
  </tr>`;
}

function updateCompareSortHeaders() {
  document.querySelectorAll('#simCompareTable th[data-sort]').forEach((th) => {
    th.classList.remove('sorted-asc', 'sorted-desc');
    if (th.dataset.sort === state.simCompareSortKey) {
      th.classList.add(state.simCompareSortDir === 'asc' ? 'sorted-asc' : 'sorted-desc');
    }
  });
}

function renderCompareTableFromState() {
  const ctx = state.simCompareContext;
  if (!ctx || !$('simCompareBody')) return;

  const selected = getCompareModelSelection();
  const hint = $('simCompareFilterHint');
  if (hint) hint.classList.toggle('hidden', selected.size > 0);

  if (!selected.size) {
    $('simCompareBody').innerHTML = `<tr><td colspan="4">Select at least one model above.</td></tr>`;
    updateCompareSortHeaders();
    return;
  }

  const filtered = ctx.altRows.filter((r) => selected.has(r.key));
  let rows;
  if (state.simCompareSortKey === 'label') {
    rows = sortCompareRows([ctx.actualRow, ...filtered], 'label', state.simCompareSortDir);
  } else {
    const sorted = sortCompareRows(filtered, state.simCompareSortKey, state.simCompareSortDir);
    rows = [ctx.actualRow, ...sorted];
  }

  $('simCompareBody').innerHTML = rows.map(renderCompareRow).join('');
  updateCompareSortHeaders();
}

function runCompareFromRequest() {
  if (!state.pricing || !$('simCompareBody')) return;
  const id = $('simRequest')?.value || state.simRequestId;
  const event = state.filtered.find((e) => e.id === id) || state.all.find((e) => e.id === id);
  if (!event) {
    state.simCompareContext = null;
    $('simSourceSummary')?.classList.add('hidden');
    $('simCompareModelFilters').innerHTML = '';
    $('simCompareBody').innerHTML = '<tr><td colspan="4">Load usage data and pick a request.</td></tr>';
    return;
  }

  state.simRequestId = id;
  const tokens = tokensFromEvent(event);
  const actualCost = actualTokenCost(event);
  const summary = $('simSourceSummary');
  if (summary) {
    summary.classList.remove('hidden');
    summary.innerHTML = `
      <div><dt>When</dt><dd>${fmt.date(event.timestampMs)}</dd></div>
      <div><dt>Model used ${tip('The model Cursor billed for this request. Auto means Cursor chose the model automatically.')}</dt><dd>${esc(event.model)}</dd></div>
      <div><dt>Actual token cost ${tip('What Cursor charged for model/API tokens on this request. Does not include flat usage fees on some plans, and always the token value rather than the Billed figure — the comparison below prices tokens, so its baseline has to as well.')}</dt><dd>${fmt.money(actualCost)}</dd></div>
      <div><dt>Input / output ${tip('Token counts from your request — replayed as-is when estimating other models.')}</dt><dd>${fmt.num(tokens.input)} / ${fmt.num(tokens.output)}</dd></div>
      <div><dt>Cache read / write ${tip('Prompt cache tokens from this request. Savings estimates assume similar cache behavior on other models.')}</dt><dd>${fmt.num(tokens.cacheRead)} / ${fmt.num(tokens.cacheWrite)}</dd></div>
      <div><dt>Total tokens ${tip('Sum of input, output, cache read, and cache write tokens.')}</dt><dd>${fmt.num(event.totalTokens)}</dd></div>`;
  }

  populateCompareModelFilters(event);
  state.simCompareContext = buildCompareRows(event);
  renderCompareTableFromState();
}

function setSimModeUI(mode) {
  state.simMode = mode;
  document.querySelectorAll('.sim-mode').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.simMode === mode);
  });
  $('simRequestPanel')?.classList.toggle('hidden', mode !== 'request');
  $('simCustomPanel')?.classList.toggle('hidden', mode !== 'custom');
}

function refreshSimulator() {
  populateSimRequestPicker(state.simRequestId);
  if (state.simMode === 'request') runCompareFromRequest();
  else runSimulator();
}

function openCompare(requestId) {
  state.simRequestId = requestId;
  state.simMode = 'request';
  setSimModeUI('request');
  setAppView('simulator');
}

function runSimulator() {
  if (!state.pricing) return;
  // Typed input can be negative even with min="0" on the field; a negative
  // token count would quietly produce a negative "cost".
  const tokenInput = (id) => Math.max(0, num($(id).value));
  const tokens = {
    input: tokenInput('simInput'),
    output: tokenInput('simOutput'),
    cacheRead: tokenInput('simCacheRead'),
    cacheWrite: tokenInput('simCacheWrite'),
  };
  const modelKey = $('simModel').value;
  const rates = matchPricing(modelKey, state.pricing);
  if (!rates) {
    $('simCost').textContent = '—';
    $('simSavings').textContent = '—';
    $('simNoCache').textContent = '—';
    $('simRates').textContent = 'No pricing matched for this model.';
    return;
  }
  const cost = estimateTokenCost(rates, tokens);
  const savings = cacheSavingsFor({ cacheRead: tokens.cacheRead }, rates);
  const noCache = cost != null && savings != null ? cost + savings : cost;
  $('simCost').textContent = fmt.money(cost);
  $('simSavings').textContent = fmt.money(savings);
  $('simNoCache').textContent = fmt.money(noCache);
  const parts = [`${rates.label} rates (per 1M tokens)`];
  if (rates.input != null) parts.push(`input $${rates.input}`);
  if (rates.output != null) parts.push(`output $${rates.output}`);
  if (rates.cacheRead != null) parts.push(`cache read $${rates.cacheRead}`);
  $('simRates').textContent = parts.join(' · ');
}

function setAppView(view) {
  state.appView = view;
  $('overviewView').classList.toggle('hidden', view !== 'overview');
  $('usageView').classList.toggle('hidden', view !== 'usage');
  $('analyzeView').classList.toggle('hidden', view !== 'analyze');
  $('simulatorView').classList.toggle('hidden', view !== 'simulator');
  // One filter bar, shown wherever the date range means something. Overview
  // used to carry a second copy of the period and cost-mode chips for when this
  // bar was hidden there; both being visible read as two competing filters, so
  // the duplicate is gone. Only the Simulator drops the bar — that view is a
  // standalone calculator that doesn't read the date filter at all.
  document.querySelector('.filter-bar')?.classList.toggle('hidden', view === 'simulator');
  if (view !== 'usage') {
    $('billingNotice')?.classList.add('hidden');
    // Errors and warnings describe the data every view is showing, so they
    // follow the user across tabs; only the "loaded N requests" confirmation is
    // specific to the request log and goes away with it.
    if (state.alertType === 'info') hideAlert();
  }
  document.querySelectorAll('.nav-item[data-app]').forEach((btn) => {
    if (btn.disabled) return;
    const active = btn.dataset.app === view;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  if (view === 'overview') renderOverview();
  if (view === 'simulator') refreshSimulator();
  if (view === 'analyze') renderAnalyze();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  initDateRange();
  initPeriodComparePrefs();
  initCompareModelPrefs();

  const storedMode = storage.getItem(COST_MODE_KEY);
  if (storedMode === 'billed' || storedMode === 'value') state.costMode = storedMode;
  document.querySelectorAll('.cost-mode-btn').forEach((btn) => {
    const active = btn.dataset.costMode === state.costMode;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    btn.addEventListener('click', () => setCostMode(btn.dataset.costMode));
  });
  applyCostModeLabels();
  decorateTips();

  $('alert')?.addEventListener('click', (ev) => {
    if (ev.target.closest('.alert-close')) hideAlert();
  });

  try {
    const status = await rpc('status');
    $('authLabel').textContent = {
      session: status.email ? `Signed in as ${status.email} (Cursor session)` : 'Signed in via Cursor',
      admin: 'Team Admin API',
      none: 'Sign into Cursor to load data',
    }[status.authMode] || '';
  } catch {
    $('authLabel').textContent = '';
  }

  $('refreshBtn').addEventListener('click', load);
  $('exportBtn').addEventListener('click', exportCsv);

  document.querySelectorAll(PRESET_BTN_SELECTOR).forEach((btn) => {
    btn.addEventListener('click', () => onPresetClick(btn.dataset.preset));
  });

  document.querySelectorAll(ANALYZE_TAB_SELECTOR).forEach((tab) => {
    tab.addEventListener('click', () => setAnalyzePanel(tab.dataset.analyzePanel));
  });

  document.querySelectorAll('.compare-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.trend.mode === btn.dataset.compareMode) return;
      state.trend.mode = btn.dataset.compareMode;
      // Seed the custom pickers with the window they'd otherwise replace, so
      // switching to Custom starts from what was already on screen instead of
      // two empty inputs.
      if (state.trend.mode === 'custom' && !state.trend.customStart && state.trend.range) {
        state.trend.customStart = toDateInputValue(new Date(state.trend.range.startMs));
        state.trend.customEnd = toDateInputValue(new Date(state.trend.range.endMs));
        $('compareStartDate').value = state.trend.customStart;
        $('compareEndDate').value = state.trend.customEnd;
      }
      savePrefs({ compareMode: state.trend.mode });
      renderComparison();
      void loadTrendComparison();
    });
  });

  // Committed on change, not on every keystroke: each baseline is a fresh
  // paginated fetch of cursor.com, and a half-typed year is a range nobody
  // asked for.
  ['compareStartDate', 'compareEndDate'].forEach((id) => {
    $(id)?.addEventListener('change', () => {
      state.trend.customStart = $('compareStartDate').value;
      state.trend.customEnd = $('compareEndDate').value;
      savePrefs({
        compareMode: state.trend.mode,
        compareStart: state.trend.customStart,
        compareEnd: state.trend.customEnd,
      });
      void loadTrendComparison();
    });
  });

  $('modelFilter').addEventListener('change', () => { state.page = 1; destroyCharts(); refresh(); });
  $('startDate').addEventListener('change', onDateInputChange);
  $('endDate').addEventListener('change', onDateInputChange);

  $('pageSize').addEventListener('change', () => {
    state.pageSize = parseInt($('pageSize').value, 10);
    state.page = 1;
    refresh();
  });

  $('prevPage').addEventListener('click', () => { state.page -= 1; refresh(); });
  $('nextPage').addEventListener('click', () => { state.page += 1; refresh(); });

  document.querySelectorAll(VIEW_TAB_SELECTOR).forEach((tab) => {
    tab.addEventListener('click', () => setPanel(tab.dataset.panel));
  });

  $('goAnalyzeTab')?.addEventListener('click', () => setAppView('analyze'));
  $('ovSeeAllInsights')?.addEventListener('click', () => setAppView('analyze'));
  $('ovViewRequests')?.addEventListener('click', () => setAppView('usage'));

  document.querySelectorAll('.nav-item[data-app]').forEach((btn) => {
    if (btn.disabled) return;
    btn.addEventListener('click', () => setAppView(btn.dataset.app));
  });

  document.querySelectorAll('.sim-mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      setSimModeUI(btn.dataset.simMode);
      refreshSimulator();
    });
  });

  $('simRequest')?.addEventListener('change', () => {
    setComparePickerOpen(false);
    runCompareFromRequest();
  });

  $('simComparePickerBtn')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    toggleComparePicker();
  });

  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('#simComparePicker')) setComparePickerOpen(false);
  });

  // A popup that only closes on an outside click is a trap for keyboard users:
  // Escape closes it and hands focus back to the control that opened it.
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    const menu = $('simComparePickerMenu');
    if (!menu || menu.classList.contains('hidden')) return;
    setComparePickerOpen(false);
    $('simComparePickerBtn')?.focus();
  });

  $('simCompareSearch')?.addEventListener('input', (ev) => {
    applyCompareModelSearch(ev.target.value);
  });

  $('simCompareSearch')?.addEventListener('click', (ev) => ev.stopPropagation());

  $('simCompareModelFilters')?.addEventListener('change', () => {
    saveCompareModelSelection();
    renderCompareTableFromState();
  });

  $('simCompareSelectAll')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    document.querySelectorAll('#simCompareModelFilters input').forEach((cb) => { cb.checked = true; });
    saveCompareModelSelection();
    renderCompareTableFromState();
  });

  $('simCompareClear')?.addEventListener('click', (ev) => {
    ev.stopPropagation();
    document.querySelectorAll('#simCompareModelFilters input').forEach((cb) => { cb.checked = false; });
    saveCompareModelSelection();
    renderCompareTableFromState();
  });

  $('simCompareTable')?.addEventListener('click', (ev) => {
    const th = ev.target.closest('th[data-sort]');
    if (!th || ev.target.closest('.tip')) return;
    const key = th.dataset.sort;
    if (state.simCompareSortKey === key) {
      state.simCompareSortDir = state.simCompareSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      state.simCompareSortKey = key;
      state.simCompareSortDir = key === 'savings' ? 'desc' : 'asc';
    }
    renderCompareTableFromState();
  });

  $('tableBody')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.btn-compare');
    if (!btn) return;
    openCompare(btn.dataset.id);
  });

  $('analyzeExpensivePanel')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.btn-compare');
    if (!btn) return;
    openCompare(btn.dataset.id);
  });

  $('analyzeTemplates')?.addEventListener('click', (ev) => {
    const card = ev.target.closest('[data-template]');
    if (!card) return;
    state.analyzeTemplateId = card.dataset.template;
    document.querySelectorAll('.template-card').forEach((c) => {
      c.classList.toggle('active', c.dataset.template === state.analyzeTemplateId);
    });
    applyTemplateScopes(state.analyzeTemplateId);
    updateBriefPreview();
    saveAnalyzePrefs();
  });

  $('analyzeScopes')?.addEventListener('change', () => {
    updateBriefPreview();
    saveAnalyzePrefs();
  });

  $('analyzeThresholds')?.addEventListener('change', (ev) => {
    const input = ev.target.closest('input[data-threshold]');
    if (!input) return;
    const field = ANALYZE_THRESHOLD_FIELDS.find((f) => f.key === input.dataset.threshold);
    if (!field) return;
    const clamped = Math.min(field.max, Math.max(field.min, num(input.value)));
    input.value = clamped;
    state.analyzeThresholds[field.key] = clamped;
    saveAnalyzePrefs();
    renderAnalyze();
  });

  $('analyzeThresholdsReset')?.addEventListener('click', () => {
    state.analyzeThresholds = { ...ANALYZE_THRESHOLD_DEFAULTS };
    renderThresholdInputs();
    saveAnalyzePrefs();
    renderAnalyze();
  });

  $('analyzeCustomQ')?.addEventListener('input', updateBriefPreview);

  $('copyCursorBrief')?.addEventListener('click', copyCursorBrief);

  ['simModel', 'simInput', 'simOutput', 'simCacheRead', 'simCacheWrite'].forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', runSimulator);
    el.addEventListener('change', runSimulator);
  });

  // Scoped to the request log: the simulator's compare table also uses
  // th[data-sort], and an unscoped selector wired its headers to this handler
  // too — clicking "Est. cost" there set the request log's sort key to a field
  // its rows don't have, silently dropping the sort the user had chosen.
  document.querySelectorAll('#requestsTable th[data-sort]').forEach((th) => {
    const sortByHeader = () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
      else { state.sortKey = key; state.sortDir = 'desc'; }
      state.page = 1;
      refresh();
    };
    th.addEventListener('click', sortByHeader);
    // Sorting is a primary action on this table, so it has to be reachable
    // without a pointer; the headers carry tabindex="0" for the same reason.
    th.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return;
      ev.preventDefault();
      sortByHeader();
    });
  });

  // Put the chrome in the state the view actually implies before the first
  // load — otherwise Overview opens with the Requests filter bar still showing
  // (duplicating its own period chips) until the user switches views once.
  setAppView(state.appView);

  await load();
}

init();
