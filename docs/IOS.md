# iOS

Verified against **Xcode 26.3 (17C529), iOS SDK 26.2, Swift 6.2.4** on this
machine. Every API claim below was checked against the installed SDK headers or
Apple documentation.

---

## 1. Build

```bash
pnpm install
cd apps/mobile/ios && pod install
cd ../../.. && ./scripts/build-ios.sh
```

`build-ios.sh` filters the nullability and shadowing noise that third-party pods
emit, so a real error is impossible to miss. It must print `** BUILD SUCCEEDED **`.

To run:

```bash
pnpm --filter @airlink/mobile start        # Metro
pnpm --filter @airlink/mobile ios          # build, install, launch
```

Open `apps/mobile/ios/AirLink.xcworkspace` in Xcode — **not** the `.xcodeproj`.

**Deployment target: iOS 16.0.** React Native's own floor is 15.1, but the
VisionCamera barcode scanner (QR pairing) needs 15.5, so the Podfile sets 16.0.

---

## 2. Where the native code lives

Not in the Xcode project. It is a React Native library package at
[`native/airlink-transport`](../native/airlink-transport), whose podspec globs
`ios/**/*.{h,m,mm,swift}`. Adding a transport is adding a file — there is no
project file to edit and nothing to remember to register.

```
native/airlink-transport/
├── src/NativeAirLinkTransport.ts     the TurboModule spec — the contract
├── ios/
│   ├── RCTNativeAirLinkTransport.mm  the TurboModule; pure forwarding
│   ├── AirLinkTransportBridge.swift  routing, event fan-out
│   └── Transport/
│       ├── AirLinkTypes.swift        the Swift-side contract
│       ├── BleTransport.swift        CoreBluetooth, central + peripheral
│       ├── LocalNetworkTransport.swift  Network.framework
│       └── HotspotJoiner.swift       NEHotspotConfiguration
└── airlink-transport.podspec
```

### Why the module is Objective-C++ and the work is Swift

React Native's TurboModule machinery is C++: `getTurboModule:` returns a
`std::shared_ptr<facebook::react::TurboModule>`, which Swift cannot express. So
the module class must be ObjC++, and the radio work lives in Swift behind it —
the adapter pattern both Apple and the React Native docs recommend.

**Three traps worth knowing**, all hit while getting this to build:

1. The generated spec drags in the C++ TurboModule machinery, and CocoaPods
   feeds every *public* header of a pod into the umbrella header Swift compiles
   its module from. A public header importing the spec makes the pod's own Swift
   half fail with `'utility' file not found`. The ObjC++ interface therefore
   lives inside the `.mm`, where nothing else can see it.
2. The generated `SpecBase` derives from `NSObject`, so there is no super
   implementation of `invalidate` to chain to.
3. The Swift interface header import differs between static-library and
   framework builds. Probe for both with `__has_include`.

Events use the **codegen-generated typed emitters** (`emitOnPeerDiscovered:`),
not `RCTEventEmitter`, which is the 0.87 way.

---

## 3. CoreBluetooth

**Dual role.** One `CBCentralManager` and one `CBPeripheralManager` in the same
process, compile-verified under Swift 6.

**MTU is not controllable.** There is no API to request one. Read what you were
given: `peripheral.maximumWriteValueLength(for: .withoutResponse)` on the
central side, `central.maximumUpdateValueLength` on the peripheral side. The
commonly-quoted 185/182 figures are community numbers, not Apple's — query at
runtime, never hardcode. Values have regressed across iOS releases before.

**LE 2M PHY and Extended Data Length are automatic** and, per Apple DTS, not app
controllable. The peripheral role does expose coarse control via
`setDesiredConnectionLatency(_:for:)`, which the header itself hedges on. LE
Coded PHY has no CoreBluetooth API at all.

**Flow control is mandatory.** Honour `peripheral.canSendWriteWithoutResponse`
and `peripheralIsReady(toSendWriteWithoutResponse:)`; on the peripheral side
`updateValue(_:for:onSubscribedCentrals:)` returns `false` when the queue is
full and you must wait for `peripheralManagerIsReady(toUpdateSubscribers:)`.
Getting this wrong silently drops data.

**L2CAP is the bulk path.** `publishL2CAPChannel(withEncryption:)` yields a PSM,
which you publish in a GATT characteristic because L2CAP channels are not
discoverable on their own. The central calls `openL2CAPChannel(psm)`. Note the
Swift delegate is `peripheral(_:didOpen:error:)` — *not* `didOpenL2CAPChannel`,
obsoleted in Swift 3. A channel gives you an input/output stream pair, so the
transport length-frames it.

---

## 4. Network.framework

`NWParameters.includePeerToPeer = true` enables Apple peer-to-peer Wi-Fi (AWDL).
Three things to get right:

- It is **Bonjour-only**: it applies when advertising a Bonjour service on an
  `NWListener` or connecting to one.
- Set it on **both** the listener parameters *and* the connection parameters.
  Setting it only on the listener is the classic bug, per Apple DTS.
- AWDL uses **IPv6 link-local**. Do not force IPv4.

It works with **no Wi-Fi network joined** — Apple TN3179 confirms Bonjour
operations can trigger the local-network alert while the device is "off Wi-Fi".
It is Apple-only; TN3151 says so explicitly.

---

## 5. Info.plist

```
NSBluetoothAlwaysUsageDescription   why we use Bluetooth, and that location is not
NSLocalNetworkUsageDescription      why a shared Wi-Fi makes transfers fast
NSBonjourServices                   _airlink._tcp, _airlink._udp
NSCameraUsageDescription            scanning a friend's QR code
NSPhotoLibraryUsageDescription      sending a photo
NSPhotoLibraryAddUsageDescription   saving one a friend sent
NSMicrophoneUsageDescription        voice messages
UIBackgroundModes                   bluetooth-central, bluetooth-peripheral
```

Without `NSBonjourServices` listing the exact service type, Bonjour silently
fails. An app that touches CoreBluetooth without
`NSBluetoothAlwaysUsageDescription` **crashes**.

There is deliberately no location usage string: AirLink does not use location,
and an empty string reads as a request with no explanation.

---

## 6. Background — what is really possible

Honest, because the UX depends on it.

| Capability | Backgrounded / locked |
|---|---|
| Scanning | Works, but a **service-UUID filter is mandatory**, the interval is throttled, duplicates are coalesced, and scan responses are not read |
| Advertising | Works, but the local name is dropped and **all service UUIDs move to the overflow area**, discoverable only by an iOS device explicitly scanning for them |
| GATT connections | Maintained by the OS across suspension |
| Notifications waking the app | Yes — the one genuine background wake path, ~10 seconds per wake |
| L2CAP | Does **not** wake or keep the app alive (Apple DTS, forum 746286) |
| Network.framework / AWDL | Does not survive backgrounding |

**The consequence that matters: an Android phone cannot discover a backgrounded
iOS app.** Overflow-area services are documented as discoverable "only by an iOS
device explicitly scanning for them", so an Android `ScanFilter` on our service
UUID will not match. This is not something to engineer around; the app tells the
user *"Keep AirLink open to stay connected."* On a flight, with both people
using the app, that is what happens anyway.

iOS 26 adds one nuance: a Live Activity counts as "sufficiently in use" to lift
the scanning restrictions — but not once the screen is off.

**State restoration**: use `CBCentralManagerOptionRestoreIdentifierKey` and
re-create managers unconditionally at launch.
`UIApplicationLaunchOptionsBluetoothCentralsKey` is **deprecated as of iOS 26**;
do not key restoration off launch options. Set
`CBCentralManagerOptionShowPowerAlertKey` to `false` on a background launch so
the user is not shown an alert by an app they did not open.

---

## 7. Testing on real devices

The simulator has no Bluetooth radio, so discovery and connection can only be
tested on hardware. Everything above the transport — protocol, crypto,
reliability, games, file transfer, sync — is covered by the mock transport and
runs in Node. See [TESTING.md](TESTING.md).
