/**
 * The NASA-7 polynomial evaluator (ROADMAP-SIM Phase 68a, law S2): the
 * standard two-range seven-coefficient thermodynamic curve fits of the
 * NASA Glenn database, evaluated in their exact published dimensionless
 * forms (McBride, Gordon and Reno, NASA TP-2002-211556, 2002):
 *
 *   Cp°/R      = a₁ + a₂T + a₃T² + a₄T³ + a₅T⁴
 *   H°/(RT)    = a₁ + a₂T/2 + a₃T²/3 + a₄T³/4 + a₅T⁴/5 + a₆/T
 *   S°/R       = a₁lnT + a₂T + a₃T²/2 + a₄T³/3 + a₅T⁴/4 + a₇
 *
 * with a₆ carrying the enthalpy of formation (H(298.15 K) = Hf° by the
 * database's anchor) and a₇ the entropy constant. G°/(RT) = H°/(RT) −
 * S°/R (the quantity the equilibrium solver drives). Single-range
 * species (the monatomic noble gases) carry one coefficient block.
 * Pure arithmetic, zero dependencies, bitwise deterministic.
 */

/** The molar gas constant, J/(mol·K) — exact since the 2019 SI (N_A·k_B). */
export const GAS_CONSTANT_J_PER_MOL_K = 8.31446261815324;

/** The databases' standard-state pressure, bar (post-1982 convention). */
export const NASA7_STANDARD_STATE_BAR = 1;

/**
 * The coefficients' evaluation domain this module enforces: the NASA
 * Glenn fits cover 200–6000 K, and the equilibrium solver keeps every
 * temperature it touches inside this span (documented clamps, no
 * silent extrapolation).
 */
export const NASA7_T_MIN_K = 200;
export const NASA7_T_MAX_K = 6000;

/** One coefficient block: exactly the seven published coefficients. */
export type Nasa7Coefficients = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

/** One fitted temperature range and its coefficient block. */
export interface Nasa7Range {
  /** The range's inclusive lower bound, K. */
  readonly tMinK: number;
  /** The range's inclusive upper bound, K. */
  readonly tMaxK: number;
  readonly coefficients: Nasa7Coefficients;
}

/**
 * One gaseous species' thermochemical record: composition (element →
 * atom count), molar mass, the fitted ranges (low first; a single block
 * for single-range species), and the database's own source note carried
 * verbatim for citation.
 */
export interface Nasa7Species {
  readonly name: string;
  readonly composition: Readonly<Record<string, number>>;
  /** Molar mass, kg/kmol (= g/mol), from the conventional atomic weights. */
  readonly molecularWeightKgPerKmol: number;
  readonly ranges: readonly Nasa7Range[];
  /** The database's source note, carried verbatim (see thermo-data.ts). */
  readonly note: string;
}

/** Clamps a temperature into the module's evaluation domain, K. */
function clampDomainK(tK: number): number {
  if (tK < NASA7_T_MIN_K) return NASA7_T_MIN_K;
  if (tK > NASA7_T_MAX_K) return NASA7_T_MAX_K;
  return tK;
}

/** Picks the coefficient block whose range contains the temperature. */
function rangeFor(species: Nasa7Species, tK: number): Nasa7Range {
  const t = clampDomainK(tK);
  for (const range of species.ranges) {
    if (t <= range.tMaxK) return range;
  }
  const last = species.ranges[species.ranges.length - 1];
  if (last === undefined) {
    throw new Error(`The species "${species.name}" carries no fitted range.`);
  }
  return last;
}

/** Dimensionless heat capacity Cp°/R of the species at temperature K. */
export function nasa7CpOverR(species: Nasa7Species, tK: number): number {
  const t = clampDomainK(tK);
  const a = rangeFor(species, t).coefficients;
  return (
    a[0] + a[1] * t + a[2] * t * t + a[3] * t * t * t + a[4] * t * t * t * t
  );
}

/** Dimensionless enthalpy H°/(RT) of the species at temperature K. */
export function nasa7HOverRT(species: Nasa7Species, tK: number): number {
  const t = clampDomainK(tK);
  const a = rangeFor(species, t).coefficients;
  return (
    a[0] +
    (a[1] / 2) * t +
    (a[2] / 3) * t * t +
    (a[3] / 4) * t * t * t +
    (a[4] / 5) * t * t * t * t +
    a[5] / t
  );
}

/** Dimensionless entropy S°/R of the species at the standard state. */
export function nasa7SOverR(species: Nasa7Species, tK: number): number {
  const t = clampDomainK(tK);
  const a = rangeFor(species, t).coefficients;
  return (
    a[0] * Math.log(t) +
    a[1] * t +
    (a[2] / 2) * t * t +
    (a[3] / 3) * t * t * t +
    (a[4] / 4) * t * t * t * t +
    a[6]
  );
}

/** Dimensionless Gibbs energy G°/(RT) = H°/(RT) − S°/R at temperature K. */
export function nasa7GOverRT(species: Nasa7Species, tK: number): number {
  return nasa7HOverRT(species, tK) - nasa7SOverR(species, tK);
}

/** Molar enthalpy h°(T), J/mol (includes the formation enthalpy). */
export function nasa7EnthalpyJPerMol(
  species: Nasa7Species,
  tK: number,
): number {
  return (
    nasa7HOverRT(species, tK) * GAS_CONSTANT_J_PER_MOL_K * clampDomainK(tK)
  );
}

/** Molar entropy s°(T) at the standard state, J/(mol·K). */
export function nasa7EntropyJPerMolK(
  species: Nasa7Species,
  tK: number,
): number {
  return nasa7SOverR(species, tK) * GAS_CONSTANT_J_PER_MOL_K;
}

/** Molar heat capacity cp°(T), J/(mol·K). */
export function nasa7CpJPerMolK(species: Nasa7Species, tK: number): number {
  return nasa7CpOverR(species, tK) * GAS_CONSTANT_J_PER_MOL_K;
}

/** The species' fitted span [min, max], K (the union of its ranges). */
export function nasa7FittedSpanK(
  species: Nasa7Species,
): readonly [number, number] {
  const first = species.ranges[0];
  const last = species.ranges[species.ranges.length - 1];
  if (first === undefined || last === undefined) {
    throw new Error(
      `The species "${species.name}" carries no fitted range to span.`,
    );
  }
  return [first.tMinK, last.tMaxK];
}
