/**
 * The invitation, end to end, over a link that loses things.
 *
 * The bug this exists for was the loudest one on real phones: two friends
 * connected, one picked Chess, and the other never saw a thing. The cause was
 * not the radio. `GameInviteCentre` - the only listener for `GAME_INVITE`
 * outside an already-open game - was built lazily by the Play tab, and a bottom
 * tab does not mount until it is first opened. So on a phone whose owner had
 * been looking at Home since launch, the invitation was decrypted, acknowledged
 * by the reliability layer, delivered to nobody at all, and dropped, while the
 * other phone said "Waiting for your friend…" for forty-five seconds and then
 * claimed there had been no answer.
 *
 * These tests run the REAL centre against REAL `PeerSession`s over a simulated
 * link, because every earlier version of this flow looked correct in isolation.
 */
import {
  BLE_LIKE_CONDITIONS,
  MockNetwork,
  PROTOCOL_VERSION,
  PeerSession,
  VirtualClock,
  createIdentity,
  systemRandom,
  type Link,
  type PeerCapabilities,
} from '@airlink/core';
import { AirLinkClient } from '../src/client/AirLinkClient';
import { inviteCentreFor } from '../src/screens/play/inviteCentre';
import { MessageType, encodeAck, encodeInvite, decodeAck } from '../src/screens/play/gameProtocol';

jest.setTimeout(30000);

function capabilities(name: string, deviceId: string): PeerCapabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    appVersion: '0',
    platform: 'ios',
    deviceModel: 'test',
    displayName: name,
    deviceId,
    transports: [],
    features: ['games'],
    games: [{ id: 'tic-tac-toe', version: 1 }],
    maxPayloadBytes: 65536,
  };
}

/**
 * Two clients with real databases and real profiles, joined by two real
 * sessions over a simulated radio.
 *
 * The handles are placed into each client's map directly. That is the one piece
 * of scaffolding here: `AirLinkClient.connect` dials a native transport, and
 * there is no native transport in Node. Everything above the link - the
 * handshake, the reliability layer, the invite centre - is the real thing.
 */
async function twoConnectedPhones() {
  const clock = new VirtualClock();
  const network = new MockNetwork(clock, 0xa17c);
  network.setConditions(BLE_LIKE_CONDITIONS);

  const alejandro = new AirLinkClient({ appVersion: '0', platform: 'ios', deviceModel: 'test' });
  const maria = new AirLinkClient({ appVersion: '0', platform: 'ios', deviceModel: 'test' });
  await alejandro.load();
  await maria.load();
  await alejandro.createProfile('Alejandro', null);
  await maria.createProfile('Maria', null);

  const idA = createIdentity(systemRandom, 0);
  const idM = createIdentity(systemRandom, 0);
  const trustA = new Map<string, Uint8Array>();
  const trustM = new Map<string, Uint8Array>();

  const transportA = network.createTransport('alejandro');
  const transportM = network.createTransport('maria');

  const sessionA = new PeerSession('maria', {
    clock,
    handshake: {
      identity: idA,
      capabilities: capabilities('Alejandro', idA.deviceId),
      random: systemRandom,
      lookupTrustedKey: (peerId) => trustA.get(peerId),
    },
  });
  const sessionM = new PeerSession('alejandro', {
    clock,
    handshake: {
      identity: idM,
      capabilities: capabilities('Maria', idM.deviceId),
      random: systemRandom,
      lookupTrustedKey: (peerId) => trustM.get(peerId),
    },
  });

  transportM.events.on('incomingLink', ({ link }: { link: Link }) => {
    sessionM.startAsResponder(link);
  });

  const pending = transportA.connect('maria');
  await clock.advanceAsync(400);
  await sessionA.startAsInitiator(await pending);
  await clock.advanceAsync(4000);
  if (sessionA.awaitingUserConfirmation) {
    sessionA.confirmPairing(true);
    sessionM.confirmPairing(true);
    await clock.advanceAsync(600);
  }

  // The profile rows carry the peer ids the invitation names, so they must be
  // the identities the sessions actually negotiated.
  alejandro.db.users.adoptIdentity(idA.peerId, idA.signing.publicKey, idA.deviceId, 0);
  maria.db.users.adoptIdentity(idM.peerId, idM.signing.publicKey, idM.deviceId, 0);

  const handleA = { key: sessionM.peerId as string, peerId: sessionM.peerId, session: sessionA };
  const handleM = { key: sessionA.peerId as string, peerId: sessionA.peerId, session: sessionM };
  (alejandro as unknown as { peers: Map<string, unknown> }).peers.set(handleA.key, handleA);
  (maria as unknown as { peers: Map<string, unknown> }).peers.set(handleM.key, handleM);

  return { clock, network, alejandro, maria, sessionA, sessionM, handleA, handleM };
}

function inviteFor(sessionId: string, inviteId: string, players: string[], expiresAt: number) {
  return encodeInvite({
    inviteId,
    sessionId,
    gameId: 'tic-tac-toe',
    version: 1,
    seed: 7,
    players,
    expiresAt,
  });
}

test('an invitation arrives even though the Play tab was never opened', async () => {
  const { clock, alejandro, maria, sessionA, sessionM } = await twoConnectedPhones();

  // Maria is looking at Home. Her invite centre exists anyway, because
  // ClientProvider builds it at startup rather than leaving it to a screen.
  const centre = inviteCentreFor(maria);
  expect(centre.list()).toHaveLength(0);

  const players = [sessionM.peerId as string, sessionA.peerId as string];
  sessionA.sendReliable(MessageType.GAME_INVITE, inviteFor('game-1', 'inv-1', players, Date.now() + 45000));
  await clock.advanceAsync(2000);

  const invites = centre.list();
  expect(invites).toHaveLength(1);
  expect(invites[0]?.gameId).toBe('tic-tac-toe');
  expect(invites[0]?.inviteId).toBe('inv-1');
});

test('the inviting phone is told its invitation arrived', async () => {
  const { clock, maria, sessionA, sessionM } = await twoConnectedPhones();
  inviteCentreFor(maria);

  const acks: string[] = [];
  sessionA.events.on('message', (message) => {
    if (message.type === MessageType.GAME_INVITE_ACK) {
      const id = decodeAck(message.value);
      if (id) acks.push(id);
    }
  });

  const players = [sessionM.peerId as string, sessionA.peerId as string];
  sessionA.sendReliable(MessageType.GAME_INVITE, inviteFor('game-2', 'inv-2', players, Date.now() + 45000));
  await clock.advanceAsync(3000);

  // This is what lets the waiting screen say "Delivered" instead of guessing,
  // and what lets it stop retrying.
  expect(acks).toContain('inv-2');
});

test('twenty repeats of one invitation produce exactly one question', async () => {
  const { clock, maria, sessionA, sessionM } = await twoConnectedPhones();
  const centre = inviteCentreFor(maria);

  const players = [sessionM.peerId as string, sessionA.peerId as string];
  const expiresAt = Date.now() + 45000;
  for (let i = 0; i < 20; i++) {
    sessionA.sendReliable(MessageType.GAME_INVITE, inviteFor('game-3', 'inv-3', players, expiresAt));
    await clock.advanceAsync(200);
  }
  await clock.advanceAsync(3000);

  expect(centre.list()).toHaveLength(1);
});

test('an invitation survives a link that loses one packet in five', async () => {
  /*
   * The condition the retry loop exists for. Reliable delivery already
   * retransmits, so what is really being proved here is that the two together -
   * retransmission underneath, an application retry on top - never turn one
   * question into two.
   */
  const { clock, network, maria, sessionA, sessionM } = await twoConnectedPhones();
  const centre = inviteCentreFor(maria);

  // The link degrades AFTER the two are connected, which is what actually
  // happens: you sit down next to each other, connect, and then somebody puts
  // their phone in a pocket. Establishing a session under this much loss is a
  // separate question, and `tests/failureScenarios.test.ts` already asks it.
  network.setConditions({ latencyMs: 500, jitterMs: 200, reliableLossRate: 0.2, realtimeLossRate: 0.2 });

  const players = [sessionM.peerId as string, sessionA.peerId as string];
  const expiresAt = Date.now() + 45000;

  // The room's own schedule: ask, then back off, for as long as the window.
  let delay = 1000;
  for (let attempt = 0; attempt < 6; attempt++) {
    sessionA.sendReliable(MessageType.GAME_INVITE, inviteFor('game-4', 'inv-4', players, expiresAt));
    await clock.advanceAsync(delay);
    delay = Math.min(delay * 2, 8000);
  }
  await clock.advanceAsync(5000);

  expect(centre.list()).toHaveLength(1);
});

test('an answered invitation is not asked again when the invite is repeated', async () => {
  const { clock, maria, sessionA, sessionM } = await twoConnectedPhones();
  const centre = inviteCentreFor(maria);

  const players = [sessionM.peerId as string, sessionA.peerId as string];
  const expiresAt = Date.now() + 45000;
  sessionA.sendReliable(MessageType.GAME_INVITE, inviteFor('game-5', 'inv-5', players, expiresAt));
  await clock.advanceAsync(2000);
  expect(centre.list()).toHaveLength(1);

  centre.decline('inv-5');
  expect(centre.list()).toHaveLength(0);

  // The other phone has not heard the decline yet and asks again.
  sessionA.sendReliable(MessageType.GAME_INVITE, inviteFor('game-5', 'inv-5', players, expiresAt));
  await clock.advanceAsync(2000);

  expect(centre.list()).toHaveLength(0);
});

test('an invitation that names somebody else is ignored', async () => {
  const { clock, maria, sessionA } = await twoConnectedPhones();
  const centre = inviteCentreFor(maria);

  sessionA.sendReliable(
    MessageType.GAME_INVITE,
    inviteFor('game-6', 'inv-6', ['SOMEONE', 'ELSE'], Date.now() + 45000),
  );
  await clock.advanceAsync(2000);

  expect(centre.list()).toHaveLength(0);
});

test('an acknowledgement round-trips through its codec', () => {
  expect(decodeAck(encodeAck('abc'))).toBe('abc');
  expect(decodeAck(null)).toBeNull();
  expect(decodeAck({ i: 42 } as never)).toBeNull();
});
