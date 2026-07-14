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
  estimateTokenCost,
  cacheSavingsFor,
  displayModel,
  normalize,
  summarize,
  detectBillingMode,
  isCountedRequest,
  percentile,
  projectExhaustionDate,
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
  assert.equal(pricing.models.length, 4);
  const sonnet = pricing.models.find((m) => m.display === 'Claude 4.5 Sonnet');
  assert.deepEqual(
    [sonnet.input, sonnet.cacheWrite, sonnet.cacheRead, sonnet.output],
    [3.0, 3.75, 0.3, 15.0],
  );
  const gpt = pricing.models.find((m) => m.display === 'GPT-5.2');
  assert.equal(gpt.cacheWrite, null);
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
test('unknown model returns null', () => {
  assert.equal(matchPricing('mystery-model-9000', pricing), null);
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
test('percentile', () => {
  assert.equal(percentile([1, 2, 3, 4], 0.75), 4);
  assert.equal(percentile([], 0.75), null);
});
test('displayModel maps default/auto', () => {
  assert.equal(displayModel('default'), 'Auto');
  assert.equal(displayModel('gpt-5.2'), 'gpt-5.2');
});

// --- TS modules -----------------------------------------------------------

const authCore = await loadTs('src/authCore.ts', 'authCore.mjs');
const api = await loadTs('src/api.ts', 'api.mjs');

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
