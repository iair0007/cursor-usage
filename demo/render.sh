#!/usr/bin/env bash
# Converts the Playwright-recorded .webm into a shareable mp4 (and a
# lightweight gif for embedding in the README). Run after demo/record.mjs.
#
# Usage: ./demo/render.sh [cut]
#   cut: "full" (default) reads/writes demo/out/; every other cut uses
#        demo/out/<cut>/ — the same mapping as outDirForCut() in script.mjs.
#        Must match the cut record.mjs was run with — each cut keeps its own
#        directory so re-rendering one never overwrites the other.
set -euo pipefail

cd "$(dirname "$0")"

CUT="${1:-full}"
# Mirror outDirForCut() in script.mjs: the full cut owns demo/out/ itself, and
# every named cut gets its own subdirectory. Falling back to "out" for an
# unknown cut would silently re-render the full cut's webm over its own mp4.
if [ "$CUT" = "full" ]; then
  OUT="out"
else
  OUT="out/$CUT"
fi

if [ ! -d "$OUT" ]; then
  echo "No demo/$OUT directory — run 'node demo/record.mjs --cut $CUT' first." >&2
  exit 1
fi

FFMPEG="${DEMO_FFMPEG:-ffmpeg}"
WEBM="$(ls -t "$OUT"/*.webm 2>/dev/null | head -1)"

if [ -z "$WEBM" ]; then
  echo "No .webm found in demo/$OUT — run 'node demo/record.mjs --cut $CUT' first." >&2
  exit 1
fi

echo "Cut: $CUT"
echo "Source: $WEBM"

NARRATION="$OUT/voice/narration.wav"
LEAD_MS="$(cat "$OUT/lead-ms.txt" 2>/dev/null || echo 0)"

if [ -f "$NARRATION" ]; then
  echo "Muxing narration: $NARRATION (delayed ${LEAD_MS}ms to match the recording's page-load lead-in)"
  "$FFMPEG" -y -i "$WEBM" -i "$NARRATION" \
    -af "adelay=${LEAD_MS}:all=1" \
    -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
    -c:a aac -b:a 128k -shortest -movflags +faststart \
    "$OUT/demo.mp4"
else
  echo "No narration track found — rendering silent (run generate-voiceover.mjs first for a narrated cut)."
  "$FFMPEG" -y -i "$WEBM" \
    -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart \
    "$OUT/demo.mp4"
fi

"$FFMPEG" -y -i "$WEBM" -vf "fps=12,scale=900:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
  "$OUT/demo.gif"

echo "Wrote $OUT/demo.mp4 and $OUT/demo.gif"
