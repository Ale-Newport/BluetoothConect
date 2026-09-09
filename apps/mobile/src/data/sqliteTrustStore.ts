import { sanitiseDisplayName, type PairingMethod, type TrustStore, type TrustedPeer } from '@airlink/core';
import type { PeerRepository, VerifiedVia } from '@airlink/db';

/**
 * The friend list, backed by SQLite.
 *
 * `TrustStore` is deliberately SYNCHRONOUS: the handshake calls
 * `get(peerId)` from inside a state machine that cannot await. So the whole
 * table is held in memory - a handful of rows of 32-byte keys, not a database in
 * any meaningful sense - and every mutation writes through to SQLite
 * immediately. Reads are instant; nothing is ever lost.
 *
 * Two invariants carried over from the in-memory implementation:
 *  - An identity key is written ONCE. A later handshake presenting a different
 *    key for the same peer id is rejected by the handshake, and quietly
 *    overwriting here would silently undo that protection.
 *  - A BLOCKED peer's `get` returns undefined even though a record exists, so
 *    the worst case if the pre-handshake block gate is ever bypassed is
 *    "treated as a stranger", never "silently auto-trusted".
 */
export class SqliteTrustStore implements TrustStore {
  private readonly records = new Map<string, TrustedPeer>();
  private rev = 0;

  constructor(private readonly peers: PeerRepository) {
    this.reload();
  }

  get revision(): number {
    return this.rev;
  }

  /** Read the table into memory. Called at startup and after a bulk change. */
  reload(): void {
    this.records.clear();
    for (const row of this.peers.listAll()) {
      if (row.trustState === 'known') continue;
      const method: PairingMethod =
        row.verifiedVia === 'qr' ? 'qr' : row.verifiedVia === 'sas' ? 'sas' : 'restored';
      this.records.set(row.peerId, {
        peerId: row.peerId,
        identityKey: row.identityPublic,
        displayName: row.displayName,
        method,
        pairedAt: row.pairedAt ?? row.verifiedAt ?? row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        ...(row.advertisementKey ? { advertisementKey: row.advertisementKey } : {}),
        ...(row.selfAdvertisementKey ? { selfAdvertisementKey: row.selfAdvertisementKey } : {}),
        blocked: row.trustState === 'blocked',
      });
    }
    this.rev++;
  }

  get(peerId: string): Uint8Array | undefined {
    const record = this.records.get(peerId);
    if (!record || record.blocked) return undefined;
    return record.identityKey;
  }

  record(peerId: string): TrustedPeer | undefined {
    return this.records.get(peerId);
  }

  list(): readonly TrustedPeer[] {
    return [...this.records.values()].filter((r) => !r.blocked).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  set(peer: TrustedPeer): void {
    const existing = this.records.get(peer.peerId);
    // Never overwrite a proven identity key.
    const identityKey = existing?.identityKey ?? peer.identityKey;
    const record: TrustedPeer = {
      ...peer,
      identityKey,
      displayName: sanitiseDisplayName(peer.displayName),
    };
    this.records.set(peer.peerId, record);
    this.rev++;

    this.peers.upsertSeen({
      peerId: record.peerId,
      displayName: record.displayName,
      identityPublic: record.identityKey,
      now: record.lastSeenAt,
    });
    this.peers.setTrust(
      record.peerId,
      record.blocked ? 'blocked' : 'trusted',
      toVerifiedVia(record.method),
      record.pairedAt,
    );
    this.peers.setAdvertisementKeys(
      record.peerId,
      record.advertisementKey ?? null,
      record.selfAdvertisementKey ?? null,
      record.pairedAt,
    );
  }

  remove(peerId: string): void {
    // Removing a friendship must not lift a block: someone the user blocked
    // stays blocked even after their friend record is gone.
    const existing = this.records.get(peerId);
    if (existing?.blocked) return;
    this.records.delete(peerId);
    this.peers.remove(peerId);
    this.rev++;
  }

  block(peerId: string): void {
    const existing = this.records.get(peerId);
    if (existing) {
      this.records.set(peerId, { ...existing, blocked: true });
    }
    this.peers.setTrust(peerId, 'blocked', 'none', Date.now());
    this.rev++;
  }

  unblock(peerId: string): void {
    const existing = this.records.get(peerId);
    if (existing) {
      // Unblocking restores the friendship it interrupted, rather than silently
      // promoting a stranger the user once blocked.
      this.records.set(peerId, { ...existing, blocked: false });
      this.peers.setTrust(peerId, 'trusted', toVerifiedVia(existing.method), existing.pairedAt);
    } else {
      this.peers.setTrust(peerId, 'known', 'none', Date.now());
    }
    this.rev++;
  }

  isBlocked(peerId: string): boolean {
    return this.records.get(peerId)?.blocked ?? false;
  }

  /** Bump the last-seen time. Cheap, and called every time a friend appears. */
  touch(peerId: string, wallNow: number): void {
    const existing = this.records.get(peerId);
    if (!existing) return;
    this.records.set(peerId, { ...existing, lastSeenAt: wallNow });
    this.peers.upsertSeen({
      peerId,
      displayName: existing.displayName,
      identityPublic: existing.identityKey,
      now: wallNow,
    });
  }
}

function toVerifiedVia(method: PairingMethod): VerifiedVia {
  return method === 'qr' ? 'qr' : method === 'sas' ? 'sas' : 'none';
}
