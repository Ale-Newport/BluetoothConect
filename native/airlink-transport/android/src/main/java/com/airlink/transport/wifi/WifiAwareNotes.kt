package com.airlink.transport.wifi

/*
 * WHY THERE IS NO WifiAwareTransport.kt IN THIS DIRECTORY
 * =======================================================
 *
 * This file exists so the next person to read this directory knows that Wi-Fi
 * Aware (NAN) was considered and deliberately left out, not forgotten. There is
 * no class, no adapter and no stub: the identifier lives on in the vocabulary
 * (TransportKind.WIFI_AWARE) and AirLinkTransportModule reports it honestly as
 * never available, which is all a transport nobody can use needs.
 *
 * The pitch is genuinely attractive: Wi-Fi Aware gives peer-to-peer discovery
 * and a high-bandwidth data path with no access point, no group owner
 * negotiation and no pairing, and Apple shipped a WiFiAware framework in
 * iOS 26. On paper it is exactly the transport this product wants. In practice
 * it fails on three separate counts, any one of which is disqualifying.
 *
 * 1. THE HARDWARE USUALLY IS NOT THERE.
 *    Wi-Fi Aware is gated behind PackageManager.FEATURE_WIFI_AWARE, which is
 *    optional and absent on most Android handsets in the field - including
 *    plenty of current mid-range devices. A transport that a majority of users
 *    cannot run is not a floor, and everything in AirLink has to work on the
 *    floor. BLE is the floor; Wi-Fi Direct and NSD are the upgrades.
 *
 * 2. iOS INTEROP DOES NOT WORK IN PRACTICE.
 *    Apple's implementation requires a paid-team entitlement, service names
 *    baked into Info.plist at build time, and a mandatory one-time system
 *    pairing ceremony with a six-digit PIN. Android-to-iPhone Aware sessions
 *    fail on mainstream handsets: missing DCEA attributes, auth status 15,
 *    PINs that are never displayed. So the one case that would justify the
 *    complexity - iPhone to Android with no network - is precisely the case it
 *    does not deliver. That case is served here by the local-only hotspot in
 *    HotspotHost.kt, which needs one system tap and then runs at full Wi-Fi
 *    speed.
 *
 * 3. IT WOULD BUY NOTHING WE DO NOT ALREADY HAVE.
 *    Android to Android already has Wi-Fi Direct in WifiDirectTransport.kt at
 *    several MB/s. Any device on a shared network already has NSD plus TCP in
 *    LocalNetworkTransport.kt at similar speed. Aware would be a third path to
 *    the same destinations, with its own discovery model, its own permission
 *    story and its own failure modes to test - on hardware most users do not
 *    have, for a case it does not actually solve.
 *
 * WHAT THE CODE DOES INSTEAD
 * --------------------------
 * AirLinkTransportModule.platformGate() reports 'wifiAware' as supported only
 * when FEATURE_WIFI_AWARE is present, and available never - with the reason
 * 'unsupportedHardware' on devices without the feature, and a documented
 * "we choose not to" explanation on the ones that have it. buildTransports()
 * registers nothing for it, so there is no object, no thread and no radio.
 * That keeps the identifier alive in the negotiation protocol: if the interop
 * story ever changes this becomes one new file here and no feature code
 * changes at all. Nothing in the product promises it today.
 *
 * If you do revisit it: android.net.wifi.aware.WifiAwareManager, an
 * attach/publish/subscribe session, then WifiAwareNetworkSpecifier through
 * ConnectivityManager.requestNetwork to get a real socket - at which point the
 * length framing in FramedTcp.kt applies unchanged, because it is the same
 * TCP-shaped byte stream as everything else here. Implement AirLinkTransport,
 * add one line to buildTransports(), and nothing above the transport layer
 * needs to know.
 */
