import Foundation
import UIKit
import UserNotifications

/**
 * The Swift half of the local-notifications module.
 *
 * Everything here is local. AirLink has no server, so nothing ever arrives from
 * APNs: a banner appears because a message came over Bluetooth a moment ago and
 * JavaScript asked for one. That is why there is no token registration and no
 * remote-notification handling anywhere in this file.
 *
 * It holds no product policy. It does not decide whether a message deserves a
 * banner, whether the user is already reading that conversation, or what the
 * badge should count. It posts what it is told to post, reports taps, and keeps
 * the OS objects alive. Every judgement lives in TypeScript, where it can be
 * read and tested.
 */
@objc public protocol AirLinkNotificationsDelegate: AnyObject {
    func emitNotificationOpened(_ payload: [String: Any])
    func emitNotificationPresented(_ payload: [String: Any])
}

@objc public final class LocalNotifications: NSObject {

    @objc public static let shared = LocalNotifications()

    private let lock = NSLock()
    private weak var _delegate: AirLinkNotificationsDelegate?

    /**
     * The tap that arrived before JavaScript was listening.
     *
     * iOS delivers the launch tap within a moment of the process starting, long
     * before the React bundle has evaluated. Emitting it then would emit it into
     * nothing, so it is held here and handed over by `consumeInitialOpen` when
     * JavaScript finally asks - which is the only ordering that cannot lose it.
     *
     * Only the most recent is kept. A user who taps two notifications in the
     * second before the bundle loads meant the second one, and an unbounded
     * queue filled from a delegate callback is a leak waiting for a bad day.
     */
    private var pendingOpen: [String: Any]?

    @objc public var delegate: AirLinkNotificationsDelegate? {
        get { lock.airlinkSync { _delegate } }
        set { lock.airlinkSync { _delegate = newValue } }
    }

    private override init() {
        super.init()
    }

    // MARK: - Delegate installation

    /**
     * Claim UNUserNotificationCenter's delegate before the app finishes
     * launching.
     *
     * Apple is explicit that the delegate must be in place by the end of
     * `application:didFinishLaunchingWithOptions:` or the response to a tap is
     * simply never delivered. A TurboModule cannot satisfy that on its own: it
     * is constructed lazily, the first time JavaScript imports it, which is
     * several hundred milliseconds too late on a cold launch.
     *
     * So the module's `+load` calls this, which registers for the launch
     * notification - the earliest moment at which touching UIApplication is
     * legal - and claims the delegate from there. Anything tapped before the
     * bundle is up is then buffered above.
     *
     * This does mean AirLink owns the notification delegate outright. Nothing
     * else in the app wants it (there is no push, and no notification-related
     * library), but if that ever changes, this is the place that has to start
     * forwarding rather than the place to work around.
     */
    @objc public static func installDelegateEarly() {
        NotificationCenter.default.addObserver(
            shared,
            selector: #selector(applicationDidFinishLaunching),
            name: UIApplication.didFinishLaunchingNotification,
            object: nil
        )
    }

    @objc private func applicationDidFinishLaunching() {
        claimDelegate()
    }

    /// Idempotent: setting the same delegate twice costs nothing, and being
    /// called both from launch and from the module's `init` is what makes the
    /// ordering impossible to get wrong.
    @objc public func claimDelegate() {
        UNUserNotificationCenter.current().delegate = self
    }

    // MARK: - Permission

    @objc public func getPermission(resolve: @escaping (String) -> Void) {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            resolve(Self.name(for: settings.authorizationStatus))
        }
    }

    @objc public func requestPermission(resolve: @escaping (String) -> Void) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in
            // The boolean from requestAuthorization is deliberately ignored in
            // favour of re-reading the settings. They disagree in the case that
            // actually matters: provisional authorisation, and a user who
            // changed their mind in Settings while the app was backgrounded,
            // both report a stale answer here. The settings are the truth.
            center.getNotificationSettings { settings in
                resolve(Self.name(for: settings.authorizationStatus))
            }
        }
    }

    private static func name(for status: UNAuthorizationStatus) -> String {
        switch status {
        case .notDetermined: return "notAsked"
        case .denied: return "denied"
        case .authorized, .provisional, .ephemeral: return "granted"
        @unknown default:
            // A status this build does not know about is not a grant. Treating
            // it as one would mean posting notifications into a void and
            // telling the user they are on.
            return "denied"
        }
    }

    // MARK: - Posting

    @objc public func present(_ identifier: String,
                              title: String,
                              body: String,
                              threadId: String,
                              dataJson: String,
                              resolve: @escaping () -> Void,
                              reject: @escaping (String, String) -> Void) {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        // Groups a conversation's notifications together in Notification Centre,
        // and is what clearThread matches on when the user opens that chat.
        content.threadIdentifier = threadId
        content.userInfo = ["threadId": threadId, "data": dataJson]

        // A nil trigger means "deliver now", which is the only kind of
        // notification this app has: the message is already on the device. A
        // scheduled trigger would be a strange thing to build against an event
        // that has already happened.
        let request = UNNotificationRequest(identifier: identifier, content: content, trigger: nil)

        UNUserNotificationCenter.current().add(request) { error in
            if let error {
                reject("failed", error.localizedDescription)
            } else {
                resolve()
            }
        }
    }

    @objc public func setBadgeCount(_ count: Int,
                                    resolve: @escaping () -> Void,
                                    reject: @escaping (String, String) -> Void) {
        if #available(iOS 16.0, *) {
            UNUserNotificationCenter.current().setBadgeCount(count) { error in
                if let error {
                    reject("failed", error.localizedDescription)
                } else {
                    resolve()
                }
            }
        } else {
            // Deprecated since iOS 17 and still the only route below 16, which
            // React Native's deployment floor keeps in scope.
            DispatchQueue.main.async {
                UIApplication.shared.applicationIconBadgeNumber = count
                resolve()
            }
        }
    }

    // MARK: - Clearing

    @objc public func clearThread(_ threadId: String, resolve: @escaping () -> Void) {
        let center = UNUserNotificationCenter.current()
        center.getDeliveredNotifications { delivered in
            let ids = delivered
                .filter { $0.request.content.threadIdentifier == threadId }
                .map { $0.request.identifier }
            if !ids.isEmpty {
                center.removeDeliveredNotifications(withIdentifiers: ids)
            }
            resolve()
        }
    }

    @objc public func clearAll(resolve: @escaping () -> Void) {
        let center = UNUserNotificationCenter.current()
        center.removeAllDeliveredNotifications()
        // Nothing here is ever scheduled, so there should never be a pending
        // request - but "clear everything" that left something behind would be
        // a lie, and this costs one call.
        center.removeAllPendingNotificationRequests()
        resolve()
    }

    // MARK: - The launch tap

    /**
     * Hand over the tap that launched the app, once.
     *
     * Resolves with a JSON object of the same shape as the open event, or with
     * an empty string when the app was opened some other way. Draining, so a
     * second call - a screen remounting, a Fast Refresh - cannot reopen the
     * same conversation again.
     */
    @objc public func consumeInitialOpen(resolve: @escaping (String) -> Void) {
        let payload: [String: Any]? = lock.airlinkSync {
            let queued = pendingOpen
            pendingOpen = nil
            return queued
        }
        guard let payload,
              let encoded = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: encoded, encoding: .utf8) else {
            resolve("")
            return
        }
        resolve(json)
    }

}

// MARK: - UNUserNotificationCenterDelegate

extension LocalNotifications: UNUserNotificationCenterDelegate {

    /**
     * A notification is about to appear while the app is in the foreground.
     *
     * It is always shown. That is not a policy decision made here - it is the
     * consequence of there being no push: the only way a notification exists at
     * all is that JavaScript called `present`, and JavaScript already knows
     * which conversation is on screen. Asking Swift to second-guess that would
     * put the same rule in two places and let them disagree.
     *
     * The emit exists so JavaScript can react to the banner it asked for - a
     * soft in-app sound, a badge refresh - not so it can veto it.
     */
    public func userNotificationCenter(_ center: UNUserNotificationCenter,
                                       willPresent notification: UNNotification,
                                       withCompletionHandler completionHandler:
                                        @escaping (UNNotificationPresentationOptions) -> Void) {
        delegate?.emitNotificationPresented(Self.payload(from: notification))
        completionHandler([.banner, .list, .sound, .badge])
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter,
                                       didReceive response: UNNotificationResponse,
                                       withCompletionHandler completionHandler: @escaping () -> Void) {
        let payload = Self.payload(from: response.notification)

        // Reading the delegate and stashing the payload happen under the same
        // lock: a subscription landing between the two would find the stash
        // already drained and miss this open entirely.
        let listener: AirLinkNotificationsDelegate? = lock.airlinkSync {
            if let delegate = _delegate { return delegate }
            pendingOpen = payload
            return nil
        }
        listener?.emitNotificationOpened(payload)
        completionHandler()
    }

    private static func payload(from notification: UNNotification) -> [String: Any] {
        let info = notification.request.content.userInfo
        return [
            "threadId": info["threadId"] as? String ?? notification.request.content.threadIdentifier,
            "data": info["data"] as? String ?? "{}",
        ]
    }
}

private extension NSLock {
    /// Not named `withLock`: Foundation grew one of those in iOS 16, and an
    /// extension with the same signature as the system method is an ambiguity
    /// the compiler resolves differently depending on which SDK is in front of
    /// it. This app still builds for iOS 15, so it needs its own, under a name
    /// that can never collide.
    func airlinkSync<T>(_ body: () -> T) -> T {
        lock()
        defer { unlock() }
        return body()
    }
}
