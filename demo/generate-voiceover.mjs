#!/usr/bin/env node
'use strict';

// Synthesizes the narration lines in demo/script.mjs into per-beat clips.
// Two engines, both fully local (no API key, no account):
//
//   --engine espeak (default off macOS)  espeak-ng + an mbrola diphone voice.
//     No model download, so it works even behind network policies that block
//     Hugging Face/GitHub (this repo's sandboxed CI environment, notably) —
//     but it sounds synthetic, closer to a GPS voice than a narrator.
//
//   --engine say (default on macOS)      macOS's built-in `say` command —
//     the same voice engine as Siri/VoiceOver. Sounds like an actual person.
//     Only exists on macOS, so it can't run in this repo's Linux sandbox;
//     use it when running this pipeline locally on a Mac instead.
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
// Usage:
//   node demo/generate-voiceover.mjs                          # espeak on Linux, say on macOS
//   node demo/generate-voiceover.mjs --engine say --voice Ava  # macOS, a specific voice
//   node demo/generate-voiceover.mjs --engine espeak --voice mb-us1 --rate 165

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { BEATS, TAIL_PAD_MS } from './script.mjs';
import { getDurationMs, FFMPEG } from './audio-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const voiceDir = path.join(__dirname, 'out', 'voice');
fs.mkdirSync(voiceDir, { recursive: true });

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

const ENGINE = flag('engine', os.platform() === 'darwin' ? 'say' : 'espeak');
const RATE_WPM = Number(flag('rate', ENGINE === 'say' ? 175 : 165));

const ESPEAK = process.env.DEMO_ESPEAK || 'espeak-ng';
const SAY = process.env.DEMO_SAY || 'say';
// mb-us1 (US English, female) — see `espeak-ng --voices=mbrola`.
// Samantha ships on every Mac with no extra download; for a noticeably
// better result, download a Premium/Enhanced voice from System Settings ->
// Accessibility -> Spoken Content -> System Voice -> Manage Voices, then
// pass e.g. --voice "Ava (Premium)" (quote it, `say -v '?'` lists installed
// voices).
const VOICE = flag('voice', ENGINE === 'say' ? 'Samantha' : 'mb-us1');

function synthEspeak(text, outPath) {
  execFileSync(ESPEAK, ['-v', VOICE, '-s', String(RATE_WPM), '-w', outPath, text], { stdio: 'inherit' });
}

function synthSay(text, outPath) {
  const aiffPath = outPath.replace(/\.wav$/, '.aiff');
  execFileSync(SAY, ['-v', VOICE, '-r', String(RATE_WPM), '-o', aiffPath, text], { stdio: 'inherit' });
  execFileSync(FFMPEG, ['-y', '-i', aiffPath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', outPath], { stdio: 'ignore' });
  fs.unlinkSync(aiffPath);
}

const synth = ENGINE === 'say' ? synthSay : synthEspeak;

console.log(`Engine: ${ENGINE} · voice: ${VOICE} @ ${RATE_WPM}wpm`);
if (ENGINE === 'say' && os.platform() !== 'darwin') {
  console.error('--engine say only works on macOS (it shells out to the `say` command).');
  process.exit(1);
}

const manifest = {};

for (const beat of BEATS) {
  let narrationMs = 0;
  if (beat.narration) {
    const clipPath = path.join(voiceDir, `${beat.id}.narration.wav`);
    synth(beat.narration, clipPath);
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
