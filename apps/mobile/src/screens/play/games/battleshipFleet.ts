import { useCallback, useEffect, useState } from 'react';
import { systemRandom } from '@airlink/core';
import { useClient } from '../../../client/ClientProvider.js';
import { FLEET, SALT_BYTES, SEA_SIZE, isLegalLayout, shipCells, type Ship } from '../gameTypes.js';

/**
 * The one secret in the whole app that the shared state must NOT contain.
 *
 * Battleship is a commitment game: what travels at the start is
 * H(layout || salt) and nothing else, and the layout itself stays on the
 * device that owns it until the audit at the end. That is what makes a fleet
 * hidden with no server to hide it behind - and it means the layout has to be
 * kept somewhere outside the game state, because the game state is exactly the
 * thing both phones can see.
 *
 * It goes in the settings table rather than in a ref, so a fleet survives the
 * app being closed. Without that, a game resumed after a restart could not
 * answer a single shot, and the reveal at the end would fail its own audit -
 * the player would look like a cheat because their phone forgot.
 */

export interface FleetSecret {
  readonly ships: readonly Ship[];
  readonly salt: readonly number[];
}

const KEY_PREFIX = 'play.battleship.fleet.';

export interface FleetSecretHandle {
  readonly secret: FleetSecret | null;
  /** True until the stored fleet has been looked for. Never spins forever. */
  readonly loading: boolean;
  save(secret: FleetSecret): void;
}

export function useFleetSecret(gameSessionId: string): FleetSecretHandle {
  const client = useClient();
  const [secret, setSecret] = useState<FleetSecret | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let stored: FleetSecret | null = null;
    try {
      stored = client.db.settings.getJson<FleetSecret | null>(KEY_PREFIX + gameSessionId, null);
    } catch {
      stored = null;
    }
    setSecret(isUsable(stored) ? stored : null);
    setLoading(false);
  }, [client, gameSessionId]);

  const save = useCallback(
    (next: FleetSecret) => {
      setSecret(next);
      try {
        client.db.settings.setJson(KEY_PREFIX + gameSessionId, next, Date.now());
      } catch {
        // A fleet that will not write is still playable for this sitting; the
        // board says so if it is ever needed after a restart.
      }
    },
    [client, gameSessionId],
  );

  return { secret, loading, save };
}

function isUsable(value: FleetSecret | null): value is FleetSecret {
  if (!value || !Array.isArray(value.ships) || !Array.isArray(value.salt)) return false;
  if (value.ships.length !== FLEET.length || value.salt.length !== SALT_BYTES) return false;
  return isLegalLayout(value.ships);
}

/** A fresh salt. Cryptographic randomness: it is what hides the layout. */
export function freshSalt(): number[] {
  return Array.from(systemRandom.randomBytes(SALT_BYTES));
}

/**
 * A random legal fleet.
 *
 * `Math.random` on purpose. This layout is LOCAL - it never enters the reducer,
 * both devices are meant to produce different ones, and the determinism rule
 * that bans Math.random applies to the shared state, not to a private choice
 * this phone makes for its own player. The salt above is a different matter and
 * comes from the CSPRNG.
 */
export function randomFleet(): Ship[] {
  for (let attempt = 0; attempt < 200; attempt++) {
    const ships: Ship[] = [];
    let ok = true;
    for (const entry of FLEET) {
      const placed = placeOne(ships, entry.length);
      if (!placed) {
        ok = false;
        break;
      }
      ships.push(placed);
    }
    if (ok && isLegalLayout(ships)) return ships;
  }
  // Falls back to a legal column layout, which always fits: 5+4+3+3+2 ships in
  // five columns of a ten-square board.
  return FLEET.map((entry, index) => ({ row: 0, col: index * 2, vertical: true, length: entry.length }));
}

function placeOne(placed: readonly Ship[], length: number): Ship | null {
  const taken = new Set<number>();
  for (const ship of placed) for (const cell of shipCells(ship) ?? []) taken.add(cell);

  for (let attempt = 0; attempt < 120; attempt++) {
    const vertical = Math.random() < 0.5;
    const row = Math.floor(Math.random() * (vertical ? SEA_SIZE - length + 1 : SEA_SIZE));
    const col = Math.floor(Math.random() * (vertical ? SEA_SIZE : SEA_SIZE - length + 1));
    const candidate: Ship = { row, col, vertical, length };
    const cells = shipCells(candidate);
    if (!cells) continue;
    if (cells.some((cell) => taken.has(cell))) continue;
    return candidate;
  }
  return null;
}

/** Move a ship to a new anchor, keeping its axis. Null when it would not fit. */
export function moveShip(ships: readonly Ship[], index: number, row: number, col: number): Ship[] | null {
  const target = ships[index];
  if (!target) return null;
  const next = [...ships];
  next[index] = { ...target, row, col };
  return isLegalLayout(next) ? next : null;
}

/** Turn a ship on its anchor. Null when the turned ship would not fit. */
export function rotateShip(ships: readonly Ship[], index: number): Ship[] | null {
  const target = ships[index];
  if (!target) return null;
  const next = [...ships];
  next[index] = { ...target, vertical: !target.vertical };
  return isLegalLayout(next) ? next : null;
}
