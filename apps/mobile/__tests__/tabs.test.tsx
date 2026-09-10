/**
 * Every tab opens, and every tab is honest with nobody nearby.
 *
 * This is the broadest test in the app, and the cheapest insurance in it. The
 * five tabs pull in the whole screen layer - the game catalogue, the Skia
 * canvases, the share pickers, the developer screens - so a module that throws
 * at import time, a component that renders `undefined`, or a selector that
 * reads a field the store no longer has all surface here rather than on a
 * phone.
 *
 * Nobody is nearby, because that is the state a first user is actually in. Each
 * tab therefore has to say so in words, and none of them may say it in the
 * vocabulary of failure.
 */
import React from 'react';
import { act, render, screen, userEvent, waitFor } from '@testing-library/react-native';
import { strings } from '@airlink/config';
import App from '../App';
import { AirLinkClient } from '../src/client/AirLinkClient.js';
import { AppPhase, useAppStore } from '../src/state/index.js';

/** Everything the vocabulary of failure would look like on screen. */
const FAILURE_WORDS = [/\berror\b/i, /no internet/i, /\bfailed\b/i, /not available/i, /unavailable/i];

/**
 * Put a finished profile in place, so the app boots to the home screen.
 *
 * Written through a real `AirLinkClient` against the same in-memory database
 * the app will open, rather than by poking the store: that way the test starts
 * from a state the app could genuinely have been left in.
 */
async function seedProfile(): Promise<void> {
  const client = new AirLinkClient({ appVersion: '0.1.0', platform: 'ios', deviceModel: 'test' });
  await client.load();
  await client.createProfile('Ada', null);
}

async function bootToHome(): Promise<void> {
  await seedProfile();
  await render(<App />);
  await waitFor(() => expect(useAppStore.getState().phase).toBe(AppPhase.READY));
  await act(async () => undefined);
}

afterEach(() => {
  useAppStore.getState().reset();
  globalThis.__airlinkNativeTest?.clearCalls();
  globalThis.__airlinkSqliteTest?.clear();
  globalThis.__airlinkKeychainTest?.clear();
});

test('an existing profile boots straight to the home screen', async () => {
  await bootToHome();
  expect(screen.getByText('Home')).toBeTruthy();
  for (const word of FAILURE_WORDS) expect(screen.queryByText(word)).toBeNull();
});

test('each tab opens, and none of them treats an empty room as an error', async () => {
  const user = userEvent.setup();
  await bootToHome();

  // The assertion for each tab is a sentence that only that screen renders, so
  // pressing the tab and finding the tab's own label again cannot pass for
  // having opened it.
  const tabs = [
    [strings.home.chat, 'Connect to someone nearby and say hello.'],
    [strings.play.title, 'Connect to a friend on the Home tab and every game here lights up.'],
    [strings.share.title, 'Photos and files you send or receive appear here.'],
    [strings.profile.title, 'Friends who scan your code can find you again anywhere.'],
  ] as const;

  for (const [tab, evidence] of tabs) {
    await user.press(screen.getAllByText(tab)[0] as ReturnType<typeof screen.getByText>);
    await act(async () => undefined);
    expect(screen.getByText(evidence)).toBeTruthy();
    for (const word of FAILURE_WORDS) expect(screen.queryByText(word)).toBeNull();
  }
}, 30000);

test('a peer discovered by the radio reaches the home screen', async () => {
  await bootToHome();

  // Pushed in through the native module's own event, so the whole chain runs:
  // native event → transport → registry → client → store → screen.
  await act(async () => {
    globalThis.__airlinkNativeTest?.emit('onPeerDiscovered', {
      transport: 'ble',
      endpointId: 'endpoint-1',
      name: 'Grace',
      token: 'a1b2c3d4e5f6',
      rssi: -55,
    });
  });

  await waitFor(() => expect(useAppStore.getState().peers.length).toBe(1));
  await act(async () => undefined);
  expect(screen.getByText('Grace')).toBeTruthy();
});

test('starting the radios asks for the permissions they need', async () => {
  await bootToHome();

  // The Android prompt is the point. iOS raises its own sheets when the radios
  // are first touched, but Android raises nothing unless it is asked - and for
  // a while nothing asked, so a first run on Android reached a home screen
  // offering Settings for a permission the system had never mentioned.
  const request = globalThis.__airlinkNativeTest
    ?.calls()
    .find((call) => call.name === 'requestPermissions');
  expect(request).toBeDefined();
  expect(request?.transports).toContain('ble');
});

test('the radio state the app starts with reaches the interface', async () => {
  await bootToHome();

  // `availabilityChanged` fires on a change, so it never fires for the state a
  // transport is already in. Without an explicit publish, a phone whose
  // Bluetooth was on the whole time never contradicts the store's starting
  // assumption that it is off, and Home offers to open Settings for a working
  // radio. The double reports Bluetooth as available and never changes it,
  // which is exactly that case.
  await waitFor(() => expect(useAppStore.getState().radios.bluetoothOn).toBe(true));
  for (const word of FAILURE_WORDS) expect(screen.queryByText(word)).toBeNull();
  expect(screen.queryByText(/bluetooth is off/i)).toBeNull();
});

test('a Wi-Fi transport reaches the interface as well as Bluetooth', async () => {
  await bootToHome();

  // `wifiOn` stands for several transports, so it has to be an OR rather than
  // whichever one reported last - which is what it was, and both report at
  // startup, so the flag landed on whichever finished second.
  await waitFor(() => expect(useAppStore.getState().radios.wifiOn).toBe(true));
});

test('with Bluetooth off but Wi-Fi working, the banner does not claim nobody can be found', async () => {
  await bootToHome();
  await waitFor(() => expect(useAppStore.getState().radios.bluetoothOn).toBe(true));

  // Bluetooth switched off at the radio, exactly as the native layer reports it.
  await act(async () => {
    globalThis.__airlinkNativeTest?.emit('onAvailabilityChanged', {
      transport: 'ble',
      available: false,
      reason: 'poweredOff',
    });
  });
  await waitFor(() => expect(useAppStore.getState().radios.bluetoothOn).toBe(false));

  // Home deliberately waits before drawing any conclusion about the radios -
  // "not knowing yet" must not look like a problem - so this waits past that
  // window rather than asserting into it.
  await waitFor(() => expect(screen.getByText(strings.status.bluetoothOffWifiWorksDetail)).toBeTruthy(), {
    timeout: 6000,
  });

  // The blunt line would be a lie while the local network is still finding
  // people - and a friend would be sitting in the list right below it.
  expect(screen.queryByText(strings.status.bluetoothOffDetail)).toBeNull();
}, 30000);

test('a session accepted rather than dialled is still found by the peer it belongs to', async () => {
  // Covered directly against the client rather than through the screen: the
  // defect is that a handle created for an INBOUND link is keyed by a synthetic
  // id, so looking it up by the peer id the presence layer uses found nothing -
  // and Home offered "Connect" over an already-open session.
  const solo = new AirLinkClient({ appVersion: '0', platform: 'ios', deviceModel: 'test' });
  await solo.load();

  const peers = (solo as unknown as { peers: Map<string, unknown> }).peers;
  peers.set('inbound-abc123', { session: { peerId: 'PEERGRACE' } });

  expect(solo.peer('inbound-abc123')).toBeDefined();
  expect(solo.peer('PEERGRACE')).toBeDefined();
  expect(solo.peer('SOMEONE-ELSE')).toBeUndefined();
});
