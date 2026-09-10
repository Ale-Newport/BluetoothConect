#!/usr/bin/env bash
# Regenerate the app icon set from assets/icon-source.svg.
#
# Uses macOS's built-in tools so it needs no extra dependencies:
#   qlmanage renders the SVG, sips resizes.
# Point icon-source.svg at real artwork and run this again.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="assets/icon-source.svg"
[ -f "$SRC" ] || { echo "missing $SRC"; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Rendering $SRC at 1024px..."
qlmanage -t -s 1024 -o "$TMP" "$SRC" >/dev/null 2>&1
MASTER="$TMP/$(basename "$SRC").png"
[ -f "$MASTER" ] || { echo "render failed - is qlmanage available?"; exit 1; }

IOS="apps/mobile/ios/AirLink/Images.xcassets/AppIcon.appiconset"
mkdir -p "$IOS"
# Xcode 14+ accepts a single 1024px icon and derives the rest.
sips -z 1024 1024 "$MASTER" --out "$IOS/icon-1024.png" >/dev/null
cat > "$IOS/Contents.json" <<'JSON'
{
  "images" : [
    { "filename" : "icon-1024.png", "idiom" : "universal", "platform" : "ios", "size" : "1024x1024" }
  ],
  "info" : { "author" : "xcode", "version" : 1 }
}
JSON

ANDROID="apps/mobile/android/app/src/main/res"
for entry in "mdpi:48" "hdpi:72" "xhdpi:96" "xxhdpi:144" "xxxhdpi:192"; do
  density="${entry%%:*}"
  size="${entry##*:}"
  mkdir -p "$ANDROID/mipmap-$density"
  sips -z "$size" "$size" "$MASTER" --out "$ANDROID/mipmap-$density/ic_launcher.png" >/dev/null
  sips -z "$size" "$size" "$MASTER" --out "$ANDROID/mipmap-$density/ic_launcher_round.png" >/dev/null
done

echo "Done. iOS: $IOS  Android: $ANDROID/mipmap-*"
echo "These are PLACEHOLDERS until assets/icon-source.svg is real artwork."
