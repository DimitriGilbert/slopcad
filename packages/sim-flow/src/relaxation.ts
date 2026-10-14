/**
 * Collision (Phase 63a): BGK first, TRT as the stability knob — the
 * roadmap's exact ordering. Both models share one in-place kernel over
 * the live SoA distributions; only the rates differ.
 *
 * ## BGK (single-relaxation-time)
 *
 * f_i ← f_i − (f_i − e_i(u))/τ, with τ = τ⁺ from the unit closure
 * (ν = c_s²(τ − ½)). Simple, and the honest baseline — but near τ = ½
 * (high Re) its odd and even moments share one rate and the resulting
 * resonance is the classic BGK blow-up, which the Phase 63a stability
 * fixture pins.
 *
 * ## TRT (two-relaxation-times, the stability knob)
 *
 * The distribution decomposes into even/odd reflection parts
 * (f±_i = (f_i ± f_ī)/2, equilibria from `./d2q9`), relaxed at two
 * rates: the physical λ⁺ = 1/τ⁺ (set by viscosity) and a FREE λ⁻ = 1/τ⁻
 * fixed by the MAGIC PARAMETER
 *
 *   Λ = (τ⁺ − ½)(τ⁻ − ½),
 *
 * with τ⁻ = ½ + Λ/(τ⁺ − ½). The default Λ = 1/4 is the celebrated
 * channel value: for steady Poiseuille/Couette with bounce-back it
 * cancels the boundary error exactly, independent of τ⁺ — the property
 * the Poiseuille fixture leans on. Other documented values in the
 * literature: 3/16 (Ginzburg's steady-state optimum), 1/12
 * (advection-dominated stability) — the config takes any Λ ∈ (0, 1],
 * and the stability gain is structural: as τ⁺ → ½, τ⁻ grows without
 * bound, so the odd modes are over-damped exactly when BGK rings.
 *
 * Momentum and density are conserved exactly at every collision
 * (pair-wise antisymmetry of the odd parts), in f64 arithmetic before
 * the f32 store — deterministic rounding, law S2.
 */

import type { LbmState } from "./state";

import {
  D2Q9_OPPOSITE,
  D2Q9_Q,
  D2Q9_VELOCITIES,
  D2Q9_WEIGHTS,
  d2q9Equilibrium,
  d2q9EquilibriumEven,
  d2q9EquilibriumOdd,
} from "./d2q9";

/** The default TRT magic parameter — the channel-exact choice. */
export const LBM_DEFAULT_MAGIC_LAMBDA = 0.25;

/** The accepted magic-parameter range: (0, 1]. */
export const LBM_MAGIC_LAMBDA_MAX = 1;

/** The collision model configuration. */
export type LbmCollisionModel =
  | { readonly kind: "bgk" }
  | {
      readonly kind: "trt";
      /** The magic parameter Λ; defaults to {@link LBM_DEFAULT_MAGIC_LAMBDA}. */
      readonly magicLambda?: number;
    };

/** The materialized rates a step consumes (both strictly positive). */
export interface LbmRelaxationRates {
  readonly kind: "bgk" | "trt";
  /** λ⁺ = 1/τ⁺ — the physical rate. */
  readonly lambdaPlus: number;
  /** λ⁻ = 1/τ⁻ — the free rate (equals λ⁺ under BGK). */
  readonly lambdaMinus: number;
  /** The magic parameter in force (Λ = ¼ under BGK is meaningless; reported 0). */
  readonly magicLambda: number;
}

/**
 * Materializes the rates from the unit closure's τ⁺ and the model
 * choice, refusing a Λ outside (0, 1] — the knob stays honest in both
 * directions.
 */
export function lbmRelaxationRates(
  model: LbmCollisionModel,
  tauPlus: number,
): LbmRelaxationRates {
  if (model.kind === "bgk") {
    const rate = 1 / tauPlus;
    return { kind: "bgk", lambdaPlus: rate, lambdaMinus: rate, magicLambda: 0 };
  }
  const magicLambda = model.magicLambda ?? LBM_DEFAULT_MAGIC_LAMBDA;
  const tauMinus = 0.5 + magicLambda / (tauPlus - 0.5);
  return {
    kind: "trt",
    lambdaPlus: 1 / tauPlus,
    lambdaMinus: 1 / tauMinus,
    magicLambda,
  };
}

/** Whether a model's free parameters are inside their honest ranges. */
export function lbmCollisionModelProblem(
  model: LbmCollisionModel,
): string | undefined {
  if (model.kind === "trt" && model.magicLambda !== undefined) {
    if (
      typeof model.magicLambda !== "number" ||
      !Number.isFinite(model.magicLambda) ||
      model.magicLambda <= 0 ||
      model.magicLambda > LBM_MAGIC_LAMBDA_MAX
    ) {
      return `A TRT magic parameter must lie in (0, ${String(LBM_MAGIC_LAMBDA_MAX)}], received ${String(model.magicLambda)}.`;
    }
  }
  return undefined;
}

/**
 * Applies one collision to the live distributions, in place, at every
 * FLUID node from the macroscopic fields (which must be current for
 * `f` — the stepper's step order guarantees it). Solids are skipped:
 * their contents are bounce-back's business, never collision's.
 *
 * The optional per-node force arrays (`fx`, `fy`, lattice momentum
 * units per step — the Boussinesq field of `./buoyancy`) add the GUO
 * forcing (Guo, Zheng & Shi 2002), the exact second-order form whose
 * moments cancel the O(dt) force error: each step injects exactly ΣF
 * of momentum (the momentum ledger's body-force term) and the
 * macroscopic velocity the equilibrium reads must carry the half-step
 * correction u = (Σf·c + F/2)/ρ (`lbmComputeMacroscopic`'s forced
 * form). Under TRT the force splits with the collision: the
 * reflection-EVEN part (the (c·u)(c·F) and u·F terms, weighted
 * (1 − λ⁺/2)) rides the physical rate and the reflection-ODD part
 * (w_i·3·c·F, weighted (1 − λ⁻/2)) rides the free rate — the
 * d'Humières forcing the TRT literature standardizes on; under BGK
 * the two weights coincide and the term reduces to the textbook
 * (1 − 1/(2τ))·S_i verbatim.
 */
export function lbmCollide(
  state: LbmState,
  rates: LbmRelaxationRates,
  forceX?: Float64Array,
  forceY?: Float64Array,
): void {
  const { f, rho, ux, uy, nx, ny } = state;
  const mask = state.solid.solid;
  const { lambdaPlus, lambdaMinus } = rates;
  const forced = forceX !== undefined && forceY !== undefined;
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const index = x + y * nx;
      if (mask[index] === 1) continue;
      const nodeRho = rho[index] ?? 1;
      const nodeUx = ux[index] ?? 0;
      const nodeUy = uy[index] ?? 0;
      const fx = forced ? (forceX?.[index] ?? 0) : 0;
      const fy = forced ? (forceY?.[index] ?? 0) : 0;
      if (rates.kind === "bgk") {
        for (let i = 0; i < D2Q9_Q; i += 1) {
          const column = f[i];
          if (column === undefined) continue;
          const value = column[index] ?? 0;
          const [cx, cy] = D2Q9_VELOCITIES[i] ?? [0, 0];
          const cu = cx * nodeUx + cy * nodeUy;
          const cf = cx * fx + cy * fy;
          // Guo's S_i with the BGK half-rate weight (1 − λ/2).
          const guo =
            (1 - lambdaPlus / 2) *
            (D2Q9_WEIGHTS[i] ?? 0) *
            (3 * cf + 9 * cu * cf - 3 * (nodeUx * fx + nodeUy * fy));
          column[index] =
            value -
            lambdaPlus * (value - d2q9Equilibrium(i, nodeRho, nodeUx, nodeUy)) +
            guo;
        }
        continue;
      }
      // The common force pieces: the reflection-even scalar (per pair,
      // since S⁺ is pair-constant) and the rest-direction weight.
      const uDotF = nodeUx * fx + nodeUy * fy;
      // TRT: the rest direction is purely even; every reflected pair is
      // updated atomically from its two original values — the pair's odd
      // error enters each member with the opposite sign.
      const rest = f[0];
      if (rest !== undefined) {
        const value = rest[index] ?? 0;
        const guoRest =
          (1 - lambdaPlus / 2) * (D2Q9_WEIGHTS[0] ?? 0) * -3 * uDotF;
        rest[index] =
          value -
          lambdaPlus *
            (value - d2q9EquilibriumEven(0, nodeRho, nodeUx, nodeUy)) +
          guoRest;
      }
      for (let i = 1; i < D2Q9_Q; i += 1) {
        const j = D2Q9_OPPOSITE[i] ?? 0;
        if (j <= i) continue;
        const column = f[i];
        const mirror = f[j];
        if (column === undefined || mirror === undefined) continue;
        const fi = column[index] ?? 0;
        const fj = mirror[index] ?? 0;
        const evenError =
          (fi + fj) / 2 - d2q9EquilibriumEven(i, nodeRho, nodeUx, nodeUy);
        const oddError =
          (fi - fj) / 2 - d2q9EquilibriumOdd(i, nodeRho, nodeUx, nodeUy);
        const [cx, cy] = D2Q9_VELOCITIES[i] ?? [0, 0];
        const cu = cx * nodeUx + cy * nodeUy;
        const cf = cx * fx + cy * fy;
        const weight = D2Q9_WEIGHTS[i] ?? 0;
        // Even part (pair-constant), odd part (sign-flips with the member).
        const sPlus = (1 - lambdaPlus / 2) * weight * (9 * cu * cf - 3 * uDotF);
        const sMinus = (1 - lambdaMinus / 2) * weight * 3 * cf;
        column[index] =
          fi - lambdaPlus * evenError - lambdaMinus * oddError + sPlus + sMinus;
        mirror[index] =
          fj - lambdaPlus * evenError + lambdaMinus * oddError + sPlus - sMinus;
      }
    }
  }
}
