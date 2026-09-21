import Foundation
import AVFoundation

/**
 * The Swift half of the voice-message module: record one note, play one note.
 *
 * WHY THE ENCODING IS WHAT IT IS. Every file this class writes is about to be
 * pushed down a Bluetooth link at roughly 40 KB a second. That single fact
 * decides the format:
 *
 *   AAC, mono, 22.05 kHz, 24 kbps  ->  3 KB per second of speech
 *
 * A one-minute voice note is therefore about 180 KB and takes five seconds or
 * so to reach the other phone. The same minute at the settings a phone would
 * normally reach for - 44.1 kHz stereo at 128 kbps - is close to a megabyte and
 * takes half a minute, which the user experiences not as a large file but as a
 * broken app. 24 kbps mono AAC is comfortably intelligible for speech (it is in
 * the range voice codecs have used for decades); it would be a poor way to send
 * music, and this is not an app for sending music.
 *
 * THE AUDIO SESSION is activated only while recording or playing and
 * deactivated immediately afterwards. Holding `.playAndRecord` open would keep
 * the route captured, leave the recording indicator up, and duck every other
 * app's audio for as long as the chat screen was on display.
 */
@objc public protocol AirLinkAudioDelegate: AnyObject {
    func emitLevel(_ payload: [String: Any])
    func emitPlaybackProgress(_ payload: [String: Any])
    func emitPlaybackFinished(_ payload: [String: Any])
}

@objc public final class AudioRecorder: NSObject {

    @objc public static let shared = AudioRecorder()

    @objc public weak var delegate: AirLinkAudioDelegate?

    /// Everything that touches the state below runs here. AVFoundation calls
    /// back from several different threads and the timers fire on their own.
    private let queue = DispatchQueue(label: "com.airlink.audio")

    private var recorder: AVAudioRecorder?
    private var recordingURL: URL?
    private var levelTimer: DispatchSourceTimer?
    /// Smoothed level, so the waveform does not flicker between frames.
    private var smoothedLevel: Float = 0

    private var player: AVAudioPlayer?
    private var playingPath: String?
    private var progressTimer: DispatchSourceTimer?

    /**
     * Set when something outside the app - almost always an incoming phone
     * call - ended the recording for us. The file is finalised and deleted at
     * that moment, and this is what makes the eventual `stopRecording` reject
     * rather than resolve with a note the user never finished saying.
     */
    private var recordingInterrupted = false

    private override init() {
        super.init()
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance()
        )
    }

    // MARK: - Permission

    @objc public func getPermission(resolve: @escaping (String) -> Void) {
        if #available(iOS 17.0, *) {
            resolve(Self.name(for: AVAudioApplication.shared.recordPermission))
        } else {
            resolve(Self.legacyName(for: AVAudioSession.sharedInstance().recordPermission))
        }
    }

    @objc public func requestPermission(resolve: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission { granted in resolve(granted) }
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission { granted in resolve(granted) }
        }
    }

    @available(iOS 17.0, *)
    private static func name(for permission: AVAudioApplication.recordPermission) -> String {
        switch permission {
        case .undetermined: return "notAsked"
        case .denied: return "denied"
        case .granted: return "granted"
        @unknown default: return "denied"
        }
    }

    private static func legacyName(for permission: AVAudioSession.RecordPermission) -> String {
        switch permission {
        case .undetermined: return "notAsked"
        case .denied: return "denied"
        case .granted: return "granted"
        @unknown default: return "denied"
        }
    }

    // MARK: - Recording

    @objc public func startRecording(resolve: @escaping () -> Void,
                                     reject: @escaping (String, String) -> Void) {
        queue.async {
            guard self.recorder == nil else {
                // Never silently replaces the running recording: a caller that
                // believed it was still recording the first note would go on to
                // send the second one in its place.
                reject("busy", "A recording is already in progress.")
                return
            }

            // Playing and recording at once is not a thing this app does, and
            // leaving a player running would feed the loudspeaker straight back
            // into the microphone.
            self.stopPlaybackLocked(completed: false)

            do {
                let session = AVAudioSession.sharedInstance()
                // `.duckOthers` rather than interrupting: the user is recording
                // a few seconds of speech, and whatever they were listening to
                // should come back at full volume afterwards rather than having
                // been stopped. `.defaultToSpeaker` matters for the playback
                // half - without it an iPhone routes `.playAndRecord` to the
                // earpiece and playback sounds broken.
                //
                // Deliberately NOT `.allowBluetooth`. Routing the microphone
                // through a headset switches the Bluetooth radio into the
                // hands-free profile, and this app is holding that radio open
                // for the link that is about to carry the recording. The
                // built-in microphone is the one that does not fight the
                // transport for the antenna.
                try session.setCategory(.playAndRecord,
                                        mode: .spokenAudio,
                                        options: [.duckOthers, .defaultToSpeaker])
                try session.setActive(true)

                let url = try Self.newRecordingURL()
                let recorder = try AVAudioRecorder(url: url, settings: Self.encoderSettings)
                recorder.delegate = self
                recorder.isMeteringEnabled = true
                guard recorder.record() else {
                    throw NSError(domain: "AirLinkAudio", code: 1, userInfo: [
                        NSLocalizedDescriptionKey: "The microphone could not be started.",
                    ])
                }

                self.recorder = recorder
                self.recordingURL = url
                self.recordingInterrupted = false
                self.smoothedLevel = 0
                self.startLevelTimerLocked()
                resolve()
            } catch {
                self.releaseSessionLocked()
                reject("failed", error.localizedDescription)
            }
        }
    }

    @objc public func stopRecording(resolve: @escaping ([String: Any]) -> Void,
                                    reject: @escaping (String, String) -> Void) {
        queue.async {
            if self.recordingInterrupted {
                self.recordingInterrupted = false
                reject("interrupted",
                       "The recording was interrupted and could not be finished.")
                return
            }
            guard let recorder = self.recorder, let url = self.recordingURL else {
                reject("notRecording", "Nothing is being recorded.")
                return
            }

            // Read the duration BEFORE stopping. `currentTime` is defined only
            // while the recorder is running and reads zero afterwards, so a
            // stop-then-measure ordering produces a voice note that claims to
            // last no time at all.
            let durationMs = recorder.currentTime * 1000
            recorder.stop()
            self.stopLevelTimerLocked()
            self.recorder = nil
            self.recordingURL = nil
            self.releaseSessionLocked()

            let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber
            let sizeBytes = size?.doubleValue ?? 0
            guard sizeBytes > 0 else {
                // An empty file is not a voice message. Handing one to the chat
                // layer would produce a bubble that plays silence.
                try? FileManager.default.removeItem(at: url)
                reject("empty", "The recording produced no audio.")
                return
            }

            resolve([
                "path": url.path,
                "durationMs": durationMs,
                "sizeBytes": sizeBytes,
            ])
        }
    }

    @objc public func cancelRecording(resolve: @escaping () -> Void) {
        queue.async {
            self.recorder?.stop()
            self.stopLevelTimerLocked()
            if let url = self.recordingURL {
                try? FileManager.default.removeItem(at: url)
            }
            self.recorder = nil
            self.recordingURL = nil
            self.recordingInterrupted = false
            self.releaseSessionLocked()
            resolve()
        }
    }

    private static var encoderSettings: [String: Any] {
        [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: 22_050.0,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 24_000,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue,
        ]
    }

    /**
     * Recordings live in Application Support, not Caches.
     *
     * A note sits on disk between being recorded and being accepted by the
     * peer, which over Bluetooth can be a while; the system is free to empty
     * Caches at any point, and a file that vanished mid-transfer would surface
     * as a transfer that failed for no reason anyone could reproduce.
     */
    private static func newRecordingURL() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory,
                                               in: .userDomainMask,
                                               appropriateFor: nil,
                                               create: true)
        let folder = base.appendingPathComponent("AirLinkVoice", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder.appendingPathComponent("voice-\(UUID().uuidString).m4a")
    }

    // MARK: - Metering

    /**
     * Ten samples a second, not one per audio frame.
     *
     * The waveform is a drawing. At the frame rate the encoder works to this
     * would be 86 bridge crossings and 86 React renders a second for an
     * animation nobody can see move that fast.
     */
    private func startLevelTimerLocked() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.1, repeating: 0.1)
        timer.setEventHandler { [weak self] in
            guard let self, let recorder = self.recorder else { return }
            recorder.updateMeters()
            let level = self.smooth(Self.normalise(recorder.averagePower(forChannel: 0)))
            self.delegate?.emitLevel(["level": Double(level)])
        }
        timer.resume()
        levelTimer = timer
    }

    private func stopLevelTimerLocked() {
        levelTimer?.cancel()
        levelTimer = nil
    }

    /**
     * dB to 0..1.
     *
     * `averagePower` runs from -160 (digital silence) to 0 (full scale), but
     * ordinary speech at arm's length sits around -30 to -10. Mapping the whole
     * range gives a waveform that never moves, so the floor is -50: everything
     * quieter is silence as far as the drawing is concerned.
     */
    private static func normalise(_ decibels: Float) -> Float {
        let floorDb: Float = -50
        let clamped = max(floorDb, min(0, decibels))
        return (clamped - floorDb) / -floorDb
    }

    /// An exponential moving average, because the raw meter jitters enough
    /// between 100 ms samples to make the bars look like noise rather than
    /// like a voice.
    private func smooth(_ level: Float) -> Float {
        // Rises quickly and falls slowly: a waveform that drops instantly on
        // every pause between words reads as a microphone that keeps cutting
        // out.
        let weight: Float = level > smoothedLevel ? 0.6 : 0.25
        smoothedLevel += (level - smoothedLevel) * weight
        return smoothedLevel
    }

    // MARK: - Playback

    @objc public func play(_ path: String,
                           resolve: @escaping () -> Void,
                           reject: @escaping (String, String) -> Void) {
        queue.async {
            guard self.recorder == nil else {
                reject("busy", "Cannot play while recording.")
                return
            }
            // Starting a second note stops the first. Two voice messages at once
            // is never what anybody meant by tapping play.
            self.stopPlaybackLocked(completed: false)

            do {
                let session = AVAudioSession.sharedInstance()
                // `.playback` rather than `.playAndRecord`: the microphone is
                // not involved, and the playback-only category is the one that
                // routes to the loudspeaker and keeps working with the silent
                // switch on, which is what a user expects from a voice message
                // they deliberately tapped.
                try session.setCategory(.playback, mode: .spokenAudio, options: [.duckOthers])
                try session.setActive(true)

                let player = try AVAudioPlayer(contentsOf: URL(fileURLWithPath: path))
                player.delegate = self
                guard player.play() else {
                    throw NSError(domain: "AirLinkAudio", code: 2, userInfo: [
                        NSLocalizedDescriptionKey: "The audio file could not be played.",
                    ])
                }
                self.player = player
                self.playingPath = path
                self.startProgressTimerLocked()
                resolve()
            } catch {
                self.releaseSessionLocked()
                reject("failed", error.localizedDescription)
            }
        }
    }

    @objc public func stopPlayback(resolve: @escaping () -> Void) {
        queue.async {
            self.stopPlaybackLocked(completed: false)
            resolve()
        }
    }

    /// Must be called on `queue`. Emits the finished event whenever there was
    /// actually something playing, so the bubble that was animating stops even
    /// when playback was ended by something other than the file running out.
    private func stopPlaybackLocked(completed: Bool) {
        stopProgressTimerLocked()
        guard let player = self.player else { return }
        player.stop()
        let path = playingPath ?? ""
        self.player = nil
        self.playingPath = nil
        releaseSessionLocked()
        delegate?.emitPlaybackFinished(["path": path, "completed": completed])
    }

    private func startProgressTimerLocked() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.1, repeating: 0.1)
        timer.setEventHandler { [weak self] in
            guard let self, let player = self.player else { return }
            self.delegate?.emitPlaybackProgress([
                "positionMs": player.currentTime * 1000,
                "durationMs": player.duration * 1000,
            ])
        }
        timer.resume()
        progressTimer = timer
    }

    private func stopProgressTimerLocked() {
        progressTimer?.cancel()
        progressTimer = nil
    }

    // MARK: - Session

    /// Must be called on `queue`. Deactivating tells whatever we ducked that it
    /// may come back up; skipping it is how an app ends up silencing music for
    /// the rest of its run.
    private func releaseSessionLocked() {
        guard recorder == nil, player == nil else { return }
        try? AVAudioSession.sharedInstance().setActive(false, options: [.notifyOthersOnDeactivation])
    }

    // MARK: - Interruptions

    /**
     * A phone call, a Siri request, another app taking the microphone.
     *
     * The recorder is already suspended by the time this arrives. What matters
     * is that it is stopped properly rather than abandoned: `stop()` writes the
     * container's trailer, so the file on disk is a valid m4a instead of a
     * truncated one that some decoders play and others reject. Then it is
     * deleted, because a note cut off mid-sentence is not a note the user meant
     * to send, and `stopRecording` is left a flag to reject with - the chat
     * layer must be told the recording is gone, not handed a stub.
     *
     * Playback is simply stopped. Resuming audio the user cannot see is worse
     * than making them tap play again.
     */
    @objc private func handleInterruption(_ notification: Notification) {
        guard let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw),
              type == .began else { return }

        queue.async {
            if let recorder = self.recorder {
                recorder.stop()
                self.stopLevelTimerLocked()
                if let url = self.recordingURL {
                    try? FileManager.default.removeItem(at: url)
                }
                self.recorder = nil
                self.recordingURL = nil
                self.recordingInterrupted = true
            }
            self.stopPlaybackLocked(completed: false)
            self.releaseSessionLocked()
        }
    }
}

// MARK: - AVAudioRecorderDelegate

extension AudioRecorder: AVAudioRecorderDelegate {
    public func audioRecorderEncodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
        // Same treatment as an interruption: there is a file on disk and it is
        // not a voice message.
        queue.async {
            self.stopLevelTimerLocked()
            if let url = self.recordingURL {
                try? FileManager.default.removeItem(at: url)
            }
            self.recorder = nil
            self.recordingURL = nil
            self.recordingInterrupted = true
            self.releaseSessionLocked()
        }
    }
}

// MARK: - AVAudioPlayerDelegate

extension AudioRecorder: AVAudioPlayerDelegate {
    public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        queue.async { self.stopPlaybackLocked(completed: flag) }
    }

    public func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        queue.async { self.stopPlaybackLocked(completed: false) }
    }
}
