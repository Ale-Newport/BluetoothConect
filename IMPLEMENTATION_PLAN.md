# AirLink — Implementation Plan

> **Together, even when you're offline.**

This document records the architecture, the decisions behind it, and the honest
limits of what the two mobile platforms allow. It is written to be read before
the code.

Environment this plan was written against (verified on this machine,
2026-09-09):

| Tool | Version |
|---|---|
| Xcode | 26.3 (17C529), iOS SDK 26.2, iOS 26.3 simulator runtime |
| Swift | 6.2.4 |
| Node | 26.0.0, pnpm 10.34.5 |
| React Native | 0.87.1, React 19.2.3, New Architecture (mandatory) |
| Android SDK | **not installed on this machine** — see [Android build status](#android-build-status) |

---

## 1. The one decision everything else follows from

Two phones, no internet, no router, no server. What can actually carry bytes
between them?

We researched this exhaustively against Apple and Google documentation, the
installed SDK headers, and developer-forum answers from Apple DTS engineers.
The answer is uncomfortable and it shapes the whole product:

| Scenario | Transport that actually works | Realistic throughput |
|---|---|---|
| iPhone ↔ iPhone, no network | **Network.framework peer-to-peer** (`includePeerToPeer`, Bonjour, AWDL) | tens of MB/s |
| Android ↔ Android, no network | **Wi-Fi Direct** | several MB/s |
| **iPhone ↔ Android, no network** | **BLE GATT — and nothing else** | **~5–40 KB/s** |
| Any ↔ any, sharing a local Wi-Fi (plane Wi-Fi, a hotspot, a router with no WAN) | **Bonjour/NSD + TCP** | MB/s |
| iPhone ↔ Android, no network, high bandwidth needed | **Android local-only hotspot + iOS `NEHotspotConfiguration`**, credentials handed over via BLE — one system tap | MB/s |

Two findings deserve to be stated plainly because they are commonly got wrong:

- **Wi-Fi Aware is not the answer.** Apple shipped the `WiFiAware` framework in
  iOS 26 and it is genuinely present in the 26.2 SDK. But it requires a paid-team
  entitlement, service names baked into `Info.plist` at build time, and a
  mandatory one-time system pairing ceremony with a six-digit PIN — and
  iPhone↔Android Aware is broken in practice on mainstream handsets (missing
  DCEA attributes, auth status 15, PINs never displayed). We ship a
  capability-detecting adapter and a documented "unavailable" path. We do not
  build the product on it.
- **A backgrounded iOS app is invisible to Android.** Apple documents that a
  backgrounded peripheral moves all of its service UUIDs into the advertising
  *overflow area*, which is "discoverable only by an iOS device explicitly
  scanning for them", and drops the local name entirely. An Android `ScanFilter`
  on our service UUID will not match. This is not a bug we can engineer around,
  so we tell the user the truth: **keep AirLink open to stay connected.** On a
  flight, with both people using the app, that is exactly what happens anyway.

So: **BLE is the floor, and everything must work on it.** A photo over BLE takes
minutes, and the UI says so. Everything faster is an upgrade the user never has
to think about.

---

## 2. Architecture

```
apps/mobile                    React Native 0.87 + TypeScript. Screens, design system.
  └── src/native               TurboModule specs (the only place JS meets Swift/Kotlin)

packages/core                  Pure TypeScript. No React, no platform APIs.
  ├── protocol/                CBOR codec, frame + envelope format, fragmentation, capabilities
  ├── crypto/                  identity, SIGMA-I handshake, AEAD session, replay window, SAS
  ├── transport/               Transport/Link contract + MockTransport simulator
  ├── session/                 reliability, connection state machine, clock sync, PeerSession
  ├── messaging/ files/ sync/  the feature protocols
  └── mesh/                    group routing, designed so host migration can be added

packages/games                 Deterministic game reducers + turn-based and realtime runtimes
packages/db                    SQLite schema, migrations, typed repositories
packages/config                Branding: app name, colours, strings, bundle ids — one place

native/ios                     Swift: CoreBluetooth, Network.framework, hotspot handoff
native/android                 Kotlin: BLE central + peripheral, Wi-Fi Direct, NSD, LOHS

docs/                          ARCHITECTURE, PROTOCOL, SECURITY, TRANSPORTS, IOS, ANDROID,
                               GAMES, FILE_TRANSFER, SYNC, TESTING
tests/                         cross-package integration + the offline acceptance harness
scripts/                       the network test harness and dev tooling
```

### Why the core is pure TypeScript

Every hard part of this product — the handshake, packet ordering, retransmission,
fragment reassembly, deduplication, game determinism, drift correction — is
logic, not radio. Keeping it in dependency-free TypeScript means:

- it runs identically on Hermes and on Node;
- **it is tested against a simulated network, exhaustively, in milliseconds**,
  with two, three or ten virtual devices, deterministic clocks and seeded
  randomness, without touching a phone;
- adding a radio is one file implementing `Transport`, and no feature changes.

The native layer is deliberately *dumb*: discover peers, open a link, move
datagrams, report state. It holds no protocol knowledge at all.

### The layering

```
  Chat · Games · Share · Sync · Presence      features, transport-unaware
────────────────────────────────────────────
  PeerSession                                 owns keys + reliability, borrows a link
    ├── Reliability   seq / ack / retry / dedup / ordering
    ├── SecureSession AEAD, nonce discipline, replay window
    └── Fragmentation MTU-aware split and reassembly
────────────────────────────────────────────
  TransportManager                            capability detection, negotiation, upgrade
    ├── BLETransport            iOS + Android, the universal floor
    ├── LocalNetworkTransport   Bonjour / NSD + TCP
    ├── PeerToPeerWiFiTransport iOS ↔ iOS (Network.framework)
    ├── WiFiDirectTransport     Android ↔ Android
    ├── HotspotHandoffTransport Android LOHS ↔ iOS NEHotspotConfiguration
    └── MockTransport           the simulator that makes all of this testable
```

**The property that makes the product feel magic**: `PeerSession` owns the
session keys and the reliability state, and merely *borrows* a `Link`. Swapping a
Bluetooth link for a Wi-Fi one — or reconnecting after the phone was in a pocket
— replaces the borrowed part. The conversation, the queued messages and the game
in progress all survive. There is no re-handshake and nothing to re-establish.
This is covered by tests that drop the link mid-conversation and assert that not
one message is lost.

---

## 3. Security

No invented cryptography. Standard primitives from the audited `@noble` suite,
composed into a standard protocol.

- **Identity**: one long-term Ed25519 key pair per install. Its public key *is*
  the durable identity; the public peer id is a truncated hash of it. Nothing is
  derived from hardware — no MAC address, no IDFV, no ANDROID_ID, no phone
  number.
- **Handshake**: SIGMA-I. An ephemeral X25519 exchange establishes a shared
  secret; each side then proves its identity by signing the handshake transcript
  *inside* the resulting encrypted channel. Gives mutual authentication, forward
  secrecy, identity hiding from passive observers, and replay resistance.
- **First meeting**: an active attacker relaying the exchange necessarily
  produces two different transcripts, so the six-digit code derived from the
  transcript differs on the two phones. Users compare it, exactly as ZRTP and
  Matrix do. A scanned QR code skips this by carrying the identity key
  out-of-band.
- **Every meeting after that**: the stored identity key must match exactly. A
  repeat meeting is immune to an active attacker with **zero** user
  interaction — which is the whole point of a friend-first product.
- **Traffic**: ChaCha20-Poly1305 with per-direction keys, a per-direction nonce
  prefix and a 64-bit counter, so a nonce is never reused and a packet cannot be
  reflected at its sender. A 1024-entry sliding window rejects replays.
- **Every byte from a peer is untrusted.** Bounded decoders, validated packets,
  rejected malformed input, and a `Handshake` class from which the only
  exception that can escape is `HandshakeError`.

Details in [`docs/SECURITY.md`](docs/SECURITY.md).

---

## 4. Honest limits

These are written down so the product never promises them.

| Limit | Consequence | What we do |
|---|---|---|
| Backgrounded iOS advertiser is invisible to Android | iPhone↔Android needs AirLink open on the iPhone | Say so, plainly, in the connection sheet |
| iOS background BLE: service-UUID filter mandatory, throttled, no duplicates, ~10s per wake | Background reconnection is slow and best-effort | Reconnect promptly on foreground; never claim silent operation |
| No high-bandwidth transport survives iOS backgrounding | A file transfer pauses when the app leaves the foreground | Transfers are resumable by design, and the UI says "paused" |
| Wi-Fi Aware iPhone↔Android is broken on real handsets | Not a usable transport in 2026 | Capability adapter, documented, off by default |
| BLE gives ~5–40 KB/s | A 4 MB photo takes 2–10 minutes over Bluetooth alone | Show a real ETA; offer the Wi-Fi upgrade path |
| `react-native-video` progress callbacks jitter | Sub-100ms playback sync cannot be polled reliably | Anchor-based sync: host publishes (position, clock anchor, rate); each device computes its own target and corrects by nudging playback rate |
| Android needs a foreground service (and a permanent notification) for background BLE | Visible notification while connected in background | Only started when a session is live |

---

## 5. Phases and status

| # | Phase | Status |
|---|---|---|
| 1 | Monorepo, protocol, crypto, transport contract, MockTransport, database | **done** |
| 2 | Reliability, connection state machine, clock sync, PeerSession | **done** |
| 3 | Game engine, runtimes, conformance suite, reference game | **done** |
| 4 | The 12 games | in progress |
| 5 | Native BLE (iOS + Android), TurboModule bridge | in progress |
| 6 | Local network + peer-to-peer Wi-Fi transports, negotiation and upgrade | in progress |
| 7 | Chat, file transfer, sync protocols on top of `PeerSession` | in progress |
| 8 | React Native app: onboarding, home, chat, play, share, sync, profile, developer mode | in progress |
| 9 | Integration tests, failure-scenario suite, offline acceptance harness | in progress |
| 10 | Store readiness: icons, launch screen, privacy strings, release config | pending |

### Android build status

There is **no Android SDK and no Android Studio on this machine**, so Android
code in this repository is written against the verified API surface but has not
been compiled here. Everything else — the entire `packages/` tree and the iOS
build — is compiled and tested. `docs/ANDROID.md` lists exactly what to install
and the one command that will verify the Android side.

---

## 6. The acceptance test

The project is done when, with **both phones in airplane mode and Bluetooth on**,
and **no server of any kind reachable**:

```
iPhone and Android both open AirLink
  → they find each other
  → they connect and authenticate
  → they chat
  → they send a photo
  → they play a multiplayer game
  → one walks away; the session reconnects when they return
```

`scripts/` contains a harness that runs the whole of this against simulated
radios, plus the manual checklist for two physical devices in
[`docs/TESTING.md`](docs/TESTING.md).
