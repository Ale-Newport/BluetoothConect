/**
 * Injectable clock + timer abstraction.
 *
 * Every timeout, retry and scheduler in the core goes through this interface so
 * that tests can run a whole multi-peer session deterministically and instantly
 * with a virtual clock. Nothing in `packages/core` may call `Date.now()`,
 * `setTimeout` or `setInterval` directly.
 */
export interface Clock {
  /** Monotonic-ish milliseconds since an arbitrary epoch. Used for durations. */
  now(): number;
  /** Wall-clock milliseconds since the Unix epoch. Used for message timestamps. */
  wallNow(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

export type TimerHandle = { readonly __timer: unique symbol } | number | object;

/**
 * Optional globals this package uses when present.
 *
 * Declared by probing rather than by importing a lib, so `@airlink/core` makes
 * no assumption about whether a consumer's tsconfig includes dom, node or
 * neither - React Native's includes neither.
 */
interface OptionalGlobals {
  performance?: { now(): number };
  queueMicrotask?: (fn: () => void) => void;
}
const optional = globalThis as unknown as OptionalGlobals;

export const systemClock: Clock = {
  // A monotonic source where one exists: Date.now() jumps when the user or the
  // network changes the wall clock, and a jump backwards would make every
  // measured duration and timeout nonsense.
  now: () => (typeof optional.performance?.now === 'function' ? optional.performance.now() : Date.now()),
  wallNow: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as TimerHandle,
  clearTimeout: (h) => clearTimeout(h as unknown as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms) as unknown as TimerHandle,
  clearInterval: (h) => clearInterval(h as unknown as ReturnType<typeof setInterval>),
};

interface ScheduledTask {
  id: number;
  fireAt: number;
  fn: () => void;
  intervalMs: number | null;
  cancelled: boolean;
}

/**
 * Deterministic virtual clock. `advance(ms)` fires every task due in that window
 * in correct chronological order, including tasks scheduled by other tasks.
 */
export class VirtualClock implements Clock {
  private current: number;
  private readonly wallEpoch: number;
  private nextId = 1;
  private tasks: ScheduledTask[] = [];

  constructor(startMs = 0, wallEpochMs = 1_700_000_000_000) {
    this.current = startMs;
    this.wallEpoch = wallEpochMs;
  }

  now(): number {
    return this.current;
  }

  wallNow(): number {
    // Date.now() yields whole milliseconds; the virtual clock must too, or test
    // runs would exercise a value shape that cannot occur in production.
    return Math.floor(this.wallEpoch + this.current);
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const task: ScheduledTask = {
      id: this.nextId++,
      fireAt: this.current + Math.max(0, ms),
      fn,
      intervalMs: null,
      cancelled: false,
    };
    this.tasks.push(task);
    return task;
  }

  clearTimeout(handle: TimerHandle): void {
    const task = handle as ScheduledTask;
    if (task && typeof task === 'object' && 'cancelled' in task) task.cancelled = true;
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const period = Math.max(1, ms);
    const task: ScheduledTask = {
      id: this.nextId++,
      fireAt: this.current + period,
      fn,
      intervalMs: period,
      cancelled: false,
    };
    this.tasks.push(task);
    return task;
  }

  clearInterval(handle: TimerHandle): void {
    this.clearTimeout(handle);
  }

  /** Number of live (non-cancelled) timers. Useful to assert clean teardown. */
  get pendingTimers(): number {
    return this.tasks.filter((t) => !t.cancelled).length;
  }

  /**
   * Advance the virtual clock, firing due callbacks in order. Bounded so a
   * self-rescheduling zero-delay timer cannot hang a test.
   */
  advance(ms: number): void {
    const target = this.current + ms;
    let guard = 0;
    for (;;) {
      if (++guard > 1_000_000) throw new Error('VirtualClock.advance: timer storm (>1e6 callbacks)');
      let next: ScheduledTask | undefined;
      for (const t of this.tasks) {
        if (t.cancelled || t.fireAt > target) continue;
        if (!next || t.fireAt < next.fireAt || (t.fireAt === next.fireAt && t.id < next.id)) next = t;
      }
      if (!next) break;
      this.current = next.fireAt;
      if (next.intervalMs === null) {
        next.cancelled = true;
      } else {
        next.fireAt = this.current + next.intervalMs;
      }
      this.tasks = this.tasks.filter((t) => !t.cancelled);
      next.fn();
    }
    this.current = target;
    this.tasks = this.tasks.filter((t) => !t.cancelled);
  }

  /** Advance the clock and flush the microtask queue between ticks. */
  async advanceAsync(ms: number, stepMs = 5): Promise<void> {
    let left = ms;
    while (left > 0) {
      const step = Math.min(stepMs, left);
      this.advance(step);
      left -= step;
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        if (optional.queueMicrotask) optional.queueMicrotask(resolve);
        else void Promise.resolve().then(resolve);
      });
    }
  }
}
