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
    connectFirst: (name: string): string => `Connect to ${name} on the Home tab first.`,
    /** A game whose board this build cannot draw. Honest, and the tile is dead. */
    noRenderer: 'This game is not playable in this version.',
    /** Same game, different rules on the two phones. */
    differentVersion: (name: string): string => `${name} has a different version of this game.`,
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
    slowStartTitle: 'Still setting up',
    slowStartBody: 'This is taking longer than it should. Leaving and starting again usually fixes it.',
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
    tapColumn: 'Tap a column to drop a disc.',
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
    emptySquare: 'empty',
    tapPiece: 'Tap a piece to see its moves.',
    /** Indexed by piece type, 1-6, for screen readers. */
    piece: ['', 'pawn', 'knight', 'bishop', 'rook', 'queen', 'king'] as readonly string[],
  },

  reaction: {
    ready: "I'm ready",
    waitingOthers: 'Waiting for your friend to get ready…',
    holdOn: 'Wait…',
    tapNow: 'Tap',
    tooEarly: 'Too early',
    reported: 'Waiting for your friend…',
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
    doublePrefix: 'Double',
    treblePrefix: 'Treble',
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
    finished: 'Finished',
    waitingOther: 'Waiting for your friend to finish…',
    points: (n: number): string => `${n} pts`,
    yourWords: 'Your words',
    nothingYet: 'Nothing yet.',
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
    nothingToUndo: 'Nothing drawn yet',
    endRound: 'End round',
    solved: 'Solved',
    round: (n: number, of: number): string => `Round ${n} of ${of}`,
    guessesTitle: 'Guesses',
    noGuesses: 'No guesses yet',
    canvas: 'Drawing canvas',
    colour: (n: number): string => `Colour ${n}`,
    brush: (width: number): string => `${width}pt`,
  },

  battleship: {
    placeTitle: 'Place your fleet',
    placeBody: 'Pick a ship, tap the sea to move it, and turn it with Rotate.',
    rotate: 'Rotate',
    randomise: 'Shuffle',
    ready: 'Ready',
    yourWaters: 'Your waters',
    theirWaters: 'Their waters',
    /** Ship names, in the fleet's own fixed order. */
    ships: ['Carrier', 'Battleship', 'Cruiser', 'Submarine', 'Destroyer'] as readonly string[],
    hit: 'Hit',
    miss: 'Miss',
    sunk: (ship: string): string => `${ship} sunk`,
    fireHint: 'Tap their waters to fire.',
    waitingCommit: 'Waiting for your friend to place their fleet…',
    auditing: 'Checking both fleets…',
    reveal: 'Show my fleet',
    revealSent: 'Fleet sent. Waiting for your friend…',
    cheated: 'Their fleet did not match what they reported.',
    lostFleetTitle: 'This fleet is gone',
    lostFleetBody:
      'Your ships were only ever on this phone, and they are no longer here - so this game cannot go on. Start a new one.',
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
    aimHint: 'Drag from the cue ball to aim, lift to shoot.',
    power: 'Power',
    shoot: 'Shoot',
    solids: 'Solids',
    stripes: 'Stripes',
    open: 'Table open',
    rolling: 'Balls rolling…',
    yourShot: 'Your shot',
    onEight: 'Shoot for the black',
    ballInHand: 'Ball in hand - the cue ball has been re-spotted',
    table: 'Pool table',
  },
} as const;
