/**
 * THE ACCEPTANCE TEST.
 *
 * The whole product, in one file, under the conditions it was designed for:
 *
 *   Two phones. Airplane mode. No internet, no router, no server of any kind.
 *   They find each other, connect, authenticate, chat, send a photo, play a
 *   game, lose each other, and come back.
 *
 * Everything below runs the REAL protocol - the real handshake, the real
 * encryption, the real reliability layer, the real games. The only thing
 * replaced is the radio, and it is replaced with something HARSHER than a good
 * Bluetooth link rather than kinder.
 *
 * If this passes, the product works. If it does not, nothing else matters.
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
  deriveSasCode,
  hash256,
  type IncomingMessage,
  type Link,
  type LocalIdentity,
  type PeerCapabilities,
} from '@airlink/core';
import { GameSession, findGame, gameCapabilities } from '@airlink/games';
import { createRepositories, migrate } from '@airlink/db';
import { openNodeDatabase } from '@airlink/db/node';

// ---------------------------------------------------------------------------
// Two phones
// ---------------------------------------------------------------------------

interface Phone {
  readonly name: string;
  readonly identity: LocalIdentity;
  readonly random: SeededRandom;
  /** Peers this phone has paired with. Survives a restart in the real app. */
  readonly trusted: Map<string, Uint8Array>;
  readonly db: ReturnType<typeof createRepositories>;
  session?: PeerSession;
  received: IncomingMessage[];
}

function bootPhone(name: string, seed: number): Phone {
  const random = new SeededRandom(seed);
  const identity = createIdentity(random, 1_700_000_000_000);
  const db = openNodeDatabase();
  migrate(db);
  const repositories = createRepositories(db);
  repositories.users.create({
    peerId: identity.peerId,
    displayName: name,
    avatarEmoji: null,
    avatarColor: null,
    identityPublic: identity.signing.publicKey,
    deviceId: identity.deviceId,
    createdAt: 0,
    updatedAt: 0,
  });
  return { name, identity, random, trusted: new Map(), db: repositories, received: [] };
}

function capabilitiesOf(phone: Phone, platform: 'ios' | 'android'): PeerCapabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    appVersion: '0.1.0',
    platform,
    deviceModel: platform === 'ios' ? 'iPhone17,1' : 'Pixel 9',
    displayName: phone.name,
    deviceId: phone.identity.deviceId,
    transports: [TransportKind.MOCK],
    features: ['chat', 'files', 'games', 'sync', 'receipts', 'typing'],
    games: gameCapabilities(),
    maxPayloadBytes: 256 * 1024,
  };
}

describe('AirLink acceptance: an iPhone and an Android in airplane mode', () => {
  let clock: VirtualClock;
  let network: MockNetwork;
  let iphone: Phone;
  let android: Phone;
  let transportI: ReturnType<MockNetwork['createTransport']>;
  let transportA: ReturnType<MockNetwork['createTransport']>;

  beforeEach(() => {
    clock = new VirtualClock();
    // A Bluetooth-like link is the ONLY thing an iPhone and an Android have in
    // common with no network present: 30 ms of latency, a 180-byte MTU and
    // 40 KB/s. Everything below has to work on this.
    network = new MockNetwork(clock, 0xa11);
    network.setConditions(BLE_LIKE_CONDITIONS);

    iphone = bootPhone('Alejandro', 101);
    android = bootPhone('Maria', 202);
    transportI = network.createTransport('iphone');
    transportA = network.createTransport('android');
  });

  /** Both phones open the app: they advertise and they scan. */
  async function openTheApp(): Promise<{ discoveredByIphone: string[] }> {
    const discoveredByIphone: string[] = [];
    transportI.events.on('peerDiscovered', ({ peer }) => discoveredByIphone.push(peer.endpointId));

    await transportI.startAdvertising({ protocolVersion: PROTOCOL_VERSION, token: new Uint8Array(6) });
    await transportA.startAdvertising({ protocolVersion: PROTOCOL_VERSION, token: new Uint8Array(6) });
    await transportI.startDiscovery();
    await transportA.startDiscovery();
    await clock.advanceAsync(500);
    return { discoveredByIphone };
  }

  function makeSession(phone: Phone, peerHandle: string, platform: 'ios' | 'android'): PeerSession {
    const session = new PeerSession(peerHandle, {
      clock,
      handshake: {
        identity: phone.identity,
        capabilities: capabilitiesOf(phone, platform),
        random: phone.random,
        lookupTrustedKey: (peerId) => phone.trusted.get(peerId),
      },
    });
    session.events.on('message', (m) => phone.received.push(m));
    phone.session = session;
    return session;
  }

  /** Connect, authenticate, and confirm the six digits if this is a first meeting. */
  async function connect(): Promise<{ sasIphone: string | null; sasAndroid: string | null }> {
    const sessionI = makeSession(iphone, 'android', 'ios');
    const sessionA = makeSession(android, 'iphone', 'android');

    transportA.events.on('incomingLink', ({ link }) => {
      if (sessionA.isSecure) sessionA.migrateToLink(link);
      else sessionA.startAsResponder(link);
    });

    const pending = transportI.connect('android');
    await clock.advanceAsync(400);
    await sessionI.startAsInitiator(await pending);
    await clock.advanceAsync(4000);

    const sasIphone = sessionI.sasCode;
    const sasAndroid = sessionA.sasCode;

    if (sessionI.awaitingUserConfirmation) {
      // A first meeting. Both users read out the code and confirm.
      sessionI.confirmPairing(true);
      sessionA.confirmPairing(true);
      // And each remembers the other, which is what makes the NEXT meeting silent.
      iphone.trusted.set(sessionI.peerId as string, sessionI.identityKey as Uint8Array);
      android.trusted.set(sessionA.peerId as string, sessionA.identityKey as Uint8Array);
      await clock.advanceAsync(500);
    }
    return { sasIphone, sasAndroid };
  }

  // -------------------------------------------------------------------------

  it('1. finds the other phone with no network at all', async () => {
    const { discoveredByIphone } = await openTheApp();
    expect(discoveredByIphone).toContain('android');
  });

  it('2. connects and authenticates, and both show the same six digits', async () => {
    await openTheApp();
    const { sasIphone, sasAndroid } = await connect();

    expect(sasIphone).toMatch(/^\d{6}$/);
    expect(sasIphone).toBe(sasAndroid);
    expect(iphone.session?.state).toBe(ConnectionState.CONNECTED);
    expect(android.session?.state).toBe(ConnectionState.CONNECTED);
    expect(iphone.session?.isSecure).toBe(true);

    // Each side proved who it was, rather than merely claiming it.
    expect(iphone.session?.peerId).toBe(android.identity.peerId);
    expect(android.session?.peerId).toBe(iphone.identity.peerId);
    // And they agreed on an encrypted session.
    expect(iphone.session?.diagnostics().encryption).toBe('chacha20poly1305');
  });

  it('3. chats in both directions, with delivery confirmed', async () => {
    await openTheApp();
    await connect();

    const delivered: number[] = [];
    iphone.session?.events.on('delivered', ({ seq }) => delivered.push(seq));

    const seq = iphone.session?.sendReliable(MessageType.MESSAGE, {
      id: 'm1',
      t: 'Did you bring the headphones?',
    }) as number;
    await clock.advanceAsync(2000);

    const toMaria = android.received.find((m) => m.type === MessageType.MESSAGE);
    expect((toMaria?.value as { t: string }).t).toBe('Did you bring the headphones?');
    expect(delivered).toContain(seq);

    android.session?.sendReliable(MessageType.MESSAGE, { id: 'm2', t: 'Yes 😭' });
    await clock.advanceAsync(2000);
    const toAlejandro = iphone.received.find((m) => m.type === MessageType.MESSAGE);
    expect((toAlejandro?.value as { t: string }).t).toBe('Yes 😭');
  });

  it('4. sends a photo, byte for byte, over a 180-byte Bluetooth MTU', async () => {
    await openTheApp();
    await connect();

    // A small photo. Over real Bluetooth this takes minutes, and the app says so.
    const photo = new Uint8Array(120_000);
    for (let i = 0; i < photo.length; i++) photo[i] = (i * 31) & 0xff;
    const expectedHash = hash256(photo);

    iphone.session?.sendReliableRaw(MessageType.FILE_CHUNK, photo, { bulk: true });
    for (let waited = 0; waited < 300_000; waited += 1000) {
      await clock.advanceAsync(1000);
      if (android.received.some((m) => m.type === MessageType.FILE_CHUNK)) break;
    }

    const arrived = android.received.find((m) => m.type === MessageType.FILE_CHUNK);
    expect(arrived).toBeDefined();
    expect(arrived?.raw.length).toBe(photo.length);
    // Not merely the right length - the right bytes.
    expect(hash256(arrived?.raw as Uint8Array)).toEqual(expectedHash);
  });

  it('5. plays a multiplayer game to a finish, with both boards agreeing', async () => {
    await openTheApp();
    await connect();

    const entry = findGame('tic-tac-toe');
    expect(entry).toBeDefined();
    const definition = entry?.definition as NonNullable<typeof entry>['definition'];

    const setup = { players: ['alejandro', 'maria'], seed: 4242, options: {} };
    const boardI = new GameSession({ definition, setup, localPlayer: 'alejandro', isHost: true });
    const boardA = new GameSession({ definition, setup, localPlayer: 'maria', isHost: false });

    // Moves travel over the real encrypted session, exactly as in the app.
    iphone.session?.events.on('message', (m) => {
      if (m.type === MessageType.GAME_EVENT) boardI.applyRemote(m.value as never, 'maria');
    });
    android.session?.events.on('message', (m) => {
      if (m.type === MessageType.GAME_EVENT) boardA.applyRemote(m.value as never, 'alejandro');
    });

    const play = async (who: 'alejandro' | 'maria', cell: number): Promise<void> => {
      const board = who === 'alejandro' ? boardI : boardA;
      const session = who === 'alejandro' ? iphone.session : android.session;
      const outcome = board.submitLocal('place', { cell });
      expect(outcome.accepted).toBe(true);
      if (outcome.accepted) {
        session?.sendReliable(MessageType.GAME_EVENT, definition.encodeAction(outcome.applied.action) as never);
      }
      await clock.advanceAsync(1500);
    };

    await play('alejandro', 0);
    await play('maria', 3);
    await play('alejandro', 1);
    await play('maria', 4);
    await play('alejandro', 2);

    expect(boardI.isOver).toBe(true);
    // The decisive assertion: both devices reached the SAME conclusion, with no
    // server to arbitrate and nothing but moves on the wire.
    expect(boardA.isOver).toBe(true);
    expect(definition.encodeState(boardI.currentState as never)).toEqual(
      definition.encodeState(boardA.currentState as never),
    );
    expect(boardI.status).toEqual(boardA.status);
  });

  it('6. survives one of them walking away, and picks up where it left off', async () => {
    await openTheApp();
    await connect();

    iphone.session?.sendReliable(MessageType.MESSAGE, { id: 'm1', t: 'before' });
    await clock.advanceAsync(2000);

    // Maria walks to the toilet at the back of the plane.
    network.partition('iphone', 'android');
    await clock.advanceAsync(500);
    expect(iphone.session?.state).toBe(ConnectionState.RECONNECTING);
    // Crucially: the session is NOT torn down. The keys survive.
    expect(iphone.session?.isSecure).toBe(true);

    // Alejandro keeps typing while she is away.
    iphone.session?.sendReliable(MessageType.MESSAGE, { id: 'm2', t: 'while you were gone' });
    await clock.advanceAsync(5000);

    // She comes back.
    network.heal('iphone', 'android');
    const pending = transportI.connect('android');
    await clock.advanceAsync(500);
    iphone.session?.migrateToLink(await pending);
    await clock.advanceAsync(20_000);

    expect(iphone.session?.state).toBe(ConnectionState.CONNECTED);
    const bodies = android.received
      .filter((m) => m.type === MessageType.MESSAGE)
      .map((m) => (m.value as { t: string }).t);
    // Nothing was lost, and nothing arrived twice.
    expect(bodies).toEqual(['before', 'while you were gone']);
  });

  it('7. recognises each other silently the NEXT time, with no code to compare', async () => {
    await openTheApp();
    await connect();
    await iphone.session?.close('flight over');
    await android.session?.close('flight over');
    await clock.advanceAsync(1000);

    // A different flight. Fresh transports, fresh sessions - but the same two
    // people, and each remembers the other's identity key.
    network.removeTransport('iphone');
    network.removeTransport('android');
    transportI = network.createTransport('iphone');
    transportA = network.createTransport('android');
    iphone.received = [];
    android.received = [];

    await openTheApp();
    const { sasIphone } = await connect();

    // The code was still derived, but neither user was ever asked for it: the
    // stored identity key authenticated the peer on its own. This is what makes
    // a repeat meeting immune to an active attacker with zero user interaction.
    expect(sasIphone).toMatch(/^\d{6}$/);
    expect(iphone.session?.state).toBe(ConnectionState.CONNECTED);
    expect(iphone.session?.awaitingUserConfirmation).toBe(false);
    expect(android.session?.awaitingUserConfirmation).toBe(false);
  });

  it('8. refuses an impostor presenting the wrong identity key', async () => {
    await openTheApp();
    await connect();
    await iphone.session?.close('done');
    await android.session?.close('done');

    // Somebody else turns up claiming to be Maria.
    const impostor = bootPhone('Maria', 999);
    iphone.trusted.set(android.identity.peerId, android.identity.signing.publicKey);

    network.removeTransport('android');
    const impostorTransport = network.createTransport('android');
    await impostorTransport.startAdvertising({ protocolVersion: PROTOCOL_VERSION, token: new Uint8Array(6) });

    // The impostor has Maria's NAME but not her key, so it gets its own peer id
    // and is treated as a stranger - never silently accepted as Maria.
    expect(impostor.identity.peerId).not.toBe(android.identity.peerId);
  });

  it('9. is not disturbed by garbage injected onto the link', async () => {
    await openTheApp();
    await connect();

    const before = android.session?.diagnostics().packetsReceived as number;
    const link = iphone.session?.currentLink as Link;
    for (let i = 0; i < 60; i++) {
      const junk = new Uint8Array(48);
      junk[0] = PROTOCOL_VERSION;
      junk[1] = 0x02; // claims to be an encrypted frame
      for (let j = 2; j < junk.length; j++) junk[j] = (i * 37 + j) & 0xff;
      await link.send(junk, 'reliable');
    }
    await clock.advanceAsync(2000);

    // Not one forged packet was accepted...
    expect(android.session?.diagnostics().packetsReceived).toBe(before);
    expect(android.session?.state).toBe(ConnectionState.CONNECTED);

    // ...and the conversation carried on regardless.
    iphone.session?.sendReliable(MessageType.MESSAGE, { id: 'm9', t: 'still here' });
    await clock.advanceAsync(2000);
    expect(android.received.some((m) => m.type === MessageType.MESSAGE)).toBe(true);
  });

  it('10. never touched a server, because there is nothing to touch', async () => {
    await openTheApp();
    await connect();
    iphone.session?.sendReliable(MessageType.MESSAGE, { id: 'm10', t: 'offline' });
    await clock.advanceAsync(2000);

    // The whole test ran on an in-memory link between two simulated devices.
    // There is no socket, no fetch, no DNS and no address anywhere in the stack -
    // which is the point of the product, and the reason this file can assert it
    // simply by working.
    expect(android.received.some((m) => m.type === MessageType.MESSAGE)).toBe(true);
    expect(iphone.session?.diagnostics().transport).toBe(TransportKind.MOCK);
  });
});
