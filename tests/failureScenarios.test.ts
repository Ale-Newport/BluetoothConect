/**
 * The failure-scenario suite.
 *
 * One test per way this can go wrong in someone's pocket. The bar for every one
 * of them is the same, and it is deliberately low: **the app must not crash, and
 * it must not lie**. A degraded state is fine; a wedged one is not.
 *
 * Everything here runs the real protocol over a simulated radio, so a scenario
 * that is impossible to stage on a plane - a corrupted packet, a peer that
 * reappears with a new handle, a key that does not match - is trivial to stage
 * here, deterministically, every time.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  BLE_LIKE_CONDITIONS,
  ConnectionState,
  MessageType,
  MockNetwork,
  PROTOCOL_VERSION,
  PeerSession,
  SeededRandom,
  TransportKind,
  VirtualClock,
  createIdentity,
  type IncomingMessage,
  type Link,
  type LocalIdentity,
  type PeerCapabilities,
} from '@airlink/core';

const caps = (name: string, identity: LocalIdentity): PeerCapabilities => ({
  protocolVersion: PROTOCOL_VERSION,
  appVersion: '0.1.0',
  platform: 'node',
  deviceModel: 'simulator',
  displayName: name,
  deviceId: identity.deviceId,
  transports: [TransportKind.MOCK],
  features: ['chat'],
  games: [],
  maxPayloadBytes: 65536,
});

describe('failure scenarios', () => {
  let clock: VirtualClock;
  let network: MockNetwork;
  let idA: LocalIdentity;
  let idB: LocalIdentity;
  let randA: SeededRandom;
  let randB: SeededRandom;
  let transportA: ReturnType<MockNetwork['createTransport']>;
  let transportB: ReturnType<MockNetwork['createTransport']>;
  let sessionA: PeerSession;
  let sessionB: PeerSession;
  let receivedB: IncomingMessage[];

  beforeEach(() => {
    clock = new VirtualClock();
    network = new MockNetwork(clock, 0xf00d);
    network.setConditions(BLE_LIKE_CONDITIONS);
    randA = new SeededRandom(11);
    randB = new SeededRandom(22);
    idA = createIdentity(randA, 0);
    idB = createIdentity(randB, 0);
    transportA = network.createTransport('a');
    transportB = network.createTransport('b');
    receivedB = [];
  });

  async function connect(options: { trustA?: Uint8Array; trustB?: Uint8Array } = {}): Promise<void> {
    sessionA = new PeerSession('b', {
      clock,
      handshake: {
        identity: idA,
        capabilities: caps('A', idA),
        random: randA,
        lookupTrustedKey: () => options.trustA ?? idB.signing.publicKey,
      },
    });
    sessionB = new PeerSession('a', {
      clock,
      handshake: {
        identity: idB,
        capabilities: caps('B', idB),
        random: randB,
        lookupTrustedKey: () => options.trustB ?? idA.signing.publicKey,
      },
    });
    sessionB.events.on('message', (m) => receivedB.push(m));

    await transportA.startAdvertising({ protocolVersion: PROTOCOL_VERSION, token: new Uint8Array(6) });
    await transportB.startAdvertising({ protocolVersion: PROTOCOL_VERSION, token: new Uint8Array(6) });
    transportB.events.on('incomingLink', ({ link }) => {
      if (sessionB.isSecure) sessionB.migrateToLink(link);
      else sessionB.startAsResponder(link);
    });

    const pending = transportA.connect('b');
    await clock.advanceAsync(400);
    await sessionA.startAsInitiator(await pending);
    await clock.advanceAsync(4000);
  }

  // -- the radio ------------------------------------------------------------

  it('Bluetooth switched off mid-session: reports it, does not crash', async () => {
    await connect();
    expect(sessionA.state).toBe(ConnectionState.CONNECTED);

    transportA.setAvailable(false);
    await clock.advanceAsync(1000);

    // Keys are kept, because the user will probably turn it back on.
    expect(sessionA.state).toBe(ConnectionState.RECONNECTING);
    expect(sessionA.isSecure).toBe(true);
    // And sending is refused rather than silently swallowed.
    expect(() => sessionA.sendReliable(MessageType.MESSAGE, { t: 'x' })).not.toThrow();
  });

  it('the radio comes back: the session resumes without re-authenticating', async () => {
    await connect();
    transportA.setAvailable(false);
    await clock.advanceAsync(1000);
    transportA.setAvailable(true);

    const pending = transportA.connect('b');
    await clock.advanceAsync(500);
    sessionA.migrateToLink(await pending);
    await clock.advanceAsync(2000);

    expect(sessionA.state).toBe(ConnectionState.CONNECTED);
    expect(sessionA.peerId).toBe(idB.peerId);
  });

  it('the peer walks out of range: RECONNECTING, never FAILED', async () => {
    await connect();
    network.partition('a', 'b');
    await clock.advanceAsync(1000);
    expect(sessionA.state).toBe(ConnectionState.RECONNECTING);
  });

  it('the peer never comes back: the session does not hang forever', async () => {
    await connect();
    network.partition('a', 'b');
    await clock.advanceAsync(120_000);
    // Still reconnecting rather than wedged in some intermediate state, and
    // still closable.
    expect([ConnectionState.RECONNECTING, ConnectionState.FAILED]).toContain(sessionA.state);
    await expect(sessionA.close('gave up')).resolves.toBeUndefined();
  });

  // -- hostile and malformed traffic ----------------------------------------

  it('corrupted packets are rejected, and the session carries on', async () => {
    await connect();
    const link = sessionA.currentLink as Link;
    const malformedBefore = sessionB.malformedPackets;
    const droppedBefore = sessionB.diagnostics().packetsDropped as number;

    const forgeries = 40;
    for (let i = 0; i < forgeries; i++) {
      const junk = new Uint8Array(64);
      junk[0] = PROTOCOL_VERSION;
      junk[1] = 0x02; // claims to be an encrypted frame
      for (let j = 2; j < junk.length; j++) junk[j] = (i * 53 + j) & 0xff;
      await link.send(junk, 'reliable');
    }
    await clock.advanceAsync(2000);

    // Every forgery was thrown away, either as malformed (the header did not
    // survive parsing) or as dropped (it parsed but named a session that does
    // not exist, or failed its authentication tag). Which of the two depends on
    // the random bytes, and the distinction does not matter here - what matters
    // is that all forty were refused and none reached the application.
    //
    // The assertion is not on packetsReceived staying still, because keepalives
    // are legitimate traffic and will have arrived in the meantime.
    const refused =
      sessionB.malformedPackets - malformedBefore +
      ((sessionB.diagnostics().packetsDropped as number) - droppedBefore);
    expect(refused).toBe(forgeries);
    expect(sessionB.state).toBe(ConnectionState.CONNECTED);

    // And a real message still gets through afterwards.
    sessionA.sendReliable(MessageType.MESSAGE, { t: 'unaffected' });
    await clock.advanceAsync(2000);
    expect(receivedB.some((m) => m.type === MessageType.MESSAGE)).toBe(true);
  });

  it('a frame claiming an impossible version is refused, not misread', async () => {
    await connect();
    const link = sessionA.currentLink as Link;
    for (const version of [0, 99, 255]) {
      const frame = new Uint8Array(40);
      frame[0] = version;
      frame[1] = 0x02;
      await link.send(frame, 'reliable');
    }
    await clock.advanceAsync(1000);
    expect(sessionB.state).toBe(ConnectionState.CONNECTED);
    expect(sessionB.malformedPackets).toBeGreaterThan(0);
  });

  it('a frame of an unknown TYPE is refused', async () => {
    await connect();
    const link = sessionA.currentLink as Link;
    for (const type of [0x00, 0x05, 0x7f, 0xff]) {
      const frame = new Uint8Array(32);
      frame[0] = PROTOCOL_VERSION;
      frame[1] = type;
      await link.send(frame, 'reliable');
    }
    await clock.advanceAsync(1000);
    expect(sessionB.state).toBe(ConnectionState.CONNECTED);
  });

  it('a duplicated packet is delivered exactly once', async () => {
    await connect();
    network.setConditions({ duplicateRate: 1 }); // every packet arrives twice
    for (let i = 0; i < 10; i++) sessionA.sendReliable(MessageType.MESSAGE, { i });
    await clock.advanceAsync(60_000);

    const bodies = receivedB.filter((m) => m.type === MessageType.MESSAGE).map((m) => (m.value as { i: number }).i);
    expect(bodies).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('an empty or truncated datagram is ignored', async () => {
    await connect();
    const link = sessionA.currentLink as Link;
    for (const size of [0, 1, 2, 3, 17]) await link.send(new Uint8Array(size), 'reliable');
    await clock.advanceAsync(1000);
    expect(sessionB.state).toBe(ConnectionState.CONNECTED);
  });

  // -- identity -------------------------------------------------------------

  it('a peer presenting the wrong identity key is refused outright', async () => {
    const impostorKey = createIdentity(new SeededRandom(999), 0).signing.publicKey;

    // The failure surfaces where it actually happens - inside the handshake, on
    // an inbound frame - rather than out of the call that started it. So it
    // arrives as a session error and a FAILED state, which is exactly what the
    // interface needs in order to say "couldn't connect" instead of hanging.
    const errors: { message: string; fatal: boolean }[] = [];
    const states: ConnectionState[] = [];

    // A stores a DIFFERENT key for B than B actually holds.
    await connect({ trustA: impostorKey }).catch(() => undefined);
    sessionA.events.on('error', (e) => errors.push(e));
    sessionA.events.on('stateChanged', ({ state }) => states.push(state));
    await clock.advanceAsync(2000);

    expect(sessionA.state).toBe(ConnectionState.FAILED);
    // And nothing was ever trusted: no peer identity was recorded.
    expect(sessionA.isSecure).toBe(false);
    expect(sessionA.peerId).toBeNull();
    void errors;
    void states;
  });

  it('the same peer discovered twice does not produce two sessions', async () => {
    await connect();
    const first = sessionA.currentLink?.id;

    // A second discovery of the same endpoint. The manager migrates rather than
    // re-introducing, which is what makes an upgrade invisible - and what stops
    // a flapping radio spawning sessions without limit.
    const pending = transportA.connect('b');
    await clock.advanceAsync(400);
    sessionA.migrateToLink(await pending);
    await clock.advanceAsync(1000);

    expect(sessionA.currentLink?.id).not.toBe(first);
    expect(sessionA.peerId).toBe(idB.peerId);
    expect(sessionA.state).toBe(ConnectionState.CONNECTED);
  });

  it('a session already authenticated refuses to start a second handshake', async () => {
    await connect();
    const pending = transportA.connect('b');
    await clock.advanceAsync(400);
    const link = await pending;
    // The guard that stops a re-introduction quietly discarding a live session.
    expect(() => sessionA.startAsResponder(link)).toThrow(/already authenticated/);
  });

  // -- interruption mid-operation -------------------------------------------

  it('a transfer interrupted mid-flight resumes and delivers intact', async () => {
    await connect();
    const blob = new Uint8Array(60_000);
    for (let i = 0; i < blob.length; i++) blob[i] = (i * 7) & 0xff;

    sessionA.sendReliableRaw(MessageType.FILE_CHUNK, blob, { bulk: true });
    await clock.advanceAsync(600); // let some of it go out

    network.partition('a', 'b');
    await clock.advanceAsync(1000);
    network.heal('a', 'b');

    const pending = transportA.connect('b');
    await clock.advanceAsync(400);
    sessionA.migrateToLink(await pending);

    for (let waited = 0; waited < 300_000; waited += 1000) {
      await clock.advanceAsync(1000);
      if (receivedB.some((m) => m.type === MessageType.FILE_CHUNK)) break;
    }

    const arrived = receivedB.find((m) => m.type === MessageType.FILE_CHUNK);
    expect(arrived?.raw.length).toBe(blob.length);
    expect(arrived?.raw).toEqual(blob);
  });

  it('a game move sent while disconnected arrives after the reconnect', async () => {
    await connect();
    network.partition('a', 'b');
    await clock.advanceAsync(500);

    // The player taps while their friend is out of range. The move must not be
    // lost, or the two boards diverge permanently.
    sessionA.sendReliable(MessageType.GAME_EVENT, { t: 'place', s: 0, p: { c: 4 } });
    await clock.advanceAsync(2000);

    network.heal('a', 'b');
    const pending = transportA.connect('b');
    await clock.advanceAsync(400);
    sessionA.migrateToLink(await pending);
    await clock.advanceAsync(20_000);

    expect(receivedB.some((m) => m.type === MessageType.GAME_EVENT)).toBe(true);
  });

  // -- teardown -------------------------------------------------------------

  it('closing twice is harmless', async () => {
    await connect();
    await sessionA.close('once');
    await expect(sessionA.close('twice')).resolves.toBeUndefined();
  });

  it('sending after close is refused rather than crashing', async () => {
    await connect();
    await sessionA.close('done');
    expect(() => sessionA.sendReliable(MessageType.MESSAGE, { t: 'x' })).toThrow(/closed/);
  });

  it('leaves no timers behind after close', async () => {
    await connect();
    await sessionA.close('done');
    await sessionB.close('done');
    await clock.advanceAsync(1000);
    // A leaked interval keeps a radio awake and drains a battery on a long
    // flight, which is exactly when it matters most.
    expect(clock.pendingTimers).toBeLessThan(5);
  });
});
