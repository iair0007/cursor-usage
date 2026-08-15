// Small ffmpeg/wav helpers shared by generate-voiceover.mjs and record.mjs's
// post-recording resync step.

import path from 'node:path';
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';

export const FFMPEG = process.env.DEMO_FFMPEG || 'ffmpeg';
export const SAMPLE_RATE = 16000;

// ffmpeg writes probe info to stderr and exits non-zero with no output file
// given, so capture stderr directly rather than relying on stdout/exit code.
export function getDurationMs(file) {
  const stderr = spawnSync(FFMPEG, ['-i', file], { encoding: 'utf8' }).stderr || '';
  const m = stderr.match(/Duration: (\d+):(\d\d):(\d\d)\.(\d+)/);
  if (!m) throw new Error(`Could not parse ffmpeg duration for ${file}:\n${stderr}`);
  const [, hh, mm, ss, frac] = m;
  return ((Number(hh) * 60 + Number(mm)) * 60 + Number(ss)) * 1000 + Number(frac) * 10;
}

export function silenceFile(outPath, ms) {
  execFileSync(FFMPEG, [
    '-y', '-f', 'lavfi', '-i', `anullsrc=r=${SAMPLE_RATE}:cl=mono`,
    '-t', String(Math.max(0, ms) / 1000),
    '-c:a', 'pcm_s16le', outPath,
  ], { stdio: 'ignore' });
}

export function concatWavs(files, outPath) {
  const listPath = path.join(path.dirname(outPath), `concat-list-${Date.now()}.txt`);
  fs.writeFileSync(listPath, files.map((f) => `file '${path.resolve(f)}'`).join('\n'));
  execFileSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath], { stdio: 'ignore' });
  fs.unlinkSync(listPath);
}

/** A narration clip padded with trailing silence to exactly `targetMs`. */
export function padToDuration(clipPath, clipMs, targetMs, outPath, tmpDir) {
  const trailMs = Math.max(0, targetMs - clipMs);
  if (trailMs === 0) {
    fs.copyFileSync(clipPath, outPath);
    return;
  }
  const trailPath = path.join(tmpDir, `pad-${path.basename(outPath)}.tmp.wav`);
  silenceFile(trailPath, trailMs);
  concatWavs([clipPath, trailPath], outPath);
  fs.unlinkSync(trailPath);
}
