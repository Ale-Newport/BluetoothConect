import { useSyncExternalStore } from 'react';
import { ConnectionState, type IncomingMessage } from '@airlink/core';
import { findGame } from '@airlink/games';
import type { AirLinkClient } from '../../client/AirLinkClient.js';
import { MessageType, decodeInvite, trySend } from './gameProtocol.js';
import { createGameRow } from './useGameRoom.js';
import { hasRenderer } from './games/index.js';
import { useOptionalClient } from './useOptionalClient.js';

/**
 * The other half of an invitation.
 *
 * `useGameRoom` sends `GAME_INVITE` and waits. Something has to be LISTENING
 * for it on the other phone, or a game can never be started at all: the invited
 * player has no room open, so nothing of theirs is subscribed to that message,
 * and the host sits asking for forty-five seconds and then says "No answer" -
 * which is a lie, because the answer never had anywhere to arrive.
 *
 * This is that listener, and it is shaped exactly like the Share tab's transfer
 * centre for the same reason: one instance per client, held for the client's
 * lifetime, written to from outside React by session events, read through
 * `useSyncExternalStore`. An invitation is a question with a deadline, so it is
 * offered while the Play tab is in front and then quietly expires - nothing is
 * queued up to ambush somebody an hour later.
 *
 * WHAT IT DOES ON ARRIVAL, before anybody is asked anything:
 *
 *   - An invite for a game this build cannot play is DECLINED immediately,
 *     rather than left to time out. The other phone gets a real answer.
 *   - An invite for a game whose row already exists is ignored: it is the host
 *     repeating itself, or announcing a game that is already on the shelf.
 *   - The row is written from the invite - the seed, the seat order, the game -
 *     so that accepting opens a room that builds a byte-identical starting
 *     state without another round trip. The room refuses to invent that row
 *     itself, and it is right to.
 *
 * Being a per-client singleton created on first use, this only starts listening
 * once something has read it - today, the Play tab. Mounting it once next to the
 * navigator would make an invitation reachable from any tab; that belongs in the
 * navigator's own file, not here. See the report.
 */

/** An invitation waiting on an answer, as a screen needs to see it. */
export interface GameInviteRecord {
  readonly sessionId: string;
  /** The peer, for navigation. Never rendered. */
  readonly peerKey: string;
  /** Stable identity, only ever used to colour an avatar. Never rendered. */
  readonly peerId: string | null;
  readonly peerName: string;
  readonly gameId: string;
  /** The game's own name, from the catalogue. */
  readonly gameName: string;
  /** True if the seat order makes THIS device the host. Normally false. */
  readonly isHost: boolean;
  readonly receivedAt: number;
}

/** How long an invitation is worth showing. The host stops asking at 45s. */
export const INVITE_LIFETIME_MS = 45_000;

const NO_INVITES: readonly GameInviteRecord[] = [];

class GameInviteCentre {
  private readonly invites = new Map<string, GameInviteRecord>();
  /** Sessions already answered, so a repeated invite is not asked twice. */
  private readonly settled = new Set<string>();
  private readonly bindings = new Map<string, (() => void)[]>();
  private readonly listeners = new Set<() => void>();
  private readonly clientOffs: (() => void)[] = [];

  /** Stable between changes, so `useSyncExternalStore` behaves. */
  private snapshotCache: readonly GameInviteRecord[] = NO_INVITES;

  constructor(private readonly client: AirLinkClient) {
    this.clientOffs.push(
      client.events.on('connectionChanged', ({ peerKey, state }) => {
        if (state === ConnectionState.CONNECTED) this.attach(peerKey);
        else this.detach(peerKey);
      }),
    );
    // A friend may already be connected by the time this is first read, so
    // nothing here waits for an event that has already happened.
    for (const handle of client.connectedPeers()) this.attach(handle.key);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  list = (): readonly GameInviteRecord[] => this.snapshotCache;

  /**
   * Take the invitation. The row is already written, so the caller only has to
   * open the room.
   */
  accept(sessionId: string): GameInviteRecord | null {
    const record = this.invites.get(sessionId);
    if (!record) return null;
    this.settled.add(sessionId);
    this.invites.delete(sessionId);
    this.publish();
    return record;
  }

  /**
   * Forget an invitation without answering it.
   *
   * For the one case where it has already been answered somewhere else: a
   * rematch accepted inside the room the two players were already in. The room
   * owns that conversation, and this must not offer it a second time.
   */
  forget(sessionId: string): void {
    this.settled.add(sessionId);
    if (this.invites.delete(sessionId)) this.publish();
  }

  /** Say no, out loud: the other phone stops asking instead of timing out. */
  decline(sessionId: string): void {
    const record = this.invites.get(sessionId);
    this.settled.add(sessionId);
    this.invites.delete(sessionId);
    this.publish();
    if (!record) return;
    const handle = this.client.peer(record.peerKey);
    if (handle) trySend(handle.session, MessageType.GAME_DECLINE, { s: sessionId });
  }

  // -- sessions --------------------------------------------------------------

  private attach(peerKey: string): void {
    if (this.bindings.has(peerKey)) return;
    const handle = this.client.peer(peerKey);
    if (!handle || handle.session.state !== ConnectionState.CONNECTED) return;
    this.bindings.set(peerKey, [
      handle.session.events.on('message', (message) => {
        if (message.type === MessageType.GAME_INVITE) this.onInvite(peerKey, message);
      }),
      handle.session.events.on('closed', () => this.detach(peerKey)),
    ]);
  }

  private detach(peerKey: string): void {
    const offs = this.bindings.get(peerKey);
    if (!offs) return;
    for (const off of offs) off();
    this.bindings.delete(peerKey);
  }

  private onInvite(peerKey: string, message: IncomingMessage): void {
    const invite = decodeInvite(message.value);
    if (!invite) return;
    if (this.settled.has(invite.sessionId) || this.invites.has(invite.sessionId)) return;

    const me = this.client.profile?.peerId;
    // An invitation that does not name this device is not ours to answer.
    if (!me || !invite.players.includes(me)) return;

    const handle = this.client.peer(peerKey);
    if (!handle) return;

    const entry = findGame(invite.gameId);
    const playable =
      entry !== undefined &&
      hasRenderer(invite.gameId) &&
      invite.players.length === 2 &&
      entry.definition.protocolVersion === invite.version;

    if (!entry || !playable) {
      // Better a plain "not now" than forty-five seconds of a spinner on the
      // other phone. The tile on THIS device already explains the mismatch.
      this.settled.add(invite.sessionId);
      trySend(handle.session, MessageType.GAME_DECLINE, { s: invite.sessionId });
      return;
    }

    let existing = false;
    try {
      existing = this.client.db.games.get(invite.sessionId) !== null;
    } catch {
      existing = false;
    }
    // A row we already hold means this game is known: the host repeating its
    // invite, or announcing one that is already on the "in progress" shelf.
    if (existing) return;

    const host = invite.players[0] ?? me;
    if (!createGameRow(this.client, invite.sessionId, entry.definition, invite.seed, invite.players, host)) return;

    this.prune();
    this.invites.set(invite.sessionId, {
      sessionId: invite.sessionId,
      peerKey,
      peerId: handle.session.peerId,
      peerName: handle.session.capabilities?.displayName ?? '',
      gameId: invite.gameId,
      gameName: entry.definition.name,
      isHost: host === me,
      receivedAt: Date.now(),
    });
    this.publish();
  }

  /** Drop invitations the other phone has already given up on. */
  private prune(): void {
    const cutoff = Date.now() - INVITE_LIFETIME_MS;
    for (const [id, record] of this.invites) {
      if (record.receivedAt < cutoff) this.invites.delete(id);
    }
  }

  private publish(): void {
    this.snapshotCache = this.invites.size === 0 ? NO_INVITES : [...this.invites.values()];
    for (const listener of this.listeners) listener();
  }
}

export type { GameInviteCentre };

/**
 * One centre per client, for the client's lifetime.
 *
 * A `WeakMap` rather than a module variable so a second client - a future
 * multi-profile build, or a test - does not inherit another one's invitations.
 */
const centres = new WeakMap<AirLinkClient, GameInviteCentre>();

export function inviteCentreFor(client: AirLinkClient): GameInviteCentre {
  const existing = centres.get(client);
  if (existing) return existing;
  const created = new GameInviteCentre(client);
  centres.set(client, created);
  return created;
}

/** The centre, or null while the client is still coming up. */
export function useInviteCentre(): GameInviteCentre | null {
  const client = useOptionalClient();
  return client ? inviteCentreFor(client) : null;
}

/** Stable no-op source for the window before the client exists. */
const noSubscribe = (): (() => void) => (): void => undefined;
const noInvites = (): readonly GameInviteRecord[] => NO_INVITES;

export function useGameInvites(): readonly GameInviteRecord[] {
  const centre = useInviteCentre();
  return useSyncExternalStore(centre?.subscribe ?? noSubscribe, centre?.list ?? noInvites);
}

/**
 * The oldest invitation still worth asking about, or null.
 *
 * Freshness is judged when the screen renders rather than on a timer: the point
 * is never to ASK about an invitation the other phone has given up on, and a
 * sheet already open is still worth answering - a late acceptance is taken.
 */
export function useNextInvite(): GameInviteRecord | null {
  const invites = useGameInvites();
  return invites.find((record) => Date.now() - record.receivedAt < INVITE_LIFETIME_MS) ?? null;
}
