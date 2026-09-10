/**
 * Strings this folder needs that `@airlink/config` does not carry yet.
 *
 * Every one of these belongs in `packages/config/src/strings.ts` alongside the
 * rest. They live here only because another agent owns that file right now, so
 * moving them is a copy-paste and a find-replace of `local.` for `strings.`.
 *
 * The voice is the same as the shared table: plain, calm, and never technical.
 * The one exception is `developer`, which is the single place in the product
 * where raw numbers and transport names are allowed to reach a screen.
 */
import { brand } from '@airlink/config';

export const local = {
  /**
   * Relative time as a bare phrase, so a sentence can put its own verb in front
   * of it. `friends.seen*` says the whole sentence because a friend row has no
   * room for one.
   */
  time: {
    justNow: 'just now',
    minutes: (n: number): string => (n === 1 ? '1 minute ago' : `${n} minutes ago`),
    hours: (n: number): string => (n === 1 ? '1 hour ago' : `${n} hours ago`),
    yesterday: 'yesterday',
  },

  you: {
    /** The navigator titles the Settings route "You"; the row needs its own word. */
    settings: 'Settings',
    yourCodeHint: 'Friends who scan your code can find you again anywhere.',
    developerModeOn: 'Developer mode is on.',
    aboutSection: 'ABOUT',
    peopleSection: 'PEOPLE',
    privacySection: 'PRIVACY & SECURITY',
    friendsCount: (n: number): string => (n === 1 ? '1 friend' : `${n} friends`),
    noFriendsYet: 'No friends yet',
  },

  friends: {
    /** How a friendship was proven. QR is stronger, and the UI says so. */
    verifiedByQr: 'Verified by QR code',
    verifiedByCode: 'Verified by six-digit code',
    verifiedRestored: 'Restored from a backup',
    qrIsStronger: 'Scanning a code is the stronger check.',
    codeIsGood: 'Comparing digits is a good check.',
    restoredIsWeak: 'Not verified in person yet.',
    emptyTitle: 'No friends yet',
    emptyBody: `Scan a friend's code, or connect to someone nearby and compare six digits.`,
    /**
     * The same invitation on a phone that cannot scan.
     *
     * Both halves of `emptyBody` have to be things this device can actually do,
     * or the only sentence on an empty screen is describing someone else's
     * phone. See `SCANNING_IS_SUPPORTED` in ScannerCamera.
     */
    emptyBodyNoScanner: `Show your code for a friend to scan, or connect to someone nearby and compare six digits.`,
    seenJustNow: 'Seen just now',
    seenMinutes: (n: number): string => (n === 1 ? 'Seen 1 minute ago' : `Seen ${n} minutes ago`),
    seenHours: (n: number): string => (n === 1 ? 'Seen 1 hour ago' : `Seen ${n} hours ago`),
    seenYesterday: 'Seen yesterday',
    seenOn: (date: string): string => `Seen ${date}`,
    seenNever: 'Not seen yet',
    manage: (name: string): string => `Options for ${name}`,
    removeTitle: (name: string): string => `Remove ${name}?`,
    removeBody: `You would have to pair from scratch to talk again - scan their code, or compare six digits with them in person. Your messages stay on this device.`,
    blockTitle: (name: string): string => `Block ${name}?`,
    blockBody: `They will not be able to connect to this device again, and they are removed from your friends. You can undo this in Friends.`,
    blocked: 'Blocked',
    showSafetyNumber: 'Show safety number',
    /**
     * A failed mutation, said specifically.
     *
     * `strings.common.error` on its own tells someone that something went
     * wrong without saying what, or whether the thing they asked for happened.
     * On a screen whose whole subject is who this device trusts, that is the
     * one thing they need to know.
     */
    removeFailedTitle: (name: string): string => `${name} could not be removed.`,
    blockFailedTitle: (name: string): string => `${name} could not be blocked.`,
    unblockFailedTitle: (name: string): string => `${name} could not be unblocked.`,
    actionFailedBody: 'Nothing was changed. Try again.',
  },

  myCode: {
    lead: 'Have your friend scan this.',
    why: 'Scanning is the safest way to add a friend: the key travels between the two screens, never over the air.',
    refreshes: 'This code refreshes on its own, so an old screenshot cannot be used.',
    unavailableTitle: 'Code not ready',
    unavailableBody: 'Your code could not be built. Reopening this screen usually fixes it.',
    tryAgain: 'Build it again',
    /** Read out by a screen reader in place of the bitmap itself. */
    accessibilityLabel: (name: string): string => `${name}'s pairing code, as a QR code for a friend to scan.`,
  },

  scan: {
    lead: `Point the camera at your friend's code.`,
    cameraTitle: 'Camera',
    cameraBody: `${brand.name} uses the camera only to read a friend's code. Nothing is recorded and nothing leaves this device.`,
    noCameraTitle: 'No camera',
    noCameraBody: 'This device has no camera to scan with. You can still connect to someone nearby and compare six digits.',
    /**
     * Not a failure and not a "coming soon": a plain statement of what this
     * phone can do today, with both working routes offered rather than a dead
     * end. See the note in ScannerCamera for why this case exists.
     */
    noScannerHereTitle: 'Scanning is not available on this phone yet',
    noScannerHereBody: `You can still be added the same way. Show your own code for your friend to scan, or connect to them nearby and compare six digits - both are just as secure.`,
    cameraFailedTitle: `Camera didn't start`,
    cameraFailedBody: 'Close this screen and open it again. If it keeps happening, connect to your friend nearby and compare six digits instead.',
    starting: 'Starting the camera…',
    scanning: 'Looking for a code…',
    addedTitle: (name: string): string => `${name} is now a friend`,
    addedBody: 'You will recognise each other automatically from now on.',
    alreadyFriends: (name: string): string => `${name} is already a friend`,
    upgraded: 'Their code is now verified by QR, which is the stronger check.',
    itsYou: 'That is your own code.',
    itsYouBody: 'Ask your friend to show theirs instead.',
    blockedTitle: 'You blocked this device',
    blockedBody: 'Unblock them in Friends first, then scan again.',
    scanAgain: 'Scan again',
    /** One honest sentence per way a code can fail. Never a silent no-op. */
    rejectNotAirlink: `That is not an ${brand.name} code.`,
    rejectNotAirlinkBody: 'It might be a link or a ticket. Ask your friend to open Show my QR code.',
    rejectUnreadable: `That code couldn't be read.`,
    rejectUnreadableBody: 'Try again with the code filling more of the screen.',
    rejectNewer: `That code needs a newer version of ${brand.name}.`,
    rejectNewerBody: 'Update both phones when you are next online.',
    rejectExpired: 'That code has expired.',
    rejectExpiredBody: 'Ask your friend to show their code again - codes only last a few minutes.',
    rejectClock: `That code's clock is ahead of yours.`,
    rejectClockBody: 'Check the date and time on both phones, then try again.',
    rejectForged: 'That code is not genuine.',
    rejectForgedBody: 'It did not pass its own signature check. Do not add this device.',
    saveFailed: 'That friend could not be saved.',
    saveFailedBody: 'Nothing was changed. Try scanning again.',
    viewFriend: 'See safety number',
  },

  privacy: {
    title: 'Privacy',
    lead: `${brand.name} runs entirely on this phone.`,
    doesTitle: 'WHAT IT DOES',
    does: [
      'Talks straight to the phone next to you, over Bluetooth or a shared Wi-Fi network.',
      'Encrypts every message end to end, so only the two phones can read it.',
      'Keeps your messages, files and games in a database on this device.',
      'Remembers a friend by a key the two of you exchanged in person.',
    ],
    doesNotTitle: 'WHAT IT DOES NOT DO',
    doesNot: [
      'No account, no sign-in, no password.',
      'No server. There is nothing to upload to and nothing to hack.',
      'No location, no contacts, no phone number, no email.',
      'No advertising identifier, and no analytics or crash reporting.',
      'No tracking of who you talk to, or when.',
    ],
    identityTitle: 'HOW YOU ARE IDENTIFIED',
    identityBody: `Your name and a key made on this phone, and nothing else. The key is not derived from your hardware, your number or anything else that could follow you around. Deleting ${brand.name} deletes it.`,
    controlTitle: 'WHAT YOU CONTROL',
    controlBody: 'Remove a friend, block a device, or clear your history at any time in Settings. There is no copy anywhere else.',
  },

  security: {
    overviewTitle: 'Security',
    overviewLead: 'Every conversation is encrypted end to end, on the device, with keys that never leave it.',
    overviewPickFriend: 'Pick a friend to compare safety numbers with.',
    compareHint: 'Read them out loud, or hold the two phones side by side.',
    pairedOn: (date: string): string => `Friends since ${date}`,
    unknownFriendTitle: 'Not a friend yet',
    unknownFriendBody: 'There is no safety number until you have paired with this person.',
    noFriendsTitle: 'Nobody to verify yet',
    noFriendsBody: 'Add a friend first, then you can compare safety numbers.',
  },

  settings: {
    profileSection: 'YOUR PROFILE',
    avatarSection: 'YOUR COLOUR',
    historySection: 'HISTORY',
    aboutSection: 'ABOUT',
    nameLabel: 'Your name',
    nameEmpty: 'Your name cannot be empty.',
    nameUnchanged: 'Nothing to save yet.',
    nameSaved: 'Saved',
    nameSaveFailed: 'That name could not be saved.',
    nameSaveFailedBody: 'Your old name is still in place. Try again.',
    nameHint: 'This is what friends nearby see. It is only ever sent to the phone next to you.',
    avatarNone: 'Automatic',
    clearConversation: 'Clear a conversation',
    clearConversationPick: 'Which conversation?',
    clearConversationTitle: (name: string): string => `Clear the chat with ${name}?`,
    clearConversationBody: 'Every message in it is deleted from this device. They keep their copy.',
    clearAll: 'Clear all history',
    clearAllTitle: 'Clear everything?',
    clearAllBody: 'Every message in every conversation is deleted from this device, and it cannot be undone. Your friends and your files are kept.',
    clearFailed: 'Nothing could be cleared.',
    clearFailedBody: 'Your messages are still on this device. Try again.',
    nothingToClear: 'There are no messages on this device yet.',
    noConversations: 'No conversations yet',
    noConversationsBody: 'Once you have chatted with someone, you can clear it here.',
    lastMessage: (when: string): string => `Last message ${when}`,
    neverUsed: 'No messages',
    unknownPerson: 'Someone',
  },

  developer: {
    /** The one screen where raw numbers belong. Nothing here is shown elsewhere. */
    intro: 'Raw numbers, for debugging with no laptop to hand.',
    copyAll: 'Copy everything',
    copied: 'Copied',
    copyFailed: 'Could not copy',
    refresh: 'Refresh',
    turnOff: 'Turn off developer mode',
    deviceSection: 'DEVICE',
    nativeSection: 'NATIVE LAYER',
    transportSection: 'TRANSPORTS',
    sessionSection: 'SESSIONS',
    logSection: 'ACTIVITY',
    artworkSection: 'ARTWORK',
    artworkHint:
      'Every drawn mark in the app. Icons used to be characters, and a character with no glyph in the loaded font draws as an empty box with nothing in any log - so they are all paths now, and this is where to see that they still look like what they are called.',
    rawSection: 'RAW SNAPSHOT',
    deviceId: 'Device id',
    peerId: 'Peer id',
    protocolVersion: 'Protocol version',
    appVersion: 'App version',
    platform: 'Platform',
    displayName: 'Display name',
    friendsStored: 'Friends stored',
    nearbyCount: 'Nearby now',
    advertisingToken: 'Advertising token',
    registered: 'Registered',
    available: 'Available',
    score: 'Score',
    throughput: 'Throughput',
    highBandwidth: 'High bandwidth',
    reason: 'Reason',
    noTransports: 'No transports registered',
    noSessions: 'No live sessions',
    state: 'State',
    transport: 'Transport',
    linkId: 'Link id',
    mtu: 'MTU',
    encryption: 'Encryption',
    sessionId: 'Session id',
    packetsSent: 'Packets sent',
    packetsReceived: 'Packets received',
    packetsDropped: 'Packets dropped',
    packetsRejected: 'Packets rejected',
    malformed: 'Malformed packets',
    rtt: 'RTT',
    rto: 'RTO',
    clockOffset: 'Clock offset',
    inFlight: 'In flight',
    queued: 'Queued',
    linkMetrics: 'Link metrics',
    bytesSent: 'Bytes sent',
    bytesReceived: 'Bytes received',
    throughputNow: 'Measured throughput',
    signal: 'Signal',

    // -- native layer --
    osVersion: 'OS version',
    deviceModel: 'Device model',
    canAdvertiseBle: 'Can advertise (BLE peripheral)',
    supportsL2cap: 'L2CAP channels',
    canCreateHotspot: 'Can create a hotspot',
    canJoinHotspot: 'Can join a hotspot',
    supportedTransports: 'Supported transports',
    /** Honest about the reason rather than spinning forever. */
    nativeUnavailable: 'The native layer has not reported its capabilities. It reports them once the radios have started.',

    // -- activity log --
    /**
     * The client's own event stream, not the native log buffer. `AirLinkClient`
     * keeps its `Logger` private and does not expose `NativeTransportHost.logs`,
     * so this is every line the interface can actually see. Said plainly rather
     * than dressed up as more than it is.
     */
    logHint: 'Client events, newest first, since this screen opened.',
    logEmpty: 'Nothing has happened yet.',
    logNativeNote: 'The native log buffer is not exposed to the interface in this build.',
    clearLog: 'Clear',
    entries: (n: number): string => (n === 1 ? '1 entry' : `${n} entries`),
    eventPeers: (count: number): string => `discovery · ${count} nearby`,
    eventConnection: (peerKey: string, state: string, quality: string | null): string =>
      `session ${peerKey} · ${state}${quality ? ` · ${quality}` : ''}`,
    eventPairingRequired: (peerKey: string, displayName: string): string =>
      `pairing ${peerKey} · ${displayName} · awaiting confirmation`,
    eventPairingResolved: (peerKey: string, trusted: boolean): string =>
      `pairing ${peerKey} · ${trusted ? 'trusted' : 'refused'}`,
    eventMessage: (peerKey: string, messageId: string): string => `message ${peerKey} · ${messageId}`,
    eventRadio: (transport: string, available: boolean, detail: string): string =>
      `radio ${transport} · ${available ? 'available' : 'unavailable'}${detail ? ` · ${detail}` : ''}`,
    eventError: (message: string, fatal: boolean): string => `${fatal ? 'fatal' : 'error'} · ${message}`,
  },
} as const;
