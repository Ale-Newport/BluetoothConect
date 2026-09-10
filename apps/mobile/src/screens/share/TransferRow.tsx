import React from 'react';
import { Pressable, View } from 'react-native';
import { TransferState } from '@airlink/core';
import { Label, StatusDot, haptic, useTheme } from '../../ui/index.js';
import { FileTile, ProgressBar, RowAction, TILE_SIZE } from './controls.js';
import {
  groupOf,
  isIncoming,
  isMoving,
  kindOf,
  progressLine,
  rateLine,
  safeDisplayName,
  statusLine,
  statusTextTone,
  statusTone,
  summaryLine,
  TransferGroup,
} from './presentation.js';
import { shareStrings } from './strings.js';
import type { TransferRecord } from './transferCenter.js';

/**
 * One transfer in the list.
 *
 * Three lines at most: what the file is, who it is with, and what is happening
 * to it. A moving transfer gets the bar and the two measured lines under it; a
 * finished one gets a single sentence, because "Sent" needs no further
 * explanation and a stale progress bar under it would be a lie about the past.
 */

export interface TransferRowActions {
  /** Answer an incoming offer. Opens the sheet - never accepts in place. */
  onReview(record: TransferRecord): void;
  onStop(record: TransferRecord): void;
  onOpen(record: TransferRecord): void;
  onRetry(record: TransferRecord): void;
}

export function TransferRow({
  record,
  canRetry,
  actions,
}: {
  record: TransferRecord;
  /** Only true when a retry could really work: source still here, peer in range. */
  canRetry: boolean;
  actions: TransferRowActions;
}): React.JSX.Element {
  const theme = useTheme();
  const group = groupOf(record);
  const name = safeDisplayName(record.filename);
  const status = statusLine(record);
  const rate = rateLine(record);
  const showBar = isMoving(record) || record.paused;
  const openable = record.state === TransferState.COMPLETED && isIncoming(record) && record.localPath !== null;

  const body = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.spacing.md,
        paddingVertical: theme.spacing.md,
        minHeight: 56,
      }}
    >
      <FileTile kind={kindOf(record.mimeType, name)} size={TILE_SIZE} />

      <View style={{ flex: 1 }}>
        <Label variant="body" numberOfLines={1}>
          {name}
        </Label>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs, marginTop: theme.spacing.xs }}>
          <StatusDot tone={statusTone(record)} size={6} />
          <Label variant="footnote" tone={statusTextTone(record)} numberOfLines={2} style={{ flex: 1 }}>
            {summaryLine(record)}
          </Label>
        </View>

        {showBar ? (
          <View style={{ marginTop: theme.spacing.sm }}>
            <ProgressBar
              percent={record.percent}
              tone={record.paused ? 'paused' : 'accent'}
              accessibilityLabel={shareStrings.progressLabel(name, status)}
            />
            <Label variant="caption" tone="tertiary" style={{ marginTop: theme.spacing.xs }}>
              {progressLine(record)}
            </Label>
            {/* The rate is measured, so it appears only once there is a sample.
                Until then the line says it is still working it out rather than
                quoting the transport's advertised speed. */}
            {rate ? (
              <Label variant="caption" tone="tertiary">
                {rate}
              </Label>
            ) : null}
          </View>
        ) : null}

        {/* Paused says why, once. Nobody should have to guess whether a
            transfer that stopped is coming back. */}
        {record.paused && group === TransferGroup.ACTIVE ? (
          <Label variant="caption" tone="tertiary" style={{ marginTop: theme.spacing.xs }}>
            {shareStrings.pausedDetail}
          </Label>
        ) : null}
      </View>

      <RowEndAction record={record} canRetry={canRetry} openable={openable} actions={actions} />
    </View>
  );

  // An offer waiting to be answered is the one row that is itself a control:
  // tapping it opens the sheet where Accept and Decline live. Everything else
  // acts through the button at its end, so a stray tap can never start bytes
  // moving.
  if (group !== TransferGroup.WAITING) return body;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={shareStrings.reviewLabel(record.peerName, name)}
      onPress={() => {
        haptic('selection');
        actions.onReview(record);
      }}
      style={({ pressed }) => (pressed ? { opacity: 0.6 } : null)}
    >
      {body}
    </Pressable>
  );
}

function RowEndAction({
  record,
  canRetry,
  openable,
  actions,
}: {
  record: TransferRecord;
  canRetry: boolean;
  openable: boolean;
  actions: TransferRowActions;
}): React.JSX.Element | null {
  const name = safeDisplayName(record.filename);
  const group = groupOf(record);

  if (group === TransferGroup.WAITING) {
    return (
      <Label variant="body" tone="tertiary">
        ›
      </Label>
    );
  }

  if (group === TransferGroup.ACTIVE) {
    // Stop is always live: the protocol cancels from either side at any point,
    // and with no session it is a local abandonment that still ends the row.
    return (
      <RowAction
        title={shareStrings.stop}
        tone="quiet"
        accessibilityLabel={shareStrings.stopLabel(name)}
        onPress={() => actions.onStop(record)}
      />
    );
  }

  if (openable) {
    return (
      <RowAction
        title={shareStrings.open}
        accessibilityLabel={shareStrings.openLabel(name)}
        onPress={() => actions.onOpen(record)}
      />
    );
  }

  // Try again appears only when it could really work. A chip that needs the
  // peer back in range, or a source file the OS has since cleared, would be a
  // button that looks live and does nothing.
  if (canRetry) {
    return (
      <RowAction
        title={shareStrings.tryAgain}
        accessibilityLabel={shareStrings.tryAgainLabel(name)}
        onPress={() => actions.onRetry(record)}
      />
    );
  }

  return null;
}

/**
 * Exported so the sheets can render the same summary the list shows.
 *
 * `filename` is expected to have been through `safeDisplayName` already - both
 * sheets show a name the other phone chose, and the one place that is decided
 * is where the string enters the UI, not here.
 */
export function FileSummary({
  filename,
  mimeType,
  sizeLine,
  previewUri,
}: {
  filename: string;
  mimeType: string;
  sizeLine: string;
  previewUri?: string | null;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
      <FileTile kind={kindOf(mimeType, filename)} previewUri={previewUri} size={56} />
      <View style={{ flex: 1 }}>
        <Label variant="headline" numberOfLines={2}>
          {filename}
        </Label>
        <Label variant="footnote" tone="secondary">
          {sizeLine}
        </Label>
      </View>
    </View>
  );
}
