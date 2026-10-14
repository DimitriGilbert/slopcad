/**
 * Momentum-exchange force integration (Phase 63a) — the cfd-ts lineage,
 * rewritten: every full-way bounce-back reflection hands the body twice
 * the incoming population's momentum (2·f_i·c_i per reflected
 * population, `./state`'s reflection), and the per-step sum over solids
 * and directions is the body force for that step. The accumulator owns
 * the deterministic series the roadmap asks for: one drag and one lift
 * sample per step, in SI newtons per metre of depth (2D), converted
 * once through the unit closure's force factor — never re-scaled on
 * read, never decimated here (decimation is the result-store's export
 * business, law S7).
 */

import type { SimHistorySeries } from "@slopcad/sim-core";
import type { LbmUnitSystem } from "./lattice-units";

/** The force sample names of the deterministic series. */
export const LBM_FORCE_SERIES_NAMES = ["drag", "lift"] as const;

/** The unit label every force series carries (2D: per metre of depth). */
export const LBM_FORCE_UNIT = "N/m";

/** The per-step momentum-exchange force accumulator. */
export class LbmForceAccumulator {
  private readonly forceFactor: number;
  private readonly dragSamples: number[] = [];
  private readonly liftSamples: number[] = [];

  constructor(units: LbmUnitSystem) {
    this.forceFactor = units.forcePerDepthFactor;
  }

  /**
   * Records one step's lattice impulse (2·Σ f_i·c_i over solids, from
   * the reflection pass) as the step's SI force samples.
   */
  record(impulseX: number, impulseY: number): void {
    this.dragSamples.push(impulseX * this.forceFactor);
    this.liftSamples.push(impulseY * this.forceFactor);
  }

  /** The number of recorded steps (the series length). */
  get length(): number {
    return this.dragSamples.length;
  }

  /** The latest force samples, zero before the first step. */
  current(): { readonly dragNPerM: number; readonly liftNPerM: number } {
    return {
      dragNPerM: this.dragSamples[this.dragSamples.length - 1] ?? 0,
      liftNPerM: this.liftSamples[this.liftSamples.length - 1] ?? 0,
    };
  }

  /**
   * The deterministic history pair, in the sim-core history shape the
   * result store persists (samples aliased, never copied — treat as
   * read-only; windowed means and shedding metrics are the caller's
   * post-processing, never baked in here).
   */
  history(): readonly SimHistorySeries[] {
    return [
      {
        name: LBM_FORCE_SERIES_NAMES[0] ?? "drag",
        unit: LBM_FORCE_UNIT,
        samples: this.dragSamples,
      },
      {
        name: LBM_FORCE_SERIES_NAMES[1] ?? "lift",
        unit: LBM_FORCE_UNIT,
        samples: this.liftSamples,
      },
    ];
  }
}
