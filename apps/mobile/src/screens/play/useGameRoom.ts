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
  RejectionReason,
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
  INVITE_LIFETIME_MS,
  MessageType,
  decodeAck,
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
  /** The invite is going out; nothing has come back yet. */
  INVITING: 'inviting',
  /** The other phone acknowledged receipt. A person is now looking at it. */
  DELIVERED: 'delivered',
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
  /**
   * Why the board cannot be played, in words, or null when it can.
   *
   * Two very different things stop a board: the link is down, or the game is
   * over. They must never be reported as each other.
   */
  readonly disabledReason: string | null;
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
const INVITE_WINDOW_MS = INVITE_LIFETIME_MS;
/** First gap between retries. Doubles each time, up to the ceiling below. */
const INVITE_RETRY_BASE_MS = 1_000;
const INVITE_RETRY_MAX_MS = 8_000;
/** Snapshots from the host of a realtime game: roughly fifteen a second. */
const SNAPSHOT_INTERVAL_MS = 66;
/**
 * How often an UNCHANGED state is repeated anyway.
 *
 * A snapshot is only worth sending when the board has actually moved, and one
 * realtime game - pool - resolves a shot to rest inside `applyAction`, so its
 * table is byte-identical between shots and fifteen snapshots a second of it
 * would be a kilobyte a second of Bluetooth spent on nothing. But snapshots are
 * best-effort, and the last one of a rally is the one carrying the goal, so an
 * unchanged state still goes out at a slow heartbeat rather than never.
 */
const SNAPSHOT_KEEPALIVE_MS = 1_000;
/** Render this far behind the newest snapshot so there is always one to aim at. */
const INTERPOLATION_DELAY_MS = 120;
/** At most one "send me the board" per second, however many moves are missed. */
const RESYNC_INTERVAL_MS = 1_000;

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
  /**
   * The id of the asking currently in flight.
   *
   * A ref rather than state because the retry loop and the message handler both
   * need it and neither should cause a render by touching it. It changes only
   * when a NEW invitation is sent, which is what makes an acknowledgement for a
   * previous one - a rematch that was declined, an invite that timed out -
   * identifiable as stale and ignorable.
   */
  const inviteIdRef = useRef<string>('');
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

  /**
   * When we last asked for the position, so a stream of unappliable moves
   * produces one request rather than one per move.
   */
  const resyncRequestedAt = useRef(0);

  /**
   * Set when a move of OURS may never have reached the other phone.
   *
   * Two ways that happens, and neither of them looks like an error at the time:
   * `trySend` returns false because the session was not usable at that instant,
   * and the reliable channel gives up after its eight attempts and emits
   * `deliveryFailed`. In both cases the action has ALREADY been applied to this
   * device's board, so the two are now genuinely apart - and the side that
   * knows is this one, because the other side has simply seen nothing.
   *
   * The receiving side's own guard - asking for the board when an action
   * arrives out of order - cannot help here: nothing arrives. Somebody has to
   * notice the silence, and it has to be the sender.
   */
  const divergedRef = useRef(false);

  /**
   * "I have missed something - send me the board."
   *
   * A guest asks the host. The host is the authority, so it does not ask: it
   * simply publishes what it has, which repairs the guest that could not keep
   * up. Either way the exchange is bounded to one a second.
   */
  const requestResync = useCallback(() => {
    const now = Date.now();
    if (now - resyncRequestedAt.current < RESYNC_INTERVAL_MS) return;
    resyncRequestedAt.current = now;
    const game = sessionRef.current;
    const peer = client.peer(peerKey);
    if (!peer || !game) return;
    if (isHost) {
      trySendRealtime(
        peer.session,
        MessageType.GAME_STATE,
        encodeSnapshot(gameSessionId, game.snapshotEnvelope()),
        `sync:${gameSessionId}`,
      );
    } else {
      trySend(peer.session, MessageType.GAME_SYNC_REQUEST, { s: gameSessionId });
    }
  }, [client, gameSessionId, isHost, peerKey]);

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
        remoteElapsedRef.current = snapshot.envelope.elapsedMs;
        const interpolator = interpolatorRef.current;
        if (interpolator) {
          /**
           * A realtime guest FOLLOWS the host, in two senses.
           *
           * The interpolator smooths the picture between snapshots, and that is
           * all it does. The session state has to follow as well, because it is
           * what every non-drawing question is answered from: whether a local
           * action is legal (`submitLocal` validates against it - a guest whose
           * state stayed at the opening position can never serve again once the
           * first point has been played), and whether the game has been won.
           * Adopting the host's state is also the only resync a realtime guest
           * has, so an action lost on the link repairs itself on the next
           * snapshot instead of leaving the two devices permanently apart.
           *
           * A snapshot we cannot decode is dropped; another is along shortly.
           */
          if (!game.applySnapshotEnvelope(snapshot.envelope)) return;
          interpolator.push(game.currentState as unknown, message.receivedAt);
          const settled = game.status;
          if (settled.kind !== GameStatusKind.IN_PROGRESS) {
            persistOutcome(settled);
            setPhase(RoomPhase.ENDED);
            bumpBoard();
          }
          return;
        }
        // Turn-based resync after a reconnect, or after a move went missing.
        // The envelope carries the sequence counters as well as the board, so
        // this genuinely un-jams a guest rather than merely redrawing it.
        if (game.applySnapshotEnvelope(snapshot.envelope)) {
          resyncRequestedAt.current = 0;
          bumpBoard();
        }
        return;
      }

      // "Your invitation reached a listener." Not an answer - a receipt - and
      // the thing that finally lets this screen say something true.
      if (message.type === MessageType.GAME_INVITE_ACK) {
        const acked = decodeAck(message.value);
        if (acked && acked === inviteIdRef.current) {
          setPhase((current) => (current === RoomPhase.INVITING ? RoomPhase.DELIVERED : current));
        }
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
          setPhase((current) =>
            current === RoomPhase.INVITING ||
            current === RoomPhase.DELIVERED ||
            current === RoomPhase.UNANSWERED
              ? RoomPhase.PLAYING
              : current,
          );
          setRowState(client, gameSessionId, 'active');
          break;

        case MessageType.GAME_DECLINE:
          setPhase(RoomPhase.DECLINED);
          setRowState(client, gameSessionId, 'declined');
          break;

        case MessageType.GAME_LEAVE:
        case MessageType.GAME_END:
          /*
           * They have gone, so the game is over - and it has to be RECORDED as
           * over, which it never used to be. The row stayed 'active' for the
           * rest of the flight and kept offering to resume a game the other
           * person had already closed. `abandon` refuses a game that already
           * finished, so a leave arriving just after a checkmate cannot
           * overwrite the real result.
           */
          if (game && remotePlayer && game.abandon(remotePlayer)) {
            try {
              client.db.games.abandon(gameSessionId, remotePlayer, Date.now());
            } catch {
              // A history row that will not write must not stop the screen
              // telling the user what happened.
            }
            finishedWrittenRef.current = true;
          }
          setPhase((current) => (current === RoomPhase.ENDED ? current : RoomPhase.LEFT));
          break;

        case MessageType.GAME_SYNC_REQUEST: {
          // Only the host is authoritative, so only the host answers.
          if (!isHost || !game || !handle) break;
          trySendRealtime(
            handle.session,
            MessageType.GAME_STATE,
            encodeSnapshot(gameSessionId, game.snapshotEnvelope()),
            `sync:${gameSessionId}`,
          );
          break;
        }

        case MessageType.GAME_EVENT: {
          const event = decodeEvent(message.value);
          if (!event || !game || !remotePlayer) break;
          const outcome = game.applyRemote(event.action, remotePlayer);
          if (!outcome.accepted) {
            /*
             * A move we cannot apply is not a move to shrug at.
             *
             * OUT_OF_ORDER means one earlier action never arrived, and every
             * action after it will be rejected for the same reason - for ever,
             * because nothing was ever going to fill the gap. The board looked
             * alive and silently accepted nothing. So: ask for the position.
             * A guest asks the host; the host, which is authoritative, simply
             * sends its own. DUPLICATE is the reliability layer doing its job
             * and is ignored.
             */
            if (outcome.reason === RejectionReason.OUT_OF_ORDER && handle) requestResync();
            break;
          }
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
    [bumpBoard, client, gameId, gameSessionId, handle, isHost, persistAction, persistOutcome, remotePlayer, requestResync],
  );

  useEffect(() => {
    const session = handle?.session;
    if (!session) return;
    const offs = [
      session.events.on('message', (message) => {
        if (GAME_MESSAGE_TYPES.includes(message.type)) handleMessage(message);
      }),
      /*
       * The reliability layer giving up.
       *
       * It retransmits eight times and then drops the record, and until now it
       * told nobody who could act on it: the session stays CONNECTED, `live`
       * stays true, and the board carries on looking healthy while the two
       * devices are permanently a move apart. Nothing in this app subscribed to
       * this event at all.
       */
      session.events.on('deliveryFailed', ({ messageType }) => {
        if (messageType !== MessageType.GAME_EVENT) return;
        divergedRef.current = true;
        requestResync();
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [handle, handleMessage, requestResync]);

  /**
   * Repair as soon as there is somewhere to repair to.
   *
   * A move lost while the link was down cannot be fixed until it is back, so
   * the flag waits rather than firing into a closed session. The host publishes
   * its board because it is authoritative; a guest asks for one, which will
   * revert the move it made - correctly, because as far as the rest of the
   * world is concerned that move never happened.
   */
  useEffect(() => {
    if (!live || !divergedRef.current) return;
    divergedRef.current = false;
    requestResync();
  }, [live, requestResync]);

  // -- the invite -----------------------------------------------------------

  const sendInvite = useCallback(
    (inviteId: string, expiresAt: number) => {
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
          inviteId,
          sessionId: gameSessionId,
          gameId,
          version: game.definition.protocolVersion,
          seed: row.seed,
          players: row.players,
          expiresAt,
        }),
      );
    },
    [client, gameId, gameSessionId, handle],
  );

  /**
   * Ask, and keep asking until the other phone says it heard.
   *
   * Retries back off - a second, then two, then four, up to eight - rather than
   * hammering a link that is already struggling, which is the shape of the only
   * link some of these phones have. The moment `GAME_INVITE_ACK` arrives the
   * loop stops entirely: from then on the wait is a person deciding, not a
   * radio, and repeating the question would be pointless.
   *
   * Nothing here is unbounded. The whole thing gives up at `INVITE_WINDOW_MS`,
   * which is also the moment the invitation expires on the other phone, so both
   * sides stop believing in it together.
   */
  useEffect(() => {
    if (phase !== RoomPhase.INVITING || !isHost) return;

    const inviteId = newUuidLike(systemRandom).slice(0, 20);
    const started = Date.now();
    const expiresAt = started + INVITE_WINDOW_MS;
    inviteIdRef.current = inviteId;

    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    const ask = (): void => {
      if (cancelled) return;
      if (Date.now() >= expiresAt) {
        setPhase(RoomPhase.UNANSWERED);
        return;
      }
      sendInvite(inviteId, expiresAt);
      attempt += 1;
      const delay = Math.min(INVITE_RETRY_BASE_MS * 2 ** (attempt - 1), INVITE_RETRY_MAX_MS);
      timer = setTimeout(ask, delay);
    };

    ask();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [isHost, phase, sendInvite]);

  /**
   * Delivered, but still unanswered.
   *
   * The retry loop above has stopped, so this is the only thing left keeping
   * time. Without it a delivered-but-ignored invitation would wait for ever.
   */
  useEffect(() => {
    if (phase !== RoomPhase.DELIVERED) return;
    const timer = setTimeout(() => setPhase(RoomPhase.UNANSWERED), INVITE_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  /**
   * A guest that walked into the room has, by definition, accepted; a host
   * resuming a saved game announces itself the same way, so a friend who is not
   * on the Play tab still gets asked to pick it back up.
   */
  useEffect(() => {
    if (phase !== RoomPhase.PLAYING || !handle || !live) return;
    if (isHost) {
      const inviteId = inviteIdRef.current || newUuidLike(systemRandom).slice(0, 20);
      inviteIdRef.current = inviteId;
      sendInvite(inviteId, Date.now() + INVITE_WINDOW_MS);
    } else {
      trySend(handle.session, MessageType.GAME_ACCEPT, { s: gameSessionId, i: inviteIdRef.current });
    }
    setRowState(client, gameSessionId, 'active');
  }, [client, gameSessionId, handle, isHost, live, phase, sendInvite]);

  /**
   * Tell the other phone when this one cannot play after all.
   *
   * A room that cannot build its board - a game this build cannot draw, a row
   * that would not write, a peer whose session went away between accepting and
   * opening - used to fail silently on this side while the inviting phone went
   * on saying "Waiting for your friend" until its window closed. Nobody
   * declined; the answer simply never came. A guest owes the host a real answer
   * whichever way it goes.
   */
  useEffect(() => {
    if (phase !== RoomPhase.UNAVAILABLE || isHost) return;
    const peer = client.peer(peerKey);
    if (!peer) return;
    trySend(peer.session, MessageType.GAME_DECLINE, { s: gameSessionId, i: inviteIdRef.current });
  }, [client, gameSessionId, isHost, peerKey, phase]);

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
    let lastSentAt = 0;
    /** The state object behind the last snapshot sent. Identity is the test. */
    let lastSentState: unknown = null;
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
            // A reducer returns the SAME object when a step changed nothing, so
            // identity is an exact and free test for "the board has not moved".
            const moved = drawable !== lastSentState;
            if (moved || now - lastSentAt >= SNAPSHOT_KEEPALIVE_MS) {
              lastSentState = drawable;
              lastSentAt = now;
              trySendRealtime(
                handle.session,
                MessageType.GAME_STATE,
                encodeSnapshot(gameSessionId, game.snapshotEnvelope()),
                `game:${gameSessionId}`,
              );
            }
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
      // Read before applying: this is the version the other device must already
      // be at for this action to make sense on top of it.
      const previousVersion = game.stateVersion;
      const outcome = game.submitLocal(type, payload);
      if (!outcome.accepted) return false;

      const encoded = game.encode(outcome.applied.action);
      lastActionRef.current = outcome.applied.action;
      persistAction(outcome.applied.action, encoded);
      // Actions always travel reliably, even in a realtime game: the runtime
      // deduplicates on a per-player sequence number, so one dropped input
      // would stall every later one behind it.
      if (!trySend(handle.session, MessageType.GAME_EVENT, encodeEvent(gameSessionId, encoded, previousVersion))) {
        // Applied here, never sent. Repaired as soon as there is a link again.
        divergedRef.current = true;
      }

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
        inviteId: newUuidLike(systemRandom).slice(0, 20),
        sessionId: nextId,
        gameId: entry.definition.id,
        version: entry.definition.protocolVersion,
        seed,
        players,
        expiresAt: Date.now() + INVITE_WINDOW_MS,
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
    disabledReason: !live
      ? playText.room.waitingForLink
      : phase === RoomPhase.PLAYING
      ? null
      : playText.room.gameFinished,
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
