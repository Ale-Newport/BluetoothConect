import { brand } from '@airlink/config';

/**
 * The handful of onboarding strings that `@airlink/config` does not have yet.
 *
 * Everything else on these four screens comes from `strings`. These live here
 * only because `packages/config` is being worked on elsewhere; they belong in
 * `strings.onboarding` / `strings.permissions` and should move there. The
 * product name still comes from `brand`, so a rename stays a one-file change.
 */
export const onboardingCopy = {
  /** Heading for the permissions step. Explains before it asks. */
  permissionsTitle: 'Before you start',
  /** Why Continue is disabled on the name step. */
  nameRequired: 'Add a name so friends can recognise you.',
  /** The initials tile in the avatar grid - a real choice, not a failure. */
  useInitials: 'Just my initials',
  /** Offered when the radios did not come up. A first run is never a dead end. */
  continueAnyway: 'Continue anyway',
  /** Plain-language failures. The user never sees a stack trace. */
  startFailed: `${brand.name} couldn't get ready to find friends nearby.`,
  startFailedDetail: 'You can carry on and try again later.',
  profileFailed: `${brand.name} couldn't save your name on this device.`,
  profileFailedDetail: 'Try once more.',
  /** Screen-reader label for the progress indicator. */
  stepProgress: (step: number, total: number): string => `Step ${step} of ${total}`,
} as const;
