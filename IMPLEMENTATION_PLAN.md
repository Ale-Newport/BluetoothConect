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
| 3 | Game engine, runtimes, conformance suite | **done** |
| 4 | The games | **done** — 28 games, 837 tests |
| 5 | Native BLE, iOS and Android | **done** — iOS compiles; Android unbuilt, see below |
| 6 | Local network, peer-to-peer Wi-Fi, Wi-Fi Direct, hotspot handoff | **done** |
| 7 | Transport negotiation, upgrade and downgrade | **done** |
| 8 | Chat, file transfer, watch-together, groups, pairing protocols | **done** |
| 9 | Design system, navigation, store, client, native adapter | **done** |
| 10 | The app screens | **done** — 51 files, no placeholders, mounted by tests |
| 11 | Integration tests, network harness, offline acceptance test | **done** — 1150 tests |
| 12 | Store readiness: identifiers, versions, placeholder artwork, checklists | **done** |

### Verified by running it

The app was built, installed and driven on an iPhone 17 Pro simulator: the whole
onboarding flow, all five tabs, the profile and Developer Mode. Doing so found
**fifteen defects that no test caught**, seven of them before a single screen
rendered — see the commit history. Three were protocol bugs found by the network harness rather than by
the unit tests, because each only appears at scale or under packet loss:

- outbound frames interleaved, so nothing reassembled over a Bluetooth MTU;
- the handshake had no retransmission, so connecting failed under real loss;
- clock sync stalled for ever on one lost probe.

The others were build and integration: ML Kit forcing an x86_64 build that
cannot install on an Apple Silicon simulator, Metro not resolving `.ts` sibling
imports, a missing Babel plugin leaving a blank screen, op-sqlite returning
`ArrayBuffer` where the tests returned `Uint8Array`, the app discovering itself
over Bonjour, a missing safe-area inset, and an identity surviving a database
wipe with no profile to go with it.

And then, on the screens themselves:

- **Every icon in the app was a missing glyph.** The interface used two dozen
  emoji and a handful of geometric symbols as icons. Screenshots showed each of
  them drawing as an empty box with a question mark, silently, with nothing in
  any log — a character is only as reliable as the font behind it, and there is
  no way to feature-detect a missing glyph at runtime. They are paths now
  (`ui/Icon.tsx`, one mark per game in `screens/play/gameArt.tsx`), which is
  also why the avatar is a colour rather than an emoji.
- **Android was never asked for its permissions.** The native module has a
  `requestPermissions` that raises the dialog and nothing called it, so an
  Android first run granted nothing and dead-ended on a home screen offering
  Settings for a permission the system had never mentioned. Found by reading the
  start path while writing a test for it, not by running — this machine has no
  Android SDK.
- **The radio state the app started in never reached the interface**, because
  `availabilityChanged` fires on a change. A phone whose Bluetooth was on the
  whole time would have been told to go and turn it on.
- **Developer Mode said "Unavailable  no"** for an unavailable transport, which
  states the opposite of the truth, on the one screen whose whole job is to be
  read literally.

And then, once two simulators could be made into two real peers, the thing the
whole product is for:

- **A paired friend could never be connected to twice.** Discovery, the
  handshake, the six digits and trust all worked; the second connection always
  failed. The cause was a mismatch nobody had written down: `peerDiscovered` is
  a heartbeat that `NearbyRegistry` decays without, and the Bonjour transport
  only emitted it on *change*. An unpaired device's advertisement token is
  random and changes every four seconds, so the TXT record kept changing and
  presence worked by accident. Pairing made the token stable for five minutes,
  the changes stopped, and the friend vanished from the list fifteen seconds
  later. The contract is now stated on the type, in TRANSPORTS.md, and enforced
  by `MockTransport` actually implementing it — which is what makes the
  regression test possible at all.

`apps/mobile` now has a test suite of its own — 52 tests that mount the real
tree, walk a first run to Home, open all five tabs and push a peer in through
the native module's own event. Both of the two defects above that are testable
without hardware have a test that fails without the fix. Its absence until now
was itself a defect: the package had one test, the React Native template's
smoke test, and it had never run, because the preset does not transform the ESM
half these libraries ship.

That is the argument for the acceptance test, the harness and a running device
being part of the deliverable rather than an afterthought.

### Deferred, and why

**Trip Mode** (grouping a journey's chats, games, photos and notes) has its
database tables and repository, but no feature module or screen. It is the one
part of the brief explicitly described as optional, and the brief is equally
explicit that five reliable features beat twenty mediocre ones. The core —
discover, connect, chat, play, share, sync — comes first. The schema is in place
so adding it later is a feature module and a screen, not a migration.

### Stabilisation pass

A round of testing on two physical phones found six defects that no amount of
reading had — a device listing itself, "Unknown Device" rows, a connected friend
reappearing with a Connect button, an invitation that never arrived, flaky
connection, and game boards that scrolled out from under a finger.
[`STABILITY_AUDIT.md`](STABILITY_AUDIT.md) has the root causes with citations.
The shape of the answer:

- **Peer identity.** A persistent `installationId` (already present as
  `deviceId`) and a per-run `discoveryId` broadcast on every transport. One
  `isSelf`, used by every radio, replacing three self-checks that could drift.
- **`NearbyRegistry` with resolution states.** One row per physical device,
  merged on identity then discovery id then endpoint then token. A sighting with
  no identity is held for a few seconds and then discarded rather than shown.
- **One handle namespace.** A session is re-keyed onto its peer id the moment
  the handshake produces one, duplicates for one person are collapsed, and a
  simultaneous dial is decided by comparing installation ids — before either
  user is shown a six-digit code.
- **A reconnect driver.** `RECONNECTING` had no driver and no timeout, so a
  session that lost its radio waited for a link nobody was going to supply.
- **Reliable invitations.** An `inviteId`, a `GAME_INVITE_ACK` sent on every
  receipt, bounded exponential retry, and a global `GameInviteManager` mounted
  beside the navigator rather than lazily by the Play tab — which is why an
  invitation used to be delivered to no listener at all.
- **`GameShell`.** A fixed, non-scrolling scene with the back gesture disabled
  and an explicit Exit, and renderers given a height budget as well as a width.
- **State versioning.** Actions carry the version they expect; a snapshot now
  carries the sequence vector too, so a missed move repairs rather than jamming
  the session for the rest of the game.
- **Sixteen more games**, every one of them turn-, tap- or choice-based, with
  metadata the catalogue uses to lead with what the current link can carry.

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

And, added after the stabilisation pass, the half of it that is about what must
NOT happen:

```
neither phone ever lists itself
no row says "Unknown Device"
each peer appears exactly once, on however many radios it is visible
a connected friend never shows a Connect button again
A picks a game -> B sees the invitation, on whatever screen B is looking at
A move made on either phone appears on the other
rematch works, exit works, and the AirLink session survives both
```

`scripts/` contains a harness that runs the whole of this against simulated
radios, plus the manual checklist for two physical devices in
[`docs/TESTING.md`](docs/TESTING.md).
