/**
 * Code Breaker. Mastermind played as a duel: one code, two people racing it.
 *
 * Shaped exactly like the reference game (src/games/ticTacToe.ts):
 *   - an immutable state type
 *   - a single discriminated action type
 *   - validateAction rejecting anything a hostile peer must not do
 *   - applyAction as a pure reducer
 *   - compact encode/decode for both state and action
 *   - decodeAction treating its input as bytes from an attacker
 *
 * ---------------------------------------------------------------------------
 * WHERE THE SECRET LIVES, AND WHY THAT IS ACCEPTABLE HERE
 * ---------------------------------------------------------------------------
 * The code is drawn from the shared seed inside createInitialState, so no guess
 * ever has to carry it: each device derives the same four pegs on its own. It is
 * a plain field of the state, which means a determined peer who reads their own
 * process memory - or simply reimplements this function, since the seed is
 * agreed in the open before the first guess - can read the answer off and win
 * on turn one.
 *
 * Nor does the code stay off the wire. encodeState puts it in every snapshot,
 * and turn-based games send snapshots to repair a guest that has fallen behind
 * and write them to the local database between sessions, so the secret both
 * travels and is stored at rest. Deriving it from the seed saves it from riding
 * on every action; it does not hide it.
 *
 * That is stated plainly rather than papered over, because it is a real
 * property of the design and not a bug to be found later. It is acceptable for
 * THIS game and would not be for Battleship: here the code is the opponent, not
 * something one player holds against the other. Neither player chose it and
 * neither is defending it, so a cheat robs only themselves of the puzzle.
 * Battleship pays for a commit-play-reveal protocol precisely because there one
 * player's secret is the other player's target; see src/games/battleship.ts.
 *
 * The honest alternative - commit to a code neither player picks, then reveal -
 * buys nothing, because there would be nobody to reveal it: the code has no
 * author to be caught lying about it.
 *
 * ---------------------------------------------------------------------------
 * THE EQUALISING GUESS
 * ---------------------------------------------------------------------------
 * Players alternate, and player one always guesses first. Ending the game the
 * instant somebody breaks the code would therefore hand player one a free extra
 * attempt in every game, and in a race decided by a single guess that is the
 * whole match. So a break does not end the game until the ROUND is complete:
 * whoever is behind gets their equalising guess, and if they also break it the
 * result is a draw.
 *
 * That fixes the arithmetic and creates a worse problem, which belongs here
 * rather than in a bug report. The code is unique, so the ONLY guess that can
 * break it is the four pegs the leader has just played - and those pegs are
 * sitting on the shared board where the trailing player can read them. The
 * equalising break is therefore never a coincidence and always available:
 * player two can force a draw in every game player one would have won, while
 * still winning outright on any round player one misses. The rule does not
 * remove the first-move advantage. It hands a larger one to player two.
 *
 * Nothing local repairs this, because the leader's pegs travel in the leader's
 * action and have to, so that both devices can replay it and agree. The repair
 * is a commitment - but note carefully that it is a DIFFERENT commitment from
 * the one dismissed above. Committing to the CODE buys nothing, because no
 * player authored the code and none can lie about it. Committing to each
 * ROUND'S TWO GUESSES buys exactly this: revealed together, neither player ever
 * answers a guess they have already seen, and a dead heat becomes a real one.
 * That is a protocol change, not a rule change, so it is not made here. Until
 * it is, the guaranteed draw is a property of these rules and not an accident,
 * and codeBreaker.test.ts pins it so that it cannot quietly stop being known.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * ---------------------------------------------------------------------------
 * Every stored value is a small integer: pegs 0-5, counts 0-4, guess indices
 * 0-9. The reducer performs no floating-point arithmetic and reads neither the
 * clock nor Math.random. The secret comes from a SeededGameRandom this module
 * constructs itself from setup.seed. createInitialState is handed the setup and
 * nothing else - there is no context yet, and that is the right way round: the
 * session's generator is shared and mutable for the life of a game, so a code
 * drawn from it would depend on how many numbers the runtime happened to have
 * taken already. A fresh instance makes the code a pure function of the seed
 * alone, which is the whole reason two devices agree on it.
 *
 * ---------------------------------------------------------------------------
 * WIRE SIZE (~180 usable bytes per Bluetooth packet)
 * ---------------------------------------------------------------------------
 * Every peg is 0-5, and CBOR spends one byte on any integer below 24, so the
 * four pegs cost four bytes and the whole action, envelope and keys included,
 * measures 22. FEEDBACK IS NOT TRANSMITTED. Both peers hold the code, so every
 * score is recomputable from the guess, and sending it would be both redundant
 * and a second version of the truth that could disagree with the first. A
 * finished game - twenty guesses, eighty pegs, the code and two player ids -
 * encodes in 116 bytes, so even the final snapshot fits in a single packet.
 */
import type { CborValue } from '@airlink/core';
import {
  GameDecodeError,
  GameMode,
  GameStatusKind,
  SeededGameRandom,
  VALID,
  asArray,
  asInt,
  asMap,
  decodeActionEnvelope,
  encodeActionEnvelope,
  invalid,
  type GameAction,
  type GameDefinition,
  type GameSetup,
  type GameStatus,
  type PlayerId,
  type ValidationResult,
} from '../engine.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Pegs in the code. */
export const CODE_LENGTH = 4;
/** Colours available at each position. Repeats are allowed, so 6^4 = 1296 codes. */
export const COLOURS = 6;
/**
 * Guesses each player gets. This is also the hard round limit that guarantees
 * termination: the game cannot outlive 2 * MAX_GUESSES actions whatever anyone
 * plays, which is what the conformance suite's random play relies on.
 */
export const MAX_GUESSES = 10;

/** One attempt and what it revealed. `colour` is the "right colour, wrong place" count. */
export interface Attempt {
  readonly guess: readonly number[];
  /** Right colour in the right place. */
  readonly exact: number;
  /** Right colour in the wrong place. */
  readonly colour: number;
}

export interface CodeBreakerState {
  readonly players: readonly PlayerId[];
  readonly secret: readonly number[];
  /**
   * One board per player, indexed the same way as `players`, so the renderer
   * can show both races side by side. Whose turn it is is NOT stored: it is
   * implied by the board lengths (see `turnIndexOf`), and a derived turn cannot
   * drift out of step with the history the way a stored one can.
   */
  readonly boards: readonly (readonly Attempt[])[];
}

export interface CodeBreakerAction extends GameAction {
  readonly type: 'guess';
  // The peg array is mutable only because a CborValue payload must be; nothing
  // here writes through it.
  readonly payload: { readonly guess: number[] };
}

/**
 * Score a guess the way Mastermind actually scores it.
 *
 * The trap is repeats. Counting "right colour, wrong place" by asking whether
 * each guessed peg appears anywhere in the code double-counts: guess 0,0,0,0
 * against code 0,1,2,3 would report one exact and three misplaced, claiming
 * four zeros in a code that holds one. The fix is to take exact matches out
 * FIRST and then match what is left as multisets - each remaining peg of the
 * code can pay for at most one remaining peg of the guess - which is why the
 * two histograms below skip the positions already counted as exact.
 */
export function scoreGuess(
  secret: readonly number[],
  guess: readonly number[],
): { readonly exact: number; readonly colour: number } {
  const secretLeft = new Array<number>(COLOURS).fill(0);
  const guessLeft = new Array<number>(COLOURS).fill(0);
  let exact = 0;

  for (let i = 0; i < CODE_LENGTH; i++) {
    const s = secret[i] as number;
    const g = guess[i] as number;
    if (s === g) {
      exact += 1;
      continue;
    }
    secretLeft[s] = (secretLeft[s] as number) + 1;
    guessLeft[g] = (guessLeft[g] as number) + 1;
  }

  let colour = 0;
  for (let c = 0; c < COLOURS; c++) {
    colour += Math.min(secretLeft[c] as number, guessLeft[c] as number);
  }
  return { exact, colour };
}

/** A board holds a break if any attempt matched every position. */
function hasBroken(board: readonly Attempt[]): boolean {
  return board.some((a) => a.exact === CODE_LENGTH);
}

/**
 * Player one leads every round, so the second board is never ahead of the
 * first: equal lengths mean a round is about to start, unequal that player two
 * owes the equalising guess.
 */
function turnIndexOf(state: CodeBreakerState): number {
  const first = (state.boards[0] as readonly Attempt[]).length;
  const second = (state.boards[1] as readonly Attempt[]).length;
  return first === second ? 0 : 1;
}

/** Pegs of one board, flattened. See the wire-size note: feedback is not sent. */
function flatten(board: readonly Attempt[]): number[] {
  const out: number[] = [];
  for (const attempt of board) out.push(...attempt.guess);
  return out;
}

/**
 * Rebuild a board from flattened pegs, rescoring every guess against the code.
 *
 * Feedback arrives nowhere: it is recomputed here. A snapshot therefore cannot
 * carry a score that disagrees with the guess that produced it, which is one
 * fewer thing a hostile host can lie about and one fewer thing to validate.
 */
function rebuild(secret: readonly number[], pegs: readonly CborValue[], what: string): Attempt[] {
  if (pegs.length % CODE_LENGTH !== 0) {
    throw new GameDecodeError(`codeBreaker: ${what} must be a whole number of guesses`);
  }
  if (pegs.length > MAX_GUESSES * CODE_LENGTH) {
    throw new GameDecodeError(`codeBreaker: ${what} holds more than ${MAX_GUESSES} guesses`);
  }
  const board: Attempt[] = [];
  for (let i = 0; i < pegs.length; i += CODE_LENGTH) {
    const guess: number[] = [];
    for (let j = 0; j < CODE_LENGTH; j++) {
      guess.push(asInt(pegs[i + j], `${what}[${i + j}]`, 0, COLOURS - 1));
    }
    board.push({ guess, ...scoreGuess(secret, guess) });
  }
  return board;
}

export const codeBreaker: GameDefinition<CodeBreakerState, CodeBreakerAction> = {
  id: 'code-breaker',
  name: 'Code Breaker',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(setup: GameSetup): CodeBreakerState {
    const random = new SeededGameRandom(setup.seed);
    const secret: number[] = [];
    for (let i = 0; i < CODE_LENGTH; i++) secret.push(random.nextInt(COLOURS));
    return {
      players: [...setup.players],
      secret,
      boards: [[], []],
    };
  },

  validateAction(state, action): ValidationResult {
    if (codeBreaker.status(state).kind !== GameStatusKind.IN_PROGRESS) {
      return invalid('the game has already finished');
    }
    if (action.type !== 'guess') return invalid(`unknown action "${action.type}"`);

    const index = turnIndexOf(state);
    const expected = state.players[index];
    if (action.player !== expected) return invalid(`it is ${String(expected)}'s turn`);

    const guess = action.payload?.guess;
    if (!Array.isArray(guess) || guess.length !== CODE_LENGTH) {
      return invalid(`a guess must be ${CODE_LENGTH} pegs`);
    }
    for (const peg of guess) {
      if (!Number.isInteger(peg) || peg < 0 || peg > COLOURS - 1) {
        return invalid(`each peg must be 0-${COLOURS - 1}`);
      }
    }
    // Unreachable while status() is honest - a player out of guesses is either
    // finished or waiting on their opponent's equaliser - but a rule change
    // that broke that invariant should not be able to grow a board past ten.
    if ((state.boards[index] as readonly Attempt[]).length >= MAX_GUESSES) {
      return invalid(`you have used all ${MAX_GUESSES} guesses`);
    }
    return VALID;
  },

  applyAction(state, action): CodeBreakerState {
    const index = turnIndexOf(state);
    const guess = [...action.payload.guess];
    const attempt: Attempt = { guess, ...scoreGuess(state.secret, guess) };
    return {
      players: state.players,
      secret: state.secret,
      // The untouched board is reused by reference; the played one is rebuilt.
      // Pushing into the existing array would mutate a state another device is
      // still holding, which is the desynchronisation the purity rule exists
      // to prevent.
      boards: state.boards.map((board, i) => (i === index ? [...board, attempt] : board)),
    };
  },

  status(state): GameStatus {
    const first = state.boards[0] as readonly Attempt[];
    const second = state.boards[1] as readonly Attempt[];
    // Mid-round: player two still owes the equalising guess, so nothing is
    // decided yet even if player one has just broken the code.
    if (first.length !== second.length) return { kind: GameStatusKind.IN_PROGRESS };

    const brokeFirst = hasBroken(first);
    const brokeSecond = hasBroken(second);
    if (brokeFirst && brokeSecond) {
      return { kind: GameStatusKind.DRAW, reason: 'both broke the code on the same round' };
    }
    if (brokeFirst || brokeSecond) {
      const winner = state.players[brokeFirst ? 0 : 1];
      return {
        kind: GameStatusKind.WON,
        winners: winner === undefined ? [] : [winner],
        reason: 'broke the code first',
      };
    }
    if (first.length >= MAX_GUESSES) {
      return { kind: GameStatusKind.DRAW, reason: `neither broke the code in ${MAX_GUESSES} guesses` };
    }
    return { kind: GameStatusKind.IN_PROGRESS };
  },

  currentTurn(state): PlayerId | null {
    if (codeBreaker.status(state).kind !== GameStatusKind.IN_PROGRESS) return null;
    return state.players[turnIndexOf(state)] ?? null;
  },

  encodeState(state): CborValue {
    return {
      p: [...state.players],
      s: [...state.secret],
      g: state.boards.map((board) => flatten(board)),
    };
  },

  decodeState(value): CodeBreakerState {
    const m = asMap(value, 'codeBreaker.state');

    const rawPlayers = asArray(m.p, 'players', 2);
    if (rawPlayers.length !== 2) throw new GameDecodeError('codeBreaker: expected exactly 2 players');
    const players = rawPlayers.map((p, i) => {
      if (typeof p !== 'string') throw new GameDecodeError(`codeBreaker: players[${i}] must be a string`);
      if (p.length > 256) throw new GameDecodeError(`codeBreaker: players[${i}] is too long`);
      return p;
    });

    const rawSecret = asArray(m.s, 'secret', CODE_LENGTH);
    if (rawSecret.length !== CODE_LENGTH) {
      throw new GameDecodeError(`codeBreaker: the code must have ${CODE_LENGTH} pegs`);
    }
    const secret = rawSecret.map((peg, i) => asInt(peg, `secret[${i}]`, 0, COLOURS - 1));

    const rawBoards = asArray(m.g, 'boards', 2);
    if (rawBoards.length !== 2) throw new GameDecodeError('codeBreaker: expected exactly 2 boards');
    const boards = rawBoards.map((board, i) =>
      rebuild(secret, asArray(board, `boards[${i}]`, MAX_GUESSES * CODE_LENGTH), `boards[${i}]`),
    );

    // The turn is derived from these lengths, so a snapshot in which player two
    // has outpaced player one would produce a board that plays itself out of
    // order for ever. Refuse it here rather than debug it in the field.
    const first = (boards[0] as Attempt[]).length;
    const second = (boards[1] as Attempt[]).length;
    if (first !== second && first !== second + 1) {
      throw new GameDecodeError('codeBreaker: the two boards are out of step');
    }

    // A break ends the round it lands in, so an attempt that matched every
    // position can only ever be the last one on its board. A history that kept
    // guessing past one is as impossible as boards out of step, and is refused
    // for the same reason: status() would call that game won and currentTurn
    // would call it over, so the position would sit there looking finished
    // while claiming a history that could not have produced it.
    for (let i = 0; i < boards.length; i++) {
      const board = boards[i] as Attempt[];
      const broke = board.findIndex((attempt) => attempt.exact === CODE_LENGTH);
      if (broke >= 0 && broke !== board.length - 1) {
        throw new GameDecodeError(`codeBreaker: boards[${i}] kept guessing after breaking the code`);
      }
    }

    return { players, secret, boards };
  },

  encodeAction(action): CborValue {
    return encodeActionEnvelope({ ...action, payload: { g: [...action.payload.guess] } });
  },

  decodeAction(value, player): CodeBreakerAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type !== 'guess') throw new GameDecodeError(`codeBreaker: unknown action "${envelope.type}"`);
    const payload = asMap(envelope.payload, 'codeBreaker.payload');
    const pegs = asArray(payload.g, 'guess', CODE_LENGTH);
    if (pegs.length !== CODE_LENGTH) throw new GameDecodeError(`codeBreaker: a guess must be ${CODE_LENGTH} pegs`);
    return {
      type: 'guess',
      player,
      seq: envelope.seq,
      payload: { guess: pegs.map((peg, i) => asInt(peg, `guess[${i}]`, 0, COLOURS - 1)) },
    };
  },
};
