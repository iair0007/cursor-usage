/** Minimal event shape for shared cost/request helpers (extension host + webview). */
export interface UsageEventLike {
  kind?: string;
  isTokenBasedCall: boolean;
  chargedCents: number | null;
  cursorTokenFee: number | null;
  tokenUsage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalCents?: number;
  } | null;
}

export interface QuotaLike {
  used: number;
  limit: number | null;
  /** Billing-cycle start from cursor.com, when known. */
  startOfCycleIso?: string;
  /** Next quota reset (billing-cycle rollover), when known. */
  resetIso?: string;
}

/** Event window for the current billing cycle (quota start → today). */
export function billingCycleWindow(
  quota?: Pick<QuotaLike, 'startOfCycleIso'> | null,
  now: Date = new Date(),
): { start: number; end: number } {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  if (quota?.startOfCycleIso) {
    const start = new Date(quota.startOfCycleIso);
    if (!Number.isNaN(start.getTime())) {
      start.setHours(0, 0, 0, 0);
      return { start: start.getTime(), end: end.getTime() };
    }
  }

  const start = new Date(now);
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  return { start: start.getTime(), end: end.getTime() };
}

/** Short range label for tooltips, e.g. "Jun 5 – Jul 5". */
export function formatCycleRangeLabel(startMs: number, endMs: number): string {
  const fmt = (ms: number) =>
    new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${fmt(startMs)} – ${fmt(endMs)}`;
}

/** Rolling calendar-day window (last N days through today). */
export function rollingDayWindow(periodDays: number, now: Date = new Date()): { start: number; end: number } {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - (periodDays - 1));
  return { start: start.getTime(), end: end.getTime() };
}

export type StatusBarPeriodMode = 'cycle' | 'days';

const PERIOD_DAYS_MIN = 1;
const PERIOD_DAYS_MAX = 90;
const DEFAULT_PERIOD_DAYS = 30;

export interface StatusBarPeriodConfig {
  mode: StatusBarPeriodMode;
  periodDays: number;
}

export function clampPeriodDays(days: number): number {
  return Math.min(PERIOD_DAYS_MAX, Math.max(PERIOD_DAYS_MIN, days));
}

/** Resolve status-bar period from settings (supports `days:N` and legacy `days` + periodDays). */
export function parseStatusBarPeriodConfig(
  periodModeRaw: string | undefined,
  periodDaysRaw: number | undefined,
): StatusBarPeriodConfig {
  const modeRaw = periodModeRaw ?? 'cycle';
  const daysRaw = periodDaysRaw ?? DEFAULT_PERIOD_DAYS;

  if (modeRaw === 'cycle') {
    return { mode: 'cycle', periodDays: DEFAULT_PERIOD_DAYS };
  }

  const embedded = /^days:(\d+)$/.exec(modeRaw);
  if (embedded) {
    return { mode: 'days', periodDays: clampPeriodDays(Number(embedded[1])) };
  }

  if (modeRaw === 'days') {
    return { mode: 'days', periodDays: clampPeriodDays(daysRaw) };
  }

  return { mode: 'cycle', periodDays: DEFAULT_PERIOD_DAYS };
}

/** Resolve the status-bar event window from settings. */
export function statusBarWindow(
  mode: StatusBarPeriodMode,
  periodDays: number,
  quota?: Pick<QuotaLike, 'startOfCycleIso'> | null,
  now: Date = new Date(),
): { start: number; end: number } {
  return mode === 'days' ? rollingDayWindow(periodDays, now) : billingCycleWindow(quota, now);
}

/**
 * Raw event timestamps arrive as ms or seconds, number or string, depending on
 * which endpoint served them. Returns ms, or 0 when there's nothing usable.
 */
export function eventTimestampMs(timestamp: unknown): number {
  const n = Number(timestamp);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

/**
 * Keeps only events inside [startMs, endMs].
 *
 * cursor.com's usage endpoints are asked for an explicit window, but their date
 * semantics are undocumented and a response can carry rows from outside it —
 * which silently inflates every total, chart and insight computed from them,
 * and makes the panel disagree with cursor.com's own dashboard for the same
 * dates. Rows with no usable timestamp are kept: only the server can place
 * them, and dropping them would lose real usage.
 */
export function eventsWithinRange<T extends { timestamp?: number | string }>(
  events: T[],
  startMs: number,
  endMs: number,
): T[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return events;
  return events.filter((e) => {
    const ts = eventTimestampMs(e.timestamp);
    return ts === 0 || (ts >= startMs && ts <= endMs);
  });
}

/** Earliest/latest usable event timestamp in ms, or null when none have one. */
export function eventTimestampSpan<T extends { timestamp?: number | string }>(
  events: T[],
): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const e of events) {
    const ts = eventTimestampMs(e.timestamp);
    if (ts === 0) continue;
    if (ts < min) min = ts;
    if (ts > max) max = ts;
  }
  return min === Infinity ? null : { min, max };
}

const FREE_KIND_RE = /included|free|not charged|no charge|errored/i;
const NOT_COUNTED_KIND_RE = /errored|aborted|cancel/i;

function eventTotalTokens(e: UsageEventLike): number {
  const tu = e.tokenUsage;
  return (tu?.inputTokens ?? 0) + (tu?.outputTokens ?? 0) + (tu?.cacheReadTokens ?? 0) + (tu?.cacheWriteTokens ?? 0);
}

/**
 * Whether cursor.com's own usage page would count this event as a request.
 * The dashboard events API returns every event row — including errored or
 * aborted generations and bookkeeping rows with no tokens and no charge —
 * while the official "requests" figures skip those, so counting raw rows
 * overstates requests.
 */
export function isCountedRequest(
  kind: string | null | undefined,
  totalTokens: number,
  chargedCents: number | null,
): boolean {
  if (kind && NOT_COUNTED_KIND_RE.test(String(kind))) return false;
  if (!(totalTokens > 0) && !((chargedCents ?? 0) > 0)) return false;
  return true;
}

/** Request count using the same rules as isCountedRequest. */
export function countRequests(events: UsageEventLike[]): number {
  let n = 0;
  for (const e of events) {
    if (isCountedRequest(e.kind, eventTotalTokens(e), e.chargedCents)) n++;
  }
  return n;
}

/**
 * One event's cost in dollars; mirrors normalize() priority: token-based plans
 * bill chargedCents, otherwise model token cost (tokenUsage.totalCents +
 * cursorTokenFee), otherwise chargedCents. Null when the row carries no cost.
 */
export function eventCostDollars(e: UsageEventLike): number | null {
  const modelCents =
    e.tokenUsage?.totalCents != null
      ? e.tokenUsage.totalCents + (e.cursorTokenFee ?? 0)
      : null;
  if (e.isTokenBasedCall && e.chargedCents != null) return e.chargedCents / 100;
  if (modelCents != null) return modelCents / 100;
  if (e.chargedCents != null) return e.chargedCents / 100;
  return null;
}

/**
 * What-if cost sum: the API-equivalent value of the tokens, not what was billed.
 */
export function sumTokenCostDollars(events: UsageEventLike[]): number {
  let total = 0;
  for (const e of events) total += eventCostDollars(e) ?? 0;
  return total;
}

export type BillingRegime = 'token' | 'usage' | 'unknown';

/**
 * Which billing system priced a request. A flat per-request charge on a
 * non-token-based call is the marker of the older request-priced plan; ranges
 * that span a plan change hold both, and their dollars are not addable.
 */
export function eventBillingRegime(e: UsageEventLike): BillingRegime {
  if (e.isTokenBasedCall) return 'token';
  if (e.chargedCents != null) return 'usage';
  return 'unknown';
}

/**
 * What cursor.com's usage page meters for a request — the dollars that count
 * against a plan's monthly budget — or null for request-priced rows, which
 * consumed a request allowance instead and are absent from that page's spend.
 * Deliberately independent of `kind`: "Included" usage is still metered.
 */
export function planMeteredDollars(e: UsageEventLike): number | null {
  return eventBillingRegime(e) === 'usage' ? null : eventCostDollars(e);
}

/** Metered spend across events — comparable to cursor.com's "Total usage". */
export function sumPlanMeteredDollars(events: UsageEventLike[]): number {
  let total = 0;
  for (const e of events) total += planMeteredDollars(e) ?? 0;
  return total;
}

/** Per-event billed cost in dollars (normalize().billedCost rule). */
export function billedCostForEvent(
  kind: string | null | undefined,
  chargedCents: number | null,
  freePlan = false,
): number | null {
  if (freePlan) return 0;
  if (kind && FREE_KIND_RE.test(kind)) return 0;
  if (chargedCents != null) return chargedCents / 100;
  return null;
}

/** Actually-billed cost sum across raw events. */
export function sumBilledCostDollars(
  events: UsageEventLike[],
  plan?: { membershipType?: string },
): number {
  const freePlan = plan?.membershipType?.startsWith('free') ?? false;
  if (freePlan) return 0;

  let cents = 0;
  for (const e of events) {
    if (e.kind && FREE_KIND_RE.test(e.kind)) continue;
    if (e.chargedCents != null) cents += e.chargedCents;
  }
  return cents / 100;
}

export interface KindTotal {
  kind: string;
  count: number;
  tokenCostDollars: number;
  chargedDollars: number;
}

/**
 * Per-`kind` totals for the current window.
 *
 * cursor.com reports usage as Total / Included / On-demand, and `kind` is the
 * only field that says which bucket a row belongs to ("Included in Business",
 * "Usage-based", "Errored, Not Charged", …). Splitting the same events that way
 * is what makes a disagreement with cursor.com legible: whether the gap is
 * extra rows, a bucket counted on one side only, or the same rows priced
 * differently.
 */
export function eventKindTotals(
  events: (UsageEventLike & { kind?: string })[],
): KindTotal[] {
  const byKind = new Map<string, KindTotal>();
  for (const e of events) {
    const kind = e.kind || '(no kind)';
    let row = byKind.get(kind);
    if (!row) {
      row = { kind, count: 0, tokenCostDollars: 0, chargedDollars: 0 };
      byKind.set(kind, row);
    }
    row.count++;
    row.tokenCostDollars += sumTokenCostDollars([e]);
    row.chargedDollars += (e.chargedCents ?? 0) / 100;
  }
  return [...byKind.values()].sort((a, b) => b.tokenCostDollars - a.tokenCostDollars);
}

export type StatusBarQuotaFormat = 'usedLimit' | 'remaining';
export type StatusBarFillStyle = 'dots' | 'blocks' | 'squares' | 'stars' | 'bars' | 'none';

const FILL_CHARS: Record<Exclude<StatusBarFillStyle, 'none'>, [string, string]> = {
  dots: ['●', '○'],
  blocks: ['█', '░'],
  squares: ['■', '□'],
  stars: ['★', '☆'],
  bars: ['▮', '▯'],
};

// Half-fill glyph per style, for segments that are only partly used. Stars has no
// widely-supported half-star glyph, so it falls back to whole-segment steps only.
const HALF_CHARS: Partial<Record<Exclude<StatusBarFillStyle, 'none'>, string>> = {
  dots: '◐',
  blocks: '▌',
  squares: '◧',
  bars: '▬',
};

/** Compact fill indicator for quota usage (e.g. ●●◐○○ at ~50%). */
export function quotaFillBar(
  used: number,
  limit: number,
  segments = 5,
  style: StatusBarFillStyle = 'dots',
): string {
  if (limit <= 0 || style === 'none') return '';
  const ratio = Math.min(1, Math.max(0, used / limit));
  const [full, empty] = FILL_CHARS[style];
  const half = HALF_CHARS[style];

  if (!half) {
    const filled =
      ratio >= 1 ? segments : ratio <= 0 ? 0 : Math.max(1, Math.floor(ratio * segments));
    return full.repeat(filled) + empty.repeat(segments - filled);
  }

  const exact = ratio * segments;
  const filled = Math.min(segments, Math.floor(exact));
  const hasHalf = filled < segments && exact - filled >= 0.5;
  const emptyCount = segments - filled - (hasHalf ? 1 : 0);
  return full.repeat(filled) + (hasHalf ? half : '') + empty.repeat(emptyCount);
}

/** Short month/day for the status bar, e.g. "Jul 12". */
export function formatQuotaResetShort(resetIso?: string): string {
  if (!resetIso) return '';
  const d = new Date(resetIso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * The status bar's main figure. Plans with a fixed included-request quota show
 * how many requests are left and when the cycle resets (e.g. "390 left · Jul 12");
 * once exhausted, pin at limit/limit and append on-demand spend. Token-metered
 * plans show cost.
 */
export function statusBarText(opts: {
  quota?: QuotaLike | null;
  costDollars: number;
  onDemandDollars: number;
  showWhatIfPrefix: boolean;
  quotaFormat?: StatusBarQuotaFormat;
  fillStyle?: StatusBarFillStyle;
  /** Monthly spend budget, for plans metered in dollars rather than requests. */
  budget?: { spentDollars: number; budgetDollars: number; resetIso?: string } | null;
}): string {
  const {
    quota,
    costDollars,
    onDemandDollars,
    showWhatIfPrefix,
    quotaFormat = 'usedLimit',
    fillStyle = 'dots',
    budget,
  } = opts;
  if (quota?.limit != null && quota.limit > 0) {
    const limit = quota.limit;
    const reset = formatQuotaResetShort(quota.resetIso);
    const resetSuffix = reset ? ` · ${reset}` : '';
    const fill = quotaFillBar(quota.used, limit, 5, fillStyle);
    const fillSuffix = fill ? ` ${fill}` : '';
    const shownUsed = Math.min(quota.used, limit);
    const usedLimitLabel = `${shownUsed.toLocaleString('en-US')}/${limit.toLocaleString('en-US')}`;

    if (quota.used >= limit) {
      const base = `${usedLimitLabel}${fillSuffix}`;
      const withCost =
        onDemandDollars > 0 ? `${base} · $${onDemandDollars.toFixed(2)}` : base;
      return `${withCost}${resetSuffix}`;
    }

    if (quotaFormat === 'remaining') {
      const remaining = limit - quota.used;
      return `${remaining.toLocaleString('en-US')} left${fillSuffix}${resetSuffix}`;
    }

    return `${usedLimitLabel}${fillSuffix}${resetSuffix}`;
  }

  // No request allowance, but a dollar budget: same gauge, same format and fill
  // settings, denominated in money. Without this the quota-shaped settings do
  // nothing at all for anyone on a budget-metered plan.
  if (budget && budget.budgetDollars > 0) {
    const { spentDollars, budgetDollars } = budget;
    const reset = formatQuotaResetShort(budget.resetIso);
    const resetSuffix = reset ? ` · ${reset}` : '';
    const fill = quotaFillBar(spentDollars, budgetDollars, 5, fillStyle);
    const fillSuffix = fill ? ` ${fill}` : '';
    if (quotaFormat === 'remaining') {
      const remaining = Math.max(0, budgetDollars - spentDollars);
      return `$${remaining.toFixed(2)} left${fillSuffix}${resetSuffix}`;
    }
    return `$${spentDollars.toFixed(2)}/$${budgetDollars.toFixed(2)}${fillSuffix}${resetSuffix}`;
  }

  return `${showWhatIfPrefix ? '~' : ''}$${costDollars.toFixed(2)}`;
}

/** % of a plan quota used, or null when there's no real limit. */
export function quotaPercentUsed(quota: QuotaLike | null | undefined): number | null {
  if (quota?.limit == null || quota.limit <= 0) return null;
  return (quota.used / quota.limit) * 100;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BudgetRunway {
  budgetDollars: number;
  spentDollars: number;
  /** Negative once spend has passed the budget — callers decide how to show it. */
  remainingDollars: number;
  overBudget: boolean;
  percentUsed: number;
  /** Observed pace so far this cycle; null until enough of the cycle has elapsed. */
  dailySpend: number | null;
  daysToExhaustion: number | null;
  exhaustionDate: Date | null;
  daysUntilReset: number | null;
  /** True when the budget runs out before the cycle resets — the case worth warning about. */
  exhaustsBeforeReset: boolean | null;
  /** Spend per day from now that still lands exactly on the budget at reset. */
  safeDailySpend: number | null;
}

/**
 * Budget-plan equivalent of projectExhaustionDate: how long the money lasts at
 * the current pace, and what daily spend fits the rest of the cycle.
 *
 * Every figure is derived from the budget and spend passed in on this call, and
 * nothing is carried between calls. That is what makes a budget that changes
 * mid-cycle correct without special handling: raise it and the runway simply
 * grows from the same recorded spend; cut it — even below what's already
 * spent — and the result reports over-budget rather than a negative runway.
 * Callers must therefore pass the budget as it stands now, never a value
 * captured when the cycle began.
 *
 * The pace is the cycle's average (spend ÷ elapsed), matching how the
 * request-quota projection works; a caller with a better estimate can pass
 * `dailySpendOverride` (e.g. a trailing 7-day rate) without changing this math.
 */
export function projectBudgetRunway(opts: {
  spentDollars: number;
  budgetDollars: number | null | undefined;
  cycleStartMs: number;
  /** Cycle reset time; enables the "before reset?" verdict and safe daily spend. */
  cycleEndMs?: number | null;
  nowMs?: number;
  dailySpendOverride?: number | null;
}): BudgetRunway | null {
  const { spentDollars, budgetDollars, cycleStartMs, cycleEndMs, dailySpendOverride } = opts;
  const nowMs = opts.nowMs ?? Date.now();
  if (budgetDollars == null || !(budgetDollars > 0)) return null;
  if (!Number.isFinite(cycleStartMs) || cycleStartMs > nowMs) return null;

  const spent = Math.max(0, spentDollars);
  const remainingDollars = budgetDollars - spent;
  const overBudget = remainingDollars <= 0;
  const percentUsed = (spent / budgetDollars) * 100;

  const elapsedDays = (nowMs - cycleStartMs) / DAY_MS;
  // Under half a day in, spend ÷ elapsed swings wildly — one big request would
  // project a budget gone in hours. Report no pace rather than a scary guess.
  let dailySpend = dailySpendOverride ?? (elapsedDays >= 0.5 ? spent / elapsedDays : null);
  if (dailySpend != null && !(dailySpend > 0)) dailySpend = null;

  const daysUntilReset = cycleEndMs != null && cycleEndMs > nowMs
    ? (cycleEndMs - nowMs) / DAY_MS
    : null;

  let daysToExhaustion: number | null = null;
  let exhaustionDate: Date | null = null;
  if (overBudget) {
    daysToExhaustion = 0;
    exhaustionDate = new Date(nowMs);
  } else if (dailySpend != null) {
    daysToExhaustion = remainingDollars / dailySpend;
    exhaustionDate = new Date(nowMs + daysToExhaustion * DAY_MS);
  }

  return {
    budgetDollars,
    spentDollars: spent,
    remainingDollars,
    overBudget,
    percentUsed,
    dailySpend,
    daysToExhaustion,
    exhaustionDate,
    daysUntilReset,
    exhaustsBeforeReset: daysToExhaustion != null && daysUntilReset != null
      ? daysToExhaustion < daysUntilReset
      : null,
    safeDailySpend: daysUntilReset != null && daysUntilReset > 0 && !overBudget
      ? remainingDollars / daysUntilReset
      : null,
  };
}

/** Which period the selected range is measured against on the Analytics tab. */
export type ComparisonMode = 'previous' | 'prevMonth' | 'custom';

export interface DateWindow {
  startMs: number;
  endMs: number;
}

/**
 * Shift a timestamp by whole calendar months, keeping the time of day.
 *
 * The day is clamped to the target month's length before the month moves:
 * `setMonth` on the 31st lands in the month *after* the one asked for
 * (Mar 31 − 1 month = Mar 3), which would silently compare against the wrong
 * month for anyone whose range ends on the 29th–31st.
 */
export function shiftMonths(ms: number, delta: number): number {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return NaN;
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + delta);
  const daysInTargetMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, daysInTargetMonth));
  return d.getTime();
}

/**
 * The window the selected range is compared against.
 *
 * - `previous`  — the equal-length window ending the instant before the range
 *   starts. Slides with the range; never calendar-aligned.
 * - `prevMonth` — the same calendar dates one month earlier. Lengths can
 *   differ (Mar 1–31 vs Feb 1–28), which is the point: it answers "same dates
 *   last month", not "same number of days".
 * - `custom`    — whatever the user picked; null until both ends are valid, so
 *   a half-filled picker shows a prompt instead of a wrong baseline.
 */
export function comparisonWindow(opts: {
  startMs: number;
  endMs: number;
  mode: ComparisonMode;
  customStartMs?: number | null;
  customEndMs?: number | null;
}): DateWindow | null {
  const { startMs, endMs, mode, customStartMs, customEndMs } = opts;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;

  if (mode === 'custom') {
    if (!customStartMs || !customEndMs) return null;
    if (!Number.isFinite(customStartMs) || !Number.isFinite(customEndMs)) return null;
    if (customEndMs < customStartMs) return null;
    return { startMs: customStartMs, endMs: customEndMs };
  }

  if (mode === 'prevMonth') {
    const shiftedStart = shiftMonths(startMs, -1);
    const shiftedEnd = shiftMonths(endMs, -1);
    if (Number.isNaN(shiftedStart) || Number.isNaN(shiftedEnd)) return null;
    return { startMs: shiftedStart, endMs: shiftedEnd };
  }

  const prevEndMs = startMs - 1;
  return { startMs: prevEndMs - (endMs - startMs), endMs: prevEndMs };
}

/**
 * Per-model cost across two periods, biggest mover first.
 *
 * Sorted by the absolute size of the change rather than by spend: a model that
 * went from $2 to $14 is the answer to "why did my bill move", and sorting by
 * total would bury it under a model that cost more but didn't budge. Models
 * present in only one period are kept, with 0 on the side they're missing —
 * dropping them would hide exactly the "I switched models" case.
 */
export function modelCostDeltas(
  current: Map<string, number> | Record<string, number>,
  baseline: Map<string, number> | Record<string, number>,
): { model: string; current: number; baseline: number; delta: number }[] {
  const cur = current instanceof Map ? current : new Map(Object.entries(current));
  const base = baseline instanceof Map ? baseline : new Map(Object.entries(baseline));
  const models = new Set([...cur.keys(), ...base.keys()]);
  return [...models]
    .map((model) => {
      const c = cur.get(model) ?? 0;
      const b = base.get(model) ?? 0;
      return { model, current: c, baseline: b, delta: c - b };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || b.current - a.current);
}

/**
 * Straight-line projection of when `used` will hit `limit`, from the average
 * daily pace since `sinceMs`.
 */
export function projectExhaustionDate(
  used: number,
  limit: number | null | undefined,
  sinceMs: number,
  nowMs: number = Date.now(),
): Date | null {
  if (limit == null || limit <= 0 || used <= 0) return null;
  const elapsedDays = (nowMs - sinceMs) / (24 * 60 * 60 * 1000);
  if (elapsedDays < 0.5) return null;
  const perDay = used / elapsedDays;
  if (perDay <= 0) return null;
  const remaining = limit - used;
  if (remaining <= 0) return new Date(nowMs);
  const daysLeft = remaining / perDay;
  return new Date(nowMs + daysLeft * 24 * 60 * 60 * 1000);
}
