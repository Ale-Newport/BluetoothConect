# AirLink Protocol v1

The wire format, end to end. Everything here is implemented in
[`packages/core/src/protocol`](../packages/core/src/protocol) and exercised by
[`packages/core/test/codec.test.ts`](../packages/core/test/codec.test.ts).

The protocol is **transport-independent**. Nothing below assumes Bluetooth, TCP
or anything else — only that the transport delivers **datagrams**: a send of N
bytes arrives as one receive of the same N bytes, or not at all.

---

## 1. Layering

```
  Transport datagram
    └── Frame                 HANDSHAKE | SECURE | FRAGMENT | BEACON
          └── (SECURE)        AEAD(sessionId, counter, ciphertext‖tag)
                └── Envelope  channel, flags, seq, ack, type, timestamp, payload
                      └── Payload   CBOR map, or raw bytes for chunked media
```

Each layer is independently testable, and each is. The fragmentation layer never
sees plaintext; the envelope layer never sees a radio.

---

## 2. Frame

Every transport datagram carries exactly one frame. The first two bytes are
always the same, so a receiver can classify a frame before trusting anything
else in it.

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | `protocolVersion` |
| 1 | 1 | `frameType` |

```
0x01  HANDSHAKE   plaintext key-exchange message; only valid before a session exists
0x02  SECURE      AEAD-protected application frame
0x03  FRAGMENT    a slice of a larger SECURE frame, for small-MTU transports
0x04  BEACON      plaintext, unauthenticated presence beacon; carries no private data
```

A frame whose version is **newer** than this build understands is rejected at
this layer. Version *negotiation* happens in the handshake, where both sides can
still talk about it.

### 2.1 SECURE

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | `protocolVersion` |
| 1 | 1 | `0x02` |
| 2 | 8 | `sessionId` |
| 10 | 8 | `counter` (uint64, big-endian) |
| 18 | … | ciphertext ‖ 16-byte AEAD tag |

Bytes `0..18` are passed to the AEAD as **associated data**, so the version,
frame type, session id and counter are all authenticated even though they travel
in the clear. Altering any of them makes the tag fail.

### 2.2 FRAGMENT

| Offset | Size | Field |
|---|---|---|
| 0 | 1 | `protocolVersion` |
| 1 | 1 | `0x03` |
| 2 | 2 | `packetId` (uint16) |
| 4 | 2 | `index` (uint16) |
| 6 | 2 | `count` (uint16) |
| 8 | … | fragment bytes |

Fragments carry pieces of a **complete SECURE frame**, so reassembly produces
something that goes straight back through `decodeFrame`. Fragmenting after
encryption means a lost fragment costs one retransmission of one packet rather
than corrupting a partially-authenticated message.

The reassembler is bounded on every axis a peer controls: in-flight packets,
fragments per packet, total buffered bytes (256 KiB), and a 30-second timeout.
Exceeding any of them discards rather than allocates.

---

## 3. Envelope

The plaintext inside a SECURE frame.

```
u8       channel        0 CONTROL · 1 RELIABLE · 2 REALTIME · 3 BULK
u8       flags
[lenBytes senderId]      only when HAS_SENDER      (group relay)
[lenBytes destinationId] only when HAS_DESTINATION (group relay)
varint   seq            per-channel sender sequence; 0 on unsequenced channels
varint   ack            highest contiguous sequence received on RELIABLE
u32      ackBits        selective acknowledgement bitfield
varint   messageType
varint   timestamp      sender wall-clock ms, whole milliseconds
lenBytes payload
```

Flags:

| Bit | Meaning |
|---|---|
| 0 | `HAS_SENDER` — an explicit sender id follows |
| 1 | `NEEDS_ACK` — sender expects acknowledgement |
| 2 | `RETRANSMIT` — this is a resend |
| 3 | `RAW_PAYLOAD` — payload is raw bytes, not CBOR |
| 4 | `HAS_DESTINATION` — an explicit destination id follows |

`timestamp` is **advisory**. It is shown to the user and never used for ordering
or for any security decision; a peer controls it.

### 3.1 Channels

| Channel | Guarantee | Used for |
|---|---|---|
| `CONTROL` | best effort, never retried | ping/pong, acks, clock sync, goodbye |
| `RELIABLE` | exactly once, in order, retried across reconnects | chat, game moves, control |
| `REALTIME` | best effort, **coalescing** | game state, paddle positions |
| `BULK` | reliable, yields to `RELIABLE` | file chunks |

`REALTIME` deliberately does not queue. A newer message with the same coalesce
key **replaces** the one waiting, so a congested Bluetooth link shows the current
paddle position rather than a backlog of stale ones. `BULK` exists so a 100 MB
file cannot starve a conversation.

### 3.2 Acknowledgement

`ack` is the cumulative watermark: everything up to and including it has been
delivered in order. `ackBits` bit *i* additionally confirms sequence number
`ack + 2 + i` — the window starts two past the watermark because `ack + 1` is by
definition the packet that is missing. One lost packet out of a burst of forty
therefore costs one retransmission, not forty.

Retransmission timeout follows the standard RFC 6298 SRTT/RTTVAR estimator, with
Karn's algorithm: a retransmitted packet yields no RTT sample.

---

## 4. Message types

| Range | Group |
|---|---|
| `0x01–0x08` | control: PING, PONG, ACK, ERROR, BYE, CLOCK_SYNC_REQUEST/RESPONSE, KEEPALIVE |
| `0x10–0x14` | session: HELLO, HELLO_ACK, CAPABILITIES, PRESENCE, PROFILE_UPDATE |
| `0x20–0x27` | messaging: MESSAGE, TYPING, DELIVERY_RECEIPT, READ_RECEIPT, REACTION, MESSAGE_DELETE, history |
| `0x30–0x3e` | games: GAME_INVITE/ACCEPT/DECLINE/STATE/EVENT/END/SYNC_REQUEST/INPUT/LEAVE, then INVITE_ACK, RESPONSE_ACK, READY, START, REMATCH_REQUEST/ACCEPT |
| `0x40–0x48` | files: FILE_OFFER/ACCEPT/DECLINE/CHUNK/CHUNK_ACK/COMPLETE/CANCEL/RESUME/ERROR |
| `0x50–0x5a` | sync: SYNC_CREATE/JOIN/LEAVE/PLAY/PAUSE/SEEK/RATE/HEARTBEAT/CONTENT_QUERY/REPLY/END |
| `0x60–0x66` | groups: GROUP_CREATE/UPDATE/MEMBER_JOIN/MEMBER_LEAVE/RELAY/STATE_REQUEST/RESPONSE |
| `0x70–0x74` | transport: TRANSPORT_OFFER/ACCEPT/READY/FAILED/SWITCH |

**An unknown message type is ignored, not an error.** That single rule is what
lets a newer build talk to an older one: v2 can send message types v1 has never
heard of, and v1 carries on with the conversation.

### 4.1 An invitation is acknowledged before it is answered

`GAME_INVITE` carries an `inviteId` of its own, distinct from the game session
it would create, and the receiving device sends `GAME_INVITE_ACK` **the moment
it decodes one** — before a human has looked at it, and again on every repeat.

That receipt is not a nicety. Without it the asking phone could not tell "never
arrived" from "not answered yet", so it said *"Waiting for your friend…"* for
forty-five seconds in both cases and then claimed there had been no answer —
including in the case where the invitation had been delivered to a device that
had nothing listening for it at all. With it, the screen can say *Sending*, then
*Delivered*, then *Waiting for Maria*, and each of those is true.

The invite id is what makes a repeat safe. The asking phone retries on a bounded
exponential backoff until the acknowledgement arrives; the answering phone keys
everything on the id, so twenty copies of one invitation produce one question,
one row, and twenty acknowledgements.

### 4.2 Actions carry the version they expect

`GAME_EVENT` carries `n`, the `stateVersion` the action expects to be applied on
top of, and `GAME_STATE` carries the whole envelope: the board, the per-player
sequence vector, the version and the elapsed time.

The sequence vector is the part that was missing. Per-player sequence numbers
give an action exactly-once semantics, and a gap in them is not survivable on
its own — the missing action is never coming, so every action after it is
rejected for ever while the board still looks healthy. A snapshot that carried
only the board corrected the position and left the game just as dead.

---

## 5. Serialisation

Payloads are **canonical CBOR** (RFC 8949), implemented from scratch in
[`cbor.ts`](../packages/core/src/protocol/cbor.ts) — about 300 lines, no
dependencies, identical on Node and Hermes.

Why not JSON: a chat message in JSON costs roughly twice what it costs in CBOR,
and over a Bluetooth link with ~180 usable bytes per packet that is the
difference between one packet and two. Why not Protocol Buffers: a schema
compiler and a code-generation step, for a saving that CBOR already captures.

The encoder is **deterministic**: map keys are sorted length-first then
bytewise, so two peers encoding the same value produce identical bytes and can
hash them independently.

The decoder assumes its input is hostile:

- indefinite-length items are rejected outright (a canonical encoder never emits
  them, and accepting them only widens the attack surface);
- depth, collection size and string length are all capped;
- `__proto__`, `constructor` and `prototype` are refused as map keys;
- duplicate map keys are refused;
- trailing bytes after the top-level item are refused.

A fuzz test feeds it three thousand random byte strings per run and asserts that
nothing but a `DecodeError` ever escapes.

Raw binary payloads — file chunks, game snapshots — skip CBOR entirely and set
`RAW_PAYLOAD`.

---

## 6. Versioning

Every frame carries `protocolVersion`. During the handshake both sides state
their version and the session runs at `min(ours, theirs)`. Capability exchange
then narrows further: features, games (each with its own
`gameProtocolVersion`), and transports are all intersected, and nothing is ever
sent to a peer that did not advertise support for it.

Adding a message type, adding a field to a CBOR payload, or adding a transport
are all **backward compatible**. Changing the meaning of an existing field is
not, and requires a version bump.
