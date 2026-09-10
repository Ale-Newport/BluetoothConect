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
 * The distinction the copy keeps is the one that matters: a code that is stale,
 * unreadable or simply not ours is a mishap, and a code whose signature does not
 * verify is not - the second is the only one that says "do not add this device".
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

type OutcomeKind = 'added' | 'known' | 'rejected';

interface Outcome {
  readonly kind: OutcomeKind;
  readonly title: string;
  readonly body: string;
  /** Set when the scan ended with a friend we can now show a safety number for. */
  readonly peerId: string | null;
}

/** One honest sentence per way a code can fail. */
function describeRejection(reason: PairingCodeRejection): { title: string; body: string } {
  switch (reason) {
    case PairingCodeRejection.NOT_AN_AIRLINK_CODE:
    case PairingCodeRejection.TOO_LONG:
      return { title: local.scan.rejectNotAirlink, body: local.scan.rejectNotAirlinkBody };
    case PairingCodeRejection.MALFORMED:
      return { title: local.scan.rejectUnreadable, body: local.scan.rejectUnreadableBody };
    case PairingCodeRejection.UNSUPPORTED_VERSION:
      return { title: local.scan.rejectNewer, body: local.scan.rejectNewerBody };
    case PairingCodeRejection.EXPIRED:
      return { title: local.scan.rejectExpired, body: local.scan.rejectExpiredBody };
    case PairingCodeRejection.ISSUED_IN_THE_FUTURE:
      return { title: local.scan.rejectClock, body: local.scan.rejectClockBody };
    case PairingCodeRejection.BAD_SIGNATURE:
    case PairingCodeRejection.IDENTITY_MISMATCH:
      // Both mean the code did not prove it belongs to the key it carries. That
      // is the one failure worth being blunt about.
      return { title: local.scan.rejectForged, body: local.scan.rejectForgedBody };
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
          return { kind: 'rejected', title: local.scan.blockedTitle, body: local.scan.blockedBody, peerId: null };
        }
        return { kind: 'rejected', title: local.scan.saveFailed, body: local.scan.saveFailedBody, peerId: null };
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
        const { title, body } = describeRejection(parsed.reason);
        haptic('warning');
        setOutcome({ kind: 'rejected', title, body, peerId: null });
        return;
      }

      let next: Outcome;
      try {
        next = admit(parsed.code);
      } catch {
        // A write that fails leaves the table as it was. Say so rather than
        // implying a friendship that does not exist.
        next = { kind: 'rejected', title: local.scan.saveFailed, body: local.scan.saveFailedBody, peerId: null };
      }
      haptic(next.kind === 'added' ? 'success' : next.kind === 'known' ? 'selection' : 'warning');
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
      <Screen scroll>
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
 * A rejection is the only place this folder shows the danger colour, and it
 * shows it because it is the one thing here a person should act on.
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

  return (
    <Card>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <StatusDot tone={outcome.kind === 'rejected' ? 'warning' : 'connected'} size={10} />
        <Label variant="headline" tone={outcome.kind === 'rejected' ? 'danger' : 'primary'} style={{ flex: 1 }}>
          {outcome.title}
        </Label>
      </View>
      <Gap size="xs" />
      <Label variant="subheadline" tone="secondary">
        {outcome.body}
      </Label>

      <Gap size="lg" />
      {outcome.kind === 'rejected' ? (
        <>
          <Button title={local.scan.scanAgain} onPress={onScanAgain} />
          <Gap size="sm" />
          <Button title={strings.common.close} variant="ghost" onPress={onDone} />
        </>
      ) : (
        <>
          <Button title={strings.common.done} onPress={onDone} />
          <Gap size="sm" />
          <Button
            title={local.scan.viewFriend}
            variant="secondary"
            disabled={outcome.peerId === null}
            disabledReason={outcome.peerId === null ? local.scan.itsYouBody : undefined}
            onPress={() => {
              const peerId = outcome.peerId;
              if (peerId === null) return;
              navigation.replace('Security', { peerId });
            }}
          />
          <Gap size="sm" />
          <Button title={local.scan.scanAgain} variant="ghost" onPress={onScanAgain} />
        </>
      )}
    </Card>
  );
}
