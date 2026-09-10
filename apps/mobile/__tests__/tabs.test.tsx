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
