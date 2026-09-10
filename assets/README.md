# Assets

## Placeholders — replace before release

The app currently ships **generated placeholder artwork**, deliberately marked
as such so it cannot be mistaken for a finished asset and shipped by accident.

| Asset | Where | Status |
|---|---|---|
| iOS app icon | `apps/mobile/ios/AirLink/Images.xcassets/AppIcon.appiconset` | placeholder |
| Android launcher icon | `apps/mobile/android/app/src/main/res/mipmap-*` | placeholder |
| iOS launch screen | `apps/mobile/ios/AirLink/LaunchScreen.storyboard` | real, brand-neutral |
| Android splash | `apps/mobile/android/app/src/main/res/values/styles.xml` | real, brand-neutral |

`scripts/make-icons.sh` regenerates the placeholder set from
`assets/icon-source.svg`. Point it at real artwork and run it again.

## Designing the real icon

The mark should read at 40 px. The product is about two things connecting
without infrastructure, so the obvious directions are a link, an arc between two
points, or a signal with nothing behind it. Avoid a Bluetooth glyph: Bluetooth
is an implementation detail, and the app is not about it.

The palette lives in [`packages/config/src/theme.ts`](../packages/config/src/theme.ts).
The accent is `#0A6CFF`.
