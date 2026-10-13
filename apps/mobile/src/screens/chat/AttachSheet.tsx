import React from 'react';
import { Modal, Pressable, View } from 'react-native';
import { strings } from '@airlink/config';
import { Divider, Icon, Label, haptic, useTheme, type IconName } from '../../ui/index.js';
import { chatCopy } from './chatStrings.js';

/**
 * What the plus button offers: a photo from the library, or a file.
 *
 * A sheet of our own for the same reason `MessageActions` is one - the plane is
 * half Android - and it does the one thing a sheet in front of a native picker
 * has to be careful about. It does NOT start the picker itself. Presenting the
 * system picker while this modal is still on its way out is how iOS ends up
 * with "already presenting" and a button that does nothing, so the choice is
 * handed up and the composer starts the picker once `onDismiss` says the modal
 * has actually gone.
 */

export type AttachChoice = 'library' | 'file';

const ROW_HEIGHT = 52;
const ICON_SIZE = 24;

export function AttachSheet({
  visible,
  onChoose,
  onClose,
  onDismiss,
}: {
  visible: boolean;
  onChoose: (choice: AttachChoice) => void;
  /** Backdrop or Cancel: nothing was chosen. */
  onClose: () => void;
  /** The modal has finished leaving (iOS). Whatever was chosen can now be started. */
  onDismiss: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Modal
      testID="attach-sheet"
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      onDismiss={onDismiss}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={strings.common.close}
        onPress={onClose}
        style={{ flex: 1, backgroundColor: theme.colors.scrim, justifyContent: 'flex-end' }}
      >
        {/* A press inside the sheet must not close it. */}
        <Pressable
          accessible={false}
          onPress={() => undefined}
          style={[
            {
              backgroundColor: theme.colors.surface,
              borderTopLeftRadius: theme.radius.xl,
              borderTopRightRadius: theme.radius.xl,
              paddingHorizontal: theme.spacing.lg,
              paddingTop: theme.spacing.md,
              paddingBottom: theme.spacing.xxl,
            },
            theme.shadows.sheet,
          ]}
        >
          <Row icon="image" title={chatCopy.attachPhotoRow} onPress={() => onChoose('library')} />
          <Divider />
          <Row icon="document" title={chatCopy.attachFileRow} onPress={() => onChoose('file')} />
          <View style={{ marginTop: theme.spacing.md }}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={strings.common.cancel}
              onPress={onClose}
              style={({ pressed }) => [
                { minHeight: ROW_HEIGHT, alignItems: 'center', justifyContent: 'center' },
                pressed ? { opacity: 0.6 } : null,
              ]}
            >
              <Label variant="body" tone="accent">
                {strings.common.cancel}
              </Label>
            </Pressable>
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function Row({ icon, title, onPress }: { icon: IconName; title: string; onPress: () => void }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={() => {
        haptic('selection');
        onPress();
      }}
      style={({ pressed }) => [
        {
          minHeight: ROW_HEIGHT,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.spacing.md,
        },
        pressed ? { opacity: 0.6 } : null,
      ]}
    >
      <Icon name={icon} size={ICON_SIZE} color={theme.colors.accent} />
      <Label variant="body">{title}</Label>
    </Pressable>
  );
}
