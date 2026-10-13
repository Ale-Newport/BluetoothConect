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
import {
  attachmentCenterFor,
  chooseFile,
  choosePhoto,
  takePhoto,
  voiceAttachment,
} from '../src/screens/chat/attachments.js';
import { kindForMime } from '../src/screens/chat/chatCenter.js';
import { currentPath, rebaseToContainer } from '../src/screens/share/fileStore.js';
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
let mockAnnounceFails = false;
let mockPickerOptions: Record<string, unknown> = {};
let mockCameraOptions: Record<string, unknown> = {};
let mockDocumentResult:
  | { status: 'cancelled' }
  | { status: 'failed'; message: string }
  | {
      status: 'picked';
      file: { path: string; filename: string; mimeType: string; fileBytes: number; previewUri: string | null };
    } = { status: 'cancelled' };
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
  launchCamera: async (options: Record<string, unknown>) => {
    mockCameraOptions = options;
    return mockPickerResponse;
  },
}));

/** What the Files app hands back. The real picker is the Share tab's and has its own tests. */
jest.mock('../src/screens/share/picker.js', () => ({
  pickDocument: async () => mockDocumentResult,
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
        if (mockAnnounceFails) throw new Error('the chat protocol refused the announcement');
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
  mockAnnounceFails = false;
  mockPickerOptions = {};
  mockCameraOptions = {};
  mockDocumentResult = { status: 'cancelled' };
  mockPickerResponse = { didCancel: true };
});

afterEach(() => {
  globalThis.__airlinkNativeTest?.clearCalls();
  globalThis.__airlinkFsTest?.clear();
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
  // before a single byte has crossed - and it is OUR copy, in this app's own
  // storage, not the picker's temporary one (see the test on that below).
  expect(file?.localPath).toMatch(/^\/tmp\/airlink-test\/airlink\/sent\/[^/]+\/photo\.jpg$/);
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

/**
 * The guarantee behind the voice-note fix: an attachment that the other phone
 * could not read never leaves this one.
 *
 * Before, a descriptor the peer would reject was sent anyway, the announcement
 * was swallowed, the row said "sent", and two minutes later "They never
 * answered" - with the bytes sitting as a bare offer in a Share tab nobody was
 * looking at. These two tests pin the two ways that could still happen.
 */
test('a descriptor the peer could not read fails BEFORE any byte is sent', async () => {
  const client = await bootClient();
  connect(client);

  const rowId = attachmentCenterFor(client).send({
    peerId: THEM,
    displayName: 'Mallory',
    // 1080.5 pixels wide: not a thing a decoder accepts, and not a thing the
    // picker produces today - which is the point of a guard.
    attachment: {
      kind: 'image',
      path: '/tmp/airlink-test/odd.jpg',
      filename: 'odd.jpg',
      mimeType: 'image/jpeg',
      fileBytes: 120_000,
      width: 1080.5,
      height: 1920,
      durationMs: null,
    },
    replyToRowId: null,
  });
  await settle();

  expect(rowOf(client, rowId).status).toBe('failed');
  // Nothing moved: no transfer was started, nothing was announced.
  expect(mockSent).toHaveLength(0);
  expect(mockAnnounced).toHaveLength(0);
});

test('an announcement that fails after the bytes started leaves a red row, not a sent one', async () => {
  const client = await bootClient();
  connect(client);
  mockAnnounceFails = true;

  const rowId = attachmentCenterFor(client).send({
    peerId: THEM,
    displayName: 'Mallory',
    attachment: voiceAttachment({ path: '/tmp/airlink-test/voice.m4a', durationMs: 4200, sizeBytes: 9000 }),
    replyToRowId: null,
  });
  await settle();

  // The bytes did go out - there is nothing to take back - but the row must not
  // claim success for a message the other phone was never given.
  expect(mockSent).toHaveLength(1);
  expect(rowOf(client, rowId).status).toBe('failed');
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

/**
 * The camera button. A photo taken on the spot has to be exactly the photo
 * `choosePhoto` produces - the same size, the same row, the same transfer - or
 * the bar would have two kinds of picture that behave differently over a slow
 * link. The things that are NOT the same are the reasons it can fail.
 */
test('a photo from the camera is asked for small, is not saved to the roll, and lands as an image row', async () => {
  const client = await bootClient();
  connect(client);
  mockPickerResponse = A_PHOTO;

  const choice = await takePhoto();
  expect(choice.status).toBe('picked');
  if (choice.status !== 'picked') return;

  expect(mockCameraOptions.maxWidth).toBe(1280);
  expect(mockCameraOptions.maxHeight).toBe(1280);
  expect(mockCameraOptions.quality).toBe(0.7);
  expect(mockCameraOptions.mediaType).toBe('photo');
  // Taking a picture to send is not asking for it to be kept: saving would add
  // a second permission prompt on top of the camera's.
  expect(mockCameraOptions.saveToPhotos).toBe(false);

  const rowId = attachmentCenterFor(client).send({
    peerId: THEM,
    displayName: 'Mallory',
    attachment: choice.attachment,
    replyToRowId: null,
  });
  await settle();

  expect(rowOf(client, rowId).kind).toBe('image');
  expect(mockSent).toHaveLength(1);
  expect(mockAnnounced).toHaveLength(1);
  expect(mockAnnounced[0]?.mimeType).toBe('image/jpeg');
});

test('the camera says why it did not take a photo, and a cancel says nothing', async () => {
  mockPickerResponse = { errorCode: 'permission' };
  expect(await takePhoto()).toEqual({ status: 'failed', message: chatCopy.cameraDenied });

  // The simulator, and any device whose camera is busy or missing.
  mockPickerResponse = { errorCode: 'camera_unavailable' };
  expect(await takePhoto()).toEqual({ status: 'failed', message: chatCopy.cameraUnavailable });

  mockPickerResponse = { errorCode: 'others' };
  expect(await takePhoto()).toEqual({ status: 'failed', message: chatCopy.photoFailed });

  mockPickerResponse = { didCancel: true };
  expect(await takePhoto()).toEqual({ status: 'cancelled' });
});

/**
 * The plus button's second row: any file, as a message. It travels the same
 * road as a photo - a row with a file behind it, a transfer, a chat descriptor
 * - and the only decision this module makes about it is which bubble it gets.
 */
test('a file from the Files app lands as a file row, is handed to the transfer layer once, and is announced', async () => {
  const client = await bootClient();
  connect(client);
  mockDocumentResult = {
    status: 'picked',
    file: {
      path: '/tmp/airlink-test/menu.pdf',
      filename: 'menu.pdf',
      mimeType: 'application/pdf',
      fileBytes: 52_000,
      previewUri: null,
    },
  };

  const choice = await chooseFile();
  expect(choice.status).toBe('picked');
  if (choice.status !== 'picked') return;
  expect(choice.attachment.kind).toBe('file');

  const rowId = attachmentCenterFor(client).send({
    peerId: THEM,
    displayName: 'Mallory',
    attachment: choice.attachment,
    replyToRowId: null,
  });
  await settle();

  const row = rowOf(client, rowId);
  expect(row.kind).toBe('file');
  expect(row.body).toBeNull();
  const fileId = row.fileId;
  if (!fileId) throw new Error('a file row without a file is not a file');
  expect(client.db.files.get(fileId)?.localPath).toMatch(/^\/tmp\/airlink-test\/airlink\/sent\/[^/]+\/menu\.pdf$/);

  expect(mockSent).toHaveLength(1);
  expect(mockSent[0]).toMatchObject({ filename: 'menu.pdf', mimeType: 'application/pdf', fileBytes: 52_000 });
  expect(mockAnnounced).toHaveLength(1);
  expect(mockAnnounced[0]?.name).toBe('menu.pdf');
  expect(mockAnnounced[0]?.byteLength).toBe(52_000);
  // A file has no dimensions and no length in time, and says neither.
  expect(mockAnnounced[0]?.width).toBeUndefined();
  expect(mockAnnounced[0]?.durationMs).toBeUndefined();
  expect(rowOf(client, rowId).status).toBe('sent');
});

test('a file gets the bubble the other phone will give it', async () => {
  // The receiving side decides from the type alone (`kindForMime`). If the
  // sender chose differently, the same file would be a paperclip on one phone
  // and a player on the other.
  for (const [mimeType, filename] of [
    ['image/png', 'diagram.png'],
    ['image/heic', 'IMG_0001.heic'],
    ['audio/mp4', 'song.m4a'],
    ['audio/mpeg', 'song.mp3'],
    ['application/pdf', 'menu.pdf'],
    ['video/quicktime', 'clip.mov'],
    ['application/octet-stream', 'data.bin'],
  ] as const) {
    mockDocumentResult = {
      status: 'picked',
      file: { path: `/tmp/airlink-test/${filename}`, filename, mimeType, fileBytes: 1_000, previewUri: null },
    };
    const choice = await chooseFile();
    if (choice.status !== 'picked') throw new Error(`${filename} should have been picked`);
    expect(choice.attachment.kind).toBe(kindForMime(mimeType));
  }
});

test('a file that is empty, too large, unreadable or not chosen is stopped before anything is queued', async () => {
  const file = { path: '/tmp/airlink-test/x.bin', filename: 'x.bin', mimeType: 'application/octet-stream', previewUri: null };

  mockDocumentResult = { status: 'picked', file: { ...file, fileBytes: 0 } };
  expect(await chooseFile()).toEqual({ status: 'failed', message: chatCopy.fileFailed });

  mockDocumentResult = { status: 'picked', file: { ...file, fileBytes: 256 * 1024 * 1024 + 1 } };
  expect(await chooseFile()).toEqual({ status: 'failed', message: chatCopy.fileTooLarge });

  // The picker's own wording is the Share tab's; the chat says its own.
  mockDocumentResult = { status: 'failed', message: 'anything' };
  expect(await chooseFile()).toEqual({ status: 'failed', message: chatCopy.fileFailed });

  mockDocumentResult = { status: 'cancelled' };
  expect(await chooseFile()).toEqual({ status: 'cancelled' });
});

/**
 * WHERE A PICKED FILE LIVES.
 *
 * The photo picker writes into the temporary folder, which iOS empties whenever
 * the app is not running or the phone is short of space. A photo that is only
 * there is a photo that, after the app is reopened, is a grey square in the
 * sender's own chat - and a photo queued for a friend who is out of range is a
 * photo that can no longer be sent. So every picked file is moved into this
 * app's own storage first, and the row, the queue and the bubble all point at
 * THAT copy.
 */
test('a picked photo, a camera photo and a file are all moved out of the temporary folder', async () => {
  const fsTest = globalThis.__airlinkFsTest;
  if (!fsTest) throw new Error('the file system double is missing');

  mockPickerResponse = A_PHOTO;
  const library = await choosePhoto();
  const camera = await takePhoto();
  mockDocumentResult = {
    status: 'picked',
    file: { path: '/tmp/airlink-test-cache/menu.pdf', filename: 'menu.pdf', mimeType: 'application/pdf', fileBytes: 52_000, previewUri: null },
  };
  const file = await chooseFile();

  for (const choice of [library, camera, file]) {
    if (choice.status !== 'picked') throw new Error('every one of these should have been picked');
    // Nothing queued may point at the temporary original.
    expect(choice.attachment.path).not.toBe('/tmp/airlink-test/photo.jpg');
    expect(choice.attachment.path).not.toBe('/tmp/airlink-test-cache/menu.pdf');
    expect(choice.attachment.path).toContain('/airlink/sent/');
  }

  const copies = fsTest.copies();
  expect(copies).toHaveLength(3);
  expect(copies[0]).toMatchObject({ from: '/tmp/airlink-test/photo.jpg' });
  expect(copies[2]).toMatchObject({ from: '/tmp/airlink-test-cache/menu.pdf' });
  // The temporary original is ours to remove: it is the picker's copy, never
  // the user's own file.
  expect(fsTest.unlinked()).toEqual(
    expect.arrayContaining(['/tmp/airlink-test/photo.jpg', '/tmp/airlink-test-cache/menu.pdf']),
  );
});

test('two photos with the same name do not land on each other', async () => {
  mockPickerResponse = A_PHOTO;
  const first = await choosePhoto();
  const second = await choosePhoto();
  if (first.status !== 'picked' || second.status !== 'picked') throw new Error('both should have been picked');
  expect(first.attachment.path).not.toBe(second.attachment.path);
});

test('a photo or a file that cannot be kept is refused with a reason, not queued pointing at nothing', async () => {
  globalThis.__airlinkFsTest?.failCopies(true);

  mockPickerResponse = A_PHOTO;
  expect(await choosePhoto()).toEqual({ status: 'failed', message: chatCopy.photoFailed });
  expect(await takePhoto()).toEqual({ status: 'failed', message: chatCopy.photoFailed });

  mockDocumentResult = {
    status: 'picked',
    file: { path: '/tmp/airlink-test-cache/menu.pdf', filename: 'menu.pdf', mimeType: 'application/pdf', fileBytes: 52_000, previewUri: null },
  };
  expect(await chooseFile()).toEqual({ status: 'failed', message: chatCopy.fileFailed });
  // Failing to copy must not delete the only copy there is.
  expect(globalThis.__airlinkFsTest?.unlinked()).toEqual([]);
});

/**
 * WHERE A STORED PATH POINTS AFTER AN UPDATE.
 *
 * The database remembers an attachment's location as an absolute path, and on
 * iOS that path contains the data container's UUID, which changes when the app
 * is reinstalled or updated. The files come across; their folder's name does
 * not. Found when a build was reinstalled over another and every earlier photo,
 * on both phones, drew as a grey square although the files were on disk.
 */
describe('a stored path after the container has been renamed', () => {
  const OLD = '/var/mobile/Containers/Data/Application/15CBF2EB-1D07-4A97-8859-075C0D4BEA0C';
  const NEW = '/var/mobile/Containers/Data/Application/F1548F1B-2BC8-47D8-85BA-5B233ECE3BEF';

  test('is pointed at the container this install has now', () => {
    expect(rebaseToContainer(`${OLD}/Documents/airlink/received/ABC/photo.jpg`, `${NEW}/Documents`)).toBe(
      `${NEW}/Documents/airlink/received/ABC/photo.jpg`,
    );
    // tmp and Library are in the same container as Documents.
    expect(rebaseToContainer(`${OLD}/tmp/photo.jpg`, `${NEW}/Documents`)).toBe(`${NEW}/tmp/photo.jpg`);
    expect(rebaseToContainer(`${OLD}/Library/Application Support/AirLinkVoice/v.m4a`, `${NEW}/Documents`)).toBe(
      `${NEW}/Library/Application Support/AirLinkVoice/v.m4a`,
    );
  });

  test('works the same inside a simulator, whose paths have a long prefix', () => {
    const sim = '/Users/a/Library/Developer/CoreSimulator/Devices/782957A3-CA8F-4F00-9A33-79AF11083F58/data/Containers/Data/Application';
    expect(
      rebaseToContainer(
        `${sim}/15CBF2EB-1D07-4A97-8859-075C0D4BEA0C/tmp/a.jpg`,
        `${sim}/F1548F1B-2BC8-47D8-85BA-5B233ECE3BEF/Documents`,
      ),
    ).toBe(`${sim}/F1548F1B-2BC8-47D8-85BA-5B233ECE3BEF/tmp/a.jpg`);
  });

  test('leaves a path that is already current, or has no container in it, exactly as it is', () => {
    const current = `${NEW}/Documents/airlink/sent/X/a.jpg`;
    expect(rebaseToContainer(current, `${NEW}/Documents`)).toBe(current);
    // Android and the test environment have no container UUID to replace.
    expect(rebaseToContainer('/data/user/0/com.airlink/files/airlink/a.jpg', '/data/user/0/com.airlink/files')).toBe(
      '/data/user/0/com.airlink/files/airlink/a.jpg',
    );
    expect(rebaseToContainer('/tmp/airlink-test/a.jpg', '/tmp/airlink-test')).toBe('/tmp/airlink-test/a.jpg');
    // A document directory that is not in a container cannot rebase anything.
    expect(rebaseToContainer(`${OLD}/tmp/a.jpg`, '/somewhere/else')).toBe(`${OLD}/tmp/a.jpg`);
  });

  test('nothing stored stays nothing', () => {
    expect(currentPath(null)).toBeNull();
  });
});
