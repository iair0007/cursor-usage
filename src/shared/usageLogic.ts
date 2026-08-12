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
 * What-if event cost sum; mirrors normalize() priority: token-based plans bill
 * chargedCents, otherwise model token cost (tokenUsage.totalCents +
 * cursorTokenFee), otherwise chargedCents. API-equivalent value, not billed.
 */
export function sumTokenCostDollars(events: UsageEventLike[]): number {
  let cents = 0;
  for (const e of events) {
    const modelCents =
      e.tokenUsage?.totalCents != null
        ? e.tokenUsage.totalCents + (e.cursorTokenFee ?? 0)
        : null;
    if (e.isTokenBasedCall && e.chargedCents != null) cents += e.chargedCents;
    else if (modelCents != null) cents += modelCents;
    else if (e.chargedCents != null) cents += e.chargedCents;
  }
  return cents / 100;
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
}): string {
  const {
    quota,
    costDollars,
    onDemandDollars,
    showWhatIfPrefix,
    quotaFormat = 'usedLimit',
    fillStyle = 'dots',
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
  return `${showWhatIfPrefix ? '~' : ''}$${costDollars.toFixed(2)}`;
}

/** % of a plan quota used, or null when there's no real limit. */
export function quotaPercentUsed(quota: QuotaLike | null | undefined): number | null {
  if (quota?.limit == null || quota.limit <= 0) return null;
  return (quota.used / quota.limit) * 100;
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
