#!/bin/sh
# Redraws the desktop app's icons from buddi.app's (apps/mac/Design, itself
# drawn from the mascot rig by apps/mac/scripts/make-icons.mjs). Needs
# rsvg-convert (librsvg2-bin) and ImageMagick for the tray glyphs.
#   icons/*.png         the app icon (window, launcher, .deb, AppImage)
#   icons/tray/*.png    the tray glyph per state: running, starting (stopped
#                       too) and attention; -light for dark panels (GNOME,
#                       Pop!_OS, Ubuntu), -dark for light ones
set -eu
cd "$(dirname "$0")/.."
DESIGN=../mac/Design
# The app icon is buddi.app's own, as its asset catalog has it (librsvg does
# not draw app-icon.svg's figure, so the PNGs make-icons.mjs rendered are the source).
APPICON=../mac/Resources/Assets.xcassets/AppIcon.appiconset
for pair in 32x32:32 128x128:128 256x256:256 icon:512; do
  name=${pair%%:*}; size=${pair##*:}
  cp "$APPICON/icon_$size.png" "icons/$name.png"
done
mkdir -p icons/tray
for state in running starting attention; do
  src=status-glyph; [ "$state" = running ] || src="status-glyph-$state"
  for variant in light:#f2f2f2 dark:#1d1d1d; do
    name=${variant%%:*}; ink=${variant##*:}
    # Only the ink group is recoloured; the mask's own black is what cuts the eyes.
    sed "s/<g fill=\"#000\"/<g fill=\"$ink\"/" "$DESIGN/$src.svg" | rsvg-convert -w 64 -h 64 \
      | magick - -define png:color-type=6 "PNG32:icons/tray/$state-$name.png"
  done
done
