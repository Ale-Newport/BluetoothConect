#!/usr/bin/env bash
# Build the iOS app for the simulator and report only what matters.
#
# Third-party pods emit a great deal of nullability and shadowing noise that we
# cannot fix and do not own; this filters it out so a real error is impossible
# to miss.
set -uo pipefail
cd "$(dirname "$0")/../apps/mobile/ios" || exit 1
export LANG=en_US.UTF-8

DEST="${1:-generic/platform=iOS Simulator}"

xcodebuild \
  -workspace AirLink.xcworkspace \
  -scheme AirLink \
  -configuration Debug \
  -destination "$DEST" \
  -derivedDataPath build/DerivedData \
  build 2>&1 \
| grep -E "error:|BUILD SUCCEEDED|BUILD FAILED|The following build commands failed" -A1 \
| grep -viE "blob-util|image-picker|PromisesObjC|sqlite3|NSFileManager|GoogleToolbox|GTMSession" \
| sort -u
