# ADR 001 — QR scanning without ML Kit

**Status:** accepted · **Date:** 2026-09-10

## Context

QR pairing is the strongest way to add a friend: the identity key arrives out of
band, so there is nothing for an attacker in the middle to substitute.
Generating the code is pure JavaScript and unproblematic. Reading one needs a
camera and a decoder.

The obvious choice, `react-native-vision-camera-barcode-scanner`, is backed by
Google ML Kit. ML Kit ships **x86_64-only simulator slices**, so its podspec sets

```
EXCLUDED_ARCHS[sdk=iphonesimulator*] = arm64
```

which propagates to the whole app target. On an Apple Silicon Mac that produces
an x86_64 build, and an x86_64 build **cannot be installed on an arm64
simulator**. In practice: nobody on a modern Mac can run the app in a simulator
at all.

It also adds roughly 30 MB of native binary for one screen.

## Decision

Remove the ML Kit scanner. Keep `react-native-vision-camera` for the camera
preview, and decode with [`jsqr`](https://www.npmjs.com/package/jsqr) — a pure
JavaScript QR decoder, no native code, no Play Services, nothing to exclude an
architecture for.

The scan screen takes a snapshot every few hundred milliseconds and runs it
through `jsqr` until a code parses.

## Consequences

**Good**

- The app builds and runs on an Apple Silicon simulator, which is every Mac sold
  since 2020.
- About 30 MB smaller.
- No Google Play Services dependency on Android, which matters for an app whose
  whole premise is working with no network.
- One fewer native dependency to keep in step with React Native releases.

**Bad**

- Slower than a native detector: a few hundred milliseconds per attempt rather
  than continuous real-time detection. For a friend holding up a static code
  this is not a meaningful difference; for scanning a moving barcode on a
  shelf it would be.
- Decoding runs on the JS thread. Snapshots are downscaled before decoding, and
  the interval is throttled, so it does not compete with anything that matters —
  the scan screen is not doing anything else.

**Rejected alternatives**

- *Keep ML Kit and accept the simulator being unusable.* Unacceptable: it makes
  the app undevelopable on the machines developers actually have.
- *Write a native detector ourselves* (`AVCaptureMetadataOutput` on iOS, ZXing on
  Android). Technically the best answer — genuinely real-time, no ML Kit — but it
  needs a Fabric view component on both platforms for the camera preview. Worth
  revisiting if scanning ever becomes a hot path. It is not: it happens once per
  friendship.
