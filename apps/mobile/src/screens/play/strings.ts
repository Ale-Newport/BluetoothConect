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

/**
 * Named once because two strings say it: the Gomoku board's label, and that
 * same label with the newest stone read out after it. Two literals would drift.
 */
const GOMOKU_BOARD = 'Gomoku board';

export const playText = {
  tabs: {
    inProgress: 'In progress',
    favouriteOn: (name: string): string => `Remove ${name} from favourites`,
    favouriteOff: (name: string): string => `Add ${name} to favourites`,
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
    exit: '← Exit',
    leaveConfirm: 'Leave',
    leaveTitle: 'Leave game?',
    leaveBody: (name: string): string =>
      name ? `${name} will be told the game is over.` : 'Your opponent will be notified.',
    /** The three things the inviting phone can honestly say, in order. */
    inviteSending: 'Sending invitation…',
    inviteDelivered: 'Invitation delivered',
    inviteWaiting: (name: string): string => (name ? `Waiting for ${name}…` : 'Waiting for your friend…'),
    inviteAccepted: (name: string): string => (name ? `${name} accepted` : 'They accepted'),
    startingGame: 'Starting game…',
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

  dotsAndBoxes: {
    /**
     * A line, named by the box it sits on.
     *
     * "The line between the dot at row 2, column 3 and the dot at row 2,
     * column 4" is accurate and unlistenable. Every line is a side of exactly
     * one box under this naming - the shared side between two boxes is only
     * ever the top of the lower one - so it is both shorter and unambiguous.
     */
    topOf: (row: number, col: number): string => `Top of the box at row ${row}, column ${col}`,
    bottomOf: (row: number, col: number): string => `Bottom of the box at row ${row}, column ${col}`,
    leftOf: (row: number, col: number): string => `Left of the box at row ${row}, column ${col}`,
    rightOf: (row: number, col: number): string => `Right of the box at row ${row}, column ${col}`,
    drawnLine: 'already drawn',
    openLine: 'not drawn yet',
    justPlayed: (name: string): string => `just drawn by ${name}`,
    boxWon: (row: number, col: number, name: string): string =>
      `Box at row ${row}, column ${col}, won by ${name}`,
    /** Said before the first line goes down, while it is still news. */
    rule: 'Close a box and you go again.',
    tapLine: 'Tap a line between two dots.',
    goAgainYou: 'You closed a box - go again.',
    goAgainThem: (name: string): string => `${name} closed a box and goes again.`,
    /** Under the name of whoever keeps the move. */
    anotherGo: 'Another go',
  },

  gomoku: {
    board: GOMOKU_BOARD,
    /**
     * The same board, with the newest stone appended.
     *
     * The full stop is the point of this being a function rather than a join in
     * the renderer: it is what makes VoiceOver pause between the name of the
     * board and the sentence about the last move instead of running the two
     * together, and pacing a sentence is a decision about words.
     */
    boardWithLast: (last: string): string => `${GOMOKU_BOARD}. ${last}`,
    /**
     * A point's name: column letter then row number, e.g. "H8". Columns run A to
     * O from the left, rows 1 to 15 downwards, which is the order the board is
     * drawn and the order the cells are stored in.
     *
     * The letter I is kept. A Go board drops it so that I and J cannot be
     * misread at a glance, but here fifteen columns have to line up with fifteen
     * letters: drop one and every letter past it names the wrong file.
     */
    point: (col: number, row: number): string => `${'ABCDEFGHIJKLMNO'.charAt(col)}${row + 1}`,
    spokenPoint: (col: number, row: number): string =>
      `Column ${'ABCDEFGHIJKLMNO'.charAt(col)}, row ${row + 1}`,
    emptyPoint: 'empty',
    /** What the aim sits on right now, read out as the board's value. */
    aimingAt: (point: string, occupant: string): string => `Aiming at ${point}, ${occupant}`,
    aimingNowhere: 'Nothing aimed yet',
    lastStone: (point: string, name: string): string => `${name} played ${point}`,
    aimHint: 'Tap the board to aim, then play.',
    pick: 'Pick a point',
    play: (point: string): string => `Play ${point}`,
    taken: 'There is already a stone there',
    /** After the reducer says no. It does not say which no, so neither do we. */
    refused: 'That stone was not accepted. Pick another point.',
    aimLeft: 'Aim left',
    aimRight: 'Aim right',
    aimUp: 'Aim up',
    aimDown: 'Aim down',
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

  quickMath: {
    problem: (n: number, of: number): string => `Problem ${n} of ${of}`,
    /**
     * The problem, spoken.
     *
     * The printed form uses '×', and a screen reader is free to say "x", "ex"
     * or nothing at all for it. An arithmetic game whose sum cannot be heard is
     * not much of a game, so the spoken form is written out in words rather than
     * left to the voice's own reading of a symbol.
     */
    spokenProblem: (left: number, operator: string, right: number): string => `${left} ${operator} ${right}`,
    plus: 'plus',
    minus: 'minus',
    times: 'times',
    /** The entry line before a single digit has been pressed. */
    noAnswerYet: '—',
    /**
     * The entry line, spoken.
     *
     * Composed here rather than in the renderer: the comma is the only thing
     * that stops a voice reading "Your answer 47" as one phrase, and a joiner
     * that carries meaning is a string, not punctuation someone typed into JSX.
     */
    answerLabel: (value: string): string => `Your answer, ${value}`,
    typeAnswer: 'Type your answer',
    submit: 'Submit',
    answered: 'Answered. Waiting for your friend…',
    /** The running tally under each name. Score alone cannot say this. */
    gotRight: (n: number): string => `${n} right`,
    /** Takes the count rather than saying "ten": the rules own that number. */
    finished: (n: number): string => `All ${n} problems done`,
    /** The reducer turned the answer down. Rare, and never left unexplained. */
    refused: 'That answer was not accepted. Try again.',
    digit: (d: string): string => `Digit ${d}`,
    signKey: '±',
    signLabel: 'Make it negative or positive',
    deleteKey: '⌫',
    deleteLabel: 'Delete the last digit',
    nothingToDelete: 'Nothing to delete',
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

  reversi: {
    square: (row: number, col: number): string => `Row ${row}, column ${col}`,
    empty: 'empty',
    /**
     * Who owns the stone on a square, for the screen reader.
     *
     * "Your stone" rather than your own display name: a person does not refer
     * to themselves in the third person, and the name is empty until a profile
     * exists - which would leave sixty-four squares reading out a coordinate
     * and then trailing off.
     */
    yourStone: 'your stone',
    stoneOf: (name: string): string => (name ? `${name}'s stone` : 'their stone'),
    /** Said of an empty square this device may take, for the screen reader. */
    playable: 'you can play here',
    lastMove: 'last move',
    tapDot: 'Tap a dot to place a stone.',
    /**
     * The skip rule, said out loud.
     *
     * A player with no capture is passed over by the reducer without sending
     * anything, so the same person simply plays twice. Unexplained, that is
     * indistinguishable from a board that has stopped listening to the other
     * phone, which is why these two lines exist.
     *
     * Both survive a missing name. The opponent's profile can still be on its
     * way when the first skip lands, and " had no move" is a worse sentence
     * than the pronoun.
     */
    theyHadNoMove: (name: string): string =>
      name ? `${name} had no move, so it is your turn again.` : 'They had no move, so it is your turn again.',
    youHadNoMove: (name: string): string =>
      name ? `You had no move, so ${name} plays again.` : 'You had no move, so they play again.',
  },

  wordChain: {
    /** Sits above the enormous letter. The letter itself carries the weight. */
    startsWith: 'Next word starts with',
    startsWithSpoken: (letter: string): string => `The next word must start with ${letter}`,
    /** The opening move: the chain is empty, so anything in the dictionary goes. */
    openingFree: 'Any word opens the chain',
    /** Stands in the letter's place before the first word. Never a question mark - nothing is unknown. */
    openLetter: '—',
    placeholder: 'Your word…',
    play: 'Play',
    /**
     * A pass is a concession, not a skipped turn, so the control says what
     * pressing it admits rather than what the rules call it.
     */
    pass: "I'm stuck",
    passWarning: 'Passing hands your friend the win.',
    typeAWord: 'Type a word to keep the chain going.',
    chainTitle: 'Played so far',
    chainEmpty: 'Nothing played yet.',
    wordBy: (word: string, name: string): string => `${word}, played by ${name}`,
    /** Why a word came back refused. The reducer decides; these only explain. */
    tooShort: (n: number): string => `Words must be at least ${n} letters.`,
    tooLong: (n: number): string => `Words may be at most ${n} letters.`,
    lettersOnly: 'Letters only - no spaces, digits or punctuation.',
    wrongLetter: (letter: string): string => `That word has to start with ${letter}.`,
    alreadyPlayed: 'That word is already in the chain.',
    notAWord: 'That word is not in the dictionary.',
    refused: 'That word was not accepted.',
  },

  rockPaperScissors: {
    round: (n: number, of: number): string => `Round ${n} of ${of}`,
    /** The three choices, in the order the rules number them. */
    rock: 'Rock',
    paper: 'Paper',
    scissors: 'Scissors',
    /**
     * The line that keeps a sealed choice from reading as a broken tap. Someone
     * who chooses and sees nothing happen assumes the game has hung.
     */
    sealed: 'Neither choice opens until both are in.',
    choose: 'Make your choice.',
    /*
     * Both waiting lines name the other player, and a name is not guaranteed:
     * `nameFor` answers with an empty string for a peer that connected without
     * a display name. "Waiting for  to choose…" is the whole status line of
     * this board, so it says "your opponent" rather than nothing at all.
     */
    waitingChoice: (name: string): string =>
      name ? `Waiting for ${name} to choose…` : 'Waiting for your opponent to choose…',
    opening: 'Opening both choices…',
    waitingShow: (name: string): string =>
      name ? `Waiting for ${name} to show…` : 'Waiting for your opponent to show…',
    /** Captions under the two names while a round is in play. */
    locked: 'Locked in',
    choosing: 'Choosing…',
    shown: 'Shown',
    youWon: 'You won that round',
    theyWon: (name: string): string => (name ? `${name} won that round` : 'They won that round'),
    drawnRound: 'That round was a draw',
    beats: (winner: string, loser: string): string => `${winner} beats ${loser}`,
    tied: (choice: string): string => `${choice} against ${choice}`,
    /** The result strip, read one round at a time. */
    roundPlayed: (n: number, mine: string, theirs: string): string =>
      `Round ${n}, you played ${mine}, they played ${theirs}`,
    roundUnplayed: (n: number): string => `Round ${n}, not played yet`,
    lostTitle: 'This round cannot be finished',
    lostBody:
      'Your sealed choice was only ever on this phone, and it is no longer here - so there is nothing left to open. Start a new game.',
  },

  memoryDuel: {
    card: (row: number, col: number): string => `Row ${row}, column ${col}`,
    faceDown: 'face down',
    faceUp: 'face up',
    /** Said of a card in the settled mismatch, so nobody reads it as taken. */
    goesBackDown: 'face up, turns back over on the next flip',
    takenByYou: 'matched by you',
    takenBy: (name: string): string => `matched by ${name}`,
    progress: (found: number, total: number): string => `${found} of ${total} pairs found`,
    tapCard: 'Tap a card to turn it over.',
    findItsPair: 'Now find its pair.',
    /**
     * The two cards nobody matched stay up on purpose - see the rules file - so
     * these lines have to say the board is waiting rather than stuck.
     *
     * There are two of them because a mismatch always hands the turn over: the
     * player looking at it either has the next flip or has just lost it, and
     * the second of those is a dead board that would otherwise say nothing
     * about whose move it is.
     */
    noMatchYours: 'No match. Your next flip turns those two back over.',
    noMatchTheirs: 'No match, and not your turn - their next flip turns those two back over.',
    /** The eight faces, named for a screen reader. Indexed by face, 0-7. */
    symbols: [
      'circle',
      'square',
      'triangle',
      'diamond',
      'cross',
      'star',
      'hexagon',
      'ring',
    ] as readonly string[],
  },

  tapRace: {
    round: (n: number, of: number): string => `Round ${n} of ${of}`,
    /** The pad before the window opens. The first tap is also the start. */
    tapToStart: 'Tap to start',
    tapArea: 'Tap area',
    tapHint: 'Tap as fast as you can. Your first tap starts the twenty seconds.',
    secondsLeft: (s: number): string => `${s}s`,
    /** The caption under the live number, so the big figure can stay a figure. */
    taps: 'taps',
    /** The same number in words, for the pad's label - see the board. */
    tapCount: (n: number): string => `${n} taps`,
    counting: 'Counted on this phone. Only the final number is sent.',
    timeUp: 'Time is up',
    /** Said of a player who has reported. Never their number - see the board. */
    countIn: 'Count sent',
    waitingOther: "Waiting for your friend's count…",
    /** The count is already on this phone; this only offers the report again. */
    sendCount: 'Send my count',
    countHeld: 'Your count is safe on this phone until it can be sent.',
    roundTo: (name: string): string => `${name} took that round`,
    roundTied: 'That round was tied',
    /** A finished round's two numbers, named so neither is guessed at. */
    tapsFor: (name: string, n: number): string => `${name} ${n}`,
  },
  slidingPuzzle: {
    /** Under a name in the player bar. Fewer is better, so it is never a score. */
    moves: (n: number): string => (n === 1 ? '1 move' : `${n} moves`),
    solved: 'Solved',
    theirPuzzle: (name: string): string => (name ? `${name}'s puzzle` : 'Their puzzle'),
    inPlace: (n: number, of: number): string => `${n} of ${of} in place`,
    tile: (tile: number, row: number, col: number): string => `Tile ${tile}, row ${row}, column ${col}`,
    /**
     * The empty square.
     *
     * Drawn as nothing, which leaves a screen reader nothing to land on - and
     * the gap is the one square in a fifteen-puzzle you have to know the
     * position of, because it is the only place a tile can go.
     */
    gap: (row: number, col: number): string => `Empty square, row ${row}, column ${col}`,
    /** The opponent's board, which is watched rather than touched. */
    theirBoard: (name: string, n: number, of: number): string =>
      `${name ? `${name}'s puzzle` : 'Their puzzle'}, ${n} of ${of} tiles in place`,
    /**
     * The rule, taught rather than enforced twice: the renderer lets every tile
     * be tapped and the reducer refuses the ones that cannot move.
     */
    tapHint: 'Tap a tile next to the gap to slide it.',
  },
  codeBreaker: {
    /**
     * The six colours, named by letter.
     *
     * A letter rather than a colour word because the pegs are drawn from theme
     * tokens whose hue is not the same in both schemes - the "ink" peg is
     * near-black in light and near-white in dark - so any name based on how it
     * looks would be wrong half the time. The letter is also the second channel
     * that makes the board readable without colour vision at all.
     */
    peg: ['A', 'B', 'C', 'D', 'E', 'F'] as readonly string[],
    colour: (letter: string): string => `Colour ${letter}`,
    slot: (n: number, letter: string | null): string =>
      letter === null ? `Peg ${n}, empty` : `Peg ${n}, colour ${letter}`,
    slotHint: 'Takes this peg out',
    /** Under a name in the player bar. Guesses left, not guesses used - the tension is the rope. */
    guessesLeft: (n: number): string => (n === 1 ? '1 guess left' : `${n} guesses left`),
    /** The number down the side of a history row. */
    guessNumber: (n: number): string => `${n}`,
    /** Joins the pegs of one guess for a screen reader. */
    pegList: (letters: readonly string[]): string => letters.join(', '),
    attempt: (who: string, n: number, pegs: string, exact: number, colour: number): string =>
      `${who}, guess ${n}: ${pegs}. ${exact} in the right place, ${colour} the right colour in the wrong place.`,
    /** The legend, said once under the board. */
    exactLegend: 'in place',
    colourLegend: 'right colour',
    submit: 'Guess',
    pickFour: 'Fill all four pegs first',
    outOfGuesses: (n: number): string => `You have used all ${n} guesses`,
    tapColour: 'Tap a colour to fill the next peg.',
    /**
     * The other half of `tapColour`, and the only thing that says why the six
     * colours go dead once the draft is full. It is read aloud as the palette's
     * hint AND drawn as the line under the board, so it is a whole sentence
     * rather than a verb phrase - a disabled control's hint is not announced,
     * which leaves the drawn line carrying it alone.
     */
    tapToChange: 'All four pegs are filled - tap one to change it.',
    theCode: 'The code',
    codeIs: (pegs: string): string => `The code was ${pegs}`,
  },

  /**
   * Flag Duel, Capital Duel and Geography Duel, which are one board.
   *
   * Nothing here names a country, a capital or a flag: every one of those comes
   * out of the question generator in the rules package, is derived from the
   * shared seed, and is therefore already the same text on both phones. What is
   * written below is only the vocabulary AROUND the question.
   */
  quizDuel: {
    round: (n: number, of: number): string => `Round ${n} of ${of}`,
    tapAnswer: 'Tap your answer.',
    /**
     * The flag is the whole question, so nothing on screen asks it in words -
     * see the rules file. A screen reader arriving at a lone emoji would be
     * handed a question with no question in it, so this is the prompt's spoken
     * label. It is never drawn.
     */
    whichFlag: 'Which country is this flag?',
    /**
     * Stands in for a name we do not have yet. `nameFor` returns an empty
     * string until the peer's profile has been read, and "waiting for …" with a
     * hole in it reads as a bug rather than as a pause.
     */
    friend: 'Your friend',
    /**
     * The two captions in the player bar, which are drawn as a pair.
     *
     * Both seats always carry one while a question is open, so the bar keeps
     * the same height throughout - a caption that appears the moment somebody
     * answers would push the options down under the other player's finger.
     * Neither says WHAT was answered.
     */
    answered: 'Answered',
    thinking: 'Thinking…',
    /** Your own answer has landed; the round now waits on the other phone. */
    rightWaiting: (name: string): string => `Correct - waiting for ${name}…`,
    wrongWaiting: (name: string): string => `Wrong - waiting for ${name}…`,
    /** They answered first. Says nothing about WHAT they answered. */
    theyAnswered: (name: string): string => `${name} has answered`,
    answerWas: (option: string): string => `The answer was ${option}`,
    /**
     * The speed line, shown only when both players were right. It reports the
     * two measured times rather than awarding anything: the score in the player
     * bar is the reducer's to state, and this only says where it moved.
     */
    youWereFaster: 'You were faster',
    theyWereFaster: (name: string): string => `${name} was faster`,
    deadHeat: 'A dead heat',
    finished: (n: number): string => `All ${n} questions answered`,
    /** Spoken hints on the options, so colour is never the only thing saying it. */
    correctAnswer: 'The correct answer',
    yourAnswerRight: 'Your answer, correct',
    yourAnswerWrong: 'Your answer, wrong',
    /**
     * What the other player chose, marked on the option itself once the round
     * belongs to both of them. Drawn as the bare name - a person's name is not
     * a word this file owns - so this is the spoken form of the same mark.
     */
    theirAnswer: (name: string): string => `${name} chose this`,
  },
  /**
   * The "together" family: Would You Rather, Most Likely To and This or That.
   *
   * One block of words for three games, because one renderer draws all three
   * and they differ only in where the two options come from. The prompts
   * themselves are NOT here: they are the game rather than the chrome around
   * it, they ship in the rules package, and both phones must deal the same ten
   * from the same seed.
   */
  secretChoice: {
    /**
     * Where you are in the ten. Spoken rather than drawn: the row of marks says
     * it on screen, so this is what a screen reader is given in the arrangement
     * that has no room for the marks.
     */
    round: (n: number, of: number): string => `Round ${n} of ${of}`,
    /** Stands in for a name we do not have yet. Never an id, never blank. */
    friend: 'Your friend',
    /** Under a name in the player bar. Says a choice exists, never which one. */
    answered: 'Answered',
    thinking: 'Thinking…',
    /** Before you have picked. Says out loud that neither of you can peek. */
    chooseHint: 'Pick one. Neither of you sees the other until you have both chosen.',
    /**
     * The same line, on a board too short to draw the player bar, carrying the
     * one thing that bar would have said: a choice has landed. Never which one -
     * knowing your friend has answered is a nudge, knowing WHAT they answered
     * would end the game.
     */
    chooseHintAfter: (name: string): string =>
      `${name} has answered. Pick one - they cannot see yours until you have chosen.`,
    /** The pause the whole family is built around. */
    waitingFor: (name: string): string => `Waiting for ${name}…`,
    /** The reveal, and the only two things it can ever say. */
    agreed: 'You agreed',
    differed: 'You went different ways',
    bothSaid: (option: string): string => `You both said ${option}.`,
    eachSaid: (yours: string, name: string, theirs: string): string =>
      `You said ${yours}. ${name} said ${theirs}.`,
    next: 'Next prompt',
    /** The last one, so the control says where it goes rather than "Next". */
    lastReveal: 'See how you did',
    /** The marker on an opened option. Paired with the player bar's two inks. */
    you: 'You',
    /** The same reveal, for a screen reader, appended to the option itself. */
    yoursSpoken: 'your choice',
    theirsSpoken: (name: string): string => `${name} chose this`,
    unchosenSpoken: 'neither of you chose this',
    /** The row of marks, read as one thing rather than ten. */
    progress: (agreed: number, played: number): string =>
      `Agreed on ${agreed} of ${played} prompts so far`,
    /**
     * The ending.
     *
     * Nobody wins one of these and the rules file says why at length, so the
     * closing lines are a tally of something the two of them hold JOINTLY and a
     * remark about it. There is deliberately no phrasing here that could be
     * read as one of them having done better than the other, because there is
     * no such quantity: agreement is symmetric.
     */
    tally: (agreed: number, of: number): string =>
      agreed === 1 ? `You agreed once out of ${of}` : `You agreed ${agreed} times out of ${of}`,
    tallyNote: (agreed: number, of: number): string => {
      if (agreed === 0) return 'Not once. There is a whole conversation in that.';
      if (agreed === of) return 'Every one of them. That is either lovely or slightly suspicious.';
      if (agreed * 2 > of) return 'More often than not, then.';
      return 'Plenty left to talk about.';
    },
  },
} as const;
