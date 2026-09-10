import React from 'react';
import { ActivityIndicator, StatusBar, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { AppPhase, selectPhase, useAppStore } from './state/index.js';
import { ClientProvider } from './client/ClientProvider.js';
import { AppNavigator } from './navigation/AppNavigator.js';
import { EmptyState, Label, ThemeProvider, useTheme } from './ui/index.js';

/**
 * Root shell.
 *
 * Three states and nothing else: loading, a hard failure, and the app. There is
 * no "connecting to the server" state, because there is no server.
 */
export function AppRoot(): React.JSX.Element {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <ClientProvider>
            <Shell />
          </ClientProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function Shell(): React.JSX.Element {
  const theme = useTheme();
  const phase = useAppStore(selectPhase);
  const failure = useAppStore((s) => s.failure);

  if (phase === AppPhase.LOADING) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.background }}>
        <StatusBar barStyle={theme.scheme === 'dark' ? 'light-content' : 'dark-content'} />
        <ActivityIndicator color={theme.colors.accent} />
      </View>
    );
  }

  if (phase === AppPhase.FAILED) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: theme.colors.background }}>
        <EmptyState
          icon="warning"
          title="Something went wrong"
          body={failure ?? 'AirLink could not start.'}
        />
        <Label variant="footnote" tone="tertiary" align="center">
          Restarting the app usually fixes this.
        </Label>
      </View>
    );
  }

  return (
    <>
      <StatusBar barStyle={theme.scheme === 'dark' ? 'light-content' : 'dark-content'} />
      <AppNavigator needsOnboarding={phase === AppPhase.ONBOARDING} />
    </>
  );
}
