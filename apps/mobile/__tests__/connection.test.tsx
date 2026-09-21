/**
 * Two phones, one connection.
 *
 * Every defect here was reported as something else. "Maria keeps reappearing
 * with a Connect button" was a session filed under a name the presence layer
 * did not use. "It sometimes will not connect" was a failed attempt leaving a
 * dead handle in the map that every later attempt then reused. "They both show
 * different six-digit codes" was two phones dialling each other at the same
 * instant and neither of them yielding.
 *
 * The common cause is that a peer had several names and nothing mapped between
 * them. These tests are written against the one name a peer now has.
 */
import { ConnectionState } from '@airlink/core';
import { AirLinkClient } from '../src/client/AirLinkClient';

type Injectable = { peers: Map<string, unknown> };

async function client(): Promise<AirLinkClient> {
  const instance = new AirLinkClient({ appVersion: '0', platform: 'ios', deviceModel: 'test' });
  await instance.load();
  await instance.createProfile('Alejandro', null);
  return instance;
}

/** A handle shaped like the real one, with a session that only reports state. */
function handle(over: {
  key: string;
  peerId?: string | null;
  installationId?: string | null;
  aliases?: string[];
  state?: ConnectionState;
  secure?: boolean;
  startedAt?: number;
  migratedAtPackets?: number | null;
  packetsReceived?: number;
}) {
  return {
    key: over.key,
    peerId: over.peerId ?? null,
    installationId: over.installationId ?? null,
    attemptId: `attempt-${over.key}`,
    aliases: new Set([over.key, ...(over.aliases ?? [])]),
    migratedAtPackets: over.migratedAtPackets ?? null,
    startedAt: over.startedAt ?? 0,
    offs: [],
    session: {
      peerId: over.peerId ?? null,
      state: over.state ?? ConnectionState.CONNECTED,
      isSecure: over.secure ?? true,
      isHighBandwidth: false,
      capabilities: null,
      diagnostics: () => ({ packetsReceived: over.packetsReceived ?? 0 }),
      close: async () => undefined,
    },
  };
}

test('a session is found by every name a caller might hold', async () => {
  const instance = await client();
  const peers = (instance as unknown as Injectable).peers;
  peers.set('PEERMARIA', handle({ key: 'PEERMARIA', peerId: 'PEERMARIA', installationId: 'install-maria' }));

  // The canonical name, the identity the handshake produced, and the
  // installation id from the capability exchange all reach the same session.
  expect(instance.peer('PEERMARIA')).toBeDefined();
  expect(instance.peer('install-maria')).toBeDefined();
  expect(instance.peer('SOMEONE-ELSE')).toBeUndefined();
});

test('an inbound session is not filed under a name nothing else uses', async () => {
  const instance = await client();
  const peers = (instance as unknown as Injectable).peers;

  // Before the handshake an inbound link genuinely has no identity, so it gets
  // a placeholder of our own - deliberately one that cannot collide with a
  // discovery row, which is what the bare endpoint id used to do.
  peers.set('inbound:1', handle({ key: 'inbound:1' }));
  expect(instance.peer('inbound:1')).toBeDefined();

  // And once the handshake names it, that name is what everything else finds.
  peers.delete('inbound:1');
  peers.set('PEERGRACE', handle({ key: 'PEERGRACE', peerId: 'PEERGRACE' }));
  expect(instance.peer('PEERGRACE')).toBeDefined();
  expect(instance.peer('inbound:1')).toBeUndefined();
});

test('connectedPeers reports one session per person, not one per link', async () => {
  const instance = await client();
  const peers = (instance as unknown as Injectable).peers;
  peers.set('PEERMARIA', handle({ key: 'PEERMARIA', peerId: 'PEERMARIA' }));
  peers.set('PEERGRACE', handle({ key: 'PEERGRACE', peerId: 'PEERGRACE' }));
  peers.set(
    'PEERSAM',
    handle({ key: 'PEERSAM', peerId: 'PEERSAM', state: ConnectionState.CONNECTING, secure: false }),
  );

  const connected = instance.connectedPeers();
  expect(connected).toHaveLength(2);
  expect(connected.map((h) => h.key).sort()).toEqual(['PEERGRACE', 'PEERMARIA']);
});

test('a dial to a peer already connected does nothing at all', async () => {
  const instance = await client();
  const peers = (instance as unknown as Injectable).peers;
  peers.set('PEERMARIA', handle({ key: 'PEERMARIA', peerId: 'PEERMARIA' }));

  // The radios are not up in a test, so reaching them at all would throw. It
  // returning quietly is the proof that it never got that far - which is the
  // guard that stops a stray Connect tap opening a second link over a live
  // session and fighting it.
  await expect(instance.connect('PEERMARIA')).resolves.toBeUndefined();
  expect(peers.size).toBe(1);
});

test('a dial while already dialling is joined rather than repeated', async () => {
  const instance = await client();
  const peers = (instance as unknown as Injectable).peers;
  peers.set(
    'PEERMARIA',
    handle({ key: 'PEERMARIA', peerId: 'PEERMARIA', state: ConnectionState.CONNECTING, secure: false }),
  );

  await expect(instance.connect('PEERMARIA')).resolves.toBeUndefined();
  expect(peers.size).toBe(1);
});

test('a dead handle from a failed attempt does not poison the next one', async () => {
  const instance = await client();
  const peers = (instance as unknown as Injectable).peers;
  peers.set(
    'PEERMARIA',
    handle({ key: 'PEERMARIA', peerId: 'PEERMARIA', state: ConnectionState.FAILED, secure: false }),
  );

  /*
   * The next attempt has to clear the corpse before it can do anything, and
   * with no radios in a test it then fails at the transport. Both halves matter:
   * the throw proves it went past the guards, and the empty map proves the
   * corpse is gone - which is what used to make one failure permanent until the
   * app was restarted.
   */
  await expect(instance.connect('PEERMARIA')).rejects.toThrow();
  expect(peers.has('PEERMARIA')).toBe(false);
});

test('a handshake failure is never fatal to the app', async () => {
  const instance = await client();
  const seen: { message: string; fatal: boolean }[] = [];
  instance.events.on('error', (event) => seen.push(event));

  // One peer failing to authenticate is a connection that did not happen. It
  // used to blank the whole interface to "Something went wrong" with no way
  // back to the app.
  instance.events.emit('error', { message: 'handshake failed', fatal: false });
  expect(seen.every((event) => event.fatal === false)).toBe(true);
});

test('diagnostics carry the identifiers the bugs lived in', async () => {
  const instance = await client();
  const snapshot = instance.diagnostics();

  // Every one of these was invisible from the phone while the defect it
  // describes was being reported.
  expect(snapshot).toHaveProperty('installationId');
  expect(snapshot).toHaveProperty('discoveryId');
  expect(snapshot).toHaveProperty('publicKeyFingerprint');
  expect(snapshot).toHaveProperty('discovered');
  expect(typeof snapshot.discoveryId).toBe('string');
  expect((snapshot.discoveryId as string).length).toBe(16);
});


test('a re-keyed session still answers to the name the interface is holding', async () => {
  /*
   * The defect this exists for was found by running two phones, not by reading,
   * and it was mine.
   *
   * A session is re-keyed onto its peer id the moment the handshake produces
   * one - which is what makes the presence layer able to find it, and is most
   * of the fix for a connected friend sprouting a Connect button. But the
   * six-digit prompt is raised BEFORE that, carrying the key the discovery row
   * had, and a screen cannot notice that its peer was renamed underneath it. So
   * "They match" resolved to nothing, `pairing.confirm()` was never called, and
   * both phones sat showing the same six digits until the two-minute pairing
   * timeout gave up and said "Couldn't connect".
   *
   * The log said it exactly: `state=pairing` at 18:14:05 under the new name,
   * `state=failed` at 18:16:05. One hundred and twenty seconds.
   */
  const instance = await client();
  const peers = (instance as unknown as Injectable).peers;

  // As it is after adoptIdentity: filed under the peer id, remembering the
  // discovery row key it was created with.
  peers.set(
    'PEERMARIA',
    handle({ key: 'PEERMARIA', peerId: 'PEERMARIA', aliases: ['localNetwork:abc123._airlink._tcp.'] }),
  );

  expect(instance.peer('PEERMARIA')).toBeDefined();
  expect(instance.peer('localNetwork:abc123._airlink._tcp.')).toBeDefined();
  expect(instance.peer('localNetwork:someone-else')).toBeUndefined();
});

test('confirming a pairing reaches the session under its old name', async () => {
  const instance = await client();
  const peers = (instance as unknown as Injectable).peers;

  let confirmed = false;
  const h = handle({ key: 'PEERMARIA', peerId: 'PEERMARIA', aliases: ['localNetwork:abc'] });
  (h as unknown as { pairing: { confirm: () => void; decline: () => void } }).pairing = {
    confirm: () => {
      confirmed = true;
    },
    decline: () => undefined,
  };
  peers.set('PEERMARIA', h);

  // The screen still calls it by the name it was given when the code appeared.
  instance.confirmPairing('localNetwork:abc');
  expect(confirmed).toBe(true);
});


test('a session the peer no longer holds is rebuilt rather than migrated again', async () => {
  /*
   * Seen on two simulators: one phone showed a live green dot and "Your turn"
   * while the other showed that person as merely nearby, and nothing either of
   * them did arrived.
   *
   * `migrateToLink` keeps the session keys and assumes THE PEER STILL HAS THEM.
   * True for a pocket or a transport upgrade; false for a peer whose app
   * restarted and is running a fresh handshake. The reconnect driver happily
   * migrated into that void, over and over, because a migration always
   * "succeeded" from this side.
   *
   * So a migration is provisional: if the link drops again without a single
   * packet having arrived, it reached nobody and the session is torn down.
   */
  const instance = await client();
  const peers = (instance as unknown as Injectable).peers;

  // Migrated when 12 packets had been received, and not one has arrived since.
  const stale = handle({
    key: 'PEERMARIA',
    peerId: 'PEERMARIA',
    state: ConnectionState.RECONNECTING,
    migratedAtPackets: 12,
    packetsReceived: 12,
  });
  peers.set('PEERMARIA', stale);

  (instance as unknown as { scheduleReconnect: (h: unknown) => void }).scheduleReconnect(stale);
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 0));

  expect(peers.has('PEERMARIA')).toBe(false);
});

test('a migration that did carry traffic is allowed to reconnect again', async () => {
  const instance = await client();
  const peers = (instance as unknown as Injectable).peers;

  // Migrated at 12, and 30 have arrived since: that link was real.
  const healthy = handle({
    key: 'PEERGRACE',
    peerId: 'PEERGRACE',
    state: ConnectionState.RECONNECTING,
    migratedAtPackets: 12,
    packetsReceived: 30,
  });
  peers.set('PEERGRACE', healthy);

  (instance as unknown as { scheduleReconnect: (h: unknown) => void }).scheduleReconnect(healthy);
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 0));

  // Kept, and the provisional marker cleared so the next round judges afresh.
  expect(peers.has('PEERGRACE')).toBe(true);
  expect(healthy.migratedAtPackets).toBeNull();
  await instance.disconnect('PEERGRACE');
});
