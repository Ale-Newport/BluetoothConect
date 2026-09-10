import React, { useCallback, useEffect, useState } from 'react';
import { View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { TransferState, formatBytes } from '@airlink/core';
import { strings } from '@airlink/config';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  Gap,
  Label,
  Row,
  Screen,
  StatusBanner,
  haptic,
  useTheme,
} from '../../ui/index.js';
import { useAppStore } from '../../state/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { ProgressBar } from './controls.js';
import { canSaveToPhotos, openReceivedFile, saveToPhotos } from './fileStore.js';
import { FileSummary } from './TransferRow.js';
import {
  isTerminal,
  progressLine,
  rateLine,
  safeDisplayName,
  statusLine,
  statusTextTone,
} from './presentation.js';
import { shareStrings } from './strings.js';
import type { TransferRecord } from './transferCenter.js';
import { useTransfer, useTransferCenter } from './useTransfers.js';

/**
 * Somebody wants to send you something.
 *
 * Nothing is ever accepted on the user's behalf: a file arriving on a plane is
 * a stranger handing you a package, and the app's job is to say who, what and
 * how big, then wait. After Accept the same sheet becomes the progress view, so
 * the person who said yes can watch it happen and stop it without hunting for
 * the tab it went to.
 */

/** How long "Saved to Photos" and its siblings stay up before clearing. */
const NOTICE_MS = 4000;

export function IncomingFileScreen({
  route,
  navigation,
}: NativeStackScreenProps<RootStackParams, 'IncomingFile'>): React.JSX.Element {
  const theme = useTheme();
  const centre = useTransferCenter();
  const record = useTransfer(route.params.transferId);

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // A one-off message takes itself down. Nothing on this sheet may sit there
  // forever waiting to be dismissed.
  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const peerName = useAppStore(
    (state) => state.peers.find((peer) => peer.key === route.params.peerKey)?.displayName ?? record?.peerName ?? '',
  );
  const peerId = useAppStore((state) => state.peers.find((peer) => peer.key === route.params.peerKey)?.peerId ?? null);

  const accept = useCallback(() => {
    if (!centre || !record) return;
    setBusy(true);
    setNotice(null);
    void centre
      .accept(record.id)
      .then(() => haptic('success'))
      // The only way this fails is the offer having gone away between the sheet
      // opening and the tap - the peer walked off, or their side timed out.
      .catch(() => setNotice(shareStrings.incomingGone))
      .finally(() => setBusy(false));
  }, [centre, record]);

  const decline = useCallback(() => {
    if (!centre || !record) return;
    centre.decline(record.id);
    navigation.goBack();
  }, [centre, record, navigation]);

  const stop = useCallback(() => {
    if (!centre || !record) return;
    centre.cancel(record.id);
  }, [centre, record]);

  const open = useCallback(() => {
    if (!record?.localPath) return;
    void openReceivedFile(record.localPath, record.mimeType).then((opened) => {
      if (!opened) setNotice(shareStrings.couldNotOpen);
    });
  }, [record]);

  const save = useCallback(() => {
    if (!record?.localPath) return;
    void saveToPhotos(record.localPath, record.filename, record.mimeType).then((saved) => {
      setNotice(saved ? shareStrings.savedToPhotos : shareStrings.couldNotSave);
      if (saved) haptic('success');
    });
  }, [record]);

  /**
   * The offer is gone, or was never ours.
   *
   * An offer expires on both sides after two minutes, and a peer can withdraw
   * one, so this sheet can genuinely outlive the thing it was opened for. It
   * says so and offers the way out rather than showing an empty progress bar.
   */
  if (!record) {
    return (
      <Screen>
        <EmptyState
          icon="↓"
          title={shareStrings.incomingGone}
          action={<Button title={strings.common.close} variant="secondary" onPress={() => navigation.goBack()} />}
        />
      </Screen>
    );
  }

  const name = safeDisplayName(record.filename);
  const waiting = record.state === TransferState.OFFERED;
  const finished = isTerminal(record);
  const received = record.state === TransferState.COMPLETED && record.localPath !== null;

  return (
    <Screen scroll>
      <Gap size="lg" />

      <Row gap="md">
        <Avatar name={peerName} peerId={peerId} size={44} />
        <View style={{ flex: 1 }}>
          <Label variant="title2">
            {waiting ? strings.share.wantsToSend(peerName) : shareStrings.incomingFrom(peerName)}
          </Label>
        </View>
      </Row>

      <Gap size="lg" />

      <Card>
        {/* The name came off the wire. It is shown as text and never used to
            build a path, and `safeDisplayName` has already taken out the
            invisible characters that let a peer make an executable read as a
            picture. */}
        <FileSummary filename={name} mimeType={record.mimeType} sizeLine={formatBytes(record.totalBytes)} />

        {!waiting ? (
          <View style={{ marginTop: theme.spacing.lg }}>
            {!finished ? (
              <>
                <ProgressBar
                  percent={record.percent}
                  tone={record.paused ? 'paused' : 'accent'}
                  accessibilityLabel={shareStrings.progressLabel(name, statusLine(record))}
                />
                <Label variant="caption" tone="tertiary" style={{ marginTop: theme.spacing.xs }}>
                  {progressLine(record)}
                </Label>
              </>
            ) : null}
            <Label
              variant="footnote"
              tone={statusTextTone(record)}
              style={{ marginTop: theme.spacing.xs }}
            >
              {rateLine(record) ?? statusLine(record)}
            </Label>
            {record.paused && !finished ? (
              <Label variant="caption" tone="tertiary" style={{ marginTop: theme.spacing.xs }}>
                {shareStrings.pausedDetail}
              </Label>
            ) : null}
          </View>
        ) : null}
      </Card>

      <Gap size="lg" />

      {notice ? (
        <>
          <StatusBanner tone="connecting" title={notice} />
          <Gap size="lg" />
        </>
      ) : null}

      <Actions
        record={record}
        busy={busy}
        waiting={waiting}
        finished={finished}
        received={received}
        onAccept={accept}
        onDecline={decline}
        onStop={stop}
        onOpen={open}
        onSave={save}
        onClose={() => navigation.goBack()}
      />

      <Gap size="lg" />
    </Screen>
  );
}

function Actions({
  record,
  busy,
  waiting,
  finished,
  received,
  onAccept,
  onDecline,
  onStop,
  onOpen,
  onSave,
  onClose,
}: {
  record: TransferRecord;
  busy: boolean;
  waiting: boolean;
  finished: boolean;
  received: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onStop: () => void;
  onOpen: () => void;
  onSave: () => void;
  onClose: () => void;
}): React.JSX.Element {
  // Nothing has been agreed to yet: two equal-weight answers, and no default.
  if (waiting) {
    return (
      <View>
        <Button title={strings.share.accept} onPress={onAccept} loading={busy} />
        <Gap size="sm" />
        <Button title={strings.share.decline} variant="ghost" onPress={onDecline} disabled={busy} />
      </View>
    );
  }

  if (!finished) {
    return (
      <View>
        <Button title={shareStrings.stop} variant="secondary" onPress={onStop} />
        <Gap size="sm" />
        {/* Leaving does not stop anything: the transfer belongs to the app, not
            to this sheet, and it keeps going while the user is elsewhere. */}
        <Button title={strings.common.close} variant="ghost" onPress={onClose} />
      </View>
    );
  }

  if (received) {
    return (
      <View>
        <Button title={shareStrings.open} onPress={onOpen} />
        {canSaveToPhotos(record.mimeType) ? (
          <>
            <Gap size="sm" />
            <Button title={strings.share.saveToPhotos} variant="secondary" onPress={onSave} />
          </>
        ) : null}
        <Gap size="sm" />
        <Button title={strings.common.done} variant="ghost" onPress={onClose} />
      </View>
    );
  }

  return <Button title={strings.common.close} variant="secondary" onPress={onClose} />;
}
