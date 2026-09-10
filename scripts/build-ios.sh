#!/usr/bin/env bash
# Build the iOS app and report only what matters.
#
# Two rules, and the second one exists because of a real crash.
#
#   1. Third-party pods emit a great deal of nullability and shadowing noise we
#      neither own nor can fix, so it is filtered out.
#   2. Warnings in OUR OWN sources are never filtered. A hand-written
#      TurboModule method once drifted from the signature codegen generates -
#      `double` where the protocol said `NSInteger` - which compiles, because a
#      selector matches on its name, and then segfaults at the first call
#      because arm64 passes integers and doubles in different registers. Clang
#      warned about it. This script swallowed the warning, and the defect was
#      found by a crash on a device instead.
#
# Usage: ./scripts/build-ios.sh [destination] [configuration]
#   ./scripts/build-ios.sh                                  # simulator, Debug
#   ./scripts/build-ios.sh 'generic/platform=iOS' Release    # device, Release
set -uo pipefail
cd "$(dirname "$0")/../apps/mobile/ios" || exit 1
export LANG=en_US.UTF-8

DEST="${1:-generic/platform=iOS Simulator}"
CONFIG="${2:-Debug}"

# Paths whose warnings are ours, and therefore never filtered.
OURS='airlink-transport|apps/mobile/ios/AirLink/'

OUTPUT=$(
  xcodebuild \
    -workspace AirLink.xcworkspace \
    -scheme AirLink \
    -configuration "$CONFIG" \
    -destination "$DEST" \
    -derivedDataPath build/DerivedData \
    build 2>&1
)
STATUS=$?

# Our own warnings, in full.
MINE=$(printf '%s\n' "$OUTPUT" | grep -E "warning:|error:" | grep -E "$OURS" | sort -u)
if [ -n "$MINE" ]; then
  echo "--- warnings and errors in our own sources ---"
  printf '%s\n' "$MINE"
  echo
fi

# Everything else, filtered down to real failures.
printf '%s\n' "$OUTPUT" \
  | grep -E "error:|BUILD SUCCEEDED|BUILD FAILED|The following build commands failed" -A1 \
  | grep -viE "blob-util|image-picker|PromisesObjC|sqlite3|NSFileManager|GoogleToolbox|GTMSession" \
  | sort -u

exit $STATUS
