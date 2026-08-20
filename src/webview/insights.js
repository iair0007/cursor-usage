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

import {
  UNATTRIBUTED_SESSION,
  autoRouting,
  displayModel,
  estimateTokenCost,
  normModel,
} from './logic.js';

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
  /** Requests needed either side of a change before it is worth judging. */
  switchMinRequests: 3,
  /** A change has to move real money, and move it by a real proportion. */
  switchMinImpact: 0.25,
  switchMinPct: 20,
  /** Output per request must grow by this much to call it an effort change. */
  effortOutputMultiple: 1.5,
  /** How far the billed-to-list ratio must move to count as a price change. */
  priceShiftPct: 10,
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
    // The rates themselves were a built-in default rather than a scrape, so the
    // proportions are indicative and the caller should say as much.
    estimated: rates.estimated === true,
  };
}

/** Share of a request's cost that went on moving context around rather than on the answer. */
export function contextShare(breakdown) {
  if (!breakdown || !(breakdown.total > 0)) return null;
  return (breakdown.cacheRead + breakdown.cacheWrite) / breakdown.total;
}

/**
 * The four buckets as shares, plus a name for what the context half actually did.
 *
 * Two things this exists to stop being said. The first is "re-reading and
 * re-caching the conversation" on a session that never wrote a byte to cache —
 * `cacheWrite` is 0 for every request on some accounts, and naming an activity
 * that did not happen is the kind of small false statement that makes a reader
 * stop trusting the arithmetic beside it.
 *
 * The second is worse: the leftover share used to be reported as "the answers
 * themselves", but it is output *plus input*, and input is the prompt you
 * sent. On a session that is 14.5% output and 12.4% input that phrasing
 * overstates the answer's share by nearly double, and it is the number the
 * whole "context handling vs real work" argument rests on.
 */
export function spendSplit(breakdown) {
  if (!breakdown || !(breakdown.total > 0)) return null;
  const share = (value) => (value / breakdown.total) * 100;
  const read = breakdown.cacheRead > 0;
  const write = breakdown.cacheWrite > 0;
  return {
    contextPct: share(breakdown.cacheRead + breakdown.cacheWrite),
    outputPct: share(breakdown.output),
    inputPct: share(breakdown.input),
    // Null when neither happened, so callers drop the clause rather than
    // print an empty pair of dashes.
    contextLabel: read && write
      ? 're-reading and re-caching the conversation'
      : read ? 're-reading the conversation'
        : write ? 'writing the conversation to cache' : null,
  };
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
      // Anchored to the regrowth, because that is the request that cost the
      // money — but `summaryRequestId` carries the summary itself, so the card
      // can offer a link to it too. Without that, the one request the finding is
      // about is the one nothing in the product points at.
      'compaction-undone', 'medium', 'request',
      { requestId: regrown.id, sessionId, summaryRequestId: event.id }, spent,
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

// ---------------------------------------------------------------------------
// Things that changed partway through a session
//
// Three rules, not one, because the three changes people make are measured in
// genuinely different units and merging them would print a confident wrong
// number. `pricingLabel` is what separates them: it is the catalog row a request
// actually priced against, where `modelRaw` is the billed variant string.
//
//   - A different rate card (a new model, or Auto starting to route somewhere)
//     changes the price per token. Measurable by re-pricing the same tokens.
//   - A different reasoning effort bills on the *same* rate card — Cursor's own
//     docs say effort changes token usage, not price — so re-pricing yields
//     exactly zero. It has to be measured in tokens instead.
//   - A promotion beginning or ending changes neither, but changes what was
//     actually charged for identical work.
// ---------------------------------------------------------------------------

/** Contiguous runs of requests sharing a key, in the order they were asked. */
function runsBy(list, keyOf) {
  const runs = [];
  for (const event of list) {
    const key = keyOf(event);
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.events.push(event);
    else runs.push({ key, events: [event] });
  }
  return runs;
}

function sumTokens(events) {
  return events.reduce((acc, e) => ({
    input: acc.input + (e.inputTokens || 0),
    output: acc.output + (e.outputTokens || 0),
    cacheRead: acc.cacheRead + (e.cacheReadTokens || 0),
    cacheWrite: acc.cacheWrite + (e.cacheWriteTokens || 0),
  }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
}

function spent(events) {
  return events.reduce((s, e) => s + (e.cost ?? 0), 0);
}

/** The rate card a request priced against, or its normalised name when unpriced. */
function rateCardOf(event, ratesFor) {
  const rates = ratesFor(event.modelRaw, event);
  return rates?.label || `?${normModel(event.modelRaw)}`;
}

/**
 * Moving to a different rate card partway through, and what it cost.
 *
 * The comparison prices the requests *after* the switch against the rates of the
 * model that was left, rather than comparing what each half of the session
 * actually spent. That distinction is the whole rule: a switch nearly always
 * happens once a conversation is already large, so raw before-and-after spend
 * would charge the new model for context growth it had nothing to do with.
 * Holding the tokens fixed cancels the growth and leaves only the price.
 */
function modelSwitch(list, sessionId, ratesFor, t) {
  const runs = runsBy(list, (e) => rateCardOf(e, ratesFor));
  if (runs.length < 2) return null;

  let worst = null;
  for (let i = 1; i < runs.length; i += 1) {
    const before = runs[i - 1];
    const after = runs[i];
    if (before.events.length < t.switchMinRequests || after.events.length < t.switchMinRequests) continue;
    const priorRates = ratesFor(before.events[before.events.length - 1].modelRaw, before.events[0]);
    if (!priorRates) continue;
    const actual = spent(after.events);
    const counterfactual = estimateTokenCost(priorRates, sumTokens(after.events));
    if (counterfactual == null || !(actual > 0) || !(counterfactual > 0)) continue;
    const delta = actual - counterfactual;
    const pct = Math.abs(delta / counterfactual) * 100;
    if (Math.abs(delta) < t.switchMinImpact || pct < t.switchMinPct) continue;
    if (!worst || Math.abs(delta) > Math.abs(worst.delta)) {
      worst = { before, after, delta, actual, counterfactual, at: list.indexOf(after.events[0]) };
    }
  }
  if (!worst) return null;

  const { before, after, delta, actual, counterfactual, at } = worst;
  const fromName = displayModel(before.events[0].modelRaw);
  const toName = displayModel(after.events[0].modelRaw);
  const routed = autoRouting(after.events[0].modelRaw);
  const how = routed
    ? `Auto routed to ${routed.model}`
    : `You moved from ${fromName} to ${toName}`;
  const dearer = delta > 0;

  return finding(
    'model-switch', dearer ? 'high' : 'positive', 'request',
    { requestId: after.events[0].id, sessionId }, dearer ? delta : 0,
    dearer
      ? `Switching to ${toName} cost ${money(delta)} more than staying put`
      : `Switching to ${toName} saved ${money(-delta)}`,
    `${how} at request #${at + 1}. The ${count(after.events.length)} requests after it cost `
      + `${money(actual)}; the same tokens on ${fromName} would have been ${money(counterfactual)}. `
      + 'Both figures price identical token counts, so this is the rate difference alone — the '
      + 'context had grown either way.',
    dearer
      ? 'Worth knowing before the next long session. This compares price, not results: the model you '
        + 'left might have needed more turns to finish the same work, which no token count can show.'
      : 'The cheaper card did the rest of this session. Worth repeating when the work suits it.',
    { fromLabel: before.key, toLabel: after.key, actual, counterfactual, delta, switchedAt: at + 1 },
  );
}

/**
 * Raising the reasoning effort, which costs more without costing more per token.
 *
 * Cursor bills every effort level of a model on one published row, so this
 * cannot be measured the way a model switch is — re-pricing the same tokens
 * against the same rate card returns the same number by construction. What
 * actually changes is how much the model writes, so that is what gets measured.
 */
function effortSwitch(list, sessionId, ratesFor, t) {
  const runs = runsBy(list, (e) => `${rateCardOf(e, ratesFor)}|${normModel(e.modelRaw)}`);
  if (runs.length < 2) return null;

  for (let i = 1; i < runs.length; i += 1) {
    const before = runs[i - 1];
    const after = runs[i];
    // Same rate card either side is what makes this an effort change rather
    // than a model change — the other rule owns that case.
    if (rateCardOf(before.events[0], ratesFor) !== rateCardOf(after.events[0], ratesFor)) continue;
    if (before.events.length < t.switchMinRequests || after.events.length < t.switchMinRequests) continue;

    const outBefore = median(before.events.map((e) => e.outputTokens || 0));
    const outAfter = median(after.events.map((e) => e.outputTokens || 0));
    if (!(outBefore > 0) || outAfter < outBefore * t.effortOutputMultiple) continue;

    const costBefore = median(before.events.map((e) => e.cost ?? 0));
    const costAfter = median(after.events.map((e) => e.cost ?? 0));
    const impact = Math.max(0, (costAfter - costBefore) * after.events.length);
    if (impact < t.switchMinImpact) continue;

    const at = list.indexOf(after.events[0]);
    return finding(
      'effort-switch', 'medium', 'request',
      { requestId: after.events[0].id, sessionId }, impact,
      `Raising the effort level added ${money(impact)} over ${count(after.events.length)} requests`,
      `From request #${at + 1} the model changed from ${displayModel(before.events[0].modelRaw)} to `
        + `${displayModel(after.events[0].modelRaw)} — the same rate card at a different reasoning `
        + `effort. The price per token did not change; the amount written did, from `
        + `${count(outBefore)} to ${count(outAfter)} output tokens on a typical request, taking the `
        + `typical request from ${money(costBefore)} to ${money(costAfter)}.`,
      'A higher effort earns its keep on genuinely hard problems and quietly does not on the rest '
        + 'of a session. Worth dropping back once the hard part is done.',
      { outputBefore: outBefore, outputAfter: outAfter, costBefore, costAfter, switchedAt: at + 1 },
    );
  }
  return null;
}

/**
 * The same model billed at a different effective rate partway through.
 *
 * Measured against what Cursor actually charged rather than against the discount
 * table, because those entries are keyed by day: read that way, a promotion
 * boundary could only ever land inside a session that ran across midnight. The
 * billed-to-list ratio moves whatever the cause and whenever it happens.
 */
function priceChanged(list, sessionId, ratesFor, t) {
  // What one request was charged, as a fraction of what its tokens are worth at
  // the published rate. A promotion moves this; nothing the user does moves it.
  const ratioOf = (event) => {
    const rates = ratesFor(event.modelRaw, event);
    if (!rates || event.cost == null) return null;
    // A discounted card already has the promotion baked into it, so measuring
    // against it would compare the charge to itself and always find nothing.
    const listRates = rates.discountPct ? { ...rates, ...undiscount(rates) } : rates;
    const expected = estimateTokenCost(listRates, sumTokens([event]));
    return expected > 0 ? event.cost / expected : null;
  };
  // Nearest 5%: the ratio wobbles by a fraction of a cent's rounding on every
  // request, and grouping on the raw value would make every request its own run.
  const bucketOf = (event) => {
    const ratio = ratioOf(event);
    return ratio == null ? 'none' : String(Math.round(ratio * 20) / 20);
  };

  // Grouped inside each rate card, not across them: a price change happens to
  // one model while it is in use, so both sides of it are the same rate card and
  // splitting on the card alone would leave a single run with nothing to compare.
  for (const card of runsBy(list, (e) => rateCardOf(e, ratesFor))) {
    const runs = runsBy(card.events, bucketOf);
    for (let i = 1; i < runs.length; i += 1) {
      const before = runs[i - 1];
      const after = runs[i];
      if (before.events.length < t.switchMinRequests || after.events.length < t.switchMinRequests) continue;
      const rBefore = median(before.events.map(ratioOf).filter((r) => r != null));
      const rAfter = median(after.events.map(ratioOf).filter((r) => r != null));
      if (!(rBefore > 0) || !(rAfter > 0)) continue;
      const shift = ((rAfter - rBefore) / rBefore) * 100;
      if (Math.abs(shift) < t.priceShiftPct) continue;
      const at = list.indexOf(after.events[0]);
      const dearer = shift > 0;
      const impact = dearer
        ? Math.max(0, spent(after.events) - spent(after.events) / (rAfter / rBefore))
        : 0;
      if (dearer && impact < t.switchMinImpact) continue;
      return priceChangeFinding(after, sessionId, at, shift, dearer, impact, rBefore, rAfter);
    }
  }
  return null;
}

function priceChangeFinding(after, sessionId, at, shift, dearer, impact, rBefore, rAfter) {
  const name = displayModel(after.events[0].modelRaw);
  const moved = Math.abs(shift).toFixed(0);
  return finding(
    'price-changed', dearer ? 'high' : 'positive', 'request',
    { requestId: after.events[0].id, sessionId }, impact,
    dearer
      ? `${name} got ${moved}% dearer partway through this session`
      : `${name} got ${moved}% cheaper partway through this session`,
    `From request #${at + 1} the same model was billed differently against the same published `
      + `price — ${dearer ? 'up' : 'down'} ${moved}% on identical work. A promotion starting or `
      + 'ending is the usual reason.',
    dearer
      ? 'Nothing you did, and nothing to fix — but it explains a jump that would otherwise look '
        + 'like your own usage changing.'
      : 'Worth knowing while it lasts: the same work is costing less than the rate card says.',
    { ratioBefore: rBefore, ratioAfter: rAfter, shiftPct: shift, changedAt: at + 1 },
  );
}

/** List rates behind a discounted card, so a charge can be compared to par. */
function undiscount(rates) {
  const factor = 1 - (rates.discountPct || 0) / 100;
  if (!(factor > 0)) return {};
  const up = (v) => (v == null ? null : v / factor);
  return {
    input: up(rates.input),
    output: up(rates.output),
    cacheRead: up(rates.cacheRead),
    cacheWrite: up(rates.cacheWrite),
  };
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
  // Reduced rather than `Math.min(...)`: the spread form throws RangeError once
  // the array is long enough to blow the argument limit, and a 90-day period on
  // a busy account gets there.
  const floor = colds.reduce((lo, e) => Math.min(lo, e.inputTokens || 0), Infinity);
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

    // What changed partway through, judged over the session as a whole rather
    // than request by request — a switch is a property of the sequence, not of
    // any one row in it, so these run once per conversation.
    if (sessionId !== UNATTRIBUTED_SESSION) {
      for (const detect of [modelSwitch, effortSwitch, priceChanged]) {
        const found = detect(list, sessionId, ratesFor, t);
        if (found) findings.push(found);
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

/**
 * How many finding cards a surface shows before the rest are folded away.
 *
 * A card is only worth its space if it tells the reader something the card
 * above it did not, and three is about as many distinct lessons as anyone acts
 * on in one sitting. What used to happen instead: the same rule firing on
 * fourteen requests rendered fourteen cards with the same explanation and the
 * same closing tip, and the genuinely different findings were somewhere below
 * the fold, indistinguishable from the repetition.
 */
export const FINDING_CARD_LIMIT = 3;

/**
 * One card per kind of finding, worst first.
 *
 * A rule that fired repeatedly is a single card — the costliest instance, which
 * is the one worth opening — carrying a count of the others and their combined
 * dollars, so nothing is hidden and no total shrinks. Rules are the grouping
 * key precisely because the body and the advice are written per rule: two cards
 * from the same rule differ only in their numbers, which is exactly the
 * repetition that makes a wall of cards unreadable.
 *
 * Period-level findings carry no `rule`, and each of them fires at most once,
 * so their title is a stable key.
 */
export function dedupeFindings(findings) {
  const groups = new Map();
  for (const f of findings || []) {
    const key = f.rule || f.title;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { lead: f, count: 0, dollars: 0 });
      continue;
    }
    // Keep the dearest instance as the one on show, and bank whichever of the
    // two it displaces — so the folded dollars are every instance but the lead,
    // however the list happened to be ordered coming in.
    let displaced = f;
    if ((f.impact ?? 0) > (group.lead.impact ?? 0)) {
      displaced = group.lead;
      group.lead = f;
    }
    group.dollars += displaced.impact ?? 0;
    group.count += 1;
  }
  return [...groups.values()]
    .map(({ lead, count, dollars }) => (count ? { ...lead, related: { count, dollars } } : lead))
    .sort((a, b) => {
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
