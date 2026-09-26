# Stability audit

What the code actually does today, why the six defects observed on real phones
happen, and what is being changed. Every claim below is a citation, not a guess.

Baseline before this work: `pnpm test` green — 1152 tests across
`packages/core` (585), `packages/games` (485), `tests` (27), `apps/mobile` (55).

---

## 1. Observed architecture

```
apps/mobile/src/client/AirLinkClient.ts     owns identity, radios, discovery, one PeerSession per peer
apps/mobile/src/client/ClientProvider.tsx   core events -> zustand store -> screens
packages/core/src/presence/registry.ts      NearbyRegistry: collapses the discovery stream into rows
packages/core/src/session/peerSession.ts    keys + reliability, BORROWS a link
packages/core/src/session/stateMachine.ts   ConnectionState, legal transitions, per-state timeouts
apps/mobile/src/screens/play/inviteCentre.ts  listens for GAME_INVITE
apps/mobile/src/screens/play/useGameRoom.ts   sends GAME_INVITE, runs the game
native/.../BleTransport.swift, LocalNetworkTransport.swift, *.kt
```

The core layer is in good shape. `PeerSession` genuinely owns keys and
reliability and merely borrows a link; `ConnectionStateMachine`
(`packages/core/src/session/stateMachine.ts:38`) already rejects illegal
transitions and already has per-state timeouts. **Nearly every defect observed
on real devices is in the app-layer wiring above it, not in the protocol.**

The single structural fault runs through all of them: **there is no stable
identifier for an installation.** Identity today is

| identifier | where | stable? |
|---|---|---|
| `peerId` (Ed25519 fingerprint) | `crypto/identity.ts` | yes — but **only known after the handshake** |
| `deviceId` | `identityStore.ts` | yes, but never travels in an advertisement |
| `advertisementToken` | 6 rotating bytes, `pairing/advertisementTokens.ts` | **rotates every 4 s; meaningless to a stranger** |
| `endpointId` | BLE peripheral UUID / Bonjour service name | per-transport, rotates, differs per platform |

So before a handshake completes there is **nothing** a device can compare
against itself, and nothing two transports can agree on. Self-filtering, peer
deduplication and "is this the peer I am already connected to?" are all
therefore built on the rotating token or on a service name — and all three fail
in the same conditions.

---

## 2. Root causes

### A — the device discovers itself

Two independent mechanisms, both name/token-shaped.

**A1. The JS self-filter is a bounded set of rotating tokens.**
`AirLinkClient.wireTransport` (`AirLinkClient.ts:412`) drops a discovery whose
token is in `ownTokens`. `ownTokens` is capped at 32 entries
(`AirLinkClient.ts:481`) and a new token is added **every 4 seconds**
(`AirLinkClient.ts:497`), so the set remembers roughly **128 seconds** of
advertising history. Any transport still publishing an older token — a Bonjour
listener that failed to re-register, an `NWListener` in `.waiting`, a BLE
advertisement whose restart threw at `AirLinkClient.ts:471` while the other
transports succeeded — is seen as a **stranger**, because its token has been
evicted. `Set.add` also does not re-order an existing member, so a repeated
token ages out on its *first* insertion.

**A2. The native self-filters are keyed on the service name.**
Android: `handleServiceFound` returns early only when
`name == registeredServiceName || name == requestedServiceName`
(`wifi/LocalNetworkTransport.kt:672`). `registeredServiceName` is set to `null`
on unregister (`:518`) and on re-registration failure (`:497`). The file's own
comment at `:462` states the consequence: a leaked registration means
"`handleServiceFound` stops recognising our own service". iOS has the same
shape via `registeredServiceNames` / `dropSelfFromEndpoints`
(`LocalNetworkTransport.swift:567–579`).

Both are correct while nothing goes wrong, and both fail open — into
self-discovery — precisely when the radio layer is under stress.

### B — "Unknown Device"

Three separate producers, one renderer.

**B1. The renderer.** `ClientProvider.tsx:66` —
`displayName: peer.displayName || 'Unknown device'`. Any peer with an empty
name is published to the store as a normal, connectable row. There is no
"unresolved" state; a partial advertisement is indistinguishable from a
complete one.

**B2. iOS emits deliberately empty discoveries.**
`BleTransport.swift:475` calls
`noteDiscovery(endpointId:, name: "", token: "", rssi: 0)` for every peripheral
returned by `retrieveConnectedPeripherals`. That reaches JS with **no token and
no name** — so it cannot be self-filtered (A1 matches on token) and it renders
as "Unknown Device".

**B3. An iPhone's token is not in its advertisement at all.**
`BleTransport.swift:406` — the rotating token lives in a GATT characteristic,
not in the advertisement, because iOS moves service data into an overflow area.
So every iPhone peer arrives token-less and nameless first
(`BleTransport.swift:1338–1356`), and is only completed later by an identity
read (`:1505`). The registry lists it immediately.

### C — a connected friend reappears with a Connect button  ← the worst one

This is a **key-namespace bug**, and the code already documents half of it
(`AirLinkClient.ts:641`, the doc comment on `peer()`).

- Outbound: `connect(peerKey)` → `createHandle(peerKey)` where `peerKey` is the
  **registry key** — `peerId` for a recognised friend, else `"ble:UUID"`.
- Inbound: `acceptIncoming` → `createHandle(link.endpointId)`
  (`AirLinkClient.ts:614`) — a **bare endpoint id**, no transport prefix.

So on the accepting side the handle key is `"A1B2-…"` while the registry key
for the same device is `"ble:A1B2-…"`. They never match.

The consequences chain:

1. `NearbyRegistry.setConnected(peerId, …)` (`registry.ts:266`) scans for an
   entry whose `entry.peerId === peerId`. A peer discovered as a **stranger**
   has `peerId === null` — it is never resolved, because `resolveToken` can
   only recognise an existing *friend*. So `connected` is **never set** for a
   first-time peer, and `sweep()` (`registry.ts:330`) evicts a live, connected
   peer 15 s after its advertisement stops.
2. `ClientProvider.tsx:63` rebuilds every row from
   `handle?.session.state ?? ConnectionState.DISCOVERED`. When the key lookup
   fails, a **connected** peer is republished as `DISCOVERED` → the row renders
   "Nearby / Connect".
3. That rebuild runs on **every** `peersChanged`, i.e. on every heartbeat from
   every transport (`presenceRefreshMs` = 5 s, several transports, several
   peers), and it also clobbers `quality` back to `null` each time.
4. Tapping the resulting Connect button calls `connect()` again, which opens a
   **second link** to a peer that already has a live session — and
   `acceptIncoming` on the far side only recognises a migration when
   `handle.session.currentLink?.endpointId === endpointId`
   (`AirLinkClient.ts:606`), which is false for a different transport. A second
   `PeerSession` is created for the same human.

There is no `isSelf`, no registry entry lifecycle tied to the session, and no
arbitration when both sides dial at once — `startAsInitiator` and
`startAsResponder` both simply throw if a session is already authenticated
(`peerSession.ts:269`, `:289`), and nothing catches that.

### D — the invitation never arrives  ← the reported showstopper

**Primary cause: nothing is listening.** `GameInviteCentre` is constructed
lazily by `inviteCentreFor(client)` (`inviteCentre.ts:231`), whose only callers
are `useInviteCentre()` → `PlayScreen.tsx:92`. Bottom-tab screens mount on
first focus. **If phone B has not opened the Play tab since launch, the object
does not exist**, no `session.on('message')` listener is attached, and
`GAME_INVITE` is decrypted, delivered and dropped on the floor. The file's own
header comment says exactly this: *"Mounting it once next to the navigator
would make an invitation reachable from any tab"*.

Compare `chatCenterFor(instance)`, which **is** called eagerly in
`ClientProvider.tsx:127` with a comment explaining why it must be. Invites were
never given the same treatment.

**Secondary causes, each sufficient on its own:**

- The invite UI is rendered only inside `PlayScreen`. Even with the centre
  alive, an invitation is invisible from Home, Chat, Share or You.
- `attach(peerKey)` (`inviteCentre.ts:169`) resolves through
  `client.peer(peerKey)` — the same broken namespace as defect C. On the
  accepting side the key mismatch means no listener is attached even when the
  centre exists.
- **There is no ACK.** The host blind-repeats `GAME_INVITE` every 3 s for 45 s
  (`useGameRoom.ts:465`) and then says "No answer". "Waiting for your
  friend…" is derived from nothing the receiver sent, so it cannot distinguish
  *not delivered* from *not answered*.
- An invite is silently auto-declined when `findGame`/`hasRenderer`/
  `protocolVersion` disagree (`inviteCentre.ts:203`) — correct, but invisible.
- `settled` (`inviteCentre.ts:126`) grows without bound.
- An invite carries no `inviteId`, no `expiresAt`, no sender/receiver — only a
  `sessionId` (`gameProtocol.ts:60`).

### D2 — three more discovery faults, found by a full read of the native layer

These were not visible from the TypeScript alone and are, between them, most of
what "connecting is flaky" looked like on Android.

**Android re-registered its Bonjour service under a new name every 4 seconds.**
`instanceName` was derived from the rotating token
(`wifi/LocalNetworkTransport.kt:419`), and the instance name **is** the
`endpointId`. So to every other phone this device became a brand-new peer every
four seconds; rows accumulated for the 15 s decay window, each with its own
Connect button; dialling an older one failed because that service had been
unregistered; and during the gap between unregister and re-register the
transport's own self-filter had no name to compare against and reported
**itself**.

**One transient NSD failure disabled Wi-Fi for the rest of the session.**
`onRegistrationFailed` reported `availabilityChanged(false)`
(`wifi/LocalNetworkTransport.kt:486`), which latched with nothing to unlatch it.

**Discovery was armed exactly once.** `startDiscovery()` skipped any transport
not available in that instant (`AirLinkClient.ts:313`) and never re-armed, so
turning Bluetooth on after launch did nothing at all.

### E — connecting is flaky

- `startAdvertising` is re-issued for **every transport every 4 s**
  (`AirLinkClient.ts:518`). On iOS `CBPeripheralManager.startAdvertising` is a
  restart, so there is an advertising gap every 4 s.
- `availability()` is awaited **inside** that 4 s loop, serially, per transport.
- No `connectionAttemptId` anywhere: a callback from an abandoned attempt is
  indistinguishable from a live one.
- Simultaneous connect has no arbitration at all (see C.4).
- `connect()` has a 20 s transport timeout (`AirLinkClient.ts:596`) *and* the
  state machine has a 20 s `CONNECTING` timeout — they race.

### F — the game screen scrolls, and the back gesture fires

- `GameRoomScreen.tsx:115` wraps the entire game in a **`ScrollView`**.
- `GameRoom` is registered with no `gestureEnabled` option
  (`AppNavigator.tsx:113`), so the native-stack default applies and a left-edge
  drag inside a game pops the screen.
- Every drag board uses the RN responder system without capture —
  `onStartShouldSetResponder` / `onMoveShouldSetResponder`
  (`AirHockeyTable.tsx:208`, `PoolTable.tsx:233`, `DrawAndGuessBoard.tsx:175`,
  `DartsBoard.tsx:172`, `WordDuelBoard.tsx:170`). The enclosing `ScrollView`
  can and does steal the gesture. `react-native-gesture-handler@3.2.1` is
  already a dependency and is not used by any board.

---

## 3. What changed

Each row landed with tests that fail without it.

| # | Change | Files |
|---|---|---|
| 1 | **`PeerIdentity` + `installationId`** — a persistent per-install UUID and a public-key fingerprint, carried in every advertisement | `core/src/presence/identity.ts` (new), `transport/types.ts`, `identityStore.ts`, native TXT/GATT |
| 2 | **One `isSelf()`** used by every transport, replacing three name/token filters. `DISCOVERY_IGNORED_SELF` logging | `core/src/presence/selfFilter.ts` (new), `AirLinkClient.ts` |
| 3 | **`PeerRegistry`** with resolution states `DISCOVERED_UNRESOLVED → RESOLVING_IDENTITY → DISCOVERED_VALID / IGNORED`; one logical peer across all transports; no unresolved peer reaches the UI | `core/src/presence/registry.ts` |
| 4 | **Connected means connected** — session lifetime pins the registry row, discovery of a connected peer updates metadata only and can never produce a Connect affordance | `registry.ts`, `AirLinkClient.ts` |
| 5 | **One handle namespace** keyed on peer identity, plus `connectionAttemptId` guards so stale callbacks are dropped | `AirLinkClient.ts`, `peerSession.ts` |
| 6 | **Deterministic arbitration** — lower `installationId` initiates; the loser yields without tearing down | `AirLinkClient.ts` |
| 7 | **Reliable invitations** — `inviteId`, `GAME_INVITE_ACK`, bounded exponential retry, idempotent delivery, a **global** `GameInviteManager` mounted next to the navigator and visible from any tab | `inviteCentre.ts`, `AppNavigator.tsx`, `ClientProvider.tsx`, `constants.ts` |
| 8 | **Game session handshake** — `gameSessionId`, `GAME_READY` from both sides, then `GAME_START`; `stateVersion` on every action with snapshot resync on mismatch | `gameProtocol.ts`, `useGameRoom.ts` |
| 9 | **`GameShell`** — fixed, non-scrolling, safe-area-correct, back-gesture disabled, explicit Exit, shared header/score/turn/rematch chrome | `screens/play/GameShell.tsx` (new) |
| 10 | **Core games fixed**, then a catalogue of latency-tolerant games with real metadata and categories | `packages/games` |
| 10b | **Leaving a game ends it.** `GameStatusKind.ABANDONED` and the database's `'abandoned'` state both existed from the start and neither was reachable, so a game somebody walked out of stayed `'active'` and kept offering to resume | `runtime.ts`, `repositories.ts`, `useGameRoom.ts` |
| 11 | **Chaos tests** — self-discovery, duplicate peers, connected-rediscovery, simultaneous connect, invite under 20 % loss | `packages/core/test`, `tests/` |

## 4. Method

The root causes above were found by reading, then confirmed by a second pass
whose only job was to **refute** each one against the code as it actually
stands. That pass killed eleven claims that read plausibly and did not hold —
among them "every BLE peer is an unmergeable Unknown Device", "Wi-Fi Direct
lists every device in range as a peer", and "a handshake error blanks the whole
app" — each of which had a guard elsewhere the first reading had missed. What
survives here is what survived that.

Where a fix is claimed below, it is claimed because a test fails without it.

### Verification

| | |
|---|---|
| `pnpm typecheck` | clean, all six packages |
| `pnpm test` | **1567 passed** (core 570, games 845, db 34, acceptance 27, app 91) — from 1150 |
| `./scripts/build-ios.sh` | `** BUILD SUCCEEDED **`, including every Swift and Objective-C++ change |
| Android | **not compiled** — there is no Android SDK on this machine, which is a pre-existing condition of the repo. The Kotlin is written against the verified API surface and reviewed. See `docs/ANDROID.md` |

The tests that speak directly to the six defects:

```
packages/core/test/discovery.test.ts      21  self-discovery, unknown devices, dedup,
                                              connected-rediscovery, arbitration
packages/games/test/resync.test.ts        16  a missed move, and that it repairs
apps/mobile/__tests__/invites.test.tsx     7  the invitation, end to end, under 20% loss
apps/mobile/__tests__/connection.test.tsx 12  one name per peer, no poisoned handles,
                                              a re-keyed session, a migration into silence
```

A defect worth naming, because it is the one a receiver cannot possibly notice:
when an action is applied locally and then never reaches the other phone -
`trySend` refused it, or the reliable channel gave up after eight attempts -
**nothing arrives out of order on the far side. Nothing arrives at all.** The
receiving device has no reason to suspect a thing. So the sender now watches its
own sends and subscribes to `deliveryFailed`, which nothing in the app listened
to before, and asks for the board as soon as there is a link to ask over.

`apps/mobile/__tests__/invites.test.tsx` is the one that matters most: it drives
two real `AirLinkClient`s with two real `PeerSession`s over a simulated radio,
and asserts that an invitation reaches a phone whose owner has never opened the
Play tab. That test fails against the old code.

### Two decisions worth stating

- **Pong and Air Hockey are demoted, not deleted.** They are moved to a
  `REAL-TIME` category marked "best connection required" and are not offered
  when the active transport is BLE. The catalogue is re-weighted towards
  turn/tap/choice games, which is what a 40 KB/s link can actually carry.
- **Nothing is rebuilt.** `PeerSession`, the handshake, the reliability layer,
  the game engine and the conformance suite are correct and are kept.

---

## 3b. What only showed up by running it

Five defects that 1565 passing tests and a clean typecheck could not have found,
each caught on two simulators and one physical iPhone.

**The generated TurboModule glue was never regenerated.** `discoveryId` was added
as a fourth argument to `startAdvertising` across the TypeScript spec, the Swift,
the Kotlin and the Objective-C++ — but codegen still declared `argCount = 3`, so
every advertisement threw `Exception in HostFunction`. The app searched for
peers and never advertised to any. The signal was in the build output the whole
time and was walked past three times:

```
warning: class 'RCTNativeAirLinkTransport' does not conform to
         protocol 'NativeAirLinkTransportSpec'
```

`scripts/build-ios.sh`'s own header warns about exactly this failure mode, in
those words, and says never to filter our own warnings. Fixed by re-running
codegen (`pod install`, which needs `LANG=en_US.UTF-8`).

**iOS wrote the discovery id and never read it.** The TXT record carried `d=…`;
nothing parsed it back, so `DiscoveredEndpoint.discoveryId` was always empty on
Apple devices and one phone appeared twice — once per local-network transport.
Android had the full round trip. Write-only on one platform is the kind of gap
that a test of the JavaScript cannot see, because the JavaScript was correct.

**Re-keying a handle broke pairing.** The session is re-keyed onto its peer id
the moment the handshake produces one, which is most of the fix for defect C —
but the six-digit prompt is raised *before* that, carrying the key the discovery
row had. "They match" then resolved to nothing, and both phones sat showing the
same code until the pairing timeout. The log was unambiguous: `state=pairing` at
18:14:05, `state=failed` at 18:16:05 — exactly 120 seconds. A handle now answers
to every name it has ever had.

**A 3x3 board rendered as 2 columns of nine.** `BoardSurface` keeps its padding
inside its own width, so three cells and two gaps come to precisely the inner
width — and flexbox wraps on `>`, not `>=`. Measuring the box instead of
computing it from the window made fractional widths normal, and one sub-pixel
sent the third cell onto its own line. Cell sizes are floored.

**A migration can reach nobody.** `migrateToLink` keeps the session keys and
assumes the peer still holds them too — true for a pocket or a transport
upgrade, false for a peer whose app restarted. The reconnect driver migrated
into that void repeatedly, because from this side a migration always
"succeeds": one phone showed a live green dot and "Your turn" while the other
showed that person as merely nearby. A migration is now provisional, and a link
that drops again without a single packet having arrived rebuilds the session
instead.

---

## 3c. App Store readiness, and what "with and without Wi-Fi" can honestly mean

A later pass prepared the app for submission and re-verified both link paths on
two simulators. Two bugs came out of it that were not in the original six.

**Blocking a stranger silently did nothing.** `SqliteTrustStore.block()` updated
its in-memory `records` map only when the peer was ALREADY a trusted friend -
`reload()` skips every row still at `trust_state = 'known'` - while `isBlocked()`
read only that map. So blocking a stranger returned success and changed nothing
for the rest of the session, and the live session was never refused. A stranger
is precisely who gets blocked. `MemoryTrustStore` in `packages/core` has carried
a separate `blocks` set from the start, with a comment saying a row claiming to
be blocked must also appear in the set "or `isBlocked` and `get` would disagree
about the same peer". They disagreed. Fixed by adding that set, hydrating it in
`reload()`, and making `get()` refuse a blocked peer's identity key.
`apps/mobile/__tests__/report.test.tsx` covers it.

**The Bluetooth banner said "Bluetooth is off" for four different facts.** Under
an "Open Settings" button, it said that to somebody who had DENIED the permission
- not a switch they forgot - and to hardware with NO Bluetooth radio, where
Settings can change nothing and the button was dead. `radioChanged` carried only
`available` and a `detail` string, and `publishRadioState` was putting the reason
IDENTIFIER ("unsupportedHardware") into the slot the UI shows a person, while the
other emit site used the human sentence. The event now carries `reason`, the
banner picks its wording from it, and the Settings button is absent where
Settings cannot help. `apps/mobile/__tests__/radioBanner.test.tsx` covers all
four reasons. This one mattered beyond tidiness: an App Review tester denies
permissions on purpose, and the banner is the first thing they see.

### What "without Wi-Fi" can and cannot prove on a simulator

Worth stating precisely, because the phrase invites a claim that cannot be made.
The iOS Simulator has no Bluetooth radio - `CBCentralManager` reports
`.unsupported`, which `BleTransport.swift:246` maps to `unsupportedHardware`. So
taking the Wi-Fi away from a simulator leaves ZERO transports. It can never
demonstrate a working connection without Wi-Fi; only the degraded state.

Developer Mode can now hold the non-BLE transports down
(`AirLinkClient.setWifiSuppressed`), which is the honest way to see that state
without switching off the Mac's own Wi-Fi - that hits both simulators at once,
kills the host's network, and does nothing at all on a Mac wired to Ethernet.
The suppression deliberately goes THROUGH the real availability path rather than
filtering `all()`: a transport that vanished from the list would exercise a code
path no phone ever takes. It reports the same `noLocalNetwork` reason
`LocalNetworkTransport.evaluate()` returns, stops advertising and discovery,
closes open links - two simulators talk over the host's loopback, so an
already-open TCP link would otherwise keep working and prove nothing - and
cannot be lifted by a native "the Wi-Fi is fine" report at the next path change.
`apps/mobile/__tests__/noWifi.test.tsx` covers all of it.

So the three tiers of evidence, kept apart:

| Claim | Evidence | Status |
|---|---|---|
| The whole journey works over local Wi-Fi | Two simulators, live: one row per peer, trusted re-recognition, connect, invite delivered, Four in a Row played to a finish with both boards agreeing and complementary outcomes | **Verified** |
| The protocol, crypto, games, resync and reconnect work at the Bluetooth floor | `tests/acceptance.test.ts`, ten scenarios over `BLE_LIKE_CONDITIONS` - 30 ms latency, 20 ms jitter, 1% loss, 180-byte MTU - plus 17 failure scenarios | **Verified in simulation** |
| The degraded no-transport state is honest | `noWifi.test.tsx`, and live: "No Bluetooth on this device" with no dead Settings button | **Verified** |
| The iOS BLE radio code itself | none | **NOT verified.** Needs two physical phones. |
| An iPhone talking to an Android over BLE | none; the Kotlin has never been compiled | **NOT verified.** |

The Swift identity record was at least executed: compiled standalone and run
against 200,000 fuzzed buffers plus every truncation of a valid record, with the
byte layout checked offset by offset and backward compatibility confirmed to
keep the token and name. That is the record, not the radio.

---

## 3d. "Couldn't connect" after both people tapped "They match"

Reported from two simulators meeting for the first time: the same six digits on
both, both confirmed, both databases recorded `trusted | sas`, the session was
Connected · Excellent underneath - and both screens said "Couldn't connect".
Three separate faults produced that one sentence, and fixing any one of them
alone left the symptom in place, which is why it survived the first attempt.

**The connect sheet timed out on the human.** "Securing" had a twenty-second
deadline, and PAIRING was counted as securing. But pairing is someone picking up
the other phone and reading six digits, not a handshake. `deadlineFor()` in
`ConnectSheet.tsx` now gives PAIRING no deadline; `PeerSession` keeps its own
120 s pairing timeout, so a pairing that really stalls is still reported by the
layer that knows. `apps/mobile/__tests__/connectSheet.test.tsx`.

**The pairing was resolved under a different name from the one it was raised
under.** `adoptIdentity` re-files a handle from its discovery key onto its peer
id when the session enters PAIRING. The six-digit prompt could be raised under
the discovery key and resolved under the peer id, so the store looked for the
wrong name, removed nothing, and the confirm screen waited out its backstop. A
handle now remembers the key its prompt was raised under (`pairingKey`) and
every resolution - paired, refused, discarded - uses that.

**A second `connect()` destroyed the ceremony on screen.** Found by reading the
receiving phone's activity log with a third simulator on the network:
`pairing inbound:2 · refused` in the same second as two disconnects. `connect()`
returned early only for CONNECTED, secure, CONNECTING and AUTHENTICATING, and
treated every other state as a corpse to discard and redial. PAIRING and
NEGOTIATING_TRANSPORT are not corpses. They are now in the in-progress set;
FAILED is still cleared and redialled, so a dead session cannot block a retry.

Both are in `apps/mobile/__tests__/pairingKey.test.ts` (eight cases, both event
orders), and `packages/core/test/pairing.test.ts` gained the three-phone case.
Verified live afterwards: first-time pairing A↔B, and Lucas↔Maria pairing while
Maria already had a friend, both landing on Connected with no error.

Two smaller things from the same round. **A photo in chat never reached the
other phone**: the receiver saw the offer, but nothing accepted a transfer the
chat had already vouched for, so the sender's bubble ended at "They never
answered". `TransferCenter.expect()` now lets the chat pre-accept the file it is
attached to. **Tab screens scrolled underneath the clock**: every header-less
screen cleared the notch with padding inside its scrolling content, which
scrolls away with everything else. `StatusBarBackdrop` in `ui/primitives.tsx`
holds that band, and the chat list uses it too.

**Seen once and not reproduced**: after the Mac had slept for hours, trusted
friends appeared as "New device" until the simulators restarted. The "cached
binding" and "stale TXT record" explanations were both tested and disproved; it
has not recurred. Separately, once, right after reinstalling the app on one
simulator, a friend was listed twice for about a minute - as "Maria · Nearby"
and as "Maria · New device" - and then merged by itself. Her two Bonjour records
were carrying tokens for two different friends at that moment, which is normal
for someone with two friends; the registry is now tested against exactly that,
in every order, and merges it correctly. A cold launch and a kill mid-session
both failed to reproduce it. Recorded here so it is not forgotten, not claimed
as fixed.

**Built but not yet exercised on a device**: voice notes end to end, the system
notification banner, and turning notification permission on and off. Recording
and playback rows are covered by `attachments.test.tsx`, and what gets announced
and badged by `unread.test.tsx`; the permission switch in Settings has no test
of its own. All of it compiles. A simulator cannot record from a microphone
convincingly, and the banner needs the app in the background with a peer still
connected, which iOS rarely allows for long. Worth checking in TestFlight.

---

## 3e. What two real iPhones found in an hour

TestFlight put the app on two physical phones for the first time, and both of
the things simulators could never exercise were broken. Neither had a test that
failed; both had tests that passed by stubbing the exact value that breaks.

**Voice notes never arrived, over any link.** `AVAudioRecorder.currentTime` is
seconds as a Double, so a duration in milliseconds is 3472.5623582766438. The
encoder validated `byteLength` and passed width, height and duration through
untouched; CBOR wrote the fraction as a legal float64; and the receiver's
decoder, which requires an integer, threw `DecodeError` and dropped the WHOLE
chat message before acknowledging it. That message is the one that calls
`TransferCenter.expect`, so the file was never auto-accepted: it waited as an
unanswered offer until the 120-second timeout turned the sender's bubble red,
with nothing whatsoever on the other phone. Photos were immune because they
carry no duration, which is why "everything works except audio".

Fixed at the seam where native values become app values (`audio.ts` rounds
duration and size), again in `voiceAttachment` for any other producer, and
structurally in `encodeAttachment`, which now refuses what its own decoder
refuses - so this class of defect fails in the sender's stack instead of
silently on the far side of a radio. Two more defects behind it, both of which
would have survived that fix: `files.insert` is INSERT OR REPLACE and the two
writers of a file row - the transfer layer and the chat announcement - erased
each other's knowledge in both arrival orders, so a received voice note drew as
0:00 (now `fillMedia`, a COALESCE update that can only fill holes); and nothing
told the conversation when an incoming transfer completed, so an arrived note
kept a play control that did nothing until some unrelated chat event happened
(the chat centre now subscribes to the transfer centre).

**Bluetooth with no Wi-Fi at all.** Two defects, one of which makes the app's
central promise impossible:

- **An iPhone was unidentifiable over BLE.** iOS will not put service data in
  an advertisement, so an advertising iPhone can say only "I speak this
  service". The token and discovery id live in a characteristic that can only
  be read over a connection - and the transport read it only AFTER connecting,
  which the user can only ask for once the peer is listed, which the registry
  only does once it is identified. Two iPhones with no Wi-Fi saw each other and
  stayed invisible, each row swept away after eight seconds. Over Wi-Fi this
  never showed, because the Bonjour TXT record carries both fields with no
  connection at all. `BleTransport.scheduleIdentityProbe` now resolves it the
  only way CoreBluetooth allows: connect, read the one characteristic,
  disconnect, re-announce - bounded to two at a time and one per peer per
  minute, because this is a radio and a battery.
- **A re-subscribe on a stale link left a phone half-connected.** A peripheral
  -role link has no liveness timer. When a central drops out of range and iOS
  does not deliver `didUnsubscribeFrom`, the old link survives; the peer comes
  back, subscribes again, and the handler returned early because a link was
  already open. Nothing was announced upward, so no handshake was answered, and
  `subscribedCentral` still pointed at the dead connection - the only object
  the send path has. Inbound writes still matched. The phone received messages
  and could not answer any of them. A re-subscribe from a different CBCentral
  now replaces the link; the same one merely refreshes its datagram size.

Both BLE fixes compile and are reasoned from the code. **Neither can be
verified here** - the simulator has no Bluetooth radio - so they are claims
until two physical phones in airplane mode say otherwise.

## 4. What was not done

Stated because a list of everything that went right is not an honest report.

- **Group games for three or more.** Secret Word and Vote both want them. The
  mesh layer exists, but every game in the catalogue is two-player and the game
  session, the invitation and the room are all built around a pair. That is a
  real piece of architecture, not a game, and doing it badly to add two titles
  would have cost more than it bought.
- **The rest of the game list.** Sequence Memory, Estimation, the Reaction
  variants, Number Guess, Grid Treasure, Maze Race, Colour Match, Odd One Out,
  Emoji Guess, Hangman, Categories, Draw Challenge, Story Chain, One Word Story
  and Truth Quiz are not built. Sixteen were, each with rules tests, a
  conformance run, a renderer and a review. The brief's own priority order put
  ten to fifteen polished games above thirty mediocre ones.
- **Two smaller findings in existing games are left standing**, and are worth
  naming rather than leaving in a review transcript:
  - **Pool declares itself `REALTIME` but resolves a whole shot inside
    `applyAction`**, so its `tick()` is unreachable and its table is
    byte-identical between shots. It works; it is not the thing it says it is.
  - **Air Hockey's `serveAt` is an absolute timestamp** in a clock no snapshot
    carries.
- **Android is still uncompiled**, as it was before. Everything else builds. No
  Android SDK is installed on this machine, so `BleWire.kt` - the other half of
  the cross-platform identity record - has never been compiled, let alone run.
  Both wire files are toolchain-independent (`BleIdentityRecord.swift` imports
  only Foundation, `BleWire.kt` only `java.util.UUID`), so a differential test
  that runs BOTH encoders on the same inputs and diffs the bytes is possible the
  moment a Kotlin compiler is installed. That is the cheapest way to de-risk
  iPhone-to-Android before touching a phone.
- **It has not been run on two PHYSICAL phones at once.** It has been run on two
  simulators and installed on one iPhone. The simulator has no Bluetooth radio,
  so every observation above is over the local network; the BLE paths, airplane
  mode, and an iPhone-to-Android pairing are still unexercised.
  `docs/TESTING.md` §5 is the checklist, rewritten around exactly these
  failures.
