import React, { useCallback, useEffect } from 'react';
import {
  NavigationContainer,
  DarkTheme,
  DefaultTheme,
  useNavigationContainerRef,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { areaColor, strings, type AreaName } from '@airlink/config';
import { useTheme } from '../ui/index.js';
import { selectPendingInvites, selectUnreadChats, useAppStore } from '../state/index.js';
import { useNotificationBadges } from '../client/notificationCentre.js';
import { local } from '../screens/you/localStrings.js';
import type { RootStackParams, TabParams } from './routes.js';
import { TabIcon, type TabIconName } from './TabIcons.js';

import { HomeScreen } from '../screens/home/HomeScreen.js';
import { ChatListScreen } from '../screens/chat/ChatListScreen.js';
import { ConversationScreen } from '../screens/chat/ConversationScreen.js';
import { PlayScreen } from '../screens/play/PlayScreen.js';
import { GamePickerScreen } from '../screens/play/GamePickerScreen.js';
import { GameRoomScreen } from '../screens/play/GameRoomScreen.js';
import { ShareScreen } from '../screens/share/ShareScreen.js';
import { ShareComposeScreen } from '../screens/share/ShareComposeScreen.js';
import { IncomingFileScreen } from '../screens/share/IncomingFileScreen.js';
import { WatchTogetherScreen } from '../screens/sync/WatchTogetherScreen.js';
import { YouScreen } from '../screens/you/YouScreen.js';
import { FriendsScreen } from '../screens/you/FriendsScreen.js';
import { MyCodeScreen } from '../screens/you/MyCodeScreen.js';
import { ScanCodeScreen } from '../screens/you/ScanCodeScreen.js';
import { SecurityScreen } from '../screens/you/SecurityScreen.js';
import { SettingsScreen } from '../screens/you/SettingsScreen.js';
import { DeveloperModeScreen } from '../screens/you/DeveloperModeScreen.js';
import { ConnectSheet } from '../screens/home/ConnectSheet.js';
import { PairingConfirmScreen } from '../screens/home/PairingConfirmScreen.js';
import { OnboardingScreen } from '../screens/onboarding/OnboardingScreen.js';
import { GameInviteHost } from '../screens/play/GameInviteHost.js';

const Stack = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<TabParams>();

/** Which drawn icon each tab uses. See TabIcons.tsx for why they are drawn. */
const TAB_ICON: Record<keyof TabParams, TabIconName> = {
  Home: 'home',
  Chat: 'chat',
  Play: 'play',
  Share: 'share',
  You: 'you',
};

/**
 * The tab names are the area names, and that is not a coincidence.
 *
 * `areaColor` is keyed by exactly these five words so that the tab bar, a
 * screen's header and any chip on that screen cannot drift apart: they all read
 * one table. The cast is safe by construction - `TabParams` and `AreaName` are
 * the same five strings - and the compiler checks it here rather than at each
 * call site.
 */
const AREA: Record<keyof TabParams, AreaName> = {
  Home: 'Home',
  Chat: 'Chat',
  Play: 'Play',
  Share: 'Share',
  You: 'You',
};

/**
 * The badge, as a number or nothing at all.
 *
 * `undefined` rather than 0: react-navigation draws a dot for an empty string
 * and a "0" for the number, and a tab bar that says nought unread is a tab bar
 * shouting about nothing.
 */
function badgeFor(route: keyof TabParams, unreadChats: number, pendingInvites: number): number | undefined {
  if (route === 'Chat') return unreadChats > 0 ? unreadChats : undefined;
  if (route === 'Play') return pendingInvites > 0 ? pendingInvites : undefined;
  return undefined;
}

/**
 * What a screen reader says about a tab that is wearing a badge.
 *
 * A red circle with a number in it is invisible to VoiceOver unless the tab
 * says so in words, and "Chat" on its own would hide the entire point of the
 * badge from the people who most need to be told.
 */
function tabLabel(route: keyof TabParams, title: string, unreadChats: number, pendingInvites: number): string {
  if (route === 'Chat' && unreadChats > 0) return `${title}, ${local.notify.badgeChats(unreadChats)}`;
  if (route === 'Play' && pendingInvites > 0) return `${title}, ${local.notify.badgeInvites(pendingInvites)}`;
  return title;
}

const TAB_TITLE: Record<keyof TabParams, string> = {
  Home: 'Home',
  Chat: strings.home.chat,
  Play: strings.play.title,
  Share: strings.share.title,
  You: strings.profile.title,
};

function TabNavigator(): React.JSX.Element {
  const theme = useTheme();
  const unreadChats = useAppStore(selectUnreadChats);
  const pendingInvites = useAppStore(selectPendingInvites);

  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        /*
          One hue per tab, rather than one blue app with five identical grey
          screens. The accent is NOT used here on purpose: it is the colour of
          a primary action, and a tab bar that borrowed it would make the
          selected tab look like a button to press.
        */
        tabBarActiveTintColor: areaColor(theme.colors, AREA[route.name]),
        tabBarInactiveTintColor: theme.colors.textTertiary,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.separator,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarIcon: ({ color }) => <TabIcon name={TAB_ICON[route.name]} color={color} />,
        tabBarBadge: badgeFor(route.name, unreadChats, pendingInvites),
        /*
          Styled rather than left to the platform default, which is a system
          red on a system grey and reads as a warning in the dark theme. It is
          `danger` because it is the one thing on this bar allowed to demand
          attention, with `onAccent` on top so the digit is legible on it in
          both schemes.
        */
        tabBarBadgeStyle: {
          backgroundColor: theme.colors.danger,
          color: theme.colors.onAccent,
          fontSize: 11,
          fontWeight: '700',
        },
        tabBarAccessibilityLabel: tabLabel(route.name, TAB_TITLE[route.name], unreadChats, pendingInvites),
      })}
    >
      <Tabs.Screen name="Home" component={HomeScreen} options={{ title: TAB_TITLE.Home }} />
      <Tabs.Screen name="Chat" component={ChatListScreen} options={{ title: TAB_TITLE.Chat }} />
      <Tabs.Screen name="Play" component={PlayScreen} options={{ title: TAB_TITLE.Play }} />
      <Tabs.Screen name="Share" component={ShareScreen} options={{ title: TAB_TITLE.Share }} />
      <Tabs.Screen name="You" component={YouScreen} options={{ title: TAB_TITLE.You }} />
    </Tabs.Navigator>
  );
}

export function AppNavigator({ needsOnboarding }: { needsOnboarding: boolean }): React.JSX.Element {
  const theme = useTheme();
  const navTheme = theme.scheme === 'dark' ? DarkTheme : DefaultTheme;
  const navigationRef = useNavigationContainerRef<RootStackParams>();
  // The centre, not the native module: it decides what is worth a notification.
  const notificationCentre = useNotificationBadges();

  /**
   * Tell the notification centre which conversation is on screen.
   *
   * The navigator is the only thing that actually knows, and it has to be
   * right the instant the screen appears: a message arriving while its own
   * conversation is open must put a badge on nothing and buzz nobody, because
   * the user is looking straight at it.
   */
  const onStateChange = useCallback(() => {
    if (!notificationCentre) return;
    const route = navigationRef.getCurrentRoute();
    const params = route?.params as { peerKey?: string } | undefined;
    const peerKey = route?.name === 'Conversation' ? params?.peerKey ?? null : null;
    notificationCentre.setActiveConversation(peerKey);
  }, [navigationRef, notificationCentre]);

  /**
   * A tapped notification opens what it was about.
   *
   * An invitation resolves to null and is deliberately left alone: the invite
   * host asks its question wherever the user is, and navigating would take
   * them away from it.
   */
  useEffect(() => {
    if (!notificationCentre) return undefined;
    return notificationCentre.onOpened((target) => {
      if (!target || !navigationRef.isReady()) return;
      navigationRef.navigate('Conversation', target);
    });
  }, [navigationRef, notificationCentre]);

  return (
    <NavigationContainer
      ref={navigationRef}
      onStateChange={onStateChange}
      theme={{
        ...navTheme,
        colors: {
          ...navTheme.colors,
          primary: theme.colors.accent,
          background: theme.colors.background,
          card: theme.colors.surface,
          text: theme.colors.text,
          border: theme.colors.separator,
        },
      }}
    >
      <Stack.Navigator
        initialRouteName={needsOnboarding ? 'Onboarding' : 'Tabs'}
        screenOptions={{
          headerShadowVisible: false,
          headerStyle: { backgroundColor: theme.colors.background },
          headerTintColor: theme.colors.text,
          headerTitleStyle: { fontSize: 17, fontWeight: '600' },
          contentStyle: { backgroundColor: theme.colors.background },
        }}
      >
        <Stack.Screen name="Onboarding" component={OnboardingScreen} options={{ headerShown: false }} />
        <Stack.Screen name="Tabs" component={TabNavigator} options={{ headerShown: false }} />

        {/* Sheets: things that interrupt, and should feel like it. */}
        <Stack.Group screenOptions={{ presentation: 'modal' }}>
          <Stack.Screen name="Connect" component={ConnectSheet} options={{ title: '' }} />
          <Stack.Screen name="PairingConfirm" component={PairingConfirmScreen} options={{ title: '' }} />
          <Stack.Screen name="IncomingFile" component={IncomingFileScreen} options={{ title: '' }} />
          <Stack.Screen name="ShareCompose" component={ShareComposeScreen} options={{ title: strings.share.title }} />
          <Stack.Screen name="GamePicker" component={GamePickerScreen} options={{ title: strings.play.chooseGame }} />
          <Stack.Screen name="MyCode" component={MyCodeScreen} options={{ title: strings.profile.showQr }} />
          <Stack.Screen name="ScanCode" component={ScanCodeScreen} options={{ title: strings.profile.scanQr }} />
        </Stack.Group>

        <Stack.Screen
          name="Conversation"
          component={ConversationScreen}
          options={({ route }) => ({ title: route.params.title })}
        />
        {/*
          The back gesture is OFF for a game.

          A left-edge drag is how you move a paddle, drag a puck and draw a
          line, and on iOS it was also how you left the game - which sent
          GAME_LEAVE and told the other player you had quit, in the middle of a
          rally. Leaving is a decision, so it needs a control that says so: the
          room has an explicit Exit that asks first.
        */}
        <Stack.Screen
          name="GameRoom"
          component={GameRoomScreen}
          options={{ headerShown: false, gestureEnabled: false }}
        />
        <Stack.Screen name="WatchTogether" component={WatchTogetherScreen} options={{ headerShown: false }} />
        <Stack.Screen name="Friends" component={FriendsScreen} options={{ title: strings.profile.friends }} />
        <Stack.Screen name="Security" component={SecurityScreen} options={{ title: strings.profile.security }} />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: strings.profile.title }} />
        <Stack.Screen name="DeveloperMode" component={DeveloperModeScreen} options={{ title: strings.profile.developerMode }} />
      </Stack.Navigator>
      {/*
        Inside the container so it can navigate, outside the navigator so it is
        not owned by any screen. An invitation reaches the user wherever they
        happen to be in the app.
      */}
      <GameInviteHost />
    </NavigationContainer>
  );
}
