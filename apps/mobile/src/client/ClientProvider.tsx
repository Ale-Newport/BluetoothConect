import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { ConnectionState, Logger } from '@airlink/core';
import { strings } from '@airlink/config';
import { AppPhase, useAppStore } from '../state/index.js';
import { AirLinkClient } from './AirLinkClient.js';
import { chatCenterFor } from '../screens/chat/chatCenter.js';
import { inviteCentreFor } from '../screens/play/inviteCentre.js';
import { transferCenterFor } from '../screens/share/transferCenter.js';
import pkg from '../../package.json';

/**
 * Owns the client for the app's lifetime and keeps the store in step with it.
 *
 * The client is created once and never re-created; React re-renders, radios do
 * not. Everything the interface reads flows one way: core events → store →
 * screens.
 */
const ClientContext = createContext<AirLinkClient | null>(null);

/** One frame. Long enough to coalesce a burst of sightings, short enough to feel live. */
const PEER_PUBLISH_INTERVAL_MS = 250;

export function useClient(): AirLinkClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error('useClient must be used inside a ClientProvider');
  return client;
}

export function ClientProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const clientRef = useRef<AirLinkClient | null>(null);
  const [client, setClient] = useState<AirLinkClient | null>(null);
  const store = useAppStore;

  if (!clientRef.current) {
    clientRef.current = new AirLinkClient({
      // Kept in step with MARKETING_VERSION in the Xcode project: this string
      // is shown in the interface AND sent to the peer in the capability
      // exchange, so a stale one makes the app disagree with the store listing
      // and with the other phone about what it is.
      appVersion: (pkg as { version?: string }).version ?? '1.0.0',
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      deviceModel: Platform.OS,
      /**
       * A development build talks; a release build only remembers.
       *
       * The buffer was always being written and never read, so a debug build
       * was silent in the Metro console while the interesting thing happened -
       * which is a strange way to build a debug build. Release keeps `info`
       * and no console: the lines still go to the buffer, which is what
       * Developer Mode and the bug report read.
       *
       * `typeof jest` keeps the test output readable. It is a real condition,
       * not superstition: every screen test mounts this provider.
       */
      logger: new Logger('airlink', {
        minLevel: __DEV__ ? 'debug' : 'info',
        console: __DEV__ && typeof jest === 'undefined',
      }),
    });
  }

  useEffect(() => {
    const instance = clientRef.current as AirLinkClient;
    let cancelled = false;

    /**
     * Rebuilding the whole list is cheap; doing it on every radio heartbeat is
     * not.
     *
     * Several transports each re-announce every peer they can see every few
     * seconds, so this used to fire many times a second, hand React a set of
     * brand-new objects that defeated every `useShallow` in the app, and reset
     * each row's connection state and quality from scratch. One frame's worth of
     * coalescing turns a storm into one render, and the store keeps whatever the
     * last event actually said.
     */
    let publishTimer: ReturnType<typeof setTimeout> | undefined;

    const publishPeers = (): void => {
      const nearby = instance.nearby();
      const previous = store.getState().peers;
      store.getState().setPeers(
        nearby.map((peer) => {
          const handle = instance.peer(peer.key);
          const held = previous.find((p) => p.key === peer.key || (peer.peerId && p.peerId === peer.peerId));
          return {
            key: peer.key,
            peerId: peer.peerId,
            // A row with no name is a real device that published none - not a
            // half-arrived advertisement, because the registry holds those back
            // until they resolve. So it gets an honest label rather than the
            // word "Unknown", which read as "something is wrong".
            displayName: peer.displayName || strings.home.newDevice,
            avatarColor: held?.avatarColor ?? null,
            isFriend: peer.peerId !== null,
            nearby: true,
            // A live session is the truth about a peer's state. Where there is
            // none, the connection state last reported for this row is kept
            // rather than being reset to DISCOVERED - resetting it is what made
            // a connected friend sprout a Connect button every few seconds.
            connection: handle?.session.state ?? (peer.connected ? ConnectionState.CONNECTED : held?.connection ?? ConnectionState.DISCOVERED),
            quality: held?.quality ?? null,
            lastSeenAt: peer.lastSeenAt,
            highBandwidth: handle?.session.isHighBandwidth ?? false,
          };
        }),
      );
    };

    const schedulePublish = (): void => {
      if (publishTimer !== undefined) return;
      publishTimer = setTimeout(() => {
        publishTimer = undefined;
        if (!cancelled) publishPeers();
      }, PEER_PUBLISH_INTERVAL_MS);
    };

    const subscriptions = [
      instance.events.on('peersChanged', schedulePublish),

      instance.events.on('connectionChanged', ({ peerKey, state, quality }) => {
        store.getState().setConnection(peerKey, state, quality);
        // A state change re-keys rows and pins them, so the list itself needs
        // rebuilding - but on the next frame, alongside everything else.
        schedulePublish();
      }),

      instance.events.on('pairingRequired', ({ peerKey, displayName, code }) => {
        store.getState().addPendingPairing({ peerKey, displayName, code, startedAt: Date.now() });
      }),

      instance.events.on('pairingResolved', ({ peerKey }) => {
        store.getState().resolvePendingPairing(peerKey);
      }),

      instance.events.on('radioChanged', ({ transport, available, detail, reason }) => {
        if (transport === 'ble') {
          store
            .getState()
            .setRadios({ bluetoothOn: available, detail: detail || null, bluetoothReason: reason });
          return;
        }
        // `wifiOn` covers SEVERAL transports - the local network and Apple
        // peer-to-peer Wi-Fi - so it cannot simply take the value of whichever
        // one spoke last. Both report at startup, and the flag was landing on
        // whichever finished second. Ask the client, which knows all of them.
        void instance.wifiDiscoveryAvailable().then((on) => {
          if (!cancelled) store.getState().setRadios({ wifiOn: on });
        });
      }),

      instance.events.on('error', ({ message, fatal }) => {
        if (fatal) store.getState().setPhase(AppPhase.FAILED, message);
      }),
    ];

    void (async () => {
      try {
        const { hasIdentity, hasProfile } = await instance.load();
        if (cancelled) return;
        // A key with no profile is not a first run - the identity, and therefore
        // every friendship, is intact. Onboarding asks for a name again and
        // keeps the key.
        if (!hasIdentity || !hasProfile) {
          store.getState().setPhase(AppPhase.ONBOARDING);
        } else {
          store.getState().setProfile(instance.profile);
          // Before the radios, and before any screen is on top: the chat centre
          // is what listens to `ChatProtocol` and writes arriving messages to
          // SQLite. Built lazily by the Chat tab it would not exist until that
          // tab was first opened, and a message arriving before then would be
          // acknowledged to the sender and then dropped - the protocol keeps
          // ids, not bodies. It is cheap, and it has to be listening first.
          chatCenterFor(instance);
          // And for exactly the same reason: the invite centre is what listens
          // for GAME_INVITE and acknowledges it. Built lazily by the Play tab -
          // which is a LAZY tab - it did not exist until that tab had been
          // opened, so an invitation arriving first was delivered to nobody and
          // dropped, while the other phone waited forty-five seconds for an
          // answer that had nowhere to come from.
          inviteCentreFor(instance);
          // And the transfer centre, for the same reason again: a file offer
          // arriving before the Share tab has ever been opened had nowhere to
          // land either.
          transferCenterFor(instance);
          store.getState().setPhase(AppPhase.READY);
          // Radios come up only once there is an identity to advertise, so a
          // first launch never shows a permission prompt before the screen that
          // explains it.
          await instance.start();
        }
        setClient(instance);
      } catch (err) {
        if (!cancelled) {
          store.getState().setPhase(AppPhase.FAILED, err instanceof Error ? err.message : String(err));
          setClient(instance);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (publishTimer !== undefined) clearTimeout(publishTimer);
      for (const off of subscriptions) off();
      void instance.stop();
    };
  }, [store]);

  const value = useMemo(() => client, [client]);
  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}
