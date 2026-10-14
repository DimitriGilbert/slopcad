/**
 * The grid-convergence self-check (Phase 63b, the §7.11 completeness
 * ruling): a per-scenario flag that runs the same scenario at TWO
 * resolutions — coarse and a factor-2 refinement, the resolution-ladder
 * machinery — and reports the drift between them: integrated-quantity
 * drift (window-mean lift/drag at matched physical time) plus the
 * field-level difference between the coarse mean solution and the
 * block-filtered fine mean solution. The report is a BUILT-IN TRUST
 * INDICATOR, never a gate: drift numbers are advisory (the risk-S16
 * posture every regime threshold shares), and the expected
 * dissipation-vs-refinement direction is stated in the report itself,
 * sourced from the researched prior art.
 *
 * Matched physical time is structural, not approximated: the unit
 * closure fixes dt = u_lat·dx/U with u_lat and U shared across the
 * ladder, so the refined run's time step is exactly half the coarse
 * one and the driver runs it for exactly twice the steps with an
 * averaging window of exactly twice the length — both runs then end,
 * and average, at the same physical instant.
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  type SimParseResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";

/** The ladder's refinement factor (the one rung the self-check climbs). */
export const LBM_GRID_CONVERGENCE_REFINEMENT = 2;

/**
 * The honest expectation the drift report states beside its numbers —
 * the dissipation-vs-refinement tradeoff the prior art warns about
 * ( AngeTheGreat engine-simulation findings, global report §Phase 63:
 * "naive schemes low-pass the field", refinement cost grows
 * non-linearly, `docs/research/ange-engine-sim/global-report.md`).
 */
export const LBM_GRID_CONVERGENCE_DIRECTION = [
  "Expected direction: the coarse lattice over-dissipates — numerical",
  "viscosity scales with the cell size, so the coarse solution low-passes",
  "the field (smoothed wakes, thick boundary layers) and refinement",
  "REDUCES that artificial dissipation: integrated forces drift toward",
  "their converged values and the field-level difference shrinks as the",
  "ladder refines. Staircase boundaries converge slowly (first-order in",
  "dx at best), so one factor-2 rung measures the drift, never bounds",
  "the error — these numbers are advisory trust indicators, not error",
  "bars.",
].join(" ");

/** One rung's grid and window facts, as the drift report states them. */
export interface LbmConvergenceRungFacts {
  readonly nx: number;
  readonly ny: number;
  readonly cellSizeM: number;
  readonly completedSteps: number;
  readonly physicalDurationS: number;
  readonly averagingWindowSteps: number;
}

/** One rung's solution view the drift is computed from. */
export interface LbmConvergenceRungView {
  readonly facts: LbmConvergenceRungFacts;
  /** The rung's occupancy mask (nx·ny values, x-fastest). */
  readonly solid: Uint8Array;
  /** Window-mean velocity components, LATTICE units (x-fastest). */
  readonly meanVelocityXLattice: Float64Array;
  readonly meanVelocityYLattice: Float64Array;
  /** Window-mean integrated forces, SI (N per metre of depth). */
  readonly meanDragNPerM: number;
  readonly meanLiftNPerM: number;
}

/** The drift of one integrated quantity, normalized by the pair's force scale. */
export interface LbmForceDrift {
  readonly coarseNPerM: number;
  readonly fineNPerM: number;
  /**
   * (fine − coarse) divided by the largest force magnitude the pair
   * produced — the honest normalizer when the quantity itself crosses
   * zero (a symmetric body's lift), stated as a fraction of the run's
   * dominant aerodynamic force.
   */
  readonly relative: number;
}

/** The field-level drift between the coarse and filtered-fine solutions. */
export interface LbmFieldDrift {
  /** Coarse nodes whose 2×2 fine block is fluid in both rungs. */
  readonly comparedNodes: number;
  /** comparedNodes over the coarse rung's fluid nodes (the honest coverage). */
  readonly coverage: number;
  /** ‖coarse − filtered fine‖₂ / ‖coarse‖₂ over the compared nodes. */
  readonly l2Relative: number;
  /** max |coarse − filtered fine| / u_char over the compared nodes. */
  readonly linfRelative: number;
}

/** The self-check's report: both rungs' facts, the drifts, the direction. */
export interface LbmGridConvergenceReport {
  readonly refinementFactor: number;
  readonly coarse: LbmConvergenceRungFacts;
  readonly fine: LbmConvergenceRungFacts;
  readonly dragDrift: LbmForceDrift;
  readonly liftDrift: LbmForceDrift;
  readonly fieldDrift: LbmFieldDrift;
  /** The expected dissipation-vs-refinement direction ({@link LBM_GRID_CONVERGENCE_DIRECTION}). */
  readonly direction: string;
}

/**
 * Computes the grid-convergence drift between a coarse rung and its
 * factor-2 refinement. The fine mean field is filtered to the coarse
 * nodes by 2×2 block averaging; a coarse node compares only when it is
 * fluid AND its whole fine block is fluid (staircase disagreement at
 * the body is reported through the coverage fraction, never averaged
 * through). Shape disagreement declines structured.
 */
export function lbmGridConvergenceDrift(
  coarse: LbmConvergenceRungView,
  fine: LbmConvergenceRungView,
  characteristicLatticeVelocity: number,
): SimParseResult<LbmGridConvergenceReport, SimError> {
  const { nx, ny } = coarse.facts;
  if (
    fine.facts.nx !== nx * LBM_GRID_CONVERGENCE_REFINEMENT ||
    fine.facts.ny !== ny * LBM_GRID_CONVERGENCE_REFINEMENT
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `A grid-convergence pair must be a factor-${String(LBM_GRID_CONVERGENCE_REFINEMENT)} ladder: the refined rung's grid (${String(fine.facts.nx)}×${String(fine.facts.ny)}) must be exactly twice the coarse rung's (${String(nx)}×${String(ny)}).`,
        { coarse: coarse.facts, fine: fine.facts },
      ),
    );
  }
  const cells = nx * ny;
  if (
    coarse.solid.length !== cells ||
    fine.solid.length !== 4 * cells ||
    coarse.meanVelocityXLattice.length !== cells ||
    coarse.meanVelocityYLattice.length !== cells ||
    fine.meanVelocityXLattice.length !== 4 * cells ||
    fine.meanVelocityYLattice.length !== 4 * cells
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "A grid-convergence pair's value arrays must each match their rung's extent product.",
        { coarseCells: cells, fineCells: 4 * cells },
      ),
    );
  }
  if (
    !(characteristicLatticeVelocity > 0) ||
    !Number.isFinite(characteristicLatticeVelocity)
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "A grid-convergence report needs a positive characteristic lattice velocity to normalize its field drift.",
        characteristicLatticeVelocity,
      ),
    );
  }

  // The field-level drift: coarse mean speed vs the 2×2 block-average of
  // the fine mean speed, node by node, over the honestly comparable set.
  const fineNx = fine.facts.nx;
  let comparedNodes = 0;
  let coarseFluidNodes = 0;
  let sumSquaredDiff = 0;
  let sumSquaredCoarse = 0;
  let maxAbsDiff = 0;
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const coarseIndex = x + y * nx;
      if ((coarse.solid[coarseIndex] ?? 0) === 1) continue;
      coarseFluidNodes += 1;
      const fineIndexBase = 2 * x + 2 * y * fineNx;
      const block = [
        fineIndexBase,
        fineIndexBase + 1,
        fineIndexBase + fineNx,
        fineIndexBase + fineNx + 1,
      ];
      let blockFluid = true;
      for (const fineIndex of block) {
        if ((fine.solid[fineIndex] ?? 0) === 1) {
          blockFluid = false;
          break;
        }
      }
      if (!blockFluid) continue;
      comparedNodes += 1;
      const coarseSpeed = Math.hypot(
        coarse.meanVelocityXLattice[coarseIndex] ?? 0,
        coarse.meanVelocityYLattice[coarseIndex] ?? 0,
      );
      let sumSpeed = 0;
      for (const fineIndex of block) {
        sumSpeed += Math.hypot(
          fine.meanVelocityXLattice[fineIndex] ?? 0,
          fine.meanVelocityYLattice[fineIndex] ?? 0,
        );
      }
      const filteredSpeed = sumSpeed / block.length;
      const diff = coarseSpeed - filteredSpeed;
      sumSquaredDiff += diff * diff;
      sumSquaredCoarse += coarseSpeed * coarseSpeed;
      const absDiff = Math.abs(diff);
      if (absDiff > maxAbsDiff) maxAbsDiff = absDiff;
    }
  }
  const fieldDrift: LbmFieldDrift = {
    comparedNodes,
    coverage: coarseFluidNodes === 0 ? 0 : comparedNodes / coarseFluidNodes,
    l2Relative:
      sumSquaredCoarse === 0 ? 0 : Math.sqrt(sumSquaredDiff / sumSquaredCoarse),
    linfRelative: maxAbsDiff / characteristicLatticeVelocity,
  };

  // The integrated-quantity drift, normalized by the pair's dominant
  // force scale (honest for zero-crossing quantities like symmetric lift).
  const forceScale = Math.max(
    Math.abs(coarse.meanDragNPerM),
    Math.abs(fine.meanDragNPerM),
    Math.abs(coarse.meanLiftNPerM),
    Math.abs(fine.meanLiftNPerM),
  );
  const forceDrift = (
    coarseValue: number,
    fineValue: number,
  ): LbmForceDrift => ({
    coarseNPerM: coarseValue,
    fineNPerM: fineValue,
    relative: forceScale > 0 ? (fineValue - coarseValue) / forceScale : 0,
  });

  return simOk({
    refinementFactor: LBM_GRID_CONVERGENCE_REFINEMENT,
    coarse: coarse.facts,
    fine: fine.facts,
    dragDrift: forceDrift(coarse.meanDragNPerM, fine.meanDragNPerM),
    liftDrift: forceDrift(coarse.meanLiftNPerM, fine.meanLiftNPerM),
    fieldDrift,
    direction: LBM_GRID_CONVERGENCE_DIRECTION,
  });
}

/**
 * Rejects non-finite drift inputs before they can fabricate a report —
 * the driver calls this on each rung's window means and mean fields.
 */
export function lbmConvergenceRungProblem(
  rung: LbmConvergenceRungView,
): SimError | undefined {
  const facts = rung.facts;
  const factsFinite =
    Number.isFinite(facts.cellSizeM) &&
    facts.cellSizeM > 0 &&
    Number.isFinite(facts.physicalDurationS) &&
    facts.physicalDurationS > 0 &&
    Number.isFinite(facts.averagingWindowSteps) &&
    facts.averagingWindowSteps > 0 &&
    Number.isFinite(rung.meanDragNPerM) &&
    Number.isFinite(rung.meanLiftNPerM);
  if (!factsFinite) {
    return simError(
      SIM_ERROR_CODES.scenarioInvalid,
      "A grid-convergence rung must carry finite positive grid facts and finite window-mean forces.",
      rung.facts,
    );
  }
  const cells = facts.nx * facts.ny;
  for (const field of [rung.meanVelocityXLattice, rung.meanVelocityYLattice]) {
    for (let index = 0; index < cells; index += 1) {
      if (!Number.isFinite(field[index] ?? NaN)) {
        return simError(
          SIM_ERROR_CODES.scenarioInvalid,
          `A grid-convergence rung's mean field carries a non-finite value at index ${String(index)}; the self-check refuses to diff against it.`,
          index,
        );
      }
    }
  }
  return undefined;
}
