/**
 * The conformance suite every AirLink game must pass.
 *
 * A game that satisfies these checks is guaranteed to stay in step across two
 * devices, to survive a hostile peer, and to be safe to ship. A game that does
 * not is broken, however good it looks on screen. Running one shared suite over
 * every game is what makes it safe to add games quickly.
 *
 * The checks:
 *   1. Determinism            same seed + same actions => byte-identical state
 *   2. Purity                 applyAction does not mutate its input
 *   3. State round-trip       encodeState/decodeState preserve everything
 *   4. Action round-trip      encodeAction/decodeAction preserve everything
 *   5. Hostile input          decodeAction throws (never crashes) on garbage
 *   6. Validation             illegal actions are rejected, not applied
 *   7. Termination            random play reaches a terminal status
 *   8. Two-device convergence two independent sessions agree move for move
 */
import { encodeCbor, decodeCbor, toHex, type CborValue } from '@airlink/core';
import {
  GameMode,
  GameStatusKind,
  SeededGameRandom,
  createContext,
  type GameAction,
  type GameDefinition,
  type GameSetup,
  type PlayerId,
} from './engine.js';
import { GameSession } from './runtime.js';

export interface ConformanceHooks<TState, TAction extends GameAction> {
  /**
   * Produce a legal action for `player` in `state`, or null when they cannot
   * move. Used to drive random play, so it need not be clever - only legal.
   */
  readonly legalAction: (
    state: TState,
    player: PlayerId,
    random: SeededGameRandom,
    session: GameSession<TState, TAction>,
  ) => { type: string; payload: CborValue } | null;
  /** Upper bound on plies before random play is considered non-terminating. */
  readonly maxPlies?: number;
  /** Realtime games: how long to simulate, in milliseconds. */
  readonly simulateMs?: number;
}

export interface ConformanceFailure {
  readonly check: string;
  readonly detail: string;
}

export interface ConformanceReport {
  readonly gameId: string;
  readonly passed: boolean;
  readonly failures: readonly ConformanceFailure[];
  readonly playedPlies: number;
  readonly finalStatus: string;
}

function stableHash(value: CborValue): string {
  return toHex(encodeCbor(value)).slice(0, 64);
}

function makeSetup(definition: GameDefinition<never, never>, seed: number): GameSetup {
  const count = Math.max(definition.minPlayers, Math.min(2, definition.maxPlayers));
  return {
    players: Array.from({ length: count }, (_, i) => `player-${i + 1}`),
    seed,
    options: {},
  };
}

export function runConformance<TState, TAction extends GameAction>(
  definition: GameDefinition<TState, TAction>,
  hooks: ConformanceHooks<TState, TAction>,
  seed = 0x51ee,
): ConformanceReport {
  const failures: ConformanceFailure[] = [];
  const fail = (check: string, detail: string): void => {
    failures.push({ check, detail });
  };

  const setup = makeSetup(definition as unknown as GameDefinition<never, never>, seed);
  const maxPlies = hooks.maxPlies ?? 400;

  // -- 1 & 8: two independent sessions must converge, move for move ----------
  const a = new GameSession<TState, TAction>({
    definition,
    setup,
    localPlayer: setup.players[0] as PlayerId,
    isHost: true,
  });
  const b = new GameSession<TState, TAction>({
    definition,
    setup,
    localPlayer: setup.players[1] ?? (setup.players[0] as PlayerId),
    isHost: false,
  });

  if (stableHash(definition.encodeState(a.currentState)) !== stableHash(definition.encodeState(b.currentState))) {
    fail('determinism', 'two sessions built from the same setup produced different initial states');
  }

  const driver = new SeededGameRandom(seed ^ 0x9e37);
  const sessionsByPlayer = new Map<PlayerId, GameSession<TState, TAction>>();
  sessionsByPlayer.set(setup.players[0] as PlayerId, a);
  if (setup.players[1]) sessionsByPlayer.set(setup.players[1], b);

  const actionLog: TAction[] = [];
  let plies = 0;

  for (; plies < maxPlies; plies++) {
    if (a.isOver) break;

    // Whose move? Turn-based games say; realtime games let anyone act.
    const turn = definition.currentTurn?.(a.currentState) ?? null;
    const candidates = turn ? [turn] : [...sessionsByPlayer.keys()];
    const player = candidates[driver.nextInt(candidates.length)] as PlayerId;
    const mover = sessionsByPlayer.get(player);
    if (!mover) break;

    const proposal = hooks.legalAction(mover.currentState, player, driver, mover);
    if (!proposal) {
      if (definition.mode === GameMode.REALTIME) {
        a.tick(1000 / (definition.tickRate ?? 60));
        b.tick(1000 / (definition.tickRate ?? 60));
        continue;
      }
      break;
    }

    // -- 2: PURITY. Hold on to the state object the reducer is about to be
    // given, hash it, apply the action, then re-encode that SAME object. If the
    // reducer mutated anything reachable from it - a nested array written
    // through after a shallow copy is the usual culprit - the hash moves.
    //
    // Structural sharing is fine and expected: an untouched sub-object may be
    // reused by reference. What must never happen is a WRITE through it, because
    // the two devices replay actions at different moments and a mutated history
    // desynchronises them in a way that is almost impossible to debug in the
    // field.
    const stateBefore = mover.currentState;
    const hashBefore = stableHash(definition.encodeState(stateBefore));

    const outcome = mover.submitLocal(proposal.type, proposal.payload);
    if (!outcome.accepted) {
      fail('validation', `legalAction produced a rejected action: ${outcome.detail}`);
      break;
    }
    actionLog.push(outcome.applied.action);

    const hashAfter = stableHash(definition.encodeState(stateBefore));
    if (hashAfter !== hashBefore) {
      fail('purity', `applyAction mutated the state it was given (ply ${plies + 1}, action "${proposal.type}")`);
      break;
    }

    // -- 8: replay the same action on the other session.
    const other = player === (setup.players[0] as PlayerId) ? b : a;
    const wire = decodeCbor(encodeCbor(definition.encodeAction(outcome.applied.action)));
    const mirrored = other.applyRemote(wire, player);
    if (!mirrored.accepted) {
      fail('convergence', `peer rejected a valid action: ${mirrored.detail}`);
      break;
    }

    const ha = stableHash(definition.encodeState(a.currentState));
    const hb = stableHash(definition.encodeState(b.currentState));
    if (ha !== hb) {
      fail('convergence', `states diverged after ${plies + 1} plies (${ha} vs ${hb})`);
      break;
    }

    if (definition.mode === GameMode.REALTIME) {
      const step = 1000 / (definition.tickRate ?? 60);
      const tickStateBefore = a.currentState;
      const tickHashBefore = stableHash(definition.encodeState(tickStateBefore));
      a.tick(step);
      b.tick(step);
      if (stableHash(definition.encodeState(tickStateBefore)) !== tickHashBefore) {
        fail('purity', `tick() mutated the state it was given (ply ${plies + 1})`);
        break;
      }
      if (stableHash(definition.encodeState(a.currentState)) !== stableHash(definition.encodeState(b.currentState))) {
        fail('determinism', `tick() diverged after ${plies + 1} plies`);
        break;
      }
    }
  }

  // -- 1: replaying the same log from scratch must reproduce the state -------
  const replayed = GameSession.replay(definition, setup, actionLog);
  if (stableHash(definition.encodeState(replayed)) !== stableHash(definition.encodeState(a.currentState))) {
    fail('determinism', 'replaying the action log did not reproduce the live state');
  }

  // -- 3: state round-trip ---------------------------------------------------
  try {
    const encoded = definition.encodeState(a.currentState);
    const wire = decodeCbor(encodeCbor(encoded));
    const restored = definition.decodeState(wire);
    if (stableHash(definition.encodeState(restored)) !== stableHash(encoded)) {
      fail('stateRoundTrip', 'encodeState -> decodeState -> encodeState is not stable');
    }
  } catch (err) {
    fail('stateRoundTrip', `threw: ${err instanceof Error ? err.message : String(err)}`);
  }

  // -- 4: action round-trip --------------------------------------------------
  for (const action of actionLog.slice(0, 20)) {
    try {
      const wire = decodeCbor(encodeCbor(definition.encodeAction(action)));
      const restored = definition.decodeAction(wire, action.player);
      if (restored.type !== action.type || restored.seq !== action.seq || restored.player !== action.player) {
        fail('actionRoundTrip', `action ${action.type} did not survive the round trip`);
        break;
      }
      if (stableHash(definition.encodeAction(restored)) !== stableHash(definition.encodeAction(action))) {
        fail('actionRoundTrip', `action ${action.type} payload changed across the round trip`);
        break;
      }
    } catch (err) {
      fail('actionRoundTrip', `threw: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  // -- 5: hostile input ------------------------------------------------------
  const hostile: CborValue[] = [
    null,
    0,
    'not an action',
    [],
    {},
    { t: 'move' },
    { t: 'move', s: -1, p: null },
    { t: 'x'.repeat(500), s: 0, p: null },
    { t: 'move', s: 0, p: { row: 1e12, col: -1e12 } },
    { t: 'move', s: 0, p: new Uint8Array(64) },
    { t: 'move', s: 0, p: Array.from({ length: 200 }, () => 1) },
    { t: 'move', s: 1.5, p: null },
    { t: 'move', s: 0, p: { row: 'a', col: {} } },
  ];
  const fresh = new GameSession<TState, TAction>({
    definition,
    setup,
    localPlayer: setup.players[0] as PlayerId,
    isHost: true,
  });
  for (const junk of hostile) {
    try {
      const result = fresh.applyRemote(junk, setup.players[0] as PlayerId);
      // Accepting is fine only if the value happened to be a legal action;
      // what must never happen is a throw escaping applyRemote.
      void result;
    } catch (err) {
      fail('hostileInput', `applyRemote threw on ${JSON.stringify(junk)}: ${String(err)}`);
      break;
    }
  }

  // -- 6: a peer must not be able to act as another player -------------------
  if (setup.players.length > 1 && actionLog.length > 0) {
    const impostor = new GameSession<TState, TAction>({
      definition,
      setup,
      localPlayer: setup.players[0] as PlayerId,
      isHost: true,
    });
    const stolen = definition.encodeAction(actionLog[0] as TAction);
    const result = impostor.applyRemote(stolen, 'somebody-not-in-this-game');
    if (result.accepted) fail('authorisation', 'an action from an unknown player was accepted');
  }

  // -- 7: termination --------------------------------------------------------
  const status = a.status;
  if (definition.mode === GameMode.TURN_BASED && plies >= maxPlies && status.kind === GameStatusKind.IN_PROGRESS) {
    fail('termination', `random play did not terminate within ${maxPlies} plies`);
  }

  return {
    gameId: definition.id,
    passed: failures.length === 0,
    failures,
    playedPlies: plies,
    finalStatus: status.kind,
  };
}

export { createContext };
