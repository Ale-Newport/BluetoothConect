/**
 * Anti-replay sliding window, following the algorithm in RFC 6479 (the one IPsec
 * uses). Sequence numbers may arrive out of order within the window; anything
 * older than the window, or already seen, is rejected.
 *
 * Implemented over a bitmap of 32-bit words so it stays allocation-free on the
 * receive hot path.
 */
export class ReplayWindow {
  private readonly bitmap: Uint32Array;
  private readonly windowSize: number;
  private highest = 0;
  private seenAny = false;

  constructor(windowSize = 1024) {
    if (windowSize < 32 || windowSize % 32 !== 0) throw new Error('ReplayWindow: size must be a multiple of 32, >= 32');
    this.windowSize = windowSize;
    this.bitmap = new Uint32Array(windowSize / 32);
  }

  /** Highest accepted sequence number so far. */
  get highestSeen(): number {
    return this.highest;
  }

  /** True if `seq` has already been accepted, or is too old to judge. */
  isReplay(seq: number): boolean {
    if (!Number.isSafeInteger(seq) || seq < 0) return true;
    if (!this.seenAny) return false;
    if (seq > this.highest) return false;
    if (seq + this.windowSize <= this.highest) return true; // too old
    return this.getBit(seq);
  }

  /**
   * Record `seq` as accepted. Returns false if it was a replay (in which case
   * nothing is recorded and the caller must drop the packet).
   */
  accept(seq: number): boolean {
    if (this.isReplay(seq)) return false;

    if (!this.seenAny) {
      this.seenAny = true;
      this.highest = seq;
      this.setBit(seq);
      return true;
    }

    if (seq > this.highest) {
      const advance = seq - this.highest;
      if (advance >= this.windowSize) {
        this.bitmap.fill(0);
      } else {
        // Clear the bits for the sequence numbers we are sliding past.
        for (let s = this.highest + 1; s <= seq; s++) this.clearBit(s);
      }
      this.highest = seq;
    }
    this.setBit(seq);
    return true;
  }

  private index(seq: number): number {
    return seq % this.windowSize;
  }

  private getBit(seq: number): boolean {
    const i = this.index(seq);
    return ((this.bitmap[i >>> 5] as number) & (1 << (i & 31))) !== 0;
  }

  private setBit(seq: number): void {
    const i = this.index(seq);
    this.bitmap[i >>> 5] = (this.bitmap[i >>> 5] as number) | (1 << (i & 31));
  }

  private clearBit(seq: number): void {
    const i = this.index(seq);
    this.bitmap[i >>> 5] = (this.bitmap[i >>> 5] as number) & ~(1 << (i & 31));
  }

  reset(): void {
    this.bitmap.fill(0);
    this.highest = 0;
    this.seenAny = false;
  }
}
