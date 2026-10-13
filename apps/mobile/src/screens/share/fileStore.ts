import { Platform } from 'react-native';
import ReactNativeBlobUtil from 'react-native-blob-util';
import { fromBase64, isValidTransferId, newSortableId, systemRandom, toBase64, type FileStore } from '@airlink/core';

/**
 * The file I/O behind the transfer protocol.
 *
 * `@airlink/core/files` deliberately does no I/O of its own: it reads and
 * writes through a `FileStore`, which is why the whole protocol is testable in
 * memory. This module is the other half - the two stores the app plugs in, and
 * the small amount of path discipline that has to happen where the bytes
 * actually land.
 *
 * Two constraints from react-native-blob-util shape everything here, and both
 * are worth stating because neither is obvious:
 *
 *  1. There is no positional read. `fs.slice(src, dest, start, end)` writes a
 *     range to a second file, which is then read whole. A 256-byte Bluetooth
 *     chunk cannot afford a temp file each, so the sender reads in large blocks
 *     and serves chunks out of the block it already holds.
 *
 *  2. There is no positional WRITE at all. Only `writeFile` and `appendFile`.
 *     Chunks arrive out of order (that is the entire point of a selective
 *     acknowledgement), so a receiver cannot stream into one file. Each run of
 *     chunks is therefore written as its own part file named by its offset, and
 *     the parts are concatenated once the file is complete and verified. The
 *     part directory doubles as the on-disk record of what has arrived, so a
 *     half-received file survives the app being killed.
 */

const fs = ReactNativeBlobUtil.fs;

/** Everything this feature writes lives under one directory, and only there. */
const ROOT = `${fs.dirs.DocumentDir}/airlink`;
const INCOMING_ROOT = `${ROOT}/incoming`;
const RECEIVED_ROOT = `${ROOT}/received`;
const SENT_ROOT = `${ROOT}/sent`;
const SCRATCH_ROOT = `${fs.dirs.CacheDir}/airlink/outgoing`;

/**
 * How much of a file the sender pulls off disk at once.
 *
 * Large enough that a 120 MB video costs a couple of hundred reads rather than
 * half a million, small enough to sit in a phone's heap next to a decoded
 * photo. Reads within a block are free, which is the common case: the sender
 * walks the file in order and only jumps back to retransmit.
 */
const READ_BLOCK_BYTES = 512 * 1024;

async function ensureDir(path: string): Promise<void> {
  if (await fs.exists(path)) return;
  await fs.mkdir(path);
}

/**
 * The part of an iOS path that names this install's data container.
 *
 * `.../Containers/Data/Application/<UUID>` is where Documents, Library and tmp
 * live, and the UUID is not permanent: iOS gives the app a new one when it is
 * reinstalled or updated, and when it is restored onto another phone. The
 * files come along; only the folder's name changes.
 */
const DATA_CONTAINER = /^.*\/Containers\/Data\/Application\/[0-9A-Fa-f-]{36}(?=\/|$)/;

/**
 * A stored path, pointed at wherever this app's container is NOW.
 *
 * The database remembers where a photo or a voice note was written as an
 * absolute path, container UUID included. After an update that path names a
 * folder that no longer exists, although the file is sitting in the new one -
 * so every photo ever sent or received would turn into a grey square, and every
 * voice note would refuse to play, on the first update after release. Reading
 * a path through here replaces the stale container with the current one. A
 * path that does not have the shape (Android's, a test's) is returned as it is.
 */
export function rebaseToContainer(stored: string, documentDir: string): string {
  const current = DATA_CONTAINER.exec(documentDir)?.[0];
  if (!current) return stored;
  return stored.replace(DATA_CONTAINER, current);
}

/** `rebaseToContainer` against this install's own Documents directory; null stays null. */
export function currentPath(stored: string | null): string | null {
  return stored === null ? null : rebaseToContainer(stored, fs.dirs.DocumentDir);
}

/** blob-util wants a plain path; pickers hand back a URI. */
export function pathFromUri(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  const withoutScheme = uri.slice('file://'.length);
  try {
    return decodeURIComponent(withoutScheme);
  } catch {
    // A malformed escape means the path was never percent-encoded.
    return withoutScheme;
  }
}

/**
 * The name this device will use on disk.
 *
 * The protocol has already rejected separators, control characters and "..",
 * so what arrives cannot escape a directory. This goes further and derives a
 * NEW name from the peer's, rather than reusing theirs: the file lands in a
 * directory named after the transfer id, so two files called "IMG_0001.jpg"
 * cannot collide, and nothing a peer chooses can decide where bytes are
 * written. The original name is still what the user is shown - it is displayed
 * as text, never resolved as a path.
 */
export function diskNameFor(filename: string): string {
  const cleaned = filename.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '');
  const trimmed = cleaned.slice(0, 100);
  return trimmed.length > 0 ? trimmed : 'file';
}

/** Guard for anything that becomes a path segment. Ids are already bounded. */
function assertPathSafeId(transferId: string): string {
  if (!isValidTransferId(transferId)) throw new Error('file store: unusable transfer id');
  return transferId;
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export class SourceFileStore implements FileStore {
  private block: Uint8Array | null = null;
  private blockStart = 0;
  private scratchCounter = 0;
  private disposed = false;

  constructor(
    private readonly path: string,
    readonly fileBytes: number,
    private readonly transferKey: string,
  ) {}

  async readChunk(offset: number, length: number): Promise<Uint8Array> {
    if (offset < 0 || length < 0 || offset + length > this.fileBytes) {
      throw new Error('file store: read past the end of the file');
    }
    if (length === 0) return new Uint8Array(0);
    if (!this.covers(offset, length)) await this.loadBlock(offset, length);
    const block = this.block;
    if (!block) throw new Error('file store: block could not be read');
    const start = offset - this.blockStart;
    return block.subarray(start, start + length);
  }

  private covers(offset: number, length: number): boolean {
    const block = this.block;
    if (!block) return false;
    return offset >= this.blockStart && offset + length <= this.blockStart + block.length;
  }

  private async loadBlock(offset: number, length: number): Promise<void> {
    const start = Math.floor(offset / READ_BLOCK_BYTES) * READ_BLOCK_BYTES;
    // A chunk that straddles a block boundary extends the window rather than
    // splitting the read in two.
    const end = Math.min(this.fileBytes, Math.max(start + READ_BLOCK_BYTES, offset + length));
    await ensureDir(SCRATCH_ROOT);
    const scratch = `${SCRATCH_ROOT}/${this.transferKey}-${this.scratchCounter++}`;
    try {
      await fs.slice(this.path, scratch, start, end);
      const encoded = (await fs.readFile(scratch, 'base64')) as string;
      this.block = fromBase64(encoded);
      this.blockStart = start;
    } finally {
      await fs.unlink(scratch).catch(() => undefined);
    }
  }

  /**
   * Never called, and loud if it ever is.
   *
   * `FileStore` carries both halves because the RECEIVING side needs both: it
   * writes chunks and then reads them back to verify the whole-file hash. A file
   * being sent is only ever read, so a write here would mean the protocol had
   * confused the two directions - which would corrupt the user's own file rather
   * than merely fail a transfer, and is worth throwing over.
   */
  async writeChunk(): Promise<void> {
    throw new Error('file store: a file being sent is never written to');
  }

  /** Drop the cached block. The source file itself is never touched. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.block = null;
  }
}

/**
 * Keep a file that is about to be sent, somewhere the system will not take it back.
 *
 * What a picker hands over lives in a temporary folder, and "temporary" is
 * meant literally: iOS empties it when the app is not running and when the
 * phone is short of space. That is fine for something sent in the next second,
 * and wrong for everything else this app promises - a photo queued for a friend
 * who is out of range has to still exist when they come back, a retry has to
 * have something to read, and the sender's own bubble has to keep showing the
 * picture rather than a grey square after the app is reopened. So the file is
 * moved, once, into this app's own storage (next to what it receives), under a
 * folder of its own so that two photos called IMG_0001.jpg cannot collide.
 *
 * The temporary original is removed afterwards: it is our copy of the picker's
 * copy, never the user's own file.
 */
export async function keepForSending(sourcePath: string, filename: string): Promise<string> {
  await ensureDir(ROOT);
  await ensureDir(SENT_ROOT);
  const dir = `${SENT_ROOT}/${newSortableId(systemRandom, Date.now())}`;
  await ensureDir(dir);
  const destination = `${dir}/${diskNameFor(filename)}`;
  await fs.cp(sourcePath, destination);
  await fs.unlink(sourcePath).catch(() => undefined);
  return destination;
}

/** Read a file's real size. The pickers report it too, but not always. */
export async function measureFile(path: string): Promise<number> {
  const stat = await fs.stat(path);
  return typeof stat.size === 'number' ? stat.size : Number(stat.size);
}

// ---------------------------------------------------------------------------
// Receiving
// ---------------------------------------------------------------------------

interface Part {
  readonly offset: number;
  readonly length: number;
}

export class IncomingPartStore implements FileStore {
  private readonly parts = new Map<number, Part>();
  private cachedOffset = -1;
  private cached: Uint8Array | null = null;

  private constructor(
    private readonly dir: string,
    private readonly transferId: string,
    private readonly fileBytes: number,
  ) {}

  /**
   * Open (or reopen) the part directory for a transfer.
   *
   * Reopening is what makes a resume work across a restart: the part files are
   * still there, and their names are their offsets, so the directory listing
   * IS the record of what arrived. The bitmap in the database says which grid
   * chunks are complete; this says where their bytes are.
   */
  static async open(transferId: string, fileBytes: number): Promise<IncomingPartStore> {
    assertPathSafeId(transferId);
    const dir = `${INCOMING_ROOT}/${transferId}`;
    await ensureDir(ROOT);
    await ensureDir(INCOMING_ROOT);
    await ensureDir(dir);
    const store = new IncomingPartStore(dir, transferId, fileBytes);
    await store.hydrate();
    return store;
  }

  private async hydrate(): Promise<void> {
    let names: string[];
    try {
      names = await fs.ls(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const offset = Number(name);
      if (!Number.isInteger(offset) || offset < 0) continue;
      try {
        const stat = await fs.stat(`${this.dir}/${name}`);
        const length = typeof stat.size === 'number' ? stat.size : Number(stat.size);
        if (length > 0) this.parts.set(offset, { offset, length });
      } catch {
        // A part we cannot stat is a part we do not have; the sender will
        // simply be asked for those chunks again.
      }
    }
  }

  async writeChunk(offset: number, bytes: Uint8Array): Promise<void> {
    if (offset < 0 || offset + bytes.length > this.fileBytes) {
      throw new Error('file store: write past the end of the file');
    }
    await fs.writeFile(`${this.dir}/${offset}`, toBase64(bytes), 'base64');
    this.parts.set(offset, { offset, length: bytes.length });
    if (this.cachedOffset === offset) {
      this.cachedOffset = -1;
      this.cached = null;
    }
  }

  /**
   * Read back what was written. Used only for verification, which walks the
   * whole file on the chunk grid - and every part is a whole number of grid
   * chunks, so a grid read lies inside one part. The loop below still handles
   * a read that spans parts, because being wrong here would corrupt a file
   * rather than fail loudly.
   */
  async readChunk(offset: number, length: number): Promise<Uint8Array> {
    if (length === 0) return new Uint8Array(0);
    const out = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const at = offset + written;
      const part = this.partContaining(at);
      if (!part) throw new Error(`file store: nothing written at ${at}`);
      const data = await this.readPart(part);
      const from = at - part.offset;
      const take = Math.min(length - written, data.length - from);
      if (take <= 0) throw new Error(`file store: part at ${part.offset} is short`);
      out.set(data.subarray(from, from + take), written);
      written += take;
    }
    return out;
  }

  private partContaining(offset: number): Part | null {
    for (const part of this.parts.values()) {
      if (offset >= part.offset && offset < part.offset + part.length) return part;
    }
    return null;
  }

  private async readPart(part: Part): Promise<Uint8Array> {
    if (this.cachedOffset === part.offset && this.cached) return this.cached;
    const encoded = (await fs.readFile(`${this.dir}/${part.offset}`, 'base64')) as string;
    const data = fromBase64(encoded);
    this.cachedOffset = part.offset;
    this.cached = data;
    return data;
  }

  /**
   * Stitch the parts into one file, in offset order, and throw the parts away.
   *
   * Only ever called after the protocol has verified the assembled bytes
   * against the offered hash, so this cannot produce a file that claims to be
   * something it is not.
   */
  async finalize(filename: string): Promise<string> {
    const dir = `${RECEIVED_ROOT}/${this.transferId}`;
    await ensureDir(ROOT);
    await ensureDir(RECEIVED_ROOT);
    await ensureDir(dir);
    const destination = `${dir}/${diskNameFor(filename)}`;

    if (await fs.exists(destination)) await fs.unlink(destination);
    await fs.createFile(destination, '', 'base64');

    const ordered = [...this.parts.values()].sort((a, b) => a.offset - b.offset);
    for (const part of ordered) {
      // 'uri' appends another file's bytes directly, which keeps a 120 MB video
      // out of the JavaScript heap entirely.
      await fs.appendFile(destination, `${this.dir}/${part.offset}`, 'uri');
    }

    this.cached = null;
    this.cachedOffset = -1;
    await fs.unlink(this.dir).catch(() => undefined);
    this.parts.clear();
    return destination;
  }

  /** Give up on a half-received file and reclaim its space. */
  async discard(): Promise<void> {
    this.cached = null;
    this.cachedOffset = -1;
    this.parts.clear();
    await fs.unlink(this.dir).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Doing something with a finished file
// ---------------------------------------------------------------------------

/**
 * Hand the file to the OS. iOS shows the document interaction menu (which is
 * also where "Save Image" lives); Android fires an ACTION_VIEW chooser.
 *
 * Returns false when nothing on the device can open it, so the caller can say
 * so rather than appearing to do nothing.
 */
export async function openReceivedFile(path: string, mimeType: string): Promise<boolean> {
  try {
    if (Platform.OS === 'ios') {
      await ReactNativeBlobUtil.ios.openDocument(path);
      return true;
    }
    const opened = await ReactNativeBlobUtil.android.actionViewIntent(path, mimeType || 'application/octet-stream');
    return opened !== false;
  } catch {
    return false;
  }
}

/**
 * The shape of the one MediaCollection call this screen makes.
 *
 * Declared locally because react-native-blob-util ships its `filedescriptor`
 * type in a Flow file with no TypeScript counterpart, so the published
 * definition for `MediaCollection` resolves to nothing usable. Narrow and
 * explicit beats reaching for `any`.
 */
interface MediaStoreDescriptor {
  readonly name: string;
  readonly parentFolder: string;
  readonly mimeType: string;
}

/** True when the platform can put this file in the photo library by itself. */
export function canSaveToPhotos(mimeType: string): boolean {
  return Platform.OS === 'android' && (mimeType.startsWith('image/') || mimeType.startsWith('video/'));
}

export async function saveToPhotos(path: string, filename: string, mimeType: string): Promise<boolean> {
  if (!canSaveToPhotos(mimeType)) return false;
  const collection = ReactNativeBlobUtil.MediaCollection as unknown as {
    copyToMediaStore(file: MediaStoreDescriptor, kind: 'Image' | 'Video', source: string): Promise<string>;
  };
  try {
    await collection.copyToMediaStore(
      { name: diskNameFor(filename), parentFolder: '', mimeType: mimeType || 'image/jpeg' },
      mimeType.startsWith('video/') ? 'Video' : 'Image',
      path,
    );
    return true;
  } catch {
    return false;
  }
}
