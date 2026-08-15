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
import { BEATS, TAIL_PAD_MS } from './script.mjs';
import { getDurationMs, concatWavs, padToDuration, silenceFile } from './audio-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'out');
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
  console.log(voiceManifest
    ? 'Using demo/out/voice/manifest.json for nominal beat timing (narrated cut).'
    : 'No voiceover manifest found — using caption-only fallback timing. '
      + 'Run demo/generate-voiceover.mjs first for a narrated cut.');

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

  const caption = async (text) => {
    await page.evaluate((text) => {
      const el = document.getElementById('demoCaption');
      el.textContent = text || '';
      el.classList.toggle('demo-slide-hidden', !text);
    }, text);
  };
  const hideSlide = (id) => page.evaluate((id) => {
    document.getElementById(id).classList.add('demo-slide-hidden');
  }, id);
  const showSlide = (id) => page.evaluate((id) => {
    document.getElementById(id).classList.remove('demo-slide-hidden');
  }, id);
  const byId = Object.fromEntries(BEATS.map((b) => [b.id, b]));

  // Measures the real wall-clock time each beat takes (its actions plus its
  // wait), which is what the post-recording resync step pads narration to.
  const actualMs = {};
  const runBeat = async (id, fn) => {
    const t0 = Date.now();
    await fn();
    actualMs[id] = Date.now() - t0;
  };

  await runBeat('intro', async () => {
    await page.waitForTimeout(nominalWaitMs(byId.intro));
  });

  await runBeat('statusBar', async () => {
    await hideSlide('demoIntro');
    await showSlide('demoStatusBar');
    await page.waitForTimeout(nominalWaitMs(byId.statusBar));
    await hideSlide('demoStatusBar');
  });

  await runBeat('overview', async () => {
    await caption(byId.overview.caption);
    await page.waitForTimeout(nominalWaitMs(byId.overview));
  });

  await runBeat('requestsTable', async () => {
    await caption(byId.requestsTable.caption);
    await page.click('[data-app="usage"]');
    await page.waitForTimeout(nominalWaitMs(byId.requestsTable));
  });

  await runBeat('requestsAnalytics', async () => {
    await caption(byId.requestsAnalytics.caption);
    await page.click('[data-panel="analytics"]');
    await page.waitForTimeout(nominalWaitMs(byId.requestsAnalytics));
  });

  await runBeat('findings', async () => {
    await caption(byId.findings.caption);
    await page.click('[data-app="analyze"]');
    await page.waitForTimeout(nominalWaitMs(byId.findings));
  });

  await runBeat('compare', async () => {
    await caption(byId.compare.caption);
    await page.click('[data-analyze-panel="compare"]');
    await page.waitForTimeout(nominalWaitMs(byId.compare));
  });

  await runBeat('sessions', async () => {
    await caption(byId.sessions.caption);
    await page.click('[data-analyze-panel="sessions"]');
    const budgetMs = nominalWaitMs(byId.sessions);
    let spent = 0;
    const step = async (ms) => { await page.waitForTimeout(ms); spent += ms; };
    await step(1200);
    const checkboxes = page.locator('#sessionsList input[type="checkbox"][data-session-id]');
    if (await checkboxes.count() >= 2) {
      await checkboxes.nth(0).check();
      await checkboxes.nth(1).check();
      await step(500);
      const compareBtn = page.locator('#trayCompare');
      if (await compareBtn.isEnabled()) {
        await compareBtn.click();
        await step(1000);
        await page.locator('#sessionsDialogClose').click().catch(() => {});
      }
    }
    if (spent < budgetMs) await page.waitForTimeout(budgetMs - spent);
  });

  await runBeat('simulator', async () => {
    await caption(byId.simulator.caption);
    await page.click('[data-app="simulator"]');
    const budgetMs = nominalWaitMs(byId.simulator);
    const firstLeg = Math.min(1800, budgetMs);
    await page.waitForTimeout(firstLeg);
    const discountNote = page.locator('#simDiscountSummary');
    if (await discountNote.count()) await discountNote.scrollIntoViewIfNeeded().catch(() => {});
    if (budgetMs > firstLeg) await page.waitForTimeout(budgetMs - firstLeg);
  });

  await runBeat('outro', async () => {
    await caption(null);
    await showSlide('demoOutro');
    await page.waitForTimeout(nominalWaitMs(byId.outro));
  });

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
