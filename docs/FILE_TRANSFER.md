# File transfer

Moving a 4 MB photo between two phones with no network — over a link that may
carry 180 bytes at a time, may be interrupted, and may be replaced mid-flight by
a faster one.

Implemented in [`packages/core/src/files`](../packages/core/src/files).

---

## 1. The flow

```
FILE_OFFER   → FILE_ACCEPT / FILE_DECLINE
             → FILE_CHUNK ×N  ⇄  FILE_CHUNK_ACK
             → FILE_COMPLETE
```

with `FILE_CANCEL`, `FILE_RESUME` and `FILE_ERROR` available at any point.

An offer is never auto-accepted. The receiver sees the name, the type and the
size, and decides.

---

## 2. Chunking that follows the link

The chunk size is derived from the **live** link's maximum payload, minus the
framing overhead. That matters because a transfer that starts on Bluetooth and
upgrades to Wi-Fi must **adapt mid-flight** rather than restarting: the same
transfer continues with much larger chunks, and the receiver does not care,
because chunks are addressed by index rather than by offset.

Chunks travel on the `BULK` channel, which is reliable but yields to `RELIABLE`,
so a 100 MB file cannot starve a conversation happening at the same time.

---

## 3. Integrity

Two levels, because they answer different questions:

- **Per chunk** — a digest travels with each chunk. A chunk that fails is
  re-requested rather than accepted, so corruption is caught immediately and
  costs one chunk.
- **Whole file** — a hash of the complete file, checked at `FILE_COMPLETE`. This
  is what proves the reassembly was correct, and it is the same hash the
  watch-together feature uses for content matching.

---

## 4. Resume

The receiver keeps a **bitmap** of the chunks it holds
([`bitmap.ts`](../packages/core/src/files/bitmap.ts)). It is exposed so the app
can persist it, which means a transfer interrupted at 80% resumes at 80% — even
after the app was killed, even over a different transport, even the next day.

`FILE_RESUME` carries the bitmap, and the sender sends only what is missing.

---

## 5. Flow control

A sliding window of in-flight chunks. Without it a fast sender drowns a slow
link and the reliability layer spends its life retransmitting; with it, the
window adapts to the measured round trip.

---

## 6. Progress and the honest ETA

Progress is reported as bytes, percentage and an estimated time — computed from
**measured** throughput rather than the transport's nominal rate, because the
nominal rate of a Bluetooth link is close to meaningless.

```
42.8 MB / 120 MB — 36%
```

This feeds a deliberate piece of UX: if the only link is Bluetooth and the file
is large, the app says so *before* the user commits, and mentions that sharing a
Wi-Fi network would be much faster. Letting someone start a forty-minute
transfer without telling them would be a worse sin than being slow.

An interrupted transfer shows **Paused**, not Failed, because it will resume.

---

## 7. Treating the peer as hostile

The sender chooses every field in an offer, so:

- an offer above a configured maximum size is refused;
- concurrent transfers are capped;
- a filename containing a path separator, a NUL or control characters is
  refused — the app is about to use that string to name a file on disk;
- a chunk index outside the declared range, or for an unknown transfer, is
  dropped;
- a chunk larger than the negotiated size is dropped.

---

## 8. No file I/O in the core

The module works against an injected interface with `readChunk` / `writeChunk`.
That keeps it fully testable in memory — the test suite moves a 500 KB file over
a simulated 180-byte-MTU link, interrupts it, and resumes it over a **new** link
— and lets the app plug in `react-native-blob-util` without the protocol
knowing anything about a filesystem.
