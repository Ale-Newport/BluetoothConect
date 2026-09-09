import Foundation
import NetworkExtension

/**
 * Joining a peer's hotspot.
 *
 * This is the only route to high-bandwidth iPhone-to-Android transfer when
 * there is no network at all. Apple gives an app no way to CREATE a hotspot, but
 * NEHotspotConfiguration lets it ask the OS to JOIN one: the Android peer starts
 * a local-only hotspot, hands its SSID and passphrase across the Bluetooth link
 * we already have, and the iPhone joins after a single system confirmation. Both
 * sides then talk Bonjour + TCP at real Wi-Fi speed.
 *
 * `joinOnce = true` means the configuration is not persisted: the network is
 * forgotten when the app exits, so AirLink never leaves a stranger's hotspot in
 * the user's saved-network list.
 */
enum HotspotJoiner {

    static func join(ssid: String, passphrase: String, completion: @escaping (Result<Bool, Error>) -> Void) {
        guard !ssid.isEmpty else {
            completion(.failure(AirLinkError.failed("hotspot SSID was empty")))
            return
        }
        // NEHotspotConfiguration requires WPA2/WPA3 credentials of at least 8
        // characters; anything shorter is rejected by the system with an opaque
        // error, so we say something useful instead.
        guard passphrase.count >= 8 else {
            completion(.failure(AirLinkError.failed("hotspot passphrase must be at least 8 characters")))
            return
        }

        let configuration = NEHotspotConfiguration(ssid: ssid, passphrase: passphrase, isWEP: false)
        configuration.joinOnce = true
        configuration.lifeTimeInDays = 1

        NEHotspotConfigurationManager.shared.apply(configuration) { error in
            guard let error = error as NSError? else {
                completion(.success(true))
                return
            }
            // "Already associated" is success from the caller's point of view.
            if error.domain == NEHotspotConfigurationErrorDomain,
               error.code == NEHotspotConfigurationError.alreadyAssociated.rawValue {
                completion(.success(true))
                return
            }
            if error.domain == NEHotspotConfigurationErrorDomain,
               error.code == NEHotspotConfigurationError.userDenied.rawValue {
                completion(.success(false))
                return
            }
            completion(.failure(AirLinkError.failed("could not join the hotspot: \(error.localizedDescription)")))
        }
    }

    static func leave(ssid: String) {
        guard !ssid.isEmpty else { return }
        NEHotspotConfigurationManager.shared.removeConfiguration(forSSID: ssid)
    }
}
