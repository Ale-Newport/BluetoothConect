import React, { createContext, useContext, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { colors, motion, radius, shadows, spacing, typography, type ColorScheme } from '@airlink/config';

/**
 * Theme access.
 *
 * Every component reads colours from here. Nothing in the app hard-codes a hex
 * value - if a colour is missing, it goes in `packages/config/src/theme.ts`, not
 * inline. That is what keeps light and dark honest, and what makes rebranding a
 * one-file change.
 */
export interface Theme {
  readonly colors: ColorScheme;
  readonly scheme: 'light' | 'dark';
  readonly spacing: typeof spacing;
  readonly radius: typeof radius;
  readonly typography: typeof typography;
  readonly shadows: typeof shadows;
  readonly motion: typeof motion;
}

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';
  const theme = useMemo<Theme>(
    () => ({ colors: colors[scheme], scheme, spacing, radius, typography, shadows, motion }),
    [scheme],
  );
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('useTheme must be used inside a ThemeProvider');
  return theme;
}
