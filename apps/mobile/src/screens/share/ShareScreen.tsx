import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useIsFocused, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useShallow } from 'zustand/react/shallow';
import { TransferDirection, TransferState } from '@airlink/core';
import { strings } from '@airlink/config';
import {
  Button,
  Card,
  EmptyState,
  Gap,
  Label,
  Row,
  Screen,
  SectionHeading,
  StatusBanner,
  useTheme,
} from '../../ui/index.js';
import { selectConnected, useAppStore, type PeerView } from '../../state/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { RowAction, RowSeparator, TILE_SIZE } from './controls.js';
import { openReceivedFile } from './fileStore.js';
import { TransferRow, type TransferRowActions } from './TransferRow.js';
import { groupOf, TransferGroup } from './presentation.js';
import { shareStrings } from './strings.js';
import type { TransferRecord } from './transferCenter.js';
import { useTransferCenter, useTransfers } from './useTransfers.js';

/**
 * Share.
 *
 * The list of what has moved between this phone and the ones near it, and one
 * prominent way to send something else. Everything on it is real: the
 * percentages, the rates and the times remaining all come from what the link
 * has ACTUALLY managed, measured by the protocol, never from a transport's
 * nominal figure.
 *
 * The screen deliberately has no Pause button. The protocol pauses by itself
 * when a link drops and resumes from its bitmap when the link returns, and
 * there is no message on the wire for "pause on purpose" - so a Pause control
 * here would be a button that looks live and does something else. Stop is
 * offered instead, and a transfer that has stopped moving says "Paused" and why.
 */

/** How long a one-off notice ("Saved to Photos") stays up before clearing itself. */
const NOTICE_MS = 4000;

export function ShareScreen(): React.JSX.Element {
  const theme = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const isFocused = useIsFocused();
  const centre = useTransferCenter();
  const transfers = useTransfers();

  // `useShallow` because the selector builds a new array on every store change;
  // without it the snapshot is never equal to itself and this re-renders forever.
  const connected = useAppStore(useShallow(selectConnected));
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const { waiting, active, finished } = useMemo(() => groupTransfers(transfers), [transfers]);

  const recipient: PeerView | undefined = connected[0];

  /**
   * An offer that arrives while this tab is in front interrupts, because it is
   * a question only the user can answer and it expires.
   *
   * Only while focused, and only once per transfer: a second navigation would
   * stack two copies of the same sheet, and re-presenting one the user has
   * already dismissed would trap them. Anything missed this way is still in
   * "Waiting for you" below, so nothing is ever lost - it simply stops shouting.
   */
  const presented = useRef(new Set<string>());
  useEffect(() => {
    if (!isFocused) return;
    const next = waiting.find((record) => !presented.current.has(record.id));
    if (!next) return;
    presented.current.add(next.id);
    navigation.navigate('IncomingFile', { peerKey: next.peerKey, transferId: next.id });
  }, [waiting, isFocused, navigation]);

  const openCompose = useCallback(() => {
    if (!recipient) return;
    navigation.navigate('ShareCompose', { peerKey: recipient.key });
  }, [navigation, recipient]);

  const actions = useMemo<TransferRowActions>(
    () => ({
      onReview: (record) => navigation.navigate('IncomingFile', { peerKey: record.peerKey, transferId: record.id }),
      onStop: (record) => centre?.cancel(record.id),
      onOpen: (record) => {
        if (!record.localPath) return;
        void openReceivedFile(record.localPath, record.mimeType).then((opened) => {
          if (!opened) setNotice(shareStrings.couldNotOpen);
        });
      },
      onRetry: (record) => {
        if (!centre || !record.localPath) return;
        void centre
          .send({
            peerKey: record.peerKey,
            path: record.localPath,
            filename: record.filename,
            mimeType: record.mimeType,
            fileBytes: record.totalBytes,
          })
          .then(() => centre.forget(record.id))
          .catch(() => setNotice(shareStrings.couldNotSend));
      },
    }),
    [centre, navigation],
  );

  /**
   * A retry needs four things to be true at once, and all four are checked here
   * rather than inside the row: the file has to have been ours to begin with,
   * it has to have actually gone wrong, the copy we sent from has to still be
   * on disk as far as we know, and the person has to be back in range.
   *
   * The second of those is easy to forget and the worst to get wrong. A send
   * that SUCCEEDED is terminal like any other, so without it the app puts "Try
   * again" beside "Sent" - which reads as though something failed, and sends
   * the file a second time for anybody who believes it. A transfer the other
   * person declined is excluded for a different reason: they answered, and a
   * one-tap way to ask them again is not a feature.
   */
  const connectedKeys = useMemo(() => new Set(connected.map((peer) => peer.key)), [connected]);
  const canRetry = useCallback(
    (record: TransferRecord): boolean =>
      record.direction === TransferDirection.OUTGOING &&
      (record.state === TransferState.FAILED || record.state === TransferState.CANCELLED) &&
      record.localPath !== null &&
      connectedKeys.has(record.peerKey),
    [connectedKeys],
  );

  const clearFinished = useCallback(() => {
    for (const record of finished) centre?.forget(record.id);
  }, [centre, finished]);

  const nothingAtAll = transfers.length === 0;

  // Two separate reasons, and the button says which one applies. `centre` is
  // null for the first moment after launch, while the radios are still coming
  // up; opening the sheet then would offer a Send that could not send.
  const cannotSend = !centre ? shareStrings.notReadyYet : !recipient ? shareStrings.connectFirst : null;

  const sendButton = (
    <Button
      title={shareStrings.sendSomething}
      onPress={openCompose}
      disabled={cannotSend !== null}
      {...(cannotSend ? { disabledReason: cannotSend } : {})}
    />
  );

  return (
    <Screen scroll>
      <Gap size="xxl" />
      <Label variant="largeTitle">{strings.share.title}</Label>
      <Gap size="lg" />

      {/* Nobody in range is not an error - it is Tuesday. Same calm grey as
          everything else, and it says what to do about it. */}
      {!recipient ? (
        <>
          <StatusBanner
            tone="disconnected"
            title={shareStrings.notConnected}
            detail={shareStrings.noRecipientsBody}
          />
          <Gap size="lg" />
        </>
      ) : null}

      {notice ? (
        <>
          <StatusBanner tone="connecting" title={notice} />
          <Gap size="lg" />
        </>
      ) : null}

      {nothingAtAll ? null : (
        <>
          {sendButton}
          <Gap size="xl" />
        </>
      )}

      {waiting.length > 0 ? (
        <TransferSection
          heading={shareStrings.waitingForYou}
          records={waiting}
          canRetry={canRetry}
          actions={actions}
        />
      ) : null}

      {active.length > 0 ? (
        <TransferSection heading={shareStrings.inProgress} records={active} canRetry={canRetry} actions={actions} />
      ) : null}

      {finished.length > 0 ? (
        <TransferSection
          heading={shareStrings.recent}
          records={finished}
          canRetry={canRetry}
          actions={actions}
          headingAction={
            <RowAction
              title={shareStrings.clearFinished}
              tone="quiet"
              accessibilityLabel={shareStrings.clearFinishedLabel}
              onPress={clearFinished}
            />
          }
        />
      ) : null}

      {nothingAtAll ? (
        <EmptyState icon="↑" title={shareStrings.emptyTitle} body={shareStrings.emptyBody} action={sendButton} />
      ) : null}

      <Gap size="lg" />
      {/* The one thing that will surprise someone whose transfer stops. */}
      <Label variant="caption" tone="tertiary" align="center" style={{ paddingHorizontal: theme.spacing.lg }}>
        {strings.connection.keepAppOpen}
      </Label>
      <Gap size="lg" />
    </Screen>
  );
}

function TransferSection({
  heading,
  records,
  canRetry,
  actions,
  headingAction,
}: {
  heading: string;
  records: readonly TransferRecord[];
  canRetry: (record: TransferRecord) => boolean;
  actions: TransferRowActions;
  headingAction?: React.ReactNode;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View>
      {headingAction ? (
        <Row align="center">
          <View style={{ flex: 1 }}>
            <SectionHeading>{heading}</SectionHeading>
          </View>
          {headingAction}
        </Row>
      ) : (
        <SectionHeading>{heading}</SectionHeading>
      )}
      <Card style={{ paddingVertical: theme.spacing.xs }}>
        {records.map((record, index) => (
          <View key={record.id}>
            {index > 0 ? <RowSeparator inset={TILE_SIZE + theme.spacing.md} /> : null}
            <TransferRow record={record} canRetry={canRetry(record)} actions={actions} />
          </View>
        ))}
      </Card>
      <Gap size="xl" />
    </View>
  );
}

/**
 * Three lists out of one.
 *
 * The centre already sorts by when a record last changed, so the order inside
 * each group is "whatever moved most recently", which is what a person is
 * looking for when they open this tab mid-transfer.
 */
function groupTransfers(records: readonly TransferRecord[]): {
  waiting: TransferRecord[];
  active: TransferRecord[];
  finished: TransferRecord[];
} {
  const waiting: TransferRecord[] = [];
  const active: TransferRecord[] = [];
  const finished: TransferRecord[] = [];
  for (const record of records) {
    if (groupOf(record) === TransferGroup.WAITING) waiting.push(record);
    else if (groupOf(record) === TransferGroup.ACTIVE) active.push(record);
    else finished.push(record);
  }
  return { waiting, active, finished };
}
