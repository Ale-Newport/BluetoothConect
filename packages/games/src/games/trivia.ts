/**
 * Trivia. Two to eight players race through the same multiple-choice questions.
 *
 * Everyone sees one question at a time, in an order derived from the shared
 * game seed. Each player answers once; a correct answer is worth 100 points
 * plus a speed bonus of up to 50. When everybody has answered - or when the
 * host closes the question because time ran out - the question RESOLVES: every
 * score for that question is applied at once and the correct option becomes
 * readable. The host then advances to the next question.
 *
 * ---------------------------------------------------------------------------
 * Where the answer key lives, and why it is NOT in the state
 * ---------------------------------------------------------------------------
 * The question bank ships inside the app, so a *modified* client can always
 * look up the answer to a question it is currently displaying. Only a server
 * could prevent that, and AirLink deliberately has none. What this design does
 * guarantee is that the answer never travels and never appears in the
 * synchronised state:
 *
 *   - The question order and the per-question option permutation are DERIVED
 *     from the seed by pure functions (`deck`, `optionOrder`) and recomputed on
 *     demand. Neither is a field of TriviaState, so an encoded snapshot on the
 *     wire carries no answer key - only the seed, which both peers agreed on
 *     before the first question and which is useless without the bank.
 *   - The single exported accessor that yields the correct option,
 *     `revealedCorrect`, returns null until the question has resolved. An
 *     honest client's rendering path - and this module's own tests - cannot
 *     obtain the answer any earlier, because no other export exposes it.
 *   - Scores and correct-answer tallies stay frozen while a question is open
 *     and are applied together at resolve time. Scoring each answer as it
 *     arrived would leak the key just as badly: a score jumping the instant a
 *     player answered would tell everyone that that player's (visible) choice
 *     was the right one.
 *
 * Residual, deliberate limitation: answers themselves travel in the clear,
 * because the action shape is fixed by the app protocol, so a player who
 * answers late can copy an earlier peer's choice. Closing that hole needs a
 * commit-reveal round trip (send hash(choice, nonce) first, reveal after the
 * question closes), which doubles the packets per question on a link with about
 * 180 usable bytes per packet. The speed bonus already prices waiting in.
 *
 * ---------------------------------------------------------------------------
 * Determinism notes
 * ---------------------------------------------------------------------------
 * Nothing here reads the clock or Math.random. `elapsedMs` is supplied by the
 * answering device and is therefore treated as hostile: it is rounded, clamped
 * to 0..30000 at decode time and clamped again when it is scored. All scoring
 * is integer arithmetic on values below 2^21, so both devices compute
 * bit-identical totals; the one division, `(50 * remaining) / 30000`, is an
 * IEEE-754 correctly-rounded operation on exact integers and is then floored,
 * so it cannot differ across engines. No floating point is ever stored.
 */
import type { CborValue } from '@airlink/core';
import {
  GameDecodeError,
  GameMode,
  GameStatusKind,
  SeededGameRandom,
  VALID,
  asArray,
  asBool,
  asInt,
  asMap,
  asNumber,
  asString,
  decodeActionEnvelope,
  encodeActionEnvelope,
  invalid,
  type GameAction,
  type GameDefinition,
  type GameSetup,
  type GameStatus,
  type PlayerId,
  type ValidationResult,
} from '../engine.js';

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Answers slower than this earn no speed bonus, and are clamped to it. */
export const MAX_ANSWER_MS = 30_000;
/** Awarded for any correct answer. */
export const BASE_POINTS = 100;
/** Added on top, scaled linearly by how much of the 30s window was left. */
export const MAX_SPEED_BONUS = 50;
export const DEFAULT_QUESTIONS = 10;
/** Hard ceiling, so a hostile `options.questions` cannot ask for a huge game. */
export const MAX_QUESTIONS = 50;
/** Sentinel stored in `choices` for a player who has not answered yet. */
export const UNANSWERED = -1;

// ---------------------------------------------------------------------------
// The offline question bank
// ---------------------------------------------------------------------------

interface BankEntry {
  readonly category: string;
  readonly prompt: string;
  /** Always four. `answer` indexes into this, the BANK order, not the display order. */
  readonly options: readonly string[];
  readonly answer: number;
}

const BANK: readonly BankEntry[] = [
  // -- Geography ------------------------------------------------------------
  { category: 'Geography', prompt: 'Which country has the largest land area?', options: ['Canada', 'China', 'Russia', 'United States'], answer: 2 },
  { category: 'Geography', prompt: 'What is the capital of Australia?', options: ['Sydney', 'Canberra', 'Melbourne', 'Perth'], answer: 1 },
  { category: 'Geography', prompt: 'Which river flows through Cairo?', options: ['The Nile', 'The Congo', 'The Niger', 'The Zambezi'], answer: 0 },
  { category: 'Geography', prompt: 'Mount Everest sits on the border of Nepal and which country?', options: ['India', 'China', 'Bhutan', 'Pakistan'], answer: 1 },
  { category: 'Geography', prompt: 'Which is the largest hot desert in the world?', options: ['The Gobi', 'The Kalahari', 'The Sahara', 'The Atacama'], answer: 2 },
  { category: 'Geography', prompt: 'Which country contains the most natural lakes?', options: ['Canada', 'Finland', 'Russia', 'Sweden'], answer: 0 },
  { category: 'Geography', prompt: 'Which sea lies between Italy and the Balkan peninsula?', options: ['The Aegean', 'The Adriatic', 'The Tyrrhenian', 'The Black Sea'], answer: 1 },
  { category: 'Geography', prompt: 'What is the smallest country in the world by area?', options: ['Monaco', 'Vatican City', 'San Marino', 'Nauru'], answer: 1 },
  { category: 'Geography', prompt: 'Which continent has no permanent human residents?', options: ['Antarctica', 'Australia', 'South America', 'Africa'], answer: 0 },
  { category: 'Geography', prompt: 'Which is the longest river in South America?', options: ['The Orinoco', 'The Parana', 'The Amazon', 'The Magdalena'], answer: 2 },
  { category: 'Geography', prompt: 'Haneda Airport serves which city?', options: ['Seoul', 'Tokyo', 'Osaka', 'Taipei'], answer: 1 },
  { category: 'Geography', prompt: 'Which country shares the southern land border of the United States?', options: ['Guatemala', 'Cuba', 'Mexico', 'Belize'], answer: 2 },

  // -- Science --------------------------------------------------------------
  { category: 'Science', prompt: 'What is the chemical symbol for gold?', options: ['Ag', 'Au', 'Gd', 'Go'], answer: 1 },
  { category: 'Science', prompt: 'How many bones are there in the adult human body?', options: ['186', '206', '226', '246'], answer: 1 },
  { category: 'Science', prompt: 'Which planet is known as the Red Planet?', options: ['Venus', 'Mars', 'Jupiter', 'Mercury'], answer: 1 },
  { category: 'Science', prompt: 'Which gas do plants take in for photosynthesis?', options: ['Oxygen', 'Nitrogen', 'Carbon dioxide', 'Hydrogen'], answer: 2 },
  { category: 'Science', prompt: 'Which organelle is called the powerhouse of the cell?', options: ['The nucleus', 'The ribosome', 'The mitochondrion', 'The Golgi body'], answer: 2 },
  { category: 'Science', prompt: 'Roughly how fast does light travel in a vacuum?', options: ['300,000 km/s', '30,000 km/s', '3,000 km/s', '3 million km/s'], answer: 0 },
  { category: 'Science', prompt: 'Which element has atomic number 1?', options: ['Helium', 'Hydrogen', 'Lithium', 'Oxygen'], answer: 1 },
  { category: 'Science', prompt: 'Which force keeps the planets in orbit around the Sun?', options: ['Magnetism', 'Friction', 'Gravity', 'Electrostatic repulsion'], answer: 2 },
  { category: 'Science', prompt: 'At sea level, water freezes at what temperature?', options: ['0 C', '-10 C', '32 C', '10 C'], answer: 0 },
  { category: 'Science', prompt: 'Which blood type is the universal red-cell donor?', options: ['AB positive', 'O negative', 'A negative', 'B positive'], answer: 1 },
  { category: 'Science', prompt: 'What does DNA stand for?', options: ['Deoxyribonucleic acid', 'Dinucleic acid', 'Deoxyribose nucleotide', 'Diribonucleic acid'], answer: 0 },
  { category: 'Science', prompt: 'Who published the theory of general relativity?', options: ['Isaac Newton', 'Albert Einstein', 'Niels Bohr', 'Galileo Galilei'], answer: 1 },
  { category: 'Science', prompt: 'How many hearts does an octopus have?', options: ['One', 'Two', 'Three', 'Eight'], answer: 2 },
  { category: 'Science', prompt: 'Which is the largest planet in the solar system?', options: ['Saturn', 'Jupiter', 'Neptune', 'Uranus'], answer: 1 },

  // -- History --------------------------------------------------------------
  { category: 'History', prompt: 'In which year did the Berlin Wall fall?', options: ['1987', '1989', '1991', '1993'], answer: 1 },
  { category: 'History', prompt: 'Who was the first person to walk on the Moon?', options: ['Buzz Aldrin', 'Yuri Gagarin', 'Neil Armstrong', 'Michael Collins'], answer: 2 },
  { category: 'History', prompt: 'In which year was Magna Carta sealed?', options: ['1066', '1215', '1348', '1485'], answer: 1 },
  { category: 'History', prompt: 'Genghis Khan founded which empire?', options: ['The Ottoman Empire', 'The Mongol Empire', 'The Persian Empire', 'The Roman Empire'], answer: 1 },
  { category: 'History', prompt: 'In which year did the First World War begin?', options: ['1912', '1914', '1916', '1918'], answer: 1 },
  { category: 'History', prompt: 'Which civilisation built Machu Picchu?', options: ['The Maya', 'The Aztecs', 'The Inca', 'The Olmec'], answer: 2 },
  { category: 'History', prompt: 'Who was the first President of the United States?', options: ['Thomas Jefferson', 'John Adams', 'George Washington', 'Benjamin Franklin'], answer: 2 },
  { category: 'History', prompt: 'In which year did the Titanic sink?', options: ['1910', '1912', '1914', '1918'], answer: 1 },
  { category: 'History', prompt: 'Which country gave the Statue of Liberty to the United States?', options: ['France', 'Britain', 'Spain', 'Italy'], answer: 0 },
  { category: 'History', prompt: 'Cleopatra was the last active ruler of which kingdom?', options: ['Ptolemaic Egypt', 'Babylon', 'Nubia', 'Carthage'], answer: 0 },
  { category: 'History', prompt: 'In which year did the Great Fire of London break out?', options: ['1605', '1666', '1707', '1755'], answer: 1 },
  { category: 'History', prompt: 'Which Roman emperor ordered a wall built across northern Britain in AD 122?', options: ['Hadrian', 'Trajan', 'Augustus', 'Nero'], answer: 0 },

  // -- Film -----------------------------------------------------------------
  { category: 'Film', prompt: 'Who directed Jaws?', options: ['George Lucas', 'Steven Spielberg', 'Ridley Scott', 'Martin Scorsese'], answer: 1 },
  { category: 'Film', prompt: 'Which film won the first Academy Award for Best Picture?', options: ['Wings', 'Sunrise', 'The Jazz Singer', 'Metropolis'], answer: 0 },
  { category: 'Film', prompt: 'In The Matrix, which pill does Neo swallow?', options: ['The blue one', 'The red one', 'The green one', 'The white one'], answer: 1 },
  { category: 'Film', prompt: 'Which studio made Toy Story?', options: ['DreamWorks', 'Pixar', 'Blue Sky', 'Aardman'], answer: 1 },
  { category: 'Film', prompt: 'Who played Jack in Titanic?', options: ['Brad Pitt', 'Leonardo DiCaprio', 'Matt Damon', 'Johnny Depp'], answer: 1 },
  { category: 'Film', prompt: '"May the Force be with you" comes from which franchise?', options: ['Star Trek', 'Star Wars', 'Dune', 'Stargate'], answer: 1 },
  { category: 'Film', prompt: 'Which film won the Best Picture Oscar for the 2019 film year?', options: ['1917', 'Parasite', 'Joker', 'Roma'], answer: 1 },
  { category: 'Film', prompt: 'Who directed Pulp Fiction?', options: ['Quentin Tarantino', 'The Coen brothers', 'David Fincher', 'Paul Thomas Anderson'], answer: 0 },
  { category: 'Film', prompt: 'In The Lion King, who is Simba’s father?', options: ['Scar', 'Mufasa', 'Rafiki', 'Zazu'], answer: 1 },
  { category: 'Film', prompt: 'Which actor played Iron Man in the Marvel films?', options: ['Chris Evans', 'Robert Downey Jr.', 'Mark Ruffalo', 'Chris Hemsworth'], answer: 1 },
  { category: 'Film', prompt: 'In which film does Jodie Foster interview Hannibal Lecter?', options: ['Se7en', 'The Silence of the Lambs', 'Zodiac', 'Psycho'], answer: 1 },
  { category: 'Film', prompt: 'Hayao Miyazaki co-founded which animation studio?', options: ['Studio Ghibli', 'Toei Animation', 'Madhouse', 'Gainax'], answer: 0 },

  // -- Music ----------------------------------------------------------------
  { category: 'Music', prompt: 'How many strings does a standard guitar have?', options: ['Four', 'Five', 'Six', 'Seven'], answer: 2 },
  { category: 'Music', prompt: 'Which band released the album Abbey Road?', options: ['The Rolling Stones', 'The Beatles', 'The Kinks', 'The Who'], answer: 1 },
  { category: 'Music', prompt: 'Beethoven kept composing after losing which sense?', options: ['Sight', 'Hearing', 'Speech', 'Smell'], answer: 1 },
  { category: 'Music', prompt: 'Which instrument has 88 keys?', options: ['The organ', 'The piano', 'The harpsichord', 'The accordion'], answer: 1 },
  { category: 'Music', prompt: 'Who recorded Bohemian Rhapsody?', options: ['Queen', 'Led Zeppelin', 'Pink Floyd', 'Deep Purple'], answer: 0 },
  { category: 'Music', prompt: 'Which country was the composer Frederic Chopin born in?', options: ['Poland', 'France', 'Austria', 'Hungary'], answer: 0 },
  { category: 'Music', prompt: 'In music, what does "forte" mean?', options: ['Loud', 'Soft', 'Fast', 'Slow'], answer: 0 },
  { category: 'Music', prompt: 'Who is known as the King of Pop?', options: ['Prince', 'Michael Jackson', 'Elvis Presley', 'James Brown'], answer: 1 },
  { category: 'Music', prompt: 'The saxophone belongs to which instrument family?', options: ['Brass', 'Woodwind', 'Percussion', 'Strings'], answer: 1 },
  { category: 'Music', prompt: 'How many lines does a musical stave have?', options: ['Four', 'Five', 'Six', 'Seven'], answer: 1 },
  { category: 'Music', prompt: 'Bob Marley is most associated with which genre?', options: ['Reggae', 'Ska', 'Calypso', 'Soca'], answer: 0 },
  { category: 'Music', prompt: 'Which group won Eurovision in 1974 with Waterloo?', options: ['Roxette', 'ABBA', 'A-ha', 'Ace of Base'], answer: 1 },

  // -- Sport ----------------------------------------------------------------
  { category: 'Sport', prompt: 'How many players does each side field in association football?', options: ['Nine', 'Ten', 'Eleven', 'Twelve'], answer: 2 },
  { category: 'Sport', prompt: 'How often are the Summer Olympic Games normally held?', options: ['Every two years', 'Every three years', 'Every four years', 'Every five years'], answer: 2 },
  { category: 'Sport', prompt: 'In tennis, what is a score of zero called?', options: ['Love', 'Nil', 'Duck', 'Blank'], answer: 0 },
  { category: 'Sport', prompt: 'Which country has won the most FIFA World Cups?', options: ['Germany', 'Italy', 'Brazil', 'Argentina'], answer: 2 },
  { category: 'Sport', prompt: 'How many points is a touchdown worth in American football?', options: ['Three', 'Five', 'Six', 'Seven'], answer: 2 },
  { category: 'Sport', prompt: 'In which sport would you perform a slam dunk?', options: ['Volleyball', 'Basketball', 'Handball', 'Netball'], answer: 1 },
  { category: 'Sport', prompt: 'The Tour de France is a race in which sport?', options: ['Running', 'Cycling', 'Sailing', 'Horse racing'], answer: 1 },
  { category: 'Sport', prompt: 'How many holes are played in a standard round of golf?', options: ['Nine', 'Twelve', 'Eighteen', 'Twenty-one'], answer: 2 },
  { category: 'Sport', prompt: 'Which sport is played with a shuttlecock?', options: ['Squash', 'Badminton', 'Table tennis', 'Padel'], answer: 1 },
  { category: 'Sport', prompt: 'How many balls are bowled in a standard cricket over?', options: ['Four', 'Five', 'Six', 'Eight'], answer: 2 },
  { category: 'Sport', prompt: 'Usain Bolt set his world records in which discipline?', options: ['Sprinting', 'The marathon', 'Hurdles', 'The long jump'], answer: 0 },
  { category: 'Sport', prompt: 'Which martial art originated in Korea?', options: ['Judo', 'Taekwondo', 'Kung fu', 'Muay Thai'], answer: 1 },

  // -- Food -----------------------------------------------------------------
  { category: 'Food', prompt: 'Which nut is marzipan made from?', options: ['Almond', 'Hazelnut', 'Walnut', 'Cashew'], answer: 0 },
  { category: 'Food', prompt: 'Sushi is traditionally from which country?', options: ['China', 'Japan', 'Korea', 'Thailand'], answer: 1 },
  { category: 'Food', prompt: 'What is the main ingredient of guacamole?', options: ['Avocado', 'Courgette', 'Peas', 'Broccoli'], answer: 0 },
  { category: 'Food', prompt: 'Which spice is the most expensive by weight?', options: ['Saffron', 'Vanilla', 'Cardamom', 'Cinnamon'], answer: 0 },
  { category: 'Food', prompt: 'Parmesan cheese comes from which country?', options: ['France', 'Italy', 'Spain', 'Greece'], answer: 1 },
  { category: 'Food', prompt: 'Which pastry are profiteroles made from?', options: ['Choux', 'Filo', 'Puff', 'Shortcrust'], answer: 0 },
  { category: 'Food', prompt: 'Which vegetable gives borscht its colour?', options: ['Beetroot', 'Cabbage', 'Carrot', 'Turnip'], answer: 0 },
  { category: 'Food', prompt: 'Traditional balsamic vinegar comes from which Italian city?', options: ['Modena', 'Naples', 'Turin', 'Bari'], answer: 0 },
  { category: 'Food', prompt: 'Which fruit is traditional cider made from?', options: ['Apples', 'Pears', 'Grapes', 'Plums'], answer: 0 },
  { category: 'Food', prompt: 'Tofu is made from which bean?', options: ['Soya', 'Black bean', 'Fava', 'Mung'], answer: 0 },
  { category: 'Food', prompt: 'Which country produces the most coffee?', options: ['Colombia', 'Vietnam', 'Brazil', 'Ethiopia'], answer: 2 },
  { category: 'Food', prompt: 'Which grain is risotto made from?', options: ['Rice', 'Barley', 'Wheat', 'Spelt'], answer: 0 },

  // -- Language -------------------------------------------------------------
  { category: 'Language', prompt: 'How many letters are there in the English alphabet?', options: ['24', '25', '26', '27'], answer: 2 },
  { category: 'Language', prompt: 'Which language has the most native speakers?', options: ['English', 'Spanish', 'Mandarin Chinese', 'Hindi'], answer: 2 },
  { category: 'Language', prompt: 'Which of these words is a palindrome?', options: ['Level', 'Table', 'Chair', 'Window'], answer: 0 },
  { category: 'Language', prompt: 'In Spanish, what is a "biblioteca"?', options: ['A bookshop', 'A library', 'An office', 'A school'], answer: 1 },
  { category: 'Language', prompt: 'What is the official language of Brazil?', options: ['Spanish', 'Portuguese', 'French', 'Italian'], answer: 1 },
  { category: 'Language', prompt: 'Which alphabet is Russian written in?', options: ['Latin', 'Cyrillic', 'Greek', 'Arabic'], answer: 1 },
  { category: 'Language', prompt: 'Two words that sound alike but are spelled differently are called what?', options: ['Homophones', 'Synonyms', 'Antonyms', 'Acronyms'], answer: 0 },
  { category: 'Language', prompt: '"Carpe diem" is Latin for what?', options: ['Seize the day', 'Fear the night', 'Trust the sea', 'Live freely'], answer: 0 },
  { category: 'Language', prompt: 'Which of these is NOT a Romance language?', options: ['Romanian', 'Catalan', 'Dutch', 'Portuguese'], answer: 2 },
  { category: 'Language', prompt: 'In the acronym NASA, what does the first A stand for?', options: ['Aeronautics', 'Astronomy', 'Atmospheric', 'Applied'], answer: 0 },
  { category: 'Language', prompt: 'Esperanto is best described as what?', options: ['A constructed language', 'A dialect of Spanish', 'An ancient tongue', 'A programming language'], answer: 0 },
  { category: 'Language', prompt: 'How many letters are there in the Greek alphabet?', options: ['20', '24', '26', '28'], answer: 1 },
];

// ---------------------------------------------------------------------------
// Seed-derived question deck. Never stored, always recomputed.
// ---------------------------------------------------------------------------

/**
 * The question order for a game. A fresh generator is seeded here rather than
 * drawing from `context.random`, deliberately: the session shares one RNG
 * across every action, so a deck drawn from it would depend on how many draws
 * had already happened - and a replayed log would then deal a different deck.
 * A pure function of the seed cannot drift.
 */
function deck(seed: number, total: number): readonly number[] {
  const rng = new SeededGameRandom(seed);
  const ids = BANK.map((_, i) => i);
  return rng.shuffle(ids).slice(0, total);
}

/**
 * The option permutation for one position: display slot -> index into the bank
 * entry's own option list. Seeded per position so that shuffling the options of
 * question 5 cannot be predicted from having seen question 4.
 */
function optionOrder(seed: number, position: number): readonly number[] {
  const rng = new SeededGameRandom((seed ^ Math.imul(position + 1, 0x9e3779b1)) >>> 0);
  return rng.shuffle([0, 1, 2, 3]);
}

function entryAt(seed: number, total: number, position: number): BankEntry {
  const ids = deck(seed, total);
  const clamped = position < 0 ? 0 : position >= ids.length ? ids.length - 1 : position;
  return BANK[ids[clamped] as number] as BankEntry;
}

/** The display slot holding the correct option. Never stored in the state. */
function correctSlot(seed: number, total: number, position: number): number {
  const entry = entryAt(seed, total, position);
  return optionOrder(seed, position).indexOf(entry.answer);
}

/**
 * Integer speed bonus: full 50 at 0 ms, 0 at the 30 s cut-off, linear between.
 * `MAX_SPEED_BONUS * remaining` is at most 1,500,000, so the product and the
 * division are both exact-input IEEE-754 operations and the floor makes the
 * result an integer on every engine.
 */
function speedBonus(ms: number): number {
  const t = ms < 0 ? 0 : ms > MAX_ANSWER_MS ? MAX_ANSWER_MS : ms;
  return Math.floor((MAX_SPEED_BONUS * (MAX_ANSWER_MS - t)) / MAX_ANSWER_MS);
}

// ---------------------------------------------------------------------------
// State and actions
// ---------------------------------------------------------------------------

export interface TriviaState {
  readonly players: readonly PlayerId[];
  /** The shared seed, normalised to a uint32. The whole deck derives from it. */
  readonly seed: number;
  /** How many questions this game runs. */
  readonly total: number;
  /** 0-based index of the question on screen. Never reaches `total`. */
  readonly position: number;
  /** True once the current question has been scored and its answer is public. */
  readonly revealed: boolean;
  readonly finished: boolean;
  /** Per player, for the CURRENT question: display slot, or UNANSWERED. */
  readonly choices: readonly number[];
  /** Per player, for the CURRENT question: clamped answer time in ms. */
  readonly times: readonly number[];
  readonly scores: readonly number[];
  /** Per player: how many questions they have got right so far. */
  readonly correct: readonly number[];
}

export interface TriviaAnswerAction extends GameAction {
  readonly type: 'answer';
  readonly payload: { readonly choice: number; readonly elapsedMs: number };
}

export interface TriviaNextAction extends GameAction {
  readonly type: 'next';
  readonly payload: Record<string, never>;
}

export type TriviaAction = TriviaAnswerAction | TriviaNextAction;

// ---------------------------------------------------------------------------
// Views - the only sanctioned way to read a question, and the reveal gate
// ---------------------------------------------------------------------------

export interface TriviaQuestionView {
  readonly position: number;
  readonly total: number;
  readonly category: string;
  readonly prompt: string;
  /** In display order: the index of an option here IS the `choice` value. */
  readonly options: readonly string[];
}

/** The question on screen, with its options already in display order. */
export function currentQuestion(state: TriviaState): TriviaQuestionView {
  const entry = entryAt(state.seed, state.total, state.position);
  const order = optionOrder(state.seed, state.position);
  return {
    position: state.position,
    total: state.total,
    category: entry.category,
    prompt: entry.prompt,
    options: order.map((i) => entry.options[i] as string),
  };
}

/**
 * The correct display slot, or null while the question is still open. This is
 * the ONLY export that yields the answer key, and it is gated on the reveal.
 */
export function revealedCorrect(state: TriviaState): number | null {
  if (!state.revealed) return null;
  return correctSlot(state.seed, state.total, state.position);
}

export interface TriviaStanding {
  readonly player: PlayerId;
  readonly score: number;
  readonly correct: number;
}

/** Scores, highest first, ties broken by player id so both devices agree. */
export function leaderboard(state: TriviaState): readonly TriviaStanding[] {
  return state.players
    .map((player, i) => ({ player, score: state.scores[i] as number, correct: state.correct[i] as number }))
    .sort((x, y) => (y.score - x.score) || (x.player < y.player ? -1 : x.player > y.player ? 1 : 0));
}

/** Has this player answered the question on screen? */
export function hasAnswered(state: TriviaState, player: PlayerId): boolean {
  const seat = state.players.indexOf(player);
  return seat >= 0 && state.choices[seat] !== UNANSWERED;
}

// ---------------------------------------------------------------------------
// Reducer helpers
// ---------------------------------------------------------------------------

/**
 * Close the current question: score every answer at once, publish the key, and
 * end the game if this was the last question. Players who did not answer keep
 * the score they had.
 */
function resolve(state: TriviaState): TriviaState {
  const key = correctSlot(state.seed, state.total, state.position);
  const scores = [...state.scores];
  const correct = [...state.correct];
  for (let i = 0; i < state.players.length; i++) {
    if (state.choices[i] !== key) continue;
    scores[i] = (scores[i] as number) + BASE_POINTS + speedBonus(state.times[i] as number);
    correct[i] = (correct[i] as number) + 1;
  }
  return {
    ...state,
    scores,
    correct,
    revealed: true,
    finished: state.position >= state.total - 1,
  };
}

/** Move on to the next question, clearing the per-question tallies. */
function advance(state: TriviaState): TriviaState {
  return {
    ...state,
    position: state.position + 1,
    revealed: false,
    choices: state.players.map(() => UNANSWERED),
    times: state.players.map(() => 0),
  };
}

function readOptionCount(options: Readonly<Record<string, CborValue>>): number {
  const raw = options.questions;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_QUESTIONS;
  const n = Math.floor(raw);
  return n < 1 ? 1 : n > MAX_QUESTIONS ? MAX_QUESTIONS : n;
}

/** Clamp an untrusted answer time. Rounded first, so the result is an integer. */
function clampAnswerMs(raw: number): number {
  const rounded = Math.round(raw);
  if (rounded <= 0) return 0;
  return rounded > MAX_ANSWER_MS ? MAX_ANSWER_MS : rounded;
}

// ---------------------------------------------------------------------------
// The game
// ---------------------------------------------------------------------------

export const trivia: GameDefinition<TriviaState, TriviaAction> = {
  id: 'trivia',
  name: 'Trivia',
  protocolVersion: 1,
  mode: GameMode.TURN_BASED,
  minPlayers: 2,
  maxPlayers: 8,

  createInitialState(setup: GameSetup): TriviaState {
    const players = [...setup.players];
    return {
      players,
      seed: setup.seed >>> 0,
      total: readOptionCount(setup.options),
      position: 0,
      revealed: false,
      finished: false,
      choices: players.map(() => UNANSWERED),
      times: players.map(() => 0),
      scores: players.map(() => 0),
      correct: players.map(() => 0),
    };
  },

  validateAction(state, action): ValidationResult {
    const type = action.type as string;
    if (state.finished) return invalid('the game has already finished');
    const seat = state.players.indexOf(action.player);
    if (seat < 0) return invalid(`${action.player} is not in this game`);

    if (action.type === 'answer') {
      if (state.revealed) return invalid('answers for this question are closed');
      const { choice, elapsedMs } = action.payload;
      if (!Number.isInteger(choice) || choice < 0 || choice > 3) return invalid('choice must be 0-3');
      if (!Number.isInteger(elapsedMs) || elapsedMs < 0 || elapsedMs > MAX_ANSWER_MS) {
        return invalid(`elapsedMs must be 0-${MAX_ANSWER_MS}`);
      }
      if (state.choices[seat] !== UNANSWERED) return invalid('you have already answered this question');
      return VALID;
    }

    if (action.type === 'next') {
      // Only the host closes a question or moves the game on. There is no clock
      // in a turn-based game - `context.elapsedMs` is always 0 - so "time is up"
      // cannot be checked here; it is the host's call, and closing a question
      // early costs the host their own answer just as much as anyone else's.
      if (state.players[0] !== action.player) return invalid('only the host can advance the game');
      return VALID;
    }

    return invalid(`unknown action "${type}"`);
  },

  applyAction(state, action): TriviaState {
    if (action.type === 'answer') {
      const seat = state.players.indexOf(action.player);
      if (seat < 0) return state; // unreachable after validateAction; belt and braces
      const choices = [...state.choices];
      const times = [...state.times];
      choices[seat] = action.payload.choice;
      times[seat] = action.payload.elapsedMs;
      const answered: TriviaState = { ...state, choices, times };
      // The last answer in closes the question by itself; nobody has to press
      // anything, and no score moves until this moment.
      return choices.every((c) => c !== UNANSWERED) ? resolve(answered) : answered;
    }
    // 'next' means "time is up" while the question is open, and "on to the next
    // one" once it has been scored.
    return state.revealed ? advance(state) : resolve(state);
  },

  status(state): GameStatus {
    if (!state.finished) return { kind: GameStatusKind.IN_PROGRESS };
    let best = -1;
    for (const score of state.scores) if (score > best) best = score;
    const winners = state.players.filter((_, i) => state.scores[i] === best);
    if (winners.length === 1) {
      return { kind: GameStatusKind.WON, winners, reason: `${best} points` };
    }
    return { kind: GameStatusKind.DRAW, reason: `${winners.length} players tied on ${best} points` };
  },

  currentTurn(state): PlayerId | null {
    if (state.finished) return null;
    // Between questions the host is on the clock; during one, whoever still
    // owes an answer. Any of them may act - this is only the "who is holding
    // things up" hint the UI and the conformance driver need.
    if (state.revealed) return state.players[0] ?? null;
    const waiting = state.choices.indexOf(UNANSWERED);
    return (waiting >= 0 ? state.players[waiting] : state.players[0]) ?? null;
  },

  encodeState(state): CborValue {
    // Short keys and flat integer arrays: 45 bytes of CBOR for a two-player
    // game, 109 for eight, both inside one Bluetooth packet. The questions
    // themselves never travel - `g` (the seed) regenerates the whole deck.
    return {
      p: [...state.players],
      g: state.seed,
      n: state.total,
      i: state.position,
      r: state.revealed,
      f: state.finished,
      c: [...state.choices],
      m: [...state.times],
      x: [...state.scores],
      k: [...state.correct],
    };
  },

  decodeState(value): TriviaState {
    const m = asMap(value, 'trivia.state');
    const players = asArray(m.p, 'players', 8).map((p, i) => asString(p, `players[${i}]`, 64));
    if (players.length < 2) throw new GameDecodeError('trivia: needs 2-8 players');
    const seed = asInt(m.g, 'seed', 0, 0xffffffff);
    const total = asInt(m.n, 'total', 1, MAX_QUESTIONS);
    const seats = (v: CborValue | undefined, what: string, min: number, max: number): number[] => {
      const arr = asArray(v, what, 8).map((x, i) => asInt(x, `${what}[${i}]`, min, max));
      if (arr.length !== players.length) throw new GameDecodeError(`trivia: ${what} needs one entry per player`);
      return arr;
    };
    return {
      players,
      seed,
      total,
      position: asInt(m.i, 'position', 0, total - 1),
      revealed: asBool(m.r, 'revealed'),
      finished: asBool(m.f, 'finished'),
      choices: seats(m.c, 'choices', UNANSWERED, 3),
      times: seats(m.m, 'times', 0, MAX_ANSWER_MS),
      scores: seats(m.x, 'scores', 0, total * (BASE_POINTS + MAX_SPEED_BONUS)),
      correct: seats(m.k, 'correct', 0, total),
    };
  },

  encodeAction(action): CborValue {
    if (action.type === 'answer') {
      // Wire shape: {c: choice, m: ms}. Two small integers, well under the
      // ~180 usable bytes a Bluetooth packet gives us.
      return encodeActionEnvelope({ ...action, payload: { c: action.payload.choice, m: action.payload.elapsedMs } });
    }
    return encodeActionEnvelope({ ...action, payload: {} });
  },

  decodeAction(value, player): TriviaAction {
    const envelope = decodeActionEnvelope(value, player);
    if (envelope.type === 'answer') {
      const payload = asMap(envelope.payload, 'trivia.payload');
      return {
        type: 'answer',
        player,
        seq: envelope.seq,
        payload: {
          choice: asInt(payload.c, 'answer.choice', 0, 3),
          // Any wildly out-of-range value is rejected outright; anything merely
          // optimistic is rounded and clamped. Clamping is idempotent, so the
          // action still round-trips exactly.
          elapsedMs: clampAnswerMs(asNumber(payload.m, 'answer.elapsedMs')),
        },
      };
    }
    if (envelope.type === 'next') {
      return { type: 'next', player, seq: envelope.seq, payload: {} };
    }
    throw new GameDecodeError(`trivia: unknown action "${envelope.type}"`);
  },
};
