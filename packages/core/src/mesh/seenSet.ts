/**
 * The bounded seen-set: the single thing that stops a flood from becoming a
 * broadcast storm.
 *
 * Forwarding in this mesh is controlled flooding - a relay sends a packet on to
 * every neighbour it did not come from. In a triangle, or any topology with a
 * cycle, that packet comes straight back. What terminates the flood is that
 * every device remembers the packets it has already handled and refuses them
 * the second time.
 *
 * "Remembers" is the dangerous word. A peer can make us remember things, so the
 * memory is bounded on both axes:
 *
 *  - CAPACITY. At most `capacity` entries, ever. When full, the oldest entry is
 *    evicted. A `Map` preserves insertion order, so "oldest" is the first key
 *    and eviction is O(1) rather than a scan.
 *  - AGE. Entries expire after `ttlMs`. Because insertion order is also
 *    chronological order (the clock is monotonic), everything expired is at the
 *    front, so a purge stops at the first live entry instead of scanning.
 *
 * Forgetting a packet id is safe: the worst case is that a very old duplicate
 * is delivered twice, which is why the TTL is minutes rather than seconds and
 * far longer than any flood can possibly still be in flight.
 */
import type { Clock } from '../util/time.js';

export class SeenSet {
  /** key -> the clock reading at which it was added. Insertion order = age order. */
  private readonly entries = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly capacity: number,
    private readonly ttlMs: number,
  ) {
    if (capacity < 1) throw new Error('SeenSet: capacity must be at least 1');
  }

  /**
   * Record a key and report whether it was already present.
   *
   * Test-and-set in one call on purpose: a caller that checked and then added
   * would have a window in which a re-entrant delivery slipped through, and
   * re-entrant delivery is exactly what a flood produces.
   */
  add(key: string): boolean {
    const now = this.clock.now();
    this.purge(now);

    const at = this.entries.get(key);
    if (at !== undefined) {
      // Refresh nothing: keeping the original timestamp means a peer cannot pin
      // an entry in memory forever by re-sending it.
      return true;
    }

    while (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    this.entries.set(key, now);
    return false;
  }

  /** Read-only test. Does not extend an entry's life. */
  has(key: string): boolean {
    const at = this.entries.get(key);
    if (at === undefined) return false;
    return this.clock.now() - at <= this.ttlMs;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }

  /** Drop the expired prefix. Bounded by the number of entries actually expired. */
  private purge(now: number): void {
    for (const [key, at] of this.entries) {
      if (now - at <= this.ttlMs) return;
      this.entries.delete(key);
    }
  }
}

/**
 * The dedup key for a relayed packet.
 *
 * Scoped by origin so one member cannot silence another by guessing message ids
 * and claiming them first: a collision only matters within a single sender's
 * own stream. The separator is not in the identifier alphabet, so no pair of
 * (origin, id) values can be made to collide by splitting the string elsewhere.
 */
export function seenKey(originId: string, messageId: string): string {
  return `${originId}/${messageId}`;
}
