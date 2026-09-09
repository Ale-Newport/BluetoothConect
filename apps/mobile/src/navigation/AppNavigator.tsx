import React from 'react';
import { Text } from 'react-native';
import { NavigationContainer, DarkTheme, DefaultTheme } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { strings } from '@airlink/config';
import { useTheme } from '../ui/index.js';
import type { RootStackParams, TabParams } from './routes.js';

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

const Stack = createNativeStackNavigator<RootStackParams>();
const Tabs = createBottomTabNavigator<TabParams>();

/** Emoji tab icons until real artwork exists. Clearly placeholder, on purpose. */
const TAB_ICON: Record<keyof TabParams, string> = {
  Home: '◎',
  Chat: '✉',
  Play: '◆',
  Share: '↑',
  You: '●',
};

function TabNavigator(): React.JSX.Element {
  const theme = useTheme();
  return (
    <Tabs.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.textTertiary,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.separator,
        },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        tabBarIcon: ({ color }) => (
          <Text style={{ fontSize: 18, color, lineHeight: 22 }}>{TAB_ICON[route.name]}</Text>
        ),
      })}
    >
      <Tabs.Screen name="Home" component={HomeScreen} options={{ title: 'Home' }} />
      <Tabs.Screen name="Chat" component={ChatListScreen} options={{ title: strings.home.chat }} />
      <Tabs.Screen name="Play" component={PlayScreen} options={{ title: strings.play.title }} />
      <Tabs.Screen name="Share" component={ShareScreen} options={{ title: strings.share.title }} />
      <Tabs.Screen name="You" component={YouScreen} options={{ title: strings.profile.title }} />
    </Tabs.Navigator>
  );
}

export function AppNavigator({ needsOnboarding }: { needsOnboarding: boolean }): React.JSX.Element {
  const theme = useTheme();
  const navTheme = theme.scheme === 'dark' ? DarkTheme : DefaultTheme;

  return (
    <NavigationContainer
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
        <Stack.Screen name="GameRoom" component={GameRoomScreen} options={{ headerShown: false }} />
        <Stack.Screen name="WatchTogether" component={WatchTogetherScreen} options={{ headerShown: false }} />
        <Stack.Screen name="Friends" component={FriendsScreen} options={{ title: strings.profile.friends }} />
        <Stack.Screen name="Security" component={SecurityScreen} options={{ title: strings.profile.security }} />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: strings.profile.title }} />
        <Stack.Screen name="DeveloperMode" component={DeveloperModeScreen} options={{ title: strings.profile.developerMode }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
