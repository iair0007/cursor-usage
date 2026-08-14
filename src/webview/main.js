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
  detectDiscounts,
  discountPeriods,
  resolveDiscount,
  detectedDiscountDays,
  applyDiscountToRates,
  modelsMissingDiscountInfo,
  normalizeDiscountEntry,
  dayKey,
  simulatorModels,
  defaultCompareSelection,
  mergeCompareSelection,
  displayModel,
  cacheSavingsFor,
  num,
  normModel,
  normalize,
  summarize,
  comparisonWindow,
  detectBillingMode,
  detectPlanChange,
  isPerRequestPriced,
  modelCostDeltas,
  percentile,
  projectExhaustionDate,
  groupByDay,
  filterByRange,
  sessionTotals,
  sessionSummary,
  sessionMetrics,
  filterSessions,
  sortSessions,
  SESSION_SORT_DEFAULT_DIR,
  UNATTRIBUTED_SESSION,
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

/**
 * Two tiers, because vscode.setState alone is not durable enough. It survives
 * the panel being hidden (and is synchronous, which every caller here relies
 * on), but it dies with the panel — so preferences stored only there reset
 * every time the dashboard was closed and reopened. The extension host's
 * globalState is the durable copy; setState is the fast local mirror.
 *
 * Reads stay synchronous: hydratePrefs() pulls the durable copy in before
 * init() touches any of it.
 */
const persisted = vscode.getState() || {};
const storage = {
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(persisted, key) ? persisted[key] : null;
  },
  setItem(key, value) {
    persisted[key] = String(value);
    vscode.setState(persisted);
    // Per key rather than whole-object, so a slow write can't clobber a
    // different preference saved while it was in flight. Best-effort: losing a
    // preference write is not worth failing a user action over.
    rpc('prefsSet', { key, value: String(value) }).catch(() => {});
  },
};

async function hydratePrefs() {
  try {
    const stored = await rpc('prefsGet', {}, 5000);
    if (stored && typeof stored === 'object') Object.assign(persisted, stored);
  } catch {
    // Older host, or the call failed — fall back to whatever setState kept.
  }
}

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
  /** Analyze tab sub-view: 'findings' | 'compare' | 'sessions'. */
  analyzePanel: 'findings',
  sessions: {
    /** Substring filter over session ids and models. */
    query: '',
    /**
     * Session ids lined up for comparison, in the order they were picked —
     * which is also the order of the columns and the A/B/C/D labels.
     */
    selected: [],
    /** Which column orders the list: 'name' | 'started' | 'duration' | 'requests' | 'cost'. */
    sortKey: 'cost',
    sortDir: 'desc',
    page: 1,
    pageSize: 20,
    /** The session everything else is measured against in the comparison. */
    baseId: null,
    /** Hide comparison rows whose values all match — see sameAcross(). */
    diffOnly: false,
    /**
     * id → name from Cursor's local database, or null once we've looked and
     * found none. The null matters: without it every render would re-ask for
     * the same unnamed conversations.
     */
    titles: new Map(),
    /** Ids currently being looked up, so a re-render doesn't ask twice. */
    titlesPending: new Set(),
  },
  appView: 'overview',
  simMode: 'request',
  simRequestId: null,
  simCompareSelected: null,
  simCompareFilterRequestId: null,
  simCompareModelsKey: null,
  simCompareSortKey: 'estCost',
  simCompareSortDir: 'asc',
  simCompareContext: null,
  /** What to hand focus back to when the Simulator intro dialog closes. */
  simIntroReturnFocus: null,
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
  /**
   * Calendar month (YYYY-MM) `planChangeDay` was last checked for. The check
   * runs against the current month's own events regardless of the date filter
   * — see ensurePlanChangeCurrentMonth() — so the chip reflects the account,
   * not whatever range happens to be on screen. Null means not checked yet
   * this session.
   */
  planCheckMonthKey: null,
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
    /**
     * Explicit dates for the left column. Null means it follows the filter bar,
     * which is the default and keeps one period in force across every tab; set,
     * it detaches so two arbitrary windows can be lined up.
     */
    primaryStart: '',
    primaryEnd: '',
    primaryEvents: null,
    /** Which column the inline date editor is aimed at: 'current' | 'baseline'. */
    editing: null,
    /** The resolved baseline window, for labelling the columns. */
    range: null,
    loading: false,
    error: null,
  },
  analyzeThresholds: { ...ANALYZE_THRESHOLD_DEFAULTS },
  /**
   * Promotions inferred from billing vs. the published rate table, recomputed
   * whenever the loaded events change. See detectDiscounts().
   */
  detectedDiscounts: { discounts: {}, observed: new Set() },
  /** Hand-entered promotions, persisted — they outlive any one loaded range. */
  manualDiscounts: [],
  /** Compare-model keys the last simulator render could not price for the day. */
  discountPromptKeys: [],
  /** Request ids whose "we don't know about a promo" prompt the user dismissed. */
  discountPromptDismissed: new Set(),
  discountEditorOpen: false,
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
  /** One decimal, for per-day rates where whole numbers hide the difference. */
  rate(v) { return v == null ? '—' : v.toFixed(1); },
  /** Promotions are usually round ("50%"); only show a decimal when there is one. */
  discountPct(v) { return v == null ? '—' : `${Number.isInteger(v) ? v : v.toFixed(1)}%`; },
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
 * Applies the result of checking this calendar month's own events for a
 * billing-system change: reveals or hides the "Current plan" chip, and — the
 * first time it's seen — switches to it.
 *
 * Deliberately scoped to the current month rather than whatever range the
 * user has loaded — see the call site in load(). Detecting it from the
 * selected range meant a change from three weeks ago only surfaced the chip
 * once someone happened to load a range that reached back that far; "Today"
 * or "7 days" right after a mid-month switch would never show it at all,
 * even though the chip exists precisely to help right after a switch.
 *
 * Mixing two billing systems in one total is the thing that made "Month to
 * date" read $202 when cursor.com said $2.79, so once we know where the
 * change happened, the range that only covers the current system is the
 * honest default. Only automatic once: after that the choice is the user's,
 * and their saved preset is respected.
 *
 * Returns true when it kicked off a reload, so the caller stops rendering the
 * range being replaced.
 */
function applyPlanChangeResult(change, monthKey) {
  state.planCheckMonthKey = monthKey;
  if (change) {
    state.planChangeDay = change.dayKey;
    // planChangeDay is auto-injected by savePrefs() from state, which was
    // just updated above.
    savePrefs({});
  } else if (state.planChangeDay) {
    // This month's own events no longer show the evidence: the account
    // changed plans in an earlier month (stale from a previous session) or
    // never really changed at all. Either way, keeping the chip around would
    // point at a range this account can no longer show any evidence for.
    state.planChangeDay = null;
    savePrefs({});
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
  // Only rows that carry an actual per-request charge count as the old system.
  // A row that merely wasn't token-metered — an included request charged $0 —
  // is not evidence of anything, and treating it as such warned about a plan
  // change on accounts that never had one.
  const legacy = state.all.filter(isPerRequestPriced).length;
  const metered = state.all.length - legacy;
  if (!legacy || !metered) return '';
  // The same one-way test detectPlanChange applies: interleaved regimes mean
  // this account meters some requests and not others, not that it migrated.
  if (!state.planChangeDay) return '';
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

/** The current calendar month, as 'YYYY-MM' — the unit the plan-change check is scoped to. */
function currentMonthKey(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
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

// ---------------------------------------------------------------------------
// Promotional discounts (see detectDiscounts() in logic.js for the rationale)
// ---------------------------------------------------------------------------

/** Restores hand-entered promotions. They are never re-derivable, so they persist. */
function initDiscountPrefs() {
  const stored = loadPrefs()?.manualDiscounts;
  if (!Array.isArray(stored)) return;
  state.manualDiscounts = stored.map(normalizeDiscountEntry).filter(Boolean);
}

function saveManualDiscounts() {
  savePrefs({ manualDiscounts: state.manualDiscounts });
}

function discountContext() {
  return { detected: state.detectedDiscounts, manual: state.manualDiscounts };
}

/** The promotion in force for a model on the day a given request ran. */
function discountForEvent(modelRaw, timestampMs) {
  return resolveDiscount(modelRaw, dayKey(timestampMs), discountContext());
}

const DISCOUNT_TIPS = {
  detected: 'Cursor charged you noticeably less for this model than its normal price on this day, so it was probably on sale. Worked out from your own bill — Cursor does not publish its sales anywhere this extension can read.',
  manual: 'A discount you added yourself. Estimates for this model use the lower price on the dates you gave.',
};

function discountBadge(discount, extraClass = '') {
  if (!discount) return '';
  const label = discount.source === 'manual' ? 'you added' : 'off';
  return ` <span class="discount-tag ${extraClass}" title="${esc(DISCOUNT_TIPS[discount.source])}">−${fmt.discountPct(discount.pct)} ${label}</span>`;
}

/**
 * The badge for a model in a table that spans the whole loaded range rather
 * than one request. A promotion that ran for part of the range still belongs
 * on the row — the summary it labels includes those days' spend — so the badge
 * names the number of days rather than implying the whole period was discounted.
 */
function rangeDiscountBadge(modelRaw) {
  const days = detectedDiscountDays(state.detectedDiscounts, modelRaw);
  if (days.length) {
    const byDay = state.detectedDiscounts.discounts[normModel(modelRaw)];
    const top = Math.max(...days.map((d) => byDay[d].pct));
    const span = days.length === 1 ? fmt.shortDate(days[0]) : `${days.length} days`;
    return ` <span class="discount-tag" title="${esc(DISCOUNT_TIPS.detected)}">−${fmt.discountPct(top)} on ${esc(span)}</span>`;
  }
  const manual = state.manualDiscounts.find((entry) => manualEntryCoversModel(entry, modelRaw));
  if (!manual) return '';
  return ` <span class="discount-tag discount-tag-manual" title="${esc(DISCOUNT_TIPS.manual)}">−${fmt.discountPct(manual.pct)} entered</span>`;
}

function manualEntryCoversModel(entry, modelRaw) {
  const n = normModel(modelRaw);
  return (entry.models || []).some((m) => m === '*' || n === m || n.includes(m) || m.includes(n));
}

const COMPARE_MODES = ['previous', 'prevMonth', 'custom'];

/** Restores the comparison baseline chosen in a previous session. */
function initSessionPrefs() {
  const prefs = loadPrefs();
  if (SESSION_SORT_DEFAULT_DIR[prefs?.sessionSortKey]) state.sessions.sortKey = prefs.sessionSortKey;
  if (prefs?.sessionSortDir === 'asc' || prefs?.sessionSortDir === 'desc') {
    state.sessions.sortDir = prefs.sessionSortDir;
  }
  const size = Number(prefs?.sessionPageSize);
  if (SESSION_PAGE_SIZES.includes(size)) state.sessions.pageSize = size;
}

function initPeriodComparePrefs() {
  const prefs = loadPrefs();
  if (COMPARE_MODES.includes(prefs?.compareMode)) state.trend.mode = prefs.compareMode;
  if (prefs?.compareStart) state.trend.customStart = prefs.compareStart;
  if (prefs?.compareEnd) state.trend.customEnd = prefs.compareEnd;
  if (prefs?.comparePrimaryStart && prefs?.comparePrimaryEnd) {
    state.trend.primaryStart = prefs.comparePrimaryStart;
    state.trend.primaryEnd = prefs.comparePrimaryEnd;
  }
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
 *
 * `betterWhen: 'neither'` drops the colour entirely, for comparisons where no
 * direction is the good one. Two sessions are not a before and an after: one
 * costing more than the other is a fact about the work, not a regression, and
 * painting it amber would invent a verdict the numbers don't support.
 */
function deltaCell(current, baseline, format = fmt.money, betterWhen = 'down') {
  if (format(current) === format(baseline)) return '<span class="delta delta-flat">no change</span>';
  const delta = current - baseline;
  const up = delta > 0;
  const sign = up ? '+' : '−';
  // The values differ on screen but the gap is under one displayed unit — say
  // "<$0.01" rather than "$0.00", which reads as no difference at all.
  const smallestUnit = format === fmt.num ? 1
    : format === fmt.rate || format === fmt.pct ? 0.1
      : format === fmtDuration ? 60 * 1000 // durations are printed in whole minutes
        : 0.01;
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

  if (betterWhen === 'neither') {
    return `<span class="delta delta-neutral">${magnitude}${esc(pct)}</span>`;
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

  document.querySelectorAll('.compare-mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.compareMode === state.trend.mode);
  });
  renderCompareEditor();

  const statusEl = $('compareStatus');
  const bodyEl = $('compareBody');
  const noteEl = $('compareNote');
  const setStatus = (text) => {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('hidden', !text);
  };
  const clear = (text) => {
    setStatus(text);
    bodyEl.innerHTML = '';
    noteEl.classList.add('hidden');
  };

  // Nothing loaded at all: the panel would be a grid of em-dashes.
  if (!state.loaded) return clear('Load a date range to compare periods.');
  if (state.trend.mode === 'custom' && !state.trend.range) {
    return clear('Pick both ends of the period you want to compare against.');
  }
  if (state.trend.loading) {
    setStatus(`Loading ${windowLabel(state.trend.range)}…`);
    noteEl.classList.add('hidden');
    return;
  }
  if (state.trend.error) return clear(state.trend.error);

  const baseline = state.trend.previous;
  const baselineEvents = state.trend.previousEvents;
  if (!baseline || !baselineEvents) return clear('No comparison loaded yet.');

  const currentWindow = currentPrimaryWindow();
  const baseWindow = state.trend.range;
  if (!currentWindow) return clear('Pick both ends of this period.');

  // A pinned left column has its own fetched events; otherwise the comparison
  // reads the same rows every other view is showing.
  const currentEvents = hasPrimaryOverride() ? state.trend.primaryEvents : state.filtered;
  if (hasPrimaryOverride() && !currentEvents) return clear('Loading this period…');

  setStatus('');
  const current = summarize(currentEvents);

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
  const costNoun = costModeNoun();

  const head = (which, label, window, days) => `
    <th scope="col">
      <span class="compare-col-label">${esc(label)}</span>
      <button type="button" class="compare-window-btn" data-edit-window="${which}"
        title="Click to set this period's dates">${esc(windowLabel(window))}</button>
      <span class="compare-col-days">${fmt.num(days)} day${days === 1 ? '' : 's'}${which === 'current' && hasPrimaryOverride() ? ' · pinned' : ''}</span>
    </th>`;

  bodyEl.innerHTML = `
    <table class="compare-table">
      <thead>
        <tr>
          <th scope="col"></th>
          ${head('current', 'This period', currentWindow, curDays)}
          ${head('baseline', 'Compared with', baseWindow, baseDays)}
          <th scope="col">Change</th>
        </tr>
      </thead>
      <tbody>
        ${compareMetricRow(`Total ${costNoun}`, current.totalCost, baseline.totalCost)}
        ${compareMetricRow('Requests', current.count, baseline.count, fmt.num)}
        ${compareMetricRow('Avg / request', current.avg ?? 0, baseline.avg ?? 0)}
        ${compareMetricRow('Avg / day', current.totalCost / curDays, baseline.totalCost / baseDays)}
        ${compareMetricRow('Requests / day', current.count / curDays, baseline.count / baseDays, fmt.rate)}
        ${compareMetricRow('Cache savings', current.totalSavings, baseline.totalSavings, fmt.money, 'up')}
        ${compareMetricRow('Cache hit rate', cacheHitRate(currentEvents), cacheHitRate(baselineEvents), fmt.pct, 'up')}
      </tbody>
    </table>

    ${renderModelDeltaTable(currentEvents, baselineEvents, {
      currentLabel: windowLabel(currentWindow),
      baselineLabel: windowLabel(baseWindow),
    })}`;

  // Caveats that make an honest reading possible. Both are artefacts of the
  // windows, not of the usage, and both have burned readers of the ▲/▼ badge
  // that this panel exists to explain.
  const notes = [];
  if (currentWindow.endMs > Date.now()) {
    notes.push('This period includes today, which isn\'t over yet — expect it to look lower than a comparison period of whole days.');
  }
  if (curDays !== baseDays) {
    notes.push(`The two periods aren't the same length (${fmt.num(curDays)} vs ${fmt.num(baseDays)} days) — compare the per-day rows rather than the totals.`);
  }
  if (hasPrimaryOverride()) {
    notes.push('This comparison uses its own periods, so the date range in the toolbar above does not apply to it.');
  }
  noteEl.textContent = notes.join(' ');
  noteEl.classList.toggle('hidden', !notes.length);
}

/** Share of tokens served from cache — the lever behind most cost changes. */
function cacheHitRate(events) {
  const t = events.reduce((acc, e) => {
    acc.cacheRead += e.cacheReadTokens || 0;
    acc.total += (e.inputTokens || 0) + (e.outputTokens || 0) + (e.cacheReadTokens || 0) + (e.cacheWriteTokens || 0);
    return acc;
  }, { cacheRead: 0, total: 0 });
  return t.total > 0 ? (t.cacheRead / t.total) * 100 : 0;
}

/**
 * Which models account for the difference.
 *
 * Cost alone can't tell "I used it more" from "each call got dearer", so the
 * requests and the per-request average sit beside it — the three together name
 * the cause rather than just the symptom.
 *
 * Takes labels rather than date windows because it serves two callers now: two
 * periods, where a model appearing on one side only really has started or
 * stopped, and two sessions, where it just means the two conversations reached
 * for different models. Same table, different words for the same shape — hence
 * `tagNew`/`tagGone`.
 */
function renderModelDeltaTable(currentEvents, baselineEvents, opts) {
  const {
    currentLabel,
    baselineLabel,
    heading = 'What moved, by model',
    tagNew = 'new',
    tagGone = 'stopped',
    betterWhen = 'down',
    // The sessions dialog's two-column comparison reuses this table wholesale
    // for its model breakdown, and needs it to carry the same alignment and
    // sticky-header rules as the metrics table above it — rules scoped to
    // that class so the period comparison (this function's other caller)
    // isn't affected.
    extraClass = '',
  } = opts;
  const curCost = Object.fromEntries(costByModel(currentEvents));
  const baseCost = Object.fromEntries(costByModel(baselineEvents));
  const countBy = (events) => events.reduce((m, e) => {
    if (e.counted !== false) m[e.model] = (m[e.model] || 0) + 1;
    return m;
  }, {});
  const curCount = countBy(currentEvents);
  const baseCount = countBy(baselineEvents);
  const deltas = modelCostDeltas(curCost, baseCost);
  if (!deltas.length) return '';

  const rows = deltas.map((d) => {
    const cN = curCount[d.model] || 0;
    const bN = baseCount[d.model] || 0;
    const cAvg = cN ? d.current / cN : 0;
    const bAvg = bN ? d.baseline / bN : 0;
    const tag = d.baseline === 0
      ? ` <span class="compare-tag">${esc(tagNew)}</span>`
      : d.current === 0 ? ` <span class="compare-tag compare-tag-gone">${esc(tagGone)}</span>` : '';
    // Rows that didn't move are kept for completeness but stop competing for
    // attention with the ones that did.
    const quiet = Math.abs(d.delta) < 0.005 ? ' class="compare-row-quiet"' : '';
    return `<tr${quiet}>
        <th scope="row">${esc(d.model)}${tag}${rangeDiscountBadge(d.model)}</th>
        <td>${fmt.money(d.current)}<span class="compare-sub">${fmt.num(cN)} req · ${fmt.money(cAvg)}/req</span></td>
        <td>${fmt.money(d.baseline)}<span class="compare-sub">${fmt.num(bN)} req · ${fmt.money(bAvg)}/req</span></td>
        <td>${deltaCell(d.current, d.baseline, fmt.money, betterWhen)}</td>
      </tr>`;
  }).join('');

  return `
    <h4 class="compare-subhead">${esc(heading)}</h4>
    <table class="compare-table compare-models${extraClass ? ` ${esc(extraClass)}` : ''}">
      <thead>
        <tr>
          <th scope="col">Model</th>
          <th scope="col">${esc(currentLabel)}</th>
          <th scope="col">${esc(baselineLabel)}</th>
          <th scope="col">Change</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

/** The inline from/to editor, aimed at whichever column was clicked. */
function renderCompareEditor() {
  const editor = $('compareEditor');
  if (!editor) return;
  const target = state.trend.editing;
  editor.classList.toggle('hidden', !target);
  if (!target) return;

  const isCurrent = target === 'current';
  $('compareEditorLabel').textContent = isCurrent ? 'This period' : 'Compared with';
  const window = isCurrent ? currentPrimaryWindow() : state.trend.range;
  if (window) {
    $('compareEditStart').value = toDateInputValue(new Date(window.startMs));
    $('compareEditEnd').value = toDateInputValue(new Date(window.endMs));
  }
  // Resetting the left column hands it back to the filter bar; resetting the
  // right one hands it back to the "previous period" default.
  $('compareEditReset').textContent = isCurrent ? 'Follow the filter bar' : 'Use previous period';
  $('compareEditReset').classList.toggle(
    'hidden',
    isCurrent ? !hasPrimaryOverride() : state.trend.mode === 'previous',
  );
}

function openCompareEditor(target) {
  state.trend.editing = state.trend.editing === target ? null : target;
  renderCompareEditor();
}

function applyCompareEditor() {
  const start = $('compareEditStart').value;
  const end = $('compareEditEnd').value;
  if (!start || !end) return;
  if (toMs(start) > toMs(end, true)) {
    showAlert('error', 'The "From" date is after the "To" date — pick a valid range.');
    return;
  }
  if (state.trend.editing === 'current') {
    state.trend.primaryStart = start;
    state.trend.primaryEnd = end;
  } else {
    state.trend.mode = 'custom';
    state.trend.customStart = start;
    state.trend.customEnd = end;
  }
  state.trend.editing = null;
  saveComparePrefs();
  renderComparison();
  void loadTrendComparison();
}

function resetCompareEditor() {
  if (state.trend.editing === 'current') {
    state.trend.primaryStart = '';
    state.trend.primaryEnd = '';
  } else {
    state.trend.mode = 'previous';
  }
  state.trend.editing = null;
  saveComparePrefs();
  renderComparison();
  void loadTrendComparison();
}

function saveComparePrefs() {
  savePrefs({
    compareMode: state.trend.mode,
    compareStart: state.trend.customStart,
    compareEnd: state.trend.customEnd,
    comparePrimaryStart: state.trend.primaryStart,
    comparePrimaryEnd: state.trend.primaryEnd,
  });
}
// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

const SESSION_PAGE_SIZES = [20, 50, 100];

/**
 * How many sessions can be compared at once.
 *
 * Comparison tables stop being scannable past a handful of columns — the
 * guidance is to keep it to about five and make users narrow down first, which
 * the filter and the sort above are there to do. Four columns plus the row
 * labels also still fits without horizontal scrolling.
 */
const MAX_COMPARE_SESSIONS = 4;

/** The loaded requests belonging to one session. */
function eventsForSession(sessionId) {
  return state.filtered.filter((e) => (e.conversationId || UNATTRIBUTED_SESSION) === sessionId);
}

/**
 * Conversation ids are uuids: unreadable at full length, and alike enough at
 * the front that a plain truncation would print two different sessions
 * identically. Keeping both ends is what makes the rows tell each other apart.
 */
function shortSessionId(id) {
  if (id === UNATTRIBUTED_SESSION) return 'Unattributed';
  return id.length > 16 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/**
 * How a session is named on screen: the name Cursor gave the conversation
 * where we could find one, the shortened id where we couldn't.
 *
 * `isId` travels with it because the two want different typography — a uuid
 * needs the monospace treatment that makes its characters distinguishable, and
 * a sentence very much does not.
 */
function sessionLabel(id) {
  const title = state.sessions.titles.get(id);
  return title ? { text: title, isId: false } : { text: shortSessionId(id), isId: true };
}

/**
 * Asks the extension host to name the conversations on screen.
 *
 * Only for ids we haven't already resolved or asked about, and only for what's
 * actually rendered — the names come out of a local database that can be
 * several gigabytes, so this stays a small, bounded lookup rather than an
 * upfront index of every session in the period.
 */
async function loadSessionTitles(ids) {
  const { titles, titlesPending } = state.sessions;
  const wanted = ids.filter(
    (id) => id !== UNATTRIBUTED_SESSION && !titles.has(id) && !titlesPending.has(id),
  );
  if (!wanted.length) return;
  wanted.forEach((id) => titlesPending.add(id));

  let found = {};
  try {
    found = (await rpc('sessionTitles', { ids: wanted })).titles || {};
  } catch {
    // A missing database, no sqlite3 on PATH, a Cursor version that stores its
    // chats elsewhere: all of them just mean the ids stay on screen, which is
    // what they already say. Not worth an alert, and the extension host has
    // already logged the reason.
  }

  // Ids that came back unnamed are recorded as null rather than left out, so
  // the next render doesn't ask for them all over again.
  let learned = false;
  for (const id of wanted) {
    titlesPending.delete(id);
    const title = found[id] || null;
    if (!titles.has(id)) {
      titles.set(id, title);
      if (title) learned = true;
    }
  }
  if (learned && state.appView === 'analyze' && state.analyzePanel === 'sessions') renderSessions();
}

function fmtDuration(ms) {
  if (!ms || ms < 60 * 1000) return '<1 min';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

/**
 * Clicking a column sorts by it; clicking the one already sorted reverses it.
 *
 * A fresh column starts in the direction its data is usually read — biggest
 * cost, longest, most recent first — rather than always ascending, which would
 * put the cheapest sessions on top of a panel about where the money went.
 */
function setSessionSort(key) {
  const sessions = state.sessions;
  if (sessions.sortKey === key) {
    sessions.sortDir = sessions.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    sessions.sortKey = key;
    sessions.sortDir = SESSION_SORT_DEFAULT_DIR[key] || 'desc';
  }
  sessions.page = 1;
  savePrefs({ sessionSortKey: sessions.sortKey, sessionSortDir: sessions.sortDir });
  renderSessions();
}

function toggleSessionSelected(id) {
  const sessions = state.sessions;
  const at = sessions.selected.indexOf(id);
  if (at >= 0) {
    sessions.selected.splice(at, 1);
    if (sessions.baseId === id) sessions.baseId = sessions.selected[0] ?? null;
  } else {
    if (sessions.selected.length >= MAX_COMPARE_SESSIONS) {
      showAlert('info', `You can compare up to ${MAX_COMPARE_SESSIONS} sessions at once — clear one first.`);
      return;
    }
    sessions.selected.push(id);
    if (!sessions.baseId) sessions.baseId = id;
  }
  renderSessions();
  // The dialog stays truthful if a session is added or dropped behind it.
  if ($('sessionsDialog')?.open) renderSessionCompare();
}

function clearSessionSelection() {
  state.sessions.selected = [];
  state.sessions.baseId = null;
  $('sessionsDialog')?.close();
  renderSessions();
}

/**
 * The requests of the selected period, grouped by the conversation they came
 * from, with any two to four of them comparable side by side.
 *
 * Scoped to the filter bar deliberately: "pick the dates, then pick from the
 * sessions in them" is the flow, and a second date control here would ask the
 * same question the toolbar already answers.
 */
function renderSessions() {
  const panel = $('sessionsPanel');
  if (!panel) return;

  const statusEl = $('sessionsStatus');
  const summaryEl = $('sessionsSummary');
  const listEl = $('sessionsList');
  const pagerEl = $('sessionsPager');
  const noteEl = $('sessionsNote');

  // The filter only makes sense with a list under it — on an empty period, or
  // on an account whose requests carry no conversation id, it's a control that
  // can't do anything.
  const search = $('sessionSearch')?.closest('.sessions-search');
  const clear = (text) => {
    statusEl.textContent = text || '';
    statusEl.classList.toggle('hidden', !text);
    summaryEl.innerHTML = '';
    listEl.innerHTML = '';
    pagerEl.innerHTML = '';
    noteEl.classList.add('hidden');
    search?.classList.add('hidden');
    renderSessionTray([]);
  };

  if (!state.loaded) return clear('Load a date range to see the sessions in it.');
  if (!state.filtered.length) return clear('No requests in this period, so there are no sessions to show.');

  const totals = sessionTotals(state.filtered);
  const summary = sessionSummary(totals);
  const sessions = totals.filter((t) => t.sessionId !== UNATTRIBUTED_SESSION);

  // Nothing came back with a conversation id. Say which half is missing rather
  // than showing an empty table, which reads as "you had no sessions" when what
  // happened is that the requests couldn't be attributed to any.
  if (!sessions.length) {
    return clear(`None of the ${fmt.num(summary.unattributedRequests)} requests in this period `
      + 'came with a conversation id, so they can\'t be grouped into sessions. Cursor only reports one '
      + 'on some plans and API versions — everything else on this tab is unaffected.');
  }

  statusEl.classList.add('hidden');
  search?.classList.remove('hidden');

  // A selection made in another range points at sessions that aren't here any
  // more; keeping it would leave a comparison of blanks on screen.
  const present = new Set(sessions.map((t) => t.sessionId));
  state.sessions.selected = state.sessions.selected.filter((id) => present.has(id));
  if (!state.sessions.selected.includes(state.sessions.baseId)) {
    state.sessions.baseId = state.sessions.selected[0] ?? null;
  }

  const costNoun = costModeNoun();
  const top = summary.topSession;
  summaryEl.innerHTML = `
    <div class="kpi-strip">
      <article class="kpi">
        <span class="kpi-label">Sessions</span>
        <span class="kpi-value">${fmt.num(summary.sessions)}</span>
        <span class="kpi-sub">in the selected period</span>
      </article>
      <article class="kpi kpi-primary">
        <span class="kpi-label">${esc(costNoun)} / session</span>
        <span class="kpi-value">${fmt.money(summary.costPerSession)}</span>
        <span class="kpi-sub">average across ${fmt.num(summary.sessions)}</span>
      </article>
      <article class="kpi">
        <span class="kpi-label">Requests / session</span>
        <span class="kpi-value">${fmt.rate(summary.requestsPerSession)}</span>
        <span class="kpi-sub">average</span>
      </article>
      <article class="kpi">
        <span class="kpi-label">Most expensive</span>
        <span class="kpi-value">${fmt.money(top ? top.costDollars : null)}</span>
        <span class="kpi-sub">${top ? esc(sessionLabel(top.sessionId).text) : '—'}</span>
      </article>
    </div>`;

  // Share is against the whole period, unattributed requests included, so the
  // percentages answer "how much of my bill was this" rather than "how much of
  // the part we could attribute".
  const periodCost = totals.reduce((s, t) => s + t.costDollars, 0);
  renderSessionList(listEl, pagerEl, sessions, periodCost);
  renderSessionTray(sessions);

  const notes = [];
  if (summary.unattributedRequests > 0) {
    notes.push(`${fmt.num(summary.unattributedRequests)} request${summary.unattributedRequests === 1 ? '' : 's'} `
      + 'in this period carried no conversation id and are not listed above, so the session totals '
      + 'add up to less than the period total.');
  }
  notes.push('Sessions are grouped by the conversation id on each request. Only the dates in the toolbar '
    + 'above scope this list.');
  noteEl.textContent = notes.join(' ');
  noteEl.classList.remove('hidden');
}

function renderSessionList(root, pagerRoot, sessions, periodCost) {
  const query = state.sessions.query;
  const titleOf = (id) => state.sessions.titles.get(id);
  const matches = filterSessions(sessions, query, titleOf);

  if (!matches.length) {
    root.innerHTML = `<p class="compare-empty">No session matches “${esc(query)}”.</p>`;
    pagerRoot.innerHTML = '';
    return;
  }

  // Sorted before paging, so "show me the longest" reaches the whole period
  // rather than reordering one page of it.
  const sorted = sortSessions(matches, state.sessions.sortKey, state.sessions.sortDir, titleOf);
  const pageSize = state.sessions.pageSize;
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  // A filter or a sort can leave the current page past the end of the list.
  const page = Math.min(Math.max(1, state.sessions.page), pages);
  state.sessions.page = page;
  const from = (page - 1) * pageSize;
  const shown = sorted.slice(from, from + pageSize);

  // Models is the one column with no sort: a session's models are a set, and
  // ordering rows by "claude before gpt" answers nothing anyone asks.
  const sortHead = (key, label) => {
    const active = state.sessions.sortKey === key;
    const cls = active ? ` sorted-${state.sessions.sortDir}` : '';
    const aria = active ? (state.sessions.sortDir === 'asc' ? 'ascending' : 'descending') : 'none';
    return `<th scope="col" class="session-sort${cls}" data-session-sort="${key}" aria-sort="${aria}">
        <button type="button" class="session-sort-btn">${esc(label)}</button>
      </th>`;
  };

  const rows = shown.map((t) => {
    const m = sessionMetrics(t);
    const slot = state.sessions.selected.indexOf(t.sessionId);
    const picked = slot >= 0;
    const name = sessionLabel(t.sessionId);
    return `<tr data-session-id="${esc(t.sessionId)}"${picked ? ' class="session-row-picked"' : ''}>
        <td class="session-pick">
          <input type="checkbox" data-session-id="${esc(t.sessionId)}"${picked ? ' checked' : ''}
            aria-label="Compare session ${esc(name.text)}" />
          ${picked ? `<span class="session-slot">${SESSION_SLOTS[slot]}</span>` : ''}
        </td>
        <th scope="row" class="session-name${name.isId ? ' is-id' : ''}" title="${esc(t.sessionId)}">${esc(name.text)}</th>
        <td>${esc(fmt.date(t.firstMs))}</td>
        <td>${esc(fmtDuration(m.durationMs))}</td>
        <td>${fmt.num(t.requests)}${t.erroredRequests
          ? `<span class="compare-sub">+${fmt.num(t.erroredRequests)} errored</span>` : ''}</td>
        <td>${fmt.money(t.costDollars)}<span class="compare-sub">${fmt.money(m.costPerRequest)}/req${
          periodCost > 0 ? ` · ${fmt.pct((t.costDollars / periodCost) * 100)} of period` : ''}</span></td>
        <td class="session-models">${t.models.slice(0, 3).map((x) => esc(displayModel(x))).join(', ')}${t.models.length > 3 ? ` +${t.models.length - 3}` : ''}</td>
      </tr>`;
  }).join('');

  root.innerHTML = `
    <div class="table-scroll">
      <table class="compare-table sessions-table">
        <thead>
          <tr>
            <th scope="col"><span class="sr-only">Compare</span></th>
            ${sortHead('name', 'Session')}
            ${sortHead('started', 'Started')}
            ${sortHead('duration', 'Active for')}
            ${sortHead('requests', 'Requests')}
            ${sortHead('cost', costModeNoun())}
            <th scope="col">Models</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;

  pagerRoot.innerHTML = `
    <div class="sessions-pager">
      <span class="pager-range">${fmt.num(from + 1)}–${fmt.num(from + shown.length)} of ${fmt.num(sorted.length)}</span>
      <label class="pager-size">
        <span>Per page</span>
        <select id="sessionPageSize">
          ${SESSION_PAGE_SIZES.map((n) => `<option value="${n}"${n === pageSize ? ' selected' : ''}>${n}</option>`).join('')}
        </select>
      </label>
      <div class="pager-nav">
        <button type="button" class="btn" data-session-page="prev"${page <= 1 ? ' disabled' : ''}>Previous</button>
        <span class="pager-count">Page ${fmt.num(page)} of ${fmt.num(pages)}</span>
        <button type="button" class="btn" data-session-page="next"${page >= pages ? ' disabled' : ''}>Next</button>
      </div>
    </div>`;

  // Only what's on screen, plus whatever is selected — a selected session can
  // be paged past or filtered away, and it's named in the tray regardless.
  void loadSessionTitles([...shown.map((t) => t.sessionId), ...state.sessions.selected]);
}

/** Column letters, so a picked row and its column carry the same handle. */
const SESSION_SLOTS = ['A', 'B', 'C', 'D'];

/**
 * The selection tray: what's picked, and the way into the comparison.
 *
 * Pinned to the bottom of the view because it is the feedback for a click that
 * can happen anywhere in a long list. Its chips are removable, so a session
 * picked by accident can be dropped without hunting for its row again.
 */
function renderSessionTray(sessions) {
  const tray = $('sessionsTray');
  if (!tray) return;
  const selected = state.sessions.selected;
  tray.classList.toggle('hidden', selected.length === 0);
  if (!selected.length) return;

  $('trayChips').innerHTML = selected.map((id, i) => {
    const name = sessionLabel(id);
    const total = sessions.find((t) => t.sessionId === id);
    return `<span class="tray-chip">
        <span class="session-slot">${SESSION_SLOTS[i]}</span>
        <span class="tray-chip-name${name.isId ? ' is-id' : ''}" title="${esc(id)}">${esc(name.text)}</span>
        ${total ? `<span class="tray-chip-cost">${fmt.money(total.costDollars)}</span>` : ''}
        <button type="button" class="tray-chip-drop" data-drop-session="${esc(id)}"
          aria-label="Remove ${esc(name.text)} from the comparison">×</button>
      </span>`;
  }).join('');

  const enough = selected.length >= 2;
  $('trayCount').textContent = enough
    ? `${selected.length} selected`
    : 'Pick one more to compare';
  $('trayCompare').disabled = !enough;
}

// ---------------------------------------------------------------------------
// Session comparison (dialog)
// ---------------------------------------------------------------------------

/**
 * One definition of every comparable figure, used for both the two-column and
 * the many-column layouts.
 *
 * `betterWhen` says whether a direction exists at all. Cheaper, better-cached
 * and fewer cold starts are wins whichever session they belong to; requests,
 * tokens and pace only say how big a session was, so they are marked
 * 'neither' and highlighted as extremes rather than judged.
 */
function sessionMetricDefs() {
  const noun = costModeNoun();
  return [
    { label: `Total ${noun}`, value: (c) => c.m.costDollars, format: fmt.money, betterWhen: 'down' },
    { label: 'Requests', value: (c) => c.m.requests, format: fmt.num, betterWhen: 'neither' },
    {
      label: 'Errored or aborted',
      value: (c) => c.t.erroredRequests,
      format: fmt.num,
      betterWhen: 'down',
      // A row of zeroes on every comparison is noise; it earns its place only
      // when something actually errored.
      when: (ctxs) => ctxs.some((c) => c.t.erroredRequests > 0),
    },
    { label: 'Avg / request', value: (c) => c.m.costPerRequest, format: fmt.money, betterWhen: 'down' },
    { label: 'Priciest request', value: (c) => c.t.maxCostDollars, format: fmt.money, betterWhen: 'down' },
    { label: 'Active for', value: (c) => c.m.durationMs, format: fmtDuration, betterWhen: 'neither' },
    { label: 'Requests / hour', value: (c) => c.m.requestsPerHour, format: fmt.rate, betterWhen: 'neither' },
    { label: `${noun} / hour`, value: (c) => c.m.costPerHour, format: fmt.money, betterWhen: 'down' },
    {
      label: 'Tokens',
      value: (c) => c.m.totalTokens,
      format: fmt.num,
      betterWhen: 'neither',
      // Cached tokens are named rather than left implicit: on a well-cached
      // session they are most of the total, and the in/out figures alone read
      // as an arithmetic error against it.
      sub: (c) => `${fmt.num(c.t.inputTokens)} in · ${fmt.num(c.t.outputTokens)} out · `
        + `${fmt.num(c.t.cacheReadTokens + c.t.cacheWriteTokens)} cached`,
    },
    { label: 'Cache hit rate', value: (c) => c.m.cacheHitRate, format: fmt.pct, betterWhen: 'up' },
    { label: 'Cache savings', value: (c) => c.t.savingsDollars, format: fmt.money, betterWhen: 'up' },
    { label: 'Cold starts', value: (c) => c.coldStarts, format: fmt.num, betterWhen: 'down' },
  ];
}

/** Everything one column of the comparison needs, gathered once. */
function sessionCompareContext(sessionId, sessions) {
  const t = sessions.find((s) => s.sessionId === sessionId);
  if (!t) return null;
  const events = eventsForSession(sessionId);
  return {
    id: sessionId,
    t,
    m: sessionMetrics(t),
    events,
    coldStarts: events.filter(
      (e) => e.cacheReadTokens === 0 && e.inputTokens > state.analyzeThresholds.coldStartInputTokens,
    ).length,
  };
}

function openSessionCompare() {
  const dialog = $('sessionsDialog');
  if (!dialog || state.sessions.selected.length < 2) return;
  renderSessionCompare();
  if (!dialog.open) dialog.showModal();
}

/**
 * Whether a row's values are all the same once rounded to what's displayed.
 *
 * Judged at display precision for the same reason the delta cells are: a row
 * reading "$0.07, $0.07" is not a difference worth keeping on screen when the
 * user has asked to see only what differs.
 */
function sameAcross(def, ctxs) {
  const shown = ctxs.map((c) => {
    const v = def.value(c);
    return v == null ? '—' : def.format(v);
  });
  return shown.every((v) => v === shown[0]);
}

/**
 * Marks the best and worst value in a row.
 *
 * With three or more columns there is no single "difference" to report, so the
 * comparison happens down each row instead: the extremes carry the colour and
 * everything between them stays plain, which is what makes a wide table
 * scannable. Where a metric has no better direction, most is amber and least
 * is green purely as a high/low marker.
 */
function extremeClasses(def, ctxs) {
  const values = ctxs.map((c) => def.value(c));
  const present = values.filter((v) => v != null);
  if (present.length < 2) return values.map(() => '');
  const max = Math.max(...present);
  const min = Math.min(...present);
  if (def.format(max) === def.format(min)) return values.map(() => '');
  const highClass = def.betterWhen === 'up' ? 'cell-good' : 'cell-bad';
  const lowClass = def.betterWhen === 'up' ? 'cell-bad' : 'cell-good';
  return values.map((v) => {
    if (v == null) return '';
    if (v === max) return highClass;
    if (v === min) return lowClass;
    return '';
  });
}

function renderSessionCompare() {
  const body = $('sessionsDialogBody');
  if (!body) return;

  const sessions = sessionTotals(state.filtered).filter((t) => t.sessionId !== UNATTRIBUTED_SESSION);
  const ctxs = state.sessions.selected
    .map((id) => sessionCompareContext(id, sessions))
    .filter(Boolean);

  if (ctxs.length < 2) {
    body.innerHTML = '<p class="compare-empty">Pick at least two sessions to compare.</p>';
    return;
  }

  // Two columns need no base: the left one is the reference, the way the period
  // comparison reads, and the Difference column names its own direction. A base
  // only earns its keep once there are too many columns for a single delta.
  const pair = ctxs.length === 2;
  const baseIndex = pair ? 0 : Math.max(0, ctxs.findIndex((c) => c.id === state.sessions.baseId));
  $('sessionsDialogDesc').textContent = pair
    ? 'Two sessions side by side, with what separates them.'
    : `${ctxs.length} sessions. The best and worst figure in each row is highlighted, `
      + 'and every column says how it differs from the base — pick a different base to re-read them all against it.';

  const defs = sessionMetricDefs().filter((d) => !d.when || d.when(ctxs));
  const visible = state.sessions.diffOnly ? defs.filter((d) => !sameAcross(d, ctxs)) : defs;

  const head = ctxs.map((c, i) => {
    const name = sessionLabel(c.id);
    const isBase = !pair && i === baseIndex;
    const baseBtn = pair ? '' : `<button type="button" class="compare-base-btn${isBase ? ' active' : ''}"
        data-base-session="${esc(c.id)}" aria-pressed="${isBase ? 'true' : 'false'}"
        >${isBase ? 'Base' : 'Set as base'}</button>`;
    return `<th scope="col" class="${isBase ? 'compare-col-base' : ''}">
        <span class="compare-col-label">${SESSION_SLOTS[i]}${isBase ? ' · base' : ''}</span>
        <span class="compare-col-range${name.isId ? ' is-id' : ''}" title="${esc(c.id)}">${esc(name.text)}</span>
        <span class="compare-col-days">${esc(fmt.date(c.t.firstMs))}</span>
        ${baseBtn}
      </th>`;
  }).join('');

  const rows = visible.map((def) => {
    const marks = pair ? ctxs.map(() => '') : extremeClasses(def, ctxs);
    const base = def.value(ctxs[baseIndex]);
    const cells = ctxs.map((c, i) => {
      const v = def.value(c);
      const shown = v == null ? '—' : def.format(v);
      const sub = def.sub ? `<span class="compare-sub">${def.sub(c)}</span>` : '';
      // Every non-base column says how it stands against the base, which is
      // what the base is for once the Difference column is gone.
      const vsBase = !pair && i !== baseIndex && v != null && base != null && def.format(v) !== def.format(base)
        ? `<span class="compare-sub">${deltaCell(v, base, def.format, 'neither')} vs ${SESSION_SLOTS[baseIndex]}</span>`
        : '';
      return `<td class="${marks[i]}">${shown}${sub}${vsBase}</td>`;
    }).join('');

    // With two columns the difference is the point of the table, so it keeps
    // its own column and its colour. Always A against B, in that order, so the
    // sign means the same thing on every row.
    const diff = pair
      ? `<td>${(() => {
        const a = def.value(ctxs[0]);
        const b = def.value(ctxs[1]);
        return a == null || b == null ? '—' : deltaCell(a, b, def.format, def.betterWhen);
      })()}</td>`
      : '';

    return `<tr><th scope="row">${esc(def.label)}</th>${cells}${diff}</tr>`;
  }).join('');

  const emptyNote = visible.length
    ? ''
    : '<p class="compare-empty">These sessions match on every figure shown.</p>';

  body.innerHTML = `
    <div class="sessions-dialog-scroll">
      <table class="compare-table sessions-compare-table">
        <thead>
          <tr>
            <th scope="col"></th>
            ${head}
            ${pair ? `<th scope="col">
              <span class="compare-col-label">Difference</span>
              <span class="compare-col-days">A against B</span>
            </th>` : ''}
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${emptyNote}
      ${renderSessionModelTable(ctxs, baseIndex, pair)}
    </div>`;
}

/**
 * Which models each session used.
 *
 * Two sessions get the delta table the period comparison uses; more than two
 * get a straight matrix, since a column of deltas against a base repeated four
 * times is a worse read than the costs themselves with the extremes marked.
 */
function renderSessionModelTable(ctxs, baseIndex, pair) {
  if (pair) {
    // Same column order and the same direction as the table above it.
    return renderModelDeltaTable(ctxs[0].events, ctxs[1].events, {
      currentLabel: 'Session A',
      baselineLabel: 'Session B',
      heading: 'Which models each session used',
      tagNew: 'only in A',
      tagGone: 'only in B',
      extraClass: 'sessions-compare-table',
    });
  }

  const costs = ctxs.map((c) => Object.fromEntries(costByModel(c.events)));
  const models = [...new Set(costs.flatMap((byModel) => Object.keys(byModel)))];
  if (!models.length) return '';
  // Biggest spend across all the sessions first — the model that explains the
  // most of what's on screen leads.
  models.sort((a, b) => costs.reduce((s, c) => s + (c[b] || 0), 0) - costs.reduce((s, c) => s + (c[a] || 0), 0));

  const rows = models.map((model) => {
    const values = costs.map((byModel) => byModel[model] || 0);
    const used = values.filter((v) => v > 0);
    const max = Math.max(...values);
    const min = Math.min(...values);
    const cells = values.map((v) => {
      // A model one session never touched is a blank, not a $0.00 to compare:
      // "didn't use it" and "used it for nothing" are different statements.
      if (v === 0) return '<td class="cell-absent">—</td>';
      const cls = used.length < 2 || fmt.money(max) === fmt.money(min) ? ''
        : v === max ? 'cell-bad' : v === min ? 'cell-good' : '';
      return `<td class="${cls}">${fmt.money(v)}</td>`;
    }).join('');
    return `<tr><th scope="row">${esc(model)}</th>${cells}</tr>`;
  }).join('');

  return `
    <h4 class="compare-subhead">Which models each session used</h4>
    <table class="compare-table compare-models sessions-compare-table">
      <thead>
        <tr>
          <th scope="col">Model</th>
          ${ctxs.map((c, i) => `<th scope="col">${SESSION_SLOTS[i]}</th>`).join('')}
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
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
  const { mode, customStart, customEnd, primaryStart, primaryEnd } = state.trend;
  const primary = hasPrimaryOverride() ? `${primaryStart}..${primaryEnd}` : `${$('startDate').value}|${$('endDate').value}`;
  return `${primary}|${$('modelFilter').value}|${state.costMode}`
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
      <td>${esc(e.model)}${discountBadge(discountForEvent(e.modelRaw, e.timestampMs))}</td>
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

/** Findings, period comparison or sessions — the views on the Analyze tab. */
function setAnalyzePanel(panel) {
  state.analyzePanel = panel;
  document.querySelectorAll(ANALYZE_TAB_SELECTOR).forEach((tab) => {
    const active = tab.dataset.analyzePanel === panel;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  // One place decides which of the boxes (empty note, findings, comparison,
  // sessions) is visible, so a sub-tab switch can't leave two of them up.
  renderAnalyze();
}

/** True when the left column has been pinned to its own dates. */
function hasPrimaryOverride() {
  return Boolean(state.trend.primaryStart && state.trend.primaryEnd);
}

/**
 * The left column's window: its own dates when pinned, otherwise whatever the
 * filter bar is showing.
 */
function currentPrimaryWindow() {
  if (hasPrimaryOverride()) {
    return { startMs: toMs(state.trend.primaryStart), endMs: toMs(state.trend.primaryEnd, true) };
  }
  const startStr = $('startDate').value;
  const endStr = $('endDate').value;
  if (!startStr || !endStr) return null;
  return { startMs: toMs(startStr), endMs: toMs(endStr, true) };
}

/** The baseline window for the current selection, or null if it can't be resolved. */
function currentBaselineWindow() {
  const primary = currentPrimaryWindow();
  if (!primary) return null;
  return comparisonWindow({
    startMs: primary.startMs,
    endMs: primary.endMs,
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
  state.trend.primaryEvents = null;
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

  // A pinned left column is no longer the range the rest of the dashboard
  // loaded, so it needs fetching too. Both windows go out together.
  const primary = hasPrimaryOverride() ? currentPrimaryWindow() : null;

  try {
    const load = async (w) => {
      const usage = await rpc('usage', { startDate: w.startMs, endDate: w.endMs });
      const normOpts = { freePlan: isFreePlan() };
      let events = (usage.events || []).map((raw) => normalize(raw, state.pricing, normOpts));
      if (modelVal) events = events.filter((e) => e.modelRaw === modelVal);
      return applyCostMode(events);
    };
    const [baselineEvents, primaryEvents] = await Promise.all([
      load(window),
      primary ? load(primary) : Promise.resolve(null),
    ]);
    if (state.trend.key !== key) return; // superseded by a newer request
    state.trend.previousEvents = baselineEvents;
    state.trend.previous = summarize(baselineEvents);
    state.trend.primaryEvents = primaryEvents;
  } catch (e) {
    if (state.trend.key !== key) return;
    state.trend.previous = null;
    state.trend.previousEvents = null;
    state.trend.primaryEvents = null;
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
  // Once the comparison's left column is pinned, its baseline belongs to that
  // pinned window rather than to the range this card is showing — the two
  // totals are no longer about the same period, so there is no honest delta to
  // put here. The Compare tab keeps its own, correctly paired, figures.
  const comparable = !hasPrimaryOverride() && state.trend.key === currentTrendKey();
  const badge = comparable && state.trend.previous
    ? trendBadge(summary.totalCost, state.trend.previous.totalCost)
    : '';
  // The badge poses a question it can't answer on its own — against what, and
  // because of what — so it links to the view that does.
  const trend = badge
    ? `${badge}<button type="button" class="btn-link-inline compare-link" data-goto-compare>Compare periods →</button>`
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

  // The "Current plan" chip is a fact about the account, not about whatever
  // range is on screen, so it's checked against this calendar month's own
  // events rather than the selected range — see applyPlanChangeResult(). Once
  // per month (effectively once per session): the reentrant load() below from
  // an auto-switch already has planCheckMonthKey set, so it skips this.
  const monthKey = currentMonthKey();
  const needsMonthCheck = state.planCheckMonthKey !== monthKey;
  // "Month to date" already requests exactly this window, so there's nothing
  // to check that the main fetch won't already have — asking twice would be
  // exactly the kind of redundant request an earlier round of this trimmed out.
  const monthIsSelectedRange = needsMonthCheck && state.datePreset === 'mtd';
  const monthWindow = needsMonthCheck && !monthIsSelectedRange ? getRangeForPreset('mtd') : null;

  try {
    const [usage, pricingData, budget, monthUsage] = await Promise.all([
      rpc('usage', { startDate: start, endDate: end }),
      rpc('pricing').catch(() => ({ markdown: '' })),
      // Budget spend is always the current cycle, never the selected range —
      // a projection built from "Today" would be meaningless. Non-fatal: the
      // rest of the dashboard works without it.
      rpc('budget').catch(() => null),
      monthWindow
        ? rpc('usage', { startDate: toMs(monthWindow.start), endDate: toMs(monthWindow.end, true) }).catch(() => null)
        : Promise.resolve(null),
    ]);
    if (seq !== loadSeq) return;
    state.budget = budget;

    state.pricing = parsePricing(pricingData.markdown || '');
    state.plan = usage.plan || null;
    const normOpts = { freePlan: isFreePlan() };
    const normalized = (usage.events || []).map((raw) => normalize(raw, state.pricing, normOpts));
    state.all = filterByRange(normalized, start, end);
    // Promotions are inferred from the events themselves, so this has to be
    // rebuilt whenever the loaded range changes — every renderer below reads it.
    state.detectedDiscounts = detectDiscounts(state.all, state.pricing);
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

    // Skipped (leaving planCheckMonthKey unset) when the dedicated fetch
    // failed — non-fatal, same as pricing/budget above, and it means next
    // load() simply tries again instead of the chip being wrongly hidden for
    // the rest of the month on one dropped request.
    if (needsMonthCheck && (monthIsSelectedRange || monthUsage)) {
      const monthEvents = monthIsSelectedRange
        ? state.all
        : (monthUsage.events || []).map((raw) => normalize(raw, state.pricing, normOpts));
      // The request picker reads state.filtered, which only refresh() updates
      // — so the possible reload this can trigger has to come after, or it
      // lists the previous range's requests.
      const switchedToPlanRange = applyPlanChangeResult(detectPlanChange(monthEvents), monthKey);
      if (switchedToPlanRange) return; // load() re-entered with the narrower range
    }

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
      // Both notices say the same thing — some of these dollars come from a
      // different pricing system — so they carry the same weight. The
      // auto-switch one used to be a blue "info" beside an amber warning about
      // the very same condition.
      spanNote || notice ? 'warn' : 'info',
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
    state.detectedDiscounts = { discounts: {}, observed: new Set() };
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
      <td>${esc(r.model)}${rangeDiscountBadge(r.model)}</td>
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
      <td>${esc(e.model)}${discountBadge(discountForEvent(e.modelRaw, e.timestampMs))}</td>
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
  // against 120 last week" is a finding — and Sessions explains its own empty
  // period in the terms of this tab, so only the findings view collapses into
  // the generic empty state. The sub-tabs stay available either way.
  const hasData = state.filtered.length > 0;
  const onCompare = state.analyzePanel === 'compare';
  const onSessions = state.analyzePanel === 'sessions';
  const onFindings = !onCompare && !onSessions;
  $('analyzeTabs')?.classList.toggle('hidden', !state.loaded);
  empty.classList.toggle('hidden', hasData || !onFindings);
  $('analyzeCompare')?.classList.toggle('hidden', !onCompare);
  $('analyzeSessions')?.classList.toggle('hidden', !onSessions);
  content.classList.toggle('hidden', !hasData || !onFindings);

  if (onCompare) {
    renderComparison();
    void loadTrendComparison();
    return;
  }
  if (onSessions) {
    renderSessions();
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

/** Events the model list is derived from — the loaded range, or everything. */
function modelSourceEvents() {
  return state.filtered.length ? state.filtered : state.all;
}

function getCompareModels(pricing) {
  return simulatorModels(pricing, modelSourceEvents());
}

function requestOptionLabel(e) {
  return `${fmt.date(e.timestampMs)} · ${e.model} · ${fmt.num(e.totalTokens)} tok · ${fmt.money(e.cost)}`;
}

function isSameModel(modelKey, eventModelRaw, pricing) {
  const a = normModel(modelKey);
  const b = normModel(eventModelRaw);
  if (a === b) return true;
  if (a === 'default' && (b === 'default' || b.includes('auto'))) return true;
  if (b === 'default' && (a === 'default' || a.includes('auto'))) return true;
  // Names differ (e.g. a catalog key "grok-4-6" vs. a billed variant string
  // "cursor-grok-4.6-high") but can still price against the same published
  // rate row — that's the same model, not an alternative to compare against.
  if (pricing) {
    const ra = matchPricing(modelKey, pricing);
    const rb = matchPricing(eventModelRaw, pricing);
    if (ra && rb && ra.label === rb.label) return true;
  }
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
  const el = $('simModel');
  if (!state.pricing || !el) return;
  const previous = el.value;
  // Models with no published rate stay in the list but can't be priced, so they
  // are disabled rather than dropped — see simulatorModels().
  el.innerHTML = simulatorModels(state.pricing, modelSourceEvents())
    .map((o) => `<option value="${esc(o.key)}"${o.priced ? '' : ' disabled'}>${esc(o.label)}${o.priced ? '' : ' (no published rate)'}</option>`)
    .join('');
  if (previous && [...el.options].some((o) => o.value === previous)) el.value = previous;
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
  // `[]` is a real choice — the user cleared every model — and is distinct from
  // `null`, which means they have never picked. Testing `.length` here treated
  // the two alike and silently re-checked the computed defaults.
  const stored = loadCompareModelPrefs();
  if (stored) state.simCompareSelected = new Set(stored);
}

/**
 * The selection to show in the picker. Computed defaults apply only when the
 * user has never chosen; once they have, their set is returned as-is, including
 * keys this request cannot offer. Filtering it down to what is currently
 * offered would let a save further down the line write the narrowed set back
 * and lose the rest.
 */
function resolveCompareSelection(models) {
  if (state.simCompareSelected) return state.simCompareSelected;
  const stored = loadCompareModelPrefs();
  if (stored) return new Set(stored);
  return defaultCompareSelection(models, modelSourceEvents());
}

function saveCompareModelSelection() {
  const boxes = [...document.querySelectorAll('#simCompareModelFilters input')];
  const merged = mergeCompareSelection(
    loadCompareModelPrefs(),
    boxes.map((el) => el.value),
    boxes.filter((el) => el.checked).map((el) => el.value),
  );
  state.simCompareSelected = new Set(merged);
  saveCompareModelPrefs(merged);
  updateComparePickerLabel();
}

/** Clear means all models, not just the ones this request happens to offer. */
function clearCompareModelSelection() {
  state.simCompareSelected = new Set();
  saveCompareModelPrefs([]);
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

  const models = getCompareModels(state.pricing).filter((m) => !isSameModel(m.key, event.modelRaw, state.pricing));
  // The list is partly derived from the events in the loaded range, so a range
  // change can add or drop models while the selected request stays the same —
  // keying the rebuild on the request alone would leave stale checkboxes.
  const modelsKey = models.map((m) => m.key).join('|');
  const unchanged = state.simCompareFilterRequestId === event.id
    && state.simCompareModelsKey === modelsKey;
  if (unchanged && container.children.length) return;

  state.simCompareFilterRequestId = event.id;
  state.simCompareModelsKey = modelsKey;
  const selected = resolveCompareSelection(models);
  state.simCompareSelected = selected;

  container.innerHTML = models.map((m) => {
    const checked = selected.has(m.key);
    const note = m.priced ? '' : ' <span class="sim-picker-note">no published rate</span>';
    return `<label class="sim-picker-item" data-label="${esc(m.label.toLowerCase())}">
      <input type="checkbox" value="${esc(m.key)}" ${checked ? 'checked' : ''}>
      <span>${esc(m.label)}${note}</span>
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
    // Whatever promotion was running is already inside the billed figure, so
    // this is flagged for context only — never applied a second time.
    discount: discountForEvent(event.modelRaw, event.timestampMs),
    isActual: true,
  };

  // The replay prices this request's tokens as of the day it ran, so that is
  // the day whose promotions apply — not today's.
  const day = dayKey(event.timestampMs);

  const altRows = [];
  const unknown = [];
  for (const m of getCompareModels(state.pricing)) {
    if (isSameModel(m.key, event.modelRaw, state.pricing)) continue;
    const discount = resolveDiscount(m.key, day, discountContext());
    const rates = discount ? applyDiscountToRates(m.rates, discount.pct) : m.rates;
    // Unpriced models stay in the table with an empty cost cell. Dropping them
    // made a model the user had just run look like it didn't exist.
    const estCost = rates ? estimateTokenCost(rates, tokens) : null;
    const savings = rates ? cacheSavingsFor({ cacheRead: tokens.cacheRead }, rates) : null;
    const diff = actualCost != null && estCost != null ? estCost - actualCost : null;
    // The rates that priced this row, when they came from a differently-named
    // catalog entry, are an approximation the user should be able to see.
    const via = rates && normModel(rates.label) !== normModel(m.key) ? rates.label : null;
    altRows.push({ key: m.key, label: m.label, via, estCost, savings, diff, discount, isActual: false });
    if (m.rates && !discount) unknown.push(m.key);
  }

  // Models priced at list because nothing tells us otherwise — no requests that
  // day to measure, and no entry from the user. Worth one quiet offer to fix.
  state.discountPromptKeys = modelsMissingDiscountInfo(unknown, day, discountContext());
  return { actualRow, altRows, event };
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
      <td>${esc(row.label)} <span class="sim-tag">actual</span>${discountBadge(row.discount)}</td>
      <td>${fmt.money(row.estCost)}</td>
      <td>—</td>
      <td>${row.savings != null ? fmt.money(row.savings) : '—'}</td>
    </tr>`;
  }
  const rowClass = row.diff != null && row.diff < -0.005 ? 'row-cheaper' : row.diff > 0.005 ? 'row-pricier' : '';
  const diffClass = row.diff != null && row.diff < -0.005 ? 'diff-save' : row.diff > 0.005 ? 'diff-more' : '';
  const note = row.estCost == null
    ? ` <span class="sim-tag sim-tag-muted">no published rate</span> ${tip('This model appears in your usage but not on cursor.com\'s pricing table, so there is no published rate to estimate from.')}`
    : row.via
      ? ` <span class="sim-tag sim-tag-muted">via ${esc(row.via)} rates</span> ${tip('Cursor bills this variant under a model string that is not on the pricing table, so the estimate uses the closest published rates. Reasoning level and any long-context or Fast surcharge are not reflected.')}`
      : '';
  // Marks a figure we know might be too high, and says so in one hover for
  // anyone who does not read footnotes.
  const listPriced = row.estCost != null && !row.discount
    && (state.discountPromptKeys || []).includes(row.key);
  const mark = listPriced
    ? `<span class="list-price-mark" title="Full price — this extension can't tell whether Cursor was discounting this model that day.">*</span>`
    : '';
  return `<tr class="${rowClass}">
    <td>${esc(row.label)}${note}${discountBadge(row.discount)}</td>
    <td>${fmt.money(row.estCost)}${mark}</td>
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
  // Counted from the rows this request can actually show, not from the raw
  // selection: that set now carries models the current request doesn't offer,
  // so its size no longer says whether the table has anything in it.
  const filtered = ctx.altRows.filter((r) => selected.has(r.key));
  const hint = $('simCompareFilterHint');
  if (hint) hint.classList.toggle('hidden', filtered.length > 0);

  if (!filtered.length) {
    $('simCompareBody').innerHTML = `<tr><td colspan="4">Select at least one model above.</td></tr>`;
    updateCompareSortHeaders();
    renderDiscountPrompt([]);
    renderCompareFootnote();
    return;
  }

  let rows;
  if (state.simCompareSortKey === 'label') {
    rows = sortCompareRows([ctx.actualRow, ...filtered], 'label', state.simCompareSortDir);
  } else {
    const sorted = sortCompareRows(filtered, state.simCompareSortKey, state.simCompareSortDir);
    rows = [ctx.actualRow, ...sorted];
  }

  $('simCompareBody').innerHTML = rows.map(renderCompareRow).join('');
  updateCompareSortHeaders();
  renderDiscountPrompt(filtered);
  // After the rows exist — it counts the marks it is explaining.
  renderCompareFootnote();
}

/**
 * The one-line offer to record a promotion we could not measure.
 *
 * Only for models actually on screen, and only once per request — a nag that
 * reappears on every re-render for a promotion the user knows isn't running
 * would be worse than the stale estimate it is trying to prevent.
 */
function renderDiscountPrompt(visibleRows) {
  const el = $('simDiscountPrompt');
  if (!el) return;
  const shown = new Set(visibleRows.map((r) => r.key));
  const keys = (state.discountPromptKeys || []).filter((k) => shown.has(k));
  const dismissed = state.discountPromptDismissed.has(state.simRequestId);
  if (!keys.length || dismissed || state.discountEditorOpen) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  const names = discountPromptNames(keys);
  const day = state.simCompareContext?.event
    ? fmt.shortDate(dayKey(state.simCompareContext.event.timestampMs))
    : 'that day';
  const wereWas = keys.length > 1 ? 'were' : 'was';
  // Leads with the consequence to the reader — "this number may be too high" —
  // rather than with the mechanism. The mechanism is one click away for anyone
  // who wants it, and in the intro dialog for anyone who has not met it yet.
  el.innerHTML = `
    <span class="sim-note-text">
      <strong>${esc(names)}</strong> ${wereWas} priced at full price here. Cursor discounts a model for a few days at a time,
      and you didn't use ${keys.length > 1 ? 'these models' : 'this model'} on ${esc(day)} — so if there was a discount, this estimate is too high.
    </span>
    <span class="sim-note-actions">
      <button type="button" class="btn-text" id="simDiscountPromptAdd">Add a discount</button>
      <button type="button" class="btn-text btn-quiet" id="simDiscountPromptExplain">Why?</button>
      <button type="button" class="btn-text btn-quiet" id="simDiscountPromptDismiss">Dismiss</button>
    </span>`;
  el.classList.remove('hidden');
  $('simDiscountPromptAdd')?.addEventListener('click', () => {
    setDiscountEditorOpen(true, keys);
  });
  $('simDiscountPromptExplain')?.addEventListener('click', openSimIntro);
  $('simDiscountPromptDismiss')?.addEventListener('click', () => {
    state.discountPromptDismissed.add(state.simRequestId);
    el.classList.add('hidden');
    renderCompareFootnote();
  });
}

/** "GPT-5.2, Claude 4.5 Haiku and 2 more" — model labels, not raw keys. */
function discountPromptNames(keys) {
  const catalog = getCompareModels(state.pricing);
  const names = keys.slice(0, 2).map((k) => catalog.find((x) => x.key === k)?.label || k);
  const rest = keys.length - names.length;
  if (rest > 0) names.push(`${rest} more`);
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The asterisk convention from any priced table: mark the figures that carry a
 * caveat, explain it once underneath. This survives dismissing the prompt —
 * the user has said "stop offering", not "stop telling me which numbers are
 * uncertain", and an unmarked estimate claims a confidence it doesn't have.
 */
function renderCompareFootnote() {
  const el = $('simCompareFootnote');
  if (!el) return;
  const marked = document.querySelectorAll('#simCompareBody .list-price-mark').length;
  if (!marked) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `<span class="list-price-mark" aria-hidden="true">*</span>
    Full price — this extension can't tell whether Cursor was discounting ${marked > 1 ? 'these models' : 'this model'} that day.
    <button type="button" class="btn-link-inline" id="simFootnoteAdd">Add a discount</button>`;
  el.classList.remove('hidden');
  $('simFootnoteAdd')?.addEventListener('click', () => {
    setDiscountEditorOpen(true, state.discountPromptKeys || []);
  });
}

const SIM_INTRO_KEY = 'cursorUsage.simIntroSeen';

/**
 * The one-time explanation of why an estimate might be too high.
 *
 * Shown on the first visit to the Simulator rather than the first time a
 * request happens to lack discount data: the caveat applies to the whole tab,
 * and a dialog that appears only once some later condition is met reads as an
 * error report about that request. Seen once, never again — but reachable
 * afterwards from "What's this?", because a user who clicked through it on day
 * one will want it back the day they notice a number looks wrong.
 */
function openSimIntro() {
  const el = $('simIntro');
  if (!el) return;
  state.simIntroReturnFocus = document.activeElement;
  el.classList.remove('hidden');
  $('simIntroDismiss')?.focus();
}

function closeSimIntro() {
  const el = $('simIntro');
  if (!el || el.classList.contains('hidden')) return;
  el.classList.add('hidden');
  storage.setItem(SIM_INTRO_KEY, '1');
  // Returning focus to whatever opened the dialog is what keeps keyboard and
  // screen-reader users from being dumped at the top of the document.
  const back = state.simIntroReturnFocus;
  state.simIntroReturnFocus = null;
  if (back && typeof back.focus === 'function' && document.contains(back)) back.focus();
}

function maybeShowSimIntro() {
  if (storage.getItem(SIM_INTRO_KEY) === '1') return;
  openSimIntro();
}

/**
 * Keeps Tab inside the dialog while it is open. aria-modal tells a screen
 * reader the rest of the page is inert, but it does not stop the browser
 * tabbing a sighted keyboard user out into content they cannot see.
 */
function trapSimIntroFocus(ev) {
  const el = $('simIntro');
  if (ev.key !== 'Tab' || !el || el.classList.contains('hidden')) return;
  const focusable = [...el.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.disabled && node.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (ev.shiftKey && document.activeElement === first) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && document.activeElement === last) {
    ev.preventDefault();
    first.focus();
  }
}

function addDays(day, n) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return dayKey(d.getTime());
}

function setDiscountEditorOpen(open, preselectKeys = []) {
  state.discountEditorOpen = open;
  renderDiscountEditor(preselectKeys);
  renderDiscountSummary();
  if (state.simCompareContext) renderCompareTableFromState();
}

/**
 * What the dashboard currently believes about promotions, measured and
 * declared alike. Shown even when the editor is closed: a discount silently
 * reshaping the comparison table is worse than no discount at all.
 */
function renderDiscountSummary() {
  const el = $('simDiscountSummary');
  if (!el) return;
  const periods = discountPeriods(state.detectedDiscounts);
  const chips = [];
  for (const p of periods) {
    const range = p.start === p.end ? fmt.shortDate(p.start) : `${fmt.shortDate(p.start)}–${fmt.shortDate(p.end)}`;
    chips.push(`<span class="discount-chip" title="${esc(DISCOUNT_TIPS.detected)}"><strong>−${fmt.discountPct(p.pct)}</strong> ${esc(p.label || p.model)} · ${esc(range)} <span class="discount-chip-src">from your bill</span></span>`);
  }
  for (const entry of state.manualDiscounts) {
    const models = entry.models.includes('*') ? 'all models' : entry.models.join(', ');
    const range = entry.start === entry.end ? fmt.shortDate(entry.start) : `${fmt.shortDate(entry.start)}–${fmt.shortDate(entry.end)}`;
    chips.push(`<span class="discount-chip discount-chip-manual" title="${esc(DISCOUNT_TIPS.manual)}"><strong>−${fmt.discountPct(entry.pct)}</strong> ${esc(models)} · ${esc(range)} <span class="discount-chip-src">you added</span></span>`);
  }
  el.innerHTML = chips.length
    ? chips.join('')
    : `<span class="sim-note-muted">None found in this date range, and none added. Estimates below use Cursor's normal prices.</span>`;
}

function renderDiscountEditor(preselectKeys = []) {
  const el = $('simDiscountEditor');
  if (!el) return;
  el.classList.toggle('hidden', !state.discountEditorOpen);
  if (!state.discountEditorOpen) {
    el.innerHTML = '';
    return;
  }

  const preselect = new Set(preselectKeys);
  const models = getCompareModels(state.pricing).filter((m) => m.priced !== false);
  const checkboxes = models.map((m) => `
    <label class="discount-model-opt">
      <input type="checkbox" value="${esc(m.key)}"${preselect.has(m.key) ? ' checked' : ''} />
      <span>${esc(m.label)}</span>
    </label>`).join('');

  const event = state.simCompareContext?.event;
  const start = (event && dayKey(event.timestampMs)) || dayKey(Date.now());
  const end = addDays(start, 6);

  const existing = state.manualDiscounts.map((entry) => {
    const modelText = entry.models.includes('*') ? 'All models' : entry.models.join(', ');
    return `<li>
      <span><strong>−${fmt.discountPct(entry.pct)}</strong> ${esc(modelText)} · ${esc(fmt.shortDate(entry.start))}–${esc(fmt.shortDate(entry.end))}</span>
      <button type="button" class="btn-text btn-quiet" data-discount-remove="${esc(entry.id)}">Remove</button>
    </li>`;
  }).join('');

  el.innerHTML = `
    <p class="sim-note-muted">
      Saw a discount announced that isn't showing up here? Add it, and estimates for these models on these dates will use the lower price.
      ${tip('This only changes the "what would this have cost on another model" estimates. What you were actually charged for your own requests never changes.')}
    </p>
    <div class="discount-form">
      <div class="discount-field discount-field-models">
        <span class="discount-label">Models on promotion</span>
        <div class="discount-model-list" id="simDiscountModels">${checkboxes || '<span class="sim-note-text">Load usage data first.</span>'}</div>
      </div>
      <div class="discount-field">
        <label class="discount-label" for="simDiscountStart">From</label>
        <input type="date" id="simDiscountStart" value="${esc(start)}" />
      </div>
      <div class="discount-field">
        <label class="discount-label" for="simDiscountEnd">To</label>
        <input type="date" id="simDiscountEnd" value="${esc(end)}" />
      </div>
      <div class="discount-field discount-field-pct">
        <label class="discount-label" for="simDiscountPct">Discount %</label>
        <input type="number" id="simDiscountPct" min="1" max="99" step="1" value="50" />
      </div>
      <div class="discount-actions">
        <button type="button" class="btn-primary" id="simDiscountSave">Save</button>
        <button type="button" class="btn-text" id="simDiscountCancel">Close</button>
      </div>
    </div>
    <p id="simDiscountError" class="sim-filter-hint hidden"></p>
    ${existing ? `<ul class="discount-entry-list">${existing}</ul>` : ''}`;

  $('simDiscountSave')?.addEventListener('click', saveDiscountFromEditor);
  $('simDiscountCancel')?.addEventListener('click', () => setDiscountEditorOpen(false));
  el.querySelectorAll('[data-discount-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.discountRemove;
      state.manualDiscounts = state.manualDiscounts.filter((e) => e.id !== id);
      saveManualDiscounts();
      setDiscountEditorOpen(true);
      runCompareFromRequest();
    });
  });
}

function saveDiscountFromEditor() {
  const err = $('simDiscountError');
  const fail = (msg) => {
    if (!err) return;
    err.textContent = msg;
    err.classList.remove('hidden');
  };
  const checked = [...document.querySelectorAll('#simDiscountModels input:checked')].map((el) => el.value);
  if (!checked.length) return fail('Pick at least one model.');

  const entry = normalizeDiscountEntry({
    models: checked,
    start: $('simDiscountStart')?.value,
    end: $('simDiscountEnd')?.value,
    pct: $('simDiscountPct')?.value,
  });
  if (!entry) return fail('Enter a discount between 1 and 99% and an end date on or after the start date.');

  state.manualDiscounts = [...state.manualDiscounts, entry];
  saveManualDiscounts();
  err?.classList.add('hidden');
  setDiscountEditorOpen(false);
  // Re-price the table so the new discount is visible immediately.
  runCompareFromRequest();
  refresh();
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
      <div><dt>Model used ${tip('The model Cursor billed for this request. Auto means Cursor chose the model automatically.')}</dt><dd>${esc(event.model)}${discountBadge(discountForEvent(event.modelRaw, event.timestampMs))}</dd></div>
      <div><dt>Actual token cost ${tip('What Cursor charged for model/API tokens on this request. Does not include flat usage fees on some plans, and always the token value rather than the Billed figure — the comparison below prices tokens, so its baseline has to as well.')}</dt><dd>${fmt.money(actualCost)}</dd></div>
      <div><dt>Input / output ${tip('Token counts from your request — replayed as-is when estimating other models.')}</dt><dd>${fmt.num(tokens.input)} / ${fmt.num(tokens.output)}</dd></div>
      <div><dt>Cache read / write ${tip('Prompt cache tokens from this request. Savings estimates assume similar cache behavior on other models.')}</dt><dd>${fmt.num(tokens.cacheRead)} / ${fmt.num(tokens.cacheWrite)}</dd></div>
      <div><dt>Total tokens ${tip('Sum of input, output, cache read, and cache write tokens.')}</dt><dd>${fmt.num(event.totalTokens)}</dd></div>`;
  }

  populateCompareModelFilters(event);
  state.simCompareContext = buildCompareRows(event);
  renderCompareTableFromState();
  renderDiscountSummary();
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
  // Re-derived here as well as on load: the model list is partly built from the
  // events in the current range, and load() populates it before refresh() has
  // recomputed state.filtered.
  populateSimulatorModels();
  populateSimRequestPicker(state.simRequestId);
  if (state.simMode === 'request') runCompareFromRequest();
  else runSimulator();
  // Also when there is no request to compare: what the dashboard believes
  // about promotions should be visible before anything is selected.
  renderDiscountSummary();
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
  const published = matchPricing(modelKey, state.pricing);
  if (!published) {
    $('simCost').textContent = '—';
    $('simSavings').textContent = '—';
    $('simNoCache').textContent = '—';
    $('simRates').textContent = 'No pricing matched for this model.';
    return;
  }
  // A hypothetical token profile has no date of its own, so it is priced as of
  // today — the only day a "what would this cost me" answer can mean.
  const discount = resolveDiscount(modelKey, dayKey(Date.now()), discountContext());
  const rates = discount ? applyDiscountToRates(published, discount.pct) : published;
  const cost = estimateTokenCost(rates, tokens);
  const savings = cacheSavingsFor({ cacheRead: tokens.cacheRead }, rates);
  const noCache = cost != null && savings != null ? cost + savings : cost;
  $('simCost').textContent = fmt.money(cost);
  $('simSavings').textContent = fmt.money(savings);
  $('simNoCache').textContent = fmt.money(noCache);
  // Naming the discount matters: without it these read as the published rates,
  // and a user checking them against cursor.com would find they disagree.
  const rate = (v) => `$${Math.round(v * 1000) / 1000}`;
  const parts = [discount
    ? `${rates.label} rates less ${fmt.discountPct(discount.pct)} ${discount.source === 'manual' ? 'entered' : 'detected'} (per 1M tokens)`
    : `${rates.label} rates (per 1M tokens)`];
  if (rates.input != null) parts.push(`input ${rate(rates.input)}`);
  if (rates.output != null) parts.push(`output ${rate(rates.output)}`);
  if (rates.cacheRead != null) parts.push(`cache read ${rate(rates.cacheRead)}`);
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
  if (view === 'simulator') {
    refreshSimulator();
    maybeShowSimIntro();
  }
  if (view === 'analyze') renderAnalyze();
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
  // Must come first: everything below reads storage synchronously.
  await hydratePrefs();
  initDateRange();
  initPeriodComparePrefs();
  initCompareModelPrefs();
  initDiscountPrefs();
  initSessionPrefs();

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
      saveComparePrefs();
      renderComparison();
      void loadTrendComparison();
    });
  });

  // Applied on demand rather than on every keystroke: each window is a fresh
  // paginated fetch of cursor.com, and a half-typed year is a range nobody
  // asked for.
  $('compareEditApply')?.addEventListener('click', applyCompareEditor);
  $('compareEditReset')?.addEventListener('click', resetCompareEditor);
  $('compareEditCancel')?.addEventListener('click', () => {
    state.trend.editing = null;
    renderCompareEditor();
  });
  // The column headers are rebuilt on every render, so the click is delegated.
  $('compareBody')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-edit-window]');
    if (btn) openCompareEditor(btn.dataset.editWindow);
  });

  // Rows are rebuilt on every render, so both the checkbox and the row click
  // are delegated to the container. A click that lands on the checkbox is left
  // to its own change event — handling both would toggle the row twice.
  $('sessionsList')?.addEventListener('click', (ev) => {
    if (ev.target.closest('input[type="checkbox"]')) return;
    const sortable = ev.target.closest('[data-session-sort]');
    if (sortable) {
      setSessionSort(sortable.dataset.sessionSort);
      return;
    }
    const row = ev.target.closest('tr[data-session-id]');
    if (row) toggleSessionSelected(row.dataset.sessionId);
  });
  $('sessionsList')?.addEventListener('change', (ev) => {
    const box = ev.target.closest('input[data-session-id]');
    if (box) toggleSessionSelected(box.dataset.sessionId);
  });
  // Filtering is local to the loaded rows, so it can run on every keystroke —
  // there's no fetch behind it. The input lives outside the re-rendered list so
  // that typing doesn't blur it.
  $('sessionSearch')?.addEventListener('input', (ev) => {
    state.sessions.query = ev.target.value;
    state.sessions.page = 1;
    renderSessions();
  });

  $('sessionsPager')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-session-page]');
    if (!btn) return;
    state.sessions.page += btn.dataset.sessionPage === 'next' ? 1 : -1;
    renderSessions();
  });
  $('sessionsPager')?.addEventListener('change', (ev) => {
    if (ev.target.id !== 'sessionPageSize') return;
    state.sessions.pageSize = Number(ev.target.value);
    state.sessions.page = 1;
    savePrefs({ sessionPageSize: String(state.sessions.pageSize) });
    renderSessions();
  });

  // The tray and the dialog it opens.
  $('trayCompare')?.addEventListener('click', openSessionCompare);
  $('trayClear')?.addEventListener('click', clearSessionSelection);
  $('trayChips')?.addEventListener('click', (ev) => {
    const drop = ev.target.closest('[data-drop-session]');
    if (drop) toggleSessionSelected(drop.dataset.dropSession);
  });
  $('sessionsDialogClose')?.addEventListener('click', () => $('sessionsDialog')?.close());
  $('sessionsDiffOnly')?.addEventListener('change', (ev) => {
    state.sessions.diffOnly = ev.target.checked;
    renderSessionCompare();
  });
  $('sessionsDialogBody')?.addEventListener('click', (ev) => {
    const base = ev.target.closest('[data-base-session]');
    if (!base) return;
    state.sessions.baseId = base.dataset.baseSession;
    renderSessionCompare();
    renderSessions();
  });
  // Clicking the backdrop closes it, the way a modal is expected to behave.
  $('sessionsDialog')?.addEventListener('click', (ev) => {
    if (ev.target === $('sessionsDialog')) $('sessionsDialog').close();
  });

  // "Compare →" beside the trend badge: the badge raises the question, this
  // takes you to the view that answers it.
  $('ovCostSub')?.addEventListener('click', (ev) => {
    if (!ev.target.closest('[data-goto-compare]')) return;
    setAppView('analyze');
    setAnalyzePanel('compare');
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
    clearCompareModelSelection();
    renderCompareTableFromState();
  });

  $('simDiscountToggle')?.addEventListener('click', () => {
    setDiscountEditorOpen(!state.discountEditorOpen);
  });

  $('simDiscountExplain')?.addEventListener('click', openSimIntro);
  $('simIntroDismiss')?.addEventListener('click', closeSimIntro);
  $('simIntroAdd')?.addEventListener('click', () => {
    closeSimIntro();
    setDiscountEditorOpen(true);
    $('simDiscountModels')?.querySelector('input')?.focus();
  });
  // Clicking the dimmed area outside the dialog dismisses it, the way every
  // other modal on the web does. Guarded to the backdrop itself so a click that
  // starts inside the dialog and drifts out does not close it.
  $('simIntro')?.addEventListener('click', (ev) => {
    if (ev.target === $('simIntro')) closeSimIntro();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') closeSimIntro();
    else trapSimIntroFocus(ev);
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
