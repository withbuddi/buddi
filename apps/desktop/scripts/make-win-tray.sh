#!/bin/sh
# The Windows tray icons: the full-colour Blob, as the taskbar and Start show
# it (the notification area there is in colour: Defender, Copilot), cut at the
# notification area's sizes per display scale (16 px at 100 %, 20 at 125 %,
# 24 at 150 %, 32 at 200 %) from buddi.app's small-size favicon cuts
# (apps/mac/Design/favicon-16.svg and -32.svg). Per state:
#   running    the Blob
#   starting   the Blob in grey (also stopped)
#   attention  the Blob with an amber dot, bottom right
# Needs ImageMagick 7.
set -eu
cd "$(dirname "$0")/.."
DESIGN=../mac/Design
mkdir -p icons/tray
for pair in 16:favicon-16 20:favicon-16 24:favicon-32 32:favicon-32; do
  s=${pair%%:*}; svg=$DESIGN/${pair##*:}.svg
  base=$(mktemp -t buddi-tray).png
  magick -background none -density 2400 "$svg" -trim +repage -resize "${s}x${s}" -gravity center -background none -extent "${s}x${s}" "PNG32:$base"
  cp "$base" "icons/tray/win-running-$s.png"
  magick "$base" -colorspace Gray -level 0%,80% "PNG32:icons/tray/win-starting-$s.png"
  # The dot: about a third of the icon, ringed in white so it reads on any taskbar.
  r=$(( (s * 3 + 9) / 20 )); c=$(( s - r - 1 ))
  magick "$base" -fill white -draw "circle $c,$c $c,$(( c - r - 1 ))" -fill '#F59E0B' -draw "circle $c,$c $c,$(( c - r ))" "PNG32:icons/tray/win-attention-$s.png"
  rm -f "$base"
done
