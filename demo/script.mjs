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

/** The beats for a named cut — `full` (the default) or `short`. */
export function beatsForCut(cut) {
  return cut === 'short' ? SHORT_BEATS : BEATS;
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
  return cut === 'short' ? 'out/short' : 'out';
}
