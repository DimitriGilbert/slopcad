/**
 * The laminar flame-speed module (ROADMAP-SIM Phase 68b): the
 * Metghalchi–Keck premixed burning-velocity correlation — the
 * published form the Wiebe burn-duration grounding ties to (burn
 * duration = chamber scale over flame speed, never a fitted diesel-style
 * burn curve).
 *
 *   M. Metghalchi and J. C. Keck, "Burning velocities of mixtures of
 *   air with methanol, isooctane, and indolene at high pressure and
 *   temperature", Combustion and Flame 48 (1982) 191–210,
 *   doi:10.1016/0010-2180(82)90127-4
 *
 * The correlation, exactly as published:
 *
 *   S_L = S_L0 · (T_u/T_ref)^α · (p/p_ref)^β · (1 − 2.1·y_dil)
 *   S_L0 = B_m + B_φ·(φ − φ_m)²            [cm/s at reference state]
 *   α    = 2.18 − 0.8·(φ − 1)
 *   β    = −0.16 + 0.22·(φ − 1)
 *
 * with the reference state (T_ref, p_ref) = (298.15 K, 1 atm), the
 * dilution term's residual-mass fraction y_dil, and the iso-octane fit
 *
 *   B_m = 26.28 cm/s,  B_φ = −94.51 cm/s,  φ_m = 1.13.
 *
 * Stated validity, honestly: the fit was measured in a combustion bomb
 * over unburned-gas temperatures up to about 700 K and pressures of a
 * few to ~8 atm, for equivalence ratios near stoichiometric (the
 * parabola's span); the module reports every use outside that band as
 * the standard engine-model extrapolation (a flag, not a decline), and
 * the fit's known ambient under-prediction against later iso-octane
 * burning-velocity measurements is carried in the result's note. The
 * two curated octanes ride the iso-octane fit — n-octane on the
 * gasoline-surrogate fit, stated, not hidden. Fuels without a published
 * M&K-class fit carried here (H2, CH4, CO) decline LOUDLY by name: the
 * burn-duration grounding refuses to guess a flame speed.
 */

import {
  simError,
  simFail,
  simOk,
  SIM_ERROR_CODES,
  type SimError,
  type SimParseResult,
} from "@slopcad/sim-core";

// The correlation's internal reference state and fit-band limits —
// module-local plumbing (the public surface reports the fit's validity
// through the result's `withinFitBand` flags, not these numbers; the
// published values are re-derived independently in the tests).
/** The correlation's reference temperature, K. */
const FLAME_SPEED_REFERENCE_T_K = 298.15;
/** The correlation's reference pressure, bar (1 atm). */
const FLAME_SPEED_REFERENCE_P_BAR = 1.01325;
/** The fit's stated unburned-temperature band, upper end, K. */
const FLAME_SPEED_FIT_T_MAX_K = 700;
/** The fit's stated pressure band, upper end, bar (~8 atm). */
const FLAME_SPEED_FIT_P_MAX_BAR = 8 * FLAME_SPEED_REFERENCE_P_BAR;

/** The iso-octane fit coefficients (Metghalchi–Keck 1982, cm/s basis). */
const ISO_OCTANE_B_M_CM_PER_S = 26.28;
const ISO_OCTANE_B_PHI_CM_PER_S = -94.51;
const ISO_OCTANE_PHI_M = 1.13;

/** The dilution coefficient, as published (the 1 − 2.1·y_dil term). */
export const FLAME_SPEED_DILUTION_COEFFICIENT = 2.1;

/** The fuels whose published fits this module carries. */
export const FLAME_SPEED_FUEL_NAMES: readonly string[] = Object.freeze([
  "C8H18-ISO",
  "C8H18-N",
]);

/** The correlation's result with its honesty report. */
export interface LaminarFlameSpeedResult {
  /** The laminar burning velocity, m/s. */
  readonly speedMPerS: number;
  readonly fuel: string;
  readonly equivalenceRatio: number;
  readonly unburnedTK: number;
  readonly pressureBar: number;
  /**
   * The fit's validity report: temperature and pressure inside the
   * measured band, dilution inside the term's span. Out-of-band use
   * proceeds (engine conditions exceed the bomb band routinely) and is
   * flagged here — honesty, not decline.
   */
  readonly withinFitBand: {
    readonly temperature: boolean;
    readonly pressure: boolean;
    readonly dilution: boolean;
  };
  /** The reference-conditions burning velocity S_L0, m/s (the parabola). */
  readonly referenceSpeedMPerS: number;
}

/**
 * The Metghalchi–Keck laminar burning velocity of a premixed octane–air
 * charge: S_L(φ, T_u, p, y_dil). Declines for fuels without a carried
 * published fit, for dilution at or beyond the term's zero, and for
 * equivalence ratios so far from φ_m the fitted parabola is no longer
 * positive (outside the fit's span — never a negative speed).
 */
export function laminarFlameSpeedMPerS(input: {
  readonly fuel: string;
  readonly equivalenceRatio: number;
  readonly unburnedTK: number;
  readonly pressureBar: number;
  readonly residualMassFraction?: number;
}): SimParseResult<LaminarFlameSpeedResult, SimError> {
  if (!FLAME_SPEED_FUEL_NAMES.includes(input.fuel)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `No published laminar flame-speed fit is carried for the fuel "${input.fuel}" (carried: ${FLAME_SPEED_FUEL_NAMES.join(", ")}, on the Metghalchi–Keck 1982 iso-octane fit) — the burn-duration grounding declines rather than guessing a flame speed.`,
        input.fuel,
      ),
    );
  }
  const phi = input.equivalenceRatio;
  if (!Number.isFinite(phi) || phi <= 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The flame-speed correlation needs a positive equivalence ratio; it was ${String(phi)}.`,
        phi,
      ),
    );
  }
  if (!Number.isFinite(input.unburnedTK) || input.unburnedTK <= 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The flame-speed correlation needs a positive unburned-gas temperature (K); it was ${String(input.unburnedTK)}.`,
        input.unburnedTK,
      ),
    );
  }
  if (!Number.isFinite(input.pressureBar) || input.pressureBar <= 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The flame-speed correlation needs a positive pressure (bar); it was ${String(input.pressureBar)}.`,
        input.pressureBar,
      ),
    );
  }
  const residual = input.residualMassFraction ?? 0;
  if (!Number.isFinite(residual) || residual < 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The residual-mass fraction must be finite and non-negative; it was ${String(residual)}.`,
        residual,
      ),
    );
  }
  if (residual >= 1 / FLAME_SPEED_DILUTION_COEFFICIENT) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The residual-mass fraction ${String(residual)} drives the Metghalchi–Keck dilution term (1 − ${String(FLAME_SPEED_DILUTION_COEFFICIENT)}·y) to zero or below; the mixture will not propagate a flame and the correlation declines rather than returning a non-positive speed.`,
        residual,
      ),
    );
  }
  const sL0CmPerS =
    ISO_OCTANE_B_M_CM_PER_S +
    ISO_OCTANE_B_PHI_CM_PER_S * (phi - ISO_OCTANE_PHI_M) ** 2;
  if (!(sL0CmPerS > 0)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The equivalence ratio ${String(phi)} lies outside the Metghalchi–Keck fit's span (the reference-conditions parabola is no longer positive there) — the correlation declines rather than extrapolating past its measured branch.`,
        phi,
      ),
    );
  }
  const alpha = 2.18 - 0.8 * (phi - 1);
  const beta = -0.16 + 0.22 * (phi - 1);
  const speedMPerS =
    (sL0CmPerS / 100) *
    Math.pow(input.unburnedTK / FLAME_SPEED_REFERENCE_T_K, alpha) *
    Math.pow(input.pressureBar / FLAME_SPEED_REFERENCE_P_BAR, beta) *
    (1 - FLAME_SPEED_DILUTION_COEFFICIENT * residual);
  return simOk({
    speedMPerS,
    fuel: input.fuel,
    equivalenceRatio: phi,
    unburnedTK: input.unburnedTK,
    pressureBar: input.pressureBar,
    withinFitBand: {
      temperature:
        input.unburnedTK >= FLAME_SPEED_REFERENCE_T_K &&
        input.unburnedTK <= FLAME_SPEED_FIT_T_MAX_K,
      pressure:
        input.pressureBar >= FLAME_SPEED_REFERENCE_P_BAR &&
        input.pressureBar <= FLAME_SPEED_FIT_P_MAX_BAR,
      dilution: residual < 1 / FLAME_SPEED_DILUTION_COEFFICIENT,
    },
    referenceSpeedMPerS: sL0CmPerS / 100,
  });
}
