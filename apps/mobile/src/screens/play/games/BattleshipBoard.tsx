import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { Button, Label, haptic, useTheme } from '../../../ui/index.js';
import { BoardSurface, Cell, ChipRow, Hint, PlayerBar } from '../boardKit.js';
import { playText } from '../strings.js';
import type { GameRendererProps } from '../contract.js';
import {
  BattleshipPhase,
  FLEET,
  SEA_SIZE,
  fleetCommitment,
  resolveReport,
  shipCells,
  sunkCount,
  type BattleshipState,
  type Ship,
  type Shot,
} from '../gameTypes.js';
import { freshSalt, randomFleet, rotateShip, useFleetSecret } from './battleshipFleet.js';

/**
 * Battleship.
 *
 * The one game here that has to keep a secret with no server to keep it in, and
 * the protocol solves it the old-fashioned way: each phone commits to
 * H(layout || salt) up front, answers shots against a layout it never sends,
 * and reveals at the end so the whole transcript can be audited. A player who
 * lied about a single square loses on the audit.
 *
 * That shape decides how this screen behaves:
 *
 *   THE REPORT IS AUTOMATIC. When a shot lands on this player's water, the
 *   honest answer is a pure function of the fleet and the shots so far -
 *   `resolveReport`, the same function the audit later re-derives - so there is
 *   nothing to ask the user and nothing they could usefully decide. Making it a
 *   button would only offer them a chance to stall.
 *
 *   THE FLEET OUTLIVES THE APP. It is written to the settings table, not held
 *   in memory, because a game resumed after a restart must still be able to
 *   answer - and must still pass its own audit at the end.
 *
 *   THE REVEAL IS A BUTTON, ONCE. It sends the layout and the salt, and from
 *   that moment the game is decided by arithmetic rather than by trust.
 */

const MAX_GRID = 320;
/** Hairline gutter between sea squares. Smaller than any spacing token, by need. */
const GUTTER = 1;
/** Corner on a sea square. The radius scale starts at 8, which would be a circle. */
const CELL_RADIUS = 2;

export function BattleshipBoard({
  state,
  dispatch,
  local,
  players,
  nameFor,
  turn,
  live,
  width,
  sessionKey,
}: GameRendererProps<BattleshipState>): React.JSX.Element {
  const theme = useTheme();

  const seat = players.indexOf(local) === 1 ? 1 : 0;
  const foe = seat === 1 ? 0 : 1;
  const grid = Math.min(width, MAX_GRID);
  const cell = grid / SEA_SIZE;

  // The fleet is filed under this game's own id, so a rematch starts with a
  // fresh one rather than reusing a layout the opponent has already seen.
  const { secret, loading, save } = useFleetSecret(sessionKey);

  const [draft, setDraft] = useState<readonly Ship[] | null>(null);
  const [selected, setSelected] = useState(0);

  // Seeded once, from a stored fleet if there is one, otherwise from a shuffle.
  // After that the draft is the only thing the placement screen edits, so
  // rotating and moving still work if a commitment did not get sent.
  useEffect(() => {
    if (state.phase !== BattleshipPhase.PLACEMENT || draft || loading) return;
    setDraft(secret?.ships ?? randomFleet());
  }, [draft, loading, secret, state.phase]);

  // Memoised because the auto-report effect below depends on them: a fresh
  // empty array on every render would re-run it and re-send the same report.
  const myShots = useMemo<readonly Shot[]>(() => state.shots[seat] ?? [], [seat, state.shots]);
  const theirShots = useMemo<readonly Shot[]>(() => state.shots[foe] ?? [], [foe, state.shots]);
  const committed = state.commitments[seat] !== null;

  /**
   * Answer a shot at our own water.
   *
   * In an effect rather than in a render so it runs exactly once per pending
   * shot, and guarded on the pending cell so a re-render mid-flight cannot send
   * the same report twice - the reducer would refuse the duplicate, but a
   * refused action is still a packet on a Bluetooth link.
   */
  useEffect(() => {
    const pending = state.pending;
    if (!pending || pending.shooter === seat || !secret || !live) return;
    if (state.phase !== BattleshipPhase.FIRING) return;
    const answer = resolveReport(secret.ships, myShots, pending.cell);
    dispatch('report', { cell: answer.cell, hit: answer.hit, sunk: answer.sunk });
  }, [dispatch, live, myShots, seat, secret, state.pending, state.phase]);

  const myCells = useMemo(() => {
    const ships = draft ?? secret?.ships ?? [];
    const map = new Map<number, number>();
    ships.forEach((ship, index) => {
      for (const c of shipCells(ship) ?? []) map.set(c, index);
    });
    return map;
  }, [draft, secret]);

  const shotAt = (shots: readonly Shot[], index: number): Shot | undefined =>
    shots.find((shot) => shot.cell === index);

  // -- placement ------------------------------------------------------------

  if (state.phase === BattleshipPhase.PLACEMENT) {
    const ships = draft ?? secret?.ships ?? [];
    return (
      <View>
        <Label variant="title2">{playText.battleship.placeTitle}</Label>
        <Label variant="subheadline" tone="secondary" style={{ marginTop: theme.spacing.xs }}>
          {playText.battleship.placeBody}
        </Label>

        <View style={{ height: theme.spacing.lg }} />

        <BoardSurface size={grid} padded={false}>
          <Sea
            size={cell}
            label={playText.battleship.yourWaters}
            cellState={(index) => {
              const ship = myCells.get(index);
              return ship === undefined ? 'water' : ship === selected ? 'selectedShip' : 'ship';
            }}
            describe={(index) => {
              const ship = myCells.get(index);
              return ship === undefined
                ? cellName(index)
                : `${cellName(index)}, ${playText.battleship.ships[ship] ?? ''}`;
            }}
            onPress={
              committed
                ? undefined
                : (index) => {
                    const next = anchorTo(ships, selected, index);
                    if (next) setDraft(next);
                    else haptic('warning');
                  }
            }
          />
        </BoardSurface>

        <View style={{ height: theme.spacing.lg }} />

        {committed ? (
          <Hint text={playText.battleship.waitingCommit} />
        ) : (
          <View style={{ gap: theme.spacing.md }}>
            <ChipRow
              options={FLEET.map((_, index) => index)}
              value={selected}
              onChange={setSelected}
              labelFor={(index) => playText.battleship.ships[index] ?? ''}
            />
            <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
              <Button
                title={playText.battleship.rotate}
                variant="secondary"
                style={{ flex: 1 }}
                onPress={() => {
                  const next = rotateShip(ships, selected);
                  if (next) setDraft(next);
                  else haptic('warning');
                }}
              />
              <Button
                title={playText.battleship.randomise}
                variant="secondary"
                style={{ flex: 1 }}
                onPress={() => setDraft(randomFleet())}
              />
            </View>
            <Button
              title={playText.battleship.ready}
              onPress={() => {
                const salt = freshSalt();
                const fleet = { ships: [...ships], salt };
                save(fleet);
                dispatch('place', { commitment: [...fleetCommitment(fleet.ships, salt)] });
              }}
              disabled={!live || ships.length !== FLEET.length}
              disabledReason={live ? undefined : playText.room.waitingForLink}
            />
          </View>
        )}
      </View>
    );
  }

  // -- the fleet this device has forgotten ----------------------------------

  if (!secret && !loading) {
    // Honest rather than broken: without the layout this phone cannot answer a
    // shot, and pretending otherwise would fail the audit and look like cheating.
    return (
      <View>
        <Label variant="title2">{playText.battleship.lostFleetTitle}</Label>
        <Label variant="subheadline" tone="secondary" style={{ marginTop: theme.spacing.xs }}>
          {playText.battleship.lostFleetBody}
        </Label>
      </View>
    );
  }

  // -- reveal ---------------------------------------------------------------

  if (state.phase === BattleshipPhase.REVEAL || state.phase === BattleshipPhase.FINISHED) {
    const revealed = state.reveals[seat] !== null;
    return (
      <View>
        <PlayerBar
          players={players}
          local={local}
          turn={null}
          nameFor={nameFor}
          scoreFor={(player) => sunkCount(state.shots[players.indexOf(player) === 1 ? 1 : 0] ?? [])}
        />
        <View style={{ height: theme.spacing.lg }} />
        <Label variant="title2" align="center">
          {playText.battleship.auditing}
        </Label>
        <View style={{ height: theme.spacing.md }} />
        {state.cheated[foe] === true ? <Hint text={playText.battleship.cheated} tone="secondary" /> : null}
        {revealed || !secret ? (
          <Hint text={playText.battleship.revealSent} />
        ) : (
          <Button
            title={playText.battleship.reveal}
            onPress={() => dispatch('reveal', { ships: secret.ships.map((s) => ({ ...s })), salt: [...secret.salt] })}
            disabled={!live}
            disabledReason={live ? undefined : playText.room.waitingForLink}
          />
        )}
      </View>
    );
  }

  // -- firing ---------------------------------------------------------------

  const myTurn = turn === local && state.pending === null;

  return (
    <View>
      <PlayerBar
        players={players}
        local={local}
        turn={turn}
        nameFor={nameFor}
        captionFor={(player) => {
          const index = players.indexOf(player) === 1 ? 1 : 0;
          return playText.battleship.fleetLeft(FLEET.length - sunkCount(state.shots[index] ?? []));
        }}
      />

      <View style={{ height: theme.spacing.lg }} />

      <Label variant="caption" tone="tertiary">
        {playText.battleship.theirWaters.toUpperCase()}
      </Label>
      <View style={{ height: theme.spacing.sm }} />
      <BoardSurface size={grid} padded={false}>
        <Sea
          size={cell}
          label={playText.battleship.theirWaters}
          cellState={(index) => {
            const shot = shotAt(theirShots, index);
            if (!shot) return 'water';
            return shot.sunk !== null ? 'sunk' : shot.hit ? 'hit' : 'miss';
          }}
          describe={(index) => {
            const shot = shotAt(theirShots, index);
            const outcome = !shot
              ? ''
              : shot.sunk !== null
              ? playText.battleship.sunk(playText.battleship.ships[shot.sunk] ?? '')
              : shot.hit
              ? playText.battleship.hit
              : playText.battleship.miss;
            return `${playText.battleship.fireAt(cellName(index))}${outcome ? `, ${outcome}` : ''}`;
          }}
          onPress={
            myTurn && live
              ? (index) => {
                  if (shotAt(theirShots, index)) return;
                  haptic('impactLight');
                  dispatch('fire', { cell: index });
                }
              : undefined
          }
        />
      </BoardSurface>

      <View style={{ height: theme.spacing.lg }} />

      <Label variant="caption" tone="tertiary">
        {playText.battleship.yourWaters.toUpperCase()}
      </Label>
      <View style={{ height: theme.spacing.sm }} />
      <BoardSurface size={grid} padded={false}>
        <Sea
          size={cell}
          label={playText.battleship.yourWaters}
          cellState={(index) => {
            const shot = shotAt(myShots, index);
            if (shot) return shot.sunk !== null ? 'sunk' : shot.hit ? 'hit' : 'miss';
            return myCells.has(index) ? 'ship' : 'water';
          }}
          describe={(index) => {
            const shot = shotAt(myShots, index);
            if (shot) {
              const outcome =
                shot.sunk !== null
                  ? playText.battleship.sunk(playText.battleship.ships[shot.sunk] ?? '')
                  : shot.hit
                  ? playText.battleship.hit
                  : playText.battleship.miss;
              return `${cellName(index)}, ${outcome}`;
            }
            const ship = myCells.get(index);
            return ship === undefined
              ? cellName(index)
              : `${cellName(index)}, ${playText.battleship.ships[ship] ?? ''}`;
          }}
        />
      </BoardSurface>

      <Hint text={myTurn ? playText.battleship.fireHint : playText.room.notYourTurn} />
    </View>
  );
}

type SeaCell = 'water' | 'ship' | 'selectedShip' | 'hit' | 'miss' | 'sunk';

/** Ten by ten. One component, two grids, no duplicated geometry. */
function Sea({
  size,
  label,
  cellState,
  describe,
  onPress,
}: {
  size: number;
  label: string;
  cellState: (index: number) => SeaCell;
  describe: (index: number) => string;
  onPress?: (index: number) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const fill: Record<SeaCell, string> = {
    water: theme.colors.surfaceElevated,
    ship: theme.colors.textSecondary,
    selectedShip: theme.colors.accent,
    hit: theme.colors.danger,
    miss: theme.colors.textTertiary,
    sunk: theme.colors.text,
  };

  return (
    <View
      accessibilityLabel={label}
      style={{ width: size * SEA_SIZE, height: size * SEA_SIZE, flexDirection: 'row', flexWrap: 'wrap' }}
    >
      {Array.from({ length: SEA_SIZE * SEA_SIZE }, (_, index) => {
        const kind = cellState(index);
        return (
          <Cell
            key={index}
            size={size}
            onPress={onPress ? () => onPress(index) : undefined}
            accessibilityLabel={describe(index)}
            // A single point of gutter: the grid is ten squares across a phone,
            // so anything from the spacing scale would leave no square at all.
            style={{ padding: GUTTER }}
          >
            <View
              style={{
                flex: 1,
                alignSelf: 'stretch',
                borderRadius: CELL_RADIUS,
                backgroundColor: fill[kind],
                opacity: kind === 'miss' ? 0.4 : 1,
              }}
            />
          </Cell>
        );
      })}
    </View>
  );
}

/** "C4" - a square in the words people use out loud. */
function cellName(index: number): string {
  const row = Math.floor(index / SEA_SIZE);
  const col = index % SEA_SIZE;
  return `${String.fromCharCode(65 + row)}${col + 1}`;
}

/** Put the selected ship's anchor on a square, if the fleet still fits. */
function anchorTo(ships: readonly Ship[], index: number, cell: number): Ship[] | null {
  const target = ships[index];
  if (!target) return null;
  const next = [...ships];
  next[index] = { ...target, row: Math.floor(cell / SEA_SIZE), col: cell % SEA_SIZE };
  const cells = new Set<number>();
  for (const ship of next) {
    const occupied = shipCells(ship);
    if (!occupied) return null;
    for (const c of occupied) {
      if (cells.has(c)) return null;
      cells.add(c);
    }
  }
  return next;
}
