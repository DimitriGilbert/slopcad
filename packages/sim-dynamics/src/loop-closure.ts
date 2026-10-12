/**
 * Closed-loop closure through the existing LM machinery (Phase 67a):
 * when a joint closes a cycle the spanning tree cannot carry, the
 * kernel treats it as a CONSTRAINT — the mate solver's Levenberg–
 * Marquardt discipline restated in the tree's generalized coordinates,
 * with the same fixed constants (forward-difference Jacobian at 1e-7,
 * the 1e-3 damping schedule λ/3 on improvement and 2λ otherwise, the
 * 100-iteration cap, fixed-pivot dense solves) so the two solvers stay
 * behaviorally pinned (the dev-only cross-compat suite runs cad-core's
 * `solveAssemblyMates` per joint kind and checks this projection
 * accepts its zero-station poses, keeps them accepted along every
 * granted motion, and detects violations; the discipline constants are
 * pinned to the mate solver's own).
 *
 * The closure mechanism, stated honestly:
 *
 * - The loop joint's residual rows are the mate solver's joint rows
 *   VERBATIM in SI (per kind: exactly the 6-minus-granted-DOF rows; a
 *   granted DOF produces no row, so the rows vanish for EVERY
 *   configuration the joint allows — they measure only violation).
 * - VELOCITY level: the rows' finite-difference Jacobian enters the
 *   step's cone solve as equality rows with a Baumgarte target
 *   (−(β/dt)·r), so the constraint impulses (the loop's reaction
 *   wrench) and the friction cones solve in ONE warm-started
 *   discipline.
 * - POSITION level: after integration, an LM projection over the
 *   generalized coordinates drives every row under the 1e-9 m/rad
 *   tolerance; a projection that exhausts its iteration discipline
 *   above tolerance declines the step (`sim/loop-unresolved`) — a
 *   snapped mechanism is never fabricated.
 *
 * Loop reactions are the multiplier-weighted dual wrench of the rows
 * (force along a position row's direction, torque about an orientation
 * row's direction) — exact for the force and tilt rows, and the
 * roll-row dual is reported along the joint's world axis (the
 * leading-order term), documented as the multiplier view.
 */

import type { DoorJointKind } from "./door";

import { solveDense } from "./friction";
import { auxiliaryBasis, type JointDofLayout } from "./joints";
import {
  add3,
  cross3,
  type Mat3,
  mulMat3Vec,
  sub3,
  type Vec3,
} from "./spatial";

/** The LM iteration cap (the mate solver's constant). */
export const LOOP_LM_MAX_ITERATIONS = 100;

/** The forward-difference step of the loop Jacobian (the mate solver's constant, SI). */
export const LOOP_FD_STEP = 1e-7;

/** The residual under which a loop row counts as closed (m | rad, SI restatement). */
export const LOOP_CLOSURE_TOLERANCE = 1e-9;

/** The initial LM damping (the mate solver's schedule). */
const LOOP_LM_INITIAL_LAMBDA = 1e-3;

/** The Baumgarte coupling of the velocity-level target (pinned). */
export const LOOP_BAUMGARTE_BETA = 0.2;

/** One closing-loop joint in kernel terms (body indices, SI frame). */
export interface LoopJointConstraint {
  readonly id: string;
  readonly kind: DoorJointKind;
  readonly baseBodyIndex: number;
  readonly movedBodyIndex: number;
  /** The joint origin, base-local, m. */
  readonly origin: Vec3;
  /** The unit axis, base-local (undefined for ball; the base's local z for rigid). */
  readonly axis: Vec3 | undefined;
  readonly layout: JointDofLayout;
}

/** The dual of one residual row: a force direction or a torque direction. */
export interface LoopRowDual {
  readonly type: "force" | "torque";
  readonly direction: Vec3;
}

/** A body pose the rows evaluate against. */
export interface PoseView {
  readonly r: Mat3;
  readonly t: Vec3;
}

/**
 * One loop joint's residual rows and their duals at the current poses —
 * the mate solver's `jointResidualRows` restated in SI (same row forms,
 * same order, same auxiliary basis).
 */
export function loopRowsAndDuals(
  constraint: LoopJointConstraint,
  base: PoseView,
  moved: PoseView,
): {
  readonly rows: readonly number[];
  readonly duals: readonly LoopRowDual[];
} {
  const frameOrigin = constraint.origin;
  const frameAxisLocal = constraint.axis ?? [0, 0, 1];
  const worldAxis = mulMat3Vec(base.r, frameAxisLocal);
  const worldOrigin = add3(base.t, mulMat3Vec(base.r, frameOrigin));
  const movedZ = mulMat3Vec(moved.r, [0, 0, 1]);
  const movedX = mulMat3Vec(moved.r, [1, 0, 0]);
  const [e1, e2] = auxiliaryBasis(worldAxis);
  const delta = sub3(moved.t, worldOrigin);
  const tilt = cross3(worldAxis, movedZ);
  const rows: number[] = [];
  const duals: LoopRowDual[] = [];
  const pushLinear = (direction: Vec3): void => {
    rows.push(dot(direction, delta));
    duals.push({ type: "force", direction });
  };
  const pushTilt = (direction: Vec3): void => {
    rows.push(dot(direction, tilt));
    duals.push({ type: "torque", direction });
  };
  const pushRoll = (): void => {
    rows.push(dot(e1, movedX));
    duals.push({ type: "torque", direction: worldAxis });
  };
  switch (constraint.kind) {
    case "rigid":
      pushLinear([1, 0, 0]);
      pushLinear([0, 1, 0]);
      pushLinear([0, 0, 1]);
      pushTilt(e1);
      pushTilt(e2);
      pushRoll();
      break;
    case "revolute":
      pushLinear(e1);
      pushLinear(e2);
      pushLinear(worldAxis);
      pushTilt(e1);
      pushTilt(e2);
      break;
    case "slider":
      pushLinear(e1);
      pushLinear(e2);
      pushTilt(e1);
      pushTilt(e2);
      pushRoll();
      break;
    case "cylindrical":
      pushLinear(e1);
      pushLinear(e2);
      pushTilt(e1);
      pushTilt(e2);
      break;
    case "planar":
      pushLinear(worldAxis);
      pushTilt(e1);
      pushTilt(e2);
      break;
    case "ball":
      pushLinear([1, 0, 0]);
      pushLinear([0, 1, 0]);
      pushLinear([0, 0, 1]);
      break;
  }
  return { rows, duals };
}

/** The worst |row| over a residual vector. */
export function worstResidual(rows: readonly number[]): number {
  let worst = 0;
  for (const row of rows) {
    if (Math.abs(row) > worst) worst = Math.abs(row);
  }
  return worst;
}

/** The generalized-coordinate view the projection operates on. */
export interface LoopProjectionView {
  /** The residual rows of every loop joint at generalized coordinates `q`. */
  readonly rowsAt: (q: readonly number[]) => readonly number[];
  /** The tangent update q ⊕ δ (the integration op: component-wise for every kind). */
  readonly applyDelta: (
    q: readonly number[],
    delta: readonly number[],
  ) => readonly number[];
}

/** The projection's outcome. */
export interface LoopProjectionOutcome {
  readonly q: readonly number[];
  readonly iterations: number;
  /** The worst |row| the projection settled at. */
  readonly residual: number;
}

/**
 * The LM position projection over the generalized coordinates: drives
 * every loop row under {@link LOOP_CLOSURE_TOLERANCE} or reports the
 * residual it froze at (the caller declines above tolerance — never a
 * fabricated closure). Deterministic: fixed constants, fixed order.
 */
export function projectLoops(
  view: LoopProjectionView,
  q: readonly number[],
): LoopProjectionOutcome {
  let current = [...q];
  let rows = view.rowsAt(current);
  let sse = rows.reduce((sum, row) => sum + row * row, 0);
  let lambda = LOOP_LM_INITIAL_LAMBDA;
  let iterations = 0;
  for (; iterations < LOOP_LM_MAX_ITERATIONS; iterations += 1) {
    if (worstResidual(rows) < LOOP_CLOSURE_TOLERANCE) break;
    const jacobian = loopJacobian(view, current, rows);
    const size = current.length;
    // Normal equations (JᵀJ + λI)·δ = −Jᵀr, damped — the LM discipline.
    const normal: number[][] = [];
    for (let i = 0; i < size; i += 1) {
      const row = new Array<number>(size).fill(0);
      for (let j = 0; j < size; j += 1) {
        let sum = 0;
        for (let r = 0; r < rows.length; r += 1) {
          sum += (jacobian[i]?.[r] ?? 0) * (jacobian[j]?.[r] ?? 0);
        }
        row[j] = sum + (i === j ? lambda : 0);
      }
      normal.push(row);
    }
    const gradient: number[] = new Array<number>(size).fill(0);
    for (let i = 0; i < size; i += 1) {
      let sum = 0;
      for (let r = 0; r < rows.length; r += 1) {
        sum += (jacobian[i]?.[r] ?? 0) * (rows[r] ?? 0);
      }
      gradient[i] = -sum;
    }
    const step = solveDense(normal, gradient);
    if (step === undefined) break;
    const candidate = view.applyDelta(current, step);
    const candidateRows = view.rowsAt(candidate);
    const candidateSse = candidateRows.reduce((sum, row) => sum + row * row, 0);
    if (candidateSse < sse) {
      current = [...candidate];
      rows = candidateRows;
      sse = candidateSse;
      lambda = lambda / 3;
    } else {
      lambda = lambda * 2;
    }
    if (step.reduce((norm, entry) => norm + entry * entry, 0) < 1e-24) {
      break;
    }
  }
  return {
    q: current,
    iterations,
    residual: worstResidual(rows),
  };
}

/** The forward-difference Jacobian ∂rows/∂q at the current station. */
function loopJacobian(
  view: LoopProjectionView,
  q: readonly number[],
  rows: readonly number[],
): number[][] {
  const jacobian: number[][] = [];
  for (let k = 0; k < q.length; k += 1) {
    const delta = new Array<number>(q.length).fill(0);
    delta[k] = LOOP_FD_STEP;
    const perturbedRows = view.rowsAt(view.applyDelta(q, delta));
    jacobian.push(
      perturbedRows.map(
        (row, index) => (row - (rows[index] ?? 0)) / LOOP_FD_STEP,
      ),
    );
  }
  return jacobian;
}

/**
 * The velocity projection q̇ ← q̇ − J⁺·(J·q̇): the rates stay in the
 * constraint manifold's tangent after the position snap (minimum-norm
 * correction through the normal equations of the least-squares dual).
 */
export function projectLoopVelocities(
  jacobian: readonly (readonly number[])[],
  rates: readonly number[],
): readonly number[] {
  if (jacobian.length === 0) return rates;
  const rows = jacobian.length;
  const normal: number[][] = [];
  for (let m = 0; m < rows; m += 1) {
    const row: number[] = new Array<number>(rows).fill(0);
    for (let n = 0; n < rows; n += 1) {
      let sum = 0;
      for (let k = 0; k < rates.length; k += 1) {
        sum += (jacobian[m]?.[k] ?? 0) * (jacobian[n]?.[k] ?? 0);
      }
      row[n] = sum;
    }
    normal.push(row);
  }
  const target: number[] = new Array<number>(rows).fill(0);
  for (let m = 0; m < rows; m += 1) {
    let sum = 0;
    for (let k = 0; k < rates.length; k += 1) {
      sum += (jacobian[m]?.[k] ?? 0) * (rates[k] ?? 0);
    }
    target[m] = sum;
  }
  const dual = solveDense(normal, target);
  if (dual === undefined) return rates;
  return rates.map(
    (rate, k) =>
      rate -
      dual.reduce(
        (sum, multiplier, m) => sum + multiplier * (jacobian[m]?.[k] ?? 0),
        0,
      ),
  );
}

/** Assembles a loop joint's reaction wrench from the equality multipliers and row duals. */
export function loopReactionWrench(
  duals: readonly LoopRowDual[],
  multipliers: readonly number[],
): { forceN: Vec3; torqueNPerM: Vec3 } {
  let fx = 0;
  let fy = 0;
  let fz = 0;
  let tx = 0;
  let ty = 0;
  let tz = 0;
  for (let index = 0; index < duals.length; index += 1) {
    const dual = duals[index];
    const multiplier = multipliers[index] ?? 0;
    if (dual === undefined) continue;
    if (dual.type === "force") {
      fx += dual.direction[0] * multiplier;
      fy += dual.direction[1] * multiplier;
      fz += dual.direction[2] * multiplier;
    } else {
      tx += dual.direction[0] * multiplier;
      ty += dual.direction[1] * multiplier;
      tz += dual.direction[2] * multiplier;
    }
  }
  return { forceN: [fx, fy, fz], torqueNPerM: [tx, ty, tz] };
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
