/**
 * Every icon the interface asks for is actually drawn.
 *
 * The point of this file is to close the failure mode that made the drawn icon
 * set necessary in the first place. A missing character used to fail silently -
 * an empty box on screen and nothing anywhere else - and a missing *name* would
 * fail just as silently, because an unmatched name renders an empty `<Svg>`.
 * So: every name in the set must produce paths, and every game in the catalogue
 * must have a mark. `ALL_ICON_NAMES` is the same array `IconName` is derived
 * from, so this cannot silently cover less than the whole union.
 */
import React from 'react';
import { render } from '@testing-library/react-native';
import { allGames } from '@airlink/games';
import { ALL_ICON_NAMES, Icon, ThemeProvider } from '../src/ui/index.js';
import { DRAWN_GAME_IDS, GameArt } from '../src/screens/play/gameArt.js';

/** Count the drawing primitives an icon produced, at any depth. */
function shapeCount(node: unknown): number {
  if (node === null || typeof node !== 'object') return 0;
  if (Array.isArray(node)) return node.reduce<number>((total, child) => total + shapeCount(child), 0);
  const element = node as { type?: unknown; children?: unknown };
  const type = typeof element.type === 'string' ? element.type : '';
  const isShape = ['RNSVGPath', 'RNSVGCircle', 'RNSVGRect', 'RNSVGLine'].includes(type);
  return (isShape ? 1 : 0) + shapeCount(element.children);
}

test.each(ALL_ICON_NAMES)('the %s icon draws something', async (name) => {
  const view = await render(
    <ThemeProvider>
      <Icon name={name} />
    </ThemeProvider>,
  );
  expect(shapeCount(view.toJSON())).toBeGreaterThan(0);
});

test.each(allGames().map((entry) => entry.definition.id))('the %s tile has a mark', async (gameId) => {
  const view = await render(
    <ThemeProvider>
      <GameArt gameId={gameId} />
    </ThemeProvider>,
  );
  expect(shapeCount(view.toJSON())).toBeGreaterThan(0);
});

test('the catalogue and the drawn set agree, in both directions', () => {
  const inCatalogue = allGames().map((entry) => entry.definition.id).sort();
  expect([...DRAWN_GAME_IDS].sort()).toEqual(inCatalogue);
});
