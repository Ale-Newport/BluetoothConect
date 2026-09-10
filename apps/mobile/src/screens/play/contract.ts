import type React from 'react';
import type { CborValue } from '@airlink/core';
import type { GameAction, PlayerId } from '@airlink/games';

/**
 * The one contract every game renderer implements.
 *
 * A renderer receives STATE and a DISPATCH and returns a view. It never opens a
 * session, never touches the peer, never decides whether a move is legal and
 * never mutates anything - the rules live in @airlink/games and are the same
 * code the tests and the headless simulator run. That separation is the whole
 * reason one GameRoom screen can host twelve very different games.
 *
 * Dispatch returns false when the reducer refused the move. A renderer should
 * use that to shake a piece back, not to explain itself: the room already knows
 * whose turn it is and says so at the top of the screen.
 */
export type GameDispatch = (type: string, payload: CborValue) => boolean;

/**
 * A per-frame feed, provided ONLY for realtime games (Pong, Air Hockey, Pool).
 *
 * Realtime state moves sixty times a second, which is far too fast to push
 * through React without dropping frames. So the room hands continuous games
 * this imperative feed instead: subscribe once, then write the numbers straight
 * into Reanimated shared values that Skia reads on the UI thread. React is left
 * to re-render only when something discrete changes - a goal, a serve, a win.
 */
export interface FrameFeed<TState> {
  /** The state to draw right now: authoritative on the host, interpolated on a guest. */
  current(): TState;
  /** Called once per animation frame with the state to draw and the frame delta. */
  subscribe(listener: (state: TState, deltaMs: number) => void): () => void;
}

export interface GameRendererProps<TState> {
  readonly state: TState;
  readonly dispatch: GameDispatch;
  /** The device's own player. Never render this as an id - use `nameFor`. */
  readonly local: PlayerId;
  /** Seat order, identical on both devices. Index 0 hosts. */
  readonly players: readonly PlayerId[];
  readonly isHost: boolean;
  /** A person's name. The only thing a player id may ever be turned into. */
  readonly nameFor: (player: PlayerId) => string;
  readonly turn: PlayerId | null;
  /** The move that was just applied, whoever played it. Drives "last move" marks. */
  readonly lastAction: GameAction | null;
  /**
   * False while the link is down. Inputs must go disabled with a reason and the
   * board must stay exactly as it is - the session survives a reconnect and so
   * must what the user is looking at.
   */
  readonly live: boolean;
  /**
   * Why the board cannot be played right now, already phrased for a person.
   * Null exactly when `live` is true.
   *
   * A renderer must use THIS rather than assuming a dead board means a dead
   * link: `live` is also false once the game is over, and a finished game that
   * says "Waiting for the connection" under a perfectly good connection is the
   * kind of small lie that makes a whole app feel untrustworthy.
   */
  readonly disabledReason: string | null;
  /** Realtime games only; null for turn-based ones. */
  readonly frames: FrameFeed<TState> | null;
  /** Simulated milliseconds since the game started. 0 for turn-based games. */
  readonly elapsedMs: number;
  /** Width available to the board, already inside the screen's padding. */
  readonly width: number;
  /**
   * An opaque, stable id for THIS game.
   *
   * Present for one reason: Battleship. A commitment game keeps its fleet off
   * the shared state by definition, so that renderer has to file a private
   * secret somewhere and find it again after a restart - and it must not find
   * the PREVIOUS game's fleet, or its own reveal would fail the audit and it
   * would look like a cheat. Nothing else needs this, and nothing may render it.
   */
  readonly sessionKey: string;
}

export type GameRenderer<TState> = (props: GameRendererProps<TState>) => React.JSX.Element;
