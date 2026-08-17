// Turning a request log into advice about how the money was spent.
//
// Everything here is derived from token counts and timestamps alone — never
// from prompts, messages or code context, none of which this extension reads.
// That constraint is what makes the findings safe to show, and it also shapes
// what they can honestly say: the rules below describe the *cost structure* of
// a request ("96% of these tokens were re-read context"), and stop short of
// judging whether that context was necessary, which no amount of token
// accounting can tell you.
//
// Every finding carries an `anchor` (which request and session it is about)
// and an `impact` in dollars, so the same finding can be ranked and rendered
// identically on the Overview, in the session list and on the request row —
// one rule, one place to fix it, three places it shows up.

import { UNATTRIBUTED_SESSION } from './logic.js';

export const INSIGHT_DEFAULTS = {
  /**
   * A request that read and wrote no cache at all, yet sent a large input, is
   * Cursor compacting the conversation: the whole thread goes up in one
   * uncached shot and a summary comes back. Ordinary requests cache their
   * prefix, so `cacheWrite === 0` is what separates a compaction from a cold
   * start — the distinction the plain "no cache reads" test misses.
   */
  compactionMinInput: 50_000,
  /** Below this an uncached request is just a short question, not a cold start. */
  coldStartInputTokens: 3_000,
  /** Cold starts to see before quoting a baseline; one sample is an anecdote. */
  coldStartSampleMin: 3,
  /**
   * Cursor's prompt cache expires in minutes. Coming back to a thread after
   * this long means the cache is gone and the whole accumulated context is
   * re-written at full price before any work happens.
   */
  staleResumeGapMs: 60 * 60 * 1000,
  /** Ignore small re-writes: every turn writes something. */
  staleResumeCacheWriteTokens: 100_000,
  /** Cache reads this many times the session's median mark a blown-out context. */
  blowupMultiple: 5,
  /** ...but only when re-read context is what the request is actually made of. */
  blowupCacheShare: 0.9,
  /** Requests either side of a compaction used to judge whether it helped. */
  compactionWindow: 4,
  /** Cache reads must fall by this much after a compaction for it to have worked. */
  compactionReliefPct: 40,
  concentrationTopN: 3,
  concentrationSharePct: 30,
};

const HOUR_MS = 60 * 60 * 1000;

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function money(n) {
  const v = Math.abs(n);
  if (v >= 100) return `$${n.toFixed(0)}`;
  if (v >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

function count(n) {
  return Math.round(n).toLocaleString('en-US');
}

function hours(ms) {
  const h = ms / HOUR_MS;
  return h >= 1 ? `${h.toFixed(1)}h` : `${Math.round(ms / 60000)}m`;
}

/**
 * What a request's cost was actually made of, per token bucket.
 *
 * The parts are rescaled so they sum to the cost the rest of the dashboard
 * shows for the request. List rates and the real charge diverge whenever a
 * model is discounted, and a breakdown whose parts don't add up to the total
 * beside it reads as a bug rather than as a promotion. `scaled` records
 * whether that correction did anything, so callers can say so.
 */
export function costBreakdown(event, rates) {
  if (!rates || rates.input == null) return null;
  const part = (tokens, rate) => (rate == null ? 0 : ((tokens || 0) * rate) / 1_000_000);
  const modelled = {
    input: part(event.inputTokens, rates.input),
    output: part(event.outputTokens, rates.output),
    cacheRead: part(event.cacheReadTokens, rates.cacheRead),
    cacheWrite: part(event.cacheWriteTokens, rates.cacheWrite),
  };
  const modelledTotal = modelled.input + modelled.output + modelled.cacheRead + modelled.cacheWrite;
  if (!(modelledTotal > 0)) return null;
  const scale = event.cost != null && event.cost > 0 ? event.cost / modelledTotal : 1;
  return {
    input: modelled.input * scale,
    output: modelled.output * scale,
    cacheRead: modelled.cacheRead * scale,
    cacheWrite: modelled.cacheWrite * scale,
    total: modelledTotal * scale,
    // Anything past a rounding difference means list price and the real charge
    // disagreed — a discount, usually.
    scaled: Math.abs(scale - 1) > 0.01,
  };
}

/** Share of a request's cost that went on moving context around rather than on the answer. */
export function contextShare(breakdown) {
  if (!breakdown || !(breakdown.total > 0)) return null;
  return (breakdown.cacheRead + breakdown.cacheWrite) / breakdown.total;
}

/**
 * Which of the four shapes a request has.
 *
 * `compaction` is the one worth naming: Cursor summarising the thread looks
 * nothing like a user request (huge input, tiny output, no cache at either
 * end) and counting it as a cold start — as the plain `cacheRead === 0` test
 * does — both inflates the cold-start count and produces exactly backwards
 * advice, since a compaction is the opposite of starting fresh.
 */
export function classifyRequest(event, thresholds = {}) {
  const t = { ...INSIGHT_DEFAULTS, ...thresholds };
  const read = event.cacheReadTokens || 0;
  const write = event.cacheWriteTokens || 0;
  const input = event.inputTokens || 0;
  if (read === 0 && write === 0 && input >= t.compactionMinInput) return 'compaction';
  if (read === 0 && input > t.coldStartInputTokens) return 'coldStart';
  if (read > 0) return 'cached';
  return 'small';
}

function finding(rule, severity, scope, anchor, impact, title, body, action, evidence) {
  return {
    id: `${rule}:${anchor.requestId ?? anchor.sessionId ?? 'period'}`,
    rule,
    severity,
    scope,
    anchor,
    impact: Number.isFinite(impact) ? impact : 0,
    title,
    body,
    action,
    evidence: evidence || {},
  };
}

function staleResume(event, previous, breakdown, sessionId, t) {
  if (!previous || !breakdown) return null;
  const gap = event.timestampMs - previous.timestampMs;
  if (gap < t.staleResumeGapMs) return null;
  if ((event.cacheWriteTokens || 0) < t.staleResumeCacheWriteTokens) return null;
  return finding(
    'stale-resume', 'high', 'request',
    { requestId: event.id, sessionId }, breakdown.cacheWrite,
    `${money(breakdown.cacheWrite)} spent re-caching a thread left for ${hours(gap)}`,
    `This request resumed a conversation that had been idle for ${hours(gap)}. The prompt cache had `
      + `expired, so the whole accumulated context — ${count(event.cacheWriteTokens)} tokens — was `
      + `written again from scratch before any work happened.`,
    'After hours away, a fresh chat costs less than reviving a large old one: you pay to rebuild the '
      + 'context either way, and a new thread rebuilds only what you still need.',
    { gapMs: gap, cacheWriteTokens: event.cacheWriteTokens },
  );
}

function contextBlowup(event, breakdown, medianRead, sessionId, t) {
  if (!breakdown || !(medianRead > 0)) return null;
  const read = event.cacheReadTokens || 0;
  if (read < medianRead * t.blowupMultiple) return null;
  const share = event.totalTokens > 0 ? read / event.totalTokens : 0;
  if (share < t.blowupCacheShare) return null;
  // Only the reads above the session's own normal level are attributable to
  // the context having grown; the rest is what this session costs to run.
  const excess = breakdown.cacheRead * ((read - medianRead) / read);
  return finding(
    'context-blowup', 'high', 'request',
    { requestId: event.id, sessionId }, excess,
    `Context grew ${(read / medianRead).toFixed(0)}× — ${money(excess)} above this session's normal`,
    `${(share * 100).toFixed(0)}% of this request's tokens were re-read context `
      + `(${count(read)} of ${count(event.totalTokens)}). Cost here is context size × how many turns `
      + `the agent took, not how long the answer was — output was only ${money(breakdown.output)}.`,
    'Long agent runs re-read everything each turn, so cost climbs faster than the work does. '
      + 'Splitting the task at the last finished milestone keeps the context small for the rest of it.',
    { cacheReadTokens: read, medianRead, cacheShare: share },
  );
}

function compactionOutcome(list, idx, sessionId, dollarsOf, t) {
  const event = list[idx];
  const readsBefore = list.slice(Math.max(0, idx - t.compactionWindow), idx)
    .map((e) => e.cacheReadTokens || 0).filter((n) => n > 0);
  const readsAfter = list.slice(idx + 1, idx + 1 + t.compactionWindow)
    .map((e) => e.cacheReadTokens || 0).filter((n) => n > 0);
  const before = median(readsBefore);
  const after = median(readsAfter);
  if (!(before > 0) || !readsAfter.length) return null;

  const reliefPct = ((before - after) / before) * 100;
  if (reliefPct < t.compactionReliefPct) return null;

  // It worked — but did it last? A later request back at the pre-compaction
  // level means the thread re-inflated and the saving was temporary, which is
  // the moment a new chat would have paid off rather than another summary.
  const regrown = list.slice(idx + 1).find((e) => (e.cacheReadTokens || 0) >= before);
  if (regrown) {
    const breakdown = dollarsOf(regrown);
    const spent = breakdown ? breakdown.cacheRead : 0;
    return finding(
      'compaction-undone', 'medium', 'request',
      { requestId: regrown.id, sessionId }, spent,
      'Summarising worked, then the context grew back',
      `Compacting at this point cut cache reads by ${reliefPct.toFixed(0)}% for ${money(event.cost ?? 0)}. `
        + `Within ${hours(regrown.timestampMs - event.timestampMs)} the thread was back to its previous `
        + `size, and the next large request spent ${money(spent)} re-reading it.`,
      'A summary buys time, not a session. The quiet stretch right after one is the cheapest moment '
        + 'to start a fresh chat.',
      { reliefPct, regrownAtMs: regrown.timestampMs, compactionCost: event.cost ?? 0 },
    );
  }

  return finding(
    'compaction-worked', 'positive', 'request',
    { requestId: event.id, sessionId }, 0,
    `Summarising cut cache reads by ${reliefPct.toFixed(0)}%`,
    `Cursor compacted this conversation for ${money(event.cost ?? 0)}, and the requests after it read `
      + `${count(before - after)} fewer cached tokens each.`,
    'Worth doing again when a thread starts feeling heavy — it costs cents and it is working here.',
    { reliefPct, costDollars: event.cost ?? 0 },
  );
}

function spendConcentration(priced, totalCost, dollarsOf, t) {
  if (priced.length <= t.concentrationTopN * 3 || !(totalCost > 0)) return null;
  const top = [...priced].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)).slice(0, t.concentrationTopN);
  const topCost = top.reduce((s, e) => s + (e.cost ?? 0), 0);
  const share = (topCost / totalCost) * 100;
  if (share < t.concentrationSharePct) return null;
  const worst = top[0];
  const breakdown = dollarsOf(worst);
  const ctx = contextShare(breakdown);
  return finding(
    'spend-concentration', 'high', 'period',
    { requestId: worst.id, sessionId: worst.conversationId || UNATTRIBUTED_SESSION }, topCost,
    `${share.toFixed(0)}% of this period went on ${top.length} requests`,
    `${money(topCost)} of ${money(totalCost)} came from ${top.length} of ${count(priced.length)} requests`
      + `${ctx != null ? `, and ${(ctx * 100).toFixed(0)}% of the dearest one was context handling` : ''}. `
      + 'Averages hide this: the typical request here is cheap.',
    'Work on the outliers rather than on everyday usage — the rest of the log is already inexpensive.',
    { topCost, share, requestIds: top.map((e) => e.id) },
  );
}

function newChatOverhead(priced, dollarsOf, t) {
  const colds = priced.filter((e) => classifyRequest(e, t) === 'coldStart');
  if (colds.length < t.coldStartSampleMin) return null;
  // The floor is what every new chat carries before you type: system prompt,
  // rules files and the tool definitions of every connected MCP server. The
  // cheapest cold start is the closest thing to measuring it directly.
  const floor = Math.min(...colds.map((e) => e.inputTokens || 0));
  const spent = colds.reduce((s, e) => {
    const b = dollarsOf(e);
    return s + (b ? b.input : 0);
  }, 0);
  return finding(
    'new-chat-overhead', 'medium', 'period',
    { requestId: colds[0].id, sessionId: colds[0].conversationId || UNATTRIBUTED_SESSION }, spent,
    `Every new chat starts with about ${count(floor)} tokens already loaded`,
    `Across ${count(colds.length)} fresh starts the smallest was ${count(floor)} input tokens — that is `
      + `your baseline: Cursor's system prompt, your rules files, and the tool definitions of every `
      + `connected MCP server. You paid ${money(spent)} on those starts before typing anything.`,
    'If that looks high: turn off MCP servers you do not use in this project (their tool definitions '
      + 'load whether you call them or not), and trim your rules files.',
    { floorTokens: floor, coldStarts: colds.length, spentDollars: spent },
  );
}

/**
 * Every finding for a set of requests, dearest first.
 *
 * `ratesFor` is injected rather than imported so the caller stays in charge of
 * discount handling: the dashboard prices a request at whatever it actually
 * cost that day, and this module should not re-derive that independently.
 */
export function buildInsights({ events, ratesFor, thresholds = {} }) {
  const t = { ...INSIGHT_DEFAULTS, ...thresholds };
  const priced = (events || []).filter((e) => e && e.cost != null);
  if (!priced.length) return [];

  const dollarsOf = (event) => costBreakdown(event, ratesFor(event.modelRaw, event));
  const totalCost = priced.reduce((s, e) => s + (e.cost ?? 0), 0);
  const findings = [];

  const bySession = new Map();
  for (const event of [...priced].sort((a, b) => a.timestampMs - b.timestampMs)) {
    const sessionId = event.conversationId || UNATTRIBUTED_SESSION;
    if (!bySession.has(sessionId)) bySession.set(sessionId, []);
    bySession.get(sessionId).push(event);
  }

  for (const [sessionId, list] of bySession) {
    const medianRead = median(list.map((e) => e.cacheReadTokens || 0).filter((n) => n > 0));
    for (let idx = 0; idx < list.length; idx += 1) {
      const event = list[idx];
      const breakdown = dollarsOf(event);
      // The unattributed bucket is not a conversation, so gaps and medians
      // across it compare unrelated requests. Its rows still get period-level
      // findings, just not the per-session ones.
      if (sessionId !== UNATTRIBUTED_SESSION) {
        const stale = staleResume(event, list[idx - 1], breakdown, sessionId, t);
        if (stale) findings.push(stale);
        const blowup = contextBlowup(event, breakdown, medianRead, sessionId, t);
        if (blowup) findings.push(blowup);
        if (classifyRequest(event, t) === 'compaction') {
          const outcome = compactionOutcome(list, idx, sessionId, dollarsOf, t);
          if (outcome) findings.push(outcome);
        }
      }
    }
  }

  const concentration = spendConcentration(priced, totalCost, dollarsOf, t);
  if (concentration) findings.push(concentration);
  const overhead = newChatOverhead(priced, dollarsOf, t);
  if (overhead) findings.push(overhead);

  // Two compactions in one session can both regrow into the same later request,
  // and the rule anchors to the regrowth rather than to the summary — so the
  // same card would be rendered twice and its dollars counted twice in a brief.
  const unique = [...new Map(findings.map((f) => [f.id, f])).values()];

  // Positive findings are worth showing but never worth topping the list: they
  // have no dollars attached and would otherwise outrank real money whenever
  // impact ties at zero.
  return unique.sort((a, b) => {
    if ((a.severity === 'positive') !== (b.severity === 'positive')) return a.severity === 'positive' ? 1 : -1;
    return (b.impact ?? 0) - (a.impact ?? 0);
  });
}

/** The findings that belong to one request, for the row detail. */
export function findingsForRequest(findings, requestId) {
  return findings.filter((f) => f.anchor.requestId === requestId);
}

/** The findings that belong to one session, period-level ones included when they point into it. */
export function findingsForSession(findings, sessionId) {
  return findings.filter((f) => f.anchor.sessionId === sessionId);
}

/** Highest severity present, for a row badge. */
export function badgeSeverity(findings) {
  if (findings.some((f) => f.severity === 'high')) return 'high';
  if (findings.some((f) => f.severity === 'medium')) return 'medium';
  if (findings.some((f) => f.severity === 'positive')) return 'positive';
  return null;
}
