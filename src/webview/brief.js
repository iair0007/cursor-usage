// Handing one slice of the request log to Cursor Chat, and asking about it.
//
// The dashboard already builds a brief for a whole period (see main.js). This
// module builds the two narrower ones — one session, one request — and lives in
// its own file for the same reason insights.js does: the interesting part is the
// format, the format is worth testing, and neither should need a DOM to exercise.
//
// Everything here is derived from token counts, timestamps and costs, plus the
// conversation name the extension reads out of Cursor's own local database. No
// prompts, no messages, no code — the extension never reads any, which is what
// makes a brief safe to paste into a chat at all.
//
// The format is under a token budget, because the analysis costs money too, and
// two rules do most of that work:
//
//   1. Never emit one line per request. A per-request line runs ~30 tokens and on
//      a plateau it carries almost nothing; 47 of them outweigh the rest of the
//      brief put together. The cost curve below is six fixed slices instead, so a
//      12-request session and a 300-request one produce the same number of lines,
//      and the slope, the step down at a compaction and the spike all survive.
//   2. Never say the same thing twice. A finding already narrates a stale resume
//      with the dollars attached; repeating it as a timeline row costs tokens and
//      invites the reader to count the same money twice.
//
// Collaborators are injected rather than imported — the same arrangement
// buildInsights uses for `ratesFor` — so the caller stays in charge of discount
// handling and the tests need no pricing table to run.

import { sessionMetrics, sessionTotals } from './logic.js';
import { spendSplit } from './insights.js';

/**
 * What the receiving model has to be told before it can help.
 *
 * This is the most expensive part of a brief — around 270 tokens, a third of a
 * session brief — and it earns that place: it is the only part that changes what
 * the reader knows about the domain. Without rule 3 a model reads "68% of spend
 * was cache reads" as a *success* and congratulates the user on their cache hit
 * rate. Rule 2 exists because the obvious first question — "what were you working
 * on?" — is one nobody can answer: we deliberately never read it.
 */
export const BRIEF_PREAMBLE = `Read-only export from my Cursor Usage Dashboard extension. Everything is in this
message: call no tools, fetch nothing, ask no clarifying questions.

Rules:
1. Use only the numbers below. Never invent, estimate or extrapolate a figure —
   if it isn't here, say "not in the data" in one line and move on.
2. Don't ask what I was working on. This extension reads only token counts,
   timestamps and costs — never prompts, messages or code — so nobody can tell
   you. Reason from the shape of the spending.
3. Cursor bills four token buckets at different rates: output ~5x input, cache
   write ~1.25x input, cache read ~0.1x input. Every agent turn re-sends the
   whole conversation, so cache-read cost grows as turns x context size and a
   long thread gets dearer per turn even as the work gets smaller. The prompt
   cache expires after a few idle minutes: resuming a stale thread rewrites the
   entire context at write price before any work happens.
4. So the levers here are thread length, when to start a fresh chat, when to
   compact, and what stays in context. Do not tell me to switch to a cheaper
   model unless these specific numbers single a model out.
5. Answer in one pass. Lead with the largest dollar item and quote it, then give
   at most 3 actions, each tied to a figure above.`;

/** Caveats that apply to every brief this dashboard produces, whatever its scope. */
export const BRIEF_NOTES = [
  '- Auto optimizes for task success and uses the Auto+Composer pool — not always the cheapest rate card.',
  '- Cheaper models in comparisons assume the same token counts; real usage may differ.',
  '- Token cost excludes flat per-request usage fees unless noted in summary.',
];

/**
 * The questions worth asking about one session or one request.
 *
 * Each prompt does three jobs at once: it demands the answer cite figures (which
 * is what stops a model inventing them), it names the decision being made (which
 * is what stops it falling back on "try a cheaper model"), and it presupposes
 * nothing about what the work actually was (which is what stops it asking).
 */
export const BRIEF_TEMPLATES = [
  {
    id: 'session-too-long',
    scope: 'session',
    title: 'Find where starting a fresh chat would have saved money.',
    prompt: 'Using the cost curve and the events, tell me whether this conversation should have '
      + 'been split, and at which request number. Quote the dollars I would have saved and show '
      + 'how you got that from the figures above. If the data says the session was run well, say '
      + 'that instead of manufacturing a recommendation.',
  },
  {
    id: 'session-waste',
    scope: 'session',
    title: 'Identify avoidable spend, ranked by dollar impact.',
    prompt: 'Rank the avoidable spend in this session from largest to smallest — re-caching after '
      + 'idle gaps, context grown past what the turn needed, errored requests, compaction that '
      + "didn't hold. Give a dollar figure per item, total them, and state that total as a share "
      + 'of the session cost. Count only what is visible in the numbers above; do not include '
      + 'anything you had to assume.',
  },
  {
    id: 'session-next-time',
    scope: 'session',
    title: 'Create a cheaper plan for doing the same work.',
    prompt: "Assume I'm about to start the same kind of work again. Give me a run plan in at most "
      + '5 bullets: when to open a new chat, when to compact, what to keep out of context, and the '
      + 'exact request number in the curve above where I should have stopped and started fresh. '
      + 'Every bullet must cite a number from this session.',
  },
  {
    id: 'session-custom',
    scope: 'session',
    title: 'Custom question - Write a question',
    custom: true,
    prompt: 'Answer my question using only the session data below.',
  },
  {
    id: 'request-avoidable',
    scope: 'request',
    title: 'Find out whether this request was avoidable.',
    prompt: 'Was this request avoidable, and what should I have done instead at this exact moment? '
      + 'Quote the dollars and show the arithmetic from the numbers below. Use the requests that '
      + 'came after it to judge whether the money it spent was earned back or thrown away.',
  },
  {
    id: 'request-custom',
    scope: 'request',
    title: 'Custom question - Write a question',
    custom: true,
    prompt: 'Answer my question using only the request data below.',
  },
];

/** How many contiguous slices the cost curve is reported in. */
export const CURVE_SLICES = 6;
/** Events named individually, at most. Ranked by dollars, so the cut drops the cheapest. */
export const EVENT_CAP = 5;
/** Findings quoted, at most, of which at most one is a positive. */
export const FINDING_CAP = 4;
/** A pause worth naming. Below this a gap is just someone reading the answer. */
export const NOTABLE_GAP_MS = 30 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

function money(n) {
  if (n == null || !Number.isFinite(n)) return '$0.00';
  const v = Math.abs(n);
  if (v >= 100) return `$${n.toFixed(0)}`;
  if (v >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

function count(n) {
  return Math.round(n || 0).toLocaleString('en-US');
}

/**
 * Token counts at reading precision rather than accounting precision.
 *
 * "1.4M" and "1,402,600" say the same thing about a cost curve, and one of them
 * costs a quarter as much to send. Exact figures are kept where the reader is
 * expected to do arithmetic with them — a single request's own tokens — and
 * rounded everywhere they only establish a shape.
 */
function tok(n) {
  const v = Math.round(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1_000) return `${Math.round(v / 1_000)}k`;
  return String(v);
}

function pct(n) {
  return n == null ? '—' : `${n.toFixed(0)}%`;
}

function dur(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 60000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (!h) return `${m}m`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** UTC to the minute. Callers in the dashboard pass the user's own local formatter instead. */
function defaultFormatTime(ms) {
  return new Date(ms || 0).toISOString().slice(0, 16).replace('T', ' ');
}

/**
 * Roughly how much this brief will cost to send.
 *
 * Four characters per token is the usual English approximation and it is wrong in
 * both directions on a page of numbers — but the figure exists to let someone
 * decide between a 900-token brief and a 2,300-token one, and it is more than
 * accurate enough for that. Presented as an estimate everywhere it is shown.
 */
export function estimateBriefSize(text) {
  const chars = (text || '').length;
  return { chars, tokens: Math.ceil(chars / 4) };
}

/**
 * The session's spending, in a fixed number of contiguous equal-count slices.
 *
 * Equal *count*, not equal time: idle gaps are events in their own right and
 * slicing by the clock puts empty buckets in the middle of a bursty session.
 * Cache read is reported as a median rather than a mean so that one spike shows
 * up once — in the events list, where it can be named — instead of also dragging
 * a slice average up and being read as sustained growth.
 */
export function costCurve(events, slices = CURVE_SLICES) {
  const list = events || [];
  if (!list.length) return [];
  const n = list.length;
  const buckets = Math.min(slices, n);
  const out = [];
  for (let i = 0; i < buckets; i += 1) {
    const from = Math.floor((i * n) / buckets);
    const to = Math.floor(((i + 1) * n) / buckets);
    const slice = list.slice(from, to);
    out.push({
      from,
      to,
      count: slice.length,
      cost: slice.reduce((s, e) => s + (e.cost ?? 0), 0),
      medianRead: median(slice.map((e) => e.cacheReadTokens || 0).filter((v) => v > 0)),
    });
  }
  return out;
}

/** Which slice of the curve a request at this index falls in. */
function sliceOf(index, curve) {
  const found = curve.findIndex((s) => index >= s.from && index < s.to);
  return found < 0 ? curve.length : found + 1;
}

/**
 * The moments worth naming that the findings don't already cover.
 *
 * Anything a finding anchors is skipped: the finding says it better, says it with
 * dollars, and saying it twice invites the reader to add the same money to their
 * total in two places. What is left gets ranked by dollars so that hitting the cap
 * drops the cheapest event rather than an arbitrary one.
 */
export function briefEvents(events, findings, { classify, breakdownOf, formatTime, cap = EVENT_CAP } = {}) {
  const list = events || [];
  if (!list.length) return [];
  const time = formatTime || defaultFormatTime;
  const covered = new Set((findings || []).map((f) => f.anchor?.requestId).filter(Boolean));
  const kindOf = classify || (() => 'cached');
  const out = [];
  // The compaction rules anchor their finding to the *regrowth* request rather
  // than to the summary, so id-matching alone doesn't notice that the compaction
  // has already been narrated — and narrated better, with what happened after it.
  const compactionJudged = (findings || [])
    .some((f) => f.rule === 'compaction-worked' || f.rule === 'compaction-undone');

  list.forEach((event, index) => {
    if (covered.has(event.id)) return;
    const at = `#${index + 1}`;

    if (kindOf(event) === 'compaction') {
      if (compactionJudged) return;
      out.push({
        impact: event.cost ?? 0,
        line: `${at} at ${time(event.timestampMs)} — Cursor compacted the conversation for `
          + `${money(event.cost ?? 0)}; ${tok(event.inputTokens)} tokens went up uncached.`,
      });
      return;
    }

    const previous = list[index - 1];
    const gap = previous ? event.timestampMs - previous.timestampMs : 0;
    if (gap >= NOTABLE_GAP_MS) {
      out.push({
        impact: event.cost ?? 0,
        line: `${dur(gap)} idle before ${at}; resuming cost ${money(event.cost ?? 0)} and rewrote `
          + `${tok(event.cacheWriteTokens)} tokens to cache.`,
      });
    }
  });

  // Errored requests are aggregated rather than listed: five of them are one fact
  // about the session ("some requests were charged and returned nothing"), and
  // five lines to say it is four lines too many.
  const errored = list.filter((e) => e.counted === false);
  if (errored.length) {
    const spent = errored.reduce((s, e) => s + (e.cost ?? 0), 0);
    const where = errored.map((e) => `#${list.indexOf(e) + 1}`).slice(0, 4).join(', ');
    out.push({
      impact: spent,
      line: `${count(errored.length)} request${errored.length === 1 ? '' : 's'} errored `
        + `(charged, no result): ${where}${errored.length > 4 ? ' …' : ''}, ${money(spent)} total.`,
    });
  }

  // The dearest request is worth a line when no rule fired on it. When one did,
  // this stays quiet rather than promoting the runner-up: "the dearest request"
  // has to name the actual dearest request or it is simply a false statement.
  const priced = list.filter((e) => e.cost != null && e.counted !== false);
  const dearest = priced.length
    ? priced.reduce((best, e) => ((e.cost ?? 0) > (best.cost ?? 0) ? e : best))
    : null;
  if (dearest && !covered.has(dearest.id) && (dearest.cost ?? 0) > 0 && kindOf(dearest) !== 'compaction') {
    const breakdown = breakdownOf ? breakdownOf(dearest) : null;
    const context = breakdown && breakdown.total > 0
      ? ` — ${pct(((breakdown.cacheRead + breakdown.cacheWrite) / breakdown.total) * 100)} of it context handling`
      : '';
    out.push({
      impact: dearest.cost ?? 0,
      line: `#${list.indexOf(dearest) + 1} was the dearest request at ${money(dearest.cost)}${context}.`,
    });
  }

  return out.sort((a, b) => b.impact - a.impact).slice(0, cap);
}

/**
 * Findings, trimmed to what a reader can act on.
 *
 * `action` is dropped deliberately. It is the dashboard's own generic advice, and
 * producing something better than it is exactly the job being handed over — quoting
 * it would anchor the answer to the thing we are trying to improve on.
 */
function findingsBlock(findings, cap = FINDING_CAP) {
  const list = findings || [];
  const positives = list.filter((f) => f.severity === 'positive').slice(0, 1);
  const rest = list.filter((f) => f.severity !== 'positive');
  return [...rest, ...positives]
    .slice(0, cap)
    .map((f, i) => `${i + 1}. [${f.severity}] ${f.title}. ${f.body}`)
    .join('\n');
}

/**
 * The rate card the arithmetic in rule 3 should be done against.
 *
 * Only worth its tokens when one rate card actually applies — on a session that
 * reached for four models there is no single set of numbers to quote, and quoting
 * one of them invites the reader to price the whole session with it.
 */
function ratesBlock(events, ratesOf) {
  if (!ratesOf) return null;
  const models = new Set(events.map((e) => e.model));
  if (models.size > 2) return null;
  const counts = new Map();
  for (const e of events) counts.set(e.modelRaw, (counts.get(e.modelRaw) || 0) + 1);
  const dominant = events.find((e) => e.modelRaw === [...counts.entries()]
    .sort((a, b) => b[1] - a[1])[0][0]);
  const rates = dominant ? ratesOf(dominant) : null;
  if (!rates || rates.input == null) return null;
  const per = (v) => (v == null ? '—' : `$${Number(v).toFixed(2)}`);
  return `- Rates in play (per 1M tokens): in ${per(rates.input)} · out ${per(rates.output)}`
    + ` · cache write ${per(rates.cacheWrite)} · cache read ${per(rates.cacheRead)}`;
}

/** Model mix, dearest first — "Auto (41), Claude Opus 4.5 (6)". */
function modelsBlock(events) {
  const byModel = new Map();
  for (const e of events) byModel.set(e.model, (byModel.get(e.model) || 0) + 1);
  return [...byModel.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([model, n]) => `${model} (${n})`)
    .join(', ');
}

/** Where a set of requests' money went, by token bucket. */
function spendBlock(events, breakdownOf) {
  if (!breakdownOf) return null;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let priced = 0;
  for (const event of events) {
    const breakdown = breakdownOf(event);
    if (!breakdown) continue;
    priced += 1;
    totals.input += breakdown.input;
    totals.output += breakdown.output;
    totals.cacheRead += breakdown.cacheRead;
    totals.cacheWrite += breakdown.cacheWrite;
    totals.total += breakdown.total;
  }
  return priced && totals.total > 0 ? totals : null;
}

const BUCKET_LABELS = {
  cacheRead: 'cache read',
  cacheWrite: 'cache write',
  output: 'output',
  input: 'input',
};

/**
 * The four token buckets, dearest first.
 *
 * Sorted rather than fixed-order because rule 5 asks the reader to lead with the
 * largest dollar item, and making them find it first is a small tax on every
 * answer. Empty buckets are dropped: "cache read $0.000 (0%)" on a cold start is
 * a true statement that costs tokens to make and tells nobody anything.
 */
function splitLine(spend) {
  return Object.keys(BUCKET_LABELS)
    .filter((key) => spend[key] > 0)
    .sort((a, b) => spend[b] - spend[a])
    .map((key) => `${BUCKET_LABELS[key]} ${money(spend[key])} (${pct((spend[key] / spend.total) * 100)})`)
    .join(' · ');
}

/**
 * The question the brief is asking.
 *
 * The user's own wording only counts when the chosen template is the one that
 * asks for it. Taking it whenever the box was non-empty meant a question typed
 * once quietly overrode every template picked after it, with nothing on screen
 * to say so.
 */
function taskBlock(template, question) {
  const custom = (question || '').trim();
  const wanted = template?.custom === true;
  return ['## Task', (wanted && custom) || template?.prompt || '', ''];
}

function joinBrief(parts) {
  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * One conversation, as a brief.
 *
 * `session` carries the identity the events cannot: `{ name, costBasis }`, where
 * costBasis says whether the dollars are money the plan billed or the what-if
 * value of the tokens. Without that line the same brief means two different
 * things depending on a toggle the reader can't see, and every recommendation
 * that follows is calibrated against the wrong number.
 */
export function buildSessionBrief({
  session = {},
  events = [],
  findings = [],
  breakdownOf,
  classify,
  ratesOf,
  formatTime,
  template,
  question,
} = {}) {
  if (!events.length) return '';
  const time = formatTime || defaultFormatTime;
  const kindOf = classify || (() => 'cached');
  const totals = sessionTotals(events)[0];
  const metrics = sessionMetrics(totals);
  const spend = spendBlock(events, breakdownOf);
  const curve = costCurve(events);
  const savings = events.reduce((s, e) => s + (e.cacheSavings ?? 0), 0);

  const parts = ['# Cursor session brief', '', BRIEF_PREAMBLE, '', ...taskBlock(template, question)];

  const identity = [
    '## Session',
    `- Name: ${session.name || session.id || 'unnamed conversation'}`,
    `- Window: ${time(totals.firstMs)} -> ${time(totals.lastMs)} (${dur(metrics.durationMs)})`,
    `- ${count(totals.requests)} requests${totals.erroredRequests
      ? ` (+${count(totals.erroredRequests)} errored, still charged)` : ''}`,
    `- Cost: ${money(totals.costDollars)} ${session.costBasis || 'billed by the plan'}`
      + `${metrics.costPerRequest != null ? ` · ${money(metrics.costPerRequest)}/request` : ''}`
      + ` · dearest single request ${money(totals.maxCostDollars)}`,
    `- Models: ${modelsBlock(events)}`,
  ];
  const rates = ratesBlock(events, ratesOf);
  if (rates) identity.push(rates);
  identity.push(
    `- Tokens: in ${count(totals.inputTokens)} · out ${count(totals.outputTokens)}`
      + ` · cache read ${count(totals.cacheReadTokens)} · cache write ${count(totals.cacheWriteTokens)}`,
  );
  if (metrics.cacheHitRate != null) {
    identity.push(`- ${pct(metrics.cacheHitRate)} of tokens served from cache`
      + `${savings > 0 ? `; est. ${money(savings)} saved against full input price` : ''}`);
  }
  parts.push(...identity, '');

  if (spend) {
    // Named precisely, because the reader is asked to lead its answer with the
    // largest dollar item: the leftover after context is output *and* input,
    // and calling the pair "the answers" hands the model a false premise about
    // the one split the whole brief is arguing from.
    const split = spendSplit(spend);
    parts.push(
      `## Where the ${money(totals.costDollars)} went`,
      `- ${splitLine(spend)}`,
      `Context handling${split.contextLabel ? ` (${split.contextLabel})` : ''} was `
        + `${pct(split.contextPct)} of this session; the answers were ${pct(split.outputPct)} and the `
        + `prompts I sent ${pct(split.inputPct)}.`,
      '',
    );
  }

  // Markers say *where* the shape changes; the events list below says what it cost.
  // Splitting them that way keeps the curve to four lines however eventful the
  // session was.
  const markers = [];
  events.forEach((event, index) => {
    if (kindOf(event) === 'compaction') {
      markers.push(`compaction at #${index + 1} (slice ${sliceOf(index, curve)})`);
      return;
    }
    const previous = events[index - 1];
    if (!previous) return;
    const gap = event.timestampMs - previous.timestampMs;
    if (gap >= NOTABLE_GAP_MS) {
      markers.push(`${dur(gap)} idle before #${index + 1} (slice ${sliceOf(index, curve)})`);
    }
  });

  parts.push(
    `## Cost curve — ${curve.length} equal slices, oldest -> newest`,
    `reqs      ${curve.map((s) => s.count).join(' / ')}`,
    `$         ${curve.map((s) => (s.cost).toFixed(2)).join(' / ')}`,
    `med read  ${curve.map((s) => tok(s.medianRead)).join(' / ')}`,
    markers.length ? `markers   ${markers.slice(0, 6).join(' · ')}` : 'markers   none',
    '',
  );

  const other = briefEvents(events, findings, { classify, breakdownOf, formatTime });
  if (other.length) {
    parts.push('## Other events', ...other.map((e) => `- ${e.line}`), '');
  }

  if (findings.length) {
    parts.push(
      '## Dashboard findings (rule-based, already shown to me — extend or correct these,',
      '   do not restate them)',
      findingsBlock(findings),
      '',
    );
  }

  parts.push('---', 'Notes:', ...BRIEF_NOTES);
  return joinBrief(parts);
}

/**
 * One request, as a brief: one request back, three forward.
 *
 * The asymmetry is the whole design. The state a request *arrives* in is already
 * summarised by two numbers we have — the idle gap since the previous request and
 * the session's median cache read, which uses every request rather than a sample
 * of three. What nothing else can supply is what happened *next*: whether the
 * money a huge re-cache spent was amortised over the turns that followed or thrown
 * away when the thread was abandoned. That is the difference between "expensive
 * but correct" and "you paid $6.72 to say goodbye", and no other line in the brief
 * can settle it.
 */
export function buildRequestBrief({
  event,
  sessionEvents = [],
  session = {},
  findings = [],
  breakdownOf,
  classify,
  ratesOf,
  formatTime,
  template,
  question,
} = {}) {
  if (!event) return '';
  const time = formatTime || defaultFormatTime;
  const kindOf = classify || (() => 'cached');
  const list = sessionEvents.length ? sessionEvents : [event];
  const index = list.findIndex((e) => e.id === event.id);
  const at = index < 0 ? 0 : index;
  const breakdown = breakdownOf ? breakdownOf(event) : null;

  const parts = ['# Cursor request brief', '', BRIEF_PREAMBLE, '', ...taskBlock(template, question)];

  const shape = {
    compaction: 'compaction — Cursor summarising the thread, not a request I made',
    coldStart: 'cold start — nothing read from cache, so this began a fresh context',
    cached: 'ordinary turn — served largely from the prompt cache',
    small: 'short request — barely any context moved',
  }[kindOf(event)];

  const own = [
    '## The request',
    `- ${time(event.timestampMs)} · ${event.model} · ${money(event.cost ?? 0)} `
      + `${session.costBasis || 'billed by the plan'}`,
    `- Tokens: in ${count(event.inputTokens)} · out ${count(event.outputTokens)}`
      + ` · cache read ${count(event.cacheReadTokens)} · cache write ${count(event.cacheWriteTokens)}`,
  ];
  if (breakdown && breakdown.total > 0) own.push(`- Cost split: ${splitLine(breakdown)}`);
  own.push(`- Shape: ${shape}`);
  const rates = ratesBlock([event], ratesOf);
  if (rates) own.push(rates);
  parts.push(...own, '');

  const sessionCost = list.reduce((s, e) => s + (e.cost ?? 0), 0);
  const where = [
    '## Where it sits',
    `- Session "${session.name || session.id || 'unnamed conversation'}" — request `
      + `#${at + 1} of ${list.length}, session total ${money(sessionCost)}`
      + `${sessionCost > 0 ? `. This one request is ${pct(((event.cost ?? 0) / sessionCost) * 100)} of it` : ''}.`,
    `- Session normal: median ${money(median(list.map((e) => e.cost ?? 0)))}/request, `
      + `median cache read ${count(median(list.map((e) => e.cacheReadTokens || 0).filter((v) => v > 0)))} tokens.`,
  ];

  // One request back, and a second only when that one is itself interesting —
  // otherwise the gap and the session median have already said everything the
  // preceding requests could.
  const before = [];
  for (let i = at - 1; i >= 0 && before.length < 2; i -= 1) {
    const prior = list[i];
    const gap = list[i + 1].timestampMs - prior.timestampMs;
    before.unshift(`#${i + 1} at ${time(prior.timestampMs)}, ${money(prior.cost ?? 0)}, `
      + `cache read ${count(prior.cacheReadTokens)} — ${dur(gap)} before this one.`);
    const interesting = kindOf(prior) === 'compaction'
      || findings.some((f) => f.anchor?.requestId === prior.id);
    if (!interesting) break;
  }
  if (before.length) where.push(`- Before: ${before.join(' ')}`);

  const after = list.slice(at + 1, at + 4);
  if (after.length) {
    const tail = list.slice(at + 4);
    where.push(`- After: ${after.map((e, i) => `#${at + 2 + i} ${money(e.cost ?? 0)} `
      + `(read ${tok(e.cacheReadTokens)})`).join(' · ')}.`
      + (tail.length
        ? ` The session then ran ${count(tail.length)} more request${tail.length === 1 ? '' : 's'} `
          + `totalling ${money(tail.reduce((s, e) => s + (e.cost ?? 0), 0))} and ended.`
        : ' The session ended there.'));
  } else {
    where.push('- After: nothing — this was the last request in the session.');
  }
  parts.push(...where, '');

  if (findings.length) {
    parts.push(
      '## Dashboard findings on this request (extend or correct, do not restate)',
      findingsBlock(findings),
      '',
    );
  }

  parts.push('---', 'Notes:', ...BRIEF_NOTES);
  return joinBrief(parts);
}
