/**
 * The Bluetooth banner tells the truth, and only offers Settings when Settings
 * can do something.
 *
 * Four different facts used to arrive on the home screen wearing the same
 * sentence. "Bluetooth is off" was shown to someone who had DECLINED the
 * permission - which is not a switch they forgot - and to hardware with no
 * Bluetooth radio at all, under an "Open Settings" button that led to a page
 * where nothing could be changed. A dead button is worse than no button,
 * because the person keeps pressing it.
 *
 * This matters beyond tidiness: an App Review tester denies permissions on
 * purpose, and the first thing they see is this banner.
 */
import React from 'react';
import { act, render, screen, waitFor } from '@testing-library/react-native';
import { strings } from '@airlink/config';
import { TransportUnavailableReason } from '@airlink/core';
import App from '../App';
import { AirLinkClient } from '../src/client/AirLinkClient.js';
import { AppPhase, useAppStore } from '../src/state/index.js';

/**
 * The banner deliberately waits `RADIO_SETTLE_MS` before it will call Bluetooth
 * off, so that a launch does not accuse everybody for its first second. The
 * test has to live through that wait rather than around it.
 */
const RADIO_SETTLE_MS = 2500;

async function bootToHome(): Promise<void> {
  const client = new AirLinkClient({ appVersion: '0.1.0', platform: 'ios', deviceModel: 'test' });
  await client.load();
  await client.createProfile('Ada', null);
  await render(<App />);
  await waitFor(() => expect(useAppStore.getState().phase).toBe(AppPhase.READY));
  await act(async () => {
    jest.advanceTimersByTime(RADIO_SETTLE_MS + 100);
  });
}

/**
 * Drive the banner the way the transport layer does, through the store the
 * provider writes to - not by rendering the component with hand-made props,
 * which would prove only that the component can be called.
 */
async function radioSays(
  reason: TransportUnavailableReason | null,
  options: { readonly wifiOn: boolean },
): Promise<void> {
  await act(async () => {
    useAppStore.getState().setRadios({
      bluetoothOn: false,
      wifiOn: options.wifiOn,
      detail: null,
      bluetoothReason: reason,
    });
  });
}

beforeEach(() => {
  // Fake timers so the settle wait above costs nothing, but advance the clock
  // explicitly - the point of the wait is that it exists.
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  useAppStore.getState().reset();
  globalThis.__airlinkNativeTest?.clearCalls();
  globalThis.__airlinkSqliteTest?.clear();
  globalThis.__airlinkKeychainTest?.clear();
});

test('a switched-off radio says so, and offers Settings', async () => {
  await bootToHome();
  await radioSays(TransportUnavailableReason.RADIO_OFF, { wifiOn: false });
  expect(screen.getByText(strings.status.bluetoothOff)).toBeTruthy();
  expect(screen.getByText(strings.permissions.openSettings)).toBeTruthy();
});

test('a declined permission is not called "off", and still offers Settings', async () => {
  await bootToHome();
  await radioSays(TransportUnavailableReason.PERMISSION_DENIED, { wifiOn: false });
  expect(screen.getByText(strings.status.bluetoothDenied)).toBeTruthy();
  // The whole point: the old copy would have been shown here.
  expect(screen.queryByText(strings.status.bluetoothOff)).toBeNull();
  // Settings IS the right destination for a permission, so the button stays.
  expect(screen.getByText(strings.permissions.openSettings)).toBeTruthy();
});

test('a permission never asked for is treated like a declined one', async () => {
  await bootToHome();
  await radioSays(TransportUnavailableReason.PERMISSION_NOT_REQUESTED, { wifiOn: false });
  expect(screen.getByText(strings.status.bluetoothDenied)).toBeTruthy();
  expect(screen.queryByText(strings.status.bluetoothOff)).toBeNull();
});

test('hardware with no radio is told the truth, with NO dead Settings button', async () => {
  await bootToHome();
  await radioSays(TransportUnavailableReason.UNSUPPORTED_HARDWARE, { wifiOn: false });
  expect(screen.getByText(strings.status.bluetoothUnsupported)).toBeTruthy();
  expect(screen.queryByText(strings.status.bluetoothOff)).toBeNull();
  // Settings cannot add a radio. This is the dead button, and it must be gone.
  expect(screen.queryByText(strings.permissions.openSettings)).toBeNull();
});

test('an OS too old to do BLE is also not offered Settings', async () => {
  await bootToHome();
  await radioSays(TransportUnavailableReason.UNSUPPORTED_OS_VERSION, { wifiOn: false });
  expect(screen.getByText(strings.status.bluetoothUnsupported)).toBeTruthy();
  expect(screen.queryByText(strings.permissions.openSettings)).toBeNull();
});

test('with Wi-Fi working, the banner says what still works rather than what does not', async () => {
  await bootToHome();
  await radioSays(TransportUnavailableReason.RADIO_OFF, { wifiOn: true });
  expect(screen.getByText(strings.status.bluetoothOffWifiWorks)).toBeTruthy();
  expect(screen.getByText(strings.status.bluetoothOffWifiWorksDetail)).toBeTruthy();
});

test('a declined permission with Wi-Fi up still leads with what works', async () => {
  await bootToHome();
  await radioSays(TransportUnavailableReason.PERMISSION_DENIED, { wifiOn: true });
  expect(screen.getByText(strings.status.bluetoothDenied)).toBeTruthy();
  expect(screen.getByText(strings.status.bluetoothDeniedWifiWorksDetail)).toBeTruthy();
});

test('no radio at all, with Wi-Fi up, never offers the dead button either', async () => {
  await bootToHome();
  await radioSays(TransportUnavailableReason.UNSUPPORTED_HARDWARE, { wifiOn: true });
  expect(screen.getByText(strings.status.bluetoothUnsupported)).toBeTruthy();
  expect(screen.queryByText(strings.permissions.openSettings)).toBeNull();
});

/**
 * The regression that started this: `publishRadioState` put `availability.reason`
 * - an identifier like "unsupportedHardware" - into the slot the interface
 * shows to a person, while the other emit site used the human sentence. Nothing
 * caught it because both are strings.
 */
test('the reason identifier is never shown to the user as the detail line', async () => {
  await bootToHome();
  for (const reason of Object.values(TransportUnavailableReason)) {
    await radioSays(reason, { wifiOn: false });
    expect(screen.queryByText(reason)).toBeNull();
  }
});
