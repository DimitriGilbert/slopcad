/**
 * Momentum-exchange force integration, 3D (Phase 66a) — the 63a
 * accumulator carried to three components: every full-way bounce-back
 * reflection hands the body twice the incoming population's momentum
 * (2·f_i·c_i per reflected population, `./state-3d`'s reflection), and
 * the per-step sum over solids and directions is the body force vector
 * for that step. The accumulator owns the deterministic series: drag
 * (x), lift (y — the roadmap's gravity axis), and side (z) samples per
 * step, in SI newtons (a 3D force, not the 2D per-depth N/m), converted
 * once through the 3D unit closure's force factor — never re-scaled on
 * read, never decimated here (decimation is the result-store's export
 * business, law S7).
 */

import type { SimHistorySeries } from "@slopcad/sim-core";
import type { Lbm3dUnitSystem } from "./lattice-units-3d";

/** The force sample names of the deterministic 3D series. */
export const LBM3D_FORCE_SERIES_NAMES = ["drag", "lift", "side"] as const;

/** The unit label every 3D force series carries. */
export const LBM3D_FORCE_UNIT = "N";

/** The per-step momentum-exchange force accumulator (three components). */
export class Lbm3dForceAccumulator {
  private readonly forceFactor: number;
  private readonly dragSamples: number[] = [];
  private readonly liftSamples: number[] = [];
  private readonly sideSamples: number[] = [];

  constructor(units: Lbm3dUnitSystem) {
    this.forceFactor = units.forceFactor;
  }

  /**
   * Records one step's lattice impulse (2·Σ f_i·c_i over solids, from
   * the reflection pass) as the step's SI force samples.
   */
  record(impulseX: number, impulseY: number, impulseZ: number): void {
    this.dragSamples.push(impulseX * this.forceFactor);
    this.liftSamples.push(impulseY * this.forceFactor);
    this.sideSamples.push(impulseZ * this.forceFactor);
  }

  /** The number of recorded steps (the series length). */
  get length(): number {
    return this.dragSamples.length;
  }

  /** The latest force samples, zero before the first step. */
  current(): {
    readonly dragN: number;
    readonly liftN: number;
    readonly sideN: number;
  } {
    return {
      dragN: this.dragSamples[this.dragSamples.length - 1] ?? 0,
      liftN: this.liftSamples[this.liftSamples.length - 1] ?? 0,
      sideN: this.sideSamples[this.sideSamples.length - 1] ?? 0,
    };
  }

  /**
   * The deterministic history triple, in the sim-core history shape the
   * result store persists (samples aliased, never copied — treat as
   * read-only; windowed means and shedding metrics are the caller's
   * post-processing, never baked in here).
   */
  history(): readonly SimHistorySeries[] {
    return [
      {
        name: LBM3D_FORCE_SERIES_NAMES[0] ?? "drag",
        unit: LBM3D_FORCE_UNIT,
        samples: this.dragSamples,
      },
      {
        name: LBM3D_FORCE_SERIES_NAMES[1] ?? "lift",
        unit: LBM3D_FORCE_UNIT,
        samples: this.liftSamples,
      },
      {
        name: LBM3D_FORCE_SERIES_NAMES[2] ?? "side",
        unit: LBM3D_FORCE_UNIT,
        samples: this.sideSamples,
      },
    ];
  }
}
