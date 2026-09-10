import React from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type TextStyle } from 'react-native';
import { Icon, haptic, useTheme, type IconName, type StatusTone } from '../../ui/index.js';
import { Scrubber } from './Scrubber.js';
import { cinema, formatClock, formatSpeed } from './playerTheme.js';
import { syncStrings, shared } from './syncStrings.js';

/**
 * The chrome over the film.
 *
 * Everything here is drawn in the CINEMA palette rather than the app theme -
 * see playerTheme.ts for why the player is dark in both schemes - which is also
 * why this file cannot use `Label` or the other themed primitives and draws its
 * own text instead. The layout, the spacing, the radii and the type scale are
 * still the design system's; only the colour table is swapped.
 *
 * The controls auto-hide while the film is running and come back on a tap. They
 * are pinned open whenever nothing is playing, because a paused screen with no
 * visible way to start again is just a black rectangle.
 */

/** Apple's minimum, and the floor for every target on this screen. */
const TOUCH_MIN = 44;
/** The one control that is always aimed at in a hurry. */
const PLAY_SIZE = 72;
/** How far the skip controls jump. The step every player on earth uses. */
const SKIP_MS = 10_000;
/** The status dot. Small, because the words next to it do the work. */
const DOT_SIZE = 6;

export interface SubtitleOption {
  readonly index: number;
  readonly label: string;
}

export interface PlayerOverlayProps {
  /** The file's own name. Never a path, never an id. */
  readonly title: string;
  readonly statusTone: StatusTone;
  readonly statusText: string;
  /** One extra sentence when the short status needs explaining. */
  readonly statusDetail: string | undefined;
  readonly visible: boolean;
  /** What the shared line says. Not what this device's decoder is doing. */
  readonly playing: boolean;
  readonly positionMs: number;
  readonly durationMs: number;
  /**
   * False while the two phones cannot reach each other. Commanding playback
   * then would move this device off a line the peer is not receiving, which is
   * exactly the silent drift this screen exists to prevent.
   */
  readonly controlsEnabled: boolean;
  /** Why the controls are inert, in plain words. Undefined when they are live. */
  readonly disabledReason: string | undefined;
  /**
   * The shared line is parked on the last frame.
   *
   * Playing forward from there is the one command in this player that cannot
   * do anything: the core parks the line on the final frame when the film runs
   * out, and a play command would publish a line that starts where no decoder
   * can advance. So the transport offers a restart instead of a play that
   * would look live and move nothing.
   */
  readonly atEnd: boolean;
  readonly speed: number;
  readonly subtitles: readonly SubtitleOption[];
  /** Index into `subtitles`, or null for off. */
  readonly selectedSubtitle: number | null;
  readonly insetTop: number;
  readonly insetBottom: number;
  onToggleControls(): void;
  onTogglePlay(): void;
  /** Put the shared line back at the beginning. One command, host or guest. */
  onRestart(): void;
  onSkip(deltaMs: number): void;
  onScrubStart(): void;
  onScrubMove(positionMs: number): void;
  onScrubEnd(positionMs: number): void;
  onCycleSpeed(): void;
  onCycleSubtitles(): void;
  onLeave(): void;
}

export function PlayerOverlay(props: PlayerOverlayProps): React.JSX.Element {
  const theme = useTheme();
  const {
    title,
    statusTone,
    statusText,
    statusDetail,
    visible,
    playing,
    positionMs,
    durationMs,
    controlsEnabled,
    disabledReason,
    atEnd,
    speed,
    subtitles,
    selectedSubtitle,
    insetTop,
    insetBottom,
  } = props;

  const subtitleLabel =
    selectedSubtitle === null
      ? syncStrings.subtitlesOff
      : subtitles.find((track) => track.index === selectedSubtitle)?.label ?? syncStrings.subtitlesOff;

  return (
    <View style={StyleSheet.absoluteFill}>
      {/*
        The whole picture is one big target for showing and hiding the controls.
        It sits UNDER them, so a tap that lands on a button is a button press and
        anything else toggles - which is what every video player does and what
        nobody has to be taught.
      */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={visible ? syncStrings.hideControls : syncStrings.showControls}
        onPress={props.onToggleControls}
        style={StyleSheet.absoluteFill}
      />

      {visible ? (
        <View
          pointerEvents="box-none"
          style={[
            StyleSheet.absoluteFill,
            {
              backgroundColor: cinema.scrim,
              paddingTop: insetTop + theme.spacing.sm,
              paddingBottom: insetBottom + theme.spacing.md,
            },
          ]}
        >
          {/* -- who, what, and whether the two are together ------------- */}
          <View
            pointerEvents="box-none"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: theme.spacing.sm,
              paddingHorizontal: theme.spacing.md,
            }}
          >
            <GlyphButton
              icon="chevronLeft"
              label={shared.sync.leaveSession}
              enabled
              onPress={props.onLeave}
            />
            <View style={{ flex: 1 }}>
              <PlayerText variant="footnote" numberOfLines={1}>
                {title}
              </PlayerText>
              {statusDetail !== undefined ? (
                <PlayerText variant="caption" tone="tertiary" numberOfLines={1}>
                  {statusDetail}
                </PlayerText>
              ) : null}
            </View>
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.spacing.xs,
                paddingHorizontal: theme.spacing.sm,
                paddingVertical: theme.spacing.xs,
                borderRadius: theme.radius.pill,
                backgroundColor: cinema.surface,
              }}
              // One element, read as one sentence: a dot and a word announced
              // separately are two announcements for one fact.
              accessible
              accessibilityRole="text"
              accessibilityLabel={statusText}
            >
              <PlayerDot tone={statusTone} />
              <PlayerText variant="caption" tone="secondary">
                {statusText}
              </PlayerText>
            </View>
          </View>

          {/* -- transport ------------------------------------------------ */}
          <View
            pointerEvents="box-none"
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: theme.spacing.xxl }}
          >
            <GlyphButton
              icon="skipBack"
              label={syncStrings.back10}
              hint={disabledReason}
              enabled={controlsEnabled}
              onPress={() => props.onSkip(-SKIP_MS)}
            />
            <GlyphButton
              icon={atEnd ? 'replay' : playing ? 'pause' : 'start'}
              label={atEnd ? syncStrings.watchFromStart : playing ? syncStrings.pause : syncStrings.play}
              hint={disabledReason}
              enabled={controlsEnabled}
              size={PLAY_SIZE}
              filled
              onPress={atEnd ? props.onRestart : props.onTogglePlay}
            />
            <GlyphButton
              icon="skipForward"
              label={syncStrings.forward10}
              hint={disabledReason}
              enabled={controlsEnabled}
              onPress={() => props.onSkip(SKIP_MS)}
            />
          </View>

          {/* -- position and the two settings worth a tap ---------------- */}
          <View pointerEvents="box-none" style={{ paddingHorizontal: theme.spacing.lg }}>
            <Scrubber
              positionMs={positionMs}
              durationMs={durationMs}
              enabled={controlsEnabled && durationMs > 0}
              onScrubStart={props.onScrubStart}
              onScrubMove={props.onScrubMove}
              onScrubEnd={props.onScrubEnd}
            />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
              <PlayerText variant="caption" tone="secondary">
                {formatClock(positionMs)}
              </PlayerText>
              <View style={{ flex: 1 }} />
              <PlayerText variant="caption" tone="tertiary">
                {formatClock(durationMs)}
              </PlayerText>
              <GlyphButton
                text={formatSpeed(speed)}
                label={syncStrings.speed}
                value={formatSpeed(speed)}
                hint={disabledReason}
                enabled={controlsEnabled}
                onPress={props.onCycleSpeed}
              />
              <GlyphButton
                text="CC"
                label={syncStrings.subtitles}
                value={subtitleLabel}
                hint={subtitles.length === 0 ? syncStrings.noSubtitles : undefined}
                enabled={subtitles.length > 0}
                active={selectedSubtitle !== null}
                onPress={props.onCycleSubtitles}
              />
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

type PlayerTone = 'primary' | 'secondary' | 'tertiary' | 'accent';

/**
 * Text in the cinema palette.
 *
 * `Label` reads its colour from `useTheme()`, which would print near-black type
 * on the film in light mode. The type SCALE is still the design system's; only
 * the colour comes from elsewhere.
 */
function PlayerText({
  children,
  variant = 'body',
  tone = 'primary',
  numberOfLines,
  style,
}: {
  children: React.ReactNode;
  variant?: keyof typeof import('@airlink/config').typography;
  tone?: PlayerTone;
  numberOfLines?: number;
  style?: StyleProp<TextStyle>;
}): React.JSX.Element {
  const theme = useTheme();
  const color = {
    primary: cinema.text,
    secondary: cinema.textSecondary,
    tertiary: cinema.textTertiary,
    accent: cinema.accent,
  }[tone];
  return (
    <Text style={[theme.typography[variant] as TextStyle, { color }, style]} numberOfLines={numberOfLines}>
      {children}
    </Text>
  );
}

/**
 * The status dot, in the cinema palette.
 *
 * `StatusDot` reads its colour from `useTheme()`, and this surface is dark in
 * BOTH schemes - so in light mode the shared primitive would put the light
 * palette's darker green and amber on a near-black pill. Same reason as
 * `PlayerText`, same fix: the design system's shape, the player's colours.
 */
function PlayerDot({ tone }: { tone: StatusTone }): React.JSX.Element {
  const color = {
    connected: cinema.connected,
    connecting: cinema.connecting,
    disconnected: cinema.disconnected,
    warning: cinema.warning,
  }[tone];
  return (
    <View style={{ width: DOT_SIZE, height: DOT_SIZE, borderRadius: DOT_SIZE / 2, backgroundColor: color }} />
  );
}

/**
 * One control.
 *
 * Disabled is never silent: the button dims, announces itself as disabled, and
 * carries the reason as a hint - and the reason is on screen anyway, in the
 * status pill at the top. There is no state in which a control looks live and
 * does nothing.
 */
function GlyphButton({
  icon,
  text,
  textVariant = 'footnote',
  label,
  value,
  hint,
  enabled,
  active = false,
  filled = false,
  size = TOUCH_MIN,
  onPress,
}: {
  /** A drawn mark. Exactly one of `icon` or `text` is given. */
  icon?: IconName;
  /** For the controls whose content is a number, like the speed. */
  text?: string;
  textVariant?: keyof typeof import('@airlink/config').typography;
  label: string;
  value?: string;
  hint?: string | undefined;
  enabled: boolean;
  active?: boolean;
  filled?: boolean;
  size?: number;
  onPress(): void;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !enabled }}
      {...(value !== undefined ? { accessibilityValue: { text: value } } : {})}
      {...(!enabled && hint !== undefined ? { accessibilityHint: hint } : {})}
      disabled={!enabled}
      onPress={() => {
        haptic('impactLight');
        onPress();
      }}
      style={({ pressed }) => [
        {
          minWidth: size,
          height: size,
          paddingHorizontal: theme.spacing.sm,
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: theme.radius.pill,
          backgroundColor: filled ? cinema.surface : 'transparent',
          opacity: enabled ? 1 : 0.4,
        },
        pressed ? { opacity: 0.6 } : null,
      ]}
    >
      {icon !== undefined ? (
        <Icon name={icon} size={26} color={active ? theme.colors.accent : cinema.text} />
      ) : (
        <PlayerText variant={textVariant} tone={active ? 'accent' : 'primary'}>
          {text}
        </PlayerText>
      )}
    </Pressable>
  );
}
