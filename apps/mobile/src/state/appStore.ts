import { create } from 'zustand';
import { ConnectionState } from '@airlink/core';
import {
  AppPhase,
  type LocalProfile,
  type PeerView,
  type PendingPairing,
  type RadioStatus,
  type WaitingCounts,
} from './types.js';

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

  /**
   * Conversations with something unread, for the badge on the Chat tab.
   *
   * Derived from the `unread_count` column the conversations table has kept all
   * along, never counted independently: two counters for one fact is how a tab
   * ends up wearing a badge for a message the user read ten minutes ago.
   */
  unreadChats: number;
  /** Game invitations waiting on an answer, for the badge on the Play tab. */
  pendingInvites: number;

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
  /**
   * Both counts at once, because they are recomputed together.
   *
   * One action rather than two setters: the notification centre works both
   * figures out in a single pass over the database, and writing them
   * separately would re-render the whole tab bar twice for one arriving
   * message.
   */
  setWaiting(counts: WaitingCounts): void;
  setDeveloperMode(on: boolean): void;
  reset(): void;
}

const INITIAL_RADIOS: RadioStatus = {
  bluetoothOn: false,
  wifiOn: false,
  detail: null,
  bluetoothReason: null,
};

export const useAppStore = create<AppState>((set) => ({
  phase: AppPhase.LOADING,
  failure: null,
  profile: null,
  peers: [],
  pendingPairings: [],
  radios: INITIAL_RADIOS,
  offline: true,
  unreadChats: 0,
  pendingInvites: 0,
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

  setWaiting: ({ unreadChats, pendingInvites }) =>
    set((state) =>
      // A no-op write would still notify every subscriber, and this one is
      // called on every chat publish - including the ones that only moved a
      // tick mark.
      state.unreadChats === unreadChats && state.pendingInvites === pendingInvites
        ? state
        : { unreadChats, pendingInvites },
    ),
  setDeveloperMode: (developerMode) => set({ developerMode }),

  reset: () =>
    set({
      phase: AppPhase.LOADING,
      failure: null,
      profile: null,
      peers: [],
      pendingPairings: [],
      radios: INITIAL_RADIOS,
      unreadChats: 0,
      pendingInvites: 0,
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
export const selectUnreadChats = (s: AppState): number => s.unreadChats;
export const selectPendingInvites = (s: AppState): number => s.pendingInvites;

export const selectPeer =
  (key: string) =>
  (s: AppState): PeerView | undefined =>
    s.peers.find((p) => p.key === key);
