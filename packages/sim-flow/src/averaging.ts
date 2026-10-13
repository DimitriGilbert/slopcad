/**
 * Post-hoc time averaging (Phase 63b, law S9's turbulence answer): a
 * resolved unsteady run is answered by MEAN + FLUCTUATION fields, never
 * by a turbulence model (no-RANS stands; honesty replaces it). This
 * module owns the deterministic second-moment accumulator the run
 * driver feeds during the averaging window: per node, Welford's
 * one-pass mean/variance over the window's snapshots, in the SAME
 * fixed row-major order every sample — so the accumulated moments are
 * bitwise-identical for identical snapshot sequences (law S2), with no
 * clock, no randomness, and no second pass over stored fields.
 *
 * The snapshots arrive in LATTICE units (the stepper's
 * `snapshotLattice()` velocities); the driver converts the finished
 * moments to SI once, at its own unit door — this module is pure
 * arithmetic over arrays and knows nothing of units.
 *
 * Variance is the POPULATION variance (M2/n): the window IS the whole
 * ensemble being reported, not a sample drawn from one. The fluctuation
 * field the driver emits is the RMS fluctuation, √Var, per component —
 * u′rms and v′rms, the standard turbulence-statistics pair.
 */

/** The finished moments of one averaging window (copies; caller owns them). */
export interface LbmFieldMoments {
  /** The number of accumulated snapshots (the window length). */
  readonly count: number;
  /** E[u_x] per node, lattice units (row-major `x + y·nx`). */
  readonly meanX: Float64Array;
  /** E[u_y] per node, lattice units. */
  readonly meanY: Float64Array;
  /** Var[u_x] per node, lattice units (population variance, M2/n). */
  readonly varianceX: Float64Array;
  /** Var[u_y] per node, lattice units. */
  readonly varianceY: Float64Array;
}

/**
 * The per-node second-moment accumulator: feed it one snapshot per
 * completed step inside the averaging window, read the moments once at
 * the end. Solid nodes accumulate whatever the snapshot carries (the
 * stepper's snapshots read exactly 0 there), which is the honest
 * column: the driver's mask-aware consumers skip them.
 */
export class LbmMomentAccumulator {
  readonly nx: number;
  readonly ny: number;
  private count = 0;
  private readonly meanX: Float64Array;
  private readonly meanY: Float64Array;
  private readonly m2X: Float64Array;
  private readonly m2Y: Float64Array;

  constructor(nx: number, ny: number) {
    if (!Number.isInteger(nx) || !Number.isInteger(ny) || nx < 1 || ny < 1) {
      throw new Error(
        `A moment accumulator needs positive integer extents, received ${String(nx)}×${String(ny)}.`,
      );
    }
    this.nx = nx;
    this.ny = ny;
    const cells = nx * ny;
    this.meanX = new Float64Array(cells);
    this.meanY = new Float64Array(cells);
    this.m2X = new Float64Array(cells);
    this.m2Y = new Float64Array(cells);
  }

  /** The number of accumulated snapshots so far. */
  get sampleCount(): number {
    return this.count;
  }

  /**
   * Accumulates one snapshot's velocity components. The traversal is
   * row-major, the additions are Welford's — the same sequence every
   * call, so identical windows produce bitwise-identical moments.
   */
  accumulate(velocityX: Float64Array, velocityY: Float64Array): void {
    const cells = this.nx * this.ny;
    if (velocityX.length !== cells || velocityY.length !== cells) {
      throw new Error(
        `A moment snapshot needs exactly ${String(cells)} values per component, received ${String(velocityX.length)}/${String(velocityY.length)}.`,
      );
    }
    this.count += 1;
    const n = this.count;
    for (let index = 0; index < cells; index += 1) {
      const x = velocityX[index] ?? 0;
      const y = velocityY[index] ?? 0;
      const meanXBefore = this.meanX[index] ?? 0;
      const meanYBefore = this.meanY[index] ?? 0;
      const deltaX = x - meanXBefore;
      const deltaY = y - meanYBefore;
      this.meanX[index] = meanXBefore + deltaX / n;
      this.meanY[index] = meanYBefore + deltaY / n;
      this.m2X[index] =
        (this.m2X[index] ?? 0) + deltaX * (x - (this.meanX[index] ?? 0));
      this.m2Y[index] =
        (this.m2Y[index] ?? 0) + deltaY * (y - (this.meanY[index] ?? 0));
    }
  }

  /** The window's moments (fresh copies; population variance M2/n). */
  moments(): LbmFieldMoments {
    const n = this.count;
    const varianceX = new Float64Array(this.nx * this.ny);
    const varianceY = new Float64Array(this.nx * this.ny);
    if (n > 0) {
      varianceX.set(this.m2X.map((value) => value / n));
      varianceY.set(this.m2Y.map((value) => value / n));
    }
    return {
      count: n,
      meanX: Float64Array.from(this.meanX),
      meanY: Float64Array.from(this.meanY),
      varianceX,
      varianceY,
    };
  }
}
