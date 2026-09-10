import { strings } from '@airlink/config';

/**
 * The handful of strings this feature needs that `@airlink/config` does not
 * carry yet.
 *
 * They live here, and not in `packages/config/src/strings.ts`, only because
 * another agent owns that package while this screen is being written. Every one
 * of them belongs under `strings.sync` and should be lifted there verbatim; the
 * shape below mirrors that object so the move is a copy and a delete.
 *
 * Everything already present in `@airlink/config` is used from there - see the
 * `shared` re-export at the bottom for the ones this feature leans on, so a
 * reader can see at a glance what is borrowed and what is new.
 */
export const syncStrings = {
  // -- choosing ------------------------------------------------------------
  nothingChosenTitle: 'Nothing chosen yet',
  nothingChosenBody:
    'Pick a film you both already have on your phones. The video never travels - only play, pause and position do.',
  chooseAnother: 'Choose another video',
  /** Stands in for a name we do not have yet. Never a device id. */
  aFriend: 'Your friend',

  // -- preparing the file --------------------------------------------------
  preparing: 'Reading the video…',
  preparingDetail: 'Taking a few samples so your friend can check they have the same file.',
  unreadableTitle: "Couldn't read this video",
  unreadableBody: 'That file could not be opened. Try another one.',

  // -- checking the friend -------------------------------------------------
  checkingDetail: 'Comparing the two files. Nothing is uploaded.',
  noAnswerTitle: 'No answer yet',
  noAnswerBody: (name: string): string => `Ask ${name} to open Watch together, then check again.`,
  checkAgain: 'Check again',
  differentFile: (name: string): string => `${name} has a different copy of this`,
  sameFileNeeded: 'It has to be the same file on both phones.',
  /** Under [Send the file]: the share screen asks for the file itself. */
  sendFileDetail: 'You choose the file on the next screen.',

  // -- being invited -------------------------------------------------------
  invitedTitle: (name: string): string => `${name} wants to watch together`,
  invitedBody: 'Choose your copy of this video to join.',
  invitedReady: (name: string): string => `You both have this. Join ${name} whenever you like.`,
  notNow: 'Not now',
  thisIsDifferent: 'This is a different file',

  // -- the session ---------------------------------------------------------
  waitingDetail: (name: string): string => `${name} will join once they pick the same file.`,
  endedTitle: 'Session over',
  endedBody: 'You can start another one whenever you like.',
  watchSomethingElse: 'Watch something else',

  // -- the player ----------------------------------------------------------
  play: 'Play',
  pause: 'Pause',
  back10: 'Back 10 seconds',
  forward10: 'Forward 10 seconds',
  position: 'Position',
  speed: 'Speed',
  subtitles: 'Subtitles',
  subtitlesOff: 'Off',
  /** A track the file names neither by title nor by language. */
  subtitleTrack: (n: number): string => `Track ${n}`,
  noSubtitles: 'This video has no subtitles.',
  showControls: 'Show the controls',
  hideControls: 'Hide the controls',
  /** Fallback for a file whose name the picker did not give us. */
  untitled: 'Video',

  // -- not connected -------------------------------------------------------
  needsConnection: 'Watching together needs a connection.',
  /** Why the picture stopped when the two phones lost sight of each other. */
  holdingForLink: 'Paused until you are both back in range.',
} as const;

/**
 * The strings borrowed from `@airlink/config`. Named here so the screens read
 * as one vocabulary rather than two.
 */
export const shared = {
  sync: strings.sync,
  common: strings.common,
  connection: strings.connection,
  chat: strings.chat,
  home: strings.home,
  share: strings.share,
} as const;
