/**
 * The app mounts, and a first run gets all the way to the home screen.
 *
 * This suite exists because of two real defects. The first was a blank white
 * screen: a missing Babel plugin made every screen module throw at import time,
 * and nothing in a thousand passing logic tests noticed, because none of them
 * imported a screen. The second was a crash on first launch from a column type
 * the database driver returned in a shape the repositories did not expect. Both
 * are import-time or first-render failures, and both are exactly what mounting
 * the real tree catches.
 *
 * The radios are mocked - see jest.setup.js - and deliberately mocked as
 * *unavailable*, which is the harder case. An app that only reaches its home
 * screen when the hardware answers is not an offline-first app.
 *
 * Two notes on the library. `render` is asynchronous in React Native Testing
 * Library 14, so every call is awaited; and the interface is queried the way a
 * person meets it - by visible text and by accessibility label - so a passing
 * test means the screen is actually usable, not merely constructed.
 */
import React from 'react';
import { act, render, screen, userEvent, waitFor } from '@testing-library/react-native';
import { brand, strings } from '@airlink/config';
import App from '../App';
import { AppPhase, useAppStore } from '../src/state/index.js';

/** Let the client's asynchronous load settle, whatever it decides. */
async function settle(): Promise<void> {
  await waitFor(() => {
    expect(useAppStore.getState().phase).not.toBe(AppPhase.LOADING);
  });
  await act(async () => undefined);
}

// Storage is remembered between renders inside a file - a keychain that forgets
// is not a keychain - so it is cleared explicitly, or the second test in this
// file would find the identity the first one wrote and never see a first run.
beforeEach(() => {
  globalThis.__airlinkSqliteTest?.clear();
  globalThis.__airlinkKeychainTest?.clear();
});

afterEach(() => {
  useAppStore.getState().reset();
});

test('mounts, and leaves the loading state without a server to wait for', async () => {
  await render(<App />);
  await settle();
  expect(useAppStore.getState().phase).not.toBe(AppPhase.FAILED);
});

test('a first run with no identity starts at onboarding', async () => {
  await render(<App />);
  await settle();

  expect(useAppStore.getState().phase).toBe(AppPhase.ONBOARDING);
  // The wordmark is what is drawn; the sentence is what a screen reader says.
  expect(screen.getByText(brand.wordmark)).toBeTruthy();
  expect(screen.getByLabelText(strings.onboarding.welcomeTitle)).toBeTruthy();
  expect(screen.getByText(strings.onboarding.getStarted)).toBeTruthy();
});

test('the first screen never calls being offline an error', async () => {
  await render(<App />);
  await settle();

  // The premise of the product: no signal is the normal state. None of the
  // vocabulary of failure belongs on the way in - and the radios are mocked
  // unavailable here, so this is the exact case that would tempt it.
  for (const forbidden of [/error/i, /no internet/i, /failed/i, /unavailable/i, /offline/i]) {
    expect(screen.queryByText(forbidden)).toBeNull();
  }
});

test('a name and a colour is the whole of onboarding, and it ends on the home screen', async () => {
  const user = userEvent.setup();
  await render(<App />);
  await settle();

  await user.press(screen.getByText(strings.onboarding.getStarted));
  await user.type(screen.getByLabelText(strings.onboarding.namePlaceholder), 'Ada');
  await user.press(screen.getByText(strings.onboarding.nameContinue));

  // The avatar step. "Auto" is a real choice, not a way of skipping one, so
  // taking it has to reach the end of onboarding like any other.
  expect(screen.getByText(strings.onboarding.avatarTitle)).toBeTruthy();
  await user.press(screen.getByLabelText(strings.onboarding.avatarAutomatic));
  await user.press(screen.getByText(strings.onboarding.nameContinue));

  // The permissions step asks the system for radios that this environment does
  // not have. Not getting them must still land the user on the home screen:
  // there is nothing to log in to, so there is nothing to be blocked by.
  await user.press(screen.getByText(strings.permissions.allow));

  // Onboarding gives the radios a settling window before it decides, so this
  // waits longer than the library's one-second default. It is not a guess: the
  // screen's own budget is 1.5s plus however long `start()` takes.
  await waitFor(() => expect(useAppStore.getState().phase).toBe(AppPhase.READY), { timeout: 8000 });
  await act(async () => undefined);

  const profile = useAppStore.getState().profile;
  expect(profile?.displayName).toBe('Ada');
  // Null means "derive my colour from my peer id", which is what Auto chose.
  expect(profile?.avatarColor).toBeNull();
}, 30000);
