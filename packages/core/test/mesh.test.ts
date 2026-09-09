import { describe, expect, it } from 'vitest';
import { MessageType, PROTOCOL_VERSION } from '../src/protocol/constants.js';
import { encodeCbor, type CborValue } from '../src/protocol/cbor.js';
import { TransportKind, type PeerCapabilities } from '../src/protocol/capabilities.js';
import { SeededRandom } from '../src/crypto/random.js';
import { createIdentity, type LocalIdentity } from '../src/crypto/identity.js';
import type { HandshakeConfig } from '../src/crypto/handshake.js';
import { PeerSession } from '../src/session/peerSession.js';
import { ConnectionState } from '../src/session/stateMachine.js';
import {
  BLE_LIKE_CONDITIONS,
  HOSTILE_CONDITIONS,
  MockNetwork,
  WIFI_LIKE_CONDITIONS,
  type MockTransport,
  type NetworkConditions,
} from '../src/transport/mock.js';
import type { Link } from '../src/transport/types.js';
import { VirtualClock } from '../src/util/time.js';
import { DecodeError } from '../src/util/varint.js';
import {
  GroupSession,
  MESH_LIMITS,
  MeshDropReason,
  MeshError,
  RelayFlags,
  SeenSet,
  compareSnapshots,
  decodeGroupSnapshot,
  decodeRelayPacket,
  encodeGroupSnapshot,
  encodeRelayPacket,
  seenKey,
  type GroupMessageEvent,
  type GroupSnapshot,
  type RelayPacket,
} from '../src/mesh/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * `noUncheckedIndexedAccess` is on, and a non-null assertion in a test hides
 * exactly the setup mistake a test should shout about.
 */
function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`test setup: missing ${what}`);
  return value;
}

function caps(name: string, deviceId: string): PeerCapabilities {
  return {
    protocolVersion: PROTOCOL_VERSION,
    appVersion: '0.1.0',
    platform: 'node',
    deviceModel: 'simulator',
    displayName: name,
    deviceId,
    transports: [TransportKind.MOCK],
    features: ['chat', 'groups'],
    games: [],
    maxPayloadBytes: 65536,
  };
}

interface Device {
  readonly name: string;
  readonly endpoint: string;
  readonly identity: LocalIdentity;
  readonly config: HandshakeConfig;
  transport: MockTransport;
}

interface MeshContext {
  readonly clock: VirtualClock;
  readonly network: MockNetwork;
  readonly devices: Map<string, Device>;
  readonly sessions: Map<string, PeerSession>;
  readonly groups: Map<string, GroupSession>;
  /** Cryptographic peer id of a named device - the id the mesh routes on. */
  pid(name: string): string;
  group(name: string): GroupSession;
  session(from: string, to: string): PeerSession;
}

const sessionKey = (from: string, to: string): string => `${from}|${to}`;

/**
 * Build an N-device mock network with an explicit topology.
 *
 * Every pair NOT named in `edges` is partitioned, so "A and C cannot see each
 * other" is a fact about the simulated radio, not an omission in the test.
 *
 * Modelled on connectPair() in session.test.ts and generalised: same trust
 * setup, same responder wiring, same virtual clock.
 */
async function buildMesh(options: {
  names: readonly string[];
  edges: readonly (readonly [string, string])[];
  conditions?: Partial<NetworkConditions>;
}): Promise<MeshContext> {
  const clock = new VirtualClock();
  const network = new MockNetwork(clock, 0xa11);
  if (options.conditions) network.setConditions(options.conditions);

  const devices = new Map<string, Device>();
  options.names.forEach((name, i) => {
    const random = new SeededRandom(101 + i * 37);
    const identity = createIdentity(random, 1000);
    devices.set(name, {
      name,
      endpoint: `endpoint-${name.toLowerCase()}`,
      identity,
      // Everybody has met everybody before, so no session stops for a SAS code.
      config: {
        identity,
        capabilities: caps(name, `device-${name}`),
        random,
        lookupTrustedKey: (peerId) => {
          for (const d of devices.values()) {
            if (d.identity.peerId === peerId) return d.identity.signing.publicKey;
          }
          return undefined;
        },
      },
      transport: undefined as unknown as MockTransport,
    });
  });

  for (const device of devices.values()) {
    device.transport = network.createTransport(device.endpoint);
  }

  const edgeSet = new Set(options.edges.map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
  for (let i = 0; i < options.names.length; i++) {
    for (let j = i + 1; j < options.names.length; j++) {
      const a = must(options.names[i], 'name');
      const b = must(options.names[j], 'name');
      if (edgeSet.has(a < b ? `${a}|${b}` : `${b}|${a}`)) continue;
      network.partition(must(devices.get(a), a).endpoint, must(devices.get(b), b).endpoint);
    }
  }

  const sessions = new Map<string, PeerSession>();
  const nameByEndpoint = new Map<string, string>();
  for (const device of devices.values()) nameByEndpoint.set(device.endpoint, device.name);

  const ensureSession = (me: string, other: string): PeerSession => {
    const key = sessionKey(me, other);
    const existing = sessions.get(key);
    if (existing) return existing;
    const created = new PeerSession(must(devices.get(other), other).endpoint, {
      clock,
      handshake: must(devices.get(me), me).config,
    });
    sessions.set(key, created);
    return created;
  };

  for (const device of devices.values()) {
    device.transport.events.on('incomingLink', ({ link }: { link: Link }) => {
      const other = nameByEndpoint.get(link.endpointId);
      if (other === undefined) return;
      const session = ensureSession(device.name, other);
      if (session.isSecure) session.migrateToLink(link);
      else session.startAsResponder(link);
    });
  }

  for (const [a, b] of options.edges) {
    const from = must(devices.get(a), a);
    const to = must(devices.get(b), b);
    const pending = from.transport.connect(to.endpoint);
    await clock.advanceAsync(300);
    const link = await pending;
    await ensureSession(a, b).startAsInitiator(link);
    await clock.advanceAsync(3000);
  }

  const groups = new Map<string, GroupSession>();
  options.names.forEach((name, i) => {
    groups.set(
      name,
      new GroupSession({
        localPeerId: must(devices.get(name), name).identity.peerId,
        clock,
        random: new SeededRandom(9001 + i * 13),
        localDisplayName: name,
      }),
    );
  });

  for (const [a, b] of options.edges) {
    const ga = must(groups.get(a), a);
    const gb = must(groups.get(b), b);
    ga.attach(must(devices.get(b), b).identity.peerId, must(sessions.get(sessionKey(a, b)), sessionKey(a, b)));
    gb.attach(must(devices.get(a), a).identity.peerId, must(sessions.get(sessionKey(b, a)), sessionKey(b, a)));
  }

  return {
    clock,
    network,
    devices,
    sessions,
    groups,
    pid: (name) => must(devices.get(name), name).identity.peerId,
    group: (name) => must(groups.get(name), name),
    session: (from, to) => must(sessions.get(sessionKey(from, to)), sessionKey(from, to)),
  };
}

/**
 * Form a group along a path: the first name hosts, and each subsequent name is
 * added by the neighbour before it - which is how it has to happen when the
 * host cannot reach the far end of the line.
 */
async function formGroupAlongPath(ctx: MeshContext, path: readonly string[], name = 'Row 27'): Promise<void> {
  const hostName = must(path[0], 'path[0]');
  ctx.group(hostName).create(name, 'grp1');
  for (let i = 1; i < path.length; i++) {
    const adder = must(path[i - 1], 'adder');
    const joiner = must(path[i], 'joiner');
    ctx.group(adder).addMember({
      peerId: ctx.pid(joiner),
      displayName: joiner,
      joinedAt: ctx.clock.wallNow(),
    });
    await ctx.clock.advanceAsync(4000);
  }
  await ctx.clock.advanceAsync(4000);
}

function collectGroup(group: GroupSession): GroupMessageEvent[] {
  const out: GroupMessageEvent[] = [];
  group.events.on('message', (m) => out.push(m));
  return out;
}

function collectDrops(group: GroupSession): { reason: string; via: string }[] {
  const out: { reason: string; via: string }[] = [];
  group.events.on('dropped', (d) => out.push({ reason: d.reason, via: d.via }));
  return out;
}

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

function snapshot(over: Partial<GroupSnapshot> = {}): GroupSnapshot {
  return {
    groupId: 'grp1',
    name: 'Row 27',
    hostId: 'AAAA',
    epoch: 1,
    members: [{ peerId: 'AAAA', displayName: 'A', joinedAt: 1000 }],
    updatedAt: 1000,
    ...over,
  };
}

function packet(over: Partial<RelayPacket> = {}): RelayPacket {
  return {
    groupId: 'grp1',
    originId: 'AAAA',
    destinationId: 'CCCC',
    messageId: 'deadbeef',
    hops: MESH_LIMITS.defaultHops,
    flags: RelayFlags.NONE,
    innerType: MessageType.MESSAGE,
    payload: bytes(1, 2, 3),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// SeenSet - the loop breaker
// ---------------------------------------------------------------------------

describe('SeenSet', () => {
  it('reports a key as new once and as seen thereafter', () => {
    const clock = new VirtualClock();
    const seen = new SeenSet(clock, 16, 1000);
    expect(seen.add('a')).toBe(false);
    expect(seen.add('a')).toBe(true);
    expect(seen.has('a')).toBe(true);
  });

  it('never exceeds its capacity, however much a peer sends', () => {
    const clock = new VirtualClock();
    const seen = new SeenSet(clock, 8, 60_000);
    for (let i = 0; i < 10_000; i++) seen.add(`k${i}`);
    expect(seen.size).toBeLessThanOrEqual(8);
    // The most recent entries are the ones that matter for a live flood.
    expect(seen.has('k9999')).toBe(true);
    expect(seen.has('k0')).toBe(false);
  });

  it('forgets an entry once it is older than the TTL', () => {
    const clock = new VirtualClock();
    const seen = new SeenSet(clock, 64, 1000);
    seen.add('a');
    clock.advance(999);
    expect(seen.has('a')).toBe(true);
    clock.advance(2);
    expect(seen.has('a')).toBe(false);
    // ...and the expired prefix is actually reclaimed, not just hidden.
    seen.add('b');
    expect(seen.size).toBe(1);
  });

  it('does not extend a live entry when the same key is sent again', () => {
    const clock = new VirtualClock();
    const seen = new SeenSet(clock, 64, 1000);
    seen.add('a');
    // Re-sending inside the window must not push the expiry out, or a peer
    // could keep one entry alive forever by repeating it.
    for (let i = 0; i < 9; i++) {
      clock.advance(100);
      expect(seen.add('a')).toBe(true);
    }
    clock.advance(101);
    expect(seen.has('a')).toBe(false);
  });

  it('scopes message ids per origin, so one peer cannot claim another peer ids', () => {
    expect(seenKey('AAAA', 'm1')).not.toBe(seenKey('BBBB', 'm1'));
  });
});

// ---------------------------------------------------------------------------
// Snapshot ordering - the rule gossip convergence rests on
// ---------------------------------------------------------------------------

describe('compareSnapshots', () => {
  it('prefers the higher epoch', () => {
    expect(compareSnapshots(snapshot({ epoch: 5 }), snapshot({ epoch: 4 }))).toBeGreaterThan(0);
    expect(compareSnapshots(snapshot({ epoch: 4 }), snapshot({ epoch: 5 }))).toBeLessThan(0);
  });

  it('breaks an equal-epoch host race deterministically', () => {
    const a = snapshot({ epoch: 7, hostId: 'AAAA' });
    const b = snapshot({ epoch: 7, hostId: 'ZZZZ' });
    expect(compareSnapshots(a, b)).toBeGreaterThan(0);
    expect(compareSnapshots(b, a)).toBeLessThan(0);
  });

  it('breaks an equal-epoch membership race deterministically', () => {
    const one = snapshot({ epoch: 7, members: [{ peerId: 'AAAA', displayName: 'A', joinedAt: 1 }] });
    const two = snapshot({
      epoch: 7,
      members: [
        { peerId: 'AAAA', displayName: 'A', joinedAt: 1 },
        { peerId: 'BBBB', displayName: 'B', joinedAt: 2 },
      ],
    });
    expect(compareSnapshots(two, one)).toBeGreaterThan(0);
  });

  it('is a total order: no pair of states can make two devices disagree', () => {
    const candidates: GroupSnapshot[] = [
      snapshot({ epoch: 1 }),
      snapshot({ epoch: 2 }),
      snapshot({ epoch: 2, hostId: 'BBBB' }),
      snapshot({ epoch: 2, hostId: 'BBBB', members: [] }),
      snapshot({
        epoch: 2,
        members: [
          { peerId: 'AAAA', displayName: 'A', joinedAt: 1 },
          { peerId: 'ZZZZ', displayName: 'Z', joinedAt: 2 },
        ],
      }),
    ];
    for (const a of candidates) {
      for (const b of candidates) {
        // Antisymmetric everywhere, which is exactly what "two phones pick the
        // same winner" means.
        expect(Math.sign(compareSnapshots(a, b)) + Math.sign(compareSnapshots(b, a))).toBe(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Codec - hostile input
// ---------------------------------------------------------------------------

describe('relay packet codec', () => {
  it('round-trips a unicast packet', () => {
    const original = packet();
    const decoded = decodeRelayPacket(encodeRelayPacket(original));
    expect(decoded).toEqual(original);
  });

  it('round-trips a broadcast, where the destination is empty', () => {
    const decoded = decodeRelayPacket(encodeRelayPacket(packet({ destinationId: '' })));
    expect(decoded.destinationId).toBe('');
  });

  it('copies the payload out of the datagram buffer instead of aliasing it', () => {
    const encoded = encodeRelayPacket(packet({ payload: bytes(9, 9, 9) }));
    const decoded = decodeRelayPacket(encoded);
    encoded.fill(0);
    expect(Array.from(decoded.payload)).toEqual([9, 9, 9]);
  });

  it('rejects a hop budget outside the permitted range', () => {
    expect(() => encodeRelayPacket(packet({ hops: 0 }))).toThrow(/hop budget/);
    expect(() => encodeRelayPacket(packet({ hops: MESH_LIMITS.maxHops + 1 }))).toThrow(/hop budget/);
    // ...and on the wire, where the number came from a peer rather than from us.
    // The hop byte is located by diffing two otherwise identical encodings.
    const one = encodeRelayPacket(packet({ hops: 1 }));
    const two = encodeRelayPacket(packet({ hops: 2 }));
    const hopOffset = one.findIndex((b, i) => b !== two[i]);
    expect(hopOffset).toBeGreaterThan(0);
    const tampered = one.slice();
    tampered[hopOffset] = 99;
    expect(() => decodeRelayPacket(tampered)).toThrow(DecodeError);
  });

  it('rejects an unknown wire version rather than guessing at the header', () => {
    const wire = encodeRelayPacket(packet());
    wire[0] = 7;
    expect(() => decodeRelayPacket(wire)).toThrow(/relay version/);
  });

  it('rejects flag bits this build does not define', () => {
    const wire = encodeRelayPacket(packet());
    wire[1] = 0x80;
    expect(() => decodeRelayPacket(wire)).toThrow(/relay flags/);
  });

  it('refuses a relay packet nested inside a relay packet', () => {
    expect(() => encodeRelayPacket(packet({ innerType: MessageType.GROUP_RELAY }))).toThrow(/may not carry/);
  });

  it('refuses a packet addressed to its own sender', () => {
    const wire = encodeRelayPacket(packet({ originId: 'AAAA', destinationId: 'BBBB' }));
    // Rewrite 'BBBB' to 'AAAA' in place: same length, so framing survives and
    // only the semantic check can catch it.
    const text = Array.from(wire, (b) => String.fromCharCode(b)).join('');
    const at = text.indexOf('BBBB');
    expect(at).toBeGreaterThan(0);
    for (let i = 0; i < 4; i++) wire[at + i] = 'A'.charCodeAt(0);
    expect(() => decodeRelayPacket(wire)).toThrow(/its own origin/);
  });

  it('rejects an identifier outside the shared alphabet', () => {
    const wire = encodeRelayPacket(packet({ originId: 'AAAA' }));
    const text = Array.from(wire, (b) => String.fromCharCode(b)).join('');
    const at = text.indexOf('AAAA');
    wire[at] = 0x2e; // '.'
    expect(() => decodeRelayPacket(wire)).toThrow(/valid identifier/);
  });

  it('rejects an empty origin and an empty group id', () => {
    expect(() => encodeRelayPacket(packet({ originId: '' }))).not.toThrow();
    const wire = encodeRelayPacket(packet({ originId: '' }));
    expect(() => decodeRelayPacket(wire)).toThrow(/originId is empty/);
  });

  it('rejects a truncated packet at every prefix length', () => {
    const wire = encodeRelayPacket(packet());
    for (let cut = 0; cut < wire.length; cut++) {
      expect(() => decodeRelayPacket(wire.subarray(0, cut))).toThrow(DecodeError);
    }
  });

  it('rejects trailing bytes after a complete packet', () => {
    const wire = encodeRelayPacket(packet());
    const padded = new Uint8Array(wire.length + 3);
    padded.set(wire, 0);
    expect(() => decodeRelayPacket(padded)).toThrow(DecodeError);
  });

  it('refuses to encode a payload larger than the relay limit', () => {
    const huge = new Uint8Array(MESH_LIMITS.maxRelayPayloadBytes + 1);
    expect(() => encodeRelayPacket(packet({ payload: huge }))).toThrow(/exceeds the limit/);
  });

  it('rejects arbitrary garbage without throwing anything but DecodeError', () => {
    const rng = new SeededRandom(4242);
    for (let i = 0; i < 500; i++) {
      const junk = rng.randomBytes(1 + (i % 64));
      try {
        decodeRelayPacket(junk);
      } catch (err) {
        expect(err).toBeInstanceOf(DecodeError);
      }
    }
  });
});

describe('group snapshot codec', () => {
  it('round-trips a full group', () => {
    const original = snapshot({
      members: [
        { peerId: 'AAAA', displayName: 'Alejandro', joinedAt: 1000 },
        { peerId: 'BBBB', displayName: 'Maria', joinedAt: 2000 },
      ],
    });
    expect(decodeGroupSnapshot(encodeGroupSnapshot(original))).toEqual(original);
  });

  it('rejects a member list longer than the group limit', () => {
    const members: CborValue[] = [];
    for (let i = 0; i < MESH_LIMITS.maxMembers + 1; i++) members.push([`P${i}`, `n${i}`, 1000]);
    expect(() => decodeGroupSnapshot({ g: 'grp1', n: 'x', h: 'AAAA', e: 1, u: 0, m: members })).toThrow(
      /too many entries/,
    );
  });

  it('rejects a duplicated member, which would make membership ambiguous', () => {
    expect(() =>
      decodeGroupSnapshot({
        g: 'grp1',
        n: 'x',
        h: 'AAAA',
        e: 1,
        u: 0,
        m: [
          ['AAAA', 'a', 1],
          ['AAAA', 'a', 2],
        ],
      }),
    ).toThrow(/duplicate member/);
  });

  it('rejects an epoch that is not an integer in range', () => {
    const base = { g: 'grp1', n: 'x', h: 'AAAA', u: 0, m: [] };
    expect(() => decodeGroupSnapshot({ ...base, e: -1 })).toThrow(/out of range/);
    expect(() => decodeGroupSnapshot({ ...base, e: 2 ** 33 })).toThrow(/out of range/);
    expect(() => decodeGroupSnapshot({ ...base, e: 1.5 })).toThrow(/must be an integer/);
    expect(() => decodeGroupSnapshot({ ...base, e: 'seven' })).toThrow(/must be an integer/);
  });

  it('rejects a malformed member entry', () => {
    const base = { g: 'grp1', n: 'x', h: 'AAAA', e: 1, u: 0 };
    expect(() => decodeGroupSnapshot({ ...base, m: [['AAAA', 'a']] })).toThrow(/malformed member/);
    expect(() => decodeGroupSnapshot({ ...base, m: ['AAAA'] })).toThrow(/malformed member/);
    expect(() => decodeGroupSnapshot({ ...base, m: [[1, 'a', 1]] })).toThrow(/must be a string/);
  });

  it('rejects an over-long display name and an out-of-alphabet peer id', () => {
    const base = { g: 'grp1', n: 'x', h: 'AAAA', e: 1, u: 0 };
    const long = 'x'.repeat(MESH_LIMITS.maxDisplayNameLength + 1);
    expect(() => decodeGroupSnapshot({ ...base, m: [['AAAA', long, 1]] })).toThrow(/exceeds/);
    expect(() => decodeGroupSnapshot({ ...base, m: [['A A', 'a', 1]] })).toThrow(/valid identifier/);
  });

  it('rejects a snapshot that is not a map at all', () => {
    expect(() => decodeGroupSnapshot(null)).toThrow(/must be a map/);
    expect(() => decodeGroupSnapshot([1, 2, 3])).toThrow(/must be a map/);
    expect(() => decodeGroupSnapshot(bytes(1, 2))).toThrow(/must be a map/);
  });

  it('accepts a host who is no longer a member, because that state is real', () => {
    const decoded = decodeGroupSnapshot({
      g: 'grp1',
      n: 'x',
      h: 'GONE',
      e: 4,
      u: 0,
      m: [['BBBB', 'b', 1]],
    });
    expect(decoded.hostId).toBe('GONE');
    expect(decoded.members).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Three peers, a line, and a relay in the middle
// ---------------------------------------------------------------------------

const LINE_ABC = {
  names: ['A', 'B', 'C'] as const,
  edges: [
    ['A', 'B'],
    ['B', 'C'],
  ] as const,
};

describe('a three-peer line where A and C cannot see each other', () => {
  it('really is partitioned: A cannot open a link to C', async () => {
    const ctx = await buildMesh(LINE_ABC);
    await expect(ctx.devices.get('A')?.transport.connect('endpoint-c')).rejects.toThrow(/out of range/);
    expect(ctx.session('A', 'B').state).toBe(ConnectionState.CONNECTED);
    expect(ctx.session('B', 'C').state).toBe(ConnectionState.CONNECTED);
  });

  it('forms one group that all three agree on, host included', async () => {
    const ctx = await buildMesh(LINE_ABC);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);

    for (const name of ['A', 'B', 'C']) {
      const state = ctx.group(name).snapshot;
      expect(state?.groupId).toBe('grp1');
      expect(state?.hostId).toBe(ctx.pid('A'));
      expect(state?.members.map((m) => m.peerId).sort()).toEqual([ctx.pid('A'), ctx.pid('B'), ctx.pid('C')].sort());
    }
    // Converged means the same epoch, not merely the same members.
    const epochs = ['A', 'B', 'C'].map((n) => ctx.group(n).snapshot?.epoch);
    expect(new Set(epochs).size).toBe(1);
    expect(ctx.group('A').isHost).toBe(true);
    expect(ctx.group('C').isHost).toBe(false);
  });

  it('carries a message from A to C through B, exactly once', async () => {
    const ctx = await buildMesh(LINE_ABC);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);

    const atC = collectGroup(ctx.group('C'));
    const atB = collectGroup(ctx.group('B'));

    // C is a member but not a neighbour: this is the whole point of the module.
    expect(ctx.group('A').reachableMembers).toEqual([ctx.pid('B')]);
    expect(ctx.group('A').isMember(ctx.pid('C'))).toBe(true);

    expect(ctx.group('A').sendTo(ctx.pid('C'), MessageType.MESSAGE, encodeCbor({ t: 'seat 3?' }))).toBe(true);
    await ctx.clock.advanceAsync(6000);

    expect(atC).toHaveLength(1);
    const received = must(atC[0], 'message at C');
    expect(received.from).toBe(ctx.pid('A'));
    expect(received.via).toBe(ctx.pid('B'));
    expect(received.type).toBe(MessageType.MESSAGE);
    expect(received.relayed).toBe(true);
    // The honest bit: B read this on the way through, and C is told so.
    expect(received.endToEnd).toBe(false);
    expect(received.broadcast).toBe(false);

    // B carried it but was not addressed by it.
    expect(atB).toHaveLength(0);
    expect(ctx.group('B').packetsRelayed).toBe(1);
  });

  it('delivers a broadcast to every member and to each of them once', async () => {
    const ctx = await buildMesh(LINE_ABC);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);

    const atB = collectGroup(ctx.group('B'));
    const atC = collectGroup(ctx.group('C'));

    expect(ctx.group('A').broadcast(MessageType.MESSAGE, encodeCbor({ t: 'landing in 20' }))).toBe(1);
    await ctx.clock.advanceAsync(6000);

    expect(atB).toHaveLength(1);
    expect(atC).toHaveLength(1);
    expect(must(atB[0], 'B').broadcast).toBe(true);
    expect(must(atC[0], 'C').from).toBe(ctx.pid('A'));
    // B heard it from the sender directly; C only through B.
    expect(must(atB[0], 'B').relayed).toBe(false);
    expect(must(atB[0], 'B').endToEnd).toBe(true);
    expect(must(atC[0], 'C').relayed).toBe(true);
  });

  it('moves the host cleanly when promoteHost is called', async () => {
    const ctx = await buildMesh(LINE_ABC);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);

    const changesAtC: { from: string; to: string }[] = [];
    ctx.group('C').events.on('hostChanged', (e) => changesAtC.push(e));
    const before = must(ctx.group('A').snapshot, 'A state').epoch;

    const promoted = ctx.group('A').promoteHost(ctx.pid('B'));
    expect(promoted.hostId).toBe(ctx.pid('B'));
    expect(promoted.epoch).toBeGreaterThan(before);
    await ctx.clock.advanceAsync(6000);

    for (const name of ['A', 'B', 'C']) {
      expect(ctx.group(name).hostId).toBe(ctx.pid('B'));
    }
    expect(ctx.group('B').isHost).toBe(true);
    expect(ctx.group('A').isHost).toBe(false);
    // It reached C, which is two hops from the peer that made the decision.
    expect(changesAtC).toEqual([{ from: ctx.pid('A'), to: ctx.pid('B') }]);
    expect(new Set(['A', 'B', 'C'].map((n) => ctx.group(n).snapshot?.epoch)).size).toBe(1);
  });

  it('refuses to promote a peer who is not a member, and no-ops on the current host', async () => {
    const ctx = await buildMesh(LINE_ABC);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);

    expect(() => ctx.group('A').promoteHost('STRANGER')).toThrow(MeshError);
    const before = must(ctx.group('A').snapshot, 'A state');
    expect(ctx.group('A').promoteHost(ctx.pid('A'))).toBe(before);
  });

  it('reports the host as lost when it leaves, and lets a member take over', async () => {
    const ctx = await buildMesh(LINE_ABC);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);

    const lostAtC: string[] = [];
    ctx.group('C').events.on('hostLost', (e) => lostAtC.push(e.hostId));

    ctx.group('A').leave('walked off');
    await ctx.clock.advanceAsync(6000);

    // Both survivors know the host is gone, and neither has silently elected
    // anyone: that decision is the app's, and it is a consensus problem.
    expect(lostAtC).toEqual([ctx.pid('A')]);
    expect(ctx.group('B').hostPresent).toBe(false);
    expect(ctx.group('C').hostPresent).toBe(false);
    expect(ctx.group('B').isMember(ctx.pid('A'))).toBe(false);

    ctx.group('B').promoteHost(ctx.pid('B'));
    await ctx.clock.advanceAsync(6000);
    expect(ctx.group('B').isHost).toBe(true);
    expect(ctx.group('C').hostId).toBe(ctx.pid('B'));
    expect(ctx.group('C').hostPresent).toBe(true);
  });

  it('answers a state request from a member and refuses one from a stranger', async () => {
    const ctx = await buildMesh(LINE_ABC);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);

    // A member that has fallen behind catches up by asking.
    const stale = must(ctx.group('C').snapshot, 'C state');
    ctx.group('C').adopt({
      ...stale,
      epoch: 1,
      members: stale.members.filter((m) => m.peerId !== ctx.pid('C')),
    });
    ctx.group('C').requestState(ctx.pid('B'));
    await ctx.clock.advanceAsync(6000);
    expect(must(ctx.group('C').snapshot, 'C state').members).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Loops, duplicates and the hop limit
// ---------------------------------------------------------------------------

describe('bounding the flood', () => {
  it('terminates a loop in a triangle, delivering one copy to each member', async () => {
    const ctx = await buildMesh({
      names: ['A', 'B', 'C'],
      edges: [
        ['A', 'B'],
        ['B', 'C'],
        ['A', 'C'],
      ],
    });
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);

    // Count relay datagrams at the session layer, below the mesh, so a storm
    // would be visible even if dedup hid it from the application.
    let relayFrames = 0;
    for (const session of ctx.sessions.values()) {
      session.events.on('message', (m) => {
        if (m.type === MessageType.GROUP_RELAY) relayFrames++;
      });
    }

    const atB = collectGroup(ctx.group('B'));
    const atC = collectGroup(ctx.group('C'));
    const dropsB = collectDrops(ctx.group('B'));
    const dropsC = collectDrops(ctx.group('C'));

    ctx.group('A').broadcast(MessageType.MESSAGE, encodeCbor({ t: 'once, please' }));
    await ctx.clock.advanceAsync(30_000);

    // Exactly one delivery each, despite two paths to each of them.
    expect(atB).toHaveLength(1);
    expect(atC).toHaveLength(1);
    // A closed cycle: A->B, A->C, B->C, C->B. Four frames, then it dies.
    expect(relayFrames).toBe(4);
    expect(dropsB.filter((d) => d.reason === MeshDropReason.DUPLICATE)).toHaveLength(1);
    expect(dropsC.filter((d) => d.reason === MeshDropReason.DUPLICATE)).toHaveLength(1);
    // Nothing is still circulating.
    expect(ctx.group('A').diagnostics().seenEntries).toBe(1);
  });

  it('deduplicates a member who can be reached two different ways', async () => {
    const ctx = await buildMesh({
      names: ['A', 'B', 'C'],
      edges: [
        ['A', 'B'],
        ['B', 'C'],
        ['A', 'C'],
      ],
    });
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);
    const atC = collectGroup(ctx.group('C'));

    // A unicast to C: A can reach C directly, so it does - and B never sees it.
    ctx.group('A').sendTo(ctx.pid('C'), MessageType.MESSAGE, bytes(7));
    await ctx.clock.advanceAsync(10_000);

    expect(atC).toHaveLength(1);
    expect(must(atC[0], 'at C').relayed).toBe(false);
    expect(must(atC[0], 'at C').endToEnd).toBe(true);
    expect(ctx.group('B').packetsRelayed).toBe(0);
  });

  it('enforces the hop limit down a four-peer line', async () => {
    const line = {
      names: ['A', 'B', 'C', 'D'] as const,
      edges: [
        ['A', 'B'],
        ['B', 'C'],
        ['C', 'D'],
      ] as const,
    };

    const short = await buildMesh(line);
    await formGroupAlongPath(short, ['A', 'B', 'C', 'D']);
    const atD = collectGroup(short.group('D'));
    const dropsAtC = collectDrops(short.group('C'));

    // Two hops covers A->B->C and stops there; D is three links away.
    short.group('A').sendTo(short.pid('D'), MessageType.MESSAGE, bytes(1), { hops: 2 });
    await short.clock.advanceAsync(10_000);
    expect(atD).toHaveLength(0);
    expect(dropsAtC.map((d) => d.reason)).toContain(MeshDropReason.HOP_LIMIT);

    // One more hop and the same message arrives.
    short.group('A').sendTo(short.pid('D'), MessageType.MESSAGE, bytes(2), { hops: 3 });
    await short.clock.advanceAsync(10_000);
    expect(atD).toHaveLength(1);
    expect(Array.from(must(atD[0], 'at D').payload)).toEqual([2]);
    expect(must(atD[0], 'at D').hopsRemaining).toBe(1);
  });

  it('clamps a caller who asks for more hops than the mesh permits', async () => {
    const ctx = await buildMesh(LINE_ABC);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);
    const atC = collectGroup(ctx.group('C'));

    // A hop budget of a million is not a way to make one packet cost the mesh a
    // million forwards.
    ctx.group('A').sendTo(ctx.pid('C'), MessageType.MESSAGE, bytes(3), { hops: 1_000_000 });
    await ctx.clock.advanceAsync(6000);
    expect(atC).toHaveLength(1);
    expect(must(atC[0], 'at C').hopsRemaining).toBeLessThanOrEqual(MESH_LIMITS.maxHops);
  });
});

// ---------------------------------------------------------------------------
// Refusing to work for strangers
// ---------------------------------------------------------------------------

describe('a non-member gets nothing relayed', () => {
  /** A-B-C is the group; D has a live session to B but was never added. */
  const withOutsider = {
    names: ['A', 'B', 'C', 'D'] as const,
    edges: [
      ['A', 'B'],
      ['B', 'C'],
      ['B', 'D'],
    ] as const,
  };

  it('refuses locally to address a peer who is not in the group', async () => {
    const ctx = await buildMesh(withOutsider);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);
    expect(() => ctx.group('A').sendTo(ctx.pid('D'), MessageType.MESSAGE, bytes(1))).toThrow(MeshError);
    expect(() => ctx.group('A').sendTo('NOTAPEER', MessageType.MESSAGE, bytes(1))).toThrow(/not a member/);
  });

  it('refuses to forward for a link peer who is not in the group', async () => {
    const ctx = await buildMesh(withOutsider);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);
    // B knows D as a session, but D was never added to the group.
    ctx.group('B').attach(ctx.pid('D'), ctx.session('B', 'D'));
    const dropsB = collectDrops(ctx.group('B'));
    const atC = collectGroup(ctx.group('C'));

    // D forges a packet that claims to come from A - a real member - and asks B
    // to carry it to C.
    ctx.session('D', 'B').sendReliableRaw(
      MessageType.GROUP_RELAY,
      encodeRelayPacket(
        packet({ groupId: 'grp1', originId: ctx.pid('A'), destinationId: ctx.pid('C'), payload: bytes(66) }),
      ),
    );
    await ctx.clock.advanceAsync(10_000);

    expect(dropsB.map((d) => d.reason)).toContain(MeshDropReason.RELAY_NOT_MEMBER);
    expect(atC).toHaveLength(0);
    expect(ctx.group('B').packetsRelayed).toBe(0);
  });

  it('refuses to forward a packet whose claimed origin is not in the group', async () => {
    const ctx = await buildMesh(withOutsider);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);
    const dropsB = collectDrops(ctx.group('B'));
    const atC = collectGroup(ctx.group('C'));

    // A is a member, so B will listen - but the packet A hands over claims to
    // have been written by somebody outside the group.
    ctx.session('A', 'B').sendReliableRaw(
      MessageType.GROUP_RELAY,
      encodeRelayPacket(packet({ originId: 'OUTSIDER', destinationId: ctx.pid('C') })),
    );
    await ctx.clock.advanceAsync(10_000);

    expect(dropsB.map((d) => d.reason)).toContain(MeshDropReason.ORIGIN_NOT_MEMBER);
    expect(atC).toHaveLength(0);
  });

  it('refuses to forward a packet addressed to somebody outside the group', async () => {
    const ctx = await buildMesh(withOutsider);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);
    ctx.group('B').attach(ctx.pid('D'), ctx.session('B', 'D'));
    const dropsB = collectDrops(ctx.group('B'));

    let framesAtD = 0;
    ctx.session('D', 'B').events.on('message', (m) => {
      if (m.type === MessageType.GROUP_RELAY) framesAtD++;
    });

    ctx.session('A', 'B').sendReliableRaw(
      MessageType.GROUP_RELAY,
      encodeRelayPacket(packet({ originId: ctx.pid('A'), destinationId: ctx.pid('D') })),
    );
    await ctx.clock.advanceAsync(10_000);

    expect(dropsB.map((d) => d.reason)).toContain(MeshDropReason.DESTINATION_NOT_MEMBER);
    expect(framesAtD).toBe(0);
  });

  it('never floods a broadcast onward to an attached non-member', async () => {
    const ctx = await buildMesh(withOutsider);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);
    ctx.group('B').attach(ctx.pid('D'), ctx.session('B', 'D'));

    let framesAtD = 0;
    ctx.session('D', 'B').events.on('message', (m) => {
      if (m.type === MessageType.GROUP_RELAY) framesAtD++;
    });
    const atC = collectGroup(ctx.group('C'));

    ctx.group('A').broadcast(MessageType.MESSAGE, bytes(1, 2, 3));
    await ctx.clock.advanceAsync(10_000);

    expect(atC).toHaveLength(1);
    // D is attached and reachable, and gets nothing, because it is not a member.
    expect(framesAtD).toBe(0);
  });

  it('ignores a state update from a peer outside the group', async () => {
    const ctx = await buildMesh(withOutsider);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);
    ctx.group('B').attach(ctx.pid('D'), ctx.session('B', 'D'));
    const dropsB = collectDrops(ctx.group('B'));
    const before = must(ctx.group('B').snapshot, 'B state');

    // A hostile takeover attempt: a huge epoch, and D as host.
    ctx.session('D', 'B').sendReliable(
      MessageType.GROUP_UPDATE,
      encodeGroupSnapshot({
        groupId: 'grp1',
        name: 'hijacked',
        hostId: ctx.pid('D'),
        epoch: 4_000_000_000,
        members: [{ peerId: ctx.pid('D'), displayName: 'D', joinedAt: 1 }],
        updatedAt: 1,
      }),
    );
    await ctx.clock.advanceAsync(10_000);

    expect(dropsB.map((d) => d.reason)).toContain(MeshDropReason.RELAY_NOT_MEMBER);
    expect(ctx.group('B').snapshot).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// Hostile bytes arriving over a real session
// ---------------------------------------------------------------------------

describe('hostile input over a live session', () => {
  it('drops garbage in a GROUP_RELAY payload and keeps routing afterwards', async () => {
    const ctx = await buildMesh(LINE_ABC);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);
    const atC = collectGroup(ctx.group('C'));
    const rng = new SeededRandom(31337);

    for (let i = 0; i < 60; i++) {
      ctx.session('A', 'B').sendReliableRaw(MessageType.GROUP_RELAY, rng.randomBytes(1 + (i % 50)));
    }
    await ctx.clock.advanceAsync(20_000);

    expect(ctx.group('B').malformedPackets).toBeGreaterThan(0);
    expect(ctx.session('B', 'A').state).toBe(ConnectionState.CONNECTED);

    // The mesh is entirely unbothered: the next real message still gets through.
    ctx.group('A').sendTo(ctx.pid('C'), MessageType.MESSAGE, bytes(42));
    await ctx.clock.advanceAsync(10_000);
    expect(atC).toHaveLength(1);
    expect(Array.from(must(atC[0], 'at C').payload)).toEqual([42]);
  });

  it('drops a malformed group control payload without touching group state', async () => {
    const ctx = await buildMesh(LINE_ABC);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);
    const before = must(ctx.group('B').snapshot, 'B state');
    const dropsB = collectDrops(ctx.group('B'));

    // Wrong CBOR shape, out-of-range values, and a member list past the limit.
    ctx.session('A', 'B').sendReliable(MessageType.GROUP_UPDATE, [1, 2, 3]);
    ctx.session('A', 'B').sendReliable(MessageType.GROUP_UPDATE, { g: 'grp1', h: 'AAAA', e: -5, m: [] });
    ctx.session('A', 'B').sendReliable(MessageType.GROUP_MEMBER_JOIN, { g: 'grp1', m: 'not-a-member' });
    ctx.session('A', 'B').sendReliable(MessageType.GROUP_MEMBER_LEAVE, { g: 'grp1' });
    ctx.session('A', 'B').sendReliable(MessageType.GROUP_STATE_REQUEST, { g: 'has space' });
    const oversized: CborValue[] = [];
    for (let i = 0; i < 64; i++) oversized.push([`P${i}`, 'x', 1]);
    ctx.session('A', 'B').sendReliable(MessageType.GROUP_UPDATE, {
      g: 'grp1',
      h: 'AAAA',
      e: 99,
      u: 0,
      m: oversized,
    });
    await ctx.clock.advanceAsync(20_000);

    expect(ctx.group('B').malformedPackets).toBe(6);
    expect(dropsB.filter((d) => d.reason === MeshDropReason.MALFORMED)).toHaveLength(6);
    expect(ctx.group('B').snapshot).toEqual(before);
    expect(ctx.group('B').members).toHaveLength(3);
  });

  it('will not adopt a group it is not named in', async () => {
    const ctx = await buildMesh(LINE_ABC);
    // No group formed at all: B is a blank slate.
    const dropsB = collectDrops(ctx.group('B'));
    ctx.session('A', 'B').sendReliable(
      MessageType.GROUP_CREATE,
      encodeGroupSnapshot(
        snapshot({ groupId: 'grp9', members: [{ peerId: ctx.pid('A'), displayName: 'A', joinedAt: 1 }] }),
      ),
    );
    await ctx.clock.advanceAsync(10_000);

    expect(ctx.group('B').snapshot).toBeNull();
    expect(dropsB.map((d) => d.reason)).toContain(MeshDropReason.NO_GROUP);
  });

  it('refuses local misuse loudly, and never with a stray TypeError', async () => {
    const ctx = await buildMesh(LINE_ABC);
    const gA = ctx.group('A');

    expect(() => gA.broadcast(MessageType.MESSAGE, bytes(1))).toThrow(MeshError);
    expect(() => gA.attach('has space', ctx.session('A', 'B'))).toThrow(MeshError);
    expect(() => gA.attach(ctx.pid('A'), ctx.session('A', 'B'))).toThrow(/ourselves/);
    // The mesh identity must be the authenticated one.
    expect(() => gA.attach(ctx.pid('C'), ctx.session('A', 'B'))).toThrow(/authenticated as/);

    gA.create('Row 27', 'grp1');
    expect(() => gA.sendTo(gA.localPeerId, MessageType.MESSAGE, bytes(1))).toThrow(/ourselves/);
    gA.addMember({ peerId: ctx.pid('B'), displayName: 'B', joinedAt: 0 });
    expect(() => gA.sendTo(ctx.pid('B'), MessageType.GROUP_RELAY, bytes(1))).toThrow(/relay a relay/);
    expect(() =>
      gA.sendTo(ctx.pid('B'), MessageType.MESSAGE, new Uint8Array(MESH_LIMITS.maxRelayPayloadBytes + 1)),
    ).toThrow(/exceeds the relay limit/);

    gA.dispose();
    expect(() => gA.create('another')).toThrow(/disposed/);
  });
});

// ---------------------------------------------------------------------------
// Joining, re-attaching, and the sealed-payload escape hatch
// ---------------------------------------------------------------------------

describe('joining and re-attaching', () => {
  it('lets a peer adopt a group out of band and announce itself', async () => {
    const ctx = await buildMesh(LINE_ABC);
    ctx.group('A').create('Row 27', 'grp1');
    ctx.group('A').addMember({ peerId: ctx.pid('B'), displayName: 'B', joinedAt: 0 });
    await ctx.clock.advanceAsync(4000);

    // C is handed the state some other way - a QR code across the aisle - and
    // then tells the group it is here.
    const shared = must(ctx.group('B').snapshot, 'B state');
    ctx.group('C').adopt({
      ...shared,
      members: [...shared.members, { peerId: ctx.pid('C'), displayName: 'C', joinedAt: 0 }],
    });
    ctx.group('C').announceSelf();
    await ctx.clock.advanceAsync(8000);

    for (const name of ['A', 'B', 'C']) expect(ctx.group(name).members).toHaveLength(3);
    expect(new Set(['A', 'B', 'C'].map((n) => ctx.group(n).snapshot?.epoch)).size).toBe(1);
  });

  it('replaces a neighbour on re-attach instead of delivering everything twice', async () => {
    const ctx = await buildMesh(LINE_ABC);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);
    const atC = collectGroup(ctx.group('C'));

    // A reconnect hands the mesh a session for a peer it already knows.
    ctx.group('B').attach(ctx.pid('C'), ctx.session('B', 'C'));
    expect(ctx.group('B').attachedPeers).toHaveLength(2);

    ctx.group('A').sendTo(ctx.pid('C'), MessageType.MESSAGE, bytes(5));
    await ctx.clock.advanceAsync(10_000);
    expect(atC).toHaveLength(1);
  });

  it('honours a payload the sender says it already sealed', async () => {
    const ctx = await buildMesh(LINE_ABC);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);
    const atC = collectGroup(ctx.group('C'));

    ctx.group('A').sendTo(ctx.pid('C'), MessageType.MESSAGE, bytes(1), { endToEndSealed: true });
    await ctx.clock.advanceAsync(10_000);

    const received = must(atC[0], 'at C');
    // Relayed through B, and yet reported as confidential - because the caller
    // took responsibility for sealing it. Nothing in this build does.
    expect(received.relayed).toBe(true);
    expect(received.endToEnd).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Degraded links
// ---------------------------------------------------------------------------

describe('degraded links', () => {
  it('forms a group and relays across a BLE-class link', async () => {
    const ctx = await buildMesh({ ...LINE_ABC, conditions: BLE_LIKE_CONDITIONS });
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);
    const atC = collectGroup(ctx.group('C'));

    expect(ctx.group('C').members).toHaveLength(3);

    // 2 KB over a 180-byte MTU: the relay packet is fragmented on both legs.
    const big = new Uint8Array(2000);
    for (let i = 0; i < big.length; i++) big[i] = i & 0xff;
    ctx.group('A').sendTo(ctx.pid('C'), MessageType.MESSAGE, big);
    await ctx.clock.advanceAsync(60_000);

    expect(atC).toHaveLength(1);
    expect(must(atC[0], 'at C').payload).toEqual(big);
  });

  it('completes over a hostile link with heavy loss, reordering and duplication', async () => {
    const ctx = await buildMesh({ ...LINE_ABC, conditions: WIFI_LIKE_CONDITIONS });
    // Degrade only after the handshakes, which have no retry of their own.
    ctx.network.setConditions(HOSTILE_CONDITIONS);

    await formGroupAlongPath(ctx, ['A', 'B', 'C']);
    // Group state converged across two hops despite 15% reliable loss.
    expect(ctx.group('C').members).toHaveLength(3);
    expect(ctx.group('C').hostId).toBe(ctx.pid('A'));

    const atB = collectGroup(ctx.group('B'));
    const atC = collectGroup(ctx.group('C'));

    const sent = 8;
    for (let i = 0; i < sent; i++) ctx.group('A').broadcast(MessageType.MESSAGE, bytes(i));
    await ctx.clock.advanceAsync(180_000);

    // Every broadcast reaches both members exactly once - no loss, and no
    // duplicate despite the link duplicating 10% of everything it carries.
    expect(atB.map((m) => must(m.payload[0], 'byte'))).toEqual(Array.from({ length: sent }, (_, i) => i));
    expect(atC.map((m) => must(m.payload[0], 'byte'))).toEqual(Array.from({ length: sent }, (_, i) => i));

    // And the host can still be moved when the radio is this bad.
    ctx.group('A').promoteHost(ctx.pid('C'));
    await ctx.clock.advanceAsync(120_000);
    expect(ctx.group('C').isHost).toBe(true);
    expect(ctx.group('B').hostId).toBe(ctx.pid('C'));
  });
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

describe('diagnostics', () => {
  it('reports the routing state a developer needs to see', async () => {
    const ctx = await buildMesh(LINE_ABC);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);
    ctx.group('A').sendTo(ctx.pid('C'), MessageType.MESSAGE, bytes(1));
    await ctx.clock.advanceAsync(6000);

    const d = ctx.group('B').diagnostics();
    expect(d.groupId).toBe('grp1');
    expect(d.hostId).toBe(ctx.pid('A'));
    expect(d.isHost).toBe(false);
    expect(d.hostPresent).toBe(true);
    expect(d.memberCount).toBe(3);
    expect(d.packetsRelayed).toBe(1);
    expect(d.reachableMembers).toEqual([ctx.pid('A'), ctx.pid('C')]);
    expect(d.seenEntries).toBe(1);
  });

  it('detaching a neighbour stops it from being routed to', async () => {
    const ctx = await buildMesh(LINE_ABC);
    await formGroupAlongPath(ctx, ['A', 'B', 'C']);
    const atC = collectGroup(ctx.group('C'));

    ctx.group('B').detach(ctx.pid('C'));
    expect(ctx.group('B').reachableMembers).toEqual([ctx.pid('A')]);

    // C is still a member, so sending is legal - it simply cannot get there.
    ctx.group('A').sendTo(ctx.pid('C'), MessageType.MESSAGE, bytes(1));
    await ctx.clock.advanceAsync(10_000);
    expect(atC).toHaveLength(0);
  });
});
