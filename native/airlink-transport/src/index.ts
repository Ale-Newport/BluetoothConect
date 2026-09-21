export { default as NativeAirLinkTransport } from './NativeAirLinkTransport.js';
export type * from './NativeAirLinkTransport.js';

// Named rather than `export type *` because all three specs call their module
// interface `Spec`, and a wildcard would make the last one win silently.
export { default as NativeAirLinkNotifications } from './NativeAirLinkNotifications.js';
export type {
  Spec as NativeAirLinkNotificationsSpec,
  NativeNotificationOpenEvent,
  NativeNotificationPresentedEvent,
} from './NativeAirLinkNotifications.js';

export { default as NativeAirLinkAudio } from './NativeAirLinkAudio.js';
export type {
  Spec as NativeAirLinkAudioSpec,
  NativeRecording,
  NativeAudioLevelEvent,
  NativeAudioProgressEvent,
  NativeAudioFinishedEvent,
} from './NativeAirLinkAudio.js';
