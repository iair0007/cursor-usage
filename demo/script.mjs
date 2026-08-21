// Shared source of truth for the demo video's beats: what's on screen, the
// on-screen caption, and the spoken narration line. demo/generate-voiceover.mjs
// synthesizes audio per beat and measures its real duration;
// demo/record.mjs then waits exactly that long (plus TAIL_PAD_MS) before
// cutting to the next beat, so the recorded video and the narration track
// stay in sync without either script hard-coding timings the other has to
// guess at.
//
// Edit narration/caption text here, then re-run:
//   node demo/generate-voiceover.mjs && node demo/record.mjs && ./demo/render.sh

// Extra dwell after each beat's narration finishes, before cutting to the
// next — gives the visual a beat to breathe instead of feeling rushed.
export const TAIL_PAD_MS = 500;

// Keep each line long enough to cover its beat's on-screen action.
//
// A beat lasts max(narration, minMs) plus this pad plus however long its
// Playwright actions take, and the narration is what usually sets that — so a
// short line under a beat with a lot to do (Sessions ticks two checkboxes,
// opens a dialog and holds it; Install types a publisher name a character at a
// time) leaves the voice finished while the screen is still working, which
// plays as dead air. The fix is a longer line, not a faster visual: there is
// always more true detail worth saying about what is on screen. After changing
// wording, re-run the pipeline and compare each beat's measured length in
// out/beat-timing.json against its narrationMs in out/voice/manifest.json —
// the gap should be roughly TAIL_PAD_MS, not seconds.

/**
 * Splits a beat's narration into subtitle-sized chunks.
 *
 * The on-screen caption is the narration verbatim, so it has to be broken up:
 * a whole beat's line is two or three sentences, far past what fits legibly in
 * one caption. Splits on sentence ends first, then commas and em dashes, and
 * greedily repacks the pieces up to `maxChars` — so breaks land where the
 * voice already pauses instead of mid-clause.
 */
export function captionChunks(narration, maxChars = 84) {
  if (!narration) return [];
  const pieces = narration
    .split(/(?<=[.!?])\s+|(?<=,)\s+|\s+(?=—)/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks = [];
  let current = '';
  for (const piece of pieces) {
    const merged = current ? `${current} ${piece}` : piece;
    if (merged.length > maxChars && current) {
      chunks.push(current);
      current = piece;
    } else {
      current = merged;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Each beat's on-screen subtitle is its `narration` verbatim, chunked by
// captionChunks() above — there is deliberately no separate caption field, so
// the two can never drift apart.
export const BEATS = [
  {
    id: 'intro',
    narration: 'Cursor Usage Dashboard shows exactly where your Cursor spend and requests go — broken down by model, by day, and by conversation.',
  },
  {
    id: 'statusBar',
    narration: "It lives right in your status bar, always visible while you code. Hover over it for the full breakdown — including how many days of budget you have left at your current pace.",
    minMs: 5200,
  },
  {
    id: 'overview',
    narration: "The Overview totals your cost, requests, and cache savings for the period, and projects your burn rate on budget-metered plans — so you know if you'll run out before the cycle resets.",
    minMs: 2200,
  },
  {
    id: 'requestsTable',
    narration: "Every request is logged here, with its exact token cost. Filter by model or date, or export the whole thing to CSV if you'd rather dig through it in a spreadsheet.",
    minMs: 2600,
  },
  {
    id: 'discount',
    // Cursor does announce its sales — in the IDE and in blog posts. What it
    // never does is put them in the published price list this extension
    // reads, which is the whole reason measuring them from the bill is
    // necessary. Saying "without announcing it" would be untrue, and it
    // contradicts the extension's own copy in src/html.ts (#simIntroBody).
    narration: 'Cursor announces its model sales in the IDE, but its published price list never changes — so a discounted model still looks full price. This measures the real discount from your own bill and flags it automatically.',
    minMs: 3200,
  },
  {
    id: 'requestsAnalytics',
    narration: 'The Analytics tab charts the same data — daily cost trends, which models are driving your bill, and how much of your usage is cache rather than fresh tokens, day by day.',
    minMs: 2600,
  },
  {
    id: 'findings',
    narration: "Rule-based findings scan your usage for patterns worth knowing — a model quietly becoming your biggest cost, or a spike on one specific day — so you don't have to go hunting for them yourself, load after load.",
    minMs: 2600,
  },
  {
    id: 'compare',
    narration: 'Compare stacks any two periods side by side, sorted by whatever moved the most — so you can see immediately whether last week was an outlier or the new normal, model by model.',
    minMs: 2200,
  },
  {
    id: 'sessions',
    narration: 'Sessions group every request by conversation instead of by day, so you can see what a single chat actually cost — and compare two sessions directly to spot which one burned through your budget, and which models each of them leaned on.',
    minMs: 6000,
  },
  {
    id: 'simulator',
    narration: "The Simulator replays a request you already made against every other model's pricing, so you see what it would've cost elsewhere — accounting for real discounts too, and saying so when it can't be sure.",
    minMs: 3000,
  },
  {
    id: 'install',
    narration: "To install it, open the Extensions panel and search for the publisher name, iair0007 — that finds it faster than searching for the extension itself.",
    minMs: 6000,
  },
  {
    id: 'outro',
    narration: "It's free on Open VSX, installs in seconds, and needs no proxy and no separate login — just your Cursor account.",
  },
];

/**
 * The 60-second cut, for social feeds where the full walkthrough is far longer
 * than anyone scrolling will watch.
 *
 * Not a trimmed re-edit of the long one: every line is rewritten short, because
 * the beats are the same on-screen actions and it is the narration that sets
 * each beat's length (record.mjs waits out the audio). Beats whose actions take
 * longer than their line — Sessions has two checkboxes, a dialog to open and
 * time to read it; Install types a publisher name a character at a time — carry
 * a `minMs` floor well above their narration so the visual still lands.
 *
 * Beat choice follows what the extension is actually distinctive for rather
 * than tab order: the status bar, the request log and the Analytics charts are
 * all cut, since a feed viewer will not miss them and they cost ~30s between
 * them.
 */
export const SHORT_BEATS = [
  {
    id: 'intro',
    narration: 'See exactly where your Cursor tokens and money go.',
  },
  {
    id: 'overview',
    narration: 'Your cost, requests and cache savings — plus how many days of budget you have left at your current pace.',
    minMs: 2000,
  },
  {
    id: 'discount',
    // Same correction as the full cut's discount beat: Cursor announces its
    // sales, just never in the price list this extension reads.
    narration: 'Cursor announces model sales, but never in its price list — so this measures the real discount from your own bill.',
    minMs: 3000,
  },
  {
    id: 'compare',
    narration: 'Compare any two periods — this month against last — sorted by what moved most.',
    minMs: 2000,
  },
  {
    id: 'sessions',
    narration: 'Or group spend by conversation, and put two side by side to see which chat burned through your budget, and on what.',
    minMs: 7500,
  },
  {
    id: 'simulator',
    narration: "Replay a real request against other models to see what it would've cost.",
    minMs: 3000,
  },
  {
    id: 'install',
    narration: "It's free on Open VSX — search the publisher name, iair0007, in the Extensions panel.",
    minMs: 6000,
  },
  {
    id: 'outro',
    narration: 'No proxy, no extra login — just your Cursor account.',
  },
];

/**
 * The session cut — one conversation followed from start to finish.
 *
 * The other two cuts tour the tabs; this one tells a story, because the
 * session features only mean anything against a conversation that went wrong.
 * It follows `conv_authnight` from generate-fixtures.mjs: an ordinary refactor
 * whose context blew out, got summarised, grew straight back, and was finally
 * resumed hours later against an expired cache.
 *
 * Two rules govern the wording. No dollar figure is spoken — the screen shows
 * them and the fixtures regenerate with fresh dates, so a number in the
 * narration would eventually contradict the picture beside it. And nothing is
 * claimed that the findings on screen do not say: demo/verify-story.mjs runs
 * the real rules over the real fixture data and fails if any of the three this
 * script names stops firing, or drops below FINDING_CARD_LIMIT where the
 * camera would never see it.
 */
export const SESSION_BEATS = [
  {
    id: 'sessionIntro',
    narration: "One long agent chat can cost more than a whole week of ordinary work — and by the time you notice, it's already on the bill. This is what the dashboard can tell you about a conversation that got away from you.",
  },
  {
    id: 'sessionsList',
    narration: 'Sessions groups every request by the conversation it came from, so one chat reads as one row: what it cost, how long it ran, and which models it reached for. The names come from Cursor\'s own local chat index — nothing you wrote is ever read, and no title leaves your machine.',
    minMs: 3200,
  },
  {
    id: 'sessionOpen',
    narration: 'Open one and you get where its money actually went, by token bucket. On a long agent session most of it is cache reads — the accumulated thread being re-sent, turn after turn — rather than the answers you were waiting for.',
    minMs: 3400,
  },
  {
    id: 'sessionTimeline',
    narration: 'One bar per request, in the order you asked them, each priced, with the share that was re-read context shaded in. Hover any of them for what it cost and what that cost was made of. The striped bar is Cursor summarising the thread — and the tallest bar is not a long answer at all, it is what it cost to come back to this conversation hours later.',
    minMs: 7000,
  },
  {
    id: 'sessionFindings',
    narration: 'The findings anchored to the session say what happened, and when. Coming back after three and a half hours cost the most — the cache had expired, so the whole thread was written again before any work happened. One request read six times more context than the rest of the conversation. And summarising did bring it down, before the thread grew straight back, which is the moment a fresh chat beats another summary. All of it derived from token counts and timestamps, never from anything you wrote.',
    minMs: 7500,
  },
  {
    id: 'findingToRequest',
    narration: 'Every finding links to the request it is about. Open the row and the cost breaks down by bucket, so you can check the claim yourself: a few cents of answer, and the rest re-reading context you had already paid for once.',
    minMs: 5000,
  },
  {
    id: 'sessionAsk',
    narration: 'Or hand the session to Cursor Chat. The brief carries token counts, timings and costs, and nothing you typed, because none of it is ever read. It is built small on purpose — the analysis costs tokens too — and it tells you its size and what sending it is worth before you send anything. It fills the chat box and stops there: nothing goes until you have read it and pressed Enter.',
    minMs: 8000,
  },
  {
    id: 'sessionCompare',
    narration: 'And you can put two conversations side by side. Same kind of work, same day — but in this one the summary held, and the context never grew back.',
    minMs: 5500,
  },
  {
    // Reuses the full cut's `install` handler and its mock Extensions panel —
    // same beat id, so record.mjs dispatches to the same code. The publisher
    // search is the point: the extension has few downloads, so searching its
    // name buries it, while the publisher name finds it first hit.
    id: 'install',
    narration: 'To install it, open the Extensions panel and search for the publisher name, iair0007 — that finds it faster than searching for the extension itself.',
    minMs: 6000,
  },
  {
    id: 'sessionOutro',
    narration: "It's free on Open VSX, and needs no proxy and no separate login — just your Cursor account.",
  },
];

/**
 * The under-a-minute session cut, for feeds where the two-and-a-half minute
 * walkthrough is longer than anyone scrolling will watch.
 *
 * Every id here already has a handler in record.mjs, and the order keeps the
 * dependency those handlers carry: `sessionTimeline` and `sessionFindings`
 * both read the detail dialog `sessionOpen` opens, so they have to follow it.
 * Cut are the sessions list, the finding-to-request jump and the two-session
 * comparison — leaving one arc: open a session, see the bar that cost the
 * most, learn why, hand the numbers on.
 *
 * The narration is rewritten rather than truncated, and each beat is allowed
 * exactly one idea — at this length a line that restates an earlier one is the
 * most expensive thing in the cut. So the 3.5h resume is explained once, on
 * the plot where it is visible (not again in the findings), and the privacy
 * claim is made once, on the findings beat (not again on the Cursor Chat one).
 */
export const SESSION_SHORT_BEATS = [
  {
    id: 'sessionIntro',
    narration: 'One long agent chat can cost more than a week of ordinary work.',
  },
  {
    id: 'sessionOpen',
    narration: 'Open the session and you see where the money actually went, by token bucket — mostly context handling rather than new work.',
    minMs: 4000,
  },
  {
    // The plot carries this beat, so it hovers only two bars: an ordinary turn
    // for scale, then the peak the line is about. The long cut's four-stop tour
    // of the blowup and the summary bar is a different story than this one.
    id: 'sessionTimeline',
    narration: 'One bar per request. The tallest is not a long answer — it is the price of coming back after three and a half hours: the cache had expired, so the whole thread was written again before any work happened.',
    timelineStops: [5, 21],
    minMs: 5000,
  },
  {
    // Where the privacy claim lands, once. It belongs on this beat rather than
    // on the Cursor Chat one because this is the beat that shows conclusions
    // being drawn — the natural place a viewer wonders how much was read to
    // draw them. Saying it here also frees the Ask beat to make its own point
    // instead of repeating this one.
    id: 'sessionFindings',
    narration: 'The extension spots that on its own. It reads only token counts and timestamps — never your prompts, your code, or anything the conversation said.',
    minMs: 5000,
  },
  {
    id: 'sessionAsk',
    narration: 'Hand the numbers to Cursor Chat when you want a second opinion — it shows you the brief, and what it costs, before anything is sent.',
    minMs: 5000,
  },
  {
    id: 'install',
    narration: 'Search the publisher iair0007 in your Extensions panel. Free, no proxy, no login.',
    minMs: 5500,
  },
];

/**
 * The beats for a named cut — `full` (the default), `short`, `session`, or
 * `session-short`.
 */
export function beatsForCut(cut) {
  if (cut === 'short') return SHORT_BEATS;
  if (cut === 'session') return SESSION_BEATS;
  if (cut === 'session-short') return SESSION_SHORT_BEATS;
  return BEATS;
}

/**
 * Where a cut's artifacts live, relative to demo/.
 *
 * The full cut keeps writing straight to demo/out/ as it always has, so its
 * existing files and the paths other things reference stay put; other cuts get
 * a subdirectory of their own. Every stage (voice clips, manifest, .webm, mp4)
 * is namespaced this way, so re-rendering one cut can never clobber another's.
 */
export function outDirForCut(cut) {
  if (cut === 'full') return 'out';
  return `out/${cut}`;
}
