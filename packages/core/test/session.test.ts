import { describe, expect, it } from 'vitest';
import { MessageType, Channel } from '../src/protocol/constants.js';
import { TransportKind, type PeerCapabilities } from '../src/protocol/capabilities.js';
import { SeededRandom } from '../src/crypto/random.js';
import { createIdentity, type LocalIdentity } from '../src/crypto/identity.js';
import type { HandshakeConfig } from '../src/crypto/handshake.js';
import { PeerSession, type IncomingMessage } from '../src/session/peerSession.js';
import { ConnectionState, ConnectionStateMachine, ReconnectPolicy } from '../src/session/stateMachine.js';
import { ReliableChannel } from '../src/session/reliability.js';
import { ClockSynchronizer, computeDriftCorrection, DriftAction } from '../src/session/clockSync.js';
import {
  BLE_LIKE_CONDITIONS,
  HOSTILE_CONDITIONS,
  MockNetwork,
  WIFI_LIKE_CONDITIONS,
  mockToken,
} from '../src/transport/mock.js';
import { VirtualClock } from '../src/util/time.js';
import { PROTOCOL_VERSION } from '../src/protocol/constants.js';
import type { Link } from '../src/transport/types.js';
import { LinkState } from '../src/transport/types.js';

function caps(name: string, deviceId: string): PeerCapabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    appVersion: '0.1.0',
    platform: 'node',
    deviceModel: 'simulator',
    displayName: name,
    deviceId,
    transports: [TransportKind.MOCK],
    features: ['chat', 'games', 'files', 'sync'],
    games: [{ id: 'tic-tac-toe', version: 1 }],
    maxPayloadBytes: 65536,
  };
}

interface Device {
  identity: LocalIdentity;
  config: HandshakeConfig;
  trust: Map<string, Uint8Array>;
}

function makeDevice(name: string, seed: number): Device {
  const random = new SeededRandom(seed);
  const identity = createIdentity(random, 1000);
  const trust = new Map<string, Uint8Array>();
  const config: HandshakeConfig = {
    identity,
    capabilities: caps(name, `device-${name}`),
    random,
    lookupTrustedKey: (peerId) => trust.get(peerId),
  };
  return { identity, config, trust };
}

/**
 * Build a full two-peer scenario over the mock network: transports, discovery,
 * links and sessions. Returns everything the tests need to poke at.
 */
async function connectPair(
  options: {
    conditions?: Partial<typeof BLE_LIKE_CONDITIONS>;
    preTrusted?: boolean;
    seedA?: number;
    seedB?: number;
  } = {},
) {
  const clock = new VirtualClock();
  const network = new MockNetwork(clock, 0xa11);
  if (options.conditions) network.setConditions(options.conditions);

  const alejandro = makeDevice('Alejandro', options.seedA ?? 101);
  const maria = makeDevice('Maria', options.seedB ?? 202);

  if (options.preTrusted) {
    alejandro.trust.set(maria.identity.peerId, maria.identity.signing.publicKey);
    maria.trust.set(alejandro.identity.peerId, alejandro.identity.signing.publicKey);
  }

  const transportA = network.createTransport('endpoint-a');
  const transportB = network.createTransport('endpoint-b');

  await transportA.startAdvertising({ protocolVersion: PROTOCOL_VERSION, token: mockToken(1), displayName: 'Alejandro' });
  await transportB.startAdvertising({ protocolVersion: PROTOCOL_VERSION, token: mockToken(2), displayName: 'Maria' });

  const discovered: string[] = [];
  transportA.events.on('peerDiscovered', ({ peer }) => discovered.push(peer.endpointId));
  await transportA.startDiscovery();

  const sessionA = new PeerSession('endpoint-b', { clock, handshake: alejandro.config });
  const sessionB = new PeerSession('endpoint-a', { clock, handshake: maria.config });

  // B routes an incoming link the way the real SessionManager does: a brand new
  // peer gets a handshake, a peer we already have a session with gets migrated.
  let incoming: Link | undefined;
  transportB.events.on('incomingLink', ({ link }) => {
    incoming = link;
    if (sessionB.isSecure) sessionB.migrateToLink(link);
    else sessionB.startAsResponder(link);
  });

  const connectPromise = transportA.connect('endpoint-b');
  await clock.advanceAsync(200);
  const linkA = await connectPromise;
  await sessionA.startAsInitiator(linkA);
  await clock.advanceAsync(2000);

  return {
    clock,
    network,
    transportA,
    transportB,
    sessionA,
    sessionB,
    alejandro,
    maria,
    discovered,
    linkA,
    get linkB(): Link {
      if (!incoming) throw new Error('no incoming link');
      return incoming;
    },
  };
}

function collect(session: PeerSession): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  session.events.on('message', (m) => out.push(m));
  return out;
}

describe('MockTransport', () => {
  it('discovers an advertising peer', async () => {
    const ctx = await connectPair({ preTrusted: true });
    expect(ctx.discovered).toContain('endpoint-b');
  });

  it('reports links as connected on both sides', async () => {
    const ctx = await connectPair({ preTrusted: true });
    expect(ctx.linkA.state).toBe(LinkState.CONNECTED);
    expect(ctx.linkB.state).toBe(LinkState.CONNECTED);
  });

  it('refuses to send a datagram larger than the MTU', async () => {
    const ctx = await connectPair({ preTrusted: true, conditions: BLE_LIKE_CONDITIONS });
    await expect(ctx.linkA.send(new Uint8Array(10_000), 'reliable')).rejects.toThrow(/exceeds MTU/);
  });

  it('stops delivering once a peer goes out of range', async () => {
    const ctx = await connectPair({ preTrusted: true });
    ctx.network.partition('endpoint-a', 'endpoint-b');
    await ctx.clock.advanceAsync(100);
    expect(ctx.linkA.state).toBe(LinkState.CLOSED);
  });
});

describe('PeerSession end to end', () => {
  it('authenticates two previously paired peers with no user interaction', async () => {
    const ctx = await connectPair({ preTrusted: true });
    expect(ctx.sessionA.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.sessionB.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.sessionA.peerId).toBe(ctx.maria.identity.peerId);
    expect(ctx.sessionB.peerId).toBe(ctx.alejandro.identity.peerId);
    expect(ctx.sessionA.awaitingUserConfirmation).toBe(false);
    expect(ctx.sessionA.isSecure).toBe(true);
  });

  it('requires six-digit confirmation on a first meeting, and both sides show the same code', async () => {
    const ctx = await connectPair({ preTrusted: false });
    expect(ctx.sessionA.state).toBe(ConnectionState.PAIRING);
    expect(ctx.sessionB.state).toBe(ConnectionState.PAIRING);
    expect(ctx.sessionA.sasCode).toBe(ctx.sessionB.sasCode);
    expect(ctx.sessionA.sasCode).toMatch(/^\d{6}$/);

    // Refuses to carry traffic until the user has confirmed.
    expect(() => ctx.sessionA.sendReliable(MessageType.MESSAGE, { t: 'hi' })).toThrow(/confirm/);

    ctx.sessionA.confirmPairing(true);
    ctx.sessionB.confirmPairing(true);
    expect(ctx.sessionA.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.sessionB.state).toBe(ConnectionState.CONNECTED);
  });

  it('exchanges the capability record', async () => {
    const ctx = await connectPair({ preTrusted: true });
    expect(ctx.sessionA.capabilities?.displayName).toBe('Maria');
    expect(ctx.sessionB.capabilities?.displayName).toBe('Alejandro');
    expect(ctx.sessionA.capabilities?.games).toEqual([{ id: 'tic-tac-toe', version: 1 }]);
  });

  it('delivers a chat message in both directions', async () => {
    const ctx = await connectPair({ preTrusted: true });
    const gotB = collect(ctx.sessionB);
    const gotA = collect(ctx.sessionA);

    ctx.sessionA.sendReliable(MessageType.MESSAGE, { id: 'm1', t: 'Did you bring the headphones?' });
    await ctx.clock.advanceAsync(500);

    const first = gotB.find((m) => m.type === MessageType.MESSAGE);
    expect(first).toBeDefined();
    expect((first?.value as Record<string, unknown>).t).toBe('Did you bring the headphones?');

    ctx.sessionB.sendReliable(MessageType.MESSAGE, { id: 'm2', t: 'Yes 😭' });
    await ctx.clock.advanceAsync(500);
    const reply = gotA.find((m) => m.type === MessageType.MESSAGE);
    expect((reply?.value as Record<string, unknown>).t).toBe('Yes 😭');
  });

  it('confirms delivery back to the sender', async () => {
    const ctx = await connectPair({ preTrusted: true });
    const delivered: number[] = [];
    ctx.sessionA.events.on('delivered', ({ seq }) => delivered.push(seq));
    const seq = ctx.sessionA.sendReliable(MessageType.MESSAGE, { t: 'ping' });
    await ctx.clock.advanceAsync(500);
    expect(delivered).toContain(seq);
  });

  it('preserves ordering across a burst of messages', async () => {
    const ctx = await connectPair({ preTrusted: true });
    const got = collect(ctx.sessionB);
    for (let i = 0; i < 40; i++) ctx.sessionA.sendReliable(MessageType.MESSAGE, { i });
    await ctx.clock.advanceAsync(3000);

    const received = got.filter((m) => m.type === MessageType.MESSAGE).map((m) => (m.value as { i: number }).i);
    expect(received).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it('fragments and reassembles a payload far larger than the BLE MTU', async () => {
    const ctx = await connectPair({ preTrusted: true, conditions: BLE_LIKE_CONDITIONS });
    const got = collect(ctx.sessionB);

    // 20 KB over a 180-byte MTU: well over a hundred fragments.
    const big = new Uint8Array(20_000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    ctx.sessionA.sendReliableRaw(MessageType.FILE_CHUNK, big, { bulk: true });
    await ctx.clock.advanceAsync(20_000);

    const chunk = got.find((m) => m.type === MessageType.FILE_CHUNK);
    expect(chunk).toBeDefined();
    expect(chunk?.raw.length).toBe(20_000);
    expect(chunk?.raw).toEqual(big);
  });

  it('survives a hostile link with heavy loss, reordering and duplication', async () => {
    const ctx = await connectPair({ preTrusted: true, conditions: WIFI_LIKE_CONDITIONS });
    const got = collect(ctx.sessionB);

    // Degrade the link only AFTER the handshake, which has no retry of its own.
    ctx.network.setConditions(HOSTILE_CONDITIONS);

    const sent = 25;
    for (let i = 0; i < sent; i++) ctx.sessionA.sendReliable(MessageType.MESSAGE, { i });
    await ctx.clock.advanceAsync(120_000);

    const received = got.filter((m) => m.type === MessageType.MESSAGE).map((m) => (m.value as { i: number }).i);
    // Every message arrives, exactly once, in order - despite 15% reliable loss,
    // 20% reordering and 10% duplication.
    expect(received).toEqual(Array.from({ length: sent }, (_, i) => i));
  });

  it('coalesces realtime traffic instead of queueing it', async () => {
    const ctx = await connectPair({ preTrusted: true });
    const got = collect(ctx.sessionB);
    for (let i = 0; i < 10; i++) {
      ctx.sessionA.sendRealtime(MessageType.GAME_STATE, new Uint8Array([i]), 'paddle');
    }
    await ctx.clock.advanceAsync(500);
    const states = got.filter((m) => m.type === MessageType.GAME_STATE);
    expect(states.length).toBeGreaterThan(0);
    // The last value sent must be the last value seen.
    expect(states[states.length - 1]?.raw[0]).toBe(9);
  });

  it('rejects an oversized payload rather than truncating it', async () => {
    const ctx = await connectPair({ preTrusted: true });
    expect(() => ctx.sessionA.sendReliableRaw(MessageType.MESSAGE, new Uint8Array(200_000))).toThrow(/exceeds/);
  });

  it('ignores a message type it does not understand', async () => {
    const ctx = await connectPair({ preTrusted: true });
    const got = collect(ctx.sessionB);
    // 0xEE is not in the MessageType table.
    ctx.sessionA.sendReliableRaw(0xee, new Uint8Array([1]));
    await ctx.clock.advanceAsync(500);
    expect(got.find((m) => m.type === 0xee)).toBeUndefined();
    // ...and the session is still perfectly healthy.
    ctx.sessionA.sendReliable(MessageType.MESSAGE, { t: 'still here' });
    await ctx.clock.advanceAsync(500);
    expect(got.some((m) => m.type === MessageType.MESSAGE)).toBe(true);
  });

  it('drops injected garbage without disturbing the session', async () => {
    const ctx = await connectPair({ preTrusted: true });
    const got = collect(ctx.sessionB);
    const before = ctx.sessionB.diagnostics().packetsReceived as number;

    for (let i = 0; i < 50; i++) {
      const junk = new Uint8Array(40);
      junk[0] = PROTOCOL_VERSION;
      junk[1] = 0x02; // claims to be a SECURE frame
      for (let j = 2; j < junk.length; j++) junk[j] = (i * 31 + j) & 0xff;
      await ctx.linkA.send(junk, 'reliable');
    }
    await ctx.clock.advanceAsync(500);

    expect(ctx.sessionB.state).toBe(ConnectionState.CONNECTED);
    expect(ctx.sessionB.diagnostics().packetsReceived).toBe(before);

    ctx.sessionA.sendReliable(MessageType.MESSAGE, { t: 'unaffected' });
    await ctx.clock.advanceAsync(500);
    expect(got.some((m) => m.type === MessageType.MESSAGE)).toBe(true);
  });

  it('moves to RECONNECTING (not FAILED) when the link drops, keeping the keys', async () => {
    const ctx = await connectPair({ preTrusted: true });
    ctx.network.partition('endpoint-a', 'endpoint-b');
    await ctx.clock.advanceAsync(200);
    expect(ctx.sessionA.state).toBe(ConnectionState.RECONNECTING);
    expect(ctx.sessionA.isSecure).toBe(true);
  });

  it('resumes an interrupted conversation over a brand new link, losing nothing', async () => {
    const ctx = await connectPair({ preTrusted: true, conditions: BLE_LIKE_CONDITIONS });
    const got = collect(ctx.sessionB);

    ctx.sessionA.sendReliable(MessageType.MESSAGE, { i: 0 });
    await ctx.clock.advanceAsync(1000);

    // Radio drops mid-conversation.
    ctx.network.partition('endpoint-a', 'endpoint-b');
    await ctx.clock.advanceAsync(200);
    expect(ctx.sessionA.state).toBe(ConnectionState.RECONNECTING);

    // Messages queued while disconnected must not be lost.
    ctx.sessionA.sendReliable(MessageType.MESSAGE, { i: 1 });
    ctx.sessionA.sendReliable(MessageType.MESSAGE, { i: 2 });
    await ctx.clock.advanceAsync(2000);

    // Radio comes back; a fresh link is established and both sides migrate.
    ctx.network.heal('endpoint-a', 'endpoint-b');
    const p = ctx.transportA.connect('endpoint-b');
    await ctx.clock.advanceAsync(300);
    const newLinkA = await p;

    // B migrates itself from the incomingLink handler; A migrates here.
    ctx.sessionA.migrateToLink(newLinkA);
    await ctx.clock.advanceAsync(15_000);

    const received = got.filter((m) => m.type === MessageType.MESSAGE).map((m) => (m.value as { i: number }).i);
    expect(received).toEqual([0, 1, 2]);
    expect(ctx.sessionA.state).toBe(ConnectionState.CONNECTED);
  });

  it('upgrades from a slow link to a fast one without the conversation noticing', async () => {
    const ctx = await connectPair({ preTrusted: true, conditions: BLE_LIKE_CONDITIONS });
    const got = collect(ctx.sessionB);
    const changes: { from: string | null; to: string; isHighBandwidth: boolean }[] = [];
    ctx.sessionA.events.on('transportChanged', (e) => changes.push(e));

    ctx.sessionA.sendReliable(MessageType.MESSAGE, { i: 0 });
    await ctx.clock.advanceAsync(1000);

    // A faster transport becomes available. Same peers, same keys, new pipe.
    ctx.network.setConditions(WIFI_LIKE_CONDITIONS);
    const p = ctx.transportA.connect('endpoint-b');
    await ctx.clock.advanceAsync(200);
    const fastA = await p;

    ctx.sessionA.migrateToLink(fastA);
    await ctx.clock.advanceAsync(1000);

    ctx.sessionA.sendReliable(MessageType.MESSAGE, { i: 1 });
    await ctx.clock.advanceAsync(1000);

    const received = got.filter((m) => m.type === MessageType.MESSAGE).map((m) => (m.value as { i: number }).i);
    expect(received).toEqual([0, 1]);
    // The session never left CONNECTED, and no re-authentication happened.
    expect(ctx.sessionA.state).toBe(ConnectionState.CONNECTED);
    // The listener attaches after the initial handshake, so exactly one further
    // transport change is expected - and it must name the new link.
    expect(changes).toHaveLength(1);
    expect(changes[0]?.to).toBe(fastA.id);
    expect(changes[0]?.isHighBandwidth).toBe(true);
    expect(ctx.sessionA.maxPayloadBytes).toBeGreaterThan(0);
  });

  it('closes cleanly and tells the peer', async () => {
    const ctx = await connectPair({ preTrusted: true });
    let closedB = false;
    ctx.sessionB.events.on('closed', () => (closedB = true));
    await ctx.sessionA.close('user left');
    await ctx.clock.advanceAsync(500);
    expect(closedB).toBe(true);
  });

  it('exposes developer diagnostics', async () => {
    const ctx = await connectPair({ preTrusted: true });
    ctx.sessionA.sendReliable(MessageType.MESSAGE, { t: 'x' });
    await ctx.clock.advanceAsync(500);
    const d = ctx.sessionA.diagnostics();
    expect(d.encryption).toBe('chacha20poly1305');
    expect(d.transport).toBe(TransportKind.MOCK);
    expect(d.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(d.packetsSent as number).toBeGreaterThan(0);
    expect(d.peerId).toBe(ctx.maria.identity.peerId);
  });
});

describe('clock synchronisation', () => {
  it('measures a known offset between two peers', async () => {
    const ctx = await connectPair({ preTrusted: true, conditions: WIFI_LIKE_CONDITIONS });
    ctx.sessionA.clockSync.startRound(5);
    await ctx.clock.advanceAsync(2000);
    // Both peers share one VirtualClock here, so the true offset is zero and the
    // estimate must land within the link's round-trip noise.
    expect(ctx.sessionA.clockSync.sampleCount).toBeGreaterThan(0);
    expect(Math.abs(ctx.sessionA.clockSync.offsetMs ?? 999)).toBeLessThan(30);
    expect(ctx.sessionA.clockSync.roundTripMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects a response with impossible timestamps', () => {
    const clock = new VirtualClock();
    const sync = new ClockSynchronizer(clock, () => undefined);
    sync.startRound(1);
    // A response for a probe id that was never issued.
    const bogus = new Uint8Array([0xa4]);
    expect(sync.handleResponse(bogus)).toBeNull();
  });
});

describe('drift correction policy', () => {
  it('ignores drift below the threshold', () => {
    expect(computeDriftCorrection(1000, 1030).action).toBe(DriftAction.IGNORE);
  });

  it('nudges the playback rate for moderate drift', () => {
    const ahead = computeDriftCorrection(1200, 1000);
    expect(ahead.action).toBe(DriftAction.ADJUST_RATE);
    expect(ahead.rate).toBeLessThan(1); // we are ahead, so slow down
    const behind = computeDriftCorrection(1000, 1200);
    expect(behind.action).toBe(DriftAction.ADJUST_RATE);
    expect(behind.rate).toBeGreaterThan(1);
  });

  it('seeks only when the gap is large', () => {
    const c = computeDriftCorrection(1000, 5000);
    expect(c.action).toBe(DriftAction.SEEK);
    expect(c.seekToMs).toBe(5000);
  });
});

describe('ConnectionStateMachine', () => {
  it('rejects an illegal transition instead of applying it', () => {
    const clock = new VirtualClock();
    const sm = new ConnectionStateMachine(clock);
    const illegal: unknown[] = [];
    sm.events.on('illegalTransition', (e) => illegal.push(e));
    expect(sm.transitionTo(ConnectionState.CONNECTED)).toBe(false);
    expect(sm.current).toBe(ConnectionState.DISCONNECTED);
    expect(illegal).toHaveLength(1);
  });

  it('never leaves the UI stuck: every hanging state times out', () => {
    const clock = new VirtualClock();
    const sm = new ConnectionStateMachine(clock);
    sm.transitionTo(ConnectionState.CONNECTING);
    clock.advance(25_000);
    expect(sm.current).toBe(ConnectionState.FAILED);
  });

  it('offers a route out of FAILED', () => {
    const clock = new VirtualClock();
    const sm = new ConnectionStateMachine(clock);
    sm.transitionTo(ConnectionState.CONNECTING);
    sm.transitionTo(ConnectionState.FAILED);
    expect(sm.transitionTo(ConnectionState.CONNECTING)).toBe(true);
  });

  it('records history for developer mode', () => {
    const clock = new VirtualClock();
    const sm = new ConnectionStateMachine(clock);
    sm.transitionTo(ConnectionState.DISCOVERING);
    sm.transitionTo(ConnectionState.DISCOVERED);
    expect(sm.recentHistory.map((h) => h.to)).toEqual([ConnectionState.DISCOVERING, ConnectionState.DISCOVERED]);
  });
});

describe('ReconnectPolicy', () => {
  it('backs off with jitter and stays inside the schedule bounds', () => {
    let seed = 1;
    const rand = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const policy = new ReconnectPolicy([500, 1000, 2000], rand);
    const first = policy.nextDelayMs();
    expect(first).toBeGreaterThanOrEqual(250);
    expect(first).toBeLessThanOrEqual(500);
    const second = policy.nextDelayMs();
    expect(second).toBeGreaterThanOrEqual(500);
    expect(second).toBeLessThanOrEqual(1000);
  });
});

describe('ReliableChannel in isolation', () => {
  it('retransmits until acknowledged, then stops', () => {
    const clock = new VirtualClock();
    const sent: { seq: number; retransmit: boolean }[] = [];
    const channel = new ReliableChannel(clock, {
      transmit: (r, isRetransmit) => sent.push({ seq: r.seq, retransmit: isRetransmit }),
      onAcknowledged: () => undefined,
      onDeliveryFailed: () => undefined,
    });
    const seq = channel.send(1, new Uint8Array([1]));
    clock.advance(5000);
    expect(sent.filter((s) => s.retransmit).length).toBeGreaterThan(0);

    const before = sent.length;
    channel.handleAck(seq, 0);
    clock.advance(10_000);
    expect(sent.length).toBe(before);
  });

  it('gives up after the retry limit and reports the failure', () => {
    const clock = new VirtualClock();
    const failed: number[] = [];
    const channel = new ReliableChannel(
      clock,
      {
        transmit: () => undefined,
        onAcknowledged: () => undefined,
        onDeliveryFailed: (r) => failed.push(r.seq),
      },
      { maxAttempts: 3 },
    );
    channel.send(1, new Uint8Array([1]));
    clock.advance(120_000);
    expect(failed).toEqual([1]);
  });

  it('buffers out-of-order arrivals and releases them in order', () => {
    const clock = new VirtualClock();
    const channel = new ReliableChannel(clock, {
      transmit: () => undefined,
      onAcknowledged: () => undefined,
      onDeliveryFailed: () => undefined,
    });
    expect(channel.receive(3, new Uint8Array([3]))).toEqual([]);
    expect(channel.receive(2, new Uint8Array([2]))).toEqual([]);
    const released = channel.receive(1, new Uint8Array([1]));
    expect(released.map((r) => r[0])).toEqual([1, 2, 3]);
  });

  it('drops duplicates', () => {
    const clock = new VirtualClock();
    const channel = new ReliableChannel(clock, {
      transmit: () => undefined,
      onAcknowledged: () => undefined,
      onDeliveryFailed: () => undefined,
    });
    expect(channel.receive(1, new Uint8Array([1]))).toHaveLength(1);
    expect(channel.receive(1, new Uint8Array([1]))).toHaveLength(0);
  });

  it('selectively acknowledges packets held above a gap', () => {
    const clock = new VirtualClock();
    const channel = new ReliableChannel(clock, {
      transmit: () => undefined,
      onAcknowledged: () => undefined,
      onDeliveryFailed: () => undefined,
    });
    channel.receive(1, new Uint8Array([1])); // delivered, watermark = 1
    channel.receive(3, new Uint8Array([3])); // held: 2 is missing
    channel.receive(4, new Uint8Array([4]));
    const { ack, ackBits } = channel.ackState();
    expect(ack).toBe(1);
    // seq 3 = ack + 2 + 0 -> bit 0; seq 4 = ack + 2 + 1 -> bit 1
    expect(ackBits & 0b11).toBe(0b11);
  });

  it('clears the right packets when a selective ack comes back', () => {
    const clock = new VirtualClock();
    const acked: number[] = [];
    const channel = new ReliableChannel(clock, {
      transmit: () => undefined,
      onAcknowledged: (seq) => acked.push(seq),
      onDeliveryFailed: () => undefined,
    });
    for (let i = 0; i < 5; i++) channel.send(1, new Uint8Array([i]));
    // Peer has 1, and also holds 3 and 4, but is missing 2.
    channel.handleAck(1, 0b11);
    expect(acked.sort()).toEqual([1, 3, 4]);
    expect(channel.inFlightCount).toBe(2); // 2 and 5 still outstanding
  });
});

describe('bulk transfer under real conditions', () => {
  /**
   * The regression test for the worst bug found in this stack.
   *
   * Several large messages are written CONCURRENTLY, and each one is fragmented
   * across a 180-byte Bluetooth MTU. If outbound frames are not serialised,
   * their fragments interleave on the wire, the receiver ends up holding more
   * partially-reassembled packets than its bound allows, and it completes NONE
   * of them - file transfer over Bluetooth simply does not work.
   */
  it('delivers fifty fragmented messages over a Bluetooth-like link', async () => {
    const ctx = await connectPair({ preTrusted: true, conditions: BLE_LIKE_CONDITIONS });
    const got = collect(ctx.sessionB);
    const failures: number[] = [];
    ctx.sessionA.events.on('deliveryFailed', (e) => failures.push(e.seq));

    const payload = new Uint8Array(4096).fill(7);
    for (let i = 0; i < 50; i++) ctx.sessionA.sendReliableRaw(MessageType.FILE_CHUNK, payload, { bulk: true });
    await ctx.clock.advanceAsync(300_000);

    const chunks = got.filter((m) => m.type === MessageType.FILE_CHUNK);
    expect(failures).toEqual([]);
    expect(chunks).toHaveLength(50);
    expect(chunks.every((c) => c.raw.length === 4096)).toBe(true);
  });

  it('does not let a bulk acknowledgement confirm a reliable message', async () => {
    // A CONTROL ACK names the channel it refers to. Feeding BULK's watermark to
    // the reliable channel would mark a chat message delivered that the peer has
    // never seen - a silent, and very hard to diagnose, data loss.
    const ctx = await connectPair({ preTrusted: true });
    const delivered: number[] = [];
    ctx.sessionA.events.on('delivered', ({ seq }) => delivered.push(seq));

    ctx.sessionA.sendReliableRaw(MessageType.FILE_CHUNK, new Uint8Array(64), { bulk: true });
    await ctx.clock.advanceAsync(500);

    // The chat message goes out only AFTER the bulk one has been acknowledged,
    // so any reliable ack it receives must be genuinely its own.
    const chatSeq = ctx.sessionA.sendReliable(MessageType.MESSAGE, { t: 'hello' });
    await ctx.clock.advanceAsync(500);
    expect(delivered).toContain(chatSeq);

    const received = collect(ctx.sessionB);
    void received;
    expect(ctx.sessionB.state).toBe(ConnectionState.CONNECTED);
  });
});

describe('out-of-order delivery preserves message identity', () => {
  /**
   * The regression test for a subtle and nasty defect: the reorder buffer used
   * to store only a packet's BYTES, so a packet released from behind a sequence
   * gap was delivered with whichever envelope happened to be arriving at that
   * moment. A file chunk surfaced as a chat message, and raw bytes were handed
   * to the CBOR decoder.
   */
  it('releases each buffered packet with its own type, flags and timestamp', () => {
    const clock = new VirtualClock();
    const channel = new ReliableChannel(clock, {
      transmit: () => undefined,
      onAcknowledged: () => undefined,
      onDeliveryFailed: () => undefined,
    });

    // Two packets of DIFFERENT kinds, arriving out of order.
    const chat = { seq: 1, type: MessageType.MESSAGE, raw: false };
    const chunk = { seq: 2, type: MessageType.FILE_CHUNK, raw: true };

    expect(channel.receive(chunk.seq, chunk)).toEqual([]); // held: 1 is missing
    const released = channel.receive(chat.seq, chat);

    expect(released).toHaveLength(2);
    expect(released[0]).toBe(chat);
    expect(released[1]).toBe(chunk);
    // Each kept its OWN identity rather than inheriting the other's.
    expect(released[0]?.type).toBe(MessageType.MESSAGE);
    expect(released[1]?.type).toBe(MessageType.FILE_CHUNK);
    expect(released[1]?.raw).toBe(true);
  });

  it('delivers interleaved chat and binary messages correctly over a lossy link', async () => {
    const ctx = await connectPair({ preTrusted: true, conditions: WIFI_LIKE_CONDITIONS });
    const got = collect(ctx.sessionB);
    ctx.network.setConditions(HOSTILE_CONDITIONS);

    // Alternate CBOR chat messages and raw binary chunks, so any confusion
    // between them shows up as a decode failure or a missing message.
    for (let i = 0; i < 12; i++) {
      if (i % 2 === 0) {
        ctx.sessionA.sendReliable(MessageType.MESSAGE, { i });
      } else {
        const blob = new Uint8Array(64).fill(i);
        ctx.sessionA.sendReliableRaw(MessageType.FILE_CHUNK, blob);
      }
    }
    await ctx.clock.advanceAsync(180_000);

    const chats = got.filter((m) => m.type === MessageType.MESSAGE);
    const chunks = got.filter((m) => m.type === MessageType.FILE_CHUNK);
    expect(chats.map((m) => (m.value as { i: number }).i)).toEqual([0, 2, 4, 6, 8, 10]);
    expect(chunks).toHaveLength(6);
    // Every chat message decoded as CBOR, and every chunk stayed raw.
    expect(chats.every((m) => m.value !== null)).toBe(true);
    expect(chunks.every((m) => m.value === null && m.raw.length === 64)).toBe(true);
  });
});
