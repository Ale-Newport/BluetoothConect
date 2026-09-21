/**
 * Branding, in one place.
 *
 * "AirLink" is a working name. Everything the user sees that carries the
 * product's identity is defined here and nowhere else, so renaming the app is a
 * change to this file plus the two native bundle identifiers listed in
 * `nativeIdentity` - not a search across the codebase.
 */
export const brand = {
  /** Shown in the UI, the app switcher and the store listing. */
  name: 'AirLink',
  /** Uppercase wordmark used on the home screen. */
  wordmark: 'AIRLINK',
  tagline: "Together, even when you're offline.",
  /** One-line description for the store and the onboarding screen. */
  promise: 'Stay connected wherever you go.',
  /** Reverse-DNS prefix for identifiers and service names. */
  domain: 'com.airlink',

  /**
   * PUBLISHED CONTACT DETAILS. These are placeholders and MUST be replaced.
   *
   * App Store guideline 1.2 requires an app carrying user-generated content to
   * publish a way to reach the developer, and App Store Connect separately
   * demands a reachable support URL before it will accept a submission. The
   * in-app "report" flow below offers this address, so a placeholder here is a
   * dead end presented to somebody who has just seen something upsetting.
   *
   * Deliberately not filled in automatically: publishing a personal email
   * address inside a shipped binary is the owner's decision, not a default. A
   * free GitHub Pages site and a dedicated address are enough.
   */
  supportEmail: 'support@example.invalid',
  supportUrl: 'https://example.invalid/airlink/support',
} as const;

/**
 * Identifiers that must ALSO be changed in the native projects when the brand
 * changes. Listed here so the set is discoverable rather than folkloric.
 *
 *   iOS      apps/mobile/ios/AirLink.xcodeproj  -> PRODUCT_BUNDLE_IDENTIFIER
 *   Android  apps/mobile/android/app/build.gradle -> namespace, applicationId
 *
 * The two identifiers deliberately DIFFER. Apple refused to register
 * `com.airlink.app` - another developer's account already holds it - so the
 * iOS bundle id is the one this account owns. Google Play is a separate
 * namespace and still has `com.airlink.app`, so there is nothing to change
 * there and no point inventing a mismatch to look tidy.
 *
 * The iOS identifier is immutable once an App Store record exists against it.
 */
export const nativeIdentity = {
  iosBundleId: 'com.alejandronewport.airlink',
  androidApplicationId: 'com.airlink.app',
  /** Bonjour / NSD service type. Changing this breaks compatibility with older builds. */
  bonjourServiceType: '_airlink._tcp',
} as const;

export type Brand = typeof brand;
