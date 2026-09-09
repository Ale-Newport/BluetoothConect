/**
 * The route map.
 *
 * One place that names every screen and its parameters, so a screen never
 * guesses what it was passed and adding a screen is a change here plus a file.
 */
export type RootStackParams = {
  Onboarding: undefined;
  Tabs: undefined;
  /** The connection sheet for one nearby device. */
  Connect: { peerKey: string };
  /** Comparing six digits on a first meeting. */
  PairingConfirm: { peerKey: string };
  Conversation: { peerKey: string; title: string };
  /** A game in progress. */
  GameRoom: { peerKey: string; gameId: string; gameSessionId: string; isHost: boolean };
  GamePicker: { peerKey: string };
  ShareCompose: { peerKey: string };
  IncomingFile: { peerKey: string; transferId: string };
  WatchTogether: { peerKey: string; syncSessionId: string };
  Friends: undefined;
  MyCode: undefined;
  ScanCode: undefined;
  Security: { peerId: string };
  DeveloperMode: undefined;
  Settings: undefined;
};

export type TabParams = {
  Home: undefined;
  Chat: undefined;
  Play: undefined;
  Share: undefined;
  You: undefined;
};
