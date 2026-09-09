import { useEffect, useRef, useState } from 'react';
import {
  ConnectionState,
  ContentAvailability,
  DriftAction,
  SyncRole,
  WatchState,
  WatchTogetherSession,
  systemClock,
  systemRandom,
  type ContentIdentity,
  type MediaController,
} from '@airlink/core';
import { useClient } from '../../client/ClientProvider.js';
import { selectPeer, useAppStore } from '../../state/index.js';

/**
 * Owns one `WatchTogetherSession` for the life of the screen and projects its
 * events into the handful of facts the interface actually renders.
 *
 * The protocol object is created from the peer's live `PeerSession`, which means
 * it exists only while there is somebody to talk to - and is torn down when the
 * user walks away, telling the peer rather than leaving them staring at a film
 * nobody is driving any more.
 *
 * Nothing technical escapes this hook. Reasons, reject codes and session ids
 * stay inside it; what comes out is "the peer has it", "no answer", "catching
 * up".
 */

export interface SyncInvite {
  readonly sessionId: string;
  readonly content: ContentIdentity;
}

/** Why the pre-session flow stopped. Each one has a way forward on screen. */
export const SetupOutcome = {
  /** The peer answered, and does not hold the same file. */
  PEER_MISSING: 'peerMissing',
  /** The peer holds something close but not identical. */
  PEER_MISMATCH: 'peerMismatch',
  /** Nobody answered in time - usually the peer has not opened this screen. */
  NO_ANSWER: 'noAnswer',
} as const;
export type SetupOutcome = (typeof SetupOutcome)[keyof typeof SetupOutcome];

export interface WatchTogetherApi {
  /** Null until the peer session exists. Everything below is meaningless then. */
  readonly session: WatchTogetherSession | null;
  /** True when a command would actually reach the peer. */
  readonly linkUp: boolean;
  readonly watchState: WatchState;
  readonly role: SyncRole | null;
  readonly peerJoined: boolean;
  readonly invite: SyncInvite | null;
  readonly outcome: SetupOutcome | null;
  /** True while a drift correction is being applied. */
  readonly correcting: boolean;
  /** What the shared line says: playing, or parked. */
  readonly anchorPlaying: boolean;
  readonly finished: boolean;
  clearOutcome(): void;
  clearInvite(): void;
  clearFinished(): void;
}

/**
 * How long "Catching up…" may stay on screen without a fresh correction.
 *
 * The correction loop stops emitting once playback is parked or the session
 * ends, and an indicator with no way of switching itself off is exactly the
 * spinner-for-ever this app does not have anywhere else.
 */
const CORRECTION_LINGER_MS = 4_000;

export function useWatchTogether(peerKey: string, media: MediaController): WatchTogetherApi {
  const client = useClient();
  const peer = useAppStore(selectPeer(peerKey));
  const connection = peer?.connection ?? ConnectionState.DISCONNECTED;

  // Re-read on every render, but the object identity is stable for the life of
  // the peer - so the effect below runs once per real session, not once per
  // connection-state wobble.
  const peerSession = client.peer(peerKey)?.session ?? null;

  const [session, setSession] = useState<WatchTogetherSession | null>(null);
  const [watchState, setWatchState] = useState<WatchState>(WatchState.IDLE);
  const [role, setRole] = useState<SyncRole | null>(null);
  const [peerJoined, setPeerJoined] = useState(false);
  const [invite, setInvite] = useState<SyncInvite | null>(null);
  const [outcome, setOutcome] = useState<SetupOutcome | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [anchorPlaying, setAnchorPlaying] = useState(false);
  const [finished, setFinished] = useState(false);
  const lingerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    if (!peerSession) {
      setSession(null);
      return;
    }

    const watch = new WatchTogetherSession({
      session: peerSession,
      clock: systemClock,
      media,
      random: systemRandom,
      // The peer's invitation is a question for this user, not something to
      // accept behind their back - and they have to point at their own copy of
      // the file before there is anything to play.
      autoJoin: false,
    });

    const markCorrecting = (active: boolean): void => {
      setCorrecting(active);
      if (lingerRef.current !== undefined) clearTimeout(lingerRef.current);
      if (!active) return;
      lingerRef.current = setTimeout(() => setCorrecting(false), CORRECTION_LINGER_MS);
    };

    const subscriptions = [
      watch.events.on('stateChanged', (event) => {
        setWatchState(event.state);
        setRole(event.role);
      }),

      watch.events.on('invited', (event) => {
        setInvite({ sessionId: event.sessionId, content: event.content });
      }),

      watch.events.on('contentUnavailable', (event) => {
        setOutcome(
          event.availability === ContentAvailability.MISMATCH
            ? SetupOutcome.PEER_MISMATCH
            : SetupOutcome.PEER_MISSING,
        );
      }),

      watch.events.on('contentQueryTimedOut', () => setOutcome(SetupOutcome.NO_ANSWER)),

      watch.events.on('peerJoined', () => setPeerJoined(true)),

      watch.events.on('anchorChanged', (event) => setAnchorPlaying(event.anchor.playing)),

      watch.events.on('correction', (event) => markCorrecting(event.correction.action !== DriftAction.IGNORE)),

      watch.events.on('ended', () => {
        setPeerJoined(false);
        setAnchorPlaying(false);
        setInvite(null);
        markCorrecting(false);
        setFinished(true);
      }),
    ];

    setSession(watch);

    return () => {
      for (const off of subscriptions) off();
      if (lingerRef.current !== undefined) clearTimeout(lingerRef.current);
      // Walking off the screen leaves the party. The peer is told, because the
      // alternative is their player being corrected against a line nobody is
      // publishing any more.
      watch.end('left');
      watch.dispose();
      setSession(null);
    };
  }, [peerSession, media]);

  return {
    session,
    linkUp: connection === ConnectionState.CONNECTED,
    watchState,
    role,
    peerJoined,
    invite,
    outcome,
    correcting,
    anchorPlaying,
    finished,
    clearOutcome: () => setOutcome(null),
    clearInvite: () => setInvite(null),
    clearFinished: () => setFinished(false),
  };
}
