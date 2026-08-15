# Demo video generator

Produces a ~30s walkthrough video of the dashboard, without needing a real
Cursor install or a real cursor.com account. It runs the actual webview
bundle (`media/main.js`, built from `src/webview/`) in a plain browser tab,
with `bridge.js` standing in for the extension host (`src/panel.ts`) and
serving synthetic-but-realistic usage data instead of live RPC calls.

## Pipeline

```bash
npm install
npm run compile              # builds media/main.js + media/styles.css

node demo/generate-fixtures.mjs   # writes demo/data.js (gitignored, regenerate any time)
node demo/record.mjs              # drives demo/harness.html with Playwright, writes demo/out/*.webm
./demo/render.sh                  # converts the .webm to demo/out/demo.mp4 + demo/out/demo.gif
```

`record.mjs` and `render.sh` shell out to a specific Chromium/ffmpeg binary
path by default (this repo's sandbox has Playwright's bundled Chromium at
`/opt/pw-browsers/...` and a full-featured system `ffmpeg`). Override with
`DEMO_CHROMIUM=/path/to/chrome` / `DEMO_FFMPEG=/path/to/ffmpeg` if those
differ in your environment. Playwright itself needs to be resolvable — either
`npm install playwright` locally, or point `NODE_PATH` at wherever it's
installed globally.

## What it shows

Intro card → status bar screenshot (`docs/screenshot-statusbar.png`) →
Overview (cost/requests/cache stats + a budget burn-rate projection,
deliberately on a dollar-metered "Business" plan so that card renders) →
Requests table → Analytics charts → Analyze Findings → Compare periods →
Sessions (including a two-session compare) → Simulator (with a measured Grok
4.6 discount, so the "Discounted" badge shows up for real) → outro card.

## Files

- `generate-fixtures.mjs` — synthesizes ~45 days of usage events, sessions,
  a budget/burn-rate story, and a real (measured) promotional-discount
  window, and writes them to `data.js` as `window.__DEMO_DATA__`.
- `pricing.md` — a small pricing table in the same format `matchPricing()`
  parses from the real cursor.com page, used only by the harness.
- `bridge.js` — fakes `acquireVsCodeApi()` and answers the webview's RPC
  calls (`usage`, `pricing`, `budget`, `sessionTitles`, …) from `data.js`
  instead of a real extension host.
- `harness.html` — the dashboard's body markup (kept in sync with
  `src/html.ts` by hand) plus demo-only intro/outro slides and a caption bar.
- `overlay.css` — styling for the demo-only slides/captions.
- `record.mjs` — Playwright script: loads the harness, waits for the first
  render, then scripts a tour of every tab with timed caption changes while
  recording video.
- `render.sh` — converts the recorded `.webm` to `.mp4` and `.gif`.

`data.js` and `out/` are gitignored — they're generated artifacts, not
source. Re-run the pipeline above to regenerate them (e.g. after a UI change,
or just to get fresh relative dates).

If `src/html.ts`'s body markup changes, `harness.html` needs the same edit —
it's a copy, not a template, so the ids `main.js` looks up keep matching.
