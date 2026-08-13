'use strict';

// Pure dashboard logic (pricing parsing, event normalization, aggregation).
// No DOM or VS Code dependencies so it can be unit-tested in Node directly.

import {
  billedCostForEvent,
  comparisonWindow,
  countRequests,
  eventBillingRegime,
  eventTimestampMs,
  isCountedRequest,
  modelCostDeltas,
  planMeteredDollars,
  projectBudgetRunway,
  projectExhaustionDate,
  quotaPercentUsed,
  shiftMonths,
  statusBarText,
  sumBilledCostDollars,
  sumPlanMeteredDollars,
  sumTokenCostDollars,
} from '../shared/usageLogic.ts';

export {
  billedCostForEvent,
  comparisonWindow,
  countRequests,
  eventBillingRegime,
  eventTimestampMs,
  isCountedRequest,
  modelCostDeltas,
  planMeteredDollars,
  projectBudgetRunway,
  projectExhaustionDate,
  quotaPercentUsed,
  shiftMonths,
  statusBarText,
  sumBilledCostDollars,
  sumPlanMeteredDollars,
  sumTokenCostDollars,
};

export const MODEL_ALIASES = {
  auto: ['auto', 'default', 'cursor-auto'],
  'claude-4-5-sonnet': ['claude-4.5-sonnet', 'claude-4-5-sonnet'],
  'claude-4-6-sonnet': ['claude-4.6-sonnet', 'claude-4-6-sonnet'],
  'claude-4-6-opus': ['claude-4.6-opus', 'claude-4-6-opus'],
  'composer-2-5': ['composer-2.5', 'composer-2-5', 'composer'],
  'gpt-5-2': ['gpt-5.2', 'gpt-5-2'],
  'gpt-5-4': ['gpt-5.4', 'gpt-5-4-mini'],
  'gemini-3-1-pro': ['gemini-3.1-pro', 'gemini-3-pro'],
};

export function parseDollar(v) {
  if (!v || v === '-') return null;
  const m = String(v).match(/\$?\s*([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

export function normModel(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/(\d)\.(\d)/g, '$1-$2')
    .replace(/[^a-z0-9.-]/g, '');
}

/**
 * Bundled last-known-good rates, used only when the live scrape of
 * cursor.com/docs/models-and-pricing finds nothing (offline, or the page
 * layout changed). Approximate by nature — a degraded Simulator/cache-savings
 * estimate beats a broken one. Consumers should check `pricing.fallback`.
 */
const FALLBACK_PRICING = {
  auto: { input: 1.25, cacheWrite: 1.25, cacheRead: 0.25, output: 6.0 },
  models: [
    { display: 'Claude 4.5 Sonnet', input: 3.0, cacheWrite: 3.75, cacheRead: 0.3, output: 15.0 },
    { display: 'Claude 4.5 Haiku', input: 1.0, cacheWrite: 1.25, cacheRead: 0.1, output: 5.0 },
    { display: 'GPT-5.2', input: 1.75, cacheWrite: null, cacheRead: 0.18, output: 14.0 },
    { display: 'Composer 2.5', input: 1.25, cacheWrite: 1.55, cacheRead: 0.13, output: 10.0 },
  ],
};

function buildAliasIndex(models) {
  const aliasIndex = {};
  for (const [key, aliases] of Object.entries(MODEL_ALIASES)) {
    for (const a of aliases) aliasIndex[normModel(a)] = key;
  }
  for (const m of models) aliasIndex[m.name] = m.name;
  return aliasIndex;
}

export function parsePricing(md) {
  const auto = { input: null, cacheWrite: null, cacheRead: null, output: null };
  const models = [];

  const autoSec = (md || '').match(/### Auto pricing[\s\S]*?(?=###|## )/i);
  if (autoSec) {
    for (const row of autoSec[0].match(/\|\s*([^|]+)\s*\|\s*\$?([\d.]+)\s*\|/g) || []) {
      const [, label, rate] = row.match(/\|\s*([^|]+)\s*\|\s*\$?([\d.]+)\s*\|/) || [];
      if (!label) continue;
      const l = label.toLowerCase();
      const r = parseFloat(rate);
      if (l.includes('input') && l.includes('cache write')) {
        auto.input = r;
        auto.cacheWrite = r;
      } else if (l.includes('cache read')) auto.cacheRead = r;
      else if (l.includes('output')) auto.output = r;
    }
  }

  const modelSec = (md || '').match(/### Model pricing[\s\S]*?(?=### Premium|## Plans|$)/i);
  if (modelSec) {
    for (const line of modelSec[0].split('\n')) {
      if (!line.startsWith('|') || line.includes(':---') || /model/i.test(line.split('|')[1])) continue;
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      if (cells.length < 6) continue;
      const display = cells[0].replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
      models.push({
        name: normModel(display),
        display,
        input: parseDollar(cells[2]),
        cacheWrite: parseDollar(cells[3]),
        cacheRead: parseDollar(cells[4]),
        output: parseDollar(cells[5]),
      });
    }
  }

  // Scrape found nothing usable (empty/unreachable doc, or page restructured) — fall back.
  if (auto.input == null && models.length === 0) {
    const fallbackModels = FALLBACK_PRICING.models.map((m) => ({ ...m, name: normModel(m.display) }));
    return {
      auto: { ...FALLBACK_PRICING.auto },
      models: fallbackModels,
      aliasIndex: buildAliasIndex(fallbackModels),
      fallback: true,
    };
  }

  return { auto, models, aliasIndex: buildAliasIndex(models), fallback: false };
}

export function matchPricing(model, pricing) {
  const n = normModel(model);
  if (n.includes('auto') || n === 'default') {
    if (pricing.auto.input != null) {
      return {
        input: pricing.auto.input,
        cacheWrite: pricing.auto.cacheWrite ?? pricing.auto.input,
        cacheRead: pricing.auto.cacheRead,
        output: pricing.auto.output,
        label: 'Auto',
      };
    }
  }
  const key = pricing.aliasIndex[n];
  if (key) {
    const m = pricing.models.find((x) => x.name === normModel(key));
    if (m?.input != null) {
      return {
        input: m.input,
        cacheWrite: m.cacheWrite ?? m.input,
        cacheRead: m.cacheRead,
        output: m.output,
        label: m.display,
      };
    }
  }
  const partial = pricing.models.find((m) => n.includes(m.name) || m.name.includes(n));
  if (partial?.input != null) {
    return {
      input: partial.input,
      cacheWrite: partial.cacheWrite ?? partial.input,
      cacheRead: partial.cacheRead,
      output: partial.output,
      label: partial.display,
    };
  }
  return null;
}

/**
 * Every model the simulator can offer, in picker order.
 *
 * Two sources, because neither is complete on its own. cursor.com's pricing
 * table carries the rates, but it lists canonical names ("Grok 4.6") while
 * requests are billed under variant strings that encode the reasoning level
 * ("cursor-grok-4.6-high"), and Cursor-hosted variants sometimes never reach
 * the published table at all. A picker built from the table alone therefore
 * hides the models the user demonstrably ran — exactly the ones they came to
 * compare. The usage data supplies the names; the table supplies the rates.
 *
 * A model seen in usage but absent from the table comes back with
 * `rates: null` instead of being dropped: "no published rate for this" is
 * information, and silently omitting a model the user just ran reads as a bug.
 */
export function simulatorModels(pricing, events = []) {
  const out = [];
  const seen = new Set();
  const add = (key, label, source) => {
    const n = normModel(key);
    if (!n || seen.has(n)) return;
    seen.add(n);
    const rates = matchPricing(key, pricing);
    out.push({ key, label, rates, source, priced: Boolean(rates) });
  };

  if (pricing?.auto?.input != null) add('default', 'Auto', 'catalog');
  for (const m of pricing?.models || []) {
    if (m.input != null) add(m.name, m.display, 'catalog');
  }

  // Auto is already covered by the catalog entry, and its raw forms ("default",
  // "cursor-auto") would otherwise land as separate look-alike rows.
  const fromUsage = [...new Set((events || []).map((e) => e.modelRaw).filter(Boolean))]
    .filter((raw) => {
      const n = normModel(raw);
      return n && n !== 'unknown' && n !== 'default' && !n.includes('auto');
    })
    .sort((a, b) => a.localeCompare(b));
  for (const raw of fromUsage) add(raw, raw, 'usage');

  return out;
}

/**
 * The models to pre-check in the compare picker: the ones this user actually
 * spends on, most-used first. Previously a hardcoded list of model names that
 * went stale every time Cursor shipped a new model.
 */
export function defaultCompareSelection(models, events = [], limit = 4) {
  const counts = new Map();
  for (const e of events || []) {
    const n = normModel(e.modelRaw);
    if (n) counts.set(n, (counts.get(n) || 0) + 1);
  }
  // A model with no published rate has nothing to show in the cost column, so
  // it is never a default pick — the user can still tick it manually.
  const priced = models.filter((m) => m.priced !== false);
  const pool = priced.length ? priced : models;
  const used = pool
    .map((m) => ({ key: m.key, n: counts.get(normModel(m.key)) || 0 }))
    .filter((m) => m.n > 0)
    .sort((a, b) => b.n - a.n);
  if (used.length >= 2) return new Set(used.slice(0, limit).map((m) => m.key));
  return new Set(pool.slice(0, Math.min(limit, pool.length)).map((m) => m.key));
}

/**
 * The compare selection to persist after the user ticks a box.
 *
 * The picker only ever offers models other than the one the current request
 * used, so the checkboxes are a partial view of the saved selection. Writing
 * back just what is checked therefore dropped any model the current request
 * happened to use — pick a Grok request to compare and Grok quietly vanished
 * from your saved models. Keys the picker cannot currently offer are carried
 * through untouched; only the offered ones are rewritten.
 */
export function mergeCompareSelection(stored, offered, checked) {
  const offeredSet = new Set(offered);
  const carried = (stored || []).filter((k) => !offeredSet.has(k));
  const out = [];
  const seen = new Set();
  for (const k of [...carried, ...checked]) {
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

export function estimateTokenCost(rates, tokens) {
  if (!rates) return null;
  let cost = 0;
  if (rates.input != null) cost += tokens.input * rates.input / 1_000_000;
  if (rates.output != null) cost += tokens.output * rates.output / 1_000_000;
  if (rates.cacheRead != null) cost += tokens.cacheRead * rates.cacheRead / 1_000_000;
  const cwRate = rates.cacheWrite ?? rates.input;
  if (cwRate != null) cost += tokens.cacheWrite * cwRate / 1_000_000;
  return cost;
}

export function displayModel(raw) {
  const n = normModel(raw);
  if (!raw || n === 'default' || n.includes('auto')) return 'Auto';
  return raw;
}

export function cacheSavingsFor(tokens, rates) {
  if (!rates || !tokens.cacheRead || rates.input == null || rates.cacheRead == null) return null;
  return (tokens.cacheRead * (rates.input - rates.cacheRead)) / 1_000_000;
}

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * opts.freePlan: on a free plan nothing is ever billed, so billedCost is 0
 * regardless of what the event's charge fields claim.
 */
export function normalize(raw, pricing, opts = {}) {
  const tu = raw.tokenUsage || {};
  const inputTokens = num(tu.inputTokens);
  const outputTokens = num(tu.outputTokens);
  const cacheReadTokens = num(tu.cacheReadTokens);
  const cacheWriteTokens = num(tu.cacheWriteTokens);
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;

  const isTokenBased = Boolean(raw.isTokenBasedCall);
  const chargedCents = raw.chargedCents != null ? num(raw.chargedCents) : null;
  const modelCents = tu.totalCents != null ? num(tu.totalCents) : null;
  const feeCents = raw.cursorTokenFee != null ? num(raw.cursorTokenFee) : 0;

  // tokenCost = actual model/API spend from tokens (what drives optimization)
  const tokenCost = modelCents != null ? (modelCents + feeCents) / 100 : null;
  // requestCharge = flat usage-based fee ($0.04/request on some plans) — NOT token cost
  const requestCharge = !isTokenBased && chargedCents != null ? chargedCents / 100 : null;
  // Primary cost: token-based plans use chargedCents; others use tokenCost
  let cost = null;
  if (isTokenBased && chargedCents != null) {
    cost = chargedCents / 100;
  } else if (tokenCost != null) {
    cost = tokenCost;
  } else if (chargedCents != null) {
    cost = chargedCents / 100;
  }

  // billedCost = what the user actually pays for this request on their plan,
  // as opposed to `cost` which is the API-equivalent value of the tokens.
  const billedCost = billedCostForEvent(raw.kind, chargedCents, opts.freePlan);

  // Which billing system priced this request, and what cursor.com meters for
  // it. Both come from the shared module so the panel and the status bar's
  // budget projection classify an event identically.
  const billingRegime = eventBillingRegime(raw);
  const planMeteredCost = planMeteredDollars(raw);

  const ts = eventTimestampMs(raw.timestamp);

  const modelRaw = raw.model || 'unknown';
  const rates = matchPricing(modelRaw, pricing);
  const cacheSavings = cacheSavingsFor({ cacheRead: cacheReadTokens }, rates);
  const noCacheCost = cost != null && cacheSavings != null ? cost + cacheSavings : null;

  return {
    id: raw.id || `${ts}-${modelRaw}`,
    timestampMs: ts || 0,
    modelRaw,
    model: displayModel(modelRaw),
    kind: raw.kind || null,
    counted: isCountedRequest(raw.kind, totalTokens, chargedCents),
    cost,
    valueCost: cost,
    billedCost,
    tokenCost,
    requestCharge,
    isTokenBased,
    billingRegime,
    planMeteredCost,
    cacheSavings,
    noCacheCost,
    pricingLabel: rates?.label || null,
    pricingMatched: Boolean(rates),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
  };
}

export function detectBillingMode(events) {
  const tokenBased = events.filter((e) => e.isTokenBased).length;
  const usageBased = events.filter((e) => !e.isTokenBased && e.requestCharge != null).length;
  if (tokenBased > 0 && usageBased > 0) return 'mixed';
  if (tokenBased > 0) return 'token';
  if (usageBased > 0) return 'usage';
  return 'unknown';
}

export function summarize(events) {
  const countedEvents = events.filter((e) => e.counted !== false);
  const withCost = events.filter((e) => e.cost != null);
  const totalCost = withCost.reduce((s, e) => s + e.cost, 0);
  const totalSavings = events.filter((e) => e.cacheSavings != null).reduce((s, e) => s + e.cacheSavings, 0);
  const noCache = totalCost + totalSavings;
  const totalRequestFees = events.filter((e) => e.requestCharge != null).reduce((s, e) => s + e.requestCharge, 0);
  // A charge of exactly $0 is an included request, not a per-request fee.
  // Without the `> 0` an account whose rows are all "included" grew a Usage fee
  // column of zeroes, and read as being billed per request when it wasn't.
  const hasUsageFees = events.some((e) => e.requestCharge != null && e.requestCharge > 0
    && e.tokenCost != null && Math.abs(e.requestCharge - e.tokenCost) > 0.001);
  const billingMode = detectBillingMode(events);

  // Reconciliation against cursor.com's usage page. Its "Total usage" only
  // meters token-priced requests, so a range spanning a plan change must report
  // the two systems side by side instead of adding them into one dollar figure
  // that matches neither page.
  const metered = events.filter((e) => e.planMeteredCost != null);
  // "Priced per request" means a per-request charge was actually made. Rows
  // that were merely not token-metered — included requests, charged $0 — are
  // not evidence of an older pricing system, and counting them as such made
  // the dashboard report a plan change that never happened.
  const legacy = events.filter(isPerRequestPriced);
  const meteredTotal = metered.reduce((s, e) => s + e.planMeteredCost, 0);

  return {
    count: countedEvents.length,
    eventCount: events.length,
    notCounted: events.length - countedEvents.length,
    withCost: withCost.length,
    // Subset of the counted requests that carry cost data. `withCost` spans
    // every row including errored/aborted ones, so it can exceed the request
    // count — fine for explaining a cost total, wrong under a "Requests"
    // headline, where it reads as more requests than the headline shows.
    withCostCounted: countedEvents.filter((e) => e.cost != null).length,
    totalCost,
    totalSavings,
    noCache,
    avg: withCost.length ? totalCost / withCost.length : null,
    avgNoCache: withCost.length ? noCache / withCost.length : null,
    totalRequestFees,
    hasUsageFees,
    billingMode,
    meteredTotal,
    meteredCount: metered.length,
    legacyRequestCount: legacy.length,
    legacyFeeTotal: legacy.reduce((s, e) => s + (e.requestCharge ?? 0), 0),
    legacyTokenValue: legacy.reduce((s, e) => s + (e.tokenCost ?? e.cost ?? 0), 0),
    spansPlanChange: metered.length > 0 && legacy.length > 0,
  };
}

/**
 * Local calendar day (YYYY-MM-DD) for a timestamp.
 *
 * Deliberately local, not UTC: the date filters are built from local midnight
 * boundaries, so bucketing by UTC day would push late-evening (or early-morning,
 * west of UTC) requests into a day that sits outside the selected range —
 * daily charts then disagree with the KPI totals they sit next to.
 */
export function dayKey(timestampMs) {
  const d = new Date(timestampMs);
  if (Number.isNaN(d.getTime())) return null;
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** { 'YYYY-MM-DD': totalCost } over events that have a cost, keyed by local day. */
export function groupByDay(events) {
  const map = {};
  for (const e of events) {
    if (!e.timestampMs || e.cost == null) continue;
    const day = dayKey(e.timestampMs);
    if (!day) continue;
    map[day] = (map[day] || 0) + e.cost;
  }
  return map;
}

/**
 * Client-side guard so what's displayed always matches the active filter.
 * The usage API is asked for [startMs, endMs] but its date semantics aren't
 * documented (inclusive ends, whole-day rounding, server timezone), so a
 * response can carry rows outside the requested window. Events with no usable
 * timestamp are kept — the server is the only thing that can place them.
 */
export function filterByRange(events, startMs, endMs) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return events;
  return events.filter((e) => !e.timestampMs || (e.timestampMs >= startMs && e.timestampMs <= endMs));
}

/**
 * Smallest number of requests on each side before a regime split is called a
 * plan change. Two stray rows either side of a boundary are noise; a real
 * migration leaves a substantial block of each.
 */
export const PLAN_CHANGE_MIN_EVIDENCE = 5;

/**
 * True when a request was actually priced per request — the old billing system
 * left a real fee behind.
 *
 * The distinction that matters: `chargedCents: 0` means nothing was charged,
 * not that a per-request fee of zero was applied. An account whose rows are all
 * "included" carries plenty of non-token-metered requests charged $0, and
 * reading those as the old pricing system is what made the dashboard announce a
 * plan change on an account that never had one.
 */
export function isPerRequestPriced(e) {
  return e.billingRegime === 'usage' && (e.requestCharge ?? 0) > 0;
}

/**
 * When billing switched from per-request pricing to dollar metering, if that
 * happened inside these events.
 *
 * The boundary is the first metered request that has per-request-priced ones
 * before it. Returned as the local day it fell on, because that's what a date
 * filter can express — a range starting mid-day would silently drop the earlier
 * part of that day.
 *
 * Three conditions, all of them learned from a false positive on a live
 * Enterprise account where every row was the same "included in business" kind
 * and nothing had migrated at all:
 *
 * 1. Both systems must be present — with only one, nothing changed here.
 * 2. The split must be **one-way**. A migration never goes back, so a
 *    per-request-priced row *after* the first metered one means the two are
 *    interleaved: this account simply meters some requests and not others.
 *    Without this the "change" was really "the first row that happened to be
 *    token-metered", which moved whenever the date filter moved — the same
 *    account reported a different change date for "Today" than for a 30-day
 *    range, which is impossible for a real migration.
 * 3. Each side needs `PLAN_CHANGE_MIN_EVIDENCE` requests, so a narrow window
 *    holding a couple of odd rows can't manufacture a boundary.
 */
export function detectPlanChange(events) {
  const timed = events.filter((e) => e.timestampMs > 0).sort((a, b) => a.timestampMs - b.timestampMs);
  // The boundary is the first genuinely token-metered row. Anchoring it on
  // "first row not priced per request" instead let a $0 included request sitting
  // before the real switch pull the date a day early.
  const firstMetered = timed.find((e) => e.billingRegime === 'token');
  if (!firstMetered) return null;
  const legacyBefore = timed.filter((e) => isPerRequestPriced(e) && e.timestampMs < firstMetered.timestampMs);
  if (!legacyBefore.length) return null;

  const legacyAfter = timed.filter((e) => isPerRequestPriced(e) && e.timestampMs >= firstMetered.timestampMs);
  if (legacyAfter.length) return null;

  const meteredAfter = timed.filter((e) => e.billingRegime === 'token').length;
  if (legacyBefore.length < PLAN_CHANGE_MIN_EVIDENCE || meteredAfter < PLAN_CHANGE_MIN_EVIDENCE) return null;

  const day = new Date(firstMetered.timestampMs);
  day.setHours(0, 0, 0, 0);
  return {
    changedAtMs: firstMetered.timestampMs,
    startOfDayMs: day.getTime(),
    dayKey: dayKey(firstMetered.timestampMs),
    legacyRequestsBefore: legacyBefore.length,
  };
}

export function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * p)] || sorted[sorted.length - 1];
}

