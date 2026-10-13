# Testing

The hard problem in a peer-to-peer app is that the interesting behaviour needs
two devices, a radio, and conditions you cannot summon on demand: a lost packet,
a peer walking out of range, a transport upgrading mid-transfer.

AirLink's answer is that **almost none of the interesting behaviour is in the
radio**. The handshake, packet ordering, retransmission, fragment reassembly,
deduplication, game determinism and drift correction all live in pure
TypeScript, so they are tested against a simulated network — deterministically,
with N peers, in milliseconds.

```bash
pnpm test                                  # everything
pnpm --filter @airlink/core test           # protocol, crypto, transports, features
pnpm --filter @airlink/games test          # 28 games + the conformance suite
pnpm --filter @airlink/db test             # against real SQLite
pnpm --filter @airlink/mobile test         # the screens, mounted for real
pnpm typecheck
```

---

## 1. The two tools that make it possible

### `MockTransport`

An in-process transport that reproduces every condition a radio inflicts:

```ts
const network = new MockNetwork(clock, seed);
network.setConditions({
  latencyMs: 120, jitterMs: 180,
  reliableLossRate: 0.15, realtimeLossRate: 0.25,
  reorderRate: 0.2, duplicateRate: 0.1,
  bandwidthBytesPerSecond: 8_000, maxDatagramSize: 160,
});

const a = network.createTransport('phone-a');
const b = network.createTransport('phone-b');

network.partition('phone-a', 'phone-b');   // they walk out of range
network.heal('phone-a', 'phone-b');        // and come back
a.setAvailable(false);                     // Bluetooth switched off
```

Presets: `PERFECT_CONDITIONS`, `BLE_LIKE_CONDITIONS` (30 ms, 180-byte MTU,
40 KB/s), `WIFI_LIKE_CONDITIONS`, `HOSTILE_CONDITIONS`.

Its randomness is seeded, so a failing test reproduces **exactly**.

### `VirtualClock`

Nothing in `packages/core` may call `Date.now()`, `setTimeout` or `setInterval`.
Every timeout, retry and scheduler goes through an injected `Clock`. That single
rule means a test can advance thirty seconds instantly:

```ts
const clock = new VirtualClock();
clock.advance(30_000);          // every due timer fires, in order
await clock.advanceAsync(5000); // and flushes microtasks between ticks
expect(clock.pendingTimers).toBe(0);   // asserts clean teardown
```

A two-minute retransmission scenario runs in under a millisecond.

---

## 2. What is covered

### Unit

Codec round-trips, varint bounds, CBOR determinism, replay windows, RTT
estimation, selective acknowledgement, drift correction, dartboard geometry,
chess legality, the sliding window.

### Fuzzing

Every decoder that touches peer input is fuzzed. The CBOR decoder takes 3000
random byte strings per run; the handshake takes 500. The assertion is not that
they parse — it is that **nothing but a `DecodeError` or a `HandshakeError` ever
escapes**.

### Integration — two real peers

The valuable ones. Two `PeerSession`s over `MockNetwork`, running the real
handshake and the real protocol:

- previously paired peers authenticate with no user interaction
- a first meeting requires six digits, and both sides show the same ones
- a man in the middle produces two different codes
- 40 messages arrive in order under 15% loss, 20% reordering, 10% duplication
- a 20 KB payload fragments and reassembles over a 180-byte MTU
- 50 injected garbage packets change nothing; the next real message arrives
- the link dies mid-conversation → `RECONNECTING`, not `FAILED`, keys retained
- messages queued while disconnected are delivered after reconnect, in order
- a session migrates to a **different transport** without losing a message and
  without re-authenticating

### Games

Every game passes a shared conformance suite across dozens of seeds:

| Check | What it proves |
|---|---|
| Determinism | Same seed + same actions → byte-identical state |
| Purity | `applyAction` and `tick` do not mutate their input |
| Round-trip | State and actions survive the wire unchanged |
| Hostile input | `decodeAction` throws on garbage; `applyRemote` never throws |
| Authorisation | An action attributed to a non-player is refused |
| Convergence | Two independent sessions agree move for move |
| Termination | Random play reaches a terminal status |

### Database

Real SQLite via `node:sqlite`: migrations, idempotency, foreign keys, CHECK
constraints, transaction rollback, savepoints, and the rule that delivery status
never moves backwards.

### The screens

Everything above tests logic that never opens a socket, which leaves one class
of defect untouched: the app failing before any logic runs. Two real ones got
through — a blank white screen caused by a missing Babel plugin, where every
screen module threw at import time; and a crash on first launch caused by the
SQLite driver returning BLOBs in a shape the repositories did not expect. A
thousand passing logic tests noticed neither, because none of them imported a
screen.

So `apps/mobile` mounts the real tree under Node with React Native Testing
Library and drives it the way a person meets it, by visible text and
accessibility label:

- a first run reaches onboarding rather than a failure screen
- a name and a colour is the whole of onboarding, and it ends on Home
- all five tabs open, each asserted by a sentence only that screen renders
- a peer pushed in as a native `onPeerDiscovered` event reaches Home, so the
  chain native → transport → registry → client → store → screen runs end to end
- `start()` asks for the permissions the radios need, which is the assertion
  that would have caught Android never being prompted at all
- the radio state the app *starts* in reaches the interface, not just changes
- nothing on the way in uses the vocabulary of failure - no "error", no "no
  internet", no "unavailable" - because the radios are mocked **unavailable**,
  which is the case that would tempt it
- every icon name draws actual paths, and every game in the catalogue has a mark

The doubles live in `apps/mobile/jest.setup.js` and are deliberately faithful
rather than convenient. Two of them had to be corrected during the writing, and
both corrections were real properties of the thing being stood in for: op-sqlite
hands BLOBs over as `ArrayBuffer` where `node:sqlite` wants `Uint8Array`, and
the TurboModule's events are codegen `EventEmitter` properties subscribed as
`onPeerDiscovered(callback)`, not plain callbacks. A double that shrugged at
either would have tested nothing. The keychain and the database remember what
they are given, per test file, because a keychain that forgets is not a
keychain.

What they do **not** do is simulate a radio. That is `MockTransport`'s job, one
layer down, and two phones' job below that.

---

## 3. Failure scenarios

Explicitly exercised, because an offline app that crashes is worse than one that
says "not connected":

| Scenario | Where |
|---|---|
| Bluetooth switched off mid-session | `MockTransport.setAvailable(false)` |
| Peer walks out of range | `network.partition()` |
| Peer returns | `network.heal()` |
| Packet corruption | injected garbage frames |
| Duplicate packets | `duplicateRate` |
| Out-of-order delivery | `reorderRate` |
| Wrong encryption key | trust-store mismatch test |
| Disconnect mid-transfer | partition during a file transfer |
| Disconnect mid-game | partition during a game session |
| Transport change | `migrateToLink` while messages are in flight |
| Malformed packets | fuzz tests |
| A cheating peer | Battleship commit-reveal, forged game actions |

---

## 4. What the simulation cannot tell you

Honestly:

- **Real MTU negotiation.** iOS picks a number and does not let you ask.
- **Real throughput.** Depends on connection interval, PHY and interference.
- **Discovery latency**, especially with a backgrounded app.
- **Whether the OS suspends you**, and when.
- **Genuine cross-platform interop.** iOS CoreBluetooth talking to an Android
  GATT server is the one thing only two phones can prove.

So the mock proves correctness; hardware proves feasibility.

### Bluetooth cannot be tested against a simulator, and one phone is enough

An iPhone with Wi-Fi off cannot connect to an iOS Simulator, and that is not a
defect: the simulator has no Bluetooth radio at all (`CBCentralManager` reports
`.unsupported`, which is why the app shows "No Bluetooth on this device"), so it
speaks only the local network, and an iPhone on Bluetooth alone has no route to
it. Testing the Bluetooth path takes two devices that both have a radio.

If you have one iPhone, the Mac is the second device:

```bash
./scripts/ble-mac-peer.sh --seconds 300
```

It builds a small app that advertises the AirLink GATT service from the Mac's
own radio, answers identity reads, scans for the iPhone, and prints every move
the iPhone makes. Put the iPhone in airplane mode with only Bluetooth on, open
AirLink, and watch for:

| In the log | It means |
|---|---|
| `SAW AN AIRLINK PEER` | the iPhone advertises, with no Wi-Fi |
| `THE IPHONE'S IDENTITY RECORD decodes` | the Mac can read who the iPhone is |
| `THE IPHONE READ OUR IDENTITY RECORD` | the iPhone's identity probe works |
| a row named `Mac-test` under *Other devices* | the iPhone listed a peer it only knows over Bluetooth |
| `THE IPHONE SUBSCRIBED` then `iPhone WROTE to RX` | tapping Connect opened a link and began a handshake |
| `notification from the iPhone` while nothing is paired | **a bug**: the iPhone is pushing some other session's encrypted frames (counters climbing, retries spacing out) at a device it owes no session. This is the routing fault `IncomingLinkRouter` fixes; on a fixed build the log shows no such lines |

**That is PROBE mode, and what it cannot do:** it speaks the layer below the
protocol, so it never completes a pairing and tapping Connect ends in "Couldn't
connect" on the iPhone. It proves the part that decides whether two phones can
find each other and open a link. It does not prove messages cross it.

### TALK mode: the Mac as a real AirLink phone

```bash
./scripts/ble-mac-peer.sh --talk
```

The radio stays in the Swift app; everything above it is `packages/core` running
in Node - the encrypted handshake, six-digit pairing, chat with delivery
receipts, file transfer, and the same `IncomingLinkRouter` the phone uses. The
iPhone can connect to it, pair (the Mac prints the six digits and confirms its
side by itself; compare them and tap "They match"), exchange messages in both
directions, and receive a file. It measures what has only ever been argued about:
how long a message takes to be delivered over real Bluetooth, and how fast a file
moves (`--file-kb N` sets its size; accept it in the iPhone's Share tab).

Everything printed also goes to `apps/mobile/ios/build/ble-mac-peer/talk.log`.

Before trusting a bench result, run the self-test, which plays the iPhone against
the bridge over the same wire with no radio at all - pairing, chat, a file, a
dropped link resumed, a stray subscriber - at any link size:

```bash
./node_modules/.bin/tsx scripts/ble-mac-peer/selftest.ts --mtu 185
```

If that passes and the bench does not, the fault is the radio or the phone, not
the Node half.

---

## 5. The manual checklist

Two physical devices, ideally one iPhone and one Android.

**Setup.** Install on both. Complete onboarding. Grant Bluetooth when asked.

**Discovery and pairing.**
1. Open on both. Each appears in the other's list within a few seconds.
2. **Neither phone lists itself.** Leave them both sitting there for two or
   three minutes and check again - the failure this catches used to take about
   that long to appear, because the self-filter forgot what it had advertised.
3. **No row says "New device" that stays that way**, and no row appears twice.
   One person, one row, however many radios they are visible on.
4. Tap Connect. Both show the same six digits. Confirm on both.
5. Both show Connected, and **the Connect button is gone on both**. Leave them
   for several minutes with the app in the foreground: no duplicate rows, no
   second connection request, no interruption.
6. Now tap Connect on both phones at the same instant, from a disconnected
   state. Exactly one connection results, and the six digits match.

**Now switch both phones to airplane mode, then switch Bluetooth back on.**
Everything below happens with no internet, no Wi-Fi network and no server.

7. Send a message each way. Check ticks progress to delivered, then read.
8. Send a photo. Check the progress and the ETA are honest, then that the file
   opens on the other side.

**Invitations.** This is the flow that failed most visibly, so it gets its own
block.

9. On phone B, go to **Home** - not Play - and stay there. On A, open Play and
   pick Chess. B must see the invitation **on the Home screen**, immediately.
   Repeat from Chat, from Share, and from You. It must appear on all of them.
10. On A, watch the wording: "Sending invitation…" must become "Invitation
    delivered" as soon as B's phone has it, and only then "Waiting for Maria".
    If it says "delivered" and B sees nothing, that is a bug worth reporting in
    those exact words.
11. B declines. A is told promptly, and does not sit out the full window.
12. A invites again and B accepts. Both open the same board.
13. Play Tic-Tac-Toe, then Chess, then Connect Four, then Battleship, then
    Trivia, then Reaction, then Draw & Guess, then Word Duel. Both boards agree
    at every move.
14. **Inside a game**, drag a finger up and down the middle of the board, and
    then in from the left edge. Neither may scroll the screen and neither may
    leave the game. Exit is the only way out, and it asks first.
15. Finish a game. Rematch works without reconnecting. "Choose another game"
    returns both phones to Play **still connected**.
16. Play Pong. Motion is smooth; the ball is in the same place on both screens.
    Over Bluetooth it is marked "Best over Wi-Fi" in the catalogue, and that is
    the honest answer.
17. Walk out of range for thirty seconds, **with a game open**. Both show
    Reconnecting and the board stays exactly where it was. Come back: the
    session resumes **on its own** - nobody taps anything - the board is still
    there, and any message sent while apart arrives.
18. Send a message while apart, then return — it must deliver, not fail.
19. Background one app, then foreground it. It reconnects.
20. Switch Bluetooth off on one device. The other shows a calm status, not an
    error, and reconnects when it returns. Switch Bluetooth back **on** and
    check that discovery resumes without restarting the app.
21. Both join the same Wi-Fi with no internet. The transport upgrades, and a
    photo that took minutes now takes seconds — with no interruption. The peer
    still appears exactly once.
22. Watch Together: pick the same video on both, start a session, confirm they
    stay in step, then seek and confirm both follow.
23. Force-quit one app and reopen it. History is intact and it reconnects.
24. Open **You → Developer Mode → DISCOVERY** on both. Every row there should
    be somebody real, resolved, and listed once. A row marked *held back* is the
    system working: it is a sighting that has not identified itself yet.

**Nothing in this list may ever crash the app.** A failure is a message, not a
stack trace.

### Two dev-only warnings you will see, and can ignore

Both come from dependencies, appear only in a debug build, and neither is
fixable here without patching someone else's package:

- `DrawerLayoutAndroid is deprecated` — emitted by
  `react-native-gesture-handler/src/index.ts`, which re-exports it. React
  Navigation requires gesture-handler, and nothing in AirLink uses a drawer.
- `Attempted to import the module ".../featureflags/ReactNativeFeatureFlags"
  which is not listed in the "exports"` — `@react-native/virtualized-lists`
  reaching into a private React Native path its own exports map does not list.

---

## 6. Adding a test

- Testing protocol behaviour? Use two `PeerSession`s over `MockNetwork`; copy
  `connectPair` from `packages/core/test/session.test.ts`.
- Testing a game? Add it to the conformance suite first, then write the
  rule-specific tests.
- Testing something time-dependent? Inject `VirtualClock`. If you find yourself
  reaching for a real timer, the code under test has a dependency it should not.
- Testing a decoder? Add its shape to the fuzz corpus.
