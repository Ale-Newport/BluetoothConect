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
  type ScrollViewInstance,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { strings } from '@airlink/config';
import { Button, Gap, Label, Row, Screen, haptic, useTheme } from '../../ui/index.js';
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

  // `ScrollView` is a function component under the New Architecture, so the ref
  // holds the host instance rather than the component itself.
  const pager = useRef<ScrollViewInstance>(null);
  const mounted = useRef(true);
  // A retry must not mint a second identity: `createProfile` writes a keypair
  // and a row, and doing it twice would orphan the first one.
  const profileCreated = useRef(false);
  /**
   * The `start()` already in flight, if any.
   *
   * A deadline abandons a promise; it cannot cancel the work behind it. The
   * native stack is still coming up when `withDeadline` gives up, and
   * `AirLinkClient.start()` only guards against re-entry once it has *finished*
   * - so calling it again from Retry would raise a second transport host and
   * leave the first one advertising on a timer nothing holds a handle to.
   * Retry therefore waits on the attempt already running; only a real failure
   * clears the slot so the next press is a genuine second try.
   */
  const startAttempt = useRef<Promise<void> | null>(null);

  const [step, setStep] = useState<Step>(Step.WELCOME);
  const [rawName, setRawName] = useState('');
  const [color, setColor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [trouble, setTrouble] = useState<OnboardingTrouble | null>(null);
  /**
   * The peer id, resolved before it is needed rather than when it is written.
   *
   * The automatic avatar colour is derived from the peer id, so the avatar step
   * cannot honestly preview it without one. Null until the keystore answers,
   * which the avatar step handles by falling back to the name - a colour that
   * may change once, rather than a spinner on a decorative screen.
   */
  const [peerId, setPeerId] = useState<string | null>(null);

  const name = normaliseName(rawName);
  const nameReady = isUsableName(rawName);

  // Everything past the name is reachable only once there is a name, and the
  // current page always stays reachable so clearing the field cannot yank the
  // ground out from under someone standing on it.
  const unlocked = Math.max(nameReady ? Step.PERMISSIONS : Step.NAME, step);

  // Set on the way in as well as cleared on the way out: an effect that only
  // ever writes `false` is permanently false after the first mount/unmount/
  // remount cycle, and every `if (!mounted.current) return` below would then
  // swallow the completion and strand the user on this screen.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Runs once, on the way in, and deliberately not gated on a step: the keys
  // exist long before the avatar step is reached, and a failure here is not
  // something to interrupt a first run for - `createProfile` creates the
  // identity itself if this never lands.
  useEffect(() => {
    let live = true;
    client
      .ensureIdentityPeerId()
      .then((id) => {
        if (live) setPeerId(id);
      })
      .catch(() => {
        // Left null. The avatar step seeds from the name instead.
      });
    return () => {
      live = false;
    };
  }, [client]);

  const scrollToStep = useCallback(
    (target: Step) => {
      pager.current?.scrollTo({ x: target * width, animated: true });
    },
    [width],
  );

  useEffect(() => {
    scrollToStep(step);
    if (step !== Step.NAME) Keyboard.dismiss();
  }, [step, scrollToStep]);

  /**
   * Advancing a step can also *create* the page we are scrolling to, and a
   * native scroll view clamps to the content width it currently knows about.
   * Re-issuing the scroll once the content has actually grown is what stops the
   * pager from silently staying on the page it was already showing.
   */
  const onContentResized = useCallback(
    (contentWidth: number) => {
      if (width > 0 && contentWidth >= (step + 1) * width) scrollToStep(step);
    },
    [step, width, scrollToStep],
  );

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
      // Only a *positive* answer is written back. Nothing downstream ever
      // clears `permissionsGranted`, so recording a refusal we have not
      // actually seen - an iOS prompt can still be on screen when this runs -
      // would be a lie that sticks. What Home shows is driven by `bluetoothOn`,
      // which the transport keeps live: it puts up a calm banner with Open
      // Settings while Bluetooth is off, and takes it down by itself the moment
      // the user says yes.
      if (radiosUp) store.setRadios({ permissionsGranted: true, detail: null });
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
        await client.createProfile(name, color);
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
      if (!startAttempt.current) {
        startAttempt.current = client.start().catch((error: unknown) => {
          // A failure is retryable, so the slot is released. A timeout is not a
          // failure and deliberately leaves it held.
          startAttempt.current = null;
          throw error instanceof Error ? error : new Error(String(error));
        });
      }
      await withDeadline(startAttempt.current, START_TIMEOUT_MS);
    } catch {
      if (!mounted.current) return;
      setBusy(false);
      setTrouble('radios');
      return;
    }

    const radiosUp = await waitForRadios(RADIO_SETTLE_MS);
    if (!mounted.current) return;
    setBusy(false);
    // A success tap is a claim that everything worked. If the radios have not
    // reported in, the honest gesture is the quieter one.
    haptic(radiosUp ? 'success' : 'impactLight');
    enter(radiosUp);
  }, [busy, nameReady, name, color, client, enter, goTo]);

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
        // Someone can reach this step and then swipe back and empty the field.
        // Both buttons would lead somewhere they cannot act, so both say so
        // rather than looking live.
        return (
          <>
            <Row gap="sm">
              <Button
                title={strings.onboarding.skip}
                variant="ghost"
                onPress={() => {
                  setColor(null);
                  goTo(Step.PERMISSIONS);
                }}
                disabled={!nameReady}
                style={{ flex: 1 }}
              />
              <Button
                title={strings.onboarding.nameContinue}
                onPress={() => goTo(Step.PERMISSIONS)}
                disabled={!nameReady}
                style={{ flex: 2 }}
              />
            </Row>
            {nameReady ? null : (
              <>
                <Gap size="xs" />
                <Label variant="footnote" tone="tertiary" align="center">
                  {onboardingCopy.nameRequired}
                </Label>
              </>
            )}
          </>
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
          // Locked while the identity is being written and the radios brought
          // up. The name and the avatar have already been handed to
          // `createProfile` by then, so a field edited mid-flight would be
          // silently discarded - a control that looks live but is not. The lock
          // is bounded by the deadline above and the button spins throughout.
          scrollEnabled={!busy}
          bounces={false}
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onMomentumScrollEnd={onSettled}
          onContentSizeChange={onContentResized}
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
            <AvatarStep width={width} name={name} peerId={peerId} color={color} onSelect={setColor} />
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
