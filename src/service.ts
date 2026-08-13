import * as vscode from 'vscode';
import {
  CursorSession,
  getAdminApiKey,
  resolveSession,
} from './auth';
import {
  ApiError,
  BudgetLookup,
  PlanInfo,
  PlanQuota,
  RawUsageEvent,
  fetchAdminUsage,
  fetchDashboardUsage,
  fetchHardLimit,
  fetchMe,
  fetchPlanQuota,
  fetchPricingMarkdown,
  fetchStripeProfile,
  fetchBudget,
} from './api';
import {
  billingCycleWindow,
  eventKindTotals,
  eventTimestampSpan,
  eventsWithinRange,
  projectBudgetRunway,
  rollingDayWindow,
  sumPlanMeteredDollars,
  sumTokenCostDollars,
  type BudgetRunway,
  type StatusBarPeriodMode,
} from './shared/usageLogic';

export {
  billingCycleWindow,
  clampPeriodDays,
  countRequests,
  eventBillingRegime,
  eventCostDollars,
  eventKindTotals,
  planMeteredDollars,
  projectBudgetRunway,
  sumPlanMeteredDollars,
  eventTimestampMs,
  eventTimestampSpan,
  eventsWithinRange,
  formatCycleRangeLabel,
  parseStatusBarPeriodConfig,
  projectExhaustionDate,
  quotaPercentUsed,
  quotaFillBar,
  rollingDayWindow,
  statusBarText,
  statusBarWindow,
  sumBilledCostDollars,
  sumTokenCostDollars,
} from './shared/usageLogic';
export type { StatusBarFillStyle, StatusBarPeriodMode, StatusBarQuotaFormat } from './shared/usageLogic';

export interface BudgetStatus {
  budgetDollars: number | null;
  /** Where the budget came from — the panel says so rather than implying Cursor reported it. */
  source: 'setting' | 'cursor' | 'hardLimit' | 'none';
  /** Which setting or endpoint field supplied it, so a wrong value is traceable. */
  sourceDetail?: string;
  spentDollars: number;
  cycleStartMs: number;
  cycleEndMs: number;
  runway: BudgetRunway | null;
}

export interface UsageResult {
  events: RawUsageEvent[];
  authMode: 'admin' | 'session' | 'none';
  email?: string;
  plan?: PlanInfo;
  quota?: PlanQuota;
  hardLimit?: number | null;
  note?: string;
}

const SESSION_CACHE_TTL_MS = 5 * 60 * 1000;
const USAGE_CACHE_TTL_MS = 2 * 60 * 1000;
/** Quota moves with usage, so it tracks the usage cache. */
const QUOTA_CACHE_TTL_MS = 2 * 60 * 1000;
/** Plan and spend cap change on billing events, not on requests. */
const PROFILE_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * Shared data layer for the dashboard panel and the status bar. Mirrors the
 * original server.js auth priority: Admin API key -> Cursor IDE session ->
 * none.
 */
export class UsageService {
  private pricingCache: { markdown: string; fetchedAt: number } | null = null;
  private sessionCache: { session: CursorSession | null; fetchedAt: number } | null = null;
  private usageCache = new Map<string, { result: UsageResult; fetchedAt: number }>();
  private usageInflight = new Map<string, Promise<UsageResult>>();
  private lookupCache = new Map<string, { value: unknown; fetchedAt: number }>();
  private lookupInflight = new Map<string, Promise<unknown>>();
  /** undefined = not looked up yet; null = looked up and nothing found. */
  private budgetLookup: BudgetLookup | null | undefined = undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** Drop cached session and usage after credential changes or manual refresh. */
  invalidateCaches(): void {
    this.sessionCache = null;
    this.usageCache.clear();
    this.usageInflight.clear();
    this.lookupCache.clear();
    this.lookupInflight.clear();
    this.budgetLookup = undefined;
  }

  /**
   * Memoizes the small per-account lookups (quota, plan, spend cap) that hang
   * off almost every operation.
   *
   * Without this, one dashboard open produced dozens of identical calls: the
   * panel asks for usage and for the budget, the budget asks for cycle usage,
   * the cycle lookup asks for the quota, the status bar refreshes after every
   * one of those, and each comparison period adds another round. The usage
   * responses were already cached; these three were not, so they were the ones
   * left hammering cursor.com.
   *
   * Concurrent callers join the in-flight promise rather than starting their
   * own, which is what collapses the burst that happens on open.
   */
  private async cachedLookup<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = this.lookupCache.get(key);
    if (hit && Date.now() - hit.fetchedAt < ttlMs) return hit.value as T;

    const inflight = this.lookupInflight.get(key);
    if (inflight) return inflight as Promise<T>;

    const promise = fn()
      .then((value) => {
        this.lookupCache.set(key, { value, fetchedAt: Date.now() });
        this.lookupInflight.delete(key);
        return value;
      })
      .catch((e) => {
        this.lookupInflight.delete(key);
        throw e;
      });
    this.lookupInflight.set(key, promise as Promise<unknown>);
    return promise;
  }

  private quota(session: CursorSession): Promise<PlanQuota | null | undefined> {
    return this.cachedLookup(`quota:${session.userId}`, QUOTA_CACHE_TTL_MS, () =>
      fetchPlanQuota(session).catch((e) => {
        this.log(`Quota lookup failed (non-fatal): ${e?.message || e}`);
        return undefined;
      }));
  }

  private plan(session: CursorSession): Promise<PlanInfo | undefined> {
    return this.cachedLookup(`plan:${session.userId}`, PROFILE_CACHE_TTL_MS, () =>
      fetchStripeProfile(session).catch((e) => {
        this.log(`Plan lookup failed (non-fatal): ${e?.message || e}`);
        return undefined;
      }));
  }

  private hardLimit(session: CursorSession): Promise<number | null | undefined> {
    return this.cachedLookup(`hardLimit:${session.userId}`, PROFILE_CACHE_TTL_MS, () =>
      fetchHardLimit(session).catch((e) => {
        this.log(`Hard-limit lookup failed (non-fatal): ${e?.message || e}`);
        return undefined;
      }));
  }

  async getSession(): Promise<CursorSession | null> {
    if (
      this.sessionCache &&
      Date.now() - this.sessionCache.fetchedAt < SESSION_CACHE_TTL_MS
    ) {
      return this.sessionCache.session;
    }

    const session = await resolveSession(this.context, this.log);
    this.sessionCache = { session, fetchedAt: Date.now() };
    this.log(session
      ? `Session resolved (source: ${session.source}, user: ${session.userId}${session.email ? `, email: ${session.email}` : ''})`
      : 'No Cursor session found (state.vscdb unreadable or missing token, no manual token stored)');
    return session;
  }

  async getStatus(): Promise<{ authMode: 'admin' | 'session' | 'none'; email?: string }> {
    if (await getAdminApiKey(this.context)) return { authMode: 'admin' };
    const session = await this.getSession();
    if (session) return { authMode: 'session', email: session.email };
    return { authMode: 'none' };
  }

  /**
   * Usage for the status bar over the configured period (billing cycle or rolling days).
   */
  async getStatusBarUsage(opts: {
    mode: StatusBarPeriodMode;
    periodDays: number;
  }): Promise<UsageResult> {
    if (opts.mode === 'days') {
      const { start, end } = rollingDayWindow(opts.periodDays);
      return this.getUsage(start, end);
    }

    const adminKey = await getAdminApiKey(this.context);
    if (adminKey) {
      const { start, end } = billingCycleWindow(null);
      return this.getUsage(start, end);
    }

    const session = await this.getSession();
    if (!session) return { events: [], authMode: 'none' };

    const quota = await this.quota(session);
    const { start, end } = billingCycleWindow(quota ?? undefined);
    return this.getUsage(start, end);
  }

  async getUsage(startMs: number, endMs: number): Promise<UsageResult> {
    const key = await this.usageCacheKey(startMs, endMs);
    const cached = this.usageCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < USAGE_CACHE_TTL_MS) {
      this.log(`Usage cache hit (${key})`);
      return cached.result;
    }

    const inflight = this.usageInflight.get(key);
    if (inflight) {
      this.log(`Usage fetch in flight, joining (${key})`);
      return inflight;
    }

    const promise = this.fetchUsage(startMs, endMs)
      .then((result) => {
        this.pruneUsageCache();
        this.usageCache.set(key, { result, fetchedAt: Date.now() });
        this.usageInflight.delete(key);
        return result;
      })
      .catch((e) => {
        this.usageInflight.delete(key);
        throw e;
      });
    this.usageInflight.set(key, promise);
    return promise;
  }

  /**
   * Drop entries past their TTL. Every distinct date range the user loads gets
   * its own key, and a long-lived window (custom ranges, trend comparisons)
   * would otherwise keep every response it ever fetched alive for the session.
   */
  private pruneUsageCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.usageCache) {
      if (now - entry.fetchedAt >= USAGE_CACHE_TTL_MS) this.usageCache.delete(key);
    }
  }

  private async usageCacheKey(startMs: number, endMs: number): Promise<string> {
    const adminKey = await getAdminApiKey(this.context);
    if (adminKey) return `admin:${startMs}:${endMs}`;
    const session = await this.getSession();
    if (session) return `session:${session.userId}:${startMs}:${endMs}`;
    return `none:${startMs}:${endMs}`;
  }

  /**
   * Every consumer (panel, status bar) assumes the events it gets belong to the
   * window it asked for, so enforce that here rather than in each of them, and
   * log what the API actually returned — a mismatch between the requested
   * window and the events' real span is the difference between "cursor.com
   * disagrees with this extension" and "this extension has a bug".
   */
  private scopeToWindow(
    events: RawUsageEvent[],
    startMs: number,
    endMs: number,
  ): RawUsageEvent[] {
    const iso = (ms: number) => new Date(ms).toISOString();
    const span = eventTimestampSpan(events);
    this.log(
      `Usage window ${iso(startMs)} → ${iso(endMs)}: API returned ${events.length} event(s)`
      + (span ? ` spanning ${iso(span.min)} → ${iso(span.max)}` : ' (none carry a usable timestamp)'),
    );

    const kept = eventsWithinRange(events, startMs, endMs);
    if (kept.length !== events.length) {
      this.log(
        `Dropped ${events.length - kept.length} event(s) outside the requested window — `
        + 'cursor.com returned rows beyond the range it was asked for; totals now cover the '
        + 'selected range only.',
      );
    }

    // Printed in cursor.com's own vocabulary (Total / Included / On-demand) so
    // the panel's figures can be reconciled against the dashboard line by line
    // instead of eyeballed.
    const money = (d: number) => `$${d.toFixed(2)}`;
    const kinds = eventKindTotals(kept)
      .map((k) => `"${k.kind}" ×${k.count} token ${money(k.tokenCostDollars)} / charged ${money(k.chargedDollars)}`)
      .join(', ');
    this.log(
      `In-window totals: ${kept.length} event(s) · token cost ${money(sumTokenCostDollars(kept))}`
      + ` · by kind: ${kinds || '(none)'}`,
    );
    return kept;
  }

  private async fetchUsage(startMs: number, endMs: number): Promise<UsageResult> {
    const adminKey = await getAdminApiKey(this.context);
    if (adminKey) {
      const events = this.scopeToWindow(
        await fetchAdminUsage(adminKey, startMs, endMs),
        startMs,
        endMs,
      );
      return { events, authMode: 'admin', note: 'Team usage via Admin API.' };
    }

    const session = await this.getSession();
    if (session) {
      const [rawEvents, plan, quota, hardLimit] = await Promise.all([
        fetchDashboardUsage(session, startMs, endMs),
        this.plan(session),
        this.quota(session),
        this.hardLimit(session),
      ]);
      const events = this.scopeToWindow(rawEvents, startMs, endMs);
      if (plan) this.log(`Plan: ${plan.membershipType}`);
      if (quota) this.log(`Quota: ${quota.used}/${quota.limit ?? '∞'}`);
      if (hardLimit) this.log(`Hard limit: $${hardLimit}`);
      let email = session.email;
      if (!email) {
        try {
          email = (await fetchMe(session)).email;
        } catch {
          // Non-fatal: usage already loaded.
        }
      }
      return {
        events,
        authMode: 'session',
        email,
        plan,
        quota: quota ?? undefined,
        hardLimit,
        note:
          session.source === 'ide'
            ? 'Signed in with your Cursor IDE session.'
            : 'Using manually stored session token.',
      };
    }

    return { events: [], authMode: 'none' };
  }

  /**
   * Spend against the monthly budget for the current cycle, with a burn-rate
   * projection. Reports the same money cursor.com's usage page shows as
   * "Total usage", so the two can be compared directly.
   *
   * The budget comes in per call rather than being stored: users raise or cut
   * it mid-cycle, and a figure captured at cycle start would quietly project
   * the wrong runway. cursor.com does not expose the budget through any
   * endpoint this extension can read, so the caller's setting is the primary
   * source and the usage-based spend cap is the fallback.
   *
   * (The value is passed in, not read from the workspace configuration here,
   * so this module stays free of the VS Code runtime and remains unit-testable
   * outside the extension host.)
   */
  async getBudgetStatus(configuredBudgetDollars = 0): Promise<BudgetStatus | null> {
    const configured = configuredBudgetDollars > 0 ? configuredBudgetDollars : 0;

    const usage = await this.getStatusBarUsage({ mode: 'cycle', periodDays: 30 });
    if (usage.authMode === 'none') return null;

    // Ask cursor.com only when the user hasn't set a budget themselves, and
    // cache the answer for the session: it's the same lookup on every refresh.
    if (configured === 0 && this.budgetLookup === undefined) {
      const session = await this.getSession();
      this.budgetLookup = session
        ? await fetchBudget(session, { teamId: usage.plan?.teamId, email: usage.email })
            .catch(() => null)
        : null;
    }

    const looked = configured > 0 ? null : this.budgetLookup;
    const budgetDollars = configured > 0 ? configured : (looked?.dollars ?? usage.hardLimit ?? null);
    const source: BudgetStatus['source'] = configured > 0
      ? 'setting'
      : (looked ? 'cursor' : (usage.hardLimit ? 'hardLimit' : 'none'));
    const sourceDetail = configured > 0 ? 'cursorUsage.budget.monthlyDollars' : looked?.source;

    const { start, end } = billingCycleWindow(usage.quota ?? undefined);
    // Metered spend only: requests priced by the older per-request plan never
    // counted against a dollar budget, so folding them in would show a budget
    // burning down that cursor.com considers untouched.
    const spentDollars = sumPlanMeteredDollars(usage.events);
    // The cycle ends when the quota resets; fall back to the window's end so a
    // missing reset date costs the "before reset?" verdict, not the projection.
    const resetMs = usage.quota?.resetIso ? new Date(usage.quota.resetIso).getTime() : NaN;
    const cycleEndMs = Number.isNaN(resetMs) ? end : resetMs;

    const runway = projectBudgetRunway({
      spentDollars,
      budgetDollars,
      cycleStartMs: start,
      cycleEndMs,
    });
    this.log(
      `Budget: ${budgetDollars != null ? `$${budgetDollars}` : 'not set'} (${sourceDetail || source}) · spent $${spentDollars.toFixed(2)} this cycle`
      + (runway?.dailySpend != null ? ` · $${runway.dailySpend.toFixed(2)}/day` : ''),
    );

    return { budgetDollars, source, sourceDetail, spentDollars, cycleStartMs: start, cycleEndMs, runway };
  }

  /** Pricing markdown, cached for an hour (it changes rarely). */
  async getPricingMarkdown(): Promise<string> {
    const ONE_HOUR = 60 * 60 * 1000;
    if (this.pricingCache && Date.now() - this.pricingCache.fetchedAt < ONE_HOUR) {
      return this.pricingCache.markdown;
    }
    const markdown = await fetchPricingMarkdown();
    this.pricingCache = { markdown, fetchedAt: Date.now() };
    return markdown;
  }

  isAuthError(e: unknown): boolean {
    return e instanceof ApiError && (e.status === 401 || e.status === 403);
  }
}
