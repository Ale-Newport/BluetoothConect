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
#   ./scripts/archive-ios.sh --upload               # also send it to Apple, as
#                                                   # the Apple ID signed in to Xcode
#
# A PAID Apple Developer Program membership is required. A free Apple ID
# ("Personal Team") cannot issue an Apple Distribution certificate, so this
# script will fail at the export step with any free account - not because
# anything here is wrong, but because Apple does not permit it.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IOS_DIR="$ROOT/apps/mobile/ios"
OUT_DIR="$ROOT/apps/mobile/ios/build/AppStore"
# The archive goes where Xcode keeps its own, because that folder is the ONLY
# place the Organizer looks. Archived anywhere else it is a perfectly good
# archive that Window -> Organizer -> Archives says does not exist - which is
# exactly what the "Next" step below used to send people to find.
ARCHIVE="$HOME/Library/Developer/Xcode/Archives/$(date +%Y-%m-%d)/AirLink $(date '+%Y-%m-%d %H.%M.%S').xcarchive"
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
    # The whole leading comment block, however long it grows.
    -h|--help) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
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
# Expanded below as ${EXTRA[@]+"${EXTRA[@]}"}, never plain "${EXTRA[@]}": the
# bash that ships with macOS is 3.2, and under `set -u` it calls an EMPTY array
# an unbound variable. The array is empty unless --bundle-id is given, so the
# plain form failed every ordinary run before xcodebuild even started.

rm -rf "$ARCHIVE"
mkdir -p "$OUT_DIR" "$(dirname "$ARCHIVE")"

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
  ${EXTRA[@]+"${EXTRA[@]}"} \
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
#
# Through xcodebuild with `destination = upload`, which is what the Organizer's
# Distribute button does underneath. It authenticates as the Apple ID already
# signed in to Xcode (Settings -> Accounts) - the same session that just
# produced the App Store profile above - so there is no password to create,
# store or type. The route it replaces, `altool` with an app-specific password,
# asked a first-time publisher to mint a credential for a job Xcode can do.
if [ $UPLOAD -eq 1 ]; then
  say "Uploading to App Store Connect"
  note "As the Apple ID signed in to Xcode. This takes a minute or two."

  UPLOAD_PLIST="$OUT_DIR/UploadOptions.plist"
  sed 's#<string>export</string>#<string>upload</string>#' "$PLIST" > "$UPLOAD_PLIST"
  UPLOAD_OUT=$(cd "$IOS_DIR" && xcodebuild \
    -exportArchive \
    -archivePath "$ARCHIVE" \
    -exportOptionsPlist "$UPLOAD_PLIST" \
    -exportPath "$OUT_DIR/upload" \
    -allowProvisioningUpdates 2>&1)
  UPLOAD_STATUS=$?

  if [ $UPLOAD_STATUS -ne 0 ]; then
    echo "$UPLOAD_OUT" | grep -iE 'error|already|version|bundle|account|app record' \
      | sort -u | sed 's/^/  /' | head -20
    fail "Upload rejected. Apple's message above is usually precise. The usual
  first-time causes: the app record does not exist yet in App Store Connect
  (step 4), no Apple ID in Xcode -> Settings -> Accounts, or a build number
  that was already uploaded (raise CURRENT_PROJECT_VERSION). The .ipa above is
  still valid and can be sent with the Transporter app instead."
  fi
  say "Uploaded. Apple processes it for 10 minutes to 2 hours and emails you."
  note "It then appears in App Store Connect -> your app -> TestFlight."
else
  say "Next - upload it"
  note "Easiest: run this again with --upload (uses the Apple ID in Xcode)."
  note "Or Xcode: Window -> Organizer -> Archives -> the newest AirLink ->"
  note "  Distribute App -> App Store Connect -> Distribute."
  note "Or the Transporter app (free, Mac App Store): drag in $IPA"
fi
