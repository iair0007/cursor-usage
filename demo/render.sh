#!/usr/bin/env bash
# Converts the Playwright-recorded demo/out/*.webm into a shareable mp4 (and a
# lightweight gif for embedding in the README). Run after demo/record.mjs.
set -euo pipefail

cd "$(dirname "$0")"

FFMPEG="${DEMO_FFMPEG:-ffmpeg}"
WEBM="$(ls -t out/*.webm | head -1)"

if [ -z "$WEBM" ]; then
  echo "No .webm found in demo/out — run 'node demo/record.mjs' first." >&2
  exit 1
fi

echo "Source: $WEBM"

NARRATION="out/voice/narration.wav"
LEAD_MS="$(cat out/lead-ms.txt 2>/dev/null || echo 0)"

if [ -f "$NARRATION" ]; then
  echo "Muxing narration: $NARRATION (delayed ${LEAD_MS}ms to match the recording's page-load lead-in)"
  "$FFMPEG" -y -i "$WEBM" -i "$NARRATION" \
    -af "adelay=${LEAD_MS}:all=1" \
    -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
    -c:a aac -b:a 128k -shortest -movflags +faststart \
    out/demo.mp4
else
  echo "No narration track found — rendering silent (run generate-voiceover.mjs first for a narrated cut)."
  "$FFMPEG" -y -i "$WEBM" \
    -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart \
    out/demo.mp4
fi

"$FFMPEG" -y -i "$WEBM" -vf "fps=12,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
  out/demo.gif

echo "Wrote out/demo.mp4 and out/demo.gif"
