import { useSyncExternalStore } from 'react';
import { ConnectionState, type IncomingMessage } from '@airlink/core';
import { findGame } from '@airlink/games';
import type { AirLinkClient } from '../../client/AirLinkClient.js';
import {
  INVITE_LIFETIME_MS,
  MessageType,
  decodeAck,
  decodeInvite,
  encodeAck,
  trySend,
} from './gameProtocol.js';
import { createGameRow } from './useGameRoom.js';
import { hasRenderer } from './games/index.js';
import { useOptionalClient } from './useOptionalClient.js';

/**
 * The other half of an invitation, and the reason one used to vanish.
 *
 * `useGameRoom` sends `GAME_INVITE` and waits. Something has to be LISTENING
 * for it on the other phone. This is that listener - and until now it was built
 * lazily by the Play tab, which is a LAZY bottom tab, so on a phone that had
 * not opened Play since launch it did not exist at all. The invitation was
 * decrypted, acknowledged by the reliability layer, delivered to zero
 * subscribers and dropped, while the other phone said "Waiting for your
 * friend…" for forty-five seconds and then lied about there being no answer.
 *
 * It is now built by `ClientProvider` at startup, exactly like the chat centre
 * next to it and for exactly the same reason, and the question it produces is
 * rendered by a host mounted beside the navigator rather than inside one tab.
 * An invitation is reachable from anywhere in the app.
 *
 * WHAT IT DOES ON ARRIVAL, before anybody is asked anything:
 *
 *   - ACKNOWLEDGES IT, immediately and always. That single message is what lets
 *     the asking phone say "Delivered" instead of guessing, and what lets it
 *     stop retrying. It is sent before any judgement is made about whether the
 *     game is playable, because the question being asked is "did this arrive?",
 *     not "will you play?".
 *   - An invite for a game this build cannot play is DECLINED immediately,
 *     rather than left to time out.
 *   - A REPEAT IS IDEMPOTENT. The same `inviteId` arriving ten times produces
 *     one question, one row and one acknowledgement each time.
 *   - The row is written from the invite - the seed, the seat order, the game -
 *     so that accepting opens a room that builds a byte-identical starting
 *     state without another round trip.
 */

/** An invitation waiting on an answer, as a screen needs to see it. */
export interface GameInviteRecord {
  readonly inviteId: string;
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
  readonly expiresAt: number;
}

export { INVITE_LIFETIME_MS };

const NO_INVITES: readonly GameInviteRecord[] = [];

/**
 * How many answered invitations are remembered.
 *
 * Enough that a retry storm on a bad link cannot re-ask something already
 * answered, and bounded so a long flight cannot grow it without limit. The old
 * set had no ceiling at all.
 */
const SETTLED_MEMORY = 128;

class GameInviteCentre {
  private readonly invites = new Map<string, GameInviteRecord>();
  /** Invites already answered, newest last, so a repeat is not asked twice. */
  private readonly settled = new Set<string>();
  private readonly bindings = new Map<string, (() => void)[]>();
  private readonly listeners = new Set<() => void>();
  private readonly clientOffs: (() => void)[] = [];
  /** inviteId -> the peer that asked, so an ack can be repeated on a retry. */
  private readonly acknowledged = new Map<string, string>();

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
  accept(inviteId: string): GameInviteRecord | null {
    const record = this.invites.get(inviteId);
    if (!record) return null;
    this.settle(inviteId);
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
  forget(inviteId: string): void {
    this.settle(inviteId);
    if (this.invites.delete(inviteId)) this.publish();
  }

  /** Say no, out loud: the other phone stops asking instead of timing out. */
  decline(inviteId: string): void {
    const record = this.invites.get(inviteId);
    this.settle(inviteId);
    this.publish();
    if (!record) return;
    const handle = this.client.peer(record.peerKey);
    if (handle) trySend(handle.session, MessageType.GAME_DECLINE, { s: record.sessionId, i: inviteId });
  }

  /** Every invitation still open, for Developer Mode. */
  diagnostics(): { inviteId: string; gameId: string; peerId: string | null; expiresAt: number }[] {
    return [...this.invites.values()].map((r) => ({
      inviteId: r.inviteId,
      gameId: r.gameId,
      peerId: r.peerId,
      expiresAt: r.expiresAt,
    }));
  }

  dispose(): void {
    for (const off of this.clientOffs) off();
    this.clientOffs.length = 0;
    for (const offs of this.bindings.values()) for (const off of offs) off();
    this.bindings.clear();
    this.listeners.clear();
    this.invites.clear();
  }

  // -- sessions --------------------------------------------------------------

  private attach(peerKey: string): void {
    const handle = this.client.peer(peerKey);
    if (!handle || handle.session.state !== ConnectionState.CONNECTED) return;
    // Bind on the handle's own key, not on whatever name the caller used. A
    // session is re-keyed onto its peer id the moment the handshake reveals
    // one, and binding under the older name left the listener orphaned.
    if (this.bindings.has(handle.key)) return;
    this.bindings.set(handle.key, [
      handle.session.events.on('message', (message) => {
        if (message.type === MessageType.GAME_INVITE) this.onInvite(handle.key, message);
      }),
      handle.session.events.on('closed', () => this.detach(handle.key)),
    ]);
  }

  private detach(peerKey: string): void {
    const handle = this.client.peer(peerKey);
    for (const key of [peerKey, handle?.key]) {
      if (!key) continue;
      const offs = this.bindings.get(key);
      if (!offs) continue;
      for (const off of offs) off();
      this.bindings.delete(key);
    }
  }

  private onInvite(peerKey: string, message: IncomingMessage): void {
    const invite = decodeInvite(message.value);
    if (!invite) return;

    const handle = this.client.peer(peerKey);
    if (!handle) return;

    // ACKNOWLEDGE FIRST, ALWAYS, AND ON EVERY REPEAT.
    //
    // This is a receipt, not an answer, and the asking phone needs it whatever
    // we go on to decide. Acknowledging a repeat matters just as much: if the
    // first ack was the frame that got lost, only a repeat can rescue it.
    trySend(handle.session, MessageType.GAME_INVITE_ACK, encodeAck(invite.inviteId));
    this.acknowledged.set(invite.inviteId, peerKey);

    if (this.settled.has(invite.inviteId)) {
      // Already answered. Re-send the answer rather than staying silent, so a
      // lost decline does not become a forty-five-second wait.
      trySend(handle.session, MessageType.GAME_RESPONSE_ACK, encodeAck(invite.inviteId));
      return;
    }
    if (this.invites.has(invite.inviteId)) return; // Already asking. One question.

    const me = this.client.profile?.peerId;
    // An invitation that does not name this device is not ours to answer.
    if (!me || !invite.players.includes(me)) return;

    const entry = findGame(invite.gameId);
    const playable =
      entry !== undefined &&
      hasRenderer(invite.gameId) &&
      invite.players.length === 2 &&
      entry.definition.protocolVersion === invite.version;

    if (!entry || !playable) {
      // Better a plain "not now" than forty-five seconds of a spinner on the
      // other phone. The tile on THIS device already explains the mismatch.
      this.settle(invite.inviteId);
      trySend(handle.session, MessageType.GAME_DECLINE, { s: invite.sessionId, i: invite.inviteId });
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
    this.invites.set(invite.inviteId, {
      inviteId: invite.inviteId,
      sessionId: invite.sessionId,
      peerKey: handle.key,
      peerId: handle.session.peerId,
      peerName: handle.session.capabilities?.displayName ?? '',
      gameId: invite.gameId,
      gameName: entry.definition.name,
      isHost: host === me,
      receivedAt: Date.now(),
      expiresAt: Date.now() + INVITE_LIFETIME_MS,
    });
    this.publish();
  }

  private settle(inviteId: string): void {
    this.settled.add(inviteId);
    this.invites.delete(inviteId);
    while (this.settled.size > SETTLED_MEMORY) {
      const oldest = this.settled.values().next().value;
      if (oldest === undefined) break;
      this.settled.delete(oldest);
      this.acknowledged.delete(oldest);
    }
  }

  /** Drop invitations the other phone has already given up on. */
  private prune(): void {
    const now = Date.now();
    for (const [id, record] of this.invites) {
      if (record.expiresAt <= now) this.invites.delete(id);
    }
  }

  private publish(): void {
    this.snapshotCache = this.invites.size === 0 ? NO_INVITES : [...this.invites.values()];
    for (const listener of this.listeners) listener();
  }
}

export type { GameInviteCentre };
export { decodeAck };

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
  return invites.find((record) => record.expiresAt > Date.now()) ?? null;
}
