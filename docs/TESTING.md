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
pnpm --filter @airlink/games test          # 12 games + the conformance suite
pnpm --filter @airlink/db test             # against real SQLite
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

---

## 5. The manual checklist

Two physical devices, ideally one iPhone and one Android.

**Setup.** Install on both. Complete onboarding. Grant Bluetooth when asked.

**Discovery and pairing.**
1. Open on both. Each appears in the other's list within a few seconds.
2. Tap Connect. Both show the same six digits. Confirm on both.
3. Both show Connected.

**Now switch both phones to airplane mode, then switch Bluetooth back on.**
Everything below happens with no internet, no Wi-Fi network and no server.

4. Send a message each way. Check ticks progress to delivered, then read.
5. Send a photo. Check the progress and the ETA are honest, then that the file
   opens on the other side.
6. Play Tic-Tac-Toe, then Chess. Both boards agree at every move.
7. Play Pong. Motion is smooth; the ball is in the same place on both screens.
8. Walk out of range for thirty seconds. Both show Reconnecting. Come back:
   the session resumes and any message sent while apart arrives.
9. Send a message while apart, then return — it must deliver, not fail.
10. Background one app, then foreground it. It reconnects.
11. Switch Bluetooth off on one device. The other shows a calm status, not an
    error, and reconnects when it returns.
12. Both join the same Wi-Fi with no internet. The transport upgrades, and a
    photo that took minutes now takes seconds — with no interruption.
13. Watch Together: pick the same video on both, start a session, confirm they
    stay in step, then seek and confirm both follow.
14. Force-quit one app and reopen it. History is intact and it reconnects.

**Nothing in this list may ever crash the app.** A failure is a message, not a
stack trace.

---

## 6. Adding a test

- Testing protocol behaviour? Use two `PeerSession`s over `MockNetwork`; copy
  `connectPair` from `packages/core/test/session.test.ts`.
- Testing a game? Add it to the conformance suite first, then write the
  rule-specific tests.
- Testing something time-dependent? Inject `VirtualClock`. If you find yourself
  reaching for a real timer, the code under test has a dependency it should not.
- Testing a decoder? Add its shape to the fuzz corpus.
