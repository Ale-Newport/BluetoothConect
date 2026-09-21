/**
 * Taking the Wi-Fi away, on a device that has no Bluetooth to fall back on.
 *
 * WHY THIS EXISTS. The iOS Simulator has no Bluetooth radio at all -
 * CBCentralManager reports .unsupported - so "what does AirLink do with no
 * Wi-Fi?" could not be answered on a simulator without switching off the Mac's
 * own Wi-Fi, which takes the network from both simulators at once, kills the
 * host's connectivity, and does nothing whatsoever on a Mac wired to Ethernet.
 *
 * So Developer Mode can hold a transport down. The thing worth testing is that
 * it does so THROUGH THE REAL PATH rather than around it:
 *
 *   - availability() reports the same `noLocalNetwork` reason that
 *     LocalNetworkTransport.evaluate() returns when NWPathMonitor sees no
 *     usable interface, so no screen can tell this from a real outage;
 *   - the transport stays in `all()`, because one that vanished from the list
 *     would exercise a code path no phone ever takes;
 *   - open links are CLOSED, because two simulators talk over the host's
 *     loopback and an already-established TCP link would otherwise keep
 *     carrying traffic and the whole exercise would prove nothing;
 *   - a native report saying "actually the Wi-Fi is fine" cannot lift it,
 *     which it would otherwise do at the very next network path change.
 */
import { TransportKind } from '@airlink/core';
import { NativeTransportHost } from '../src/native/NativeTransportAdapter.js';

const CONFIG = {
  serviceUuid: '0000a1f0-0000-1000-8000-00805f9b34fb',
  rxCharacteristicUuid: '0000a1f1-0000-1000-8000-00805f9b34fb',
  txCharacteristicUuid: '0000a1f2-0000-1000-8000-00805f9b34fb',
  bonjourServiceType: '_airlink._tcp',
};

async function bootHost(): Promise<NativeTransportHost> {
  const host = new NativeTransportHost();
  await host.start(CONFIG);
  return host;
}

function transportOf(host: NativeTransportHost, kind: TransportKind) {
  const found = host.all().find((t) => t.kind === kind);
  if (!found) throw new Error(`the double should expose ${kind}`);
  return found;
}

afterEach(() => {
  globalThis.__airlinkNativeTest?.clearCalls();
});

test('the local network is available until it is held down', async () => {
  const host = await bootHost();
  const wifi = transportOf(host, TransportKind.LOCAL_NETWORK);
  expect((await wifi.availability()).available).toBe(true);

  await host.setSuppressed(TransportKind.LOCAL_NETWORK, true);

  expect((await wifi.availability()).available).toBe(false);
});

test('it reports the reason a real outage reports, so no screen can tell them apart', async () => {
  const host = await bootHost();
  await host.setSuppressed(TransportKind.LOCAL_NETWORK, true);

  const availability = await transportOf(host, TransportKind.LOCAL_NETWORK).availability();
  expect(availability.reason).toBe('noLocalNetwork');
  // And a sentence for a person, not an identifier. The startup path used to
  // put `reason` in this slot and the UI rendered "unsupportedHardware".
  expect(availability.detail).toBeTruthy();
  expect(availability.detail).not.toBe(availability.reason);
});

test('the transport stays in all(), because a missing one is a path no phone takes', async () => {
  const host = await bootHost();
  const before = host.all().length;

  await host.setSuppressed(TransportKind.LOCAL_NETWORK, true);

  expect(host.all()).toHaveLength(before);
  expect(host.all().map((t) => t.kind)).toContain(TransportKind.LOCAL_NETWORK);
});

test('it emits availabilityChanged, which is how every listener finds out', async () => {
  const host = await bootHost();
  const wifi = transportOf(host, TransportKind.LOCAL_NETWORK);
  const seen: boolean[] = [];
  wifi.events.on('availabilityChanged', ({ availability }) => seen.push(availability.available));

  await host.setSuppressed(TransportKind.LOCAL_NETWORK, true);
  await host.setSuppressed(TransportKind.LOCAL_NETWORK, false);

  expect(seen).toEqual([false, true]);
});

test('holding it down twice emits once, so listeners are not woken for nothing', async () => {
  const host = await bootHost();
  const wifi = transportOf(host, TransportKind.LOCAL_NETWORK);
  const seen: boolean[] = [];
  wifi.events.on('availabilityChanged', ({ availability }) => seen.push(availability.available));

  await host.setSuppressed(TransportKind.LOCAL_NETWORK, true);
  await host.setSuppressed(TransportKind.LOCAL_NETWORK, true);

  expect(seen).toEqual([false]);
});

/**
 * The one that would have bitten. While suppressed the native layer keeps
 * reporting the truth - the Wi-Fi really is there - and NWPathMonitor fires on
 * every path change. Without the guard the radio would flicker straight back
 * on, and the test using it would silently become meaningless.
 */
test('a native "the Wi-Fi is fine" report cannot lift the suppression', async () => {
  const host = await bootHost();
  const wifi = transportOf(host, TransportKind.LOCAL_NETWORK);
  await host.setSuppressed(TransportKind.LOCAL_NETWORK, true);

  globalThis.__airlinkNativeTest?.emit('onTransportAvailabilityChanged', {
    kind: 'localNetwork',
    available: true,
    reason: '',
    detail: '',
  });

  expect((await wifi.availability()).available).toBe(false);
});

test('letting it go restores whatever the native layer last reported', async () => {
  const host = await bootHost();
  const wifi = transportOf(host, TransportKind.LOCAL_NETWORK);

  await host.setSuppressed(TransportKind.LOCAL_NETWORK, true);
  await host.setSuppressed(TransportKind.LOCAL_NETWORK, false);

  expect((await wifi.availability()).available).toBe(true);
});

test('Bluetooth is untouched: this is a Wi-Fi switch, not a kill switch', async () => {
  const host = await bootHost();
  await host.setSuppressed(TransportKind.LOCAL_NETWORK, true);

  expect((await transportOf(host, TransportKind.BLE).availability()).available).toBe(true);
  expect(host.suppressedKinds()).toEqual([TransportKind.LOCAL_NETWORK]);
});

test('suppressing stops advertising and discovery, not just the reported state', async () => {
  const host = await bootHost();
  const wifi = transportOf(host, TransportKind.LOCAL_NETWORK);
  await wifi.startDiscovery();
  await wifi.startAdvertising({ protocolVersion: 1, token: new Uint8Array([1, 2, 3]), displayName: 'Ada' });
  globalThis.__airlinkNativeTest?.clearCalls();

  await host.setSuppressed(TransportKind.LOCAL_NETWORK, true);

  // Staying findable while claiming to be off the network is the failure this
  // guards: the peer would go on seeing us and the row would never disappear.
  const calls = globalThis.__airlinkNativeTest?.calls() ?? [];
  const stopped = calls
    .filter((c) => c.kind === TransportKind.LOCAL_NETWORK)
    .map((c) => c.name);
  expect(stopped).toContain('stopDiscovery');
  expect(stopped).toContain('stopAdvertising');
});

test('an unknown transport is a no-op rather than a throw', async () => {
  const host = await bootHost();
  // Wi-Fi Direct is Android-only and absent from the double. A Developer Mode
  // switch must not explode on a device that lacks the radio it names.
  await expect(host.setSuppressed(TransportKind.WIFI_DIRECT, true)).resolves.toBeUndefined();
  expect(host.suppressedKinds()).toEqual([]);
});
