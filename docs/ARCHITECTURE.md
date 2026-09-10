# Architecture

## The shape of it

```
apps/mobile                React Native 0.87 + TypeScript. Screens, navigation, design system.

packages/core              Pure TypeScript. No React, no platform APIs, no dependencies but @noble.
  ├── protocol/            CBOR codec, frame + envelope format, fragmentation, capabilities
  ├── crypto/              identity, SIGMA-I handshake, AEAD session, replay window, SAS
  ├── transport/           the Transport/Link contract, negotiation, upgrade, MockTransport
  ├── session/             reliability, connection state machine, clock sync, PeerSession
  ├── messaging/           the chat protocol
  ├── files/               chunked, resumable, verified transfer
  ├── sync/                watch-together: content matching, anchors, drift correction
  ├── mesh/                groups, relay routing, host migration readiness
  ├── pairing/             QR and six-digit pairing, trust store, rotating tokens
  └── presence/            the nearby registry the Home screen renders

packages/games             Deterministic game reducers, turn-based and realtime runtimes, 12 games
packages/db                SQLite schema, migrations, typed repositories
packages/config            Branding: name, colours, strings, bundle ids — one place

native/airlink-transport   The RN library package holding the radios
  ├── src/                 the TurboModule spec — the JS ↔ native contract
  ├── ios/                 Swift: CoreBluetooth, Network.framework, hotspot join
  └── android/             Kotlin: BLE, NSD + TCP, Wi-Fi Direct, local-only hotspot

docs/ · scripts/           documentation and the build + harness tooling
```

---

## Why the core is pure TypeScript

Every hard part of this product is logic, not radio: the handshake, packet
ordering, retransmission, fragment reassembly, deduplication, game determinism,
drift correction. Keeping all of it in dependency-free TypeScript buys three
things:

1. **It runs identically on Hermes and on Node.** No native module, no
   conditional compilation, no "works on my platform".
2. **It is testable without a phone.** A simulated network with a virtual clock
   and seeded randomness runs two, three or ten peers deterministically, in
   milliseconds. A failing test reproduces exactly, every time. This is why
   there are ~1000 tests rather than a manual checklist.
3. **Adding a radio is one file.** It implements `Transport`; no feature
   changes.

The native layer is deliberately *dumb*. It discovers endpoints, opens links,
moves opaque datagrams and reports state. It holds no protocol knowledge
whatsoever — it never parses a payload, never adds a header, never decides when
to reconnect.

---

## The layering

```
  Chat · Games · Share · Sync · Presence          features, transport-unaware
─────────────────────────────────────────────
  PeerSession                                     owns keys + reliability, BORROWS a link
    ├── Reliability     seq / ack / retry / dedup / ordering
    ├── SecureSession   AEAD, nonce discipline, replay window
    └── Fragmentation   MTU-aware split and reassembly
─────────────────────────────────────────────
  TransportManager                                capability detection, negotiation, upgrade
    ├── BLETransport             iOS + Android, the universal floor
    ├── LocalNetworkTransport    Bonjour / NSD + TCP
    ├── PeerToPeerWiFiTransport  iOS ↔ iOS (Network.framework)
    ├── WiFiDirectTransport      Android ↔ Android
    ├── HotspotHandoffTransport  Android hosts, iPhone joins
    └── MockTransport            the simulator that makes all of this testable
```

### The one idea that makes the product work

`PeerSession` **owns** the session keys and the reliability state, and merely
**borrows** a `Link`.

Swapping a Bluetooth link for a Wi-Fi one — or reconnecting after the phone was
in a pocket — replaces the borrowed part. The conversation, the queued messages
and the game in progress all survive. There is no re-handshake and nothing to
re-establish.

That is what makes a transport upgrade invisible, and it is covered by a test
that drops the link mid-conversation, reconnects over a *different* transport,
and asserts that not one message was lost.

---

## Data flow, end to end

Sending "Yes 😭" to Maria:

```
ChatProtocol.send()
  → CBOR-encode the payload
  → ReliableChannel assigns a sequence number, keeps a copy for retransmission
  → Envelope: channel RELIABLE, flags, seq, piggybacked ack, type MESSAGE, timestamp
  → SecureSession seals it: ChaCha20-Poly1305, per-direction key, counter nonce
  → SECURE frame: version ‖ type ‖ sessionId ‖ counter ‖ ciphertext‖tag
  → if larger than the link MTU, split into FRAGMENTs
  → Link.send()  →  base64  →  TurboModule  →  Swift/Kotlin  →  the radio
```

and back the other way, in reverse, with every step treating its input as
hostile.

---

## State management in the app

- **zustand** for app state. Decisive reason: the store is a plain closure, so
  BLE callbacks, database hooks and Reanimated worklets — all of which live
  outside the React tree — can write to it directly. Selector subscriptions keep
  a 60 fps game screen from re-rendering on unrelated peer churn.
- **SQLite** (op-sqlite) for anything that must survive a restart. The same
  schema and repositories run on `node:sqlite` under test, so every query is
  covered against a real engine.
- **Skia** for realtime game rendering: physics runs in a worklet on the UI
  thread and repaints without a React render, which matters in an app whose JS
  thread is also doing networking.
- **Drawn icons, never characters.** Every mark in the interface is an SVG path
  (`ui/Icon.tsx`, and one per game in `screens/play/gameArt.tsx`). This started
  as a bug fix and became a rule: the app originally used emoji and geometric
  symbols as icons, and on the device it was built against every one of them
  drew as an empty box, silently, with nothing in any log. A character is only
  as reliable as the font behind it, and a missing glyph cannot be detected at
  runtime — so a text icon is a bet on the host's font stack that can never be
  checked. `IconName` is derived from the array of names rather than the other
  way round, which is what makes "every icon draws something" a test that cannot
  quietly cover less than the whole set.

---

## Testing strategy

| Layer | How it is tested |
|---|---|
| Codec, crypto, reliability, games | Unit tests, plus fuzzing on every decoder |
| Whole protocol, two+ peers | Integration tests over `MockTransport` with a virtual clock |
| Degraded links | The same tests under 15% loss, 20% reordering, 10% duplication |
| Database | Against real SQLite via `node:sqlite` |
| App screens | Mounted for real under Node, driven by text and a11y label |
| iOS native | Compiled by `scripts/build-ios.sh`; radios need hardware |
| Android native | **Not yet compiled** — see [ANDROID.md](ANDROID.md) |

See [TESTING.md](TESTING.md).

---

## Principles, and what they cost

**Offline-first is not a mode, it is the design.** There is no server to fall
back to, so there is no "degraded" path to under-test. The cost is that
everything — identity, trust, ordering, conflict resolution — has to be solved
locally.

**Every peer is hostile.** Bounded decoders, validated packets, actions
re-validated on both devices. The cost is verbosity in the decode paths; the
benefit is that a fuzz test cannot crash the stack.

**No fake functionality.** A game appears in the Play tab only because it is in
the registry, and the registry holds real definitions — a test asserts every
entry has a callable reducer and a round-trippable state. A capability is
advertised only if the device really has it.

**Say what is not possible.** A backgrounded iPhone is invisible to Android;
Wi-Fi Aware does not interoperate; Bluetooth moves a photo in minutes, not
seconds. All three are in the UI and the docs rather than hidden behind a
spinner.
