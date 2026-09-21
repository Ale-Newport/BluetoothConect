/**
 * The seam between the app and local notifications.
 *
 * Everything here is local. AirLink has no server, so a banner is never
 * something that arrived from outside: it is the app telling the user about a
 * message that came over Bluetooth while they were looking at something else.
 * There is no token, no registration and no remote payload anywhere below,
 * which is also why the App Store privacy label can stay at "Data Not
 * Collected".
 *
 * THIS FILE NEVER THROWS AND NEVER REJECTS. A build from before the native
 * module existed, and a Jest run where there is no native side at all, both end
 * up here with `NativeAirLinkNotifications` as null. In that case every method
 * resolves to a harmless default and `isAvailable()` is false, so a caller can
 * post a notification unconditionally and the worst that happens is that
 * nothing appears. A notification that could crash a chat screen would be a
 * remarkably bad trade.
 */
import {
  NativeAirLinkNotifications,
  type NativeAirLinkNotificationsSpec,
  type NativeNotificationOpenEvent,
} from '@airlink/native-transport';

/**
 * One narrowed handle to the module. `TurboModuleRegistry.get` is typed as
 * `Spec | null | undefined`, and repeating that check at every call site would
 * make the absence read like an edge case rather than the ordinary state of a
 * Jest run. A `const` is also what lets TypeScript keep the narrowing inside
 * the closures below.
 */
const native: NativeAirLinkNotificationsSpec | null = NativeAirLinkNotifications ?? null;

export type NotificationPermission = 'granted' | 'denied' | 'notAsked' | 'unsupported';

export interface NotificationOpen {
  /** The conversation or game room the notification belonged to. */
  readonly threadId: string;
  /** Whatever the caller attached when it posted the notification. */
  readonly data: Record<string, string>;
}

export interface NotificationInput {
  /**
   * Stable identifier. Posting again with the same id replaces the banner
   * rather than stacking a second one, which is what keeps three quick messages
   * from one person from becoming three separate notifications.
   */
  id: string;
  title: string;
  body: string;
  /** Groups the notification with the rest of its conversation, and is what
   *  `clearThread` removes when the user opens that chat. */
  threadId: string;
  data?: Record<string, string>;
}

/**
 * Permission strings cross the bridge as plain strings because codegen cannot
 * express a union of string literals in a spec. Anything unrecognised is
 * treated as 'unsupported' rather than guessed at - claiming a permission the
 * OS did not give would mean posting into a void while telling the user
 * notifications are on.
 */
function toPermission(value: string): NotificationPermission {
  switch (value) {
    case 'granted':
    case 'denied':
    case 'notAsked':
      return value;
    default:
      return 'unsupported';
  }
}

/**
 * The payload map travels as JSON for the reason given in the spec header:
 * codegen has no faithful type for a string-to-string map. Anything that is not
 * a flat object of strings is dropped rather than coerced, because a caller
 * reading `data.conversationId` should get a string or nothing, never `[object
 * Object]`.
 */
function parseData(json: string): Record<string, string> {
  if (json.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

type OpenListener = (event: NotificationOpen) => void;

const listeners = new Set<OpenListener>();
let nativeSubscription: { remove: () => void } | null = null;
/** The launch tap is drained exactly once per app run; see the spec's note on
 *  `consumeInitialOpen` for why it cannot simply be an event. */
let initialOpenConsumed = false;

function deliver(event: NotificationOpen): void {
  // A copy, because a listener that unsubscribes itself while being called -
  // which is exactly what a screen navigating away does - would otherwise
  // mutate the set mid-iteration.
  for (const listener of [...listeners]) listener(event);
}

function toOpen(event: NativeNotificationOpenEvent): NotificationOpen {
  return { threadId: event.threadId, data: parseData(event.data) };
}

async function consumeInitialOpen(): Promise<void> {
  if (initialOpenConsumed || native === null) return;
  initialOpenConsumed = true;
  try {
    const json = await native.consumeInitialOpen();
    if (json.length === 0) return;
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== 'object' || parsed === null) return;
    const record = parsed as Record<string, unknown>;
    const threadId = record['threadId'];
    const data = record['data'];
    if (typeof threadId !== 'string' || threadId.length === 0) return;
    deliver({ threadId, data: parseData(typeof data === 'string' ? data : '') });
  } catch {
    // A launch tap we could not read is a launch tap that opens the app on the
    // home screen. Mildly annoying; not worth an unhandled rejection during
    // startup.
  }
}

export const notifications = {
  isAvailable(): boolean {
    return native !== null;
  },

  async getPermission(): Promise<NotificationPermission> {
    if (native === null) return 'unsupported';
    try {
      return toPermission(await native.getPermission());
    } catch {
      return 'unsupported';
    }
  },

  async requestPermission(): Promise<NotificationPermission> {
    if (native === null) return 'unsupported';
    try {
      return toPermission(await native.requestPermission());
    } catch {
      return 'unsupported';
    }
  },

  async present(input: NotificationInput): Promise<void> {
    if (native === null) return;
    try {
      await native.present(
        input.id,
        input.title,
        input.body,
        input.threadId,
        JSON.stringify(input.data ?? {}),
      );
    } catch {
      // The OS refuses for reasons the caller cannot do anything about - the
      // user turned notifications off a second ago, the system is rate
      // limiting. Swallowed on purpose: the message itself already arrived and
      // is already in the conversation.
    }
  },

  async setBadgeCount(count: number): Promise<void> {
    if (native === null) return;
    try {
      // Rounded and floored here rather than in native code: the count comes
      // from a database query that can return a float on some drivers, and
      // Int32 is what the spec promises.
      await native.setBadgeCount(Math.max(0, Math.round(count)));
    } catch {
      // Android has no platform badge API at all, so this is expected there.
    }
  },

  async clearThread(threadId: string): Promise<void> {
    if (native === null) return;
    try {
      await native.clearThread(threadId);
    } catch {
      // Failing to tidy up is not worth surfacing to somebody who just opened
      // a chat.
    }
  },

  async clearAll(): Promise<void> {
    if (native === null) return;
    try {
      await native.clearAll();
    } catch {
      // As above.
    }
  },

  /**
   * Call `callback` when the user taps a notification, including the tap that
   * launched the app. Returns the unsubscribe.
   *
   * One native subscription is shared by every caller and is torn down when the
   * last one goes, so a screen that mounts and unmounts repeatedly does not
   * accumulate bridge listeners.
   */
  onOpened(callback: OpenListener): () => void {
    listeners.add(callback);

    if (nativeSubscription === null && native !== null) {
      nativeSubscription = native.onNotificationOpened((event) => {
        deliver(toOpen(event));
      });
    }

    // Deliberately after the listener is registered: the promise resolves on a
    // later tick, so the launch tap reaches this caller rather than nobody.
    void consumeInitialOpen();

    return () => {
      listeners.delete(callback);
      if (listeners.size === 0 && nativeSubscription !== null) {
        nativeSubscription.remove();
        nativeSubscription = null;
      }
    };
  },
};
