import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ConnectionState,
  decodeCbor,
  encodeCbor,
  newUuidLike,
  systemRandom,
  type CborValue,
  type IncomingMessage,
} from '@airlink/core';
import {
  GameMode,
  GameSession,
  GameStatusKind,
  SnapshotInterpolator,
  findGame,
  type GameAction,
  type GameCatalogueEntry,
  type GameDefinition,
  type GameStatus,
  type PlayerId,
} from '@airlink/games';
import type { GameSessionRow } from '@airlink/db';
import type { AirLinkClient } from '../../client/AirLinkClient.js';
import { useClient } from '../../client/ClientProvider.js';
import { selectPeer, useAppStore } from '../../state/index.js';
import { strings } from '@airlink/config';
import type { FrameFeed, GameDispatch } from './contract.js';
import { playText } from './strings.js';
import {
  GAME_MESSAGE_TYPES,
  MessageType,
  decodeEvent,
  decodeInvite,
  decodeSnapshot,
  encodeEvent,
  encodeInvite,
  encodeSnapshot,
  sessionIdOf,
  trySend,
  trySendRealtime,
  type GameInvite,
} from './gameProtocol.js';
import { lerpFor } from './realtime.js';

/**
 * One game, from the invite to the rematch.
 *
 * This hook is the only place in the Play screens that knows a peer exists. It
 * owns a `GameSession` from @airlink/games, pushes local moves out over the
 * peer session, feeds remote ones back in, and hands the result to whichever
 * renderer draws that game. Everything below it sees a state and a dispatch.
 *
 * Both synchronisation models the runtime describes land here:
 *
 *   TURN-BASED  only actions travel, reliably and in order, and both devices
 *               replay them through the same reducer. The log is also written
 *               to the database, so a game survives the app being closed and is
 *               rebuilt by deterministic replay rather than by a state dump.
 *
 *   REALTIME    the host runs the authoritative tick and ships snapshots; the
 *               guest sends input and draws an interpolated view of the last
 *               two snapshots, so a snapshot arriving late costs a few
 *               milliseconds of lag instead of a visible jump.
 *
 * The board is never thrown away because the link dropped. A PeerSession owns
 * its keys and its reliability state and merely borrows a link, so a game
 * genuinely survives walking out of range and back; this hook keeps the state,
 * disables the inputs and says "Reconnecting…" rather than ending anything.
 */

export const RoomPhase = {
  /** Building the session; nothing is on screen yet. */
  PREPARING: 'preparing',
  /** The invite is out and we are waiting for the other phone. */
  INVITING: 'inviting',
  /** Nobody answered inside the window. Offer to ask again. */
  UNANSWERED: 'unanswered',
  /** They said not now. */
  DECLINED: 'declined',
  PLAYING: 'playing',
  /** The reducer says the game is over. */
  ENDED: 'ended',
  /** They closed the game on their side. */
  LEFT: 'left',
  /** We cannot start at all. `blockedReason` says why, in plain words. */
  UNAVAILABLE: 'unavailable',
} as const;
export type RoomPhase = (typeof RoomPhase)[keyof typeof RoomPhase];

/** The catalogue hands out `GameDefinition<never, never>`; so does everything here. */
type AnyDefinition = GameDefinition<never, never>;
type AnySession = GameSession<never, never>;

export interface GameRoomView {
  readonly phase: RoomPhase;
  readonly entry: GameCatalogueEntry | null;
  readonly state: unknown;
  readonly status: GameStatus | null;
  readonly turn: PlayerId | null;
  readonly lastAction: GameAction | null;
  readonly players: readonly PlayerId[];
  readonly local: PlayerId;
  readonly isHost: boolean;
  /** The link is up and the game can be played right now. */
  readonly live: boolean;
  readonly elapsedMs: number;
  readonly frames: FrameFeed<unknown> | null;
  readonly dispatch: GameDispatch;
  readonly nameFor: (player: PlayerId) => string;
  readonly opponentName: string;
  /** Why we cannot start, already phrased for a person. */
  readonly blockedReason: string | null;
  /**
   * This game's own id, passed through to the renderer.
   *
   * Only Battleship needs it: a commitment game keeps its fleet OFF the shared
   * state by definition, so that renderer files a private secret under this key
   * and finds it again after a restart - and, because the key changes with the
   * game, a rematch never reuses a layout the opponent has already seen.
   */
  readonly sessionKey: string;
  /** A rematch the other side has offered, waiting on an answer. */
  readonly incomingRematch: GameInvite | null;
  leave(): void;
  retryInvite(): void;
  /** Offer a fresh game of the same thing. Returns the route for it. */
  requestRematch(): RematchRoute | null;
  acceptRematch(): RematchRoute | null;
  declineRematch(): void;
}

export interface RematchRoute {
  readonly gameSessionId: string;
  readonly isHost: boolean;
}

export interface GameRoomParams {
  readonly peerKey: string;
  readonly gameId: string;
  readonly gameSessionId: string;
  readonly isHost: boolean;
}

/** How long to keep asking before admitting nobody is answering. */
const INVITE_WINDOW_MS = 45_000;
const INVITE_REPEAT_MS = 3_000;
/** Snapshots from the host of a realtime game: roughly fifteen a second. */
const SNAPSHOT_INTERVAL_MS = 66;
/** Render this far behind the newest snapshot so there is always one to aim at. */
const INTERPOLATION_DELAY_MS = 120;

export function useGameRoom(params: GameRoomParams): GameRoomView {
  const { peerKey, gameId, gameSessionId, isHost } = params;
  const client = useClient();
  const profile = useAppStore((s) => s.profile);
  const peerView = useAppStore(selectPeer(peerKey));

  const entry = useMemo(() => findGame(gameId) ?? null, [gameId]);

  const sessionRef = useRef<AnySession | null>(null);
  const playersRef = useRef<readonly PlayerId[]>([]);
  const eventIndexRef = useRef(0);
  const replayingRef = useRef(false);
  const frameListeners = useRef(new Set<(state: unknown, deltaMs: number) => void>());
  const interpolatorRef = useRef<SnapshotInterpolator<unknown> | null>(null);
  const remoteElapsedRef = useRef(0);
  const lastActionRef = useRef<GameAction | null>(null);
  const finishedWrittenRef = useRef(false);

  const [phase, setPhase] = useState<RoomPhase>(RoomPhase.PREPARING);
  const [blockedReason, setBlockedReason] = useState<string | null>(null);
  const [incomingRematch, setIncomingRematch] = useState<GameInvite | null>(null);
  const [connection, setConnection] = useState<ConnectionState>(
    () => client.peer(peerKey)?.session.state ?? ConnectionState.DISCONNECTED,
  );
  /**
   * The re-render trigger.
   *
   * The counter itself is never read - only bumped - because the board lives in
   * a ref rather than in state: a realtime game mutates it sixty times a second
   * and React must never see that. `bumpBoard()` is called only when something
   * DISCRETE changed, and the render it causes rebuilds the view below from the
   * ref. Hence the empty slot: there is no value here worth naming.
   */
  const [, forceRender] = useState(0);

  const handle = client.peer(peerKey);
  const localPlayer = profile?.peerId ?? '';
  const remotePlayer = handle?.session.peerId ?? null;
  const opponentName = handle?.session.capabilities?.displayName || peerView?.displayName || '';

  const nameFor = useCallback(
    (player: PlayerId): string => (player === localPlayer ? profile?.displayName ?? '' : opponentName),
    [localPlayer, opponentName, profile?.displayName],
  );

  const bumpBoard = useCallback(() => forceRender((n) => n + 1), []);

  // -- persistence ----------------------------------------------------------

  const persistAction = useCallback(
    (action: GameAction, encoded: CborValue) => {
      if (replayingRef.current) return;
      const session = sessionRef.current;
      try {
        client.db.games.appendEvent(
          gameSessionId,
          eventIndexRef.current,
          action.player,
          action.seq,
          encodeCbor(encoded),
          Date.now(),
        );
        eventIndexRef.current += 1;
        if (session) client.db.games.saveSnapshot(gameSessionId, encodeCbor(session.snapshot()), Date.now());
      } catch {
        // Losing the ability to resume later is never worth interrupting a game.
      }
    },
    [client, gameSessionId],
  );

  const persistOutcome = useCallback(
    (status: GameStatus) => {
      if (finishedWrittenRef.current || status.kind === GameStatusKind.IN_PROGRESS) return;
      finishedWrittenRef.current = true;
      const winner = status.kind === GameStatusKind.WON ? status.winners[0] ?? null : null;
      try {
        client.db.games.finish(gameSessionId, winner, status.kind, Date.now());
      } catch {
        // As above: a missing history row must not break the end-of-game screen.
      }
    },
    [client, gameSessionId],
  );

  // -- building the session -------------------------------------------------

  useEffect(() => {
    const definition = entry?.definition;
    if (!definition) {
      setBlockedReason(playText.tabs.noRenderer);
      setPhase(RoomPhase.UNAVAILABLE);
      return;
    }
    if (!handle || !remotePlayer || !localPlayer) {
      setBlockedReason(playText.tabs.notConnected);
      setPhase(RoomPhase.UNAVAILABLE);
      return;
    }

    const row = readOrCreateRow(client, { peerKey, gameId, gameSessionId, isHost }, definition, localPlayer, remotePlayer);
    if (!row) {
      setBlockedReason(strings.common.error);
      setPhase(RoomPhase.UNAVAILABLE);
      return;
    }

    let session: AnySession;
    try {
      session = new GameSession({
        definition,
        setup: { players: row.players, seed: row.seed, options: {} },
        localPlayer,
        isHost,
      });
    } catch {
      setBlockedReason(strings.common.error);
      setPhase(RoomPhase.UNAVAILABLE);
      return;
    }

    sessionRef.current = session;
    playersRef.current = row.players;
    finishedWrittenRef.current = false;
    lastActionRef.current = null;

    // A game already under way is rebuilt by replaying its own action log.
    // Deterministic replay is what makes this exact rather than approximate:
    // the same actions through the same reducer give the same board, byte for
    // byte, with nothing shipped over the link to do it.
    replayingRef.current = true;
    eventIndexRef.current = replayLog(client, gameSessionId, definition, session, localPlayer);
    replayingRef.current = false;

    interpolatorRef.current =
      definition.mode === GameMode.REALTIME && !isHost
        ? new SnapshotInterpolator<unknown>(lerpFor(definition.id), INTERPOLATION_DELAY_MS)
        : null;

    setBlockedReason(null);
    setPhase(row.state === 'active' || !isHost ? RoomPhase.PLAYING : RoomPhase.INVITING);
    bumpBoard();

    return () => {
      sessionRef.current = null;
      interpolatorRef.current = null;
    };
  }, [bumpBoard, client, entry, gameId, gameSessionId, handle, isHost, localPlayer, peerKey, remotePlayer]);

  // -- connection -----------------------------------------------------------

  useEffect(() => {
    setConnection(client.peer(peerKey)?.session.state ?? ConnectionState.DISCONNECTED);
    return client.events.on('connectionChanged', (event) => {
      if (event.peerKey === peerKey) setConnection(event.state);
    });
  }, [client, peerKey]);

  const live = connection === ConnectionState.CONNECTED;

  // -- incoming messages ----------------------------------------------------

  const handleMessage = useCallback(
    (message: IncomingMessage) => {
      const game = sessionRef.current;

      if (message.type === MessageType.GAME_STATE) {
        const snapshot = decodeSnapshot(message.raw);
        if (!snapshot || snapshot.sessionId !== gameSessionId || !game) return;
        remoteElapsedRef.current = snapshot.elapsedMs;
        const interpolator = interpolatorRef.current;
        if (interpolator) {
          try {
            interpolator.push(game.definition.decodeState(snapshot.state), message.receivedAt);
          } catch {
            // A snapshot we cannot decode is dropped; another is 66ms away.
          }
          return;
        }
        // Turn-based resync after a reconnect: a guest trusts the host.
        if (game.applySnapshot(snapshot.state)) bumpBoard();
        return;
      }

      if (message.type === MessageType.GAME_INVITE) {
        const invite = decodeInvite(message.value);
        // An invite naming THIS session is the other side repeating itself.
        if (!invite || invite.sessionId === gameSessionId || invite.gameId !== gameId) return;
        setIncomingRematch(invite);
        return;
      }

      if (sessionIdOf(message) !== gameSessionId) return;

      switch (message.type) {
        case MessageType.GAME_ACCEPT:
          setPhase((current) => (current === RoomPhase.INVITING || current === RoomPhase.UNANSWERED ? RoomPhase.PLAYING : current));
          setRowState(client, gameSessionId, 'active');
          break;

        case MessageType.GAME_DECLINE:
          setPhase(RoomPhase.DECLINED);
          setRowState(client, gameSessionId, 'declined');
          break;

        case MessageType.GAME_LEAVE:
        case MessageType.GAME_END:
          setPhase((current) => (current === RoomPhase.ENDED ? current : RoomPhase.LEFT));
          break;

        case MessageType.GAME_SYNC_REQUEST: {
          // Only the host is authoritative, so only the host answers.
          if (!isHost || !game || !handle) break;
          trySend(handle.session, MessageType.GAME_STATE, {
            s: gameSessionId,
            v: game.snapshot(),
            t: Math.round(game.simulatedMs),
          });
          break;
        }

        case MessageType.GAME_EVENT: {
          const event = decodeEvent(message.value);
          if (!event || !game || !remotePlayer) break;
          const outcome = game.applyRemote(event.action, remotePlayer);
          if (!outcome.accepted) break;
          lastActionRef.current = outcome.applied.action;
          persistAction(outcome.applied.action, event.action);
          const status = game.status;
          if (status.kind !== GameStatusKind.IN_PROGRESS) {
            persistOutcome(status);
            setPhase(RoomPhase.ENDED);
          }
          bumpBoard();
          break;
        }

        default:
          break;
      }
    },
    [bumpBoard, client, gameId, gameSessionId, handle, isHost, persistAction, persistOutcome, remotePlayer],
  );

  useEffect(() => {
    const session = handle?.session;
    if (!session) return;
    return session.events.on('message', (message) => {
      if (GAME_MESSAGE_TYPES.includes(message.type)) handleMessage(message);
    });
  }, [handle, handleMessage]);

  // -- the invite -----------------------------------------------------------

  const sendInvite = useCallback(() => {
    const game = sessionRef.current;
    if (!handle || !game) return;
    let row: GameSessionRow | null = null;
    try {
      row = client.db.games.get(gameSessionId);
    } catch {
      row = null;
    }
    if (!row) return;
    trySend(
      handle.session,
      MessageType.GAME_INVITE,
      encodeInvite({
        sessionId: gameSessionId,
        gameId,
        version: game.definition.protocolVersion,
        seed: row.seed,
        players: row.players,
      }),
    );
  }, [client, gameId, gameSessionId, handle]);

  useEffect(() => {
    if (phase !== RoomPhase.INVITING || !isHost) return;
    sendInvite();
    const started = Date.now();
    // Repeating the invite lets a friend who was on another tab still catch it.
    // It stops on its own, so nothing can sit here asking forever.
    const timer = setInterval(() => {
      if (Date.now() - started >= INVITE_WINDOW_MS) {
        clearInterval(timer);
        setPhase(RoomPhase.UNANSWERED);
        return;
      }
      sendInvite();
    }, INVITE_REPEAT_MS);
    return () => clearInterval(timer);
  }, [isHost, phase, sendInvite]);

  /**
   * A guest that walked into the room has, by definition, accepted; a host
   * resuming a saved game announces itself the same way, so a friend who is not
   * on the Play tab still gets asked to pick it back up.
   */
  useEffect(() => {
    if (phase !== RoomPhase.PLAYING || !handle || !live) return;
    if (isHost) sendInvite();
    else trySend(handle.session, MessageType.GAME_ACCEPT, { s: gameSessionId });
    setRowState(client, gameSessionId, 'active');
  }, [client, gameSessionId, handle, isHost, live, phase, sendInvite]);

  /** Ask for the current board whenever the link comes back. */
  useEffect(() => {
    if (!live || isHost || phase !== RoomPhase.PLAYING || !handle) return;
    trySend(handle.session, MessageType.GAME_SYNC_REQUEST, { s: gameSessionId });
  }, [gameSessionId, handle, isHost, live, phase]);

  // -- the realtime loop ----------------------------------------------------

  const mode = entry?.definition.mode ?? GameMode.TURN_BASED;

  useEffect(() => {
    if (mode !== GameMode.REALTIME || phase !== RoomPhase.PLAYING) return;

    let frame = 0;
    let last = Date.now();
    let lastSnapshotAt = 0;
    let cancelled = false;

    const step = (): void => {
      if (cancelled) return;
      const now = Date.now();
      // A frame that arrived after the app was backgrounded is capped rather
      // than simulated in full; the host's next snapshot corrects the guest.
      const delta = Math.min(now - last, 250);
      last = now;

      const game = sessionRef.current;
      if (game) {
        let drawable: unknown;
        if (isHost) {
          // The host runs the authoritative simulation. Everything drawn on
          // either device is a picture of what happens on this line.
          game.tick(delta);
          drawable = game.currentState;
          if (handle && now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
            lastSnapshotAt = now;
            trySendRealtime(
              handle.session,
              MessageType.GAME_STATE,
              encodeSnapshot(gameSessionId, game.snapshot(), game.simulatedMs),
              `game:${gameSessionId}`,
            );
          }
        } else {
          drawable = interpolatorRef.current?.sample(now) ?? game.currentState;
        }

        for (const listener of frameListeners.current) listener(drawable, delta);

        const status = game.status;
        if (status.kind !== GameStatusKind.IN_PROGRESS) {
          persistOutcome(status);
          setPhase(RoomPhase.ENDED);
          bumpBoard();
          return;
        }
      }
      frame = requestAnimationFrame(step);
    };

    frame = requestAnimationFrame(step);
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [bumpBoard, gameSessionId, handle, isHost, mode, persistOutcome, phase]);

  const frames = useMemo<FrameFeed<unknown> | null>(() => {
    if (mode !== GameMode.REALTIME) return null;
    const listeners = frameListeners.current;
    return {
      current: () => {
        const game = sessionRef.current;
        if (!game) return null;
        if (isHost) return game.currentState;
        return interpolatorRef.current?.sample(Date.now()) ?? game.currentState;
      },
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    };
  }, [isHost, mode]);

  // -- dispatch -------------------------------------------------------------

  const dispatch = useCallback<GameDispatch>(
    (type, payload) => {
      const game = sessionRef.current;
      if (!game || !handle) return false;
      const outcome = game.submitLocal(type, payload);
      if (!outcome.accepted) return false;

      const encoded = game.encode(outcome.applied.action);
      lastActionRef.current = outcome.applied.action;
      persistAction(outcome.applied.action, encoded);
      // Actions always travel reliably, even in a realtime game: the runtime
      // deduplicates on a per-player sequence number, so one dropped input
      // would stall every later one behind it.
      trySend(handle.session, MessageType.GAME_EVENT, encodeEvent(gameSessionId, encoded));

      const status = game.status;
      if (status.kind !== GameStatusKind.IN_PROGRESS) {
        persistOutcome(status);
        setPhase(RoomPhase.ENDED);
      }
      bumpBoard();
      return true;
    },
    [bumpBoard, gameSessionId, handle, persistAction, persistOutcome],
  );

  // -- leaving, and asking again --------------------------------------------

  const leave = useCallback(() => {
    const game = sessionRef.current;
    if (handle) trySend(handle.session, MessageType.GAME_LEAVE, { s: gameSessionId });

    // A game that reached a result has already been written by `persistOutcome`,
    // with its winner. Touching the row again here would replace "finished" with
    // "abandoned" and lose that, so a finished game is left exactly as it is.
    const finished = game ? game.status.kind !== GameStatusKind.IN_PROGRESS : false;
    if (finished) return;

    // A realtime game cannot honestly be resumed - its state is a function of
    // elapsed time, and there is no truthful way to pick a puck up where it was
    // left. Saying so in the row keeps it off the "in progress" shelf.
    const resumable = mode === GameMode.TURN_BASED && phase === RoomPhase.PLAYING;
    setRowState(client, gameSessionId, resumable ? 'active' : 'abandoned');
  }, [client, gameSessionId, handle, mode, phase]);

  const retryInvite = useCallback(() => setPhase(RoomPhase.INVITING), []);

  const requestRematch = useCallback((): RematchRoute | null => {
    if (!handle || !localPlayer || !remotePlayer || !entry) return null;
    const nextId = newUuidLike(systemRandom);
    const seed = seedFromRandom();
    // Whoever asks for the rematch hosts it, which also swaps who starts.
    const players = [localPlayer, remotePlayer];
    if (!createGameRow(client, nextId, entry.definition, seed, players, localPlayer)) return null;
    trySend(
      handle.session,
      MessageType.GAME_INVITE,
      encodeInvite({
        sessionId: nextId,
        gameId: entry.definition.id,
        version: entry.definition.protocolVersion,
        seed,
        players,
      }),
    );
    return { gameSessionId: nextId, isHost: true };
  }, [client, entry, handle, localPlayer, remotePlayer]);

  const acceptRematch = useCallback((): RematchRoute | null => {
    const invite = incomingRematch;
    if (!invite || !entry) return null;
    setIncomingRematch(null);
    const host = invite.players[0] ?? '';
    if (!createGameRow(client, invite.sessionId, entry.definition, invite.seed, invite.players, host)) return null;
    return { gameSessionId: invite.sessionId, isHost: host === localPlayer };
  }, [client, entry, incomingRematch, localPlayer]);

  const declineRematch = useCallback(() => {
    const invite = incomingRematch;
    setIncomingRematch(null);
    if (invite && handle) trySend(handle.session, MessageType.GAME_DECLINE, { s: invite.sessionId });
  }, [handle, incomingRematch]);

  // -- the view -------------------------------------------------------------

  /**
   * Built fresh on every render, deliberately.
   *
   * The board itself lives in a ref, not in state - a realtime game mutates it
   * sixty times a second and React must never see that. So what actually makes
   * this hook produce a NEW view is the render `bumpBoard()` forces whenever
   * something discrete changed: a move landed, the phase moved on, the link
   * came back. Memoising the object on top of that would only add a dependency
   * list that lies - it would have to name a ref it reads - to save building
   * one small object per render.
   */
  const session = sessionRef.current;

  return {
    phase,
    entry,
    state: session ? (session.currentState as unknown) : null,
    status: session ? session.status : null,
    turn: session ? session.turn : null,
    lastAction: lastActionRef.current,
    players: playersRef.current,
    local: localPlayer,
    isHost,
    live,
    elapsedMs: session ? (isHost ? session.simulatedMs : remoteElapsedRef.current) : 0,
    frames,
    dispatch,
    nameFor,
    opponentName,
    blockedReason,
    sessionKey: gameSessionId,
    incomingRematch,
    leave,
    retryInvite,
    requestRematch,
    acceptRematch,
    declineRematch,
  };
}

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

function seedFromRandom(): number {
  const bytes = systemRandom.randomBytes(4);
  return (((bytes[0] ?? 0) << 24) | ((bytes[1] ?? 0) << 16) | ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)) >>> 0;
}

function setRowState(client: AirLinkClient, id: string, state: 'active' | 'declined' | 'abandoned'): void {
  try {
    client.db.games.setState(id, state, Date.now());
  } catch {
    // A history row that will not write must never stop a game.
  }
}

/** Write the row for a game we are about to play. Returns false if it cannot. */
export function createGameRow(
  client: AirLinkClient,
  sessionId: string,
  definition: AnyDefinition,
  seed: number,
  players: readonly string[],
  hostPeerId: string,
): boolean {
  try {
    if (client.db.games.get(sessionId)) return true;
    const now = Date.now();
    client.db.games.create({
      id: sessionId,
      gameId: definition.id,
      gameVersion: definition.protocolVersion,
      conversationId: null,
      hostPeerId,
      seed,
      players: [...players],
      state: 'invited',
      createdAt: now,
      updatedAt: now,
    });
    return true;
  } catch {
    return false;
  }
}

function readOrCreateRow(
  client: AirLinkClient,
  params: GameRoomParams,
  definition: AnyDefinition,
  localPlayer: string,
  remotePlayer: string,
): GameSessionRow | null {
  try {
    const existing = client.db.games.get(params.gameSessionId);
    if (existing) return existing;
  } catch {
    return null;
  }
  // A guest's row is written the moment the invite lands, so if there is none
  // here we were never invited to this game and must not invent it.
  if (!params.isHost) return null;
  const seed = seedFromRandom();
  if (!createGameRow(client, params.gameSessionId, definition, seed, [localPlayer, remotePlayer], localPlayer)) {
    return null;
  }
  try {
    return client.db.games.get(params.gameSessionId);
  } catch {
    return null;
  }
}

/**
 * Rebuild a game in progress from its stored action log.
 *
 * The local player's own moves go back in through `submitLocal` rather than
 * `applyRemote`, because that is what keeps the session's outgoing sequence
 * counter in step - replaying our own moves as if they were someone else's
 * would make the very next move we made look like a duplicate.
 */
function replayLog(
  client: AirLinkClient,
  sessionId: string,
  definition: AnyDefinition,
  session: AnySession,
  localPlayer: string,
): number {
  let applied = 0;
  try {
    for (const event of client.db.games.events(sessionId)) {
      let decoded: CborValue;
      try {
        decoded = decodeCbor(event.payload);
      } catch {
        break;
      }
      if (event.playerPeerId === localPlayer) {
        let action: GameAction;
        try {
          action = definition.decodeAction(decoded, localPlayer);
        } catch {
          break;
        }
        if (!session.submitLocal(action.type, action.payload as CborValue).accepted) break;
      } else if (!session.applyRemote(decoded, event.playerPeerId).accepted) {
        break;
      }
      applied += 1;
    }
  } catch {
    return applied;
  }
  return applied;
}
