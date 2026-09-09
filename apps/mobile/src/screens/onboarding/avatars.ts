/**
 * The avatar set.
 *
 * Deliberately narrow and deliberately calm: faces and travel, nothing that
 * reads as a sticker pack. An emoji here is a real product feature - it is what
 * a friend sees in a list row - rather than decoration, which is why the app
 * has no other emoji in its furniture.
 *
 * Order matters: the first row is what most people will pick from without
 * scrolling, so it holds the plainest options.
 */
export const AVATAR_EMOJI = [
  '\u{1F642}', // slightly smiling face
  '\u{1F60E}', // smiling face with sunglasses
  '\u{1F913}', // nerd face
  '\u{1F609}', // winking face
  '\u{1F60C}', // relieved face
  '\u{1F98A}', // fox
  '\u{1F43B}', // bear
  '\u{1F43C}', // panda
  '\u{1F428}', // koala
  '\u{1F981}', // lion
  '\u{1F427}', // penguin
  '\u{1F989}', // owl
  '\u{1F422}', // turtle
  '\u{1F433}', // whale
  '\u{1F340}', // four leaf clover
  '\u{1F335}', // cactus
  '\u{1F30A}', // wave
  '\u{2708}\u{FE0F}', // airplane
  '\u{1FA90}', // ringed planet
  '\u{1F3A7}', // headphones
  '\u{1F4F7}', // camera
  '\u{1F3B8}', // guitar
  '\u{26A1}', // high voltage
  '\u{1F319}', // crescent moon
] as const;

export type AvatarEmoji = (typeof AVATAR_EMOJI)[number];
