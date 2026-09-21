package com.airlink.transport

import android.Manifest
import android.app.Activity
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import org.json.JSONObject
import java.util.concurrent.atomic.AtomicInteger

/**
 * The Kotlin half of the local-notifications module.
 *
 * Local means local. AirLink has no server, so there is no FCM registration
 * here, no token, no remote payload - every notification exists because a
 * message arrived over Bluetooth a second ago and JavaScript asked for a
 * banner. The module posts what it is told to post, reports taps, and holds no
 * opinion about whether a given message deserves one.
 *
 * Grouping is done with [NotificationCompat.Builder.setGroup] keyed on the
 * conversation, which is the closest Android equivalent of iOS's
 * `threadIdentifier`: notifications from one chat collapse together and
 * `clearThread` can find them again when the user opens it.
 */
@ReactModule(name = NativeAirLinkNotificationsSpec.NAME)
class AirLinkNotificationsModule(reactContext: ReactApplicationContext) :
    NativeAirLinkNotificationsSpec(reactContext), ActivityEventListener {

    private val appContext: Context = reactContext.applicationContext
    private val manager = NotificationManagerCompat.from(appContext)
    private val permissionRequestCode = AtomicInteger(4700)
    private var pendingPermission: Promise? = null

    /**
     * A tap that arrived before JavaScript was listening.
     *
     * The tap that launches the app from cold is the case that matters: the
     * Activity already carries our Intent by the time this module is
     * constructed, which is itself before the React bundle has finished
     * evaluating. Holding it until JavaScript asks for it is what makes "take
     * me to this conversation" actually take the user there rather than to the
     * home screen.
     */
    private var pendingOpen: Map<String, String>? = null

    /**
     * True once JavaScript has asked for the launch tap, which is the first
     * moment we know for certain that it is wired up and listening. Before it,
     * a tap is stashed; after it, one is emitted straight away.
     */
    private var handedOverInitialOpen = false

    init {
        createChannel()
        reactContext.addActivityEventListener(this)
        // The launch Intent is already in hand by the time this module is
        // constructed; onNewIntent only fires for taps that arrive afterwards.
        reactContext.currentActivity?.intent?.let { rememberOrEmit(it) }
    }

    /**
     * One channel, created up front.
     *
     * Android will not show a notification whose channel does not exist, and
     * creating it at post time would mean the very first message of a fresh
     * install is the one that silently does not appear. Creating an existing
     * channel is a no-op, so this is safe to run on every construction.
     */
    private fun createChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Messages",
            NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = "New messages and game invitations from people nearby."
            enableVibration(true)
        }
        val system = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
        system?.createNotificationChannel(channel)
    }

    // =====================================================================
    // Permission
    // =====================================================================

    override fun getPermission(promise: Promise) {
        promise.resolve(currentPermission())
    }

    private fun currentPermission(): String {
        // Below Android 13 there is no notification permission at all: an app
        // may post, and the user turns it off in Settings if they do not want
        // it. Reporting "granted" is the honest answer to "may I post?", which
        // is the question the caller is actually asking.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return if (manager.areNotificationsEnabled()) "granted" else "denied"
        }
        val held = appContext.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        if (held) return "granted"
        // Android cannot distinguish "never asked" from "asked and refused"
        // without remembering that we asked, and Permissions already keeps that
        // record for the radios. Reusing it keeps the two answers consistent.
        return if (Permissions.wasRequested(appContext, Manifest.permission.POST_NOTIFICATIONS)) "denied" else "notAsked"
    }

    override fun requestPermission(promise: Promise) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || currentPermission() == "granted") {
            promise.resolve(currentPermission())
            return
        }
        val activity = reactApplicationContext.currentActivity as? PermissionAwareActivity
        if (activity == null) {
            // No Activity means no dialog. Answering with what we hold now is
            // honest; the caller retries once a screen is up. Deliberately not
            // a rejection: a refused permission is a state to show, not an
            // error to throw.
            promise.resolve(currentPermission())
            return
        }
        synchronized(this) {
            if (pendingPermission != null) {
                promise.resolve(currentPermission())
                return
            }
            pendingPermission = promise
        }
        val code = permissionRequestCode.incrementAndGet() and 0xFFFF
        // Recorded BEFORE the dialog: the process can die while it is on
        // screen, and a forgotten request reads as "never asked" forever.
        Permissions.markRequested(appContext, setOf(Manifest.permission.POST_NOTIFICATIONS))
        try {
            val listener = PermissionListener { _, _, _ ->
                val waiting = synchronized(this) { pendingPermission.also { pendingPermission = null } }
                waiting?.resolve(currentPermission())
                true
            }
            activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), code, listener)
        } catch (t: Throwable) {
            Log.w(TAG, "could not ask for notification permission", t)
            val waiting = synchronized(this) { pendingPermission.also { pendingPermission = null } }
            waiting?.resolve(currentPermission())
        }
    }

    // =====================================================================
    // Posting
    // =====================================================================

    override fun present(
        id: String,
        title: String,
        body: String,
        threadId: String,
        dataJson: String,
        promise: Promise,
    ) {
        try {
            val intent = launchIntent(threadId, dataJson)
            val builder = NotificationCompat.Builder(appContext, CHANNEL_ID)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(NotificationCompat.BigTextStyle().bigText(body))
                // The app's own icon. This library ships no drawables of its
                // own on purpose - an icon here would be one the app could not
                // change without editing the library.
                .setSmallIcon(appContext.applicationInfo.icon)
                .setAutoCancel(true)
                .setGroup(threadId)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE)
                .setContentIntent(intent)

            // Posting with the caller's id as the tag is what gives "3 new
            // messages" one banner rather than three: the same id replaces,
            // a different id adds.
            if (currentPermission() == "granted") {
                manager.notify(id, NOTIFICATION_ID, builder.build())
            }
            promise.resolve(null)
        } catch (t: Throwable) {
            promise.reject("failed", t.message ?: "Could not post the notification.", t)
        }
    }

    private fun launchIntent(threadId: String, dataJson: String): PendingIntent? {
        val launch = appContext.packageManager
            .getLaunchIntentForPackage(appContext.packageName)
            ?.apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
                putExtra(EXTRA_THREAD_ID, threadId)
                putExtra(EXTRA_DATA, dataJson)
            } ?: return null
        // FLAG_IMMUTABLE is mandatory from Android 12 and correct everywhere:
        // nothing outside this app has any business rewriting the thread id.
        return PendingIntent.getActivity(
            appContext,
            threadId.hashCode(),
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
    }

    /**
     * Android has no platform badge API.
     *
     * Every launcher that shows a number does it through its own vendor
     * protocol, and the libraries that paper over that are exactly the sort of
     * third-party dependency this app will not take. The count is still part of
     * the contract because iOS uses it, so this resolves quietly rather than
     * rejecting - the in-app unread dot, which is the part the user actually
     * looks at, is drawn by the navigation bar either way.
     */
    override fun setBadgeCount(count: Double, promise: Promise) {
        promise.resolve(null)
    }

    // =====================================================================
    // Clearing
    // =====================================================================

    override fun clearThread(threadId: String, promise: Promise) {
        try {
            val system = appContext.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager
            system?.activeNotifications
                ?.filter { it.notification.group == threadId }
                ?.forEach { manager.cancel(it.tag, it.id) }
            promise.resolve(null)
        } catch (t: Throwable) {
            // Reading active notifications can throw on some OEM builds. Not
            // being able to tidy up is not worth failing a promise the caller
            // made while opening a chat.
            Log.w(TAG, "could not clear thread $threadId", t)
            promise.resolve(null)
        }
    }

    override fun clearAll(promise: Promise) {
        manager.cancelAll()
        promise.resolve(null)
    }

    // =====================================================================
    // Taps
    // =====================================================================

    /**
     * Hand over the tap that launched the app, once.
     *
     * See the note on `consumeInitialOpen` in the spec: the launch Intent is
     * already attached to the Activity by the time this module is constructed,
     * which is itself before JavaScript can have subscribed to anything, so an
     * emit at that moment goes nowhere. Draining, so a screen remounting cannot
     * reopen the same conversation twice.
     */
    override fun consumeInitialOpen(promise: Promise) {
        val queued = synchronized(this) {
            handedOverInitialOpen = true
            pendingOpen.also { pendingOpen = null }
        }
        if (queued == null) {
            promise.resolve("")
            return
        }
        promise.resolve(
            JSONObject()
                .put("threadId", queued["threadId"])
                .put("data", queued["data"])
                .toString()
        )
    }

    override fun onNewIntent(intent: Intent?) {
        intent?.let { rememberOrEmit(it) }
    }

    override fun onActivityResult(activity: Activity?, requestCode: Int, resultCode: Int, data: Intent?) {
        // Nothing here starts an Activity for a result.
    }

    private fun rememberOrEmit(intent: Intent) {
        val threadId = intent.getStringExtra(EXTRA_THREAD_ID) ?: return
        val payload = mapOf(
            "threadId" to threadId,
            "data" to (intent.getStringExtra(EXTRA_DATA) ?: "{}"),
        )
        // Consumed, so a configuration change that re-delivers the same Intent
        // does not reopen the conversation a second time.
        intent.removeExtra(EXTRA_THREAD_ID)
        intent.removeExtra(EXTRA_DATA)

        val emitNow = synchronized(this) {
            if (!handedOverInitialOpen) { pendingOpen = payload }
            handedOverInitialOpen
        }
        if (emitNow) emitOpened(payload)
    }

    private fun emitOpened(payload: Map<String, String>) {
        try {
            emitOnNotificationOpened(
                Arguments.createMap().apply {
                    putString("threadId", payload["threadId"])
                    putString("data", payload["data"])
                }
            )
        } catch (t: Throwable) {
            // The C++ side is not wired up before JavaScript imports the module
            // and is gone once the React instance is. An emit that arrives a
            // moment too early or too late must be a no-op, not a crash.
            Log.w(TAG, "could not emit onNotificationOpened", t)
        }
    }

    override fun invalidate() {
        reactApplicationContext.removeActivityEventListener(this)
        super.invalidate()
    }

    private companion object {
        const val TAG = "AirLinkNotifications"
        const val CHANNEL_ID = "airlink-messages"

        /**
         * One numeric id for every notification, with the caller's string id as
         * the tag. Android identifies a notification by the (tag, id) pair, so
         * this gives the string ids the replace-by-identity behaviour the
         * contract promises without hashing them into a space where two
         * conversations could collide.
         */
        const val NOTIFICATION_ID = 1

        const val EXTRA_THREAD_ID = "com.airlink.notification.threadId"
        const val EXTRA_DATA = "com.airlink.notification.data"
    }
}
