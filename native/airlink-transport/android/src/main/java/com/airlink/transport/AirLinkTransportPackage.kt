package com.airlink.transport

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers this library's TurboModules with React Native.
 *
 * The host app adds this to its package list:
 *
 *     override fun getPackages(): List<ReactPackage> =
 *         PackageList(this).packages.apply { add(AirLinkTransportPackage()) }
 *
 * [BaseReactPackage] is the New Architecture base class: it resolves modules
 * lazily by name through [getModule], so nothing here touches a radio - or even
 * constructs the module - until JavaScript first imports it. The deprecated
 * `createNativeModules` path is deliberately not implemented; on the New
 * Architecture, which React Native 0.87 makes mandatory, it is never called.
 *
 * THREE MODULES, THREE SPECS. Local notifications and voice-message audio ship
 * in this library because it is the one place the app links native code, but
 * each is its own spec with its own method map rather than more methods on the
 * transport. That is not tidiness: a spec and an implementation that drift by a
 * single argument compile cleanly and then jump through a garbage pointer on
 * the first call, which has already happened here once. The smaller each map
 * is, the less there is to drift.
 */
class AirLinkTransportPackage : BaseReactPackage() {

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        when (name) {
            NativeAirLinkTransportSpec.NAME -> AirLinkTransportModule(reactContext)
            NativeAirLinkNotificationsSpec.NAME -> AirLinkNotificationsModule(reactContext)
            NativeAirLinkAudioSpec.NAME -> AirLinkAudioModule(reactContext)
            else -> null
        }

    override fun getReactModuleInfoProvider(): ReactModuleInfoProvider = ReactModuleInfoProvider {
        mapOf(
            NativeAirLinkTransportSpec.NAME to ReactModuleInfo(
                name = NativeAirLinkTransportSpec.NAME,
                className = AirLinkTransportModule::class.java.name,
                canOverrideExistingModule = false,
                // Emphatically not eager. The module owns Bluetooth and Wi-Fi;
                // constructing it at startup would cost battery on every launch,
                // and the permission prompts must appear when a capability is
                // first used, never on launch.
                needsEagerInit = false,
                isCxxModule = false,
                isTurboModule = true,
            ),
            NativeAirLinkNotificationsSpec.NAME to ReactModuleInfo(
                name = NativeAirLinkNotificationsSpec.NAME,
                className = AirLinkNotificationsModule::class.java.name,
                canOverrideExistingModule = false,
                // Not eager either, although it is tempting: the notification
                // channel and the launch Intent both have to exist before the
                // first banner, and they do - this module is constructed the
                // moment JavaScript imports its wrapper, which happens while
                // the app is still starting up and long before any message can
                // have arrived.
                needsEagerInit = false,
                isCxxModule = false,
                isTurboModule = true,
            ),
            NativeAirLinkAudioSpec.NAME to ReactModuleInfo(
                name = NativeAirLinkAudioSpec.NAME,
                className = AirLinkAudioModule::class.java.name,
                canOverrideExistingModule = false,
                // Emphatically not eager. It owns the microphone, and the
                // permission prompt must appear when the user first holds the
                // record button, never on launch.
                needsEagerInit = false,
                isCxxModule = false,
                isTurboModule = true,
            ),
        )
    }
}
