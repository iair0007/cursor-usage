'use strict';

// Pure dashboard logic (pricing parsing, event normalization, aggregation).
// No DOM or VS Code dependencies so it can be unit-tested in Node directly.

import {
  billedCostForEvent,
  comparisonWindow,
  countRequests,
  eventBillingRegime,
  eventTimestampMs,
  filterSessions,
  isCountedRequest,
  modelCostDeltas,
  planMeteredDollars,
  projectBudgetRunway,
  projectExhaustionDate,
  quotaPercentUsed,
  sessionMetrics,
  SESSION_SORT_DEFAULT_DIR,
  sessionSummary,
  sessionTotals,
  shiftMonths,
  sortSessions,
  statusBarText,
  sumBilledCostDollars,
  sumPlanMeteredDollars,
  sumTokenCostDollars,
  UNATTRIBUTED_SESSION,
} from '../shared/usageLogic.ts';

export {
  billedCostForEvent,
  comparisonWindow,
  countRequests,
  eventBillingRegime,
  eventTimestampMs,
  filterSessions,
  isCountedRequest,
  modelCostDeltas,
  planMeteredDollars,
  projectBudgetRunway,
  projectExhaustionDate,
  quotaPercentUsed,
  sessionMetrics,
  SESSION_SORT_DEFAULT_DIR,
  sessionSummary,
  sessionTotals,
  shiftMonths,
  sortSessions,
  statusBarText,
  sumBilledCostDollars,
  sumPlanMeteredDollars,
  sumTokenCostDollars,
  UNATTRIBUTED_SESSION,
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
    // Cursor's own hosted pool (cursor.com/docs/models-and-pricing, "Cursor
    // Models" table) — a single published rate per model, regardless of the
    // reasoning-effort level a request used.
    { display: 'Grok 4.6', input: 2.0, cacheWrite: null, cacheRead: 0.5, output: 6.0 },
    { display: 'Grok 4.5', input: 2.0, cacheWrite: null, cacheRead: 0.5, output: 6.0 },
    { display: 'Composer 2.5', input: 0.5, cacheWrite: null, cacheRead: 0.2, output: 2.5 },
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

/** True for a markdown table separator row ("| :--- | --- |"). */
function isTableSeparatorRow(line) {
  return /^\|?[\s:|-]+\|?$/.test(line) && line.includes('-');
}

function splitRowCells(line) {
  return line.split('|').map((c) => c.trim()).filter(Boolean);
}

/**
 * Extracts model rate rows from one markdown table, given its already-split
 * header cells and raw data rows. Column position isn't assumed — cursor.com
 * publishes more than one shape of pricing table (the frontier-model table
 * has a "Context" column the Cursor-hosted "Cursor Models" pool table
 * doesn't), so columns are located by header text instead of by index.
 */
function parseModelTableRows(headerCells, rows) {
  const idx = (pred) => headerCells.findIndex((c) => pred(c.toLowerCase()));
  const inputIdx = idx((c) => c.includes('input'));
  const outputIdx = idx((c) => c.includes('output'));
  if (inputIdx === -1 || outputIdx === -1) return [];
  const cacheWriteIdx = idx((c) => c.includes('cache') && c.includes('write'));
  const cacheReadIdx = idx((c) => c.includes('cache') && c.includes('read'));

  const models = [];
  for (const cells of rows) {
    if (cells.length <= Math.max(inputIdx, outputIdx)) continue;
    const display = cells[0]
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .trim();
    if (!display) continue;
    models.push({
      name: normModel(display),
      display,
      input: parseDollar(cells[inputIdx]),
      cacheWrite: cacheWriteIdx === -1 ? null : parseDollar(cells[cacheWriteIdx]),
      cacheRead: cacheReadIdx === -1 ? null : parseDollar(cells[cacheReadIdx]),
      output: parseDollar(cells[outputIdx]),
    });
  }
  return models;
}

export function parsePricing(md) {
  const text = md || '';
  const auto = { input: null, cacheWrite: null, cacheRead: null, output: null };

  const autoSec = text.match(/### Auto pricing[\s\S]*?(?=###|## )/i);
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

  // Scan every markdown table in the doc for one that prices models, rather
  // than anchoring to a single "### Model pricing" heading. cursor.com prices
  // its own hosted pool (Grok, Composer — the "Cursor Models" table) in a
  // separate table from third-party frontier models, and past versions of
  // this parser only ever looked at the frontier-model table — so a model
  // that's really on the pricing page (just under a different heading) came
  // back with no rate and got treated as unpriced.
  const models = [];
  const seenNames = new Set();
  const lines = text.split('\n').map((l) => l.trim());
  for (let i = 0; i < lines.length - 1; i++) {
    if (!lines[i].startsWith('|') || !isTableSeparatorRow(lines[i + 1])) continue;
    const headerCells = splitRowCells(lines[i]);
    const rows = [];
    let j = i + 2;
    while (j < lines.length && lines[j].startsWith('|')) {
      rows.push(splitRowCells(lines[j]));
      j++;
    }
    for (const m of parseModelTableRows(headerCells, rows)) {
      if (seenNames.has(m.name)) continue;
      seenNames.add(m.name);
      models.push(m);
    }
    i = j - 1;
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

/**
 * `cacheWrite` falls back to the input rate when the table publishes none, so
 * an estimate is still possible — but callers that are *measuring* rather than
 * estimating need to know the difference, or they read the substitution as a
 * real price. `cacheWritePublished` records which of the two this is.
 */
export function matchPricing(model, pricing) {
  const n = normModel(model);
  if (n.includes('auto') || n === 'default') {
    if (pricing.auto.input != null) {
      return {
        input: pricing.auto.input,
        cacheWrite: pricing.auto.cacheWrite ?? pricing.auto.input,
        cacheWritePublished: pricing.auto.cacheWrite != null,
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
        cacheWritePublished: m.cacheWrite != null,
        cacheRead: m.cacheRead,
        output: m.output,
        label: m.display,
      };
    }
  }
  // Longest-name match wins, not first-found: a billed variant string can
  // contain more than one candidate substring (e.g. "cursor-grok-4.6-fast-high"
  // contains both "grok-4-6" and the more specific "grok-4-6-fast"), and the
  // more specific catalog row is the one whose rate actually applies.
  let partial = null;
  for (const m of pricing.models) {
    if (!m.name) continue;
    if (n.includes(m.name) || m.name.includes(n)) {
      if (!partial || m.name.length > partial.name.length) partial = m;
    }
  }
  if (partial?.input != null) {
    return {
      input: partial.input,
      cacheWrite: partial.cacheWrite ?? partial.input,
      cacheWritePublished: partial.cacheWrite != null,
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
 * table carries the rates, but requests are billed under variant strings that
 * encode extra detail the table doesn't ("cursor-grok-4.6-high" bills Grok 4.6
 * at a chosen reasoning effort — the effort changes token usage, not price, so
 * it isn't a separate rate row). Genuinely Cursor-hosted models can also go
 * unpriced if they haven't reached the published table at all. A picker built
 * from the table alone would hide any model only ever seen under a variant
 * string. The usage data supplies names the table doesn't otherwise offer;
 * the table supplies the rates.
 *
 * A usage-only name that turns out to price against a catalog row (matched via
 * matchPricing, e.g. "cursor-grok-4.6-high" against "Grok 4.6") is skipped
 * here rather than added as its own row — it is that catalog model, not a
 * different one, and listing both would offer the same rate twice under two
 * names. Only names matchPricing genuinely cannot place come back with
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
      if (!n || n === 'unknown' || n === 'default' || n.includes('auto')) return false;
      return !matchPricing(raw, pricing);
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

// ---------------------------------------------------------------------------
// Promotional discounts
//
// Cursor periodically runs limited-time promotions ("Grok 4.6 is 50% off for
// one week"). They are announced in prose on the blog and never appear as a
// machine-readable rate, so the published table this dashboard scrapes keeps
// showing list price for the duration.
//
// This matters in exactly one place. A request you actually made carries
// Cursor's own billed figure, so its cost is right whether or not a promo was
// running. Only the simulator's "what would this have cost on model X" column
// is computed from the published rates, so only that column can be stale.
//
// Two ways to close the gap, in order of preference:
//   1. Infer it. When you did run the model, its billed token value can be
//      divided by what the published rates say it should have cost. A ratio
//      well under 1, holding across several requests the same day, is a
//      discount — measured from real billing rather than guessed.
//   2. Ask. For a model you have not run, there is nothing to measure, so the
//      user can record the promo by hand and every estimate honours it.
// ---------------------------------------------------------------------------

/**
 * Thresholds for calling a cost gap a promotion rather than noise. Inference
 * is a heuristic over rounded, surcharge-inclusive billing figures, so these
 * are deliberately conservative: a missed promo leaves the estimate where it
 * already was, while a false positive silently rewrites prices the user never
 * got.
 */
export const DISCOUNT_DETECTION = {
  /** Below a couple of cents, cent-rounding alone moves the ratio by more than a promo would. */
  minExpectedCost: 0.02,
  /** One cheap request proves nothing; a promo shows up across a day's traffic. */
  minSamples: 3,
  /** Under this, the gap is rounding and surcharge drift, not a promotion. */
  minPct: 8,
  /** Over this, something is wrong with the comparison — decline to guess. */
  maxPct: 95,
  /** How far a sample may sit from the median and still count as agreeing with it. */
  tolerancePct: 6,
  /** Share of samples that must agree before the median is trustworthy. */
  minAgreement: 0.6,
  /** Promotions are round numbers, so snap to the nearest step when close. */
  snapStep: 5,
  snapWithin: 2.5,
};

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function snapDiscountPct(pct, cfg) {
  const step = cfg.snapStep;
  const nearest = Math.round(pct / step) * step;
  return Math.abs(nearest - pct) <= cfg.snapWithin ? nearest : Math.round(pct * 10) / 10;
}

/**
 * Infers per-model, per-day discounts by comparing what Cursor billed for the
 * tokens against what the published rates say those tokens should have cost.
 *
 * Returns `{ discounts, observed }`. `observed` carries the "model|day" pairs
 * that had enough usable requests to reach a conclusion at all, so callers can
 * tell "we checked and there was no promotion" from "we have no idea" — the
 * second is what a manual entry is for, and prompting for the first would be
 * nagging the user about something already answered.
 */
export function detectDiscounts(events = [], pricing = null, opts = {}) {
  const cfg = { ...DISCOUNT_DETECTION, ...opts };
  const discounts = {};
  const observed = new Set();
  if (!pricing) return { discounts, observed };

  const buckets = new Map();
  for (const e of events || []) {
    if (!e || !e.timestampMs) continue;
    const n = normModel(e.modelRaw);
    // Auto routes to a model Cursor does not name, so its billed value cannot
    // be checked against any single rate row.
    if (!n || n === 'unknown' || n === 'default' || n.includes('auto')) continue;

    // The billed value of the tokens alone. `tokenCost` folds in the Cursor
    // token fee, which is charged on top of the model rate and would read as a
    // surcharge — comparing it against the rate table understates every promo.
    const actual = e.modelTokenCost;
    if (actual == null || !(actual > 0)) continue;

    const rates = matchPricing(e.modelRaw, pricing);
    if (!rates) continue;

    const tokens = {
      input: e.inputTokens,
      output: e.outputTokens,
      cacheRead: e.cacheReadTokens,
      cacheWrite: e.cacheWriteTokens,
    };
    const expected = estimateTokenCost(rates, tokens);
    if (expected == null || expected < cfg.minExpectedCost) continue;

    // Where the table publishes no cache-write rate, estimateTokenCost bills
    // those tokens at the input rate. That is not a wild guess — Anthropic is
    // the outlier in charging a write premium, and the pools with no such
    // column (xAI's, and OpenAI's before GPT-5.6) genuinely have no separate
    // write fee — but it is still an assumption, and Cursor's own hosted
    // models are exactly the ones it runs promotions on.
    //
    // Discarding the request instead, as this once did, made Grok and Composer
    // permanently undetectable: their requests always carry cache-write tokens,
    // so every sample was thrown away and the count never reached minSamples no
    // matter how much the user ran them. So bound the unknown rather than duck
    // it. The true rate cannot be below zero, nor above the input rate it was
    // substituted from, so price the same tokens at the stingy end too and
    // require the discount to survive there as well. Cache writes that are
    // really free, read against a substitution, are precisely the false
    // positive the old skip existed to prevent — and the floor still rejects
    // that, while allowing the gaps too large for the substitution to explain.
    let floorExpected = expected;
    if (e.cacheWriteTokens > 0 && !rates.cacheWritePublished) {
      floorExpected = estimateTokenCost({ ...rates, cacheWrite: 0 }, tokens);
      if (floorExpected == null || !(floorExpected > 0)) continue;
    }

    const day = dayKey(e.timestampMs);
    if (!day) continue;
    const bucketKey = `${n}|${day}`;
    if (!buckets.has(bucketKey)) {
      buckets.set(bucketKey, { n, day, ratios: [], floorRatios: [], label: rates.label });
    }
    const bucket = buckets.get(bucketKey);
    bucket.ratios.push(actual / expected);
    bucket.floorRatios.push(actual / floorExpected);
  }

  for (const { n, day, ratios, floorRatios, label } of buckets.values()) {
    if (ratios.length < cfg.minSamples) continue;

    const sorted = [...ratios].sort((a, b) => a - b);
    const rawPct = (1 - median(sorted)) * 100;
    // The same day priced with cache writes free. Equal to rawPct unless a
    // substitution was involved, so this only ever bites where one was.
    const floorPct = (1 - median([...floorRatios].sort((a, b) => a - b))) * 100;

    // A gap the substitution alone could account for. That is inconclusive, not
    // answered, so it is deliberately left out of `observed`: the Simulator
    // keeps offering to record the promotion by hand, which is the right
    // fallback for a day we cannot measure.
    if (rawPct >= cfg.minPct && floorPct < cfg.minPct) continue;

    observed.add(`${n}|${day}`);
    if (rawPct < cfg.minPct || rawPct > cfg.maxPct) continue;

    // A real promotion prices every request the same way. Wide scatter means
    // the gap is coming from surcharges or model routing, not a rate change.
    const agreeing = ratios.filter((r) => Math.abs((1 - r) * 100 - rawPct) <= cfg.tolerancePct).length;
    if (agreeing / ratios.length < cfg.minAgreement) continue;

    if (!discounts[n]) discounts[n] = {};
    discounts[n][day] = {
      pct: snapDiscountPct(rawPct, cfg),
      samples: ratios.length,
      label,
    };
  }

  return { discounts, observed };
}

/** Contiguous day ranges per model, for describing a promotion as a period. */
export function discountPeriods(detected) {
  const out = [];
  for (const [model, byDay] of Object.entries(detected?.discounts || {})) {
    const days = Object.keys(byDay).sort();
    let run = null;
    for (const day of days) {
      const pct = byDay[day].pct;
      // Half a day of slack, so a run does not split just because the clocks
      // changed overnight and "one day later" is 23 or 25 hours, not 24.
      const prevDay = run && new Date(`${run.end}T12:00:00`);
      const contiguous = run && pct === run.pct && prevDay
        && (new Date(`${day}T12:00:00`) - prevDay) <= 86400000 * 1.5;
      if (contiguous) {
        run.end = day;
        run.days++;
      } else {
        if (run) out.push(run);
        run = { model, label: byDay[day].label, pct, start: day, end: day, days: 1 };
      }
    }
    if (run) out.push(run);
  }
  return out.sort((a, b) => b.start.localeCompare(a.start) || a.model.localeCompare(b.model));
}

/** A manual entry's model list matches an event's model the way pricing does. */
function discountEntryMatchLength(entry, modelName) {
  let best = -1;
  for (const m of entry.models || []) {
    if (m === '*') {
      if (best < 0) best = 0;
      continue;
    }
    if (modelName === m || modelName.includes(m) || m.includes(modelName)) {
      best = Math.max(best, m.length);
    }
  }
  return best;
}

/**
 * The hand-entered discount in force for a model on a day, if any. The most
 * specific model match wins so a blanket "everything is 20% off" entry never
 * overrides one naming the model outright; equally specific entries resolve to
 * the larger discount.
 */
export function manualDiscountFor(entries, modelRaw, day) {
  const n = normModel(modelRaw);
  if (!n || !day) return null;
  let best = null;
  let bestSpecificity = -1;
  for (const entry of entries || []) {
    if (!entry || entry.pct == null) continue;
    if (entry.start && day < entry.start) continue;
    if (entry.end && day > entry.end) continue;
    const specificity = discountEntryMatchLength(entry, n);
    if (specificity < 0) continue;
    if (specificity > bestSpecificity || (specificity === bestSpecificity && entry.pct > (best?.pct ?? -1))) {
      best = entry;
      bestSpecificity = specificity;
    }
  }
  return best;
}

/**
 * The discount to price a model at on a given day.
 *
 * Measured beats declared: a detected discount comes from Cursor's own billing
 * for requests that really ran, while a manual entry is the user's recollection
 * of an announcement. Manual entries therefore fill the gap for models with no
 * usage to measure, rather than overriding the evidence.
 */
export function resolveDiscount(modelRaw, day, { detected, manual } = {}) {
  const n = normModel(modelRaw);
  const det = detected?.discounts?.[n]?.[day];
  if (det) return { pct: det.pct, source: 'detected', samples: det.samples };
  const entry = manualDiscountFor(manual, modelRaw, day);
  if (entry) return { pct: entry.pct, source: 'manual', entryId: entry.id };
  return null;
}

/** Any day in the loaded range on which this model was detected as discounted. */
export function detectedDiscountDays(detected, modelRaw) {
  const byDay = detected?.discounts?.[normModel(modelRaw)];
  return byDay ? Object.keys(byDay).sort() : [];
}

export function applyDiscountToRates(rates, pct) {
  if (!rates || !pct) return rates;
  const factor = 1 - pct / 100;
  const scale = (v) => (v == null ? null : v * factor);
  return {
    ...rates,
    input: scale(rates.input),
    output: scale(rates.output),
    cacheRead: scale(rates.cacheRead),
    cacheWrite: scale(rates.cacheWrite),
    discountPct: pct,
  };
}

/**
 * Which of these models the dashboard genuinely cannot price for a given day —
 * no measurement, no manual entry — and so is worth asking the user about.
 *
 * A model that ran that day and showed no discount is *answered*, not unknown,
 * and prompting for it would be nagging about a question already settled.
 */
export function modelsMissingDiscountInfo(modelKeys, day, { detected, manual } = {}) {
  if (!day) return [];
  return (modelKeys || []).filter((key) => {
    const n = normModel(key);
    if (!n) return false;
    if (detected?.discounts?.[n]?.[day]) return false;
    if (detected?.observed?.has(`${n}|${day}`)) return false;
    return !manualDiscountFor(manual, key, day);
  });
}

/** Validates and canonicalizes a hand-entered discount before it is stored. */
export function normalizeDiscountEntry(raw) {
  if (!raw) return null;
  const pct = Number(raw.pct);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return null;
  const models = [...new Set((raw.models || [])
    .map((m) => (m === '*' ? '*' : normModel(m)))
    .filter(Boolean))];
  if (!models.length) return null;
  const isDay = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
  const start = isDay(raw.start) ? raw.start : null;
  const end = isDay(raw.end) ? raw.end : null;
  if (!start || !end || end < start) return null;
  return {
    id: raw.id || `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    models,
    start,
    end,
    pct: Math.round(pct * 10) / 10,
  };
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
  // The same figure without the Cursor token fee, which is charged on top of
  // the model's own rate. Discount detection compares this against the rate
  // table, and folding the fee in would read as a surcharge on every model.
  //
  // Cursor does not always break the model's own value out as
  // tokenUsage.totalCents. Where it doesn't, a token-billed request still
  // carries it: the charge is that value plus the token fee. Without this,
  // detection had nothing to measure on such an account and reported "no
  // discount found" for every model, which is indistinguishable from having
  // checked. Per-request billing is a flat fee unrelated to the tokens, so it
  // is deliberately left out rather than compared against a rate table.
  const modelCentsResolved = modelCents != null
    ? modelCents
    : (isTokenBased && chargedCents != null ? Math.max(0, chargedCents - feeCents) : null);
  const modelTokenCost = modelCentsResolved != null ? modelCentsResolved / 100 : null;
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
    conversationId: raw.conversationId || null,
    counted: isCountedRequest(raw.kind, totalTokens, chargedCents),
    cost,
    valueCost: cost,
    billedCost,
    tokenCost,
    modelTokenCost,
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

