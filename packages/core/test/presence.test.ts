import { describe, expect, it } from 'vitest';
import { NearbyKind, NearbyRegistry, Proximity, proximityFromRssi } from '../src/presence/index.js';
import { TransportKind } from '../src/protocol/capabilities.js';
import { VirtualClock } from '../src/util/time.js';
import type { DiscoveredPeer } from '../src/transport/types.js';

const FRIEND_TOKEN = new Uint8Array([1, 2, 3, 4, 5, 6]);
const OTHER_TOKEN = new Uint8Array([9, 9, 9, 9, 9, 9]);

function setup(options: { staleAfterMs?: number } = {}) {
  const clock = new VirtualClock();
  const registry = new NearbyRegistry({
    clock,
    resolveToken: (token) => (token.every((b, i) => b === FRIEND_TOKEN[i]) ? 'PEERMARIA' : null),
    friendName: (peerId) => (peerId === 'PEERMARIA' ? 'Maria' : undefined),
    staleAfterMs: options.staleAfterMs ?? 15_000,
  });
  registry.start();
  return { clock, registry };
}

function sighting(over: Partial<DiscoveredPeer> = {}): DiscoveredPeer {
  return {
    endpointId: 'endpoint-1',
    transport: TransportKind.BLE,
    discoveredAt: 0,
    lastSeenAt: 0,
    ...over,
  } as DiscoveredPeer;
}

describe('proximity bucketing', () => {
  it('buckets rather than pretending to measure distance', () => {
    expect(proximityFromRssi(-40)).toBe(Proximity.IMMEDIATE);
    expect(proximityFromRssi(-65)).toBe(Proximity.NEAR);
    expect(proximityFromRssi(-90)).toBe(Proximity.FAR);
    expect(proximityFromRssi(undefined)).toBe(Proximity.UNKNOWN);
    expect(proximityFromRssi(0)).toBe(Proximity.UNKNOWN);
  });
});

describe('NearbyRegistry', () => {
  /**
   * The defect this exists for was found by running two devices, not by reading.
   *
   * A phone advertises the same Bonjour service type from BOTH of its local
   * network transports - `localNetwork` and `peerToPeerWifi` differ only by
   * `includePeerToPeer` - and browses with both. Every device therefore sees
   * every other device four times: two of its services, seen by two browsers.
   * On screen that was one phone listed four times, each with its own Connect
   * button.
   *
   * The advertisement token is what collapses them. All four sightings carry
   * the identical token at any instant, because the client advertises one token
   * across every transport in a single pass.
   */
  it('collapses one stranger seen on two transports into one row', () => {
    const { registry } = setup();
    const token = new Uint8Array([7, 7, 7, 7, 7, 7]);

    // The 2x2: our two browsers, each seeing both of their services.
    registry.observe(sighting({ transport: TransportKind.LOCAL_NETWORK, endpointId: 'their-lan', advertisementToken: token }));
    registry.observe(sighting({ transport: TransportKind.LOCAL_NETWORK, endpointId: 'their-p2p', advertisementToken: token }));
    registry.observe(sighting({ transport: TransportKind.PEER_TO_PEER_WIFI, endpointId: 'their-lan', advertisementToken: token }));
    registry.observe(sighting({ transport: TransportKind.PEER_TO_PEER_WIFI, endpointId: 'their-p2p', advertisementToken: token }));

    expect(registry.size).toBe(1);
    expect(registry.list()).toHaveLength(1);
  });

  it('keeps genuinely different strangers apart', () => {
    const { registry } = setup();
    registry.observe(sighting({ endpointId: 'a', advertisementToken: new Uint8Array([1, 1, 1, 1, 1, 1]) }));
    registry.observe(sighting({ endpointId: 'b', advertisementToken: new Uint8Array([2, 2, 2, 2, 2, 2]) }));
    expect(registry.size).toBe(2);
  });

  it('follows a stranger through a token rotation without duplicating them', () => {
    const { registry } = setup();
    const first = new Uint8Array([3, 3, 3, 3, 3, 3]);
    const second = new Uint8Array([4, 4, 4, 4, 4, 4]);

    registry.observe(sighting({ transport: TransportKind.LOCAL_NETWORK, endpointId: 'lan', advertisementToken: first }));
    registry.observe(sighting({ transport: TransportKind.PEER_TO_PEER_WIFI, endpointId: 'lan', advertisementToken: first }));
    expect(registry.size).toBe(1);

    // Four seconds later the peer rotates its token. The Bonjour service name
    // does not change, so the endpoint is the anchor that carries the row
    // across the rotation - and the new token must not open a second row.
    registry.observe(sighting({ transport: TransportKind.LOCAL_NETWORK, endpointId: 'lan', advertisementToken: second }));
    registry.observe(sighting({ transport: TransportKind.PEER_TO_PEER_WIFI, endpointId: 'lan', advertisementToken: second }));
    expect(registry.size).toBe(1);

    // And a device that only NOW appears carrying the old token is somebody
    // else, not a resurrection of the row that has moved on.
    registry.observe(sighting({ transport: TransportKind.LOCAL_NETWORK, endpointId: 'other', advertisementToken: first }));
    expect(registry.size).toBe(2);
  });

  it('recognises a paired friend from their rotating token', () => {
    const { registry } = setup();
    registry.observe(sighting({ advertisementToken: FRIEND_TOKEN, rssi: -50 }));
    const [peer] = registry.list();
    expect(peer?.kind).toBe(NearbyKind.TRUSTED_FRIEND);
    expect(peer?.peerId).toBe('PEERMARIA');
    expect(peer?.displayName).toBe('Maria');
    expect(peer?.proximity).toBe(Proximity.IMMEDIATE);
  });

  it('lists a stranger as an unknown device', () => {
    const { registry } = setup();
    registry.observe(sighting({ advertisementToken: OTHER_TOKEN, advertisedName: 'Some phone' }));
    const [peer] = registry.list();
    expect(peer?.kind).toBe(NearbyKind.UNKNOWN_DEVICE);
    expect(peer?.peerId).toBeNull();
  });

  it('prefers the stored friend name over whatever is advertised', () => {
    const { registry } = setup();
    // An attacker advertising a friend's token cannot also choose their name.
    registry.observe(sighting({ advertisementToken: FRIEND_TOKEN, advertisedName: 'Definitely Maria' }));
    expect(registry.list()[0]?.displayName).toBe('Maria');
  });

  it('collapses the same friend seen over two transports into one row', () => {
    const { registry } = setup();
    registry.observe(sighting({ transport: TransportKind.BLE, endpointId: 'ble-1', advertisementToken: FRIEND_TOKEN, rssi: -80 }));
    registry.observe(
      sighting({ transport: TransportKind.LOCAL_NETWORK, endpointId: 'net-1', advertisementToken: FRIEND_TOKEN, rssi: -45 }),
    );
    expect(registry.size).toBe(1);
    const [peer] = registry.list();
    expect(peer?.reachableVia).toContain(TransportKind.BLE);
    expect(peer?.reachableVia).toContain(TransportKind.LOCAL_NETWORK);
    // Best signal across the transports wins.
    expect(peer?.proximity).toBe(Proximity.IMMEDIATE);
  });

  it('keeps the row when one of two transports goes away', () => {
    const { registry } = setup();
    registry.observe(sighting({ transport: TransportKind.BLE, endpointId: 'ble-1', advertisementToken: FRIEND_TOKEN }));
    registry.observe(
      sighting({ transport: TransportKind.LOCAL_NETWORK, endpointId: 'net-1', advertisementToken: FRIEND_TOKEN }),
    );
    registry.forgetEndpoint(TransportKind.LOCAL_NETWORK, 'net-1');
    expect(registry.size).toBe(1);
    expect(registry.list()[0]?.reachableVia).toEqual([TransportKind.BLE]);
  });

  it('drops the row when the last transport goes away', () => {
    const { registry } = setup();
    const left: string[] = [];
    registry.events.on('friendLeft', (e) => left.push(e.peerId));
    registry.observe(sighting({ advertisementToken: FRIEND_TOKEN }));
    registry.forgetEndpoint(TransportKind.BLE, 'endpoint-1');
    expect(registry.size).toBe(0);
    expect(left).toEqual(['PEERMARIA']);
  });

  it('expires a peer that stops advertising', () => {
    const { clock, registry } = setup({ staleAfterMs: 10_000 });
    registry.observe(sighting({ advertisementToken: FRIEND_TOKEN }));
    clock.advance(5_000);
    expect(registry.size).toBe(1);
    clock.advance(8_000);
    expect(registry.size).toBe(0);
  });

  it('keeps a connected peer listed even when advertising stops', () => {
    // iOS stops being discoverable the moment the app is backgrounded, so a
    // live session must pin the row or the person vanishes mid-conversation.
    const { clock, registry } = setup({ staleAfterMs: 5_000 });
    registry.observe(sighting({ advertisementToken: FRIEND_TOKEN }));
    registry.setConnected('PEERMARIA', true);
    clock.advance(60_000);
    expect(registry.size).toBe(1);
    expect(registry.list()[0]?.connected).toBe(true);

    registry.setConnected('PEERMARIA', false);
    clock.advance(60_000);
    expect(registry.size).toBe(0);
  });

  it('rides out a brief disappearance without flickering', () => {
    const { clock, registry } = setup({ staleAfterMs: 15_000 });
    const changes: number[] = [];
    registry.events.on('changed', (e) => changes.push(e.peers.length));
    registry.observe(sighting({ advertisementToken: FRIEND_TOKEN }));
    clock.advance(9_000); // a pocket, a passing body
    registry.observe(sighting({ advertisementToken: FRIEND_TOKEN }));
    clock.advance(9_000);
    expect(registry.size).toBe(1);
    expect(changes.every((n) => n === 1)).toBe(true);
  });

  it('merges a stranger into a friend once the token resolves', () => {
    const clock = new VirtualClock();
    let known = false;
    const registry = new NearbyRegistry({
      clock,
      // Simulates the friend list finishing its load after the first sighting.
      resolveToken: () => (known ? 'PEERMARIA' : null),
      friendName: () => 'Maria',
    });
    registry.start();
    registry.observe(sighting({ advertisementToken: FRIEND_TOKEN, advertisedName: 'phone' }));
    expect(registry.list()[0]?.kind).toBe(NearbyKind.UNKNOWN_DEVICE);
    const firstSeen = registry.list()[0]?.firstSeenAt;

    known = true;
    clock.advance(1000);
    registry.observe(sighting({ advertisementToken: FRIEND_TOKEN }));
    expect(registry.size).toBe(1);
    const [peer] = registry.list();
    expect(peer?.kind).toBe(NearbyKind.TRUSTED_FRIEND);
    // And we remember we had already seen them, rather than resetting.
    expect(peer?.firstSeenAt).toBe(firstSeen);
  });

  it('sorts connected first, then friends, then by proximity', () => {
    const { registry } = setup();
    registry.observe(sighting({ endpointId: 'e1', advertisementToken: OTHER_TOKEN, advertisedName: 'Zed', rssi: -40 }));
    registry.observe(sighting({ endpointId: 'e2', advertisementToken: FRIEND_TOKEN, rssi: -85 }));
    const list = registry.list();
    expect(list[0]?.kind).toBe(NearbyKind.TRUSTED_FRIEND);
    expect(list[1]?.kind).toBe(NearbyKind.UNKNOWN_DEVICE);
  });

  it('picks the preferred transport to dial', () => {
    const { registry } = setup();
    registry.observe(sighting({ transport: TransportKind.BLE, endpointId: 'ble-1', advertisementToken: FRIEND_TOKEN }));
    registry.observe(
      sighting({ transport: TransportKind.LOCAL_NETWORK, endpointId: 'net-1', advertisementToken: FRIEND_TOKEN }),
    );
    const best = registry.bestEndpointFor('PEERMARIA', [TransportKind.LOCAL_NETWORK, TransportKind.BLE]);
    expect(best).toEqual({ transport: TransportKind.LOCAL_NETWORK, endpointId: 'net-1' });

    const fallback = registry.bestEndpointFor('PEERMARIA', [TransportKind.WIFI_DIRECT]);
    expect(fallback?.endpointId).toBeDefined();
    expect(registry.bestEndpointFor('nobody', [TransportKind.BLE])).toBeNull();
  });

  it('cleans up completely on dispose', () => {
    const { clock, registry } = setup();
    registry.observe(sighting({ advertisementToken: FRIEND_TOKEN }));
    registry.dispose();
    expect(registry.size).toBe(0);
    expect(clock.pendingTimers).toBe(0);
  });
});
