/**
 * The connect sheet must not tell somebody they failed when they did not.
 *
 * THE BUG THIS EXISTS FOR, seen on two simulators pairing for the first time.
 * Both phones showed the same six digits, both people tapped "They match", the
 * session came up - and both sheets then said "Couldn't connect" on top of a
 * home screen that said Connected · Excellent.
 *
 * The cause was a deadline applied to the wrong thing. "Securing" is given
 * twenty seconds on the honest reasoning that a handshake over an open link is
 * quick or it is broken. But PAIRING is not a handshake: it is waiting for a
 * person to pick up the other phone, read six digits off it, and tap a button
 * on both. That is easily more than twenty seconds the first time anybody does
 * it, so the sheet was timing out on the human rather than on the protocol.
 *
 * It matters beyond tidiness. An App Review tester pairs two devices as the
 * very first thing they do, and "Couldn't connect" at that moment reads as an
 * app that does not work - a guideline 2.1 rejection earned by a timer.
 *
 * `PeerSession` keeps its own 120s pairing timeout, so a pairing that really
 * does stall is still reported, by the layer that actually knows.
 */
import { ConnectionState } from '@airlink/core';
import { deadlineFor } from '../src/screens/home/ConnectSheet.js';

test('waiting for a person to compare six digits has no deadline at all', () => {
  // The regression, stated directly: this returned 20_000 and the sheet failed.
  expect(deadlineFor('securing', ConnectionState.PAIRING)).toBeNull();
});

test('a link that never opens still has one', () => {
  // A genuinely dead radio must not spin for ever.
  expect(deadlineFor('connecting', ConnectionState.CONNECTING)).toBeGreaterThan(0);
});

test('a handshake that stalls on an open link still has one', () => {
  expect(deadlineFor('securing', ConnectionState.AUTHENTICATING)).toBeGreaterThan(0);
  expect(deadlineFor('securing', ConnectionState.NEGOTIATING_TRANSPORT)).toBeGreaterThan(0);
});

test('opening a link is given longer than securing one', () => {
  // The transport gives itself 20s to open a link, so this must outlast it or
  // the sheet pre-empts an answer the radio was about to give.
  const connecting = deadlineFor('connecting', ConnectionState.CONNECTING);
  const securing = deadlineFor('securing', ConnectionState.AUTHENTICATING);
  expect(connecting).not.toBeNull();
  expect(securing).not.toBeNull();
  expect(connecting as number).toBeGreaterThan(securing as number);
  expect(connecting as number).toBeGreaterThan(20_000);
});

test('a settled sheet is never on a clock', () => {
  // Nothing to time out: these are endings, not waits.
  for (const connection of [undefined, ConnectionState.CONNECTED, ConnectionState.FAILED]) {
    expect(deadlineFor('idle', connection)).toBeNull();
    expect(deadlineFor('connected', connection)).toBeNull();
    expect(deadlineFor('failed', connection)).toBeNull();
  }
});

test('pairing is the ONLY state that escapes the clock', () => {
  // Stated as an exhaustive sweep so that a new connection state added later
  // inherits a deadline by default rather than silently escaping one - the
  // permissive direction is the one that produces a spinner nobody can leave.
  const timed = [
    ConnectionState.CONNECTING,
    ConnectionState.AUTHENTICATING,
    ConnectionState.NEGOTIATING_TRANSPORT,
  ];
  for (const connection of timed) {
    expect(deadlineFor('securing', connection)).not.toBeNull();
  }
  expect(deadlineFor('securing', ConnectionState.PAIRING)).toBeNull();
});
