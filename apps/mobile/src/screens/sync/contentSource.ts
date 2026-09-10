import ReactNativeBlobUtil from 'react-native-blob-util';
import { errorCodes, isErrorWithCode, keepLocalCopy, pick, types } from '@react-native-documents/picker';
import {
  describeContent,
  fromBase64,
  type ContentDescriptor,
  type ContentSampleReader,
} from '@airlink/core';

/**
 * Turning a file the user pointed at into something the two phones can compare.
 *
 * The protocol never sends video. What it sends is a ContentDescriptor - size,
 * duration and a SHA-256 over eight 64 KiB windows spread through the file (see
 * packages/core/src/sync/contentHash.ts). Everything in this file exists to
 * produce that descriptor from a picked file without reading four gigabytes
 * through the bridge.
 */

/** A file the user chose, before we know anything about its contents. */
export interface PickedVideo {
  /** What `<Video source={{ uri }}>` plays. */
  readonly uri: string;
  /** The same file as a filesystem path, which is what the sampler needs. */
  readonly path: string;
  /** Shown to the user, and sent to the peer as an advisory title. */
  readonly title: string;
  readonly mimeType: string | null;
  readonly byteLength: number;
}

/**
 * Present the system picker.
 *
 * Resolves null when the user backed out, which is not an error and must not be
 * reported as one.
 */
export async function pickVideo(): Promise<PickedVideo | null> {
  let picked;
  try {
    [picked] = await pick({ type: [types.video], mode: 'import' });
  } catch (err) {
    if (isErrorWithCode(err) && err.code === errorCodes.OPERATION_CANCELED) return null;
    throw err;
  }

  const title = picked.name ?? '';
  const uri = await localUriFor(picked.uri, title);
  const path = toFilesystemPath(uri);
  // The picker reports a size for almost every provider, but "almost" is not a
  // guarantee and the size is a byte-exact part of the match - so when it is
  // missing we ask the filesystem rather than guessing.
  const byteLength = picked.size ?? (await statSize(path));

  return { uri, path, title, mimeType: picked.type, byteLength };
}

/**
 * The file's exact length, from the filesystem.
 *
 * `fs.stat().size` is DECLARED as a number and is a string at runtime on both
 * platforms - `ReactNativeBlobUtilFS.java` calls `putString("size", ...)` and
 * the iOS module formats it with `%llu`. A string reaches `describeContent`,
 * fails `Number.isSafeInteger` inside `sampledWindowOffsets`, and the screen
 * reports a perfectly good film as one it could not read - every time, for that
 * file. So it is coerced and checked here, at the only boundary that knows the
 * declaration is wrong.
 */
async function statSize(path: string): Promise<number> {
  const stat = await ReactNativeBlobUtil.fs.stat(path);
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size <= 0) {
    throw new Error(`sync: the filesystem reported no usable size for ${path}`);
  }
  return size;
}

/**
 * Build the descriptor the peer will be asked to match.
 *
 * `durationMs` comes from the player's own `onLoad`, because the duration that
 * matters is the one the decoder on this device reports - that is exactly what
 * the peer compares against, with a one-second tolerance for the fact that
 * AVFoundation and ExoPlayer round the last frame differently.
 */
export async function describePickedVideo(video: PickedVideo, durationMs: number): Promise<ContentDescriptor> {
  const reader = new SampledFileReader(video.path, video.byteLength);
  try {
    return await describeContent(reader, {
      // Local handle only: it is never sent and never compared, so the file's
      // own path is exactly the right thing to use.
      contentId: video.path,
      durationMs,
      ...(video.title ? { title: video.title } : {}),
      ...(video.mimeType ? { mimeType: video.mimeType } : {}),
    });
  } finally {
    await reader.cleanUp();
  }
}

/**
 * Random access to a file, one window at a time.
 *
 * react-native-blob-util has no "read N bytes at offset" call, so each window is
 * sliced out to a scratch file and read back as base64. Eight round trips of
 * 64 KiB is a few hundred milliseconds; reading the whole film would be twenty
 * seconds and a lot of battery, which is the entire reason the hash is sampled.
 */
class SampledFileReader implements ContentSampleReader {
  private readonly scratch: string;

  constructor(
    private readonly path: string,
    readonly byteLength: number,
  ) {
    this.scratch = `${ReactNativeBlobUtil.fs.dirs.CacheDir}/airlink-sync-window-${Date.now().toString(36)}`;
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    await ReactNativeBlobUtil.fs.slice(this.path, this.scratch, offset, offset + length);
    const raw: unknown = await ReactNativeBlobUtil.fs.readFile(this.scratch, 'base64');
    if (typeof raw !== 'string') throw new Error('sync: the file window came back in an unexpected shape');
    // Some platforms wrap long base64 at 76 characters; the decoder rejects any
    // character outside the alphabet, newlines included.
    return fromBase64(raw.replace(/\s+/g, ''));
  }

  async cleanUp(): Promise<void> {
    try {
      await ReactNativeBlobUtil.fs.unlink(this.scratch);
    } catch {
      // A scratch file that was never created, or already gone, is not a
      // failure worth surfacing - the cache is the system's to reclaim.
    }
  }
}

/**
 * Get a path the filesystem can slice.
 *
 * iOS hands back a `file://` url the picker already copied into the app's inbox.
 * Android hands back a `content://` uri that belongs to another app's document
 * provider, which cannot be sliced - so it is copied into the cache first. That
 * copy costs a full read of the file, which is the honest price of Android's
 * document model; there is no random-access read over a content uri from JS.
 */
async function localUriFor(uri: string, fileName: string): Promise<string> {
  if (uri.startsWith('file://')) return uri;
  const [copy] = await keepLocalCopy({
    files: [{ uri, fileName: fileName || 'video' }],
    destination: 'cachesDirectory',
  });
  if (copy.status !== 'success') throw new Error(copy.copyError);
  return copy.localUri;
}

function toFilesystemPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  // Percent-encoding is part of the url, not of the path: a film called
  // "Le Mans '66.mp4" arrives with %20 and %27 in it and would not be found.
  return decodeURIComponent(uri.slice('file://'.length));
}
