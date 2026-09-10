# ADR 001 — QR scanning without ML Kit

**Status:** accepted · **Date:** 2026-09-10

## Context

QR pairing is the strongest way to add a friend: the identity key arrives out of
band, so there is nothing for an attacker in the middle to substitute.
Generating the code is pure JavaScript and unproblematic. Reading one needs a
camera and a decoder.

The obvious dependency, `react-native-vision-camera-barcode-scanner`, is backed
by Google ML Kit. ML Kit ships **x86_64-only simulator slices**, so its podspec
sets

```
EXCLUDED_ARCHS[sdk=iphonesimulator*] = arm64
```

and CocoaPods propagates that to the whole app target. On an Apple Silicon Mac
that produces an x86_64 binary, and an x86_64 binary **cannot be installed on an
arm64 simulator**. In practice: nobody on a Mac sold since 2020 could run the
app in a simulator at all. It was found the first time the app was launched.

It also added roughly 30 MB of native binary, and a Google Play Services
dependency on Android — for an app whose whole premise is working with no
network.

## Decision

Remove it. `react-native-vision-camera` v5 has its own **object output**
(`useObjectOutput` with `types: ['qr']`, `isScannedCode`) which reads QR codes
natively, on the platform's own vision stack, with nothing to exclude an
architecture for.

## Consequences

**Good**

- The app builds and runs on an Apple Silicon simulator.
- 12 fewer pods, about 30 MB smaller.
- No Play Services dependency on Android.
- Detection is still native and real-time — this is not a downgrade in
  behaviour, only in dependency weight.

**Known limitation**

`useObjectOutput` throws where the platform has no object-detection output. A
hook cannot be called conditionally, so the camera lives in its own component
(`ScannerCamera.tsx`) that the screen mounts **last**, once the platform, the
permission and a real camera are all confirmed. Where scanning is unavailable
the screen says so and points at the six-digit code, which is a complete
alternative — and QR pairing still works between the two platforms in that case,
because the device that cannot scan can still *show* its code.

**Rejected alternatives**

- *Keep ML Kit and accept the simulator being unusable.* Unacceptable: it makes
  the app undevelopable on the machines developers actually have.
- *Decode in JavaScript with `jsqr`.* Works, and was the first plan — take a
  snapshot every few hundred milliseconds, read the pixels, decode. Dropped once
  Vision Camera turned out to do it natively: JS decoding would have been slower
  and no simpler.
