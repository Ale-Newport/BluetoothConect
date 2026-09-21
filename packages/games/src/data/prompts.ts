/**
 * The prompt banks for the "together" games - Would You Rather, Most Likely To
 * and This or That.
 *
 * Offline by construction, like the country table beside it. There is no
 * network to fetch a fresh pack from, so the pack ships in the binary or it does
 * not exist. A few hundred short lines cost a couple of kilobytes and never go
 * stale mid-flight, which is the only place these games really matter.
 *
 * WHY EACH BANK IS FOUR TIMES THE LENGTH OF A GAME. A game deals ten prompts,
 * shuffled from the shared seed. Ten prompts in a bank of ten would mean every
 * game was the same game in a different order, and the second play would be the
 * last one. Forty-odd means a pair can play four or five times before they see
 * a repeat, which is about as long as anybody wants to keep playing anyway.
 *
 * WHY OPTIONS ARE A PAIR OF FIELDS AND NOT ONE STRING WITH A SEPARATOR. The
 * obvious compact form is 'Beach / Mountains', split at the slash by whoever
 * renders it. It lost for two reasons: an option containing a slash silently
 * becomes three options, and the renderer wants two labelled buttons rather
 * than a sentence, so the split would have to happen on every frame anyway.
 *
 * ON THE WRITING ITSELF. These are meant to be played by two people sitting
 * next to each other with nothing else to do - on a plane, on a train, in a
 * waiting room. So: nothing crude, because the person beside you may be your
 * partner or may be your colleague and the game cannot tell; nothing that needs
 * a shared cultural reference, because half of them expire; and nothing that
 * sounds like a team-building exercise, which is the fastest way to make two
 * adults put a phone down. The test each line has to pass is that the answer is
 * genuinely arguable and that hearing the other person's answer tells you
 * something about them.
 */

/** Two options, exactly as they are shown on the two buttons. */
export interface OptionPair {
  readonly a: string;
  readonly b: string;
}

/**
 * Would You Rather. Both options must be defensible: a pair where one side is
 * obviously correct is not a question, it is a quiz with one mark going spare.
 */
export const WOULD_YOU_RATHER: readonly OptionPair[] = [
  { a: 'Always be too hot', b: 'Always be too cold' },
  { a: 'Live by the sea', b: 'Live in the mountains' },
  { a: 'Never need sleep', b: 'Never need to eat' },
  { a: 'Read minds', b: 'Be invisible' },
  { a: 'An extra hour every day', b: 'An extra day every week' },
  { a: 'Travel to the past', b: 'Travel to the future' },
  { a: 'Speak every language', b: 'Play every instrument' },
  { a: 'Be famous for a year', b: 'Be comfortable for ever' },
  { a: 'Lose all your photographs', b: 'Lose all your music' },
  { a: 'A perfect memory of one day', b: 'A second go at another' },
  { a: 'Breakfast for every meal', b: 'Pudding for every meal' },
  { a: 'Never queue again', b: 'Never be cold again' },
  { a: 'Always get the window seat', b: 'Always get the aisle' },
  { a: 'A house with a huge kitchen', b: 'A house with a huge garden' },
  { a: 'Be the funniest in the room', b: 'Be the kindest in the room' },
  { a: 'Sing everything you say', b: 'Dance everywhere you go' },
  { a: 'A dog that talks', b: 'A cat that tells the truth' },
  { a: 'Wake at five every morning', b: 'Stay up until three every night' },
  { a: 'Give up coffee', b: 'Give up chocolate' },
  { a: 'A week with no phone', b: 'A week with no music' },
  { a: 'Always know the time exactly', b: 'Always know the way home' },
  { a: 'Fly, but slowly', b: 'Teleport, but once a day' },
  { a: 'Only ever wear one colour', b: 'Only ever eat one cuisine' },
  { a: 'Live a hundred years ago', b: 'Live a hundred years from now' },
  { a: 'Never lose your keys', b: 'Never lose an argument' },
  { a: 'A long train journey', b: 'A short flight' },
  { a: 'Rain on your day off', b: 'Sun on a day you must work' },
  { a: 'Camping in the rain', b: 'A hotel with no window' },
  { a: 'Be brilliant at one thing', b: 'Be decent at everything' },
  { a: 'Your evenings free', b: 'Your mornings free' },
  { a: 'Always have a book on you', b: 'Always have a snack on you' },
  { a: 'Be trusted by everyone', b: 'Be believed by everyone' },
  { a: 'Never feel jet-lagged', b: 'Never wake up aching' },
  { a: 'Learn to surf', b: 'Learn to ski' },
  { a: 'A pub with a fire', b: 'A cafe with a window' },
  { a: 'Get up for the sunrise', b: 'Stay up for the stars' },
  { a: 'Ten close friends', b: 'A hundred good ones' },
  { a: 'Remember every dream', b: 'Choose one dream a night' },
  { a: 'A day alone in a city', b: 'A day alone in a forest' },
  { a: 'Always be five minutes early', b: 'Always have five minutes more' },
  { a: 'Own a small boat', b: 'Own a small cabin' },
  { a: 'Grow all your own food', b: 'Make all your own clothes' },
  { a: 'Be able to draw anything', b: 'Be able to mend anything' },
  { a: 'Live in one place for ever', b: 'Move somewhere new each year' },
  { a: 'Sing in front of a crowd', b: 'Speak in front of a crowd' },
  { a: 'Know what happens next', b: 'Be surprised every time' },
];

/**
 * Most Likely To. Each line completes "Who is most likely to...", so every entry
 * begins with a verb in the plain form and carries no full stop.
 *
 * The rule these had to follow: an accusation you would be pleased to have
 * levelled at you. "Lose their passport" is a fond thing to say about someone.
 * Anything that would sting if the other person picked you has no place here -
 * two people playing this on a long flight cannot walk away from the answer.
 */
export const MOST_LIKELY_TO: readonly string[] = [
  'miss the last train home',
  'cry at an advert',
  "befriend a stranger's dog",
  'lose their passport an hour before the flight',
  'learn a language for one holiday',
  'send a message to entirely the wrong person',
  'still be awake at four in the morning',
  'know where everything in the house is',
  'forget their own birthday',
  'talk their way out of a parking ticket',
  'start a project at midnight',
  'keep the same plant alive for ten years',
  'read the instructions first',
  'get lost in a city they know well',
  'be the last one dancing',
  'apologise to a piece of furniture',
  'give away the last chip',
  'be quietly right about everything',
  'end up on stage at a gig',
  'come home with a second cat',
  "remember a stranger's name a year later",
  'burn the toast twice',
  'take the scenic route',
  'bring three books for one weekend',
  "organise everybody else's holiday",
  'answer an email at midnight',
  'learn to bake bread properly',
  'be talked into karaoke',
  'put off a phone call for a week',
  'know a shortcut',
  'meet the neighbours first',
  'run a marathon on a dare',
  'keep every ticket stub',
  'arrive far too early',
  'fall asleep in the cinema',
  'start a conversation on a plane',
  'over-pack for one night away',
  'mend something with tape and hope',
  'win a pub quiz single-handed',
  'say yes to a boat trip',
  'remember the anniversary',
  'be the one holding the map',
  'go back for the dog first',
  'stay for one more song',
  'cook for twelve at no notice',
  'be recognised in a foreign country',
];

/**
 * This or That. Quickfire, so both labels are kept to a word or three - long
 * enough to be a real preference, short enough to answer without thinking,
 * which is the entire pleasure of it.
 */
export const THIS_OR_THAT: readonly OptionPair[] = [
  { a: 'Beach', b: 'Mountains' },
  { a: 'Coffee', b: 'Tea' },
  { a: 'Cats', b: 'Dogs' },
  { a: 'Sweet', b: 'Salty' },
  { a: 'Early bird', b: 'Night owl' },
  { a: 'Window', b: 'Aisle' },
  { a: 'Text', b: 'Phone call' },
  { a: 'The book', b: 'The film' },
  { a: 'Bath', b: 'Shower' },
  { a: 'Summer', b: 'Winter' },
  { a: 'Sunrise', b: 'Sunset' },
  { a: 'City', b: 'Countryside' },
  { a: 'Train', b: 'Plane' },
  { a: 'Pen', b: 'Pencil' },
  { a: 'Toast', b: 'Cereal' },
  { a: 'Pizza', b: 'Pasta' },
  { a: 'Ketchup', b: 'Brown sauce' },
  { a: 'Cake', b: 'Biscuits' },
  { a: 'Roast', b: 'Curry' },
  { a: 'Cinema', b: 'Sofa' },
  { a: 'Crossword', b: 'Sudoku' },
  { a: 'Handwritten', b: 'Typed' },
  { a: 'Paper map', b: 'Satnav' },
  { a: 'Walk', b: 'Cycle' },
  { a: 'Vanilla', b: 'Chocolate' },
  { a: 'Still', b: 'Sparkling' },
  { a: 'Smooth', b: 'Crunchy' },
  { a: 'Marmite', b: 'Never Marmite' },
  { a: 'Duvet', b: 'Blankets' },
  { a: 'Curtains open', b: 'Curtains shut' },
  { a: 'Hot chocolate', b: 'Mulled wine' },
  { a: 'Pub quiz', b: 'Karaoke' },
  { a: 'Tent', b: 'Hotel' },
  { a: 'Museum', b: 'Market' },
  { a: 'Plan it', b: 'Wing it' },
  { a: 'Long walk', b: 'Long bath' },
  { a: 'Board games', b: 'Cards' },
  { a: 'Radio', b: 'Podcast' },
  { a: 'Records', b: 'Playlists' },
  { a: 'Write a list', b: 'Trust your memory' },
  { a: 'Morning swim', b: 'Evening run' },
  { a: 'Rain on the roof', b: 'Snow on the ground' },
  { a: 'Rock pools', b: 'Sandcastles' },
  { a: 'Fireworks', b: 'Bonfire' },
  { a: 'Front row', b: 'Back row' },
  { a: 'Give presents', b: 'Get presents' },
];
