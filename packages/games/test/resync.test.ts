/**
 * What happens to a game when one move goes missing.
 *
 * The answer used to be: it jams, silently, for ever. Per-player sequence
 * numbers give an action exactly-once semantics, and a gap in them makes every
 * LATER action out of order too - so a guest that missed one move rejected
 * everything that followed while showing a board that looked perfectly healthy.
 * Worse, the repair did not repair: a host snapshot replaced the board and left
 * the counters exactly where they were, so the position was corrected and the
 * game was still dead.
 */
import { describe, expect, it } from 'vitest';
import { GameSession, RejectionReason } from '../src/runtime.js';
import { ticTacToe } from '../src/games/ticTacToe.js';
import { GameStatusKind } from '../src/engine.js';
import { connectFour } from '../src/games/connectFour.js';

const PLAYERS = ['host', 'guest'];

/**
 * Narrow an outcome to its accepted branch, failing the test if it was not.
 *
 * `ActionOutcome` is a discriminated union on purpose - a rejection carries a
 * reason and no action - so a test that wants the action has to say why it is
 * entitled to one.
 */
function applied<T extends { accepted: boolean }>(
  outcome: T,
): Extract<T, { accepted: true }> extends { applied: infer A } ? A : never {
  expect(outcome.accepted).toBe(true);
  return (outcome as unknown as { applied: never }).applied;
}

/** The rejection reason, or undefined when the outcome was accepted. */
function reasonOf(outcome: { accepted: boolean }): string | undefined {
  return (outcome as { reason?: string }).reason;
}

function pair() {
  const setup = { players: PLAYERS, seed: 1234, options: {} };
  const host = new GameSession({ definition: ticTacToe, setup, localPlayer: 'host', isHost: true });
  const guest = new GameSession({ definition: ticTacToe, setup, localPlayer: 'guest', isHost: false });
  return { host, guest };
}

describe('state version', () => {
  it('counts up by one for every action, on both devices', () => {
    const { host, guest } = pair();
    expect(host.stateVersion).toBe(0);

    const move = host.submitLocal('place', { cell: 0 });
    expect(move.accepted).toBe(true);
    expect(host.stateVersion).toBe(1);

    guest.applyRemote(host.encode(applied(move).action), 'host');
    expect(guest.stateVersion).toBe(1);
  });
});

describe('a missed move', () => {
  /**
   * An action that arrives with a gap in front of it.
   *
   * Written as a raw wire value on purpose: the point is the SEQUENCING, and
   * hand-building the frame is the only way to reproduce "seq 1 arrived and
   * seq 0 never did" without also modelling a whole lossy link. Games where a
   * player legitimately acts several times in a row - drawing a stroke,
   * throwing a dart, answering a question - hit this in the ordinary course of
   * play the moment one frame is dropped.
   */
  const placeWithSeq = (cell: number, seq: number) => ({ t: 'place', s: seq, p: { c: cell } });

  it('jams every later move, which is why it has to be noticed', () => {
    const { guest } = pair();

    // The host's first move never arrived; its second one has.
    const outcome = guest.applyRemote(placeWithSeq(1, 1) as never, 'host');
    expect(outcome.accepted).toBe(false);
    expect(reasonOf(outcome)).toBe(RejectionReason.OUT_OF_ORDER);

    // And it stays jammed: nothing that follows can ever be applied either.
    expect(reasonOf(guest.applyRemote(placeWithSeq(2, 2) as never, 'host'))).toBe(RejectionReason.OUT_OF_ORDER);
    expect(guest.stateVersion).toBe(0);
  });

  it('is repaired completely by a snapshot envelope, counters and all', () => {
    const { host, guest } = pair();

    // The host has played, the guest has missed it, and is now stuck.
    const first = host.submitLocal('place', { cell: 0 });
    expect(first.accepted).toBe(true);
    expect(guest.applyRemote(placeWithSeq(1, 1) as never, 'host').accepted).toBe(false);

    // The guest asks; the host answers with everything, not just the board.
    expect(guest.applySnapshotEnvelope(host.snapshotEnvelope())).toBe(true);
    expect(guest.stateVersion).toBe(host.stateVersion);
    expect(guest.currentState.board).toEqual(host.currentState.board);

    // And - the part that used to be missing - the game carries on. The guest
    // can move, and the host accepts it.
    const reply = guest.submitLocal('place', { cell: 4 });
    expect(reply.accepted).toBe(true);
    expect(host.applyRemote(guest.encode(applied(reply).action), 'guest').accepted).toBe(true);
    expect(guest.currentState.board).toEqual(host.currentState.board);
  });

  it('lets the repaired guest move again without being called a duplicate', () => {
    const { host, guest } = pair();
    host.submitLocal('place', { cell: 0 });
    guest.applySnapshotEnvelope(host.snapshotEnvelope());

    const reply = guest.submitLocal('place', { cell: 4 });
    expect(reply.accepted).toBe(true);
    expect(host.applyRemote(guest.encode(applied(reply).action), 'guest').accepted).toBe(true);
  });

  it('ignores a host snapshot older than one it has already taken', () => {
    const { host, guest } = pair();
    const stale = host.snapshotEnvelope();

    host.submitLocal('place', { cell: 0 });
    expect(guest.applySnapshotEnvelope(host.snapshotEnvelope())).toBe(true);
    expect(guest.stateVersion).toBe(1);

    // A late answer to a question already resolved must not rewind the board.
    expect(guest.applySnapshotEnvelope(stale)).toBe(false);
    expect(guest.stateVersion).toBe(1);
  });

  it('still accepts a repair when the guest is AHEAD by its own count', () => {
    /*
     * The case that makes comparing the two counters unsound. A guest whose
     * own moves never reached the host has applied more actions than the host
     * has - so it is ahead by number and wrong about the board at the same
     * time. It is exactly the device that most needs the repair.
     */
    const setup = { players: PLAYERS, seed: 7, options: {} };
    const host = new GameSession({ definition: ticTacToe, setup, localPlayer: 'host', isHost: true });
    const guest = new GameSession({ definition: ticTacToe, setup, localPlayer: 'guest', isHost: false });

    const hostMove = host.submitLocal('place', { cell: 0 });
    guest.applyRemote(host.encode(applied(hostMove).action), 'host');
    const lost = guest.submitLocal('place', { cell: 8 });
    expect(lost.accepted).toBe(true);
    expect(guest.stateVersion).toBe(2);
    expect(host.stateVersion).toBe(1); // the host never heard it

    expect(guest.applySnapshotEnvelope(host.snapshotEnvelope())).toBe(true);
    expect(guest.snapshot()).toEqual(host.snapshot());
  });

  it('never lets a guest correct the host', () => {
    const { host, guest } = pair();
    expect(host.applySnapshotEnvelope(guest.snapshotEnvelope())).toBe(false);
  });
});

describe('a long game under repeated loss', () => {
  it('converges every time, in a game with more moves to lose', () => {
    const setup = { players: PLAYERS, seed: 99, options: {} };
    const host = new GameSession({ definition: connectFour, setup, localPlayer: 'host', isHost: true });
    const guest = new GameSession({ definition: connectFour, setup, localPlayer: 'guest', isHost: false });

    // A deterministic "link" that swallows every third frame.
    let frame = 0;
    const send = (from: GameSession<never, never>, to: GameSession<never, never>, encoded: unknown): void => {
      frame += 1;
      if (frame % 3 === 0) return; // lost
      const outcome = to.applyRemote(encoded as never, from === host ? 'host' : 'guest');
      if (!outcome.accepted && reasonOf(outcome) === RejectionReason.OUT_OF_ORDER && to === guest) {
        guest.applySnapshotEnvelope(host.snapshotEnvelope());
      }
    };

    for (let turn = 0; turn < 12 && !host.isOver; turn++) {
      const mover = turn % 2 === 0 ? host : guest;
      const other = mover === host ? guest : host;
      const column = turn % 7;
      const outcome = mover.submitLocal('drop', { column });
      if (!outcome.accepted) {
        // The mover is behind; catch it up the way the app does.
        if (mover === guest) guest.applySnapshotEnvelope(host.snapshotEnvelope());
        continue;
      }
      send(mover as never, other as never, mover.encode(applied(outcome).action));
    }

    // Whatever the link did, one resync brings the two boards together.
    guest.applySnapshotEnvelope(host.snapshotEnvelope());
    expect(guest.stateVersion).toBe(host.stateVersion);
    expect(guest.snapshot()).toEqual(host.snapshot());
  });
});

describe('a move that was never sent', () => {
  /**
   * The half of the problem the receiver cannot see.
   *
   * When an action is applied locally but never reaches the other phone -
   * because the session was unusable at that instant, or because the
   * reliability layer gave up after its eight attempts - nothing arrives out of
   * order on the far side. Nothing arrives at all. So the far side has no
   * reason to suspect anything, and the two boards stay a move apart with both
   * of them looking healthy. Only the sender knows, which is why the app now
   * watches its own sends and `deliveryFailed`.
   *
   * What the two devices must be able to do about it once they notice is the
   * part that lives here.
   */
  it('leaves the sender ahead and the receiver with no way to know', () => {
    const { host, guest } = pair();

    const move = host.submitLocal('place', { cell: 0 });
    expect(move.accepted).toBe(true);
    // The frame is dropped on the floor: `guest` is never told.
    expect(host.stateVersion).toBe(1);
    expect(guest.stateVersion).toBe(0);
    // And the guest's board is a perfectly legal, perfectly wrong position.
    expect(guest.status.kind).toBe('inProgress');
  });

  it('is repaired by the host publishing its board', () => {
    const { host, guest } = pair();
    host.submitLocal('place', { cell: 0 });

    expect(guest.applySnapshotEnvelope(host.snapshotEnvelope())).toBe(true);
    expect(guest.snapshot()).toEqual(host.snapshot());
  });

  it('reverts a guest whose own move never landed, which is the honest answer', () => {
    const { host, guest } = pair();

    const opening = host.submitLocal('place', { cell: 0 });
    guest.applyRemote(host.encode(applied(opening).action), 'host');

    // The guest replies, and the reply is lost for good.
    const lost = guest.submitLocal('place', { cell: 4 });
    expect(lost.accepted).toBe(true);
    expect(guest.stateVersion).toBe(2);
    expect(host.stateVersion).toBe(1);

    // Asking the host for the board takes that move back. It has to: as far as
    // the rest of the world is concerned it never happened, and a guest holding
    // a move nobody else has is the divergence, not the cure.
    expect(guest.applySnapshotEnvelope(host.snapshotEnvelope())).toBe(true);
    expect(guest.currentState.board[4]).toBe(0);
    expect(guest.snapshot()).toEqual(host.snapshot());

    // And it can play that move again, cleanly.
    const again = guest.submitLocal('place', { cell: 4 });
    expect(again.accepted).toBe(true);
    expect(host.applyRemote(guest.encode(applied(again).action), 'guest').accepted).toBe(true);
  });
});

describe('somebody leaves', () => {
  /**
   * `GameStatusKind.ABANDONED` has been in the engine's status union since the
   * beginning and nothing could produce it, because a status is a pure function
   * of the position and no game models "my opponent walked away" - quite
   * rightly, since that is not a fact about the board. So a game somebody left
   * never finished: its row sat on the resume shelf offering to pick up
   * something the other person had closed.
   */
  it('ends the game, on the session rather than in any reducer', () => {
    const { host, guest } = pair();
    host.submitLocal('place', { cell: 0 });
    expect(host.isOver).toBe(false);

    expect(guest.abandon('host')).toBe(true);
    expect(guest.isOver).toBe(true);
    expect(guest.status).toEqual({ kind: GameStatusKind.ABANDONED, by: 'host' });
    expect(guest.abandonedByPlayer).toBe('host');
  });

  it('refuses to overwrite a game that was actually won', () => {
    // A leave arriving just after the winning move must not turn a win into a
    // walkover - which is the whole reason `abandon` checks `isOver` first.
    const { host, guest } = pair();
    const play = (mover: typeof host, other: typeof host, cell: number): void => {
      const outcome = mover.submitLocal('place', { cell });
      other.applyRemote(mover.encode(applied(outcome).action), mover === host ? 'host' : 'guest');
    };
    play(host, guest, 0);
    play(guest, host, 3);
    play(host, guest, 1);
    play(guest, host, 4);
    play(host, guest, 2);

    expect(host.status.kind).toBe(GameStatusKind.WON);
    expect(host.abandon('guest')).toBe(false);
    expect(host.status.kind).toBe(GameStatusKind.WON);
  });

  it('refuses a player who is not in the game', () => {
    const { host } = pair();
    expect(host.abandon('mallory')).toBe(false);
    expect(host.isOver).toBe(false);
  });

  it('cannot be abandoned twice', () => {
    const { guest } = pair();
    expect(guest.abandon('host')).toBe(true);
    expect(guest.abandon('guest')).toBe(false);
    expect(guest.status).toEqual({ kind: GameStatusKind.ABANDONED, by: 'host' });
  });

  it('stops accepting moves once somebody has gone', () => {
    const { guest } = pair();
    guest.abandon('host');
    expect(guest.applyRemote({ t: 'place', s: 0, p: { c: 0 } } as never, 'host').accepted).toBe(false);
  });
});
