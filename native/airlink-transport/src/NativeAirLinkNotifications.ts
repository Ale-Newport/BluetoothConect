/**
 * Local notifications, and nothing else.
 *
 * There is no push server behind this module and there never will be: AirLink
 * has no server at all, so every notification it shows is one this device
 * decided to show about something that arrived over Bluetooth or Wi-Fi a
 * moment ago. That is why there is no token registration, no APNs plumbing and
 * no remote payload anywhere below - the whole surface is "put this banner on
 * screen now" plus the badge and the tap.
 *
 * WHY THIS IS A SEPARATE SPEC from NativeAirLinkTransport rather than four more
 * methods on it: codegen turns each spec into one method map, and when the
 * transport's map and the .mm implementation drifted apart by a single argument
 * the app compiled cleanly and then jumped through a garbage pointer on the
 * first call. A notification is not a radio. Keeping it in its own spec keeps
 * its method map small, independent, and impossible to confuse with the one the
 * radios use.
 *
 * DATA ENCODING. `data` crosses as a JSON string rather than as an object.
 * Codegen has no faithful type for a string-to-string map in a spec - the only
 * option is an untyped object, which gives up exactly the checking this
 * boundary exists to provide - so the payload is serialised once on the way out
 * and parsed once on the way back. It carries a handful of short identifiers,
 * so the cost is nothing, and the rule "everything in a notification payload is
 * a string" is worth enforcing anyway: it is what the OS stores.
 */
import type { TurboModule, CodegenTypes } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * Delivered when the user taps a notification while the app is running.
 *
 * The tap that LAUNCHES the app does not arrive here - see
 * `consumeInitialOpen` below for why it cannot.
 */
export interface NativeNotificationOpenEvent {
  /** The conversation (or game room) the notification belonged to. */
  threadId: string;
  /** JSON object of string values. See DATA ENCODING above. */
  data: string;
}

/**
 * Delivered when a notification is shown while the app is in the foreground.
 *
 * Deliberately a plain notice with no decision attached: whether a banner
 * should have appeared at all is a product question - is the user already
 * looking at that conversation? - and product questions are answered in
 * TypeScript, never in Swift or Kotlin.
 */
export interface NativeNotificationPresentedEvent {
  threadId: string;
  data: string;
}

export interface Spec extends TurboModule {
  /**
   * 'granted' | 'denied' | 'notAsked'. Never prompts; safe to call on launch to
   * decide whether the settings row should say "Allow" or "Turn off in
   * Settings".
   */
  getPermission(): Promise<string>;

  /**
   * Shows the one system prompt iOS allows, for alerts, sounds and badges.
   * Resolves with the resulting permission. Asking twice never prompts twice -
   * iOS answers from the stored decision - so the caller does not have to
   * remember whether it has asked.
   */
  requestPermission(): Promise<string>;

  /**
   * Post a notification now.
   *
   * @param id stable identifier; posting again with the same id replaces the
   *   existing notification rather than stacking a second one, which is what
   *   keeps "3 new messages" from becoming three separate banners.
   * @param threadId groups this notification with the rest of its conversation
   *   in Notification Centre, and is what `clearThread` removes.
   * @param dataJson JSON object of string values, echoed back on tap.
   */
  present(
    id: string,
    title: string,
    body: string,
    threadId: string,
    dataJson: string,
  ): Promise<void>;

  /** Set the app icon badge. Zero removes it. */
  setBadgeCount(count: CodegenTypes.Int32): Promise<void>;

  /** Remove every delivered notification for one conversation. */
  clearThread(threadId: string): Promise<void>;

  /** Remove every delivered notification this app has posted. */
  clearAll(): Promise<void>;

  /**
   * The tap that launched the app, if there was one. Resolves with a JSON
   * object of the same shape as `NativeNotificationOpenEvent`, or with '' when
   * the app was opened some other way. Draining it, so calling twice answers
   * once.
   *
   * WHY THIS IS NOT JUST AN EVENT. Both platforms deliver a launch tap within
   * a moment of the process starting - iOS through the notification-centre
   * delegate, Android as an extra on the launch Intent - and both do it long
   * before the React bundle has finished evaluating, let alone before a screen
   * has subscribed to anything. An event emitted at that instant goes nowhere,
   * and the one gesture whose entire meaning is "take me to this conversation"
   * opens the app on the home screen instead. So the native side holds it and
   * hands it over when asked.
   */
  consumeInitialOpen(): Promise<string>;

  readonly onNotificationOpened: CodegenTypes.EventEmitter<NativeNotificationOpenEvent>;
  readonly onNotificationPresented: CodegenTypes.EventEmitter<NativeNotificationPresentedEvent>;
}

/**
 * `get`, not `getEnforcing`.
 *
 * The transport module is load-bearing - an app without radios is not this app,
 * so it is right for its absence to be a hard error. Notifications are not:
 * a JavaScript-only test has no native side at all, and a phone still running
 * a build from before this module existed should show no banners rather than
 * crash on the first message. The wrapper in the app turns this null into a set
 * of harmless no-ops.
 */
export default TurboModuleRegistry.get<Spec>('NativeAirLinkNotifications');
