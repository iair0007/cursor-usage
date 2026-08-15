#!/usr/bin/env node
'use strict';

// Synthesizes the narration lines in demo/script.mjs into per-beat clips.
// Three engines, all fully local (no API key, no account):
//
//   --engine kokoro (default)   Kokoro-82M, an open-weight (MIT) neural TTS
//     model (onnx-community/Kokoro-82M-v1.0-ONNX) run locally via the
//     `kokoro-js` package. Sounds close to a real human narrator — the best
//     quality of the three — and is free and offline once its ~86MB
//     quantized model is downloaded (cached under
//     node_modules/@huggingface/transformers/.cache, so it re-downloads
//     after a clean `npm install`). Needs one-time internet access to
//     Hugging Face to fetch the model.
//
//   --engine say                macOS's built-in `say` command — the same
//     voice engine as Siri/VoiceOver. Only exists on macOS. Decent with a
//     stock voice (Samantha); noticeably better with a downloaded
//     Premium/Enhanced voice.
//
//   --engine espeak              espeak-ng + an mbrola diphone voice. No
//     model download, so it works even behind network policies that block
//     Hugging Face/GitHub (this repo's sandboxed CI environment, notably) —
//     but it sounds synthetic, closer to a GPS voice than a narrator.
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
//   node demo/generate-voiceover.mjs                            # kokoro, voice af_heart
//   node demo/generate-voiceover.mjs --voice bf_emma --speed 0.95
//   node demo/generate-voiceover.mjs --engine say --voice Ava    # macOS, a specific voice
//   node demo/generate-voiceover.mjs --engine espeak --voice mb-us1 --rate 165

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { beatsForCut, outDirForCut, TAIL_PAD_MS } from './script.mjs';
import { getDurationMs, FFMPEG, SAMPLE_RATE } from './audio-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};

// Which cut to narrate: `full` (the default walkthrough) or `short` (the
// 60-second social cut). Each writes to its own directory — see outDirForCut.
const CUT = flag('cut', 'full');
const BEATS = beatsForCut(CUT);
const voiceDir = path.join(__dirname, outDirForCut(CUT), 'voice');
fs.mkdirSync(voiceDir, { recursive: true });

const ENGINE = flag('engine', 'kokoro');
const RATE_WPM = Number(flag('rate', ENGINE === 'say' ? 175 : 165));
const SPEED = Number(flag('speed', 1.0));

const ESPEAK = process.env.DEMO_ESPEAK || 'espeak-ng';
const SAY = process.env.DEMO_SAY || 'say';
const KOKORO_MODEL = process.env.DEMO_KOKORO_MODEL || 'onnx-community/Kokoro-82M-v1.0-ONNX';
// af_heart — warm US-English female voice, widely regarded as Kokoro's best
// default. Run `node -e "import('kokoro-js').then(async m => console.log(Object.keys((await m.KokoroTTS.from_pretrained('onnx-community/Kokoro-82M-v1.0-ONNX')).voices)))"`
// to list every available voice (af_*/am_* = US female/male, bf_*/bm_* = British).
// mb-us1 (US English, female) — see `espeak-ng --voices=mbrola`.
// Samantha ships on every Mac with no extra download; for a noticeably
// better result, download a Premium/Enhanced voice from System Settings ->
// Accessibility -> Spoken Content -> System Voice -> Manage Voices, then
// pass e.g. --voice "Ava (Premium)" (quote it, `say -v '?'` lists installed
// voices).
const VOICE = flag('voice', ENGINE === 'kokoro' ? 'af_heart' : ENGINE === 'say' ? 'Samantha' : 'mb-us1');

function synthEspeak(text, outPath) {
  execFileSync(ESPEAK, ['-v', VOICE, '-s', String(RATE_WPM), '-w', outPath, text], { stdio: 'inherit' });
}

function synthSay(text, outPath) {
  const aiffPath = outPath.replace(/\.wav$/, '.aiff');
  execFileSync(SAY, ['-v', VOICE, '-r', String(RATE_WPM), '-o', aiffPath, text], { stdio: 'inherit' });
  execFileSync(FFMPEG, ['-y', '-i', aiffPath, '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', outPath], { stdio: 'ignore' });
  fs.unlinkSync(aiffPath);
}

let kokoroTTS = null;
async function synthKokoro(text, outPath) {
  if (!kokoroTTS) {
    const { KokoroTTS } = await import('kokoro-js');
    console.log(`Loading Kokoro model (${KOKORO_MODEL})... first run downloads ~86MB, cached after.`);
    kokoroTTS = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: 'q8', device: 'cpu' });
  }
  const rawPath = outPath.replace(/\.wav$/, '.raw.wav');
  const audio = await kokoroTTS.generate(text, { voice: VOICE, speed: SPEED });
  await audio.save(rawPath);
  // Kokoro writes 24kHz float32; downstream concat (padToDuration/render.sh)
  // stream-copies wavs together, so every clip must share one format —
  // resample/requantize to match espeak/say's 16kHz mono pcm_s16le output.
  execFileSync(FFMPEG, ['-y', '-i', rawPath, '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', outPath], { stdio: 'ignore' });
  fs.unlinkSync(rawPath);
}

const synth = ENGINE === 'kokoro' ? synthKokoro : ENGINE === 'say' ? synthSay : synthEspeak;

console.log(`Cut: ${CUT} (${BEATS.length} beats)`);
console.log(ENGINE === 'kokoro' ? `Engine: kokoro · voice: ${VOICE} @ speed ${SPEED}` : `Engine: ${ENGINE} · voice: ${VOICE} @ ${RATE_WPM}wpm`);
if (ENGINE === 'say' && os.platform() !== 'darwin') {
  console.error('--engine say only works on macOS (it shells out to the `say` command).');
  process.exit(1);
}

const manifest = {};

for (const beat of BEATS) {
  let narrationMs = 0;
  if (beat.narration) {
    const clipPath = path.join(voiceDir, `${beat.id}.narration.wav`);
    await synth(beat.narration, clipPath);
    narrationMs = Math.round(getDurationMs(clipPath));
  }

  const waitMs = Math.max(narrationMs, beat.minMs || 0) + TAIL_PAD_MS;
  manifest[beat.id] = { narrationMs, waitMs, narration: beat.narration || null };
  console.log(`  ${beat.id}: narration ${narrationMs}ms, nominal wait ${waitMs}ms`);
}

fs.writeFileSync(path.join(voiceDir, 'manifest.json'), JSON.stringify(manifest, null, 2));

const totalMs = Object.values(manifest).reduce((s, b) => s + b.waitMs, 0);
console.log(`\nWrote demo/${outDirForCut(CUT)}/voice/*.narration.wav + manifest.json`);
console.log(`Nominal scripted runtime: ${(totalMs / 1000).toFixed(1)}s (record.mjs will run a little longer — see its resync step)`);
