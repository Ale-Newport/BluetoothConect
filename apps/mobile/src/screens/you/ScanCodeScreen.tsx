import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking, View } from 'react-native';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useCameraDevice, useCameraPermission } from 'react-native-vision-camera';
import {
  PairingCodeRejection,
  PairingMethod,
  recordScannedFriend,
  tryParsePairingCode,
  type PairingCode,
} from '@airlink/core';
import { strings } from '@airlink/config';
import {
  Button,
  Card,
  EmptyState,
  Gap,
  Label,
  Screen,
  StatusDot,
  haptic,
  useTheme,
} from '../../ui/index.js';
import { useClient } from '../../client/ClientProvider.js';
import { selectProfile, useAppStore } from '../../state/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { local } from './localStrings.js';
import { SCANNING_IS_SUPPORTED, ScannerCamera } from './ScannerCamera.js';

/**
 * Scan a friend.
 *
 * The camera reads a QR, the strict parser in `@airlink/core` decides whether it
 * is genuine, and only then does a friend row get written. Nothing here is
 * lenient: every way a code can fail has its own honest sentence, and there is
 * no path through this screen that ends in silence.
 *
 * The distinction it keeps - in the copy AND in the colour - is the one that
 * matters: a code that is stale, unreadable or simply not ours is a mishap, and
 * a code whose signature does not verify is not. The second is the only one that
 * says "do not add this device", and the only one drawn in the danger colour.
 *
 * PLATFORM LIMIT, stated here because it changes what this screen can offer.
 * Reading a code needs a decoder, and the only one in this app is Vision
 * Camera's own object output, which is implemented on iOS alone - see the note
 * in `ScannerCamera` and `docs/adr-001-qr-scanning.md`. So where scanning does
 * not exist this screen does not pretend: it says so and offers the two routes
 * that genuinely work, which are just as secure. A viewfinder that could never
 * fire would be worse than an honest sentence.
 */

/**
 * How long to wait for a camera device before saying there isn't one.
 *
 * `useCameraDevice` returns undefined while the native device list is still
 * loading, which is indistinguishable from a device with no camera. Rather than
 * spin forever we give it a fair window and then say so plainly.
 */
const DEVICE_TIMEOUT_MS = 4000;

/**
 * How a scan ended, and how loudly to say so.
 *
 * The split between `mishap` and `unsafe` is the whole point of this type. An
 * expired code, a boarding pass, a code from a newer build, a clock an hour out,
 * a device the user themselves blocked: none of those is a security event, and
 * painting them the danger colour teaches people to ignore the danger colour.
 * `unsafe` is reserved for the one case that earns it - a code whose signature
 * did not verify - so that when the screen does go red it means something.
 */
type OutcomeKind = 'added' | 'known' | 'mishap' | 'unsafe';

interface Outcome {
  readonly kind: OutcomeKind;
  readonly title: string;
  readonly body: string;
  /** Set when the scan ended with a friend we can now show a safety number for. */
  readonly peerId: string | null;
}

/** One honest sentence per way a code can fail, and its weight. */
function describeRejection(reason: PairingCodeRejection): {
  kind: 'mishap' | 'unsafe';
  title: string;
  body: string;
} {
  switch (reason) {
    case PairingCodeRejection.NOT_AN_AIRLINK_CODE:
    case PairingCodeRejection.TOO_LONG:
      return { kind: 'mishap', title: local.scan.rejectNotAirlink, body: local.scan.rejectNotAirlinkBody };
    case PairingCodeRejection.MALFORMED:
      return { kind: 'mishap', title: local.scan.rejectUnreadable, body: local.scan.rejectUnreadableBody };
    case PairingCodeRejection.UNSUPPORTED_VERSION:
      return { kind: 'mishap', title: local.scan.rejectNewer, body: local.scan.rejectNewerBody };
    case PairingCodeRejection.EXPIRED:
      return { kind: 'mishap', title: local.scan.rejectExpired, body: local.scan.rejectExpiredBody };
    case PairingCodeRejection.ISSUED_IN_THE_FUTURE:
      return { kind: 'mishap', title: local.scan.rejectClock, body: local.scan.rejectClockBody };
    case PairingCodeRejection.BAD_SIGNATURE:
    case PairingCodeRejection.IDENTITY_MISMATCH:
      // Both mean the code did not prove it belongs to the key it carries. That
      // is the one failure worth being blunt about, and the only one this
      // screen shows in the danger colour.
      return { kind: 'unsafe', title: local.scan.rejectForged, body: local.scan.rejectForgedBody };
  }
}

/** The haptic that matches the weight of the news. */
function hapticFor(kind: OutcomeKind): 'success' | 'selection' | 'impactLight' | 'warning' {
  switch (kind) {
    case 'added':
      return 'success';
    case 'known':
      return 'selection';
    case 'mishap':
      // A nudge, not a buzz: the user has to point the camera again, which is
      // not the same as being warned.
      return 'impactLight';
    case 'unsafe':
      return 'warning';
  }
}

export function ScanCodeScreen(): React.JSX.Element {
  const theme = useTheme();
  const client = useClient();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const screenFocused = useIsFocused();
  const profile = useAppStore(selectProfile);

  const { hasPermission, canRequestPermission, requestPermission } = useCameraPermission();
  const device = useCameraDevice('back');

  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [cameraFailed, setCameraFailed] = useState(false);
  const [deviceTimedOut, setDeviceTimedOut] = useState(false);
  const [appActive, setAppActive] = useState(() => AppState.currentState === 'active');

  // The scanner fires many times a second. Once a code has been dealt with, the
  // rest of that burst must not queue up behind a result the user is reading.
  const busy = useRef(false);

  const myPeerId = profile?.peerId ?? client.profile?.peerId ?? null;

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setAppActive(state === 'active'));
    return () => subscription.remove();
  }, []);

  // Bound the "looking for a camera" state so it always resolves into either a
  // viewfinder or an explanation.
  useEffect(() => {
    if (device) {
      setDeviceTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setDeviceTimedOut(true), DEVICE_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [device]);

  const resume = useCallback(() => {
    busy.current = false;
    setOutcome(null);
  }, []);

  /** Turn a validated code into a friend row, and say exactly what happened. */
  const admit = useCallback(
    (code: PairingCode): Outcome => {
      if (myPeerId !== null && code.peerId === myPeerId) {
        return { kind: 'known', title: local.scan.itsYou, body: local.scan.itsYouBody, peerId: null };
      }

      // Read the existing row BEFORE writing, so we can tell "already a friend"
      // from "new friend" and can notice a genuine upgrade to QR strength.
      const before = client.trustStore.record(code.peerId);

      const result = recordScannedFriend(client.trustStore, code, Date.now());
      if (!result.ok) {
        // Today the only refusal is a blocked peer - a decision the user made
        // and can undo - but the reason is checked rather than assumed, so a new
        // refusal added upstream cannot quietly show the wrong sentence.
        if (client.trustStore.isBlocked(code.peerId) || before?.blocked === true) {
          // The user's own earlier decision, working exactly as they asked.
          // Nothing here is a failure, so nothing here is red.
          return { kind: 'mishap', title: local.scan.blockedTitle, body: local.scan.blockedBody, peerId: null };
        }
        return { kind: 'mishap', title: local.scan.saveFailed, body: local.scan.saveFailedBody, peerId: null };
      }

      if (before && !before.blocked) {
        const upgraded = before.method !== PairingMethod.QR;
        return {
          kind: 'known',
          title: local.scan.alreadyFriends(result.peer.displayName),
          body: upgraded ? local.scan.upgraded : local.scan.addedBody,
          peerId: result.peer.peerId,
        };
      }

      return {
        kind: 'added',
        title: local.scan.addedTitle(result.peer.displayName),
        body: local.scan.addedBody,
        peerId: result.peer.peerId,
      };
    },
    [client, myPeerId],
  );

  const onCode = useCallback(
    (value: string) => {
      if (busy.current) return;
      busy.current = true;

      const parsed = tryParsePairingCode(value, Date.now());
      if (!parsed.ok) {
        const { kind, title, body } = describeRejection(parsed.reason);
        haptic(hapticFor(kind));
        setOutcome({ kind, title, body, peerId: null });
        return;
      }

      let next: Outcome;
      try {
        next = admit(parsed.code);
      } catch {
        // A write that fails leaves the table as it was. Say so rather than
        // implying a friendship that does not exist.
        next = { kind: 'mishap', title: local.scan.saveFailed, body: local.scan.saveFailedBody, peerId: null };
      }
      haptic(hapticFor(next.kind));
      setOutcome(next);
    },
    [admit],
  );

  const onCameraError = useCallback(() => {
    // The camera is the only way through this screen, so a failure here is a
    // real dead end and gets a real explanation rather than a toast.
    setCameraFailed(true);
  }, []);

  // --- everything that stops us reaching a viewfinder -----------------------

  // Checked before the permission prompt, and before `ScannerCamera` is allowed
  // anywhere near the tree: its `useObjectOutput` throws on a platform with no
  // implementation, and a hook cannot be called conditionally.
  if (!SCANNING_IS_SUPPORTED) {
    return (
      <Screen safeTop={false} scroll>
        <Gap size="xl" />
        <Label variant="title2">{local.scan.noScannerHereTitle}</Label>
        <Gap size="sm" />
        <Label variant="body" tone="secondary">
          {local.scan.noScannerHereBody}
        </Label>
        <Gap size="xl" />
        <Button title={strings.profile.showQr} onPress={() => navigation.replace('MyCode')} />
        <Gap size="sm" />
        <Button title={strings.common.close} variant="ghost" onPress={() => navigation.goBack()} />
      </Screen>
    );
  }

  if (!hasPermission) {
    if (canRequestPermission) {
      return (
        <Screen scroll>
          <Gap size="xxl" />
          <Label variant="title2">{local.scan.cameraTitle}</Label>
          <Gap size="sm" />
          <Label variant="body" tone="secondary">
            {local.scan.cameraBody}
          </Label>
          <Gap size="xl" />
          <Button title={strings.permissions.allow} onPress={() => void requestPermission()} />
          <Gap size="sm" />
          <Button title={strings.permissions.notNow} variant="ghost" onPress={() => navigation.goBack()} />
        </Screen>
      );
    }
    return (
      <Screen>
        <EmptyState
          icon="🎥"
          title={strings.permissions.deniedTitle}
          body={`${local.scan.cameraBody} ${strings.permissions.deniedBody}`}
          action={
            <Button title={strings.permissions.openSettings} onPress={() => void Linking.openSettings()} />
          }
        />
      </Screen>
    );
  }

  if (cameraFailed) {
    return (
      <Screen>
        <EmptyState
          icon="🎥"
          title={local.scan.cameraFailedTitle}
          body={local.scan.cameraFailedBody}
          action={<Button title={strings.common.close} onPress={() => navigation.goBack()} />}
        />
      </Screen>
    );
  }

  if (!device) {
    if (!deviceTimedOut) {
      return (
        <Screen>
          <EmptyState icon="🎥" title={local.scan.starting} />
        </Screen>
      );
    }
    return (
      <Screen>
        <EmptyState
          icon="🎥"
          title={local.scan.noCameraTitle}
          body={local.scan.noCameraBody}
          action={<Button title={strings.common.close} onPress={() => navigation.goBack()} />}
        />
      </Screen>
    );
  }

  // --- the viewfinder -------------------------------------------------------

  // Paused while a result is on screen, while another screen is in front, and
  // while the app is in the background. A camera left running in a pocket is a
  // battery bill and a trust problem.
  const scanning = outcome === null && screenFocused && appActive;

  return (
    <Screen padded>
      <Gap size="md" />
      <Label variant="subheadline" tone="secondary" align="center">
        {local.scan.lead}
      </Label>
      <Gap size="md" />

      <View style={{ flex: 1 }}>
        <ScannerCamera device={device} isActive={scanning} onCode={onCode} onError={onCameraError} />
      </View>

      <Gap size="md" />

      {outcome === null ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: theme.spacing.sm,
            minHeight: 44,
          }}
        >
          <StatusDot tone="connecting" />
          <Label variant="footnote" tone="tertiary">
            {local.scan.scanning}
          </Label>
        </View>
      ) : (
        <ScanOutcome outcome={outcome} onScanAgain={resume} onDone={() => navigation.goBack()} />
      )}
    </Screen>
  );
}

/**
 * What happened, and what to do about it.
 *
 * The danger colour is spent on exactly one outcome - a code whose signature did
 * not verify - because that is the only one where the right answer is "stop".
 * Everything else that did not work (a stale code, a boarding pass, a device the
 * user blocked last week) is a mishap: it is stated plainly, in the same calm
 * grey as the rest of the app, with the camera one tap away. An app that shouts
 * at every hiccup has nothing left to say when it matters.
 */
function ScanOutcome({
  outcome,
  onScanAgain,
  onDone,
}: {
  outcome: Outcome;
  onScanAgain: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();

  const unsafe = outcome.kind === 'unsafe';
  const worked = outcome.kind === 'added' || outcome.kind === 'known';
  const peerId = outcome.peerId;

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <StatusDot tone={unsafe ? 'warning' : worked ? 'connected' : 'disconnected'} size={10} />
        <Label variant="headline" tone={unsafe ? 'danger' : 'primary'} style={{ flex: 1 }}>
          {outcome.title}
        </Label>
      </View>
      <Gap size="xs" />
      <Label variant="subheadline" tone="secondary">
        {outcome.body}
      </Label>

      <Gap size="lg" />
      {worked ? (
        <>
          <Button title={strings.common.done} onPress={onDone} />
          {/*
            Rendered only when there is a friendship to open. A disabled button
            whose only explanation repeats the sentence directly above it is
            furniture, not a control.
          */}
          {peerId === null ? null : (
            <>
              <Gap size="sm" />
              <Button
                title={local.scan.viewFriend}
                variant="secondary"
                onPress={() => navigation.replace('Security', { peerId })}
              />
            </>
          )}
          <Gap size="sm" />
          <Button title={local.scan.scanAgain} variant="ghost" onPress={onScanAgain} />
        </>
      ) : (
        <>
          <Button title={local.scan.scanAgain} onPress={onScanAgain} />
          <Gap size="sm" />
          <Button title={strings.common.close} variant="ghost" onPress={onDone} />
        </>
      )}
    </Card>
  );
}
