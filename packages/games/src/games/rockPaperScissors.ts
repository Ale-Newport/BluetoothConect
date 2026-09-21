/**
 * Rock Paper Scissors, best of five, over a link with no referee.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM
 * ---------------------------------------------------------------------------
 * Rock Paper Scissors is a SIMULTANEOUS game, and this engine is a turn-based
 * reducer: actions arrive in a total order and both devices replay them. If a
 * round were one action carrying a choice, whoever sent second would have seen
 * the first choice before making their own, and would win every round for ever.
 * There is no server to hold both choices back and open them together, and the
 * peer on the other end is free to lie about when it decided.
 *
 * ---------------------------------------------------------------------------
 * THE SOLUTION: COMMIT THEN REVEAL
 * ---------------------------------------------------------------------------
 * Each round is two actions per player.
 *
 *   commit { hash }          hash = H(seat || round || choice || nonce),
 *                            truncated (see below). The choice itself never
 *                            leaves the device. The hash binds its sender to one
 *                            choice - they cannot change their mind later
 *                            without breaking it - and it tells the opponent
 *                            nothing, because the nonce is secret. The seat and
 *                            the round bind it to one player and one moment, so
 *                            it is worth nothing to anybody else.
 *
 *   reveal { choice, nonce } Re-hashed by the reducer and compared with the
 *                            commitment. A reveal that does not match is not a
 *                            move that loses: it is REFUSED by validateAction,
 *                            on both devices, so the transcript never contains
 *                            a broken commitment at all.
 *
 * BOTH players must commit before EITHER may reveal. That ordering is the whole
 * protocol: revealing while the opponent is still free to choose would hand back
 * exactly the advantage the commitment was there to remove.
 *
 * Two smaller guards fall out of the same reasoning:
 *   - A commitment is BOUND to who is making it and to which round: the
 *     preimage carries the committer's player index and the round number ahead
 *     of the choice and the nonce, so one choice and one nonce commit to a
 *     different digest for each player and in every round.
 *
 *     Without that binding, copying the opponent's commitment is a forced draw
 *     on demand. The copier cannot open it at the moment they send it - they do
 *     not have the nonce - but they do not need to yet: a reveal carries the
 *     nonce IN THE CLEAR, so the copier waits, takes the victim's choice and
 *     nonce straight off the wire, and replays the pair as its own. It opens the
 *     copied commitment perfectly, because it is the same preimage, and the
 *     round is a draw. Every round. For ever. Binding kills it at the root: a
 *     reveal is re-hashed with the REVEALER's own index, so the replayed pair
 *     produces a different digest and does not open what was copied.
 *
 *     Refusing a commitment identical to the opponent's is the guard that
 *     suggests itself instead, and it was tried first. It lost because it is not
 *     order-independent, and the commit phase is the one phase this game
 *     deliberately does not serialise: each device applies its own commit at
 *     once and the peer's when it lands, so the two devices apply the same two
 *     commits in OPPOSITE orders. Hand them identical commitments and each
 *     device keeps the one it applied first and refuses the other - so the two
 *     boards disagree about who has committed, with no error raised anywhere and
 *     the same action count on both, which is precisely the desynchronisation
 *     `stateVersion` cannot see. A rule that judges your move by reading the
 *     opponent's half of the board cannot be applied concurrently. A rule about
 *     the preimage can, because the preimage is yours alone.
 *   - The nonce must be at least MIN_NONCE characters. The alternative was to
 *     leave it free and treat a weak nonce as the sender's own problem, since
 *     only their secrecy suffers. It lost because there are three choices: with
 *     a one-character nonce an opponent brute-forces the whole preimage space in
 *     microseconds, and a UI bug that shipped short nonces would look like a
 *     working game while leaking every round. The reducer cannot check that a
 *     nonce is UNPREDICTABLE, but it can check that it is long enough to be.
 *
 * A player who commits and then never reveals stalls the round. That is a
 * disconnect, not a rule: it is handled by the session layer above, which is
 * also where a per-move timeout would live. Nothing the reducer can do would
 * distinguish a sulking peer from a flat battery.
 *
 * A copied commitment now ends in exactly that state, and deliberately so. The
 * copier cannot open it, so the round stalls - which is the same outcome as
 * committing thirty-two random hex characters, something no rule can detect and
 * every cheat can do. Reducing the copy to an ordinary stall is the whole point:
 * a stall already has an owner one layer up, whereas a forced draw had none.
 *
 * ---------------------------------------------------------------------------
 * WHY THE COMMITMENT IS TRUNCATED
 * ---------------------------------------------------------------------------
 * hash256 gives 32 bytes, which is 64 hex characters. Two of those live in the
 * state at once, and a state snapshot has to fit a Bluetooth MTU of 185 bytes
 * alongside the player ids, the scores and the round history. The full digest
 * does not fit; COMMITMENT_BYTES of it does, with room to spare.
 *
 * Keeping all 32 bytes and splitting the snapshot across packets was the
 * alternative, and it lost because 128 bits is already far beyond any preimage
 * search, and because the digest length is not what protects this game anyway -
 * the choice space is three. The NONCE is the secret. Truncating the hash does
 * not weaken hiding at all; it costs only second-preimage margin nobody can use
 * inside a five-round game.
 *
 * ---------------------------------------------------------------------------
 * TERMINATION
 * ---------------------------------------------------------------------------
 * Best of five: first to WINS_NEEDED round wins takes it, and in any case the
 * match stops after ROUNDS rounds. Drawn rounds score nothing and are NOT
 * replayed - replaying them is the natural house rule and it is precisely the
 * rule that lets an unlucky pair of players play for ever, which a game with no
 * clock and a fixed action budget must never do. Five rounds at four actions
 * each is a hard ceiling of twenty actions per match.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM
 * ---------------------------------------------------------------------------
 * Every number here is a small integer: choices 1-3, scores 0-3, packed round
 * outcomes 5-15. There is no floating-point arithmetic and no randomness in the
 * reducer at all - the nonces are chosen by the UI and travel as data, so
 * context.random is never consulted.
 *
 * Determinism here has to be stronger than "same log, same state", because this
 * game does not have one log order. Every rule below is ORDER-INDEPENDENT: a
 * commit is judged only against the committer's own slot, a reveal only against
 * the committer's own commitment, and a round is scored from both choices at
 * once by a function that reads them by index rather than by arrival. So the two
 * devices, which see the two concurrent commits in opposite orders, accept and
 * refuse exactly the same actions and land on the same board. Any rule tempted
 * to compare one player's move against the other's has to be checked against
 * that before it goes in.
 *
 * ---------------------------------------------------------------------------
 * WIRE SIZE
 * ---------------------------------------------------------------------------
 *   commit ~50 bytes    reveal ~30 bytes
 *   snapshot ~35 bytes finished, ~100 bytes mid-round, plus the two player ids
 *
 * The mid-round snapshot is the one that has to fit, not the finished one: it is
 * the only time two 32-character commitments are live at once, and it is exactly
 * when a rejoining peer needs catching up. It clears 185 bytes with room for
 * player ids of thirty characters each.
 */
import { hash256, toHex, utf8Encode, type CborValue } from '@airlink/core';
import {
  GameDecodeError,
  GameMode,
  GameStatusKind,
  VALID,
  asArray,
  asInt,
  asMap,
  asString,
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

/** 1 = rock, 2 = paper, 3 = scissors. 0 is "not revealed yet". */
export type Choice = 1 | 2 | 3;

export const ROCK: Choice = 1;
export const PAPER: Choice = 2;
export const SCISSORS: Choice = 3;

/** Rounds in the match, and the score that clinches it before they run out. */
export const ROUNDS = 5;
export const WINS_NEEDED = 3;

/** Leading bytes of the digest kept as the commitment. See the header. */
export const COMMITMENT_BYTES = 16;
export const COMMITMENT_CHARS = COMMITMENT_BYTES * 2;

/** Enough nonce that the three-choice preimage space cannot be searched. */
export const MIN_NONCE = 8;
export const MAX_NONCE = 32;

export interface RockPaperScissorsState {
  readonly players: readonly PlayerId[];
  /** Index of the round being played, 0-based. Equal to ROUNDS when finished. */
  readonly round: number;
  /** Per-player commitment for the round in play; null until they commit. */
  readonly commits: readonly (string | null)[];
  /** Per-player revealed choice for the round in play; 0 until they reveal. */
  readonly reveals: readonly (Choice | 0)[];
  readonly scores: readonly number[];
  /** One packed entry per finished round. See `packOutcome`. */
  readonly outcomes: readonly number[];
}

export interface RockPaperScissorsCommitAction extends GameAction {
  readonly type: 'commit';
  readonly payload: { readonly hash: string };
}

export interface RockPaperScissorsRevealAction extends GameAction {
  readonly type: 'reveal';
  readonly payload: { readonly choice: Choice; readonly nonce: string };
}

export type RockPaperScissorsAction = RockPaperScissorsCommitAction | RockPaperScissorsRevealAction;

/**
 * The commitment a player makes to a choice in a round.
 *
 * `player` is the committer's index in `state.players`, not their id: an index
 * is a single digit, an id is a device name of any length, and the preimage
 * needs no separators only while every field before the nonce is fixed-width.
 * Index (0-1), round (0-4) and choice (1-3) are one character each, so a
 * preimage can be split exactly one way and the ambiguity a separator exists to
 * prevent cannot arise. The nonce comes last, where its length cannot matter.
 *
 * The index and the round are what make a copied commitment worthless: see the
 * header. They cost two characters of preimage and nothing on the wire, because
 * both are already known to both devices and neither is transmitted.
 */
export function commitment(player: number, round: number, choice: Choice, nonce: string): string {
  return toHex(hash256(utf8Encode(`${player}${round}${choice}${nonce}`)).slice(0, COMMITMENT_BYTES));
}

/** Both round choices in one integer, 5-15. Cheap to encode, exactly reversible. */
function packOutcome(first: Choice, second: Choice): number {
  return first * 4 + second;
}

export function unpackOutcome(packed: number): { readonly first: Choice; readonly second: Choice } {
  return { first: Math.floor(packed / 4) as Choice, second: (packed % 4) as Choice };
}

/**
 * 0 for a drawn round, otherwise the 1-based index of the player who won it.
 * Rock beats scissors, paper beats rock, scissors beats paper - which is exactly
 * "one more, modulo three".
 */
export function roundWinner(first: Choice, second: Choice): 0 | 1 | 2 {
  if (first === second) return 0;
  return (first - second + 3) % 3 === 1 ? 1 : 2;
}

function isCommitmentHex(value: string): boolean {
  if (value.length !== COMMITMENT_CHARS) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    const isDigit = c >= 0x30 && c <= 0x39;
    const isLowerAf = c >= 0x61 && c <= 0x66;
    if (!isDigit && !isLowerAf) return false;
  }
  return true;
}

function playerIndex(state: RockPaperScissorsState, player: PlayerId): number {
  return state.players.indexOf(player);
}

function matchOver(state: RockPaperScissorsState): boolean {
  return state.round >= ROUNDS || (state.scores[0] ?? 0) >= WINS_NEEDED || (state.scores[1] ?? 0) >= WINS_NEEDED;
}

export const rockPaperScissors: GameDefinition<RockPaperScissorsState, RockPaperScissorsAction> = {
  id: 'rock-paper-scissors',
  name: 'Rock Paper Scissors',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  maxPlayers: 2,

  createInitialState(setup: GameSetup): RockPaperScissorsState {
    return {
      players: [...setup.players],
      round: 0,
      commits: [null, null],
      reveals: [0, 0],
      scores: [0, 0],
      outcomes: [],
    };
  },

  validateAction(state, action): ValidationResult {
    if (matchOver(state)) return invalid('the match has already finished');
    const index = playerIndex(state, action.player);
    if (index < 0) return invalid(`${action.player} is not in this game`);
    const other = 1 - index;

    switch (action.type) {
      // Judged against this player's own slot and nothing else, so the two
      // devices reach the same verdict whichever of the two concurrent commits
      // they happen to see first. A copied commitment is accepted here and dies
      // at the reveal, where it cannot be opened.
      case 'commit': {
        if (state.commits[index] !== null) return invalid('you have already committed this round');
        const hash = action.payload?.hash;
        if (typeof hash !== 'string' || !isCommitmentHex(hash)) {
          return invalid(`commitment must be ${COMMITMENT_CHARS} lowercase hex characters`);
        }
        return VALID;
      }

      case 'reveal': {
        const own = state.commits[index];
        if (own === null || own === undefined) return invalid('commit before you reveal');
        if (state.commits[other] === null) return invalid('your opponent has not committed yet');
        if (state.reveals[index] !== 0) return invalid('you have already revealed this round');
        const choice = action.payload?.choice;
        if (choice !== ROCK && choice !== PAPER && choice !== SCISSORS) {
          return invalid('choice must be rock, paper or scissors');
        }
        const nonce = action.payload?.nonce;
        if (typeof nonce !== 'string' || nonce.length < MIN_NONCE || nonce.length > MAX_NONCE) {
          return invalid(`nonce must be ${MIN_NONCE}-${MAX_NONCE} characters`);
        }
        // The point of the whole protocol. A reveal that does not reproduce the
        // commitment is someone changing their mind after seeing the round, and
        // both devices refuse it identically. Re-hashed under the REVEALER's own
        // index, so replaying the pair the opponent just published opens nothing.
        if (commitment(index, state.round, choice, nonce) !== own) {
          return invalid('that reveal does not match your commitment');
        }
        return VALID;
      }

      default:
        return invalid(`unknown action "${String((action as GameAction).type)}"`);
    }
  },

  applyAction(state, action): RockPaperScissorsState {
    const index = playerIndex(state, action.player);

    if (action.type === 'commit') {
      const commits = [...state.commits];
      commits[index] = action.payload.hash;
      return { ...state, commits };
    }

    const reveals = [...state.reveals];
    reveals[index] = action.payload.choice;
    const first = reveals[0];
    const second = reveals[1];
    // 0 is "still hidden"; undefined cannot happen with two players, but the
    // narrowing keeps the scoring below honest about what it is reading.
    if (!first || !second) return { ...state, reveals };

    // Both are open: score the round and start the next one with clean slates,
    // so `commits`/`reveals` always describe the round currently in play and
    // nothing has to remember to clear them later.
    const winner = roundWinner(first, second);
    const scores = [...state.scores];
    if (winner !== 0) scores[winner - 1] = (scores[winner - 1] ?? 0) + 1;
    return {
      players: state.players,
      round: state.round + 1,
      commits: [null, null],
      reveals: [0, 0],
      scores,
      outcomes: [...state.outcomes, packOutcome(first, second)],
    };
  },

  status(state): GameStatus {
    const first = state.scores[0] ?? 0;
    const second = state.scores[1] ?? 0;
    if (first >= WINS_NEEDED || (state.round >= ROUNDS && first > second)) {
      return { kind: GameStatusKind.WON, winners: [state.players[0] as PlayerId], reason: `${first}-${second}` };
    }
    if (second >= WINS_NEEDED || (state.round >= ROUNDS && second > first)) {
      return { kind: GameStatusKind.WON, winners: [state.players[1] as PlayerId], reason: `${second}-${first}` };
    }
    // Five rounds with no clear score means the rounds were drawn, not that the
    // match is unfinished: drawn rounds are not replayed.
    if (state.round >= ROUNDS) return { kind: GameStatusKind.DRAW, reason: `${first}-${second}` };
    return { kind: GameStatusKind.IN_PROGRESS };
  },

  /**
   * Whose action the engine is waiting for.
   *
   * A commit phase is genuinely simultaneous - validateAction lets either player
   * commit first, because refusing an early commit from the second player would
   * serialise the one phase whose entire purpose is that it is not serialised.
   * The runtime still needs A name to prompt, so this reports the lowest-indexed
   * player who has yet to act in the current phase. It is an ordering for the
   * UI, not a rule; nothing rejects an action that arrives out of it.
   */
  currentTurn(state): PlayerId | null {
    if (matchOver(state)) return null;
    const waitingToCommit = state.commits.findIndex((c) => c === null);
    if (waitingToCommit >= 0) return state.players[waitingToCommit] ?? null;
    const waitingToReveal = state.reveals.findIndex((r) => r === 0);
    if (waitingToReveal >= 0) return state.players[waitingToReveal] ?? null;
    return null;
  },

  encodeState(state): CborValue {
    return {
      p: [...state.players],
      n: state.round,
      c: [...state.commits],
      v: [...state.reveals],
      s: [...state.scores],
      o: [...state.outcomes],
    };
  },

  decodeState(value): RockPaperScissorsState {
    const m = asMap(value, 'rockPaperScissors.state');

    const rawPlayers = asArray(m.p, 'players', 2);
    if (rawPlayers.length !== 2) throw new GameDecodeError('rockPaperScissors: expected exactly 2 players');
    const players = rawPlayers.map((p, i) => asString(p, `players[${i}]`));

    const rawCommits = asArray(m.c, 'commits', 2);
    if (rawCommits.length !== 2) throw new GameDecodeError('rockPaperScissors: expected 2 commitments');
    const commits = rawCommits.map((c, i) => {
      if (c === null || c === undefined) return null;
      const hex = asString(c, `commits[${i}]`, COMMITMENT_CHARS);
      if (!isCommitmentHex(hex)) throw new GameDecodeError(`rockPaperScissors: commits[${i}] is not a commitment`);
      return hex;
    });

    const rawReveals = asArray(m.v, 'reveals', 2);
    if (rawReveals.length !== 2) throw new GameDecodeError('rockPaperScissors: expected 2 reveals');
    const reveals = rawReveals.map((r, i) => asInt(r, `reveals[${i}]`, 0, 3) as Choice | 0);

    const rawScores = asArray(m.s, 'scores', 2);
    if (rawScores.length !== 2) throw new GameDecodeError('rockPaperScissors: expected 2 scores');
    const scores = rawScores.map((s, i) => asInt(s, `scores[${i}]`, 0, ROUNDS));

    const outcomes = asArray(m.o, 'outcomes', ROUNDS).map((o, i) =>
      asInt(o, `outcomes[${i}]`, packOutcome(ROCK, ROCK), packOutcome(SCISSORS, SCISSORS)),
    );
    for (const [i, packed] of outcomes.entries()) {
      const { first, second } = unpackOutcome(packed);
      if (first < ROCK || first > SCISSORS || second < ROCK || second > SCISSORS) {
        throw new GameDecodeError(`rockPaperScissors: outcomes[${i}] does not name two choices`);
      }
    }

    const round = asInt(m.n, 'round', 0, ROUNDS);

    /*
     * Every field above is individually well formed by now, and that is not the
     * same as being a board this reducer could have produced. A snapshot is
     * adopted wholesale by a rejoining guest, so a peer that ships an INCOHERENT
     * one - a round revealed by somebody who never committed, a score that does
     * not follow from the rounds played - hands that guest a game it can never
     * finish, and does it without breaking a single type. The round counter and
     * both scores are derivable from `outcomes`, and the reveals are only
     * reachable once both commitments are in, so all of it is checkable here for
     * the cost of one pass.
     */
    if (outcomes.length !== round) {
      throw new GameDecodeError(`rockPaperScissors: ${outcomes.length} outcomes for round ${round}`);
    }
    const tally = [0, 0];
    for (const packed of outcomes) {
      const { first, second } = unpackOutcome(packed);
      const winner = roundWinner(first, second);
      if (winner !== 0) tally[winner - 1] = (tally[winner - 1] ?? 0) + 1;
    }
    if (scores[0] !== tally[0] || scores[1] !== tally[1]) {
      throw new GameDecodeError(`rockPaperScissors: scores ${scores.join('-')} do not follow from the rounds played`);
    }
    for (const [i, choice] of reveals.entries()) {
      // A reveal is only legal once BOTH players have committed, so a revealed
      // choice beside a missing commitment is a position with no history.
      if (choice !== 0 && (commits[0] === null || commits[1] === null)) {
        throw new GameDecodeError(`rockPaperScissors: reveals[${i}] without both commitments`);
      }
    }
    if (reveals[0] !== 0 && reveals[1] !== 0) {
      throw new GameDecodeError('rockPaperScissors: both players revealed without the round being scored');
    }

    return { players, round, commits, reveals, scores, outcomes };
  },

  encodeAction(action): CborValue {
    switch (action.type) {
      case 'commit':
        return encodeActionEnvelope({ ...action, payload: { h: action.payload.hash } });
      case 'reveal':
        return encodeActionEnvelope({ ...action, payload: { c: action.payload.choice, n: action.payload.nonce } });
      default:
        throw new GameDecodeError(`rockPaperScissors: unknown action "${String((action as GameAction).type)}"`);
    }
  },

  decodeAction(value, player): RockPaperScissorsAction {
    const envelope = decodeActionEnvelope(value, player);
    const { seq } = envelope;

    switch (envelope.type) {
      case 'commit': {
        const payload = asMap(envelope.payload, 'rockPaperScissors.commit');
        const hash = asString(payload.h, 'hash', COMMITMENT_CHARS);
        if (!isCommitmentHex(hash)) {
          throw new GameDecodeError(`rockPaperScissors: hash must be ${COMMITMENT_CHARS} lowercase hex characters`);
        }
        return { type: 'commit', player, seq, payload: { hash } };
      }

      case 'reveal': {
        const payload = asMap(envelope.payload, 'rockPaperScissors.reveal');
        const nonce = asString(payload.n, 'nonce', MAX_NONCE);
        if (nonce.length < MIN_NONCE) throw new GameDecodeError('rockPaperScissors: nonce is too short');
        return {
          type: 'reveal',
          player,
          seq,
          payload: { choice: asInt(payload.c, 'choice', ROCK, SCISSORS) as Choice, nonce },
        };
      }

      default:
        throw new GameDecodeError(`rockPaperScissors: unknown action "${envelope.type}"`);
    }
  },
};
