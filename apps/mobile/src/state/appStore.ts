import { create } from 'zustand';
import { ConnectionState } from '@airlink/core';
import { AppPhase, type LocalProfile, type PeerView, type PendingPairing, type RadioStatus } from './types.js';

/**
 * The app store.
 *
 * zustand rather than Context or Redux for one decisive reason: the store is a
 * plain closure, so the things that actually produce state here - Bluetooth
 * callbacks, database hooks, Reanimated worklets - can write to it directly from
 * outside the React tree. Selector subscriptions then keep a 60fps game screen
 * from re-rendering because an unrelated peer's signal strength moved.
 *
 * Everything here is a projection of what the core layer already knows. The
 * store holds no protocol state of its own; it is what the screens read.
 */
interface AppState {
  phase: AppPhase;
  failure: string | null;
  profile: LocalProfile | null;

  /** Everyone nearby or connected, already sorted for display. */
  peers: PeerView[];
  /** Pairings waiting on the user to compare a code. */
  pendingPairings: PendingPairing[];

  radios: RadioStatus;
  /** True when the device has no internet - which is normal, not an error. */
  offline: boolean;

  developerMode: boolean;

  // --- actions, all called from outside React ---
  setPhase(phase: AppPhase, failure?: string): void;
  setProfile(profile: LocalProfile | null): void;
  setPeers(peers: PeerView[]): void;
  upsertPeer(peer: PeerView): void;
  removePeer(key: string): void;
  setConnection(peerKey: string, connection: ConnectionState, quality?: string | null): void;
  addPendingPairing(pairing: PendingPairing): void;
  resolvePendingPairing(peerKey: string): void;
  setRadios(radios: Partial<RadioStatus>): void;
  setOffline(offline: boolean): void;
  setDeveloperMode(on: boolean): void;
  reset(): void;
}

const INITIAL_RADIOS: RadioStatus = {
  bluetoothOn: false,
  wifiOn: false,
  detail: null,
};

export const useAppStore = create<AppState>((set) => ({
  phase: AppPhase.LOADING,
  failure: null,
  profile: null,
  peers: [],
  pendingPairings: [],
  radios: INITIAL_RADIOS,
  offline: true,
  developerMode: false,

  setPhase: (phase, failure) => set({ phase, failure: failure ?? null }),
  setProfile: (profile) => set({ profile }),
  setPeers: (peers) => set({ peers }),

  upsertPeer: (peer) =>
    set((state) => {
      const index = state.peers.findIndex((p) => p.key === peer.key);
      if (index < 0) return { peers: [...state.peers, peer] };
      const next = [...state.peers];
      next[index] = peer;
      return { peers: next };
    }),

  removePeer: (key) => set((state) => ({ peers: state.peers.filter((p) => p.key !== key) })),

  setConnection: (peerKey, connection, quality) =>
    set((state) => ({
      peers: state.peers.map((p) =>
        p.key === peerKey ? { ...p, connection, quality: quality === undefined ? p.quality : quality } : p,
      ),
    })),

  addPendingPairing: (pairing) =>
    set((state) =>
      state.pendingPairings.some((p) => p.peerKey === pairing.peerKey)
        ? state
        : { pendingPairings: [...state.pendingPairings, pairing] },
    ),

  resolvePendingPairing: (peerKey) =>
    set((state) => ({ pendingPairings: state.pendingPairings.filter((p) => p.peerKey !== peerKey) })),

  setRadios: (radios) => set((state) => ({ radios: { ...state.radios, ...radios } })),
  setOffline: (offline) => set({ offline }),
  setDeveloperMode: (developerMode) => set({ developerMode }),

  reset: () =>
    set({
      phase: AppPhase.LOADING,
      failure: null,
      profile: null,
      peers: [],
      pendingPairings: [],
      radios: INITIAL_RADIOS,
      developerMode: false,
    }),
}));

// --- selectors -------------------------------------------------------------
// Exported as functions so a screen subscribes to one slice rather than the
// whole store; this is what keeps a game running at 60fps while peers churn.

export const selectPhase = (s: AppState): AppPhase => s.phase;
export const selectProfile = (s: AppState): LocalProfile | null => s.profile;
export const selectPeers = (s: AppState): PeerView[] => s.peers;
export const selectFriends = (s: AppState): PeerView[] => s.peers.filter((p) => p.isFriend);
export const selectNearbyStrangers = (s: AppState): PeerView[] => s.peers.filter((p) => !p.isFriend && p.nearby);
export const selectConnected = (s: AppState): PeerView[] =>
  s.peers.filter((p) => p.connection === ConnectionState.CONNECTED);
export const selectRadios = (s: AppState): RadioStatus => s.radios;
export const selectPendingPairings = (s: AppState): PendingPairing[] => s.pendingPairings;
export const selectDeveloperMode = (s: AppState): boolean => s.developerMode;

export const selectPeer =
  (key: string) =>
  (s: AppState): PeerView | undefined =>
    s.peers.find((p) => p.key === key);
