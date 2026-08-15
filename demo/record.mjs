#!/usr/bin/env node
'use strict';

// Records a ~30s walkthrough of the dashboard webview (demo/harness.html,
// driven against the fixture data in demo/data.js) using Playwright's video
// capture. Produces demo/out/demo.webm, which demo/render.sh then converts to
// mp4/gif.
//
// Usage: NODE_PATH=<global node_modules with playwright> node demo/record.mjs

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

const VIEWPORT = { width: 1600, height: 900 };
const CHROMIUM_PATH = process.env.DEMO_CHROMIUM
  || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

async function main() {
  const browser = await chromium.launch({ executablePath: CHROMIUM_PATH });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    recordVideo: { dir: outDir, size: VIEWPORT },
  });
  const page = await context.newPage();

  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

  await page.goto('file://' + path.join(__dirname, 'harness.html'));
  // Let the RPC round trip + first render settle before the recording relies on it.
  await page.waitForSelector('#ovCost:not(:has-text("—"))', { timeout: 15000 });

  const caption = async (text, { hide = false } = {}) => {
    await page.evaluate(({ text, hide }) => {
      const el = document.getElementById('demoCaption');
      el.textContent = text;
      el.classList.toggle('demo-slide-hidden', hide || !text);
    }, { text, hide });
  };
  const hideSlide = (id) => page.evaluate((id) => {
    document.getElementById(id).classList.add('demo-slide-hidden');
  }, id);
  const showSlide = (id) => page.evaluate((id) => {
    document.getElementById(id).classList.remove('demo-slide-hidden');
  }, id);
  const wait = (ms) => page.waitForTimeout(ms);

  // ---- Intro (~0.0 - 2.2s) --------------------------------------------------
  await wait(2200);

  // ---- Status bar beat (~2.2 - 5.2s) ---------------------------------------
  await hideSlide('demoIntro');
  await showSlide('demoStatusBar');
  await wait(3000);
  await hideSlide('demoStatusBar');

  // ---- Overview (~5.2 - 9.0s) ------------------------------------------------
  await caption('Cost, requests, cache savings — plus a live budget burn-rate');
  await wait(3800);

  // ---- Requests: table (~9.0 - 11.4s) ----------------------------------------
  await caption('The full request log — filters, per-request cost, CSV export');
  await page.click('[data-app="usage"]');
  await wait(2400);

  // ---- Requests: analytics (~11.4 - 14.2s) -----------------------------------
  await caption('Daily cost, model breakdown, token volume');
  await page.click('[data-panel="analytics"]');
  await wait(2800);

  // ---- Analyze: findings (~14.2 - 17.4s) --------------------------------------
  await caption('Rule-based findings — what’s actually driving your bill');
  await page.click('[data-app="analyze"]');
  await wait(3200);

  // ---- Analyze: compare periods (~17.4 - 20.2s) -------------------------------
  await caption('Compare any two periods, sorted by biggest mover');
  await page.click('[data-analyze-panel="compare"]');
  await wait(2800);

  // ---- Analyze: sessions (~20.2 - 23.4s) --------------------------------------
  await caption('Group spend by conversation, then compare sessions side by side');
  await page.click('[data-analyze-panel="sessions"]');
  await wait(1200);
  const checkboxes = page.locator('#sessionsList input[type="checkbox"][data-session-id]');
  const checkCount = await checkboxes.count();
  if (checkCount >= 2) {
    await checkboxes.nth(0).check();
    await checkboxes.nth(1).check();
    await wait(500);
    const compareBtn = page.locator('#trayCompare');
    if (await compareBtn.isEnabled()) {
      await compareBtn.click();
      await wait(1000);
      await page.locator('#sessionsDialogClose').click().catch(() => {});
    }
  }
  await wait(500);

  // ---- Simulator (~23.4 - 26.8s) -----------------------------------------------
  await caption('Simulate costs across models — and catch real promotions');
  await page.click('[data-app="simulator"]');
  await wait(2200);
  // Point at the measured Grok discount badge if one rendered.
  const discountNote = page.locator('#simDiscountSummary');
  if (await discountNote.count()) await discountNote.scrollIntoViewIfNeeded().catch(() => {});
  await wait(1200);

  // ---- Outro (~26.8 - 29.0s) -----------------------------------------------------
  await caption('', { hide: true });
  await showSlide('demoOutro');
  await wait(2200);

  if (errors.length) {
    console.error('Console/page errors during recording:');
    for (const e of errors) console.error(' -', e);
  }

  await context.close();
  await browser.close();

  const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.webm'));
  console.log('Recorded:', files.map((f) => path.join(outDir, f)));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
