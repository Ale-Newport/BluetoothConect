import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { ConnectionState, Logger } from '@airlink/core';
import { AppPhase, useAppStore } from '../state/index.js';
import { AirLinkClient } from './AirLinkClient.js';
import { chatCenterFor } from '../screens/chat/chatCenter.js';
import pkg from '../../package.json';

/**
 * Owns the client for the app's lifetime and keeps the store in step with it.
 *
 * The client is created once and never re-created; React re-renders, radios do
 * not. Everything the interface reads flows one way: core events → store →
 * screens.
 */
const ClientContext = createContext<AirLinkClient | null>(null);

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
      appVersion: (pkg as { version?: string }).version ?? '0.1.0',
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

    const subscriptions = [
      instance.events.on('peersChanged', () => {
        const nearby = instance.nearby();
        store.getState().setPeers(
          nearby.map((peer) => {
            const handle = instance.peer(peer.key);
            return {
              key: peer.key,
              peerId: peer.peerId,
              displayName: peer.displayName || 'Unknown device',
              avatarColor: null,
              isFriend: peer.peerId !== null,
              nearby: true,
              connection: handle?.session.state ?? ConnectionState.DISCOVERED,
              quality: null,
              lastSeenAt: peer.lastSeenAt,
              highBandwidth: handle?.session.isHighBandwidth ?? false,
            };
          }),
        );
      }),

      instance.events.on('connectionChanged', ({ peerKey, state, quality }) => {
        store.getState().setConnection(peerKey, state, quality);
      }),

      instance.events.on('pairingRequired', ({ peerKey, displayName, code }) => {
        store.getState().addPendingPairing({ peerKey, displayName, code, startedAt: Date.now() });
      }),

      instance.events.on('pairingResolved', ({ peerKey }) => {
        store.getState().resolvePendingPairing(peerKey);
      }),

      instance.events.on('radioChanged', ({ transport, available, detail }) => {
        if (transport === 'ble') {
          store.getState().setRadios({ bluetoothOn: available, detail: detail || null });
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
      for (const off of subscriptions) off();
      void instance.stop();
    };
  }, [store]);

  const value = useMemo(() => client, [client]);
  return <ClientContext.Provider value={value}>{children}</ClientContext.Provider>;
}
