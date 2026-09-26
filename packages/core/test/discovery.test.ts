/**
 * The four discovery defects that were found by running two real phones, and
 * that no test could have caught because nothing simulated the conditions.
 *
 *   A device listed ITSELF as somebody to connect to.
 *   A half-arrived advertisement was shown as a connectable "Unknown Device".
 *   One phone appeared several times, once per radio it could be seen on.
 *   A CONNECTED friend reappeared as a fresh row with a Connect button, and
 *   pressing it fought the session that was already open.
 *
 * Each one has a test here that fails against the old code and passes against
 * the new. They are written in the vocabulary of what a person sees, because
 * that is what actually went wrong.
 */
import { describe, expect, it } from 'vitest';
import {
  NearbyRegistry,
  PeerResolution,
  SelfIdentityGuard,
  SelfReason,
  fingerprintOfKey,
  initiatorWins,
  isValidDiscoveryId,
  newDiscoveryId,
  type LocalPeerIdentity,
} from '../src/presence/index.js';
import { TransportKind } from '../src/protocol/capabilities.js';
import { PROTOCOL_VERSION } from '../src/protocol/constants.js';
import { VirtualClock } from '../src/util/time.js';
import { systemRandom } from '../src/crypto/random.js';
import type { DiscoveredPeer } from '../src/transport/types.js';

const FRIEND_TOKEN = new Uint8Array([1, 2, 3, 4, 5, 6]);
const MY_DISCOVERY_ID = 'a1b2c3d4e5f60718';
const THEIR_DISCOVERY_ID = '0f1e2d3c4b5a6978';

function localIdentity(over: Partial<LocalPeerIdentity> = {}): LocalPeerIdentity {
  return {
    installationId: 'install-mine',
    peerId: 'PEERME',
    publicKeyFingerprint: 'ffffffffffffffff',
    displayName: 'Alejandro',
    discoveryId: MY_DISCOVERY_ID,
    ...over,
  };
}

function sighting(over: Partial<DiscoveredPeer> = {}): DiscoveredPeer {
  return {
    endpointId: 'endpoint-1',
    transport: TransportKind.BLE,
    protocolVersion: PROTOCOL_VERSION,
    discoveredAt: 0,
    lastSeenAt: 0,
    ...over,
  } as DiscoveredPeer;
}

function registry(clock: VirtualClock, over: { resolveWindowMs?: number } = {}): NearbyRegistry {
  const r = new NearbyRegistry({
    clock,
    resolveToken: (token) => (token.every((b, i) => b === FRIEND_TOKEN[i]) ? 'PEERMARIA' : null),
    friendName: (peerId) => (peerId === 'PEERMARIA' ? 'Maria' : undefined),
    resolveWindowMs: over.resolveWindowMs ?? 8_000,
  });
  r.start();
  return r;
}

// ---------------------------------------------------------------------------

describe('self discovery', () => {
  it('recognises our own advertisement by its discovery id, whatever radio it came back on', () => {
    const clock = new VirtualClock();
    const guard = new SelfIdentityGuard({ clock });
    guard.setIdentity(localIdentity());

    for (const transport of [TransportKind.BLE, TransportKind.LOCAL_NETWORK, TransportKind.PEER_TO_PEER_WIFI]) {
      const check = guard.check(sighting({ transport, discoveryId: MY_DISCOVERY_ID }));
      expect(check.isSelf).toBe(true);
      expect(check.reason).toBe(SelfReason.DISCOVERY_ID);
    }
  });

  it('leaves a real peer alone', () => {
    const clock = new VirtualClock();
    const guard = new SelfIdentityGuard({ clock });
    guard.setIdentity(localIdentity());
    expect(guard.check(sighting({ discoveryId: THEIR_DISCOVERY_ID })).isSelf).toBe(false);
  });

  it('still knows a token it advertised ten minutes and a hundred rotations ago', () => {
    /*
     * The old filter kept thirty-two tokens in a Set and rotated one in every
     * four seconds, so it forgot after about two minutes - and a transport
     * still publishing an older record was then a stranger with a Connect
     * button on it. This is that exact scenario.
     */
    const clock = new VirtualClock();
    const guard = new SelfIdentityGuard({ clock });
    guard.setIdentity(localIdentity());

    const first = new Uint8Array([7, 7, 7, 7, 7, 7]);
    guard.noteAdvertisedToken(first);

    for (let i = 0; i < 100; i++) {
      clock.advance(4_000);
      guard.noteAdvertisedToken(new Uint8Array([i & 0xff, 1, 2, 3, 4, 5]));
    }

    // Four hundred seconds later, a stale Bonjour record turns up carrying it.
    const check = guard.check(sighting({ transport: TransportKind.LOCAL_NETWORK, advertisementToken: first }));
    expect(check.isSelf).toBe(true);
    expect(check.reason).toBe(SelfReason.ADVERTISEMENT_TOKEN);
  });

  it('recognises our own long-term key even with no discovery id at all', () => {
    const clock = new VirtualClock();
    const guard = new SelfIdentityGuard({ clock });
    const fingerprint = fingerprintOfKey(systemRandom.randomBytes(32));
    guard.setIdentity(localIdentity({ publicKeyFingerprint: fingerprint }));
    expect(guard.check(sighting({ publicKeyFingerprint: fingerprint })).isSelf).toBe(true);
  });

  it('leaves the peer list untouched when our own advertisement comes back', () => {
    const clock = new VirtualClock();
    const guard = new SelfIdentityGuard({ clock });
    guard.setIdentity(localIdentity());
    const reg = registry(clock);

    const observeUnlessSelf = (peer: DiscoveredPeer): void => {
      if (!guard.check(peer).isSelf) reg.observe(peer);
    };

    // Bonjour hands our own service straight back to our own browser, on both
    // of the local-network transports iOS runs, over and over.
    for (let i = 0; i < 50; i++) {
      observeUnlessSelf(
        sighting({
          transport: TransportKind.LOCAL_NETWORK,
          endpointId: `self-lan-${i}`,
          discoveryId: MY_DISCOVERY_ID,
        }),
      );
      observeUnlessSelf(
        sighting({
          transport: TransportKind.PEER_TO_PEER_WIFI,
          endpointId: `self-p2p-${i}`,
          discoveryId: MY_DISCOVERY_ID,
        }),
      );
      clock.advance(4_000);
    }

    expect(reg.list()).toHaveLength(0);
    expect(reg.trackedSize).toBe(0);
  });

  it('rejects a malformed discovery id rather than letting it match', () => {
    expect(isValidDiscoveryId('')).toBe(false);
    expect(isValidDiscoveryId('nothex-nothex-nn')).toBe(false);
    expect(isValidDiscoveryId('a1b2c3d4e5f6071')).toBe(false); // one short
    expect(isValidDiscoveryId(MY_DISCOVERY_ID)).toBe(true);
    expect(isValidDiscoveryId(newDiscoveryId(systemRandom))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('unknown devices', () => {
  it('holds a sighting with nothing identifying in it, rather than listing it', () => {
    /*
     * This is what iOS emits for a Bluetooth peer before its identity
     * characteristic has been read: no name, no token, nothing. It used to
     * become a row reading "Unknown Device" with a Connect button.
     */
    const clock = new VirtualClock();
    const reg = registry(clock);
    reg.observe(sighting({ endpointId: 'bare', advertisementToken: undefined, advertisedName: undefined }));

    expect(reg.list()).toHaveLength(0);
    expect(reg.trackedSize).toBe(1);
    expect(reg.find('ble:bare')?.resolution).not.toBe(PeerResolution.DISCOVERED_VALID);
  });

  it('shows it the moment the transport fills the identity in', () => {
    /*
     * The second sighting is not a formality - it is a contract with the
     * native transport, and for a long time nothing honoured it.
     *
     * iOS cannot put service data in a BLE advertisement, so an iPhone
     * advertising AirLink says only "I speak this service" and perhaps a name.
     * The token and the discovery id live in a characteristic that can only be
     * READ over a connection, and the transport used to read it only after
     * connecting - which the user could only ask for once the peer was listed,
     * which this registry would only do once it was identified. Two iPhones
     * with no Wi-Fi therefore saw each other and stayed invisible, each row
     * swept away after `resolveWindowMs`, and this test passed throughout
     * because it hand-feeds the very re-announcement nobody made.
     *
     * `BleTransport.scheduleIdentityProbe` is what makes it true: it connects
     * on its own, reads the identity, disconnects, and re-announces the peer -
     * which is exactly the second `observe` below.
     */
    const clock = new VirtualClock();
    const reg = registry(clock);
    reg.observe(sighting({ endpointId: 'bare' }));
    expect(reg.list()).toHaveLength(0);

    // The identity probe completes and the same endpoint is re-announced.
    reg.observe(sighting({ endpointId: 'bare', discoveryId: THEIR_DISCOVERY_ID, advertisedName: 'Maria' }));

    const listed = reg.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.displayName).toBe('Maria');
    expect(listed[0]?.resolution).toBe(PeerResolution.DISCOVERED_VALID);
  });

  it('throws away a sighting that never resolves, instead of keeping it for ever', () => {
    const clock = new VirtualClock();
    const reg = registry(clock, { resolveWindowMs: 5_000 });
    reg.observe(sighting({ endpointId: 'bare' }));
    expect(reg.trackedSize).toBe(1);

    clock.advance(6_000);
    expect(reg.trackedSize).toBe(0);
    expect(reg.list()).toHaveLength(0);
  });

  it('does not list a peer speaking a protocol we cannot speak', () => {
    const clock = new VirtualClock();
    const reg = registry(clock);
    reg.observe(
      sighting({ endpointId: 'future', discoveryId: THEIR_DISCOVERY_ID, protocolVersion: PROTOCOL_VERSION + 9 }),
    );
    expect(reg.list()).toHaveLength(0);
    expect(reg.find('ble:future')?.resolution).toBe(PeerResolution.IGNORED);
  });
});

// ---------------------------------------------------------------------------

describe('peer deduplication', () => {
  it('is one row for one phone seen over Bluetooth, then Wi-Fi, then Bluetooth again', () => {
    const clock = new VirtualClock();
    const reg = registry(clock);

    reg.observe(sighting({ transport: TransportKind.BLE, endpointId: 'ble-1', discoveryId: THEIR_DISCOVERY_ID }));
    reg.observe(
      sighting({ transport: TransportKind.LOCAL_NETWORK, endpointId: 'lan-1', discoveryId: THEIR_DISCOVERY_ID }),
    );
    reg.observe(sighting({ transport: TransportKind.BLE, endpointId: 'ble-1', discoveryId: THEIR_DISCOVERY_ID }));

    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0]?.reachableVia).toEqual([TransportKind.BLE, TransportKind.LOCAL_NETWORK]);
  });

  it('is one friend when their two records advertise tokens for two different friends', () => {
    /*
     * An iPhone publishes two Bonjour records - one per local-network transport
     * - and one browser sees both. A person with more than one friend rotates
     * which friend's token they advertise, and the two records are updated at
     * different moments, so for a while one carries the token WE recognise and
     * the other carries a token meant for somebody else. The second is a
     * stranger by its token and the same phone by its discovery id, and the
     * discovery id has to win in every order, or a friend is listed twice:
     * once as a friend and once as "New device" under the same name.
     */
    const OTHER_FRIENDS_TOKEN = new Uint8Array([9, 9, 9, 9, 9, 9]);
    const lan = (endpointId: string, token: Uint8Array): DiscoveredPeer =>
      sighting({
        transport: TransportKind.LOCAL_NETWORK,
        endpointId,
        discoveryId: THEIR_DISCOVERY_ID,
        advertisementToken: token,
        advertisedName: 'Maria',
      });
    const orders: [string, Uint8Array][][] = [
      [['record-a', FRIEND_TOKEN], ['record-b', OTHER_FRIENDS_TOKEN]],
      [['record-b', OTHER_FRIENDS_TOKEN], ['record-a', FRIEND_TOKEN]],
      // ...and then the rotation moves on, so the two swap.
      [
        ['record-b', OTHER_FRIENDS_TOKEN],
        ['record-a', FRIEND_TOKEN],
        ['record-a', OTHER_FRIENDS_TOKEN],
        ['record-b', FRIEND_TOKEN],
        ['record-b', OTHER_FRIENDS_TOKEN],
      ],
    ];

    for (const order of orders) {
      const clock = new VirtualClock();
      const reg = registry(clock);
      for (const [endpointId, token] of order) {
        reg.observe(lan(endpointId, token));
        clock.advance(500);
      }
      expect(reg.list().map((p) => [p.key, p.displayName])).toEqual([['PEERMARIA', 'Maria']]);
    }
  });

  it('stays one row when the endpoint handle changes underneath it', () => {
    /*
     * Android re-registered its Bonjour service under a brand-new name every
     * four seconds, and that name IS the endpoint id - so one phone became a
     * new row every four seconds until the screen was a column of Marias. The
     * discovery id does not change with it.
     */
    const clock = new VirtualClock();
    const reg = registry(clock);

    for (let i = 0; i < 20; i++) {
      reg.observe(
        sighting({
          transport: TransportKind.LOCAL_NETWORK,
          endpointId: `AirLink-${i}`,
          discoveryId: THEIR_DISCOVERY_ID,
          advertisedName: 'Maria',
        }),
      );
      clock.advance(4_000);
    }

    expect(reg.list()).toHaveLength(1);
  });

  it('folds a stranger row into the friend row once the handshake names them', () => {
    const clock = new VirtualClock();
    const reg = registry(clock);
    reg.observe(sighting({ endpointId: 'ble-1', discoveryId: THEIR_DISCOVERY_ID }));
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0]?.peerId).toBeNull();

    reg.bindIdentity('ble:ble-1', { peerId: 'PEERMARIA', installationId: 'install-maria' });

    const listed = reg.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.peerId).toBe('PEERMARIA');
    // And a later sighting on the same radio lands on that same row.
    reg.observe(sighting({ endpointId: 'ble-1', discoveryId: THEIR_DISCOVERY_ID }));
    expect(reg.list()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('connected means connected', () => {
  it('never re-offers a connected peer, however many times it is rediscovered', () => {
    const clock = new VirtualClock();
    const reg = registry(clock);

    reg.observe(sighting({ endpointId: 'ble-1', discoveryId: THEIR_DISCOVERY_ID, advertisedName: 'Maria' }));
    reg.bindIdentity('ble:ble-1', { peerId: 'PEERMARIA', installationId: 'install-maria' });
    reg.setConnected('PEERMARIA', true);

    let changes = 0;
    reg.events.on('changed', () => {
      changes += 1;
    });

    // A hundred fresh advertisements, on two radios, with rotating handles.
    for (let i = 0; i < 100; i++) {
      reg.observe(
        sighting({ transport: TransportKind.BLE, endpointId: `ble-${i}`, discoveryId: THEIR_DISCOVERY_ID }),
      );
      reg.observe(
        sighting({
          transport: TransportKind.LOCAL_NETWORK,
          endpointId: `lan-${i}`,
          discoveryId: THEIR_DISCOVERY_ID,
        }),
      );
      clock.advance(1_000);
    }

    const listed = reg.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.connected).toBe(true);
    expect(listed[0]?.peerId).toBe('PEERMARIA');
    // The row was updated, never replaced.
    expect(changes).toBeGreaterThan(0);
  });

  it('pins a peer met for the first time, whose row has no peer id yet', () => {
    /*
     * The failure this replaces: a stranger connects, `setConnected(peerId)`
     * finds no row carrying that peer id because the row is keyed on a
     * transport handle, the row is never pinned, and fifteen seconds later the
     * sweep deletes a peer in the middle of a live, encrypted conversation.
     */
    const clock = new VirtualClock();
    const reg = registry(clock);
    reg.observe(sighting({ endpointId: 'ble-1', discoveryId: THEIR_DISCOVERY_ID }));

    // Pinned by the only name anybody has: the row key itself.
    reg.setConnected('ble:ble-1', true);

    clock.advance(60_000);
    const listed = reg.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.connected).toBe(true);
  });

  it('keeps a connected peer when its last radio stops reporting it', () => {
    // iOS stops advertising the instant the app is backgrounded. The link is
    // completely unaffected, and the row must not vanish.
    const clock = new VirtualClock();
    const reg = registry(clock);
    reg.observe(sighting({ endpointId: 'ble-1', discoveryId: THEIR_DISCOVERY_ID }));
    reg.setConnected('ble:ble-1', true);

    reg.forgetEndpoint(TransportKind.BLE, 'ble-1');
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0]?.connected).toBe(true);
  });

  it('pins every row for one person, not merely the first', () => {
    const clock = new VirtualClock();
    const reg = registry(clock);
    reg.observe(sighting({ transport: TransportKind.BLE, endpointId: 'a', advertisementToken: FRIEND_TOKEN }));
    reg.setConnected('PEERMARIA', true);
    expect(reg.list().every((p) => p.connected)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('simultaneous connect arbitration', () => {
  it('is decided the same way on both phones, and never the same way on both', () => {
    const a = 'install-aaaa';
    const b = 'install-bbbb';
    // Phone A asks "do I initiate?"; phone B asks the same question.
    expect(initiatorWins(a, b)).toBe(true);
    expect(initiatorWins(b, a)).toBe(false);
    // Exactly one initiator, whichever way round the pair is read.
    expect(initiatorWins(a, b)).not.toBe(initiatorWins(b, a));
  });

  it('is stable across many random pairs', () => {
    for (let i = 0; i < 200; i++) {
      const x = newDiscoveryId(systemRandom);
      const y = newDiscoveryId(systemRandom);
      if (x === y) continue;
      expect(initiatorWins(x, y)).not.toBe(initiatorWins(y, x));
    }
  });
});

describe('index hygiene', () => {
  it('leaves nothing behind when a peer changes its handle on the same radio', () => {
    /*
     * Android's Bonjour registration used to be renamed every four seconds, and
     * the name IS the endpoint id, so this happened continuously. Each stale
     * index entry is a chance for a later sighting to resolve to a row that has
     * been deleted or re-keyed, and open a duplicate for somebody already
     * listed.
     */
    const clock = new VirtualClock();
    const reg = registry(clock);

    for (let i = 0; i < 30; i++) {
      reg.observe(
        sighting({
          transport: TransportKind.LOCAL_NETWORK,
          endpointId: `AirLink-${i}`,
          discoveryId: THEIR_DISCOVERY_ID,
          advertisedName: 'Maria',
        }),
      );
    }
    expect(reg.list()).toHaveLength(1);

    // A sighting on one of the abandoned handles, carrying nothing to identify
    // it, must not resolve onto a dead row - and must not be listed either.
    reg.observe(
      sighting({
        transport: TransportKind.LOCAL_NETWORK,
        endpointId: 'AirLink-3',
        advertisementToken: undefined,
        advertisedName: undefined,
      }),
    );
    expect(reg.list()).toHaveLength(1);
  });

  it('keeps one row when a friend is recognised after being seen as a stranger', () => {
    const clock = new VirtualClock();
    const reg = registry(clock);

    reg.observe(sighting({ transport: TransportKind.BLE, endpointId: 'ble-1', discoveryId: THEIR_DISCOVERY_ID }));
    reg.observe(
      sighting({ transport: TransportKind.LOCAL_NETWORK, endpointId: 'lan-1', discoveryId: THEIR_DISCOVERY_ID }),
    );
    expect(reg.list()).toHaveLength(1);

    reg.bindIdentity('ble:ble-1', { peerId: 'PEERMARIA', installationId: 'install-maria' });
    reg.setConnected('PEERMARIA', true);

    // Both radios keep reporting, under both old and new handles.
    for (let i = 0; i < 10; i++) {
      reg.observe(sighting({ transport: TransportKind.BLE, endpointId: 'ble-1', discoveryId: THEIR_DISCOVERY_ID }));
      reg.observe(
        sighting({ transport: TransportKind.LOCAL_NETWORK, endpointId: `lan-${i}`, discoveryId: THEIR_DISCOVERY_ID }),
      );
      clock.advance(2_000);
    }

    const listed = reg.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.peerId).toBe('PEERMARIA');
    expect(listed[0]?.connected).toBe(true);
  });
});
