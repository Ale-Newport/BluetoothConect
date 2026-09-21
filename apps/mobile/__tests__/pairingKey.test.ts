/**
 * A pending pairing is resolved under the same name it was raised under.
 *
 * THE BUG THIS EXISTS FOR. Two phones meeting for the first time compared six
 * digits, both people tapped "They match", and both databases recorded the
 * friendship - `trusted | sas` on each side - with the session Connected and
 * Excellent underneath. And yet both screens sat on "Waiting for your friend to
 * confirm too…" and then, forty-five seconds later, said "Couldn't connect".
 *
 * The pairing worked. The screen was never told.
 *
 * `PairingConfirmScreen` leaves only when its pending pairing disappears from
 * the store, and it is removed by a `pairingResolved` event carrying the
 * handle's key. But `adoptIdentity` RENAMES the handle mid-ceremony: it runs on
 * the session entering PAIRING and re-files the handle from its discovery key
 * onto the peer id it has just learned. So the pairing could be raised under
 * `localNetwork:abc` and resolved under the peer id. The store looked for the
 * wrong name, found nothing, removed nothing - and the screen waited out its
 * backstop timer and reported a failure that had not happened.
 *
 * Nothing below the UI was wrong, which is why no protocol test caught it and
 * why every earlier theory about timeouts was a theory about the wrong layer.
 *
 * The two events can arrive in either order relative to the rename, so both
 * orders are asserted: the invariant is that the names agree, not that the
 * events happen to line up.
 */
import { ConnectionState } from '@airlink/core';
import { AirLinkClient, type PeerHandle } from '../src/client/AirLinkClient.js';
import { useAppStore } from '../src/state/index.js';

/** A discovery row's key: what the Connect sheet opens with. */
const DISCOVERY_KEY = 'localNetwork:discovery-row';
/** The identity the handshake reveals partway through. */
const PEER_ID = 'b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

interface Internals {
  createHandle(peerKey: string): PeerHandle;
}

async function bootClient(): Promise<AirLinkClient> {
  const client = new AirLinkClient({ appVersion: '1.0.0', platform: 'ios', deviceModel: 'test' });
  await client.load();
  await client.createProfile('Alejandro', null);
  // `start()` builds the capability manager, and needs radios to do it. The
  // list of transports we advertise has nothing to do with what a handle is
  // called, so it is stubbed rather than bringing up a native layer.
  (client as unknown as { capabilities: { availableKinds(): string[] } }).capabilities = {
    availableKinds: () => [],
  };
  return client;
}

/**
 * Pretend the handshake has just revealed who this is. `adoptIdentity` reads
 * the peer id off the session, and the session only knows it once a real
 * handshake has run - which needs a radio this test does not have.
 */
function revealIdentity(handle: PeerHandle): void {
  Object.defineProperty(handle.session, 'peerId', { get: () => PEER_ID, configurable: true });
}

/** Every key the client used for a raised pairing, and for a resolved one. */
function recordKeys(client: AirLinkClient): { raised: string[]; resolved: string[] } {
  const raised: string[] = [];
  const resolved: string[] = [];
  client.events.on('pairingRequired', ({ peerKey }) => void raised.push(peerKey));
  client.events.on('pairingResolved', ({ peerKey }) => void resolved.push(peerKey));
  return { raised, resolved };
}

function emitPairing(handle: PeerHandle, name: 'confirmationRequired' | 'paired' | 'refused'): void {
  const events = handle.pairing.events as unknown as { emit(n: string, e: unknown): void };
  if (name === 'confirmationRequired') {
    events.emit(name, { peerId: PEER_ID, displayName: 'Maria', sasCode: '280895', identityKey: new Uint8Array(32) });
  } else if (name === 'paired') {
    events.emit(name, {
      peer: {
        peerId: PEER_ID,
        identityKey: new Uint8Array(32),
        displayName: 'Maria',
        method: 'sas',
        pairedAt: 1,
        lastSeenAt: 1,
        blocked: false,
      },
      firstTime: true,
    });
  } else {
    events.emit(name, { peerId: PEER_ID, reason: 'pairing declined' });
  }
}

function enterPairing(handle: PeerHandle): void {
  const events = handle.session.events as unknown as { emit(n: string, e: unknown): void };
  events.emit('stateChanged', { state: ConnectionState.PAIRING });
}

afterEach(() => {
  globalThis.__airlinkNativeTest?.clearCalls();
  globalThis.__airlinkSqliteTest?.clear();
  globalThis.__airlinkKeychainTest?.clear();
});

test('the rename happens: a handle IS re-filed under its peer id mid-ceremony', async () => {
  // The premise of the bug, checked rather than assumed.
  const client = await bootClient();
  const handle = (client as unknown as Internals).createHandle(DISCOVERY_KEY);
  revealIdentity(handle);

  expect(handle.key).toBe(DISCOVERY_KEY);
  enterPairing(handle);
  expect(handle.key).toBe(PEER_ID);
});

test('raised before the rename, resolved after it - the case that was on screen', async () => {
  const client = await bootClient();
  const keys = recordKeys(client);
  const handle = (client as unknown as Internals).createHandle(DISCOVERY_KEY);
  revealIdentity(handle);

  emitPairing(handle, 'confirmationRequired'); // raised under the discovery key
  enterPairing(handle); // ...then renamed onto the peer id
  emitPairing(handle, 'paired'); // ...then resolved

  expect(keys.raised).toEqual([DISCOVERY_KEY]);
  // The regression: this was [PEER_ID], so the store never found the pairing.
  expect(keys.resolved).toContain(DISCOVERY_KEY);
});

test('renamed first, then raised and resolved - also agrees', async () => {
  const client = await bootClient();
  const keys = recordKeys(client);
  const handle = (client as unknown as Internals).createHandle(DISCOVERY_KEY);
  revealIdentity(handle);

  enterPairing(handle);
  emitPairing(handle, 'confirmationRequired');
  emitPairing(handle, 'paired');

  expect(keys.resolved).toContain(keys.raised[0]);
});

test('a refusal is resolved under the raised name too, so a declined screen closes', async () => {
  const client = await bootClient();
  const keys = recordKeys(client);
  const handle = (client as unknown as Internals).createHandle(DISCOVERY_KEY);
  revealIdentity(handle);

  emitPairing(handle, 'confirmationRequired');
  enterPairing(handle);
  emitPairing(handle, 'refused');

  expect(keys.resolved).toContain(DISCOVERY_KEY);
});

test('the pending pairing actually leaves the store - the thing the screen waits for', async () => {
  // The end-to-end claim in one place: raise it, rename, resolve, and check the
  // store the screen reads rather than the events in between.
  const client = await bootClient();
  const handle = (client as unknown as Internals).createHandle(DISCOVERY_KEY);
  revealIdentity(handle);

  client.events.on('pairingRequired', ({ peerKey, displayName, code }) =>
    useAppStore.getState().addPendingPairing({ peerKey, displayName, code, startedAt: 0 }),
  );
  client.events.on('pairingResolved', ({ peerKey }) => useAppStore.getState().resolvePendingPairing(peerKey));

  emitPairing(handle, 'confirmationRequired');
  expect(useAppStore.getState().pendingPairings.map((p) => p.peerKey)).toEqual([DISCOVERY_KEY]);

  enterPairing(handle);
  emitPairing(handle, 'paired');

  expect(useAppStore.getState().pendingPairings).toEqual([]);
  useAppStore.getState().reset();
});

/**
 * THE SECOND BUG, found by reading the activity log on the receiving phone.
 *
 * With a third simulator on the network, pairing failed even though both
 * people confirmed the same six digits. Maria's log showed, in the same second:
 *
 *     session CBEGM44… · disconnected
 *     pairing inbound:2 · refused
 *     session CBEGM44… · disconnected
 *
 * Her app had been relaunched just before, which resets the inbound counter,
 * so `inbound:2` meant Lucas's phone had dialled her TWICE in one attempt - and
 * the second dial destroyed the first.
 *
 * `connect()` returns early for a session that is CONNECTED, secure, or still
 * CONNECTING / AUTHENTICATING, and treats every other state as "a corpse from
 * an earlier attempt": it discards it and dials again. PAIRING is "every other
 * state". A session showing six digits is not secure yet - it only becomes
 * usable once both people confirm - so nothing caught it. Any second call to
 * `connect()` while the user was reading the digits threw away the live
 * ceremony, refused it, and started a new one the user had never seen.
 */
test('a second connect while the six digits are on screen does not destroy the ceremony', async () => {
  const client = await bootClient();
  const keys = recordKeys(client);
  const handle = (client as unknown as Internals).createHandle(DISCOVERY_KEY);

  // The session is at the pairing gate: authenticated, not yet secure, waiting
  // on the two people to compare digits.
  Object.defineProperty(handle.session, 'state', { get: () => ConnectionState.PAIRING, configurable: true });
  Object.defineProperty(handle.session, 'isSecure', { get: () => false, configurable: true });
  emitPairing(handle, 'confirmationRequired');

  // Something calls connect again: a retry, a reconnect driver, a second tap.
  await client.connect(DISCOVERY_KEY).catch(() => undefined);

  // The ceremony the user is looking at must still be there.
  expect(keys.resolved).toEqual([]);
  expect((client as unknown as { peers: Map<string, PeerHandle> }).peers.get(DISCOVERY_KEY)).toBe(handle);
});

test('agreeing a transport is also in progress, not a corpse', async () => {
  const client = await bootClient();
  const handle = (client as unknown as Internals).createHandle(DISCOVERY_KEY);
  Object.defineProperty(handle.session, 'state', {
    get: () => ConnectionState.NEGOTIATING_TRANSPORT,
    configurable: true,
  });
  Object.defineProperty(handle.session, 'isSecure', { get: () => false, configurable: true });

  await client.connect(DISCOVERY_KEY).catch(() => undefined);

  expect((client as unknown as { peers: Map<string, PeerHandle> }).peers.get(DISCOVERY_KEY)).toBe(handle);
});

test('a genuinely dead session IS still cleared and redialled', async () => {
  // The guard exists for a reason: a FAILED session must not block a retry for
  // ever. Only the states that are actually in progress are protected.
  const client = await bootClient();
  const keys = recordKeys(client);
  const handle = (client as unknown as Internals).createHandle(DISCOVERY_KEY);
  Object.defineProperty(handle.session, 'state', { get: () => ConnectionState.FAILED, configurable: true });
  Object.defineProperty(handle.session, 'isSecure', { get: () => false, configurable: true });

  await client.connect(DISCOVERY_KEY).catch(() => undefined);

  expect((client as unknown as { peers: Map<string, PeerHandle> }).peers.get(DISCOVERY_KEY)).not.toBe(handle);
  expect(keys.resolved).toContain(DISCOVERY_KEY);
});
