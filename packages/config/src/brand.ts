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
} as const;

/**
 * Identifiers that must ALSO be changed in the native projects when the brand
 * changes. Listed here so the set is discoverable rather than folkloric.
 *
 *   iOS      apps/mobile/ios/AirLink.xcodeproj  -> PRODUCT_BUNDLE_IDENTIFIER
 *   Android  apps/mobile/android/app/build.gradle -> namespace, applicationId
 */
export const nativeIdentity = {
  iosBundleId: 'com.airlink.app',
  androidApplicationId: 'com.airlink.app',
  /** Bonjour / NSD service type. Changing this breaks compatibility with older builds. */
  bonjourServiceType: '_airlink._tcp',
} as const;

export type Brand = typeof brand;
