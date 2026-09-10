import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { formatSasCode } from '@airlink/core';
import { strings } from '@airlink/config';
import { Avatar, Button, EmptyState, Gap, Label, Row, Screen, useTheme } from '../../ui/index.js';
import { selectPendingPairings, useAppStore, type PendingPairing } from '../../state/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { PulsingDot } from './controls.js';
import { useOptionalClient } from './useOptionalClient.js';
import { markPairingAnswered } from './pairingRouting.js';
import { homeCopy } from './peerPresentation.js';

/**
 * Comparing six digits.
 *
 * This is the one screen in the app where a mistake is permanent: saying "they
 * match" without looking hands whoever is on the other end a trusted place on
 * this phone, and the trust store will let them straight in from then on. So it
 * behaves accordingly - it never dismisses itself while the question is still
 * open, it never pre-selects an answer, and the confirm button refuses the tap
 * that was already travelling when the screen appeared.
 *
 * The digits themselves come from the handshake, not from either user, and both
 * phones derive them from the same shared secret. Two different numbers mean a
 * third party is relaying the conversation - which is the whole reason the user
 * is being asked to look.
 */

/**
 * How long "They match" stays inert.
 *
 * A pairing appears without warning, often while the user is mid-tap somewhere
 * else. Long enough to break the momentum of a stray touch, short enough that a
 * user who is genuinely reading never notices it.
 */
const CONFIRM_ARM_MS = 1200;

/**
 * How long we wait for the other phone after this one has answered.
 *
 * The pairing controller runs its own timeout underneath; this is the backstop
 * that guarantees the screen resolves into something tappable even if no event
 * ever arrives.
 */
const PARTNER_TIMEOUT_MS = 45_000;

/**
 * Smaller than the connect sheet's portrait on purpose: on this screen the six
 * digits are the subject and the face is context. A pixel size because `Avatar`
 * takes a number - the design system has no scale for component dimensions.
 */
const AVATAR_SIZE = 56;

type Answer = 'none' | 'confirmed' | 'timedOut' | 'refused';

export function PairingConfirmScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const { peerKey } = useRoute<RouteProp<RootStackParams, 'PairingConfirm'>>().params;
  const client = useOptionalClient();

  const pairing = useAppStore(selectPendingPairings).find((p) => p.peerKey === peerKey);
  const [answer, setAnswer] = useState<Answer>('none');
  const [armed, setArmed] = useState(false);

  /**
   * The pairing we are answering, held across the moment it is resolved.
   *
   * Confirming removes it from the store, and the waiting state still has to
   * name the person it is waiting for. The fallback is deliberately limited to
   * that case: while the question is still open, a pairing that has gone away
   * means there is nothing left to confirm, and the user must be told rather
   * than left holding a live-looking button over a dead session.
   */
  const lastKnown = useRef<PendingPairing | null>(pairing ?? null);
  useEffect(() => {
    if (pairing) lastKnown.current = pairing;
  }, [pairing]);
  const view = pairing ?? (answer === 'confirmed' ? lastKnown.current : null);

  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), CONFIRM_ARM_MS);
    return () => clearTimeout(timer);
  }, []);

  /**
   * The other phone's answer.
   *
   * The store only records that a pairing stopped being pending, not how it
   * ended, so a refusal and a success look identical from there - and the
   * screen would close on both. Someone who has just vouched for six digits is
   * owed the outcome, so we listen for it at the source. The ref is written
   * inside the event, before any re-render, so the dismissal below can never
   * win the race against it.
   */
  const refused = useRef(false);
  /** Our own "they don't match" comes straight back as a refusal; ignore it. */
  const declinedHere = useRef(false);
  useEffect(() => {
    if (!client) return;
    return client.events.on('pairingResolved', (event) => {
      if (event.peerKey !== peerKey || event.trusted || declinedHere.current) return;
      refused.current = true;
      setAnswer('refused');
    });
  }, [client, peerKey]);

  /**
   * Leave only once the user has answered, and only on a good ending.
   *
   * The pairing disappearing while the question is still on screen is not a
   * reason to dismiss: the user is looking at six digits and deciding, and
   * yanking the screen away mid-decision teaches them that the ceremony is
   * cosmetic. They get told instead.
   */
  useEffect(() => {
    if (answer !== 'confirmed' || pairing || refused.current) return;
    navigation.goBack();
  }, [answer, pairing, navigation]);

  useEffect(() => {
    if (answer !== 'confirmed' || !pairing) return;
    const timer = setTimeout(() => setAnswer('timedOut'), PARTNER_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [answer, pairing]);

  const close = useCallback(() => navigation.goBack(), [navigation]);

  /**
   * Say the outcome out loud.
   *
   * Answering swaps the two buttons for a waiting line, or the whole screen for
   * a result. VoiceOver announces neither: it just loses the element it was on.
   * So the one thing the user was waiting to hear is spoken.
   */
  useEffect(() => {
    if (answer === 'none') return;
    const said =
      answer === 'confirmed'
        ? homeCopy.pairingWaiting
        : answer === 'refused'
          ? `${homeCopy.pairingRefusedTitle}. ${homeCopy.pairingRefusedBody}`
          : `${strings.connection.failed}. ${homeCopy.connectFailedBody}`;
    AccessibilityInfo.announceForAccessibility(said);
  }, [answer]);

  /** Why "They match" cannot be pressed yet, or null when it can. */
  const waitReason = client === null ? homeCopy.startingUp : armed ? null : homeCopy.compareFirst;

  const onMatch = useCallback(() => {
    if (!client) return;
    // Recorded before the answer goes out: the decision latches in the pairing
    // machine, so from this moment on nothing may offer the question again.
    markPairingAnswered(peerKey);
    client.confirmPairing(peerKey);
    setAnswer('confirmed');
  }, [client, peerKey]);

  const onMismatch = useCallback(() => {
    // Declining ends the session outright. Nothing to wait for, and nothing the
    // user should have to dismiss afterwards.
    declinedHere.current = true;
    markPairingAnswered(peerKey);
    client?.declinePairing(peerKey);
    navigation.goBack();
  }, [client, navigation, peerKey]);

  // Checked before the pairing itself: the other phone said no, and that is the
  // news whether or not the request is still in the store.
  if (answer === 'refused') {
    return (
      <Screen scroll style={{ flexGrow: 1, justifyContent: 'center' }}>
        <EmptyState
          icon="radar"
          title={homeCopy.pairingRefusedTitle}
          body={homeCopy.pairingRefusedBody}
          action={<Button title={strings.common.close} variant="secondary" onPress={close} />}
        />
      </Screen>
    );
  }

  // Likewise: once we have given up waiting, that is the news, whether or not
  // the request is still in the store.
  if (answer === 'timedOut') {
    return (
      <Screen scroll style={{ flexGrow: 1, justifyContent: 'center' }}>
        <EmptyState
          icon="radar"
          title={strings.connection.failed}
          body={homeCopy.connectFailedBody}
          action={<Button title={strings.common.close} variant="secondary" onPress={close} />}
        />
      </Screen>
    );
  }

  if (!view) {
    return (
      <Screen scroll style={{ flexGrow: 1, justifyContent: 'center' }}>
        <EmptyState
          icon="radar"
          title={homeCopy.pairingGoneTitle}
          body={homeCopy.pairingGoneBody}
          action={<Button title={strings.common.close} variant="secondary" onPress={close} />}
        />
      </Screen>
    );
  }

  return (
    <Screen scroll style={{ flexGrow: 1, justifyContent: 'space-between' }}>
      <View>
        <Gap size="xl" />
        <View style={{ alignItems: 'center' }}>
          {/* No peer id yet - the point of this screen is that these two phones
              have not agreed on one - so the colour comes from the name. */}
          <Avatar name={view.displayName} peerId={null} size={AVATAR_SIZE} />
          <Gap size="md" />
          <Label variant="title2" align="center" numberOfLines={2}>
            {view.displayName}
          </Label>
          <Gap size="xs" />
          <Label variant="footnote" tone="secondary" align="center">
            {homeCopy.firstMeeting}
          </Label>
        </View>

        <Gap size="xl" />
        <PairingCode code={view.code} />
        <Gap size="xl" />

        <Label variant="headline" align="center">
          {strings.connection.confirmTitle}
        </Label>
        <Gap size="xs" />
        <Label variant="subheadline" tone="secondary" align="center">
          {strings.connection.confirmBody}
        </Label>
      </View>

      <View>
        <Gap size="xl" />
        {answer === 'confirmed' ? (
          <>
            <Row gap="sm" style={{ justifyContent: 'center' }}>
              <PulsingDot />
              <Label variant="footnote" tone="secondary">
                {homeCopy.pairingWaiting}
              </Label>
            </Row>
            <Gap size="md" />
            {/* Even a wait the user cannot hurry gets a way out. */}
            <Button title={strings.common.close} variant="ghost" onPress={close} />
          </>
        ) : (
          <>
            {/* The reason sits above the buttons in a slot that keeps its
                height when it goes. Under the button it would push both
                answers upwards a second after the screen appeared - moving
                the target under a thumb that is already on its way down, on
                the one screen where the wrong answer is permanent. */}
            <View style={{ minHeight: theme.typography.footnote.lineHeight, justifyContent: 'center' }}>
              {waitReason ? (
                <Label variant="footnote" tone="tertiary" align="center">
                  {waitReason}
                </Label>
              ) : null}
            </View>
            <Gap size="sm" />
            <Button
              title={strings.connection.confirmYes}
              onPress={onMatch}
              // Nothing is pre-selected and nothing is focused: the answer has
              // to be a deliberate press, and for the first moment it cannot be
              // one at all.
              disabled={waitReason !== null}
            />
            <Gap size="sm" />
            {/* Never disabled, whatever else is not ready: this is also the way
                out of the screen. */}
            <Button title={strings.connection.confirmNo} variant="secondary" onPress={onMismatch} />
          </>
        )}
      </View>
    </Screen>
  );
}

/**
 * The six digits, formatted "483 291".
 *
 * Large and spaced because the entire security of the pairing rests on two
 * people reading them out loud to each other and noticing a difference. The
 * screen-reader label spells them one at a time - "four eight three…" - because
 * "four hundred and eighty-three thousand" is not something you can compare
 * against another phone.
 */
function PairingCode({ code }: { code: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      accessible
      accessibilityRole="text"
      accessibilityLabel={homeCopy.spellCode(code)}
      style={{
        backgroundColor: theme.colors.surfaceElevated,
        borderRadius: theme.radius.lg,
        paddingVertical: theme.spacing.xl,
        paddingHorizontal: theme.spacing.lg,
        alignItems: 'center',
      }}
    >
      <Label variant="pairingCode" align="center">
        {formatSasCode(code)}
      </Label>
    </View>
  );
}
