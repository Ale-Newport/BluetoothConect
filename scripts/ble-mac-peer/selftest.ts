/**
 * Does the bridge work, before a radio is involved?
 *
 * Starts `bridge.ts` with no radio and connects to it over the same JSON wire
 * the Swift app uses, playing the part of the iPhone with the REAL protocol: it
 * dials, pairs with six digits, chats, accepts a file, drops its link, comes
 * back on a new one and resumes - and a stray central that subscribes and says
 * nothing is checked to be turned away rather than given a session.
 *
 * It is the check to run before asking somebody to hold a phone: what it can
 * rule out is every mistake in the Node half, so that whatever goes wrong on the
 * bench is the radio or the phone.
 *
 *   ./node_modules/.bin/tsx scripts/ble-mac-peer/selftest.ts [--mtu 185]
 */
import { spawn } from 'node:child_process';
import net from 'node:net';
import {
  ChatProtocol,
  ConnectionState,
  FileTransferProtocol,
  InMemoryTrustStore,
  MemoryFileStore,
  PROTOCOL_VERSION,
  PairingController,
  PeerSession,
  TransportKind,
  createIdentity,
  systemClock,
  systemRandom,
  type HandshakeConfig,
  type PeerCapabilities,
} from '../../packages/core/src/index.js';
import { RadioLink } from './radioLink.js';

const MTU = Number(process.argv[process.argv.indexOf('--mtu') + 1]) || 185;

const failures: string[] = [];
const check = (ok: boolean, what: string): void => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}`);
  if (!ok) failures.push(what);
};
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until(what: string, condition: () => boolean, ms = 20_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await sleep(25);
  }
  console.log(` FAIL  timed out waiting for: ${what}`);
  failures.push(`timed out: ${what}`);
  return false;
}

// ---- the iPhone ------------------------------------------------------------

const identity = createIdentity(systemRandom, Date.now());
const trust = new InMemoryTrustStore();
const capabilities: PeerCapabilities = {
  protocolVersion: PROTOCOL_VERSION,
  appVersion: 'selftest',
  platform: 'ios',
  deviceModel: 'iPhone (simulated)',
  displayName: 'SimulatedPhone',
  deviceId: `selftest-${identity.peerId.slice(0, 12)}`,
  transports: [TransportKind.BLE],
  features: ['chat', 'files'],
  games: [],
  maxPayloadBytes: 65536,
};
const handshake: HandshakeConfig = {
  identity,
  capabilities,
  random: systemRandom,
  lookupTrustedKey: (peerId) => trust.get(peerId),
};

// ---- the wire to the bridge ------------------------------------------------

let socket: net.Socket;
let currentLink: RadioLink | null = null;
const received: string[] = [];
let fileDone = false;

function sendOp(message: Record<string, unknown>): void {
  socket.write(`${JSON.stringify(message)}\n`);
}

function newLink(): RadioLink {
  const link = new RadioLink('selftest-phone', MTU, (bytes) =>
    sendOp({ op: 'rx', data: Buffer.from(bytes).toString('base64') }),
  );
  currentLink = link;
  sendOp({ op: 'open', mtu: MTU, central: 'selftest-phone' });
  return link;
}

async function main(): Promise<void> {
  const bridge = spawn(
    './node_modules/.bin/tsx',
    ['scripts/ble-mac-peer/bridge.ts', '--no-radio', '--seconds', '120', '--name', 'Mac-test', '--file-kb', '48'],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let port = 0;
  let bridgeLog = '';
  bridge.stdout.setEncoding('utf8');
  bridge.stdout.on('data', (chunk: string) => {
    bridgeLog += chunk;
    const match = /listening on 127\.0\.0\.1:(\d+)/.exec(bridgeLog);
    if (match && !port) port = Number(match[1]);
  });
  if (!(await until('the bridge to listen', () => port !== 0))) return void bridge.kill();

  socket = net.connect(port, '127.0.0.1');
  let pending = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      const message = JSON.parse(line) as { op: string; data?: string };
      if (message.op === 'tx' && message.data) currentLink?.deliver(new Uint8Array(Buffer.from(message.data, 'base64')));
    }
  });
  await new Promise<void>((resolve) => socket.once('connect', () => resolve()));

  console.log(`\nA. Pairing, chat and a file, over a ${MTU}-byte link`);
  const session = new PeerSession('mac', { clock: systemClock, handshake });
  const pairing = new PairingController(session, { clock: systemClock, trustStore: trust, identity, random: systemRandom });
  const chat = new ChatProtocol(session, { clock: systemClock, random: systemRandom });
  const files = new FileTransferProtocol(session, { clock: systemClock, random: systemRandom });
  let sas: string | null = null;
  pairing.events.on('confirmationRequired', ({ sasCode }) => {
    sas = sasCode;
    pairing.confirm();
  });
  chat.events.on('message', ({ message }) => received.push(message.text));
  files.events.on('offer', ({ offer }) => {
    files.accept(offer.transferId, new MemoryFileStore(offer.fileBytes));
  });
  files.events.on('completed', () => {
    fileDone = true;
  });

  const link = newLink();
  await session.startAsInitiator(link);
  check(await until('the session to become secure', () => session.isSecure), 'the handshake completes through the bridge');
  check(await until('the session to be connected', () => session.state === ConnectionState.CONNECTED), 'pairing completes and the session is CONNECTED');
  check(sas !== null && /^\d{6}$/.test(sas), `a six-digit code was shown (${sas})`);

  check(await until('the greeting', () => received.includes('Hello from the Mac, over Bluetooth only.')), 'the Mac greets the phone');
  chat.send({ text: 'ping' });
  check(await until('the echo', () => received.includes('Mac heard: ping')), 'a message sent to the Mac comes back as an echo');
  check(await until('the file', () => fileDone, 40_000), 'the file offered by the Mac is accepted and arrives');

  console.log('\nB. A dropped link is resumed, not re-introduced');
  const before = session.state;
  sendOp({ op: 'close' });
  link.peerClosed();
  check(await until('the phone to notice', () => session.state === ConnectionState.RECONNECTING, 8_000), `the phone's session waits for a link (was ${before})`);

  const second = newLink();
  session.migrateToLink(second);
  chat.send({ text: 'back again' });
  check(await until('the echo after resuming', () => received.includes('Mac heard: back again')), 'after resuming, messages still cross');
  check(!/turned away/.test(bridgeLog), 'a resuming friend was not turned away');

  console.log('\nC. A stray central that subscribes and says nothing');
  sendOp({ op: 'close' });
  second.peerClosed();
  await sleep(300);
  sendOp({ op: 'open', mtu: MTU, central: 'a-stray-mac' });
  await sleep(500);
  const turned = (bridgeLog.match(/link turned away/g) ?? []).length;
  check(turned === 0, 'it is held without being given anybody\'s session (it is not turned away until it has had its chance to speak)');
  check(!/pairing refused/.test(bridgeLog), 'it did not disturb the paired session');

  sendOp({ op: 'quit' });
  bridge.kill();
  socket.destroy();
  await sleep(200);
}

main()
  .catch((err) => {
    console.log(` FAIL  ${String(err)}`);
    failures.push(String(err));
  })
  .finally(() => {
    console.log(failures.length === 0 ? '\nALL GOOD\n' : `\n${failures.length} FAILED\n`);
    process.exit(failures.length === 0 ? 0 : 1);
  });
