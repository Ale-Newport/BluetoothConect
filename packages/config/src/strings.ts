/**
 * Every user-facing string.
 *
 * Centralised for two reasons: renaming the product is one edit, and adding a
 * language later is a new object rather than a hunt through JSX. The tone is
 * plain and calm - this is an app people open on a plane, not a dashboard.
 *
 * Note especially the offline strings. AirLink is FOR being offline, so a
 * missing internet connection is never an error; it is the normal state.
 */
import { brand } from './brand.js';

export const strings = {
  onboarding: {
    welcomeTitle: `Welcome to ${brand.name}`,
    welcomeBody: brand.promise,
    welcomePoints: ['No signal.', 'No Wi-Fi.', 'No problem.'],
    getStarted: 'Get started',
    nameTitle: 'Choose your name',
    nameSubtitle: 'This is how friends nearby will see you.',
    namePlaceholder: 'Your name',
    nameContinue: 'Continue',
    avatarTitle: 'Pick a colour',
    avatarSubtitle: 'Optional. You can change it any time.',
    avatarAutomatic: 'Chosen for me',
    avatarAutoShort: 'Auto',
    skip: 'Skip',
    done: 'Done',
  },

  permissions: {
    bluetoothTitle: 'Bluetooth',
    bluetoothBody: `${brand.name} uses Bluetooth to find friends nearby. Your location is not shared, and nothing is sent to the internet.`,
    localNetworkTitle: 'Local network',
    localNetworkBody: 'When you share a Wi-Fi network, photos and video move much faster. Only devices you connect to can see you.',
    nearbyDevicesTitle: 'Nearby devices',
    nearbyDevicesBody: `${brand.name} needs this to connect directly to a friend's phone over Wi-Fi.`,
    allow: 'Allow',
    notNow: 'Not now',
    openSettings: 'Open Settings',
    deniedTitle: 'Permission needed',
    deniedBody: 'You can turn this on any time in Settings.',
  },

  home: {
    nearbyFriends: 'NEARBY FRIENDS',
    otherDevices: 'OTHER DEVICES',
    searching: 'Searching nearby…',
    nobodyNearby: 'Nobody nearby yet',
    nobodyNearbyBody: `Open ${brand.name} on your friend's phone and they'll appear here.`,
    chat: 'Chat',
    play: 'Play',
    share: 'Share',
    sync: 'Sync',
    connect: 'Connect',
    connected: 'Connected',
    nearby: 'Nearby',
    trustedFriend: 'Trusted friend',
    newDevice: 'New device',
  },

  connection: {
    connecting: 'Connecting…',
    securing: 'Securing connection…',
    connected: 'Connected',
    reconnecting: 'Reconnecting…',
    failed: "Couldn't connect",
    tryAgain: 'Try again',
    /** Shown while pairing for the first time. */
    confirmTitle: 'Do these numbers match?',
    confirmBody: 'Check that your friend sees the same six digits. This makes sure nobody else is listening.',
    confirmYes: 'They match',
    confirmNo: "They don't match",
    pairingRequestTitle: (name: string): string => `${name} wants to connect`,
    keepAppOpen: `Keep ${brand.name} open to stay connected.`,
  },

  chat: {
    placeholder: 'Message…',
    connectedLocally: 'Connected locally',
    notConnected: 'Not connected',
    willSendWhenConnected: "Saved — this will send when you're back in range.",
    typing: 'typing…',
    today: 'Today',
    yesterday: 'Yesterday',
    delivered: 'Delivered',
    read: 'Read',
    failed: 'Not sent',
    retry: 'Retry',
    reply: 'Reply',
    react: 'React',
    copy: 'Copy',
    deleteForMe: 'Delete for me',
    emptyTitle: 'No messages yet',
    emptyBody: 'Say hello.',
  },

  play: {
    title: 'Play',
    chooseGame: 'Choose a game',
    choosePlayers: 'Choose players',
    creatingGame: 'Creating game…',
    waitingForOpponent: 'Waiting for your friend…',
    invitedYou: (name: string, game: string): string => `${name} invited you to play ${game}`,
    accept: 'Play',
    decline: 'Decline',
    yourTurn: 'Your turn',
    theirTurn: (name: string): string => `${name}'s turn`,
    youWon: 'You won',
    youLost: 'You lost',
    draw: 'Draw',
    rematch: 'Rematch',
    leaveGame: 'Leave game',
    resume: 'Resume',
    unavailableTitle: 'Not available yet',
    unavailableBody: (name: string): string => `${name} doesn't have this game.`,
  },

  share: {
    title: 'Share',
    sendTo: (name: string): string => `Send to ${name}`,
    choosePhoto: 'Photo or video',
    chooseFile: 'File',
    send: 'Send',
    cancel: 'Cancel',
    wantsToSend: (name: string): string => `${name} wants to send:`,
    accept: 'Accept',
    decline: 'Decline',
    sending: 'Sending',
    receiving: 'Receiving',
    paused: 'Paused',
    complete: 'Sent',
    failed: 'Transfer failed',
    saveToPhotos: 'Save to Photos',
    /** Shown when the only link is Bluetooth and the file is large. */
    slowLinkWarning: 'This will take a while over Bluetooth.',
    fasterOverWifi: 'Much faster if you share a Wi-Fi network.',
  },

  sync: {
    title: 'Sync',
    watchTogether: 'Watch together',
    chooseVideo: 'Choose a video',
    checkingFriend: 'Checking your friend…',
    friendHasFile: (name: string): string => `${name} has this file`,
    friendMissingFile: (name: string): string => `${name} doesn't have this file`,
    readyToSync: 'Ready to watch together',
    sendFile: 'Send the file',
    startSession: 'Start watching',
    waitingToStart: 'Waiting for your friend…',
    inSync: 'In sync',
    catchingUp: 'Catching up…',
    leaveSession: 'Leave',
  },

  trip: {
    title: 'Trips',
    newTrip: 'New trip',
    tripName: 'Trip name',
    emptyTitle: 'No trips yet',
    emptyBody: 'Group your chats, photos and games from one journey.',
    members: 'Travelling with',
    notes: 'Notes',
  },

  profile: {
    title: 'You',
    yourName: 'Your name',
    yourCode: 'Your code',
    showQr: 'Show my QR code',
    scanQr: 'Scan a friend',
    friends: 'Friends',
    removeFriend: 'Remove friend',
    blockDevice: 'Block device',
    unblock: 'Unblock',
    clearHistory: 'Clear chat history',
    privacy: 'Privacy',
    privacyBody: `${brand.name} works entirely on your device. There is no account, no server, and nothing is uploaded.`,
    security: 'Security',
    safetyNumber: 'Safety number',
    safetyNumberBody: 'Compare these numbers with your friend to be certain nobody is in the middle.',
    developerMode: 'Developer mode',
    about: 'About',
    version: 'Version',
  },

  status: {
    offline: 'Offline',
    offlineDetail: 'Local connections available',
    bluetoothOff: 'Bluetooth is off',
    bluetoothOffDetail: `Turn Bluetooth on so ${brand.name} can find friends nearby.`,
    /**
     * The same fact, when it is not the whole story.
     *
     * With Bluetooth off but a Wi-Fi network available, friends on that network
     * are still found - so telling someone AirLink cannot find anyone, while a
     * friend sits in the list below the banner, is simply untrue.
     */
    bluetoothOffWifiWorks: 'Bluetooth is off',
    bluetoothOffWifiWorksDetail: `${brand.name} can still find friends on this Wi-Fi. Bluetooth reaches further, and works with no network at all.`,
    wifiOffDetail: 'Turn Wi-Fi on for faster transfers.',
    permissionNeeded: 'Permission needed',
    excellent: 'Excellent',
    good: 'Good',
    weak: 'Weak',
    reconnecting: 'Reconnecting',
  },

  common: {
    cancel: 'Cancel',
    done: 'Done',
    save: 'Save',
    delete: 'Delete',
    remove: 'Remove',
    close: 'Close',
    back: 'Back',
    next: 'Next',
    retry: 'Retry',
    error: 'Something went wrong',
  },
} as const;

export type Strings = typeof strings;
