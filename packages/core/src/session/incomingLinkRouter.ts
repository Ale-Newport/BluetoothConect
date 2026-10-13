/**
 * Decides which session an incoming link belongs to - from what it says.
 *
 * THE BUG THIS REPLACES. An inbound link used to be handed to the FIRST
 * established session that was disconnected, before a single byte of it had
 * been read:
 *
 *     if (sameEndpoint || sessionIsReconnecting) session.migrateToLink(link)
 *
 * "Is somebody disconnected?" is a fact about US. It says nothing about who has
 * just connected. So whoever dialled - a stranger, a friend whose session we no
 * longer hold, a developer's Mac that merely subscribed to see what happens -
 * was attached to an old session with somebody else, which promptly started
 * pushing that other person's encrypted frames at them. And the stranger's own
 * hello went to a session that had already finished its handshake, which
 * ignores a hello ("handshake frame after the handshake completed") and so
 * answers nothing. From their side: a peer that appears in the list, accepts the
 * connection, and never says a word. From ours: "Connected".
 *
 * It was found by pointing a real iPhone at a Mac pretending to be a second
 * AirLink phone: the Mac subscribed, owed the iPhone no session at all, and the
 * iPhone began transmitting a stranger's session counters at it.
 *
 * THE RULE NOW. Every secure frame names its session in the clear (eight bytes
 * after the header) and a hello says it is one. So the first datagram that
 * carries either settles it:
 *
 *   - a frame naming a session we hold  -> that session resumes on this link,
 *   - a hello                           -> a new responder, as for any stranger,
 *   - a frame naming a session we DON'T -> close the link: nobody here can use
 *                                          it, and a closed link tells the other
 *                                          side so at once instead of waiting
 *                                          out a liveness timer,
 *   - nothing decisive in a while       -> close it as well.
 *
 * Whatever arrived while deciding is buffered and replayed into the chosen
 * session, so nothing the other side said is lost to the deliberation.
 *
 * Generic over the session type so this layer depends on neither the app's
 * handle nor on PeerSession itself, and can be tested with real ones.
 */
import { peekFrame } from '../protocol/frame.js';
import type { Link } from '../transport/types.js';
import { LinkState } from '../transport/types.js';
import type { Clock, TimerHandle } from '../util/time.js';

export interface IncomingLinkRouterOptions<S> {
  readonly clock: Clock;
  /** Established sessions, whatever state they are in. Read afresh for each link. */
  readonly sessions: () => Iterable<S>;
  /** Does this session hold the session whose id the frame names? */
  readonly owns: (session: S, sessionId: Uint8Array) => boolean;
  /** A known session resumes on this link. */
  readonly resume: (session: S, link: Link) => void;
  /** Somebody new: start a responder on this link. */
  readonly introduce: (link: Link) => void;
  /** Called with a reason when a link is turned away. For logging. */
  readonly onTurnedAway?: (reason: string, link: Link) => void;
  /** How long to wait for a datagram that says who this is. */
  readonly decisionTimeoutMs?: number;
  /** Bounds on what a link that has said nothing useful can make us hold. */
  readonly maxBufferedDatagrams?: number;
  readonly maxBufferedBytes?: number;
}

/**
 * Long enough for a resumed session's first sign of life on a link: a peer that
 * has just migrated speaks at once, but an older build waits for its keepalive
 * (five seconds), and a Bluetooth link may take a while to deliver it.
 */
export const DEFAULT_DECISION_TIMEOUT_MS = 15_000;

export class IncomingLinkRouter<S> {
  private readonly pending = new Set<() => void>();

  constructor(private readonly options: IncomingLinkRouterOptions<S>) {}

  /**
   * Take responsibility for an incoming link. Must be called SYNCHRONOUSLY from
   * the transport's `incomingLink` event: the listener is attached before the
   * event returns, so no datagram can arrive unheard.
   */
  accept(link: Link): void {
    const { clock } = this.options;
    const maxDatagrams = this.options.maxBufferedDatagrams ?? 32;
    const maxBytes = this.options.maxBufferedBytes ?? 64 * 1024;

    const buffered: Uint8Array[] = [];
    let bufferedBytes = 0;
    let settled = false;
    let timer: TimerHandle | undefined;

    const stopListening: (() => void)[] = [];
    const cleanup = (): void => {
      settled = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      for (const off of stopListening.splice(0)) off();
      this.pending.delete(abandon);
    };
    const turnAway = (reason: string): void => {
      cleanup();
      this.options.onTurnedAway?.(reason, link);
      void link.close(reason).catch(() => undefined);
    };
    // Called by `dispose`, so a router that is torn down does not leave links
    // open and timers running.
    const abandon = (): void => {
      if (!settled) turnAway('router disposed');
    };
    this.pending.add(abandon);

    /** Hand the link to its session, then give that session what it missed. */
    const settle = (attach: () => void): void => {
      cleanup();
      try {
        attach();
      } catch (err) {
        this.options.onTurnedAway?.(`attach failed: ${String(err)}`, link);
        void link.close('attach failed').catch(() => undefined);
        return;
      }
      for (const bytes of buffered) link.events.emit('data', { bytes });
    };

    stopListening.push(
      link.events.on('data', ({ bytes }) => {
        if (settled) return;

        buffered.push(bytes);
        bufferedBytes += bytes.length;
        if (buffered.length > maxDatagrams || bufferedBytes > maxBytes) {
          turnAway('too much said without saying who it was');
          return;
        }

        const peek = peekFrame(bytes);
        if (peek.kind === 'handshake') {
          settle(() => this.options.introduce(link));
          return;
        }
        if (peek.kind === 'secure') {
          const known = this.find(peek.sessionId);
          if (known) {
            settle(() => this.options.resume(known.session, link));
          } else {
            turnAway('names a session we do not hold');
          }
        }
        // 'undecided' and 'unreadable' say nothing yet: keep listening.
      }),
      link.events.on('state', ({ state }) => {
        if (settled) return;
        if (state === LinkState.CLOSED || state === LinkState.FAILED) {
          cleanup();
          this.options.onTurnedAway?.('link closed before it said who it was', link);
        }
      }),
    );

    timer = clock.setTimeout(() => {
      if (!settled) turnAway('said nothing that identifies it');
    }, this.options.decisionTimeoutMs ?? DEFAULT_DECISION_TIMEOUT_MS);
  }

  /** Close every link still being decided. For teardown and for tests. */
  dispose(): void {
    for (const abandon of [...this.pending]) abandon();
  }

  private find(sessionId: Uint8Array): { session: S } | null {
    for (const session of this.options.sessions()) {
      if (this.options.owns(session, sessionId)) return { session };
    }
    return null;
  }
}
