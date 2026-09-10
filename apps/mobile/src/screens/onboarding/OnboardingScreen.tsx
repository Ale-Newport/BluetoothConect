import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { strings } from '@airlink/config';
import { Button, Gap, Row, Screen, haptic, useTheme } from '../../ui/index.js';
import { useClient } from '../../client/ClientProvider.js';
import { AppPhase, useAppStore } from '../../state/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { onboardingCopy } from './copy.js';
import { isUsableName, normaliseName } from './name.js';
import { ProgressBar } from './ProgressBar.js';
import { WelcomeStep } from './WelcomeStep.js';
import { NameStep } from './NameStep.js';
import { AvatarStep } from './AvatarStep.js';
import { PermissionsStep, type OnboardingTrouble } from './PermissionsStep.js';

/**
 * First run.
 *
 * Four steps in a pager: who we are, who you are, what you look like, and the
 * two permissions that make any of it work. It is short on purpose - the app
 * only earns its explanation once two phones are in the same room.
 *
 * The one structural decision worth knowing about: a step is only *rendered*
 * once it is reachable, which is what stops a swipe from skipping past a
 * required answer. There is no gesture interception and no disabled-scroll
 * state, because a page that does not exist cannot be scrolled to.
 */

const Step = {
  WELCOME: 0,
  NAME: 1,
  AVATAR: 2,
  PERMISSIONS: 3,
} as const;
type Step = (typeof Step)[keyof typeof Step];

const STEP_COUNT = 4;

/**
 * Bringing the radios up must not be able to hang the first run. If the native
 * side has not answered by now something is wrong with it, and the user is
 * better served by a plain sentence and a button than by a spinner.
 */
const START_TIMEOUT_MS = 15_000;

/**
 * How long to let the radios report in before opening Home.
 *
 * `start()` resolves as soon as the stack is up, but on iOS the Bluetooth
 * prompt is answered afterwards and availability arrives as an event. Waiting a
 * beat means Home usually opens already knowing the answer; if it does not, the
 * banner there is driven by the same live store and corrects itself.
 */
const RADIO_SETTLE_MS = 1_500;
const RADIO_POLL_MS = 120;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Nothing may spin forever: a promise that never settles still has to end. */
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function waitForRadios(ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (useAppStore.getState().radios.bluetoothOn) return true;
    if (Date.now() >= deadline) return false;
    await delay(RADIO_POLL_MS);
  }
}

type Props = NativeStackScreenProps<RootStackParams, 'Onboarding'>;

export function OnboardingScreen({ navigation }: Props): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const client = useClient();

  const pager = useRef<ScrollView>(null);
  const mounted = useRef(true);
  // A retry must not mint a second identity: `createProfile` writes a keypair
  // and a row, and doing it twice would orphan the first one.
  const profileCreated = useRef(false);

  const [step, setStep] = useState<Step>(Step.WELCOME);
  const [rawName, setRawName] = useState('');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<OnboardingTrouble | null>(null);

  const name = normaliseName(rawName);
  const nameReady = isUsableName(rawName);

  // Everything past the name is reachable only once there is a name, and the
  // current page always stays reachable so clearing the field cannot yank the
  // ground out from under someone standing on it.
  const unlocked = Math.max(nameReady ? Step.PERMISSIONS : Step.NAME, step);

  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useEffect(() => {
    pager.current?.scrollTo({ x: step * width, animated: true });
    if (step !== Step.NAME) Keyboard.dismiss();
  }, [step, width]);

  const goTo = useCallback((next: Step) => {
    setStep(next);
  }, []);

  const onSettled = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      if (width <= 0) return;
      const page = Math.round(e.nativeEvent.contentOffset.x / width);
      const clamped = Math.min(Math.max(page, Step.WELCOME), unlocked) as Step;
      setStep((current) => (current === clamped ? current : clamped));
    },
    [width, unlocked],
  );

  /** Hand over to the app: profile in the store, phase ready, Home on screen. */
  const enter = useCallback(
    (radiosUp: boolean) => {
      const store = useAppStore.getState();
      // Home reads these to decide whether to show its calm banner. Both are
      // live, so a permission granted a moment later clears it on its own.
      store.setRadios({
        permissionsGranted: radiosUp,
        detail: radiosUp ? null : strings.permissions.deniedBody,
      });
      store.setProfile(client.profile);
      store.setPhase(AppPhase.READY);
      // Reset rather than navigate: there is no going back to a first run.
      navigation.reset({ index: 0, routes: [{ name: 'Tabs' }] });
    },
    [client, navigation],
  );

  const finish = useCallback(async () => {
    if (busy) return;
    if (!nameReady) {
      goTo(Step.NAME);
      return;
    }

    setBusy(true);
    setTrouble(null);

    if (!profileCreated.current) {
      try {
        await client.createProfile(name, emoji);
        profileCreated.current = true;
      } catch {
        // The identity lives in the keychain; if that write fails there is
        // nothing to advertise, so this is the one step that must succeed.
        if (!mounted.current) return;
        setBusy(false);
        setTrouble('profile');
        return;
      }
    }

    try {
      // This is the call that raises the operating system's prompts.
      await withDeadline(client.start(), START_TIMEOUT_MS);
    } catch {
      if (!mounted.current) return;
      setBusy(false);
      setTrouble('radios');
      return;
    }

    const radiosUp = await waitForRadios(RADIO_SETTLE_MS);
    if (!mounted.current) return;
    setBusy(false);
    haptic('success');
    enter(radiosUp);
  }, [busy, nameReady, name, emoji, client, enter, goTo]);

  const continueAnyway = useCallback(() => {
    // Declining a permission is not a reason to be held on this screen. The
    // profile already exists, so Home is perfectly usable; it just says what
    // will not work yet, and offers Settings.
    enter(useAppStore.getState().radios.bluetoothOn);
  }, [enter]);

  const footer = ((): React.JSX.Element => {
    switch (step) {
      case Step.WELCOME:
        return (
          <Button title={strings.onboarding.getStarted} onPress={() => goTo(Step.NAME)} />
        );

      case Step.NAME:
        return (
          <Button
            title={strings.onboarding.nameContinue}
            onPress={() => goTo(Step.AVATAR)}
            disabled={!nameReady}
            disabledReason={onboardingCopy.nameRequired}
          />
        );

      case Step.AVATAR:
        return (
          <Row gap="sm">
            <Button
              title={strings.onboarding.skip}
              variant="ghost"
              onPress={() => {
                setEmoji(null);
                goTo(Step.PERMISSIONS);
              }}
              style={{ flex: 1 }}
            />
            <Button
              title={strings.onboarding.nameContinue}
              onPress={() => goTo(Step.PERMISSIONS)}
              style={{ flex: 2 }}
            />
          </Row>
        );

      case Step.PERMISSIONS:
      default:
        return (
          <>
            <Button
              title={trouble ? strings.common.retry : strings.permissions.allow}
              onPress={() => void finish()}
              loading={busy}
              disabled={!nameReady}
              disabledReason={onboardingCopy.nameRequired}
            />
            {trouble === 'radios' ? (
              <>
                <Gap size="sm" />
                <Button
                  title={onboardingCopy.continueAnyway}
                  variant="ghost"
                  onPress={continueAnyway}
                />
              </>
            ) : null}
          </>
        );
    }
  })();

  return (
    <Screen padded={false}>
      <View style={{ paddingTop: insets.top + theme.spacing.md, paddingHorizontal: theme.spacing.lg }}>
        <ProgressBar step={step} total={STEP_COUNT} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          ref={pager}
          horizontal
          pagingEnabled
          bounces={false}
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onMomentumScrollEnd={onSettled}
          style={{ flex: 1 }}
        >
          <WelcomeStep width={width} />
          {unlocked >= Step.NAME ? (
            <NameStep
              width={width}
              active={step === Step.NAME}
              value={rawName}
              onChange={setRawName}
              onSubmit={() => {
                if (nameReady) goTo(Step.AVATAR);
              }}
            />
          ) : null}
          {unlocked >= Step.AVATAR ? (
            <AvatarStep width={width} name={name} emoji={emoji} onSelect={setEmoji} />
          ) : null}
          {unlocked >= Step.PERMISSIONS ? (
            <PermissionsStep width={width} trouble={trouble} />
          ) : null}
        </ScrollView>

        <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md }}>
          {footer}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
