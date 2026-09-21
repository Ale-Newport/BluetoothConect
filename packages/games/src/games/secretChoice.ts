/**
 * The "together" family: Would You Rather, Most Likely To, This or That.
 *
 * One reducer, instantiated three times. All three games are the same shape - a
 * prompt with two options, both players choose in secret, the choices open
 * together, and at the end you are told how often the two of you matched. What
 * differs between them is only the bank of prompts and where the two option
 * labels come from, so three definitions share one set of rules and one set of
 * tests rather than three near-identical files that drift apart.
 *
 * ---------------------------------------------------------------------------
 * NOBODY LOSES, AND THE STATUS SAYS SO
 * ---------------------------------------------------------------------------
 * The terminal status is a DRAW with the agreement count as its reason, never a
 * WON. Declaring the player with more matches the winner was the obvious
 * alternative and it is a design lie: agreement is symmetric, both players hold
 * exactly the same number of matches by definition, and there is no quantity
 * here that one person can have more of than the other. A game about finding
 * out what somebody thinks does not need a scoreboard, and bolting one on would
 * quietly change what the pair are doing - answering honestly is worth nothing
 * if a point is going spare for answering strategically.
 *
 * ---------------------------------------------------------------------------
 * THE REVEAL, AND WHY IT IS A RULE RATHER THAN A COURTESY
 * ---------------------------------------------------------------------------
 * A round is revealed only when BOTH choices are in. This is the whole game: a
 * player who can see the other's answer before committing to their own is no
 * longer answering the question, they are answering the person, and every round
 * after the first would be a negotiation. The flag exists so that there is one
 * place that rule lives - `revealed[round]` - and one accessor, `roundView`,
 * that will not hand out the other player's choice until it is set. Nothing
 * else in this module exposes an unrevealed pick, so an honest renderer cannot
 * show one by accident, and a bug that tried to would have to be written on
 * purpose. Consistency between the flag and the picks is re-checked at decode,
 * so a peer cannot ship a snapshot claiming a round is closed when it is not.
 *
 * What this does NOT buy, stated plainly because the difference matters: the
 * `choose` action carries the option in the clear, so a MODIFIED peer can read
 * its partner's answer the moment the packet lands and choose accordingly. The
 * fix for that is commit-then-reveal, which rock-paper-scissors in this same
 * folder implements in full, and it costs a second round trip and a nonce per
 * prompt. It lost here because the two games are not the same kind of game: in
 * rock-paper-scissors peeking wins the match, so the protocol has to make it
 * impossible; here peeking wins nothing at all - there is no score to take and
 * no one to take it from - so it can only spoil the evening of the person who
 * bothered to build the modified client. Paying two packets a prompt to protect
 * a player from themselves is not a trade worth making on a Bluetooth link.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE OPTIONS COME FROM
 * ---------------------------------------------------------------------------
 * Would You Rather and This or That carry their two options in the prompt bank.
 * Most Likely To does not: its options ARE the two players, so they can only be
 * known from the setup. That is why a bank is a discriminated union rather than
 * a plain array of pairs, and why labels are resolved at render time by
 * `roundView` rather than written into the state when the round is dealt.
 * Baking the names in at deal time was the simpler-looking option; it lost
 * because it would put two device names into every snapshot that crosses the
 * link, ten times over, on a transport where a packet is 185 bytes.
 *
 * ---------------------------------------------------------------------------
 * DETERMINISM AND TERMINATION
 * ---------------------------------------------------------------------------
 * The reducer consults no randomness and no clock: choices arrive as data and
 * every stored value is a small integer or a boolean, so two devices replaying
 * the same log agree bit for bit. The deal - which ten prompts, in what order -
 * is a pure function of the shared seed, computed on demand and never stored,
 * exactly as the trivia deck is and for the same reason: `context.random` is
 * shared across every action in a session, so a deal drawn from it would depend
 * on how many draws had already happened and a replayed log would deal a
 * different game.
 *
 * Termination is unconditional. PROMPTS_PER_GAME rounds, two choices each, and
 * the game is over after exactly twenty actions however they are played. There
 * is no rule under which a round can be replayed or skipped, so random play
 * cannot fail to reach the end.
 *
 * WIRE SIZE. A snapshot is two player ids, a seed, twenty choices, ten booleans
 * and a tally - comfortably inside one packet, so a peer rejoining after a
 * dropped link is caught up in a single message.
 */
import type { CborValue } from '@airlink/core';
import {
  GameDecodeError,
  GameMode,
  GameStatusKind,
  SeededGameRandom,
  VALID,
  asArray,
  asBool,
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
import { MOST_LIKELY_TO, THIS_OR_THAT, WOULD_YOU_RATHER, type OptionPair } from '../data/prompts.js';

/** Prompts in one game. Ten is about four minutes, which is the right length. */
export const PROMPTS_PER_GAME = 10;

/** The two options, as they are indexed everywhere. */
export const OPTION_A = 0;
export const OPTION_B = 1;
/** A player who has not chosen in a round yet. */
export const UNCHOSEN = -1;

export interface SecretChoiceState {
  readonly players: readonly PlayerId[];
  /** Shared seed, normalised to a uint32. The whole deal derives from it. */
  readonly seed: number;
  /**
   * Two entries per round, in player order: [r0p0, r0p1, r1p0, r1p1, ...].
   * UNCHOSEN until that player has chosen. Flat rather than nested because a
   * nested array costs a CBOR header per round for nothing.
   */
  readonly picks: readonly number[];
  /** One flag per round, set when the second choice lands. See the header. */
  readonly revealed: readonly boolean[];
  /** Rounds in which the two chose the same option. Re-derived at decode. */
  readonly agreed: number;
}

export interface SecretChoiceAction extends GameAction {
  readonly type: 'choose';
  readonly payload: { readonly round: number; readonly option: number };
}

/**
 * A prompt bank, and with it the answer to "where do the two labels come from".
 *
 * `lead` is the line above the options. This or That has none - the two words
 * are the whole question - and passes an empty string rather than a placeholder
 * nobody would want on screen.
 */
export type PromptBank =
  | { readonly kind: 'pairs'; readonly lead: string; readonly pairs: readonly OptionPair[] }
  | { readonly kind: 'players'; readonly lead: string; readonly lines: readonly string[] };

function bankSize(bank: PromptBank): number {
  return bank.kind === 'pairs' ? bank.pairs.length : bank.lines.length;
}

// ---------------------------------------------------------------------------
// The deal: a pure function of the seed, never stored
// ---------------------------------------------------------------------------

/**
 * Which prompts this game asks, in order. A fresh generator is seeded here
 * rather than drawing from `context.random`, for the reason given in the
 * header: the session's generator is shared and its position depends on history.
 */
function deal(seed: number, total: number): readonly number[] {
  const rng = new SeededGameRandom(seed);
  return rng.shuffle(Array.from({ length: total }, (_, i) => i)).slice(0, PROMPTS_PER_GAME);
}

/** The round in play, or PROMPTS_PER_GAME once the last one has opened. */
export function currentRound(state: SecretChoiceState): number {
  const next = state.revealed.indexOf(false);
  return next < 0 ? PROMPTS_PER_GAME : next;
}

/** One player's choice in a round, or UNCHOSEN. */
export function pickAt(state: SecretChoiceState, round: number, playerIndex: number): number {
  return state.picks[round * 2 + playerIndex] ?? UNCHOSEN;
}

export interface RoundView {
  /** The line above the options. Empty for a bank that does not use one. */
  readonly prompt: string;
  readonly options: readonly [string, string];
  /** The viewer's own choice, or null if they have yet to make it. */
  readonly yours: number | null;
  /** The other player's choice - null until the round has opened. */
  readonly theirs: number | null;
  readonly revealed: boolean;
}

/**
 * Everything the screen for one round may know, and nothing it may not.
 *
 * The single accessor for a choice. `theirs` is null until the round is
 * revealed, and there is deliberately no second way to read a pick out of the
 * state, because a value that reaches the renderer has a way of reaching the
 * screen - through an animation, a screen reader, a debug overlay - long before
 * anybody intended it to.
 */
export function roundView(
  bank: PromptBank,
  state: SecretChoiceState,
  round: number,
  viewer: PlayerId,
): RoundView {
  if (round < 0 || round >= PROMPTS_PER_GAME) throw new Error(`secretChoice: no round ${round}`);
  const entry = deal(state.seed, bankSize(bank))[round] ?? 0;
  const prompt =
    bank.kind === 'pairs' ? bank.lead : `${bank.lead} ${bank.lines[entry] ?? ''}`.trim();
  const options: readonly [string, string] =
    bank.kind === 'pairs'
      ? [bank.pairs[entry]?.a ?? '', bank.pairs[entry]?.b ?? '']
      : [String(state.players[0] ?? ''), String(state.players[1] ?? '')];

  const index = state.players.indexOf(viewer);
  const revealed = state.revealed[round] === true;
  const own = index < 0 ? UNCHOSEN : pickAt(state, round, index);
  const other = index < 0 ? UNCHOSEN : pickAt(state, round, 1 - index);
  return {
    prompt,
    options,
    yours: own === UNCHOSEN ? null : own,
    theirs: revealed && other !== UNCHOSEN ? other : null,
    revealed,
  };
}

function countAgreements(picks: readonly number[], revealed: readonly boolean[]): number {
  let agreed = 0;
  for (let round = 0; round < PROMPTS_PER_GAME; round++) {
    if (revealed[round] !== true) continue;
    if (picks[round * 2] === picks[round * 2 + 1]) agreed += 1;
  }
  return agreed;
}

export interface SecretChoiceConfig {
  readonly id: string;
  readonly name: string;
  readonly bank: PromptBank;
}

/**
 * Build one game of the family.
 *
 * Exported so the three below are visibly the same rules with different words,
 * and so a fourth pack is a data change rather than a code change.
 */
export function createSecretChoice(
  config: SecretChoiceConfig,
): GameDefinition<SecretChoiceState, SecretChoiceAction> {
  // A bank shorter than a game would deal the same prompt twice, which the
  // shuffle cannot detect and a player certainly would. Caught at import time
  // rather than at the table.
  if (bankSize(config.bank) < PROMPTS_PER_GAME) {
    throw new Error(`${config.id}: a prompt bank needs at least ${PROMPTS_PER_GAME} entries`);
  }

  return {
    id: config.id,
    name: config.name,
    protocolVersion: 1,
    mode: GameMode.TURN_BASED,
    minPlayers: 2,
    maxPlayers: 2,

    createInitialState(setup: GameSetup): SecretChoiceState {
      return {
        players: [...setup.players],
        seed: setup.seed >>> 0,
        picks: new Array<number>(PROMPTS_PER_GAME * 2).fill(UNCHOSEN),
        revealed: new Array<boolean>(PROMPTS_PER_GAME).fill(false),
        agreed: 0,
      };
    },

    validateAction(state, action): ValidationResult {
      const round = currentRound(state);
      if (round >= PROMPTS_PER_GAME) return invalid('the game has already finished');
      if (action.type !== 'choose') return invalid(`unknown action "${action.type}"`);
      const index = state.players.indexOf(action.player);
      if (index < 0) return invalid(`${action.player} is not in this game`);
      // The round is named in the payload and checked rather than inferred, so
      // a choice made just as the round turned over is refused instead of being
      // silently applied to the next prompt - which is exactly the moment a
      // player would swear the app answered for them.
      if (action.payload?.round !== round) return invalid(`round ${round} is the one in play`);
      const option = action.payload.option;
      if (option !== OPTION_A && option !== OPTION_B) return invalid('option must be 0 or 1');
      if (pickAt(state, round, index) !== UNCHOSEN) return invalid('you have already chosen this round');
      return VALID;
    },

    applyAction(state, action): SecretChoiceState {
      const round = currentRound(state);
      const index = state.players.indexOf(action.player);
      const picks = [...state.picks];
      picks[round * 2 + index] = action.payload.option;

      const first = picks[round * 2];
      const second = picks[round * 2 + 1];
      if (first === undefined || second === undefined || first === UNCHOSEN || second === UNCHOSEN) {
        return { ...state, picks };
      }

      // Both are in: the round opens, and the tally moves in the same step. A
      // separate "open the round" action would have let one player leave the
      // other looking at a closed card indefinitely.
      const revealed = [...state.revealed];
      revealed[round] = true;
      return { ...state, picks, revealed, agreed: state.agreed + (first === second ? 1 : 0) };
    },

    status(state): GameStatus {
      if (currentRound(state) < PROMPTS_PER_GAME) return { kind: GameStatusKind.IN_PROGRESS };
      return {
        kind: GameStatusKind.DRAW,
        reason: `agreed ${state.agreed} times out of ${PROMPTS_PER_GAME}`,
      };
    },

    /**
     * Both players may choose at any point in the round in play - validateAction
     * says nothing about order, because serialising the one phase whose point is
     * that it is simultaneous would defeat it. The runtime still wants a name to
     * prompt with, so this reports the lowest-indexed player who has yet to
     * choose. It is an ordering for the UI, not a rule.
     */
    currentTurn(state): PlayerId | null {
      const round = currentRound(state);
      if (round >= PROMPTS_PER_GAME) return null;
      const waiting = pickAt(state, round, 0) === UNCHOSEN ? 0 : 1;
      return state.players[waiting] ?? null;
    },

    encodeState(state): CborValue {
      return {
        p: [...state.players],
        g: state.seed,
        c: [...state.picks],
        v: [...state.revealed],
        a: state.agreed,
      };
    },

    decodeState(value): SecretChoiceState {
      const m = asMap(value, `${config.id}.state`);

      const rawPlayers = asArray(m.p, 'players', 2);
      if (rawPlayers.length !== 2) throw new GameDecodeError(`${config.id}: expected exactly 2 players`);
      const players = rawPlayers.map((p, i) => asString(p, `players[${i}]`));

      const rawPicks = asArray(m.c, 'picks', PROMPTS_PER_GAME * 2);
      if (rawPicks.length !== PROMPTS_PER_GAME * 2) {
        throw new GameDecodeError(`${config.id}: expected ${PROMPTS_PER_GAME * 2} picks`);
      }
      const picks = rawPicks.map((c, i) => asInt(c, `picks[${i}]`, UNCHOSEN, OPTION_B));

      const rawRevealed = asArray(m.v, 'revealed', PROMPTS_PER_GAME);
      if (rawRevealed.length !== PROMPTS_PER_GAME) {
        throw new GameDecodeError(`${config.id}: expected ${PROMPTS_PER_GAME} reveal flags`);
      }
      const revealed = rawRevealed.map((v, i) => asBool(v, `revealed[${i}]`));

      /*
       * The three fields say overlapping things, so a snapshot that disagrees
       * with itself is refused rather than adopted and puzzled over later. Two
       * of these checks are what stop a peer editing the wire: claiming a round
       * is open when only one choice is in reveals the other player's answer
       * early, and claiming a larger tally rewrites the only thing the game
       * ever tells you. Rounds must also be a prefix - you cannot have opened
       * round 4 without having played round 3 - because the reducer can produce
       * no other arrangement.
       *
       * The prefix rule binds the CHOICES as well as the flags, and that is not
       * a tidiness check. A snapshot is authoritative: a guest adopts whatever
       * the host sends. Checking only the flags let a host plant a choice in a
       * round nobody had reached - unreachable for the reducer, since you cannot
       * answer round 4 while round 0 is in play, but internally consistent round
       * by round, so it decoded happily. The victim then arrived at round 4 to
       * find an answer it had never given already recorded, was refused when it
       * tried to give its own ("you have already chosen this round"), and had
       * the fabricated answer opened and counted the moment the other side
       * chose. A tally the player cannot account for is the one failure this
       * game cannot shrug off, since the tally is all it has to say.
       */
      let inPlay = -1;
      for (let round = 0; round < PROMPTS_PER_GAME; round++) {
        const open = revealed[round] === true;
        if (open && inPlay >= 0) throw new GameDecodeError(`${config.id}: rounds opened out of order`);
        if (!open && inPlay < 0) inPlay = round;
        const both = picks[round * 2] !== UNCHOSEN && picks[round * 2 + 1] !== UNCHOSEN;
        if (open !== both) throw new GameDecodeError(`${config.id}: round ${round} disagrees with its choices`);
        const empty = picks[round * 2] === UNCHOSEN && picks[round * 2 + 1] === UNCHOSEN;
        if (inPlay >= 0 && round > inPlay && !empty) {
          throw new GameDecodeError(`${config.id}: round ${round} holds a choice before anyone reached it`);
        }
      }

      const agreed = asInt(m.a, 'agreed', 0, PROMPTS_PER_GAME);
      if (agreed !== countAgreements(picks, revealed)) {
        throw new GameDecodeError(`${config.id}: the agreement count does not match the choices`);
      }

      return { players, seed: asInt(m.g, 'seed', 0, 0xffffffff), picks, revealed, agreed };
    },

    encodeAction(action): CborValue {
      return encodeActionEnvelope({
        ...action,
        payload: { r: action.payload.round, o: action.payload.option },
      });
    },

    decodeAction(value, player): SecretChoiceAction {
      const envelope = decodeActionEnvelope(value, player);
      if (envelope.type !== 'choose') throw new GameDecodeError(`${config.id}: unknown action "${envelope.type}"`);
      const payload = asMap(envelope.payload, `${config.id}.choose`);
      return {
        type: 'choose',
        player,
        seq: envelope.seq,
        payload: {
          round: asInt(payload.r, 'round', 0, PROMPTS_PER_GAME - 1),
          option: asInt(payload.o, 'option', OPTION_A, OPTION_B),
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The three games
// ---------------------------------------------------------------------------

export const WOULD_YOU_RATHER_BANK: PromptBank = {
  kind: 'pairs',
  lead: 'Would you rather...',
  pairs: WOULD_YOU_RATHER,
};

export const MOST_LIKELY_TO_BANK: PromptBank = {
  kind: 'players',
  lead: 'Who is most likely to',
  lines: MOST_LIKELY_TO,
};

export const THIS_OR_THAT_BANK: PromptBank = {
  kind: 'pairs',
  lead: '',
  pairs: THIS_OR_THAT,
};

export const wouldYouRather = createSecretChoice({
  id: 'would-you-rather',
  name: 'Would You Rather',
  bank: WOULD_YOU_RATHER_BANK,
});

export const mostLikelyTo = createSecretChoice({
  id: 'most-likely-to',
  name: 'Most Likely To',
  bank: MOST_LIKELY_TO_BANK,
});

export const thisOrThat = createSecretChoice({
  id: 'this-or-that',
  name: 'This or That',
  bank: THIS_OR_THAT_BANK,
});

/**
 * Bank by game id, so a renderer holding only a definition can find the words.
 * The alternative was to hang the bank off the definition object itself, which
 * the GameDefinition contract has no field for and which would have made every
 * consumer of a game carry a game-specific cast.
 */
export const SECRET_CHOICE_BANKS: Readonly<Record<string, PromptBank>> = {
  [wouldYouRather.id]: WOULD_YOU_RATHER_BANK,
  [mostLikelyTo.id]: MOST_LIKELY_TO_BANK,
  [thisOrThat.id]: THIS_OR_THAT_BANK,
};
