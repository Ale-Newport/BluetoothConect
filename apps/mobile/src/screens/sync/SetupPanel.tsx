import React from 'react';
import { ActivityIndicator, View } from 'react-native';
import { Avatar, Button, Card, EmptyState, Gap, Label, Row, StatusBanner, useTheme } from '../../ui/index.js';
import { formatClock } from './playerTheme.js';
import { syncStrings, shared } from './syncStrings.js';

/**
 * Everything that happens before two people are watching the same frame.
 *
 * Purely presentational: it is handed a stage and a set of handlers, which is
 * what keeps the flow itself - picking, hashing, asking, creating - readable in
 * one place in WatchTogetherScreen.
 *
 * Two rules govern this panel. Every state has a way forward on screen, so a
 * person is never left with a sentence and no button. And no state is red: a
 * friend who does not hold the file has not failed at anything, and neither has
 * a link that has not come back yet.
 */

export type SetupStage =
  /** No file chosen. The true empty state. */
  | { readonly kind: 'empty' }
  /** Reading the duration and sampling the file. Ends in `ready` or `unreadable`. */
  | { readonly kind: 'preparing' }
  | { readonly kind: 'unreadable' }
  /** File ready, but the two phones cannot reach each other yet. */
  | { readonly kind: 'offline' }
  /** The question is out. The protocol gives up after 30 seconds on its own. */
  | { readonly kind: 'checking' }
  /** Same size, same samples, same duration. */
  | { readonly kind: 'ready' }
  | { readonly kind: 'peerMissing' }
  | { readonly kind: 'peerMismatch' }
  | { readonly kind: 'noAnswer' }
  | { readonly kind: 'invited'; readonly haveFile: boolean; readonly matches: boolean }
  | { readonly kind: 'ended' };

export interface SetupHandlers {
  onChoose(): void;
  onStart(): void;
  onCheckAgain(): void;
  onSendFile(): void;
  onJoin(): void;
  onDecline(): void;
  onWatchSomethingElse(): void;
  onDone(): void;
}

export interface SetupPanelProps {
  readonly stage: SetupStage;
  readonly peerName: string;
  readonly peerId: string | null;
  readonly peerAvatar: string | null;
  /** The file's own name. Empty until something is chosen. */
  readonly videoTitle: string;
  readonly durationMs: number;
  /** True while the system picker is up, so the button says so. */
  readonly picking: boolean;
  /** A command the peer should have received did not go out. Rare, and honest. */
  readonly actionFailed: boolean;
  readonly handlers: SetupHandlers;
}

export function SetupPanel({
  stage,
  peerName,
  peerId,
  peerAvatar,
  videoTitle,
  durationMs,
  picking,
  actionFailed,
  handlers,
}: SetupPanelProps): React.JSX.Element {
  const theme = useTheme();

  if (stage.kind === 'empty') {
    return (
      <EmptyState
        icon="▶"
        title={syncStrings.nothingChosenTitle}
        body={syncStrings.nothingChosenBody}
        action={
          <Button title={shared.sync.chooseVideo} onPress={handlers.onChoose} loading={picking} />
        }
      />
    );
  }

  return (
    <Card>
      {stage.kind === 'invited' ? (
        <InviteHeader peerName={peerName} peerId={peerId} peerAvatar={peerAvatar} />
      ) : (
        <ChosenFile title={videoTitle} durationMs={durationMs} />
      )}

      <Gap size="lg" />

      {stage.kind === 'preparing' ? (
        <>
          <Row gap="sm">
            <ActivityIndicator color={theme.colors.accent} />
            <View style={{ flex: 1 }}>
              <Label variant="headline">{syncStrings.preparing}</Label>
              <Label variant="footnote" tone="secondary">
                {syncStrings.preparingDetail}
              </Label>
            </View>
          </Row>
          <Gap size="lg" />
          <Button title={syncStrings.chooseAnother} variant="ghost" onPress={handlers.onChoose} loading={picking} />
        </>
      ) : null}

      {stage.kind === 'unreadable' ? (
        <>
          <Label variant="headline">{syncStrings.unreadableTitle}</Label>
          <Label variant="footnote" tone="secondary">
            {syncStrings.unreadableBody}
          </Label>
          <Gap size="lg" />
          <Button title={syncStrings.chooseAnother} onPress={handlers.onChoose} loading={picking} />
        </>
      ) : null}

      {stage.kind === 'offline' ? (
        <>
          <StatusBanner
            tone="connecting"
            title={shared.connection.reconnecting}
            detail={syncStrings.needsConnection}
          />
          <Gap size="lg" />
          <Button
            title={shared.sync.startSession}
            onPress={handlers.onStart}
            disabled
            disabledReason={syncStrings.needsConnection}
          />
          <Gap size="sm" />
          <Button title={syncStrings.chooseAnother} variant="ghost" onPress={handlers.onChoose} loading={picking} />
        </>
      ) : null}

      {stage.kind === 'checking' ? (
        <>
          <StatusBanner
            tone="connecting"
            title={shared.sync.checkingFriend}
            detail={syncStrings.checkingDetail}
          />
          <Gap size="lg" />
          <Button title={syncStrings.chooseAnother} variant="ghost" onPress={handlers.onChoose} loading={picking} />
        </>
      ) : null}

      {stage.kind === 'ready' ? (
        <>
          <StatusBanner tone="connected" title={shared.sync.friendHasFile(peerName)} detail={shared.sync.readyToSync} />
          <Gap size="lg" />
          <Button title={shared.sync.startSession} onPress={handlers.onStart} />
          <Gap size="sm" />
          <Button title={syncStrings.chooseAnother} variant="ghost" onPress={handlers.onChoose} loading={picking} />
        </>
      ) : null}

      {stage.kind === 'peerMissing' || stage.kind === 'peerMismatch' ? (
        <>
          <StatusBanner
            tone="warning"
            title={
              stage.kind === 'peerMissing'
                ? shared.sync.friendMissingFile(peerName)
                : syncStrings.differentFile(peerName)
            }
            detail={syncStrings.sameFileNeeded}
          />
          <Gap size="lg" />
          <Button title={shared.sync.sendFile} onPress={handlers.onSendFile} />
          <Label variant="footnote" tone="tertiary" align="center" style={{ marginTop: theme.spacing.xs }}>
            {syncStrings.sendFileDetail}
          </Label>
          <Gap size="sm" />
          <Button title={syncStrings.chooseAnother} variant="ghost" onPress={handlers.onChoose} loading={picking} />
        </>
      ) : null}

      {stage.kind === 'noAnswer' ? (
        <>
          <StatusBanner tone="connecting" title={syncStrings.noAnswerTitle} detail={syncStrings.noAnswerBody(peerName)} />
          <Gap size="lg" />
          <Button title={syncStrings.checkAgain} onPress={handlers.onCheckAgain} />
          <Gap size="sm" />
          <Button title={syncStrings.chooseAnother} variant="ghost" onPress={handlers.onChoose} loading={picking} />
        </>
      ) : null}

      {stage.kind === 'invited' ? (
        <>
          {stage.haveFile && !stage.matches ? (
            <StatusBanner tone="warning" title={syncStrings.thisIsDifferent} detail={syncStrings.sameFileNeeded} />
          ) : (
            <Label variant="footnote" tone="secondary">
              {stage.matches ? syncStrings.invitedReady(peerName) : syncStrings.invitedBody}
            </Label>
          )}
          <Gap size="lg" />
          {stage.matches ? (
            <Button title={shared.sync.watchTogether} onPress={handlers.onJoin} />
          ) : (
            <Button
              title={stage.haveFile ? syncStrings.chooseAnother : shared.sync.chooseVideo}
              onPress={handlers.onChoose}
              loading={picking}
            />
          )}
          <Gap size="sm" />
          <Button title={syncStrings.notNow} variant="ghost" onPress={handlers.onDecline} />
        </>
      ) : null}

      {stage.kind === 'ended' ? (
        <>
          <Label variant="headline">{syncStrings.endedTitle}</Label>
          <Label variant="footnote" tone="secondary">
            {syncStrings.endedBody}
          </Label>
          <Gap size="lg" />
          <Button title={syncStrings.watchSomethingElse} onPress={handlers.onWatchSomethingElse} />
          <Gap size="sm" />
          <Button title={shared.common.done} variant="ghost" onPress={handlers.onDone} />
        </>
      ) : null}

      {/*
        The session would not start. There is no red on this screen and this is
        not the exception: `create()` and `join()` refuse for exactly one
        reachable reason - the two of you stopped being in range between the tap
        and the send - and being out of range is the normal weather here, not a
        fault. So it says what happened, in words, with the button above it
        still there to try again. "Something went wrong" would be both alarming
        and less true.
      */}
      {actionFailed ? (
        <Label variant="footnote" tone="secondary" align="center" style={{ marginTop: theme.spacing.md }}>
          {syncStrings.couldNotStart}
        </Label>
      ) : null}
    </Card>
  );
}

/** The file this device is offering, said the way a person would say it. */
function ChosenFile({ title, durationMs }: { title: string; durationMs: number }): React.JSX.Element {
  return (
    <View>
      <Label variant="headline" numberOfLines={2}>
        {title || syncStrings.untitled}
      </Label>
      {durationMs > 0 ? (
        <Label variant="footnote" tone="tertiary">
          {formatClock(durationMs)}
        </Label>
      ) : null}
    </View>
  );
}

function InviteHeader({
  peerName,
  peerId,
  peerAvatar,
}: {
  peerName: string;
  peerId: string | null;
  peerAvatar: string | null;
}): React.JSX.Element {
  return (
    <Row gap="md">
      <Avatar name={peerName} peerId={peerId} emoji={peerAvatar} size={44} />
      <View style={{ flex: 1 }}>
        <Label variant="headline" numberOfLines={2}>
          {syncStrings.invitedTitle(peerName)}
        </Label>
      </View>
    </Row>
  );
}
