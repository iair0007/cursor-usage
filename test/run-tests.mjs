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
  describeDiscountRun,
  describePricingScrape,
  detectDiscounts,
  discountImpact,
  discountPeriods,
  resolveDiscount,
  manualDiscountFor,
  applyDiscountToRates,
  modelsMissingDiscountInfo,
  normalizeDiscountEntry,
  detectedDiscountDays,
  autoRouting,
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
  sortSessions,
  UNATTRIBUTED_SESSION,
} = await loadTs('src/webview/logic.js', 'logic.mjs');

let passed = 0;
let failed = 0;
// Every async test's promise, so the summary cannot be printed — and the exit
// code decided — while one is still running. An async test whose `test(...)`
// call was not awaited used to settle after `process.exit(1)` had already been
// skipped, so a failure inside it left CI green.
const running = [];
function test(name, fn) {
  try {
    const maybe = fn();
    if (maybe && typeof maybe.then === 'function') {
      const settled = maybe.then(
        () => {
          passed++;
          console.log(`  ✓ ${name}`);
        },
        (e) => {
          failed++;
          console.error(`  ✗ ${name}\n    ${e.message}`);
        },
      );
      running.push(settled);
      return settled;
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
console.log('discountImpact (what the promotion did to the bill)');
function impactEvent(i, model, list, billed, day = '2026-08-13') {
  return {
    timestampMs: new Date(`${day}T1${i % 9}:00:00`).getTime(),
    modelRaw: model,
    listTokenCost: list,
    billedTokenCost: billed,
    cost: billed,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  };
}
test('it measures the money the promotion actually took off', () => {
  const events = [
    impactEvent(0, 'cursor-grok-4.6-high', 0.86, 0.39),
    impactEvent(1, 'cursor-grok-4.6-high', 0.52, 0.24),
  ];
  const detected = detectDiscounts(events, pricing);
  const impact = discountImpact(events, detected);
  assert.equal(impact.requests, 2);
  assert.ok(Math.abs(impact.savedDollars - 0.75) < 1e-9, '(0.86-0.39) + (0.52-0.24)');
  assert.equal(impact.models[0].label, 'cursor-grok-4.6-high');
  assert.deepEqual(impact.days, ['2026-08-13']);
});
test('it counts what ran on other models the same days', () => {
  const events = [
    impactEvent(0, 'cursor-grok-4.6-high', 0.86, 0.39),
    impactEvent(1, 'cursor-grok-4.6-high', 0.52, 0.24),
    impactEvent(2, 'claude-sonnet-5', 0.5, 0.5),
    // A different day entirely — not an alternative to that day's promotion.
    impactEvent(3, 'claude-sonnet-5', 0.9, 0.9, '2026-08-20'),
  ];
  const impact = discountImpact(events, detectDiscounts(events, pricing));
  assert.equal(impact.otherRequests, 1, 'only the same-day one');
  assert.ok(Math.abs(impact.otherDollars - 0.5) < 1e-9);
});
test('no promotion means nothing to report, not a zero-dollar one', () => {
  const events = [0, 1, 2].map((i) => impactEvent(i, 'cursor-grok-4.6-high', 0.5, 0.5));
  const impact = discountImpact(events, detectDiscounts(events, pricing));
  assert.deepEqual(impact.models, []);
  assert.equal(impact.savedDollars, 0);
  assert.equal(impact.otherDollars, 0, 'no discounted day, so nothing is an alternative to it');
});
test('a discounted request missing either figure still counts, without inventing dollars', () => {
  const events = [
    impactEvent(0, 'cursor-grok-4.6-high', 0.86, 0.39),
    { ...impactEvent(1, 'cursor-grok-4.6-high', 0.52, 0.24), listTokenCost: null, billedTokenCost: null },
  ];
  // The second is measured off the first's model-day, so it is discounted too.
  const impact = discountImpact(events, detectDiscounts([events[0]], pricing));
  assert.equal(impact.requests, 2);
  assert.ok(Math.abs(impact.savedDollars - 0.47) < 1e-9, 'only the request that carried both figures');
});

console.log('displayModel and Cursor Router routing');
test('a routed row names the model and the mode it was billed under', () => {
  // Balance and Intelligence bill at the routed model's rate, so which model
  // it was is the difference between two very different prices.
  assert.equal(displayModel('Cursor Grok 4.5 (Auto Balanced)'), 'Auto Balance → Grok 4.5');
  assert.equal(displayModel('Cursor Claude Opus 5 (Auto Intelligence)'), 'Auto Intelligence → Claude Opus 5');
  assert.equal(displayModel('Cursor Grok 4.5 (Auto Cost)'), 'Auto Cost → Grok 4.5');
});
test('bare Auto still reads as Auto — Cursor named nothing to show', () => {
  assert.equal(displayModel('auto'), 'Auto');
  assert.equal(displayModel('default'), 'Auto');
  assert.equal(displayModel(''), 'Auto');
});
test('a plain model name is left exactly as Cursor billed it', () => {
  assert.equal(displayModel('cursor-grok-4.6-high'), 'cursor-grok-4.6-high');
  assert.equal(displayModel('claude-sonnet-5-thinking-medium'), 'claude-sonnet-5-thinking-medium');
});
test('autoRouting reports the parts, and nothing for a non-routed name', () => {
  assert.deepEqual(autoRouting('Cursor Grok 4.5 (Auto Balanced)'), { model: 'Grok 4.5', mode: 'Balance' });
  assert.equal(autoRouting('cursor-grok-4.6-high'), null);
  assert.equal(autoRouting('auto'), null);
});

console.log('parsePricing: Auto published as a table row');
// cursor.com moved Auto's bundled rate out of a "### Auto pricing" label list
// and into an ordinary pricing table under "Auto modes".
const AUTO_ROW_DOC = `
## Models and pricing

### Auto modes

| Name | Input | Cache Write | Cache Read | Output |
| :--- | :--- | :--- | :--- | :--- |
| ![icon](https://cursor.com/i.svg) Auto Cost | $1.25 | $1.25 | $0.25 | $6 |

### Model pricing

| Model | Context | Input | Cache write | Cache read | Output |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Grok 4.5 | 200k | $2.00 | - | $0.50 | $6.00 |
`;
const autoRowPricing = parsePricing(AUTO_ROW_DOC);
test('the Auto Cost row becomes the Auto rate', () => {
  // Left unread, plain "auto"/"default" requests had no rates at all — and so
  // no cache-savings figure, on the mode most requests actually run in.
  assert.ok(!autoRowPricing.fallback, 'parsed from the page, not the bundled catalog');
  assert.deepEqual(autoRowPricing.auto, { input: 1.25, cacheWrite: 1.25, cacheRead: 0.25, output: 6 });
  assert.equal(matchPricing('default', autoRowPricing).label, 'Auto');
  assert.equal(matchPricing('auto', autoRowPricing).cacheWritePublished, true);
});
test('the router modes still split correctly on the new page shape', () => {
  assert.equal(matchPricing('Cursor Grok 4.5 (Auto Balanced)', autoRowPricing).label, 'Grok 4.5');
  assert.equal(matchPricing('Cursor Grok 4.5 (Auto Cost)', autoRowPricing).label, 'Auto');
});
test('the older "### Auto pricing" list is still understood', () => {
  assert.equal(pricing.auto.input, 1.25);
  assert.equal(matchPricing('default', pricing).label, 'Auto');
});

console.log('matchPricing and Cursor Router modes');
test('a Balance/Intelligence row prices at the model the router picked', () => {
  // Those modes bill at the routed model's own rate — which is why Cursor
  // names it in the row. Pricing it at Auto's bundled rate understates a
  // routed Grok request by roughly half.
  const r = matchPricing('Cursor Grok 4.5 (Auto Balanced)', pricing);
  assert.equal(r.label, 'Grok 4.5');
});
test('a Cost-mode row keeps Auto\'s bundled rate even though a model is named', () => {
  // Cost mode is the one that keeps bundled Auto pricing whatever it routes to.
  const r = matchPricing('Cursor Grok 4.5 (Auto Cost)', pricing);
  assert.equal(r.label, 'Auto');
});
test('bare Auto and default still price as Auto', () => {
  assert.equal(matchPricing('auto', pricing).label, 'Auto');
  assert.equal(matchPricing('default', pricing).label, 'Auto');
});
test('a Fast variant reaches the Fast row despite an interleaved word', () => {
  // "grok-4-6-fast" is not a substring of "cursor-grok-4-6-high-fast".
  assert.equal(matchPricing('cursor-grok-4.6-high-fast', pricing).label, 'Grok 4.6 (Fast)');
  assert.equal(matchPricing('cursor-grok-4.6-high', pricing).label, 'Grok 4.6');
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
// Auto is priced from its own published row, which is the comparison of like
// with like — the rate a request billed as Auto is actually charged at.
const AUTO_LIST = estimateTokenCost(matchPricing('auto', pricing), GROK_TOKENS);

test('paying exactly the published Auto rate is no discount', () => {
  const autos = [0, 1, 2, 3].map((i) => (
    { ...grokEvent(i, 1), modelRaw: 'auto', modelTokenCost: AUTO_LIST, listTokenCost: null, billedTokenCost: null }));
  const { discounts, observed } = detectDiscounts(autos, pricing);
  assert.deepEqual(discounts, {}, 'the Auto bundle being cheaper than a frontier model is not a sale');
  assert.ok(observed.has('auto|2026-08-13'), 'measured, and the answer was "no sale"');
});

test('a real promotion on Auto is still found, against Auto\'s own rate', () => {
  const autos = [0, 1, 2, 3].map((i) => (
    { ...grokEvent(i, 1), modelRaw: 'auto', modelTokenCost: AUTO_LIST * 0.5, listTokenCost: null, billedTokenCost: null }));
  assert.equal(detectDiscounts(autos, pricing).discounts.auto['2026-08-13'].pct, 50);
});
// An enterprise agreement is a standing reduction on every request, reported
// on the event as enterpriseUsageDiscountPercent while totalCents stays at
// list. Measured against list it looks like a permanent sale on every model.
const entEvent = (i, billedFraction, pct) => ({
  id: `x${i}`,
  timestampMs: new Date(`2026-08-12T1${i}:00:00`).getTime(),
  modelRaw: 'cursor-grok-4.6-high',
  listTokenCost: 1,
  billedTokenCost: billedFraction,
  baselineDiscountPct: pct,
  inputTokens: 5000, outputTokens: 900, cacheReadTokens: 400_000, cacheWriteTokens: 0,
});

test("a standing enterprise reduction is the account's price, not a sale", () => {
  // Paying exactly the agreement and nothing more: no promotion to report.
  const { discounts, observed } = detectDiscounts([0, 1, 2, 3].map((i) => entEvent(i, 0.93, 7)), pricing);
  assert.deepEqual(discounts, {});
  assert.ok(observed.has('cursor-grok-4-6-high|2026-08-12'), 'measured, and the answer was "no sale"');
});

test('a sale on top of an agreement is reported at its own size', () => {
  // A 50% sale billed on a 7% account lands at 0.5 x 0.93 of list. Measured
  // against list that reads 53.5%; against what the account actually pays, 50%.
  const { discounts } = detectDiscounts([0, 1, 2, 3].map((i) => entEvent(i, 0.5 * 0.93, 7)), pricing);
  assert.equal(discounts['cursor-grok-4-6-high']['2026-08-12'].pct, 50);
});

test('an account with no agreement is measured exactly as before', () => {
  const { discounts } = detectDiscounts([0, 1, 2, 3].map((i) => entEvent(i, 0.5, 0)), pricing);
  assert.equal(discounts['cursor-grok-4-6-high']['2026-08-12'].pct, 50);
});

test('a nonsense agreement percentage is ignored rather than trusted', () => {
  for (const pct of [100, 120, -5, NaN, null]) {
    const { discounts } = detectDiscounts([0, 1, 2, 3].map((i) => entEvent(i, 0.5, pct)), pricing);
    assert.equal(discounts['cursor-grok-4-6-high']?.['2026-08-12']?.pct, 50,
      `baseline ${pct} must not scale anything`);
  }
});

test('the agreement percentage is read from the event Cursor sends', () => {
  const api = readFileSync(path.join(here, '..', 'src/api.ts'), 'utf8');
  assert.match(api, /enterpriseUsageDiscountPercent/);
  const logic = readFileSync(path.join(here, '..', 'src/webview/logic.js'), 'utf8');
  assert.match(logic, /baselineDiscountPct/);
});

test('a Balance-routed row is measured — Cursor named the model it billed at', () => {
  // The opposite case to bare Auto: "(Auto Balanced)" means the request was
  // billed at the named model's own rate, and matchPricing resolves it to that
  // catalog row. Skipping it on the word "auto" left every routed request
  // permanently undetectable wherever tokenUsage.totalCents is absent.
  const routed = [0, 1, 2, 3].map((i) => (
    { ...grokEvent(i, 0.5), modelRaw: 'Cursor Grok 4.6 High (Auto Balanced)' }));
  const { discounts } = detectDiscounts(routed, pricing);
  assert.equal(discounts['cursor-grok-4-6-high-auto-balanced']['2026-08-13'].pct, 50);
});
test('a Balance-routed row at list price is reported as no discount, not as unknown', () => {
  const routed = [0, 1, 2, 3].map((i) => (
    { ...grokEvent(i, 1), modelRaw: 'Cursor Grok 4.6 High (Auto Balanced)' }));
  const { discounts, observed } = detectDiscounts(routed, pricing);
  assert.deepEqual(discounts, {});
  assert.ok(observed.has('cursor-grok-4-6-high-auto-balanced|2026-08-13'));
});
// Grok publishes no cache-write rate, so a request carrying cache writes has
// two defensible prices: writes at the input rate (what estimateTokenCost
// substitutes) and writes free. These fixtures name the billed figure outright,
// since LIST_COST only covers the other tokens.
//   40k writes → $0.28 with writes substituted, $0.20 with writes free.
const WRITE_TOKENS = { ...GROK_TOKENS, cacheWrite: 40_000 };
//   400k writes swamp the rest → $0.82 substituted, $0.02 free.
const WRITE_HEAVY_TOKENS = { input: 5_000, output: 1_000, cacheRead: 8_000, cacheWrite: 400_000 };
function grokWriteEvent(i, billed, tokens, day = '2026-08-13') {
  return { ...grokEvent(i, 1, day, tokens), modelTokenCost: billed };
}

test('an unpriced cache write is bounded, not skipped — Grok stays detectable', () => {
  // Half of $0.28. Skipping these outright, as this once did, meant Grok and
  // Composer could never reach minSamples: their requests always carry writes.
  const withWrites = [0, 1, 2, 3].map((i) => grokWriteEvent(i, 0.14, WRITE_TOKENS));
  const { discounts } = detectDiscounts(withWrites, pricing);
  assert.equal(discounts['cursor-grok-4-6-high']['2026-08-13'].pct, 50);
});
test('a free cache write is not mistaken for a promotion', () => {
  // Billed $0.20: list price if writes are free, a 28.6% "gap" against the
  // substitution. Pricing writes at zero closes the gap, so this is unprovable.
  const freeWrites = [0, 1, 2, 3].map((i) => grokWriteEvent(i, 0.2, WRITE_TOKENS));
  const { discounts, observed } = detectDiscounts(freeWrites, pricing);
  assert.deepEqual(discounts, {});
  assert.equal(observed.size, 0, 'inconclusive is "unknown", not "no discount"');
});
test('the reported figure prices writes at the documented rate, not the floor', () => {
  // $0.10 is half the free-writes price and 64% off the substituted one, so no
  // cache-write rate explains it away and the floor lets it through. The number
  // shown is the substituted one — the floor decides whether to claim a
  // discount at all, it does not water down the discount that is claimed.
  const events = [0, 1, 2, 3].map((i) => grokWriteEvent(i, 0.1, WRITE_TOKENS));
  assert.equal(detectDiscounts(events, pricing).discounts['cursor-grok-4-6-high']['2026-08-13'].pct, 65);
});
test('writes too dominant to bound leave the day unknown', () => {
  // Half of $0.82 — but with writes free the day was billed 20x list, so the
  // gap could be the substitution alone. The Simulator should still offer to
  // record this promotion by hand.
  const events = [0, 1, 2, 3].map((i) => grokWriteEvent(i, 0.41, WRITE_HEAVY_TOKENS));
  const { discounts, observed } = detectDiscounts(events, pricing);
  assert.deepEqual(discounts, {});
  assert.equal(observed.size, 0);
});
test('an unpublished write premium reads as no discount, never as a fake one', () => {
  // Writes billed at 1.25x input (OpenAI's post-GPT-5.6 shape) without a
  // published column: $0.30 against a $0.28 estimate, so the error is a missed
  // promotion rather than an invented one.
  const events = [0, 1, 2, 3].map((i) => grokWriteEvent(i, 0.3, WRITE_TOKENS));
  const { discounts, observed } = detectDiscounts(events, pricing);
  assert.deepEqual(discounts, {});
  assert.ok(observed.has('cursor-grok-4-6-high|2026-08-13'), 'billed above list settles the question');
});
test('a published cache-write rate is used as-is — the floor only guards substitutions', () => {
  const rates = matchPricing('claude-4.5-sonnet', pricing);
  assert.ok(rates.cacheWritePublished, 'fixture publishes a cache-write rate for Sonnet');
  const tokens = { input: 50_000, output: 10_000, cacheRead: 80_000, cacheWrite: 400_000 };
  const list = estimateTokenCost(rates, tokens);
  const events = [0, 1, 2, 3].map((i) => ({
    ...grokWriteEvent(i, list * 0.5, tokens),
    modelRaw: 'claude-4.5-sonnet',
  }));
  const { discounts } = detectDiscounts(events, pricing);
  assert.equal(discounts['claude-4-5-sonnet']['2026-08-13'].pct, 50, 'writes dominate yet the rate is known');
});
// Cursor reports both figures for a request, so the discount is arithmetic
// rather than inference. `list` is the value at list price, `billed` what was
// actually taken.
function exactEvent(i, list, billed, day = '2026-08-13', model = 'cursor-grok-4.6-high') {
  return {
    id: `x${i}`,
    timestampMs: new Date(`${day}T1${i % 9}:00:00`).getTime(),
    modelRaw: model,
    listTokenCost: list,
    billedTokenCost: billed,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  };
}
test('one measured request is enough — there is no estimate to average out', () => {
  const { discounts, diagnostics } = detectDiscounts([exactEvent(0, 0.86, 0.39)], pricing);
  assert.equal(discounts['cursor-grok-4-6-high']['2026-08-13'].pct, 55);
  assert.equal(diagnostics.days[0].samples, 1);
});
test('a measured figure is reported as measured, not snapped to a round sale', () => {
  // 53.5% is what this account paid against list. Snapping it to "55% off"
  // asserts a promotion nobody announced, and 50% was the headline that week —
  // so the nudge moved it away from the truth in both directions at once.
  const { discounts } = detectDiscounts([exactEvent(0, 0.86, 0.4)], pricing);
  const d = discounts['cursor-grok-4-6-high']['2026-08-13'];
  assert.equal(d.pct, 53, 'the measurement, rounded to a whole point');
  assert.equal(d.measured, true);
});
test('an inferred figure is still snapped — there the round number is the point', () => {
  const inferred = [0, 1, 2, 3].map((i) => grokEvent(i, 0.512));
  const d = detectDiscounts(inferred, pricing).discounts['cursor-grok-4-6-high']['2026-08-13'];
  assert.equal(d.pct, 50, '48.8% off a noisy estimate is a 50% sale');
  assert.equal(d.measured, false);
});
test('a request small enough for cent-rounding to matter still needs corroboration', () => {
  // At 3c, half a cent is 17% — far more than the gap being claimed.
  const { discounts } = detectDiscounts([exactEvent(0, 0.03, 0.014)], pricing);
  assert.deepEqual(discounts, {}, 'one tiny request proves nothing');
  const many = [0, 1, 2].map((i) => exactEvent(i, 0.03, 0.014));
  assert.equal(many.length, 3);
  assert.ok(detectDiscounts(many, pricing).discounts['cursor-grok-4-6-high'], 'three of them do');
});
test('paying exactly the list value is no discount', () => {
  const { discounts, observed } = detectDiscounts([exactEvent(0, 0.86, 0.86)], pricing);
  assert.deepEqual(discounts, {});
  assert.ok(observed.has('cursor-grok-4-6-high|2026-08-13'), 'measured, and the answer was no');
});
test("Auto's own two figures are not comparable, so they are not compared", () => {
  // For bare Auto they describe different rate cards: totalCents is what the
  // tokens are worth on whatever model Auto routed to, while the charge follows
  // Auto's flat rate "regardless of which model is used". Their gap is the Auto
  // bundle's structural saving, and reading it as a sale badged Auto
  // "Discounted" every day at a different percentage.
  const { discounts } = detectDiscounts(
    [0, 1, 2, 3].map((i) => exactEvent(i, 0.5, 0.25, '2026-08-13', 'auto')),
    pricing,
  );
  assert.deepEqual(discounts, {}, 'a routed-model list value proves nothing about Auto');
});
test('the measured figure wins over anything the rate table would have said', () => {
  // Rates here would price these tokens at nothing like $0.86, and it does not
  // matter: the comparison never consults them.
  const e = { ...exactEvent(0, 0.86, 0.39), inputTokens: 999_999, outputTokens: 999_999 };
  assert.equal(detectDiscounts([e], pricing).discounts['cursor-grok-4-6-high']['2026-08-13'].pct, 55);
});
test('a promotion found on a billed variant reaches the catalog row', () => {
  // Detection keys on what Cursor billed ("cursor-grok-4.6-high"); the
  // Simulator asks by catalog row ("Grok 4.6"). Same model, one published
  // rate — so the discount showed in the chips and on the request's own row,
  // and was missing from the estimate for the very model it was found on.
  const detected = detectDiscounts([exactEvent(0, 0.86, 0.39)], pricing);
  assert.equal(detected.discounts['cursor-grok-4-6-high']['2026-08-13'].row, 'grok-4-6');
  const ctx = { detected, manual: [] };
  assert.equal(resolveDiscount('grok-4-6', '2026-08-13', ctx).pct, 55);
  assert.equal(resolveDiscount('Grok 4.6', '2026-08-13', ctx).pct, 55);
  assert.deepEqual(detectedDiscountDays(detected, 'grok-4-6'), ['2026-08-13']);
});
test('a variant on a different published row does not borrow the discount', () => {
  // Fast is its own row at its own rate; a promotion on the standard model is
  // not evidence of one on Fast.
  const detected = detectDiscounts([exactEvent(0, 0.86, 0.39)], pricing);
  const ctx = { detected, manual: [] };
  assert.equal(resolveDiscount('grok-4-6-fast', '2026-08-13', ctx), null);
  assert.deepEqual(detectedDiscountDays(detected, 'grok-4-6-fast'), []);
});
test('diagnostics name the reason a request could not be measured', () => {
  const noValue = [0, 1, 2, 3].map((i) => ({ ...grokEvent(i, 0.5), modelTokenCost: null }));
  const { diagnostics } = detectDiscounts(noValue, pricing);
  assert.equal(diagnostics.considered, 0);
  assert.deepEqual(diagnostics.skipped, { 'no per-request token value (cursor-grok-4-6-high)': 4 });
  const text = describeDiscountRun(detectDiscounts(noValue, pricing), noValue.length);
  assert.match(text, /0 measurable/);
  assert.match(text, /no per-request token value/);
});
test('diagnostics record the verdict for a day that was measured', () => {
  const { diagnostics } = detectDiscounts(halfPriceDay, pricing);
  assert.equal(diagnostics.considered, 4);
  assert.deepEqual(diagnostics.days, [{
    model: 'cursor-grok-4-6-high', day: '2026-08-13', samples: 4, pct: 50,
    verdict: 'discount 50% (inferred from the rate table, snapped to the nearest round sale)',
  }]);
});
test('diagnostics separate "no discount" from "too few to tell"', () => {
  const listPrice = detectDiscounts([0, 1, 2, 3].map((i) => grokEvent(i, 1)), pricing);
  assert.match(listPrice.diagnostics.days[0].verdict, /no discount/);
  const tooFew = detectDiscounts([grokEvent(0, 0.5)], pricing);
  assert.match(tooFew.diagnostics.days[0].verdict, /too few samples/);
});
test('the log line carries no ids, emails or prompt text — only models and counts', () => {
  const withIds = halfPriceDay.map((e, i) => ({
    ...e, conversationId: `conv_secret_${i}`, email: 'someone@example.com',
  }));
  const text = describeDiscountRun(detectDiscounts(withIds, pricing), withIds.length);
  assert.ok(!text.includes('conv_secret'), 'no conversation ids');
  assert.ok(!text.includes('@'), 'no email addresses');
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
test('list and billed token value are kept apart — their gap is the discount', () => {
  // totalCents is what Cursor says the tokens are worth at list; chargedCents
  // is what it took. Conflating them is what made a live promotion invisible:
  // comparing the list figure against the list rate table always reads ~0%.
  const e = normalize(tokenBasedRaw, pricing);
  assert.equal(e.listTokenCost, 1.0, 'totalCents 100');
  assert.equal(e.billedTokenCost, 1.2, 'chargedCents 123 less the 3c token fee');
  assert.equal(e.modelTokenCost, 1.2, 'prefers what was actually charged');
});
test('billed token value is null where the charge is not about tokens', () => {
  // A flat per-request fee has nothing to do with the tokens, so comparing it
  // against a rate table would read as a near-total discount on every request.
  assert.equal(normalize(usageBasedRaw, pricing).billedTokenCost, null);
});
test('list token value is null when Cursor omits it', () => {
  const { totalCents, ...noTotal } = tokenBasedRaw.tokenUsage;
  const e = normalize({ ...tokenBasedRaw, tokenUsage: noTotal }, pricing);
  assert.equal(e.listTokenCost, null);
  assert.equal(e.modelTokenCost, 1.2, 'still measurable against the rate table');
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
test('session names reach the request log whatever view is on screen', () => {
  // Switching to Requests only unhides the table; it does not rebuild it. The
  // first lookup lands while the user is still on the Overview, so a re-render
  // gated on the current view left the column showing raw ids.
  const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');
  const fn = main.match(/async function loadSessionTitles\(ids\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
  assert.ok(fn, 'expected loadSessionTitles');
  const redraw = fn.slice(fn.indexOf('if (!learned) return;'));
  const table = redraw.match(/.*renderTable\(.*/)?.[0] || '';
  assert.ok(table, 'a learned name must redraw the request log');
  assert.ok(!/state\.appView/.test(table), 'the redraw must not depend on which view is visible');
});

test('opening a session does not also pick it for comparison', () => {
  // The session name became a link into the session view, inside a row whose
  // own click handler toggles the comparison selection — so one click did both.
  const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');
  const handler = main.match(/\$\('sessionsList'\)\?\.addEventListener\('click'[\s\S]*?\n {2}\}\);/)?.[0] || '';
  assert.ok(handler, 'expected the delegated sessions-list click handler');
  const guard = handler.indexOf('.session-open');
  const toggle = handler.indexOf('toggleSessionSelected');
  assert.ok(guard > -1 && guard < toggle, 'the name link must bail out before the row toggle runs');
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

console.log('service.describeBillingFieldCoverage (the log that explains a silent detector)');
const coverageEvents = [
  { model: 'cursor-grok-4.6-high', chargedCents: 30, isTokenBasedCall: true, tokenUsage: {} },
  { model: 'cursor-grok-4.6-high', chargedCents: 39, isTokenBasedCall: true, tokenUsage: {} },
  { model: 'Auto', chargedCents: 8, isTokenBasedCall: true, tokenUsage: { totalCents: 8 } },
];
test('it counts the field detection depends on, per model', () => {
  const text = service.describeBillingFieldCoverage(coverageEvents);
  assert.match(text, /tokenUsage\.totalCents on 1/);
  assert.match(text, /cursor-grok-4\.6-high: 2 request\(s\), totalCents on 0/);
});
test('it calls out an account where the field is missing everywhere', () => {
  const none = coverageEvents.map((e) => ({ ...e, tokenUsage: {} }));
  assert.match(service.describeBillingFieldCoverage(none), /No row carries tokenUsage\.totalCents/);
  assert.doesNotMatch(service.describeBillingFieldCoverage(coverageEvents), /No row carries/);
});
test('it says nothing rather than throwing on an empty range', () => {
  assert.match(service.describeBillingFieldCoverage([]), /no events/);
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

  test('sortSessions orders by each column, both ways', () => {
    const totals = sessionTotals(events); // conv-a $5.00/3req, conv-b $0.75/1req
    const ids = (key, dir) => sortSessions(totals, key, dir).map((t) => t.sessionId);
    assert.deepEqual(ids('cost', 'desc'), ['conv-a', 'conv-b', UNATTRIBUTED_SESSION]);
    assert.deepEqual(ids('cost', 'asc'), [UNATTRIBUTED_SESSION, 'conv-b', 'conv-a']);
    assert.deepEqual(ids('requests', 'desc')[0], 'conv-a');
    // conv-a ran on the 3rd, conv-b and the unattributed rows on the 4th.
    assert.equal(ids('started', 'asc')[0], 'conv-a');
    assert.equal(ids('duration', 'desc')[0], 'conv-a');
    assert.equal(sortSessions(totals, 'cost', 'desc').length, totals.length);
  });

  test('sorting by name uses the name where there is one, the id where there is not', () => {
    // The list never shows the unattributed bucket, so neither does the sort.
    const totals = sessionTotals(events).filter((t) => t.sessionId !== UNATTRIBUTED_SESSION);
    const named = { 'conv-b': 'Aardvark refactor' };
    const byName = sortSessions(totals, 'name', 'asc', (id) => named[id]).map((t) => t.sessionId);
    // "Aardvark…" sorts ahead of "conv-a" — the named row is ordered by its
    // name, not herded to one end of the list.
    assert.deepEqual(byName, ['conv-b', 'conv-a']);
    // And reversing it is a straight reversal, not "unnamed last" again.
    assert.deepEqual(
      sortSessions(totals, 'name', 'desc', (id) => named[id]).map((t) => t.sessionId),
      ['conv-a', 'conv-b'],
    );
  });

  test('sortSessions leaves the input untouched and ties break stably', () => {
    const totals = sessionTotals(events);
    const before = totals.map((t) => t.sessionId);
    sortSessions(totals, 'name', 'asc');
    assert.deepEqual(totals.map((t) => t.sessionId), before);

    // Same request count, different cost: the cost tie-break decides, so the
    // order doesn't shuffle between renders.
    const tied = sessionTotals([
      ev('cheap', 1, 'auto', at(1, 9)),
      ev('dear', 5, 'auto', at(1, 9)),
    ]);
    assert.deepEqual(sortSessions(tied, 'requests', 'desc').map((t) => t.sessionId), ['dear', 'cheap']);
    assert.deepEqual(sortSessions(tied, 'requests', 'asc').map((t) => t.sessionId), ['dear', 'cheap']);
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

console.log('insights (advice derived from token counts alone)');
{
  const ins = await loadTs('src/webview/insights.js', 'insights.mjs');
  const RATES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, label: 'Sonnet' };
  const ratesFor = () => RATES;
  const HOUR = 60 * 60 * 1000;

  // Shapes taken from a real export: a long agent session whose cost is almost
  // entirely re-read context, a five-hour gap before the dearest request, and
  // Cursor's own compaction calls.
  const ev = (o) => ({
    id: o.id,
    timestampMs: o.t,
    modelRaw: 'claude-sonnet-5-thinking-high',
    conversationId: o.s,
    cost: o.cost,
    inputTokens: o.in ?? 0,
    outputTokens: o.out ?? 0,
    cacheReadTokens: o.cr ?? 0,
    cacheWriteTokens: o.cw ?? 0,
    totalTokens: (o.in ?? 0) + (o.out ?? 0) + (o.cr ?? 0) + (o.cw ?? 0),
  });

  test('costBreakdown splits a request into what it was actually made of', () => {
    const b = ins.costBreakdown(ev({ id: 'a', t: 0, s: 's', cost: 3.55, in: 17761, out: 21016, cr: 7379479, cw: 259267 }), RATES);
    // Cache read dominates; output — the answer itself — is a rounding error.
    assert.ok(b.cacheRead > b.cacheWrite && b.cacheWrite > b.output && b.output > b.input);
    assert.ok(Math.abs(b.cacheRead / b.total - 0.62) < 0.02);
    assert.ok(ins.contextShare(b) > 0.85);
  });

  test('the parts always add up to the cost shown beside them', () => {
    // A discounted request costs less than list rates predict; the breakdown
    // rescales rather than printing parts that sum to the wrong total.
    const e = ev({ id: 'a', t: 0, s: 's', cost: 1.0, in: 10000, out: 10000, cr: 1000000, cw: 100000 });
    const b = ins.costBreakdown(e, RATES);
    assert.ok(Math.abs((b.input + b.output + b.cacheRead + b.cacheWrite) - 1.0) < 1e-9);
    assert.equal(b.scaled, true);
  });

  test('a compaction is not a cold start', () => {
    // Cursor summarising the thread: everything in, a summary out, nothing cached.
    const compaction = ev({ id: 'c', t: 0, s: 's', cost: 0.077, in: 165817, out: 2786 });
    assert.equal(ins.classifyRequest(compaction), 'compaction');
    // A real cold start caches the prefix it just established.
    const cold = ev({ id: 'k', t: 0, s: 's', cost: 0.1, in: 35000, out: 500, cw: 35000 });
    assert.equal(ins.classifyRequest(cold), 'coldStart');
    assert.equal(ins.classifyRequest(ev({ id: 'n', t: 0, s: 's', cost: 0.1, cr: 500000 })), 'cached');
  });

  const blowupSession = [
    ...[0, 1, 2, 3, 4].map((i) => ev({ id: `s1-${i}`, t: i * 60000, s: 's1', cost: 0.2, in: 6000, out: 4000, cr: 400000, cw: 20000 })),
    ev({ id: 's1-big', t: 5 * HOUR, s: 's1', cost: 6.81, in: 110696, out: 62425, cr: 12940878, cw: 844618 }),
  ];

  test('a long idle gap followed by a big re-cache is flagged as a stale resume', () => {
    const found = ins.buildInsights({ events: blowupSession, ratesFor });
    const stale = found.find((f) => f.rule === 'stale-resume');
    assert.ok(stale, 'expected a stale-resume finding');
    assert.equal(stale.anchor.requestId, 's1-big');
    assert.equal(stale.anchor.sessionId, 's1');
    // Impact is the re-caching specifically, not the whole request.
    assert.ok(stale.impact > 0 && stale.impact < 6.81);
    assert.match(stale.title, /re-caching/);
  });

  test('a context blowup is measured against the session it happened in', () => {
    const found = ins.buildInsights({ events: blowupSession, ratesFor });
    const blowup = found.find((f) => f.rule === 'context-blowup');
    assert.ok(blowup, 'expected a context-blowup finding');
    assert.equal(blowup.anchor.requestId, 's1-big');
    assert.ok(blowup.evidence.cacheShare > 0.9);
    // Only the reads above this session's own normal level are attributed.
    const whole = ins.costBreakdown(blowupSession[5], RATES);
    assert.ok(blowup.impact < whole.cacheRead);
  });

  test('a session that never idles or blows out produces neither finding', () => {
    const steady = [0, 1, 2, 3, 4, 5].map((i) => ev({
      id: `q-${i}`, t: i * 60000, s: 'q', cost: 0.2, in: 6000, out: 4000, cr: 400000, cw: 20000,
    }));
    const found = ins.buildInsights({ events: steady, ratesFor });
    assert.equal(found.filter((f) => f.rule === 'stale-resume' || f.rule === 'context-blowup').length, 0);
  });

  test('a compaction that holds is reported as working', () => {
    const events = [
      ev({ id: 'b1', t: 0, s: 'c1', cost: 0.5, in: 8000, out: 4000, cr: 800000, cw: 40000 }),
      ev({ id: 'b2', t: 60000, s: 'c1', cost: 0.5, in: 8000, out: 4000, cr: 800000, cw: 40000 }),
      ev({ id: 'sum', t: 120000, s: 'c1', cost: 0.077, in: 165817, out: 2786 }),
      ev({ id: 'a1', t: 180000, s: 'c1', cost: 0.2, in: 3000, out: 4000, cr: 300000, cw: 30000 }),
      ev({ id: 'a2', t: 240000, s: 'c1', cost: 0.2, in: 3000, out: 4000, cr: 300000, cw: 30000 }),
    ];
    const found = ins.buildInsights({ events, ratesFor });
    const worked = found.find((f) => f.rule === 'compaction-worked');
    assert.ok(worked, 'expected compaction-worked');
    assert.equal(worked.severity, 'positive');
    assert.equal(worked.anchor.requestId, 'sum');
  });

  test('a compaction the thread grows back out of points at the regrowth, not the summary', () => {
    const events = [
      ev({ id: 'b1', t: 0, s: 'c2', cost: 0.5, in: 8000, out: 4000, cr: 800000, cw: 40000 }),
      ev({ id: 'b2', t: 60000, s: 'c2', cost: 0.5, in: 8000, out: 4000, cr: 800000, cw: 40000 }),
      ev({ id: 'sum', t: 120000, s: 'c2', cost: 0.077, in: 165817, out: 2786 }),
      ev({ id: 'a1', t: 180000, s: 'c2', cost: 0.2, in: 3000, out: 4000, cr: 300000, cw: 30000 }),
      ev({ id: 'a2', t: 240000, s: 'c2', cost: 0.2, in: 3000, out: 4000, cr: 300000, cw: 30000 }),
      ev({ id: 'regrow', t: 34 * 60000, s: 'c2', cost: 4.21, in: 11069, out: 45131, cr: 9306929, cw: 237065 }),
    ];
    const found = ins.buildInsights({ events, ratesFor });
    assert.ok(!found.some((f) => f.rule === 'compaction-worked'));
    const undone = found.find((f) => f.rule === 'compaction-undone');
    assert.ok(undone, 'expected compaction-undone');
    // It anchors to the expensive request the regrowth caused, which is what
    // the user would click through to.
    assert.equal(undone.anchor.requestId, 'regrow');
    assert.ok(undone.impact > 1);
  });

  test('two compactions regrowing into one request say so once', () => {
    // Both summaries find the same later request as their regrowth, and the
    // rule anchors there — so without a dedupe the card renders twice and its
    // dollars are counted twice by anything that totals findings.
    const events = [
      ev({ id: 'b1', t: 0, s: 'c3', cost: 0.5, in: 8000, out: 4000, cr: 800000, cw: 40000 }),
      ev({ id: 'b2', t: 60000, s: 'c3', cost: 0.5, in: 8000, out: 4000, cr: 800000, cw: 40000 }),
      ev({ id: 'sum1', t: 120000, s: 'c3', cost: 0.077, in: 165817, out: 2786 }),
      ev({ id: 'm1', t: 180000, s: 'c3', cost: 0.2, in: 3000, out: 4000, cr: 300000, cw: 30000 }),
      ev({ id: 'm2', t: 240000, s: 'c3', cost: 0.2, in: 3000, out: 4000, cr: 300000, cw: 30000 }),
      ev({ id: 'sum2', t: 300000, s: 'c3', cost: 0.077, in: 165817, out: 2786 }),
      ev({ id: 'm3', t: 360000, s: 'c3', cost: 0.1, in: 3000, out: 4000, cr: 100000, cw: 10000 }),
      ev({ id: 'm4', t: 420000, s: 'c3', cost: 0.1, in: 3000, out: 4000, cr: 100000, cw: 10000 }),
      ev({ id: 'regrow', t: 34 * 60000, s: 'c3', cost: 4.21, in: 11069, out: 45131, cr: 9306929, cw: 237065 }),
    ];
    const found = ins.buildInsights({ events, ratesFor });
    assert.deepEqual(found.map((f) => f.id), [...new Set(found.map((f) => f.id))],
      'the same finding was emitted twice');
  });

  test('spend concentration reports the outliers and points at the dearest', () => {
    const many = [
      ...Array.from({ length: 12 }, (_, i) => ev({ id: `m${i}`, t: i * 60000, s: 'm', cost: 0.05, in: 2000, out: 1000, cr: 100000, cw: 5000 })),
      ev({ id: 'big', t: 20 * 60000, s: 'm', cost: 6.81, in: 110696, out: 62425, cr: 12940878, cw: 844618 }),
    ];
    const found = ins.buildInsights({ events: many, ratesFor });
    const conc = found.find((f) => f.rule === 'spend-concentration');
    assert.ok(conc, 'expected spend-concentration');
    assert.equal(conc.scope, 'period');
    assert.equal(conc.anchor.requestId, 'big');
  });

  test('new-chat overhead measures the floor across cold starts', () => {
    const colds = [
      ev({ id: 'k1', t: 0, s: 'k1', cost: 0.2, in: 35000, out: 500, cw: 35000 }),
      ev({ id: 'k2', t: HOUR, s: 'k2', cost: 0.2, in: 41000, out: 500, cw: 41000 }),
      ev({ id: 'k3', t: 2 * HOUR, s: 'k3', cost: 0.2, in: 38000, out: 500, cw: 38000 }),
    ];
    const found = ins.buildInsights({ events: colds, ratesFor });
    const overhead = found.find((f) => f.rule === 'new-chat-overhead');
    assert.ok(overhead, 'expected new-chat-overhead');
    assert.equal(overhead.evidence.floorTokens, 35000);
    assert.equal(overhead.evidence.coldStarts, 3);
    // Compactions must not be counted here — that was the old cold-start bug.
    const withCompaction = ins.buildInsights({
      events: [...colds, ev({ id: 'sum', t: 3 * HOUR, s: 'k4', cost: 0.077, in: 165817, out: 2786 })],
      ratesFor,
    });
    assert.equal(withCompaction.find((f) => f.rule === 'new-chat-overhead').evidence.coldStarts, 3);
  });

  test('findings rank by dollars, with positives last', () => {
    const found = ins.buildInsights({ events: blowupSession, ratesFor });
    const impacts = found.filter((f) => f.severity !== 'positive').map((f) => f.impact);
    assert.deepEqual(impacts, [...impacts].sort((a, b) => b - a));
    if (found.some((f) => f.severity === 'positive')) {
      assert.equal(found[found.length - 1].severity, 'positive');
    }
  });

  test('unattributed requests get period findings but not per-session ones', () => {
    // Requests with no conversation id are unrelated to each other, so gaps
    // and medians across them would compare different conversations.
    const orphans = [
      ev({ id: 'o1', t: 0, s: null, cost: 0.2, in: 6000, out: 4000, cr: 400000, cw: 20000 }),
      ev({ id: 'o2', t: 5 * HOUR, s: null, cost: 6.81, in: 110696, out: 62425, cr: 12940878, cw: 844618 }),
    ];
    const found = ins.buildInsights({ events: orphans, ratesFor });
    assert.equal(found.filter((f) => f.scope === 'request').length, 0);
  });

  test('requests with no cost at all yield nothing rather than throwing', () => {
    assert.deepEqual(ins.buildInsights({ events: [], ratesFor }), []);
    assert.deepEqual(ins.buildInsights({ events: [ev({ id: 'x', t: 0, s: 's', cost: null })], ratesFor }), []);
    assert.equal(ins.costBreakdown(ev({ id: 'x', t: 0, s: 's', cost: 1 }), null), null);
  });

  test('a compaction that regrew points at the summary as well as the regrowth', () => {
    // The finding is anchored to the request that spent the money, but the
    // summary is what the reader wants to see next and it is not the anchor.
    const MIN = 60 * 1000;
    const session = [
      ...[0, 1, 2, 3].map((i) => ev({ id: `c${i}`, t: i * MIN, s: 'c', cost: 0.4, cr: 900000, cw: 10000 })),
      ev({ id: 'summary', t: 5 * MIN, s: 'c', cost: 0.07, in: 165817, out: 2786 }),
      ...[0, 1, 2, 3].map((i) => ev({ id: `d${i}`, t: (6 + i) * MIN, s: 'c', cost: 0.1, cr: 100000, cw: 10000 })),
      ev({ id: 'regrown', t: 20 * MIN, s: 'c', cost: 0.9, cr: 1200000, cw: 10000 }),
    ];
    const undone = ins.buildInsights({ events: session, ratesFor }).find((f) => f.rule === 'compaction-undone');
    assert.ok(undone, 'expected a compaction-undone finding');
    assert.equal(undone.anchor.requestId, 'regrown');
    assert.equal(undone.anchor.summaryRequestId, 'summary');
  });
}

console.log('what changed partway through a session');
{
  const ins = await loadTs('src/webview/insights.js', 'insights-switch.mjs');
  const MIN = 60 * 1000;

  // Two genuinely different rate cards, plus a second variant of one of them
  // that prices against the same card — which is exactly how Cursor bills
  // reasoning effort, and the distinction the two detectors turn on.
  const CARDS = {
    'claude-4-5-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, label: 'Claude 4.5 Sonnet' },
    'claude-4-5-sonnet-thinking': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, label: 'Claude 4.5 Sonnet' },
    'composer-2.5': { input: 0.5, output: 2.5, cacheRead: 0.2, cacheWrite: 0.5, label: 'Composer 2.5' },
  };
  const ratesFor = (modelRaw) => CARDS[modelRaw] || null;
  const listCost = (modelRaw, k) => {
    const r = CARDS[modelRaw];
    return (k.in * r.input + k.out * r.output + k.cr * r.cacheRead + k.cw * r.cacheWrite) / 1e6;
  };

  let seq = 0;
  const ev = (modelRaw, k, opts = {}) => ({
    id: opts.id ?? `q${seq++}`,
    timestampMs: (opts.at ?? seq) * MIN,
    modelRaw,
    model: modelRaw,
    conversationId: opts.s ?? 's',
    cost: opts.cost ?? listCost(modelRaw, k),
    inputTokens: k.in, outputTokens: k.out, cacheReadTokens: k.cr, cacheWriteTokens: k.cw,
    totalTokens: k.in + k.out + k.cr + k.cw,
  });
  const run = (n, modelRaw, k, opts = {}) => Array.from({ length: n }, (_, i) =>
    ev(modelRaw, k, { ...opts, at: (opts.from ?? 0) + i }));

  const TOK = { in: 5000, out: 3000, cr: 400000, cw: 20000 };
  const find = (events, rule) => ins.buildInsights({ events, ratesFor }).find((f) => f.rule === rule);

  test('switching rate card is priced against the model you left, not the one you moved to', () => {
    // Token counts are identical either side, so any difference the detector
    // reports has to be the rate and nothing else. This is the property the
    // whole rule rests on: a switch usually happens once a session is already
    // large, and comparing raw before/after spend would blame the new model for
    // context growth it had nothing to do with.
    const events = [...run(4, 'composer-2.5', TOK), ...run(4, 'claude-4-5-sonnet', TOK, { from: 4 })];
    const f = find(events, 'model-switch');
    assert.ok(f, 'expected a model-switch finding');
    assert.equal(f.severity, 'high');
    assert.equal(f.evidence.switchedAt, 5);
    assert.equal(f.evidence.fromLabel, 'Composer 2.5');
    assert.equal(f.evidence.toLabel, 'Claude 4.5 Sonnet');
    const expected = 4 * (listCost('claude-4-5-sonnet', TOK) - listCost('composer-2.5', TOK));
    assert.ok(Math.abs(f.impact - expected) < 1e-9, `impact ${f.impact} should be the rate gap ${expected}`);
    assert.match(f.body, /the same tokens on composer-2\.5 would have been/);
  });

  test('context growing across the switch is not charged to the new model', () => {
    // Same switch, but the second half also reads four times the context. The
    // impact must still be only the rate difference on the tokens actually sent.
    const grown = { in: 5000, out: 3000, cr: 1600000, cw: 20000 };
    const events = [...run(4, 'composer-2.5', TOK), ...run(4, 'claude-4-5-sonnet', grown, { from: 4 })];
    const f = find(events, 'model-switch');
    const expected = 4 * (listCost('claude-4-5-sonnet', grown) - listCost('composer-2.5', grown));
    assert.ok(Math.abs(f.impact - expected) < 1e-9,
      'the counterfactual must price the grown tokens both ways, not compare halves');
  });

  test('a switch that saved money is reported, and ranked below findings that cost money', () => {
    const events = [...run(4, 'claude-4-5-sonnet', TOK), ...run(4, 'composer-2.5', TOK, { from: 4 })];
    const f = find(events, 'model-switch');
    assert.ok(f);
    assert.equal(f.severity, 'positive');
    assert.equal(f.impact, 0, 'a positive carries no dollars, so it cannot outrank real money');
    assert.match(f.title, /saved/);
  });

  test('raising the effort level is measured in tokens, never in rates', () => {
    // Both variants price against one published row, so re-pricing the same
    // tokens would return exactly zero. What changes is how much gets written.
    const low = { in: 5000, out: 2000, cr: 300000, cw: 20000 };
    const high = { in: 5000, out: 9000, cr: 300000, cw: 20000 };
    const events = [...run(4, 'claude-4-5-sonnet', low), ...run(4, 'claude-4-5-sonnet-thinking', high, { from: 4 })];
    const f = find(events, 'effort-switch');
    assert.ok(f, 'expected an effort-switch finding');
    assert.equal(f.evidence.outputBefore, 2000);
    assert.equal(f.evidence.outputAfter, 9000);
    assert.ok(f.impact > 0);
    assert.match(f.body, /The price per token did not change/);
    // The failure mode worth pinning: the same rate card either side must not
    // read as a model switch, which would report a $0.00 rate difference.
    assert.equal(find(events, 'model-switch'), undefined);
  });

  test('a promotion ending mid-session is caught from the charge, not the discount table', () => {
    // Discounts are stored per day, so reading them would only ever catch a
    // session that ran across midnight. The billed-to-list ratio moves whenever
    // the price does.
    const half = listCost('claude-4-5-sonnet', TOK) / 2;
    const events = [
      ...run(4, 'claude-4-5-sonnet', TOK, { cost: half }),
      ...run(4, 'claude-4-5-sonnet', TOK, { from: 4 }),
    ];
    const f = find(events, 'price-changed');
    assert.ok(f, 'expected a price-changed finding');
    assert.equal(f.severity, 'high');
    assert.equal(f.evidence.changedAt, 5);
    assert.ok(Math.abs(f.evidence.shiftPct - 100) < 1, `shift was ${f.evidence.shiftPct}%`);
    assert.match(f.title, /dearer/);
  });

  test('a steady session reports none of the three', () => {
    const events = run(8, 'claude-4-5-sonnet', TOK);
    for (const rule of ['model-switch', 'effort-switch', 'price-changed']) {
      assert.equal(find(events, rule), undefined, `${rule} fired on an unchanged session`);
    }
  });

  test('a change too small or too brief to matter is left alone', () => {
    // Two requests either side is not a pattern, whatever the rate gap.
    const brief = [...run(2, 'composer-2.5', TOK), ...run(2, 'claude-4-5-sonnet', TOK, { from: 2 })];
    assert.equal(find(brief, 'model-switch'), undefined);
    // And a switch between two cards priced almost identically is noise.
    const tiny = { in: 100, out: 50, cr: 2000, cw: 100 };
    const cheap = [...run(4, 'composer-2.5', tiny), ...run(4, 'claude-4-5-sonnet', tiny, { from: 4 })];
    assert.equal(find(cheap, 'model-switch'), undefined);
  });

  test('the unattributed bucket gets none of them', () => {
    // It is not a conversation, so a "switch" across it compares unrelated work.
    const events = [
      ...run(4, 'composer-2.5', TOK, { s: null }),
      ...run(4, 'claude-4-5-sonnet', TOK, { from: 4, s: null }),
    ].map((e) => ({ ...e, conversationId: null }));
    const found = ins.buildInsights({ events, ratesFor });
    for (const rule of ['model-switch', 'effort-switch', 'price-changed']) {
      assert.equal(found.find((f) => f.rule === rule), undefined, `${rule} fired on the unattributed bucket`);
    }
  });

  test('an unpriced model does not throw or invent a comparison', () => {
    const events = [...run(4, 'composer-2.5', TOK),
      ...Array.from({ length: 4 }, (_, i) => ({ ...ev('composer-2.5', TOK, { at: 4 + i }), modelRaw: 'who-knows' }))];
    assert.doesNotThrow(() => ins.buildInsights({ events, ratesFor }));
    assert.equal(find(events, 'model-switch'), undefined, 'no rates on one side means no honest comparison');
  });
}

console.log('brief (handing one session or request to Cursor Chat)');
{
  const brf = await loadTs('src/webview/brief.js', 'brief.mjs');
  const ins = await loadTs('src/webview/insights.js', 'insights2.mjs');
  const RATES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, label: 'Sonnet' };
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;

  const ev = (o) => ({
    id: o.id,
    timestampMs: o.t,
    modelRaw: 'claude-sonnet-5-thinking-high',
    model: o.model ?? 'Sonnet 5 Thinking',
    conversationId: o.s ?? 'sess',
    counted: o.counted !== false,
    cost: o.cost,
    cacheSavings: o.savings ?? 0,
    inputTokens: o.in ?? 0,
    outputTokens: o.out ?? 0,
    cacheReadTokens: o.cr ?? 0,
    cacheWriteTokens: o.cw ?? 0,
    totalTokens: (o.in ?? 0) + (o.out ?? 0) + (o.cr ?? 0) + (o.cw ?? 0),
  });

  const ctx = {
    breakdownOf: (e) => ins.costBreakdown(e, RATES),
    classify: (e) => ins.classifyRequest(e),
    ratesOf: () => RATES,
    // Fixed rather than locale-dependent, so the assertions below mean the same
    // thing on every machine that runs them.
    formatTime: (ms) => new Date(ms).toISOString().slice(11, 16),
  };

  /** A plain session: n ordinary cached turns, one per minute. */
  const plain = (n, s = 'sess') => Array.from({ length: n }, (_, i) =>
    ev({ id: `${s}-${i}`, t: i * MIN, s, cost: 0.2, in: 6000, out: 4000, cr: 400000, cw: 20000 }));

  test('the cost curve is the same size whatever the session is', () => {
    // The whole reason it exists: a 300-request session must not cost 25x more
    // to describe than a 12-request one.
    assert.equal(brf.costCurve(plain(47)).length, 6);
    assert.equal(brf.costCurve(plain(300)).length, 6);
    assert.equal(brf.costCurve(plain(12)).length, 6);
    // Fewer requests than slices collapses rather than emitting empty buckets.
    assert.equal(brf.costCurve(plain(3)).length, 3);
    assert.deepEqual(brf.costCurve([]), []);
  });

  test('the curve covers every request exactly once', () => {
    const curve = brf.costCurve(plain(47));
    assert.equal(curve.reduce((s, c) => s + c.count, 0), 47);
    assert.equal(curve[0].from, 0);
    assert.equal(curve[curve.length - 1].to, 47);
  });

  test('the curve keeps the step a compaction puts in the session', () => {
    // Heavy reads, then a compaction, then light reads. Downsampling to
    // "representative rows" is what loses this; slice medians keep it.
    const heavy = Array.from({ length: 24 }, (_, i) =>
      ev({ id: `h${i}`, t: i * MIN, s: 'z', cost: 0.5, cr: 900000 }));
    const light = Array.from({ length: 24 }, (_, i) =>
      ev({ id: `l${i}`, t: (25 + i) * MIN, s: 'z', cost: 0.1, cr: 90000 }));
    const curve = brf.costCurve([...heavy, ...light]);
    assert.ok(curve[0].medianRead > 500000, 'early slices should be heavy');
    assert.ok(curve[5].medianRead < 200000, 'late slices should be light');
  });

  test('a spike moves the median far less than it moves a mean', () => {
    // Reported once, in the events list, rather than also inflating a slice and
    // reading as sustained growth.
    const flat = Array.from({ length: 23 }, (_, i) =>
      ev({ id: `f${i}`, t: i * MIN, s: 'z', cost: 0.1, cr: 100000 }));
    flat.push(ev({ id: 'spike', t: 24 * MIN, s: 'z', cost: 5, cr: 12000000 }));
    const curve = brf.costCurve(flat);
    const last = curve[curve.length - 1];
    assert.equal(last.medianRead, 100000, 'the spike does not drag the slice up with it');
    // It is still visible where it belongs: in the slice's total cost.
    assert.ok(last.cost > curve[0].cost * 5);
  });

  const gapSession = [
    ...plain(4, 'g'),
    ev({ id: 'g-resume', t: 5 * HOUR, s: 'g', cost: 6.81, in: 110696, out: 62425, cr: 0, cw: 844618 }),
    ...Array.from({ length: 4 }, (_, i) =>
      ev({ id: `g-after${i}`, t: 5 * HOUR + (i + 1) * MIN, s: 'g', cost: 0.3, cr: 850000 })),
  ];

  test('an event a finding already narrates is not narrated twice', () => {
    const findings = [{ anchor: { requestId: 'g-resume', sessionId: 'g' }, severity: 'high', title: 't', body: 'b' }];
    const bare = brf.briefEvents(gapSession, [], ctx);
    const deduped = brf.briefEvents(gapSession, findings, ctx);
    assert.ok(bare.some((e) => /idle before #5/.test(e.line)), 'the gap is an event on its own');
    assert.ok(!deduped.some((e) => /idle before #5/.test(e.line)),
      'once a finding owns that request, repeating it invites double-counting the money');
  });

  test('events are ranked by dollars and capped', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      ev({ id: `m${i}`, t: i * 2 * HOUR, s: 'm', cost: i * 0.5, cr: 100000 }));
    const events = brf.briefEvents(many, [], ctx);
    assert.ok(events.length <= 5, `capped, got ${events.length}`);
    const impacts = events.map((e) => e.impact);
    assert.deepEqual(impacts, [...impacts].sort((a, b) => b - a), 'dearest first');
  });

  test('"the dearest request" never names the runner-up', () => {
    const bare = brf.briefEvents(gapSession, [], ctx);
    assert.ok(bare.some((e) => /#5 was the dearest request/.test(e.line)));
    // Once a finding owns the dearest one, this line goes quiet rather than
    // promoting the second-dearest and calling it the dearest.
    const findings = [{ anchor: { requestId: 'g-resume', sessionId: 'g' }, severity: 'high', title: 't', body: 'b' }];
    assert.ok(!brf.briefEvents(gapSession, findings, ctx).some((e) => /dearest request/.test(e.line)));
  });

  test('a compaction the findings already judged is not re-narrated', () => {
    // compaction-worked / compaction-undone anchor to the regrowth request, not
    // to the summary, so matching on request id alone would miss this.
    const withCompaction = [
      ...plain(3, 'c'),
      ev({ id: 'c-sum', t: 4 * MIN, s: 'c', cost: 0.07, in: 165817, out: 2786 }),
      ...plain(3, 'c2'),
    ];
    assert.ok(brf.briefEvents(withCompaction, [], ctx).some((e) => /compacted the conversation/.test(e.line)));
    const judged = [{ rule: 'compaction-undone', anchor: { requestId: 'c2-2', sessionId: 'c' }, severity: 'medium', title: 't', body: 'b' }];
    assert.ok(!brf.briefEvents(withCompaction, judged, ctx).some((e) => /compacted the conversation/.test(e.line)));
  });

  test('the cost split leads with the largest bucket and drops the empty ones', () => {
    const text = brf.buildRequestBrief({
      event: gapSession[4], sessionEvents: gapSession, session: { id: 'g' }, ...ctx,
    });
    const split = text.match(/- Cost split: (.*)/)[1];
    assert.ok(split.startsWith('cache write'), `largest first, got "${split}"`);
    assert.ok(!/cache read/.test(split), 'a cold start read nothing; saying so in dollars costs tokens');
    const shares = [...split.matchAll(/\((\d+)%\)/g)].map((m) => Number(m[1]));
    assert.deepEqual(shares, [...shares].sort((a, b) => b - a));
  });

  test('errored requests are one line, not one line each', () => {
    const withErrors = [
      ...plain(3, 'e'),
      ev({ id: 'e-x', t: 10 * MIN, s: 'e', cost: 0.07, cr: 1000, counted: false }),
      ev({ id: 'e-y', t: 11 * MIN, s: 'e', cost: 0.07, cr: 1000, counted: false }),
    ];
    const lines = brf.briefEvents(withErrors, [], ctx).map((e) => e.line);
    const errored = lines.filter((l) => /errored/.test(l));
    assert.equal(errored.length, 1);
    assert.ok(/2 requests errored/.test(errored[0]));
  });

  const session = { id: 'g', name: 'Migrate auth service', costBasis: 'billed by the plan' };

  test('a session brief states its cost basis, its shape and its money', () => {
    const findings = [{
      anchor: { requestId: 'g-resume', sessionId: 'g' }, severity: 'high', impact: 3.1,
      title: '$3.10 spent re-caching a thread left for 5.1h', body: 'The prompt cache had expired.',
      action: 'Start a fresh chat after hours away.',
    }];
    const text = brf.buildSessionBrief({ session, events: gapSession, findings, ...ctx,
      template: brf.BRIEF_TEMPLATES[0] });
    assert.ok(text.includes('billed by the plan'), 'without this the dollars are ambiguous');
    assert.ok(text.includes('Migrate auth service'));
    assert.ok(/## Cost curve/.test(text));
    assert.ok(/Context handling.* was \d+%/.test(text));
    // The leftover after context is output *and* input, and input is the
    // prompt. Calling the pair "the answers" hands the reader a false premise
    // about the one split the rest of the brief argues from.
    assert.ok(!/the answers themselves were/.test(text),
      'output and input must be reported separately, not merged into "the answers"');
    assert.ok(/the answers were \d+% and the prompts I sent \d+%/.test(text));
    assert.ok(text.includes('$3.10 spent re-caching'), 'findings are quoted');
    assert.ok(text.includes(brf.BRIEF_TEMPLATES[0].prompt), 'the question is the point of the brief');
    assert.ok(/markers.*idle before #5/.test(text), 'the curve marks where the shape changed');
  });

  test('the finding action is left out, since beating it is the job', () => {
    const findings = [{
      anchor: { requestId: 'g-resume', sessionId: 'g' }, severity: 'high', impact: 3.1,
      title: 'Re-cached a stale thread', body: 'Body.', action: 'GENERIC-ADVICE-MARKER',
    }];
    const text = brf.buildSessionBrief({ session, events: gapSession, findings, ...ctx });
    assert.ok(text.includes('Re-cached a stale thread'));
    assert.ok(!text.includes('GENERIC-ADVICE-MARKER'),
      'quoting our own advice anchors the answer to what we are trying to improve on');
  });

  test('findings are capped and a positive never crowds out real money', () => {
    const findings = [
      ...Array.from({ length: 6 }, (_, i) => ({
        anchor: { requestId: `g-after${i % 4}`, sessionId: 'g' }, severity: 'high', impact: 6 - i,
        title: `High ${i}`, body: 'b',
      })),
      { anchor: { requestId: 'g-resume', sessionId: 'g' }, severity: 'positive', impact: 0, title: 'Nice', body: 'b' },
    ];
    const text = brf.buildSessionBrief({ session, events: gapSession, findings, ...ctx });
    const quoted = text.match(/^\d+\. \[/gm) || [];
    assert.equal(quoted.length, 4);
    assert.ok(!text.includes('Nice'), 'the positive is dropped before a finding with dollars on it');
  });

  test('a brief never lists requests one per line, at any size', () => {
    // Not a default any more — the opt-in that used to turn this on is gone, so
    // it is now an unconditional property of the format.
    for (const n of [3, 12, 47, 300]) {
      const text = brf.buildSessionBrief({ session, events: plain(n), ...ctx });
      assert.ok(!/^#\d+ \d/m.test(text), `${n}-request brief listed requests`);
    }
  });

  test('a typed question only counts when the question template asked for one', () => {
    // It used to win over whatever template was selected, silently and for good.
    const picked = brf.BRIEF_TEMPLATES.find((t) => t.id === 'session-too-long');
    const custom = brf.BRIEF_TEMPLATES.find((t) => t.id === 'session-custom');
    const typed = 'MY-OWN-QUESTION';
    const withTemplate = brf.buildSessionBrief({ session, events: plain(6), template: picked, question: typed, ...ctx });
    assert.ok(withTemplate.includes(picked.prompt), 'the chosen template still asks its question');
    assert.ok(!withTemplate.includes(typed), 'stale text in the box must not hijack a template');
    const withCustom = brf.buildSessionBrief({ session, events: plain(6), template: custom, question: typed, ...ctx });
    assert.ok(withCustom.includes(typed));
  });

  test('the question labels read as one instruction each', () => {
    for (const t of brf.BRIEF_TEMPLATES) {
      assert.ok(!t.title.includes(' — '), `"${t.title}" still carries a dash-appended explainer`);
      assert.equal(t.desc, undefined, `${t.id} still has a desc the dropdown would have to render`);
    }
    const byId = Object.fromEntries(brf.BRIEF_TEMPLATES.map((t) => [t.id, t.title]));
    assert.equal(byId['session-too-long'], 'Find where starting a fresh chat would have saved money.');
    assert.equal(byId['session-waste'], 'Identify avoidable spend, ranked by dollar impact.');
    assert.equal(byId['session-next-time'], 'Create a cheaper plan for doing the same work.');
    assert.equal(byId['session-custom'], 'Custom question - Write a question');
    // Only the custom ones open the free-text box.
    assert.deepEqual(brf.BRIEF_TEMPLATES.filter((t) => t.custom).map((t) => t.id),
      ['session-custom', 'request-custom']);
  });

  test('a session brief stays roughly flat as the session grows', () => {
    const small = brf.estimateBriefSize(brf.buildSessionBrief({ session, events: plain(12), ...ctx })).tokens;
    const large = brf.estimateBriefSize(brf.buildSessionBrief({ session, events: plain(300), ...ctx })).tokens;
    assert.ok(large < small * 1.3, `12 requests cost ${small} tokens, 300 cost ${large}`);
  });

  test('a request brief looks one request back and three forward', () => {
    const text = brf.buildRequestBrief({
      event: gapSession[4],
      sessionEvents: gapSession,
      session,
      findings: [],
      template: brf.BRIEF_TEMPLATES.find((t) => t.id === 'request-avoidable'),
      ...ctx,
    });
    assert.ok(/request #5 of 9/.test(text), 'position in the session');
    assert.ok(/- Before: #4 /.test(text));
    assert.ok(/4h 57m before this one/.test(text), 'the gap is what the previous request is there to establish');
    assert.ok(/- After: #6 .* · #7 .* · #8 /.test(text), 'three forward — was the re-cache earned back?');
    assert.ok(/1 more request/.test(text), 'and what became of the rest');
    assert.ok(/Shape: cold start/.test(text));
    assert.ok(/Cost split: cache write/.test(text));
  });

  test('a request brief handles the ends of a session', () => {
    const last = brf.buildRequestBrief({ event: gapSession[8], sessionEvents: gapSession, session, ...ctx });
    assert.ok(/After: nothing/.test(last));
    const first = brf.buildRequestBrief({ event: gapSession[0], sessionEvents: gapSession, session, ...ctx });
    assert.ok(!/- Before:/.test(first));
  });

  test('nothing a user wrote can reach the brief', () => {
    // The extension never reads prompts or code, but a brief is the one thing
    // here that leaves the machine — so this asserts the shape rather than
    // trusting it.
    const decoy = {
      ...gapSession[4],
      prompt: 'SECRET-PROMPT-TEXT',
      text: 'SECRET-MESSAGE-TEXT',
      content: 'SECRET-CODE-CONTEXT',
      messages: [{ role: 'user', content: 'SECRET-TURN' }],
    };
    const events = [...gapSession.slice(0, 4), decoy, ...gapSession.slice(5)];
    const both = brf.buildSessionBrief({ session, events, ...ctx })
      + brf.buildRequestBrief({ event: decoy, sessionEvents: events, session, ...ctx });
    for (const secret of ['SECRET-PROMPT-TEXT', 'SECRET-MESSAGE-TEXT', 'SECRET-CODE-CONTEXT', 'SECRET-TURN']) {
      assert.ok(!both.includes(secret), `${secret} reached the brief`);
    }
  });

  test('the preamble forbids the three things that waste a round trip', () => {
    const p = brf.BRIEF_PREAMBLE;
    assert.ok(/ask no clarifying questions/.test(p));
    assert.ok(/Never invent, estimate or extrapolate/.test(p));
    assert.ok(/never prompts, messages or code/.test(p), 'it must explain why nobody can answer "what were you doing"');
    assert.ok(/cache read ~0\.1x input/.test(p),
      'without the rate ratios a reader congratulates the user on a 90% cache hit rate');
  });

  test('every template demands the answer cite figures', () => {
    for (const t of brf.BRIEF_TEMPLATES) {
      assert.ok(['session', 'request'].includes(t.scope));
      assert.ok(t.prompt.length > 40, `${t.id} has no real prompt`);
    }
    assert.ok(brf.BRIEF_TEMPLATES.some((t) => t.scope === 'session'));
    assert.ok(brf.BRIEF_TEMPLATES.some((t) => t.scope === 'request'));
  });

  test('the size estimate grows with the text and is never zero for real text', () => {
    assert.equal(brf.estimateBriefSize('').tokens, 0);
    assert.ok(brf.estimateBriefSize('abcd').tokens >= 1);
    assert.ok(brf.estimateBriefSize('x'.repeat(4000)).tokens > brf.estimateBriefSize('x'.repeat(400)).tokens);
  });

  test('the period brief keeps the notes it has always had', () => {
    // buildCursorBrief now pulls these from here; if they changed, a shipped
    // brief changed with them.
    assert.deepEqual(brf.BRIEF_NOTES, [
      '- Auto optimizes for task success and uses the Auto+Composer pool — not always the cheapest rate card.',
      '- Cheaper models in comparisons assume the same token counts; real usage may differ.',
      '- Token cost excludes flat per-request usage fees unless noted in summary.',
    ]);
    const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');
    assert.ok(main.includes("parts.push('---', 'Notes for the model:', ...BRIEF_NOTES)"),
      'the period brief must still emit the same heading above them');
  });

  test('sessions the dashboard can price oddly still produce a brief', () => {
    const single = [ev({ id: 'one', t: 0, s: 'x', cost: 0.4, in: 5000, out: 900, cr: 20000 })];
    assert.ok(brf.buildSessionBrief({ session: { id: 'x' }, events: single, ...ctx }).length > 0);
    // No pricing table for this model: the split is unavailable, the brief isn't.
    const unpriced = brf.buildSessionBrief({
      session: { id: 'x' }, events: single, ...ctx, breakdownOf: () => null,
    });
    assert.ok(unpriced.includes('## Cost curve'));
    assert.ok(!unpriced.includes('Context handling'));
    assert.equal(brf.buildSessionBrief({ session, events: [], ...ctx }), '');
    assert.equal(brf.buildRequestBrief({ event: null, ...ctx }), '');
  });

  test('every id the ask dialog wires up exists in the markup', () => {
    const html = readFileSync(path.join(here, '..', 'src/html.ts'), 'utf8');
    for (const id of [
      'sessionAskBtn', 'askCursorDialog', 'askTitle', 'askClose', 'askRequest',
      'askTemplate', 'askCustomQ', 'askCustomField', 'askPreview',
      'askSize', 'askCopy', 'askStatus',
    ]) {
      assert.ok(html.includes(`id="${id}"`), `markup is missing id="${id}"`);
    }
  });

  test('the ask dialog is not nested inside a view that can be display:none', () => {
    // A <dialog> inside a hidden ancestor opens at zero size — the exact bug the
    // session detail dialog already had, and this one is opened from it.
    const html = readFileSync(path.join(here, '..', 'src/html.ts'), 'utf8');
    const before = html.slice(0, html.indexOf('id="askCursorDialog"'));
    const opened = (before.match(/<section /g) || []).length;
    const closed = (before.match(/<\/section>/g) || []).length;
    assert.equal(opened, closed, 'askCursorDialog sits inside an unclosed <section>');
  });
}

console.log('Auto keeps a rate even when the pricing page moves it');
{
  const MODELS_TABLE = [
    '| Model | Input | Cache Write | Cache Read | Output |',
    '| --- | --- | --- | --- | --- |',
    '| Claude 4.5 Sonnet | $3 | $3.75 | $0.30 | $15 |',
    '| GPT-5.2 | $1.25 | $1.56 | $0.13 | $10 |',
  ].join('\n');

  test('a page that lists models but no Auto row still prices Auto', () => {
    // This is the regression. Auto is priced from `pricing.auto` alone, and the
    // wholesale fallback only fired when *nothing* parsed — so a page that still
    // listed every named model but had moved or renamed the Auto row left Auto
    // with no rates at all. Every Auto request then lost its cost breakdown, its
    // cache-savings figure, and got reported as "not in the pricing table" — for
    // the most-used model in the product.
    const pricing = parsePricing(`## Pricing\n${MODELS_TABLE}`);
    assert.equal(pricing.models.length, 2, 'the named models still parse');
    assert.equal(pricing.autoFallback, true, 'and the substitution is recorded, not hidden');
    const rates = matchPricing('auto', pricing);
    assert.ok(rates, 'Auto must never come back unpriced');
    assert.ok(rates.input > 0 && rates.output > 0);
    assert.equal(rates.estimated, true, 'so the UI can say the rate is built-in, not scraped');
  });

  test('a published Auto rate is never overwritten by the built-in one', () => {
    for (const doc of [
      `### Auto pricing\n| Input and cache write | $1.10 |\n| Cache read | $0.22 |\n| Output | $5 |\n\n## Models\n${MODELS_TABLE}`,
      `## Auto modes\n| Model | Input | Cache Write | Cache Read | Output |\n| --- | --- | --- | --- | --- |\n| Auto Cost | $1.10 | $1.10 | $0.22 | $5 |`,
    ]) {
      const pricing = parsePricing(doc);
      assert.equal(pricing.autoFallback, false, 'a real rate was published');
      const rates = matchPricing('auto', pricing);
      assert.equal(rates.input, 1.1);
      assert.equal(rates.output, 5);
      assert.ok(!rates.estimated);
    }
  });

  test('every spelling of Auto reaches the same rate', () => {
    const pricing = parsePricing(`## Pricing\n${MODELS_TABLE}`);
    for (const raw of ['auto', 'Auto', 'default', 'cursor-auto', 'Auto Cost', 'auto-cost']) {
      assert.ok(matchPricing(raw, pricing), `matchPricing(${JSON.stringify(raw)}) came back null`);
    }
  });

  await test('the built-in rate carries through to a cost breakdown', async () => {
    const ins = await loadTs('src/webview/insights.js', 'insights3.mjs');
    const pricing = parsePricing(`## Pricing\n${MODELS_TABLE}`);
    const b = ins.costBreakdown(
      { inputTokens: 5000, outputTokens: 900, cacheReadTokens: 400000, cacheWriteTokens: 20000, cost: 0.4 },
      matchPricing('auto', pricing),
    );
    assert.ok(b && b.total > 0, 'an Auto request must be breakable down');
    assert.equal(b.estimated, true, 'and must be able to say the rates were a default');
  });
}

console.log('handing a brief to Cursor Chat');
{
  const rpc = readFileSync(path.join(here, '..', 'src/rpcDispatcher.ts'), 'utf8');

  test('the chat command is never called with a query', () => {
    // The load-bearing safety property. Upstream, `workbench.action.chat.open`
    // only leaves a prompt unsent when passed `isPartialQuery: true`; a bare
    // string — the form nearly every snippet on the web uses — normalizes to
    // `{ query }` and calls acceptInput(), which bills a request on the spot.
    // Whether Cursor honours `isPartialQuery` is undocumented, so the command is
    // only ever called with no arguments at all.
    const calls = [...rpc.matchAll(/executeCommand\(([^)]*)\)/g)].map((m) => m[1].trim());
    for (const call of calls) {
      assert.ok(!/chat\.open['"]\s*,/.test(call),
        `chat.open is being passed an argument, which can submit a paid request: ${call}`);
    }
    // The comment above the method names this key to explain why it is avoided,
    // so strip comments before looking for it as actual code.
    const code = rpc.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.ok(!/isPartialQuery/.test(code),
      'gambling a paid request on an option key Cursor may silently ignore');
    assert.ok(rpc.includes('executeCommand(command)'),
      'the chat-panel candidates must stay argument-free');
  });

  test('the clipboard is written before anything else is attempted', () => {
    const body = rpc.slice(rpc.indexOf('private async sendToCursorChat'));
    const clip = body.indexOf('clipboard.writeText');
    const deeplink = body.indexOf('prefillViaDeeplink');
    assert.ok(clip > -1 && deeplink > clip,
      'every path below can fail; the clipboard is what makes that survivable');
  });

  test('the deeplink is capped and gated to a desktop Cursor', () => {
    assert.ok(rpc.includes('DEEPLINK_MAX_CHARS = 8000'), 'Cursor caps a deeplink payload');
    assert.ok(/query\.length > RpcDispatcher\.DEEPLINK_MAX_CHARS/.test(rpc), 'and the cap is measured after encoding');
    assert.ok(rpc.includes('new URLSearchParams({ text })'),
      'hand-rolled encoding truncates the prompt at the first "&"');
    assert.ok(rpc.includes("uriScheme !== 'cursor'"), 'do not fire cursor:// at a non-Cursor host');
    assert.ok(rpc.includes('vscode.UIKind.Desktop'), 'the in-process interception is desktop-only');
  });

  test('the webview reports what actually happened, not what it hoped for', () => {
    const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');
    const fn = main.slice(main.indexOf('async function sendBriefToCursor'));
    assert.ok(fn.includes('outcome?.pasted'), 'a paste and a copy are different outcomes');
    assert.ok(fn.includes('outcome?.opened'));
    assert.ok(/Copied — paste in Cursor Chat/.test(fn), 'and the plain copy is still a real outcome');
  });
}

console.log('request-log row detail');
{
  const css = readFileSync(path.join(here, '..', 'src/webview/styles.css'), 'utf8');

  test('the detail cell undoes the nowrap the data columns need', () => {
    // `td { white-space: nowrap }` is right for twelve columns of timestamps and
    // token counts, and inherited — so in the one cell that holds sentences it
    // turned each finding into a single unbreakable line whose min-content width
    // fed back into the table's own minimum width under `table-layout: auto`.
    // The detail row was not sitting in a wide table; it was making it wide.
    assert.match(css, /td \{[^}]*white-space: nowrap;/s, 'the data columns still expect nowrap');
    const rule = css.match(/\.row-detail > td \{[^}]*\}/)[0];
    assert.match(rule, /white-space: normal/, '.row-detail > td must reset it');
  });

  test('long unbroken text cannot re-inflate the cell', () => {
    assert.match(css, /\.finding-card h4,\s*\n\.finding-card p,\s*\n\.finding-action \{ overflow-wrap: anywhere; \}/);
  });

  test('the grid children are allowed to shrink', () => {
    // Grid items refuse to go below their content's min-content width unless
    // told to, which would undo the wrapping fix on a narrow column.
    assert.match(css, /\.detail-grid > div \{ min-width: 0; \}/);
    assert.match(css, /\.findings-grid \{[^}]*min-width: 0/);
  });

  test('the detail content is pinned to the visible width', () => {
    // The twelve data columns can overflow a narrow window on their own, and
    // then the cell is as wide as the table whatever this row does.
    const rule = css.match(/\.detail-sticky \{[^}]*\}/)[0];
    assert.match(rule, /position: sticky/);
    assert.match(rule, /left: 0/);
    assert.match(rule, /width: min\(100%, calc\(100vw - \d+px\)\)/);
    const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');
    assert.match(main, /<div class="detail-sticky">/, 'and something has to carry the class');
  });
}

console.log('session timeline');
{
  const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');
  const fn = main.slice(main.indexOf('function renderSessionTimeline'), main.indexOf('function openSessionDetail'));

  test('the peak caption names the request it belongs to', () => {
    // It used to read "$1.02 peak", centred by space-between under the middle of
    // the plot — so on a three-bar session it sat over the *smallest* bar and
    // read as that bar's label.
    assert.ok(/peak \$\{|peak \$/.test(fn) || fn.includes('peak ${fmt.money(max)} at #${peakAt}'),
      'the peak caption must say which request it is about');
    assert.ok(fn.includes('peakAt'), 'and that index has to be computed');
  });

  test('bars get their own price while they are wide enough to show one', () => {
    assert.ok(fn.includes('tl-labels'));
    assert.ok(fn.includes('moneyFine(e.cost)'),
      'fmt.money rounds a fraction-of-a-cent request to $0.00');
    assert.ok(fn.includes('TIMELINE_LABEL_MAX'));
  });

  test('labels stop well before the plot starts scrolling', () => {
    // .tl-labels is a sibling of .tl-plot, so once the plot scrolls horizontally
    // the two slide out of alignment with each other. At flex 1 0 10px with a
    // 3px gap in an ~816px dialog that starts around 60 bars.
    const max = Number(main.match(/const TIMELINE_LABEL_MAX = (\d+)/)[1]);
    assert.ok(max > 0 && max <= 20, `TIMELINE_LABEL_MAX is ${max}, too close to the scroll threshold`);
  });

  test('the compaction bars and the tooltip are wired to something real', () => {
    const css = readFileSync(path.join(here, '..', 'src/webview/styles.css'), 'utf8');
    assert.match(fn, /tl-compaction/, 'a summarising turn is marked in the plot');
    assert.match(fn, /data-tl-tip=/, 'the tip text travels as data, not as a native title');
    assert.ok(!/title="\$\{esc\(tip\)\}"/.test(fn),
      'the native title must be gone, or two tooltips fight over the same bar');
    // Fixed, not absolute: .tl-plot scrolls horizontally, and an overflow-x box
    // clips on both axes, so an absolute tip would be cut off by its own plot.
    const tip = css.match(/\.tl-tip \{[^}]*\}/)[0];
    assert.match(tip, /position: fixed/);
    assert.match(tip, /white-space: pre-line/, 'the tip is multi-line');
    for (const id of ['tlTip']) {
      const html = readFileSync(path.join(here, '..', 'src/html.ts'), 'utf8');
      assert.ok(html.includes(`id="${id}"`), `markup is missing id="${id}"`);
      // Inside the dialog: a modal renders in the top layer, so a tooltip
      // parented to <body> would sit behind it whatever its z-index.
      const dialog = html.slice(html.indexOf('id="sessionDetailDialog"'));
      assert.ok(dialog.slice(0, dialog.indexOf('</dialog>')).includes(`id="${id}"`),
        `${id} must live inside the session dialog`);
    }
  });

  test('the label row shares the plot\'s flex rules so labels sit under their bars', () => {
    const css = readFileSync(path.join(here, '..', 'src/webview/styles.css'), 'utf8');
    const labels = css.slice(css.indexOf('.tl-labels {'), css.indexOf('.tl-axis {'));
    const plot = css.slice(css.indexOf('.tl-plot {'), css.indexOf('.tl-bar {'));
    for (const rule of ['gap: 3px', 'padding: 6px']) {
      assert.ok(plot.includes(rule), `.tl-plot lost "${rule}"`);
      assert.ok(labels.includes(rule.replace('padding: 6px', 'padding: 0 6px')),
        `.tl-labels must match .tl-plot on "${rule}"`);
    }
    assert.ok(labels.includes('flex: 1 0 10px'), 'and on how each cell sizes');
  });
}

// ---------------------------------------------------------------------------
// The standalone browser page. Its own CSP is the thing most likely to break
// it, and it breaks it silently: a blocked bootstrap script leaves a page that
// renders perfectly and can't load a single number.
// ---------------------------------------------------------------------------
console.log('\nbrowser page (Open in Browser)');
{
  const html = readFileSync(path.join(here, '..', 'src/html.ts'), 'utf8');
  const browserFn = html.slice(
    html.indexOf('export function getBrowserDashboardHtml'),
    html.indexOf('function dashboardBody'),
  );

  test('the page runs no inline script its own CSP would refuse', () => {
    // script-src 'self' blocks inline script with no nonce and no hash, so an
    // inline <script> here means the dashboard loads and then does nothing.
    const csp = browserFn.match(/Content-Security-Policy[\s\S]*?content="([^"]+)"/)?.[1] || '';
    assert.ok(/script-src [^;]*'self'/.test(csp), 'expected script-src to allow only same-origin scripts');
    assert.ok(!/'unsafe-inline'/.test(csp.match(/script-src[^;]*/)?.[0] || ''),
      'inline script must stay blocked — fix the page, not the policy');
    const inline = (browserFn.match(/<script(?![^>]*\ssrc=)[^>]*>/g) || [])
      .filter((tag) => !/nonce=/.test(tag));
    assert.deepEqual(inline, [], `inline <script> would be blocked by this page's CSP: ${inline.join(', ')}`);
  });

  test('the RPC token is never written into the page', () => {
    // It arrives in the launch URL and lives in sessionStorage; embedding it in
    // the HTML is what forced the inline script in the first place.
    assert.ok(!/getBrowserDashboardHtml\s*\(\s*token/.test(browserFn),
      'the page should not take a token to render');
    assert.ok(!/__CURSOR_USAGE_TOKEN__/.test(html), 'the token must not be inlined into the markup');
  });

  test('a reloaded tab can still authenticate', () => {
    // The token is stripped from the URL on first load, so a plain F5 has to be
    // served by sessionStorage or the tab comes back with no data at all.
    const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');
    const fn = main.match(/function readBrowserToken\(\)\s*\{[\s\S]*?\n\}/)?.[0] || '';
    assert.ok(fn, 'main.js must resolve the browser token in one place');
    assert.ok(/searchParams\.get\('token'\)/.test(fn), 'must read the token the launch URL carries');
    assert.ok(/sessionStorage\.setItem/.test(fn) && /sessionStorage\.getItem/.test(fn),
      'must survive a reload, which the URL no longer can');
    assert.ok(/replaceState/.test(fn), 'must clean the token out of the address bar and history');
  });

  test('the server gates the data and not the shell', () => {
    const server = readFileSync(path.join(here, '..', 'src/browserServer.ts'), 'utf8');
    const rpc = server.slice(server.indexOf('private handleRpc'), server.indexOf('private readRpcBody'));
    assert.ok(/tokenMatches\(req\.headers\[TOKEN_HEADER\]\)/.test(rpc), '/api/rpc must require the token header');
    const shell = server.slice(server.indexOf("url.pathname === '/'"), server.indexOf("url.pathname === '/main.js'"));
    assert.ok(!/403/.test(shell), 'gating the shell breaks reload — the shell carries no data');
    assert.ok(/timingSafeEqual/.test(server), 'compare the token in constant time');
  });

  test('non-JSON answers surface as a message, not a parse error', () => {
    const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');
    const fn = main.match(/async function rpcOverHttp\([\s\S]*?\n\}/)?.[0] || '';
    assert.ok(/res\.status === 403/.test(fn), 'a stale token needs an answer the user can act on');
    assert.ok(/res\.ok/.test(fn), 'other error statuses must not be fed to res.json()');
  });

  test('the standalone page can follow the OS theme', () => {
    // Nothing in a browser tab defines the --vscode-* variables the palette is
    // built on, so every token falls back to its light value.
    assert.ok(/<body class="standalone">/.test(browserFn), 'the page must mark itself as standalone');
    const css = readFileSync(path.join(here, '..', 'src/webview/styles.css'), 'utf8');
    const dark = css.match(/@media \(prefers-color-scheme: dark\)\s*\{\s*body\.standalone\s*\{[\s\S]*?\n {2}\}/)?.[0] || '';
    assert.ok(dark, 'expected a dark palette scoped to the standalone page');
    for (const token of ['--bg', '--panel', '--text', '--border', '--input-bg']) {
      assert.ok(dark.includes(`${token}:`), `dark palette leaves ${token} at its light value`);
    }
  });
}

// ---------------------------------------------------------------------------
// Review pass: things that were correct in isolation and wrong in place.
// ---------------------------------------------------------------------------
console.log('\nreview fixes');
{
  const css = readFileSync(path.join(here, '..', 'src/webview/styles.css'), 'utf8');
  const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');

  test('a finding keeps its own heading inside the row detail and the session dialog', () => {
    // Both containers label their sections with an uppercase 11px caption, and
    // a bare `h4` descendant selector reaches the finding card's title too —
    // which is a full sentence, and was being rendered in muted small caps.
    for (const scope of ['.detail-grid', '.session-detail-body']) {
      assert.match(css, new RegExp(`${scope.replace('.', '\\.')} h4 \\{[^}]*text-transform: uppercase`),
        `${scope} still captions its own sections`);
    }
    const rule = css.match(/\.detail-grid \.finding-card h4,\s*\n\.session-detail-body \.finding-card h4 \{[^}]*\}/)?.[0];
    assert.ok(rule, 'the finding card must win its heading back in both containers');
    assert.match(rule, /text-transform: none/);
    assert.match(rule, /font-size: 12px/);
  });

  test('a row with nothing flagged does not reserve half the cell for it', () => {
    assert.match(main, /class="detail-grid\$\{flags\.length \? '' : ' no-findings'\}"/,
      'the grid has to know whether it has a second column to lay out');
    assert.ok(!/<div>\$\{flags\.length/.test(main),
      'an always-emitted empty <div> is still a grid item');
    assert.match(css, /\.detail-grid\.no-findings \{[^}]*grid-template-columns: minmax\(/);
  });

  test('the brief is priced against the session it is about, not its first request', () => {
    const fn = main.slice(main.indexOf('function renderAskSize'), main.indexOf('function renderAskDialog'));
    assert.ok(fn.includes('dominantEvent(events)'),
      'a session that opened on one model and ran on another quoted a rate card nobody recognised');
    assert.ok(!/ratesForEvent\(events\[0\]/.test(fn));
  });

  test('nothing sizes a request list by spreading it into Math.max', () => {
    // Math.max(...array) throws RangeError once the array is long enough to
    // blow the argument limit, which only ever happens to the heaviest users.
    // The remaining spreads in main.js are over days in a range or over the
    // at-most-four sessions being compared, both of which are bounded.
    const insights = readFileSync(path.join(here, '..', 'src/webview/insights.js'), 'utf8');
    const timeline = main.slice(main.indexOf('function renderSessionTimeline'), main.indexOf('function showTimelineTip'));
    assert.ok(!/Math\.(max|min)\(\.\.\./.test(timeline), 'one bar per request — the list is as long as the session');
    assert.ok(timeline.includes('maxOf(priced'), 'and the reducing helper is what replaced it');
    assert.ok(main.includes('function maxOf('), 'the reducing helper has to exist');
    const overhead = insights
      .slice(insights.indexOf('function newChatOverhead'), insights.indexOf('export function buildInsights'))
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/Math\.(max|min)\(\.\.\./.test(overhead), 'the cold-start floor reduces over every cold start in the period');
  });

  test('a session named after its dialog opened still gets its name', () => {
    assert.ok(main.includes('function refreshOpenSessionTitle'),
      'names arrive asynchronously and the dialog heading is not redrawn by anything else');
    assert.match(main, /dialog\.dataset\.session = sessionId/,
      'the dialog has to record which conversation it is showing');
    const loader = main.slice(main.indexOf('async function loadSessionTitles'), main.indexOf('function refreshOpenSessionTitle'));
    assert.ok(loader.includes('refreshOpenSessionTitle()'), 'and the loader has to call it');
  });

  test('the loopback server survives an error after it started listening', () => {
    const server = readFileSync(path.join(here, '..', 'src/browserServer.ts'), 'utf8');
    const start = server.slice(server.indexOf('private async start()'), server.indexOf('private get baseUrl'));
    assert.match(start, /this\.server\.on\('error'/,
      "the once('error') used for listen() has fired; an unhandled 'error' event is thrown");
  });

  test('a filename from the webview cannot point the save dialog elsewhere', () => {
    const rpc = readFileSync(path.join(here, '..', 'src/rpcDispatcher.ts'), 'utf8');
    assert.match(rpc, /RpcDispatcher\.safeFilename\(filename\)/, 'joinPath resolves ".." like any path join');
    assert.match(rpc, /static safeFilename\(name: string\): string \{/);
  });
}

// ---------------------------------------------------------------------------
// The session charts and the sessions table.
// ---------------------------------------------------------------------------
console.log('\nsession charts and table');
{
  const css = readFileSync(path.join(here, '..', 'src/webview/styles.css'), 'utf8');
  const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');

  /** Hue angle in degrees, for a cheap "are these actually different colours" check. */
  const hueOf = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === min) return null;
    const d = max - min;
    const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return ((h * 60) + 360) % 360;
  };
  const bucketsIn = (block) => ['cache-read', 'cache-write', 'output', 'input']
    .map((k) => block.match(new RegExp(`--bucket-${k}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1]);

  test('the four token buckets are four different colours, in every theme', () => {
    // They were #d97706 and #f59e0b — two steps of the same orange, 10.8 ΔE
    // apart for normal vision against a floor of 15. The bands were adjacent
    // segments of one bar, so nobody could tell which was which.
    // Every rule that sets a bucket colour, wherever it lives: the light :root,
    // the editor's dark themes, and the standalone page's OS-dark block. Each
    // has to define the whole set — a scope that redefines two of the four
    // leaves the other two on the palette of the opposite theme, which is how
    // a dark IDE ended up drawing light-surface hexes.
    const blocks = css.match(/\{[^{}]*--bucket-cache-read:[^{}]*\}/g) || [];
    assert.equal(blocks.length, 3, 'expected a light, an editor-dark and a standalone-dark palette');
    for (const block of blocks) {
      const name = bucketsIn(block).join('/');
      const hexes = bucketsIn(block);
      assert.ok(hexes.every(Boolean), `${name} does not define all four buckets`);
      assert.equal(new Set(hexes).size, 4, `${name} reuses a colour across buckets`);
      for (let i = 0; i < hexes.length; i += 1) {
        for (let j = i + 1; j < hexes.length; j += 1) {
          const [a, b] = [hueOf(hexes[i]), hueOf(hexes[j])];
          const apart = Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
          assert.ok(apart >= 45,
            `${name}: ${hexes[i]} and ${hexes[j]} are ${apart.toFixed(0)}° apart — same hue family`);
        }
      }
    }
  });

  test('stacked segments are separated by a surface gap, not just by hue', () => {
    assert.match(css, /\.bd-seg \{[^}]*box-shadow: 2px 0 0 0 var\(--panel\)/);
    assert.match(css, /\.bd-seg:last-child \{ box-shadow: none; \}/);
  });

  test('the timeline is one plot — the token row that redrew it is gone', () => {
    // Cost is very nearly a linear function of tokens sent (r = 0.99 on real
    // usage), so a second row of bars drew the same shape twice, and the
    // stacked cost bar already shows which bucket the tokens landed in.
    for (const gone of ['tokensSent', 'tl-ctx-plot', 'tl-ctx-bar', 'tl-sub']) {
      assert.ok(!main.includes(gone), `${gone} should have gone with the sub-plot`);
      assert.ok(!css.includes(gone), `${gone} should have gone from the stylesheet`);
    }
  });

  test('a summarising turn is still striped in the cost plot', () => {
    const fn = main.slice(main.indexOf('function renderSessionTimeline'), main.indexOf('function showTimelineTip'));
    assert.match(fn, /tl-compaction/);
    assert.match(css, /\.tl-compaction \{/);
  });

  test('the sessions table fits its width instead of scrolling sideways', () => {
    // One 45-character models cell used to set the table's minimum width, so
    // the whole table scrolled horizontally to serve a single column.
    const cell = css.match(/\.sessions-table \.session-models \{[^}]*\}/)[0];
    assert.match(cell, /max-width: \d+px/);
    assert.match(cell, /white-space: normal/);
    // A hyphen is its own break opportunity, so no overflow-wrap value keeps
    // "cursor-grok-4.6-high" together — only nowrap on the name does.
    assert.match(css, /\.session-model \{ white-space: nowrap; \}/);
    assert.match(main, /<span class="session-model">/);
  });

  test('each sessions column header sits over its own data', () => {
    assert.match(css, /\.sessions-table thead th \{ text-align: center; \}/);
    // The name column is text and stays left, with its header over the names.
    assert.match(css, /\.sessions-table thead th:first-child,\s*\n\.sessions-table thead th:nth-child\(2\) \{ text-align: left; \}/);
    for (const cls of ['session-started', 'session-duration', 'session-requests', 'session-cost']) {
      assert.ok(main.includes(`class="${cls}"`), `the ${cls} column needs a class to be aligned by`);
    }
  });
}

// ---------------------------------------------------------------------------
// Saying only what the numbers support.
// ---------------------------------------------------------------------------
console.log('\nthe context/answer claim');
{
  const ins = await loadTs('src/webview/insights.js', 'insights4.mjs');
  const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');
  const brief = readFileSync(path.join(here, '..', 'src/webview/brief.js'), 'utf8');
  const html = readFileSync(path.join(here, '..', 'src/html.ts'), 'utf8');

  const split = (b) => ins.spendSplit({ total: 100, ...b });

  test('an activity that did not happen is not named', () => {
    // cacheWrite is 0 for every request on some accounts, so "re-reading and
    // re-caching the conversation" was describing something that never
    // occurred — beside a row reading $0.
    assert.equal(split({ cacheRead: 70, cacheWrite: 0, output: 20, input: 10 }).contextLabel,
      're-reading the conversation');
    assert.equal(split({ cacheRead: 40, cacheWrite: 30, output: 20, input: 10 }).contextLabel,
      're-reading and re-caching the conversation');
    assert.equal(split({ cacheRead: 0, cacheWrite: 60, output: 30, input: 10 }).contextLabel,
      'writing the conversation to cache');
    assert.equal(split({ cacheRead: 0, cacheWrite: 0, output: 70, input: 30 }).contextLabel, null,
      'with no cache activity at all the clause is dropped, not left empty');
  });

  test('the prompt is never counted as the answer', () => {
    // The leftover after context is output + input. Reported as "the answers
    // themselves" it overstated the answer's share by nearly double on a
    // session that was 14.5% output and 12.4% input.
    const s = split({ cacheRead: 73, cacheWrite: 0, output: 15, input: 12 });
    assert.equal(Math.round(s.contextPct), 73);
    assert.equal(Math.round(s.outputPct), 15);
    assert.equal(Math.round(s.inputPct), 12);
    // The invariant is that the answer figure is output alone. Deriving it as
    // "everything that wasn't context" is exactly the bug: that leftover is
    // output + input.
    for (const [name, src] of [['the session panel', main], ['the brief', brief]]) {
      assert.ok(!/100 - (split\.)?contextPct/.test(src),
        `${name} still derives the answer share as the leftover after context`);
    }
    assert.ok(main.includes('split.outputPct') && main.includes('split.inputPct'),
      'the session panel reports output and input as their own figures');
    assert.ok(brief.includes('split.outputPct') && brief.includes('split.inputPct'),
      'and so does the brief');
    assert.ok(main.includes('the prompts you sent'), 'and names input for what it is');
    assert.ok(brief.includes('prompts I sent'));
    assert.ok(!/as opposed to the answer itself/.test(html),
      'the timeline caption called the whole unshaded part the answer');
  });

  test('an empty bucket reads as zero rather than as a rounding artefact', () => {
    const fn = main.slice(main.indexOf('function moneyFine'), main.indexOf('function insightBadge'));
    assert.match(fn, /if \(v === 0\) return '\$0';/);
  });

  test('a token count is read by presence, so a real zero is never overridden', () => {
    const api = readFileSync(path.join(here, '..', 'src/api.ts'), 'utf8');
    const fn = api.slice(api.indexOf('function pickTokens'), api.indexOf('let loggedTokenShape'));
    assert.match(fn, /!== undefined/, 'a present-and-zero field is an answer, not a miss');
    assert.ok(!/\|\|/.test(fn), 'truthiness here would swap a real 0 for an alias');
    // Cache write reads 0 on every request for some accounts; there is no way
    // to tell a reported zero from a key we never read without seeing the shape.
    assert.match(api, /Usage event tokenUsage shape:/, 'the shape has to be diagnosable from the logs');
    assert.match(api, /resetTokenShapeLog\(\);/, 'and re-reported on each load, not once per window');
  });
}

console.log('\none card per lesson');
{
  const { dedupeFindings, FINDING_CARD_LIMIT } = await loadTs('src/webview/insights.js', 'insights5.mjs');
  const blowup = (id, impact) => ({
    id: `context-blowup:${id}`, rule: 'context-blowup', severity: 'high', impact,
    anchor: { requestId: id }, title: `Context grew — ${impact}`, body: 'b', action: 'a',
  });

  test('a rule that fired repeatedly is one card, not one per request', () => {
    const cards = dedupeFindings([blowup('r1', 6.81), blowup('r2', 4.36), blowup('r3', 3.47)]);
    assert.equal(cards.length, 1);
    assert.equal(cards[0].anchor.requestId, 'r1', 'the dearest instance is the one worth opening');
  });

  test('folding the repeats keeps their dollars on the card', () => {
    const [card] = dedupeFindings([blowup('r1', 6.81), blowup('r2', 4.36), blowup('r3', 3.47)]);
    assert.equal(card.related.count, 2);
    assert.ok(Math.abs(card.related.dollars - 7.83) < 1e-9, 'every instance but the lead');
  });

  test('the lead is the dearest however the list arrived', () => {
    const [card] = dedupeFindings([blowup('r3', 3.47), blowup('r1', 6.81), blowup('r2', 4.36)]);
    assert.equal(card.anchor.requestId, 'r1');
    assert.ok(Math.abs(card.related.dollars - 7.83) < 1e-9);
  });

  test('a rule that fired once carries no tally at all', () => {
    const [card] = dedupeFindings([blowup('r1', 6.81)]);
    assert.equal(card.related, undefined);
  });

  test('different rules stay separate — that is the whole point', () => {
    const cards = dedupeFindings([
      blowup('r1', 6.81), blowup('r2', 4.36),
      { rule: 'model-switch', severity: 'high', impact: 7.8, anchor: { requestId: 'r9' }, title: 't', body: 'b', action: 'a' },
    ]);
    assert.deepEqual(cards.map((f) => f.rule), ['model-switch', 'context-blowup']);
  });

  test('period findings have no rule, so their title keys them', () => {
    const cards = dedupeFindings([
      { severity: 'medium', title: 'Low cache hit rate', body: 'b', action: 'a' },
      { severity: 'medium', title: 'Heavy output requests', body: 'b', action: 'a' },
    ]);
    assert.equal(cards.length, 2);
  });

  test('positives never outrank real money', () => {
    const cards = dedupeFindings([
      { rule: 'cache-ok', severity: 'positive', impact: 0, title: 'p', body: 'b', action: 'a' },
      blowup('r1', 1.2),
    ]);
    assert.equal(cards[0].rule, 'context-blowup');
  });

  test('three cards is the cap, and the rest are reachable rather than dropped', () => {
    assert.equal(FINDING_CARD_LIMIT, 3);
    const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');
    const fn = main.slice(main.indexOf('function renderFindingGrid'), main.indexOf('/** Moves the user to a request'));
    assert.match(fn, /slice\(0, FINDING_CARD_LIMIT\)/, 'the grid is capped');
    assert.match(fn, /dedupeFindings\(findings\)/, 'and deduped before it is capped');
    assert.match(fn, /findings-more/, 'with the remainder behind a button');
    // Held in state, not in the DOM: every filter change re-renders the grid.
    assert.match(main, /expandedFindings: new Set\(\)/);
  });

  test('the brief says each finding once too', () => {
    const brief = readFileSync(path.join(here, '..', 'src/webview/brief.js'), 'utf8');
    const fn = brief.slice(brief.indexOf('function findingsBlock'), brief.indexOf('function ratesBlock'));
    assert.match(fn, /dedupeFindings\(findings\)/);
  });
}

console.log('\nthe session comparison table');
{
  const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');
  const css = readFileSync(path.join(here, '..', 'src/webview/styles.css'), 'utf8');
  const fn = main.slice(main.indexOf('function renderModelDeltaTable'), main.indexOf('/** The inline from/to editor'));

  test('the difference column says which way it reads', () => {
    // Two sessions have no inherent order, so "Change" left the sign meaning
    // whichever direction the reader assumed. The metrics table directly above
    // already spells it out; these now agree word for word.
    assert.match(main, /changeLabel: 'Difference'/);
    assert.match(main, /changeSub: 'A against B'/);
    assert.match(main, /<span class="compare-col-days">A against B<\/span>/,
      'the metrics table it has to match');
  });

  test('a period comparison keeps its own wording — it has a time direction', () => {
    assert.match(fn, /changeLabel = 'Change'/);
    assert.match(fn, /changeSub = ''/);
  });

  test('a model only one side ran shows a dash, not $0.00 across 0 requests', () => {
    // "never used it" and "used it and it came to nothing" are different
    // statements. The matrix shown for three or more sessions always drew this
    // distinction; the two-session table did not.
    assert.match(fn, /const modelsIn = \(events\) => new Set\(events\.map\(\(e\) => e\.model\)\)/,
      'presence comes from the events, not from a cost or a counted-request tally');
    assert.match(fn, /'<td class="cell-absent">—<\/td>'/);
    assert.match(fn, /const tag = !inBase/, 'the tag keys on presence too');
  });

  test('no percentage is offered against a side that never ran the model', () => {
    assert.match(fn, /\{ pct: inCur && inBase \}/);
    const cell = main.slice(main.indexOf('function deltaCell'), main.indexOf('function renderModelDeltaTable'));
    assert.match(cell, /pct: withPct = true/);
    assert.match(cell, /if \(!withPct\) \{\s*\n?\s*pct = '';/);
  });

  test('the row label contains its own content instead of running into the figures', () => {
    assert.match(fn, /<span class="compare-model-label">/);
    assert.match(fn, /<span class="compare-model-name"/);
    assert.match(fn, /title="\$\{esc\(d\.model\)\}"/, 'a clipped name keeps the whole of it on the title');
    const label = css.match(/\.compare-model-label \{[^}]*\}/)[0];
    assert.match(label, /flex-wrap: wrap/, 'the badge drops below the name only when it has to');
    assert.match(label, /min-width: 0/, 'without this a flex item refuses to shrink and overflows');
    const name = css.match(/\.compare-model-name \{[^}]*\}/)[0];
    for (const rule of ['overflow: hidden', 'text-overflow: ellipsis', 'white-space: nowrap']) {
      assert.ok(name.includes(rule), `the name needs "${rule}" so it clips rather than breaking mid-identifier`);
    }
  });

  test('the label column fits the longest model name Cursor bills under', () => {
    // Measured in the browser at 224px for "claude-sonnet-5-thinking-medium",
    // plus the cell's 10px padding either side. Narrower and the reasoning
    // effort is what falls off the end — and medium and high are different
    // rows at different prices.
    const width = Number(css.match(/\.sessions-compare-table th:first-child \{ width: (\d+)px; \}/)[1]);
    assert.ok(width >= 244, `label column is ${width}px, too narrow for a 224px name plus padding`);
  });
}

console.log('\ngetting from an expensive request to its session');
{
  const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');

  test('the expensive-request table carries the session it came from', () => {
    const fn = main.slice(main.indexOf('function renderAnalyzeExpensivePanel'),
      main.indexOf('function renderThresholdInputs'));
    assert.match(fn, /sessionCellFor\(e\.conversationId \|\| null\)/);
    assert.match(fn, /<th>Session<\/th>/);
    // Seven columns now, and the empty-state row has to span all of them or it
    // sits under one header instead of the table.
    assert.equal((fn.match(/<th[ >]/g) || []).length, 7, '<thead> is not a column');
    assert.match(fn, /colspan="7"/);
  });

  test('the names are fetched for this table too, not just the request log', () => {
    // They come from a local database and arrive after the first paint; without
    // this every row reads as a raw conversation id.
    const fn = main.slice(main.indexOf('function renderAnalyzeExpensivePanel'),
      main.indexOf('function renderThresholdInputs'));
    assert.match(fn, /loadSessionTitles\(expensive\.map/);
  });

  test('both tables build the cell the same way', () => {
    // One helper, so the log and Analyze cannot drift into different labels or
    // a different affordance for the same question.
    assert.equal((main.match(/class="btn-link session-link/g) || []).length, 1,
      'the markup lives in sessionCellFor and nowhere else');
    assert.equal((main.match(/sessionCellFor\(/g) || []).length, 3, 'defined once, called from both tables');
  });

  test('a session link opens the dialog from wherever it is rendered', () => {
    assert.match(main, /\.finding-session, \.session-open, \.session-link/);
  });

  test('clicking one in the log opens the session without also toggling the row', () => {
    // Two listeners see the click. The row handler has to bow out, and it must
    // not open the dialog itself or the delegated handler opens it twice.
    const fn = main.slice(main.indexOf("$('tableBody')?.addEventListener"), main.indexOf('// Findings carry their own links'));
    assert.match(fn, /if \(ev\.target\.closest\('\.session-link'\)\) return;/);
    assert.ok(!/closest\('\.session-link'\)[\s\S]{0,120}openSessionDetail/.test(fn),
      'the row handler must not open the dialog as well');
  });
}

console.log('\nthe Auto rate, and saying which one is on screen');
{
  const MODELS_MD = ['## Model pricing', '',
    '| Model | Input | Cache write | Cache read | Output |',
    '| :--- | :--- | :--- | :--- | :--- |',
    '| Claude 4.5 Sonnet | $3.00 | $3.75 | $0.30 | $15.00 |', ''].join('\n');
  const withAuto = (rowName) => parsePricing(['## Auto Cost', '',
    '| Name | Input | Cache Write | Cache Read | Output |',
    '| :--- | :--- | :--- | :--- | :--- |',
    `| ${rowName} | $1.25 | $1.25 | $0.25 | $6 |`, '', MODELS_MD].join('\n'));

  test('the published Auto row is read, including a whole-dollar rate', () => {
    const p = withAuto('Auto Cost');
    assert.deepEqual(p.auto, { input: 1.25, cacheWrite: 1.25, cacheRead: 0.25, output: 6 });
    assert.equal(p.autoFallback, false, 'this is a scrape, not the built-in rate');
  });

  test('an Auto row named for what it prices is still found by its heading', () => {
    // "All models", "Any model" — the row need not carry the word Auto when the
    // section above it does, and it is the only priced row there.
    const p = withAuto('All models');
    assert.equal(p.auto.input, 1.25);
    assert.equal(p.autoFallback, false);
  });

  test('a model whose own name contains "auto" never stands in for the bundle', () => {
    const p = parsePricing(['## Model pricing', '',
      '| Model | Input | Cache write | Cache read | Output |',
      '| :--- | :--- | :--- | :--- | :--- |',
      '| Autocoder 2 | $3.00 | $3.75 | $0.30 | $15.00 |',
      '| Claude 4.5 Sonnet | $3.00 | $3.75 | $0.30 | $15.00 |'].join('\n'));
    assert.equal(p.autoFallback, true, 'two priced rows in that section — not an Auto table');
  });

  test('when the Auto rate is missing, the log says what the page did have', () => {
    const p = parsePricing(['## Auto Cost', '', '<AutoPricingTable />', '', MODELS_MD].join('\n'));
    assert.equal(p.autoFallback, true);
    const said = describePricingScrape(p);
    assert.match(said, /no Auto rate — using the built-in one/);
    assert.match(said, /Model pricing/, 'the tables it did find are the whole point of the line');
    assert.match(said, /Model \| Input/, 'with their headers, so a renamed column is visible');
  });

  test('a healthy scrape says so in one line', () => {
    assert.match(describePricingScrape(withAuto('Auto Cost')), /Auto rate read from the page/);
  });
}

console.log('\nan omitted bucket is not a zero');
{
  const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');
  const brief = readFileSync(path.join(here, '..', 'src/webview/brief.js'), 'utf8');
  const api = readFileSync(path.join(here, '..', 'src/api.ts'), 'utf8');
  const raw = (tokenUsage) => ({
    id: 'r1', timestamp: Date.now(), model: 'claude-sonnet-5-thinking-medium',
    isTokenBasedCall: true, chargedCents: 12, tokenUsage,
  });

  test('a payload carrying a count is reported, zero or not', () => {
    for (const n of [30806, 0]) {
      const e = normalize(raw({ inputTokens: 10, cacheWriteTokens: n, unreportedBuckets: [] }), pricing);
      assert.deepEqual(e.unreportedBuckets, [], `cacheWriteTokens: ${n} is a measurement`);
      assert.equal(e.cacheWriteTokens, n);
    }
  });

  test('a bucket with no count is listed, and still counts as 0 for arithmetic', () => {
    const e = normalize(raw({ inputTokens: 10, unreportedBuckets: ['cacheWrite'] }), pricing);
    assert.deepEqual(e.unreportedBuckets, ['cacheWrite']);
    assert.equal(e.cacheWriteTokens, 0, 'the sums still need a number');
  });

  test('an event from before the flag existed is treated as fully reported', () => {
    const e = normalize(raw({ inputTokens: 10, cacheWriteTokens: 5 }), pricing);
    assert.deepEqual(e.unreportedBuckets, []);
  });

  test('presence is computed for every bucket, not just the one that broke', () => {
    // Which field an upstream change drops next is not worth predicting.
    const fn = api.slice(api.indexOf('const TOKEN_ALIASES'), api.indexOf('function unreportedOf'));
    for (const bucket of ['input:', 'output:', 'cacheRead:', 'cacheWrite:']) {
      assert.ok(fn.includes(bucket), `${bucket} needs an alias list of its own`);
    }
    assert.match(api, /unreportedBuckets: unreportedOf\(tu\)/);
  });

  test('a bucket is unknown only when every request in view omitted it', () => {
    const fn = main.slice(main.indexOf('function unreportedBuckets'), main.indexOf('const BUCKET_TOKEN_FIELD'));
    assert.match(fn, /shared\.delete\(key\)/, 'one reporting request makes the total real, if partial');
    assert.match(fn, /if \(!list\.length\) return new Set\(\)/, 'an empty list is not "unknown"');
  });

  test('every token cell in the log can show a dash', () => {
    for (const bucket of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      assert.ok(main.includes(`tokenCell(e, '${bucket}')`), `${bucket} goes through tokenCell`);
    }
    const fn = main.slice(main.indexOf('function tokenCell'), main.indexOf('function insightBadge'));
    assert.match(fn, /missing \? UNREPORTED : fmt\.num/);
  });

  test('the cost breakdown drops the figure for any missing bucket and says which', () => {
    const fn = main.slice(main.indexOf('function renderBreakdown'), main.indexOf('/** Moves the user to a request'));
    assert.match(fn, /const missing = unreported\.has\(key\)/, 'any bucket, not one hardcoded');
    assert.match(fn, /missing \? UNREPORTED : moneyFine/);
    assert.match(fn, /missing \? UNREPORTED : fmt\.pct/);
    assert.match(fn, /Cursor sent no \$\{\[\.\.\.unreported\]/, 'the note names what is actually missing');
  });

  test('no user-facing copy dates or explains the outage', () => {
    // It may come back, and the next gap may be a different bucket for a
    // different reason. The interface describes the payload in front of it;
    // when it broke belongs in the changelog.
    for (const [name, src] of [['main.js', main], ['brief.js', brief]]) {
      const copy = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
      assert.ok(!/August 2026/.test(copy.join('\n')), `${name} must not date the outage in user-facing text`);
      assert.ok(!/stopped reporting|no longer says/.test(copy.join('\n')),
        `${name} must not narrate a cause that may not hold next time`);
    }
  });

  test('the CSV leaves any missing count blank instead of writing 0', () => {
    const fn = main.slice(main.indexOf('function csvToken'), main.indexOf('function exportCsv'));
    assert.match(fn, /includes\(bucket\) \? '' :/);
    for (const bucket of ['input', 'output', 'cacheRead', 'cacheWrite']) {
      assert.ok(main.includes(`csvToken(e, '${bucket}')`), `${bucket} goes through csvToken`);
    }
  });

  test('the brief says absent in words, so the model cannot reason from a zero', () => {
    assert.match(brief, /not reported by Cursor \(unknown, not zero\)/);
    assert.match(main, /not reported by Cursor \(unknown, not zero\)/);
    // "rewrote not reported by Cursor tokens to cache" is not a sentence.
    assert.match(brief, /reported\(event, 'cacheWrite'\)/, 'the idle-resume clause is dropped, not filled');
  });
}

// ---------------------------------------------------------------------------
// Faults found reviewing this branch end to end. Each one rendered or read
// wrongly without throwing, so nothing above would have caught them.
// ---------------------------------------------------------------------------
console.log('\nthe review pass over the dashboard chrome');
{
  const main = readFileSync(path.join(here, '..', 'src/webview/main.js'), 'utf8');
  const html = readFileSync(path.join(here, '..', 'src/html.ts'), 'utf8');
  const css = readFileSync(path.join(here, '..', 'src/webview/styles.css'), 'utf8');

  test('every button in the markup carries a class the stylesheet paints', () => {
    // "btn-primary" is not a class this stylesheet has ever had — .btn.primary
    // is — so the Save in the discount editor and the "Add a discount" in the
    // Simulator intro rendered as raw native buttons: grey, square, 2px outset,
    // beside the styled ones they sit next to. Checked per button rather than
    // per class: plenty of classes here are click hooks for a delegated
    // listener (.session-open, .btn-compare) and are not meant to paint
    // anything — but a button all of whose classes are unknown to the
    // stylesheet is a button nothing is styling.
    const defined = new Set([...css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)/g)].map((m) => m[1]));
    for (const [name, src] of [['main.js', main], ['html.ts', html]]) {
      for (const m of src.matchAll(/<button\b[^>]*?\bclass="([^"$]*)"/g)) {
        const classes = m[1].split(/\s+/).filter(Boolean);
        if (!classes.length) continue;
        assert.ok(classes.some((cls) => defined.has(cls)),
          `${name} has a <button class="${m[1]}"> that styles.css never paints`);
      }
    }
  });

  test('the billing banner is drawn on arrival at the request log, not only by a refresh', () => {
    // setAppView() is the only path onto the Requests tab and it does not call
    // refresh(), so a banner rendered solely from renderKpis() stayed hidden
    // until an unrelated redraw (a sort, a page change) happened to run.
    assert.ok(main.includes('function renderBillingNotice(summary)'),
      'the banner needs a renderer of its own to be callable from both');
    const setAppView = main.slice(main.indexOf('function setAppView(view)'));
    assert.match(setAppView.slice(0, setAppView.indexOf('\n}')), /renderBillingNotice\(state\.summary\)/);
    // And it owns its own visibility, so no caller can leave it up on a view it
    // does not belong to.
    const fn = main.slice(main.indexOf('function renderBillingNotice(summary)'));
    assert.match(fn, /state\.appView !== 'usage'/);
    assert.match(fn, /billingEl\.classList\.add\('hidden'\)/);
  });

  test('rich text in an alert goes inside .alert-msg, because .alert is a flex row', () => {
    // `.alert` is display:flex so the dismiss button can sit beside the message.
    // Prose dropped straight into it turns every <strong>, <code> and <a> into a
    // flex item: the billing banner rendered as a row of ragged columns rather
    // than as a sentence.
    assert.match(css, /\.alert \{[^}]*display: flex;/s, 'the flex row is what makes the wrapper necessary');
    assert.match(css, /\.alert \.alert-msg \{[^}]*flex: 1/);
    const fn = main.slice(main.indexOf('function renderBillingNotice(summary)'));
    assert.match(fn.slice(0, fn.indexOf('\n}')), /billingEl\.innerHTML = `<span class="alert-msg">/);
    // showAlert() has always done it; this is the same rule.
    const alertFn = main.slice(main.indexOf('function showAlert'), main.indexOf('function hideAlert'));
    assert.match(alertFn, /class="alert-msg"/);
  });

  test('the timeline tooltip escapes its lines once, not twice', () => {
    // The whole list is escaped where it is interpolated, so a line that
    // escaped itself first put "&amp;" on screen for any model name carrying
    // an ampersand — the tip is written with textContent, which decodes nothing.
    const fn = main.slice(main.indexOf('function renderSessionTimeline'), main.indexOf('function showTimelineTip'));
    assert.ok(!/^\s*esc\(event\.model\),/m.test(fn), 'the model line must go in raw');
    assert.match(fn, /data-tl-tip="\$\{esc\(lines\.join/, 'and the join is what gets escaped');
  });

  test('editing a finding threshold rebuilds the findings every surface reads', () => {
    // buildInsights() takes these thresholds too, and its findings badge the
    // request rows, the session list and the Overview card. Re-rendering only
    // the Analyze tab moved that panel's counts and left everywhere else
    // showing findings computed at the old threshold.
    const handler = main.slice(main.indexOf("$('analyzeThresholds')?.addEventListener"));
    const body = handler.slice(0, handler.indexOf("$('analyzeThresholdsReset')"));
    assert.match(body, /refresh\(\);/);
    assert.ok(!/renderAnalyze\(\);/.test(body), 'renderAnalyze alone leaves state.insights stale');
    const reset = main.slice(main.indexOf("$('analyzeThresholdsReset')?.addEventListener"));
    assert.match(reset.slice(0, reset.indexOf('});')), /refresh\(\);/);
  });

  test('the Overview card counts the findings Analyze will actually show', () => {
    // Analyze renders dedupeFindings(...); counting the raw list here promised
    // "6 more findings" against a tab that had three cards to give.
    const fn = main.slice(main.indexOf('function renderOverview'), main.indexOf('let loadSeq = 0'));
    assert.match(fn, /const ranked = dedupeFindings\(data\.findings\)/);
    assert.match(fn, /pickTopFinding\(ranked\)/, 'and leads on a card from that same list');
    assert.match(fn, /const others = ranked\.length - 1/);
  });

  test('a finding quotes the threshold that fired it, not a number baked into the sentence', () => {
    const fn = main.slice(main.indexOf('function buildAnalyzeFindings'));
    const body = fn.slice(0, fn.indexOf('\nfunction renderAnalyzeHero'));
    assert.ok(!/exceeded 2k output tokens/.test(body),
      'the heavy-output card must not hardcode a threshold the user can change');
    assert.match(body, /thresholds\.heavyOutputTokens\)\} output tokens/);
  });

  test('the Analyze derivation is not rebuilt on every keystroke in the question box', () => {
    // updateBriefPreview() is bound to `input` on the custom-question textarea,
    // and it used to run the whole derivation — sorting every event in the
    // range, rebuilding every finding — once per character typed.
    assert.match(main, /let analyzeCache = \{ events: null, data: null \};/);
    assert.match(main, /if \(analyzeCache\.events === events\) return analyzeCache\.data;/,
      'keyed on the array refresh() replaces, so nothing can leave it stale');
    const code = main.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    assert.equal([...code.matchAll(/computeAnalyzeData\(/g)].length, 2,
      'only analyzeDataFor and the definition itself may call it directly');
    assert.equal([...code.matchAll(/analyzeDataFor\(/g)].length, 4,
      'the Overview card, the Analyze tab and the brief all go through the cache');
  });

  test('the request log reuses the summary refresh() already built', () => {
    // Three call sites re-derived it with summarize(state.filtered) — six more
    // passes over the range every time a row was expanded — and the ad-hoc copy
    // was missing the cost-mode fields the real one carries.
    assert.ok(!/renderTable\(state\.filtered, summarize\(state\.filtered\)\)/.test(main));
    assert.equal([...main.matchAll(/renderTable\(state\.filtered, state\.summary\)/g)].length, 3);
    const refresh = main.slice(main.indexOf('function refresh()'));
    assert.match(refresh.slice(0, refresh.indexOf('\n}')), /state\.summary = summary;/,
      'and refresh() is the one place that sets it');
  });

  test('a comparison row of zeroes earns its place the way the errored row does', () => {
    const fn = main.slice(main.indexOf('function sessionMetricDefs'), main.indexOf('function sessionCompareContext'));
    const cold = fn.slice(fn.indexOf("label: 'Cold starts'"));
    assert.match(cold.slice(0, cold.indexOf('},')), /when: \(ctxs\) => ctxs\.some/);
  });
}

console.log('\nthe suite itself');
{
  const suite = readFileSync(path.join(here, 'run-tests.mjs'), 'utf8');

  test('webview modules are loaded through the bundler, never imported raw', () => {
    // src/webview/*.js imports src/shared/usageLogic.ts. Node 22 strips the
    // types and loads it; CI's Node 20 throws ERR_UNKNOWN_FILE_EXTENSION. So a
    // bare import() of one of these passes locally and fails only on CI —
    // loadTs bundles it and works on both.
    const raw = suite.match(/import\(\s*'\.\.\/src\/[^']+'/g) || [];
    assert.deepEqual(raw, [], 'use loadTs(...) instead of importing src/ directly');
  });

  test('an async test that is not awaited still decides the exit code', () => {
    assert.match(suite, /const running = \[\];/);
    assert.match(suite, /running\.push\(settled\);/);
    assert.match(suite, /await Promise\.all\(running\);/);
  });
}

await Promise.all(running);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
