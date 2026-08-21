# Plan: a "how a session went" demo video

A third cut for the existing pipeline in `demo/` — one that shows the
session-level features added in 0.8.0: the session breakdown, the timeline,
the findings anchored to a conversation, the jump from a finding to the
request that caused it, the Cursor Chat brief, and a two-session comparison.

Everything here builds on `demo/README.md`. Read that first; this file only
covers what is new or missing for this cut.

## 0. What you do and don't need

**No MCP server is involved, and none is worth adding.** The pipeline is four
plain node/shell scripts driving Playwright and ffmpeg. Claude Code (or any
terminal) runs them directly. An MCP server would only add a layer between you
and `node demo/record.mjs`.

What is actually needed:

| Tool | Why | Where it must run |
| --- | --- | --- |
| Node 20+ and `npm install && npm run compile` | builds `media/main.js`, which the harness loads for real | anywhere |
| `playwright` + `npx playwright install chromium` | drives the harness and records the `.webm` | anywhere |
| `kokoro-js` (~390MB with playwright) | neural narration; downloads an ~86MB model from Hugging Face on first run | **your Mac** — see below |
| a full `ffmpeg` (`brew install ffmpeg`) | muxes narration into mp4, writes the gif | **your Mac** — see below |

### Run it on your Mac, not in the Claude VM

I checked this environment rather than assuming:

- Hugging Face is blocked here — the proxy answers `CONNECT tunnel failed,
  response 403`, so `kokoro-js` cannot fetch its model. The fallback is
  espeak-ng (not installed here either), which sounds like a GPS unit, not a
  narrator. The current published videos were voiced with Kokoro; an espeak
  cut would be a visible downgrade.
- There is no system `ffmpeg` on `PATH` — only Playwright's bundled
  `ffmpeg-linux`, which is a stripped build kept for webm capture, not the
  full encoder `render.sh` needs for mp4 and the gif palette filters.

Chromium *is* here, so `generate-fixtures.mjs` and `record.mjs` would work in
this VM. But splitting the pipeline across two machines means shipping
`out/voice/` back and forth, and pass 3 (narration resync) runs inside
`record.mjs` and needs ffmpeg anyway. Do the whole thing on the Mac:

```bash
npm install && npm run compile
npm install --no-save playwright kokoro-js
npx playwright install chromium     # once
brew install ffmpeg                 # once
```

Use the VM for the code changes in sections 2–4 (and for a silent,
caption-only test recording to check the choreography before you commit to a
voiced take).

## 1. What already works, and the one real gap

The good news: **the harness can already drive every new session feature.**
`demo/harness.html` is in sync with `src/html.ts` and already carries
`sessionDetailDialog`, `sessionDetailSpend`, `sessionDetailFindings`,
`sessionDetailTimeline`, `sessionAskBtn`, and the whole `askCursorDialog`
group. `bridge.js` already answers `sendToCursorChat`. Nothing structural is
missing.

The gap is the **data**. `generate-fixtures.mjs` builds sessions from a smooth
random walk — cache reads climb 800–4,000 a turn, requests land 45–240s apart,
cache writes top out around 1,600 tokens. Checked against the thresholds in
`INSIGHT_DEFAULTS` (`src/webview/insights.js`), that means the findings this
video is *about* will not fire:

| Finding | Needs | Current fixtures |
| --- | --- | --- |
| Compaction (summary turn) | `cacheRead === 0 && cacheWrite === 0 && input ≥ 50,000` | never — no such request is generated |
| Summarising worked / grew back | a compaction, then cache reads down ≥40% over 4 turns | never — depends on the above |
| Stale resume | gap ≥ 1h **and** `cacheWrite ≥ 100,000` | never — writes are ~100× too small |
| Context blowup | `cacheRead ≥ 5×` session median **and** ≥90% of the request's tokens | very unlikely on a smooth ramp |
| Cold-start baseline | ≥3 uncached requests with `input ≥ 3,000` | marginal — first-turn input is `randInt(600, 3000)`, mostly under the line |
| Switching model | ≥3 requests either side, ≥$0.25 and ≥20% impact | fires randomly and meaninglessly, since the model is re-rolled per request |

So a session beat recorded against today's fixtures would open a breakdown with
an empty or thin findings panel — the opposite of the point.

**Fix: script one story session instead of sampling it.** Hardcode it, do not
draw it from the PRNG, so the recording is reproducible and the figures on
screen stay put between takes.

## 2. Fixture work (`demo/generate-fixtures.mjs`)

Add two hand-built sessions after `conv_bignight`, and one small tweak.

### Session A — `conv_authnight`, the problem session

Title: *"Refactor auth flow: session store + token refresh"*. ~26 requests
across an evening two days back. Built to trip four findings in order, so the
timeline reads as a story rather than a bar chart:

1. **Turns 1–3 — cold start.** Uncached, `input` 5,000–9,000, `cacheWrite`
   ~1,200. Clears `coldStartInputTokens` (3,000) so the "what every new chat
   costs before you type" baseline has real samples.
2. **Turns 4–11 — the ordinary climb.** `cacheRead` 30k → 180k. This is the
   band that swells on the timeline.
3. **Turn 12 — context blowup.** `cacheRead` ≈ 600,000 against a session
   median near 120,000 (clears `blowupMultiple` 5) with `input` 3,000,
   `output` 1,500, `cacheWrite` 200 — a 0.99 cache share, past
   `blowupCacheShare` 0.9.
4. **Turn 13 — Cursor compacts.** `cacheRead` 0, `cacheWrite` 0, `input`
   ~62,000 (past `compactionMinInput` 50,000), `output` ~2,500. This is the
   request that earns the `summary` chip in the log.
5. **Turns 14–17 — relief, then regrowth.** Drop to ~45k (a >40% fall, so the
   compaction registers as having worked), then climb back past 300k **inside
   the hour** so the rule resolves as *"summarising worked, then the context
   grew back"* — the version that carries the "a fresh chat was the cheaper
   move" tip.
6. **Turn 22 — stale resume.** Starts ≥3.5h after turn 21, `cacheRead` 0,
   `cacheWrite` 240,000 (past `staleResumeCacheWriteTokens` 100,000). Keep
   `cacheWrite` non-zero or it reads as a second compaction instead.
7. **Turns 22–26 — a model switch.** Pin turns 1–21 to one model and 22–26 to
   another, with cache reads large enough that re-pricing identical token
   counts moves more than `switchMinImpact` ($0.25) and `switchMinPct` (20%).

### Session B — `conv_cleanrun`, the counter-example

Same day, ~14 requests, one compaction whose relief *holds* (cache reads stay
down for the four turns after it, no regrowth inside the hour) so it resolves
as plain **"summarising worked"**. This is what makes the compare beat land:
two real sessions, one that got away from you and one that didn't.

A single compaction can only resolve one way, so the two outcomes need two
sessions — you cannot show both on one timeline.

### One tweak to the random sessions

Raise first-turn `input` from `randInt(600, 3000)` to roughly
`randInt(4000, 9000)`. Cold starts are genuinely bigger than short questions
(system prompt, rules files, MCP tool definitions — which is exactly what that
finding is measuring), and at the current range most sessions sit under the
3,000 threshold, so the baseline finding is quieter than it should be
everywhere, not just in this cut.

**Verify before recording anything:** run `node demo/generate-fixtures.mjs`,
open `demo/harness.html`, and confirm each finding is on screen. Adjusting
numbers is cheap; re-recording a voiced take is not.

## 3. New beats (`demo/script.mjs`)

Add a `SESSION_BEATS` array and extend `beatsForCut()` / `outDirForCut()` with
a `session` cut writing to `demo/out/session/`. Target ~1m40s.

Draft narration below. It is deliberately free of dollar figures — the screen
carries those, and a spoken number goes stale the moment the fixtures are
regenerated. Existing beats follow the same rule.

| id | Narration (draft) | minMs |
| --- | --- | --- |
| `sessionIntro` | "One long agent chat can cost more than a whole week of ordinary work — and by the time you notice, it's on the bill. This is what the dashboard can tell you about a conversation that got away from you." | — |
| `sessionsList` | "Sessions groups every request by the conversation it came from, so one chat is one row: what it cost, how long it ran, and which models it reached for. Cursor's own local chat index supplies the names — nothing you wrote is ever read." | 2600 |
| `sessionOpen` | "Open one and you get where its money actually went, by token bucket. On a long agent session most of it is cache reads — the thread being re-sent, turn after turn — not the answers you were waiting for." | 3000 |
| `sessionTimeline` | "One bar per request, in the order you asked them, each priced, with the share that was re-read context shaded in. A conversation that got more expensive as it went looks expensive: the shaded band swells while the solid part stays flat. The striped bar is Cursor summarising the thread." | 6000 |
| `sessionFindings` | "The findings anchored to this session say what happened and when. One request read far more context than any other. A summary brought it back down — and then the thread grew straight back, inside the hour, which is the moment a fresh chat would have been cheaper than another summary." | 6500 |
| `findingToRequest` | "Every finding links to the request it's about. Open the row and the cost breaks down by bucket, so you can see the shape for yourself: a few cents of answer, and the rest re-reading context you'd already paid for." | 4500 |
| `sessionAsk` | "Or hand the session to Cursor Chat. The brief carries token counts, timings and costs — never anything you typed — and it's built small on purpose, because the analysis costs tokens too. It tells you its size and what sending it is worth before you send it, drops it in the chat box, and stops there. Nothing is sent until you've read it and pressed Enter." | 7000 |
| `sessionCompare` | "And you can put two conversations side by side. Same work, same day — one where the summary held, and one where it didn't." | 5000 |
| `sessionOutro` | "Free on Open VSX. No proxy, no separate login — just your Cursor account." | — |

Reuse the existing `install` beat before the outro if you want the cut to
stand alone on social; drop it if it's going on the README next to the others.

## 4. New handlers (`demo/record.mjs`)

One handler per beat id. Every selector below was checked against
`src/webview/main.js` and `demo/harness.html` — these exist:

- **`sessionsList`** — `enterDashboard()`, `ensureAnalyzePanel('sessions')`,
  then `moveCursorToCenterOf()` the `conv_authnight` row.
- **`sessionOpen`** — click `.session-open[data-session="conv_authnight"]` via
  `clickWithCursor()`. It opens `#sessionDetailDialog`, a native modal, so call
  `window.__demoCaptions.raise()` straight after, exactly as `handlers.sessions`
  already does. Scroll `#sessionDetailSpend` into view.
- **`sessionTimeline`** — the bars are
  `#sessionDetailTimeline [data-request]`. Hover across three or four with
  `moveCursorToCenterOf()`, pausing on the blowup bar and the striped summary
  bar so the hover cost readout is legible.
- **`sessionFindings`** — scroll `#sessionDetailFindings` in; if the cards
  render collapsed, click `[data-findings-toggle]`.
- **`findingToRequest`** — click `.finding-jump[data-request]` ("Show me the
  request →"). It closes the dialog and jumps to the log; the row is
  `tr[data-request="…"]`. Click it to expand the cost breakdown and add
  `demo-row-highlight`, reusing the discount beat's highlight class.
- **`sessionAsk`** — reopen the session (`.finding-session[data-session]` from
  a finding, or back through Sessions), click `#sessionAskBtn`, raise captions,
  pick a template on `#askTemplate`, let `#askPreview` and `#askSize` render,
  and **stop there**. Do not click `#askCopy` — see the note below.
- **`sessionCompare`** — the existing `handlers.sessions` already does this;
  copy it, but check the two story sessions by id rather than
  `nth(0)`/`nth(1)`, so the comparison is the intended pair.
- **`sessionIntro` / `sessionOutro`** — `showSlide()`/`hideSlide()` like the
  current intro and outro. New slides in `harness.html` if you want different
  wording from the existing cards.

### One honest-staging decision to make

`bridge.js` answers `sendToCursorChat` with
`{ pasted: false, opened: false, via: 'none' }` — the truthful result outside a
real Cursor install. So if the beat clicks the button, the video shows the
fallback message, not the feature.

Two defensible options:

1. **Stop before the click** (recommended). The dialog — the brief, its token
   size, its cost — is the interesting part, and the narration already says it
   stops before sending. Nothing is staged.
2. **Have `bridge.js` report `{ pasted: true, via: 'deeplink' }`** and show the
   success state. This is a mock, but no more so than the mocked status bar and
   Extensions panel already in the video, and it *is* what happens on a real
   install. If you take this route, put the reasoning in a comment next to the
   case, the way the existing mocks are documented.

Do not mix them: showing a success state the harness didn't produce, without
saying so anywhere, is the one thing this repo's demo has so far avoided.

## 5. Running it

```bash
node demo/generate-fixtures.mjs                    # regenerate with the story sessions

node demo/record.mjs --cut session                 # silent test pass first — check the choreography
open demo/out/session/*.webm

node demo/generate-voiceover.mjs --cut session     # kokoro/af_heart, matching the existing cuts
node demo/record.mjs --cut session                 # real pass: records, then resyncs narration
./demo/render.sh session                           # → demo/out/session/demo.mp4 + .gif
```

Do the silent pass before synthesizing audio. Narration length is what sets
each beat's duration, so choreography mistakes are far cheaper to fix before
there is a voice track to re-cut.

## 6. Checks before publishing

- Every beat's measured length in `out/session/beat-timing.json` sits about
  `TAIL_PAD_MS` (500ms) above its `narrationMs` in
  `out/session/voice/manifest.json`. A gap of seconds means the visual is
  outrunning the line — lengthen the narration, don't speed up the action.
  The header comment in `script.mjs` explains this.
- The findings on screen match what the narration claims. These are the same
  rules the extension runs on real data, so a mismatch is either a fixture that
  drifted or a genuine bug — worth knowing which.
- No dollar figure is spoken that the screen contradicts.
- If `src/html.ts`'s body markup changed since the last cut, mirror it into
  `harness.html` — it is a copy, not a template.
- Regenerate the full and short cuts too if the fixture changes moved anything
  they show; the first-turn `input` tweak in section 2 affects all three.

## 7. Suggested order

1. Fixtures (section 2), then eyeball `harness.html` until every finding fires.
2. Beats and handlers (sections 3–4), silent recording only.
3. Iterate the choreography on silent takes.
4. Voice, record, render on the Mac.
5. Publish, and add the cut to the table at the top of `demo/README.md`.
