/**
 * Seeded randomness, so a fight can be replayed exactly and two builds can be
 * compared on the same luck.
 *
 * mulberry32: tiny, fast, and good enough for dice. `expect` mode is the
 * planner's: it never rolls, and callers that ask `chance` in that mode are
 * expected to use the probability as a weight instead (see `Rng.expect`).
 */
export class Rng {
  private s: number;
  /** True inside a planner rollout: roll nothing, weigh everything. */
  readonly expect: boolean;

  constructor(seed: number, expect = false) {
    this.s = seed >>> 0;
    this.expect = expect;
  }

  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** A roll against p in 0..1. Never call in expect mode; weigh by p instead. */
  chance(p: number): boolean {
    if (p >= 1) return true;
    if (p <= 0) return false;
    return this.next() < p;
  }

  /** Uniform in [lo, hi]. The midpoint in expect mode. */
  between(lo: number, hi: number): number {
    if (this.expect) return (lo + hi) / 2;
    return lo + (hi - lo) * this.next();
  }

  /** A fresh generator for iteration `i` of a batch, from one base seed. */
  static forIteration(seed: number, i: number): Rng {
    return new Rng((seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0);
  }
}
