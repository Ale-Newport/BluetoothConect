import React from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar, StyleSheet, Text, View, useColorScheme } from 'react-native';
import { brand, colors, spacing, typography } from '@airlink/config';

/**
 * Root shell.
 *
 * Deliberately minimal for now: navigation, the store providers and the real
 * screens are added on top of this. What it already does is establish the
 * theme contract every screen reads from, so no screen ever hard-codes a
 * colour.
 */
export function AppRoot(): React.JSX.Element {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const palette = colors[scheme];

  return (
    <SafeAreaProvider>
      <StatusBar barStyle={scheme === 'dark' ? 'light-content' : 'dark-content'} />
      <View style={[styles.root, { backgroundColor: palette.background }]}>
        <Text style={[styles.wordmark, { color: palette.textSecondary }]}>{brand.wordmark}</Text>
        <Text style={[styles.tagline, { color: palette.text }]}>{brand.tagline}</Text>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl },
  wordmark: { ...typography.wordmark, marginBottom: spacing.md },
  tagline: { ...typography.title2, textAlign: 'center' },
});
