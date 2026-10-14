/**
 * Friction as force-limited constraints with emergent slip (Phase 67a,
 * the §7.10 ruling + the AngeTheGreat design input): the viscous and
 * Coulomb terms of the additive joint-record fields are part of the
 * STEP's velocity solve — never a post-pass — so the same inputs always
 * produce the same outputs (law S2).
 *
 * ## The formulation (velocity level, per joint DOF)
 *
 * The step solves for the next generalized velocities ω′ under
 *
 *   M̃·ω′ − dt·f − Jᵀλ = b,   J·ω′ = target,
 *
 * with M̃ = M + dt·D (the mass matrix — rotor inertias included — plus
 * the IMPLICIT viscous term: unconditionally stable, the exponential
 * decay's honest discrete form), b = M·ω + dt·p (p = gravity, bias,
 * motor, efforts, loads), J the closed-loop rows' Jacobian (Phase 67a's
 * loop closure) with their Baumgarte target, and per DOF the Coulomb
 * force f_i constrained to the CONE |f_i| ≤ T_i with the complementarity:
 *
 * - STICK (|s_i| ≤ dt·T_i, s_i the net drive arriving at the DOF):
 *   ω′_i = 0 and f_i = −s_i/dt — a FREE reaction force inside the cone.
 * - SLIP (|s_i| > dt·T_i): f_i = −T_i·sign(s_i) at the cone's edge,
 *   ω′_i = sign(s_i)·(|s_i| − dt·T_i)/M̃_ii — the slip is EMERGENT, and
 *   coming to rest inside a step lands exactly on ω′_i = 0 (the
 *   velocity cannot cross zero under a force that opposes it).
 *
 * Breakaway is the same Coulomb value — stiction is this cone, stated
 * honestly; there is no separate stiction model unless a ruling adds
 * one. Dissipation follows from the solved force: per DOF,
 * d·ω′² + |f_i·ω′| ≥ 0 (the conservation-audit term).
 *
 * ## The solver choice, on evidence (the prior-art ruling)
 *
 * Projected Gauss–Seidel with WARM STARTS over the cone DOFs, wrapped
 * in a fixed-point against the loop equalities' direct KKT solve — the
 * "sparse Gauss-Seidel with warm starts won over CG on velocity
 * constraints" verdict, restated at assembly scale with PINNED
 * iteration counts (below) so providers benchmark against a fixed
 * discipline. Deterministic: fixed sweep order, fixed pivoting, early
 * exit only on bitwise-identical successive iterates.
 */

/** Gauss–Seidel sweeps per outer iteration (pinned). */
export const FRICTION_PGS_SWEEPS = 24;

/** Outer fixed-point iterations against the equality rows (pinned). */
export const CONE_OUTER_ITERATIONS = 8;

/** The pivot floor of the dense solves (the mate-solver's constant). */
const DENSE_PIVOT_FLOOR = 1e-12;

/** One velocity-cone solve's outcome. */
export interface VelocityConeSolution {
  /** The solved next generalized velocities. */
  readonly velocities: readonly number[];
  /** The Coulomb force per DOF at the solution (N·m | N). */
  readonly coulombForces: readonly number[];
  /** The equality-row multipliers (loop closure). */
  readonly multipliers: readonly number[];
  /** The outer iterations consumed (≤ the pinned cap). */
  readonly iterations: number;
}

/** What one sweep of the cone projection consumes and produces. */
interface ConeProjectionInput {
  /** M̃ (ndof × ndof, row-major rows) — mass + implicit viscous. */
  readonly mass: readonly (readonly number[])[];
  /** The right-hand side b = M·ω + dt·p. */
  readonly rhs: readonly number[];
  /** The Coulomb cone limit per DOF (0 = frictionless). */
  readonly limits: readonly number[];
  readonly dt: number;
  /** The equality Jacobian rows (each ndof long); empty when loop-free. */
  readonly constraintRows: readonly (readonly number[])[];
  /** The equality targets (Baumgarte-corrected). */
  readonly constraintTargets: readonly number[];
  /** Warm starts: previous velocities, Coulomb forces, multipliers. */
  readonly warmVelocities: readonly number[];
  readonly warmForces: readonly number[];
  readonly warmMultipliers: readonly number[];
}

/**
 * Solves the velocity-level cone problem. Pure: no state, no clock —
 * identical inputs produce bitwise-identical outputs.
 *
 * The outer loop alternates the KKT linear solve (given the current
 * friction forces) with projected Gauss–Seidel sweeps that update each
 * DOF's friction force AND velocity directly: per DOF, with all else
 * frozen, the branch enforces `M̃·ω′ = b + dt·f` exactly (stick sets
 * ω′ = 0 with the free reaction `f = −s/dt` inside the cone; slip sets
 * f at the cone's edge opposing the drive, and ω′ follows).
 */
export function solveVelocityCone(
  input: ConeProjectionInput,
): VelocityConeSolution | undefined {
  const ndof = input.rhs.length;
  let velocities = [...input.warmVelocities];
  const forces = [...input.warmForces];
  let multipliers = [...input.warmMultipliers];
  let iterations = 0;
  for (let outer = 0; outer < CONE_OUTER_ITERATIONS; outer += 1) {
    iterations = outer + 1;
    // 1. The linear solve for ω′ and λ at the CURRENT forces: the KKT
    //    system [M̃ −Jᵀ; J 0]·[ω′; λ] = [b + dt·f; target].
    const solved = solveKkt(
      input.mass,
      input.constraintRows,
      addScaled(input.rhs, forces, input.dt),
      input.constraintTargets,
    );
    if (solved === undefined) return undefined;
    velocities = solved.slice(0, ndof);
    multipliers = solved.slice(ndof);
    // 2. The cone projection sweeps (Gauss–Seidel): the drive s_i is the
    //    F-free row residual with DOF i removed — f_i is the unknown.
    for (let sweep = 0; sweep < FRICTION_PGS_SWEEPS; sweep += 1) {
      let changed = false;
      for (let i = 0; i < ndof; i += 1) {
        const drive = rowDrive(input, velocities, multipliers, i);
        const limit = input.limits[i] ?? 0;
        const cone = limit * input.dt;
        const diagonal = input.mass[i]?.[i] ?? 0;
        const previous = forces[i] ?? 0;
        const previousVelocity = velocities[i] ?? 0;
        let force: number;
        let velocity: number;
        if (Math.abs(drive) <= cone) {
          // Stick: the free reaction holds the DOF, ω′ = 0 exactly.
          force = cone === 0 ? 0 : -drive / input.dt;
          velocity = 0;
        } else {
          const sign = drive > 0 ? 1 : -1;
          force = -sign * limit;
          velocity = (sign * (Math.abs(drive) - cone)) / diagonal;
        }
        if (force !== previous || velocity !== previousVelocity) {
          changed = true;
          forces[i] = force;
          velocities[i] = velocity;
        }
      }
      if (!changed) break;
    }
    // 3. Settled when a repeat linear solve reproduces the projected
    //    velocities bitwise; the projected values are the answer either
    //    way (the sweeps enforce the row equations exactly per DOF).
    const resigned = solveKkt(
      input.mass,
      input.constraintRows,
      addScaled(input.rhs, forces, input.dt),
      input.constraintTargets,
    );
    if (resigned === undefined) return undefined;
    let settled = true;
    for (let i = 0; i < ndof; i += 1) {
      if ((resigned[i] ?? 0) !== (velocities[i] ?? 0)) {
        settled = false;
        break;
      }
    }
    if (settled) {
      multipliers = resigned.slice(ndof);
      break;
    }
  }
  return {
    velocities: [...velocities],
    coulombForces: [...forces],
    multipliers: [...multipliers],
    iterations,
  };
}

/**
 * The net drive arriving at DOF i with all else frozen — the row
 * residual with DOF i's own force and velocity removed:
 * `s_i = b_i + (Jᵀλ)_i − Σ_{j≠i} M̃_ij·ω′_j`.
 */
function rowDrive(
  input: ConeProjectionInput,
  velocities: readonly number[],
  multipliers: readonly number[],
  i: number,
): number {
  const row = input.mass[i] ?? [];
  let sum = input.rhs[i] ?? 0;
  for (let j = 0; j < row.length; j += 1) {
    if (j !== i) sum -= (row[j] ?? 0) * (velocities[j] ?? 0);
  }
  for (let m = 0; m < input.constraintRows.length; m += 1) {
    const jacobianRow = input.constraintRows[m] ?? [];
    const multiplier = multipliers[m] ?? 0;
    sum += (jacobianRow[i] ?? 0) * multiplier;
  }
  return sum;
}

/** `base + scale·term` elementwise. */
function addScaled(
  base: readonly number[],
  term: readonly number[],
  scale: number,
): number[] {
  return base.map((value, index) => value + scale * (term[index] ?? 0));
}

/**
 * Solves the KKT system `[M̃ −Jᵀ; J 0]·x = [rhs; targets]` by
 * fixed-pivot Gaussian elimination — the mate solver's dense solve
 * restated (partial pivoting by column max, same pivot floor).
 * `undefined` when structurally singular (the caller declines loudly).
 */
export function solveKkt(
  mass: readonly (readonly number[])[],
  constraintRows: readonly (readonly number[])[],
  rhs: readonly number[],
  targets: readonly number[],
): number[] | undefined {
  const ndof = rhs.length;
  const ncon = targets.length;
  const a: number[][] = [];
  for (let i = 0; i < ndof; i += 1) {
    const row = [...(mass[i] ?? [])];
    for (let m = 0; m < ncon; m += 1) {
      row.push(-1 * (constraintRows[m]?.[i] ?? 0));
    }
    a.push(row);
  }
  for (let m = 0; m < ncon; m += 1) {
    const row = [...(constraintRows[m] ?? [])];
    for (let k = 0; k < ncon; k += 1) row.push(0);
    a.push(row);
  }
  return solveDense(a, [...rhs, ...targets]);
}

/** Fixed-pivot dense Gaussian elimination (the mate-solver restatement). */
export function solveDense(
  matrix: readonly (readonly number[])[],
  rhs: readonly number[],
): number[] | undefined {
  const n = rhs.length;
  const a = matrix.map((row) => [...row]);
  const b = [...rhs];
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    let best = Math.abs(a[col]?.[col] ?? 0);
    for (let row = col + 1; row < n; row += 1) {
      const candidate = Math.abs(a[row]?.[col] ?? 0);
      if (candidate > best) {
        best = candidate;
        pivot = row;
      }
    }
    if (best < DENSE_PIVOT_FLOOR) return undefined;
    if (pivot !== col) {
      const swap = a[col];
      a[col] = a[pivot] ?? [];
      if (swap !== undefined) a[pivot] = swap;
      const bSwap = b[col] ?? 0;
      b[col] = b[pivot] ?? 0;
      b[pivot] = bSwap;
    }
    const pivotRow = a[col] ?? [];
    for (let row = col + 1; row < n; row += 1) {
      const factor = (a[row]?.[col] ?? 0) / (pivotRow[col] ?? 1);
      const rowRef = a[row];
      if (rowRef === undefined) continue;
      for (let k = col; k < n; k += 1) {
        rowRef[k] = (rowRef[k] ?? 0) - factor * (pivotRow[k] ?? 0);
      }
      b[row] = (b[row] ?? 0) - factor * (b[col] ?? 0);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = b[row] ?? 0;
    for (let k = row + 1; k < n; k += 1) {
      sum -= (a[row]?.[k] ?? 0) * (x[k] ?? 0);
    }
    x[row] = sum / (a[row]?.[row] ?? 1);
  }
  return x;
}

/**
 * The dissipated power of one DOF at the solved state:
 * viscous `d·ω′²` plus Coulomb `|f·ω′|` — ≥ 0 by construction.
 */
export function dissipatedPowerW(
  viscous: number,
  rate: number,
  coulombForce: number,
): number {
  return viscous * rate * rate + Math.abs(coulombForce * rate);
}
