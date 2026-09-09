# Android

> **Build status, stated plainly.** There is **no Android SDK and no Android
> Studio on the machine this project was built on**, so the Kotlin in this
> repository has been written against the verified API surface and reviewed, but
> has **never been compiled**. Everything else — the whole `packages/` tree and
> the iOS app — is compiled and tested. Section 1 is the first thing to do.

---

## 1. Getting it to build

```bash
# 1. Install Android Studio, or just the command-line tools.
#    Then, from Android Studio's SDK Manager, install:
#      - Android SDK Platform 36  (targetSdk)
#      - Android SDK Platform 37  (compileSdk)
#      - Android SDK Build-Tools 37.0.0
#      - NDK 27.1.12297006
#      - Android SDK Command-line Tools

export ANDROID_HOME="$HOME/Library/Android/sdk"
export PATH="$ANDROID_HOME/platform-tools:$PATH"

# 2. JDK 17. Java 20 is on this machine, which AGP does not support.
#    brew install --cask temurin@17
export JAVA_HOME=$(/usr/libexec/java_home -v 17)

# 3. Then, from the repository root:
pnpm install
cd apps/mobile/android && ./gradlew assembleDebug
```

The single command that verifies the Android side:

```bash
cd apps/mobile/android && ./gradlew :airlink-transport:compileDebugKotlin
```

Expect to fix a handful of things on that first run. Every API used was checked
against `developer.android.com`, but uncompiled Kotlin is uncompiled Kotlin.

To run:

```bash
pnpm --filter @airlink/mobile start
pnpm --filter @airlink/mobile android
```

---

## 2. Configuration

| | |
|---|---|
| `minSdk` | 26 (`startAdvertisingSet`, Wi-Fi Aware) |
| `compileSdk` | 37 |
| `targetSdk` | 36 (Android 16) |
| Kotlin | 2.2.0 |
| JVM target | 17 |
| New Architecture | mandatory in RN 0.87; the `newArchEnabled` flag is a vestigial no-op |

L2CAP needs API 29, so it sits behind a runtime capability check rather than a
`minSdk` bump.

---

## 3. Where the native code lives

```
native/airlink-transport/android/
├── build.gradle
├── src/main/AndroidManifest.xml               permissions, merged into the app
└── src/main/java/com/airlink/transport/
    ├── AirLinkTransportModule.kt              the TurboModule
    ├── AirLinkTransportPackage.kt             BaseReactPackage registration
    ├── TransportTypes.kt                      the Kotlin-side contract
    ├── Permissions.kt                         the runtime permission matrix
    ├── ForegroundSessionService.kt            background sessions
    ├── ble/                                   BluetoothLeScanner / Advertiser / GattServer / L2CAP
    └── wifi/                                  NsdManager + TCP, Wi-Fi Direct, local-only hotspot
```

Autolinking finds the package through the workspace link; there is no manual
registration step.

---

## 4. Permissions

The matrix is where Android apps usually break. This is the exact manifest block
the library ships:

```xml
<!-- Android 11 and earlier -->
<uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="30" />

<!-- Android 12+ -->
<uses-permission android:name="android.permission.BLUETOOTH_SCAN"
                 android:usesPermissionFlags="neverForLocation" />
<uses-permission android:name="android.permission.BLUETOOTH_ADVERTISE" />
<uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />

<!-- Android 13+: Wi-Fi Direct, Wi-Fi Aware, local-only hotspot -->
<uses-permission android:name="android.permission.NEARBY_WIFI_DEVICES"
                 android:usesPermissionFlags="neverForLocation" />
```

`neverForLocation` is a promise to the system, and to the user, that AirLink
does not use these radios to work out where anyone is. It is also what lets the
app avoid asking for `ACCESS_FINE_LOCATION` at all on Android 12 and later —
which matters, because a messaging app asking for location is a reason not to
install it.

`ACCESS_FINE_LOCATION` is capped at `maxSdkVersion="30"` because on API 23–30 it
was genuinely required for BLE scanning, and only for that.

---

## 5. Bluetooth — the traps

**The GATT operation queue.** Android allows exactly **one** outstanding GATT
operation per connection: a write, a read, a descriptor write and an MTU request
all queue against the same slot. Issuing a second before the first callback
fires silently drops it. Almost every buggy Android BLE app gets this wrong, so
the transport serialises everything through an explicit queue with a timeout, so
a lost callback cannot wedge it forever.

**Deprecations that matter.** As of API 33,
`BluetoothGattCharacteristic.setValue`/`getValue` are deprecated. Use
`gatt.writeCharacteristic(characteristic, value, writeType)`, which returns a
status, and the `onCharacteristicChanged(gatt, characteristic, value)` /
`onCharacteristicRead(gatt, characteristic, value, status)` callbacks that
receive the value directly. `BluetoothAdapter.startLeScan` is long deprecated —
use `BluetoothLeScanner.startScan`.

**Advertising.** `startAdvertisingSet` (API 26+) is preferred over
`startAdvertising` and reports the parameters actually used. Check
`BluetoothAdapter.isMultipleAdvertisementSupported` first — not every device can
advertise at all, and one that cannot is a scan-only participant.

**Throughput.** `requestMtu(517)` is the ceiling; usable ATT payload is MTU − 3.
iOS will negotiate something smaller. `setPreferredPhy(PHY_LE_2M)` and
`requestConnectionPriority(CONNECTION_PRIORITY_HIGH)` while a transfer runs both
matter materially.

**L2CAP** (API 29+): `listenUsingInsecureL2capChannel()` gives a server socket
whose `.psm` is published in a GATT characteristic; the peer calls
`createInsecureL2capChannel(psm)`. It interoperates with iOS CoreBluetooth
L2CAP, and it is a byte stream, so the transport length-frames it.

---

## 6. Wi-Fi

**NSD.** `resolveService()` is deprecated as of API 34. Use
`registerServiceInfoCallback(NsdServiceInfo, Executor, ServiceInfoCallback)`,
and keep the old path only as a `Build.VERSION`-gated fallback. The service type
must match the iOS side exactly; Bonjour and NSD are both DNS-SD and
interoperate.

**Wi-Fi Direct.** `WifiP2pManager`, Android-to-Android only. `discoverPeers`,
`requestPeers`, `connect` with a `WifiP2pConfig.Builder`, then
`requestConnectionInfo` for the group owner address, then the same length-framed
TCP layer.

**Local-only hotspot.** `WifiManager.startLocalOnlyHotspot()` is the Android half
of the cross-platform bulk path: Android hosts, hands the credentials to the
iPhone over the existing BLE link, and the iPhone joins with
`NEHotspotConfiguration` after one system tap. The reservation dies with the
app, and the credentials are never logged.

**Wi-Fi Aware is deliberately not implemented.** `FEATURE_WIFI_AWARE` is absent
on most handsets, and iOS interop does not work in practice. The capability
report says so rather than leaving a reader to think it was forgotten.

---

## 7. Background

A **foreground service** with `foregroundServiceType="connectedDevice"` and the
`FOREGROUND_SERVICE_CONNECTED_DEVICE` permission is the only supported way to
keep a BLE session alive in the background on Android 14+. It costs a permanent
visible notification, which is why it is started only while a session is
actually live and stopped as soon as the last link closes.

Doze and App Standby throttle BLE scanning for an idle app. AirLink does not
fight this; it reconnects promptly on foreground and never claims to work
silently in a pocket.

---

## 8. Release

```bash
cd apps/mobile/android && ./gradlew assembleRelease
```

Before shipping: generate an upload keystore, set `applicationId` (currently
`com.airlink.app`, defined once in
[`packages/config/src/brand.ts`](../packages/config/src/brand.ts)), replace the
placeholder icons, and check the permission list against what the Play Console
prompts for — `NEARBY_WIFI_DEVICES` and `BLUETOOTH_SCAN` both require a
declaration of why they are used.
