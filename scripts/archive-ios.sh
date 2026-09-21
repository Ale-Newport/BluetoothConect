#!/usr/bin/env bash
# Produce a signed .ipa you can upload to App Store Connect.
#
# This is a DIFFERENT operation from build-ios.sh and run-device.sh, and the
# difference is the reason this script exists. Those two produce a build that
# runs on hardware you own, signed with a *development* identity. The App Store
# will not take that binary at all: a distribution build is signed with an
# Apple Distribution certificate against an App Store provisioning profile, and
# it must NOT carry the get-task-allow entitlement that lets a debugger attach.
# You cannot get there by adding a flag to a development build.
#
# Usage:
#   ./scripts/archive-ios.sh                        # archive + export an .ipa
#   ./scripts/archive-ios.sh --team ABCDE12345      # pick the signing team
#   ./scripts/archive-ios.sh --archive-only         # stop before exporting
#   ./scripts/archive-ios.sh --upload               # also send it to Apple
#
# A PAID Apple Developer Program membership is required. A free Apple ID
# ("Personal Team") cannot issue an Apple Distribution certificate, so this
# script will fail at the export step with any free account - not because
# anything here is wrong, but because Apple does not permit it.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IOS_DIR="$ROOT/apps/mobile/ios"
OUT_DIR="$ROOT/apps/mobile/ios/build/AppStore"
ARCHIVE="$OUT_DIR/AirLink.xcarchive"
TEAM="${AIRLINK_TEAM_ID:-}"
BUNDLE_ID=""
ARCHIVE_ONLY=0
UPLOAD=0

while [ $# -gt 0 ]; do
  case "$1" in
    --team) TEAM="${2:-}"; shift 2 ;;
    --bundle-id) BUNDLE_ID="${2:-}"; shift 2 ;;
    --archive-only) ARCHIVE_ONLY=1; shift ;;
    --upload) UPLOAD=1; shift ;;
    -h|--help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# --- 1. Which team signs this -----------------------------------------------
#
# Asked first because a wrong or missing team is the failure that costs the
# most time: xcodebuild archives for several minutes and only then reports it.
if [ -z "$TEAM" ]; then
  # Exactly one Apple Distribution certificate is the common case, and reading
  # it is friendlier than making somebody find their team id in a web portal.
  TEAM=$(security find-identity -v -p codesigning 2>/dev/null \
    | grep -o 'Apple Distribution: .*(\([A-Z0-9]\{10\}\))' \
    | grep -o '([A-Z0-9]\{10\})$' | tr -d '()' | sort -u | head -1)
fi

if [ -z "$TEAM" ]; then
  fail "No Apple Distribution certificate found, and no team id given.

  This is what a free Apple ID looks like from here: a Personal Team can sign
  a build for your own phone but cannot issue a distribution certificate, so
  there is nothing for this script to find.

  If you have paid for the Apple Developer Program:
    1. Xcode -> Settings -> Accounts -> your Apple ID -> Manage Certificates
    2. '+' -> Apple Distribution
  Then run this again, or pass the team explicitly:
    ./scripts/archive-ios.sh --team ABCDE12345
  Your team id is in the top right of https://developer.apple.com/account ."
fi

say "Archiving for the App Store (team $TEAM)"
note "Configuration Release, generic iOS device, JS bundle embedded."

EXTRA=()
[ -n "$BUNDLE_ID" ] && EXTRA+=(PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID")

rm -rf "$ARCHIVE"
mkdir -p "$OUT_DIR"

# `-destination generic/platform=iOS` and NOT a specific device: an archive is
# not built for one phone. Passing a booted simulator or a connected handset
# here is the usual reason an archive comes out unexportable.
OUTPUT=$(cd "$IOS_DIR" && xcodebuild \
  -workspace AirLink.xcworkspace \
  -scheme AirLink \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$ARCHIVE" \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_STYLE=Automatic \
  "${EXTRA[@]}" \
  archive 2>&1)
STATUS=$?

# Our own warnings are never swallowed. A hand-written TurboModule that drifts
# from what codegen generates still compiles and then crashes on a device, and
# the warning is the only notice you get. See build-ios.sh.
echo "$OUTPUT" | grep -E 'airlink-transport|apps/mobile/ios/AirLink/' \
  | grep -E 'warning:|error:' | sort -u | sed 's/^/  /' || true

if [ $STATUS -ne 0 ] || [ ! -d "$ARCHIVE" ]; then
  echo "$OUTPUT" | grep -E 'error:|Provisioning|Signing|certificate' | sort -u | sed 's/^/  /' | head -20
  fail "Archive failed. The lines above are the ones worth reading."
fi

say "Archived: $ARCHIVE"

if [ $ARCHIVE_ONLY -eq 1 ]; then
  note "Stopping here as asked. Open it with: open '$ARCHIVE'"
  exit 0
fi

# --- 2. Export an .ipa ------------------------------------------------------
#
# ExportOptions is written here rather than committed because it carries the
# team id, which differs per account and does not belong in the repo.
PLIST="$OUT_DIR/ExportOptions.plist"
cat > "$PLIST" <<PLIST_END
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>method</key>
	<string>app-store-connect</string>
	<key>teamID</key>
	<string>$TEAM</string>
	<key>destination</key>
	<string>export</string>
	<key>signingStyle</key>
	<string>automatic</string>
	<!-- Symbols let App Store Connect symbolicate crash reports, which is the
	     only crash reporting this app has: it ships no analytics SDK. -->
	<key>uploadSymbols</key>
	<true/>
	<!-- Bitcode has been removed from Xcode entirely; stating it avoids an
	     argument with older tooling. -->
	<key>compileBitcode</key>
	<false/>
</dict>
</plist>
PLIST_END

say "Exporting an .ipa"
EXPORT_OUT=$(cd "$IOS_DIR" && xcodebuild \
  -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportOptionsPlist "$PLIST" \
  -exportPath "$OUT_DIR" \
  -allowProvisioningUpdates 2>&1)
EXPORT_STATUS=$?

IPA=$(find "$OUT_DIR" -maxdepth 1 -name '*.ipa' | head -1)
if [ $EXPORT_STATUS -ne 0 ] || [ -z "$IPA" ]; then
  echo "$EXPORT_OUT" | grep -E 'error:|Provisioning|certificate|profile' | sort -u | sed 's/^/  /' | head -20
  fail "Export failed. If it mentions a distribution certificate or an App
  Store profile, that is an account matter and not a project one - see the
  message at the top of this script about free Apple IDs."
fi

say "Exported: $IPA"
note "$(du -h "$IPA" | cut -f1) - this is the file App Store Connect wants."

# --- 3. Optionally hand it to Apple ----------------------------------------
if [ $UPLOAD -eq 1 ]; then
  say "Uploading to App Store Connect"
  note "This needs an app-specific password, not your Apple ID password."
  note "Make one at https://appleid.apple.com -> Sign-In and Security."
  note "Put it in the keychain once:  xcrun notarytool store-credentials"
  note "or export AIRLINK_APPLE_ID and AIRLINK_APP_PASSWORD before running."

  if [ -z "${AIRLINK_APPLE_ID:-}" ] || [ -z "${AIRLINK_APP_PASSWORD:-}" ]; then
    fail "AIRLINK_APPLE_ID and AIRLINK_APP_PASSWORD are not both set, so there
  is nothing to authenticate with. The .ipa above is finished and valid - you
  can upload it by hand from Xcode's Organizer window, or with Apple's
  Transporter app, which is the route most people find easier the first time."
  fi

  xcrun altool --upload-app \
    --type ios \
    --file "$IPA" \
    --username "$AIRLINK_APPLE_ID" \
    --password "$AIRLINK_APP_PASSWORD" \
    || fail "Upload rejected. Apple's message above is usually precise; the
  most common first-time causes are a build number that has already been used
  (bump CURRENT_PROJECT_VERSION) and an app record that does not yet exist."
  say "Uploaded. It will appear in App Store Connect after processing."
else
  say "Next"
  note "Upload it from Xcode: Window -> Organizer -> Archives -> Distribute App."
  note "Or run this again with --upload once your credentials are set."
fi
