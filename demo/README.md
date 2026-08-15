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
node demo/generate-voiceover.mjs  # pass 1: synthesizes narration-only clips + a nominal manifest
node demo/record.mjs              # pass 2: drives harness.html with Playwright, writes demo/out/*.webm,
                                   #         then resyncs demo/out/voice/narration.wav to the *measured*
                                   #         per-beat timing (pass 3, runs automatically at the end)
./demo/render.sh                  # muxes video + narration.wav into demo/out/demo.mp4, plus demo/out/demo.gif
```

Narration is entirely optional — skip `generate-voiceover.mjs` and the other
two steps still produce a silent, caption-only video (each beat falls back to
its `minMs` floor in `script.mjs`).

Why three passes instead of one: `record.mjs`'s own Playwright actions
(`click`, `evaluate`, locator queries) take real wall-clock time on top of
each beat's `waitForTimeout`, so the actual recording always runs a bit
longer than the nominal duration `generate-voiceover.mjs` used to size the
narration — and that gap compounds beat over beat. Rather than guess a fudge
factor, `record.mjs` measures the *real* elapsed time of every beat as it
records, then rebuilds `narration.wav` from the narration-only clips padded
to those measured durations once the browser closes. `render.sh` also reads
`demo/out/lead-ms.txt` (written by `record.mjs`) to delay the whole narration
track by the page's initial load time, since Playwright's video starts
capturing before the scripted timeline does.

`record.mjs` and `render.sh` shell out to a specific Chromium/ffmpeg binary
path by default (this repo's sandbox has Playwright's bundled Chromium at
`/opt/pw-browsers/...` and a full-featured system `ffmpeg`; espeak-ng needs
the `espeak-ng` and `mbrola-us1` packages). Override with
`DEMO_CHROMIUM=/path/to/chrome`, `DEMO_FFMPEG=/path/to/ffmpeg`, or
`DEMO_ESPEAK=/path/to/espeak-ng` if those differ in your environment.
`generate-voiceover.mjs` also takes `--voice` (any `espeak-ng --voices=mbrola`
name, default `mb-us1`) and `--rate` (words per minute, default 165).
Playwright itself needs to be resolvable — either `npm install playwright`
locally, or point `NODE_PATH` at wherever it's installed globally.

## What it shows

Intro card → status bar screenshot (`docs/screenshot-statusbar.png`) →
Overview (cost/requests/cache stats + a budget burn-rate projection,
deliberately on a dollar-metered "Business" plan so that card renders) →
Requests table → Analytics charts → Analyze Findings → Compare periods →
Sessions (including a two-session compare) → Simulator (with a measured Grok
4.6 discount, so the "Discounted" badge shows up for real) → outro card, each
beat narrated per `script.mjs`.

## Files

- `script.mjs` — single source of truth for the beats: on-screen caption,
  spoken narration line, and (for beats with no narration) a `minMs` floor.
  Edit narration/caption wording here.
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
- `audio-util.mjs` — shared ffmpeg/wav helpers (duration probing, silence
  generation, concatenation, padding) used by the two scripts below.
- `generate-voiceover.mjs` — pass 1: synthesizes each beat's narration-only
  clip with espeak-ng/mbrola and writes a nominal `manifest.json`.
- `record.mjs` — pass 2: Playwright script that plays through every tab,
  measures each beat's real elapsed time, and (pass 3) resyncs
  `narration.wav` to that measured timing once recording finishes.
- `render.sh` — muxes the recorded `.webm` with `narration.wav` (delayed by
  `lead-ms.txt`) into `.mp4`, and also writes a silent `.gif`.

`data.js` and `out/` are gitignored — they're generated artifacts, not
source. Re-run the pipeline above to regenerate them (e.g. after a UI change,
after editing `script.mjs`, or just to get fresh relative dates).

If `src/html.ts`'s body markup changes, `harness.html` needs the same edit —
it's a copy, not a template, so the ids `main.js` looks up keep matching.
