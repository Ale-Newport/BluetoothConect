# Games

Twenty-eight games, all real, all playable between two phones with no server.

| Shelf | Games |
|---|---|
| **Quick** | Reaction · Tic-Tac-Toe · Rock Paper Scissors · Tap Race · Quick Math · Darts |
| **Strategy** | Chess · Connect Four · Battleship · Gomoku · Reversi · Dots & Boxes |
| **Words** | Word Duel · Word Chain |
| **Trivia** | Trivia · Flag Duel · Capital Duel · Geography Duel |
| **Puzzles** | Code Breaker · Memory Duel · Sliding Puzzle Race |
| **Party** | Draw & Guess |
| **Just the two of you** | Would You Rather · Most Likely To · This or That |
| **Real-time** | Pong · Air Hockey · 8-Ball |

---

## 0. What the catalogue knows about the link

AirLink's floor is Bluetooth between an iPhone and an Android: five to forty
kilobytes a second, with tens of milliseconds of latency and jitter. Chess does
not notice that. Pong is ruined by it. So every entry declares:

```ts
category            which shelf it belongs on
latencySensitivity  NONE - played locally, only a result is exchanged
                    LOW  - turn-based; a few hundred milliseconds is invisible
                    HIGH - continuous; wants a fast, steady link
bandwidth           TINY | LOW | HIGH
typicalMinutes      so "we have twenty minutes" is answerable
```

On a slow link `gamesForLink(false)` puts the latency-sensitive games last and
the Play tab marks them **Best over Wi-Fi**. Nothing is hidden — somebody who
wants to try Air Hockey over Bluetooth is welcome to, and will be told what to
expect first.

The three games with `latencySensitivity: NONE` are worth understanding,
because they are the shape that suits this app best: **Tap Race**, **Quick
Math** and **Sliding Puzzle Race** each run entirely on their own phone and
exchange only a result. Tap Race sends one number after twenty seconds. Latency
cannot be felt because nothing is waiting on it, and — the part that matters —
nobody can win because their radio was better.

---

## 1. The one rule

**A game is a deterministic reducer.**

```ts
applyAction(state, action, context) -> state
```

Given the same starting state and the same ordered actions, every device must
arrive at a byte-identical result. That single property is what lets two phones
stay in step with no server to arbitrate, and it is what the conformance suite
checks for every game.

Consequences a game author must respect:

- **No `Math.random`.** Randomness comes from `context.random`, seeded from the
  shared game seed, so both devices shuffle the same deck.
- **No `Date.now`.** Time comes from `context.tickMs` and `context.elapsedMs`.
- **No mutation.** Return a new value. Structural sharing of untouched
  sub-objects is fine and encouraged; writing through one is not.
- **No I/O, no rendering, no platform APIs.** This layer is pure logic and runs
  unchanged in Node under vitest.

---

## 2. The contract

```ts
interface GameDefinition<TState, TAction> {
  id; name; protocolVersion; mode; minPlayers; maxPlayers; tickRate?;

  createInitialState(setup): TState;
  validateAction(state, action, context): ValidationResult;
  applyAction(state, action, context): TState;
  tick?(state, context): TState;              // realtime only
  status(state): GameStatus;
  currentTurn?(state): PlayerId | null;

  encodeState(state): CborValue;
  decodeState(value): TState;
  encodeAction(action): CborValue;
  decodeAction(value, player): TAction;       // input is HOSTILE

  resolveConflict?(local, remote, localIsHost): TState;
}
```

`validateAction` runs on **both** devices for **every** action, local and
remote. Never trust a peer to have validated on their side. `applyAction` is
only ever called with actions that already passed it.

### Versioning, and what happens when a move goes missing

Every action carries the `stateVersion` it expects to be applied on top of, and
the runtime keeps per-player sequence numbers so an action is applied exactly
once however often the link re-delivers it.

A gap in those sequence numbers is not survivable on its own: the missing action
is never coming, so every action after it is rejected as `OUT_OF_ORDER`, for
ever, while the board still looks perfectly healthy. The repair is
`snapshotEnvelope()` / `applySnapshotEnvelope()`, which carry **the board, the
sequence vector, the version and the elapsed time together**. A snapshot that
carried only the board — which is what it used to be — corrected the position
and left the game just as dead.

```
guest cannot apply an action  ->  GAME_SYNC_REQUEST
host                          ->  GAME_STATE { state, seq, version, elapsedMs }
guest adopts all four         ->  plays on
```

Host versions only ever compare with other host versions. A guest whose own
moves never reached the host has applied *more* actions than the host has, so it
is ahead by count and wrong about the board at the same time — which is exactly
the device that most needs the repair.

`decodeAction` receives bytes from an unauthenticated peer: validate every
field with the `asInt` / `asString` / `asArray` helpers, bound every array, and
throw on anything malformed.

The action's `player` is filled in by the runtime from the **authenticated
session**, never from the packet — so a peer cannot play on someone else's
behalf by putting a different id in the payload.

---

## 3. Two synchronisation models

### Turn-based

Chess, Connect Four, Battleship, Tic-Tac-Toe, Trivia, Word Duel, Darts,
Reaction, Draw & Guess.

Only **actions** travel. Every device replays the same ordered action log
through the same reducer and therefore holds the same state. A move costs a few
dozen bytes, which is nothing even over Bluetooth, and a reconnecting player
catches up by replaying the log.

### Realtime

Pong, Air Hockey, 8-Ball. `tickRate` 60.

The host runs the authoritative simulation at a fixed timestep and ships
periodic **snapshots**. Guests send only their **input** and render an
interpolated view of the last two snapshots, so a late packet shows as smooth
motion rather than a jump.

Nothing graphical is ever transmitted. Each device draws its own frames.

**Fixed timestep with an accumulator.** The simulation only ever advances in
whole steps of `1/tickRate`. Time left over from one call is carried forward,
never discarded — a frame delivering 16.6 ms when a step is 16.667 ms would
otherwise silently drop that step, so the simulation would run slow and, far
worse, two devices with different frame pacing would accumulate different
amounts of discarded time and drift apart. (This was a real bug, caught by a
test.)

**Floating point.** Realtime games round stored positions and velocities to
three decimals at the end of each tick, and resolve collisions in a fixed index
order, so tiny per-device differences cannot accumulate into divergence.

---

## 4. The conformance suite

Every game passes this, across dozens of seeds:

| Check | What it proves |
|---|---|
| **Determinism** | Same seed + same actions → byte-identical state; replaying the log reproduces the live state |
| **Purity** | `applyAction` and `tick` do not mutate the state they are given |
| **State round-trip** | `encodeState → decodeState → encodeState` is stable |
| **Action round-trip** | Type, sequence, player and payload all survive the wire |
| **Hostile input** | `decodeAction` throws on garbage; `applyRemote` never throws |
| **Authorisation** | An action attributed to a non-player is refused |
| **Convergence** | Two independent sessions agree move for move |
| **Termination** | Random play reaches a terminal status |

There is one further guarantee worth knowing: `submitLocal` pushes a local
action through `encodeAction → decodeAction` before applying it, so a local move
takes **exactly** the path a remote one does. That makes two classes of bug
impossible to ship — an encoder that loses a field, and a validator that is
stricter for peers than for ourselves. It costs one CBOR round-trip per move.

---

## 5. Two games worth reading

### Battleship — hiding a fleet from a shared reducer

Both devices run the same reducer over the same state, so a fleet cannot simply
be kept in the state: the opponent's device would hold it. The game uses
**commit–reveal**:

1. **Placement** — each player commits to a hash of (fleet ‖ random salt).
2. **Firing** — the owner of the targeted grid *reports* hit/miss/sunk.
3. **Reveal** — at the end, both reveal their layout and salt. The reducer
   verifies the commitment and re-checks **every reported result** against the
   revealed layout. A mismatch means that player cheated, and the game is
   awarded to the other side.

A cheating opponent is caught, deterministically, with no referee.

### Word Duel — a shared secret nobody sends

Both devices generate the identical 4×4 letter grid from the shared seed, so not
one byte of it crosses the link. A word found by **both** players scores for
**neither**, which turns the game from a typing race into a hunt for what the
other one missed — and makes the shared-reducer model a virtue rather than a
constraint, since both devices must hold every submission anyway.

The dictionary — about four thousand words — ships inside the app. Nothing is
ever fetched.

---

## 6. Adding a game

1. Write `packages/games/src/games/<name>.ts` following
   [`ticTacToe.ts`](../packages/games/src/games/ticTacToe.ts), which is the
   reference implementation.
2. Write `packages/games/test/<name>.test.ts`: the real rules, the rejection
   cases, and a `runConformance` call across 40+ seeds.
3. Register it in [`registry.ts`](../packages/games/src/registry.ts) with an
   icon, a blurb and a typical duration.
4. Add a renderer in `apps/mobile/src/screens/play/games/`.

Registering is the **only** thing needed to make a game appear in the Play tab,
be offered in capability exchange, and be playable — there is no second list to
keep in sync. A test asserts that every catalogue entry has a callable reducer
and a round-trippable state, which is what stops a button existing for a game
that is not really there.

---

## 7. Versioning

Each game carries its own `protocolVersion`. Capability exchange intersects the
two devices' game lists and requires the **same** version on both sides, so a
rules change that would desynchronise two builds simply removes the game from
the picker rather than corrupting a match halfway through.
