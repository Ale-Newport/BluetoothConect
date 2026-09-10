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

UDID=""
if [ "$BUILD_ONLY" -eq 0 ]; then
  # Parsed from JSON rather than by column position. The table's last column is
  # the MODEL - an earlier version took that and handed xcodebuild "iPhone18,1"
  # as if it were a device id.
  DEVJSON=$(mktemp -t airlink-devices)
  xcrun devicectl list devices --json-output "$DEVJSON" >/dev/null 2>&1
  read -r UDID DEVNAME DEVMODE <<EOF
$(python3 - "$DEVJSON" "$DEVICE" <<'PY'
import json, sys
try:
    devices = json.load(open(sys.argv[1]))["result"]["devices"]
except Exception:
    sys.exit(0)
wanted = sys.argv[2] if len(sys.argv) > 2 else ""
for d in devices:
    props = d.get("deviceProperties", {})
    name = props.get("name", "")
    udid = d.get("identifier", "")
    if wanted and wanted not in (name, udid):
        continue
    print(udid, name.replace(" ", "_"), props.get("developerModeStatus") or "None")
    break
PY
)
EOF
  rm -f "$DEVJSON"

  [ -z "$UDID" ] && fail "No iPhone is connected.

  Plug it in with a cable, unlock it, and tap Trust on the phone.
  Then check it appears:  xcrun devicectl list devices"

  say "Device: ${DEVNAME//_/ } ($UDID)"

  # xcodebuild and devicectl use DIFFERENT IDENTIFIERS FOR THE SAME PHONE, and
  # nothing warns you: devicectl reports a CoreDevice UUID
  # (77043BBF-0DA1-55F3-...) while xcodebuild wants the hardware UDID
  # (00008150-001C42A61E...). Passing one where the other is expected produces
  # "Unable to find a device matching the provided destination specifier",
  # which reads like the phone is not attached when it is sitting right there.
  # So: ask xcodebuild what IT can see, and keep both ids.
  XCID=$(cd "$IOS_DIR" && xcodebuild -workspace AirLink.xcworkspace -scheme AirLink \
    -showdestinations 2>/dev/null \
    | grep "platform:iOS," | grep -v "placeholder" \
    | sed -n "s/.*id:\([0-9A-Fa-f-]*\).*name:\(.*\) }.*/\1|\2/p" \
    | awk -F'|' -v want="${DEVNAME//_/ }" '$2 == want { print $1; exit } END { }' )
  if [ -z "$XCID" ]; then
    XCID=$(cd "$IOS_DIR" && xcodebuild -workspace AirLink.xcworkspace -scheme AirLink \
      -showdestinations 2>/dev/null \
      | grep "platform:iOS," | grep -v "placeholder" \
      | sed -n 's/.*id:\([0-9A-Fa-f-]*\).*/\1/p' | head -1)
  fi

  # iOS 16 and later refuse to run a development build until Developer Mode is
  # switched on, and the switch only APPEARS after a Mac has tried to install
  # one - so the first failure here is part of the procedure, not a fault.
  if [ "$DEVMODE" != "enabled" ]; then
    say "Developer Mode is not enabled on this iPhone (reported: $DEVMODE)."
    echo "  On the phone: Settings -> Privacy & Security -> Developer Mode -> on,"
    echo "  then restart it. If that menu is not there yet, this build is what"
    echo "  makes it appear - run this script again once you have switched it on."
  fi
fi

# --- 4. Build --------------------------------------------------------------

# A GENERIC destination is why Apple kept saying "your team has no devices":
# with no specific device in the build, there is no UDID to register, so a free
# Personal Team can never be issued a provisioning profile. Target the phone.
DEST="generic/platform=iOS"
[ -n "${XCID:-}" ] && DEST="id=$XCID"

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
  -destination "$DEST" \
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
    *"Developer Mode disabled"*|*"Timed out waiting for all destinations"*)
      fail "Developer Mode is switched off on the iPhone, and iOS will not run a
  development build without it.

  On the phone:
    Settings -> Privacy & Security -> Developer Mode -> turn it on
    The phone restarts, and asks you to confirm again after it boots.

  If that menu is not in Settings, it appears once a Mac has tried to use
  the phone for development - which this script has now done. Look again.

  Then run this script once more. Nothing else is outstanding: the
  certificate, the App ID and the account are all in place." ;;
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
xcrun devicectl device install app --device "$UDID" "$APP" || fail "Install failed.

  If the phone says the app cannot be installed, check on the device:
    Settings -> General -> VPN & Device Management -> trust your developer
    certificate. iOS will not run an app from an untrusted developer."

BID="${BUNDLE_ID:-com.airlink.app}"
say "Launching $BID"
if ! xcrun devicectl device process launch --device "$UDID" "$BID" 2>/dev/null; then
  cat <<'TRUST'

  The app is INSTALLED but iOS will not run it yet, and tapping the icon
  will fail the same way. A development build has to be trusted once, by
  hand, on the phone:

    Settings -> General -> VPN & Device Management
      -> Apple Development: <your Apple ID> -> Trust

  Then tap AirLink on the home screen. This is a one-time step per
  certificate, not per build.
TRUST
fi

cat <<'NOTE'

Done.

One thing to remember with a free Apple ID: the provisioning profile expires
seven days after signing, and iOS then refuses to launch the app until you run
this again. A paid Apple Developer Program membership makes it a year.
NOTE
