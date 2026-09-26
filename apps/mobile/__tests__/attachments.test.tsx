/**
 * Photos and voice notes: the row, the bytes, and what a failure looks like.
 *
 * An attachment is the one message in this app that is stored in two places at
 * once - a row in `messages` that the bubble draws, and a transfer that moves
 * the file - and every interesting bug in it is the two halves disagreeing.
 * So these tests assert the database, not the screen: that picking a photo
 * really does write an `image` row with a file behind it, that a recording
 * writes a `voice` one, that the file is handed to the transfer layer exactly
 * once, and that a send which cannot happen leaves a row the user can see and
 * tap rather than nothing at all.
 *
 * The transfer layer is the one thing replaced by a double. It is tested for
 * real, against a simulated radio, in `packages/core`; what matters here is
 * what this module asks of it and what it writes down afterwards.
 */
import React from 'react';
import { fireEvent, render } from '@testing-library/react-native';
import { ConnectionState } from '@airlink/core';
import { AirLinkClient } from '../src/client/AirLinkClient.js';
import { ThemeProvider } from '../src/ui/index.js';
import { Composer } from '../src/screens/chat/Composer.js';
import { chatCopy } from '../src/screens/chat/chatStrings.js';
import { attachmentCenterFor, choosePhoto, voiceAttachment } from '../src/screens/chat/attachments.js';
import { encodeAttachment } from '@airlink/core';
import { MessageBubble } from '../src/screens/chat/MessageBubble.js';

interface SentFile {
  peerKey: string;
  path: string;
  filename: string;
  mimeType: string;
  fileBytes: number;
}

/** Jest only lets a module factory see variables whose names start with `mock`. */
const mockSent: SentFile[] = [];
/** Attachment descriptors the chat protocol was asked to carry to the peer. */
const mockAnnounced: {
  fileId: string;
  name: string;
  mimeType: string;
  byteLength: number;
  width?: number;
  height?: number;
  durationMs?: number;
}[] = [];
let mockSendFails = false;
let mockPickerOptions: Record<string, unknown> = {};
let mockPickerResponse: {
  didCancel?: boolean;
  errorCode?: string;
  assets?: {
    uri?: string;
    fileName?: string;
    type?: string;
    fileSize?: number;
    width?: number;
    height?: number;
  }[];
} = { didCancel: true };

jest.mock('../src/screens/share/transferCenter.js', () => ({
  transferCenterFor: () => ({
    subscribe: () => (): void => undefined,
    get: () => undefined,
    send: async (input: SentFile): Promise<string> => {
      if (mockSendFails) throw new Error('no session');
      mockSent.push(input);
      return `transfer-${mockSent.length}`;
    },
  }),
}));

jest.mock('react-native-image-picker', () => ({
  launchImageLibrary: async (options: Record<string, unknown>) => {
    mockPickerOptions = options;
    return mockPickerResponse;
  },
}));

/** A peer id is an Ed25519 fingerprint; any stable hex string will do here. */
const THEM = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

async function bootClient(): Promise<AirLinkClient> {
  const client = new AirLinkClient({ appVersion: '0.1.0', platform: 'ios', deviceModel: 'test' });
  await client.load();
  await client.createProfile('Ada', null);
  client.db.peers.upsertSeen({
    peerId: THEM,
    displayName: 'Mallory',
    identityPublic: new Uint8Array(32).fill(7),
    now: 1,
  });
  return client;
}

/**
 * A live session, without a radio.
 *
 * `AirLinkClient.connect` dials a native transport and there is none in Node,
 * so the handle is placed in the client's map directly - the same scaffolding
 * the game invitation tests use. Everything the attachment centre reads from a
 * handle is here: the key it sends by, and whether the session is up.
 */
function connect(client: AirLinkClient): void {
  const off = (): (() => void) => (): void => undefined;
  const handle = {
    key: THEM,
    peerId: THEM,
    session: {
      state: ConnectionState.CONNECTED,
      peerId: THEM,
      capabilities: { displayName: 'Mallory' },
      events: { on: off },
    },
    // The chat centre attaches to every connected peer the moment it is built,
    // so a handle has to answer the protocol surface it listens on - even in a
    // test that never sends a word of text.
    chat: {
      events: { on: off },
      outboxSnapshot: () => [],
      restoreOutbox: () => undefined,
      markRead: () => undefined,
      send: (draft: { attachments?: typeof mockAnnounced }) => {
        for (const attachment of draft.attachments ?? []) mockAnnounced.push(attachment);
        return { message: { id: 'wire-1' } };
      },
    },
  };
  (client as unknown as { peers: Map<string, unknown> }).peers.set(THEM, handle);
}

/** Let the centre's `deliver` run to the end: it awaits the transfer's offer. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  await new Promise<void>((resolve) => setImmediate(() => resolve()));
}

function rowOf(client: AirLinkClient, rowId: string | null): NonNullable<ReturnType<AirLinkClient['db']['messages']['get']>> {
  if (!rowId) throw new Error('no message row was written');
  const row = client.db.messages.get(rowId);
  if (!row) throw new Error(`message ${rowId} is not in the database`);
  return row;
}

beforeEach(() => {
  mockSent.length = 0;
  mockAnnounced.length = 0;
  mockSendFails = false;
  mockPickerOptions = {};
  mockPickerResponse = { didCancel: true };
});

afterEach(() => {
  globalThis.__airlinkNativeTest?.clearCalls();
  globalThis.__airlinkSqliteTest?.clear();
  globalThis.__airlinkKeychainTest?.clear();
});

const A_PHOTO = {
  assets: [
    {
      uri: 'file:///tmp/airlink-test/photo.jpg',
      fileName: 'photo.jpg',
      type: 'image/jpeg',
      fileSize: 240_000,
      width: 1280,
      height: 960,
    },
  ],
};

test('a picked photo is asked for small, and lands as an image row with a file', async () => {
  const client = await bootClient();
  connect(client);
  mockPickerResponse = A_PHOTO;

  const choice = await choosePhoto();
  expect(choice.status).toBe('picked');
  if (choice.status !== 'picked') return;

  // The whole reason this module does not simply reuse the Share picker: at
  // Bluetooth speed a full-size photo is minutes. The request has to be for a
  // downscaled one, and the picker does that resize natively.
  expect(mockPickerOptions.maxWidth).toBe(1280);
  expect(mockPickerOptions.maxHeight).toBe(1280);
  expect(mockPickerOptions.quality).toBe(0.7);
  expect(mockPickerOptions.mediaType).toBe('photo');

  const centre = attachmentCenterFor(client);
  const rowId = centre.send({
    peerId: THEM,
    displayName: 'Mallory',
    attachment: choice.attachment,
    replyToRowId: null,
  });

  const row = rowOf(client, rowId);
  expect(row.kind).toBe('image');
  expect(row.fileId).not.toBeNull();

  const fileId = row.fileId;
  if (!fileId) throw new Error('an image row without a file is not a photo');
  const file = client.db.files.get(fileId);
  // The local copy is what lets our own bubble draw the picture immediately,
  // before a single byte has crossed.
  expect(file?.localPath).toBe('/tmp/airlink-test/photo.jpg');
  expect(file?.mimeType).toBe('image/jpeg');
});

test('the file is handed to the transfer layer, once, and the tick moves', async () => {
  const client = await bootClient();
  connect(client);
  mockPickerResponse = A_PHOTO;
  const choice = await choosePhoto();
  if (choice.status !== 'picked') throw new Error('the picker should have returned a photo');

  const rowId = attachmentCenterFor(client).send({
    peerId: THEM,
    displayName: 'Mallory',
    attachment: choice.attachment,
    replyToRowId: null,
  });
  await settle();

  expect(mockSent).toHaveLength(1);
  expect(mockSent[0]?.filename).toBe('photo.jpg');
  expect(mockSent[0]?.peerKey).toBe(THEM);
  expect(rowOf(client, rowId).status).toBe('sent');

  // The peer is also TOLD, over the chat protocol, that these bytes belong in
  // the conversation - otherwise the photo arrives as a bare file offer in the
  // Share tab and their side of the chat shows nothing at all. The descriptor
  // names the transfer, because that is the id both phones know the file by.
  expect(mockAnnounced).toHaveLength(1);
  expect(mockAnnounced[0]?.fileId).toBe('transfer-1');
  expect(mockAnnounced[0]?.mimeType).toBe('image/jpeg');
  expect(mockAnnounced[0]?.byteLength).toBe(240_000);
});

test('a recording lands as a voice row that knows how long it is', async () => {
  const client = await bootClient();
  connect(client);

  const rowId = attachmentCenterFor(client).send({
    peerId: THEM,
    displayName: 'Mallory',
    attachment: voiceAttachment({ path: '/tmp/airlink-test/voice.m4a', durationMs: 4200, sizeBytes: 9000 }),
    replyToRowId: null,
  });
  await settle();

  const row = rowOf(client, rowId);
  expect(row.kind).toBe('voice');
  const fileId = row.fileId;
  if (!fileId) throw new Error('a voice row without a file cannot be played');
  const file = client.db.files.get(fileId);
  // The duration is what the playback bubble draws before anything is played,
  // so losing it here would mean a voice note with no length on it.
  expect(file?.durationMs).toBe(4200);
  expect(file?.mimeType).toBe('audio/mp4');
  expect(mockSent).toHaveLength(1);
});

/**
 * THE BUG THIS EXISTS FOR. On two real iPhones, text and photos crossed and
 * voice notes did not: the sender's bubble went red with "They never answered"
 * after two minutes, and the other phone showed nothing at all.
 *
 * `AVAudioRecorder.currentTime` is seconds as a Double, so the duration in
 * milliseconds arrived as 3472.5623582766438. Nothing on this side minded. The
 * RECEIVER's decoder requires an integer, threw, and dropped the entire chat
 * message - and that message is what calls `TransferCenter.expect`, so the
 * file was never auto-accepted and timed out unanswered.
 *
 * Every test here used to pass a whole number, stubbing exactly the thing that
 * broke. This one asserts the descriptor the peer would actually receive,
 * through the real encoder rather than the double.
 */
test('a duration measured in fractions of a millisecond still crosses the wire', async () => {
  const client = await bootClient();
  connect(client);

  const rowId = attachmentCenterFor(client).send({
    peerId: THEM,
    displayName: 'Mallory',
    attachment: voiceAttachment({
      path: '/tmp/airlink-test/voice.m4a',
      durationMs: 3472.5623582766438,
      sizeBytes: 8412,
    }),
    replyToRowId: null,
  });
  await settle();

  const fileId = rowOf(client, rowId).fileId;
  if (!fileId) throw new Error('a voice row without a file cannot be played');
  expect(client.db.files.get(fileId)?.durationMs).toBe(3473);

  const announced = mockAnnounced[0];
  expect(announced?.durationMs).toBe(3473);
  // The assertion that matters: the peer's decoder is the one that rejected
  // this, and the encoder now shares its limits - so encoding is the same
  // check, run on the side that can still do something about it.
  expect(() => encodeAttachment({
    fileId: announced?.fileId ?? '',
    name: announced?.name ?? '',
    mimeType: announced?.mimeType ?? '',
    byteLength: announced?.byteLength ?? 0,
    durationMs: announced?.durationMs,
  })).not.toThrow();
});

test('a send that cannot happen leaves a failed row, not a hole in the conversation', async () => {
  const client = await bootClient();
  connect(client);
  mockSendFails = true;

  const rowId = attachmentCenterFor(client).send({
    peerId: THEM,
    displayName: 'Mallory',
    attachment: voiceAttachment({ path: '/tmp/airlink-test/voice.m4a', durationMs: 2000, sizeBytes: 4000 }),
    replyToRowId: null,
  });
  await settle();

  // Visible and retryable: the row is still there, it is red rather than
  // missing, and the file behind it is still on this phone to send again.
  const row = rowOf(client, rowId);
  expect(row.status).toBe('failed');
  expect(row.fileId).not.toBeNull();
});

/**
 * Out of range is the normal state of this app, not a failure.
 *
 * A photo composed with nobody connected has to behave exactly like a text
 * message composed then: stored, queued, and sent when a link comes up. A
 * `failed` row here would be the app calling an ordinary Tuesday a problem.
 */
test('a photo sent to nobody waits as pending rather than failing', async () => {
  const client = await bootClient();
  mockPickerResponse = A_PHOTO;
  const choice = await choosePhoto();
  if (choice.status !== 'picked') throw new Error('the picker should have returned a photo');

  const rowId = attachmentCenterFor(client).send({
    peerId: THEM,
    displayName: 'Mallory',
    attachment: choice.attachment,
    replyToRowId: null,
  });
  await settle();

  expect(rowOf(client, rowId).status).toBe('pending');
  expect(mockSent).toHaveLength(0);
});

/**
 * The bubble has to draw before the bytes arrive.
 *
 * A voice note that has only been announced - the row is here, the file is not -
 * still gets its length and its control, greyed out. The alternative, an empty
 * bubble that becomes a player later, is indistinguishable from a bug.
 */
test('a voice message draws a play control from its row alone', async () => {
  const client = await bootClient();
  connect(client);
  const centre = attachmentCenterFor(client);
  const rowId = centre.send({
    peerId: THEM,
    displayName: 'Mallory',
    attachment: voiceAttachment({ path: '/tmp/airlink-test/voice.m4a', durationMs: 7000, sizeBytes: 15_000 }),
    replyToRowId: null,
  });
  const message = rowOf(client, rowId);
  const fileId = message.fileId;
  if (!fileId) throw new Error('a voice row without a file cannot be played');
  const file = client.db.files.get(fileId);
  if (!file) throw new Error('the file row should have been written beside the message');

  const view = await render(
    <ThemeProvider>
      <MessageBubble
        row={{
          message,
          mine: true,
          continuesAbove: false,
          continuesBelow: false,
          daySeparator: null,
          reactions: [],
          replyTo: null,
          isNewestOutgoing: true,
          attachment: {
            name: file.name,
            sizeBytes: file.sizeBytes,
            localPath: file.localPath,
            mimeType: file.mimeType,
            durationMs: file.durationMs,
          },
        }}
        peerName="Mallory"
        sendProgress={null}
        onLongPress={() => undefined}
        onRetry={() => undefined}
        onToggleReaction={() => undefined}
      />
    </ThemeProvider>,
  );

  expect(view.getByLabelText(chatCopy.playVoice)).toBeTruthy();
  expect(view.getByLabelText(chatCopy.voiceOf('0:07'))).toBeTruthy();
});

test('a denied Photos permission says so instead of failing silently', async () => {
  mockPickerResponse = { errorCode: 'permission' };
  const choice = await choosePhoto();
  expect(choice.status).toBe('failed');
  if (choice.status !== 'failed') return;
  expect(choice.message).toBe(chatCopy.photoDenied);
});

/**
 * There is no recorder under Jest, and there is none in an older build either.
 *
 * The composer has to survive both: the microphone button must still be there,
 * still be pressable, and say what is wrong rather than throwing on a method
 * that does not exist.
 */
test('the composer degrades when the native recorder is absent', async () => {
  const onNotice = jest.fn();
  const view = await render(
    <ThemeProvider>
      <Composer
        value=""
        onChangeText={() => undefined}
        onSend={() => undefined}
        onAttach={() => undefined}
        onNotice={onNotice}
        replyTo={null}
        peerName="Mallory"
        onCancelReply={() => undefined}
      />
    </ThemeProvider>,
  );

  fireEvent.press(view.getByLabelText(chatCopy.recordLabel));

  expect(onNotice).toHaveBeenCalledWith(chatCopy.voiceUnavailable);
  // Still a composer: the text box is not disabled by a missing microphone.
  expect(view.getByLabelText(chatCopy.composerLabel)).toBeTruthy();
});
