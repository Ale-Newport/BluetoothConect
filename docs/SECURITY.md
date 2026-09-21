# Security

AirLink invents no cryptography. It composes standard primitives from the
audited [`@noble`](https://github.com/paulmillr/noble-curves) suite into a
standard protocol, and everything below is implemented in
[`packages/core/src/crypto`](../packages/core/src/crypto) and tested in
[`crypto.test.ts`](../packages/core/test/crypto.test.ts).

---

## 1. Primitives

| Purpose | Primitive | Standard |
|---|---|---|
| Signatures | Ed25519 | RFC 8032 |
| Key agreement | X25519 | RFC 7748 |
| AEAD | ChaCha20-Poly1305 | RFC 8439 |
| AEAD (alternate) | AES-256-GCM | NIST SP 800-38D |
| Hash | SHA-256 | FIPS 180-4 |
| KDF | HKDF-SHA256 | RFC 5869 |
| MAC | HMAC-SHA256 | RFC 2104 |
| At-rest | XChaCha20-Poly1305 | draft-irtf-cfrg-xchacha |

ChaCha20-Poly1305 is the default rather than AES-GCM for a specific reason: a
software AES implementation is not constant-time, and on Hermes there is no
hardware AES to reach for. ChaCha20 is constant-time in pure JavaScript by
construction.

---

## 2. Identity

One long-term **Ed25519 key pair per installation**. Its public key *is* the
user's durable identity. The public peer id is
`base32(SHA-256("AirLink-v1-peer-id" ‖ publicKey)[0..10])` — 16 characters,
self-certifying, and revealing nothing about the device.

Deliberately **not** used as an identifier: MAC address, IDFV, IDFA, ANDROID_ID,
IMEI, phone number, email. There is no account and no server to have one on.

The secret key is generated on device, stored in the platform keystore
(Keychain on iOS, Keystore-backed on Android), and never leaves.

---

## 3. Handshake

A **SIGMA-I** authenticated key exchange. An ephemeral X25519 exchange
establishes a shared secret; each side then proves its long-term identity by
signing the handshake transcript *inside* the resulting encrypted channel. This
is the structure IKEv2 uses and, in spirit, TLS 1.3.

```
  I → R   INIT    { version, ephemeralPublicKey_I, nonce_I, aead }
  R → I   RESP    { version, ephemeralPublicKey_R, nonce_R }

          both derive from ECDH(e_I, e_R), bound to the transcript hash

  R → I   AUTH_R  AEAD{ identityKey_R, sign_R(transcript), capabilities_R }
  I → R   AUTH_I  AEAD{ identityKey_I, sign_I(transcript), capabilities_I }
```

The transcript hash binds the prologue, the negotiated version, both ephemeral
keys and both nonces, in a fixed order with explicit domain separation:

```
H = SHA-256( "AirLink-v1-handshake"
           ‖ version ‖ 0x01 ‖ e_I ‖ n_I
                     ‖ 0x02 ‖ e_R ‖ n_R )
```

Key schedule:

```
okm = HKDF-SHA256(ikm = ECDH, salt = H, info = "AirLink v1 traffic keys", 104 bytes)
    → k_I→R (32) ‖ prefix_I→R (4)
    ‖ k_R→I (32) ‖ prefix_R→I (4)
    ‖ sessionId (8) ‖ sasSeed (32)
```

### What this gives

| Property | How |
|---|---|
| **Mutual authentication** | Neither side can claim an identity it has no secret key for. |
| **Forward secrecy** | Ephemeral keys are wiped after the handshake. A later identity-key compromise does not decrypt yesterday's chat. |
| **Identity hiding** | Identity keys travel inside the encrypted AUTH messages, so a passive observer learns nothing. |
| **Replay resistance** | Fresh ephemerals and nonces every attempt; a recorded handshake cannot be replayed into a live session. |
| **Reflection resistance** | A peer presenting our own ephemeral key, or our own identity key, is refused. |
| **Contributory behaviour** | An all-zero or low-order X25519 result is refused (RFC 7748 §6.1). |

### What it deliberately does not give

It cannot protect a **first** meeting from an active attacker without user
involvement. That is impossible without a prior shared secret. Which is exactly
why first contact requires one of the two flows below.

---

## 4. First contact

An attacker relaying a first handshake necessarily runs **two** exchanges, and
therefore produces **two different transcripts**. Both mitigations exploit that.

### QR code — strongest

One device shows a QR carrying `{ version, peerId, identityKey, displayName,
issuedAt }` plus a self-signature. The other scans it. The identity key arrives
**out of band**, so there is nothing for an attacker in the middle to substitute.
Codes expire, and the parser validates signature, version, field lengths and age
before trusting anything.

### Six-digit code

```
sasCode = HKDF-SHA256(sasSeed, info = "AirLink v1 SAS", 8 bytes) mod 10⁶
```

Both users read out the same six digits. Under a man-in-the-middle the two
transcripts differ, so the two codes differ, and the users stop. This is the
same construction ZRTP, Matrix and WebRTC use. The bias from reducing 8 bytes
modulo 10⁶ is below 2⁻⁴⁰ — irrelevant next to the 1-in-10⁶ guessing probability
a six-digit code inherently accepts.

A test in the suite runs a real MITM — attacker M handshakes with A and
separately with B — and asserts the two codes differ.

### Every meeting afterwards

The identity key is stored. On the next meeting the handshake **requires that
exact key**, and aborts if it differs. A repeat meeting is therefore immune to
an active attacker with **zero** user interaction — which is the whole point of
a friend-first product, and the reason two phones reconnect silently on a plane.

---

## 5. Traffic protection

Per-direction keys and per-direction nonce prefixes, so a counter value is never
reused with the same key and a packet cannot be reflected back at its sender.

```
nonce[0..4)  = per-direction prefix from the key schedule
nonce[4..12) = 64-bit big-endian packet counter
```

Handshake AEAD invocations use counter 0; application traffic starts at 1, so a
handshake ciphertext can never collide with a data packet.

**Replay protection** is a 1024-entry sliding window following RFC 6479 — the
algorithm IPsec uses. Out-of-order packets inside the window are accepted; a
repeat, or anything older than the window, is dropped. Critically, the window is
advanced **only after the tag verifies**, so a forged packet cannot poison it.

Replay, forgery and corruption are deliberately **indistinguishable** to the
caller: `open()` returns null for all three, so nothing leaks through error
handling.

---

## 6. Hostile input

Every byte from a peer is untrusted, and the codebase is written that way:

- bounded decoders everywhere — depth, collection size, string length, buffer size;
- `Handshake` is a strict state machine from which the **only** exception that can
  escape is `HandshakeError`, verified by a fuzz test that feeds it 500 random
  byte strings;
- the CBOR decoder is fuzzed with 3000 random inputs per run;
- a malformed packet is **dropped**, never fatal — the radio, not the peer, is
  the likeliest culprit;
- game actions are validated on **both** devices, so a peer cannot make an
  illegal move by skipping its own validation;
- a peer's claimed player id is ignored; the authenticated session decides who
  sent an action.

---

## 7. Privacy

| | |
|---|---|
| Account required | none |
| Data leaving the device | only what the user explicitly sends to a peer |
| Telemetry / analytics | none |
| Location, contacts, phone number, email, advertising id | never collected |
| Message content | stays in local SQLite |
| Diagnostic log | in-memory ring buffer, local only, shown in Developer Mode |

**Advertisement tokens.** A Bluetooth advertisement is a broadcast, so a durable
identifier in it would let anyone follow the device around. AirLink instead
advertises a truncated MAC over a per-friend pairing secret and a coarse
timestamp: a friend can recognise it, nobody else can, and it rotates every five
minutes. Two friends see two different tokens for the same device, so they
cannot collude to confirm they saw the same phone. Within one rotation window
the token is constant, so this is unlinkability against a casual observer, not
against one watching a fixed location continuously — stated plainly in
[`advertisementTokens.ts`](../packages/core/src/pairing/advertisementTokens.ts).

**Discovery ids.** Every advertisement also carries sixteen hex characters
identifying the installation *for the length of one app run*. It exists because
the questions "is this advertisement my own?" and "is this the same phone I can
already see on the other radio?" had no reliable answer before a handshake, and
the guesses that stood in for one failed open — into a phone listing itself as a
device to connect to, and into one person appearing four times.

A durable identifier would have answered both and would have been a real
regression: broadcast in the clear, it would let anyone in radio range log a
phone's comings and goings across days, which is exactly what the rotating token
exists to prevent. A value regenerated on every launch answers both questions
completely and links nothing across time. **Within one run it is constant**, so
an observer watching continuously can tell that two sightings an hour apart are
the same session — the same limitation the token has, and for the same reason
that the alternative is worse.

The persistent `installationId` is never broadcast at all. It travels only
inside the encrypted capability exchange, after both sides have authenticated.

---

## 8. User controls

Block a device (refused *before* the handshake begins), remove a friend, reject
an incoming connection, clear a conversation, clear all history. A blocked peer
cannot reach any part of the stack.

---

## 9. Known limitations

Stated rather than hidden:

1. **First contact needs the user.** A QR scan or a compared code. There is no
   way round this without a prior shared secret.
2. **Six digits is six digits.** A one-in-a-million chance an attacker guesses.
   The QR path avoids it entirely.
3. **Metadata is visible to a local observer.** That two devices are talking, and
   roughly how much, is not hidden. Contents are.
4. **No post-compromise recovery.** A device whose identity key is stolen must
   re-pair. Session rekeying exists; identity rotation does not, yet.
5. **At-rest encryption depends on the platform.** The identity key is in the
   platform keystore; the message database relies on the OS's file protection
   rather than an app-level passphrase.
