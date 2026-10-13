/**
 * The chemical-equilibrium solver (ROADMAP-SIM Phase 68a, laws S2 and
 * S9): element-potential Gibbs minimization — the NASA CEA formulation
 * (Gordon and McBride, NASA RP-1311, 1994) — minimizing the ideal-gas
 * Gibbs energy
 *
 *   G/(RT) = Σ_j n_j [ g_j°/(RT) + ln(n_j/n) + ln(P/P°) ]
 *
 * over product mole numbers n_j subject to the element balances
 * Σ_j a_ij n_j = b⁰_i, with P° = 1 bar. The stationarity conditions
 * μ_j/(RT) + Σ_i π_i a_ij = 0 introduce one element potential π_i per
 * element; the species corrections
 *
 *   x_j = Δln n_j = −G_j − Σ_i a_ij u_i + Δln n (+ H_j Δln T for HP)
 *
 * (G_j the stationarity residual, u_i = Δπ_i) reduce the KKT system,
 * together with the linearized element balances, the total-moles
 * identity Σ n_j x_j = n Δln n, and — for the HP (constant-enthalpy,
 * constant-pressure) problem — the linearized energy balance, to a
 * dense linear system in (u_i, Δln n, Δln T) solved by owned Gaussian
 * elimination with partial pivoting.
 *
 * The march is staged for robustness: it starts from a
 * complete-combustion seed composition with a least-squares estimate
 * of the element potentials (the linear map from a physical
 * composition to its π), marches the composition at the seed
 * temperature (the TP system — the phase that converges from this
 * seed in every fixture), and only then, for HP, releases the
 * temperature from that consistent state, where the enthalpy row's
 * Δln T is the modest physical number the linearization assumes. Each
 * step is applied with the CEA SIZE/λ discipline — a cap on species
 * corrections, a cap on |Δln T|, a species floor at 1e-30 mol, and
 * trace rules that let floor-parked radicals jump straight to their
 * potential-consistent abundance (capped at 1 ppm of the mixture per
 * step) instead of riding e² crawls that throttle the march — with a
 * re-freeze guard that returns to the composition phase whenever a
 * temperature step's transient blows the enthalpy residual.
 *
 * The TP problem fixes T; the HP problem solves T — the adiabatic
 * flame temperature IS the HP solution. Convergence is the CEA step
 * test (abundance-weighted |x_j| plus |Δln T| below tolerance, default
 * 1e-9) AND the residual gates — element balance, enthalpy, and a
 * gauge-invariant stationarity measured against the best-fit
 * potentials (every species voting equally, so a pending-dissociation
 * radical cannot hide below its abundance weight) — and the iteration
 * cap (default 500) declines LOUDLY with `sim/solver-unconverged`,
 * naming the residual it froze at — never a fabricated result.
 * Everything is pure IEEE-754 arithmetic in a fixed species/element
 * order: same inputs → same outputs, bitwise, per runtime (law S2).
 */

import {
  simError,
  simFail,
  simOk,
  SIM_ERROR_CODES,
  type SimError,
  type SimParseResult,
} from "@slopcad/sim-core";
import type { ElementName } from "./thermo-data";

import {
  GAS_CONSTANT_J_PER_MOL_K,
  NASA7_STANDARD_STATE_BAR,
  NASA7_T_MAX_K,
  NASA7_T_MIN_K,
  nasa7CpOverR,
  nasa7EnthalpyJPerMol,
  nasa7GOverRT,
  nasa7HOverRT,
  type Nasa7Species,
} from "./nasa7";
import { EQUILIBRIUM_SPECIES_NAMES, ELEMENTS, getSpecies } from "./thermo-data";

/** The species-abundance floor, moles — trace species park here. */
const SPECIES_FLOOR_MOL = 1e-30;

/**
 * Below this abundance, moles, a species no longer controls the step
 * factor (CEA's trace handling): a floor-parked radical's correction
 * never shrinks and would throttle λ forever; it still RECEIVES the
 * step, so it can grow back out of trace.
 */
const TRACE_CONTROL_MOL = 1e-12;

/** The per-step rise cap for below-trace species, mole fraction of the
 * mixture — one full potential-consistent jump, never a leap past
 * trace-scale abundance in a single step. */
const TRACE_JUMP_MOLE_FRACTION = 1e-6;

/** The per-step cap on |Δln T| (CEA's SIZE discipline, tightened). */
const DLNT_CAP = 0.9;

/** The per-step cap denominator on species corrections (CEA's λ). */
const DLNN_CONTROL = 2;

/**
 * The HP seed temperature's upper clamp, K — a basin choice, not a
 * physical bound: the frozen-composition energy balance of an
 * undiluted near-stoichiometric flame exceeds 5000 K while the
 * equilibrium (dissociation-limited) answer sits far lower; seeding
 * from that stiff summit walks worse than seeding from this band.
 */
const HP_SEED_T_CLAMP_K = 3500;

/**
 * The phase-2 re-freeze threshold: an enthalpy residual above this
 * after a temperature step means the composition transient and the T
 * walk are fighting — freeze, re-converge the composition, release.
 */
const REFREEZE_ENTHALPY = 1e-3;

/** The re-freeze budget: past this, phase 2 stays released and the
 * iteration cap decides loudly. */
const RELEASE_LIMIT = 30;

/** Consecutive step-test-passes-with-failing-gates tolerated before
 * the march declines loudly (real equilibrium passes both together). */
const GATE_MISS_LIMIT = 5;

/** The residual gates a converged solution must clear (honest, loud). */
const ELEMENT_BALANCE_GATE = 1e-8;
const STATIONARITY_GATE = 1e-6;
const ENTHALPY_GATE = 1e-7;

export interface EquilibriumSolverOptions {
  /** The iteration cap; exhausting it declines `sim/solver-unconverged`. */
  readonly maxIterations?: number;
  /** The CEA step tolerance (abundance-weighted |Δln n_j| + |Δln T|). */
  readonly tolerance?: number;
}

/** The residual discipline a converged solution reports honestly. */
export interface EquilibriumResiduals {
  /** max_i |Σ_j a_ij n_j − b⁰_i| / b⁰_i — the element balance. */
  readonly elementBalance: number;
  /** Σ_j n_j |G_j| / Σ_j n_j — the KKT stationarity, abundance-weighted. */
  readonly stationarity: number;
  /** (H − H⁰) scaled by the mixture's thermal energy R·T·n. */
  readonly enthalpy: number;
}

/** An equilibrium solution: state, projected quantities, and honesty. */
export interface EquilibriumSolution {
  readonly problem: "tp" | "hp";
  readonly temperatureK: number;
  readonly pressureBar: number;
  /** Product mole numbers by species name (the active product set). */
  readonly moles: Readonly<Record<string, number>>;
  /** Mole fractions x_j = n_j / n over the product set. */
  readonly moleFractions: Readonly<Record<string, number>>;
  /** Σ n_j at equilibrium, moles. */
  readonly totalMoles: number;
  /** The mixture enthalpy at the solution, J (equals H⁰ for HP). */
  readonly enthalpyJ: number;
  /** The mixture Gibbs energy at the solution, J. */
  readonly gibbsJ: number;
  /** The product-set mean molar mass, kg/kmol. */
  readonly meanMolecularWeightKgPerKmol: number;
  /** The Newton iterations consumed. */
  readonly iterations: number;
  readonly residuals: EquilibriumResiduals;
  /** The active product species, curated order (determinism contract). */
  readonly speciesNames: readonly string[];
}

interface CompiledProblem {
  readonly species: readonly Nasa7Species[];
  readonly speciesNames: readonly string[];
  /** a[i][j]: atoms of active element i in product species j. */
  readonly a: readonly (readonly number[])[];
  readonly b0: readonly number[];
  readonly activeElements: readonly ElementName[];
  readonly pressureBar: number;
}

function compileProblem(input: {
  readonly elementTotals: Readonly<Record<string, number>>;
  readonly pressureBar: number;
}): SimParseResult<CompiledProblem, SimError> {
  const pressureBar = input.pressureBar;
  if (!Number.isFinite(pressureBar) || pressureBar <= 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The pressure must be finite and strictly positive (bar); it was ${String(pressureBar)}.`,
        pressureBar,
      ),
    );
  }
  const activeElements: ElementName[] = [];
  const b0: number[] = [];
  let total = 0;
  for (const element of ELEMENTS) {
    const moles = input.elementTotals[element] ?? 0;
    if (!Number.isFinite(moles) || moles < 0) {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          `The element total for ${element} must be finite and non-negative (moles); it was ${String(moles)}.`,
          moles,
        ),
      );
    }
    if (moles > 0) {
      activeElements.push(element);
      b0.push(moles);
    }
    total += moles;
  }
  if (total <= 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "An equilibrium problem needs at least one positive element total.",
        input.elementTotals,
      ),
    );
  }
  const activeSet = new Set<string>(activeElements);
  const species: Nasa7Species[] = [];
  for (const name of EQUILIBRIUM_SPECIES_NAMES) {
    const record = getSpecies(name);
    if (record === undefined) {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          `The equilibrium product set names "${name}", which the curated NASA-7 database does not carry.`,
          name,
        ),
      );
    }
    const supported = Object.keys(record.composition).every((element) =>
      activeSet.has(element),
    );
    if (supported) species.push(record);
  }
  if (species.length === 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "No equilibrium product species carries the requested elements.",
        input.elementTotals,
      ),
    );
  }
  for (const element of activeElements) {
    const carried = species.some(
      (record) => (record.composition[element] ?? 0) > 0,
    );
    if (!carried) {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          `The element ${element} has a positive total but no product species carries it; the balance cannot close.`,
          element,
        ),
      );
    }
  }
  // Feasibility of the starter product set: carbon can ride only CO
  // (one O per C) and CO2 — a mixture richer than b_C = b_O needs solid
  // carbon, which the starter set declines to include. The refusal is
  // loud and structural, not a solver stall.
  const carbonTotal = input.elementTotals["C"] ?? 0;
  const oxygenTotal = input.elementTotals["O"] ?? 0;
  if (carbonTotal > oxygenTotal) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The mixture is too rich for the 11-species product set: ${carbonTotal.toPrecision(6)} mol of carbon against ${oxygenTotal.toPrecision(6)} mol of oxygen — beyond carbon monoxide saturation the equilibrium needs solid carbon, which the starter set declines to include (the honest rich bound of this product set).`,
        { carbonTotal, oxygenTotal },
      ),
    );
  }
  const a = activeElements.map((element) =>
    species.map((record) => record.composition[element] ?? 0),
  );
  return simOk({
    species,
    speciesNames: Object.freeze(species.map((record) => record.name)),
    a,
    b0,
    activeElements: Object.freeze(activeElements),
    pressureBar,
  });
}

/**
 * The complete-combustion seed: element totals distributed over major
 * products (H burns to H₂O first, carbon to CO₂ then CO, an oxygen
 * shortfall leaving H₂; nitrogen and argon inert) with radicals parked
 * a decade below the trace band — the classic initial estimate that
 * lands the Newton march in the physical basin from its first step.
 */
function completeCombustionSeed(compiled: CompiledProblem): number[] {
  const bOf = (element: ElementName): number => {
    const index = compiled.activeElements.indexOf(element);
    return index >= 0 ? (compiled.b0[index] ?? 0) : 0;
  };
  const carbon = bOf("C");
  const hydrogen = bOf("H");
  const oxygen = bOf("O");
  const nitrogen = bOf("N");
  const argon = bOf("AR");
  // Rich-side correctness: carbon burns to CO FIRST (one O each — an
  // H2O-first order starves carbon entirely when oxygen is short,
  // leaving the carbon balance broken at the seed), then hydrogen to
  // H₂O, then leftover oxygen upgrades CO → CO₂ — the upgrade
  // consumes one O atom per upgraded CO (CO + O → CO₂), not one O₂.
  let oLeft = oxygen;
  let co = Math.min(carbon, oLeft);
  oLeft -= co;
  const h2o = Math.min(hydrogen / 2, oLeft);
  oLeft -= h2o;
  const co2 = Math.min(co, oLeft);
  oLeft -= co2;
  co -= co2;
  const h2 = hydrogen / 2 - h2o;
  const o2 = Math.max(oLeft, 0) / 2;
  const seed: number[] = [];
  for (const name of compiled.speciesNames) {
    switch (name) {
      case "CO2":
        seed.push(co2);
        break;
      case "H2O":
        seed.push(h2o);
        break;
      case "O2":
        seed.push(o2);
        break;
      case "CO":
        seed.push(co);
        break;
      case "H2":
        seed.push(h2);
        break;
      case "N2":
        seed.push(nitrogen / 2);
        break;
      case "AR":
        seed.push(argon);
        break;
      default:
        seed.push(TRACE_CONTROL_MOL / 10);
        break;
    }
  }
  return seed.map((value) => Math.max(value, SPECIES_FLOOR_MOL));
}

/**
 * Dense linear solve by Gaussian elimination with partial pivoting
 * (ties to the lowest row — deterministic). Returns undefined on a
 * numerically singular system (declined by the caller, never guessed).
 */
function gaussSolve(
  matrix: readonly (readonly number[])[],
  rhs: readonly number[],
): number[] | undefined {
  const size = rhs.length;
  const m: number[][] = matrix.map((row, i) => [...row, rhs[i] ?? 0]);
  for (let col = 0; col < size; col += 1) {
    let pivotRow = col;
    let pivotAbs = Math.abs(m[col]?.[col] ?? 0);
    for (let row = col + 1; row < size; row += 1) {
      const candidate = Math.abs(m[row]?.[col] ?? 0);
      if (candidate > pivotAbs) {
        pivotRow = row;
        pivotAbs = candidate;
      }
    }
    if (pivotAbs < 1e-280) return undefined;
    const pivotRowValues = m[pivotRow];
    if (pivotRowValues === undefined) return undefined;
    m[pivotRow] = m[col] ?? [];
    m[col] = pivotRowValues;
    const diagonal = m[col]?.[col] ?? 1;
    for (let row = 0; row < size; row += 1) {
      if (row === col) continue;
      const factor = (m[row]?.[col] ?? 0) / diagonal;
      if (factor === 0) continue;
      const target = m[row];
      const source = m[col];
      if (target === undefined || source === undefined) return undefined;
      for (let c = col; c <= size; c += 1) {
        target[c] = (target[c] ?? 0) - factor * (source[c] ?? 0);
      }
    }
  }
  const solution: number[] = [];
  for (let row = 0; row < size; row += 1) {
    solution.push((m[row]?.[size] ?? 0) / (m[row]?.[row] ?? 1));
  }
  return solution;
}

interface IterationState {
  readonly moles: readonly number[];
  readonly potentials: readonly number[];
  readonly temperatureK: number;
}

interface CoreInput {
  readonly problem: "tp" | "hp";
  readonly compiled: CompiledProblem;
  readonly temperatureK: number;
  readonly targetEnthalpyJ: number | undefined;
  readonly maxIterations: number;
  readonly tolerance: number;
}

function mixtureEnthalpyJ(
  species: readonly Nasa7Species[],
  moles: readonly number[],
  tK: number,
): number {
  let h = 0;
  for (const [j, record] of species.entries()) {
    h += (moles[j] ?? 0) * nasa7EnthalpyJPerMol(record, tK);
  }
  return h;
}

function residualsOf(
  core: CoreInput,
  state: IterationState,
): EquilibriumResiduals {
  const { compiled } = core;
  const { species, a, b0 } = compiled;
  const { moles, temperatureK: tK } = state;
  const n = moles.reduce((sum, value) => sum + value, 0);
  const lnP = Math.log(compiled.pressureBar / NASA7_STANDARD_STATE_BAR);
  let worstElement = 0;
  for (const [i] of b0.entries()) {
    let balance = 0;
    for (const [j] of species.entries()) {
      balance += (a[i]?.[j] ?? 0) * (moles[j] ?? 0);
    }
    worstElement = Math.max(
      worstElement,
      Math.abs(balance - (b0[i] ?? 0)) / (b0[i] ?? 1),
    );
  }
  // The potentials are Lagrange multipliers — a FREE gauge: what the
  // stationarity residual must measure is the violation under the
  // BEST-FIT potentials (abundance-weighted least squares over the
  // species' μ_j), not under the march's current iterate. For a pure
  // gas the composition is trivially stationary for any π, and
  // measuring against the iterate would gate a converged solution on
  // a gauge artifact; the refit is also what makes the metric the
  // physically right invariant ("does SOME π satisfy stationarity").
  const fitted = bestFitPotentials(compiled, moles, tK);
  let stationarity = 0;
  for (const [j, record] of species.entries()) {
    const nj = moles[j] ?? 0;
    const mu = nasa7GOverRT(record, tK) + Math.log(nj / n) + lnP;
    let g = mu;
    for (const [i] of b0.entries()) {
      g += (fitted[i] ?? 0) * (a[i]?.[j] ?? 0);
    }
    stationarity += nj * Math.abs(g);
  }
  stationarity /= n;
  const h = mixtureEnthalpyJ(species, moles, tK);
  const target = core.targetEnthalpyJ ?? h;
  // The enthalpy residual scales by the mixture's thermal energy R·T·n,
  // not |H⁰| — a reactant stream can carry H⁰ ≈ 0 J (H2/air), where a
  // relative-to-target normalization is meaningless.
  const scale = GAS_CONSTANT_J_PER_MOL_K * tK * n;
  const enthalpy = Math.abs(h - target) / scale;
  return { elementBalance: worstElement, stationarity, enthalpy };
}

/**
 * The element potentials' initial estimate: least squares over the
 * above-trace species' stationarity (Σ_i π_i a_ij ≈ −μ_j), the linear
 * map from a physical composition to its potentials — starting π at
 * zero against a physical seed composition makes the coupled step's
 * potential terms explode. Tikhonov-damped: a seed can have fewer
 * above-trace species than elements (a near-pure H₂O seed over C/H/O),
 * leaving directions unconstrained — damped toward zero rather than
 * singular.
 */
function initialPotentials(
  compiled: CompiledProblem,
  moles: readonly number[],
  tK: number,
): number[] {
  const { species, a, b0, pressureBar } = compiled;
  const ne = b0.length;
  const nTotal = moles.reduce((sum, value) => sum + value, 0);
  const lnP = Math.log(pressureBar / NASA7_STANDARD_STATE_BAR);
  const mu: number[] = [];
  const weights: number[] = [];
  for (const [j, record] of species.entries()) {
    const nj = moles[j] ?? 0;
    if (nj < TRACE_CONTROL_MOL) {
      mu.push(0);
      weights.push(0);
      continue;
    }
    mu.push(nasa7GOverRT(record, tK) + Math.log(nj / nTotal) + lnP);
    weights.push(1);
  }
  const matrix: number[][] = [];
  const rhs: number[] = [];
  for (const [i] of b0.entries()) {
    const row = new Array<number>(ne).fill(0);
    for (const [k] of b0.entries()) {
      let sum = 0;
      for (const [j] of species.entries()) {
        sum += (weights[j] ?? 0) * (a[i]?.[j] ?? 0) * (a[k]?.[j] ?? 0);
      }
      row[k] = sum;
    }
    let r = 0;
    for (const [j] of species.entries()) {
      r -= (weights[j] ?? 0) * (a[i]?.[j] ?? 0) * (mu[j] ?? 0);
    }
    row[i] = (row[i] ?? 0) + 1e-6;
    matrix.push(row);
    rhs.push(r);
  }
  const solved = gaussSolve(matrix, rhs);
  return solved ?? b0.map(() => 0);
}

/**
 * The best-fit potentials: the least-squares π minimizing
 * Σ_j (μ_j + Σ_i π_i a_ij)² with EVERY species voting equally — the
 * gauge-invariant measure of "does SOME π satisfy stationarity",
 * which is the equilibrium-constant violation the abundance-weighted
 * march cannot see in its below-trace species (a radical parked at
 * 1e-13 with a pending +20 correction would otherwise pass an
 * abundance-weighted gate while dissociation has not happened).
 * Tikhonov-damped against rank deficiency.
 */
function bestFitPotentials(
  compiled: CompiledProblem,
  moles: readonly number[],
  tK: number,
): number[] {
  const { species, a, b0, pressureBar } = compiled;
  const ne = b0.length;
  const nTotal = moles.reduce((sum, value) => sum + value, 0);
  const lnP = Math.log(pressureBar / NASA7_STANDARD_STATE_BAR);
  const mu: number[] = species.map(
    (record, j) =>
      nasa7GOverRT(record, tK) + Math.log((moles[j] ?? 0) / nTotal) + lnP,
  );
  const matrix: number[][] = [];
  const rhs: number[] = [];
  for (const [i] of b0.entries()) {
    const row = new Array<number>(ne).fill(0);
    for (const [k] of b0.entries()) {
      let sum = 0;
      for (const [j] of species.entries()) {
        sum += (a[i]?.[j] ?? 0) * (a[k]?.[j] ?? 0);
      }
      row[k] = sum;
    }
    let r = 0;
    for (const [j] of species.entries()) {
      r -= (a[i]?.[j] ?? 0) * (mu[j] ?? 0);
    }
    row[i] = (row[i] ?? 0) + 1e-9;
    matrix.push(row);
    rhs.push(r);
  }
  const solved = gaussSolve(matrix, rhs);
  return solved ?? b0.map(() => 0);
}

/** Do the residual gates clear for this state? */
function gatesPass(core: CoreInput, state: IterationState): boolean {
  const r = residualsOf(core, state);
  return (
    r.elementBalance < ELEMENT_BALANCE_GATE &&
    r.stationarity < STATIONARITY_GATE &&
    r.enthalpy < ENTHALPY_GATE
  );
}

function solveCore(
  core: CoreInput,
): SimParseResult<EquilibriumSolution, SimError> {
  const { compiled, problem } = core;
  const { species, a, b0 } = compiled;
  const ne = b0.length;
  const isHP = problem === "hp";
  const targetEnthalpyJ = core.targetEnthalpyJ;

  if (!Number.isFinite(core.temperatureK)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `The temperature must be finite (K); it was ${String(core.temperatureK)}.`,
        core.temperatureK,
      ),
    );
  }
  if (
    isHP &&
    (targetEnthalpyJ === undefined || !Number.isFinite(targetEnthalpyJ))
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "An HP problem needs a finite target enthalpy (J).",
        targetEnthalpyJ,
      ),
    );
  }
  const seedK = Math.min(
    Math.max(core.temperatureK, NASA7_T_MIN_K),
    NASA7_T_MAX_K,
  );

  // The seed: complete-combustion composition; for HP the seed
  // temperature solves the fixed-seed energy balance by bisection
  // (H(T) monotone increasing, domain brackets) clamped into the
  // HP basin band. The seed is only a starting point — the Newton
  // march, caps, and residual gates own the truth from here.
  const seedMoles = completeCombustionSeed(compiled);
  let seedTemperatureK = seedK;
  if (isHP) {
    let lo = NASA7_T_MIN_K;
    let hi = NASA7_T_MAX_K;
    for (let i = 0; i < 60; i += 1) {
      const mid = 0.5 * (lo + hi);
      const h = mixtureEnthalpyJ(species, seedMoles, mid);
      if (h < (targetEnthalpyJ ?? 0)) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    seedTemperatureK = Math.min(0.5 * (lo + hi), HP_SEED_T_CLAMP_K);
  }
  let state: IterationState = {
    moles: seedMoles,
    potentials: initialPotentials(compiled, seedMoles, seedTemperatureK),
    temperatureK: seedTemperatureK,
  };

  // The staged march: phase 1 holds the temperature and solves the
  // composition (the TP system); phase 2 — entered only for HP once
  // phase 1's step test passes — releases the temperature from a
  // CONSISTENT state, where the enthalpy row's Δln T is the modest
  // physical number the linearization assumes, instead of the
  // |Δln T| ~ 30 explosion a far-from-stationary state asks for. One
  // budget, one iteration count, one loud decline.
  let temperatureReleased = !isHP;
  let releaseCount = 0;
  let gateMisses = 0;
  let iterations = 0;
  let converged = false;

  while (iterations < core.maxIterations) {
    const phaseIsHP = isHP && temperatureReleased;
    const size = ne + (phaseIsHP ? 2 : 1);
    const tK = state.temperatureK;
    const nTotal = state.moles.reduce((sum, value) => sum + value, 0);
    const lnP = Math.log(compiled.pressureBar / NASA7_STANDARD_STATE_BAR);
    const gValues = species.map((record) => nasa7GOverRT(record, tK));
    const hValues = species.map((record) => nasa7HOverRT(record, tK));
    const cpValues = species.map((record) => nasa7CpOverR(record, tK));

    // Stationarity residual G_j per species; the current element
    // balance b_i and the enthalpy-weighted rows S_i / S.
    const gResidual: number[] = [];
    for (const [j] of species.entries()) {
      const nj = state.moles[j] ?? 0;
      const mu = (gValues[j] ?? 0) + Math.log(nj / nTotal) + lnP;
      let g = mu;
      for (const [i] of b0.entries()) {
        g += (state.potentials[i] ?? 0) * (a[i]?.[j] ?? 0);
      }
      gResidual.push(g);
    }
    const bNow: number[] = [];
    const sRow: number[] = [];
    for (const [i] of b0.entries()) {
      let balance = 0;
      let s = 0;
      for (const [j] of species.entries()) {
        const nj = state.moles[j] ?? 0;
        balance += (a[i]?.[j] ?? 0) * nj;
        s += (a[i]?.[j] ?? 0) * nj * (hValues[j] ?? 0);
      }
      bNow.push(balance);
      sRow.push(s);
    }
    let sTotal = 0;
    let nEquation = 0;
    for (const [j] of species.entries()) {
      const nj = state.moles[j] ?? 0;
      sTotal += nj * (hValues[j] ?? 0);
      nEquation += nj * (gResidual[j] ?? 0);
    }

    // The reduced KKT system, columns [u_0..u_{ne−1}, Δln n, (Δln T)]:
    //   element rows    Σ_k (A W Aᵀ)_ik u_k − b_i Δln n − S_i Δln T
    //                   = b_i − b⁰_i − Σ_j a_ij n_j G_j
    //   total-moles row Σ_k b_k u_k − S Δln T = −Σ_j n_j G_j
    //   enthalpy row    Σ_k S_k u_k − S Δln n − (Σ_j n_j H_j²
    //                   + Σ_j n_j Cp_j/R) Δln T
    //                   = Σ_j n_j H_j G_j − H⁰/(RT) + S
    const matrix: number[][] = [];
    const rhs: number[] = [];
    for (const [i] of b0.entries()) {
      const row = new Array<number>(size).fill(0);
      for (const [k] of b0.entries()) {
        let sum = 0;
        for (const [j] of species.entries()) {
          sum += (a[i]?.[j] ?? 0) * (a[k]?.[j] ?? 0) * (state.moles[j] ?? 0);
        }
        row[k] = sum;
      }
      row[ne] = -(bNow[i] ?? 0);
      if (phaseIsHP) row[ne + 1] = -(sRow[i] ?? 0);
      let awg = 0;
      for (const [j] of species.entries()) {
        awg += (a[i]?.[j] ?? 0) * (state.moles[j] ?? 0) * (gResidual[j] ?? 0);
      }
      rhs.push((bNow[i] ?? 0) - (b0[i] ?? 0) - awg);
      matrix.push(row);
    }
    {
      const row = new Array<number>(size).fill(0);
      for (const [k] of b0.entries()) {
        row[k] = bNow[k] ?? 0;
      }
      if (phaseIsHP) row[ne + 1] = -sTotal;
      rhs.push(-nEquation);
      matrix.push(row);
    }
    if (phaseIsHP) {
      const row = new Array<number>(size).fill(0);
      for (const [k] of b0.entries()) {
        row[k] = sRow[k] ?? 0;
      }
      row[ne] = -sTotal;
      let hhSum = 0;
      let cpSum = 0;
      let shg = 0;
      for (const [j] of species.entries()) {
        const nj = state.moles[j] ?? 0;
        const hj = hValues[j] ?? 0;
        hhSum += nj * hj * hj;
        cpSum += nj * (cpValues[j] ?? 0);
        shg += nj * hj * (gResidual[j] ?? 0);
      }
      row[ne + 1] = -(hhSum + cpSum);
      const h0OverRT = (targetEnthalpyJ ?? 0) / (GAS_CONSTANT_J_PER_MOL_K * tK);
      rhs.push(shg - h0OverRT + sTotal);
      matrix.push(row);
    }

    const step = gaussSolve(matrix, rhs);
    if (step === undefined) {
      return simFail(
        simError(
          SIM_ERROR_CODES.solverUnconverged,
          `The equilibrium Newton system went singular at iteration ${String(iterations)} (temperature ${String(tK)} K) — the run declines rather than guessing a step.`,
          { temperatureK: tK, iterations },
        ),
      );
    }
    const dlnn = step[ne] ?? 0;
    const dlnT = phaseIsHP ? (step[ne + 1] ?? 0) : 0;

    // Species corrections (the CEA 2.56/3.3 family).
    const x: number[] = [];
    for (const [j] of species.entries()) {
      let correction = -(gResidual[j] ?? 0) + dlnn;
      for (const [i] of b0.entries()) {
        correction -= (step[i] ?? 0) * (a[i]?.[j] ?? 0);
      }
      if (phaseIsHP) correction += (hValues[j] ?? 0) * dlnT;
      x.push(correction);
    }

    // Step test (CEA STPTOL) — before applying.
    let stepMetric = 0;
    for (const [j] of species.entries()) {
      stepMetric += (state.moles[j] ?? 0) * Math.abs(x[j] ?? 0);
    }
    stepMetric /= nTotal;
    if (phaseIsHP) stepMetric += Math.abs(dlnT);
    if (stepMetric < core.tolerance) {
      if (!temperatureReleased && isHP) {
        // Phase 1 done: release the temperature and keep marching.
        temperatureReleased = true;
        releaseCount += 1;
        continue;
      }
      // The step test alone is not convergence: a below-trace radical
      // with pending growth is invisible to the abundance-weighted
      // step, so the residual gates (equal-vote stationarity included)
      // must clear too — or the march keeps going, bounded by the
      // consecutive-miss counter declining loudly.
      if (gatesPass(core, state)) {
        converged = true;
        break;
      }
      gateMisses += 1;
      if (gateMisses >= GATE_MISS_LIMIT) break;
    } else {
      gateMisses = 0;
    }

    // Damped application: the CEA SIZE/λ caps and the species floor.
    // λ control excludes species whose step carries them across the
    // trace band in EITHER direction — a species parked at the band
    // edge with a persistently large correction would otherwise cap λ
    // forever and degrade the march to linear convergence; its exact
    // sub-trace abundance is immaterial to every residual the gates
    // measure (the abundance-weighted stationarity and the balances).
    let maxCorrection = 0;
    for (const [j] of species.entries()) {
      const nj = state.moles[j] ?? 0;
      if (nj < TRACE_CONTROL_MOL) continue;
      if (nj * Math.exp(x[j] ?? 0) < TRACE_CONTROL_MOL) continue;
      maxCorrection = Math.max(maxCorrection, Math.abs(x[j] ?? 0));
    }
    const lambdaMax = Math.min(
      1,
      DLNN_CONTROL / Math.max(maxCorrection, 1e-30),
      phaseIsHP ? DLNT_CAP / Math.max(Math.abs(dlnT), 1e-30) : 1,
    );
    const applyStep = (stepLambda: number): IterationState => {
      const nextMoles = state.moles.map((nj, j) => {
        if (nj < TRACE_CONTROL_MOL) {
          // A below-trace species takes its FULL potential-consistent
          // jump now (one step to where the current π says it belongs,
          // capped at a per-step rise to 1 ppm of the mixture) instead
          // of riding e^+2 crawls that throttle λ for everyone: the
          // jump's element perturbation is bounded by the species' own
          // abundance scale and repaired by the next Newton step.
          const riseCap =
            (TRACE_JUMP_MOLE_FRACTION * nTotal) /
            Math.max(nj, SPECIES_FLOOR_MOL);
          const capped = Math.min(x[j] ?? 0, Math.log(Math.max(riseCap, 1)));
          return Math.max(nj * Math.exp(capped), SPECIES_FLOOR_MOL);
        }
        const stepped = nj * Math.exp(stepLambda * (x[j] ?? 0));
        return Number.isFinite(stepped)
          ? Math.max(stepped, SPECIES_FLOOR_MOL)
          : SPECIES_FLOOR_MOL;
      });
      const nextK = phaseIsHP
        ? Math.min(
            Math.max(
              state.temperatureK * Math.exp(stepLambda * dlnT),
              NASA7_T_MIN_K,
            ),
            NASA7_T_MAX_K,
          )
        : state.temperatureK;
      return {
        moles: nextMoles,
        potentials: state.potentials.map(
          (pi, i) => pi + stepLambda * (step[i] ?? 0),
        ),
        temperatureK: nextK,
      };
    };
    // CEA's discipline: apply the capped step unconditionally — no line
    // search. A merit test near the constraint manifold cannot rank the
    // second-order constraint wiggle a stationarity-fixing Newton step
    // introduces (repaired the next iteration) against the residual it
    // leaves, and vetoing it stalls the march; the caps, the
    // trace-band rules, the staged startup, and the re-freeze guard
    // carry global robustness, and the residual gates verify the
    // outcome loudly.
    const next = applyStep(lambdaMax);
    if (
      !next.moles.every(Number.isFinite) ||
      !Number.isFinite(next.temperatureK)
    ) {
      return simFail(
        simError(
          SIM_ERROR_CODES.solverUnconverged,
          `The equilibrium march lost finiteness at iteration ${String(iterations)} (temperature ${String(state.temperatureK)} K) — the run declines rather than fabricating a converged result.`,
          { temperatureK: state.temperatureK, iterations },
        ),
      );
    }
    state = next;
    iterations += 1;
    // Re-freeze guard: temperature steps are only well-posed from a
    // composition-consistent state (the property the staged startup
    // established); if a phase-2 step's transient blows the enthalpy
    // residual up, freeze T again, let phase 1 re-converge the
    // composition, then release once more — bounded, so a hopeless
    // march still meets the iteration cap loudly.
    if (
      phaseIsHP &&
      releaseCount < RELEASE_LIMIT &&
      residualsOf(core, state).enthalpy > REFREEZE_ENTHALPY
    ) {
      temperatureReleased = false;
    }
  }

  const residuals = residualsOf(core, state);
  if (!converged) {
    return simFail(
      simError(
        SIM_ERROR_CODES.solverUnconverged,
        `The equilibrium solver exhausted its discipline after ${String(iterations)} iterations without reaching tolerance (element balance ${residuals.elementBalance.toExponential(3)}, stationarity ${residuals.stationarity.toExponential(3)}, enthalpy ${residuals.enthalpy.toExponential(3)}, temperature ${String(state.temperatureK)} K) — the run declines rather than fabricating a converged result.`,
        {
          iterations,
          ...residuals,
          temperatureK: state.temperatureK,
        },
      ),
    );
  }
  if (
    residuals.elementBalance > ELEMENT_BALANCE_GATE ||
    residuals.stationarity > STATIONARITY_GATE ||
    residuals.enthalpy > ENTHALPY_GATE
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.solverUnconverged,
        `The equilibrium solver's step test passed but its residuals missed the gates (element balance ${residuals.elementBalance.toExponential(3)}, stationarity ${residuals.stationarity.toExponential(3)}, enthalpy ${residuals.enthalpy.toExponential(3)}) — the run declines rather than fabricating a converged result.`,
        residuals,
      ),
    );
  }

  const nTotal = state.moles.reduce((sum, value) => sum + value, 0);
  const molesOut: Record<string, number> = {};
  const fractions: Record<string, number> = {};
  let mass = 0;
  let gibbsJ = 0;
  const lnP = Math.log(compiled.pressureBar / NASA7_STANDARD_STATE_BAR);
  for (const [j, record] of species.entries()) {
    const nj = state.moles[j] ?? 0;
    molesOut[record.name] = nj;
    fractions[record.name] = nj / nTotal;
    mass += nj * record.molecularWeightKgPerKmol;
    const muOverRT =
      nasa7GOverRT(record, state.temperatureK) + Math.log(nj / nTotal) + lnP;
    gibbsJ += nj * muOverRT * GAS_CONSTANT_J_PER_MOL_K * state.temperatureK;
  }
  const solution: EquilibriumSolution = {
    problem,
    temperatureK: state.temperatureK,
    pressureBar: compiled.pressureBar,
    moles: Object.freeze(molesOut),
    moleFractions: Object.freeze(fractions),
    totalMoles: nTotal,
    enthalpyJ: mixtureEnthalpyJ(species, state.moles, state.temperatureK),
    gibbsJ,
    meanMolecularWeightKgPerKmol: mass / nTotal,
    iterations,
    residuals,
    speciesNames: compiled.speciesNames,
  };
  return simOk(solution);
}

function optionsOr(options: EquilibriumSolverOptions | undefined): {
  readonly maxIterations: number;
  readonly tolerance: number;
} {
  return {
    maxIterations: options?.maxIterations ?? 500,
    tolerance: options?.tolerance ?? 1e-9,
  };
}

/**
 * Solves the TP problem: equilibrium composition at fixed temperature
 * and pressure. `elementTotals` in moles; the product set is the
 * curated starter set restricted to the elements present.
 */
export function solveEquilibriumTP(input: {
  readonly elementTotals: Readonly<Record<string, number>>;
  readonly temperatureK: number;
  readonly pressureBar: number;
  readonly options?: EquilibriumSolverOptions;
}): SimParseResult<EquilibriumSolution, SimError> {
  const compiled = compileProblem(input);
  if (!compiled.ok) return compiled;
  return solveCore({
    problem: "tp",
    compiled: compiled.value,
    temperatureK: input.temperatureK,
    targetEnthalpyJ: undefined,
    ...optionsOr(input.options),
  });
}

/**
 * Solves the HP problem: equilibrium at fixed pressure and total
 * enthalpy — the adiabatic equilibrium state. `initialTemperatureK`
 * seeds the march (the reactant temperature is the natural seed; the
 * staged startup walks it to the flame temperature).
 */
export function solveEquilibriumHP(input: {
  readonly elementTotals: Readonly<Record<string, number>>;
  readonly targetEnthalpyJ: number;
  readonly pressureBar: number;
  readonly initialTemperatureK: number;
  readonly options?: EquilibriumSolverOptions;
}): SimParseResult<EquilibriumSolution, SimError> {
  const compiled = compileProblem(input);
  if (!compiled.ok) return compiled;
  return solveCore({
    problem: "hp",
    compiled: compiled.value,
    temperatureK: input.initialTemperatureK,
    targetEnthalpyJ: input.targetEnthalpyJ,
    ...optionsOr(input.options),
  });
}
