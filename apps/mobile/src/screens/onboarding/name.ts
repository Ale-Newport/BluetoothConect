/**
 * What counts as a name.
 *
 * A display name is the only thing a stranger sees before deciding whether to
 * connect, so it is worth being strict about it: control characters, bidi
 * overrides and zero-width marks can make one name render as another, and a
 * name of nothing but spaces reads as a blank row on the other phone. Kept
 * pure and separate from the screen so the rules can be tested without a
 * renderer.
 */

/** Long enough for a real name, short enough to fit a list row on any phone. */
export const MAX_NAME_LENGTH = 32;

/**
 * Characters that take up no space, or that reorder the ones around them.
 *
 * Written as code points rather than a character class so the source file
 * itself stays free of the very characters it is filtering out.
 */
function isInvisible(codePoint: number): boolean {
  if (codePoint <= 0x1f || codePoint === 0x7f) return true; // C0 controls, delete
  if (codePoint >= 0x80 && codePoint <= 0x9f) return true; // C1 controls
  if (codePoint === 0xad) return true; // soft hyphen
  if (codePoint >= 0x200b && codePoint <= 0x200f) return true; // zero-width, LTR/RTL marks
  if (codePoint === 0x2028 || codePoint === 0x2029) return true; // line, paragraph separator
  if (codePoint >= 0x202a && codePoint <= 0x202e) return true; // bidi embedding and override
  if (codePoint >= 0x2060 && codePoint <= 0x2064) return true; // word joiner, invisible operators
  if (codePoint >= 0x2066 && codePoint <= 0x206f) return true; // bidi isolates, deprecated formats
  if (codePoint === 0xfeff) return true; // byte-order mark
  return false;
}

/**
 * The name as it will be stored and broadcast.
 *
 * Counted in code points rather than UTF-16 units, so truncating never splits
 * an emoji or a surrogate pair in half.
 */
export function normaliseName(raw: string): string {
  const visible = Array.from(raw)
    .filter((character) => !isInvisible(character.codePointAt(0) ?? 0))
    .join('');
  const collapsed = visible.replace(/\s+/g, ' ').trim();
  const points = Array.from(collapsed);
  return points.length <= MAX_NAME_LENGTH ? collapsed : points.slice(0, MAX_NAME_LENGTH).join('');
}

/** True when something is left once the invisible characters are gone. */
export function isUsableName(raw: string): boolean {
  return normaliseName(raw).length > 0;
}
