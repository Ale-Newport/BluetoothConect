import { describe, expect, it } from 'vitest';
import { allGames, findGame, gameCapabilities, gamesByMode } from '../src/registry.js';
import { GameMode } from '../src/engine.js';

describe('game catalogue', () => {
  it('lists every shipped game exactly once', () => {
    const ids = allGames().map((g) => g.definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('tic-tac-toe');
    expect(ids.length).toBeGreaterThanOrEqual(11);
  });

  it('exposes a complete, sane definition for every entry', () => {
    for (const entry of allGames()) {
      const d = entry.definition;
      expect(d.id).toMatch(/^[a-z0-9-]+$/);
      expect(d.name.length).toBeGreaterThan(0);
      expect(d.protocolVersion).toBeGreaterThanOrEqual(1);
      expect(d.minPlayers).toBeGreaterThanOrEqual(2);
      expect(d.maxPlayers).toBeGreaterThanOrEqual(d.minPlayers);
      expect(entry.blurb.length).toBeGreaterThan(0);
      expect(entry.typicalMinutes).toBeGreaterThan(0);
      // Every entry must be a real, callable game - this is the check that
      // stops a button existing for something that is not implemented.
      expect(typeof d.createInitialState).toBe('function');
      expect(typeof d.applyAction).toBe('function');
      expect(typeof d.validateAction).toBe('function');
      expect(typeof d.encodeState).toBe('function');
      expect(typeof d.decodeState).toBe('function');
      if (d.mode === GameMode.REALTIME) {
        expect(typeof d.tick).toBe('function');
        expect(d.tickRate).toBeGreaterThan(0);
      }
    }
  });

  it('builds a real initial state for every game', () => {
    for (const entry of allGames()) {
      const players = Array.from({ length: entry.definition.minPlayers }, (_, i) => `p${i + 1}`);
      const state = entry.definition.createInitialState({ players, seed: 1234, options: {} });
      expect(state).toBeDefined();
      // And it must survive the wire.
      const restored = entry.definition.decodeState(entry.definition.encodeState(state as never));
      expect(entry.definition.encodeState(restored as never)).toEqual(entry.definition.encodeState(state as never));
    }
  });

  it('reports capabilities for the handshake', () => {
    const caps = gameCapabilities();
    expect(caps.length).toBe(allGames().length);
    for (const c of caps) expect(c.version).toBeGreaterThanOrEqual(1);
  });

  it('finds a game by id and returns nothing for an unknown one', () => {
    expect(findGame('chess')?.definition.name).toBe('Chess');
    expect(findGame('quidditch')).toBeUndefined();
  });

  it('splits games by synchronisation mode', () => {
    const realtime = gamesByMode(GameMode.REALTIME).map((g) => g.definition.id);
    expect(realtime).toContain('pong');
    expect(realtime).toContain('air-hockey');
    expect(gamesByMode(GameMode.TURN_BASED).map((g) => g.definition.id)).toContain('chess');
  });
});
