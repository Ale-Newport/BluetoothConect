# Watch together

Two phones playing the same local film in step, with no server, no streaming and
no shared clock.

Implemented in [`packages/core/src/sync`](../packages/core/src/sync).

---

## 1. Content matching

Before a session can start, both sides must confirm they hold the **same file**.
`SYNC_CONTENT_QUERY` / `SYNC_CONTENT_REPLY` compare a content identity built
from size, duration and a **sampled hash** — a digest over several fixed-offset
windows of the file rather than the whole thing, because hashing a 4 GB video on
a phone would take longer than the opening credits.

That trade-off is stated plainly in the code: it is a strong integrity check,
not a cryptographic commitment. Two files that pass are the same film; a
deliberately crafted collision is possible and does not matter, because the
worst outcome is that two friends watch a film that is out of step.

If the peer lacks the file, the answer is an offer to send it — which is the
file transfer module, at whatever speed the link allows.

---

## 2. Only commands travel

`SYNC_CREATE` · `SYNC_JOIN` · `SYNC_LEAVE` · `SYNC_PLAY` · `SYNC_PAUSE` ·
`SYNC_SEEK` · `SYNC_RATE` · `SYNC_HEARTBEAT` · `SYNC_END`

Never video. Both devices already have the film; what they need to agree on is
*when*.

---

## 3. The anchor, and the platform limit that forced it

The obvious design — poll the player's position and broadcast it — does not
work. `react-native-video` reports playback position with **tens of
milliseconds of jitter** on both platforms: on iOS the periodic time observer
fires on the main queue and then crosses into JavaScript; on Android it is a
main-thread handler re-post loop reading a position that is itself coarse.
Broadcasting that would synchronise the two devices to the jitter.

So the host publishes an **anchor** instead:

```
anchor = (positionMs, hostWallClockMs, rate)
```

and every device computes its own target:

```
target = anchor.positionMs + (nowInHostClock - anchor.wallClockMs) × rate
```

`nowInHostClock` comes from the clock offset measured by
[`ClockSynchronizer`](../packages/core/src/session/clockSync.ts), which runs an
NTP-style exchange over the peer session:

```
roundTrip = (t4 − t1) − (t3 − t2)
offset    = ((t2 − t1) + (t3 − t4)) / 2
```

keeping the sample with the **lowest** round trip from each round — standard NTP
practice, and the right choice here because queueing delay on a Bluetooth link
is the dominant source of error.

An anchor is a fact about the host's timeline, not a measurement of a player, so
it does not inherit the player's jitter. It is republished only when something
actually changes: play, pause, seek, rate.

---

## 4. Drift correction

Each device compares its own position to the target and applies the gentlest
correction that will work:

| Drift | Action | Why |
|---|---|---|
| < 50 ms | **ignore** | Below anything a person can perceive, and within the measurement noise |
| < 300 ms | **nudge the playback rate** by up to 2%, scaled with the drift | Inaudible, and it closes the gap over a few seconds instead of jumping |
| ≥ 300 ms | **seek** | The only thing that works, and jarring enough to be a last resort |

Seeking is the last resort on purpose. A film that quietly slides back into step
feels synchronised; one that jumps every thirty seconds feels broken.

---

## 5. Latency compensation on play

A play command does not mean "now" — by the time it arrives, "now" has passed.
It schedules playback to begin at a shared **future instant**, a few hundred
milliseconds out and derived from the measured round trip, so both devices start
together rather than one starting a round trip early.

---

## 6. No media player in the core

The module works against an injected `MediaController`
(`play` / `pause` / `seek` / `setRate` / `getPosition`), so it is fully testable
with a fake player. The tests run two sessions and two fake players over a link
**with latency** and assert they converge inside the ignore threshold, that a
seek propagates, that a badly drifted device gets a seek rather than an endless
rate nudge, and that a peer sending an absurd position or a negative rate is
rejected.

---

## 7. What it does not do

- **It does not stream.** Both devices need the file. If one lacks it, that is a
  file transfer first, and over Bluetooth a film is not a realistic transfer —
  the app says so.
- **It does not survive backgrounding on iOS.** No high-bandwidth local
  transport does. Leaving the app pauses the session rather than letting the two
  drift apart in silence.
- **It does not sync audio sample-accurately.** Tens of milliseconds is the
  achievable target with a consumer media player, and it is comfortably enough
  for two people watching one film on two phones.
