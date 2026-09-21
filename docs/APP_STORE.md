# Putting AirLink on the App Store

Written for a first-time publisher. It assumes you have never opened App Store
Connect, and it says when something is a genuine hard requirement rather than
advice.

Two ground rules before anything else.

**You cannot submit with a free Apple ID.** A free account ("Personal Team")
signs builds for phones you own and nothing more. It cannot issue the Apple
Distribution certificate a store build is signed with. The $99/year Apple
Developer Program is a hard prerequisite for every step below. As a side
benefit, the seven-day provisioning expiry you have been hitting becomes a year.

**Where a rule involves a legal declaration — export compliance, the privacy
label, the age rating — this document tells you what is true about *this*
codebase and points you at Apple's own current wording.** Apple moves the exact
questions around, and a wrong answer to the encryption question is a false
statement to a government, not a form-filling slip. Read the questions as they
appear on screen.

---

## Part 1 — What has already been done for you

These were blockers or near-blockers in the repo. They are fixed and verified.

| Fixed | Why it mattered |
|---|---|
| App icon flattened to opaque RGB | It was 1024×1024 **RGBA**. An alpha channel in the app icon is the automated `ITMS-90717` rejection — the upload fails before a human sees it. Alpha was 255 everywhere, so the flatten is provably lossless. |
| `ITSAppUsesNonExemptEncryption` = `true` added | Without it, every single upload stops and asks. `true` is the correct answer here; see Part 3. |
| `NSMicrophoneUsageDescription` removed | Declared a permission for voice messages that do not exist anywhere in the codebase. Requesting a permission for an absent feature is a rejection under 5.1.1. |
| `NSPhotoLibraryAddUsageDescription` removed | Save-to-photos is gated on `Platform.OS === 'android'`, so on iOS the permission was unreachable. |
| `_airlink._udp` removed from `NSBonjourServices` | Nothing advertises or browses it. |
| `TARGETED_DEVICE_FAMILY` → iPhone only | It shipped as universal with **no iPad layout** and iPad landscape enabled. That forced a second set of screenshots and handed App Review an iPad on which to find a layout bug. |
| `MARKETING_VERSION` → `1.0.0` | `0.1.0` reads as pre-release to a reviewer. |
| Bundle id → `com.alejandronewport.airlink` | `com.airlink.app` is owned by another account and Apple refuses to register it. This is the identifier your account already holds. **It is immutable once an app record exists against it** — change it now if you want something else. |
| `CODE_SIGN_IDENTITY` "iPhone Developer" → automatic signing | A pinned *development* identity is the wrong certificate for a store build. |
| `scripts/archive-ios.sh` added | There was no way to produce an uploadable build at all. |
| "Report and block" added to chat | Guideline 1.2 requires a way to report content and block the sender. See Part 4. |
| Two trademarked game titles renamed | "Battleship" and "Connect Four" are Hasbro trademarks (5.2.5). Now "Fleet Hunt" and "Four in a Row". The internal `id`s are unchanged, so compatibility is intact. |

Two real bugs were found while doing this, both fixed with tests:

- **Blocking a stranger silently did nothing.** `SqliteTrustStore.block()` updated
  its in-memory map only if the peer was *already a trusted friend*, while
  `isBlocked()` read only that map. A stranger — precisely who you block — was
  reported blocked and was not, for the rest of the session, so the live session
  was never refused. The in-memory store in `packages/core` has always carried a
  separate `blocks` set for exactly this reason; the SQLite one was missing it.
- **The Bluetooth banner told four different lies.** "Bluetooth is off" with an
  "Open Settings" button was shown for a *denied permission* (not a switch the
  user forgot) and for *hardware with no Bluetooth radio* (where Settings can
  change nothing — a dead button). A reviewer denies permissions on purpose, so
  this was the first thing they would have seen. `radioChanged` now carries the
  reason and the banner picks its wording and whether to offer Settings.

---

## Part 2 — What you must do, in order

Do these in sequence. Each is blocked behind the one before it.

### 1. Enrol in the Apple Developer Program — **start today**

developer.apple.com/programs → Enroll, or install the free **Apple Developer**
app on your iPhone and enrol there (it verifies your identity with your ID and
Face ID in one pass, which is faster and less error-prone).

- Choose **Individual / Sole Proprietor**, not Organization. Organization needs
  a legal entity and a D-U-N-S number, takes weeks, and gives one person nothing.
- Your Apple Account needs two-factor authentication on, and the legal name must
  match your payment method.
- $99/year, auto-renewing. No free tier, no one-off option.
- Often approved in minutes, but identity verification can take a week. **This
  is why it goes first — you cannot shorten the wait, and everything else waits
  on it.**
- Once in, sign in at appstoreconnect.apple.com and accept the licence agreement
  under **Business → Agreements**. An unaccepted agreement silently blocks uploads.
- In Xcode → Settings → Accounts your paid team appears as a *second* team beside
  "(Personal Team)". Select the paid one from then on.

### 2. Check the name "AirLink" is available

App Store Connect will tell you when you create the record. Search the App Store
for "AirLink" first. Be aware the bundle-id collision is evidence the name is
contested — `com.airlink.app` already belongs to someone. Also do a quick
trademark search; a name dispute after launch is far more expensive than
choosing differently now. Everything user-visible comes from
`packages/config/src/brand.ts`, so renaming is one file plus the bundle id.

### 3. Stand up a support page and a privacy policy

**Both URLs are mandatory.** App Store Connect will not let you submit without
them. GitHub Pages is free, permanent and entirely adequate:

1. New **public** repo, e.g. `airlink-support`.
2. Add `index.md` (support) and `privacy.md` (privacy policy).
3. Settings → Pages → Deploy from a branch, `main`, `/` (root).

Do **not** use a Notion page or a Google Doc — they redirect or demand sign-in,
and a reviewer treats that as no policy.

The privacy policy is unusually easy to write honestly here: AirLink collects
nothing, has no servers, no accounts and no analytics, and makes no internet
connections; messages, files and keys live only on the two devices and are
end-to-end encrypted; camera, photo library, Bluetooth and local network are
used only for the purposes in the permission prompts (lift that wording straight
from `Info.plist`); nothing goes to any third party; deleting the app deletes the
data. Date it and put a contact email on it.

### 4. Set your support email in the repo

`packages/config/src/brand.ts` has `supportEmail` and `supportUrl` set to
`example.invalid` placeholders. **The in-app report flow hides the "Email the
developer" button entirely while the placeholder is there** — deliberately,
because sending somebody who has just been harassed to a dead mailbox is worse
than offering nothing. Set them to a real address and URL.

I did not fill these in for you: publishing an email address inside a shipped
binary is your decision, not a default. Consider a dedicated address rather than
your personal one.

### 5. Create the app record

App Store Connect → Apps → **+**.

- **Platform** iOS, **Name** your app name, **Primary language** English (or
  Spanish — whichever your listing is written in).
- **Bundle ID** pick `com.alejandronewport.airlink` from the list. If it is not
  there, register it first under Certificates, Identifiers & Profiles →
  Identifiers.
- **SKU** anything private and permanent, e.g. `airlink-ios-1`.
- **Category** primary **Social Networking**, secondary **Games**.
  Reasoning: the primary category drives your ranking, and Games is the most
  brutally competitive part of the store where an indie board game charts
  nowhere, whereas "offline peer-to-peer messaging" is a distinctive position.
  It also matches the actual pitch. The trade-off is that Social Networking
  invites the reviewer to apply the UGC rules in 1.2 — which they may apply
  anyway. Categories can be changed with any future version; the name, SKU and
  bundle id cannot.

### 6. Screenshots

Now iPhone-only, so you need **one** set instead of two.

Do not pre-render a hundred images. Open the version page → Previews and
Screenshots and **read the dimensions the form asks for** — Apple changes them
with each hardware generation, and the form is always current. Supply three to
five (minimum one, maximum ten).

The reliable way to get pixel-perfect files: boot the largest iPhone simulator
the form names and press **⌘S** in the Simulator. No scaling, no borders.

For a two-phone app this is genuinely awkward. The trick is the one used in this
session: **run two simulators and use one as the peer.** Screenshots must show
the real app (2.3.3) — captions and frames are fine, but a screenshot that is
mostly marketing text is a rejection.

**A set is already made**, in `docs/app-store-screenshots/`: five PNGs at
1320 × 2868 (the 6.9" size, taken on an iPhone 16 Pro Max simulator running the
Release build), flattened to RGB with no transparency, clock at 9:41. They show
the real app talking to a second simulator. If the form asks for a different
size by the time you submit, retake them the same way rather than scaling these.
Avoid the Home tab for a screenshot taken on a simulator: it says "No Bluetooth
on this device", which is true of the simulator and false of every iPhone.

### 7. App Privacy → "Data Not Collected"

App Store Connect → App Privacy → Get Started. Answer:

> **"No, we do not collect data from this app."**

That single answer ends the questionnaire — the sub-questions about contact info,
identifiers and usage data only appear after a "Yes". Then click **Publish**; the
label is not live until you do.

This is the correct and defensible answer, and it is worth understanding why.
Apple defines "collect" as transmitting data off the device in a way that gives
*you or your partners* access to it. AirLink sends chat, files and game moves
directly to the peer device the user chose, end-to-end encrypted, with no server
and no developer access. On-device storage is explicitly not collection either.

**Do not over-declare out of caution.** An over-declaration is also a false
declaration, and it puts a misleading privacy card on your listing that you
would then have to justify. Two things would change the answer: adding any
crash-reporting or analytics SDK, or any third-party SDK that phones home. You
have neither.

### 8. Age rating

Answer honestly. A rating obtained by answering "no" to the chat question is
grounds for removal later.

- Violence, sexual content, profanity, drugs, horror, gambling: **no**.
- **Unrestricted web access: no** — the app makes no internet connections at all.
- **Messaging / user-generated content: YES.** It has direct messaging between
  two paired users. Answering no is a misrepresentation that gets caught.
- Content rights: **no third-party content** — true now that the trademarked
  game names are gone.
- If asked about moderation: there is none, because content never leaves the two
  devices; users can **block and report** a peer.

Expect to land at **13+ or higher** once you declare messaging, and accept that.
A 4+ rating on an app with open chat is the wrong answer. Apple revised this
questionnaire in 2025 to a finer 4+/9+/13+/16+/18+ scale, so read each question
as presented.

### 9. Write the listing

- **Description** (mandatory). Lead with the one thing nothing else does: it
  works with no internet, no router and no server at all. Then chat, files, and
  ~28 two-player games. Be explicit that **two devices near each other are
  required** — it sets expectations and it helps the reviewer.
- **Keywords** (100 characters, comma-separated, no spaces after commas, never
  repeat words from your title).
- **Promotional text** (170 chars, editable without a new version — the only
  field you can change while In Review).
- **Support URL** and **Privacy Policy URL**: mandatory, from step 3.
- **Marketing URL**: optional; leave blank or reuse the support site.
- **Copyright**: e.g. `2026 Alejandro Newport`.

### 10. Pricing, availability, and two surprises

Price **Free**; there is nothing to charge for and no in-app purchase.
Availability all countries (read Part 3 first).

Two things that surprise every first-time individual publisher:

- **Your developer name on the store will be your legal name.** For a brand name
  you need a legally recognised DBA/trade name plus documentation. Decide now
  whether you mind.
- **EU trader status.** If you distribute in the EU you must declare as a trader
  and provide a contact address, phone and email that Apple **displays publicly**
  to EU users. If you are not willing to publish a home address, look into
  whether a PO box or virtual address is acceptable *before* you declare. This
  requirement is real and enforced; read the exact current wording on screen.

No banking or tax forms are needed for a free app.

### 11. Archive and upload

```bash
./scripts/archive-ios.sh
```

Or in Xcode: destination **Any iOS Device (arm64)** — not a simulator, or
Archive is greyed out — then **Product → Archive**, and in the Organizer
**Distribute App → App Store Connect → Upload**.

Bump `CURRENT_PROJECT_VERSION` before each archive (1, 2, 3…). The version
string can repeat; the build number cannot.

After upload the build shows **Processing** while Apple scans the binary, checks
Info.plist keys and privacy manifests, re-signs, and generates per-device
variants. Ten minutes to a couple of hours. You cannot attach it to a version or
a TestFlight group until it finishes.

**If you get a rejection email within minutes, that is the automated validator,
not a human.** It names the exact key or asset. The usual first-timer causes are
an icon with an alpha channel, a missing usage-description string, or a bundled
SDK without a privacy manifest. Fix, bump the build number, upload again — there
is no penalty and no review involved.

### 12. TestFlight — do this before you submit

This is the part that matters most for *this* app, because it is the first time
you can test two real phones properly.

App Store Connect → TestFlight → **Internal Testing**. Add testers under Users
and Access with the Developer or Marketing role, create a group, add them.

- Internal testing needs **no review** and is available minutes after processing.
- 100 App Store Connect users, 30 devices each.
- **You do not need device UDIDs and you do not plug anyone's phone into your
  Mac.** They install the free TestFlight app, tap your link, done.

That is how you finally test a friend's iPhone in airplane mode in another room.
External testing (public link, up to 10,000 people) needs a lighter Beta App
Review first, about a day — useful as a dry run of the 1.2 and 2.1 concerns
below.

TestFlight builds expire 90 days after upload. A rejection costs days; a
TestFlight round costs hours. Do it first.

### 13. Submit

Choose **"Manually release this version"** rather than automatic, so an approved
app waits in Pending Developer Release until you press the button.

Submit on a weekday morning; expect one to three days. States are Waiting for
Review → In Review → Pending Developer Release / Ready for Sale, or Rejected.
Budget realistically: a first submission rejected once on metadata and once on
something substantive is a normal two-week arc, not a failure.

---

## Part 3 — Export compliance, which is not optional

**This app ships its own cryptography** — Ed25519, X25519, ChaCha20-Poly1305, a
SIGMA-I handshake. It is not the trivial "we only use HTTPS" case, and the easy
exemption does not apply.

In App Store Connect: answer **yes** to "does your app use encryption", then that
it does **not** qualify for the Category 5 Part 2 exemptions, then — importantly
— **no** to "does it implement proprietary or non-standard algorithms". Every
primitive here is a published RFC/FIPS/NIST standard, and that last answer is
what keeps you on the mass-market self-classification path instead of needing a
CCATS.

`ITSAppUsesNonExemptEncryption` is now `true` in `Info.plist`, so you stop being
asked at every upload. **Do not set it to `false` to make the prompt go away.**
That value is a declaration under the U.S. Export Administration Regulations
that your encryption is exempt; it is recorded against the build, and here it
would be false.

### The BIS filing

Answering yes brings a real U.S. obligation. Know which document you need:

- **Self-classification report** — what this app most likely needs. A short table
  emailed to `crypt@bis.doc.gov` and `enc@nsa.gov` listing product, version,
  ECCN, description, the cryptographic functionality, and a URL. Due annually by
  **1 February** for the prior year, and before first export. Free, no approval
  step — you file it, you do not apply.
  The algorithm list for this app: Ed25519 signatures; X25519 key agreement;
  ChaCha20-Poly1305 and XChaCha20-Poly1305 AEAD (256-bit); AES-256-GCM; SHA-256;
  HKDF-SHA256; HMAC-SHA256.
- **CCATS** — an actual application asking BIS to classify the item, weeks of
  turnaround. For non-standard or proprietary crypto. You should not need one,
  and App Store Connect does not ask you to upload one.
- **ERN** — the number BIS issues after an encryption registration. Goes in
  `ITSEncryptionExportComplianceCode` if you get one.

**Be aware of the limits of this advice.** The classification above is the
standard reading for a mass-market app using only published algorithms, but the
details of registration-versus-report have moved over the years, and whether
Apple still pushes the **French/ANSSI declaration** back to developers is
something I cannot confirm for 2026. Read Apple's "Complying with Encryption
Export Regulations" page end to end. If the stakes concern you, this is a
reasonable thing to spend an hour of a lawyer's time on — it is the one item on
this list with legal rather than commercial consequences.

No country needs manual exclusion: the embargoed destinations are not App Store
territories.

---

## Part 4 — The two things most likely to get you rejected

Both are judgement calls by a human, and both need **App Review Notes**. That
field is the single highest-leverage thing you will write.

### Guideline 2.1 — a reviewer with one device sees nothing

This is the number one reason peer-to-peer and local-multiplayer apps are
rejected. A reviewer opens AirLink on one iPad, sees an empty "nobody nearby"
screen, and cannot exercise chat, files, or a single game.

Put this in App Review Notes, near enough verbatim:

> AirLink is a peer-to-peer app that works with no internet, no server and no
> accounts. It finds other phones over Bluetooth LE and the local Wi-Fi network,
> so **two devices are required to see any feature**. With one device the home
> screen correctly shows that nobody is nearby — that is the app working, not a
> failure.
>
> To test it: install on two devices on the same Wi-Fi network, or run a second
> iOS Simulator on the same machine. Both will list the other under "Nearby
> friends" within a few seconds. Tap the other device → Connect. Both show the
> same six-digit code; confirm on both. You can then Chat, Play (28 games),
> Share a file, or Sync.
>
> There is no account to create and nothing to log into. The app makes no
> network requests to any server; if you monitor its traffic you will see none.
>
> Background Bluetooth modes are declared because the app genuinely restores
> both central and peripheral managers with restore identifiers, so a
> conversation survives the screen locking.

Attach a screen recording of two devices connecting. This one addition probably
matters more than everything else in this document.

### Guideline 1.2 — user-generated content

The app has chat and file transfer between users. Apple normally requires UGC
apps to offer content filtering, a way to report offensive content, the ability
to block abusive users, and published contact information.

What now exists: **long-press any message → "Report and block"**. It blocks the
peer, drops the live session, and deletes the conversation from the device. There
is deliberately no "your report has been sent to us" claim, because there is
nowhere to send it.

For the notes:

> AirLink has no server and no operator. Messages travel directly between two
> devices that have each accepted the other, end-to-end encrypted; no content is
> ever transmitted to us, stored by us, or visible to any third party, so there
> is no moderation queue and no copy for us to review or take down.
>
> Within those constraints the app provides: connections that require explicit
> mutual confirmation of a six-digit code before any content can flow; **block**,
> which prevents a peer connecting or being connected to, reachable directly from
> any message via long-press → "Report and block", and also under You → Friends;
> local deletion of the conversation as part of the same action; and published
> contact details on our support page.

Do **not** argue the rule should not apply. If they reject anyway, ask precisely
which mechanism they require given that no content reaches a server — and offer
what exists.

### If you are rejected

Read the guideline **number** first; it tells you which of two different
situations you are in. A metadata rejection (screenshots, description, age
rating) is fixed by editing the listing and replying — no new build. A binary
rejection needs a new build.

Reply in the Resolution Center with one short message that does three things:
thank them, state the specific fact you believe they missed, and ask a precise
question. Never resubmit unchanged hoping for a different reviewer; that gets
noticed. You can escalate to the App Review Board if a guideline was misapplied.

Expedited review exists but is for genuine emergencies. Requesting it for a first
submission burns credibility you will want later.

---

## Part 5 — Still outstanding

Honest list. None of these blocks submission, but you should know about them.

- **The app icon is a self-declared placeholder** (`assets/icon-source.svg` says
  so). It is technically valid and will pass review. It is also the first thing
  anyone sees.
- **Developer Mode is reachable in a Release build** via seven taps on the
  version, and now includes a "switch off Wi-Fi" toggle. Undocumented features
  are technically 2.3.1. The risk is low — a reviewer is very unlikely to find a
  seven-tap gesture — but it is there.
- **Android has never been compiled.** No Android SDK is installed on this
  machine. Irrelevant to the App Store; relevant the moment you want Google Play.
- **Pool declares itself `REALTIME`** but resolves a whole shot inside
  `applyAction`, so `tick()` is unreachable. **Air Hockey's `serveAt`** is an
  absolute timestamp no snapshot carries. Both are in `STABILITY_AUDIT.md`.
- **Group games (3+ players)** are not implemented.
- **`hermes-engine`** ships without its own privacy manifest, and "hermes"
  appears on Apple's list of SDKs that must supply one. This may produce an
  upload warning. If the validator complains, updating React Native is the fix —
  it is not something this repo can patch.
- **No dark or tinted app icon variants** for iOS 18+. Optional, not required.
