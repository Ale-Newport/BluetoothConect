<div align="center">

# AirLink

**Together, even when you're offline.**

Two phones. No signal, no Wi-Fi, no server.
Chat, play, share files and watch a film in sync — over Bluetooth and local Wi-Fi.

</div>

---

## What it is

You and a friend get on a plane. You both switch to airplane mode. You open
AirLink. The phones find each other, connect, and you can talk, send photos,
play chess, and watch the same film in step for the whole flight.

Nothing touches the internet. There is no account, no server, and no cloud —
not as a fallback, not for sign-in, not for anything.

| | |
|---|---|
| 💬 **Chat** | Text, emoji, replies, reactions, receipts, typing — persisted locally |
| 🎮 **Play** | 28 real multiplayer games, shelved by what they are and by what the link can carry |
| 📤 **Share** | Chunked, resumable, verified file transfer with a real ETA |
| 🎬 **Sync** | Watch the same local video in step, to within tens of milliseconds |
| 🔒 **Private** | End-to-end encrypted, no account, nothing leaves the device |
| ✈️ **Offline** | Designed for airplane mode, not merely tolerant of it |

---

## The honest part

Two phones with no network have exactly one universal way to talk: **Bluetooth
Low Energy**. Everything else is platform-specific or needs infrastructure.

| Scenario | Transport | Speed |
|---|---|---|
| iPhone ↔ iPhone, no network | Apple peer-to-peer Wi-Fi (AWDL) | tens of MB/s |
| Android ↔ Android, no network | Wi-Fi Direct | several MB/s |
| **iPhone ↔ Android, no network** | **BLE, and nothing else** | **~5–40 KB/s** |
| Anything, sharing a local Wi-Fi | Bonjour / NSD + TCP | MB/s |
| iPhone ↔ Android, bulk, no network | Android hotspot + iOS join, one tap | MB/s |

So the whole product is built to work on the slow path, and to upgrade
invisibly when something faster appears. A photo over Bluetooth takes minutes
and the app says so. Two more things it says rather than hides: a **backgrounded
iPhone is invisible to Android** (Apple moves the service UUID into an overflow
area only Apple devices can scan), and **Wi-Fi Aware does not work between
iPhone and Android** in 2026, whatever the spec sheets suggest.

Details and sources: [`docs/TRANSPORTS.md`](docs/TRANSPORTS.md).

---

## Getting started

```bash
# Requires Node 22+, pnpm, Xcode 26+ for iOS, JDK 17 + Android SDK for Android
pnpm install

pnpm test            # ~1500 tests, no phone required
pnpm typecheck
```

### iOS

```bash
cd apps/mobile/ios && pod install && cd ../../..
./scripts/build-ios.sh                       # must print ** BUILD SUCCEEDED **
pnpm --filter @airlink/mobile ios
```

### Android

```bash
export JAVA_HOME=$(/usr/libexec/java_home -v 17)
export ANDROID_HOME="$HOME/Library/Android/sdk"
pnpm --filter @airlink/mobile android
```

> **Android build status.** The machine this was built on has no Android SDK, so
> the Kotlin has been written against the verified API surface and reviewed, but
> **never compiled**. [`docs/ANDROID.md`](docs/ANDROID.md) has the exact setup
> and the one command that verifies it.

### On your own iPhone

```bash
./scripts/run-device.sh      # Release build, installed and launched
```

A **free** Apple ID is enough — AirLink needs no entitlements at all — and the
build is standalone, so the phone does not stay tethered to the Mac. The profile
expires after seven days on a free account. See
[docs/IOS.md §7](docs/IOS.md) for the whole story, including what to do when
your certificate has expired.

The simulator has no Bluetooth radio, so BLE needs two physical devices. It does
have the local network, though: a simulator advertises and browses `_airlink._tcp`
like any peer, so **one iPhone plus one simulator on the same Wi-Fi** covers
pairing, chat, the games, file transfer and Watch Together. Airplane mode and
the BLE paths are what genuinely need a second phone.

---

## How it is built

```
apps/mobile          React Native 0.87 + TypeScript. Screens and design system.
packages/core        Pure TypeScript: protocol, crypto, transports, sessions, features
packages/games       12 deterministic games + the engine and conformance suite
packages/db          SQLite schema, migrations, typed repositories
packages/config      Branding, theme and strings — one place to rename the app
native/              Swift (CoreBluetooth, Network.framework) and Kotlin (BLE, NSD, Wi-Fi Direct)
docs/                Architecture, protocol, security, transports, platforms, testing
```

**Everything hard is in pure TypeScript.** The handshake, packet ordering,
retransmission, fragment reassembly, game determinism, drift correction — none
of it touches a radio, so all of it runs in Node against a simulated network
with a virtual clock and seeded randomness. That is why there are a thousand
tests instead of a manual checklist, and why a failing test reproduces exactly.

The native layer is deliberately dumb: it discovers endpoints, opens links, and
moves opaque datagrams. It holds no protocol knowledge at all.

### The idea that makes it feel effortless

`PeerSession` **owns** the encryption keys and the reliability state, and merely
**borrows** a link. Swapping Bluetooth for Wi-Fi — or reconnecting after the
phone spent a minute in a pocket — replaces the borrowed part. The conversation,
the queued messages and the game in progress all survive, with no re-handshake.

A test drops the link mid-conversation, reconnects over a *different* transport,
and asserts that not one message was lost.

---

## Security

No invented cryptography: standard primitives from the audited `@noble` suite,
composed into a **SIGMA-I** authenticated key exchange.

- Long-term **Ed25519** identity, generated on device. Nothing derived from
  hardware — no MAC address, no advertising id, no phone number.
- A **per-run discovery id** in every advertisement, so a device recognises its
  own broadcast exactly rather than guessing from a rotating token, and one
  phone seen over two radios is known to be one phone. Fresh on every launch,
  so it links nothing across time.
- **X25519** ephemeral exchange, then each side signs the handshake transcript
  inside the resulting encrypted channel: mutual authentication, forward secrecy
  and identity hiding.
- **ChaCha20-Poly1305** traffic protection with per-direction keys and a sliding
  replay window (RFC 6479).
- **First meeting** needs a scanned QR code or both users confirming the same
  six digits — a man in the middle necessarily produces two different
  transcripts, so the codes differ. There is a test that runs the attack.
- **Every meeting afterwards** is silent and immune to an active attacker,
  because the stored identity key must match exactly.

[`docs/SECURITY.md`](docs/SECURITY.md) — including the limitations, stated
rather than hidden.

---

## Games

**Strategy** Chess (full rules — castling, en passant, promotion, fifty-move,
repetition, insufficient material) · Connect Four · Battleship · Gomoku ·
Reversi · Dots & Boxes
**Quick** Reaction · Tic-Tac-Toe · Rock Paper Scissors · Tap Race · Quick Math · Darts
**Words** Word Duel · Word Chain
**Trivia** General Trivia · Flag Duel · Capital Duel · Geography Duel
**Puzzles** Code Breaker · Memory Duel · Sliding Puzzle Race
**Party** Draw & Guess
**Just the two of you** Would You Rather · Most Likely To · This or That
**Real-time** Pong · Air Hockey · 8-Ball

A game is a **deterministic reducer**: same start, same actions, same result on
both devices. Turn-based games send only moves; realtime games run an
authoritative host with interpolated snapshots. Every one of them passes a
shared conformance suite that checks determinism, purity, wire round-tripping,
resistance to a cheating peer, and termination — across dozens of seeds.

**The catalogue knows what the link can carry.** A game of chess does not notice
forty milliseconds of Bluetooth jitter; a game of Pong is ruined by it. So each
game declares its latency sensitivity, and on a slow link the ones that will
feel good come first while the ones that will not are marked *Best over Wi-Fi* —
reordered and labelled, never hidden.

Battleship is worth a look: since both devices run the same reducer, a fleet
cannot simply be kept in shared state, so it uses commit-reveal with cheat
detection at the end. Rock Paper Scissors uses the same idea for the same
reason. [`docs/GAMES.md`](docs/GAMES.md).

---

## Documentation

| | |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the pieces fit, and why |
| [PROTOCOL.md](docs/PROTOCOL.md) | The wire format, byte by byte |
| [SECURITY.md](docs/SECURITY.md) | Threat model, handshake, limitations |
| [TRANSPORTS.md](docs/TRANSPORTS.md) | What each radio can really do |
| [IOS.md](docs/IOS.md) · [ANDROID.md](docs/ANDROID.md) | Building, and each platform's restrictions |
| [GAMES.md](docs/GAMES.md) | Writing a game against the contract |
| [FILE_TRANSFER.md](docs/FILE_TRANSFER.md) · [SYNC.md](docs/SYNC.md) | The two hardest features |
| [TESTING.md](docs/TESTING.md) | How to test a P2P app without two phones |
| [APP_STORE.md](docs/APP_STORE.md) | Shipping it: submission, export compliance, and the two guidelines most likely to reject a P2P app |
| [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) | The plan, and what is done |

---

## The acceptance test

With **both phones in airplane mode**, Bluetooth on, and **no server reachable**:

```
iPhone and Android both open AirLink
  → they find each other
  → they connect and authenticate
  → they chat
  → they send a photo
  → they play a multiplayer game
  → one walks away; the session reconnects when they return
```

That is the product.
