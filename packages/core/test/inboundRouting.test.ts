/**
 * Who does an incoming link belong to?
 *
 * THE BUG THIS EXISTS FOR, found by pointing a real iPhone at a Mac that was
 * pretending to be a second AirLink phone. The Mac subscribed to the iPhone's
 * Bluetooth service and said nothing - it owed the iPhone no session at all -
 * and the iPhone began transmitting another session's encrypted frames at it,
 * counters 0x0d, 0x0e, 0x0f..., each retry further apart.
 *
 * The cause was a rule about the wrong person. An incoming link was adopted by
 * the first established session that happened to be disconnected:
 *
 *     if (sameEndpoint || sessionIsReconnecting) session.migrateToLink(link)
 *
 * "I am disconnected" is a fact about the receiver. It says nothing about who
 * has just connected. So a stranger was attached to somebody else's session -
 * and their hello went to a session that had already finished its handshake,
 * which ignores a hello. They were accepted, and never answered. The phone that
 * accepted them said "Connected".
 *
 * It is also a plausible cause of two phones that had once met over Wi-Fi
 * appearing to each other over Bluetooth and then not connecting: pressing
 * Connect throws away the dialler's old session and sends a fresh hello, while
 * the other phone adopts that very link into ITS old session and swallows the
 * hello. That second part is reasoned from the code, not yet seen on two phones;
 * the first part - a stranger being handed somebody's session - was.
 *
 * These tests use real sessions over the simulated network, and the first one
 * runs the OLD rule as a control, so that the failure is shown rather than
 * claimed.
 */
import { describe, expect, it } from 'vitest';
import { FrameType, MessageType, PROTOCOL_VERSION, TransportKind } from '../src/index.js';
import { TransportKind as Kind, type PeerCapabilities } from '../src/protocol/capabilities.js';
import { SeededRandom } from '../src/crypto/random.js';
import { createIdentity, type LocalIdentity } from '../src/crypto/identity.js';
import type { HandshakeConfig } from '../src/crypto/handshake.js';
import { PeerSession } from '../src/session/peerSession.js';
import { IncomingLinkRouter } from '../src/session/incomingLinkRouter.js';
import { ConnectionState } from '../src/session/stateMachine.js';
import { MockNetwork, PERFECT_CONDITIONS, mockToken, type MockTransport } from '../src/transport/mock.js';
import { LinkState, type Link } from '../src/transport/types.js';
import {
  encodeBeaconFrame,
  encodeHandshakeFrame,
  encodeSecureFrame,
  fragmentFrame,
  peekFrame,
} from '../src/protocol/frame.js';
import { VirtualClock } from '../src/util/time.js';

// ---------------------------------------------------------------------------
// peekFrame: what a first datagram says about who sent it
// ---------------------------------------------------------------------------

const SESSION_ID = new Uint8Array([0x53, 0xbe, 0xe5, 0x13, 0x58, 0x27, 0x16, 0xcb]);
const fakeSeal = (plaintext: Uint8Array): Uint8Array => new Uint8Array(plaintext.length + 16);

describe('peekFrame', () => {
  it('recognises a hello', () => {
    expect(peekFrame(encodeHandshakeFrame(new Uint8Array([1, 2, 3]))).kind).toBe('handshake');
  });

  it('reads the session a secure frame names, without opening it', () => {
    const frame = encodeSecureFrame(SESSION_ID, 13, new Uint8Array([9, 9, 9]), fakeSeal);
    const peek = peekFrame(frame);
    expect(peek.kind).toBe('secure');
    if (peek.kind === 'secure') expect([...peek.sessionId]).toEqual([...SESSION_ID]);
  });

  it('looks through the FIRST fragment of a split frame, as Bluetooth makes of every large one', () => {
    const hello = encodeHandshakeFrame(new Uint8Array(200).fill(7));
    const secure = encodeSecureFrame(SESSION_ID, 1, new Uint8Array(200).fill(5), fakeSeal);

    const helloPieces = fragmentFrame(hello, 23, 1);
    const securePieces = fragmentFrame(secure, 23, 2);
    expect(helloPieces.length).toBeGreaterThan(1);

    expect(peekFrame(helloPieces[0] as Uint8Array).kind).toBe('handshake');
    const peek = peekFrame(securePieces[0] as Uint8Array);
    expect(peek.kind).toBe('secure');
    if (peek.kind === 'secure') expect([...peek.sessionId]).toEqual([...SESSION_ID]);
  });

  it('will not guess from a fragment that is not the first', () => {
    const pieces = fragmentFrame(encodeHandshakeFrame(new Uint8Array(200)), 23, 1);
    expect(peekFrame(pieces[1] as Uint8Array).kind).toBe('undecided');
  });

  it('treats junk as junk rather than throwing', () => {
    expect(peekFrame(new Uint8Array(0)).kind).toBe('unreadable');
    expect(peekFrame(new Uint8Array([PROTOCOL_VERSION])).kind).toBe('unreadable');
    expect(peekFrame(new Uint8Array([PROTOCOL_VERSION, 0x7f, 1, 2, 3])).kind).toBe('unreadable');
    expect(peekFrame(new Uint8Array([200, FrameType.HANDSHAKE, 1])).kind).toBe('unreadable');
    expect(peekFrame(encodeBeaconFrame(new Uint8Array([1]))).kind).toBe('unreadable');
    // A secure frame too short to hold the id it claims to name.
    expect(peekFrame(new Uint8Array([PROTOCOL_VERSION, FrameType.SECURE, 1, 2])).kind).toBe('unreadable');
  });
});

// ---------------------------------------------------------------------------
// Harness: real sessions, real handshakes, one simulated radio
// ---------------------------------------------------------------------------

function caps(name: string): PeerCapabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    appVersion: '1.0.0',
    platform: 'node',
    deviceModel: 'simulator',
    displayName: name,
    deviceId: `device-${name}`,
    transports: [Kind.MOCK],
    features: ['chat'],
    games: [],
    maxPayloadBytes: 65536,
  };
}

interface Device {
  readonly name: string;
  readonly identity: LocalIdentity;
  readonly config: HandshakeConfig;
  readonly trust: Map<string, Uint8Array>;
  readonly transport: MockTransport;
}

function makeDevice(name: string, seed: number, network: MockNetwork, endpoint: string): Device {
  const random = new SeededRandom(seed);
  const identity = createIdentity(random, 1000);
  const trust = new Map<string, Uint8Array>();
  const config: HandshakeConfig = {
    identity,
    capabilities: caps(name),
    random,
    lookupTrustedKey: (peerId) => trust.get(peerId),
  };
  return { name, identity, config, trust, transport: network.createTransport(endpoint) };
}

/** Everybody already trusts everybody, so no test waits on a human comparing six digits. */
function befriend(...devices: Device[]): void {
  for (const a of devices) {
    for (const b of devices) {
      if (a !== b) a.trust.set(b.identity.peerId, b.identity.signing.publicKey);
    }
  }
}

/** The receiving end of a device, wired the way AirLinkClient wires it. */
class Receiver {
  readonly held: PeerSession[] = [];
  readonly introduced: PeerSession[] = [];
  readonly turnedAway: string[] = [];
  readonly router: IncomingLinkRouter<PeerSession>;

  constructor(
    readonly device: Device,
    private readonly clock: VirtualClock,
    options: { decisionTimeoutMs?: number } = {},
  ) {
    this.router = new IncomingLinkRouter<PeerSession>({
      clock,
      sessions: () => this.held.filter((session) => session.isSecure),
      owns: (session, id) => session.ownsSessionId(id),
      resume: (session, link) => session.migrateToLink(link),
      introduce: (link) => this.introduce(link),
      onTurnedAway: (reason) => this.turnedAway.push(reason),
      ...(options.decisionTimeoutMs !== undefined ? { decisionTimeoutMs: options.decisionTimeoutMs } : {}),
    });
    device.transport.events.on('incomingLink', ({ link }) => this.router.accept(link));
  }

  introduce(link: Link): void {
    const session = new PeerSession('inbound', { clock: this.clock, handshake: this.device.config });
    this.introduced.push(session);
    this.held.push(session);
    session.startAsResponder(link);
  }
}

/** The OLD rule, kept only as a control: adopt any link into any reconnecting session. */
class BlindReceiver extends Receiver {
  constructor(device: Device, clock: VirtualClock) {
    super(device, clock);
    // Replace the router's listener with the rule that was shipped.
    device.transport.events.removeAllListeners?.('incomingLink');
    device.transport.events.on('incomingLink', ({ link }) => {
      const adopter = this.held.find(
        (session) => session.isSecure && (session.currentLink === null || session.state === ConnectionState.RECONNECTING),
      );
      if (adopter) adopter.migrateToLink(link);
      else this.introduce(link);
    });
  }
}

async function dial(from: Device, to: string, clock: VirtualClock): Promise<Link> {
  const pending = from.transport.connect(to);
  await clock.advanceAsync(50);
  return pending;
}

/** Bring up a session between `a` (dialling) and the receiver of `b`. */
async function establish(a: Device, b: Receiver, clock: VirtualClock): Promise<PeerSession> {
  const link = await dial(a, b.device.transport.endpointId, clock);
  const session = new PeerSession(b.device.transport.endpointId, { clock, handshake: a.config });
  await session.startAsInitiator(link);
  await clock.advanceAsync(2000);
  return session;
}

async function boot(): Promise<{ clock: VirtualClock; network: MockNetwork }> {
  const clock = new VirtualClock();
  const network = new MockNetwork(clock, 0xb1e);
  network.setConditions(PERFECT_CONDITIONS);
  return { clock, network };
}

function advertise(...devices: Device[]): Promise<unknown> {
  return Promise.all(
    devices.map((d, i) =>
      d.transport.startAdvertising({ protocolVersion: PROTOCOL_VERSION, token: mockToken(i + 1), displayName: d.name }),
    ),
  );
}

/** Both ends of a session lose their link, as when Wi-Fi vanishes. */
async function dropLinks(...sessions: PeerSession[]): Promise<void> {
  for (const session of sessions) await session.currentLink?.close('airplane mode');
}

// ---------------------------------------------------------------------------
// The behaviour
// ---------------------------------------------------------------------------

describe('an incoming link goes to the session it names', () => {
  it('CONTROL - the old rule swallows a stranger\'s hello: connected, and never answered', async () => {
    const { clock, network } = await boot();
    const maria = makeDevice('Maria', 1, network, 'maria');
    const lucas = makeDevice('Lucas', 2, network, 'lucas');
    const stranger = makeDevice('Stranger', 3, network, 'stranger');
    befriend(maria, lucas, stranger);
    await advertise(maria, lucas, stranger);

    const mariaSide = new BlindReceiver(maria, clock);
    const withLucas = await establish(lucas, mariaSide, clock);
    const mariasSessionWithLucas = mariaSide.introduced[0] as PeerSession;
    expect(withLucas.isSecure).toBe(true);
    expect(mariasSessionWithLucas.isSecure).toBe(true);

    // Lucas's app is closed: Maria's session is left reconnecting.
    await dropLinks(withLucas);
    await clock.advanceAsync(100);
    expect(mariasSessionWithLucas.state).toBe(ConnectionState.RECONNECTING);

    // A stranger now connects and says hello.
    const link = await dial(stranger, 'maria', clock);
    const strangers = new PeerSession('maria', { clock, handshake: stranger.config });
    await strangers.startAsInitiator(link);
    await clock.advanceAsync(30_000);

    // Maria's old session ADOPTED the stranger's link, so the old rule shows
    // "connected"...
    expect(mariasSessionWithLucas.state).toBe(ConnectionState.CONNECTED);
    // ...while the stranger, whose hello it ignored, never got an answer.
    expect(strangers.isSecure).toBe(false);
    expect(mariaSide.introduced).toHaveLength(1); // nobody was ever asked to answer them
  });

  it('a stranger is introduced to a NEW session, and the old one is left alone', async () => {
    const { clock, network } = await boot();
    const maria = makeDevice('Maria', 1, network, 'maria');
    const lucas = makeDevice('Lucas', 2, network, 'lucas');
    const stranger = makeDevice('Stranger', 3, network, 'stranger');
    befriend(maria, lucas, stranger);
    await advertise(maria, lucas, stranger);

    const mariaSide = new Receiver(maria, clock);
    const withLucas = await establish(lucas, mariaSide, clock);
    const mariasSessionWithLucas = mariaSide.introduced[0] as PeerSession;
    await dropLinks(withLucas);
    await clock.advanceAsync(100);
    expect(mariasSessionWithLucas.state).toBe(ConnectionState.RECONNECTING);

    const link = await dial(stranger, 'maria', clock);
    const strangers = new PeerSession('maria', { clock, handshake: stranger.config });
    await strangers.startAsInitiator(link);
    await clock.advanceAsync(5_000);

    // The stranger got a real answer, from a session of its own...
    expect(strangers.isSecure).toBe(true);
    expect(mariaSide.introduced).toHaveLength(2);
    expect(mariaSide.introduced[1]?.peerId).toBe(stranger.identity.peerId);
    // ...and Lucas's session was never touched: still waiting for Lucas, and
    // still holding only the dead link it already had - not the stranger's.
    expect(mariasSessionWithLucas.state).toBe(ConnectionState.RECONNECTING);
    expect(mariasSessionWithLucas.currentLink?.endpointId).toBe('lucas');
    expect(mariasSessionWithLucas.currentLink?.state).toBe(LinkState.CLOSED);
    expect(mariaSide.turnedAway).toEqual([]);
  });

  it('a friend resuming is recognised by the session it names, and fast', async () => {
    const { clock, network } = await boot();
    const maria = makeDevice('Maria', 1, network, 'maria');
    const lucas = makeDevice('Lucas', 2, network, 'lucas');
    befriend(maria, lucas);
    await advertise(maria, lucas);

    const mariaSide = new Receiver(maria, clock);
    const lucasSession = await establish(lucas, mariaSide, clock);
    const mariasSession = mariaSide.introduced[0] as PeerSession;
    await dropLinks(lucasSession);
    await clock.advanceAsync(100);
    expect(mariasSession.state).toBe(ConnectionState.RECONNECTING);

    // Lucas comes back on a NEW link and resumes, as redial() does.
    const resumed: string[] = [];
    mariasSession.events.on('transportChanged', ({ to }) => resumed.push(to));
    const link = await dial(lucas, 'maria', clock);
    lucasSession.migrateToLink(link);
    // Well inside the five seconds a keepalive would have taken.
    await clock.advanceAsync(500);

    expect(mariaSide.introduced).toHaveLength(1); // nobody new was introduced
    expect(mariaSide.turnedAway).toEqual([]);
    expect(resumed).toHaveLength(1);
    expect(mariasSession.state).toBe(ConnectionState.CONNECTED);

    // And it is a working link, not merely a labelled one.
    const got: number[] = [];
    mariasSession.events.on('message', ({ type }) => got.push(type));
    lucasSession.sendReliable(MessageType.MESSAGE, { hello: 'again' });
    await clock.advanceAsync(500);
    expect(got).toContain(MessageType.MESSAGE);
  });

  it('turns away a link that names a session we do not hold', async () => {
    const { clock, network } = await boot();
    const maria = makeDevice('Maria', 1, network, 'maria');
    const lucas = makeDevice('Lucas', 2, network, 'lucas');
    const other = makeDevice('Other', 3, network, 'other');
    const third = makeDevice('Third', 4, network, 'third');
    befriend(maria, lucas, other, third);
    await advertise(maria, lucas, other, third);

    // Maria holds a session with Lucas...
    const mariaSide = new Receiver(maria, clock);
    await establish(lucas, mariaSide, clock);
    // ...while Other and Third hold one with each other, which Maria knows nothing of.
    const thirdSide = new Receiver(third, clock);
    const otherSession = await establish(other, thirdSide, clock);
    await dropLinks(otherSession);
    await clock.advanceAsync(100);

    const link = await dial(other, 'maria', clock);
    otherSession.migrateToLink(link);
    await clock.advanceAsync(500);

    expect(mariaSide.turnedAway).toEqual(['names a session we do not hold']);
    expect(link.state).toBe(LinkState.CLOSED);
    expect(mariaSide.introduced).toHaveLength(1);
  });

  it('closes a link that never says who it is', async () => {
    const { clock, network } = await boot();
    const maria = makeDevice('Maria', 1, network, 'maria');
    const mute = makeDevice('Mute', 2, network, 'mute');
    await advertise(maria, mute);

    const mariaSide = new Receiver(maria, clock, { decisionTimeoutMs: 3_000 });
    const link = await dial(mute, 'maria', clock);
    await clock.advanceAsync(2_900);
    expect(mariaSide.turnedAway).toEqual([]);
    expect(link.state).toBe(LinkState.CONNECTED);

    await clock.advanceAsync(200);
    expect(mariaSide.turnedAway).toEqual(['said nothing that identifies it']);
    expect(link.state).toBe(LinkState.CLOSED);
  });

  it('introduces a stranger even when a Bluetooth MTU splits the hello into pieces', async () => {
    const { clock, network } = await boot();
    network.setConditions({ ...PERFECT_CONDITIONS, maxDatagramSize: 24 });
    const maria = makeDevice('Maria', 1, network, 'maria');
    const lucas = makeDevice('Lucas', 2, network, 'lucas');
    befriend(maria, lucas);
    await advertise(maria, lucas);

    const mariaSide = new Receiver(maria, clock);
    const lucasSession = await establish(lucas, mariaSide, clock);

    // The hello is far larger than 24 bytes, so it arrived as fragments, and
    // every one of them was held and replayed into the new session intact.
    expect(lucasSession.currentLink?.maxDatagramSize).toBe(24);
    expect(lucasSession.isSecure).toBe(true);
    expect(mariaSide.introduced).toHaveLength(1);
    expect(mariaSide.introduced[0]?.isSecure).toBe(true);
    expect(mariaSide.turnedAway).toEqual([]);
  });

  it('refuses to hold unbounded input from a link that will not identify itself', async () => {
    const { clock, network } = await boot();
    const maria = makeDevice('Maria', 1, network, 'maria');
    const noisy = makeDevice('Noisy', 2, network, 'noisy');
    await advertise(maria, noisy);

    const mariaSide = new Receiver(maria, clock);
    const link = await dial(noisy, 'maria', clock);
    // Datagrams that decode as nothing: a beacon says who is NOT there.
    for (let i = 0; i < 40; i++) await link.send(encodeBeaconFrame(new Uint8Array([i])), 'reliable' as never);
    await clock.advanceAsync(500);

    expect(mariaSide.turnedAway).toEqual(['too much said without saying who it was']);
    expect(link.state).toBe(LinkState.CLOSED);
  });
});

void TransportKind;
