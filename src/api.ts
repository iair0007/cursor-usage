import { CursorSession } from './authCore';

/** Shape the webview's normalize() consumes (same as the original web app). */
export interface RawUsageEvent {
  id: string;
  timestamp: number | string;
  model: string;
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

export class ApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
  }
}

const PAGE_SIZE = 100;
const MAX_PAGES = 500;
const USER_AGENT = 'cursor-usage-dashboard-extension';

// cursor.com rejects state-changing (POST) requests whose Origin doesn't match
// the site ("Invalid origin for state-changing request" CSRF check), so mimic
// the browser dashboard's headers on every cursor.com call.
const BROWSER_HEADERS: Record<string, string> = {
  Origin: 'https://cursor.com',
  Referer: 'https://cursor.com/dashboard',
  'User-Agent': USER_AGENT,
};

type LogFn = (message: string) => void;
let log: LogFn = () => {};

/** Install a logger (e.g. a VS Code output channel) for request tracing. */
export function setApiLogger(fn: LogFn): void {
  log = fn;
}

async function fetchJson(url: string, options: RequestInit, timeoutMs = 20000): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  const method = options.method || 'GET';
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      log(`${method} ${url} -> HTTP ${res.status} in ${Date.now() - started}ms: ${text.slice(0, 300)}`);
      throw new ApiError(data?.message || data?.error || `HTTP ${res.status}`, res.status);
    }
    log(`${method} ${url} -> ${res.status} in ${Date.now() - started}ms`);
    return data;
  } catch (e: any) {
    if (e instanceof ApiError) throw e;
    log(`${method} ${url} -> ${e?.name === 'AbortError' ? 'timeout' : e?.message} in ${Date.now() - started}ms`);
    if (e?.name === 'AbortError') throw new ApiError(`Request timed out: ${url}`);
    throw new ApiError(e?.message || String(e));
  } finally {
    clearTimeout(timer);
  }
}

function num(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Parse cost fields that may arrive as cents, "$0.04", "0.04", or "-". */
function toCents(v: unknown): number | null {
  if (v == null || v === '' || v === '-') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const m = String(v).match(/([\d.]+)/);
  if (!m) return null;
  const parsed = parseFloat(m[1]);
  if (!Number.isFinite(parsed)) return null;
  // Strings on these endpoints are dollar amounts; numbers are cents.
  return Math.round(parsed * 100 * 1000) / 1000;
}

function pickChargedCents(e: any): number | null {
  if (e.chargedCents != null) return num(e.chargedCents);
  const usageBased = toCents(e.usageBasedCosts);
  if (usageBased != null) return usageBased;
  return toCents(e.requestsCosts);
}

export function toRawEvent(e: any): RawUsageEvent {
  const tu = e.tokenUsage || null;
  return {
    id: String(e.id ?? e.eventId ?? `${e.timestamp}-${e.model ?? 'unknown'}`),
    timestamp: e.timestamp ?? e.timestampEpoch ?? 0,
    model: e.model || e.modelIntent || 'unknown',
    kind: e.kind || e.kindLabel,
    isTokenBasedCall: Boolean(e.isTokenBasedCall),
    chargedCents: pickChargedCents(e),
    cursorTokenFee: num(e.cursorTokenFee ?? tu?.cursorTokenFee),
    tokenUsage: tu
      ? {
          inputTokens: num(tu.inputTokens) ?? 0,
          outputTokens: num(tu.outputTokens) ?? 0,
          cacheReadTokens: num(tu.cacheReadTokens) ?? 0,
          cacheWriteTokens: num(tu.cacheWriteTokens) ?? 0,
          totalCents: num(tu.totalCents) ?? undefined,
        }
      : null,
  };
}

/**
 * Collects a page of raw rows, skipping any event id already seen.
 *
 * Paging these endpoints is best-effort: the page parameter isn't documented,
 * and an endpoint that ignores it answers every request with the same first
 * page. Appending those blindly double-counts real usage — every total, chart
 * and average silently inflates by a whole page. Returns how many genuinely new
 * rows the page contributed so callers can stop when a page adds nothing.
 *
 * Rows without a server-assigned id are always kept: their synthesized id
 * (timestamp + model) can legitimately collide between two concurrent
 * requests, and dropping those would lose real usage.
 */
function collectPage(batch: any[], seenIds: Set<string>, into: RawUsageEvent[]): number {
  let added = 0;
  for (const e of batch) {
    const rawId = e?.id ?? e?.eventId;
    if (rawId != null) {
      const key = String(rawId);
      if (seenIds.has(key)) continue;
      seenIds.add(key);
    }
    into.push(toRawEvent(e));
    added++;
  }
  return added;
}

/** Personal usage via the cursor.com dashboard API (session cookie auth). */
export async function fetchDashboardUsage(
  session: CursorSession,
  startMs: number,
  endMs: number,
): Promise<RawUsageEvent[]> {
  const events: RawUsageEvent[] = [];
  const seenIds = new Set<string>();
  let page = 1;

  for (; page <= MAX_PAGES; page++) {
    const data = await fetchJson('https://cursor.com/api/dashboard/get-filtered-usage-events', {
      method: 'POST',
      headers: {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/json',
        Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
      },
      body: JSON.stringify({
        teamId: 0,
        startDate: String(startMs),
        endDate: String(endMs),
        page,
        pageSize: PAGE_SIZE,
      }),
    });

    const batch: any[] = data.usageEventsDisplay || data.usageEvents || data.events || [];
    const added = collectPage(batch, seenIds, events);
    if (batch.length && added === 0) {
      log(`Page ${page} repeated rows already collected — stopping to avoid double-counting usage.`);
      break;
    }

    const total = num(data.totalUsageEventsCount);
    const hasNext =
      data.pagination?.hasNextPage ??
      (total != null ? page * PAGE_SIZE < total : batch.length === PAGE_SIZE);
    if (!batch.length || !hasNext) break;
  }

  return events;
}

/** Team usage via the official Admin API (Basic auth with an admin key). */
export async function fetchAdminUsage(
  apiKey: string,
  startMs: number,
  endMs: number,
): Promise<RawUsageEvent[]> {
  const auth = Buffer.from(`${apiKey}:`).toString('base64');
  const events: RawUsageEvent[] = [];
  const seenIds = new Set<string>();
  let page = 1;

  for (; page <= MAX_PAGES; page++) {
    const data = await fetchJson('https://api.cursor.com/teams/filtered-usage-events', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({ startDate: startMs, endDate: endMs, page, pageSize: PAGE_SIZE }),
    });

    const batch: any[] = data.usageEvents || data.events || [];
    const added = collectPage(batch, seenIds, events);
    if (batch.length && added === 0) {
      log(`Page ${page} repeated rows already collected — stopping to avoid double-counting usage.`);
      break;
    }

    const hasNext = data.pagination?.hasNextPage ?? batch.length === PAGE_SIZE;
    if (!batch.length || !hasNext) break;
  }

  return events;
}

export interface PlanInfo {
  /** e.g. 'free', 'free_trial', 'pro', 'business', 'enterprise', 'unknown' */
  membershipType: string;
  daysRemainingOnTrial?: number | null;
}

/** Account plan/membership via the same endpoint the cursor.com dashboard uses. */
export async function fetchStripeProfile(session: CursorSession): Promise<PlanInfo> {
  const data = await fetchJson('https://cursor.com/api/auth/stripe', {
    method: 'GET',
    headers: {
      ...BROWSER_HEADERS,
      Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
    },
  });
  return {
    membershipType: String(
      data?.membershipType ?? data?.individualMembershipType ?? 'unknown',
    ).toLowerCase(),
    daysRemainingOnTrial: num(data?.daysRemainingOnTrial),
  };
}

export interface PlanQuota {
  used: number;
  limit: number | null;
  startOfCycleIso?: string;
  /** startOfCycleIso + 1 month, when known — the quota's next reset. */
  resetIso?: string;
}

/** startOfCycleIso -> resetIso (one calendar month later), tolerant of malformed dates. */
function computeResetIso(startOfCycleIso: string | undefined): string | undefined {
  if (!startOfCycleIso) return undefined;
  const start = new Date(startOfCycleIso);
  if (Number.isNaN(start.getTime())) return undefined;
  const reset = new Date(start);
  reset.setMonth(reset.getMonth() + 1);
  return reset.toISOString();
}

/**
 * Parse cursor.com's legacy usage-quota shape: buckets keyed by model family
 * with numRequests/maxRequestUsage (e.g. { "gpt-4": { numRequests, maxRequestUsage } }).
 * Defensive by design — this endpoint's shape isn't documented, so any
 * mismatch just yields null and the quota card is hidden rather than showing
 * a wrong number.
 */
export function parseQuotaResponse(data: any): PlanQuota | null {
  if (!data || typeof data !== 'object') return null;
  let best: PlanQuota | null = null;
  for (const [key, v] of Object.entries<any>(data)) {
    if (!v || typeof v !== 'object') continue;
    if (!('numRequests' in v) && !('maxRequestUsage' in v)) continue;
    const quota: PlanQuota = {
      used: num(v.numRequests) ?? num(v.numRequestsTotal) ?? 0,
      limit: num(v.maxRequestUsage),
    };
    if (key === 'gpt-4') {
      best = quota;
      break;
    }
    if (!best || (best.limit == null && quota.limit != null)) best = quota;
  }
  if (!best) return null;
  if (typeof data.startOfMonth === 'string') {
    best.startOfCycleIso = data.startOfMonth;
    best.resetIso = computeResetIso(data.startOfMonth);
  }
  return best;
}

/** Included/premium request quota for the current billing cycle (undocumented endpoint — best-effort). */
export async function fetchPlanQuota(session: CursorSession): Promise<PlanQuota | null> {
  const data = await fetchJson(
    `https://cursor.com/api/usage?user=${encodeURIComponent(session.userId)}`,
    {
      method: 'GET',
      headers: {
        ...BROWSER_HEADERS,
        Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
      },
    },
  );
  // This endpoint's shape is undocumented and guessed at — log the raw body
  // (once per call, capped) so a mismatch can be diagnosed from Show Logs
  // instead of guessed at blind.
  log(`Quota raw response: ${JSON.stringify(data).slice(0, 800)}`);
  const parsed = parseQuotaResponse(data);
  log(`Quota parsed: ${parsed ? JSON.stringify(parsed) : 'null (no recognizable bucket found)'}`);
  return parsed;
}

/** Usage-based spending hard limit in dollars (0/null when unset — undocumented endpoint, best-effort). */
export async function fetchHardLimit(session: CursorSession): Promise<number | null> {
  const data = await fetchJson('https://cursor.com/api/dashboard/get-hard-limit', {
    method: 'POST',
    headers: {
      ...BROWSER_HEADERS,
      'Content-Type': 'application/json',
      Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
    },
    body: '{}',
  });
  log(`Hard-limit raw response: ${JSON.stringify(data).slice(0, 300)}`);
  const limit = num(data?.hardLimit);
  return limit != null && limit > 0 ? limit : null;
}

/** Validates the session and returns account info. */
export async function fetchMe(session: CursorSession): Promise<{ email?: string; name?: string }> {
  const data = await fetchJson('https://cursor.com/api/auth/me', {
    method: 'GET',
    headers: {
      ...BROWSER_HEADERS,
      Cookie: `WorkosCursorSessionToken=${session.cookieValue}`,
    },
  });
  return { email: data?.email, name: data?.name };
}

/** Model pricing docs as markdown; the webview's parsePricing consumes it. */
export async function fetchPricingMarkdown(): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch('https://cursor.com/docs/models-and-pricing.md', {
      headers: BROWSER_HEADERS,
      signal: controller.signal,
    });
    if (!res.ok) throw new ApiError(`Pricing fetch failed: HTTP ${res.status}`, res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}
