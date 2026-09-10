#!/usr/bin/env bash
# Build AirLink for a physical iPhone, install it, and launch it.
#
# Release by default, and that matters more here than anywhere else in this
# repo. A Debug build fetches its JavaScript from Metro over the network, so the
# phone stays tethered to this Mac - which is a strange way to test an app whose
# entire premise is working with no network at all. A Release build embeds the
# bundle in the .app: the phone can then go into airplane mode, or onto a plane,
# and the app is complete on its own.
#
# Usage:
#   ./scripts/run-device.sh                     # Release, first device found
#   ./scripts/run-device.sh --debug             # tethered to Metro on this Mac
#   ./scripts/run-device.sh --device <name|udid>
#   ./scripts/run-device.sh --bundle-id com.you.airlink
#   ./scripts/run-device.sh --build-only        # do not install or launch
#
# Nothing here writes to the repository. The team id and bundle id are passed on
# the xcodebuild command line, so a personal Apple ID never ends up committed.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IOS_DIR="$ROOT/apps/mobile/ios"
CONFIG=Release
DEVICE=""
BUNDLE_ID=""
TEAM="${AIRLINK_TEAM_ID:-}"
BUILD_ONLY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --debug) CONFIG=Debug; shift ;;
    --release) CONFIG=Release; shift ;;
    --device) DEVICE="${2:-}"; shift 2 ;;
    --bundle-id) BUNDLE_ID="${2:-}"; shift 2 ;;
    --team) TEAM="${2:-}"; shift 2 ;;
    --build-only) BUILD_ONLY=1; shift ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. A signing identity -------------------------------------------------
#
# Checked first because it is the failure that wastes the most time: without it
# xcodebuild runs for two minutes and then reports a signing error that reads
# like a project problem rather than an account one.

# The ONLY certificate state that genuinely blocks a build is an expired one.
#
# Having no certificate at all does not: `xcodebuild -allowProvisioningUpdates`
# creates it, and for a free Personal Team that is the ONLY way it can be
# created - there is no button for it in Xcode, which is exactly where people
# get stuck looking for one. An earlier version of this script refused to
# continue without a certificate and so blocked the very build that would have
# minted it.
#
# An EXPIRED one is different, and worse than none: codesign keeps matching it
# by name and fails, so it has to be deleted by hand first.
if security find-identity -p codesigning 2>/dev/null | grep -q "CSSMERR_TP_CERT_EXPIRED"; then
  fail "Your Apple Development certificate has EXPIRED, so nothing can be signed.

  Free Apple ID certificates last one year, and an expired one has to be
  removed by hand - leaving it there makes codesign keep matching it by name.

    1. Open Keychain Access (Cmd+Space, 'Keychain Access' - on macOS 15 it is
       hidden from Applications). Sidebar: login -> My Certificates.
    2. Delete the expired 'Apple Development: ...' entry.
    3. Re-run this script. Xcode issues a fresh certificate while provisioning.

  Nobody but you can do this: it needs your keychain."
fi

if ! security find-identity -v -p codesigning 2>/dev/null | grep -q "Apple Development"; then
  say "No signing certificate yet - Xcode will create one while provisioning."
  echo "  This needs your Apple ID to be signed in (Xcode -> Settings -> Apple"
  echo "  Accounts) and it may ask for your keychain password. Both are normal."
fi

# --- 2. A team -------------------------------------------------------------

if [ -z "$TEAM" ]; then
  # `defaults` prints teamID unquoted - `teamID = SM3MGV3PY8;` - and an earlier
  # version of this looked for a quoted value, so it silently found nothing and
  # sent people off to run the command by hand. Accept both shapes.
  TEAM=$(defaults read com.apple.dt.Xcode IDEProvisioningTeams 2>/dev/null \
    | sed -n 's/.*teamID[[:space:]]*=[[:space:]]*"\{0,1\}\([A-Z0-9]\{10\}\)"\{0,1\};.*/\1/p' \
    | head -1 || true)
fi
[ -z "$TEAM" ] && fail "Could not work out your Team ID.

  Find it with:  defaults read com.apple.dt.Xcode IDEProvisioningTeams
  Then:          ./scripts/run-device.sh --team XXXXXXXXXX
  Or set AIRLINK_TEAM_ID in your shell."

# --- 3. A phone ------------------------------------------------------------

if [ "$BUILD_ONLY" -eq 0 ]; then
  DEVICES=$(xcrun devicectl list devices 2>/dev/null | grep -iE "iphone|ipad" || true)
  [ -z "$DEVICES" ] && fail "No iPhone is connected.

  Plug it in with a cable, unlock it, and tap Trust on the phone.
  Then check it appears:  xcrun devicectl list devices
  (Wireless also works once the device has been paired in Xcode ->
   Window -> Devices and Simulators.)"
  if [ -z "$DEVICE" ]; then
    DEVICE=$(printf '%s\n' "$DEVICES" | head -1 | awk '{print $NF}')
  fi
  say "Device: $DEVICE"
fi

# --- 4. Build --------------------------------------------------------------

say "Building $CONFIG for device (team $TEAM)"
[ "$CONFIG" = "Release" ] && echo "  The JS bundle is embedded, so the phone will not need this Mac."
[ "$CONFIG" = "Debug" ] && echo "  Tethered build: keep 'pnpm start' running and stay on the same Wi-Fi."

# macOS still ships bash 3.2, where expanding an EMPTY array under `set -u` is
# an unbound-variable error rather than nothing. `${EXTRA[@]+...}` is the idiom
# that survives it.
EXTRA=()
[ -n "$BUNDLE_ID" ] && EXTRA+=("PRODUCT_BUNDLE_IDENTIFIER=$BUNDLE_ID")

DERIVED="$IOS_DIR/build/DeviceBuild"
OUTPUT=$(cd "$IOS_DIR" && xcodebuild \
  -workspace AirLink.xcworkspace \
  -scheme AirLink \
  -configuration "$CONFIG" \
  -destination 'generic/platform=iOS' \
  -derivedDataPath "$DERIVED" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_STYLE=Automatic \
  ${EXTRA[@]+"${EXTRA[@]}"} \
  build 2>&1)
STATUS=$?

# Our own warnings are never filtered - see build-ios.sh for why.
printf '%s\n' "$OUTPUT" | grep -E "warning:|error:" | grep -E 'airlink-transport|apps/mobile/ios/AirLink/' | sort -u

if [ $STATUS -ne 0 ]; then
  printf '%s\n' "$OUTPUT" | grep -E "error:" | sort -u | head -20
  case "$OUTPUT" in
    *"is not available"*|*"Failed to register bundle identifier"*)
      fail "Apple would not register the bundle identifier com.airlink.app -
  somebody else's account already owns it.

  Pick your own and pass it in:
    ./scripts/run-device.sh --bundle-id com.<yourname>.airlink

  Note that packages/config/src/brand.ts also records the identifier; change
  it there too if you want the two to agree." ;;
    *"requires a development team"*)
      fail "xcodebuild did not accept the team id ($TEAM). Check it with:
    defaults read com.apple.dt.Xcode IDEProvisioningTeams" ;;
    *"no devices from which to generate"*)
      fail "Everything is ready except the phone.

  Your certificate and your App ID are registered; Apple simply will not
  issue a provisioning profile until it knows about a device. Connect the
  iPhone with a cable, unlock it, tap Trust, and run this again - the
  provisioning profile is created as part of that build.

  This is expected on a first run, not a misconfiguration." ;;
    *"Unable to log in with account"*|*"session has expired"*)
      fail "Xcode could not talk to Apple with your account.
  Xcode -> Settings -> Accounts, sign in again, then re-run." ;;
  esac
  fail "Build failed. The errors above are the whole story; everything else is pod noise."
fi

APP="$DERIVED/Build/Products/$CONFIG-iphoneos/AirLink.app"
[ -d "$APP" ] || fail "Build reported success but $APP is missing."
say "Built: $APP"
if [ "$CONFIG" = "Release" ]; then
  if [ -f "$APP/main.jsbundle" ]; then
    echo "  main.jsbundle embedded ($(du -h "$APP/main.jsbundle" | cut -f1)) - the app is standalone."
  else
    fail "Release build has no main.jsbundle. It would show a blank screen on the phone."
  fi
fi

[ "$BUILD_ONLY" -eq 1 ] && exit 0

# --- 5. Install and launch -------------------------------------------------

say "Installing"
xcrun devicectl device install app --device "$DEVICE" "$APP" || fail "Install failed.

  If the phone says the app cannot be installed, check on the device:
    Settings -> General -> VPN & Device Management -> trust your developer
    certificate. iOS will not run an app from an untrusted developer."

BID="${BUNDLE_ID:-com.airlink.app}"
say "Launching $BID"
xcrun devicectl device process launch --device "$DEVICE" "$BID" || \
  echo "  Could not launch it remotely. Just tap the AirLink icon on the phone."

cat <<'NOTE'

Done.

One thing to remember with a free Apple ID: the provisioning profile expires
seven days after signing, and iOS then refuses to launch the app until you run
this again. A paid Apple Developer Program membership makes it a year.
NOTE
