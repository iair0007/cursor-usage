#!/usr/bin/env node
'use strict';

// Synthesizes the narration lines in demo/script.mjs with a local,
// fully-offline TTS voice (espeak-ng + an mbrola diphone voice — no model
// download, so it works behind network policies that block Hugging
// Face/GitHub, unlike most neural TTS).
//
// This is pass 1 of the pipeline: it writes each beat's narration-only clip
// (demo/out/voice/<id>.narration.wav) plus a nominal manifest.json used to
// seed demo/record.mjs's wait() targets — how long that beat should stay on
// screen. record.mjs measures the *actual* elapsed time per beat (Playwright
// action overhead means real timing always runs a bit longer than the nominal
// target) and rebuilds the final, correctly-synced demo/out/voice/narration.wav
// itself once recording finishes — see the resync step at the bottom of
// record.mjs.
//
// Usage: node demo/generate-voiceover.mjs [--voice mb-us1] [--rate 165]

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { BEATS, TAIL_PAD_MS } from './script.mjs';
import { getDurationMs } from './audio-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const voiceDir = path.join(__dirname, 'out', 'voice');
fs.mkdirSync(voiceDir, { recursive: true });

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const ESPEAK = process.env.DEMO_ESPEAK || 'espeak-ng';
const VOICE = flag('voice', 'mb-us1'); // mb-us1 (US English, female) — see `espeak-ng --voices=mbrola`
const RATE_WPM = Number(flag('rate', '165'));

console.log(`Voice: ${VOICE} @ ${RATE_WPM}wpm`);

const manifest = {};

for (const beat of BEATS) {
  let narrationMs = 0;
  if (beat.narration) {
    const clipPath = path.join(voiceDir, `${beat.id}.narration.wav`);
    execFileSync(ESPEAK, ['-v', VOICE, '-s', String(RATE_WPM), '-w', clipPath, beat.narration], { stdio: 'inherit' });
    narrationMs = Math.round(getDurationMs(clipPath));
  }

  const waitMs = Math.max(narrationMs, beat.minMs || 0) + TAIL_PAD_MS;
  manifest[beat.id] = { narrationMs, waitMs, narration: beat.narration || null };
  console.log(`  ${beat.id}: narration ${narrationMs}ms, nominal wait ${waitMs}ms`);
}

fs.writeFileSync(path.join(voiceDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const totalMs = Object.values(manifest).reduce((s, b) => s + b.waitMs, 0);
console.log(`\nWrote demo/out/voice/*.narration.wav + manifest.json`);
console.log(`Nominal scripted runtime: ${(totalMs / 1000).toFixed(1)}s (record.mjs will run a little longer — see its resync step)`);
