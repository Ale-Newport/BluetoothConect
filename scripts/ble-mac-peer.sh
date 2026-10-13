#!/usr/bin/env bash
# Use the Mac's own Bluetooth radio as a second AirLink "phone".
#
# The iOS Simulator has no Bluetooth, so an iPhone running AirLink on Bluetooth
# alone (airplane mode, Wi-Fi off) cannot find the simulator - there is no path
# between them, and that is not a bug in the app. This stands in for the other
# phone with real hardware: it advertises the AirLink BLE service, answers
# identity reads, scans for the iPhone, and prints everything the iPhone does to
# it. See scripts/ble-mac-peer/main.swift for what it does and does not do.
#
# Two modes.
#
#   PROBE (default). Speaks only the layer below the protocol. It shows that two
#   phones can find each other and open a Bluetooth link, and never completes a
#   pairing, so tapping Connect on the iPhone ends in "Couldn't connect".
#
#   TALK (--talk). The Mac runs the REAL AirLink protocol - handshake, six-digit
#   pairing, chat, file transfer - over its own Bluetooth radio. The iPhone can
#   connect and pair with it, exchange messages in both directions, and receive
#   a file, and every delivery time and the transfer speed are measured on real
#   hardware. One iPhone is enough.
#
# Usage:
#   ./scripts/ble-mac-peer.sh                  # probe, 10 minutes, as "Mac-test"
#   ./scripts/ble-mac-peer.sh --talk           # the real protocol (see above)
#   ./scripts/ble-mac-peer.sh --talk --file-kb 256 --seconds 300
#   ./scripts/ble-mac-peer.sh --seconds 120
#   ./scripts/ble-mac-peer.sh --name Lucas
#   ./scripts/ble-mac-peer.sh --no-central     # probe mode: only advertise
#
# The first run asks for permission to use Bluetooth. Click Allow, once.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/scripts/ble-mac-peer/main.swift"
OUT="$ROOT/apps/mobile/ios/build/ble-mac-peer"
APP="$OUT/AirLink BLE Peer.app"
LOG="$OUT/peer.log"
ERR="$OUT/peer.err"

say() { printf '\033[1m%s\033[0m\n' "$*"; }

command -v swiftc >/dev/null || { echo "swiftc not found: install Xcode." >&2; exit 1; }
mkdir -p "$OUT"

say "Building the BLE peer"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
swiftc -O -swift-version 5 -o "$APP/Contents/MacOS/AirLinkBlePeer" "$SRC"

# A bundle of its own, with its own usage description, is what makes macOS ask
# the person for Bluetooth permission for THIS tool. Launched as a bare binary
# from a terminal or an editor, the permission would be attributed to the parent
# app, which has no usage string, and the system would kill the process.
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key><string>AirLinkBlePeer</string>
	<key>CFBundleIdentifier</key><string>dev.airlink.ble-mac-peer</string>
	<key>CFBundleName</key><string>AirLink BLE Peer</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>CFBundleVersion</key><string>1</string>
	<key>LSUIElement</key><true/>
	<key>NSBluetoothAlwaysUsageDescription</key>
	<string>This test tool plays the part of a second AirLink phone over Bluetooth.</string>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP" >/dev/null 2>&1

# TALK mode hands the radio to the Node process that speaks the protocol.
TALK=0
PASS=()
for arg in "$@"; do
  if [ "$arg" = "--talk" ]; then TALK=1; else PASS+=("$arg"); fi
done
if [ "$TALK" -eq 1 ]; then
  TSX="$ROOT/node_modules/.bin/tsx"
  [ -x "$TSX" ] || { echo "tsx not found: run 'pnpm install' first." >&2; exit 1; }
  say "Talking the real protocol over Bluetooth"
  exec "$TSX" "$ROOT/scripts/ble-mac-peer/bridge.ts" --app "$APP" --log "$OUT/talk.log" ${PASS[@]+"${PASS[@]}"}
fi

: > "$LOG"; : > "$ERR"
say "Running. Log: $LOG"
open -n -W --stdout "$LOG" --stderr "$ERR" "$APP" --args "$@" &
OPEN_PID=$!
trap 'kill $OPEN_PID 2>/dev/null || true; pkill -f AirLinkBlePeer 2>/dev/null || true' INT TERM

tail -n +1 -f "$LOG" &
TAIL_PID=$!
wait $OPEN_PID || true
sleep 1
kill $TAIL_PID 2>/dev/null || true

if [ -s "$ERR" ]; then
  echo; say "stderr:"; cat "$ERR"
fi
