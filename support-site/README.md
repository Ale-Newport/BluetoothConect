# AirLink support site

Four static files — no build step, no dependencies, no JavaScript, no analytics,
no external requests of any kind. Open `index.html` in a browser to see exactly
what a reviewer will see.

App Store Connect will not accept a submission without a reachable **Support
URL** and **Privacy Policy URL**. These two pages are those URLs.

```
index.html     the support page       -> Support URL
privacy.html   the privacy policy     -> Privacy Policy URL
style.css      shared stylesheet, light and dark
```

---

## 1. Edit the placeholders first

Every place you must edit is marked `EDIT ME` in a red dashed box, on the page
and in an HTML comment beside it. They are deliberately impossible to miss: a
policy published with `example.invalid` in it reads to a reviewer as no policy
at all.

| File | What to replace |
|---|---|
| `index.html` | support email (Contact section) |
| `index.html` | your name in the footer copyright |
| `index.html` | the whole "Before publishing" red box — **delete it** |
| `privacy.html` | your name (or trading name) in §1 |
| `privacy.html` | support email in §1 and §12 |
| `privacy.html` | your name in the footer copyright |
| `privacy.html` | the whole "Before publishing" red box — **delete it** |
| `privacy.html` | §6 **Camera** — read the comment there and check it still matches the shipped build |

Search for `EDIT ME` before you publish; there should be zero matches left:

```bash
grep -n "EDIT ME\|example.invalid" *.html
```

Use a dedicated address, not your personal one — it is published on a public
page and inside a shipped binary.

## 2. Publish on GitHub Pages

1. Create a **new public repository**, e.g. `airlink-support`. Public is
   required: GitHub Pages on a private repo needs a paid plan.
2. Copy these four files into the repository **root** (not into a subfolder,
   and do not copy this README's parent directory).

   ```bash
   git init && git add . && git commit -m "AirLink support and privacy policy"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/airlink-support.git
   git push -u origin main
   ```

3. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a
   branch**, Branch **`main`**, folder **`/ (root)`**, then **Save**.
4. Wait about a minute and reload the Pages settings page; it shows the live
   URL. Open both pages in a private browser window to confirm they load with
   no sign-in:

   ```
   https://YOUR-USERNAME.github.io/airlink-support/
   https://YOUR-USERNAME.github.io/airlink-support/privacy.html
   ```

Do not use Notion, Google Docs or a Drive link instead. They redirect or ask for
a sign-in, and App Review treats that as a missing policy.

## 3. Wire the URLs up

- **App Store Connect → your app → the version page:** paste the two URLs into
  **Support URL** and **Privacy Policy URL**. (Marketing URL is optional — reuse
  the support URL or leave it blank.)
- **In this repo:** set `supportEmail` and `supportUrl` in
  `packages/config/src/brand.ts` to the same address and the same support URL.
  While they are still the `example.invalid` placeholders the in-app
  "Email the developer" button stays hidden on purpose, so the report flow ends
  in a dead end. App Store guideline 1.2 expects published contact details for
  an app with user-generated content.

## 4. One thing to verify outside this directory

`NSMicrophoneUsageDescription` was removed from
`apps/mobile/ios/AirLink/Info.plist` when voice messages did not exist yet. Now
that they do, the key must be back before you archive — an app that records
audio without a purpose string crashes the moment the recorder starts, and the
privacy policy here says the microphone is used for voice messages. Check the
plist declares camera, photo library, microphone, Bluetooth and local network,
and that each purpose string matches what §6 of `privacy.html` claims. If you
change one, change the other.

## Keeping it honest

Every factual claim on both pages was checked against this repository:
`Info.plist` for the permissions and their purpose strings,
`PrivacyInfo.xcprivacy` for the privacy manifest, `packages/core/src/crypto/`
for the cryptography, and `packages/config/src/strings.ts` for what the app
actually says to the user. If a future version adds a network call, an SDK or a
new permission, both pages are wrong until you update them — the privacy policy
is a legal statement, not marketing copy.
