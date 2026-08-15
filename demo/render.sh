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

"$FFMPEG" -y -i "$WEBM" \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart \
  out/demo.mp4

"$FFMPEG" -y -i "$WEBM" -vf "fps=12,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
  out/demo.gif

echo "Wrote out/demo.mp4 and out/demo.gif"
