package com.airlink.transport

import com.facebook.react.BaseReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

/**
 * Registers the transport TurboModule with React Native.
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
 */
class AirLinkTransportPackage : BaseReactPackage() {

    override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? =
        if (name == NativeAirLinkTransportSpec.NAME) {
            AirLinkTransportModule(reactContext)
        } else {
            null
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
            )
        )
    }
}
