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
export const TAIL_PAD_MS = 300;

export const BEATS = [
  {
    id: 'intro',
    caption: null, // baked into the #demoIntro slide itself
    narration: 'Cursor Usage Dashboard — see exactly where your money goes.',
  },
  {
    id: 'statusBar',
    caption: null, // baked into the #demoStatusBar slide itself
    narration: 'A live usage figure sits right in your status bar.',
  },
  {
    id: 'overview',
    caption: 'Cost, requests, cache savings — plus a live budget burn-rate',
    narration: 'Cost, requests, cache savings — plus a live budget burn-rate.',
  },
  {
    id: 'requestsTable',
    caption: 'The full request log — filters, per-request cost, CSV export',
    narration: 'The full request log — filters, per-request cost, CSV export.',
    minMs: 1500,
  },
  {
    id: 'requestsAnalytics',
    caption: 'Daily cost, model breakdown, token volume',
    narration: 'Daily cost, model breakdown, and token volume, charted.',
    minMs: 1500,
  },
  {
    id: 'findings',
    caption: 'Rule-based findings — what’s actually driving your bill',
    narration: 'Rule-based findings tell you what’s actually driving your bill.',
    minMs: 1500,
  },
  {
    id: 'compare',
    caption: 'Compare any two periods, sorted by biggest mover',
    narration: 'Compare any two periods, sorted by biggest mover.',
    minMs: 1200,
  },
  {
    id: 'sessions',
    caption: 'Group spend by conversation, then compare sessions side by side',
    narration: 'Group spend by conversation, and compare sessions side by side.',
    minMs: 3200,
  },
  {
    id: 'simulator',
    caption: 'Simulate costs across models — and catch real promotions',
    narration: 'Simulate costs across models, and catch real promotions.',
    minMs: 1800,
  },
  {
    id: 'outro',
    caption: null, // baked into the #demoOutro slide itself
    narration: 'Free on Open VSX — zero setup, install it today.',
  },
];
