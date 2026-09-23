/**
 * The assembly mate solver (Phase 51): the deterministic numeric solve
 * that places a document's occurrences so their mates hold and their
 * joints sit at their zero station, with DOF accounting and structured
 * diagnostics in the sketch solver's vocabulary and status model.
 *
 * ## Stage discipline (the roadmap's staging note, kept)
 *
 * Mates-without-motion first: the solver drives every free occurrence's
 * 6-DOF pose to a residual-stationary point of the mate residuals, with
 * each joint holding its zero station (the moved occurrence's frame
 * anchored at the joint frame — the joint-frame convention the motion
 * algebra of `mates.ts` pivots about). Remaining-DOF MOTION — dragging
 * along the joints' granted directions — is Phase 52's surface; what this
 * module contributes to it is the DOF table, the joint-frame convention,
 * and the motion transform already exported there.
 *
 * ## Determinism is the contract
 *
 * Levenberg-Marquardt over fixed-order residuals: mates in document
 * order, then joints in document order; forward-difference Jacobian at a
 * fixed step; a fixed-pivot dense solve; a fixed damping schedule. No
 * randomness, no clock, no re-orthonormalization — identical inputs
 * solve bitwise-identically (pinned by the determinism fixtures), and
 * the reference solver's closed forms give the golden values the numeric
 * solve is checked against.
 *
 * ## Diagnostics reuse the sketch status model
 *
 * `solved` / `under-constrained` / `conflicting` with structured
 * `assembly/mate-*` codes (the sketch solver's
 * under-constrained/conflicting/not-converged vocabulary, assembly-
 * scoped): an unresolvable endpoint is `assembly/mate-unresolved`, a
 * solve that cannot drive the residual under tolerance is
 * `assembly/mate-conflicting`, and a stationary point with remaining
 * system DOF is `assembly/mate-underconstrained` at info severity.
 */

import { type DatumVec3 } from "./datum";
import { type OccurrenceId } from "./ids";
import {
  JOINT_REMAINING_DOF,
  normalizeJointAxis,
  transposePlacementRotation,
  type DocumentJoint,
  type DocumentMate,
} from "./mates";
import {
  composePlacementTransforms,
  IDENTITY_PLACEMENT_TRANSFORM,
  type PlacementRotation,
  type PlacementTransform,
} from "./placement";

/** The residual under which a mate row counts as holding (mm / radian). */
export const MATE_RESIDUAL_TOLERANCE = 1e-9;

/** The rank tolerance of the solve's DOF-accounting Jacobian. */
export const MATE_DOF_RANK_TOLERANCE = 1e-8;

/** Solver status — the sketch status vocabulary, assembly-scoped. */
export const ASSEMBLY_SOLVE_STATUSES = [
  "solved",
  "underConstrained",
  "conflicting",
  "unresolved",
] as const;

export type AssemblySolveStatus = (typeof ASSEMBLY_SOLVE_STATUSES)[number];

/** Structured solver diagnostic codes (`assembly/mate-*`, per the contract). */
export const ASSEMBLY_SOLVE_DIAGNOSTIC_CODES = {
  mateUnresolved: "assembly/mate-unresolved",
  conflicting: "assembly/mate-conflicting",
  underConstrained: "assembly/mate-underconstrained",
} as const;

export type AssemblySolveDiagnosticCode =
  (typeof ASSEMBLY_SOLVE_DIAGNOSTIC_CODES)[keyof typeof ASSEMBLY_SOLVE_DIAGNOSTIC_CODES];

/** One structured solver diagnostic (the sketch diagnostic shape). */
export interface AssemblySolveDiagnostic {
  readonly severity: "info" | "warning" | "error";
  readonly code: AssemblySolveDiagnosticCode;
  readonly message: string;
}

/**
 * A resolved mate anchor: the executor-boundary form of one mate
 * endpoint — the mated topology entity's frame in the occurrence's LOCAL
 * coordinates (position plus orientation axes; the plane/axis normal in
 * z, the angle reference in x), its entity class, and the cylinder
 * radius `tangent` mates measure against.
 */
export interface MateAnchor {
  readonly kind: "point" | "line" | "plane" | "axis";
  readonly transform: PlacementTransform;
  readonly radius?: number;
}

/** Anchors for both endpoints of one mate, keyed by the mate's id. */
export type MateAnchorTable = ReadonlyMap<
  string,
  { readonly first: MateAnchor; readonly second: MateAnchor }
>;

/** The solve's inputs (all host-supplied; cad-core owns the algebra). */
export interface AssemblySolveInput {
  /** Every occurrence the mates and joints address, in document order. */
  readonly occurrences: readonly OccurrenceId[];
  /** Occurrences held fixed (the solver's ground). */
  readonly grounded: readonly OccurrenceId[];
  readonly mates: readonly DocumentMate[];
  readonly joints: readonly DocumentJoint[];
  /** Each occurrence's initial (current) placement, world. */
  readonly initial: ReadonlyMap<OccurrenceId, PlacementTransform>;
  readonly anchors: MateAnchorTable;
}

/** The solve's outcome. */
export interface AssemblySolveResult {
  readonly status: AssemblySolveStatus;
  readonly diagnostics: readonly AssemblySolveDiagnostic[];
  /** Solved world placement per occurrence (initial placement when unmoved). */
  readonly transforms: ReadonlyMap<OccurrenceId, PlacementTransform>;
  /** The final residual (the worst row's absolute value). */
  readonly residual: number;
  /** Remaining system degrees of freedom at the solution (Jacobian rank). */
  readonly dof: number;
  readonly iterations: number;
}

// ---------------------------------------------------------------------------
// Rotation-vector algebra (the 6-DOF parameterization)
// ---------------------------------------------------------------------------

/** The cross-product (skew) companion of a rotation vector. */
function skew(v: DatumVec3): PlacementRotation {
  return [0, -v[2], v[1], v[2], 0, -v[0], -v[1], v[0], 0];
}

/** Rodrigues exponential map: rotation vector -> row-major matrix. */
export function rotationVectorToMatrix(v: DatumVec3): PlacementRotation {
  const theta = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  const K = skew(v);
  if (theta < 1e-8) {
    // First-two-term series keeps small angles exact and continuous.
    const s = 1 - (theta * theta) / 6;
    const c = 0.5 - (theta * theta) / 24;
    return [
      1 + s * K[0] + c * (K[0] * K[0] + K[1] * K[3] + K[2] * K[6]),
      s * K[1] + c * (K[0] * K[1] + K[1] * K[4] + K[2] * K[7]),
      s * K[2] + c * (K[0] * K[2] + K[1] * K[5] + K[2] * K[8]),
      s * K[3] + c * (K[3] * K[0] + K[4] * K[3] + K[5] * K[6]),
      1 + s * K[4] + c * (K[3] * K[1] + K[4] * K[4] + K[5] * K[7]),
      s * K[5] + c * (K[3] * K[2] + K[4] * K[5] + K[5] * K[8]),
      s * K[6] + c * (K[6] * K[0] + K[7] * K[3] + K[8] * K[6]),
      s * K[7] + c * (K[6] * K[1] + K[7] * K[4] + K[8] * K[7]),
      1 + s * K[8] + c * (K[6] * K[2] + K[7] * K[5] + K[8] * K[8]),
    ];
  }
  const s = Math.sin(theta) / theta;
  const c = (1 - Math.cos(theta)) / (theta * theta);
  return [
    1 + s * K[0] + c * (K[0] * K[0] + K[1] * K[3] + K[2] * K[6]),
    s * K[1] + c * (K[0] * K[1] + K[1] * K[4] + K[2] * K[7]),
    s * K[2] + c * (K[0] * K[2] + K[1] * K[5] + K[2] * K[8]),
    s * K[3] + c * (K[3] * K[0] + K[4] * K[3] + K[5] * K[6]),
    1 + s * K[4] + c * (K[3] * K[1] + K[4] * K[4] + K[5] * K[7]),
    s * K[5] + c * (K[3] * K[2] + K[4] * K[5] + K[5] * K[8]),
    s * K[6] + c * (K[6] * K[0] + K[7] * K[3] + K[8] * K[6]),
    s * K[7] + c * (K[6] * K[1] + K[7] * K[4] + K[8] * K[7]),
    1 + s * K[8] + c * (K[6] * K[2] + K[7] * K[5] + K[8] * K[8]),
  ];
}

/** Applies a row-major rotation to a vector. */
function applyRotation(m: PlacementRotation, v: DatumVec3): DatumVec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** A × b. */
function cross3(a: DatumVec3, b: DatumVec3): DatumVec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function dot3(a: DatumVec3, b: DatumVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** The deterministic auxiliary basis of a unit axis (two unit vectors ⊥ it). */
function auxiliaryBasis(z: DatumVec3): [DatumVec3, DatumVec3] {
  const seed: DatumVec3 = Math.abs(z[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const e1raw = cross3(z, seed);
  const len = Math.hypot(e1raw[0], e1raw[1], e1raw[2]);
  const e1: DatumVec3 = [e1raw[0] / len, e1raw[1] / len, e1raw[2] / len];
  const e2 = cross3(z, e1);
  return [e1, e2];
}

// ---------------------------------------------------------------------------
// Residual rows
// ---------------------------------------------------------------------------

interface WorldAnchor {
  readonly position: DatumVec3;
  readonly xAxis: DatumVec3;
  readonly yAxis: DatumVec3;
  readonly zAxis: DatumVec3;
  /** False for point anchors, whose orientation is non-semantic. */
  readonly oriented: boolean;
  readonly radius?: number;
}

function worldAnchor(
  pose: PlacementTransform,
  anchor: MateAnchor,
): WorldAnchor {
  const world = composePlacementTransforms(pose, anchor.transform);
  return {
    position: world.translation,
    xAxis: applyRotation(world.rotation, [1, 0, 0]),
    yAxis: applyRotation(world.rotation, [0, 1, 0]),
    zAxis: applyRotation(world.rotation, [0, 0, 1]),
    oriented: anchor.kind !== "point",
    radius: anchor.radius,
  };
}

/**
 * One mate's residual rows, in fixed order: position rows first, then
 * orientation rows. The row COUNT per kind is the constraint reduction:
 * it leaves exactly the DOF the vocabulary grants (concentric keeps roll
 * and slide; tangent keeps the cylinder's slide and roll).
 */
function mateResidualRows(
  kind: DocumentMate["kind"],
  value: number | undefined,
  a: WorldAnchor,
  b: WorldAnchor,
): number[] {
  switch (kind) {
    case "coincident": {
      const rows = [
        a.position[0] - b.position[0],
        a.position[1] - b.position[1],
        a.position[2] - b.position[2],
      ];
      if (a.oriented && b.oriented) {
        const [e1, e2] = auxiliaryBasis(a.zAxis);
        const misalign = cross3(a.zAxis, b.zAxis);
        rows.push(
          dot3(misalign, e1),
          dot3(misalign, e2),
          dot3(a.xAxis, b.yAxis),
        );
      }
      return rows;
    }
    case "concentric": {
      const [e1, e2] = auxiliaryBasis(a.zAxis);
      const misalign = cross3(a.zAxis, b.zAxis);
      const offset: DatumVec3 = [
        b.position[0] - a.position[0],
        b.position[1] - a.position[1],
        b.position[2] - a.position[2],
      ];
      const axial = dot3(offset, a.zAxis);
      const radial: DatumVec3 = [
        offset[0] - axial * a.zAxis[0],
        offset[1] - axial * a.zAxis[1],
        offset[2] - axial * a.zAxis[2],
      ];
      return [
        dot3(misalign, e1),
        dot3(misalign, e2),
        dot3(radial, e1),
        dot3(radial, e2),
      ];
    }
    case "distance": {
      const d = Math.hypot(
        b.position[0] - a.position[0],
        b.position[1] - a.position[1],
        b.position[2] - a.position[2],
      );
      return [d - (value ?? 0)];
    }
    case "angle": {
      const cos = dot3(a.xAxis, b.xAxis);
      const cross = cross3(a.xAxis, b.xAxis);
      const current = Math.atan2(Math.hypot(cross[0], cross[1], cross[2]), cos);
      return [current - (value ?? 0)];
    }
    case "parallel": {
      const [e1, e2] = auxiliaryBasis(a.zAxis);
      const misalign = cross3(a.zAxis, b.zAxis);
      return [dot3(misalign, e1), dot3(misalign, e2)];
    }
    case "perpendicular":
      return [dot3(a.zAxis, b.zAxis)];
    case "tangent": {
      // Plane (a: position on the plane, z its normal) against a cylinder
      // (b: position on its axis, z the axis direction, radius from the
      // anchors — a's first, then b's): parallelism of axis and plane
      // plus the plane-to-axis offset equaling the radius.
      const radius = a.radius ?? b.radius ?? 0;
      const [e1, e2] = auxiliaryBasis(a.zAxis);
      const misalign = cross3(a.zAxis, b.zAxis);
      const offset: DatumVec3 = [
        b.position[0] - a.position[0],
        b.position[1] - a.position[1],
        b.position[2] - a.position[2],
      ];
      return [
        dot3(misalign, e1),
        dot3(misalign, e2),
        dot3(offset, a.zAxis) - radius,
      ];
    }
  }
}

/**
 * One joint's residual rows at its zero station, evaluated from the base
 * pose and the moved pose. The row count per kind matches the
 * joint's DOF table exactly (6 rows removed minus the granted DOF):
 * rigid 6, revolute 5, slider 5, cylindrical 4, planar 3, ball 3.
 */
function jointResidualRows(
  joint: DocumentJoint,
  basePose: PlacementTransform,
  movedPose: PlacementTransform,
): number[] {
  const frameOrigin = joint.frame?.origin ?? [0, 0, 0];
  const frameAxisLocal = joint.frame?.axis
    ? normalizeJointAxis(joint.frame.axis)
    : ([0, 0, 1] as const);
  const worldAxis = applyRotation(basePose.rotation, frameAxisLocal);
  const worldOrigin: DatumVec3 = [
    basePose.translation[0] +
      basePose.rotation[0] * frameOrigin[0] +
      basePose.rotation[1] * frameOrigin[1] +
      basePose.rotation[2] * frameOrigin[2],
    basePose.translation[1] +
      basePose.rotation[3] * frameOrigin[0] +
      basePose.rotation[4] * frameOrigin[1] +
      basePose.rotation[5] * frameOrigin[2],
    basePose.translation[2] +
      basePose.rotation[6] * frameOrigin[0] +
      basePose.rotation[7] * frameOrigin[1] +
      basePose.rotation[8] * frameOrigin[2],
  ];
  const movedZ = applyRotation(movedPose.rotation, [0, 0, 1]);
  const movedX = applyRotation(movedPose.rotation, [1, 0, 0]);
  const [e1, e2] = auxiliaryBasis(worldAxis);
  const delta: DatumVec3 = [
    movedPose.translation[0] - worldOrigin[0],
    movedPose.translation[1] - worldOrigin[1],
    movedPose.translation[2] - worldOrigin[2],
  ];
  const tilt = cross3(worldAxis, movedZ);
  const rows: number[] = [];
  switch (joint.kind) {
    case "rigid":
      rows.push(delta[0], delta[1], delta[2]);
      rows.push(dot3(tilt, e1), dot3(tilt, e2), dot3(movedX, e1));
      break;
    case "revolute":
      // Position pinned at the joint origin; tilt removed; roll and
      // nothing else free.
      rows.push(dot3(delta, e1), dot3(delta, e2), dot3(delta, worldAxis));
      rows.push(dot3(tilt, e1), dot3(tilt, e2));
      break;
    case "slider":
      // Slide along the axis free; rotation fully pinned.
      rows.push(dot3(delta, e1), dot3(delta, e2));
      rows.push(dot3(tilt, e1), dot3(tilt, e2), dot3(movedX, e1));
      break;
    case "cylindrical":
      // Slide and roll free; tilt and radial offset removed.
      rows.push(dot3(delta, e1), dot3(delta, e2));
      rows.push(dot3(tilt, e1), dot3(tilt, e2));
      break;
    case "planar":
      // In-plane slide and spin free; normal offset and tilt removed.
      rows.push(dot3(delta, worldAxis));
      rows.push(dot3(tilt, e1), dot3(tilt, e2));
      break;
    case "ball":
      // Centre pinned; rotation free.
      rows.push(delta[0], delta[1], delta[2]);
      break;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Dense linear algebra (fixed-pivot, deterministic)
// ---------------------------------------------------------------------------

/** Reads `array[index]` with the sized-by-construction fallback of 0. */
function at(array: readonly number[] | undefined, index: number): number {
  return array?.[index] ?? 0;
}

/** Solves A·x = b by Gaussian elimination with a fixed pivot tolerance. */
function solveDense(
  matrix: readonly (readonly number[])[],
  rhs: readonly number[],
): number[] | undefined {
  const n = rhs.length;
  const a = matrix.map((row) => [...row]);
  const b = [...rhs];
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    let best = Math.abs(at(a[col], col));
    for (let row = col + 1; row < n; row += 1) {
      const candidate = Math.abs(at(a[row], col));
      if (candidate > best) {
        best = candidate;
        pivot = row;
      }
    }
    if (best < 1e-12) return undefined;
    if (pivot !== col) {
      const swap: number[] = a[col] ?? [];
      a[col] = a[pivot] ?? [];
      a[pivot] = swap;
      const bSwap = at(b, col);
      b[col] = at(b, pivot);
      b[pivot] = bSwap;
    }
    for (let row = col + 1; row < n; row += 1) {
      const factor = at(a[row], col) / at(a[col], col);
      const rowRef = a[row];
      if (rowRef !== undefined) {
        for (let k = col; k < n; k += 1) {
          rowRef[k] = at(rowRef, k) - factor * at(a[col], k);
        }
      }
      b[row] = at(b, row) - factor * at(b, col);
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = at(b, row);
    for (let k = row + 1; k < n; k += 1) sum -= at(a[row], k) * at(x, k);
    x[row] = sum / at(a[row], row);
  }
  return x;
}

/** The rank of a rectangular matrix at the DOF tolerance (fixed pivot). */
function rankOf(
  matrix: readonly (readonly number[])[],
  rows: number,
  cols: number,
): number {
  const a = matrix.map((row) => [...row]);
  let rank = 0;
  const colUsed = new Array<boolean>(cols).fill(false);
  for (let row = 0; row < rows && rank < cols; row += 1) {
    let pivotCol = -1;
    let best = MATE_DOF_RANK_TOLERANCE;
    for (let col = 0; col < cols; col += 1) {
      if (colUsed[col]) continue;
      const magnitude = Math.abs(at(a[row], col));
      if (magnitude > best) {
        best = magnitude;
        pivotCol = col;
      }
    }
    if (pivotCol < 0) continue;
    colUsed[pivotCol] = true;
    rank += 1;
    const pivotValue = at(a[row], pivotCol);
    const pivotRow = a[row];
    if (pivotRow === undefined) continue;
    for (let below = row + 1; below < rows; below += 1) {
      const factor = at(a[below], pivotCol) / pivotValue;
      if (factor === 0) continue;
      const belowRef = a[below];
      if (belowRef === undefined) continue;
      for (let col = 0; col < cols; col += 1) {
        belowRef[col] = at(belowRef, col) - factor * at(pivotRow, col);
      }
    }
  }
  return rank;
}

// ---------------------------------------------------------------------------
// The solver
// ---------------------------------------------------------------------------

export const MATE_MAX_ITERATIONS = 100;
const MATE_FD_STEP = 1e-7;

interface Parameterization {
  /** Free occurrence ids, in input order. */
  readonly ids: readonly OccurrenceId[];
  readonly initial: readonly PlacementTransform[];
}

function poseFor(
  parameterization: Parameterization,
  base: ReadonlyMap<OccurrenceId, PlacementTransform>,
  parameters: readonly number[],
  id: OccurrenceId,
): PlacementTransform {
  const index = parameterization.ids.indexOf(id);
  const initial = index >= 0 ? parameterization.initial[index] : base.get(id);
  if (initial === undefined) return IDENTITY_PLACEMENT_TRANSFORM;
  if (index < 0) return initial;
  const t: DatumVec3 = [
    at(parameters, index * 6),
    at(parameters, index * 6 + 1),
    at(parameters, index * 6 + 2),
  ];
  const w: DatumVec3 = [
    at(parameters, index * 6 + 3),
    at(parameters, index * 6 + 4),
    at(parameters, index * 6 + 5),
  ];
  const rotation = rotationVectorToMatrix(w);
  const rotatedTranslation = applyRotation(rotation, initial.translation);
  return {
    rotation,
    translation: [
      rotatedTranslation[0] + t[0],
      rotatedTranslation[1] + t[1],
      rotatedTranslation[2] + t[2],
    ],
  };
}

/**
 * Solves the assembly. Deterministic end to end: see the module doc.
 * Occurrences the mates/joints never address keep their initial
 * placements; grounded occurrences never move; the solve drives the rest
 * to a residual-stationary pose and reports status, diagnostics, DOF.
 */
export function solveAssemblyMates(
  input: AssemblySolveInput,
): AssemblySolveResult {
  const diagnostics: AssemblySolveDiagnostic[] = [];
  const transforms = new Map<OccurrenceId, PlacementTransform>();
  for (const id of input.occurrences) {
    const initial = input.initial.get(id);
    if (initial !== undefined) transforms.set(id, initial);
  }

  // Endpoint resolution: every addressed occurrence and anchor must exist.
  for (const mate of input.mates) {
    for (const endpoint of [mate.first, mate.second]) {
      if (!input.initial.has(endpoint.occurrenceId)) {
        diagnostics.push({
          severity: "error",
          code: ASSEMBLY_SOLVE_DIAGNOSTIC_CODES.mateUnresolved,
          message: `The mate ${mate.id} addresses occurrence ${endpoint.occurrenceId}, which the solve's occurrence list does not carry.`,
        });
      }
    }
    if (!input.anchors.has(mate.id)) {
      diagnostics.push({
        severity: "error",
        code: ASSEMBLY_SOLVE_DIAGNOSTIC_CODES.mateUnresolved,
        message: `The mate ${mate.id} has no resolved anchor frames; resolve its persistent references through the executor's topology seam first.`,
      });
    }
  }
  for (const joint of input.joints) {
    for (const id of [joint.baseOccurrenceId, joint.occurrenceId]) {
      if (!input.initial.has(id)) {
        diagnostics.push({
          severity: "error",
          code: ASSEMBLY_SOLVE_DIAGNOSTIC_CODES.mateUnresolved,
          message: `The joint ${joint.id} addresses occurrence ${id}, which the solve's occurrence list does not carry.`,
        });
      }
    }
  }
  if (diagnostics.length > 0) {
    return {
      status: "unresolved",
      diagnostics,
      transforms,
      residual: Number.POSITIVE_INFINITY,
      dof: Number.NaN,
      iterations: 0,
    };
  }

  const grounded = new Set(input.grounded);
  const freeIds: OccurrenceId[] = [];
  const freeInitial: PlacementTransform[] = [];
  for (const id of input.occurrences) {
    if (grounded.has(id)) continue;
    const addressed =
      input.mates.some(
        (mate) =>
          mate.first.occurrenceId === id || mate.second.occurrenceId === id,
      ) ||
      input.joints.some(
        (joint) => joint.baseOccurrenceId === id || joint.occurrenceId === id,
      );
    const initial = input.initial.get(id);
    if (addressed && initial !== undefined) {
      freeIds.push(id);
      freeInitial.push(initial);
    }
  }
  const parameterization: Parameterization = {
    ids: freeIds,
    initial: freeInitial,
  };

  const evaluate = (parameters: readonly number[]): number[] => {
    const rows: number[] = [];
    for (const mate of input.mates) {
      const anchors = input.anchors.get(mate.id);
      if (anchors === undefined) continue;
      const a = worldAnchor(
        poseFor(
          parameterization,
          input.initial,
          parameters,
          mate.first.occurrenceId,
        ),
        anchors.first,
      );
      const b = worldAnchor(
        poseFor(
          parameterization,
          input.initial,
          parameters,
          mate.second.occurrenceId,
        ),
        anchors.second,
      );
      rows.push(
        ...mateResidualRows(
          mate.kind,
          // Angle mates carry degrees on the wire; the residual is radians.
          mate.kind === "angle"
            ? (mate.value ?? 0) * (Math.PI / 180)
            : mate.value,
          a,
          b,
        ),
      );
    }
    for (const joint of input.joints) {
      rows.push(
        ...jointResidualRows(
          joint,
          poseFor(
            parameterization,
            input.initial,
            parameters,
            joint.baseOccurrenceId,
          ),
          poseFor(
            parameterization,
            input.initial,
            parameters,
            joint.occurrenceId,
          ),
        ),
      );
    }
    return rows;
  };

  const rows0 = evaluate(new Array<number>(freeIds.length * 6).fill(0));
  const residualOf = (rows: readonly number[]): number =>
    rows.reduce((worst, row) => Math.max(worst, Math.abs(row)), 0);

  let parameters = new Array<number>(freeIds.length * 6).fill(0);
  let rows = rows0;
  let sse = rows.reduce((sum, row) => sum + row * row, 0);
  let lambda = 1e-3;
  let iterations = 0;
  const rowCount = rows0.length;

  // One damped Gauss-Newton step's shared machinery: the forward-difference
  // Jacobian and the damped normal equations.
  const jacobianOf = (
    current: readonly number[],
    currentRows: readonly number[],
  ): number[][] => {
    const jacobian: number[][] = [];
    for (let p = 0; p < current.length; p += 1) {
      const perturbed = [...current];
      perturbed[p] = at(perturbed, p) + MATE_FD_STEP;
      const perturbedRows = evaluate(perturbed);
      const column: number[] = new Array<number>(rowCount);
      for (let r = 0; r < rowCount; r += 1) {
        column[r] = (at(perturbedRows, r) - at(currentRows, r)) / MATE_FD_STEP;
      }
      jacobian.push(column);
    }
    return jacobian;
  };

  for (; iterations < MATE_MAX_ITERATIONS; iterations += 1) {
    if (residualOf(rows) < MATE_RESIDUAL_TOLERANCE) break;
    const jacobian = jacobianOf(parameters, rows);
    // Normal equations JᵀJ δ = −Jᵀ r, damped.
    const jtj: number[][] = [];
    for (let i = 0; i < parameters.length; i += 1) {
      const row: number[] = new Array<number>(parameters.length).fill(0);
      for (let j = 0; j < parameters.length; j += 1) {
        let sum = 0;
        for (let r = 0; r < rowCount; r += 1) {
          sum += at(jacobian[i], r) * at(jacobian[j], r);
        }
        row[j] = sum + (i === j ? lambda : 0);
      }
      jtj.push(row);
    }
    const jtr: number[] = new Array<number>(parameters.length).fill(0);
    for (let i = 0; i < parameters.length; i += 1) {
      let sum = 0;
      for (let r = 0; r < rowCount; r += 1) {
        sum += at(jacobian[i], r) * at(rows, r);
      }
      jtr[i] = -sum;
    }
    const step = solveDense(jtj, jtr);
    if (step === undefined) break;
    const candidate = parameters.map((value, index) => value + at(step, index));
    const candidateRows = evaluate(candidate);
    const candidateSse = candidateRows.reduce((sum, row) => sum + row * row, 0);
    if (candidateSse < sse) {
      parameters = candidate;
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

  for (let index = 0; index < freeIds.length; index += 1) {
    const id = freeIds[index];
    if (id === undefined) continue;
    transforms.set(
      id,
      poseFor(parameterization, input.initial, parameters, id),
    );
  }

  const worst = residualOf(rows);
  // DOF accounting: the rank of the constraint Jacobian at the solution —
  // via its normal matrix, whose rank equals J's — gives the system's
  // remaining DOF as free parameters minus rank.
  const jacobian = jacobianOf(parameters, rows);
  const normal: number[][] = [];
  for (let i = 0; i < parameters.length; i += 1) {
    const row: number[] = new Array<number>(parameters.length).fill(0);
    for (let j = 0; j < parameters.length; j += 1) {
      let sum = 0;
      for (let r = 0; r < rowCount; r += 1) {
        sum += at(jacobian[i], r) * at(jacobian[j], r);
      }
      row[j] = sum;
    }
    normal.push(row);
  }
  const dof =
    parameters.length - rankOf(normal, parameters.length, parameters.length);

  if (worst > MATE_RESIDUAL_TOLERANCE) {
    diagnostics.push({
      severity: "error",
      code: ASSEMBLY_SOLVE_DIAGNOSTIC_CODES.conflicting,
      message: `The solve stopped at residual ${worst.toExponential(3)} (tolerance ${MATE_RESIDUAL_TOLERANCE}); the mates or joints conflict.`,
    });
    return {
      status: "conflicting",
      diagnostics,
      transforms,
      residual: worst,
      dof,
      iterations,
    };
  }
  if (dof > 0) {
    diagnostics.push({
      severity: "info",
      code: ASSEMBLY_SOLVE_DIAGNOSTIC_CODES.underConstrained,
      message: `The assembly holds with ${dof} remaining degree(s) of freedom.`,
    });
    return {
      status: "underConstrained",
      diagnostics,
      transforms,
      residual: worst,
      dof,
      iterations,
    };
  }
  return {
    status: "solved",
    diagnostics,
    transforms,
    residual: worst,
    dof,
    iterations,
  };
}

// ---------------------------------------------------------------------------
// Reference solver (the golden closed forms)
// ---------------------------------------------------------------------------

/**
 * The closed-form placement that makes `moving`'s anchor coincide exactly
 * with `base`'s: `baseWorld ∘ baseAnchor ∘ movingAnchor⁻¹` — the golden
 * value the numeric coincident-mate solve is checked against (the
 * reference-solver pattern from `cad-sketch`).
 */
export function referenceSolveCoincident(
  baseWorld: PlacementTransform,
  baseAnchor: MateAnchor,
  movingWorld: PlacementTransform,
  movingAnchor: MateAnchor,
): PlacementTransform {
  void movingWorld;
  const inverse: PlacementTransform = {
    rotation: transposePlacementRotation(movingAnchor.transform.rotation),
    translation: applyRotation(
      transposePlacementRotation(movingAnchor.transform.rotation),
      [
        -movingAnchor.transform.translation[0],
        -movingAnchor.transform.translation[1],
        -movingAnchor.transform.translation[2],
      ],
    ),
  };
  return composePlacementTransforms(
    composePlacementTransforms(baseWorld, baseAnchor.transform),
    inverse,
  );
}

/**
 * The analytic remaining-DOF readout of a joint set: the sketch solver's
 * DOF accounting, assembly-scoped — per joint the granted rotational and
 * translational DOF, and the union's total (capped at the 6 relative DOF
 * of a pair). Pure data over {@link JOINT_REMAINING_DOF}.
 */
export function jointDofSummary(joints: readonly DocumentJoint[]): {
  rotational: number;
  translational: number;
} {
  let rotational = 0;
  let translational = 0;
  for (const joint of joints) {
    const granted = JOINT_REMAINING_DOF[joint.kind];
    rotational = Math.min(6, rotational + granted.rotational);
    translational = Math.min(6, translational + granted.translational);
  }
  return { rotational, translational };
}
