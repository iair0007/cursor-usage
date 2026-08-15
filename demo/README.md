# Demo video generator

Produces a narrated walkthrough video of the dashboard, without needing a real
Cursor install or a real cursor.com account. It runs the actual webview
bundle (`media/main.js`, built from `src/webview/`) in a plain browser tab,
with `bridge.js` standing in for the extension host (`src/panel.ts`) and
serving synthetic-but-realistic usage data instead of live RPC calls.

## Cuts

Two videos come out of the same harness, fixtures and beat handlers — they
differ only in which beats they play and how the narration is worded:

| Cut | Length | Beats | Output | For |
| --- | --- | --- | --- | --- |
| `full` (default) | ~2m25s | 12 | `demo/out/` | the marketplace listing, docs, anyone who wants the whole tour |
| `short` | ~50s | 8 | `demo/out/short/` | social feeds, where nobody watches two minutes |

Each cut owns its directory for every stage (voice clips, manifest, `.webm`,
mp4, gif), so re-rendering one can never overwrite the other. Pass
`--cut short` to the two node scripts and `short` to `render.sh`; omitting it
everywhere gives the full cut, exactly as before.

The short cut is not a trimmed re-edit — its narration is rewritten shorter in
`script.mjs`'s `SHORT_BEATS`, because each beat's length is set by its
narration audio. It drops the status bar, request log and Analytics beats,
keeping what the extension is distinctive for: the budget runway, the measured
discount, period/session comparison, the Simulator, and how to install it.

## Pipeline

`playwright` (drives the harness) and `kokoro-js` (synthesizes the narration)
are **deliberately not devDependencies**, and are installed on demand instead.
Between them they pull ~390MB — mostly `onnxruntime-node` and
`@huggingface/transformers` — and `npm ci` installs devDependencies, so every
CI run and every contributor doing nothing but `npm run compile` would have
paid for a video pipeline they never invoke. Both scripts print this command
if the package is missing, so there is nothing to remember:

```bash
npm install --no-save playwright kokoro-js
npx playwright install chromium   # once, for the browser itself
```

Then:

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

The same three steps for the 60-second cut:

```bash
node demo/generate-voiceover.mjs --cut short
node demo/record.mjs --cut short
./demo/render.sh short            # writes demo/out/short/demo.mp4 + .gif
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
`DEMO_CHROMIUM=/path/to/chrome`, `DEMO_FFMPEG=/path/to/ffmpeg`,
`DEMO_ESPEAK=/path/to/espeak-ng`, or `DEMO_SAY=/path/to/say` if those differ
in your environment.
Playwright itself needs to be resolvable — either `npm install --no-save
playwright` locally (see above), or point `NODE_PATH` at wherever it's
installed globally.

### Voice engine

`generate-voiceover.mjs --engine <kokoro|say|espeak>` picks the synthesizer:

- **`kokoro`** (default) — [Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX),
  an open-weight (MIT-licensed) neural TTS model run fully locally via the
  `kokoro-js` npm package (an `onnxruntime` dependency, no PyTorch/Python
  needed). No API key, no account, no cloud calls — just a one-time ~86MB
  model download from Hugging Face on first run, cached under
  `node_modules/@huggingface/transformers/.cache` (so a clean `npm install`
  re-downloads it). Sounds close to a real narrator, clearly better than
  `say`/`espeak`. `--voice` takes any Kokoro voice name — `af_heart` (US
  female, the default) and `bf_emma` (British female) are good starting
  points; `--speed` is a multiplier (default `1.0`). Needs internet access to
  Hugging Face the first time it runs; after that it's fully offline.
- **`say`** — macOS's built-in TTS (the same engine behind Siri/VoiceOver).
  Sounds like an actual person, but is a level below Kokoro. `--voice` takes
  any installed voice name (`Samantha` ships on every Mac with no download;
  `say -v '?'` lists what you have; for a better result, download a
  Premium/Enhanced voice — System Settings → Accessibility → Spoken Content →
  System Voice → Manage Voices — and pass it quoted, e.g.
  `--voice "Ava (Premium)"`). Only runs on macOS itself.
- **`espeak`** (espeak-ng + an mbrola diphone voice) — no model download, so
  it works even behind network policies that block Hugging Face/GitHub
  (this repo's sandboxed environment, notably, which is why it's used there
  instead of `kokoro`). Sounds synthetic — a GPS voice, not a narrator.
  `--voice` takes any name from `espeak-ng --voices=mbrola` (default
  `mb-us1`); `--rate` is words per minute (default 165).

Run the full pipeline on your own Mac (with Claude Code or a plain terminal —
no MCP server needed):

  ```bash
  npm install && npm run compile
  npm install --no-save playwright kokoro-js   # not devDependencies — see Pipeline
  npx playwright install chromium              # once, first time
  node demo/generate-fixtures.mjs
  node demo/generate-voiceover.mjs   # kokoro, af_heart — add --voice/--speed to tweak
  node demo/record.mjs
  ./demo/render.sh        # needs ffmpeg — `brew install ffmpeg`
  ```

## What it shows

Intro card → status bar (a mocked-up IDE window — see below — with a real
`:hover` tooltip and a pointing arrow) → Overview (cost/requests/cache stats +
a budget burn-rate projection, deliberately on a dollar-metered "Business"
plan so that card renders) → Requests table → a dedicated discount beat
(widens the page and highlights an actual `.discount-tag`-badged row so a
real detected Grok 4.6 promotion is on screen, not just mentioned) →
Analytics charts → Analyze Findings → Compare periods → Sessions (including a
two-session compare, whose dialog holds the screen for the rest of that beat)
→ Simulator (its one-time intro dialog is pre-dismissed via `bridge.js` so
the tab's real content shows immediately; the discount summary is scrolled
into view too) → an install beat (a mocked Extensions panel that Playwright
really types `iair0007` into — the publisher name finds the extension faster
than its own name does) → outro card, each beat narrated per `script.mjs`
and subtitled with that same narration verbatim.

A fake cursor (`demo/cursor-overlay.js` + `overlay.css`'s `#demoCursor`)
tracks Playwright's real mouse — every click in `record.mjs` moves the mouse
there first via `clickWithCursor()`/`moveCursorToCenterOf()`, so the video
shows where each action is happening rather than cutting straight to the
result. Clicks also leave a brief ripple.

The status-bar and install beats don't screenshot a real Cursor window — this
pipeline only ever runs the dashboard webview standalone (see the top of this
file), never the full IDE around it — so `harness.html`'s `#demoStatusBar`
and `#demoInstall` slides mock a minimal editor window instead (`.ide-mock`
in `overlay.css`). The status-bar pill and its hover card are not hand-written
prose: `demo-runtime.js` builds both from `data.js` using the same format
strings as `statusBarText()` and the tooltip in `src/statusBar.ts`, down to
the budget runway line ("At $X/day (cycle average): ~N days of budget left"),
so they re-derive whenever the fixtures do.

## Files

- `script.mjs` — single source of truth for the beats of both cuts (`BEATS`
  and `SHORT_BEATS`, resolved by `beatsForCut()`), and for where each cut's
  files go (`outDirForCut()`). A beat is its spoken narration line plus a
  `minMs` floor for beats whose on-screen action needs longer than the audio.
  Edit narration wording here. `record.mjs` holds one handler per beat *id*,
  so a cut is just a list of ids and either cut can use any beat. Also exports `captionChunks()`,
  which splits a narration line into subtitle-sized pieces at sentence,
  comma, and em-dash boundaries — the subtitles are the narration verbatim,
  so there is no separate caption text that could drift out of sync with it.
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
- `overlay.css` — styling for the demo-only slides/subtitles, the fake
  cursor/click-ripple, the status-bar and Extensions-panel IDE mocks, and the
  discount-row highlight.
- `demo-runtime.js` — the demo-only page runtime, loaded by `harness.html`:
  draws the fake cursor and click ripple from real `mousemove`/`mousedown`
  events (driven by `record.mjs`'s actual Playwright mouse movements), runs
  the subtitle player, and fills in the status-bar mock's pill and hover
  tooltip from the fixture data, mirroring the format strings in
  `src/statusBar.ts` / `src/shared/usageLogic.ts` so those figures stay
  honest instead of being hardcoded.
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
