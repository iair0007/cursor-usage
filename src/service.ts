import * as vscode from 'vscode';
import {
  CursorSession,
  getAdminApiKey,
  resolveSession,
} from './auth';
import {
  ApiError,
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
} from './api';
import {
  billingCycleWindow,
  eventTimestampSpan,
  eventsWithinRange,
  rollingDayWindow,
  type StatusBarPeriodMode,
} from './shared/usageLogic';

export {
  billingCycleWindow,
  clampPeriodDays,
  countRequests,
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

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  /** Drop cached session and usage after credential changes or manual refresh. */
  invalidateCaches(): void {
    this.sessionCache = null;
    this.usageCache.clear();
    this.usageInflight.clear();
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

    const quota = await fetchPlanQuota(session).catch((e) => {
      this.log(`Quota prefetch failed (non-fatal): ${e?.message || e}`);
      return undefined;
    });
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
        fetchStripeProfile(session).catch((e) => {
          this.log(`Plan lookup failed (non-fatal): ${e?.message || e}`);
          return undefined;
        }),
        fetchPlanQuota(session).catch((e) => {
          this.log(`Quota lookup failed (non-fatal): ${e?.message || e}`);
          return undefined;
        }),
        fetchHardLimit(session).catch((e) => {
          this.log(`Hard-limit lookup failed (non-fatal): ${e?.message || e}`);
          return undefined;
        }),
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
