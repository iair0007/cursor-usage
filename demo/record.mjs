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
import { chromium } from 'playwright';
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

  // Moves Playwright's real mouse in visible steps (rather than teleporting),
  // so demo/demo-runtime.js's fake-cursor-follows-real-events trick has
  // motion to draw — see overlay.css's #demoCursor.
  const moveCursorTo = async (x, y, steps = 26) => {
    await page.mouse.move(x, y, { steps });
  };
  const moveCursorToCenterOf = async (locator) => {
    const box = await locator.boundingBox();
    if (!box) return null;
    await moveCursorTo(box.x + box.width / 2, box.y + box.height / 2);
    return box;
  };
  // Moves the mouse to an element, pauses so the viewer can register where
  // it's headed, then clicks — instead of jumping straight to a hidden
  // Playwright-internal click with no visible approach.
  const clickWithCursor = async (selector, { settleMs = 350 } = {}) => {
    const el = page.locator(selector).first();
    await moveCursorToCenterOf(el);
    await page.waitForTimeout(150);
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
        await page.evaluate(() => window.__demoCaptions.raise());
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
