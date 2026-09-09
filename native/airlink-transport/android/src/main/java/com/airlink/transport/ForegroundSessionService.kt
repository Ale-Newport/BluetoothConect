package com.airlink.transport

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * The foreground service that keeps a live AirLink session running while the
 * app is in the background.
 *
 * WHY THIS EXISTS. From Android 14 a foreground service with type
 * `connectedDevice`, plus FOREGROUND_SERVICE_CONNECTED_DEVICE, is the only
 * supported way to keep a Bluetooth session alive once the app leaves the
 * foreground. Without it the system stops the app's background work, the GATT
 * connection drops, and a conversation dies the moment the phone goes in a
 * pocket.
 *
 * WHAT IT COSTS. A permanent, user-visible notification that cannot be
 * dismissed while the service runs. That is not a detail we can design away, so
 * the service is started only while at least one link is actually open and
 * stopped the instant the last one closes - see `updateForegroundSession` in
 * [AirLinkTransportModule]. An app that showed this notification all the time
 * would be lying about what it is doing.
 *
 * WHAT IT DOES NOT BUY. It keeps a session that already exists alive; it does
 * not make the app discoverable to a peer that has not connected yet, and it
 * does not survive the user swiping the app away. The product must not promise
 * silent background reconnection on either platform.
 *
 * MANIFEST. This service must be declared by the host app (or by this library's
 * manifest) as:
 *
 *     <service android:name="com.airlink.transport.ForegroundSessionService"
 *              android:exported="false"
 *              android:foregroundServiceType="connectedDevice" />
 *
 * If it is not declared, [start] fails, says so in the log, and the session
 * simply loses background survival. Everything else keeps working - an offline
 * app that says "not connected" is far better than one that crashes.
 */
class ForegroundSessionService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        // A null intent means the system restarted us by itself. There is no
        // session behind that restart, and a notification claiming an active
        // connection that does not exist is worse than no notification, so stop.
        if (intent == null) {
            stopSelf()
            return START_NOT_STICKY
        }

        val linkCount = intent.getIntExtra(EXTRA_LINK_COUNT, 0)
        if (linkCount <= 0) {
            stopSession()
            return START_NOT_STICKY
        }

        try {
            createChannel()
            val notification = buildNotification(linkCount)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
                )
            } else {
                // Before API 29 a foreground service has no type at all.
                startForeground(NOTIFICATION_ID, notification)
            }
        } catch (t: Throwable) {
            // API 31+ throws when a foreground service is started from the
            // background; API 34+ throws when the declared type is missing or
            // its prerequisite permission is not held. Neither is worth dying
            // for: we lose background survival, not the session.
            Log.w(TAG, "could not enter the foreground; the session will not survive backgrounding", t)
            stopSelf()
        }

        // Never resurrect on our own. The module starts us when a link opens.
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        stopSession()
        super.onDestroy()
    }

    private fun stopSession() {
        try {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } catch (t: Throwable) {
            Log.w(TAG, "stopForeground failed", t)
        }
        stopSelf()
    }

    private fun createChannel() {
        val manager = getSystemService(NotificationManager::class.java) ?: return
        // IMPORTANCE_LOW: visible and silent. A connection notification that
        // buzzed every time a friend walked back into range would be a bug.
        val channel = NotificationChannel(
            CHANNEL_ID,
            CHANNEL_NAME,
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = CHANNEL_DESCRIPTION
            setShowBadge(false)
            enableVibration(false)
            enableLights(false)
        }
        // Creating a channel that already exists updates only its name and
        // description, never the user's own choices - which is also how a host
        // app localises this: create the channel with this id first, and these
        // English strings never win.
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(linkCount: Int): Notification {
        val text = if (linkCount == 1) {
            "Connected to 1 nearby device"
        } else {
            "Connected to $linkCount nearby devices"
        }

        val builder = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("AirLink is connected")
            .setContentText(text)
            // Honest sub-text: this is exactly what the notification buys.
            .setStyle(
                Notification.BigTextStyle().bigText(
                    "$text. Keeping this notification lets messages keep arriving while " +
                        "AirLink is in the background."
                )
            )
            .setSmallIcon(smallIcon())
            .setOngoing(true)
            .setShowWhen(false)
            .setOnlyAlertOnce(true)
            .setLocalOnly(true)
            .setCategory(Notification.CATEGORY_SERVICE)

        launchIntent()?.let { builder.setContentIntent(it) }
        return builder.build()
    }

    private fun launchIntent(): PendingIntent? = try {
        packageManager.getLaunchIntentForPackage(packageName)?.let { intent ->
            PendingIntent.getActivity(
                this,
                0,
                intent,
                // Immutable is mandatory from API 31 and correct everywhere: no
                // one else gets to rewrite where this notification leads.
                PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
            )
        }
    } catch (t: Throwable) {
        Log.w(TAG, "could not build the notification's launch intent", t)
        null
    }

    /**
     * A library cannot ship drawable resources into a host app's namespace, so
     * the host names one in its manifest:
     *
     *     <meta-data android:name="com.airlink.transport.notification_icon"
     *                android:resource="@drawable/ic_airlink_notification" />
     *
     * Without it we fall back to the app's own launcher icon: Android tints
     * small icons flat white, so a launcher icon looks worse than a purpose-made
     * silhouette, but it always exists and it always resolves.
     */
    private fun smallIcon(): Int {
        try {
            val pm = packageManager
            val info: ApplicationInfo = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                pm.getApplicationInfo(
                    packageName,
                    PackageManager.ApplicationInfoFlags.of(PackageManager.GET_META_DATA.toLong()),
                )
            } else {
                @Suppress("DEPRECATION")
                pm.getApplicationInfo(packageName, PackageManager.GET_META_DATA)
            }
            val declared = info.metaData?.getInt(META_DATA_ICON, 0) ?: 0
            if (declared != 0) return declared
            if (info.icon != 0) return info.icon
        } catch (t: Throwable) {
            Log.w(TAG, "could not resolve a notification icon", t)
        }
        return applicationInfo.icon
    }

    companion object {
        private const val TAG = "AirLinkSession"

        private const val CHANNEL_ID = "com.airlink.transport.session"
        private const val CHANNEL_NAME = "Nearby connections"
        private const val CHANNEL_DESCRIPTION =
            "Shown while AirLink is holding a connection to a nearby device open."

        private const val META_DATA_ICON = "com.airlink.transport.notification_icon"

        /** Arbitrary but fixed: "AL" in hex. Reusing it is what updates the notification. */
        private const val NOTIFICATION_ID = 0x414C

        private const val EXTRA_LINK_COUNT = "com.airlink.transport.linkCount"

        /**
         * Start, or update, the session notification.
         *
         * @return false when the service could not be started at all, so the
         *   caller can say so in the diagnostic log rather than assuming
         *   background survival it does not have.
         */
        fun start(context: Context, linkCount: Int): Boolean = try {
            val intent = Intent(context, ForegroundSessionService::class.java)
                .putExtra(EXTRA_LINK_COUNT, linkCount)
            context.startForegroundService(intent)
            true
        } catch (t: Throwable) {
            Log.w(
                TAG,
                "could not start the session service - is it declared in the manifest with " +
                    "android:foregroundServiceType=\"connectedDevice\"?",
                t,
            )
            false
        }

        fun stop(context: Context) {
            try {
                context.stopService(Intent(context, ForegroundSessionService::class.java))
            } catch (t: Throwable) {
                Log.w(TAG, "could not stop the session service", t)
            }
        }
    }
}
