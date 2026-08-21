#!/usr/bin/env node
'use strict';

// Generates realistic-looking fixture data for the demo webview harness and
// writes it to demo/data.js as `window.__DEMO_DATA__`. Nothing here talks to
// cursor.com or a real Cursor install — every figure is synthetic, built to
// exercise every tab of the dashboard (Overview burn-rate, Requests +
// Analytics, Analyze Findings/Compare/Sessions, Simulator discount) with
// plausible-looking numbers.
//
// Re-run with `node demo/generate-fixtures.mjs` any time the demo video needs
// to be re-recorded against fresh dates.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;
const now = Date.now();

// ---------------------------------------------------------------------------
// Billing cycle: current calendar month, business (dollar-metered) plan.
// ---------------------------------------------------------------------------

const nowDate = new Date(now);
const cycleStart = new Date(nowDate.getFullYear(), nowDate.getMonth(), 1);
const cycleEnd = new Date(nowDate.getFullYear(), nowDate.getMonth() + 1, 1);
const cycleStartMs = cycleStart.getTime();
const cycleEndMs = cycleEnd.getTime();

// ---------------------------------------------------------------------------
// Rate table — mirrors demo/pricing.md. Used only to synthesize plausible
// tokenUsage.totalCents ("list" cost) per event; matchPricing() in the real
// client parses demo/pricing.md independently, so figures are close but not
// bit-identical, same as real accounts.
// ---------------------------------------------------------------------------

const RATES = {
  'claude-4-5-sonnet': { input: 3.0, cacheWrite: 3.75, cacheRead: 0.3, output: 15.0 },
  'gpt-5.2': { input: 1.75, cacheWrite: 1.75, cacheRead: 0.18, output: 14.0 },
  'cursor-grok-4.6-high': { input: 2, cacheWrite: 2, cacheRead: 0.5, output: 6 },
  'composer-2-5': { input: 0.5, cacheWrite: 0.5, cacheRead: 0.2, output: 2.5 },
  auto: { input: 1.25, cacheWrite: 1.25, cacheRead: 0.25, output: 6.0 },
};

const MODEL_WEIGHTS = [
  ['claude-4-5-sonnet', 0.4],
  ['gpt-5.2', 0.2],
  ['cursor-grok-4.6-high', 0.2],
  ['composer-2-5', 0.15],
  ['auto', 0.05],
];

function pickModel(rand) {
  const r = rand();
  let acc = 0;
  for (const [model, w] of MODEL_WEIGHTS) {
    acc += w;
    if (r <= acc) return model;
  }
  return MODEL_WEIGHTS[0][0];
}

// Deterministic PRNG so the recording is reproducible run to run.
function mulberry32(seed) {
  let a = seed;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260815);
const randInt = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const pick = (arr) => arr[randInt(0, arr.length - 1)];

function estimateCents(model, tokens) {
  const r = RATES[model];
  const cost = tokens.input * r.input / 1e6
    + tokens.output * r.output / 1e6
    + tokens.cacheRead * r.cacheRead / 1e6
    + tokens.cacheWrite * (r.cacheWrite ?? r.input) / 1e6;
  return Math.round(cost * 100);
}

// ---------------------------------------------------------------------------
// Conversation names — a small pool of realistic-looking coding session
// titles, matched to a subset of sessions the way Cursor's own local chat
// index would (some sessions stay unnamed and fall back to their id).
// ---------------------------------------------------------------------------

const SESSION_TITLES = [
  'Fix auth token refresh race condition',
  'Add CSV export to requests table',
  'Refactor budget runway math',
  'Debug flaky session-cache test',
  'Wire up cost simulator discount editor',
  'Investigate cache-read token spike',
  'Add sessions comparison tray',
  'Migrate status bar to new quota format',
  'Write findings threshold unit tests',
  'Speed up sql.js fallback for large state.vscdb',
  'Draft README budget-metered section',
  'Fix off-by-one in billing cycle window',
  'Add discount detection heuristics',
  'Polish Analyze tab empty states',
  'Handle plan-change straddling ranges',
  'Add compare-periods baseline shortcuts',
  'Debug chart.js tooltip formatting',
  'Extract shared usageLogic module',
  'Add Grok 4.6 pricing row',
  'Tune warn/critical status bar thresholds',
];

// ---------------------------------------------------------------------------
// Sessions: bursts of 1-14 requests, clustered across the last 45 days, with
// slightly heavier activity in the most recent week (a believable trend for
// the sparkline / daily-cost chart) and light weekend activity.
// ---------------------------------------------------------------------------

const WINDOW_DAYS = 45;
const sessions = [];
for (let d = WINDOW_DAYS; d >= 0; d--) {
  const dayDate = new Date(now - d * DAY_MS);
  const isWeekend = dayDate.getDay() === 0 || dayDate.getDay() === 6;
  const recencyBoost = d < 10 ? 1.4 : 1;
  const baseSessions = isWeekend ? randInt(0, 1) : randInt(1, 3);
  const sessionCount = Math.round(baseSessions * recencyBoost);
  for (let s = 0; s < sessionCount; s++) {
    const dayStart = new Date(dayDate.getFullYear(), dayDate.getMonth(), dayDate.getDate(), 9).getTime();
    const startMs = dayStart + randInt(0, 9) * 60 * 60 * 1000 + randInt(0, 59) * 60 * 1000;
    if (startMs > now) continue;
    sessions.push({
      id: `conv_${sessions.length.toString(36).padStart(6, '0')}`,
      startMs,
      length: randInt(1, 14),
      title: rand() < 0.7 ? pick(SESSION_TITLES) : null,
    });
  }
}

// One deliberately large/expensive session near the end of the window, so
// "Sessions" and "Compare sessions" both have a clear standout row.
sessions.push({
  id: 'conv_bignight',
  startMs: now - 2 * DAY_MS + 10 * 60 * 60 * 1000,
  length: 26,
  title: 'Big refactor: extract shared usageLogic module',
  heavy: true,
});

// ---------------------------------------------------------------------------
// Discount window: Grok 4.6 runs at an actual 40% discount, consistently,
// for one day — so detectDiscounts() picks it up as a measured promotion.
//
// Positioned three days back because that is when Cursor's real Grok 4.6
// promotion ran relative to when this demo was cut: a viewer who remembers
// the actual sale should see the badge on the day it actually happened, not
// on some arbitrary other day, or the whole feature reads as invented.
//
// Aligned to local calendar-day boundaries (matching dayKey() in
// src/webview/logic.js, which buckets by local day) rather than a raw
// now-relative offset — detectDiscounts() requires ~60% of a day's samples
// to agree within tolerance, and a window that starts or ends mid-day mixes
// discounted and full-price requests into the same day-bucket, which reads
// as "scattered" and gets rejected as noise instead of a real promotion.
// ---------------------------------------------------------------------------

const DISCOUNT_DAYS_AGO = 3;
const startOfLocalDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const discountStart = startOfLocalDay(new Date(now - DISCOUNT_DAYS_AGO * DAY_MS));
const discountEnd = discountStart + DAY_MS - 1;

// Detection needs at least three Grok requests inside that day before it will
// call a promotion, and the random session mix does not reliably produce them
// on any one given day. This session guarantees them — and, being all Grok on
// the discounted day, it also makes the day's samples agree with each other.
sessions.push({
  id: 'conv_grokday',
  startMs: discountStart + 10 * 60 * 60 * 1000,
  length: 9,
  title: 'Port streaming parser to Grok 4.6',
  forcedModel: 'cursor-grok-4.6-high',
});

// ---------------------------------------------------------------------------
// Story sessions — the two conversations the `session` cut of the demo video
// is about (see demo/SESSION-CUT-PLAN.md).
//
// These are hand-written turn by turn rather than drawn from the PRNG above,
// for two reasons. The findings this cut exists to show only fire on specific
// token shapes — a compaction is `cacheRead === 0 && cacheWrite === 0` with a
// large input, a stale resume needs a cache *write* past 100k tokens, a blowup
// needs 5x the session's median read — and a smooth random walk produces none
// of them. And the narration and the recording both have to stay true across
// re-runs, which a reproducible-but-random session cannot promise.
//
// Every number below is set against a threshold in INSIGHT_DEFAULTS
// (src/webview/insights.js). Changing one means re-checking the rule it feeds:
// demo/verify-story.mjs does exactly that, and is the reason to run it after
// touching anything here.
//
// `cacheRead` is the running context being re-sent each turn, so it climbs
// within a phase and resets where the thread is summarised or the cache has
// expired — the shape the session timeline draws as a swelling shaded band.
// ---------------------------------------------------------------------------

const STORY_MODEL = 'claude-4-5-sonnet';

// Session A: the conversation that got away. Four phases, in order — a cold
// start, an ordinary climb, one request that reads far more context than any
// other, Cursor summarising the thread, the thread growing straight back, and
// finally a resume hours later against an expired cache.
//
// gapMin is minutes since the previous turn; the 210-minute gap before turn 22
// is what makes it a stale resume rather than just another expensive request.
const AUTH_TURNS = [
  // Cold start: uncached, and big enough to clear coldStartInputTokens (3,000).
  { gapMin: 0, input: 7200, output: 900, cacheRead: 0, cacheWrite: 1400 },
  { gapMin: 3, input: 2400, output: 1100, cacheRead: 24000, cacheWrite: 300 },
  { gapMin: 4, input: 2100, output: 1300, cacheRead: 41000, cacheWrite: 260 },
  // The ordinary climb — context accumulating a turn at a time.
  { gapMin: 3, input: 2600, output: 950, cacheRead: 62000, cacheWrite: 280 },
  { gapMin: 5, input: 2300, output: 1500, cacheRead: 84000, cacheWrite: 240 },
  { gapMin: 4, input: 2500, output: 1200, cacheRead: 103000, cacheWrite: 300 },
  { gapMin: 3, input: 2200, output: 1000, cacheRead: 121000, cacheWrite: 250 },
  { gapMin: 6, input: 2700, output: 1600, cacheRead: 138000, cacheWrite: 320 },
  { gapMin: 4, input: 2400, output: 1100, cacheRead: 152000, cacheWrite: 270 },
  { gapMin: 3, input: 2100, output: 1300, cacheRead: 166000, cacheWrite: 240 },
  { gapMin: 5, input: 2600, output: 1400, cacheRead: 181000, cacheWrite: 290 },
  // Turn 12 — context blowup. 720k reads against a session median of ~121k is
  // just under 6x, past blowupMultiple (5), and the read is 99% of the
  // request's tokens, past blowupCacheShare (0.9).
  { gapMin: 4, input: 3000, output: 1500, cacheRead: 720000, cacheWrite: 200 },
  // Turn 13 — Cursor compacts. Zero cache either way with a large input is
  // what separates a compaction from a cold start; input clears
  // compactionMinInput (50,000).
  { gapMin: 3, input: 62000, output: 2600, cacheRead: 0, cacheWrite: 0 },
  // Relief: the four turns after the summary, well under the four before it.
  { gapMin: 4, input: 2200, output: 1000, cacheRead: 44000, cacheWrite: 260 },
  { gapMin: 3, input: 2400, output: 1200, cacheRead: 52000, cacheWrite: 240 },
  { gapMin: 5, input: 2100, output: 900, cacheRead: 61000, cacheWrite: 280 },
  { gapMin: 4, input: 2500, output: 1300, cacheRead: 73000, cacheWrite: 250 },
  // ...and then it grows back. Turn 19 passes the pre-compaction median, which
  // is what turns "summarising worked" into "worked, then the context grew
  // back" — the finding that carries the start-a-fresh-chat advice.
  { gapMin: 6, input: 2300, output: 1100, cacheRead: 128000, cacheWrite: 270 },
  { gapMin: 5, input: 2600, output: 1400, cacheRead: 197000, cacheWrite: 300 },
  { gapMin: 4, input: 2400, output: 1250, cacheRead: 262000, cacheWrite: 280 },
  { gapMin: 5, input: 2200, output: 1150, cacheRead: 318000, cacheWrite: 260 },
  // Turn 22 — back after exactly 3.5 hours, which is what the narration says. The prompt cache has expired, so the whole
  // accumulated thread is re-written at full price before any work happens.
  // cacheWrite clears staleResumeCacheWriteTokens (100,000), and stays
  // non-zero so this reads as a resume rather than a second compaction.
  { gapMin: 210, input: 4800, output: 1300, cacheRead: 0, cacheWrite: 240000 },
  { gapMin: 4, input: 2300, output: 1050, cacheRead: 96000, cacheWrite: 250 },
  { gapMin: 5, input: 2500, output: 1200, cacheRead: 142000, cacheWrite: 270 },
  { gapMin: 4, input: 2100, output: 980, cacheRead: 188000, cacheWrite: 240 },
  { gapMin: 6, input: 2600, output: 1350, cacheRead: 231000, cacheWrite: 290 },
];

// Session B: the counter-example, earlier the same day. Same shape of work,
// one compaction — but nothing after it climbs back to the pre-compaction
// level, so the rule resolves as plain "summarising worked".
//
// It takes a second session to show that outcome at all: one compaction
// resolves one way or the other, never both, so the good ending cannot be told
// on session A's timeline.
const CLEAN_TURNS = [
  { gapMin: 0, input: 6800, output: 900, cacheRead: 0, cacheWrite: 1300 },
  { gapMin: 4, input: 2200, output: 1000, cacheRead: 21000, cacheWrite: 240 },
  { gapMin: 3, input: 2400, output: 1200, cacheRead: 38000, cacheWrite: 260 },
  { gapMin: 5, input: 2100, output: 900, cacheRead: 57000, cacheWrite: 210 },
  { gapMin: 4, input: 2600, output: 1400, cacheRead: 79000, cacheWrite: 280 },
  { gapMin: 3, input: 2300, output: 1100, cacheRead: 98000, cacheWrite: 250 },
  { gapMin: 6, input: 2500, output: 1300, cacheRead: 116000, cacheWrite: 230 },
  { gapMin: 4, input: 2200, output: 1000, cacheRead: 133000, cacheWrite: 240 },
  // Compacted here — and this time the relief holds.
  { gapMin: 3, input: 54000, output: 2300, cacheRead: 0, cacheWrite: 0 },
  { gapMin: 5, input: 2000, output: 900, cacheRead: 32000, cacheWrite: 220 },
  { gapMin: 4, input: 2300, output: 1100, cacheRead: 38000, cacheWrite: 250 },
  { gapMin: 3, input: 2100, output: 1000, cacheRead: 44000, cacheWrite: 230 },
  { gapMin: 5, input: 2400, output: 1200, cacheRead: 51000, cacheWrite: 260 },
  // Ends below the pre-compaction median, so nothing here counts as regrowth.
  { gapMin: 4, input: 2200, output: 1050, cacheRead: 58000, cacheWrite: 240 },
];

const storyDayStart = (daysAgo, hour, minute = 0) => {
  const d = new Date(now - daysAgo * DAY_MS);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, minute).getTime();
};

sessions.push({
  id: 'conv_authnight',
  startMs: storyDayStart(2, 15),
  title: 'Refactor auth flow: session store + token refresh',
  forcedModel: STORY_MODEL,
  turns: AUTH_TURNS,
});

sessions.push({
  id: 'conv_cleanrun',
  startMs: storyDayStart(2, 9, 30),
  title: 'Add rate limiting to the public API',
  forcedModel: STORY_MODEL,
  turns: CLEAN_TURNS,
});

// ---------------------------------------------------------------------------
// Build events
// ---------------------------------------------------------------------------

let eventSeq = 0;
const events = [];

/**
 * Appends one event. Shared by the random sessions and the scripted story
 * sessions so both produce byte-identical event shapes — a story session that
 * differed structurally would exercise a different code path in the webview
 * than the rest of the fixture, which is exactly what a demo must not do.
 */
function pushEvent(session, ts, model, tokens) {
  const totalCents = estimateCents(model, tokens);
  eventSeq += 1;
  events.push({
    id: `evt_${eventSeq.toString(36).padStart(6, '0')}`,
    timestamp: ts,
    model,
    kind: 'composer',
    conversationId: session.id,
    isTokenBasedCall: true,
    // Undiscounted for now — chargedCents is set to match totalCents until
    // the discount pass below (after the budget-scaling pass further down,
    // deliberately: at this per-event scale, list costs are often 1-3
    // cents, where Math.round(cents * 0.6) frequently rounds right back to
    // the same integer it started from — collapsing the discount before it
    // exists. Scaling first means the 40%-off cut lands on cent values
    // large enough for that rounding to actually preserve a visible gap.
    chargedCents: totalCents,
    cursorTokenFee: null,
    tokenUsage: {
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadTokens: tokens.cacheRead,
      cacheWriteTokens: tokens.cacheWrite,
      totalCents,
    },
  });
}

for (const session of sessions) {
  // Scripted sessions carry their own turns; everything else is a random walk.
  if (session.turns) {
    let ts = session.startMs;
    for (const turn of session.turns) {
      ts += turn.gapMin * 60 * 1000;
      pushEvent(session, ts, session.forcedModel, {
        input: turn.input,
        output: turn.output,
        cacheRead: turn.cacheRead,
        cacheWrite: turn.cacheWrite,
      });
    }
    continue;
  }
  let cacheReadTokens = 0;
  const forcedModel = session.forcedModel || (session.heavy ? 'claude-4-5-sonnet' : null);
  for (let i = 0; i < session.length; i++) {
    const ts = session.startMs + i * randInt(45, 240) * 1000;
    if (ts > now) break;
    const model = forcedModel || pickModel(rand);

    const isFirst = i === 0;
    // A first turn carries Cursor's system prompt, your rules files and every
    // connected MCP server's tool definitions, so it is far larger than a
    // follow-up — and has to clear coldStartInputTokens (3,000) for the
    // "what every new chat costs before you type" baseline to have samples.
    const inputTokens = isFirst
      ? randInt(4000, 9000)
      : randInt(600, 3000) + i * randInt(50, 300);
    let outputTokens = randInt(200, 1800);
    // A handful of genuine output spikes across the whole window, for the
    // "heavy output request" finding.
    if (rand() < 0.012) outputTokens = randInt(7000, 12000);
    const cacheWriteTokens = isFirst ? randInt(400, 1600) : randInt(0, 300);
    cacheReadTokens = isFirst ? 0 : cacheReadTokens + randInt(800, 4000);

    pushEvent(session, ts, model, {
      input: inputTokens,
      output: outputTokens,
      cacheRead: cacheReadTokens,
      cacheWrite: cacheWriteTokens,
    });
  }
}

events.sort((a, b) => a.timestamp - b.timestamp);

// ---------------------------------------------------------------------------
// Scale every event's cost so this cycle's metered spend lands at a target
// figure that tells a clean burn-rate story (well on pace to exceed a $40
// budget before the cycle resets, without already being over).
// ---------------------------------------------------------------------------

const TARGET_CYCLE_SPEND = 24.5;
const cycleSpendRaw = events
  .filter((e) => e.timestamp >= cycleStartMs)
  .reduce((sum, e) => sum + e.chargedCents / 100, 0);
const scale = cycleSpendRaw > 0 ? TARGET_CYCLE_SPEND / cycleSpendRaw : 1;
for (const e of events) {
  e.chargedCents = Math.round(e.chargedCents * scale);
  e.tokenUsage.totalCents = Math.round(e.tokenUsage.totalCents * scale);
}

// Discount pass, after scaling (see the comment on chargedCents above for
// why): cuts chargedCents to 60% of the now-scaled list cost for Grok 4.6
// requests inside the discount window, so detectDiscounts() has a real,
// consistently-sized gap to measure for every request that day.
for (const e of events) {
  if (e.model !== 'cursor-grok-4.6-high' || e.timestamp < discountStart || e.timestamp > discountEnd) continue;
  e.chargedCents = Math.round(e.tokenUsage.totalCents * 0.6);
}

const spentDollars = events
  .filter((e) => e.timestamp >= cycleStartMs)
  .reduce((sum, e) => sum + e.chargedCents / 100, 0);

// ---------------------------------------------------------------------------
// Budget runway — mirrors src/shared/usageLogic.ts#projectBudgetRunway.
// ---------------------------------------------------------------------------

const budgetDollars = 40;
const remainingDollars = budgetDollars - spentDollars;
const overBudget = remainingDollars <= 0;
const percentUsed = (spentDollars / budgetDollars) * 100;
const elapsedDays = (now - cycleStartMs) / DAY_MS;
const dailySpend = elapsedDays >= 0.5 ? spentDollars / elapsedDays : null;
const daysUntilReset = cycleEndMs > now ? (cycleEndMs - now) / DAY_MS : null;
let daysToExhaustion = null;
let exhaustionDate = null;
if (overBudget) {
  daysToExhaustion = 0;
  exhaustionDate = new Date(now);
} else if (dailySpend) {
  daysToExhaustion = remainingDollars / dailySpend;
  exhaustionDate = new Date(now + daysToExhaustion * DAY_MS);
}
const exhaustsBeforeReset = daysToExhaustion != null && daysUntilReset != null
  ? daysToExhaustion < daysUntilReset
  : null;
const safeDailySpend = daysUntilReset != null && daysUntilReset > 0 && !overBudget
  ? remainingDollars / daysUntilReset
  : null;

const runway = {
  budgetDollars,
  spentDollars,
  remainingDollars,
  overBudget,
  percentUsed,
  dailySpend,
  daysToExhaustion,
  exhaustionDate: exhaustionDate ? exhaustionDate.toISOString() : null,
  daysUntilReset,
  exhaustsBeforeReset,
  safeDailySpend,
};

// ---------------------------------------------------------------------------
// Session titles map — a realistic subset of conversationId -> title, the
// shape the real `sessionTitles` RPC returns.
// ---------------------------------------------------------------------------

const sessionTitles = {};
for (const s of sessions) {
  if (s.title) sessionTitles[s.id] = s.title;
}

// ---------------------------------------------------------------------------
// Assemble the payload the mock RPC bridge (demo/bridge.js) serves.
// ---------------------------------------------------------------------------

const pricingMarkdown = fs.readFileSync(path.join(__dirname, 'pricing.md'), 'utf8');

const data = {
  status: { authMode: 'session', email: 'you@example.com' },
  usage: {
    events,
    authMode: 'session',
    email: 'you@example.com',
    plan: { membershipType: 'business', teamId: 4821, isTeamMember: true },
    quota: {
      used: events.filter((e) => e.timestamp >= cycleStartMs).length,
      limit: null,
      startOfCycleIso: cycleStart.toISOString(),
      resetIso: cycleEnd.toISOString(),
    },
    hardLimit: null,
  },
  pricing: { markdown: pricingMarkdown },
  budget: {
    budgetDollars,
    source: 'setting',
    sourceDetail: 'cursorUsage.budget.monthlyDollars',
    spentDollars,
    cycleStartMs,
    cycleEndMs,
    runway,
  },
  sessionTitles,
};

const outPath = path.join(__dirname, 'data.js');
fs.writeFileSync(
  outPath,
  `// Generated by demo/generate-fixtures.mjs — do not edit by hand.\n`
  + `window.__DEMO_DATA__ = ${JSON.stringify(data, null, 2)};\n`,
);

console.log(`Wrote ${outPath}`);
console.log(`  events: ${events.length}`);
console.log(`  sessions: ${sessions.length}`);
console.log(`  cycle-to-date spend: $${spentDollars.toFixed(2)} of $${budgetDollars} (${percentUsed.toFixed(1)}%)`);
console.log(`  daily pace: $${dailySpend ? dailySpend.toFixed(2) : 'n/a'}/day`);
console.log(`  exhausts before reset: ${exhaustsBeforeReset}`);
