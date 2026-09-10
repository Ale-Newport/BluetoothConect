import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useShallow } from 'zustand/react/shallow';
import { FILE_LIMITS, TransferDirection, formatBytes, formatDuration, isTerminalState } from '@airlink/core';
import { strings } from '@airlink/config';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  Gap,
  Label,
  Screen,
  SectionHeading,
  StatusBanner,
  haptic,
  useTheme,
} from '../../ui/index.js';
import { selectConnected, useAppStore } from '../../state/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
// The app's one translation of a quality token into a word. Importing it beats
// a second copy of the same four-case switch, which is how two screens end up
// disagreeing about what "weak" is called.
import { qualityWord } from '../home/peerPresentation.js';
import { ChoiceRow, FileTile, RowSeparator } from './controls.js';
import { FileSummary } from './TransferRow.js';
import { pickDocument, pickPhoto, type PickResult, type PickedFile } from './picker.js';
import { FileKind, safeDisplayName } from './presentation.js';
import { shareStrings } from './strings.js';
import { useTransferCenter, useTransfers } from './useTransfers.js';

/**
 * Send something.
 *
 * Three decisions in one sheet - what, to whom, and whether it is worth it -
 * and the third is the one most apps skip. If the only link to this person is
 * Bluetooth and the file is big, the sheet says so BEFORE the Send button is
 * pressed, with the real estimate and the one thing that would fix it. Nobody
 * should discover they started a forty-minute transfer forty minutes later.
 */

/**
 * Above this, a transfer is long enough that a person deserves to be warned
 * before committing rather than after. A minute is roughly where "wait for it"
 * turns into "put the phone down and do something else".
 */
const LONG_TRANSFER_MS = 60_000;

/**
 * A file big enough to be worth warning about even before there is any
 * throughput to base an estimate on. Eight megabytes is a couple of photos, and
 * on Bluetooth it is already minutes.
 */
const BULKY_BYTES = 8 * 1000 * 1000;

/** Leading tile and avatar size in this sheet's choice rows. */
const ROW_TILE = 40;

type Props = NativeStackScreenProps<RootStackParams, 'ShareCompose'>;

export function ShareComposeScreen({ route, navigation }: Props): React.JSX.Element {
  const theme = useTheme();
  const centre = useTransferCenter();
  const transfers = useTransfers();
  const connected = useAppStore(useShallow(selectConnected));

  const [file, setFile] = useState<PickedFile | null>(null);
  const [picking, setPicking] = useState(false);
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [recipientKey, setRecipientKey] = useState(route.params.peerKey);

  /**
   * The person this sheet was opened for may walk away while it is open, so the
   * selection follows what is actually connected rather than what was passed in.
   * Silently retargeting a send would be far worse than re-asking.
   */
  const recipient = useMemo(
    () => connected.find((peer) => peer.key === recipientKey) ?? null,
    [connected, recipientKey],
  );
  useEffect(() => {
    const first = connected[0];
    if (!recipient && first) setRecipientKey(first.key);
  }, [connected, recipient]);

  /**
   * The protocol refuses a fourth simultaneous send, so the button says so
   * beforehand rather than throwing an error message at the user afterwards.
   *
   * Counted PER PERSON, because that is how the protocol counts: there is one
   * transfer protocol per peer and the limit belongs to it. Counting every send
   * in the app would let three files paused on their way to a friend who has
   * walked off block a send to somebody sitting in the same room, with a reason
   * that told them to finish transfers that cannot be finished.
   */
  const outgoingInFlight = useMemo(
    () =>
      recipient === null
        ? 0
        : transfers.filter(
            (record) =>
              record.direction === TransferDirection.OUTGOING &&
              record.peerKey === recipient.key &&
              !isTerminalState(record.state),
          ).length,
    [transfers, recipient],
  );

  const estimate = useMemo(
    () => (centre && recipient && file ? centre.estimateFor(recipient.key, file.fileBytes) : null),
    [centre, recipient, file],
  );

  const choose = useCallback(async (pick: () => Promise<PickResult>) => {
    setPicking(true);
    setProblem(null);
    try {
      const result = await pick();
      if (result.status === 'picked') {
        setFile(result.file);
        haptic('selection');
      } else if (result.status === 'failed') {
        setProblem(result.message);
      }
    } catch {
      // A picker can reject as well as return a failure - a denied permission,
      // a file the OS will not copy. Swallowing that would close the picker and
      // leave the sheet exactly as it was, which reads as the tap having been
      // ignored.
      setProblem(shareStrings.couldNotReadFile);
    } finally {
      // Always: a picker that is cancelled, throws or hangs must still give the
      // sheet back to the user rather than leaving a spinner with no end.
      setPicking(false);
    }
  }, []);

  const tooLarge = file !== null && file.fileBytes > FILE_LIMITS.defaultMaxFileBytes;
  const tooBusy = outgoingInFlight >= FILE_LIMITS.maxConcurrentOutgoing;

  // Every reason Send cannot be pressed, in the order a person would hit them.
  // `centre` is null for the first moment after launch, while the radios come
  // up: without it here the button would look live and do nothing at all.
  const disabledReason = !centre
    ? shareStrings.notReadyYet
    : !file
      ? shareStrings.nothingChosen
      : !recipient
        ? shareStrings.connectFirst
        : tooLarge
          ? shareStrings.tooLarge
          : tooBusy
            ? shareStrings.tooManyAtOnce(recipient.displayName)
            : null;

  const send = useCallback(() => {
    if (!centre || !file || !recipient) return;
    setSending(true);
    setProblem(null);
    void centre
      .send({
        peerKey: recipient.key,
        path: file.path,
        filename: file.filename,
        mimeType: file.mimeType,
        fileBytes: file.fileBytes,
      })
      .then(() => {
        haptic('success');
        navigation.goBack();
      })
      .catch(() => {
        // The rejection carries protocol wording written for a log. The user
        // gets a sentence instead, and the sheet stays open with their choices
        // intact so Send can simply be pressed again.
        setProblem(shareStrings.couldNotSend);
      })
      .finally(() => setSending(false));
  }, [centre, file, recipient, navigation]);

  return (
    <Screen safeTop={false} scroll>
      <Gap size="lg" />

      {problem ? (
        <>
          <StatusBanner tone="warning" title={problem} />
          <Gap size="lg" />
        </>
      ) : null}

      <SectionHeading>{shareStrings.file}</SectionHeading>
      <Card>
        {file ? (
          <View>
            <FileSummary
              filename={safeDisplayName(file.filename)}
              mimeType={file.mimeType}
              sizeLine={formatBytes(file.fileBytes)}
              previewUri={file.previewUri}
            />
            <Gap size="md" />
            <Button
              title={shareStrings.change}
              variant="secondary"
              onPress={() => setFile(null)}
              disabled={sending}
              disabledReason={shareStrings.preparing}
            />
          </View>
        ) : (
          <View>
            <Label variant="headline">{shareStrings.chooseSomething}</Label>
            <Label variant="footnote" tone="secondary" style={{ marginTop: theme.spacing.xs }}>
              {shareStrings.chooseSomethingBody}
            </Label>
            <Gap size="sm" />
            <ChoiceRow
              title={strings.share.choosePhoto}
              accessibilityLabel={shareStrings.choosePhotoLabel}
              disabled={picking}
              left={<FileTile kind={FileKind.IMAGE} size={ROW_TILE} />}
              onPress={() => void choose(pickPhoto)}
            />
            <RowSeparator inset={ROW_TILE + theme.spacing.md} />
            <ChoiceRow
              title={strings.share.chooseFile}
              accessibilityLabel={shareStrings.chooseFileLabel}
              disabled={picking}
              left={<FileTile kind={FileKind.DOCUMENT} size={ROW_TILE} />}
              onPress={() => void choose(pickDocument)}
            />
            {picking ? (
              <Label variant="caption" tone="tertiary" style={{ marginTop: theme.spacing.sm }}>
                {shareStrings.preparing}
              </Label>
            ) : null}
          </View>
        )}
      </Card>

      <Gap size="xl" />

      <SectionHeading>{shareStrings.sendTo}</SectionHeading>
      {connected.length === 0 ? (
        <EmptyState icon="◎" title={shareStrings.noRecipientsTitle} body={shareStrings.noRecipientsBody} />
      ) : (
        <Card style={{ paddingVertical: theme.spacing.xs }}>
          {connected.map((peer, index) => (
            <View key={peer.key}>
              {index > 0 ? <RowSeparator inset={ROW_TILE + theme.spacing.md} /> : null}
              <ChoiceRow
                role="radio"
                title={peer.displayName}
                // `peer.quality` is a raw token ("excellent", "weak"): a word
                // for the code, not for a person. It is never shown as it is.
                subtitle={qualityWord(peer.quality) ?? strings.home.connected}
                selected={peer.key === recipientKey}
                accessibilityLabel={shareStrings.recipientLabel(peer.displayName)}
                left={<Avatar name={peer.displayName} peerId={peer.peerId} emoji={peer.avatarEmoji} size={ROW_TILE} />}
                onPress={() => setRecipientKey(peer.key)}
              />
            </View>
          ))}
        </Card>
      )}

      <Gap size="xl" />

      {/* The honest bit. Shown before the decision, never after it. */}
      {file && recipient && estimate?.slowLink && (tooSlowToIgnore(estimate.etaMs) || file.fileBytes >= BULKY_BYTES) ? (
        <>
          <StatusBanner
            tone="warning"
            title={strings.share.slowLinkWarning}
            detail={`${
              estimate.etaMs === null ? shareStrings.estimating : shareStrings.aboutHowLong(formatDuration(estimate.etaMs))
            } ${strings.share.fasterOverWifi}`}
          />
          <Gap size="lg" />
        </>
      ) : null}

      <Button
        title={strings.share.send}
        onPress={send}
        loading={sending}
        disabled={disabledReason !== null}
        {...(disabledReason ? { disabledReason } : {})}
      />
      {sending ? (
        <Label variant="caption" tone="tertiary" align="center" style={{ marginTop: theme.spacing.xs }}>
          {shareStrings.preparing}
        </Label>
      ) : null}

      <Gap size="sm" />
      <Button
        title={strings.share.cancel}
        variant="ghost"
        onPress={() => navigation.goBack()}
        disabled={sending}
        disabledReason={shareStrings.preparing}
      />
      <Gap size="lg" />
    </Screen>
  );
}

/** Long enough that somebody would want to know before they committed. */
function tooSlowToIgnore(etaMs: number | null): boolean {
  return etaMs !== null && etaMs >= LONG_TRANSFER_MS;
}
