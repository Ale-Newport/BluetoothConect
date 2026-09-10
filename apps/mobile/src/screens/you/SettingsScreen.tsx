import React, { useCallback, useMemo, useState } from 'react';
import { Alert, Pressable, View, type ViewStyle } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { Conversation } from '@airlink/db';
import { strings } from '@airlink/config';
import {
  Avatar,
  Button,
  Card,
  Gap,
  Label,
  Screen,
  SectionHeading,
  haptic,
  useTheme,
} from '../../ui/index.js';
import type { AirLinkClient } from '../../client/AirLinkClient.js';
import { useClient } from '../../client/ClientProvider.js';
import { selectDeveloperMode, selectProfile, useAppStore } from '../../state/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { AVATAR_EMOJI } from '../onboarding/avatars.js';
import { MAX_NAME_LENGTH, isUsableName, normaliseName } from '../onboarding/name.js';
import { local } from './localStrings.js';
import { Chevron, Group, NavRow, Sheet, TextField, asString, formatWhen } from './shared.js';

/**
 * Settings.
 *
 * Your name, your look, and the two ways to throw messages away. Short on
 * purpose: an app with no account and no server has very little left to
 * configure, and inventing switches to fill the page would be dishonest about
 * what this thing actually is.
 *
 * The name and the avatar are reused from onboarding rather than redefined -
 * the same emoji set and the same normalisation rules, so a name that was
 * acceptable on the first run is acceptable on the hundredth.
 */

/** A conversation with everything the row needs, resolved once. */
interface ClearableConversation {
  readonly id: string;
  readonly title: string;
  readonly subtitle: string;
  /** Null when nothing has ever been said in it, so there is nothing to clear. */
  readonly lastMessageAt: number | null;
}

export function SettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const client = useClient();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const profile = useAppStore(selectProfile);
  const developerMode = useAppStore(selectDeveloperMode);

  const storedName = profile?.displayName ?? client.profile?.displayName ?? '';
  const storedEmoji = profile?.avatarEmoji ?? client.profile?.avatarEmoji ?? null;
  const peerId = profile?.peerId ?? client.profile?.peerId ?? null;

  const [draftName, setDraftName] = useState(storedName);
  const [draftEmoji, setDraftEmoji] = useState<string | null>(storedEmoji);
  const [saved, setSaved] = useState(false);
  const [conversations, setConversations] = useState<readonly ClearableConversation[]>([]);
  const [picking, setPicking] = useState(false);

  const appVersion = useMemo(() => asString(client.diagnostics().appVersion) ?? '—', [client]);

  /**
   * Resolve conversations into rows.
   *
   * A direct conversation stores only a peer id, so the name comes from the
   * trust store first - that is the one a handshake proved - and from the peer
   * table only as a fallback for someone we have met but never paired with.
   */
  const refresh = useCallback(() => {
    const now = Date.now();
    try {
      const rows = client.db.conversations.list(true).map<ClearableConversation>((conversation) => ({
        id: conversation.id,
        title: nameFor(client, conversation),
        subtitle:
          conversation.lastMessageAt === null
            ? local.settings.neverUsed
            : local.settings.lastMessage(formatWhen(conversation.lastMessageAt, now)),
        lastMessageAt: conversation.lastMessageAt,
      }));
      setConversations(rows);
    } catch {
      // A database we cannot read is not something to interrupt this screen
      // for; the clear actions below simply have nothing to offer.
      setConversations([]);
    }
  }, [client]);

  useFocusEffect(refresh);

  const normalised = normaliseName(draftName);
  const nameChanged = normalised !== storedName;
  const emojiChanged = draftEmoji !== storedEmoji;
  const dirty = nameChanged || emojiChanged;
  const nameUsable = isUsableName(draftName);

  const saveProfile = useCallback(() => {
    if (!nameUsable || !dirty) return;
    try {
      client.db.users.updateProfile(normalised, draftEmoji, null, Date.now());
      // The store is what every other screen reads, and the advertising loop
      // re-reads the users table on its own each cycle - so this one write is
      // enough for a friend nearby to see the new name.
      useAppStore.getState().setProfile(client.profile);
      setDraftName(normalised);
      setSaved(true);
      haptic('success');
    } catch {
      Alert.alert(local.settings.nameSaveFailed, strings.common.error);
    }
  }, [client, dirty, draftEmoji, nameUsable, normalised]);

  const clearOne = useCallback(
    (conversation: ClearableConversation) => {
      Alert.alert(
        local.settings.clearConversationTitle(conversation.title),
        local.settings.clearConversationBody,
        [
          { text: strings.common.cancel, style: 'cancel' },
          {
            text: strings.common.delete,
            style: 'destructive',
            onPress: () => {
              try {
                client.db.messages.clearConversation(conversation.id);
                haptic('warning');
              } catch {
                Alert.alert(local.settings.clearFailed, strings.common.error);
              }
              refresh();
            },
          },
        ],
      );
    },
    [client, refresh],
  );

  const clearEverything = useCallback(() => {
    Alert.alert(local.settings.clearAllTitle, local.settings.clearAllBody, [
      { text: strings.common.cancel, style: 'cancel' },
      {
        text: local.settings.clearAll,
        style: 'destructive',
        onPress: () => {
          try {
            // Conversation by conversation rather than one DELETE: each call
            // also resets that conversation's unread count and last-message
            // stamp, which a bulk delete would leave stale.
            for (const conversation of client.db.conversations.list(true)) {
              client.db.messages.clearConversation(conversation.id);
            }
            haptic('warning');
          } catch {
            Alert.alert(local.settings.clearFailed, strings.common.error);
          }
          refresh();
        },
      },
    ]);
  }, [client, refresh]);

  const clearable = useMemo(
    () => conversations.filter((conversation) => conversation.lastMessageAt !== null),
    [conversations],
  );

  return (
    <Screen scroll>
      <Gap size="lg" />

      <SectionHeading>{local.settings.profileSection}</SectionHeading>
      <Card>
        <View style={{ alignItems: 'center' }}>
          <Avatar name={normalised || storedName} peerId={peerId} emoji={draftEmoji} size={72} />
        </View>
        <Gap size="lg" />
        <Label variant="footnote" tone="secondary">
          {local.settings.nameLabel}
        </Label>
        <Gap size="xs" />
        <TextField
          value={draftName}
          onChangeText={(next) => {
            setDraftName(next);
            setSaved(false);
          }}
          placeholder={strings.onboarding.namePlaceholder}
          label={strings.profile.yourName}
          maxLength={MAX_NAME_LENGTH}
          onSubmitEditing={saveProfile}
        />
        <Gap size="xs" />
        <Label variant="caption" tone="tertiary">
          {local.settings.nameHint}
        </Label>
      </Card>

      <Gap size="lg" />
      <SectionHeading>{local.settings.avatarSection}</SectionHeading>
      <Card>
        <AvatarPicker
          name={normalised || storedName}
          selected={draftEmoji}
          onSelect={(emoji) => {
            setDraftEmoji(emoji);
            setSaved(false);
          }}
        />
      </Card>

      <Gap size="lg" />
      {/*
        Once a save lands the button becomes its own confirmation. Saying
        "Saved" and "Nothing to save yet" at the same time would be two answers
        to one question, so the reason is dropped in that state.
      */}
      <Button
        title={saved && !dirty ? local.settings.nameSaved : strings.common.save}
        onPress={saveProfile}
        disabled={!dirty || !nameUsable}
        disabledReason={
          !nameUsable ? local.settings.nameEmpty : !dirty && !saved ? local.settings.nameUnchanged : undefined
        }
      />

      <Gap size="xl" />
      <SectionHeading>{local.settings.historySection}</SectionHeading>
      <Group>
        <NavRow
          title={local.settings.clearConversation}
          subtitle={clearable.length === 0 ? local.settings.noConversations : undefined}
          // No chevron and no press handler when there is nothing behind it: a
          // row that looks tappable and is not is worse than a plain one.
          right={clearable.length === 0 ? undefined : <Chevron />}
          onPress={clearable.length === 0 ? undefined : () => setPicking(true)}
        />
      </Group>
      <Gap size="md" />
      <Button
        title={local.settings.clearAll}
        variant="danger"
        onPress={clearEverything}
        disabled={clearable.length === 0}
        disabledReason={clearable.length === 0 ? local.settings.nothingToClear : undefined}
      />

      <Gap size="xl" />
      <SectionHeading>{local.settings.aboutSection}</SectionHeading>
      <Group>
        <NavRow title={strings.profile.friends} right={<Chevron />} onPress={() => navigation.navigate('Friends')} />
        {developerMode ? (
          <NavRow
            title={strings.profile.developerMode}
            right={<Chevron />}
            onPress={() => navigation.navigate('DeveloperMode')}
          />
        ) : null}
        <NavRow
          title={strings.profile.version}
          right={
            <Label variant="footnote" tone="tertiary">
              {appVersion}
            </Label>
          }
        />
      </Group>

      <Gap size="xxl" />

      <Sheet
        visible={picking}
        onClose={() => setPicking(false)}
        title={local.settings.clearConversationPick}
        subtitle={clearable.length === 0 ? local.settings.noConversationsBody : undefined}
      >
        {clearable.map((conversation) => (
          <NavRow
            key={conversation.id}
            title={conversation.title}
            subtitle={conversation.subtitle}
            destructive
            onPress={() => {
              setPicking(false);
              // A system alert raised while a modal is still dismissing is
              // dropped on iOS, which would turn this row into a dead control.
              setTimeout(() => clearOne(conversation), theme.motion.quick);
            }}
          />
        ))}
        <Gap size="sm" />
        <Button title={strings.common.cancel} variant="secondary" onPress={() => setPicking(false)} />
      </Sheet>
    </Screen>
  );
}

/**
 * The same emoji set as onboarding, so the two screens cannot drift.
 *
 * "Initials" is first because it is the default and the quietest option, and
 * because a coloured monogram is a perfectly good identity - the emoji is a
 * choice, not a requirement.
 */
function AvatarPicker({
  name,
  selected,
  onSelect,
}: {
  name: string;
  selected: string | null;
  onSelect: (emoji: string | null) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const tile = 52;

  const tileStyle = (isSelected: boolean): ViewStyle => ({
    width: tile,
    height: tile,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: isSelected ? theme.colors.accentMuted : theme.colors.surfaceElevated,
    borderWidth: isSelected ? 2 : 0,
    borderColor: theme.colors.accent,
  });

  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={local.settings.avatarNone}
        accessibilityState={{ selected: selected === null }}
        onPress={() => {
          haptic('selection');
          onSelect(null);
        }}
        style={({ pressed }) => [tileStyle(selected === null), pressed ? { opacity: 0.7 } : null]}
      >
        <Avatar name={name} emoji={null} size={tile - theme.spacing.sm} />
      </Pressable>

      {AVATAR_EMOJI.map((emoji) => {
        const isSelected = emoji === selected;
        return (
          <Pressable
            key={emoji}
            accessibilityRole="button"
            accessibilityLabel={emoji}
            accessibilityState={{ selected: isSelected }}
            onPress={() => {
              haptic('selection');
              onSelect(emoji);
            }}
            style={({ pressed }) => [tileStyle(isSelected), pressed ? { opacity: 0.7 } : null]}
          >
            <Label variant="title2">{emoji}</Label>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A conversation's name, from the strongest source that has one. */
function nameFor(client: AirLinkClient, conversation: Conversation): string {
  if (conversation.title) return conversation.title;
  const peerId = conversation.peerId;
  if (peerId) {
    const friend = client.trustStore.record(peerId);
    if (friend) return friend.displayName;
    const known = client.db.peers.get(peerId);
    if (known) return known.displayName;
  }
  return local.settings.unknownPerson;
}
