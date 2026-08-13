// Unit tests for the pure logic shared by the webview and extension host.
// Run: npm test

import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));

// Bundle modules under test into importable ESM (resolves .ts deps logic.js pulls in).
async function loadTs(entry, outName) {
  const outfile = path.join(here, '.build', outName);
  await build({
    entryPoints: [path.join(here, '..', entry)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    outfile,
    logLevel: 'silent',
  });
  return import(outfile);
}

const {
  parsePricing,
  matchPricing,
  normModel,
  simulatorModels,
  defaultCompareSelection,
  mergeCompareSelection,
  estimateTokenCost,
  cacheSavingsFor,
  detectDiscounts,
  discountPeriods,
  resolveDiscount,
  manualDiscountFor,
  applyDiscountToRates,
  modelsMissingDiscountInfo,
  normalizeDiscountEntry,
  detectedDiscountDays,
  displayModel,
  normalize,
  summarize,
  detectBillingMode,
  isCountedRequest,
  percentile,
  projectExhaustionDate,
  dayKey,
  groupByDay,
  filterByRange,
  detectPlanChange,
  comparisonWindow,
  modelCostDeltas,
  shiftMonths,
  sessionTotals,
  sessionSummary,
  sessionMetrics,
  filterSessions,
  UNATTRIBUTED_SESSION,
} = await loadTs('src/webview/logic.js', 'logic.mjs');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    const maybe = fn();
    if (maybe && typeof maybe.then === 'function') {
      return maybe.then(
        () => {
          passed++;
          console.log(`  ✓ ${name}`);
        },
        (e) => {
          failed++;
          console.error(`  ✗ ${name}\n    ${e.message}`);
        },
      );
    }
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

const md = readFileSync(path.join(here, 'fixtures', 'pricing.md'), 'utf8');
const pricing = parsePricing(md);

console.log('parsePricing');
test('parses Auto rates', () => {
  assert.equal(pricing.auto.input, 1.25);
  assert.equal(pricing.auto.cacheWrite, 1.25);
  assert.equal(pricing.auto.cacheRead, 0.25);
  assert.equal(pricing.auto.output, 6.0);
});
test('parses model table incl. links and missing cells', () => {
  const sonnet = pricing.models.find((m) => m.display === 'Claude 4.5 Sonnet');
  assert.deepEqual(
    [sonnet.input, sonnet.cacheWrite, sonnet.cacheRead, sonnet.output],
    [3.0, 3.75, 0.3, 15.0],
  );
  const gpt = pricing.models.find((m) => m.display === 'GPT-5.2');
  assert.equal(gpt.cacheWrite, null);
});
test('parses the Cursor Models pool table, a differently-shaped table under its own heading', () => {
  assert.equal(pricing.models.length, 9);
  const grok = pricing.models.find((m) => m.display === 'Grok 4.6');
  assert.deepEqual([grok.input, grok.cacheWrite, grok.cacheRead, grok.output], [2, null, 0.5, 6]);
  const grokFast = pricing.models.find((m) => m.display === 'Grok 4.6 (Fast)');
  assert.deepEqual([grokFast.input, grokFast.cacheWrite, grokFast.cacheRead, grokFast.output], [4, null, 1, 12]);
  const composer = pricing.models.find((m) => m.display === 'Composer 2.5');
  assert.deepEqual([composer.input, composer.cacheWrite, composer.cacheRead, composer.output], [0.5, null, 0.2, 2.5]);
});
test('real scrape is not flagged as fallback', () => {
  assert.equal(pricing.fallback, false);
});
test('empty/unreachable doc falls back to bundled rates instead of an empty table', () => {
  const empty = parsePricing('');
  assert.equal(empty.fallback, true);
  assert.ok(empty.models.length > 0);
  assert.equal(empty.auto.input, 1.25);
  assert.ok(matchPricing('claude-4.5-sonnet', empty));
});
test('garbled markdown (page restructured) also falls back', () => {
  const garbled = parsePricing('# Some unrelated page\n\nNo pricing tables here.');
  assert.equal(garbled.fallback, true);
  assert.ok(garbled.models.length > 0);
});

console.log('matchPricing');
test('auto and default map to Auto rates', () => {
  assert.equal(matchPricing('auto', pricing).label, 'Auto');
  assert.equal(matchPricing('default', pricing).input, 1.25);
});
test('alias and partial matching', () => {
  assert.equal(matchPricing('claude-4.5-sonnet', pricing).label, 'Claude 4.5 Sonnet');
  assert.equal(matchPricing('claude-4-5-sonnet-thinking', pricing).label, 'Claude 4.5 Sonnet');
});
test('a billed variant string prices off the base model, not a model of its own', () => {
  // Cursor bills reasoning effort as part of the model string; there is no
  // separate published rate per effort level, only per model.
  assert.equal(matchPricing('cursor-grok-4.6-high', pricing).label, 'Grok 4.6');
});
test('the longest matching catalog name wins, so a Fast variant prices off its own row', () => {
  assert.equal(matchPricing('cursor-grok-4.6-fast-high', pricing).label, 'Grok 4.6 (Fast)');
});
test('unknown model returns null', () => {
  assert.equal(matchPricing('mystery-model-9000', pricing), null);
});

console.log('simulatorModels');
test('lists Auto plus every priced catalog model', () => {
  const keys = simulatorModels(pricing, []).map((m) => m.key);
  assert.equal(keys[0], 'default');
  assert.ok(keys.includes('claude-4-5-sonnet'));
  assert.ok(keys.includes('composer-2-5'));
});
test('adds models seen in usage that the pricing table truly does not name', () => {
  const events = [{ modelRaw: 'cursor-mystery-model-9000-high' }, { modelRaw: 'cursor-mystery-model-9000-high' }];
  const models = simulatorModels(pricing, events);
  const unknown = models.find((m) => m.key === 'cursor-mystery-model-9000-high');
  assert.ok(unknown, 'model from usage data must be offered');
  assert.equal(unknown.source, 'usage');
  // Nothing in the fixture prices this — it is still listed, just flagged.
  assert.equal(unknown.priced, false);
  assert.equal(unknown.rates, null);
});
test('a billed variant string that prices off a catalog row is not offered as a duplicate entry', () => {
  // "cursor-grok-4.6-high" is Grok 4.6 billed at a reasoning effort, not a
  // separate model — the catalog's own "Grok 4.6" row already covers it.
  const models = simulatorModels(pricing, [{ modelRaw: 'cursor-grok-4.6-high' }]);
  assert.ok(!models.some((m) => m.key === 'cursor-grok-4.6-high'));
  const grok = models.find((m) => m.key === 'grok-4-6');
  assert.ok(grok, 'Grok 4.6 catalog entry must still be offered');
  assert.equal(grok.priced, true);
});
test('same for a variant of a model already carrying a "-thinking" suffix', () => {
  const models = simulatorModels(pricing, [{ modelRaw: 'claude-4-5-sonnet-thinking' }]);
  assert.ok(!models.some((m) => m.key === 'claude-4-5-sonnet-thinking'));
  const sonnet = models.find((m) => m.key === 'claude-4-5-sonnet');
  assert.equal(sonnet.priced, true);
  assert.equal(sonnet.rates.label, 'Claude 4.5 Sonnet');
});
test('usage models already in the catalog are not duplicated', () => {
  const models = simulatorModels(pricing, [{ modelRaw: 'GPT-5.2' }, { modelRaw: 'gpt-5-2' }]);
  assert.equal(models.filter((m) => normModel(m.key) === 'gpt-5-2').length, 1);
});
test('Auto is never added twice from its raw forms', () => {
  const models = simulatorModels(pricing, [{ modelRaw: 'default' }, { modelRaw: 'cursor-auto' }]);
  assert.equal(models.filter((m) => m.label === 'Auto').length, 1);
  assert.ok(!models.some((m) => m.key === 'cursor-auto'));
});

console.log('defaultCompareSelection');
test('pre-checks the models this user actually runs, most-used first', () => {
  const models = simulatorModels(pricing, []);
  const events = [
    ...Array(5).fill({ modelRaw: 'composer-2.5' }),
    ...Array(3).fill({ modelRaw: 'claude-4.5-haiku' }),
    { modelRaw: 'gpt-5.2' },
  ];
  const picked = defaultCompareSelection(models, events, 2);
  assert.deepEqual([...picked], ['composer-2-5', 'claude-4-5-haiku']);
});
test('falls back to the head of the list when usage is too thin to rank', () => {
  const models = simulatorModels(pricing, []);
  const picked = defaultCompareSelection(models, [{ modelRaw: 'gpt-5.2' }], 3);
  assert.deepEqual([...picked], models.slice(0, 3).map((m) => m.key));
});
test('never defaults to a model it cannot price', () => {
  const events = [...Array(9).fill({ modelRaw: 'cursor-mystery-model-9000-high' }), { modelRaw: 'gpt-5.2' }];
  const models = simulatorModels(pricing, events);
  const picked = defaultCompareSelection(models, events, 4);
  assert.ok(!picked.has('cursor-mystery-model-9000-high'));
});

console.log('mergeCompareSelection');
test('keeps models the current request cannot offer', () => {
  // Comparing a Grok request hides Grok from the picker; unticking Sonnet there
  // must not drop Grok from the saved selection.
  const merged = mergeCompareSelection(
    ['claude-4-5-sonnet', 'cursor-grok-4.6-high'],
    ['claude-4-5-sonnet', 'gpt-5-2'],
    ['gpt-5-2'],
  );
  assert.deepEqual(merged, ['cursor-grok-4.6-high', 'gpt-5-2']);
});
test('unticking an offered model removes it', () => {
  const merged = mergeCompareSelection(['gpt-5-2', 'composer-2-5'], ['gpt-5-2', 'composer-2-5'], ['gpt-5-2']);
  assert.deepEqual(merged, ['gpt-5-2']);
});
test('no stored selection yet is not an error', () => {
  assert.deepEqual(mergeCompareSelection(null, ['gpt-5-2'], ['gpt-5-2']), ['gpt-5-2']);
});
test('a carried key that is also ticked is not duplicated', () => {
  const merged = mergeCompareSelection(['gpt-5-2'], ['gpt-5-2'], ['gpt-5-2']);
  assert.deepEqual(merged, ['gpt-5-2']);
});
test('clearing every offered model still leaves the carried ones', () => {
  const merged = mergeCompareSelection(['gpt-5-2', 'cursor-grok-4.6-high'], ['gpt-5-2'], []);
  assert.deepEqual(merged, ['cursor-grok-4.6-high']);
});

console.log('cost math');
test('estimateTokenCost combines all rates', () => {
  const rates = matchPricing('claude-4.5-sonnet', pricing);
  const cost = estimateTokenCost(rates, { input: 1_000_000, output: 100_000, cacheRead: 2_000_000, cacheWrite: 0 });
  assert.ok(Math.abs(cost - (3.0 + 1.5 + 0.6)) < 1e-9);
});
test('cacheSavingsFor uses input minus cache-read rate', () => {
  const rates = matchPricing('claude-4.5-sonnet', pricing);
  const savings = cacheSavingsFor({ cacheRead: 1_000_000 }, rates);
  assert.ok(Math.abs(savings - 2.7) < 1e-9);
});

console.log('promotional discounts');
// A day's worth of Grok 4.6 requests. Fixture rates: $2 input / $0.5 cache
// read / $6 output per 1M, so these tokens list at $0.20 each.
const GROK_TOKENS = { input: 50_000, output: 10_000, cacheRead: 80_000, cacheWrite: 0 };
const LIST_COST = 0.2;
function grokEvent(i, factor, day = '2026-08-13', tokens = GROK_TOKENS) {
  return {
    id: `g${i}`,
    timestampMs: new Date(`${day}T1${i % 9}:00:00`).getTime(),
    modelRaw: 'cursor-grok-4.6-high',
    modelTokenCost: LIST_COST * factor,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead,
    cacheWriteTokens: tokens.cacheWrite,
  };
}
const halfPriceDay = [0, 1, 2, 3].map((i) => grokEvent(i, 0.5));

test('the fixture rates price the sample day at list, so a gap means a promotion', () => {
  const rates = matchPricing('cursor-grok-4.6-high', pricing);
  assert.ok(Math.abs(estimateTokenCost(rates, GROK_TOKENS) - LIST_COST) < 1e-9);
});
test('a consistent half-price day is detected as a 50% promotion', () => {
  const { discounts } = detectDiscounts(halfPriceDay, pricing);
  assert.equal(discounts['cursor-grok-4-6-high']['2026-08-13'].pct, 50);
  assert.equal(discounts['cursor-grok-4-6-high']['2026-08-13'].samples, 4);
});
test('a near-miss ratio snaps to the round number a promotion would actually be', () => {
  // 0.512 of list is a 48.8% gap — cent-rounding around a 50% promo.
  const { discounts } = detectDiscounts([0, 1, 2, 3].map((i) => grokEvent(i, 0.512)), pricing);
  assert.equal(discounts['cursor-grok-4-6-high']['2026-08-13'].pct, 50);
});
test('paying list price is not a discount', () => {
  const { discounts, observed } = detectDiscounts([0, 1, 2, 3].map((i) => grokEvent(i, 1)), pricing);
  assert.deepEqual(discounts, {});
  // Still observed: we checked this day and concluded there was no promotion.
  assert.ok(observed.has('cursor-grok-4-6-high|2026-08-13'));
});
test('a surcharge (billed above list) is never reported as a discount', () => {
  const { discounts } = detectDiscounts([0, 1, 2, 3].map((i) => grokEvent(i, 1.4)), pricing);
  assert.deepEqual(discounts, {});
});
test('one cheap request is not enough evidence', () => {
  const { discounts, observed } = detectDiscounts([grokEvent(0, 0.5)], pricing);
  assert.deepEqual(discounts, {});
  assert.equal(observed.size, 0, 'too few samples is "unknown", not "no discount"');
});
test('scattered ratios are surcharge noise, not a promotion', () => {
  const noisy = [0.5, 0.95, 0.6, 1.0, 0.45].map((f, i) => grokEvent(i, f));
  const { discounts } = detectDiscounts(noisy, pricing);
  assert.deepEqual(discounts, {}, 'no single rate explains these requests');
});
test('sub-cent requests are ignored — rounding moves them more than a promo would', () => {
  const tiny = { input: 200, output: 50, cacheRead: 300, cacheWrite: 0 };
  const { discounts, observed } = detectDiscounts(
    [0, 1, 2, 3].map((i) => grokEvent(i, 0.5, '2026-08-13', tiny)),
    pricing,
  );
  assert.deepEqual(discounts, {});
  assert.equal(observed.size, 0);
});
test('Auto is skipped — its billed value belongs to a model Cursor does not name', () => {
  const autos = [0, 1, 2, 3].map((i) => ({ ...grokEvent(i, 0.5), modelRaw: 'auto' }));
  assert.deepEqual(detectDiscounts(autos, pricing).discounts, {});
});
test('an unpriced cache write is skipped rather than guessed at', () => {
  // Grok has no published cache-write rate, so estimateTokenCost would fall
  // back to the input rate and invent a gap.
  const withWrites = [0, 1, 2, 3].map((i) => grokEvent(i, 0.5, '2026-08-13', { ...GROK_TOKENS, cacheWrite: 40_000 }));
  assert.deepEqual(detectDiscounts(withWrites, pricing).discounts, {});
});
test('discounts are tracked per day, so a promotion that ends is not backdated', () => {
  const events = [
    ...[0, 1, 2, 3].map((i) => grokEvent(i, 0.5, '2026-08-13')),
    ...[4, 5, 6, 7].map((i) => grokEvent(i, 1, '2026-08-20')),
  ];
  const { discounts } = detectDiscounts(events, pricing);
  assert.equal(discounts['cursor-grok-4-6-high']['2026-08-13'].pct, 50);
  assert.equal(discounts['cursor-grok-4-6-high']['2026-08-20'], undefined);
});
test('detectedDiscountDays lists the discounted days for a model', () => {
  const detected = detectDiscounts(halfPriceDay, pricing);
  assert.deepEqual(detectedDiscountDays(detected, 'cursor-grok-4.6-high'), ['2026-08-13']);
  assert.deepEqual(detectedDiscountDays(detected, 'gpt-5.2'), []);
});
test('no pricing table means nothing can be inferred', () => {
  assert.deepEqual(detectDiscounts(halfPriceDay, null).discounts, {});
});

console.log('discountPeriods');
test('consecutive discounted days collapse into one promotion window', () => {
  const events = ['2026-08-12', '2026-08-13', '2026-08-14']
    .flatMap((day, d) => [0, 1, 2, 3].map((i) => grokEvent(i, 0.5, day)));
  const periods = discountPeriods(detectDiscounts(events, pricing));
  assert.equal(periods.length, 1);
  assert.deepEqual([periods[0].start, periods[0].end, periods[0].pct], ['2026-08-12', '2026-08-14', 50]);
});
test('a gap in the days splits the run into two promotions', () => {
  const events = ['2026-08-12', '2026-08-20']
    .flatMap((day) => [0, 1, 2, 3].map((i) => grokEvent(i, 0.5, day)));
  assert.equal(discountPeriods(detectDiscounts(events, pricing)).length, 2);
});

console.log('manual discounts');
const manualEntry = normalizeDiscountEntry({ models: ['grok-4-6'], start: '2026-08-12', end: '2026-08-19', pct: 50 });
test('a valid entry is canonicalized and given an id', () => {
  assert.deepEqual(manualEntry.models, ['grok-4-6']);
  assert.equal(manualEntry.pct, 50);
  assert.ok(manualEntry.id);
});
test('nonsensical entries are rejected rather than stored', () => {
  assert.equal(normalizeDiscountEntry({ models: ['x'], start: '2026-08-12', end: '2026-08-19', pct: 0 }), null);
  assert.equal(normalizeDiscountEntry({ models: ['x'], start: '2026-08-12', end: '2026-08-19', pct: 100 }), null);
  assert.equal(normalizeDiscountEntry({ models: [], start: '2026-08-12', end: '2026-08-19', pct: 50 }), null);
  assert.equal(normalizeDiscountEntry({ models: ['x'], start: '2026-08-19', end: '2026-08-12', pct: 50 }), null, 'backwards range');
  assert.equal(normalizeDiscountEntry({ models: ['x'], start: 'whenever', end: '2026-08-19', pct: 50 }), null);
});
test('an entry applies only inside its own dates', () => {
  assert.ok(manualDiscountFor([manualEntry], 'grok-4-6', '2026-08-12'), 'first day is inside');
  assert.ok(manualDiscountFor([manualEntry], 'grok-4-6', '2026-08-19'), 'last day is inside');
  assert.equal(manualDiscountFor([manualEntry], 'grok-4-6', '2026-08-11'), null);
  assert.equal(manualDiscountFor([manualEntry], 'grok-4-6', '2026-08-20'), null);
});
test('an entry covers the billed variant strings of the model it names', () => {
  assert.ok(manualDiscountFor([manualEntry], 'cursor-grok-4.6-high', '2026-08-13'));
  assert.equal(manualDiscountFor([manualEntry], 'gpt-5.2', '2026-08-13'), null);
});
test('a model-specific entry beats a blanket one rather than the larger winning', () => {
  const blanket = normalizeDiscountEntry({ models: ['*'], start: '2026-08-12', end: '2026-08-19', pct: 90 });
  const picked = manualDiscountFor([blanket, manualEntry], 'grok-4-6', '2026-08-13');
  assert.equal(picked.pct, 50, 'the entry naming the model is the more specific answer');
  assert.equal(manualDiscountFor([blanket, manualEntry], 'gpt-5.2', '2026-08-13').pct, 90);
});

console.log('resolveDiscount');
test('a measured discount outranks a hand-entered one', () => {
  const detected = detectDiscounts(halfPriceDay, pricing);
  const wrong = normalizeDiscountEntry({ models: ['grok-4-6'], start: '2026-08-01', end: '2026-08-31', pct: 20 });
  const got = resolveDiscount('cursor-grok-4.6-high', '2026-08-13', { detected, manual: [wrong] });
  assert.deepEqual([got.pct, got.source], [50, 'detected']);
});
test('a hand-entered discount fills a day with nothing to measure', () => {
  const detected = detectDiscounts(halfPriceDay, pricing);
  const got = resolveDiscount('grok-4-6', '2026-08-15', { detected, manual: [manualEntry] });
  assert.deepEqual([got.pct, got.source], [50, 'manual']);
});
test('no evidence and no entry is no discount', () => {
  assert.equal(resolveDiscount('gpt-5.2', '2026-08-13', { detected: detectDiscounts(halfPriceDay, pricing), manual: [] }), null);
});

console.log('applyDiscountToRates');
test('every published rate is scaled, and the estimate falls by the same share', () => {
  const rates = matchPricing('grok-4-6', pricing);
  const cut = applyDiscountToRates(rates, 50);
  assert.deepEqual([cut.input, cut.cacheRead, cut.output], [1, 0.25, 3]);
  assert.ok(Math.abs(estimateTokenCost(cut, GROK_TOKENS) - LIST_COST / 2) < 1e-9);
});
test('a cache-write rate substituted from input is discounted along with it', () => {
  // Grok publishes no cache-write rate, so matchPricing lends it the input
  // rate — which must fall by the same share, not stay at list.
  const cut = applyDiscountToRates(matchPricing('grok-4-6', pricing), 50);
  assert.equal(cut.cacheWrite, 1);
  assert.equal(cut.cacheWritePublished, false, 'still flagged as a substitution, not a published rate');
});
test('a genuinely absent rate stays absent rather than becoming zero', () => {
  const cut = applyDiscountToRates({ input: 2, output: 6, cacheRead: 0.5, cacheWrite: null }, 50);
  assert.equal(cut.cacheWrite, null);
});
test('no discount leaves the rates exactly as published', () => {
  const rates = matchPricing('grok-4-6', pricing);
  assert.equal(applyDiscountToRates(rates, 0), rates);
  assert.equal(applyDiscountToRates(rates, null), rates);
});

console.log('modelsMissingDiscountInfo');
const detectedForPrompt = detectDiscounts(halfPriceDay, pricing);
test('a model with a detected discount needs no prompting', () => {
  assert.deepEqual(modelsMissingDiscountInfo(['cursor-grok-4.6-high'], '2026-08-13', { detected: detectedForPrompt, manual: [] }), []);
});
test('a model that ran at list price that day is answered, not unknown', () => {
  const detected = detectDiscounts([0, 1, 2, 3].map((i) => grokEvent(i, 1)), pricing);
  assert.deepEqual(modelsMissingDiscountInfo(['cursor-grok-4.6-high'], '2026-08-13', { detected, manual: [] }), []);
});
test('a model never run that day is what the prompt is for', () => {
  assert.deepEqual(
    modelsMissingDiscountInfo(['gpt-5.2'], '2026-08-13', { detected: detectedForPrompt, manual: [] }),
    ['gpt-5.2'],
  );
});
test('a hand-entered discount also settles the question', () => {
  const entry = normalizeDiscountEntry({ models: ['gpt-5-2'], start: '2026-08-01', end: '2026-08-31', pct: 30 });
  assert.deepEqual(modelsMissingDiscountInfo(['gpt-5.2'], '2026-08-13', { detected: detectedForPrompt, manual: [entry] }), []);
});
test('with no day to price against, there is nothing to ask about', () => {
  assert.deepEqual(modelsMissingDiscountInfo(['gpt-5.2'], null, { detected: detectedForPrompt, manual: [] }), []);
});

console.log('normalize');
const tokenBasedRaw = {
  id: 'a',
  timestamp: '1750000000000',
  model: 'claude-4.5-sonnet',
  isTokenBasedCall: true,
  chargedCents: 123,
  cursorTokenFee: 3,
  tokenUsage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 50000, cacheWriteTokens: 0, totalCents: 100 },
};
const usageBasedRaw = {
  id: 'b',
  timestamp: 1750000, // seconds — should be scaled to ms
  model: 'auto',
  isTokenBasedCall: false,
  chargedCents: 4,
  tokenUsage: { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, totalCents: 2 },
};
test('token-based event uses chargedCents as primary cost', () => {
  const e = normalize(tokenBasedRaw, pricing);
  assert.equal(e.cost, 1.23);
  assert.equal(e.tokenCost, 1.03);
  assert.equal(e.requestCharge, null);
  assert.equal(e.totalTokens, 51200);
  assert.equal(e.timestampMs, 1750000000000);
});
test('usage-based event separates flat fee from token cost', () => {
  const e = normalize(usageBasedRaw, pricing);
  assert.equal(e.cost, 0.02);
  assert.equal(e.requestCharge, 0.04);
  assert.equal(e.model, 'Auto');
  assert.equal(e.timestampMs, 1750000 * 1000);
});

console.log('summaries');
test('detectBillingMode: token / usage / mixed', () => {
  const t = normalize(tokenBasedRaw, pricing);
  const u = normalize(usageBasedRaw, pricing);
  assert.equal(detectBillingMode([t]), 'token');
  assert.equal(detectBillingMode([u]), 'usage');
  assert.equal(detectBillingMode([t, u]), 'mixed');
});
test('summarize totals costs, fees, and savings', () => {
  const events = [normalize(tokenBasedRaw, pricing), normalize(usageBasedRaw, pricing)];
  const s = summarize(events);
  assert.equal(s.count, 2);
  assert.ok(Math.abs(s.totalCost - 1.25) < 1e-9);
  assert.ok(Math.abs(s.totalRequestFees - 0.04) < 1e-9);
  assert.equal(s.billingMode, 'mixed');
  assert.equal(s.hasUsageFees, true);
});
test('billedCost: included/errored kinds are 0, charges bill, free plan forces 0', () => {
  const included = normalize({ ...tokenBasedRaw, kind: 'Included in Pro' }, pricing);
  assert.equal(included.billedCost, 0);
  const errored = normalize({ ...tokenBasedRaw, kind: 'Errored, Not Charged' }, pricing);
  assert.equal(errored.billedCost, 0);
  const charged = normalize(tokenBasedRaw, pricing);
  assert.equal(charged.billedCost, 1.23);
  const usageFee = normalize(usageBasedRaw, pricing);
  assert.equal(usageFee.billedCost, 0.04);
  const free = normalize(tokenBasedRaw, pricing, { freePlan: true });
  assert.equal(free.billedCost, 0);
  assert.equal(free.valueCost, free.cost);
  const unknown = normalize({ model: 'x', tokenUsage: { totalCents: 10 } }, pricing);
  assert.equal(unknown.billedCost, null);
});
console.log('plan-change reconciliation (range spanning two billing systems)');
// Modelled on a real report: an Aug 1–12 range holding requests priced by the
// old per-request plan (flat $0.04 fee) and, after the plan changed, requests
// metered in dollars. cursor.com's usage page reported $2.79 for the range
// while the panel showed $185.37 — the blend of both systems.
const legacyRequest = {
  id: 'legacy',
  timestamp: 1_785_900_000_000,
  model: 'claude-opus-5-thinking-xhigh',
  isTokenBasedCall: false,
  chargedCents: 4,
  tokenUsage: { inputTokens: 6205, outputTokens: 19713, totalCents: 364 },
};
const meteredRequest = {
  id: 'metered',
  timestamp: 1_786_500_000_000,
  model: 'claude-sonnet-5-thinking-medium',
  kind: 'Included in Business',
  isTokenBasedCall: true,
  chargedCents: 261,
  tokenUsage: { inputTokens: 5340, outputTokens: 22537, totalCents: 261 },
};

test('a flat per-request fee marks the old plan; metered requests carry the spend', () => {
  const legacy = normalize(legacyRequest, pricing);
  assert.equal(legacy.billingRegime, 'usage');
  assert.equal(legacy.requestCharge, 0.04);
  assert.equal(legacy.planMeteredCost, null, 'per-request billing is not metered spend');

  const metered = normalize(meteredRequest, pricing);
  assert.equal(metered.billingRegime, 'token');
  assert.equal(metered.requestCharge, null);
  assert.equal(metered.planMeteredCost, 2.61, "matches cursor.com's metered amount for the row");
});

test('"Included" usage still counts as metered spend', () => {
  // cursor.com reports included usage in Total usage (against the monthly
  // allowance); only the out-of-pocket Billed figure treats it as zero.
  const e = normalize(meteredRequest, pricing);
  assert.equal(e.billedCost, 0);
  assert.equal(e.planMeteredCost, 2.61);
});

test('summarize reports the metered total separately from the old plan', () => {
  const events = [
    ...Array.from({ length: 56 }, (_, i) => normalize({ ...legacyRequest, id: `l${i}` }, pricing)),
    normalize(meteredRequest, pricing),
    normalize({ ...meteredRequest, id: 'metered2', chargedCents: 17, tokenUsage: { totalCents: 17 } }, pricing),
  ];
  const s = summarize(events);
  assert.equal(s.spansPlanChange, true);
  assert.equal(s.meteredCount, 2);
  assert.ok(Math.abs(s.meteredTotal - 2.78) < 1e-9, `metered total ${s.meteredTotal}`);
  assert.equal(s.legacyRequestCount, 56);
  assert.ok(Math.abs(s.legacyFeeTotal - 2.24) < 1e-9);
  assert.ok(Math.abs(s.legacyTokenValue - 56 * 3.64) < 1e-9);
  // The blended figure the panel used to headline — kept, but no longer the
  // only number on offer.
  assert.ok(Math.abs(s.totalCost - (56 * 3.64 + 2.78)) < 1e-9);
});

// A migration needs a substantial block on each side (PLAN_CHANGE_MIN_EVIDENCE).
const legacyRun = (n, day) => Array.from({ length: n }, (_, i) =>
  normalize({ ...legacyRequest, id: `l${day}-${i}`, timestamp: Date.UTC(2026, 7, day, 9 + i) }, pricing));
const meteredRun = (n, day) => Array.from({ length: n }, (_, i) =>
  normalize({ ...meteredRequest, id: `m${day}-${i}`, timestamp: Date.UTC(2026, 7, day, 9 + i) }, pricing));

test('detectPlanChange finds the day billing switched systems', () => {
  const events = [...legacyRun(5, 4), ...meteredRun(5, 12)];
  const change = detectPlanChange(events);
  assert.equal(change.changedAtMs, Date.UTC(2026, 7, 12, 9), 'the first metered request');
  assert.equal(change.legacyRequestsBefore, 5);
  assert.equal(change.dayKey, dayKey(Date.UTC(2026, 7, 12, 9)));
  // The range must start at midnight local, or the earlier part of the
  // changeover day silently drops out of the filter.
  assert.equal(new Date(change.startOfDayMs).getHours(), 0);
});
test('detectPlanChange is order-independent', () => {
  const events = [...meteredRun(5, 12), ...legacyRun(5, 4)];
  assert.equal(detectPlanChange(events).changedAtMs, Date.UTC(2026, 7, 12, 9));
});
test('no change reported when only one billing system is present', () => {
  assert.equal(detectPlanChange(meteredRun(5, 12)), null);
  assert.equal(detectPlanChange(legacyRun(5, 4)), null);
  assert.equal(detectPlanChange([]), null);
});
test('metered rows before any legacy row are not a change', () => {
  // Old rows arriving after newer ones must not invent a boundary.
  const events = [...meteredRun(5, 4), ...legacyRun(5, 12)];
  assert.equal(detectPlanChange(events), null);
});
test('interleaved regimes are a mixed account, not a migration', () => {
  // The false positive from a live Enterprise account: every row the same
  // "included in business" kind, some token-metered and some not, all the way
  // through. A migration never reverts, so a per-request row after the first
  // metered one rules one out.
  const events = [
    ...legacyRun(6, 4),
    ...meteredRun(6, 12),
    ...legacyRun(2, 13), // back to per-request pricing — impossible after a switch
  ];
  assert.equal(detectPlanChange(events), null);
});
test('a couple of odd rows either side is not enough evidence', () => {
  // Narrow windows ("Today") hold few rows; without a floor they manufactured a
  // boundary, and the reported change date then moved with the date filter.
  assert.equal(detectPlanChange([...legacyRun(2, 4), ...meteredRun(9, 12)]), null);
  assert.equal(detectPlanChange([...legacyRun(9, 4), ...meteredRun(2, 12)]), null);
  assert.ok(detectPlanChange([...legacyRun(5, 4), ...meteredRun(5, 12)]));
});
test('the boundary is the first token-metered row, not the first unpriced one', () => {
  // A $0 included request sitting just before the real switch must not pull the
  // reported change date a day early.
  const included = { ...legacyRequest, chargedCents: 0 };
  const events = [
    ...legacyRun(6, 4),
    normalize({ ...included, id: 'free', timestamp: Date.UTC(2026, 7, 11, 9) }, pricing),
    ...meteredRun(6, 12),
  ];
  assert.equal(detectPlanChange(events).changedAtMs, Date.UTC(2026, 7, 12, 9));
});
test('included requests charged $0 are not "priced per request"', () => {
  // chargedCents: 0 means nothing was charged, not that a per-request fee of
  // zero was applied. Counting these as the old pricing system reported a plan
  // change on an account that never had one.
  const included = { ...legacyRequest, chargedCents: 0 };
  const events = [
    ...Array.from({ length: 6 }, (_, i) =>
      normalize({ ...included, id: `i${i}`, timestamp: Date.UTC(2026, 7, 4, 9 + i) }, pricing)),
    ...meteredRun(6, 12),
  ];
  assert.equal(summarize(events).legacyRequestCount, 0);
  assert.equal(summarize(events).spansPlanChange, false);
  assert.equal(summarize(events).hasUsageFees, false);
});

test('the metered total is identical in What-if and Billed mode', () => {
  // The reconciliation figure answers "what does cursor.com meter for this
  // range", which the cost toggle must not move. applyCostMode() rewrites
  // `cost`, so anything deriving metered spend from `cost` at summarize time
  // would drift — this pins it to normalize() time.
  const events = [normalize(legacyRequest, pricing), normalize(meteredRequest, pricing)];
  const whatIf = summarize(events);
  const billed = summarize(events.map((e) => ({ ...e, cost: e.billedCost })));
  assert.equal(billed.meteredTotal, whatIf.meteredTotal);
  assert.equal(billed.legacyRequestCount, whatIf.legacyRequestCount);
  assert.equal(billed.spansPlanChange, whatIf.spansPlanChange);
  // …while the headline total does move, which is the point of the toggle.
  assert.notEqual(billed.totalCost, whatIf.totalCost);
});

test('summarize over no events yields zeros, not NaN', () => {
  // Every empty load now renders through this path (the panel used to bail out
  // early and leave the previous range's numbers on screen).
  const s = summarize([]);
  assert.equal(s.count, 0);
  assert.equal(s.totalCost, 0);
  assert.equal(s.meteredTotal, 0);
  assert.equal(s.legacyRequestCount, 0);
  assert.equal(s.spansPlanChange, false);
  assert.equal(s.avg, null);
  assert.equal(s.withCostCounted, 0);
  for (const [key, value] of Object.entries(s)) {
    assert.ok(!Number.isNaN(value), `${key} is NaN`);
  }
});

test('a range inside one billing system is not flagged as a plan change', () => {
  const onlyMetered = summarize([normalize(meteredRequest, pricing)]);
  assert.equal(onlyMetered.spansPlanChange, false);
  assert.ok(Math.abs(onlyMetered.meteredTotal - 2.61) < 1e-9);

  const onlyLegacy = summarize([normalize(legacyRequest, pricing)]);
  assert.equal(onlyLegacy.spansPlanChange, false);
  assert.equal(onlyLegacy.meteredTotal, 0);
  assert.equal(onlyLegacy.legacyRequestCount, 1);
});

test('metered spend is unaffected by an unset isTokenBasedCall flag', () => {
  // Same row without the flag: no flat fee still means the new system, so the
  // reconciliation figure holds whichever way cursor.com labels the event.
  const e = normalize({ ...meteredRequest, isTokenBasedCall: false, chargedCents: null }, pricing);
  assert.equal(e.billingRegime, 'unknown');
  assert.equal(e.planMeteredCost, 2.61);
});

test('withCostCounted never exceeds the request count it is shown under', () => {
  // An errored row carries cost data but is not a request: reporting it under
  // the Requests headline showed "121 requests / 122 with cost data".
  const events = [
    normalize(tokenBasedRaw, pricing),
    normalize({ ...tokenBasedRaw, id: 'c', kind: 'Errored, Not Charged' }, pricing),
  ];
  const s = summarize(events);
  assert.equal(s.count, 1);
  assert.equal(s.withCost, 2);
  assert.equal(s.withCostCounted, 1);
  assert.ok(s.withCostCounted <= s.count);
});
test('percentile', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.75), 4);
  assert.equal(percentile([], 0.75), null);
});
test('displayModel maps default/auto', () => {
  assert.equal(displayModel('default'), 'Auto');
  assert.equal(displayModel('gpt-5.2'), 'gpt-5.2');
});

console.log('date bucketing & range filtering');

/** Local midnight of a Y/M/D, the way the dashboard's date pickers build ranges. */
function localMidnight(y, m, d, h = 0, min = 0) {
  return new Date(y, m - 1, d, h, min, 0, 0).getTime();
}

test('dayKey buckets by local day, not UTC day', () => {
  // Late-evening and early-morning stamps stay on their local calendar day in
  // every timezone — the UTC-based bucketing this replaced moved one of them.
  assert.equal(dayKey(localMidnight(2026, 8, 12, 23, 30)), '2026-08-12');
  assert.equal(dayKey(localMidnight(2026, 8, 12, 0, 15)), '2026-08-12');
  assert.equal(dayKey(NaN), null);
});

test('groupByDay sums cost per local day and skips costless/timeless events', () => {
  const byDay = groupByDay([
    { timestampMs: localMidnight(2026, 8, 12, 23, 30), cost: 1 },
    { timestampMs: localMidnight(2026, 8, 12, 1, 0), cost: 0.5 },
    { timestampMs: localMidnight(2026, 8, 11, 9, 0), cost: 2 },
    { timestampMs: localMidnight(2026, 8, 11, 9, 0), cost: null },
    { timestampMs: 0, cost: 3 },
  ]);
  assert.deepEqual(byDay, { '2026-08-12': 1.5, '2026-08-11': 2 });
});

test('groupByDay days fall inside the local range that selected them', () => {
  const start = localMidnight(2026, 8, 12);
  const end = localMidnight(2026, 8, 12, 23, 59) + 59_999;
  const events = [
    { timestampMs: localMidnight(2026, 8, 12, 0, 5), cost: 1 },
    { timestampMs: localMidnight(2026, 8, 12, 22, 45), cost: 1 },
  ];
  const days = Object.keys(groupByDay(filterByRange(events, start, end)));
  assert.deepEqual(days, ['2026-08-12']);
});

test('filterByRange drops out-of-range rows and keeps timestamp-less ones', () => {
  const start = localMidnight(2026, 8, 12);
  const end = localMidnight(2026, 8, 12, 23, 59) + 59_999;
  const events = [
    { id: 'before', timestampMs: start - 1 },
    { id: 'start-edge', timestampMs: start },
    { id: 'inside', timestampMs: localMidnight(2026, 8, 12, 13, 0) },
    { id: 'end-edge', timestampMs: end },
    { id: 'after', timestampMs: end + 1 },
    { id: 'no-timestamp', timestampMs: 0 },
  ];
  assert.deepEqual(
    filterByRange(events, start, end).map((e) => e.id),
    ['start-edge', 'inside', 'end-edge', 'no-timestamp'],
  );
});

test('filterByRange is a no-op when the range is not a usable number', () => {
  const events = [{ id: 'a', timestampMs: 1 }];
  assert.equal(filterByRange(events, NaN, 5), events);
  assert.equal(filterByRange(events, 1, undefined), events);
});

// Source-level invariants: the webview's DOM wiring has no test harness here,
// and the bug these guard against (one selector matching two kinds of button)
// is invisible to the logic tests above.
console.log('webview wiring invariants');
test('period wiring cannot match the cost-mode buttons', () => {
  const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');
  assert.equal(
    main.match(/querySelectorAll\(\s*['"]\.preset-btn['"]\s*\)/g),
    null,
    'querySelectorAll(".preset-btn") also matches the .cost-mode-btn buttons: applying a date '
    + 'preset clears the What-if/Billed highlight and clicking one fires the period handler',
  );
});
test('the period and cost-mode controls exist exactly once', () => {
  // Overview used to carry a second copy of these chips, two rows below the
  // filter bar — two controls for one filter, which is what a user sees as
  // "the same filters twice".
  const html = readFileSync(path.join(here, '..', 'src/html.ts'), 'utf8');
  for (const preset of ['today', '7d', '30d', 'mtd', 'custom']) {
    const hits = html.match(new RegExp(`data-preset="${preset}"`, 'g')) || [];
    assert.equal(hits.length, 1, `data-preset="${preset}" appears ${hits.length} times`);
  }
  for (const mode of ['value', 'billed']) {
    const hits = html.match(new RegExp(`data-cost-mode="${mode}"`, 'g')) || [];
    assert.equal(hits.length, 1, `data-cost-mode="${mode}" appears ${hits.length} times`);
  }
});
test('cost-mode buttons declare no data-preset', () => {
  const html = readFileSync(path.join(here, '..', 'src/html.ts'), 'utf8');
  const buttons = html.match(/<button[^>]*cost-mode-btn[^>]*>/g) || [];
  assert.ok(buttons.length >= 2, 'expected the What-if/Billed buttons in the markup');
  for (const tag of buttons) {
    assert.ok(!/data-preset/.test(tag), `cost-mode button also declares data-preset: ${tag}`);
  }
});
test('every id the discount UI wires up exists in the markup', () => {
  // These are joined only by string ids, so a rename on one side fails silently
  // at runtime — the listener never binds and the button does nothing.
  const html = readFileSync(path.join(here, '..', 'src/html.ts'), 'utf8');
  for (const id of [
    'simIntro', 'simIntroTitle', 'simIntroBody', 'simIntroDismiss', 'simIntroAdd',
    'simDiscountExplain', 'simDiscountToggle', 'simDiscountSummary', 'simDiscountEditor',
    'simDiscountPrompt', 'simCompareFootnote',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `markup is missing id="${id}"`);
  }
});
test('the intro dialog is a labelled modal that starts hidden', () => {
  const html = readFileSync(path.join(here, '..', 'src/html.ts'), 'utf8');
  const tag = html.match(/<div[^>]*id="simIntro"[^>]*>/)?.[0] || '';
  assert.ok(/role="dialog"/.test(tag), 'needs role="dialog"');
  assert.ok(/aria-modal="true"/.test(tag), 'needs aria-modal so the rest of the page reads as inert');
  assert.ok(/aria-labelledby="simIntroTitle"/.test(tag), 'needs an accessible name');
  assert.ok(/\bhidden\b/.test(tag), 'must not be visible before the first Simulator visit');
});
test('the intro is shown once, not on every visit to the Simulator', () => {
  const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');
  const fn = main.match(/function maybeShowSimIntro\(\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(fn.includes('SIM_INTRO_KEY'), 'must consult the persisted seen-flag before opening');
  assert.ok(/return;/.test(fn), 'must bail out when already seen');
  assert.ok(
    /storage\.setItem\(SIM_INTRO_KEY/.test(main),
    'the flag has to be written somewhere or the dialog reopens forever',
  );
});

// --- TS modules -----------------------------------------------------------

const authCore = await loadTs('src/authCore.ts', 'authCore.mjs');
const api = await loadTs('src/api.ts', 'api.mjs');

console.log('api.pickConversationId / toRawEvent');
test('the conversation id is read under each spelling the endpoints use', () => {
  assert.equal(api.pickConversationId({ conversationId: 'c1' }), 'c1');
  assert.equal(api.pickConversationId({ conversation_id: 'c2' }), 'c2');
  assert.equal(api.pickConversationId({ composerId: 'c3' }), 'c3');
  assert.equal(api.pickConversationId({ threadId: 'c4' }), 'c4');
  assert.equal(api.pickConversationId({ chatId: 'c5' }), 'c5');
  assert.equal(api.pickConversationId({ conversationId: 42 }), '42');
});
test('an absent or blank conversation id is undefined, not a session key', () => {
  // A blank id would otherwise gather every unattributed request into one
  // conversation that does not exist.
  assert.equal(api.pickConversationId({}), undefined);
  assert.equal(api.pickConversationId({ conversationId: null }), undefined);
  assert.equal(api.pickConversationId({ conversationId: '' }), undefined);
  assert.equal(api.pickConversationId({ conversationId: '   ' }), undefined);
  assert.equal(api.pickConversationId(undefined), undefined);
});
test('toRawEvent carries the conversation id through instead of dropping it', () => {
  const withId = api.toRawEvent({ id: 'e1', timestamp: 1, model: 'auto', conversationId: 'c1' });
  assert.equal(withId.conversationId, 'c1');
  // Absent stays absent, so consumers can tell "no conversation" from "".
  assert.equal(api.toRawEvent({ id: 'e2', timestamp: 1, model: 'auto' }).conversationId, undefined);
});

function fakeJwt(payload) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64(payload)}.sig`;
}

console.log('authCore');
test('decodeJwtPayload + userIdFromSub + buildCookieValue', () => {
  const token = fakeJwt({ sub: 'auth0|user_123', exp: 9999999999 });
  const payload = authCore.decodeJwtPayload(token);
  assert.equal(payload.sub, 'auth0|user_123');
  const userId = authCore.userIdFromSub(payload.sub);
  assert.equal(userId, 'user_123');
  assert.equal(authCore.buildCookieValue(userId, 'tok'), 'user_123%3A%3Atok');
});
test('normalizeManualToken accepts cookie value, pair, :: form, bare JWT', () => {
  assert.equal(authCore.normalizeManualToken('user_1%3A%3Aabc'), 'user_1%3A%3Aabc');
  assert.equal(authCore.normalizeManualToken('WorkosCursorSessionToken=user_1%3A%3Aabc'), 'user_1%3A%3Aabc');
  assert.equal(authCore.normalizeManualToken('user_1::abc'), 'user_1%3A%3Aabc');
  const jwt = fakeJwt({ sub: 'auth0|user_9' });
  assert.equal(authCore.normalizeManualToken(jwt), `user_9%3A%3A${jwt}`);
  assert.equal(authCore.normalizeManualToken('garbage'), null);
});

console.log('api.toRawEvent');
test('maps dashboard event shape defensively', () => {
  const raw = api.toRawEvent({
    timestamp: '1750000000000',
    model: 'claude-4.5-sonnet',
    kindLabel: 'Included in Pro',
    isTokenBasedCall: true,
    usageBasedCosts: '$1.23',
    tokenUsage: { inputTokens: '10', outputTokens: '2', cacheReadTokens: '5', cacheWriteTokens: '0', totalCents: 100 },
  });
  assert.equal(raw.model, 'claude-4.5-sonnet');
  assert.equal(raw.chargedCents, 123);
  assert.equal(raw.tokenUsage.inputTokens, 10);
  assert.equal(raw.kind, 'Included in Pro');
});
test('numeric cents pass through; "-" cost is null', () => {
  assert.equal(api.toRawEvent({ chargedCents: 55, model: 'x' }).chargedCents, 55);
  assert.equal(api.toRawEvent({ usageBasedCosts: '-', model: 'x' }).chargedCents, null);
});

console.log('service.sumBilledCostDollars');
const service = await loadTs('src/service.ts', 'service.mjs');
test('sums chargedCents, zeroing included/errored kinds', () => {
  const events = [
    api.toRawEvent({ chargedCents: 100, model: 'x' }),
    api.toRawEvent({ chargedCents: 200, kind: 'Included in Pro', model: 'x' }),
    api.toRawEvent({ chargedCents: 300, kind: 'Errored, Not Charged', model: 'x' }),
  ];
  assert.equal(service.sumBilledCostDollars(events), 1.0);
});
test('free plan forces 0 regardless of chargedCents', () => {
  const events = [api.toRawEvent({ chargedCents: 500, model: 'x' })];
  assert.equal(service.sumBilledCostDollars(events, { membershipType: 'free' }), 0);
  assert.equal(service.sumBilledCostDollars(events, { membershipType: 'pro' }), 5.0);
});

console.log('projectBudgetRunway (burn rate for budget-metered plans)');
const cycleStart = Date.UTC(2026, 7, 9);
const cycleEnd = Date.UTC(2026, 8, 9);
const now = Date.UTC(2026, 7, 12); // 3 days into a 31-day cycle

test('projects days of runway from the pace so far', () => {
  const r = service.projectBudgetRunway({
    spentDollars: 10.84, budgetDollars: 120, cycleStartMs: cycleStart, cycleEndMs: cycleEnd, nowMs: now,
  });
  assert.ok(Math.abs(r.dailySpend - 10.84 / 3) < 1e-9);
  assert.ok(Math.abs(r.remainingDollars - 109.16) < 1e-9);
  assert.ok(Math.abs(r.percentUsed - 9.033) < 0.01);
  assert.ok(Math.abs(r.daysToExhaustion - 109.16 / (10.84 / 3)) < 1e-9);
  assert.equal(r.overBudget, false);
  // 30.2 days of runway against 28 days left — finishes the cycle in budget.
  assert.equal(r.exhaustsBeforeReset, false);
  assert.ok(Math.abs(r.safeDailySpend - 109.16 / 28) < 1e-9);
});

test('flags a budget that runs out before the cycle resets', () => {
  const r = service.projectBudgetRunway({
    spentDollars: 60, budgetDollars: 120, cycleStartMs: cycleStart, cycleEndMs: cycleEnd, nowMs: now,
  });
  assert.equal(r.dailySpend, 20);
  assert.equal(r.daysToExhaustion, 3);
  assert.equal(r.exhaustsBeforeReset, true);
  assert.equal(r.exhaustionDate.getTime(), now + 3 * 24 * 60 * 60 * 1000);
  assert.ok(r.safeDailySpend < r.dailySpend, 'staying in budget requires slowing down');
});

test('raising the budget mid-cycle extends the runway from the same spend', () => {
  const args = { spentDollars: 60, cycleStartMs: cycleStart, cycleEndMs: cycleEnd, nowMs: now };
  const before = service.projectBudgetRunway({ ...args, budgetDollars: 120 });
  const after = service.projectBudgetRunway({ ...args, budgetDollars: 240 });
  assert.equal(after.dailySpend, before.dailySpend, 'pace is a fact about spending, not the budget');
  assert.equal(after.daysToExhaustion, 9);
  assert.equal(before.exhaustsBeforeReset, true);
  assert.equal(after.exhaustsBeforeReset, true);
  assert.ok(after.safeDailySpend > before.safeDailySpend);
});

test('cutting the budget below what is already spent reports over budget', () => {
  const r = service.projectBudgetRunway({
    spentDollars: 60, budgetDollars: 40, cycleStartMs: cycleStart, cycleEndMs: cycleEnd, nowMs: now,
  });
  assert.equal(r.overBudget, true);
  assert.equal(r.remainingDollars, -20);
  assert.equal(r.daysToExhaustion, 0, 'already exhausted, not negative days');
  assert.equal(r.exhaustionDate.getTime(), now);
  assert.equal(r.safeDailySpend, null, 'no daily spend keeps you inside a budget already passed');
  assert.ok(r.percentUsed > 100, 'percent is not clamped — callers need the real overrun');
});

test('too early in the cycle to project a pace', () => {
  // Two hours in, one big request would project the budget gone by lunchtime.
  const r = service.projectBudgetRunway({
    spentDollars: 5, budgetDollars: 120, cycleStartMs: cycleStart, cycleEndMs: cycleEnd,
    nowMs: cycleStart + 2 * 60 * 60 * 1000,
  });
  assert.equal(r.dailySpend, null);
  assert.equal(r.daysToExhaustion, null);
  assert.equal(r.exhaustionDate, null);
  assert.equal(r.exhaustsBeforeReset, null);
  assert.equal(r.remainingDollars, 115, 'the balance is still reported');
  assert.ok(r.safeDailySpend > 0, 'and so is a safe daily rate');
});

test('no budget, no projection', () => {
  const base = { spentDollars: 10, cycleStartMs: cycleStart, cycleEndMs: cycleEnd, nowMs: now };
  assert.equal(service.projectBudgetRunway({ ...base, budgetDollars: null }), null);
  assert.equal(service.projectBudgetRunway({ ...base, budgetDollars: 0 }), null);
  assert.equal(service.projectBudgetRunway({ ...base, budgetDollars: undefined }), null);
});

test('zero spend so far leaves the runway open rather than infinite', () => {
  const r = service.projectBudgetRunway({
    spentDollars: 0, budgetDollars: 120, cycleStartMs: cycleStart, cycleEndMs: cycleEnd, nowMs: now,
  });
  assert.equal(r.dailySpend, null, 'no pace to extrapolate from');
  assert.equal(r.daysToExhaustion, null);
  assert.ok(Math.abs(r.safeDailySpend - 120 / 28) < 1e-9);
});

test('an explicit pace overrides the cycle average', () => {
  // Lets a caller swap in a trailing rate without touching this math.
  const r = service.projectBudgetRunway({
    spentDollars: 60, budgetDollars: 120, cycleStartMs: cycleStart, cycleEndMs: cycleEnd, nowMs: now,
    dailySpendOverride: 6,
  });
  assert.equal(r.dailySpend, 6);
  assert.equal(r.daysToExhaustion, 10);
});

test('budget spend counts metered requests only', () => {
  // Requests priced by the old per-request plan never drew on a dollar budget,
  // so they must not burn one down.
  const events = [
    api.toRawEvent({ id: 'm', isTokenBasedCall: true, chargedCents: 261, tokenUsage: { totalCents: 261 } }),
    api.toRawEvent({ id: 'l', isTokenBasedCall: false, chargedCents: 4, tokenUsage: { totalCents: 364 } }),
  ];
  assert.ok(Math.abs(service.sumPlanMeteredDollars(events) - 2.61) < 1e-9);
  assert.ok(Math.abs(service.sumTokenCostDollars(events) - (2.61 + 3.64)) < 1e-9);
});

test('panel and status bar classify billing regimes identically', () => {
  const raws = [
    { id: 'm', isTokenBasedCall: true, chargedCents: 261, tokenUsage: { totalCents: 261 } },
    { id: 'l', isTokenBasedCall: false, chargedCents: 4, tokenUsage: { totalCents: 364 } },
    { id: 'u', isTokenBasedCall: false, chargedCents: null, tokenUsage: { totalCents: 100 } },
  ].map(api.toRawEvent);
  for (const raw of raws) {
    const e = normalize(raw, pricing);
    assert.equal(e.billingRegime, service.eventBillingRegime(raw), `regime for ${raw.id}`);
    assert.equal(e.planMeteredCost, service.planMeteredDollars(raw), `metered cost for ${raw.id}`);
  }
});

console.log('service.eventsWithinRange (window enforced for panel + status bar)');
test('eventTimestampMs normalizes seconds, ms, strings, and junk', () => {
  const ms = Date.UTC(2026, 7, 12, 9, 0, 0);
  assert.equal(service.eventTimestampMs(ms), ms);
  assert.equal(service.eventTimestampMs(Math.floor(ms / 1000)), Math.floor(ms / 1000) * 1000);
  assert.equal(service.eventTimestampMs(String(ms)), ms);
  assert.equal(service.eventTimestampMs(0), 0);
  assert.equal(service.eventTimestampMs(undefined), 0);
  assert.equal(service.eventTimestampMs('not-a-date'), 0);
});
test('drops rows the API returned from outside the requested window', () => {
  // The failure this guards: an Aug 1–12 query answered with July rows, which
  // then inflate the panel's totals and the status bar's cost alike.
  const start = Date.UTC(2026, 7, 1);
  const end = Date.UTC(2026, 7, 12, 23, 59, 59, 999);
  const events = [
    { id: 'july', timestamp: Date.UTC(2026, 6, 20, 12, 0) },
    { id: 'in-range', timestamp: Date.UTC(2026, 7, 11, 12, 0) },
    { id: 'in-range-seconds', timestamp: Math.floor(Date.UTC(2026, 7, 12, 8, 0) / 1000) },
    { id: 'september', timestamp: Date.UTC(2026, 8, 2, 12, 0) },
    { id: 'no-timestamp', timestamp: 0 },
  ];
  assert.deepEqual(
    service.eventsWithinRange(events, start, end).map((e) => e.id),
    ['in-range', 'in-range-seconds', 'no-timestamp'],
  );
});
test('eventTimestampSpan reports the real span so logs can flag a window mismatch', () => {
  const events = [
    { timestamp: Date.UTC(2026, 6, 20) },
    { timestamp: 0 },
    { timestamp: Date.UTC(2026, 7, 12) },
  ];
  assert.deepEqual(service.eventTimestampSpan(events), {
    min: Date.UTC(2026, 6, 20),
    max: Date.UTC(2026, 7, 12),
  });
  assert.equal(service.eventTimestampSpan([{ timestamp: 0 }]), null);
});
test('an in-window response is passed through untouched', () => {
  const start = Date.UTC(2026, 7, 1);
  const end = Date.UTC(2026, 7, 12, 23, 59, 59, 999);
  const events = [{ id: 'a', timestamp: Date.UTC(2026, 7, 5) }];
  assert.deepEqual(service.eventsWithinRange(events, start, end), events);
});

test('panel and status bar report the same totals for the same events', () => {
  // The panel sums normalize()d events; the status bar sums raw ones through
  // shared helpers. Two code paths, one number the user compares against
  // cursor.com — they must not drift apart.
  const raws = [
    { id: 'a', timestamp: 1_780_000_000_000, model: 'auto', isTokenBasedCall: true, chargedCents: 123, cursorTokenFee: 3, tokenUsage: { inputTokens: 10, totalCents: 100 } },
    { id: 'b', timestamp: 1_780_000_100_000, model: 'auto', isTokenBasedCall: false, chargedCents: 4, tokenUsage: { inputTokens: 10, totalCents: 2 } },
    { id: 'c', timestamp: 1_780_000_200_000, model: 'auto', kind: 'Included in Business', isTokenBasedCall: false, chargedCents: 0, tokenUsage: { inputTokens: 10, totalCents: 250 } },
    { id: 'd', timestamp: 1_780_000_300_000, model: 'auto', kind: 'Errored, Not Charged', isTokenBasedCall: false, chargedCents: null, tokenUsage: { inputTokens: 0, totalCents: 0 } },
  ];
  const rawEvents = raws.map(api.toRawEvent);
  const normalized = rawEvents.map((r) => normalize(r, pricing));

  const panelWhatIf = summarize(normalized).totalCost;
  assert.ok(
    Math.abs(panelWhatIf - service.sumTokenCostDollars(rawEvents)) < 1e-9,
    `what-if drifted: panel ${panelWhatIf} vs status bar ${service.sumTokenCostDollars(rawEvents)}`,
  );

  const panelBilled = normalized.reduce((s, e) => s + (e.billedCost ?? 0), 0);
  assert.ok(
    Math.abs(panelBilled - service.sumBilledCostDollars(rawEvents)) < 1e-9,
    `billed drifted: panel ${panelBilled} vs status bar ${service.sumBilledCostDollars(rawEvents)}`,
  );

  assert.equal(summarize(normalized).count, service.countRequests(rawEvents));
});

test('eventKindTotals splits the window the way cursor.com reports it', () => {
  const events = [
    api.toRawEvent({ id: 1, kind: 'Included in Business', tokenUsage: { totalCents: 500 } }),
    api.toRawEvent({ id: 2, kind: 'Included in Business', tokenUsage: { totalCents: 300 } }),
    api.toRawEvent({ id: 3, kind: 'Usage-based', chargedCents: 40, tokenUsage: { totalCents: 100 } }),
  ];
  const totals = service.eventKindTotals(events);
  assert.deepEqual(totals.map((t) => [t.kind, t.count]), [
    ['Included in Business', 2],
    ['Usage-based', 1],
  ]);
  assert.ok(Math.abs(totals[0].tokenCostDollars - 8.0) < 1e-9);
  assert.equal(totals[0].chargedDollars, 0);
  assert.ok(Math.abs(totals[1].tokenCostDollars - 1.0) < 1e-9);
  assert.ok(Math.abs(totals[1].chargedDollars - 0.4) < 1e-9);
});

console.log('api.fetchDashboardUsage pagination');

/** Stubs global fetch with canned page bodies, restoring the original after. */
async function withFetchPages(pages, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.page);
    const payload = pages(body.page);
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const fakeSession = { cookieValue: 'cookie', userId: 'u1' };

// Awaited one at a time: these swap the global fetch, so overlapping runs
// would see each other's stub.
await test('walks pages and returns every distinct event', async () => {
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, timestamp: 1_780_000_000_000 }));
  const page2 = Array.from({ length: 22 }, (_, i) => ({ id: `e${100 + i}`, timestamp: 1_780_000_000_000 }));
  await withFetchPages(
    (page) => ({
      usageEventsDisplay: page === 1 ? page1 : page === 2 ? page2 : [],
      totalUsageEventsCount: 122,
    }),
    async () => {
      const events = await api.fetchDashboardUsage(fakeSession, 0, Date.now());
      assert.equal(events.length, 122);
      assert.equal(new Set(events.map((e) => e.id)).size, 122);
    },
  );
});

await test('an endpoint that ignores the page parameter cannot double-count', async () => {
  // Same first page every time: without the guard this appends 100 duplicate
  // events and every total, average and chart inflates by a full page.
  const page1 = Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, timestamp: 1_780_000_000_000 }));
  await withFetchPages(
    () => ({ usageEventsDisplay: page1, totalUsageEventsCount: 500 }),
    async (calls) => {
      const events = await api.fetchDashboardUsage(fakeSession, 0, Date.now());
      assert.equal(events.length, 100);
      assert.ok(calls.length <= 2, `stopped after ${calls.length} pages instead of looping`);
    },
  );
});

await test('rows with no server id are kept even when they look alike', async () => {
  // Synthesized ids (timestamp+model) can collide between concurrent requests —
  // those are real, distinct usage and must not be deduplicated away.
  const batch = [
    { timestamp: 1_780_000_000_000, model: 'auto' },
    { timestamp: 1_780_000_000_000, model: 'auto' },
  ];
  await withFetchPages(
    (page) => ({ usageEventsDisplay: page === 1 ? batch : [], totalUsageEventsCount: 2 }),
    async () => {
      const events = await api.fetchDashboardUsage(fakeSession, 0, Date.now());
      assert.equal(events.length, 2);
    },
  );
});

console.log('api.computeResetIso (next quota reset from the cycle start)');
test('adds one calendar month', () => {
  const reset = new Date(api.computeResetIso('2026-03-05T00:00:00'));
  assert.equal(reset.getMonth(), 3, 'March 5 resets in April');
  assert.equal(reset.getDate(), 5);
});
test('a cycle starting on the 31st resets in the next month, not the one after', () => {
  // setMonth(+1) on Jan 31 lands on Mar 3, which would put the reset date — and
  // every "days until reset" figure built on it — a whole month out.
  const reset = new Date(api.computeResetIso('2026-01-31T00:00:00'));
  assert.equal(reset.getMonth(), 1, 'February, clamped to its last day');
  assert.equal(reset.getDate(), 28);
});
test('clamping respects leap years', () => {
  const reset = new Date(api.computeResetIso('2028-01-30T00:00:00'));
  assert.equal(reset.getMonth(), 1);
  assert.equal(reset.getDate(), 29);
});
test('December rolls into the next year', () => {
  const reset = new Date(api.computeResetIso('2026-12-15T00:00:00'));
  assert.equal(reset.getFullYear(), 2027);
  assert.equal(reset.getMonth(), 0);
});
test('missing or malformed dates yield nothing rather than an invalid date', () => {
  assert.equal(api.computeResetIso(undefined), undefined);
  assert.equal(api.computeResetIso('not a date'), undefined);
});

console.log('api.extractBudgetDollars (works for individual and team accounts)');
test('reads an individual hard limit', () => {
  const found = api.extractBudgetDollars({ hardLimit: 120 }, {}, 'get-hard-limit');
  assert.equal(found.dollars, 120);
  assert.equal(found.source, 'get-hard-limit.hardLimit');
});
test('reads a cents-denominated field as dollars', () => {
  assert.equal(api.extractBudgetDollars({ spendLimitCents: 12000 }).dollars, 120);
});
test('picks this user out of a team roster, never a colleague', () => {
  const payload = {
    teamMemberSpend: [
      { userId: 'other', email: 'them@x.io', spendLimitDollars: 500 },
      { userId: 'me', email: 'me@x.io', spendLimitDollars: 120 },
    ],
  };
  assert.equal(api.extractBudgetDollars(payload, { userId: 'me' }, 'get-team-spend').dollars, 120);
  assert.equal(api.extractBudgetDollars(payload, { email: 'ME@x.io' }).dollars, 120, 'email match is case-insensitive');
});
test('a roster with no row for this user yields nothing', () => {
  // Showing someone else's limit as your own is worse than showing none.
  const payload = {
    teamMemberSpend: [
      { userId: 'a', spendLimitDollars: 500 },
      { userId: 'b', spendLimitDollars: 900 },
    ],
  };
  assert.equal(api.extractBudgetDollars(payload, { userId: 'me' }), null);
});
test('a single unambiguous row is used even with nothing to match on', () => {
  assert.equal(api.extractBudgetDollars({ members: [{ spendLimitDollars: 120 }] }, {}).dollars, 120);
});
test('unknown field names are ignored rather than guessed at', () => {
  assert.equal(api.extractBudgetDollars({ someNewLimitField: 120, maxThing: 99 }), null);
});
test('zero, negative and non-numeric limits are not budgets', () => {
  assert.equal(api.extractBudgetDollars({ hardLimit: 0 }), null);
  assert.equal(api.extractBudgetDollars({ hardLimit: -5 }), null);
  assert.equal(api.extractBudgetDollars({ hardLimit: 'unlimited' }), null);
  assert.equal(api.extractBudgetDollars({ noUsageBasedAllowed: true }), null, 'the real reply for an account with no limit');
});
test('a per-user override outranks a team-wide default', () => {
  const found = api.extractBudgetDollars({ spendLimitDollars: 500, hardLimitOverrideDollars: 120 }, {});
  assert.equal(found.dollars, 120);
});

console.log('api.describePayloadShape (find unread fields without logging PII)');
test('prints numbers and booleans, hides free-text', () => {
  const shape = api.describePayloadShape({
    membershipType: 'enterprise',
    customerEmail: 'someone@example.com',
    monthlyLimitDollars: 120,
    verified: true,
    trialDays: null,
  });
  assert.match(shape, /monthlyLimitDollars: 120/);
  assert.match(shape, /verified: true/);
  assert.match(shape, /trialDays: null/);
  assert.match(shape, /membershipType: string/);
  assert.ok(!shape.includes('example.com'), 'an email must never reach the log');
  assert.ok(!shape.includes('enterprise'), 'string contents are withheld');
});
test('a numeric string keeps its value — budgets are sometimes sent that way', () => {
  assert.match(api.describePayloadShape({ limit: '120' }), /limit: 120/);
  assert.match(api.describePayloadShape({ limit: '120.50' }), /limit: 120.50/);
});
test('descends far enough to reach a nested budget field, then summarizes', () => {
  // A limit sitting under two wrapper objects still has to be visible.
  assert.match(api.describePayloadShape({ team: { settings: { spendLimit: 120 } } }), /spendLimit: 120/);
  assert.match(api.describePayloadShape({ a: { b: { c: { d: 1 } } } }), /a: \{b: \{c: \{1 keys\}\}\}/);
  assert.match(api.describePayloadShape({ xs: [{ n: 5 }] }), /xs: array\(1\) of \{n: 5\}/);
  assert.match(api.describePayloadShape({ xs: [] }), /xs: array\(0\)/);
});

await test('stripe profile exposes the team id a budget would be scoped to', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      membershipType: 'enterprise', isTeamMember: true, teamId: 28585505,
    }),
  });
  try {
    const plan = await api.fetchStripeProfile({ cookieValue: 'c', userId: 'u' });
    assert.equal(plan.membershipType, 'enterprise');
    assert.equal(plan.teamId, 28585505);
    assert.equal(plan.isTeamMember, true);
  } finally {
    globalThis.fetch = original;
  }
});

console.log('api.parseQuotaResponse');
test('prefers the gpt-4 bucket, passes through startOfMonth, computes resetIso', () => {
  const quota = api.parseQuotaResponse({
    'gpt-4': { numRequests: 342, maxRequestUsage: 500 },
    'gpt-3.5-turbo': { numRequests: 10, maxRequestUsage: 1000 },
    startOfMonth: '2026-07-01T00:00:00.000Z',
  });
  assert.deepEqual(quota, {
    used: 342,
    limit: 500,
    startOfCycleIso: '2026-07-01T00:00:00.000Z',
    resetIso: '2026-08-01T00:00:00.000Z',
  });
});
test('falls back to any bucket with a limit when gpt-4 is absent', () => {
  const quota = api.parseQuotaResponse({ 'claude-3.5-sonnet': { numRequests: 5, maxRequestUsage: 50 } });
  assert.deepEqual(quota, { used: 5, limit: 50 });
});
test('returns null for shapes with no request-quota buckets', () => {
  assert.equal(api.parseQuotaResponse({ someOtherField: 1 }), null);
  assert.equal(api.parseQuotaResponse(null), null);
  assert.equal(api.parseQuotaResponse('not an object'), null);
});
test('malformed startOfMonth is dropped instead of producing an invalid resetIso', () => {
  const quota = api.parseQuotaResponse({ 'gpt-4': { numRequests: 1, maxRequestUsage: 10 }, startOfMonth: 'not-a-date' });
  assert.equal(quota.resetIso, undefined);
});

console.log('isCountedRequest / request counting (logic.js + service.ts agree)');
test('errored/aborted/cancelled kinds are not counted as requests', () => {
  assert.equal(isCountedRequest('Errored, Not Charged', 5000, null), false);
  assert.equal(isCountedRequest('Aborted, Not Charged', 5000, null), false);
  assert.equal(isCountedRequest('Cancelled', 5000, null), false);
  assert.equal(isCountedRequest('Included in Pro', 5000, null), true);
  assert.equal(isCountedRequest('Usage-based', 5000, 123), true);
});
test('rows with no tokens and no charge are bookkeeping, not requests', () => {
  assert.equal(isCountedRequest(null, 0, null), false);
  assert.equal(isCountedRequest('Included in Pro', 0, 0), false);
  assert.equal(isCountedRequest(null, 0, 4), true); // flat-fee row, no token data
  assert.equal(isCountedRequest(null, 100, null), true);
});
test('summarize separates counted requests from raw event rows', () => {
  const events = [
    normalize(api.toRawEvent({ model: 'x', kind: 'Included in Pro', tokenUsage: { inputTokens: 10, totalCents: 1 } }), pricing),
    normalize(api.toRawEvent({ model: 'x', kind: 'Errored, Not Charged', tokenUsage: { inputTokens: 10, totalCents: 1 } }), pricing),
    normalize(api.toRawEvent({ model: 'x', kind: 'Included in Pro' }), pricing),
  ];
  const s = summarize(events);
  assert.equal(s.count, 1);
  assert.equal(s.eventCount, 3);
  assert.equal(s.notCounted, 2);
});
test('service.countRequests applies the same rules to raw events', () => {
  const events = [
    api.toRawEvent({ model: 'x', kind: 'Included in Pro', tokenUsage: { inputTokens: 10 } }),
    api.toRawEvent({ model: 'x', kind: 'Errored, Not Charged', tokenUsage: { inputTokens: 10 } }),
    api.toRawEvent({ model: 'x', kind: 'Aborted' }),
    api.toRawEvent({ model: 'x', chargedCents: 4 }),
    api.toRawEvent({ model: 'x' }),
  ];
  assert.equal(service.countRequests(events), 2);
});

console.log('service.quotaFillBar');
test('fills segments proportionally and caps at full', () => {
  assert.equal(service.quotaFillBar(0, 500), '○○○○○');
  assert.equal(service.quotaFillBar(110, 500), '●○○○○');
  assert.equal(service.quotaFillBar(250, 500), '●●◐○○');
  assert.equal(service.quotaFillBar(500, 500), '●●●●●');
  assert.equal(service.quotaFillBar(512, 500), '●●●●●');
});
test('shows a half-filled segment once a segment is at least half used', () => {
  assert.equal(service.quotaFillBar(140, 500), '●○○○○');
  assert.equal(service.quotaFillBar(150, 500), '●◐○○○');
  assert.equal(service.quotaFillBar(490, 500), '●●●●◐');
});
test('supports alternate fill styles', () => {
  assert.equal(service.quotaFillBar(110, 500, 5, 'blocks'), '█░░░░');
  assert.equal(service.quotaFillBar(150, 500, 5, 'blocks'), '█▌░░░');
  assert.equal(service.quotaFillBar(150, 500, 5, 'squares'), '■◧□□□');
  assert.equal(service.quotaFillBar(150, 500, 5, 'bars'), '▮▬▯▯▯');
  assert.equal(service.quotaFillBar(500, 500, 5, 'stars'), '★★★★★');
  assert.equal(service.quotaFillBar(150, 500, 5, 'stars'), '★☆☆☆☆');
  assert.equal(service.quotaFillBar(110, 500, 5, 'none'), '');
});

console.log('service.statusBarText');
test('request-quota plans show used/limit and reset date by default', () => {
  assert.equal(
    service.statusBarText({
      quota: { used: 110, limit: 500, resetIso: '2026-08-01T00:00:00.000Z' },
      costDollars: 42.5,
      onDemandDollars: 0,
      showWhatIfPrefix: false,
    }),
    '110/500 ●○○○○ · Aug 1',
  );
});
test('quota format remaining shows requests left', () => {
  assert.equal(
    service.statusBarText({
      quota: { used: 110, limit: 500, resetIso: '2026-08-01T00:00:00.000Z' },
      costDollars: 42.5,
      onDemandDollars: 0,
      showWhatIfPrefix: false,
      quotaFormat: 'remaining',
    }),
    '390 left ●○○○○ · Aug 1',
  );
});
test('quota exhausted pins at limit/limit, appends on-demand spend and reset', () => {
  assert.equal(
    service.statusBarText({
      quota: { used: 512, limit: 500, resetIso: '2026-08-01T00:00:00.000Z' },
      costDollars: 42.5,
      onDemandDollars: 12.34,
      showWhatIfPrefix: false,
    }),
    '500/500 ●●●●● · $12.34 · Aug 1',
  );
});
test('quota exactly at limit with no on-demand spend yet shows limit/limit and reset', () => {
  assert.equal(
    service.statusBarText({
      quota: { used: 500, limit: 500, resetIso: '2026-08-01T00:00:00.000Z' },
      costDollars: 42.5,
      onDemandDollars: 0,
      showWhatIfPrefix: false,
    }),
    '500/500 ●●●●● · Aug 1',
  );
});
test('no quota limit falls back to cost (with what-if prefix on free plans)', () => {
  assert.equal(
    service.statusBarText({ quota: { used: 5, limit: 0 }, costDollars: 42.5, onDemandDollars: 0, showWhatIfPrefix: false }),
    '$42.50',
  );
  assert.equal(
    service.statusBarText({ quota: null, costDollars: 3.1, onDemandDollars: 0, showWhatIfPrefix: true }),
    '~$3.10',
  );
});

console.log('billingCycleWindow');
test('uses quota cycle start when known', () => {
  const now = new Date('2026-07-05T15:30:00.000Z');
  const { start, end } = service.billingCycleWindow(
    { startOfCycleIso: '2026-06-15T08:00:00.000Z' },
    now,
  );
  const startDate = new Date(start);
  assert.equal(startDate.getFullYear(), 2026);
  assert.equal(startDate.getMonth(), 5); // June
  assert.equal(startDate.getDate(), 15);
  const endDate = new Date(end);
  assert.equal(endDate.getFullYear(), now.getFullYear());
  assert.equal(endDate.getMonth(), now.getMonth());
  assert.equal(endDate.getDate(), now.getDate());
  assert.equal(endDate.getHours(), 23);
  assert.equal(endDate.getMinutes(), 59);
});
test('falls back to calendar month when cycle start is unknown', () => {
  const now = new Date('2026-07-05T15:30:00.000Z');
  const { start } = service.billingCycleWindow(null, now);
  const startDate = new Date(start);
  assert.equal(startDate.getFullYear(), now.getFullYear());
  assert.equal(startDate.getMonth(), now.getMonth());
  assert.equal(startDate.getDate(), 1);
});
test('formatCycleRangeLabel renders a short range', () => {
  const start = new Date(2026, 5, 15); // local Jun 15
  const end = new Date(2026, 6, 5, 23, 59, 59, 999); // local Jul 5
  const label = service.formatCycleRangeLabel(start.getTime(), end.getTime());
  assert.match(label, /Jun 15/);
  assert.match(label, /Jul 5/);
});
test('rollingDayWindow spans N calendar days through today', () => {
  const now = new Date(2026, 6, 5, 15, 30, 0); // local Jul 5
  const { start, end } = service.rollingDayWindow(30, now);
  const startDate = new Date(start);
  const endDate = new Date(end);
  assert.equal(startDate.getDate(), 6); // Jun 6
  assert.equal(startDate.getMonth(), 5);
  assert.equal(endDate.getDate(), 5);
  assert.equal(endDate.getMonth(), 6);
});
test('statusBarWindow picks cycle or rolling days', () => {
  const now = new Date(2026, 6, 5, 15, 30, 0);
  const cycle = service.statusBarWindow('cycle', 30, { startOfCycleIso: '2026-06-15T00:00:00.000Z' }, now);
  assert.equal(new Date(cycle.start).getDate(), 15);
  const days = service.statusBarWindow('days', 7, null, now);
  assert.equal(new Date(days.start).getDate(), 29); // Jun 29
});

console.log('service.parseStatusBarPeriodConfig');
test('cycle mode ignores periodDays', () => {
  assert.deepEqual(service.parseStatusBarPeriodConfig('cycle', 7), { mode: 'cycle', periodDays: 30 });
});
test('days:N embeds the rolling window length', () => {
  assert.deepEqual(service.parseStatusBarPeriodConfig('days:14', 30), { mode: 'days', periodDays: 14 });
  assert.deepEqual(service.parseStatusBarPeriodConfig('days:90', 7), { mode: 'days', periodDays: 90 });
});
test('legacy days mode still reads periodDays', () => {
  assert.deepEqual(service.parseStatusBarPeriodConfig('days', 45), { mode: 'days', periodDays: 45 });
});
test('unknown period mode falls back to cycle', () => {
  assert.deepEqual(service.parseStatusBarPeriodConfig('week', 7), { mode: 'cycle', periodDays: 30 });
});
test('period days are clamped to 1–90', () => {
  assert.deepEqual(service.parseStatusBarPeriodConfig('days', 0), { mode: 'days', periodDays: 1 });
  assert.deepEqual(service.parseStatusBarPeriodConfig('days:120', 30), { mode: 'days', periodDays: 90 });
});

console.log('service.quotaPercentUsed');
test('limit of 0 is treated as unlimited, not a percentage of 0', () => {
  // Regression: this used to crash the status bar with "Cannot read
  // properties of null (reading 'toFixed')" whenever a plan's quota
  // endpoint returned limit: 0 instead of null/undefined.
  assert.equal(service.quotaPercentUsed({ used: 5, limit: 0 }), null);
});
test('missing/negative limit is also unlimited', () => {
  assert.equal(service.quotaPercentUsed({ used: 5, limit: null }), null);
  assert.equal(service.quotaPercentUsed({ used: 5, limit: -1 }), null);
  assert.equal(service.quotaPercentUsed(undefined), null);
  assert.equal(service.quotaPercentUsed(null), null);
});
test('normal limit computes a percentage', () => {
  assert.equal(service.quotaPercentUsed({ used: 250, limit: 500 }), 50);
});
test('usage over the limit is not clamped to 100 — callers need the true % to show "limit reached"', () => {
  assert.equal(service.quotaPercentUsed({ used: 512, limit: 500 }), 102.4);
});

console.log('comparisonWindow / shiftMonths / modelCostDeltas');
{
  const at = (y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) => new Date(y, m - 1, d, hh, mm, ss, ms).getTime();
  const iso = (ms) => new Date(ms).toLocaleDateString('en-CA'); // YYYY-MM-DD, local

  test('"previous" is the equal-length window ending the instant before the range', () => {
    const startMs = at(2026, 8, 13);
    const endMs = at(2026, 8, 13, 23, 59, 59, 999);
    const w = comparisonWindow({ startMs, endMs, mode: 'previous' });
    assert.equal(iso(w.startMs), '2026-08-12');
    assert.equal(iso(w.endMs), '2026-08-12');
    assert.equal(w.endMs, startMs - 1);
  });

  test('"previous" over a week lands on the seven days before it', () => {
    const w = comparisonWindow({
      startMs: at(2026, 8, 7),
      endMs: at(2026, 8, 13, 23, 59, 59, 999),
      mode: 'previous',
    });
    assert.equal(iso(w.startMs), '2026-07-31');
    assert.equal(iso(w.endMs), '2026-08-06');
  });

  test('"prevMonth" keeps the calendar dates, not the length', () => {
    const w = comparisonWindow({
      startMs: at(2026, 3, 1),
      endMs: at(2026, 3, 31, 23, 59, 59, 999),
      mode: 'prevMonth',
    });
    assert.equal(iso(w.startMs), '2026-02-01');
    // Clamped to the last day of February rather than rolling into March.
    assert.equal(iso(w.endMs), '2026-02-28');
  });

  test('shiftMonths clamps the day instead of overflowing into the next month', () => {
    assert.equal(iso(shiftMonths(at(2026, 3, 31), -1)), '2026-02-28');
    assert.equal(iso(shiftMonths(at(2026, 5, 31), -1)), '2026-04-30');
    assert.equal(iso(shiftMonths(at(2026, 8, 15), -1)), '2026-07-15');
  });

  test('"custom" needs both ends, and rejects a backwards range', () => {
    const base = { startMs: at(2026, 8, 1), endMs: at(2026, 8, 13), mode: 'custom' };
    assert.equal(comparisonWindow(base), null);
    assert.equal(comparisonWindow({ ...base, customStartMs: at(2026, 7, 1) }), null);
    assert.equal(
      comparisonWindow({ ...base, customStartMs: at(2026, 7, 10), customEndMs: at(2026, 7, 1) }),
      null,
    );
    const w = comparisonWindow({ ...base, customStartMs: at(2026, 7, 1), customEndMs: at(2026, 7, 10) });
    assert.equal(iso(w.startMs), '2026-07-01');
    assert.equal(iso(w.endMs), '2026-07-10');
  });

  test('an invalid or backwards selected range yields no baseline', () => {
    assert.equal(comparisonWindow({ startMs: NaN, endMs: at(2026, 8, 1), mode: 'previous' }), null);
    assert.equal(comparisonWindow({ startMs: at(2026, 8, 5), endMs: at(2026, 8, 1), mode: 'previous' }), null);
  });

  test('modelCostDeltas sorts by biggest mover, not by biggest spender', () => {
    const rows = modelCostDeltas(
      { sonnet: 14, haiku: 20, gpt: 3 },
      { sonnet: 2, haiku: 19, gpt: 3 },
    );
    assert.equal(rows[0].model, 'sonnet'); // +12 beats haiku's larger total
    assert.equal(rows[0].delta, 12);
    assert.equal(rows[1].model, 'haiku');
    assert.equal(rows[2].delta, 0);
  });

  test('modelCostDeltas keeps models that appear in only one period', () => {
    const rows = modelCostDeltas({ opus: 5 }, { sonnet: 4 });
    const opus = rows.find((r) => r.model === 'opus');
    const sonnet = rows.find((r) => r.model === 'sonnet');
    assert.deepEqual(opus, { model: 'opus', current: 5, baseline: 0, delta: 5 });
    assert.deepEqual(sonnet, { model: 'sonnet', current: 0, baseline: 4, delta: -4 });
  });
}

console.log('sessionTotals / sessionSummary');
{
  const at = (d, h) => Date.UTC(2026, 7, d, h);
  // Mirrors what the API gives us once conversationId survives toRawEvent:
  // a couple of real conversations plus rows carrying no id at all.
  const ev = (conversationId, cost, model, ts, extra = {}) =>
    ({ conversationId, cost, model, timestampMs: ts, ...extra });

  const events = [
    ev('conv-a', 1.5, 'claude-4.5-sonnet', at(3, 9)),
    ev('conv-a', 2.5, 'claude-4.5-sonnet', at(3, 11)),
    ev('conv-a', 1.0, 'gpt-5.2', at(3, 14)),
    ev('conv-b', 0.75, 'composer-2.5', at(4, 10)),
    ev(null, 0.25, 'auto', at(4, 12)),
    ev('', 0.1, 'auto', at(4, 13)), // blank id is absent, not its own session
  ];

  test('rolls requests up per conversation, most expensive first', () => {
    const totals = sessionTotals(events);
    assert.deepEqual(totals.map((t) => t.sessionId), ['conv-a', 'conv-b', UNATTRIBUTED_SESSION]);
    assert.equal(totals[0].requests, 3);
    assert.ok(Math.abs(totals[0].costDollars - 5.0) < 1e-9);
    assert.equal(totals[0].firstMs, at(3, 9));
    assert.equal(totals[0].lastMs, at(3, 14));
  });

  test('a session lists its models, most used first', () => {
    assert.deepEqual(sessionTotals(events)[0].models, ['claude-4.5-sonnet', 'gpt-5.2']);
  });

  test('requests with no conversation id are collected, never dropped', () => {
    const totals = sessionTotals(events);
    const un = totals.find((t) => t.sessionId === UNATTRIBUTED_SESSION);
    // Both the null and the blank id land here — a blank would otherwise become
    // a session of its own, and the totals must still add up to the whole set.
    assert.equal(un.requests, 2);
    assert.equal(totals.reduce((n, t) => n + t.requests, 0), events.length);
    assert.ok(Math.abs(totals.reduce((c, t) => c + t.costDollars, 0) - 6.1) < 1e-9);
  });

  test('errored rows keep their cost but do not count as requests', () => {
    const withError = [...events, ev('conv-b', 0.4, 'composer-2.5', at(4, 15), { counted: false })];
    const b = sessionTotals(withError).find((t) => t.sessionId === 'conv-b');
    assert.equal(b.requests, 1);
    assert.ok(Math.abs(b.costDollars - 1.15) < 1e-9);
  });

  test('sessionSummary reports per-session shape, excluding the unattributed bucket', () => {
    const s = sessionSummary(sessionTotals(events));
    assert.equal(s.sessions, 2);
    assert.equal(s.unattributedRequests, 2);
    assert.ok(Math.abs(s.costPerSession - (5.75 / 2)) < 1e-9);
    assert.equal(s.requestsPerSession, 2);
    assert.equal(s.topSession.sessionId, 'conv-a');
  });

  test('two periods can be compared on session shape', () => {
    // The point of the session view: same spend, very different working style.
    const spread = [
      ev('s1', 1, 'auto', at(1, 9)), ev('s2', 1, 'auto', at(2, 9)),
      ev('s3', 1, 'auto', at(3, 9)), ev('s4', 1, 'auto', at(4, 9)),
    ];
    const concentrated = [
      ev('s9', 1, 'auto', at(1, 9)), ev('s9', 1, 'auto', at(1, 10)),
      ev('s9', 1, 'auto', at(1, 11)), ev('s9', 1, 'auto', at(1, 12)),
    ];
    const a = sessionSummary(sessionTotals(spread));
    const b = sessionSummary(sessionTotals(concentrated));
    assert.equal(a.sessions, 4);
    assert.equal(b.sessions, 1);
    assert.equal(a.costPerSession, 1);
    assert.equal(b.costPerSession, 4);
    assert.equal(b.requestsPerSession, 4);
  });

  test('no events yields an empty summary rather than NaN', () => {
    const s = sessionSummary(sessionTotals([]));
    assert.equal(s.sessions, 0);
    assert.equal(s.costPerSession, null);
    assert.equal(s.requestsPerSession, null);
    assert.equal(s.topSession, null);
  });

  test('a period with only unattributed requests reports no sessions', () => {
    const s = sessionSummary(sessionTotals([ev(null, 2, 'auto', at(1, 9))]));
    assert.equal(s.sessions, 0);
    assert.equal(s.unattributedRequests, 1);
    assert.equal(s.topSession, null);
  });

  test('sessionMetrics reports cost, span and pace', () => {
    const [a] = sessionTotals(events); // conv-a: 3 requests, $5, 09:00 → 14:00
    const m = sessionMetrics(a);
    assert.equal(m.requests, 3);
    assert.ok(Math.abs(m.costPerRequest - 5 / 3) < 1e-9);
    assert.equal(m.durationMs, 5 * 60 * 60 * 1000);
    assert.ok(Math.abs(m.requestsPerHour - 3 / 5) < 1e-9);
    assert.ok(Math.abs(m.costPerHour - 1) < 1e-9);
  });

  test('a session too short to measure reports no rate', () => {
    // One request, or a burst inside a minute: dividing by that span invents a
    // "900 requests/hour" pace that describes the arithmetic, not the work.
    const single = sessionTotals([ev('solo', 0.5, 'auto', at(1, 9))]);
    const m = sessionMetrics(single[0]);
    assert.equal(m.durationMs, 0);
    assert.equal(m.requestsPerHour, null);
    assert.equal(m.costPerHour, null);
    // The per-request figure is still well defined and still worth showing.
    assert.equal(m.costPerRequest, 0.5);
  });

  test('a session whose requests all errored has no per-request cost', () => {
    const errored = sessionTotals([
      ev('bad', 0.3, 'auto', at(1, 9), { counted: false }),
      ev('bad', 0.2, 'auto', at(1, 11), { counted: false }),
    ]);
    const m = sessionMetrics(errored[0]);
    assert.equal(m.requests, 0);
    assert.equal(m.costPerRequest, null); // not 0, and not Infinity
    assert.ok(Math.abs(m.costDollars - 0.5) < 1e-9);
  });

  test('token, savings and error figures roll up per session', () => {
    const tok = (conversationId, extra) =>
      ({ conversationId, cost: 1, model: 'auto', timestampMs: at(1, 9), ...extra });
    const [row] = sessionTotals([
      tok('t', { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 8000, cacheWriteTokens: 800, cacheSavings: 0.4 }),
      tok('t', { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, cacheSavings: null, cost: 3 }),
      tok('t', { inputTokens: 10, outputTokens: 0, cost: 0.5, counted: false }),
    ]);
    assert.equal(row.inputTokens, 1510);
    assert.equal(row.outputTokens, 300);
    assert.equal(row.cacheReadTokens, 8000);
    assert.ok(Math.abs(row.savingsDollars - 0.4) < 1e-9); // a null saving is 0, not NaN
    assert.equal(row.erroredRequests, 1);
    assert.equal(row.requests, 2);
    // The dearest request is the one to open, and an errored row can be it.
    assert.equal(row.maxCostDollars, 3);
  });

  test('cache hit rate is null when no tokens were reported, not 0%', () => {
    const withTokens = sessionTotals([
      { conversationId: 'c', cost: 1, timestampMs: at(1, 9), inputTokens: 1000, cacheReadTokens: 3000 },
    ]);
    assert.equal(sessionMetrics(withTokens[0]).cacheHitRate, 75);

    // An account whose API reports no token counts has an unknown hit rate;
    // "0%" would read as a session that cached nothing at all.
    const noTokens = sessionTotals([{ conversationId: 'c', cost: 1, timestampMs: at(1, 9) }]);
    assert.equal(sessionMetrics(noTokens[0]).cacheHitRate, null);
    assert.equal(sessionMetrics(noTokens[0]).totalTokens, 0);
  });

  test('filterSessions matches on id and on model', () => {
    const totals = sessionTotals(events);
    assert.deepEqual(filterSessions(totals, 'conv-b').map((t) => t.sessionId), ['conv-b']);
    // Nobody types a uuid from memory, so the models are searchable too.
    assert.deepEqual(filterSessions(totals, 'GPT-5').map((t) => t.sessionId), ['conv-a']);
    assert.equal(filterSessions(totals, '   ').length, totals.length);
    assert.equal(filterSessions(totals, 'nothing-matches').length, 0);
  });
}

console.log('projectExhaustionDate (shared usageLogic via logic.js)');
const DAY = 24 * 60 * 60 * 1000;
for (const fn of [projectExhaustionDate]) {
  test('projects a future date at a steady burn rate', () => {
    const now = Date.now();
    const since = now - 10 * DAY;
    // 100 used in 10 days = 10/day; 400 left / 10 per day = 40 days out.
    const result = fn(100, 500, since, now);
    assert.ok(result);
    const daysOut = Math.round((result.getTime() - now) / DAY);
    assert.equal(daysOut, 40);
  });
  test('already exhausted returns "now"', () => {
    const now = Date.now();
    const result = fn(600, 500, now - 10 * DAY, now);
    assert.equal(result.getTime(), now);
  });
  test('no limit, no usage yet, or too little elapsed time returns null', () => {
    const now = Date.now();
    assert.equal(fn(100, null, now - 10 * DAY, now), null);
    assert.equal(fn(0, 500, now - 10 * DAY, now), null);
    assert.equal(fn(5, 500, now - DAY / 4, now), null);
  });
}

// --- sqlite3 CLI reader ---------------------------------------------------
// Exercises the same code path resolveSession() takes when Cursor's state.vscdb
// is too large for sql.js. Skipped automatically when sqlite3 is not on PATH.

const sqliteAvailable = spawnSync('sqlite3', ['-version']).status === 0;
console.log('auth.readValuesViaSqliteCli' + (sqliteAvailable ? '' : ' (skipped: sqlite3 CLI not on PATH)'));

if (sqliteAvailable) {
  const auth = await loadTs('src/auth.ts', 'auth.mjs');
  const tmp = mkdtempSync(path.join(tmpdir(), 'cursor-usage-auth-'));
  const dbFile = path.join(tmp, 'state.vscdb');
  try {
    execFileSync('sqlite3', [
      dbFile,
      'CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);',
      "INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', 'header.payload.sig');",
      "INSERT INTO ItemTable VALUES ('cursorAuth/cachedEmail', 'user@example.com');",
      "INSERT INTO ItemTable VALUES ('other/key', 'ignore-me');",
    ]);

    await test('reads requested keys and ignores others', async () => {
      const values = await auth.readValuesViaSqliteCli(dbFile, [
        'cursorAuth/accessToken',
        'cursorAuth/cachedEmail',
      ]);
      assert.equal(values.get('cursorAuth/accessToken'), 'header.payload.sig');
      assert.equal(values.get('cursorAuth/cachedEmail'), 'user@example.com');
      assert.equal(values.has('other/key'), false);
    });

    await test('missing key resolves to a Map without that entry (not an error)', async () => {
      const values = await auth.readValuesViaSqliteCli(dbFile, ['does/not/exist']);
      assert.equal(values.size, 0);
    });

    await test('rejects with a descriptive error when the DB file is missing', async () => {
      await assert.rejects(
        () => auth.readValuesViaSqliteCli(path.join(tmp, 'missing.vscdb'), ['x']),
        /sqlite3 CLI failed/,
      );
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log('conversationTitles');
{
  const titles = await loadTs('src/shared/conversationTitles.ts', 'conversationTitles.mjs');

  test('reads names out of the composer index', () => {
    const map = titles.parseTitleIndex(new Map([
      ['composer.composerData', JSON.stringify({
        allComposers: [
          { composerId: 'c1', name: 'Fix the budget gauge' },
          { composerId: 'c2', name: '  Refactor  the\tstatus bar  ' },
          { composerId: 'c3' }, // unnamed conversations are skipped, not blanked
          { name: 'no id here' },
        ],
      })],
    ]));
    assert.equal(map.get('c1'), 'Fix the budget gauge');
    // Whitespace is collapsed: a tab or newline in a name would break both the
    // table layout and the line-oriented sqlite output it arrived through.
    assert.equal(map.get('c2'), 'Refactor the status bar');
    assert.equal(map.has('c3'), false);
    assert.equal(map.size, 2);
  });

  test('reads names out of the older chat-tab index', () => {
    const map = titles.parseTitleIndex(new Map([
      ['workbench.panel.aichat.view.aichat.chatdata', JSON.stringify({
        tabs: [{ tabId: 't1', chatTitle: 'Why is Auto so expensive' }],
      })],
    ]));
    assert.equal(map.get('t1'), 'Why is Auto so expensive');
  });

  test('an unparseable or unexpected row yields no names rather than throwing', () => {
    // These shapes are undocumented and change between Cursor versions, so the
    // failure mode has to be "sessions keep their ids", never a broken tab.
    assert.equal(titles.parseTitleIndex(new Map([['composer.composerData', 'not json']])).size, 0);
    assert.equal(titles.parseTitleIndex(new Map([['composer.composerData', '{"allComposers":"nope"}']])).size, 0);
    assert.equal(titles.parseTitleIndex(new Map([['composer.composerData', '']])).size, 0);
    assert.equal(titles.parseTitleIndex([]).size, 0);
  });

  test('a name longer than the cap is truncated', () => {
    const long = 'x'.repeat(500);
    const map = titles.parseTitleIndex(new Map([
      ['composer.composerData', JSON.stringify({ allComposers: [{ composerId: 'c', name: long }] })],
    ]));
    assert.equal(map.get('c').length, titles.MAX_TITLE_LENGTH);
    assert.ok(map.get('c').endsWith('…'));
  });

  test('per-conversation rows are keyed back to their id', () => {
    const map = titles.parseComposerNames([
      { key: 'composerData:abc-123', name: 'Session comparison POC' },
      { key: 'composerData:def', name: null }, // json_extract found no name
      { key: 'somethingElse:xyz', name: 'not a conversation row' },
    ]);
    assert.equal(map.get('abc-123'), 'Session comparison POC');
    assert.equal(map.size, 1);
  });

  test('composerRowKey builds the key the rows are stored under', () => {
    assert.equal(titles.composerRowKey('abc'), 'composerData:abc');
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
