import { AppState, type NativeEventSubscription } from 'react-native';
import {
  ConnectionState,
  FileTransferProtocol,
  TransferDirection,
  TransferState,
  defaultProfileFor,
  systemClock,
  systemRandom,
  totalChunksFor,
  type FileOffer,
  type ResumeState,
  type TransferProgress,
} from '@airlink/core';
import type { Transfer } from '@airlink/db';
import type { AirLinkClient } from '../../client/AirLinkClient.js';
import { useAppStore } from '../../state/index.js';
import { IncomingPartStore, SourceFileStore } from './fileStore.js';
import { failureText, shareStrings } from './strings.js';

/**
 * Everything the Share screens read and drive.
 *
 * It exists because file transfer is not a screen concern: a transfer has to
 * outlive the screen that started it, keep running while the user is in a game,
 * survive the app being backgrounded, and pick itself up when the link changes
 * underneath it. So the state lives here, for the lifetime of the client, and
 * the screens subscribe to it.
 *
 * The centre owns one `FileTransferProtocol` per connected peer and nothing
 * else: all of the chunking, acknowledging, retrying, resuming and verifying is
 * `@airlink/core/files`, which is tested to death without a radio. What is
 * genuinely this file's job is the part core cannot know about - which file on
 * disk, which person's name, what to persist so a half-finished transfer
 * survives being killed, and how to say what happened in words.
 */

/** One transfer, as a screen needs to see it. No protocol vocabulary. */
export interface TransferRecord {
  readonly id: string;
  readonly peerKey: string;
  readonly peerName: string;
  readonly direction: TransferDirection;
  /**
   * For an incoming transfer this string was chosen by the peer. It is safe to
   * DISPLAY - the protocol has already rejected separators and control
   * characters - but it is never used to build a path. See `diskNameFor`.
   */
  readonly filename: string;
  readonly mimeType: string;
  readonly totalBytes: number;
  readonly transferredBytes: number;
  readonly percent: number;
  /** Measured, never a transport's nominal figure. Null until a sample exists. */
  readonly bytesPerSecond: number | null;
  readonly etaMs: number | null;
  readonly state: TransferState;
  /**
   * True when bytes have stopped moving but the transfer is still alive. This
   * is "Paused", not "Failed": it resumes by itself when the link comes back.
   */
  readonly paused: boolean;
  /** Set once a received file is on disk and openable. */
  readonly localPath: string | null;
  /** Already phrased for a person. Null unless something really went wrong. */
  readonly failure: string | null;
  readonly updatedAt: number;
}

/** What the sender needs in order to resume after a session, not just a link, dies. */
interface OutgoingSource {
  readonly path: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly fileBytes: number;
  fileHash: Uint8Array | null;
  chunkSize: number | null;
  store: SourceFileStore;
}

interface Binding {
  readonly protocol: FileTransferProtocol;
  readonly offs: (() => void)[];
}

export interface LinkEstimate {
  /** Bytes per second we expect right now. Null when we have nothing to go on. */
  readonly bytesPerSecond: number | null;
  readonly etaMs: number | null;
  /** True when this link cannot move a photo at a comfortable rate. */
  readonly slowLink: boolean;
  readonly connected: boolean;
}

/** How often resume state is written to the database while bytes are moving. */
const PERSIST_INTERVAL_MS = 4000;

export class TransferCenter {
  private readonly records = new Map<string, TransferRecord>();
  private readonly bindings = new Map<string, Binding>();
  private readonly incomingStores = new Map<string, IncomingPartStore>();
  private readonly outgoingSources = new Map<string, OutgoingSource>();
  /** Last measured throughput per peer, so the NEXT send can be honest up front. */
  private readonly measured = new Map<string, number>();
  private readonly lastPersistedAt = new Map<string, number>();
  private readonly listeners = new Set<() => void>();
  private readonly clientOffs: (() => void)[] = [];
  private appStateSubscription: NativeEventSubscription | null = null;

  private snapshotCache: readonly TransferRecord[] = [];

  constructor(private readonly client: AirLinkClient) {
    this.clientOffs.push(
      client.events.on('connectionChanged', ({ peerKey, state }) => {
        if (state === ConnectionState.CONNECTED) this.attach(peerKey);
        else this.pausePeer(peerKey);
      }),
    );
    // A peer may already be connected by the time the Share tab is first
    // opened, so nothing here waits for an event that has already happened.
    for (const handle of client.connectedPeers()) this.attach(handle.key);
    this.restoreInterrupted();

    // Backgrounding is the moment most likely to be followed by the OS killing
    // the process, so it is the moment worth spending a database write on.
    this.appStateSubscription = AppState.addEventListener('change', (status) => {
      if (status !== 'active') this.persistAll();
    });
  }

  dispose(): void {
    for (const off of this.clientOffs) off();
    this.clientOffs.length = 0;
    for (const binding of this.bindings.values()) {
      for (const off of binding.offs) off();
      binding.protocol.dispose();
    }
    this.bindings.clear();
    this.appStateSubscription?.remove();
    this.appStateSubscription = null;
    this.listeners.clear();
  }

  // -- subscription ----------------------------------------------------------

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Stable identity between changes, so `useSyncExternalStore` behaves. */
  list = (): readonly TransferRecord[] => this.snapshotCache;

  get(transferId: string): TransferRecord | undefined {
    return this.records.get(transferId);
  }

  private publish(): void {
    this.snapshotCache = [...this.records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    for (const listener of [...this.listeners]) listener();
  }

  // -- what the user can do --------------------------------------------------

  /**
   * Offer a file to a peer.
   *
   * Resolves once the offer is on its way, which is after one full pass over
   * the file to hash it - so a large file spends a visible moment in
   * "Getting the file ready" before anything moves. That is honest: the pass is
   * really happening, and it is what lets the receiver be told that what
   * arrived is what was sent.
   */
  async send(input: {
    peerKey: string;
    path: string;
    filename: string;
    mimeType: string;
    fileBytes: number;
  }): Promise<string> {
    const binding = this.bindings.get(input.peerKey) ?? this.attach(input.peerKey);
    if (!binding) throw new Error(shareStrings.connectFirst);

    const store = new SourceFileStore(input.path, input.fileBytes, `send-${Date.now()}`);
    const transferId = await binding.protocol.offer({
      filename: input.filename,
      fileBytes: input.fileBytes,
      mimeType: input.mimeType,
      store,
    });

    const resume = binding.protocol.snapshot(transferId);
    this.outgoingSources.set(transferId, {
      path: input.path,
      filename: input.filename,
      mimeType: input.mimeType,
      fileBytes: input.fileBytes,
      fileHash: resume?.fileHash ?? null,
      chunkSize: resume?.chunkSize ?? null,
      store,
    });

    this.upsert({
      id: transferId,
      peerKey: input.peerKey,
      peerName: this.nameFor(input.peerKey),
      direction: TransferDirection.OUTGOING,
      filename: input.filename,
      mimeType: input.mimeType,
      totalBytes: input.fileBytes,
      transferredBytes: 0,
      percent: 0,
      bytesPerSecond: null,
      etaMs: null,
      state: TransferState.OFFERED,
      paused: false,
      localPath: input.path,
      failure: null,
      updatedAt: Date.now(),
    });
    this.persistNew(transferId);
    return transferId;
  }

  /** The user pressed Accept on an incoming offer. */
  async accept(transferId: string): Promise<void> {
    const record = this.records.get(transferId);
    const binding = record ? this.bindings.get(record.peerKey) : undefined;
    if (!record || !binding) throw new Error(shareStrings.incomingGone);

    const store = await IncomingPartStore.open(transferId, record.totalBytes);
    this.incomingStores.set(transferId, store);
    const resume = this.resumeStateFor(transferId);
    binding.protocol.accept(transferId, store, resume ?? undefined);
  }

  decline(transferId: string): void {
    const record = this.records.get(transferId);
    if (!record) return;
    this.bindings.get(record.peerKey)?.protocol.decline(transferId);
  }

  /** Stop a transfer, from either side, at any point. */
  cancel(transferId: string): void {
    const record = this.records.get(transferId);
    if (!record) return;
    const binding = this.bindings.get(record.peerKey);
    if (binding) {
      binding.protocol.cancel(transferId);
      return;
    }
    // No live session to tell, so this is a local abandonment: the peer will
    // find out when it next tries to send us something for this transfer.
    this.finish(transferId, TransferState.CANCELLED, null);
    void this.incomingStores.get(transferId)?.discard();
    this.incomingStores.delete(transferId);
    this.outgoingSources.delete(transferId);
  }

  /** Take a finished transfer off the list. Does not touch the received file. */
  forget(transferId: string): void {
    if (!this.records.delete(transferId)) return;
    this.publish();
  }

  // -- what the screens ask ---------------------------------------------------

  /**
   * How long this file will take on the link as it is right now.
   *
   * In order of preference: what a previous transfer with this peer actually
   * achieved, then what the live link reports it is achieving, then the
   * transport's reference figure. Only the last of those is a guess, and it is
   * the one used least often.
   */
  estimateFor(peerKey: string, fileBytes: number): LinkEstimate {
    const session = this.client.peer(peerKey)?.session;
    const connected = session?.state === ConnectionState.CONNECTED;
    const link = session?.currentLink ?? null;

    let bytesPerSecond = this.measured.get(peerKey) ?? null;
    if (bytesPerSecond === null && link) {
      const live = link.metrics().throughputBytesPerSecond;
      if (typeof live === 'number' && live > 0) bytesPerSecond = live;
    }
    if (bytesPerSecond === null && link) {
      bytesPerSecond = defaultProfileFor(link.transport).expectedThroughputBytesPerSecond;
    }

    return {
      bytesPerSecond,
      etaMs: bytesPerSecond && bytesPerSecond > 0 ? Math.round((fileBytes / bytesPerSecond) * 1000) : null,
      slowLink: !(session?.isHighBandwidth ?? false),
      connected,
    };
  }

  // -- sessions --------------------------------------------------------------

  private attach(peerKey: string): Binding | null {
    const existing = this.bindings.get(peerKey);
    if (existing) return existing;
    const handle = this.client.peer(peerKey);
    if (!handle || handle.session.state !== ConnectionState.CONNECTED) return null;

    const protocol = new FileTransferProtocol(handle.session, {
      clock: systemClock,
      random: systemRandom,
    });

    const offs: (() => void)[] = [
      protocol.events.on('offer', ({ offer }) => void this.onOffer(peerKey, offer)),
      protocol.events.on('progress', ({ progress }) => this.onProgress(peerKey, progress)),
      protocol.events.on('stateChanged', ({ progress }) => this.onProgress(peerKey, progress)),
      protocol.events.on('completed', ({ transferId, direction, filename }) => {
        void this.onCompleted(transferId, direction, filename);
      }),
      protocol.events.on('declined', ({ transferId, code }) => {
        const name = this.records.get(transferId)?.peerName ?? this.nameFor(peerKey);
        this.finish(transferId, TransferState.DECLINED, failureText(code, name));
        void this.releaseStores(transferId);
      }),
      protocol.events.on('cancelled', ({ transferId, byPeer }) => {
        const name = this.records.get(transferId)?.peerName ?? this.nameFor(peerKey);
        this.finish(transferId, TransferState.CANCELLED, byPeer ? shareStrings.stoppedByThem(name) : null);
        void this.releaseStores(transferId);
      }),
      protocol.events.on('failed', ({ transferId, code }) => {
        const name = this.records.get(transferId)?.peerName ?? this.nameFor(peerKey);
        this.finish(transferId, TransferState.FAILED, failureText(code, name));
        void this.releaseStores(transferId);
      }),

      // A transport upgrade (Bluetooth to Wi-Fi) keeps the same session, so the
      // running transfers only need telling that the budget changed.
      handle.session.events.on('transportChanged', () => protocol.notifyLinkChanged()),
      handle.session.events.on('closed', () => this.detach(peerKey)),
    ];

    const binding: Binding = { protocol, offs };
    this.bindings.set(peerKey, binding);
    void this.resumeOutgoingFor(peerKey, binding);
    return binding;
  }

  private detach(peerKey: string): void {
    const binding = this.bindings.get(peerKey);
    if (!binding) return;
    for (const off of binding.offs) off();
    binding.protocol.dispose();
    this.bindings.delete(peerKey);
    this.pausePeer(peerKey);
  }

  /**
   * The link to this peer is gone. Everything still running is PAUSED, never
   * failed - the bytes already on disk are still good, and the transfer picks
   * up where it stopped the moment the two phones can see each other again.
   */
  private pausePeer(peerKey: string): void {
    let changed = false;
    for (const record of this.records.values()) {
      if (record.peerKey !== peerKey) continue;
      if (record.state !== TransferState.TRANSFERRING && record.state !== TransferState.OFFERED) continue;
      this.records.set(record.id, { ...record, paused: true, bytesPerSecond: null, etaMs: null });
      changed = true;
    }
    this.persistAll();
    if (changed) this.publish();
  }

  /**
   * Re-offer a send that a dropped SESSION (not merely a dropped link) took
   * down with it.
   *
   * The offer carries the original transfer id, hash and chunk size, so the
   * receiving side recognises it as the same bytes on the same grid and
   * continues from its bitmap instead of starting again - and, because that
   * side already said yes to this exact file, it is not asked twice.
   */
  private async resumeOutgoingFor(peerKey: string, binding: Binding): Promise<void> {
    for (const record of [...this.records.values()]) {
      if (record.peerKey !== peerKey) continue;
      if (record.direction !== TransferDirection.OUTGOING) continue;
      if (record.state !== TransferState.TRANSFERRING && record.state !== TransferState.OFFERED) continue;
      const source = this.outgoingSources.get(record.id);
      if (!source || !source.fileHash || !source.chunkSize) continue;
      try {
        await binding.protocol.offer({
          transferId: record.id,
          filename: source.filename,
          fileBytes: source.fileBytes,
          mimeType: source.mimeType,
          store: source.store,
          fileHash: source.fileHash,
          chunkSize: source.chunkSize,
        });
      } catch {
        // Already running, or the peer is busy. Either way the record stays
        // paused and the next reconnection tries again.
      }
    }
  }

  // -- protocol events -------------------------------------------------------

  private async onOffer(peerKey: string, offer: FileOffer): Promise<void> {
    const peerName = this.nameFor(peerKey);
    const known = this.records.get(offer.transferId);
    const resume = this.resumeStateFor(offer.transferId, offer);

    this.upsert({
      id: offer.transferId,
      peerKey,
      peerName,
      direction: TransferDirection.INCOMING,
      filename: offer.filename,
      mimeType: offer.mimeType,
      totalBytes: offer.fileBytes,
      transferredBytes: 0,
      percent: 0,
      bytesPerSecond: null,
      etaMs: null,
      state: TransferState.OFFERED,
      paused: false,
      localPath: null,
      failure: null,
      updatedAt: Date.now(),
    });
    this.persistNew(offer.transferId);

    // An offer that matches a file this user ALREADY agreed to receive is a
    // resumption, not a new request. Asking a second time for the same file
    // would be the app forgetting what the user told it.
    const alreadyAccepted = known !== undefined && known.state !== TransferState.OFFERED;
    if (resume || alreadyAccepted) {
      try {
        await this.accept(offer.transferId);
      } catch {
        // The offer went away between arriving and being accepted; the record
        // stays pending and the user can answer it by hand.
      }
    }
  }

  private onProgress(peerKey: string, progress: TransferProgress): void {
    const existing = this.records.get(progress.transferId);
    if (!existing) return;
    if (progress.bytesPerSecond !== null && progress.bytesPerSecond > 0) {
      this.measured.set(peerKey, progress.bytesPerSecond);
    }
    this.upsert({
      ...existing,
      state: progress.state,
      transferredBytes: progress.transferredBytes,
      percent: progress.percent,
      bytesPerSecond: progress.bytesPerSecond,
      etaMs: progress.etaMs,
      paused: progress.stalled,
      updatedAt: Date.now(),
    });
    this.persistProgress(progress.transferId, progress);
  }

  private async onCompleted(transferId: string, direction: TransferDirection, filename: string): Promise<void> {
    const record = this.records.get(transferId);
    if (!record) return;

    if (direction === TransferDirection.OUTGOING) {
      this.finish(transferId, TransferState.COMPLETED, null);
      await this.releaseStores(transferId);
      return;
    }

    const store = this.incomingStores.get(transferId);
    if (!store) {
      this.finish(transferId, TransferState.FAILED, shareStrings.couldNotReadFile);
      return;
    }
    try {
      const localPath = await store.finalize(filename);
      this.incomingStores.delete(transferId);
      const current = this.records.get(transferId);
      if (current) {
        this.upsert({
          ...current,
          state: TransferState.COMPLETED,
          percent: 100,
          transferredBytes: current.totalBytes,
          paused: false,
          localPath,
          failure: null,
          updatedAt: Date.now(),
        });
      }
      this.persistCompleted(transferId, localPath);
    } catch {
      this.finish(transferId, TransferState.FAILED, shareStrings.couldNotReadFile);
    }
  }

  private finish(transferId: string, state: TransferState, failure: string | null): void {
    const existing = this.records.get(transferId);
    if (!existing) return;
    this.upsert({
      ...existing,
      state,
      percent: state === TransferState.COMPLETED ? 100 : existing.percent,
      paused: false,
      bytesPerSecond: null,
      etaMs: null,
      failure,
      updatedAt: Date.now(),
    });
    this.persistProgress(transferId, null);
  }

  private async releaseStores(transferId: string): Promise<void> {
    const incoming = this.incomingStores.get(transferId);
    if (incoming) {
      this.incomingStores.delete(transferId);
      const record = this.records.get(transferId);
      // Parts are only thrown away once the transfer really is over. A paused
      // one keeps them, because they are what makes resuming cheap.
      if (record && record.state !== TransferState.COMPLETED) await incoming.discard();
    }
    const outgoing = this.outgoingSources.get(transferId);
    if (outgoing) {
      this.outgoingSources.delete(transferId);
      await outgoing.store.dispose();
    }
  }

  // -- records ---------------------------------------------------------------

  private upsert(record: TransferRecord): void {
    this.records.set(record.id, record);
    this.publish();
  }

  private nameFor(peerKey: string): string {
    const peer = useAppStore.getState().peers.find((p) => p.key === peerKey);
    return peer?.displayName ?? this.client.peer(peerKey)?.session.capabilities?.displayName ?? '';
  }

  // -- persistence -----------------------------------------------------------
  //
  // Enough to survive the process being killed: what the file is, who it is
  // with, and which chunks are already on disk. Deliberately not a second copy
  // of the protocol's state - the bitmap and the parts on disk are the truth,
  // and everything else is rebuilt from them.

  /** The bitmap a previous attempt left behind, if it describes the same bytes. */
  private resumeStateFor(transferId: string, offer?: FileOffer): ResumeState | null {
    const row = this.safeDb(() => this.client.db.transfers.get(transferId));
    if (!row || !row.receivedBitmap) return null;
    const file = this.safeDb(() => this.client.db.files.get(row.fileId));
    if (!file) return null;
    if (offer) {
      if (file.sizeBytes !== offer.fileBytes || row.chunkSize !== offer.chunkSize) return null;
    }
    return {
      filename: file.name,
      fileBytes: file.sizeBytes,
      chunkSize: row.chunkSize,
      fileHash: file.contentHash,
      bitmap: row.receivedBitmap,
    };
  }

  private persistNew(transferId: string): void {
    const record = this.records.get(transferId);
    if (!record) return;
    const binding = this.bindings.get(record.peerKey);
    const resume = binding?.protocol.snapshot(transferId);
    const chunkSize = resume?.chunkSize ?? 0;
    const now = Date.now();
    this.safeDb(() => {
      if (this.client.db.transfers.get(transferId)) return;
      this.client.db.files.insert({
        id: transferId,
        name: record.filename,
        mimeType: record.mimeType,
        sizeBytes: record.totalBytes,
        contentHash: resume?.fileHash ?? new Uint8Array(0),
        localPath: record.direction === TransferDirection.OUTGOING ? record.localPath : null,
        width: null,
        height: null,
        durationMs: null,
        createdAt: now,
      });
      this.client.db.transfers.insert({
        id: transferId,
        fileId: transferId,
        peerId: this.client.peer(record.peerKey)?.session.peerId ?? record.peerKey,
        conversationId: null,
        direction: record.direction === TransferDirection.OUTGOING ? 'outgoing' : 'incoming',
        state: 'offered',
        chunkSize,
        totalChunks: chunkSize > 0 ? totalChunksFor(record.totalBytes, chunkSize) : 0,
        receivedBitmap: resume?.bitmap ?? null,
        bytesTransferred: 0,
        startedAt: now,
        completedAt: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      });
    });
  }

  private persistProgress(transferId: string, progress: TransferProgress | null): void {
    const record = this.records.get(transferId);
    if (!record) return;
    const terminal = progress === null;
    const last = this.lastPersistedAt.get(transferId) ?? 0;
    const now = Date.now();
    if (!terminal && now - last < PERSIST_INTERVAL_MS) return;
    this.lastPersistedAt.set(transferId, now);

    const binding = this.bindings.get(record.peerKey);
    const snapshot = binding?.protocol.snapshot(transferId);
    this.safeDb(() =>
      this.client.db.transfers.update(
        transferId,
        {
          state: dbStateFor(record),
          bytesTransferred: record.transferredBytes,
          receivedBitmap: snapshot?.bitmap ?? null,
          error: record.failure,
          ...(record.state === TransferState.COMPLETED ? { completedAt: now } : {}),
        },
        now,
      ),
    );
  }

  private persistCompleted(transferId: string, localPath: string): void {
    const now = Date.now();
    this.safeDb(() => {
      this.client.db.files.setLocalPath(transferId, localPath);
      this.client.db.transfers.update(
        transferId,
        { state: 'complete', receivedBitmap: null, completedAt: now, error: null },
        now,
      );
    });
  }

  private persistAll(): void {
    for (const record of this.records.values()) {
      this.lastPersistedAt.set(record.id, 0);
      this.persistProgress(record.id, null);
    }
  }

  /**
   * Bring back transfers that were still running when the app was last killed.
   *
   * They come back as PAUSED, which is the truth: nothing is wrong with them,
   * they simply need the other phone to be nearby again. An outgoing one cannot
   * resume by itself here - its source file may have been a temporary copy the
   * OS has since cleared - so it is shown as paused with a Stop, and is
   * re-offered only if the source is still readable.
   */
  private restoreInterrupted(): void {
    const rows = this.safeDb(() => this.client.db.transfers.active()) ?? [];
    for (const row of rows) {
      if (this.records.has(row.id)) continue;
      const file = this.safeDb(() => this.client.db.files.get(row.fileId));
      if (!file) continue;
      this.records.set(row.id, restoredRecord(row, file.name, file.mimeType, file.sizeBytes, file.localPath));
    }
    if (rows.length > 0) this.publish();
  }

  /** The database is a convenience here; a failed write must never stop bytes. */
  private safeDb<T>(fn: () => T): T | null {
    try {
      return fn();
    } catch {
      return null;
    }
  }
}

function dbStateFor(record: TransferRecord): Transfer['state'] {
  switch (record.state) {
    case TransferState.OFFERED:
      return record.paused ? 'paused' : 'offered';
    case TransferState.TRANSFERRING:
    case TransferState.VERIFYING:
      return record.paused ? 'paused' : 'transferring';
    case TransferState.COMPLETED:
      return 'complete';
    case TransferState.DECLINED:
      return 'declined';
    case TransferState.CANCELLED:
      return 'cancelled';
    case TransferState.FAILED:
    default:
      return 'failed';
  }
}

function restoredRecord(
  row: Transfer,
  filename: string,
  mimeType: string,
  totalBytes: number,
  localPath: string | null,
): TransferRecord {
  return {
    id: row.id,
    peerKey: row.peerId,
    peerName: nameForPeerId(row.peerId),
    direction: row.direction === 'outgoing' ? TransferDirection.OUTGOING : TransferDirection.INCOMING,
    filename,
    mimeType,
    totalBytes,
    transferredBytes: Math.min(totalBytes, row.bytesTransferred),
    percent: totalBytes > 0 ? Math.min(99, Math.round((row.bytesTransferred / totalBytes) * 100)) : 0,
    bytesPerSecond: null,
    etaMs: null,
    state: TransferState.TRANSFERRING,
    paused: true,
    localPath,
    failure: null,
    updatedAt: row.updatedAt,
  };
}

function nameForPeerId(peerId: string): string {
  const peer = useAppStore.getState().peers.find((p) => p.peerId === peerId || p.key === peerId);
  return peer?.displayName ?? '';
}

// ---------------------------------------------------------------------------
// One centre per client
// ---------------------------------------------------------------------------

/**
 * The client is created once for the app's lifetime, so the centre keyed to it
 * is too. A WeakMap rather than a module-level singleton so that a test - or a
 * second client in a future multi-profile build - does not inherit another
 * one's transfers.
 */
const centres = new WeakMap<AirLinkClient, TransferCenter>();

export function transferCenterFor(client: AirLinkClient): TransferCenter {
  const existing = centres.get(client);
  if (existing) return existing;
  const created = new TransferCenter(client);
  centres.set(client, created);
  return created;
}
