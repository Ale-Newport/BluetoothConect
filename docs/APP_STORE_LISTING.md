# The listing, ready to paste

Everything App Store Connect asks you to type, written out. Paste it, adjust the
voice if you want it to sound more like you, and move on.

Two rules worth knowing before you edit any of it:

- **Everything here must stay true.** Guideline 2.3.1 covers accurate metadata,
  and a description promising something the app does not do is a rejection that
  costs days. Where a line depends on a feature, it is marked.
- **The name, subtitle and keywords are what people search.** The description is
  what convinces someone already looking at the page. They do different jobs.

---

## Name and subtitle

**App name** (30 characters max) — check availability when you create the record.

```
AirLink
```

If "AirLink" is taken, these are unclaimed-sounding alternatives that keep the
meaning and fit the mark: `AirLink Nearby`, `Nearlink`, `Offgrid Chat`. Changing
it is one file (`packages/config/src/brand.ts`) plus the bundle id.

**Subtitle** (30 characters max, shown under the name):

```
Chat and play with no signal
```

Alternatives at the limit: `Messaging with no internet` · `Offline chat, files, games`

---

## Promotional text

170 characters. **The only field you can change without submitting a new
version**, including while a build is In Review — so it is where a launch note
or a fix announcement goes.

```
No internet, no signal, no problem. AirLink connects two phones directly over Bluetooth or Wi-Fi so you can talk, share photos and play — anywhere.
```

---

## Description

Under 4,000 characters. The first three lines are what shows before "more", so
they carry the whole pitch.

```
AirLink is a messenger that works when nothing else does.

On a plane, on the underground, camping, at a festival, in a country where your
data does not work — AirLink connects your phone directly to a friend's phone
over Bluetooth or a shared Wi-Fi network. No signal. No internet. No account.
No server anywhere in the middle.

WHAT YOU CAN DO

• Message a friend nearby, with photos and voice notes
• Send files of any kind, which resume by themselves if you walk out of range
• Play 28 two-player games — chess, draughts-style boards, word games, trivia,
  quick reaction games and more
• Watch something together, in sync

HOW IT WORKS

Open AirLink on two phones near each other and each one appears on the other's
screen within seconds. Tap to connect. Both phones show the same six digits —
check they match, confirm on both, and you are talking. After that first time
the two phones recognise each other silently.

Bluetooth works with no network at all. If you both happen to be on the same
Wi-Fi, AirLink notices and uses it for anything large, then falls back to
Bluetooth the moment the network goes away. You do not have to think about it.

PRIVATE BY CONSTRUCTION, NOT BY PROMISE

There is no server to trust, because there is no server. Messages go straight
from one phone to the other, encrypted end to end with keys the two phones
agree between themselves. We never see your messages because they never travel
anywhere we could see them.

• No account, no phone number, no email
• No analytics, no tracking, no advertising
• No internet connection of any kind — check it yourself with a network monitor
• Nothing stored anywhere but the two phones

YOU NEED TWO DEVICES

AirLink is only useful with someone else. On one phone it will honestly tell you
there is nobody nearby — that is the app working, not a fault.
```

**If the photo and voice-note work has not landed**, change the second bullet in
WHAT YOU CAN DO to `• Message a friend nearby` and remove "with photos and voice
notes" from the description. Do not describe a feature that is not in the build
you upload.

---

## Keywords

100 characters, comma-separated, **no spaces after the commas**, and never
repeat a word already in your app name or subtitle — Apple indexes those
separately and repeating wastes the budget.

```
offline,bluetooth,nearby,p2p,messenger,no wifi,airplane,share,files,games,local,private,encrypted
```

That is 99 characters. If you change the name or subtitle, re-check for
duplicates.

---

## URLs

| Field | Value | Required |
|---|---|---|
| Support URL | `https://Ale-Newport.github.io/airlink-support/` | **Yes** |
| Privacy Policy URL | `https://Ale-Newport.github.io/airlink-support/privacy.html` | **Yes** |
| Marketing URL | leave blank, or the same site | No |

Both pages are written and waiting in `support-site/` — publishing them is a new
public repo and one settings toggle. See `support-site/README.md`.

---

## Copyright

```
2026 Alejandro Newport
```

---

## App Review Notes

**This is the highest-leverage field on the page.** A reviewer with one device
cannot exercise a single feature of a peer-to-peer app, and that is the most
common reason apps like this are rejected under guideline 2.1.

```
AirLink is a peer-to-peer app that works with no internet, no server and no
accounts. It finds other phones over Bluetooth LE and the local Wi-Fi network,
so TWO DEVICES ARE REQUIRED to see any feature. With one device the home screen
correctly shows that nobody is nearby — that is the app working, not a failure.

TO TEST IT
Install on two devices on the same Wi-Fi network, or run a second iOS Simulator
on the same machine. Each will list the other under "Other devices" within a
few seconds. Tap Connect next to it. Both show the same six-digit code; tap
"They match" on both. The other device then moves to "Connected", and you can
Chat, Play (28 games), Share a file, or Sync. From then on the two recognise
each other as friends and connect without the code.

There is no account to create and nothing to log into. The app makes no network
requests to any server; if you monitor its traffic you will see none.

PERMISSIONS
Bluetooth and Local Network are how the app finds and reaches the other phone —
denying either narrows how it can connect, and the home screen explains which
one is missing and why. Camera is only for scanning a friend's QR code.
Microphone is only for recording a voice message in a conversation. Photo
Library is only for choosing a photo to send.

BACKGROUND MODES
Both Bluetooth background modes are declared because the app genuinely restores
its central and peripheral managers with restore identifiers, so a conversation
survives the screen locking.

USER-GENERATED CONTENT (guideline 1.2)
The app has no server and no operator. Messages travel directly between two
devices that have each accepted the other, end-to-end encrypted; no content is
ever transmitted to us, stored by us, or visible to any third party, so there is
no moderation queue and no copy for us to review or take down.

Within those constraints the app provides: connections requiring explicit mutual
confirmation of a six-digit code before any content can flow; block, which
prevents a peer connecting or being connected to, reachable directly from any
message via long-press "Report and block" and also under You → Friends; local
deletion of the conversation as part of the same action; and published contact
details on our support page.
```

**The attachment is made**: `docs/app-review-video.mp4` (72 seconds, 1 MB).
Two simulators side by side, labelled, with a title card that says two devices
are required and that a simulator has no Bluetooth radio. It shows discovery,
the six-digit check confirmed on both, a message each way with delivery and
read receipts, a game invitation accepted, and two moves. Upload it under App
Review Information -> Attachment. It is worth more than the text.

---

## "What's New" for version 1.0

Not shown for a first release — App Store Connect only asks from 1.0.1 onward.
Keep this for the first update:

```
First release.
```

---

## Age rating answers

Answer the questionnaire honestly; a rating obtained by answering "no" to the
chat question is grounds for removal later.

| Question | Answer |
|---|---|
| Violence, sexual content, profanity, drugs, horror, gambling | **No** to all |
| Unrestricted web access | **No** — the app makes no internet connections |
| Messaging / in-app communication between users | **Yes** |
| User-generated content | **Yes** |
| Content rights: does your app contain third-party content | **No** |
| Moderation | None — content never leaves the two devices. Users can block and report a peer. |

Expect **13+ or higher** once messaging is declared. That is the correct outcome;
a 4+ rating on an app with open chat is the wrong answer.

---

## App Privacy

One answer ends the questionnaire:

> **No, we do not collect data from this app.**

Then click **Publish** — the label is not live until you do. The reasoning, and
why over-declaring is also wrong, is in [APP_STORE.md](APP_STORE.md) step 7.

---

## Export compliance

Asked on each build, as **Missing Compliance** in TestFlight → the build →
Manage. The algorithm question: **"Standard encryption algorithms instead of,
or in addition to, using or accessing the encryption within Apple's operating
system"** — not proprietary, not "none". Then, available in France: **no** for
a first release (and remove France under Pricing and Availability), because
yes requires a French encryption declaration first. The full reasoning, the BIS
filing you need, and the limits of that advice are in
[APP_STORE.md](APP_STORE.md) part three. `ITSAppUsesNonExemptEncryption` is
deliberately absent from `Info.plist`; part three says why.

---

## Screenshots

Read the dimensions the form asks for rather than trusting a remembered size —
Apple changes them each hardware generation. Run two simulators, use one as the
peer, and press **⌘S** in the Simulator for pixel-perfect files.

**Already made**, in `docs/app-store-screenshots/`, at 1320 × 2868 (the 6.9"
iPhone size), flattened RGB, from the Release build talking to a second
simulator. The same five at 1284 × 2778 are in `6.5-inch/`, for an App Store
Connect page that offers the 6.5" slot instead: scaled by 0.973 and trimmed by
six rows of plain background top and bottom. One size is enough. Upload them in this order — the first two are what most people see
in search results:

| File | Shows |
|---|---|
| `1-no-signal-no-problem.png` | The first screen: "No signal. No Wi-Fi. No problem." |
| `2-private-by-construction.png` | The six-digit pairing check |
| `3-chat-with-photos.png` | A conversation with a photo, delivered and read |
| `4-games-to-play-together.png` | The catalogue, colour-coded by category |
| `5-play-face-to-face.png` | Four in a Row halfway through |

Home is deliberately not among them: on a simulator it says "No Bluetooth on
this device", which is true of the simulator and false of every iPhone. A voice
note is not shown either, because a simulator has no microphone to record a
convincing one.

They are plain screenshots. App Store Connect has no caption field: a caption
would have to be drawn into the image itself, which is allowed but optional. A
screenshot that is mostly marketing text is a rejection under 2.3.3.
