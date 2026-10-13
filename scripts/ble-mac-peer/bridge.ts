/**
 * The Mac as a second AirLink phone, over real Bluetooth.
 *
 * `main.swift` owns the radio: it advertises the AirLink GATT service, takes the
 * iPhone's writes and sends notifications back. This process owns everything
 * above it, and it is not a stand-in for the protocol - it IS the protocol,
 * `packages/core`, the same code the app runs: the encrypted handshake, the
 * six-digit pairing, chat with delivery receipts, and file transfer. The only
 * thing replaced is the phone.
 *
 * What that buys, with one iPhone and no second device:
 *
 *   - the iPhone can really connect and pair with something over Bluetooth alone;
 *   - messages cross in both directions on a real radio, with their delivery
 *     latency measured rather than argued about;
 *   - a file moves at whatever speed the radio actually gives, which is the
 *     number "it is very slow" has so far had no measurement behind;
 *   - the routing of incoming links (`IncomingLinkRouter`) is exercised the way
 *     it is on a phone, including a reconnect after the link drops.
 *
 * Run it through `scripts/ble-mac-peer.sh --talk`. It listens on a loopback TCP
 * port, starts the Swift app pointed at it, and exchanges line-delimited JSON:
 *
 *     swift -> node   {op:'open', mtu}  {op:'rx', data}  {op:'close'}  {op:'log', line}
 *     node  -> swift  {op:'tx', data}   {op:'quit'}
 *
 * with `data` base64. Options: --seconds N  --name NAME  --file-kb N  --app PATH  --log FILE  --no-radio
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import {
  ChatProtocol,
  ConnectionState,
  DeliveryStatus,
  FileTransferProtocol,
  InMemoryTrustStore,
  IncomingLinkRouter,
  MemoryFileStore,
  PROTOCOL_VERSION,
  PairingController,
  PeerSession,
  TransportKind,
  createIdentity,
  systemClock,
  systemRandom,
  type HandshakeConfig,
  type Link,
  type PeerCapabilities,
} from '../../packages/core/src/index.js';
import { RadioLink } from './radioLink.js';

// ---------------------------------------------------------------------------
// Arguments and logging
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const option = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const RUN_SECONDS = Number(option('--seconds') ?? 600);
const NAME = option('--name') ?? 'Mac-test';
const FILE_KB = Number(option('--file-kb') ?? 64);
const NO_RADIO = args.includes('--no-radio');
const APP = option('--app');
if (!APP && !NO_RADIO) {
  console.error('usage: bridge.ts --app "<path to AirLink BLE Peer.app>" [--seconds N] [--name NAME] [--file-kb N]');
  process.exit(2);
}

// A copy of everything printed goes to a file as well, so that what happened on
// the bench can be read afterwards without anybody copying a terminal.
const LOG_FILE = option('--log');
if (LOG_FILE) {
  writeFileSync(LOG_FILE, '');
  const print = console.log.bind(console);
  console.log = (...parts: unknown[]): void => {
    print(...parts);
    // eslint-disable-next-line no-control-regex
    appendFileSync(LOG_FILE, `${parts.join(' ').replace(/\x1b\[[0-9;]*m/g, '')}\n`);
  };
}

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function stamp(): string {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}
const log = (line: string): void => console.log(`[${stamp()}] ${line}`);
const say = (line: string): void => console.log(`[${stamp()}] ${BOLD}${line}${RESET}`);

// ---------------------------------------------------------------------------
// Our identity: a phone called NAME that has never met anybody
// ---------------------------------------------------------------------------

const identity = createIdentity(systemRandom, Date.now());
const trust = new InMemoryTrustStore();

const capabilities: PeerCapabilities = {
  protocolVersion: PROTOCOL_VERSION,
  appVersion: 'mac-peer',
  platform: 'macos',
  deviceModel: 'Mac (Bluetooth test peer)',
  displayName: NAME,
  deviceId: `mac-peer-${identity.peerId.slice(0, 12)}`,
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

// ---------------------------------------------------------------------------
// What happened, for the summary
// ---------------------------------------------------------------------------

const results = {
  linksOpened: 0,
  linksTurnedAway: 0,
  pairings: 0,
  heard: 0,
  sent: 0,
  deliveredMs: [] as number[],
  readMs: [] as number[],
  fileBytes: 0,
  fileMs: null as number | null,
  fileFailure: null as string | null,
};

const median = (xs: number[]): number | null => {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? null;
};

// ---------------------------------------------------------------------------
// The sessions, and the router that decides which link belongs to which
// ---------------------------------------------------------------------------

interface Conversation {
  readonly session: PeerSession;
  readonly chat: ChatProtocol;
  readonly files: FileTransferProtocol;
  greeted: boolean;
}

const conversations: Conversation[] = [];
let currentLink: RadioLink | null = null;
let socket: net.Socket | null = null;

function toRadio(bytes: Uint8Array): void {
  socket?.write(`${JSON.stringify({ op: 'tx', data: Buffer.from(bytes).toString('base64') })}\n`);
}

function startConversation(link: Link): void {
  // A hello from an iPhone that has forgotten us: whatever session we held with
  // it is dead, and keeping it around would only be a second answer to the same
  // question.
  for (const old of conversations.splice(0)) void old.session.close('the iPhone introduced itself afresh');

  const session = new PeerSession('iphone', { clock: systemClock, handshake });
  const pairing = new PairingController(session, {
    clock: systemClock,
    trustStore: trust,
    identity,
    random: systemRandom,
  });
  const chat = new ChatProtocol(session, { clock: systemClock, random: systemRandom });
  const files = new FileTransferProtocol(session, { clock: systemClock, random: systemRandom });
  const conversation: Conversation = { session, chat, files, greeted: false };
  conversations.push(conversation);

  session.events.on('stateChanged', ({ state }) => {
    log(`session: ${state}`);
    if (state === ConnectionState.CONNECTED && !conversation.greeted) {
      conversation.greeted = true;
      void greet(conversation);
    }
  });

  pairing.events.on('confirmationRequired', ({ displayName, sasCode }) => {
    const code = `${sasCode.slice(0, 3)} ${sasCode.slice(3)}`;
    console.log('');
    say(`PAIRING with "${displayName}": the six digits are  ${GREEN}${code}${RESET}${BOLD}`);
    say('Compare them with the iPhone and tap "They match" there. This side confirms by itself.');
    console.log('');
    pairing.confirm();
  });
  pairing.events.on('paired', ({ peer, firstTime }) => {
    results.pairings += 1;
    say(`PAIRED with "${peer.displayName}"${firstTime ? ' (first time)' : ''} - over Bluetooth alone`);
  });
  pairing.events.on('refused', ({ reason }) => log(`pairing refused: ${reason}`));

  chat.events.on('message', ({ message }) => {
    results.heard += 1;
    const text = message.text || `[${message.attachments.length} attachment(s)]`;
    say(`THE IPHONE SAID: ${text}`);
    if (message.text) void sendText(conversation, `Mac heard: ${message.text}`);
  });
  chat.events.on('statusChanged', ({ messageId, status }) => {
    const sentAt = sentAtById.get(messageId);
    if (sentAt === undefined) return;
    const ms = Date.now() - sentAt;
    if (status === DeliveryStatus.DELIVERED) {
      results.deliveredMs.push(ms);
      say(`our message ${messageId.slice(0, 6)} DELIVERED to the iPhone after ${ms} ms`);
    } else if (status === DeliveryStatus.READ) {
      results.readMs.push(ms);
      log(`our message ${messageId.slice(0, 6)} read after ${ms} ms`);
    }
  });
  chat.events.on('sendFailed', ({ messageId, attempts }) => {
    log(`${YELLOW}giving up on message ${messageId.slice(0, 6)} after ${attempts} attempts${RESET}`);
  });

  files.events.on('progress', ({ progress }) => {
    const rate = progress.bytesPerSecond === null ? '?' : `${(progress.bytesPerSecond / 1024).toFixed(1)} KB/s`;
    log(`file: ${progress.percent.toFixed(0)}%  ${rate}`);
  });
  files.events.on('completed', ({ filename, fileBytes }) => {
    const ms = fileStartedAt === null ? null : Date.now() - fileStartedAt;
    results.fileBytes = fileBytes;
    results.fileMs = ms;
    say(`FILE "${filename}" (${fileBytes} bytes) arrived after ${ms === null ? '?' : `${ms} ms = ${(fileBytes / 1024 / ((ms ?? 1) / 1000)).toFixed(1)} KB/s`}`);
  });
  for (const outcome of ['declined', 'cancelled', 'failed'] as const) {
    files.events.on(outcome, (event) => {
      results.fileFailure = outcome;
      log(`${YELLOW}file ${outcome}: ${JSON.stringify(event, (_k, v) => (v instanceof Uint8Array ? '<bytes>' : v))}${RESET}`);
    });
  }

  session.startAsResponder(link);
}

const sentAtById = new Map<string, number>();
let fileStartedAt: number | null = null;

async function sendText(conversation: Conversation, text: string): Promise<void> {
  try {
    const entry = conversation.chat.send({ text });
    sentAtById.set(entry.message.id, Date.now());
    results.sent += 1;
  } catch (err) {
    log(`could not send: ${String(err)}`);
  }
}

async function greet(conversation: Conversation): Promise<void> {
  say('CONNECTED. Sending a message and a file over Bluetooth.');
  await sendText(conversation, 'Hello from the Mac, over Bluetooth only.');
  if (FILE_KB > 0) {
    const bytes = new Uint8Array(FILE_KB * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 0xff;
    fileStartedAt = Date.now();
    try {
      await conversation.files.offer({
        filename: 'bluetooth-test.bin',
        fileBytes: bytes.length,
        mimeType: 'application/octet-stream',
        store: new MemoryFileStore(bytes),
      });
      say(`offered a ${FILE_KB} KB file: accept it on the iPhone (Share tab) to time the transfer`);
    } catch (err) {
      log(`could not offer the file: ${String(err)}`);
    }
  }
}

const router = new IncomingLinkRouter<PeerSession>({
  clock: systemClock,
  sessions: () => conversations.map((c) => c.session).filter((s) => s.isSecure),
  owns: (session, id) => session.ownsSessionId(id),
  resume: (session, link) => {
    say('the iPhone RESUMED its session on a new link');
    session.migrateToLink(link);
  },
  introduce: (link) => startConversation(link),
  onTurnedAway: (reason) => {
    results.linksTurnedAway += 1;
    log(`link turned away: ${reason}`);
  },
});

// ---------------------------------------------------------------------------
// The wire to the Swift process
// ---------------------------------------------------------------------------

function onRadioMessage(message: Record<string, unknown>): void {
  switch (message.op) {
    case 'log':
      console.log(String(message.line));
      break;
    case 'open': {
      results.linksOpened += 1;
      const mtu = Math.max(20, Number(message.mtu) || 20);
      const endpoint = String(message.central ?? 'central');
      log(`radio: the iPhone opened a link (datagrams up to ${mtu} bytes)`);
      currentLink = new RadioLink(endpoint, mtu, toRadio);
      router.accept(currentLink);
      break;
    }
    case 'rx':
      currentLink?.deliver(new Uint8Array(Buffer.from(String(message.data), 'base64')));
      break;
    case 'close':
      log('radio: the iPhone closed its link');
      currentLink?.peerClosed();
      currentLink = null;
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

let swift: ChildProcess | null = null;
let finishing = false;

function finish(reason: string): void {
  if (finishing) return;
  finishing = true;
  log(reason);
  socket?.write(`${JSON.stringify({ op: 'quit' })}\n`);
  setTimeout(() => {
    summary();
    for (const c of conversations) void c.session.close('done');
    process.exit(0);
  }, 1500);
}

function summary(): void {
  const ms = (xs: number[]): string => (xs.length === 0 ? 'none' : `${xs.length}, median ${median(xs)} ms, worst ${Math.max(...xs)} ms`);
  console.log('');
  console.log(`${BOLD}BRIDGE SUMMARY${RESET}`);
  console.log(`  links the iPhone opened          : ${results.linksOpened}   (turned away: ${results.linksTurnedAway})`);
  console.log(`  pairings completed               : ${results.pairings}`);
  console.log(`  messages from the iPhone         : ${results.heard}`);
  console.log(`  messages we sent                 : ${results.sent}`);
  console.log(`  delivered to the iPhone          : ${ms(results.deliveredMs)}`);
  console.log(`  read by the iPhone               : ${ms(results.readMs)}`);
  console.log(
    `  file                             : ${
      results.fileMs !== null
        ? `${results.fileBytes} bytes in ${results.fileMs} ms = ${(results.fileBytes / 1024 / (results.fileMs / 1000)).toFixed(1)} KB/s`
        : results.fileFailure
          ? `did not complete (${results.fileFailure})`
          : FILE_KB > 0
            ? 'not accepted on the iPhone'
            : 'not offered'
    }`,
  );
}

const server = net.createServer((connection) => {
  socket = connection;
  let pending = '';
  connection.setEncoding('utf8');
  connection.on('data', (chunk: string) => {
    pending += chunk;
    let newline: number;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        onRadioMessage(JSON.parse(line) as Record<string, unknown>);
      } catch (err) {
        log(`bad line from the radio process: ${String(err)}`);
      }
    }
  });
  connection.on('close', () => finish('the radio process ended'));
});

server.listen(0, '127.0.0.1', () => {
  const port = (server.address() as net.AddressInfo).port;
  log(`protocol process: peer id ${identity.peerId.slice(0, 16)}..., listening on 127.0.0.1:${port}`);
  if (NO_RADIO) return;
  swift = spawn(
    'open',
    [
      '-n',
      '-W',
      '--stdout',
      '/dev/null',
      '--stderr',
      '/dev/null',
      APP as string,
      '--args',
      '--bridge',
      `127.0.0.1:${port}`,
      '--seconds',
      String(RUN_SECONDS + 5),
      '--name',
      NAME,
    ],
    { stdio: 'ignore' },
  );
  swift.on('exit', () => finish('the radio app exited'));
});

setTimeout(() => finish('time is up'), RUN_SECONDS * 1000);
process.on('SIGINT', () => finish('interrupted'));
process.on('SIGTERM', () => finish('terminated'));
