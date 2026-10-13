/**
 * The app routes an incoming link by what it says, not by who is disconnected.
 *
 * The routing rules themselves are proved against real sessions in
 * `packages/core/test/inboundRouting.test.ts`. This pins the one thing that
 * file cannot: that `AirLinkClient` actually hands every incoming link to that
 * router, rather than to the rule it replaced - adopt the link into whichever
 * established session happens to be reconnecting, before reading a byte.
 *
 * That rule is what a real iPhone showed on the bench. A Mac that did nothing
 * but subscribe to its Bluetooth service was given another phone's session, and
 * the iPhone began pushing that session's encrypted frames at it.
 */
import {
  ConnectionState,
  FrameType,
  LinkState,
  PROTOCOL_VERSION,
  TransportKind,
  TypedEmitter,
  encodeHandshakeFrame,
  encodeSecureFrame,
  type Link,
  type LinkEvents,
} from '@airlink/core';
import { AirLinkClient, type PeerHandle } from '../src/client/AirLinkClient.js';

const KNOWN_SESSION = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
const OTHER_SESSION = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);
const seal = (plaintext: Uint8Array): Uint8Array => new Uint8Array(plaintext.length + 16);

interface Internals {
  createHandle(key: string): PeerHandle;
  peers: Map<string, PeerHandle>;
  wireTransport(transport: unknown): void;
}

/**
 * Put a link through the front door: the transport's own `incomingLink` event,
 * which is what a real radio fires. Going through `inbound.accept` directly
 * would test the router and leave the wiring - the thing that was wrong -
 * unexamined.
 */
function arrivesOnTheRadio(internals: Internals, link: Link): void {
  const events = new TypedEmitter<{ incomingLink: { link: Link } }>();
  internals.wireTransport({ kind: TransportKind.BLE, events });
  events.emit('incomingLink', { link });
}

function fakeLink(endpointId: string): { link: Link; emit(bytes: Uint8Array): void; closed: string[] } {
  const events = new TypedEmitter<LinkEvents>();
  const closed: string[] = [];
  const link = {
    id: `link-${endpointId}`,
    transport: TransportKind.BLE,
    endpointId,
    state: LinkState.CONNECTED,
    maxDatagramSize: 180,
    isHighBandwidth: false,
    events,
    queuedCount: 0,
    metrics: () => ({}),
    send: async () => undefined,
    close: async (reason?: string) => {
      closed.push(reason ?? '');
    },
  } as unknown as Link;
  return { link, emit: (bytes) => events.emit('data', { bytes }), closed };
}

/** A client holding one established session that is waiting for its friend to come back. */
async function clientWithAReconnectingFriend(): Promise<{
  client: AirLinkClient;
  internals: Internals;
  migrated: Link[];
  friend: PeerHandle;
}> {
  const client = new AirLinkClient({ appVersion: '1.0.0', platform: 'ios', deviceModel: 'test' });
  await client.load();
  await client.createProfile('Ale', null);
  (client as unknown as { capabilities: { availableKinds(): string[] } }).capabilities = { availableKinds: () => [] };
  const internals = client as unknown as Internals;

  const friend = internals.createHandle('friend-peer-id');
  const migrated: Link[] = [];
  const session = friend.session as unknown as Record<string, unknown>;
  Object.defineProperty(session, 'isSecure', { get: () => true, configurable: true });
  Object.defineProperty(session, 'state', { get: () => ConnectionState.RECONNECTING, configurable: true });
  Object.defineProperty(session, 'currentLink', { get: () => null, configurable: true });
  session.ownsSessionId = (id: Uint8Array): boolean => id.every((byte, i) => byte === KNOWN_SESSION[i]);
  session.migrateToLink = (link: Link): void => void migrated.push(link);

  return { client, internals, migrated, friend };
}

afterEach(() => {
  globalThis.__airlinkNativeTest?.clearCalls();
  globalThis.__airlinkSqliteTest?.clear();
  globalThis.__airlinkKeychainTest?.clear();
});

test('a stranger saying hello is NOT given the friend\'s session', async () => {
  const { internals, migrated, friend } = await clientWithAReconnectingFriend();
  const created = jest.spyOn(internals, 'createHandle');
  const { link, emit } = fakeLink('stranger');

  arrivesOnTheRadio(internals, link);
  emit(encodeHandshakeFrame(new Uint8Array([1, 0, 0])));

  expect(migrated).toEqual([]);
  expect(created).toHaveBeenCalledWith('inbound:1');
  // The friend's session is exactly as it was: waiting.
  expect(internals.peers.get('friend-peer-id')).toBe(friend);
});

test('the friend resuming IS given their session', async () => {
  const { internals, migrated } = await clientWithAReconnectingFriend();
  const created = jest.spyOn(internals, 'createHandle');
  const { link, emit } = fakeLink('friend');

  arrivesOnTheRadio(internals, link);
  emit(encodeSecureFrame(KNOWN_SESSION, 41, new Uint8Array([0]), seal));

  expect(migrated).toEqual([link]);
  expect(created).not.toHaveBeenCalledWith('inbound:1');
});

test('a link naming somebody else\'s session is closed, not adopted', async () => {
  const { internals, migrated } = await clientWithAReconnectingFriend();
  const { link, emit, closed } = fakeLink('someone');

  arrivesOnTheRadio(internals, link);
  emit(encodeSecureFrame(OTHER_SESSION, 1, new Uint8Array([0]), seal));

  expect(migrated).toEqual([]);
  expect(closed).toEqual(['names a session we do not hold']);
});

test('a link that says nothing is not adopted by the friend\'s session either', async () => {
  const { internals, migrated } = await clientWithAReconnectingFriend();
  const { link } = fakeLink('mac-that-only-subscribed');

  arrivesOnTheRadio(internals, link);
  // No datagram at all: the exact thing the bench Mac did.

  expect(migrated).toEqual([]);
});

void FrameType;
void PROTOCOL_VERSION;
