import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Text, View, type TextStyle } from 'react-native';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { strings } from '@airlink/config';
import {
  ALL_ICON_NAMES,
  Button,
  Card,
  Divider,
  Gap,
  Icon,
  Label,
  Row,
  Screen,
  SectionHeading,
  haptic,
  useTheme,
} from '../../ui/index.js';
import { DRAWN_GAME_IDS, GameArt } from '../play/gameArt.js';
import { useClient } from '../../client/ClientProvider.js';
import { useAppStore } from '../../state/index.js';
import type { RootStackParams } from '../../navigation/routes.js';
import { local } from './localStrings.js';
import {
  DEVELOPER_MODE_SETTING_KEY,
  Group,
  KeyValue,
  asArray,
  asBoolean,
  asNumber,
  asRecord,
  asString,
  bytesToHex,
  copyText,
  describeValue,
  formatBytes,
  formatCount,
  formatFlag,
  formatMs,
  stringifyForBugReport,
} from './shared.js';

/**
 * Developer mode.
 *
 * The one screen in the product where a raw number is allowed to reach a human.
 * Everywhere else the user sees a person and a status; here they see the MTU,
 * the round-trip time and the session id, because the person reading this is
 * debugging a radio at 35,000 feet with no laptop and no console, and a
 * reassuring word is worth nothing to them.
 *
 * Two design consequences follow from "no laptop":
 *  - Everything is copyable, and one button puts the whole snapshot plus the
 *    event log on the pasteboard as text that survives being pasted into a
 *    notes app and read later.
 *  - Every field is read defensively. `diagnostics()` is `Record<string,
 *    unknown>` and its shape belongs to a package that is still moving; a field
 *    that gets renamed must show as "—" rather than crash the one screen you
 *    open when everything else is already broken.
 */

/** How often the snapshot re-reads itself while you are looking at it. */
const LIVE_REFRESH_MS = 3000;

/** Lines kept in the event log. Enough to cover a connection attempt end to end. */
const LOG_CAPACITY = 300;

interface LogLine {
  readonly id: number;
  readonly at: number;
  readonly text: string;
  readonly bad: boolean;
}

export function DeveloperModeScreen(): React.JSX.Element {
  const theme = useTheme();
  const client = useClient();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();

  const [snapshot, setSnapshot] = useState<Record<string, unknown>>(() => safeDiagnostics(client));
  const [token, setToken] = useState<string>(() => safeToken(client));
  const [log, setLog] = useState<readonly LogLine[]>([]);
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');

  const nextLogId = useRef(0);

  const refresh = useCallback(() => {
    setSnapshot(safeDiagnostics(client));
    setToken(safeToken(client));
    setCopied('idle');
  }, [client]);

  const append = useCallback((text: string, bad = false) => {
    setLog((current) => {
      const line: LogLine = { id: nextLogId.current++, at: Date.now(), text, bad };
      // Newest first: on a phone the top of the list is the only part you can
      // see without scrolling, and the last thing that happened is the thing
      // you are trying to understand.
      const next = [line, ...current];
      return next.length > LOG_CAPACITY ? next.slice(0, LOG_CAPACITY) : next;
    });
  }, []);

  /**
   * The client's own event stream.
   *
   * `AirLinkClient` keeps its `Logger` and the native host's log emitter
   * private, so this is every line the interface can legitimately see. It is
   * labelled as what it is rather than dressed up as the native log.
   */
  useEffect(() => {
    const offs = [
      client.events.on('peersChanged', ({ count }) => append(local.developer.eventPeers(count))),
      client.events.on('connectionChanged', ({ peerKey, state, quality }) =>
        append(local.developer.eventConnection(peerKey, state, quality)),
      ),
      client.events.on('pairingRequired', ({ peerKey, displayName }) =>
        append(local.developer.eventPairingRequired(peerKey, displayName)),
      ),
      client.events.on('pairingResolved', ({ peerKey, trusted }) =>
        append(local.developer.eventPairingResolved(peerKey, trusted)),
      ),
      client.events.on('message', ({ peerKey, messageId }) =>
        append(local.developer.eventMessage(peerKey, messageId)),
      ),
      client.events.on('radioChanged', ({ transport, available, detail }) =>
        append(local.developer.eventRadio(transport, available, detail), !available),
      ),
      client.events.on('error', ({ message, fatal }) => append(local.developer.eventError(message, fatal), true)),
      // The radios, in their own words. `warn` and `error` are marked bad so a
      // failing connection stands out from the ordinary chatter.
      client.events.on('nativeLog', ({ level, scope, message }) =>
        append(local.developer.eventNative(scope, message), level === 'warn' || level === 'error'),
      ),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [append, client]);

  // Live while you are watching, and only while you are watching. Diagnostics
  // that stop moving the moment you look away are useless for chasing a radio
  // that drops every thirty seconds.
  useFocusEffect(
    useCallback(() => {
      refresh();
      const timer = setInterval(() => {
        setSnapshot(safeDiagnostics(client));
        setToken(safeToken(client));
      }, LIVE_REFRESH_MS);
      return () => clearInterval(timer);
    }, [client, refresh]),
  );

  /**
   * The raw snapshot as text, computed once per snapshot.
   *
   * It is rendered in the card at the bottom AND it is the bulk of the
   * pasteboard payload, so without this memo a full JSON walk of the
   * diagnostics tree ran twice on every render - and a render happens on every
   * single client event. That is a busy radio making the screen you opened to
   * watch the radio stutter.
   */
  const rawSnapshot = useMemo(() => stringifyForBugReport(snapshot), [snapshot]);

  /**
   * Assembled on the tap, not on every render.
   *
   * Joining three hundred log lines into one string is cheap once and wasteful
   * three hundred times, and nothing needs the result until a finger lands on
   * the button.
   */
  const copyAll = useCallback(() => {
    // The client's own buffer goes in too, because it holds what happened
    // BEFORE this screen was opened - which is when the interesting thing
    // almost always happened.
    const history = client
      .recentLog()
      .map((entry, index) => ({
        id: -1 - index,
        at: entry.at,
        text: `${entry.scope} · ${entry.message}`,
        bad: entry.level === 'warn' || entry.level === 'error',
      }));
    const ok = copyText(buildBugReport(rawSnapshot, token, [...log, ...history.reverse()]));
    setCopied(ok ? 'ok' : 'failed');
    haptic(ok ? 'success' : 'error');
  }, [client, log, rawSnapshot, token]);

  const turnOff = useCallback(() => {
    useAppStore.getState().setDeveloperMode(false);
    try {
      client.db.settings.set(DEVELOPER_MODE_SETTING_KEY, 'false', Date.now());
    } catch {
      // Failing to remember the switch is harmless; it is off for this session.
    }
    navigation.goBack();
  }, [client, navigation]);

  const transports = asRecord(snapshot.transports);
  const native = asRecord(snapshot.nativeCapabilities);
  const sessions = asArray(snapshot.sessions);

  return (
    <Screen safeTop={false} scroll>
      <Gap size="lg" />
      <Label variant="footnote" tone="secondary">
        {local.developer.intro}
      </Label>

      <Gap size="md" />
      <Row gap="sm">
        <Button title={local.developer.refresh} variant="secondary" onPress={refresh} style={{ flex: 1 }} />
        <Button
          title={copied === 'ok' ? local.developer.copied : copied === 'failed' ? local.developer.copyFailed : local.developer.copyAll}
          onPress={copyAll}
          style={{ flex: 1 }}
        />
      </Row>

      {/* -- device ------------------------------------------------------- */}
      <Gap size="xl" />
      <SectionHeading>{local.developer.deviceSection}</SectionHeading>
      <Group>
        <KeyValue label={local.developer.peerId} value={describeValue(snapshot.peerId)} />
        <KeyValue label={local.developer.deviceId} value={describeValue(snapshot.deviceId)} />
        <KeyValue label={local.developer.protocolVersion} value={describeValue(snapshot.protocolVersion)} />
        <KeyValue label={local.developer.appVersion} value={describeValue(snapshot.appVersion)} />
        <KeyValue label={local.developer.platform} value={describeValue(snapshot.platform)} />
        <KeyValue label={local.developer.friendsStored} value={formatCount(asNumber(snapshot.friends))} />
        <KeyValue label={local.developer.nearbyCount} value={formatCount(asNumber(snapshot.nearby))} />
        <KeyValue label={local.developer.advertisingToken} value={token} />
      </Group>

      {/* -- native layer ------------------------------------------------- */}
      <Gap size="xl" />
      <SectionHeading>{local.developer.nativeSection}</SectionHeading>
      {native === null ? (
        <Card>
          <Label variant="footnote" tone="tertiary">
            {local.developer.nativeUnavailable}
          </Label>
        </Card>
      ) : (
        <Group>
          <KeyValue label={local.developer.platform} value={describeValue(native.platform)} />
          <KeyValue label={local.developer.osVersion} value={describeValue(native.osVersion)} />
          <KeyValue label={local.developer.deviceModel} value={describeValue(native.deviceModel)} />
          <KeyValue label={local.developer.canAdvertiseBle} value={formatFlag(asBoolean(native.canAdvertiseBle))} />
          <KeyValue label={local.developer.supportsL2cap} value={formatFlag(asBoolean(native.supportsL2cap))} />
          <KeyValue label={local.developer.canCreateHotspot} value={formatFlag(asBoolean(native.canCreateHotspot))} />
          <KeyValue label={local.developer.canJoinHotspot} value={formatFlag(asBoolean(native.canJoinHotspot))} />
          <KeyValue
            label={local.developer.supportedTransports}
            value={describeNativeTransports(asArray(native.transports))}
          />
        </Group>
      )}

      {/* -- transports --------------------------------------------------- */}
      <Gap size="xl" />
      <SectionHeading>{local.developer.transportSection}</SectionHeading>
      <TransportList transports={transports} />

      {/* -- sessions ----------------------------------------------------- */}
      <Gap size="xl" />
      <SectionHeading>{local.developer.sessionSection}</SectionHeading>
      {sessions.length === 0 ? (
        <Card>
          <Label variant="footnote" tone="tertiary">
            {local.developer.noSessions}
          </Label>
        </Card>
      ) : (
        sessions.map((session, index) => <SessionCard key={index} session={session} />)
      )}

      {/* -- activity ----------------------------------------------------- */}
      <Gap size="xl" />
      <SectionHeading>{local.developer.logSection}</SectionHeading>
      <Label variant="caption" tone="tertiary">
        {local.developer.logHint}
      </Label>
      <Gap size="sm" />
      <Card>
        {log.length === 0 ? (
          <Label variant="footnote" tone="tertiary">
            {local.developer.logEmpty}
          </Label>
        ) : (
          <View style={{ gap: theme.spacing.xs }}>
            {log.map((line) => (
              <LogRow key={line.id} at={line.at} text={line.text} bad={line.bad} />
            ))}
          </View>
        )}
      </Card>
      <Gap size="xs" />
      <Row gap="sm" align="center">
        <Label variant="caption" tone="tertiary" style={{ flex: 1 }}>
          {`${local.developer.entries(log.length)} · ${local.developer.logNativeNote}`}
        </Label>
        {/*
          Absent rather than disabled-without-a-reason. The card above already
          says "Nothing has happened yet", so a greyed-out Clear beside it would
          be a control that neither works nor explains itself.
        */}
        {log.length === 0 ? null : (
          <Button title={local.developer.clearLog} variant="ghost" onPress={() => setLog([])} />
        )}
      </Row>

      {/* -- artwork ------------------------------------------------------ */}
      <Gap size="xl" />
      <SectionHeading>{local.developer.artworkSection}</SectionHeading>
      <Label variant="caption" tone="tertiary">
        {local.developer.artworkHint}
      </Label>
      <Gap size="sm" />
      <IconSheet />

      {/* -- raw ---------------------------------------------------------- */}
      <Gap size="xl" />
      <SectionHeading>{local.developer.rawSection}</SectionHeading>
      <Card>
        <Text
          selectable
          style={[theme.typography.mono as TextStyle, { color: theme.colors.textSecondary }]}
        >
          {rawSnapshot}
        </Text>
      </Card>

      <Gap size="xl" />
      <Button title={local.developer.turnOff} variant="secondary" onPress={turnOff} />
      <Gap size="sm" />
      <Button title={strings.common.close} variant="ghost" onPress={() => navigation.goBack()} />
      <Gap size="xxl" />
    </Screen>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

/**
 * Every drawn mark in the app, on one screen.
 *
 * This is here because of a defect that took two attempts to see. The interface
 * originally used characters as icons, and a character with no glyph in the
 * font actually loaded draws as an empty box - silently, with nothing in any
 * log. The set is drawn now (ui/Icon.tsx), which removes that failure mode, but
 * a path can still be wrong in a way only an eye catches: cropped by its box,
 * unreadable at size, or plainly not a picture of the thing it names.
 *
 * A test asserts every name produces shapes. This asserts nothing; it just puts
 * all of them where they can be looked at, which is the only check that catches
 * "it draws, but it is not a hand".
 */
function IconSheet(): React.JSX.Element {
  const theme = useTheme();
  // Wide enough for the longest name at caption size, so the labels below
  // the marks do not run into each other.
  const cell = { alignItems: 'center' as const, width: 78, gap: 2 };

  return (
    <Card>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: theme.spacing.md, justifyContent: 'flex-start' }}>
        {ALL_ICON_NAMES.map((name) => (
          <View key={name} style={cell}>
            <Icon name={name} size={28} />
            <Label variant="caption" tone="tertiary" align="center" numberOfLines={1}>
              {name}
            </Label>
          </View>
        ))}
      </View>
      <Gap size="md" />
      <Divider />
      <Gap size="md" />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', rowGap: theme.spacing.md, justifyContent: 'flex-start' }}>
        {DRAWN_GAME_IDS.map((gameId) => (
          <View key={gameId} style={cell}>
            <GameArt gameId={gameId} size={28} />
            <Label variant="caption" tone="tertiary" align="center" numberOfLines={1}>
              {gameId}
            </Label>
          </View>
        ))}
      </View>
    </Card>
  );
}

/**
 * One line of the activity log.
 *
 * Memoised on purpose. Every client event prepends a line, which hands React a
 * brand-new array and would otherwise re-render all three hundred `Text` nodes
 * for the sake of one - during a connection storm, which is exactly when this
 * screen is being read. The props are three primitives, so the comparison is
 * free and every existing line bails out before rendering.
 */
const LogRow = React.memo(function LogRow({
  at,
  text,
  bad,
}: {
  at: number;
  text: string;
  bad: boolean;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Text
      selectable
      style={[
        theme.typography.mono as TextStyle,
        { color: bad ? theme.colors.danger : theme.colors.textSecondary },
      ]}
    >
      {`${clockOf(at)}  ${text}`}
    </Text>
  );
});

function TransportList({ transports }: { transports: Record<string, unknown> | null }): React.JSX.Element {
  const rows = asArray(transports?.transports);
  if (transports === null || rows.length === 0) {
    return (
      <Card>
        <Label variant="footnote" tone="tertiary">
          {local.developer.noTransports}
        </Label>
      </Card>
    );
  }

  const available = asArray(transports.available)
    .map((kind) => asString(kind) ?? '')
    .filter(Boolean);

  return (
    <>
      <Group>
        <KeyValue label={local.developer.registered} value={formatCount(asNumber(transports.registered))} />
        <KeyValue label={local.developer.available} value={available.length > 0 ? available.join(', ') : '—'} />
      </Group>
      {rows.map((row, index) => {
        const entry = asRecord(row);
        if (entry === null) return null;
        return (
          <React.Fragment key={index}>
            <Gap size="sm" />
            <Card>
              <Label variant="headline">{describeValue(entry.kind)}</Label>
              {/*
                The label does not change with the value. Flipping it to
                "Unavailable" for an unavailable transport produced the line
                "Unavailable  no", which states the opposite of the truth - and
                this is the one screen whose entire job is to be read literally.
              */}
              <KeyValue label={local.developer.available} value={formatFlag(asBoolean(entry.available))} />
              <KeyValue label={local.developer.score} value={formatCount(asNumber(entry.score))} />
              <KeyValue label={local.developer.highBandwidth} value={formatFlag(asBoolean(entry.highBandwidth))} />
              <KeyValue
                label={local.developer.throughput}
                value={perSecond(asNumber(entry.expectedThroughputBytesPerSecond))}
              />
              {entry.reason === null || entry.reason === undefined ? null : (
                <KeyValue label={local.developer.reason} value={describeValue(entry.reason)} />
              )}
            </Card>
          </React.Fragment>
        );
      })}
    </>
  );
}

function SessionCard({ session }: { session: unknown }): React.JSX.Element | null {
  const entry = asRecord(session);
  if (entry === null) return null;

  const metrics = asRecord(entry.linkMetrics);

  return (
    <>
      <Gap size="sm" />
      <Card>
        <Label variant="headline" numberOfLines={1}>
          {describeValue(entry.peerId ?? entry.peerHandle)}
        </Label>
        <KeyValue label={local.developer.state} value={describeValue(entry.state)} />
        <KeyValue label={local.developer.transport} value={describeValue(entry.transport)} />
        <KeyValue label={local.developer.linkId} value={describeValue(entry.linkId)} />
        <KeyValue label={local.developer.mtu} value={formatBytes(asNumber(entry.maxDatagramSize))} />
        <KeyValue label={local.developer.highBandwidth} value={formatFlag(asBoolean(entry.isHighBandwidth))} />
        <KeyValue label={local.developer.protocolVersion} value={describeValue(entry.protocolVersion)} />
        <KeyValue label={local.developer.encryption} value={describeValue(entry.encryption)} />
        <KeyValue label={local.developer.sessionId} value={hexOfByteArray(entry.sessionId)} />
        <KeyValue label={local.developer.packetsSent} value={formatCount(asNumber(entry.packetsSent))} />
        <KeyValue label={local.developer.packetsReceived} value={formatCount(asNumber(entry.packetsReceived))} />
        <KeyValue label={local.developer.packetsDropped} value={formatCount(asNumber(entry.packetsDropped))} />
        <KeyValue label={local.developer.packetsRejected} value={formatCount(asNumber(entry.packetsRejected))} />
        <KeyValue label={local.developer.malformed} value={formatCount(asNumber(entry.malformedPackets))} />
        <KeyValue label={local.developer.rtt} value={formatMs(asNumber(entry.rttMs))} />
        <KeyValue label={local.developer.rto} value={formatMs(asNumber(entry.rtoMs))} />
        <KeyValue label={local.developer.clockOffset} value={formatMs(asNumber(entry.clockOffsetMs))} />
        <KeyValue label={local.developer.inFlight} value={formatCount(asNumber(entry.reliableInFlight))} />
        <KeyValue label={local.developer.queued} value={formatCount(asNumber(entry.reliableQueued))} />

        {metrics === null ? null : (
          <>
            <Gap size="sm" />
            <Label variant="caption" tone="tertiary">
              {local.developer.linkMetrics.toUpperCase()}
            </Label>
            <KeyValue label={local.developer.signal} value={describeValue(metrics.rssi)} />
            <KeyValue label={local.developer.rtt} value={formatMs(asNumber(metrics.rttMs))} />
            <KeyValue
              label={local.developer.throughputNow}
              value={perSecond(asNumber(metrics.throughputBytesPerSecond))}
            />
            <KeyValue label={local.developer.bytesSent} value={formatBytes(asNumber(metrics.bytesSent))} />
            <KeyValue label={local.developer.bytesReceived} value={formatBytes(asNumber(metrics.bytesReceived))} />
          </>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reading the snapshot
// ---------------------------------------------------------------------------

/**
 * `diagnostics()` reaches into the transport manager, the native host and every
 * live session. Any of those can be half-built while the radios are still coming
 * up, so a throw here has to leave a usable screen behind.
 */
function safeDiagnostics(client: ReturnType<typeof useClient>): Record<string, unknown> {
  try {
    return client.diagnostics();
  } catch (err) {
    return { error: String(err) };
  }
}

function safeToken(client: ReturnType<typeof useClient>): string {
  try {
    const token = client.currentAdvertisementToken();
    return token === null ? '—' : bytesToHex(token);
  } catch {
    return '—';
  }
}

/** `PeerSession` hands the session id out as a plain number array. */
function hexOfByteArray(value: unknown): string {
  if (!Array.isArray(value)) return describeValue(value);
  const bytes = value.filter((n): n is number => typeof n === 'number');
  if (bytes.length === 0) return '—';
  return bytesToHex(Uint8Array.from(bytes));
}

function describeNativeTransports(entries: readonly unknown[]): string {
  const supported = entries
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null)
    .filter((entry) => asBoolean(entry.supported) !== false)
    .map((entry) => asString(entry.kind) ?? '')
    .filter(Boolean);
  return supported.length > 0 ? supported.join(', ') : '—';
}

function perSecond(value: number | null): string {
  return value === null ? '—' : `${formatBytes(value)}/s`;
}

/** 24-hour clock with seconds. A log line without a time is half a log line. */
function clockOf(at: number): string {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * The pasteboard payload.
 *
 * Plain text, not JSON-in-a-string: it has to survive being pasted into a notes
 * app on a plane and read by a human hours later.
 */
function buildBugReport(rawSnapshot: string, token: string, log: readonly LogLine[]): string {
  const lines = [
    `${local.developer.advertisingToken}: ${token}`,
    '',
    rawSnapshot,
    '',
    `--- ${local.developer.logSection} (${local.developer.entries(log.length)}) ---`,
    ...log.map((line) => `${clockOf(line.at)}  ${line.text}`),
  ];
  return lines.join('\n');
}
