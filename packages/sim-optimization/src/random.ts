/**
 * The optimization loop's deterministic PRNG (Phase 70a, law S2): a
 * self-owned splitmix32 generator — 32-bit integer state, integer-only
 * arithmetic, no `Math.random`, no clock, no environment. The choice is
 * pinned here so the whole NSGA-II loop is bitwise reproducible given the
 * study seed: splitmix32 is small enough to fully own, has excellent
 * statistical quality for its size (it is the scalar core of the
 * SplitMix/PCG family literature), and emits its full 2^32 period through
 * every one of its states — a u32 seed addresses the period exactly, with
 * no rejected draws and therefore no output-length side channel.
 *
 * Every consumer draws through this interface only; identical draw
 * sequences produce identical bits, and the unit interval mapping scales
 * the FULL u32 by 1/2^32 (exact in a double — 32 bits fit the 53-bit
 * mantissa) so grid quantization is exact for the power-of-two lattices
 * the genome decoder builds.
 */

/** The deterministic generator: a frozen u32 state and pure transitions. */
export interface SimOptimizationRandom {
  /** The next raw u32. */
  nextUint32(): number;
  /** The next unit-interval double, [0, 1) at full u32 resolution. */
  nextUnit(): number;
  /**
   * The next integer in [0, bound) for `bound >= 1` — a bounded draw with
   * no modulo bias correction needed beyond the 2^32 floor (the discrete
   * gene's choice counts are far below any bias horizon; stated, not
   * hidden).
   */
  nextInt(bound: number): number;
}

/** The splitmix32 constants (the published mixing triple). */
const GAMMA = 0x9e3779b1;

/** Builds a generator over the given u32 seed. */
export function createSimOptimizationRandom(
  seed: number,
): SimOptimizationRandom {
  let state = seed >>> 0;
  const nextUint32 = (): number => {
    state = (state + GAMMA) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
  return {
    nextUint32,
    nextUnit: (): number => nextUint32() / 0x1_0000_0000,
    nextInt: (bound: number): number => {
      if (!Number.isInteger(bound) || bound < 1) {
        throw new RangeError(
          `nextInt bound must be a positive integer, received ${String(bound)}.`,
        );
      }
      if (bound === 1) return 0;
      return Math.floor((nextUint32() / 0x1_0000_0000) * bound);
    },
  };
}
