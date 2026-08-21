#!/usr/bin/env node
'use strict';

// Records a walkthrough of the dashboard webview (demo/harness.html, driven
// against the fixture data in demo/data.js) using Playwright's video
// capture. Produces demo/out/*.webm, which demo/render.sh then converts to
// mp4/gif.
//
// Pass 2 of the narration pipeline (see generate-voiceover.mjs for pass 1):
// each beat's nominal wait() target comes from demo/out/voice/manifest.json
// when it exists, so the recording roughly follows the narration's pace —
// but Playwright's own action overhead (click, evaluate, locator queries)
// means the real elapsed time per beat always runs a little longer than
// that nominal target, and the gap compounds beat over beat. So this script
// also measures the *actual* wall-clock duration of every beat as it
// records, and once the browser closes, rebuilds demo/out/voice/narration.wav
// from the narration-only clips padded to those measured durations —
// producing a track whose beat boundaries land exactly where the video's do,
// rather than where the nominal schedule guessed they would.
//
// Usage: NODE_PATH=<global node_modules with playwright> node demo/record.mjs

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beatsForCut, outDirForCut, TAIL_PAD_MS, captionChunks } from './script.mjs';
import { getDurationMs, concatWavs, padToDuration, silenceFile } from './audio-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const cutFlagIndex = args.indexOf('--cut');
// Which cut to record: `full` (the default walkthrough) or `short` (the
// 60-second social cut). Must match the cut generate-voiceover.mjs was run
// with, since this reads that cut's manifest for its beat timing.
const CUT = cutFlagIndex >= 0 ? args[cutFlagIndex + 1] : 'full';
const BEATS = beatsForCut(CUT);
const outDir = path.join(__dirname, outDirForCut(CUT));
const voiceDir = path.join(outDir, 'voice');
fs.mkdirSync(voiceDir, { recursive: true });

// Playwright names each capture after the page's guid, so re-recording a cut
// leaves the previous take beside the new one and render.sh has to guess which
// is meant (it takes the newest). Clearing them keeps exactly one .webm per cut
// directory, so "which file did I just render?" is never a question. These are
// this script's own gitignored intermediates — the mp4/gif it feeds are not
// touched.
for (const stale of fs.readdirSync(outDir).filter((f) => f.endsWith('.webm'))) {
  fs.rmSync(path.join(outDir, stale));
  console.log(`Removed previous take: ${path.join(outDirForCut(CUT), stale)}`);
}

const VIEWPORT = { width: 1600, height: 900 };
// DEMO_CHROMIUM, else this sandbox's known Playwright browser path if it
// happens to exist, else undefined — which tells Playwright to resolve its
// own normally-installed browser (e.g. after `npx playwright install
// chromium`), the right default anywhere outside this specific sandbox.
const SANDBOX_CHROMIUM = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const CHROMIUM_PATH = process.env.DEMO_CHROMIUM
  || (fs.existsSync(SANDBOX_CHROMIUM) ? SANDBOX_CHROMIUM : undefined);

const manifestPath = path.join(voiceDir, 'manifest.json');
const voiceManifest = fs.existsSync(manifestPath)
  ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  : null;

function nominalWaitMs(beat) {
  if (voiceManifest?.[beat.id]) return voiceManifest[beat.id].waitMs;
  return (beat.minMs || 0) + TAIL_PAD_MS;
}

async function main() {
  // Imported here rather than at the top of the file so a missing Playwright
  // gives an instruction instead of a module-resolution stack trace. It is not
  // a devDependency on purpose: cutting a video is an occasional local task,
  // and `npm ci` (CI included) should not carry it.
  const { chromium } = await import('playwright').catch(() => {
    console.error('playwright is not installed — it is not a devDependency, since only video cutting needs it.\n'
      + '  npm install --no-save playwright && npx playwright install chromium');
    process.exit(1);
  });

  console.log(`Cut: ${CUT} (${BEATS.length} beats) -> demo/${outDirForCut(CUT)}/`);
  console.log(voiceManifest
    ? `Using demo/${outDirForCut(CUT)}/voice/manifest.json for nominal beat timing (narrated cut).`
    : 'No voiceover manifest found for this cut — using caption-only fallback timing. '
      + `Run "node demo/generate-voiceover.mjs --cut ${CUT}" first for a narrated cut.`);

  const browser = await chromium.launch(CHROMIUM_PATH ? { executablePath: CHROMIUM_PATH } : {});
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: outDir, size: VIEWPORT },
  });

  const recordingStartedAt = Date.now();
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  await page.goto('file://' + path.join(__dirname, 'harness.html'));
  // Let the RPC round trip + first render settle before the recording relies on it.
  await page.waitForSelector('#ovCost:not(:has-text("—"))', { timeout: 15000 });

  // Playwright starts capturing video from page creation, but the scripted
  // beat timeline below (and the narration track) starts only once the page
  // has loaded and settled. That gap is invisible on screen (the intro slide
  // is static throughout), but it's real video time the audio track needs to
  // be delayed by — see render.sh's use of this file.
  const leadMs = Date.now() - recordingStartedAt;
  fs.writeFileSync(path.join(outDir, 'lead-ms.txt'), String(leadMs));

  // Subtitles are the beat's narration verbatim, split into caption-sized
  // chunks and handed to the page, which advances them on its own timer (see
  // demo-runtime.js) — so subtitle changes are not serialised behind whatever
  // Playwright happens to be doing in the middle of the beat.
  const captionForBeat = async (beat) => {
    const chunks = captionChunks(beat.narration);
    // Spread across the narration audio, not the whole beat: the tail pad and
    // any slack at the end of a beat is silence, and holding the last subtitle
    // through it reads better than stretching every chunk to cover it.
    const spanMs = voiceManifest?.[beat.id]?.narrationMs || nominalWaitMs(beat);
    await page.evaluate(([chunks, spanMs]) => {
      window.__demoCaptions.play(chunks, spanMs);
    }, [chunks, spanMs]);
  };
  const hideSlide = (id) => page.evaluate((id) => {
    document.getElementById(id).classList.add('demo-slide-hidden');
  }, id);
  const showSlide = (id) => page.evaluate((id) => {
    document.getElementById(id).classList.remove('demo-slide-hidden');
  }, id);

  // Native <dialog>.showModal() puts the dialog in the top layer and makes
  // everything behind it inert, so any beat that leaves one open blocks the
  // clicks of whatever beat runs next. Cuts reorder beats freely, so a beat
  // that needs the page underneath closes them itself rather than trusting the
  // beat before it to have tidied up. Idempotent — closing nothing is a no-op.
  const closeAnyDialog = async () => {
    const closed = await page.evaluate(() => {
      const open = [...document.querySelectorAll('dialog[open]')];
      for (const d of open) d.close();
      return open.length;
    });
    if (closed) await page.waitForTimeout(300);
  };

  // Where the pointer was left, so a move can be interpolated from it rather
  // than jumping to the target and animating from nowhere.
  let cursorAt = { x: VIEWPORT.width / 2, y: VIEWPORT.height / 2 };

  // Moves Playwright's real mouse so demo/demo-runtime.js's
  // fake-cursor-follows-real-events trick has motion to draw — see
  // overlay.css's #demoCursor.
  //
  // `page.mouse.move(x, y, { steps })` dispatches its intermediate mousemoves
  // back to back with no delay, so the whole travel lands inside a single 25fps
  // frame and the cursor reads as teleporting. Pacing the segments by hand is
  // what makes the approach visible: TRAVEL_MS of wall clock, which is also
  // real time the beat spends, hence the modest default.
  const TRAVEL_MS = 460;
  const moveCursorTo = async (x, y, { travelMs = TRAVEL_MS, steps = 24 } = {}) => {
    const from = cursorAt;
    const perStep = travelMs / steps;
    for (let i = 1; i <= steps; i++) {
      // Ease in/out, so the pointer accelerates away and settles rather than
      // sliding at a constant machine-like rate.
      const t = i / steps;
      const eased = t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
      await page.mouse.move(from.x + (x - from.x) * eased, from.y + (y - from.y) * eased);
      await page.waitForTimeout(perStep);
    }
    cursorAt = { x, y };
  };
  const moveCursorToCenterOf = async (locator, opts) => {
    const box = await locator.boundingBox();
    if (!box) return null;
    await moveCursorTo(box.x + box.width / 2, box.y + box.height / 2, opts);
    return box;
  };
  // Moves the mouse to an element, pauses so the viewer can register where
  // it's headed, then clicks — instead of jumping straight to a hidden
  // Playwright-internal click with no visible approach.
  const clickWithCursor = async (selector, { settleMs = 350, travelMs, pauseMs = 260 } = {}) => {
    const el = page.locator(selector).first();
    await moveCursorToCenterOf(el, travelMs === undefined ? undefined : { travelMs });
    // A beat of stillness on the target before the click, so the viewer's eye
    // catches up with the pointer and reads what is about to be pressed.
    await page.waitForTimeout(pauseMs);
    await el.click();
    await page.waitForTimeout(settleMs);
  };

  // Leaves the opening slides behind for the first beat that shows the real
  // dashboard. Which beat that is depends on the cut — the short cut has no
  // status-bar beat and goes straight from the intro card to Overview — so
  // every dashboard beat calls this rather than one designated beat owning it.
  // Idempotent: hiding an already-hidden slide is a no-op.
  const enterDashboard = async () => {
    await hideSlide('demoIntro');
    await hideSlide('demoStatusBar');
  };

  // Navigates only when the target isn't already on screen. Beats where the
  // click itself is the point (Requests, Analyze) click unconditionally and
  // visibly; these are for beats that merely need to *be* somewhere, since a
  // cut can drop whichever earlier beat used to navigate there.
  const viewVisible = (id) => page.locator(`#${id}`).evaluate((el) => !el.classList.contains('hidden')).catch(() => false);
  const ensureApp = async (app, viewId) => {
    if (await viewVisible(viewId)) return;
    await clickWithCursor(`[data-app="${app}"]`);
  };
  const ensureAnalyzePanel = async (panel) => {
    await ensureApp('analyze', 'analyzeView');
    await clickWithCursor(`[data-analyze-panel="${panel}"]`);
  };

  // Measures the real wall-clock time each beat takes (its actions plus its
  // wait), which is what the post-recording resync step pads narration to.
  const actualMs = {};

  // When the beat currently running started, for holdBeat below.
  let beatStartedAt = Date.now();

  /**
   * Holds the beat until its narration has played out — counting the time its
   * own actions already took.
   *
   * A beat's audio starts when the beat does and runs for narrationMs, while
   * its clicks and typing happen at the front. Waiting the full nominal length
   * *after* those actions therefore left the difference as silence at the end
   * of every beat, and it compounded: two navigation clicks are ~1.5s of dead
   * air on their own. Waiting only the remainder makes a beat last about
   * narration + TAIL_PAD_MS regardless of how much work it did, so the pause
   * between beats is the intended breath rather than an accident of how many
   * elements Playwright had to click.
   *
   * `reserveMs` leaves time at the end for something that still has to happen
   * after the hold — closing the Sessions dialog, say — so that too lands
   * inside the beat instead of pushing past it.
   */
  const holdBeat = async (beat, { reserveMs = 0 } = {}) => {
    const remaining = nominalWaitMs(beat) - reserveMs - (Date.now() - beatStartedAt);
    if (remaining > 0) await page.waitForTimeout(remaining);
  };

  // One handler per beat id, rather than a fixed sequence: a cut is just a
  // list of beat ids (see script.mjs's BEATS / SHORT_BEATS), and the loop at
  // the bottom runs whichever of these it names, in its order.
  const handlers = {};

  handlers.intro = async (beat) => {
    await holdBeat(beat);
  };

  handlers.statusBar = async (beat) => {
    await hideSlide('demoIntro');
    await showSlide('demoStatusBar');
    await page.waitForTimeout(500);
    // The arrow calls out the pill before the pointer arrives, so the eye
    // already knows where to look by the time the cursor gets there.
    await page.evaluate(() => document.getElementById('mockArrow')?.classList.add('demo-force-visible'));
    await page.waitForTimeout(700);
    await moveCursorToCenterOf(page.locator('#mockPill'));
    // Real :hover state (overlay.css's `.ide-pill:hover + .ide-tooltip`),
    // triggered by the mouse actually being there — not a scripted toggle.
    await holdBeat(beat, { reserveMs: 250 });
    await page.evaluate(() => document.getElementById('mockArrow')?.classList.remove('demo-force-visible'));
    await page.waitForTimeout(250);
    await hideSlide('demoStatusBar');
  };

  handlers.overview = async (beat) => {
    await enterDashboard();
    await holdBeat(beat);
  };

  handlers.requestsTable = async (beat) => {
    await enterDashboard();
    await clickWithCursor('[data-app="usage"]');
    await holdBeat(beat);
  };

  handlers.discount = async (beat) => {
    await enterDashboard();
    // The short cut has no requestsTable beat before this one, so the Requests
    // tab may still need opening.
    await ensureApp('usage', 'usageView');
    // Widen the page so a discounted request (Grok 4.6, a few days back in
    // the fixture data) is likely on-screen without needing to paginate.
    await page.selectOption('#pageSize', '100').catch(() => {});
    await page.waitForTimeout(400);
    const tag = page.locator('#tableBody .discount-tag').first();
    if (await tag.count()) {
      await tag.scrollIntoViewIfNeeded().catch(() => {});
      await page.evaluate(() => {
        document.querySelector('#tableBody .discount-tag')?.closest('tr')?.classList.add('demo-row-highlight');
      });
      await page.waitForTimeout(300);
      await moveCursorToCenterOf(tag);
    }
    await holdBeat(beat);
  };

  handlers.requestsAnalytics = async (beat) => {
    await ensureApp('usage', 'usageView');
    await clickWithCursor('[data-panel="analytics"]');
    await holdBeat(beat);
  };

  handlers.findings = async (beat) => {
    await enterDashboard();
    await clickWithCursor('[data-app="analyze"]');
    await holdBeat(beat);
  };

  handlers.compare = async (beat) => {
    await enterDashboard();
    await ensureAnalyzePanel('compare');
    await holdBeat(beat);
  };

  handlers.sessions = async (beat) => {
    await enterDashboard();
    await ensureAnalyzePanel('sessions');
    await page.waitForTimeout(700);
    const checkboxes = page.locator('#sessionsList input[type="checkbox"][data-session-id]');
    if (await checkboxes.count() >= 2) {
      await moveCursorToCenterOf(checkboxes.nth(0));
      await checkboxes.nth(0).check();
      await page.waitForTimeout(350);
      await moveCursorToCenterOf(checkboxes.nth(1));
      await checkboxes.nth(1).check();
      await page.waitForTimeout(350);
      const compareBtn = page.locator('#trayCompare');
      if (await compareBtn.isEnabled()) {
        await moveCursorToCenterOf(compareBtn);
        await compareBtn.click();
        // The dialog is a native modal, so it enters the top layer above the
        // subtitles — put them back on top of it.
        await page.evaluate(() => { window.__demoCaptions.raise(); window.__demoCursor?.raise(); });
        // The comparison dialog is the payoff of this beat, so it holds the
        // screen for the rest of it — reserving just enough at the end to
        // close again inside the beat rather than after it.
        await holdBeat(beat, { reserveMs: 400 });
        await page.locator('#sessionsDialogClose').click().catch(() => {});
        await page.waitForTimeout(400);
        return;
      }
    }
    await holdBeat(beat);
  };

  handlers.simulator = async (beat) => {
    await enterDashboard();
    await clickWithCursor('[data-app="simulator"]');
    await page.waitForTimeout(1500);
    const discountNote = page.locator('#simDiscountSummary');
    if (await discountNote.count()) {
      await discountNote.scrollIntoViewIfNeeded().catch(() => {});
      await moveCursorToCenterOf(discountNote).catch(() => {});
    }
    await holdBeat(beat);
  };

  handlers.install = async (beat) => {
    // The session cuts reach this beat straight from a beat that leaves a
    // session dialog open; the slide below it would be inert behind the modal.
    await closeAnyDialog();
    await showSlide('demoInstall');
    await page.waitForTimeout(600);
    const search = page.locator('#mockExtSearch');
    await moveCursorToCenterOf(search);
    await search.click();
    await page.waitForTimeout(300);
    // Typed for real, one key at a time, so the publisher name appears the way
    // a viewer would type it rather than materialising all at once.
    await search.type('iair0007', { delay: 190 });
    await page.waitForTimeout(400);
    await page.evaluate(() => document.getElementById('mockExtResults')?.classList.add('demo-force-visible'));
    await page.waitForTimeout(300);
    await moveCursorToCenterOf(page.locator('.ext-item-publisher'));
    await holdBeat(beat);
    await hideSlide('demoInstall');
  };

  // ---------------------------------------------------------------------------
  // Session cut — one conversation followed start to finish. The fixture story
  // session these drive is `conv_authnight` (see generate-fixtures.mjs), and
  // demo/verify-story.mjs is what guarantees the findings this cut narrates are
  // actually on screen when it records.
  // ---------------------------------------------------------------------------

  const STORY_SESSION = 'conv_authnight';
  const CLEAN_SESSION = 'conv_cleanrun';

  // The session dialogs are native modals opened with showModal(), so they
  // enter the browser's top layer above every z-index on the page — including
  // the subtitles. Every beat that opens one has to put the captions back.
  // Idempotent, because cuts reorder beats: whether the dialog is already up
  // depends on which beat ran before this one, and clicking the row underneath
  // an open modal times out (the modal makes the page behind it inert) rather
  // than failing in any way that reads as the real cause.
  const openStorySession = async () => {
    const alreadyOpen = await page.locator(`#sessionDetailDialog[open][data-session="${STORY_SESSION}"]`).count();
    if (alreadyOpen) return;
    await clickWithCursor(`.session-open[data-session="${STORY_SESSION}"]`);
    await page.evaluate(() => { window.__demoCaptions.raise(); window.__demoCursor?.raise(); });
    await page.waitForTimeout(400);
  };

  handlers.sessionIntro = async (beat) => {
    await holdBeat(beat);
  };

  handlers.sessionsList = async (beat) => {
    await enterDashboard();
    await ensureAnalyzePanel('sessions');
    await page.waitForTimeout(700);
    // The story session is the costliest in the fixtures (verify-story.mjs
    // fails if it stops being), so it leads the list — but point at it by id
    // rather than by position, so a re-sort cannot silently change the subject.
    const row = page.locator(`.session-open[data-session="${STORY_SESSION}"]`).first();
    if (await row.count()) {
      await row.scrollIntoViewIfNeeded().catch(() => {});
      await moveCursorToCenterOf(row);
    }
    await holdBeat(beat);
  };

  handlers.sessionOpen = async (beat) => {
    await enterDashboard();
    await ensureAnalyzePanel('sessions');
    await openStorySession();
    const spend = page.locator('#sessionDetailSpend');
    if (await spend.count()) {
      await spend.scrollIntoViewIfNeeded().catch(() => {});
      await moveCursorToCenterOf(spend).catch(() => {});
    }
    await holdBeat(beat);
  };

  handlers.sessionTimeline = async (beat) => {
    const timeline = page.locator('#sessionDetailTimeline');
    await timeline.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(300);
    // Hovering is the whole point of this beat: each bar's cost readout is
    // bound to mouseover, so the fake cursor has to actually travel across
    // them. Three stops — an ordinary turn, the blowup, and the striped
    // summary bar — rather than a sweep, so each tooltip is readable.
    //
    // The stops are the story's turns, by index into AUTH_TURNS: an ordinary
    // early turn, the blowup (#12), Cursor's summary (#13, the striped bar),
    // and the stale resume (#22), which is the plot's peak and the bar the
    // narration ends on. Guarded by count, so a shorter session just hovers
    // fewer bars rather than throwing mid-take.
    //
    // A beat can override the list: the short cut has one line about the peak
    // and no time to tour the bars that set it up, so it stops twice.
    const bars = timeline.locator('.tl-bar');
    const total = await bars.count();
    for (const i of (beat.timelineStops || [5, 11, 12, 21]).filter((n) => n < total)) {
      await moveCursorToCenterOf(bars.nth(i)).catch(() => {});
      await page.waitForTimeout(900);
    }
    await holdBeat(beat);
  };

  handlers.sessionFindings = async (beat) => {
    const findings = page.locator('#sessionDetailFindings');
    await findings.scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(400);
    await moveCursorToCenterOf(findings.locator('.finding-card').first()).catch(() => {});
    await holdBeat(beat);
  };

  handlers.findingToRequest = async (beat) => {
    // jumpToRequest() in main.js does all of it: closes the dialog, switches to
    // the request log, paginates to the row, expands it and flashes it. So this
    // beat is one real click and then time to read the breakdown it lands on.
    // The context-blowup card specifically, not merely the first: this beat's
    // line is about a request that was almost entirely re-*read* context, and
    // the card above it (the stale resume) is about context being re-*written*.
    // Jumping to that one would land on a breakdown the narration misdescribes.
    // Matched on the multiplier, not on the bare words: "Context grew" also
    // appears in "Summarising worked, then the context grew back", the card
    // below it.
    const blowupCard = page.locator('#sessionDetailFindings .finding-card', { hasText: /Context grew \d+×/ });
    const jump = (await blowupCard.count() ? blowupCard : page.locator('#sessionDetailFindings .finding-card'))
      .first().locator('.finding-jump').first();
    if (await jump.count()) {
      await moveCursorToCenterOf(jump);
      await jump.click();
      await page.waitForTimeout(1200);
    }
    await holdBeat(beat);
  };

  handlers.sessionAsk = async (beat) => {
    // Where this beat starts from depends on the cut: the long one arrives from
    // the request log with everything closed and has to navigate back, while
    // the short one comes straight off the findings with the dialog still up —
    // and navigating then means clicking the page behind an open modal, which
    // only ever times out. So the trip back is conditional on needing it.
    const alreadyOpen = await page.locator(`#sessionDetailDialog[open][data-session="${STORY_SESSION}"]`).count();
    if (!alreadyOpen) {
      await ensureAnalyzePanel('sessions');
      await page.waitForTimeout(500);
      await openStorySession();
    }
    await clickWithCursor('#sessionAskBtn');
    await page.evaluate(() => { window.__demoCaptions.raise(); window.__demoCursor?.raise(); });
    await page.waitForTimeout(500);

    // Pick the template the narration is about, by its wording rather than its
    // position, so re-ordering the list cannot pick a different question.
    const chosen = await page.evaluate(() => {
      const sel = document.getElementById('askTemplate');
      if (!sel) return null;
      const match = [...sel.options].find((o) => /fresh chat/i.test(o.textContent || ''));
      const option = match || sel.options[0];
      if (!option) return null;
      sel.value = option.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return option.textContent;
    });
    if (chosen) await page.waitForTimeout(600);

    // The brief itself sits in a collapsed <details>; open it so the thing the
    // narration describes is actually on screen.
    const preview = page.locator('.ask-preview summary').first();
    if (await preview.count()) {
      await moveCursorToCenterOf(preview);
      await preview.click();
      await page.waitForTimeout(500);
    }
    const size = page.locator('#askSize');
    if (await size.count()) await moveCursorToCenterOf(size).catch(() => {});

    // Deliberately stops here without clicking "Open and paste in Cursor Chat".
    // bridge.js answers sendToCursorChat with the honest out-of-Cursor result
    // ({ pasted: false, via: 'none' }), so a click would put a fallback message
    // on screen under narration describing the feature working. The dialog —
    // the brief, its token size, its cost — is what the beat is about anyway,
    // and the line says it stops before sending.
    await holdBeat(beat, { reserveMs: 400 });
    await page.locator('#askClose').click().catch(() => {});
    await page.waitForTimeout(400);
  };

  handlers.sessionCompare = async (beat) => {
    await page.locator('#sessionDetailClose').click().catch(() => {});
    await page.waitForTimeout(300);
    await ensureAnalyzePanel('sessions');
    await page.waitForTimeout(500);
    // By id, not by row position: the comparison is only worth showing for
    // this specific pair — the session that regrew against the one that didn't.
    for (const id of [STORY_SESSION, CLEAN_SESSION]) {
      const box = page.locator(`#sessionsList input[type="checkbox"][data-session-id="${id}"]`).first();
      if (!(await box.count())) continue;
      await box.scrollIntoViewIfNeeded().catch(() => {});
      await moveCursorToCenterOf(box);
      await box.check();
      await page.waitForTimeout(350);
    }
    const compareBtn = page.locator('#trayCompare');
    if (await compareBtn.count() && await compareBtn.isEnabled()) {
      await moveCursorToCenterOf(compareBtn);
      await compareBtn.click();
      await page.evaluate(() => { window.__demoCaptions.raise(); window.__demoCursor?.raise(); });
      await holdBeat(beat, { reserveMs: 400 });
      await page.locator('#sessionsDialogClose').click().catch(() => {});
      await page.waitForTimeout(400);
      return;
    }
    await holdBeat(beat);
  };

  handlers.sessionOutro = async (beat) => {
    await page.evaluate(() => window.__demoCursor?.hide());
    await showSlide('demoOutro');
    await holdBeat(beat);
  };

  handlers.outro = async (beat) => {
    await page.evaluate(() => window.__demoCursor?.hide());
    await showSlide('demoOutro');
    await holdBeat(beat);
  };

  for (const beat of BEATS) {
    const handler = handlers[beat.id];
    if (!handler) throw new Error(`No handler in record.mjs for beat "${beat.id}" (from the ${CUT} cut in script.mjs)`);
    // The clock holdBeat measures its remaining time against — set before the
    // subtitles go up, since that is also when this beat's narration starts.
    beatStartedAt = Date.now();
    // Subtitles start with the beat, before its actions, so the first chunk is
    // already up while the click/navigation that opens the beat plays out.
    await captionForBeat(beat);
    await handler(beat);
    actualMs[beat.id] = Date.now() - beatStartedAt;
  }

  if (errors.length) {
    console.error('Console/page errors during recording:');
    for (const e of errors) console.error(' -', e);
  }

  await context.close();
  await browser.close();

  fs.writeFileSync(path.join(outDir, 'beat-timing.json'), JSON.stringify(actualMs, null, 2));

  const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.webm'));
  console.log('Recorded:', files.map((f) => path.join(outDir, f)));

  if (voiceManifest) resyncNarration(actualMs);
}

/**
 * Pass 3: rebuilds demo/out/voice/narration.wav from the narration-only
 * clips generate-voiceover.mjs wrote, padding each beat's clip to the
 * *actual* measured duration of that beat instead of the nominal one it was
 * generated against — so the concatenated track's beat boundaries line up
 * with the real recording's, not the estimate that seeded it.
 */
function resyncNarration(actualMs) {
  console.log('\nResyncing narration to measured beat timing...');
  const segments = [];
  for (const beat of BEATS) {
    const targetMs = actualMs[beat.id] ?? nominalWaitMs(beat);
    const outPath = path.join(voiceDir, `${beat.id}.synced.wav`);
    if (beat.narration) {
      const clipPath = path.join(voiceDir, `${beat.id}.narration.wav`);
      const clipMs = Math.round(getDurationMs(clipPath));
      if (clipMs > targetMs) {
        console.warn(`  ${beat.id}: narration (${clipMs}ms) is longer than the recorded beat (${targetMs}ms) — audio will run into the next beat.`);
      }
      padToDuration(clipPath, clipMs, Math.max(clipMs, targetMs), outPath, voiceDir);
    } else {
      silenceFile(outPath, targetMs);
    }
    segments.push(outPath);
    console.log(`  ${beat.id}: ${targetMs}ms`);
  }
  const finalPath = path.join(voiceDir, 'narration.wav');
  concatWavs(segments, finalPath);
  for (const s of segments) fs.unlinkSync(s);
  console.log(`Wrote ${finalPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
