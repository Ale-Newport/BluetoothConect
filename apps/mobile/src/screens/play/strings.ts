/**
 * Strings the Play screens need that @airlink/config does not have yet.
 *
 * Everything the user reads in `strings.play` already lives in the shared
 * catalogue and is used from there. What is collected below is the vocabulary
 * of the individual games - "Check", "Ball in hand", "Wait for green" - plus a
 * handful of Play-tab labels. It is deliberately kept in ONE object with the
 * same shape as the shared catalogue so that moving it into
 * packages/config/src/strings.ts later is a copy and a find-and-replace, not a
 * hunt through twelve renderers.
 *
 * Another agent owns packages/config, so nothing here may be added there by
 * this screen. See the report.
 */

export const playText = {
  tabs: {
    inProgress: 'In progress',
    allGames: 'All games',
    /** Rough length of a game, shown on a tile. */
    minutes: (n: number): string => `${n} min`,
    withPerson: (name: string): string => `with ${name}`,
    nobodyTitle: 'Nobody to play with yet',
    nobodyBody: 'Connect to a friend on the Home tab and every game here lights up.',
    goHome: 'Go to Home',
    notConnected: 'Not connected yet',
    /** A game whose board this build cannot draw. Honest, and the tile is dead. */
    noRenderer: 'This game is not playable in this version.',
    chooseOpponent: 'Who are you playing?',
    onePersonOnly: 'These games are for two people.',
  },

  room: {
    noAnswerTitle: 'No answer',
    noAnswerBody: (name: string): string => `${name} may not have AirLink open. Try again?`,
    declinedTitle: (name: string): string => `${name} said not now`,
    declinedBody: 'You can always ask again later.',
    leftTitle: (name: string): string => `${name} left the game`,
    leaveConfirm: 'Leave',
    /** The board is kept while the link comes back - the session survives it. */
    reconnectingDetail: 'The board is safe. Play resumes as soon as you are back in range.',
    waitingDetail: 'Both phones need AirLink open.',
    gameOver: 'Game over',
    rematchAsked: (name: string): string => `${name} wants a rematch`,
    rematchSent: 'Rematch sent…',
    you: 'You',
    score: 'Score',
    /** Disabled-button reasons. */
    notYourTurn: 'Not your turn',
    waitingForLink: 'Waiting for the connection',
    gameFinished: 'This game has finished',
    setUpFirst: 'Set up your board first',
  },

  ticTacToe: {
    square: (row: number, col: number): string => `Row ${row}, column ${col}`,
    empty: 'empty',
  },

  connectFour: {
    column: (n: number): string => `Column ${n}`,
    columnFull: 'That column is full',
  },

  chess: {
    check: 'Check',
    checkmate: 'Checkmate',
    stalemate: 'Stalemate',
    drawFifty: 'Draw by the fifty-move rule',
    drawRepetition: 'Draw by repetition',
    drawMaterial: 'Draw - not enough pieces',
    white: 'White',
    black: 'Black',
    promotionTitle: 'Promote to',
    promotion: { q: 'Queen', r: 'Rook', b: 'Bishop', n: 'Knight' },
    captured: 'Captured',
    square: (name: string): string => `Square ${name}`,
  },

  reaction: {
    ready: "I'm ready",
    waitingOthers: 'Waiting for your friend to get ready…',
    holdOn: 'Wait…',
    tapNow: 'Tap',
    tooEarly: 'Too early',
    yourTime: (ms: number): string => `${ms} ms`,
    best: 'Best',
    average: 'Average',
    round: (n: number, of: number): string => `Round ${n} of ${of}`,
    falseStart: 'False start',
    noTime: '—',
    roundToNobody: 'Nobody took that one',
    tapTarget: 'Reaction target',
  },

  trivia: {
    question: (n: number, of: number): string => `Question ${n} of ${of}`,
    answered: 'Answered. Waiting for your friend…',
    correct: 'Correct',
    wrong: 'Wrong',
    timeUp: 'Time is up',
    nextQuestion: 'Next question',
    closeQuestion: 'Close the question',
    hostAdvances: 'Your friend is running the questions',
    secondsLeft: (s: number): string => `${s}s`,
  },

  darts: {
    remaining: 'Left',
    dartsLeft: (n: number): string => `${n} darts left`,
    bust: 'Bust',
    checkout: 'Checkout',
    aimHint: 'Drag on the board to aim, lift to throw.',
    powerHint: 'Release near the middle of the bar for a steady hand.',
    lastThrow: 'Last throw',
    miss: 'Miss',
    bull: 'Bull',
    outerBull: '25',
    doubleOut: 'Finish on a double',
    throwLabel: 'Throw',
  },

  wordDuel: {
    hint: 'Drag across touching letters to make a word.',
    tooShort: 'Too short',
    notAWord: 'Not a word',
    alreadyFound: 'Already found',
    submit: 'Submit',
    found: 'Found',
    finish: "I'm done",
    waitingOther: 'Waiting for your friend to finish…',
    points: (n: number): string => `${n} pts`,
    yourWords: 'Your words',
    shared: 'Both found it - it cancels',
  },

  drawAndGuess: {
    youDraw: (word: string): string => `Draw: ${word}`,
    theyDraw: (name: string): string => `${name} is drawing`,
    guessPlaceholder: 'Your guess…',
    guessSend: 'Guess',
    close: 'So close',
    gotIt: 'Got it',
    undo: 'Undo',
    clear: 'Clear',
    endRound: 'End round',
    solved: 'Solved',
    round: (n: number, of: number): string => `Round ${n} of ${of}`,
    guessesTitle: 'Guesses',
    noGuesses: 'No guesses yet',
    canvas: 'Drawing canvas',
  },

  battleship: {
    placeTitle: 'Place your fleet',
    placeBody: 'Tap a ship, then tap the sea to drop it. Tap it again to turn it.',
    rotate: 'Rotate',
    randomise: 'Shuffle',
    ready: 'Ready',
    yourWaters: 'Your waters',
    theirWaters: 'Their waters',
    hit: 'Hit',
    miss: 'Miss',
    sunk: (ship: string): string => `${ship} sunk`,
    waitingCommit: 'Waiting for your friend to place their fleet…',
    auditing: 'Checking both fleets…',
    cheated: 'Their fleet did not match what they reported.',
    fleetLeft: (n: number): string => `${n} ships left`,
    fireAt: (cell: string): string => `Fire at ${cell}`,
  },

  pong: {
    up: 'Up',
    down: 'Down',
    serve: 'Serve',
    yourServe: 'Your serve',
    theirServe: (name: string): string => `${name} serves`,
    hostRuns: 'Your friend is running the ball',
    table: 'Pong table',
  },

  airHockey: {
    faceOff: (s: number): string => `Face-off in ${s}`,
    dragHint: 'Drag your mallet.',
    table: 'Air hockey table',
  },

  pool: {
    aimHint: 'Drag to aim, then set the power.',
    power: 'Power',
    shoot: 'Shoot',
    solids: 'Solids',
    stripes: 'Stripes',
    open: 'Table open',
    rolling: 'Balls rolling…',
    ballInHand: 'Ball in hand - drag the cue ball',
    table: 'Pool table',
  },
} as const;
