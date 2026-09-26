import { launchImageLibrary } from 'react-native-image-picker';
import {
  ConnectionState,
  TransferState,
  isSafeFilename,
  isTerminalState,
  newSortableId,
  systemRandom,
} from '@airlink/core';
import type { MessageKind, StoredFile } from '@airlink/db';
import type { AirLinkClient, PeerHandle } from '../../client/AirLinkClient.js';
import type { Recording } from '../../native/audio.js';
import { measureFile, pathFromUri } from '../share/fileStore.js';
import { transferCenterFor, type TransferCenter } from '../share/transferCenter.js';
import { LOCAL_SENDER, chatCenterFor, directConversationId } from './chatCenter.js';
import { chatCopy } from './chatStrings.js';

/**
 * Photos and voice notes in a conversation.
 *
 * A message with a file on it is two things at once, and this module is the
 * only place that knows they are the same thing: a row in `messages` carrying a
 * `file_id`, which is what the bubble draws, and a transfer run by
 * `TransferCenter`, which is what actually moves the bytes. Neither half is
 * reimplemented here - the chunking, hashing, resuming and verifying all belong
 * to `@airlink/core/files`, and the conversation belongs to `ChatCenter`.
 *
 * The rule the whole file is shaped by is the same one the composer lives by:
 * **a photo can be sent to someone who is not there.** The row is written
 * immediately at `pending`, the bubble appears with the picture already in it,
 * and the bytes go when a link comes up. That is why this class listens to
 * sessions rather than being driven only by a button: it is the outbox for
 * attachments, in the same sense that the chat protocol's queue is the outbox
 * for text. `ChatCenter.handToProtocol` deliberately steps over bodyless rows
 * so that the two never send the same thing twice.
 */

/**
 * How big a photo is allowed to be by the time it leaves.
 *
 * The link is often Bluetooth LE at 20-40 KB/s. A 12-megapixel iPhone photo is
 * around 4 MB, which is between two and three and a half MINUTES of staring at
 * a progress bar; nobody sends a second one. A 1280px long edge at JPEG 0.7
 * lands between 200 and 400 KB - eight to twenty seconds - and is still sharp
 * on any phone screen, which is where it is going to be looked at.
 *
 * The resize happens inside the picker's native code, so the JS thread never
 * sees a decoded bitmap and the app does not freeze while it happens. That is
 * also why this does not call `pickPhoto` from the Share module: that one
 * offers video as well, cannot downscale, and folds a denied Photos permission
 * into a generic "could not read the file", which is the one failure a person
 * can actually do something about.
 */
const PHOTO_MAX_EDGE = 1280;
const PHOTO_QUALITY = 0.7;

/** Anything the recorder gives back shorter than this was a mis-tap. */
export const MIN_VOICE_MS = 700;

/**
 * Where a queued attachment is picked up again.
 *
 * A transfer only exists while there is a session, so a photo composed out of
 * range has nothing to hand it to. It waits as a `pending` row, exactly like a
 * queued text message, and this is how long the centre waits after a link comes
 * up before flushing: long enough for the handshake to have produced a peer id,
 * short enough that the user does not notice.
 */
const FLUSH_DELAY_MS = 400;

/** A file on this phone that is about to become a message. */
export interface OutgoingAttachment {
  readonly kind: Extract<MessageKind, 'image' | 'file' | 'voice'>;
  /** A real path inside this app's sandbox, readable for as long as we need. */
  readonly path: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly fileBytes: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly durationMs: number | null;
}

export type PhotoChoice =
  | { readonly status: 'picked'; readonly attachment: OutgoingAttachment }
  | { readonly status: 'cancelled' }
  | { readonly status: 'failed'; readonly message: string };

/**
 * A name the protocol will accept.
 *
 * `isSafeFilename` is the same check the receiving side applies, so a name the
 * peer would reject is replaced here rather than after the user has pressed
 * send. The generated one is deliberately dull and unique.
 */
function usableName(candidate: string | null | undefined, extension: string): string {
  const trimmed = (candidate ?? '').trim();
  if (trimmed.length > 0 && isSafeFilename(trimmed)) return trimmed;
  return `photo-${Date.now()}${extension}`;
}

/**
 * Choose a photo, already cut down to something a slow link can carry.
 *
 * Returns rather than throws, because every outcome here is ordinary: the user
 * changed their mind, the library is empty, or Photos is switched off for this
 * app - and the last of those has to be said out loud, since iOS asks only once
 * and after that the answer lives in Settings.
 */
export async function choosePhoto(): Promise<PhotoChoice> {
  let response;
  try {
    response = await launchImageLibrary({
      mediaType: 'photo',
      selectionLimit: 1,
      maxWidth: PHOTO_MAX_EDGE,
      maxHeight: PHOTO_MAX_EDGE,
      quality: PHOTO_QUALITY,
    });
  } catch {
    return { status: 'failed', message: chatCopy.photoFailed };
  }

  if (response.didCancel) return { status: 'cancelled' };
  if (response.errorCode === 'permission') return { status: 'failed', message: chatCopy.photoDenied };
  if (response.errorCode) return { status: 'failed', message: chatCopy.photoFailed };

  const asset = response.assets?.[0];
  if (!asset?.uri) return { status: 'failed', message: chatCopy.photoFailed };

  // The picker writes the resized copy into this app's cache and hands back its
  // URI, so this path stays readable long after the picker has gone - which
  // matters, because the transfer may still be reading it minutes later.
  const path = pathFromUri(asset.uri);
  const mimeType = asset.type ?? 'image/jpeg';
  const filename = usableName(asset.fileName, mimeType === 'image/png' ? '.png' : '.jpg');

  let fileBytes = asset.fileSize ?? 0;
  if (fileBytes <= 0) {
    // Android does not always report a size for a re-encoded copy. Measuring is
    // cheap and the transfer cannot start without a length.
    try {
      fileBytes = await measureFile(path);
    } catch {
      return { status: 'failed', message: chatCopy.photoFailed };
    }
  }

  return {
    status: 'picked',
    attachment: {
      kind: 'image',
      path,
      filename,
      mimeType,
      fileBytes,
      width: asset.width ?? null,
      height: asset.height ?? null,
      durationMs: null,
    },
  };
}

/**
 * A finished recording, as an attachment.
 *
 * The recorder names its own file in a scratch directory; the name that travels
 * is generated here so the peer sees something meaningful and never sees a path
 * from this phone.
 */
export function voiceAttachment(recording: Recording): OutgoingAttachment {
  return {
    kind: 'voice',
    path: recording.path,
    filename: `voice-${Date.now()}.m4a`,
    // AAC in an MP4 container, which is what both platforms record natively and
    // what both can play back without a decoder of ours.
    mimeType: 'audio/mp4',
    fileBytes: recording.sizeBytes,
    width: null,
    height: null,
    // Rounded again here, and deliberately. `audio.stopRecording` already
    // rounds what the iOS recorder reports, but this function accepts any
    // `Recording` - a future Android module, a resumed draft, a test double -
    // and a fractional duration does not fail here. It fails on the OTHER
    // phone, where the decoder refuses a non-integer and drops the whole
    // message that vouches for the file.
    durationMs: Math.round(recording.durationMs),
  };
}

/**
 * The outbox for attachments.
 *
 * One per client, like the chat centre and the transfer centre, because a photo
 * sent from a conversation has to keep going while the user is in a game and
 * has to survive the screen being closed.
 */
export class AttachmentCenter {
  private readonly transfers: TransferCenter;
  /** Transfer id -> the message row waiting on it. */
  private readonly inFlight = new Map<string, string>();
  /** Message rows currently being handed over, so no session flushes twice. */
  private readonly starting = new Set<string>();
  /** Message row -> percent, for the line under the bubble. */
  private readonly percents = new Map<string, number>();
  private readonly offs: (() => void)[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly client: AirLinkClient) {
    this.transfers = transferCenterFor(client);
    this.offs.push(this.transfers.subscribe(() => this.onTransfersChanged()));
    this.offs.push(
      this.client.events.on('connectionChanged', ({ peerKey, state }) => {
        if (state !== ConnectionState.CONNECTED) return;
        // Not immediately: CONNECTED arrives before the handshake has finished
        // naming the peer, and a flush needs the peer id to find the
        // conversation the queued rows are in.
        this.scheduleFlush(peerKey);
      }),
    );
  }

  // -- sending ---------------------------------------------------------------

  /**
   * Write the bubble, then start the bytes.
   *
   * Returns the new message row's id, or null when there is no conversation to
   * put it in - which means this device has never authenticated this person,
   * the same single reason `ChatCenter.send` refuses a text.
   *
   * Never returns null for being out of range. The row is stored either way.
   */
  send(input: {
    peerId: string;
    displayName: string;
    attachment: OutgoingAttachment;
    replyToRowId: string | null;
  }): string | null {
    const centre = chatCenterFor(this.client);
    const conversationId = centre.conversationFor(input.peerId, input.displayName);
    if (!conversationId) return null;

    const now = Date.now();
    const { attachment } = input;
    const fileId = newSortableId(systemRandom, now);
    const messageId = newSortableId(systemRandom, now);

    const stored = this.safe(() => {
      this.client.db.files.insert({
        id: fileId,
        name: attachment.filename,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.fileBytes,
        // The transfer hashes the file on its way out; there is nothing to
        // record here yet, and an empty hash is what the file row means by
        // "not verified", not by "verified as empty".
        contentHash: new Uint8Array(0),
        // Ours already: this is the copy the picker or the recorder made, which
        // is why our own bubble can draw the photo before anything has moved.
        localPath: attachment.path,
        width: attachment.width,
        height: attachment.height,
        durationMs: attachment.durationMs,
        createdAt: now,
      });
      return this.client.db.messages.insert({
        id: messageId,
        conversationId,
        senderPeerId: LOCAL_SENDER,
        kind: attachment.kind,
        // No text. A caption would be a second message, and the bubble is the
        // picture.
        body: null,
        sentAt: now,
        receivedAt: now,
        status: 'pending',
        replyToId: input.replyToRowId,
        fileId,
      });
    });
    if (!stored) return null;

    centre.touch();
    void this.deliver(input.peerId, messageId);
    return messageId;
  }

  /**
   * Try again, from the failed line under a bubble.
   *
   * Back to `pending` first so the row reads as queued rather than broken even
   * if there is still nobody to send it to - which is the same thing
   * `ChatCenter.retry` does for a text message with no session.
   */
  retry(peerId: string, rowId: string): void {
    this.safe(() => this.client.db.messages.setStatus(rowId, 'pending'));
    chatCenterFor(this.client).touch();
    void this.deliver(peerId, rowId);
  }

  /** How far along the bytes are, or null when nothing is moving. */
  percentFor(rowId: string): number | null {
    return this.percents.get(rowId) ?? null;
  }

  private async deliver(peerId: string, rowId: string): Promise<void> {
    if (this.starting.has(rowId)) return;
    const row = this.safe(() => this.client.db.messages.get(rowId));
    const fileId = row?.fileId;
    if (!row || !fileId || row.deleted) return;
    const file = this.safe(() => this.client.db.files.get(fileId));
    const path = file?.localPath;
    if (!file || !path) {
      // The bytes are not on this phone, so there is nothing to offer. This is
      // an incoming file, or a local copy that has been cleaned up underneath
      // us; either way the row must not sit at `pending` for ever.
      this.fail(rowId);
      return;
    }

    const handle = this.client.peer(peerId);
    if (!handle || handle.session.state !== ConnectionState.CONNECTED) {
      // Out of range. The row stays `pending`, the bubble says so, and the next
      // session flushes it. Deliberately NOT a failure.
      return;
    }

    this.starting.add(rowId);
    try {
      const transferId = await this.transfers.send({
        peerKey: handle.key,
        path,
        filename: file.name,
        mimeType: file.mimeType,
        fileBytes: file.sizeBytes,
      });
      this.inFlight.set(transferId, rowId);
      this.percents.set(rowId, 0);
      this.announce(handle, transferId, file);
      this.safe(() => this.client.db.messages.setStatus(rowId, 'sent'));
      chatCenterFor(this.client).touch();
    } catch {
      // `send` throws when there is no session to attach to, which the check
      // above has already covered, or when the file cannot be opened - which is
      // permanent and worth a red line the user can tap.
      this.fail(rowId);
    } finally {
      this.starting.delete(rowId);
    }
  }

  /**
   * Tell the other phone that these bytes belong in the conversation.
   *
   * Without this the file arrives as a bare offer in the Share tab and the
   * conversation on their side shows nothing at all - the photo would be sent
   * from a chat and received somewhere else entirely.
   *
   * The descriptor names the file by its TRANSFER id, which is what
   * `ChatAttachment.fileId` is documented to be: both phones know a transfer by
   * the same id, and the receiver's file row is written under it, so the bubble
   * fills in with the real picture the moment the bytes land. Our own row keeps
   * its own local file id, pointing at the copy already on this phone - two ids
   * for one photo, which is fine, because a file id never leaves the device
   * that minted it except in this one descriptor.
   *
   * A retried attachment announces itself again, because a new transfer has a
   * new id and the failed one's bytes are never coming. That leaves the earlier
   * bubble on their side saying "Receiving" for ever; there is no retraction in
   * the protocol, and a duplicate that arrives beats a photo that does not.
   */
  private announce(handle: PeerHandle, transferId: string, file: StoredFile): void {
    this.safe(() =>
      handle.chat.send({
        attachments: [
          {
            fileId: transferId,
            name: file.name,
            mimeType: file.mimeType,
            byteLength: file.sizeBytes,
            ...(file.width !== null ? { width: file.width } : {}),
            ...(file.height !== null ? { height: file.height } : {}),
            ...(file.durationMs !== null ? { durationMs: file.durationMs } : {}),
          },
        ],
      }),
    );
  }

  private fail(rowId: string): void {
    this.safe(() => this.client.db.messages.setStatus(rowId, 'failed'));
    this.percents.delete(rowId);
    chatCenterFor(this.client).touch();
  }

  // -- the queue -------------------------------------------------------------

  private scheduleFlush(peerKey: string): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush(peerKey);
    }, FLUSH_DELAY_MS);
  }

  /** Everything queued for this person, oldest first. */
  private flush(peerKey: string): void {
    const handle = this.client.peer(peerKey);
    const peerId = handle?.peerId ?? handle?.session.peerId ?? null;
    if (!peerId) return;
    const conversationId = directConversationId(peerId);
    if (!this.safe(() => this.client.db.conversations.get(conversationId))) return;

    for (const row of this.safe(() => this.client.db.messages.pendingFor(conversationId)) ?? []) {
      if (row.senderPeerId !== LOCAL_SENDER || row.deleted) continue;
      // Text is the chat protocol's queue, not ours.
      if (!row.fileId) continue;
      void this.deliver(peerId, row.id);
    }
  }

  // -- what the transfer did -------------------------------------------------

  /**
   * The bytes moved, or stopped.
   *
   * A transfer is the only thing that can tell an attachment message it has
   * actually arrived, so `delivered` here comes from the receiver having
   * verified the file - a stronger claim than the tick on a text message, and
   * the right one.
   */
  private onTransfersChanged(): void {
    if (this.inFlight.size === 0) return;
    let changed = false;
    for (const [transferId, rowId] of [...this.inFlight]) {
      const record = this.transfers.get(transferId);
      if (!record) continue;

      const percent = Math.round(record.percent);
      // Only whole steps of five: every acknowledged chunk publishes, and a
      // conversation re-reads its page from SQLite on every publish.
      const shown = this.percents.get(rowId);
      if (!isTerminalState(record.state) && (shown === undefined || Math.abs(percent - shown) >= 5)) {
        this.percents.set(rowId, percent);
        changed = true;
      }

      if (!isTerminalState(record.state)) continue;
      this.inFlight.delete(transferId);
      this.percents.delete(rowId);
      this.safe(() =>
        this.client.db.messages.setStatus(
          rowId,
          record.state === TransferState.COMPLETED ? 'delivered' : 'failed',
        ),
      );
      changed = true;
    }
    if (changed) chatCenterFor(this.client).touch();
  }

  /**
   * Run a database call and swallow what it throws.
   *
   * Same reasoning as `ChatCenter.safe`: one row that will not write must not
   * take the conversation down with it.
   */
  private safe<T>(fn: () => T): T | undefined {
    try {
      return fn();
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.inFlight.clear();
    this.starting.clear();
    this.percents.clear();
  }
}

/**
 * One centre per client, for the life of the app.
 *
 * A `WeakMap` rather than a module-level singleton for the same reason as the
 * other two: a test gets its own, and nothing here keeps a dead client alive.
 */
const centres = new WeakMap<AirLinkClient, AttachmentCenter>();

export function attachmentCenterFor(client: AirLinkClient): AttachmentCenter {
  const existing = centres.get(client);
  if (existing) return existing;
  const created = new AttachmentCenter(client);
  centres.set(client, created);
  return created;
}

/** Minutes and seconds, which is the only shape a voice note is ever read in. */
export function clockDuration(durationMs: number | null): string {
  const total = Math.max(0, Math.round((durationMs ?? 0) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}
