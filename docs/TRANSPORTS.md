# Transports

The uncomfortable answer, first, because it shapes the whole product.

## 1. What actually works

Two phones, no internet, no router, no server. Researched against Apple and
Google documentation, the installed iOS 26.2 SDK headers, and Apple DTS
answers on the developer forums.

| Scenario | Transport | Realistic throughput |
|---|---|---|
| iPhone ↔ iPhone, no network | **Network.framework peer-to-peer** (`includePeerToPeer`, Bonjour, AWDL) | tens of MB/s |
| Android ↔ Android, no network | **Wi-Fi Direct** | several MB/s |
| **iPhone ↔ Android, no network** | **BLE — and nothing else** | **~5–40 KB/s** |
| Any ↔ any, shared local Wi-Fi | **Bonjour / NSD + TCP** | MB/s |
| iPhone ↔ Android, no network, bulk needed | **Android hotspot + iOS `NEHotspotConfiguration`** | MB/s |

So **BLE is the floor and everything must work on it.** A photo over Bluetooth
takes minutes, and the UI says so. Everything faster is an upgrade the user
never has to think about.

---

## 2. The abstraction

Every transport implements one interface
([`transport/types.ts`](../packages/core/src/transport/types.ts)):

```ts
interface Transport {
  kind; profile; events;
  availability(): Promise<TransportAvailability>;
  startAdvertising(record); stopAdvertising();
  startDiscovery(); stopDiscovery();
  connect(endpointId, options): Promise<Link>;
  shutdown();
}

interface Link {
  id; transport; endpointId; state; maxDatagramSize; isHighBandwidth;
  send(bytes, mode: 'reliable' | 'realtime'): Promise<void>;
  metrics(); close(reason);
}
```

The contract every implementation must honour:

1. **Datagram semantics.** A send of N bytes arrives as one receive of the same
   N bytes, or not at all. Stream transports (TCP, L2CAP) add their own length
   framing internally.
2. While a link is connected, reliable sends arrive in order and without
   duplication. Loss is signalled by a state change, never silently.
3. `maxDatagramSize` is honoured. Sending more **throws** rather than truncating.
4. Callbacks are never delivered re-entrantly from inside a `send`.
5. `close()` is idempotent and always eventually produces a closed state.

Chat, games, file transfer and watch-together are written against this and have
no idea which radio is underneath. Adding a transport is one file.

---

## 3. The transports

### BLE — the universal floor

Both platforms run **central and peripheral simultaneously**, because either
side may initiate. A GATT service exposes an RX characteristic (the central
writes into it), a TX characteristic (notifications to the central), and an
identity characteristic carrying the advertisement record and the L2CAP PSM.

**L2CAP is the fast path.** Apple DTS explicitly recommends connection-oriented
channels over GATT for bulk, and they interoperate with Android's
`createInsecureL2capChannel`. Since a channel is a byte *stream*, the transport
adds a length prefix to preserve datagram semantics. If L2CAP fails at any
point it falls back to GATT **without dropping the link**.

Throughput depends on MTU, connection interval and PHY, none of which iOS lets
an app control. Read what you were given (`maximumWriteValueLength(for:)`,
`maximumUpdateValueLength`) and never hardcode.

**Flow control is not optional.** Both platforms will silently drop data if you
write faster than the stack can drain: honour `canSendWriteWithoutResponse` and
`peripheralManagerIsReady(toUpdateSubscribers:)` on iOS, and serialise GATT
operations on Android — the stack allows exactly one outstanding operation per
connection.

### Local network — Bonjour / NSD + TCP

The cross-platform high-bandwidth path. iOS publishes with `NWListener` and
browses with `NWBrowser`; Android uses `NsdManager` (`registerServiceInfoCallback`,
not the deprecated `resolveService`). Both are DNS-SD and interoperate.

This is more useful than it sounds: plane Wi-Fi, a hotspot, or a home router
with no WAN all count. No internet is required — only a shared link.

TCP is a stream, so the transport length-frames with a 4-byte big-endian prefix
and a hard cap. No TLS: the AirLink protocol above is already end-to-end
encrypted and authenticated, so a second layer would add cost and no security.

### Apple peer-to-peer Wi-Fi

The same Network.framework code path with `includePeerToPeer = true`, which
brings up AWDL. Works with **no Wi-Fi network joined** — which is exactly the
airplane-mode case. Two requirements that are easy to get wrong: it only works
via Bonjour, and the flag must be set on **both** the listener and the
connection parameters.

Apple, TN3151, verbatim: the on-the-wire protocol "is not documented for
third-party use, so this only works between Apple devices." Android cannot join.

### Wi-Fi Direct

Android to Android. `WifiP2pManager`, `NEARBY_WIFI_DEVICES` on API 33+, then the
same length-framed TCP socket layer. No iOS equivalent exists.

### Hotspot handoff

The only high-bandwidth iPhone↔Android path with no network at all:

```
Android  startLocalOnlyHotspot()  →  SSID + passphrase over the existing BLE link
iPhone   NEHotspotConfiguration   →  one system tap
both     Bonjour + TCP            →  real Wi-Fi speed
```

The asymmetry is forced: iOS gives an app no way to *create* a hotspot, and
Android gives an app no way to silently *join* an arbitrary one. So Android
hosts and the iPhone joins.

### Wi-Fi Aware — declared, not used

The `WiFiAware` framework is genuinely present in the iOS 26.2 SDK. It also
requires a paid-team entitlement, service names baked into `Info.plist` at build
time, and a **one-time system pairing ceremony with a six-digit PIN per peer** —
so there is no zero-touch discovery. And iPhone↔Android Aware is broken in
practice on mainstream handsets: missing DCEA attributes, auth status 15, PINs
never displayed.

AirLink ships a capability-detecting adapter that reports it accurately as
unavailable, with an honest explanation. It does not build on it.

### Mock — how any of this is testable

[`transport/mock.ts`](../packages/core/src/transport/mock.ts) is an in-process
transport that reproduces every condition a radio inflicts: latency with jitter,
packet loss, reordering, duplication, bandwidth limits, MTU limits, abrupt
disconnection and reconnection. Combined with a virtual clock, it lets the whole
stack be exercised with N simulated devices, deterministically, in milliseconds.

Presets: `PERFECT_CONDITIONS`, `BLE_LIKE_CONDITIONS` (30 ms latency, 180-byte
MTU, 40 KB/s), `WIFI_LIKE_CONDITIONS`, `HOSTILE_CONDITIONS` (15% loss, 20%
reordering, 10% duplication).

---

## 3b. Presence is a heartbeat, not an edge

The one rule a new transport is most likely to get wrong, so it is written here
as well as on the type.

`peerDiscovered` must be re-emitted **at least every `TIMING.presenceRefreshMs`
(5 s)** for as long as the peer can be seen. `NearbyRegistry` expires a row
`TIMING.nearbyStaleAfterMs` (15 s) after its last sighting, and it has to: no
radio has a dependable "gone" signal — a phone in a pocket simply stops
advertising, and Bluetooth will never tell you it left.

That is free for a radio whose discovery is naturally **edge-triggered**: BLE
advertisements repeat every few hundred milliseconds, so every scan callback is
a fresh sighting. It is **not** free for one that is **level-triggered** —
Bonjour, where a record simply exists until it is withdrawn and the browser
reports it once. Those transports own a timer. Both local-network transports
have one (`NetworkTiming.presenceRefreshSeconds` on iOS,
`PRESENCE_REFRESH_MS` on Android).

This was a real defect and an instructive one, because it hid behind something
accidental. An **unpaired** device advertises a random token that changes every
four seconds, so its Bonjour TXT record changed constantly, the browser reported
a change every time, and presence looked perfect. The moment two devices
**paired**, the token became a five-minute-stable derivation, the TXT record
stopped changing, the events stopped — and a friend standing in the room
vanished from the list after fifteen seconds and could not be dialled. First
connection always worked; every one after it failed.

Re-announcing a peer that has actually gone is the cheaper error: the row is
untrusted, a dial to it fails gracefully, and the browser's own removal event
corrects it. Not re-announcing loses people who are standing right there.

---

## 3c. Every advertisement carries a discovery id

Sixteen hex characters, chosen once per app run and broadcast by every transport
that can carry any payload at all: the Bonjour TXT record on both platforms, and
the BLE identity characteristic (there is no room in a BLE advertisement, and on
iOS `CBPeripheralManager` honours only the local name and the service UUIDs
anyway).

It answers two questions that previously had no reliable answer:

**"Is this me?"** Bonjour is not selective — a listener and a browser on the
same device see each other — and an iPhone runs *two* local-network transports,
each of which browses and finds the other's service. This was previously guessed
at from a rotating token or a service name, and both guesses fail open, into a
phone listing itself as somebody to connect to. An exact value that does not
rotate cannot.

**"Is this the same phone I can already see on the other radio?"** One
installation broadcasts one discovery id everywhere, so a Bluetooth sighting and
a Wi-Fi sighting of the same stranger merge before either device has said a
word. The token can do this too, but only when both transports happen to be on
the same four-second rotation, and they are not.

It is deliberately **not** durable. A stable identifier broadcast in the clear
would let anyone in radio range log a phone's comings and goings across days,
which is precisely what the rotating token exists to prevent. Fresh on every
launch answers both questions completely and links nothing across time.

The persistent `installationId` — which already existed as `deviceId` — never
goes on the air at all. It travels inside the encrypted capability exchange, and
is what decides which of two phones dialling at the same instant yields.

Both records are versioned by a flag bit rather than a version number, so a
phone running an older build decodes everything it knew about and simply does
not see the new field. Two people on a plane cannot both update.

---

## 4. Negotiation and upgrade

Both peers exchange their supported transports inside the encrypted handshake.
The manager intersects the two lists, ranks the result by
`TransportProfile.preference` and expected throughput, and returns an **ordered
list of candidates** so a failed attempt falls through to the next.

Upgrading mid-session is the feature that makes the product feel effortless:

```
BLE session  →  a faster transport becomes available on both sides
             →  TRANSPORT_OFFER / ACCEPT over the existing session
             →  open the new link, probe it, require the response
             →  PeerSession.migrateToLink()
```

Four rules make it safe:

- **One initiator**, chosen deterministically (the lexicographically smaller peer
  id), so two phones do not both open a link and race.
- **Prove before you drop.** The new link must carry a probe and its response
  before the old one is released.
- **Every step has a timeout.** A silent peer cannot leave the session in limbo.
- **Failure is free.** If anything goes wrong the old link is still there and the
  session continues on it.

The property that makes this possible: `PeerSession` **owns** the session keys
and the reliability state and merely **borrows** a link. Swapping the link
replaces the borrowed part — the conversation, the queued messages and the game
in progress all survive, with no re-handshake. A test drops the link
mid-conversation, reconnects over a different transport, and asserts that not
one message is lost.

Downgrade works the same way: if the fast link dies, the session falls back to
BLE rather than ending.

---

## 5. What the user sees

Never a transport name, an RSSI or an MTU. Only:

```
Maria
● Connected
```

and a quality label — Excellent, Good, Weak, Reconnecting — derived from
latency, loss and signal. Developer Mode shows the raw numbers for anyone who
wants them.
