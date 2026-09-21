/**
 * The design system.
 *
 * The look we are after is the one Apple, Linear and Arc share: a quiet
 * surface, generous space, one confident accent, and type that does the work
 * rather than decoration. Games live inside this app, but the app is not a toy.
 *
 * Every colour is defined for both schemes. Nothing in the UI may hard-code a
 * hex value; if a colour is missing here, add it here.
 */
export interface ColorScheme {
  /** Page background. */
  background: string;
  /** Raised surfaces: cards, sheets, the tab bar. */
  surface: string;
  /** A surface on top of a surface, e.g. an input inside a card. */
  surfaceElevated: string;
  /** Hairline separators. */
  separator: string;
  /** Primary text. */
  text: string;
  /** Supporting text: timestamps, captions, secondary labels. */
  textSecondary: string;
  /** De-emphasised text: placeholders, disabled states. */
  textTertiary: string;
  /** The one accent. Used for the primary action and nothing else. */
  accent: string;
  accentMuted: string;
  /** Text and icons drawn on top of the accent. */
  onAccent: string;
  /** Connection quality and status. */
  connected: string;
  connecting: string;
  disconnected: string;
  warning: string;
  danger: string;
  /** Outgoing chat bubble. */
  bubbleOutgoing: string;
  bubbleOutgoingText: string;
  /** Incoming chat bubble. */
  bubbleIncoming: string;
  bubbleIncomingText: string;
  /** Scrim behind a modal sheet. */
  scrim: string;

  /**
   * ONE HUE PER PLACE.
   *
   * `accent` stays the single colour of a primary action, everywhere, because a
   * button that changes colour by screen stops reading as a button. These are
   * the other job colour does: telling you WHERE you are. The five tabs, the
   * game categories and the message kinds each get their own hue, so the app
   * is navigable by colour rather than being one blue app with five identical
   * grey screens.
   *
   * All of them sit at roughly the same lightness and chroma, so they read as
   * one family rather than a bag of colours. Each has a `-Muted` partner for
   * chips, tinted backgrounds and empty states.
   */
  areaHome: string;
  areaChat: string;
  areaPlay: string;
  areaShare: string;
  areaYou: string;
  areaHomeMuted: string;
  areaChatMuted: string;
  areaPlayMuted: string;
  areaShareMuted: string;
  areaYouMuted: string;

  /** Game categories, so the catalogue is scannable without reading it. */
  catQuick: string;
  catStrategy: string;
  catWords: string;
  catTrivia: string;
  catPuzzles: string;
  catParty: string;
  catTogether: string;
  catRealtime: string;
}

const light: ColorScheme = {
  background: '#FBFBFD',
  surface: '#FFFFFF',
  surfaceElevated: '#F2F2F7',
  separator: '#E4E4E9',
  text: '#08080C',
  textSecondary: '#61616B',
  textTertiary: '#9A9AA4',
  accent: '#0A6CFF',
  accentMuted: '#E6F0FF',
  onAccent: '#FFFFFF',
  connected: '#12A150',
  connecting: '#E5A100',
  disconnected: '#9A9AA4',
  warning: '#E5A100',
  danger: '#E5484D',
  bubbleOutgoing: '#0A6CFF',
  bubbleOutgoingText: '#FFFFFF',
  bubbleIncoming: '#EDEDF2',
  bubbleIncomingText: '#08080C',
  scrim: 'rgba(8, 8, 12, 0.32)',

  areaHome: '#0A6CFF',
  areaChat: '#6E4BE8',
  areaPlay: '#DC6803',
  areaShare: '#0E9C8E',
  areaYou: '#C4457B',
  areaHomeMuted: '#E6F0FF',
  areaChatMuted: '#EFEAFE',
  areaPlayMuted: '#FDF0E2',
  areaShareMuted: '#E2F5F3',
  areaYouMuted: '#FCEAF2',

  catQuick: '#DC6803',
  catStrategy: '#3E63DD',
  catWords: '#0E9C8E',
  catTrivia: '#8E4EC6',
  catPuzzles: '#C4457B',
  catParty: '#E5484D',
  catTogether: '#12A150',
  catRealtime: '#0891B2',
};

const dark: ColorScheme = {
  background: '#0A0A0D',
  surface: '#141418',
  surfaceElevated: '#1E1E24',
  separator: '#2A2A31',
  text: '#F5F5F7',
  textSecondary: '#A1A1AC',
  textTertiary: '#6C6C77',
  accent: '#3D8BFF',
  accentMuted: '#152540',
  onAccent: '#FFFFFF',
  connected: '#30D158',
  connecting: '#FFD426',
  disconnected: '#6C6C77',
  warning: '#FFD426',
  danger: '#FF6169',
  bubbleOutgoing: '#3D8BFF',
  bubbleOutgoingText: '#FFFFFF',
  bubbleIncoming: '#22222A',
  bubbleIncomingText: '#F5F5F7',
  scrim: 'rgba(0, 0, 0, 0.55)',

  // Lifted and slightly desaturated: the light-mode hues go muddy on a dark
  // ground, and a saturated hue on near-black vibrates.
  areaHome: '#4D9AFF',
  areaChat: '#A38BFF',
  areaPlay: '#F2A057',
  areaShare: '#3FC8B8',
  areaYou: '#F084B0',
  areaHomeMuted: '#152540',
  areaChatMuted: '#231D3D',
  areaPlayMuted: '#33220F',
  areaShareMuted: '#0F2E2B',
  areaYouMuted: '#331624',

  catQuick: '#F2A057',
  catStrategy: '#7B9BFF',
  catWords: '#3FC8B8',
  catTrivia: '#B98AE8',
  catPuzzles: '#F084B0',
  catParty: '#FF7A80',
  catTogether: '#4ED887',
  catRealtime: '#45B8D8',
};

export const colors = { light, dark } as const;

/** A 4pt base scale. Spacing values are never written inline. */
export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 48,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  xl: 22,
  pill: 999,
} as const;

/**
 * Type scale. Sizes follow iOS conventions closely enough to feel native, with
 * a slightly tighter tracking on the large sizes for a more considered feel.
 */
export const typography = {
  largeTitle: { fontSize: 34, lineHeight: 41, fontWeight: '700', letterSpacing: -0.6 },
  title: { fontSize: 28, lineHeight: 34, fontWeight: '700', letterSpacing: -0.4 },
  title2: { fontSize: 22, lineHeight: 28, fontWeight: '600', letterSpacing: -0.3 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.2 },
  body: { fontSize: 17, lineHeight: 23, fontWeight: '400', letterSpacing: -0.2 },
  callout: { fontSize: 16, lineHeight: 21, fontWeight: '400', letterSpacing: -0.2 },
  subheadline: { fontSize: 15, lineHeight: 20, fontWeight: '400', letterSpacing: -0.1 },
  footnote: { fontSize: 13, lineHeight: 18, fontWeight: '400', letterSpacing: 0 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500', letterSpacing: 0.1 },
  /** The wordmark. Wide tracking, small size - a mark rather than a heading. */
  wordmark: { fontSize: 13, lineHeight: 16, fontWeight: '700', letterSpacing: 2.4 },
  /** Monospace, for developer mode and pairing codes. */
  mono: { fontSize: 13, lineHeight: 18, fontWeight: '500', letterSpacing: 0.4 },
  /** The six-digit pairing code. Large, spaced, unmistakable. */
  pairingCode: { fontSize: 40, lineHeight: 48, fontWeight: '600', letterSpacing: 6 },
} as const;

/** Soft, low-contrast elevation. Heavy shadows read as cheap. */
export const shadows = {
  card: {
    shadowColor: '#000000',
    shadowOpacity: 0.06,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  sheet: {
    shadowColor: '#000000',
    shadowOpacity: 0.14,
    shadowRadius: 32,
    shadowOffset: { width: 0, height: -6 },
    elevation: 12,
  },
} as const;

/**
 * Motion. Short, and eased so movement decelerates into place rather than
 * stopping dead.
 */
export const motion = {
  instant: 120,
  quick: 200,
  standard: 280,
  slow: 420,
  /** Spring for anything the user's finger set in motion. */
  spring: { damping: 20, stiffness: 220, mass: 0.7 },
} as const;

/**
 * Which hue belongs to which tab.
 *
 * A lookup rather than a colour written into each screen: the tab bar, the
 * screen header and any chip on that screen have to agree, and they only agree
 * if they read the same entry.
 */
export type AreaName = 'Home' | 'Chat' | 'Play' | 'Share' | 'You';

export function areaColor(scheme: ColorScheme, area: AreaName): string {
  switch (area) {
    case 'Chat':
      return scheme.areaChat;
    case 'Play':
      return scheme.areaPlay;
    case 'Share':
      return scheme.areaShare;
    case 'You':
      return scheme.areaYou;
    default:
      return scheme.areaHome;
  }
}

export function areaColorMuted(scheme: ColorScheme, area: AreaName): string {
  switch (area) {
    case 'Chat':
      return scheme.areaChatMuted;
    case 'Play':
      return scheme.areaPlayMuted;
    case 'Share':
      return scheme.areaShareMuted;
    case 'You':
      return scheme.areaYouMuted;
    default:
      return scheme.areaHomeMuted;
  }
}

/**
 * Which hue belongs to which game category.
 *
 * Takes the category as a plain string so `@airlink/config` does not have to
 * depend on `@airlink/games` - the dependency runs the other way, and a colour
 * table is not worth inverting it for. An unknown category falls back to the
 * Play hue rather than throwing: a new game must never be able to crash the
 * catalogue.
 */
export function categoryColor(scheme: ColorScheme, category: string): string {
  switch (category) {
    case 'quick':
      return scheme.catQuick;
    case 'strategy':
      return scheme.catStrategy;
    case 'words':
      return scheme.catWords;
    case 'trivia':
      return scheme.catTrivia;
    case 'puzzles':
      return scheme.catPuzzles;
    case 'party':
      return scheme.catParty;
    case 'together':
      return scheme.catTogether;
    case 'realtime':
      return scheme.catRealtime;
    default:
      return scheme.areaPlay;
  }
}

/** Palette for generated avatars, so a friend without a photo still has identity. */
export const avatarPalette = [
  '#0A6CFF', '#12A150', '#E5A100', '#E5484D', '#8E4EC6',
  '#0BA5A5', '#F76808', '#D6409F', '#3E63DD', '#46A758',
] as const;

/** Deterministic avatar colour from a peer id, so it never changes. */
export function avatarColorFor(peerId: string): string {
  let hash = 0;
  for (let i = 0; i < peerId.length; i++) hash = (hash * 31 + peerId.charCodeAt(i)) >>> 0;
  return avatarPalette[hash % avatarPalette.length] as string;
}

/** Initials for an avatar. Handles emoji and multi-word names. */
export function initialsFor(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return '?';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  const first = [...(parts[0] ?? '')][0] ?? '?';
  if (parts.length === 1) return first.toUpperCase();
  const second = [...(parts[parts.length - 1] ?? '')][0] ?? '';
  return (first + second).toUpperCase();
}
