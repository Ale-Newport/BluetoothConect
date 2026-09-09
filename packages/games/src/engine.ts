/**
 * The AirLink game engine contract.
 *
 * One rule governs everything here: a game is a DETERMINISTIC REDUCER.
 *
 *     applyAction(state, action, context) -> state
 *
 * Given the same starting state and the same ordered list of actions, every
 * device must arrive at a byte-identical result. That single property is what
 * lets two phones stay in step over a link with no server to arbitrate, and it
 * is what the conformance suite in test/ checks for every game.
 *
 * Consequences a game author must respect:
 *   - No Math.random(). Randomness comes from `context.random`, seeded from the
 *     shared game seed, so both devices draw the same cards.
 *   - No Date.now(). Time comes from `context.tickMs`.
 *   - No mutation of the input state. Return a new value.
 *   - No I/O, no rendering, no platform APIs. This layer is pure logic and runs
 *     unchanged in Node under vitest.
 *
 * Rendering and networking live entirely outside this file, which is why the
 * same game code powers the UI, the tests and the headless simulator.
 */
import type { CborValue } from '@airlink/core';

// Re-exported so a game file needs only one import to write its codecs.
export type { CborValue };

export type PlayerId = string;

export const GameMode = {
  /** One player acts at a time. Only actions travel; both sides replay them. */
  TURN_BASED: 'turnBased',
  /** Continuous simulation. The host is authoritative and ships snapshots. */
  REALTIME: 'realtime',
} as const;
export type GameMode = (typeof GameMode)[keyof typeof GameMode];

export interface GameSetup {
  /** Ordered player list. Index 0 is the host. Order is identical on all peers. */
  readonly players: readonly PlayerId[];
  /** Shared seed. Both devices derive identical randomness from it. */
  readonly seed: number;
  /** Game-specific options, already validated against `optionsSchema`. */
  readonly options: Readonly<Record<string, CborValue>>;
}

/**
 * Deterministic PRNG handed to games. Seeded identically on every device, so a
 * shuffled deck or a random question order matches everywhere.
 */
export interface GameRandom {
  /** Uniform float in [0, 1). */
  next(): number;
  /** Uniform integer in [0, maxExclusive). */
  nextInt(maxExclusive: number): number;
  /** Fisher-Yates shuffle returning a new array. */
  shuffle<T>(items: readonly T[]): T[];
}

export interface GameContext {
  /** Milliseconds of simulated time this step covers. 0 for turn-based games. */
  readonly tickMs: number;
  /** Total simulated milliseconds since the game started. */
  readonly elapsedMs: number;
  readonly random: GameRandom;
  readonly players: readonly PlayerId[];
}

export const GameStatusKind = {
  IN_PROGRESS: 'inProgress',
  WON: 'won',
  DRAW: 'draw',
  ABANDONED: 'abandoned',
} as const;
export type GameStatusKind = (typeof GameStatusKind)[keyof typeof GameStatusKind];

export type GameStatus =
  | { readonly kind: typeof GameStatusKind.IN_PROGRESS }
  | { readonly kind: typeof GameStatusKind.WON; readonly winners: readonly PlayerId[]; readonly reason?: string }
  | { readonly kind: typeof GameStatusKind.DRAW; readonly reason?: string }
  | { readonly kind: typeof GameStatusKind.ABANDONED; readonly by: PlayerId };

export type ValidationResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export const VALID: ValidationResult = { ok: true };
export const invalid = (reason: string): ValidationResult => ({ ok: false, reason });

/**
 * A game action, as it travels between devices.
 *
 * `player` is filled in by the runtime from the authenticated session, never by
 * the sender - a peer cannot claim to be someone else by putting a different id
 * in the payload.
 */
export interface GameAction<TPayload = CborValue> {
  readonly type: string;
  readonly player: PlayerId;
  /** Monotonic per-player action counter, used for ordering and deduplication. */
  readonly seq: number;
  readonly payload: TPayload;
}

export interface GameDefinition<TState, TAction extends GameAction = GameAction> {
  readonly id: string;
  readonly name: string;
  /** Bumped whenever the rules or the state encoding change incompatibly. */
  readonly protocolVersion: number;
  readonly mode: GameMode;
  readonly minPlayers: number;
  readonly maxPlayers: number;
  /** Realtime games only: simulation steps per second. */
  readonly tickRate?: number;

  createInitialState(setup: GameSetup): TState;

  /**
   * Reject anything a peer must not be allowed to do: acting out of turn,
   * playing an occupied square, moving a piece that is not theirs.
   *
   * This runs on BOTH devices for every action, local or remote. Never trust a
   * peer to have validated on their side.
   */
  validateAction(state: TState, action: TAction, context: GameContext): ValidationResult;

  /**
   * Pure reducer. Must not mutate `state`, and must be a function of its inputs
   * alone. Only ever called with actions that already passed validateAction.
   */
  applyAction(state: TState, action: TAction, context: GameContext): TState;

  /** Advance a realtime simulation by one fixed step. Omitted for turn-based. */
  tick?(state: TState, context: GameContext): TState;

  status(state: TState): GameStatus;

  /** Whose turn it is, for turn-based games. Null when nobody is to move. */
  currentTurn?(state: TState): PlayerId | null;

  /** Compact, canonical state encoding. Must round-trip exactly. */
  encodeState(state: TState): CborValue;
  decodeState(value: CborValue): TState;

  encodeAction(action: TAction): CborValue;
  /** Decode an action from an untrusted peer. Throw on anything malformed. */
  decodeAction(value: CborValue, player: PlayerId): TAction;

  /**
   * Resolve two conflicting states, used when a device rejoins after a
   * disconnection and its history has diverged. The default policy - trust the
   * host - suits every game we ship; a game may override it for something
   * smarter.
   */
  resolveConflict?(local: TState, remote: TState, localIsHost: boolean): TState;
}

// ---------------------------------------------------------------------------
// Deterministic randomness
// ---------------------------------------------------------------------------

/**
 * mulberry32: small, fast and - critically - identical on every JavaScript
 * engine, which a floating-point-based generator would not be.
 */
export class SeededGameRandom implements GameRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive <= 0) throw new Error('nextInt: bound must be positive');
    return Math.floor(this.next() * maxExclusive);
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.nextInt(i + 1);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }
}

export function createContext(
  players: readonly PlayerId[],
  seed: number,
  elapsedMs = 0,
  tickMs = 0,
): GameContext {
  return { players, random: new SeededGameRandom(seed), elapsedMs, tickMs };
}

// ---------------------------------------------------------------------------
// Decoding helpers - every game decodes untrusted peer input through these
// ---------------------------------------------------------------------------

export class GameDecodeError extends Error {
  override readonly name = 'GameDecodeError';
}

export function asMap(value: CborValue, what = 'value'): Record<string, CborValue> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value instanceof Uint8Array) {
    throw new GameDecodeError(`${what}: expected an object`);
  }
  return value as Record<string, CborValue>;
}

export function asInt(value: CborValue | undefined, what: string, min = -1e9, max = 1e9): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new GameDecodeError(`${what}: expected an integer`);
  if (value < min || value > max) throw new GameDecodeError(`${what}: out of range`);
  return value;
}

export function asNumber(value: CborValue | undefined, what: string, min = -1e9, max = 1e9): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new GameDecodeError(`${what}: expected a number`);
  if (value < min || value > max) throw new GameDecodeError(`${what}: out of range`);
  return value;
}

export function asString(value: CborValue | undefined, what: string, maxLength = 256): string {
  if (typeof value !== 'string') throw new GameDecodeError(`${what}: expected a string`);
  if (value.length > maxLength) throw new GameDecodeError(`${what}: too long`);
  return value;
}

export function asBool(value: CborValue | undefined, what: string): boolean {
  if (typeof value !== 'boolean') throw new GameDecodeError(`${what}: expected a boolean`);
  return value;
}

export function asArray(value: CborValue | undefined, what: string, maxLength = 4096): CborValue[] {
  if (!Array.isArray(value)) throw new GameDecodeError(`${what}: expected an array`);
  if (value.length > maxLength) throw new GameDecodeError(`${what}: too long`);
  return value;
}

/** Decode the fields every action shares. Games layer their payload on top. */
export function decodeActionEnvelope(
  value: CborValue,
  player: PlayerId,
): { type: string; player: PlayerId; seq: number; payload: CborValue } {
  const m = asMap(value, 'action');
  return {
    type: asString(m.t, 'action.type', 32),
    player,
    seq: asInt(m.s, 'action.seq', 0, Number.MAX_SAFE_INTEGER),
    payload: m.p ?? null,
  };
}

export function encodeActionEnvelope(action: GameAction): CborValue {
  return { t: action.type, s: action.seq, p: action.payload as CborValue };
}
