package com.airlink.transport

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.MediaRecorder
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.modules.core.PermissionAwareActivity
import com.facebook.react.modules.core.PermissionListener
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlin.math.log10

/**
 * The Kotlin half of the voice-message module: record one note, play one note.
 *
 * WHY THE ENCODING IS WHAT IT IS. Every file written here is about to be pushed
 * down a Bluetooth link that moves roughly 40 KB a second. Mono AAC at 22.05
 * kHz and 24 kbps costs about 3 KB per second of speech, so a one-minute note
 * is around 180 KB and arrives in a handful of seconds. The settings a phone
 * would normally reach for - 44.1 kHz stereo at 128 kbps - make the same minute
 * close to a megabyte, which the user experiences not as a large file but as a
 * broken app. See AudioRecorder.swift for the same numbers on the iOS side;
 * they are deliberately identical so a note sounds the same whichever phone
 * recorded it.
 *
 * THREADING. Every public entry point hops onto one [HandlerThread] before it
 * touches the state below, for the same reason the transport module does: it
 * removes every lock, and it gives the level and progress timers somewhere to
 * live that is not the UI thread.
 */
@ReactModule(name = NativeAirLinkAudioSpec.NAME)
class AirLinkAudioModule(reactContext: ReactApplicationContext) :
    NativeAirLinkAudioSpec(reactContext) {

    private val appContext: Context = reactContext.applicationContext
    private val thread = HandlerThread("airlink-audio").apply { start() }
    private val handler = Handler(thread.looper)
    private val permissionRequestCode = AtomicInteger(4800)
    private var pendingPermission: Promise? = null

    private var recorder: MediaRecorder? = null
    private var recordingFile: File? = null
    private var recordingStartedAt = 0L
    private var smoothedLevel = 0f
    private var levelTicker: Runnable? = null

    private var player: MediaPlayer? = null
    private var playingPath: String? = null
    private var progressTicker: Runnable? = null

    private var focusRequest: AudioFocusRequest? = null

    /**
     * Set when something outside the app - a phone call, another app taking the
     * microphone - ended the recording for us. The file is finished and deleted
     * at that moment, and this is what makes the eventual `stopRecording`
     * reject rather than hand the chat layer a note the user never finished.
     */
    private var recordingInterrupted = false

    // =====================================================================
    // Permission
    // =====================================================================

    override fun getPermission(promise: Promise) {
        promise.resolve(currentPermission())
    }

    private fun currentPermission(): String {
        if (appContext.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            return "granted"
        }
        // Android cannot tell "never asked" from "asked and refused" on its own,
        // so it reuses the record the radios already keep. Two separate records
        // of the same question would drift.
        return if (Permissions.wasRequested(appContext, Manifest.permission.RECORD_AUDIO)) {
            "denied"
        } else {
            "notAsked"
        }
    }

    override fun requestPermission(promise: Promise) {
        if (currentPermission() == "granted") {
            promise.resolve(true)
            return
        }
        val activity = reactApplicationContext.currentActivity as? PermissionAwareActivity
        if (activity == null) {
            // No Activity means no dialog. Answering "not granted" is honest and
            // the caller retries once a screen is up.
            promise.resolve(false)
            return
        }
        synchronized(this) {
            if (pendingPermission != null) {
                promise.resolve(false)
                return
            }
            pendingPermission = promise
        }
        val code = permissionRequestCode.incrementAndGet() and 0xFFFF
        Permissions.markRequested(appContext, setOf(Manifest.permission.RECORD_AUDIO))
        try {
            val listener = PermissionListener { _, _, _ ->
                val waiting = synchronized(this) { pendingPermission.also { pendingPermission = null } }
                waiting?.resolve(currentPermission() == "granted")
                true
            }
            activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), code, listener)
        } catch (t: Throwable) {
            Log.w(TAG, "could not ask for the microphone", t)
            val waiting = synchronized(this) { pendingPermission.also { pendingPermission = null } }
            waiting?.resolve(false)
        }
    }

    // =====================================================================
    // Recording
    // =====================================================================

    override fun startRecording(promise: Promise) {
        handler.post {
            if (recorder != null) {
                // Never silently replaces the running recording: a caller that
                // believed it was still recording the first note would go on to
                // send the second one in its place.
                promise.reject("busy", "A recording is already in progress.")
                return@post
            }
            if (currentPermission() != "granted") {
                promise.reject("permission_denied", "The microphone has not been allowed.")
                return@post
            }

            // The loudspeaker feeding back into the microphone is not a subtle
            // artefact; it is a recording of itself.
            stopPlaybackInternal(completed = false)

            val file = File(recordingsDirectory(), "voice-${UUID.randomUUID()}.m4a")
            try {
                requestAudioFocus()
                @Suppress("DEPRECATION")
                val created = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                    MediaRecorder(appContext)
                } else {
                    MediaRecorder()
                }
                created.apply {
                    setAudioSource(MediaRecorder.AudioSource.MIC)
                    setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                    setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                    setAudioChannels(1)
                    setAudioSamplingRate(SAMPLE_RATE)
                    setAudioEncodingBitRate(BIT_RATE)
                    setOutputFile(file.absolutePath)
                    setOnErrorListener { _, what, _ ->
                        Log.w(TAG, "recorder error $what")
                        handler.post { abandonRecording() }
                    }
                    prepare()
                    start()
                }
                recorder = created
                recordingFile = file
                recordingStartedAt = System.currentTimeMillis()
                recordingInterrupted = false
                smoothedLevel = 0f
                startLevelTicker()
                promise.resolve(null)
            } catch (t: Throwable) {
                file.delete()
                abandonAudioFocus()
                promise.reject("failed", t.message ?: "The microphone could not be started.", t)
            }
        }
    }

    override fun stopRecording(promise: Promise) {
        handler.post {
            if (recordingInterrupted) {
                recordingInterrupted = false
                promise.reject("interrupted", "The recording was interrupted and could not be finished.")
                return@post
            }
            val active = recorder
            val file = recordingFile
            if (active == null || file == null) {
                promise.reject("notRecording", "Nothing is being recorded.")
                return@post
            }

            // Wall-clock, not a recorder property: MediaRecorder exposes no
            // duration, and re-opening the finished file with a
            // MediaMetadataRetriever just to read one number costs more than
            // the millisecond of drift it would save.
            val durationMs = (System.currentTimeMillis() - recordingStartedAt).toDouble()
            stopLevelTicker()
            recorder = null
            recordingFile = null
            try {
                active.stop()
            } catch (t: Throwable) {
                // MediaRecorder.stop() throws when it was started less than a
                // moment ago and no frames were written. There is a file, and it
                // is not a voice message.
                Log.w(TAG, "recorder refused to stop", t)
                active.release()
                file.delete()
                abandonAudioFocus()
                promise.reject("empty", "The recording produced no audio.")
                return@post
            }
            active.release()
            abandonAudioFocus()

            val size = file.length().toDouble()
            if (size <= 0) {
                file.delete()
                promise.reject("empty", "The recording produced no audio.")
                return@post
            }

            promise.resolve(
                Arguments.createMap().apply {
                    putString("path", file.absolutePath)
                    putDouble("durationMs", durationMs)
                    putDouble("sizeBytes", size)
                }
            )
        }
    }

    override fun cancelRecording(promise: Promise) {
        handler.post {
            abandonRecording()
            recordingInterrupted = false
            promise.resolve(null)
        }
    }

    /** Must run on [handler]. Stops, releases and deletes, swallowing anything
     *  that goes wrong: this is the path taken when something has already gone
     *  wrong. */
    private fun abandonRecording() {
        stopLevelTicker()
        val active = recorder
        val file = recordingFile
        recorder = null
        recordingFile = null
        if (active != null) {
            try {
                active.stop()
            } catch (t: Throwable) {
                Log.w(TAG, "recorder refused to stop while cancelling", t)
            }
            active.release()
            recordingInterrupted = true
        }
        file?.delete()
        abandonAudioFocus()
    }

    /**
     * Recordings live in the app's own files directory, not the cache.
     *
     * A note sits on disk between being recorded and being accepted by the
     * peer, which over Bluetooth can be a while, and the system empties the
     * cache whenever it likes. A file that vanished mid-transfer would surface
     * as a transfer that failed for no reason anyone could reproduce.
     */
    private fun recordingsDirectory(): File =
        File(appContext.filesDir, "AirLinkVoice").apply { mkdirs() }

    // =====================================================================
    // Metering
    // =====================================================================

    /**
     * Ten samples a second, not one per audio frame: the waveform is a drawing,
     * and nobody can see a drawing move eighty times a second.
     */
    private fun startLevelTicker() {
        val ticker = object : Runnable {
            override fun run() {
                val active = recorder ?: return
                val amplitude = try {
                    active.maxAmplitude
                } catch (t: Throwable) {
                    0
                }
                emitSafely("onLevel") {
                    emitOnLevel(
                        Arguments.createMap().apply {
                            putDouble("level", smooth(normalise(amplitude)).toDouble())
                        }
                    )
                }
                handler.postDelayed(this, TICK_MS)
            }
        }
        levelTicker = ticker
        handler.postDelayed(ticker, TICK_MS)
    }

    private fun stopLevelTicker() {
        levelTicker?.let { handler.removeCallbacks(it) }
        levelTicker = null
    }

    /**
     * Amplitude to 0..1.
     *
     * `maxAmplitude` is a linear 0..32767, and linear is the wrong space for a
     * waveform: ordinary speech sits so far down the scale that the bars barely
     * move. Converting to dB and cutting the range off at -50 - everything
     * quieter is silence, as far as a drawing is concerned - gives the same
     * curve the iOS side gets from `averagePower`.
     */
    private fun normalise(amplitude: Int): Float {
        if (amplitude <= 0) return 0f
        val decibels = (20.0 * log10(amplitude / MAX_AMPLITUDE)).toFloat()
        val clamped = decibels.coerceIn(FLOOR_DB, 0f)
        return (clamped - FLOOR_DB) / -FLOOR_DB
    }

    /** Rises quickly and falls slowly: a waveform that drops to nothing in
     *  every pause between words reads as a microphone that keeps cutting out. */
    private fun smooth(level: Float): Float {
        val weight = if (level > smoothedLevel) 0.6f else 0.25f
        smoothedLevel += (level - smoothedLevel) * weight
        return smoothedLevel
    }

    // =====================================================================
    // Playback
    // =====================================================================

    override fun play(path: String, promise: Promise) {
        handler.post {
            if (recorder != null) {
                promise.reject("busy", "Cannot play while recording.")
                return@post
            }
            // Starting a second note stops the first. Two voice messages at once
            // is never what anybody meant by tapping play.
            stopPlaybackInternal(completed = false)

            try {
                requestAudioFocus()
                val created = MediaPlayer().apply {
                    setAudioAttributes(
                        AudioAttributes.Builder()
                            .setUsage(AudioAttributes.USAGE_MEDIA)
                            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                            .build()
                    )
                    setDataSource(path)
                    setOnCompletionListener { handler.post { stopPlaybackInternal(completed = true) } }
                    setOnErrorListener { _, _, _ ->
                        handler.post { stopPlaybackInternal(completed = false) }
                        true
                    }
                    prepare()
                    start()
                }
                player = created
                playingPath = path
                startProgressTicker()
                promise.resolve(null)
            } catch (t: Throwable) {
                abandonAudioFocus()
                promise.reject("failed", t.message ?: "The audio file could not be played.", t)
            }
        }
    }

    override fun stopPlayback(promise: Promise) {
        handler.post {
            stopPlaybackInternal(completed = false)
            promise.resolve(null)
        }
    }

    /** Must run on [handler]. Emits the finished event whenever there was
     *  something playing, so a bubble that was animating stops even when
     *  playback ended for a reason other than the file running out. */
    private fun stopPlaybackInternal(completed: Boolean) {
        stopProgressTicker()
        val active = player ?: return
        val path = playingPath ?: ""
        player = null
        playingPath = null
        try {
            active.stop()
        } catch (t: Throwable) {
            Log.w(TAG, "player refused to stop", t)
        }
        active.release()
        abandonAudioFocus()
        emitSafely("onPlaybackFinished") {
            emitOnPlaybackFinished(
                Arguments.createMap().apply {
                    putString("path", path)
                    putBoolean("completed", completed)
                }
            )
        }
    }

    private fun startProgressTicker() {
        val ticker = object : Runnable {
            override fun run() {
                val active = player ?: return
                emitSafely("onPlaybackProgress") {
                    emitOnPlaybackProgress(
                        Arguments.createMap().apply {
                            putDouble("positionMs", active.currentPosition.toDouble())
                            putDouble("durationMs", active.duration.toDouble())
                        }
                    )
                }
                handler.postDelayed(this, TICK_MS)
            }
        }
        progressTicker = ticker
        handler.postDelayed(ticker, TICK_MS)
    }

    private fun stopProgressTicker() {
        progressTicker?.let { handler.removeCallbacks(it) }
        progressTicker = null
    }

    // =====================================================================
    // Audio focus
    // =====================================================================

    /**
     * Focus is what makes a phone call end a recording.
     *
     * Android does not hand a recorder an interruption notification the way iOS
     * does; losing audio focus is the signal. The recording is abandoned rather
     * than paused, because a note cut off mid-sentence is not a note anybody
     * meant to send, and `stopRecording` is left something to reject with.
     */
    private fun requestAudioFocus() {
        val audio = appContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(attributes)
            .setOnAudioFocusChangeListener({ change ->
                if (change == AudioManager.AUDIOFOCUS_LOSS ||
                    change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT
                ) {
                    handler.post {
                        abandonRecording()
                        stopPlaybackInternal(completed = false)
                    }
                }
            }, handler)
            .build()
        focusRequest = request
        audio.requestAudioFocus(request)
    }

    private fun abandonAudioFocus() {
        if (recorder != null || player != null) return
        val audio = appContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
        focusRequest?.let { audio?.abandonAudioFocusRequest(it) }
        focusRequest = null
    }

    // =====================================================================
    // Teardown
    // =====================================================================

    /**
     * Every emit goes through here. The generated emitters call into the C++
     * TurboModule, which is not wired up before JavaScript imports the module
     * and is gone once the React instance is - so an emit a moment too early or
     * too late must be a no-op, not a crash on a timer thread.
     */
    private fun emitSafely(name: String, body: () -> Unit) {
        try {
            body()
        } catch (t: Throwable) {
            Log.w(TAG, "could not emit $name", t)
        }
    }

    override fun invalidate() {
        // A microphone still running after a reload is the kind of thing a user
        // notices in the status bar and never forgives.
        try {
            handler.post {
                abandonRecording()
                stopPlaybackInternal(completed = false)
            }
            handler.post { thread.quitSafely() }
        } catch (t: Throwable) {
            Log.w(TAG, "teardown failed", t)
        }
        super.invalidate()
    }

    private companion object {
        const val TAG = "AirLinkAudio"
        const val SAMPLE_RATE = 22_050
        const val BIT_RATE = 24_000
        const val TICK_MS = 100L
        const val FLOOR_DB = -50f
        const val MAX_AMPLITUDE = 32_767.0
    }
}
