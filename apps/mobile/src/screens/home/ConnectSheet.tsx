import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ConnectionState } from '@airlink/core';
import { strings } from '@airlink/config';
import {
  Avatar,
  Button,
  EmptyState,
  Gap,
  Label,
  Row,
  Screen,
  StatusDot,
  useTheme,
  type StatusTone,
} from '../../ui/index.js';
import { selectPeer, selectPendingPairings, useAppStore, type PeerView } from '../../state/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { PulsingDot } from './controls.js';
import { useOptionalClient } from './useOptionalClient.js';
import { isPairingAnswered } from './pairingRouting.js';
import { homeCopy, statusLine } from './peerPresentation.js';

/**
 * The connect sheet.
 *
 * One person, one decision, and then the honest truth about what is happening:
 * opening a link, then proving who is on the other end, then done. Each of those
 * is a real state of the session underneath rather than a progress animation on
 * a timer - which is why each one also has a deadline. A radio that goes quiet
 * must never leave this sheet spinning, so every state here ends in something
 * the user can tap.
 */

type Stage = 'idle' | 'connecting' | 'securing' | 'connected' | 'failed';

/**
 * How long each stage may take before we call it off.
 *
 * The transport gives itself 20s to open a link (`AirLinkClient.connect`), so
 * ours is deliberately longer: when the radio has its own answer we would rather
 * show that than pre-empt it with a generic timeout. Securing is a handshake
 * over an open link, so it is quick or it is broken.
 */
const CONNECTING_TIMEOUT_MS = 25_000;
const SECURING_TIMEOUT_MS = 20_000;

/** Long enough to read the word "Connected", short enough not to be a wait. */
const SUCCESS_DISMISS_MS = 1000;

/**
 * The portrait at the top of the sheet.
 *
 * A pixel size rather than a token because the design system has no scale for
 * component dimensions - `Avatar` takes a number - and this is the one place in
 * the app where a peer is the whole screen rather than a row in a list.
 */
const AVATAR_SIZE = 72;

export function ConnectSheet(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const { peerKey } = useRoute<RouteProp<RootStackParams, 'Connect'>>().params;
  const client = useOptionalClient();

  const peer = useAppStore(useMemo(() => selectPeer(peerKey), [peerKey]));
  const pendingPairings = useAppStore(selectPendingPairings);

  const [stage, setStage] = useState<Stage>('idle');

  /**
   * The last thing we knew about this peer.
   *
   * Discovery drops a device the moment its advertisement is missed a couple of
   * times, which happens routinely while a link is being opened to it. Holding
   * the previous view keeps the sheet from blanking out under the user's finger
   * over what is usually a non-event.
   */
  const lastKnown = useRef<PeerView | null>(peer ?? null);
  useEffect(() => {
    if (peer) lastKnown.current = peer;
  }, [peer]);
  const view = peer ?? lastKnown.current;

  /**
   * The session is the truth.
   *
   * Our local stage only exists to cover the gap between the tap and the first
   * event: `connect()` has to open a radio link before a session exists to
   * report anything. Once the session speaks, it wins.
   */
  const connection = view?.connection;
  useEffect(() => {
    if (connection === undefined) return;
    switch (connection) {
      case ConnectionState.CONNECTED:
        setStage('connected');
        return;
      case ConnectionState.CONNECTING:
        setStage('connecting');
        return;
      // Authenticating, agreeing a transport and comparing six digits are all
      // "securing" to the user; the difference between them is ours to keep.
      case ConnectionState.AUTHENTICATING:
      case ConnectionState.NEGOTIATING_TRANSPORT:
      case ConnectionState.PAIRING:
        setStage('securing');
        return;
      case ConnectionState.FAILED:
        // A session that failed before the user asked for anything is not this
        // sheet's news to break; it just means the last attempt ended.
        setStage((current) => (current === 'idle' ? current : 'failed'));
        return;
      default:
        return;
    }
  }, [connection]);

  // Nothing here may spin forever. Each working stage carries its own deadline,
  // and the timer restarts whenever the stage moves - so real progress is never
  // punished for taking a while overall.
  useEffect(() => {
    if (stage !== 'connecting' && stage !== 'securing') return;
    const budget = stage === 'connecting' ? CONNECTING_TIMEOUT_MS : SECURING_TIMEOUT_MS;
    const timer = setTimeout(() => setStage('failed'), budget);
    return () => clearTimeout(timer);
  }, [stage]);

  useEffect(() => {
    if (stage !== 'connected') return;
    const timer = setTimeout(() => navigation.goBack(), SUCCESS_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [stage, navigation]);

  /**
   * Say the connection out loud.
   *
   * `accessibilityLiveRegion` is Android-only, so on iOS the status block
   * changes in silence: a VoiceOver user presses Connect and is told nothing
   * for twenty seconds. Only on a move, and never for the state the sheet
   * opened on, which they have just read.
   */
  const spoken = useRef<Stage>('idle');
  useEffect(() => {
    if (stage === spoken.current) return;
    spoken.current = stage;
    if (!view) return;
    const status = describe(stage, view);
    AccessibilityInfo.announceForAccessibility(
      status.detail ? `${status.title}. ${status.detail}` : status.title,
    );
  }, [stage, view]);

  /**
   * A first meeting interrupts everything.
   *
   * `replace` rather than `navigate`: the sheet has nothing left to say once the
   * six digits are up, and leaving it stacked underneath would make the user
   * dismiss the most security-critical screen in the app and then dismiss a
   * stale sheet behind it.
   */
  // Not one the user has already answered: a confirmed pairing stays pending
  // until the other phone answers too, and re-opening the ceremony over it
  // would ask a question that can no longer be answered.
  const pairing = pendingPairings.find((p) => p.peerKey === peerKey && !isPairingAnswered(p.peerKey));
  useEffect(() => {
    if (!pairing) return;
    navigation.replace('PairingConfirm', { peerKey });
  }, [pairing, navigation, peerKey]);

  /**
   * Which attempt is on screen.
   *
   * `connect()` cannot be called off once it is in flight, so a retry can be
   * running while an earlier attempt is still on its way to a rejection. Only
   * the current one is allowed to move the sheet; otherwise a stale failure
   * would drop a live attempt onto "Couldn't connect".
   */
  const attempt = useRef(0);

  const beginConnect = useCallback(() => {
    if (!client) return;
    const mine = ++attempt.current;
    setStage('connecting');
    void (async () => {
      try {
        await client.connect(peerKey);
      } catch {
        if (attempt.current !== mine) return;
        // Deliberately not the thrown message: it comes from a transport and
        // can carry wording written for a log file. One plain sentence and a
        // retry is all the user can act on anyway.
        setStage((current) => (current === 'connected' ? current : 'failed'));
      }
    })();
  }, [client, peerKey]);

  const close = useCallback(() => navigation.goBack(), [navigation]);

  const cancel = useCallback(() => {
    // A link the radio is already opening cannot be called back - that timeout
    // belongs to the transport. So cancelling means: stop waiting here, and
    // close whatever session did manage to open.
    void client?.disconnect(peerKey).catch(() => undefined);
    navigation.goBack();
  }, [client, navigation, peerKey]);

  if (!view) {
    return (
      <Screen scroll style={{ flexGrow: 1, justifyContent: 'center' }}>
        <EmptyState
          icon="◎"
          title={homeCopy.goneTitle}
          body={homeCopy.goneBody}
          action={<Button title={strings.common.close} variant="secondary" onPress={close} />}
        />
      </Screen>
    );
  }

  const relationship = view.isFriend ? strings.home.trustedFriend : strings.home.newDevice;
  const status = describe(stage, view);

  return (
    <Screen scroll style={{ flexGrow: 1, justifyContent: 'space-between' }}>
      <View>
        <Gap size="xxl" />
        <View style={{ alignItems: 'center' }}>
          <Avatar name={view.displayName} peerId={view.peerId} emoji={view.avatarEmoji} size={AVATAR_SIZE} />
          <Gap size="lg" />
          <Label variant="title2" align="center" numberOfLines={2}>
            {view.displayName}
          </Label>
          <Gap size="xs" />
          <Label variant="footnote" tone="secondary">
            {relationship}
          </Label>
        </View>

        <Gap size="xl" />

        {/* One block that says exactly where we are. The live region is for
            Android; iOS is told by the announcement above. */}
        <View
          accessible
          accessibilityLiveRegion="polite"
          accessibilityLabel={status.detail ? `${status.title}. ${status.detail}` : status.title}
          style={{
            backgroundColor: theme.colors.surfaceElevated,
            borderRadius: theme.radius.md,
            paddingVertical: theme.spacing.md,
            paddingHorizontal: theme.spacing.lg,
            // Two lines' worth, reserved: the block grows a detail line as the
            // connection moves, and the buttons below must not jump when it does.
            minHeight: theme.spacing.xxxl + theme.spacing.lg,
            justifyContent: 'center',
          }}
        >
          <Row gap="sm">
            {/* A dot in every stage, not only while working: the same anatomy
                as every other status in the app, and the words beside it stay
                where they are instead of sliding sideways when it appears. */}
            {stage === 'connecting' || stage === 'securing' ? <PulsingDot /> : <StatusDot tone={dotTone(stage)} />}
            <View style={{ flex: 1 }}>
              <Label variant="callout" tone={stage === 'connected' ? 'connected' : 'primary'}>
                {status.title}
              </Label>
              {status.detail ? (
                <Label variant="footnote" tone="secondary">
                  {status.detail}
                </Label>
              ) : null}
            </View>
          </Row>
        </View>
      </View>

      <View>
        <Gap size="xl" />
        <Actions
          stage={stage}
          ready={client !== null}
          onConnect={beginConnect}
          onCancel={cancel}
          onClose={close}
        />
      </View>
    </Screen>
  );
}

/** The dot beside the status line at rest. While working it pulses instead. */
function dotTone(stage: Stage): StatusTone {
  switch (stage) {
    case 'connected':
      return 'connected';
    case 'failed':
      return 'warning';
    default:
      return 'disconnected';
  }
}

/** What the user is told at each stage. Never a code, never a transport name. */
function describe(stage: Stage, peer: PeerView): { title: string; detail?: string } {
  switch (stage) {
    case 'connecting':
      return { title: strings.connection.connecting };
    case 'securing':
      // A friend is being recognised silently; a new device is about to ask the
      // user to compare six digits, so warn them a beat before it happens.
      return peer.isFriend
        ? { title: strings.connection.securing }
        : { title: strings.connection.securing, detail: homeCopy.firstMeeting };
    case 'connected':
      return { title: statusLine(peer), detail: strings.connection.keepAppOpen };
    case 'failed':
      return { title: strings.connection.failed, detail: homeCopy.connectFailedBody };
    default:
      // A friend gets their status; a device nobody has met yet gets the one
      // fact that decides what the next tap will ask of them.
      return peer.isFriend ? { title: statusLine(peer) } : { title: homeCopy.firstMeeting };
  }
}

function Actions({
  stage,
  ready,
  onConnect,
  onCancel,
  onClose,
}: {
  stage: Stage;
  ready: boolean;
  onConnect: () => void;
  onCancel: () => void;
  onClose: () => void;
}): React.JSX.Element {
  switch (stage) {
    case 'connecting':
    case 'securing':
      // No spinning primary button: the status block above already carries the
      // pulse and the words, and a button that cannot be pressed is furniture.
      // The one control here is the way out, which this sheet must always have.
      return <Button title={homeCopy.cancelAttempt} variant="secondary" onPress={onCancel} />;
    case 'connected':
      return <Button title={strings.common.done} onPress={onClose} />;
    case 'failed':
      return (
        <>
          <Button title={strings.connection.tryAgain} onPress={onConnect} disabled={!ready} disabledReason={homeCopy.notReadyToConnect} />
          <Gap size="sm" />
          <Button title={strings.common.close} variant="ghost" onPress={onClose} />
        </>
      );
    default:
      return (
        <>
          <Button
            title={strings.home.connect}
            onPress={onConnect}
            disabled={!ready}
            // The radios come up a moment after the app does. Saying so beats a
            // button that looks live and swallows the tap.
            disabledReason={homeCopy.startingUp}
          />
          <Gap size="sm" />
          <Button title={strings.common.cancel} variant="ghost" onPress={onClose} />
        </>
      );
  }
}
