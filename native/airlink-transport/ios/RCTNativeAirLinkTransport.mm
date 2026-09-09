#import "RCTNativeAirLinkTransport.h"

// The Swift half of this module. CocoaPods generates this header from every
// @objc declaration in the pod's Swift sources; the pod is named
// "airlink-transport", so its module name is "airlink_transport".
#import <airlink_transport/airlink_transport-Swift.h>

/**
 * Pure forwarding. Every method hands off to the Swift bridge and wires the
 * promise callbacks; every event comes back through the delegate and is emitted
 * with the codegen-generated typed emitters.
 *
 * There is deliberately no logic here at all. If something needs a decision
 * made, it belongs in Swift (radio behaviour) or in TypeScript (protocol
 * behaviour), never in the glue.
 */
// The delegate conformance is declared here rather than in the header so the
// public header does not have to import the generated Swift interface.
@interface RCTNativeAirLinkTransport () <AirLinkTransportBridgeDelegate>
@end

@implementation RCTNativeAirLinkTransport {
  AirLinkTransportBridge *_bridge;
}

RCT_EXPORT_MODULE(NativeAirLinkTransport)

- (instancetype)init {
  if (self = [super init]) {
    _bridge = [AirLinkTransportBridge shared];
    _bridge.delegate = self;
  }
  return self;
}

- (void)invalidate {
  if (_bridge.delegate == self) {
    _bridge.delegate = nil;
  }
  [super invalidate];
}

- (std::shared_ptr<facebook::react::TurboModule>)getTurboModule:
    (const facebook::react::ObjCTurboModule::InitParams &)params {
  return std::make_shared<facebook::react::NativeAirLinkTransportSpecJSI>(params);
}

#pragma mark - Capability and permissions

- (void)getCapabilities:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_bridge getCapabilitiesWithResolve:^(NSDictionary *value) { resolve(value); }
                               reject:^(NSString *code, NSString *message) { reject(code, message, nil); }];
}

- (void)requestPermissions:(NSArray *)transports
                   resolve:(RCTPromiseResolveBlock)resolve
                    reject:(RCTPromiseRejectBlock)reject {
  [_bridge requestPermissions:transports
                      resolve:^(NSDictionary *value) { resolve(value); }
                       reject:^(NSString *code, NSString *message) { reject(code, message, nil); }];
}

- (void)openSettings {
  [_bridge openSettings];
}

#pragma mark - Lifecycle

- (void)start:(NSString *)serviceUuid
    rxCharacteristicUuid:(NSString *)rxCharacteristicUuid
    txCharacteristicUuid:(NSString *)txCharacteristicUuid
      bonjourServiceType:(NSString *)bonjourServiceType
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  [_bridge startWithServiceUuid:serviceUuid
                             rx:rxCharacteristicUuid
                             tx:txCharacteristicUuid
                 bonjourService:bonjourServiceType
                        resolve:^{ resolve(nil); }
                         reject:^(NSString *code, NSString *message) { reject(code, message, nil); }];
}

- (void)stop:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_bridge stopWithResolve:^{ resolve(nil); }
                    reject:^(NSString *code, NSString *message) { reject(code, message, nil); }];
}

#pragma mark - Advertising and discovery

- (void)startAdvertising:(NSString *)transport
                   token:(NSString *)token
             displayName:(NSString *)displayName
                 resolve:(RCTPromiseResolveBlock)resolve
                  reject:(RCTPromiseRejectBlock)reject {
  [_bridge startAdvertising:transport
                      token:token
                displayName:displayName
                    resolve:^{ resolve(nil); }
                     reject:^(NSString *code, NSString *message) { reject(code, message, nil); }];
}

- (void)stopAdvertising:(NSString *)transport
                resolve:(RCTPromiseResolveBlock)resolve
                 reject:(RCTPromiseRejectBlock)reject {
  [_bridge stopAdvertising:transport
                   resolve:^{ resolve(nil); }
                    reject:^(NSString *code, NSString *message) { reject(code, message, nil); }];
}

- (void)startDiscovery:(NSString *)transport
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  [_bridge startDiscovery:transport
                  resolve:^{ resolve(nil); }
                   reject:^(NSString *code, NSString *message) { reject(code, message, nil); }];
}

- (void)stopDiscovery:(NSString *)transport
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject {
  [_bridge stopDiscovery:transport
                 resolve:^{ resolve(nil); }
                  reject:^(NSString *code, NSString *message) { reject(code, message, nil); }];
}

#pragma mark - Links

- (void)connect:(NSString *)transport
     endpointId:(NSString *)endpointId
      timeoutMs:(double)timeoutMs
        resolve:(RCTPromiseResolveBlock)resolve
         reject:(RCTPromiseRejectBlock)reject {
  [_bridge connect:transport
        endpointId:endpointId
         timeoutMs:(NSInteger)timeoutMs
           resolve:^(NSString *linkId) { resolve(linkId); }
            reject:^(NSString *code, NSString *message) { reject(code, message, nil); }];
}

- (void)disconnect:(NSString *)linkId
            reason:(NSString *)reason
           resolve:(RCTPromiseResolveBlock)resolve
            reject:(RCTPromiseRejectBlock)reject {
  [_bridge disconnect:linkId
               reason:reason
              resolve:^{ resolve(nil); }
               reject:^(NSString *code, NSString *message) { reject(code, message, nil); }];
}

- (void)send:(NSString *)linkId
        data:(NSString *)data
    reliable:(BOOL)reliable
     resolve:(RCTPromiseResolveBlock)resolve
      reject:(RCTPromiseRejectBlock)reject {
  [_bridge send:linkId
           data:data
       reliable:reliable
        resolve:^{ resolve(nil); }
         reject:^(NSString *code, NSString *message) { reject(code, message, nil); }];
}

- (void)getLinkMetrics:(NSString *)linkId
               resolve:(RCTPromiseResolveBlock)resolve
                reject:(RCTPromiseRejectBlock)reject {
  [_bridge getLinkMetrics:linkId
                  resolve:^(NSDictionary *value) { resolve(value); }
                   reject:^(NSString *code, NSString *message) { reject(code, message, nil); }];
}

#pragma mark - Wi-Fi handoff

- (void)createHotspot:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_bridge createHotspotWithResolve:^(NSDictionary *value) { resolve(value); }
                             reject:^(NSString *code, NSString *message) { reject(code, message, nil); }];
}

- (void)stopHotspot:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject {
  [_bridge stopHotspotWithResolve:^{ resolve(nil); }
                           reject:^(NSString *code, NSString *message) { reject(code, message, nil); }];
}

- (void)joinHotspot:(NSString *)ssid
         passphrase:(NSString *)passphrase
            resolve:(RCTPromiseResolveBlock)resolve
             reject:(RCTPromiseRejectBlock)reject {
  [_bridge joinHotspot:ssid
            passphrase:passphrase
               resolve:^(NSNumber *value) { resolve(value); }
                reject:^(NSString *code, NSString *message) { reject(code, message, nil); }];
}

- (void)leaveHotspot:(NSString *)ssid
             resolve:(RCTPromiseResolveBlock)resolve
              reject:(RCTPromiseRejectBlock)reject {
  [_bridge leaveHotspot:ssid
                resolve:^{ resolve(nil); }
                 reject:^(NSString *code, NSString *message) { reject(code, message, nil); }];
}

#pragma mark - AirLinkTransportBridgeDelegate

- (void)emitPeerDiscovered:(NSDictionary *)payload { [self emitOnPeerDiscovered:payload]; }
- (void)emitPeerLost:(NSDictionary *)payload { [self emitOnPeerLost:payload]; }
- (void)emitLinkOpened:(NSDictionary *)payload { [self emitOnLinkOpened:payload]; }
- (void)emitLinkState:(NSDictionary *)payload { [self emitOnLinkState:payload]; }
- (void)emitData:(NSDictionary *)payload { [self emitOnData:payload]; }
- (void)emitMtuChanged:(NSDictionary *)payload { [self emitOnMtuChanged:payload]; }
- (void)emitAvailabilityChanged:(NSDictionary *)payload { [self emitOnAvailabilityChanged:payload]; }
- (void)emitLog:(NSDictionary *)payload { [self emitOnLog:payload]; }

@end
