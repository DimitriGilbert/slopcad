/**
 * The structural run driver (Phase 69a, the `@slopcad/sim-thermal`
 * `./run` precedent): one call — {@link runStructuralScenario} — takes
 * the solver-space problem pieces (the Phase 62 occupancy grid, the
 * structural material records' per-cell map, the boundary conditions,
 * the body-force family) and produces the completed run report;
 * {@link structuralRunSimResult} persists it as a {@link SimResult}
 * through the one S4 projection site.
 *
 * ## The boundary-condition vocabulary (the compiled 61a family)
 *
 * `fixed-support` (a domain face — every mesh node on that face's plane
 * carries all three dofs fixed), `axis-fix` (a domain face and one
 * component — the symmetry-plane roller that removes a single
 * displacement per node: the quarter-model fixture), `point-fix` (a
 * world point — the nearest mesh node, fully fixed), `force-load` (a domain face — the total
 * force distributed UNIFORMLY over the face's boundary nodes, the stated
 * coarse lumping), `pressure-load` (a domain face — the consistent
 * nodal traction p·A/4 per exposed element-face corner, positive
 * pressure pushing INTO the body), and `point-load` (a world point —
 * the consistent shape-function load on the voxel hosting the point,
 * natural coordinates clamped to the element, the quantization the
 * voxel grid implies). Loads that would land on nothing (a face the
 * body does not reach, a point too far from any occupied node) decline
 * loudly — a vanished load is a lie, never a silent zero.
 *
 * ## The body-force family (Phase 69's mandate)
 *
 * Self-weight through the gravity vector (the 61a default −Y standard
 * gravity; the zero vector disables), centrifugal load ω²·r⊥ about an
 * authored axis (the fan-blade root case), and thermal expansion from
 * a per-cell ΔT field (the Phase 65 CHT→structural chaining seam) as
 * the initial-strain load vector.
 *
 * ## Regime honesty (law S9)
 *
 * NONE of the flow/thermal dimensionless gates applies to a
 * linear-elastic static solve — the validity gates are the solver
 * discipline's residual and iteration count, which the report carries.
 * The empty regime report is the honest structural claim (the dynamics
 * precedent).
 *
 * Determinism is the layer's stance (law S2): no clock, no randomness,
 * fixed iteration discipline — the same scenario produces the
 * bitwise-identical report (pinned by test).
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  SIM_RESULT_SUMMARY_VERSION,
  type SimOccupancyGrid,
  type SimParseResult,
  type SimRegimeReport,
  type SimResult,
  type SimResultFieldBlock,
  type SolverSimField,
  type SolverSimScalar,
  simError,
  simFail,
  simOk,
  simRegimeReport,
  simScenarioSnapshotHash,
  projectSimResult,
} from "@slopcad/sim-core";
import type { StructuralSolidMaterial } from "./material";
import type { StructuralCentrifugalSpec, StructuralNodalLoad } from "./system";
import type {
  StructuralSolverOptions,
  StructuralSolverOutcome,
} from "./solver";
import type { StructuralHexMesh } from "./mesh";

import {
  hexCenterStrain,
  hexDMatrix,
  hexStressApply,
  hexVonMises,
} from "./element";
import {
  HEX_CORNER_DIRECTIONS,
  type StructuralDomainFace,
  isStructuralDomainFace,
  structuralDomainFaceNodes,
  structuralHexMesh,
} from "./mesh";
import { assembleStructuralSystem } from "./system";
import { STRUCTURAL_SOLVE_DEFAULTS, solveStructuralSystem } from "./solver";

/** The gravity default — the 61a scenario default, −Y standard gravity. */
export const STRUCTURAL_DEFAULT_GRAVITY: readonly [number, number, number] =
  Object.freeze([0, -9.80665, 0]);

/**
 * One authored boundary condition at the door (plain wire form,
 * re-validated field by field — the thermal door's trust discipline):
 * the 61a compiled family plus the point load the structural domain
 * adds.
 */
export type StructuralConditionEntry =
  | { readonly kind: "fixed-support"; readonly face: string }
  | {
      readonly kind: "axis-fix";
      readonly axis: string;
      readonly face: string;
    }
  | {
      readonly kind: "point-fix";
      readonly atWorldPointM: readonly [number, number, number];
    }
  | {
      readonly kind: "force-load";
      readonly face: string;
      readonly forceN: readonly [number, number, number];
    }
  | {
      readonly kind: "pressure-load";
      readonly face: string;
      readonly pressurePa: number;
    }
  | {
      readonly kind: "point-load";
      readonly atWorldPointM: readonly [number, number, number];
      readonly forceN: readonly [number, number, number];
    };

/** The centrifugal stance in authored wire form (direction unnormalized). */
export interface StructuralCentrifugalInput {
  /** One point on the axis, m. */
  readonly axisPointM: readonly [number, number, number];
  /** The axis direction — any non-zero triple, normalized at this door. */
  readonly axisDirection: readonly [number, number, number];
  /** The angular rate ω, rad/s (the load is ω²-driven). */
  readonly omegaRadPerS: number;
}

/** What {@link runStructuralScenario} consumes — SI at the door, law S4. */
export interface StructuralRunScenario {
  readonly name: string;
  /** The Phase 62 occupancy grid — one hex element per occupied node. */
  readonly grid: SimOccupancyGrid;
  /** The scenario's material selection, solver space (the material door). */
  readonly materials: readonly StructuralSolidMaterial[];
  /** Per grid node → 1-based index into materials; 0 on void nodes. */
  readonly cellMaterialIndex: Uint16Array;
  /** The boundary conditions (fixtures and loads). */
  readonly conditions?: readonly StructuralConditionEntry[];
  /**
   * The gravity vector, m/s² — self-weight's body force. Defaults to
   * the 61a −Y standard gravity; the zero vector disables self-weight.
   */
  readonly gravityMPerS2?: readonly [number, number, number];
  /** The centrifugal stance, when the scenario spins the body. */
  readonly centrifugal?: StructuralCentrifugalInput;
  /** Per grid node temperature rise ΔT, K — the Phase 65 chaining seam. */
  readonly thermalDeltaTK?: Float64Array;
  /** The solver discipline overrides (defaults when absent). */
  readonly solver?: StructuralSolverOptions;
  /** The compile boundary's run-time scenario hash, when compile-fed. */
  readonly scenarioSnapshotHash?: string;
}

/** The immutable grid facts every report carries. */
export interface StructuralRunGridFacts {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly spacingM: readonly [number, number, number];
  readonly elementCount: number;
  readonly nodeCount: number;
  readonly freeDofCount: number;
  readonly fixedDofCount: number;
}

/** The per-material factor-of-safety view (yield-bearing materials). */
export interface StructuralMaterialSafety {
  readonly materialId: string;
  readonly yieldStrengthPa: number;
  /** The max von Mises over this material's elements, Pa. */
  readonly vonMisesMaxPa: number;
  /** yieldStrengthPa / vonMisesMaxPa — present when the max is > 0. */
  readonly factorOfSafety?: number;
}

/** One completed structural run. */
export interface StructuralRunReport {
  readonly scenarioName: string;
  readonly scenarioSnapshotHash: string;
  readonly regime: SimRegimeReport;
  readonly grid: StructuralRunGridFacts;
  readonly solver: StructuralSolverOutcome;
  /** The displacement-magnitude field over the grid lattice, m. */
  readonly displacementField: SolverSimField;
  /** The von Mises field over the grid lattice (one value per voxel), Pa. */
  readonly vonMisesField: SolverSimField;
  /** The largest nodal displacement magnitude, m. */
  readonly maxDeflectionM: number;
  /** The largest element von Mises stress, Pa. */
  readonly vonMisesMaxPa: number;
  /** The overall factor of safety (min over yield-bearing materials). */
  readonly factorOfSafety?: number;
  /** The per-material safety views, yield-bearing materials only. */
  readonly materialSafety: readonly StructuralMaterialSafety[];
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

const refuse = (
  message: string,
  at: unknown,
): SimParseResult<never, SimError> =>
  simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));

/** Parses a finite [x, y, z] triple from untrusted wire input. */
function finiteTriple(
  input: unknown,
  what: string,
): SimParseResult<readonly [number, number, number], SimError> {
  const source: readonly unknown[] | null = Array.isArray(input)
    ? (input as readonly unknown[])
    : null;
  const entries: readonly unknown[] =
    source === null ? [] : [source[0], source[1], source[2]];
  if (entries.length !== 3) {
    return refuse(`${what} must be an array of three numbers.`, input);
  }
  const [x, y, z] = entries;
  if (
    typeof x !== "number" ||
    !Number.isFinite(x) ||
    typeof y !== "number" ||
    !Number.isFinite(y) ||
    typeof z !== "number" ||
    !Number.isFinite(z)
  ) {
    return refuse(`${what} must be three finite numbers.`, input);
  }
  return simOk([x, y, z]);
}

/** One validated condition in solver space. */
type ValidatedCondition =
  | { readonly kind: "fixed-support"; readonly face: StructuralDomainFace }
  | {
      readonly kind: "axis-fix";
      readonly axis: 0 | 1 | 2;
      readonly face: StructuralDomainFace;
    }
  | {
      readonly kind: "point-fix";
      readonly atWorldPointM: readonly [number, number, number];
    }
  | {
      readonly kind: "force-load";
      readonly face: StructuralDomainFace;
      readonly forceN: readonly [number, number, number];
    }
  | {
      readonly kind: "pressure-load";
      readonly face: StructuralDomainFace;
      readonly pressurePa: number;
    }
  | {
      readonly kind: "point-load";
      readonly atWorldPointM: readonly [number, number, number];
      readonly forceN: readonly [number, number, number];
    };

/** Validates the authored conditions (the door's re-validation duty). */
function validateConditions(
  scenario: StructuralRunScenario,
): SimParseResult<readonly ValidatedCondition[], SimError> {
  const validated: ValidatedCondition[] = [];
  const list = scenario.conditions ?? [];
  for (const entry of list) {
    if (!isPlainRecord(entry)) {
      return refuse(
        "A structural condition must be a plain object with a kind field.",
        entry,
      );
    }
    const authoredKind: unknown = entry.kind;
    switch (entry.kind) {
      case "fixed-support": {
        if (!isStructuralDomainFace(entry.face)) {
          return refuse(
            "A fixed-support's face must be one of xMin, xMax, yMin, yMax, zMin, zMax.",
            entry.face,
          );
        }
        validated.push({ kind: "fixed-support", face: entry.face });
        break;
      }
      case "axis-fix": {
        if (!isStructuralDomainFace(entry.face)) {
          return refuse(
            "An axis-fix's face must be one of xMin, xMax, yMin, yMax, zMin, zMax.",
            entry.face,
          );
        }
        if (entry.axis !== "x" && entry.axis !== "y" && entry.axis !== "z") {
          return refuse(
            'An axis-fix\'s axis must be "x", "y", or "z" — the single component the roller fixes.',
            entry.axis,
          );
        }
        validated.push({
          kind: "axis-fix",
          axis: entry.axis === "x" ? 0 : entry.axis === "y" ? 1 : 2,
          face: entry.face,
        });
        break;
      }
      case "point-fix": {
        const at = finiteTriple(
          entry.atWorldPointM,
          "A point-fix's application point",
        );
        if (!at.ok) return at;
        validated.push({ kind: "point-fix", atWorldPointM: at.value });
        break;
      }
      case "force-load": {
        if (!isStructuralDomainFace(entry.face)) {
          return refuse(
            "A force-load's face must be one of xMin, xMax, yMin, yMax, zMin, zMax.",
            entry.face,
          );
        }
        const forceN = finiteTriple(entry.forceN, "A force-load's force");
        if (!forceN.ok) return forceN;
        validated.push({
          kind: "force-load",
          face: entry.face,
          forceN: forceN.value,
        });
        break;
      }
      case "pressure-load": {
        if (!isStructuralDomainFace(entry.face)) {
          return refuse(
            "A pressure-load's face must be one of xMin, xMax, yMin, yMax, zMin, zMax.",
            entry.face,
          );
        }
        if (
          typeof entry.pressurePa !== "number" ||
          !Number.isFinite(entry.pressurePa)
        ) {
          return refuse(
            "A pressure-load's pressure must be a finite number of pascals (positive = pushing into the body).",
            entry.pressurePa,
          );
        }
        validated.push({
          kind: "pressure-load",
          face: entry.face,
          pressurePa: entry.pressurePa,
        });
        break;
      }
      case "point-load": {
        const at = finiteTriple(
          entry.atWorldPointM,
          "A point-load's application point",
        );
        if (!at.ok) return at;
        const forceN = finiteTriple(entry.forceN, "A point-load's force");
        if (!forceN.ok) return forceN;
        validated.push({
          kind: "point-load",
          atWorldPointM: at.value,
          forceN: forceN.value,
        });
        break;
      }
      default:
        return refuse(
          `A structural condition's kind must be fixed-support, axis-fix, point-fix, force-load, pressure-load, or point-load, received ${String(authoredKind)}.`,
          authoredKind,
        );
    }
  }
  return simOk(validated);
}

/** The mesh axis a domain face addresses (0 x, 1 y, 2 z) and its sign. */
function faceAxisAndSign(face: StructuralDomainFace): {
  readonly axis: 0 | 1 | 2;
  readonly sign: -1 | 1;
} {
  switch (face) {
    case "xMin":
      return { axis: 0, sign: -1 };
    case "xMax":
      return { axis: 0, sign: 1 };
    case "yMin":
      return { axis: 1, sign: -1 };
    case "yMax":
      return { axis: 1, sign: 1 };
    case "zMin":
      return { axis: 2, sign: -1 };
    default:
      return { axis: 2, sign: 1 };
  }
}

/**
 * Resolves the validated conditions against the mesh: the fixed node
 * list and the nodal loads. Every load must LAND — a face the body does
 * not reach, or a point too far from any occupied node, declines
 * loudly (an unbudgeted load is a lie, never a silent zero).
 */
function resolveConditions(
  mesh: StructuralHexMesh,
  conditions: readonly ValidatedCondition[],
): SimParseResult<
  {
    readonly fixedDofMask: Uint8Array;
    readonly nodalLoads: readonly StructuralNodalLoad[];
  },
  SimError
> {
  const fixedDofMask = new Uint8Array(mesh.nodeCount * 3);
  const nodalLoads: StructuralNodalLoad[] = [];
  const [hx, hy, hz] = mesh.spacingM;
  const cellDiagonal = Math.sqrt(
    (hx ?? 1) ** 2 + (hy ?? 1) ** 2 + (hz ?? 1) ** 2,
  );
  for (const condition of conditions) {
    if (condition.kind === "fixed-support") {
      const nodes = structuralDomainFaceNodes(mesh, condition.face);
      if (nodes.length === 0) {
        return refuse(
          `A fixed-support addresses the ${condition.face} face, which the voxelized body does not reach — the fixture would vanish and the system would be singular; the door declines instead.`,
          condition.face,
        );
      }
      for (const node of nodes) {
        fixedDofMask[node * 3] = 1;
        fixedDofMask[node * 3 + 1] = 1;
        fixedDofMask[node * 3 + 2] = 1;
      }
      continue;
    }
    if (condition.kind === "axis-fix") {
      const nodes = structuralDomainFaceNodes(mesh, condition.face);
      if (nodes.length === 0) {
        return refuse(
          `An axis-fix addresses the ${condition.face} face, which the voxelized body does not reach — the roller would vanish and the system could stay singular; the door declines instead.`,
          condition.face,
        );
      }
      for (const node of nodes) {
        fixedDofMask[node * 3 + condition.axis] = 1;
      }
      continue;
    }
    if (condition.kind === "point-fix") {
      // The nearest finite-element CORNER node hosts the fixture (the
      // voxel quantization of an authored point); beyond two cell
      // diagonals of every node the point fixes nothing real.
      let nearest = -1;
      let nearestSquared = Number.POSITIVE_INFINITY;
      for (let node = 0; node < mesh.nodeCount; node += 1) {
        const dx =
          (mesh.nodePositionM[node * 3] ?? 0) -
          (condition.atWorldPointM[0] ?? 0);
        const dy =
          (mesh.nodePositionM[node * 3 + 1] ?? 0) -
          (condition.atWorldPointM[1] ?? 0);
        const dz =
          (mesh.nodePositionM[node * 3 + 2] ?? 0) -
          (condition.atWorldPointM[2] ?? 0);
        const squared = dx * dx + dy * dy + dz * dz;
        if (squared < nearestSquared) {
          nearestSquared = squared;
          nearest = node;
        }
      }
      if (nearest === -1 || Math.sqrt(nearestSquared) > 2 * cellDiagonal) {
        return refuse(
          "A point-fix's application point sits more than two voxel diagonals from any mesh node — the fixture would land on nothing, and the door declines instead of guessing a body.",
          condition.atWorldPointM,
        );
      }
      fixedDofMask[nearest * 3] = 1;
      fixedDofMask[nearest * 3 + 1] = 1;
      fixedDofMask[nearest * 3 + 2] = 1;
      continue;
    }
    if (condition.kind === "force-load") {
      const nodes = structuralDomainFaceNodes(mesh, condition.face);
      if (nodes.length === 0) {
        return refuse(
          `A force-load addresses the ${condition.face} face, which the voxelized body does not reach — the load would vanish silently, and the door declines instead.`,
          condition.face,
        );
      }
      const share = 1 / nodes.length;
      for (const node of nodes) {
        nodalLoads.push({
          node,
          forceN: [
            (condition.forceN[0] ?? 0) * share,
            (condition.forceN[1] ?? 0) * share,
            (condition.forceN[2] ?? 0) * share,
          ],
        });
      }
      continue;
    }
    if (condition.kind === "pressure-load") {
      // The consistent traction: every exposed element face in the
      // addressed plane contributes p·A/4 to each of its four corners
      // (exact for the bilinear face), direction INTO the body.
      const { axis, sign } = faceAxisAndSign(condition.face);
      const extents = [mesh.nx, mesh.ny, mesh.nz] as const;
      const last = (extents[axis] ?? 1) - 1;
      const areaAxes = ([1, 2, 0] as const).filter(
        (candidate) => candidate !== axis,
      );
      const area =
        (mesh.spacingM[areaAxes[0] ?? 0] ?? 1) *
        (mesh.spacingM[areaAxes[1] ?? 0] ?? 1);
      const perCorner = (condition.pressurePa * area) / 4;
      const force: readonly [number, number, number] = [
        axis === 0 ? -sign * perCorner : 0,
        axis === 1 ? -sign * perCorner : 0,
        axis === 2 ? -sign * perCorner : 0,
      ];
      let landed = 0;
      for (let element = 0; element < mesh.elementCount; element += 1) {
        const gridNode = mesh.gridNodeOfElement[element] ?? 0;
        const i = gridNode % mesh.nx;
        const j = Math.floor(gridNode / mesh.nx) % mesh.ny;
        const k = Math.floor(gridNode / (mesh.nx * mesh.ny));
        const coordinates = [i, j, k] as const;
        if ((coordinates[axis] ?? 0) !== last) continue;
        for (let corner = 0; corner < 8; corner += 1) {
          const direction = HEX_CORNER_DIRECTIONS[corner];
          const onFace =
            direction !== undefined && direction[axis] === (sign > 0 ? 1 : 0);
          if (!onFace) continue;
          const node = mesh.elementNode[element * 8 + corner] ?? 0;
          nodalLoads.push({ node, forceN: force });
          landed += 1;
        }
      }
      if (landed === 0) {
        return refuse(
          `A pressure-load addresses the ${condition.face} face, which the voxelized body does not reach — the traction would vanish silently, and the door declines instead.`,
          condition.face,
        );
      }
      continue;
    }
    // The point load: nearest occupied node hosts it; the consistent
    // shape-function load with natural coordinates clamped to the
    // element (the quantization the voxel grid implies); a point beyond
    // two cell diagonals of any occupied node declines loudly.
    const point = condition.atWorldPointM;
    let nearestGridNode = -1;
    let nearestSquared = Number.POSITIVE_INFINITY;
    for (
      let gridNode = 0;
      gridNode < mesh.elementOfGridNode.length;
      gridNode += 1
    ) {
      if (mesh.elementOfGridNode[gridNode] === -1) continue;
      const i = gridNode % mesh.nx;
      const j = Math.floor(gridNode / mesh.nx) % mesh.ny;
      const k = Math.floor(gridNode / (mesh.nx * mesh.ny));
      const dx = (mesh.originM[0] ?? 0) + i * (hx ?? 1) - (point[0] ?? 0);
      const dy = (mesh.originM[1] ?? 0) + j * (hy ?? 1) - (point[1] ?? 0);
      const dz = (mesh.originM[2] ?? 0) + k * (hz ?? 1) - (point[2] ?? 0);
      const squared = dx * dx + dy * dy + dz * dz;
      if (squared < nearestSquared) {
        nearestSquared = squared;
        nearestGridNode = gridNode;
      }
    }
    if (
      nearestGridNode === -1 ||
      Math.sqrt(nearestSquared) > 2 * cellDiagonal
    ) {
      return refuse(
        "A point-load's application point sits more than two voxel diagonals from any occupied node — the load would land on nothing, and the door declines instead of guessing a body.",
        point,
      );
    }
    const element = mesh.elementOfGridNode[nearestGridNode] ?? -1;
    if (element === -1) {
      return refuse(
        "A point-load's application point resolved no hosting element.",
        point,
      );
    }
    const i = nearestGridNode % mesh.nx;
    const j = Math.floor(nearestGridNode / mesh.nx) % mesh.ny;
    const k = Math.floor(nearestGridNode / (mesh.nx * mesh.ny));
    const clamp = (value: number): number => Math.min(1, Math.max(-1, value));
    const gx = clamp(
      (2 * ((point[0] ?? 0) - ((mesh.originM[0] ?? 0) + i * (hx ?? 1)))) /
        (hx ?? 1),
    );
    const gy = clamp(
      (2 * ((point[1] ?? 0) - ((mesh.originM[1] ?? 0) + j * (hy ?? 1)))) /
        (hy ?? 1),
    );
    const gz = clamp(
      (2 * ((point[2] ?? 0) - ((mesh.originM[2] ?? 0) + k * (hz ?? 1)))) /
        (hz ?? 1),
    );
    for (let corner = 0; corner < 8; corner += 1) {
      const direction = HEX_CORNER_DIRECTIONS[corner];
      if (direction === undefined) continue;
      const sx = 2 * direction[0] - 1;
      const sy = 2 * direction[1] - 1;
      const sz = 2 * direction[2] - 1;
      const shape = ((1 + sx * gx) * (1 + sy * gy) * (1 + sz * gz)) / 8;
      const node = mesh.elementNode[element * 8 + corner] ?? 0;
      nodalLoads.push({
        node,
        forceN: [
          shape * (condition.forceN[0] ?? 0),
          shape * (condition.forceN[1] ?? 0),
          shape * (condition.forceN[2] ?? 0),
        ],
      });
    }
  }
  return simOk({ fixedDofMask, nodalLoads });
}

/** Validates the centrifugal stance and normalizes its axis (SI). */
function validateCentrifugal(
  scenario: StructuralRunScenario,
): SimParseResult<StructuralCentrifugalSpec | undefined, SimError> {
  const input = scenario.centrifugal;
  if (input === undefined) return simOk(undefined);
  const axisPointM = finiteTriple(
    input.axisPointM,
    "A centrifugal stance's axis point",
  );
  if (!axisPointM.ok) return axisPointM;
  const direction = finiteTriple(
    input.axisDirection,
    "A centrifugal stance's axis direction",
  );
  if (!direction.ok) return direction;
  const [dx, dy, dz] = direction.value;
  const norm = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(norm > 0)) {
    return refuse(
      "A centrifugal stance's axis direction must be non-zero.",
      input.axisDirection,
    );
  }
  if (
    typeof input.omegaRadPerS !== "number" ||
    !Number.isFinite(input.omegaRadPerS) ||
    input.omegaRadPerS <= 0
  ) {
    return refuse(
      "A centrifugal stance's angular rate must be a positive finite rad/s value.",
      input.omegaRadPerS,
    );
  }
  return simOk(
    Object.freeze({
      axisPointM: axisPointM.value,
      axisDirection: [dx / norm, dy / norm, dz / norm] as const,
      omegaRadPerS: input.omegaRadPerS,
    }),
  );
}

/** The standalone snapshot identity: the driver's canonical view. */
function runScenarioIdentity(scenario: StructuralRunScenario): unknown {
  return {
    name: scenario.name,
    gravityMPerS2: scenario.gravityMPerS2 ?? STRUCTURAL_DEFAULT_GRAVITY,
    ...(scenario.centrifugal === undefined
      ? {}
      : { centrifugal: scenario.centrifugal }),
    ...(scenario.thermalDeltaTK === undefined
      ? {}
      : { thermalDeltaTK: Array.from(scenario.thermalDeltaTK) }),
    ...(scenario.solver === undefined ? {} : { solver: scenario.solver }),
    grid: {
      shape: scenario.grid.shape,
      originM: scenario.grid.originM,
      spacingM: scenario.grid.spacingM,
      cells: Array.from(scenario.grid.cells),
    },
    materials: scenario.materials,
    cellMaterialIndex: Array.from(scenario.cellMaterialIndex),
    conditions: scenario.conditions ?? [],
  };
}

/**
 * Runs one structural scenario: validates the door, builds the mesh,
 * resolves the boundary conditions, assembles and solves the reduced
 * system, and recovers the displacement/von Mises fields plus the
 * summary scalars. Deterministic end to end.
 */
export function runStructuralScenario(
  scenario: StructuralRunScenario,
): SimParseResult<StructuralRunReport, SimError> {
  if (typeof scenario.name !== "string" || scenario.name.length === 0) {
    return refuse(
      "A structural run scenario must carry a non-empty name.",
      scenario.name,
    );
  }
  // The materials re-validation (the thermal door's conductivity
  // precedent): every field the stiffness assembly consumes is
  // re-checked at this door, whatever produced the solver-space list.
  // The typed local precedes the Array.isArray guard — the guard's
  // any-narrowing never reaches the consumers (the thermal door's
  // pattern).
  const materials: readonly StructuralSolidMaterial[] = scenario.materials;
  if (!Array.isArray(scenario.materials) || materials.length === 0) {
    return refuse(
      "A structural run scenario must select at least one material.",
      scenario.materials,
    );
  }
  for (const material of materials) {
    if (
      typeof material.youngsModulusPa !== "number" ||
      !Number.isFinite(material.youngsModulusPa) ||
      material.youngsModulusPa <= 0
    ) {
      return refuse(
        `The material "${material.id}" carries no valid youngsModulusPa; the stiffness assembly declines instead of fabricating one.`,
        material.youngsModulusPa,
      );
    }
    if (
      typeof material.poissonRatio !== "number" ||
      !Number.isFinite(material.poissonRatio) ||
      material.poissonRatio <= -1 ||
      material.poissonRatio >= 0.5
    ) {
      return refuse(
        `The material "${material.id}" carries no valid poissonRatio strictly inside (−1, 0.5) — the isotropic-stability band.`,
        material.poissonRatio,
      );
    }
    if (
      typeof material.densityKgPerM3 !== "number" ||
      !Number.isFinite(material.densityKgPerM3) ||
      material.densityKgPerM3 <= 0
    ) {
      return refuse(
        `The material "${material.id}" carries no valid density in kg/m³; the body-force family declines instead of fabricating one.`,
        material.densityKgPerM3,
      );
    }
  }
  const meshResult = structuralHexMesh(scenario.grid);
  if (!meshResult.ok) return meshResult;
  const mesh = meshResult.value;

  const conditions = validateConditions(scenario);
  if (!conditions.ok) return conditions;
  const resolved = resolveConditions(mesh, conditions.value);
  if (!resolved.ok) return resolved;

  const gravity =
    scenario.gravityMPerS2 === undefined
      ? STRUCTURAL_DEFAULT_GRAVITY
      : scenario.gravityMPerS2;
  const gravityTriple = finiteTriple(
    gravity,
    "A structural scenario's gravity vector",
  );
  if (!gravityTriple.ok) return gravityTriple;

  const centrifugal = validateCentrifugal(scenario);
  if (!centrifugal.ok) return centrifugal;

  let fixedDofCount = 0;
  for (const flag of resolved.value.fixedDofMask) {
    if (flag === 1) fixedDofCount += 1;
  }
  if (fixedDofCount === 0) {
    return refuse(
      "The scenario fixes no degrees of freedom — the reduced stiffness system would carry its rigid-body modes and is singular; the door declines instead of iterating on a null space (fixtures address domain faces or points the body reaches).",
      { conditions: conditions.value.length },
    );
  }

  const solverOptions = {
    ...STRUCTURAL_SOLVE_DEFAULTS,
    ...(scenario.solver === undefined ? {} : scenario.solver),
  };

  const systemResult = assembleStructuralSystem({
    mesh,
    materials: scenario.materials,
    cellMaterialIndex: scenario.cellMaterialIndex,
    gravityMPerS2: gravityTriple.value,
    ...(centrifugal.value === undefined
      ? {}
      : { centrifugal: centrifugal.value }),
    ...(scenario.thermalDeltaTK === undefined
      ? {}
      : { thermalDeltaTK: scenario.thermalDeltaTK }),
    fixedDofMask: resolved.value.fixedDofMask,
    nodalLoads: resolved.value.nodalLoads,
  });
  if (!systemResult.ok) return systemResult;
  const system = systemResult.value;

  const solved = solveStructuralSystem(system, solverOptions);
  if (!solved.ok) return solved;
  const { displacementFree, outcome } = solved.value;

  // The full nodal displacement field (fixed dofs hold zero).
  const uNode = new Float64Array(system.nodeCount * 3);
  for (let dof = 0; dof < system.dofCount; dof += 1) {
    const free = system.freeIndexOfDof[dof] ?? -1;
    if (free === -1) continue;
    uNode[dof] = displacementFree[free] ?? 0;
  }
  let maxDeflectionM = 0;
  for (let node = 0; node < system.nodeCount; node += 1) {
    const ux = uNode[node * 3] ?? 0;
    const uy = uNode[node * 3 + 1] ?? 0;
    const uz = uNode[node * 3 + 2] ?? 0;
    const magnitude = Math.sqrt(ux * ux + uy * uy + uz * uz);
    if (magnitude > maxDeflectionM) maxDeflectionM = magnitude;
  }

  // Per-element recovery on the grid lattice (void nodes carry 0 — no
  // material, no stress; the stated fill).
  const cellCount = mesh.nx * mesh.ny * mesh.nz;
  const displacementMagnitude = new Float64Array(cellCount);
  const vonMises = new Float64Array(cellCount);
  const vonMisesMaxByMaterial = new Float64Array(materials.length);
  const dMatrices = materials.map((material) =>
    hexDMatrix(material.youngsModulusPa, material.poissonRatio),
  );
  const elementDisplacement = new Float64Array(24);
  for (let element = 0; element < mesh.elementCount; element += 1) {
    const gridNode = mesh.gridNodeOfElement[element] ?? 0;
    const materialIndex = scenario.cellMaterialIndex[gridNode] ?? 0;
    const material = materials[materialIndex - 1];
    if (material === undefined) continue;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let corner = 0; corner < 8; corner += 1) {
      const node = mesh.elementNode[element * 8 + corner] ?? 0;
      const ux = uNode[node * 3] ?? 0;
      const uy = uNode[node * 3 + 1] ?? 0;
      const uz = uNode[node * 3 + 2] ?? 0;
      elementDisplacement[corner * 3] = ux;
      elementDisplacement[corner * 3 + 1] = uy;
      elementDisplacement[corner * 3 + 2] = uz;
      cx += ux;
      cy += uy;
      cz += uz;
    }
    // The element-center displacement (the host grid node's position):
    // the mean of the 8 corners — exact for linear fields.
    displacementMagnitude[gridNode] =
      Math.sqrt(cx * cx + cy * cy + cz * cz) / 8;
    const thermalStrain =
      scenario.thermalDeltaTK === undefined ||
      material.thermalExpansionPerK === undefined
        ? 0
        : material.thermalExpansionPerK *
          (scenario.thermalDeltaTK[gridNode] ?? 0);
    const strain = hexCenterStrain(
      mesh.spacingM[0] ?? 1,
      mesh.spacingM[1] ?? 1,
      mesh.spacingM[2] ?? 1,
      elementDisplacement,
    );
    const elastic: readonly number[] = [
      (strain[0] ?? 0) - thermalStrain,
      (strain[1] ?? 0) - thermalStrain,
      (strain[2] ?? 0) - thermalStrain,
      strain[3] ?? 0,
      strain[4] ?? 0,
      strain[5] ?? 0,
    ];
    const d = dMatrices[materialIndex - 1];
    if (d === undefined) continue;
    const stress = hexStressApply(d, elastic);
    const vm = hexVonMises(stress);
    vonMises[gridNode] = vm;
    if (vm > (vonMisesMaxByMaterial[materialIndex - 1] ?? 0)) {
      vonMisesMaxByMaterial[materialIndex - 1] = vm;
    }
  }
  let vonMisesMaxPa = 0;
  for (const value of vonMises) {
    if (value > vonMisesMaxPa) vonMisesMaxPa = value;
  }

  // The factor-of-safety family: yield-bearing materials only (the
  // additive-fields honesty — a record without a yield strength runs,
  // reports every field, and declines the FoS consumer alone).
  const materialSafety: StructuralMaterialSafety[] = [];
  let factorOfSafety: number | undefined;
  for (const [index, material] of materials.entries()) {
    if (material.yieldStrengthPa === undefined) continue;
    const materialMax = vonMisesMaxByMaterial[index] ?? 0;
    const entry: StructuralMaterialSafety = {
      materialId: material.id,
      yieldStrengthPa: material.yieldStrengthPa,
      vonMisesMaxPa: materialMax,
      ...(materialMax > 0
        ? {
            factorOfSafety: material.yieldStrengthPa / materialMax,
          }
        : {}),
    };
    materialSafety.push(entry);
    const materialFos = entry.factorOfSafety;
    if (materialFos !== undefined) {
      if (factorOfSafety === undefined || materialFos < factorOfSafety) {
        factorOfSafety = materialFos;
      }
    }
  }

  let snapshotHash: string;
  if (scenario.scenarioSnapshotHash !== undefined) {
    if (
      typeof scenario.scenarioSnapshotHash !== "string" ||
      scenario.scenarioSnapshotHash.length === 0
    ) {
      return refuse(
        "A run scenario's compile-fed snapshot hash must be a non-empty string.",
        scenario.scenarioSnapshotHash,
      );
    }
    snapshotHash = scenario.scenarioSnapshotHash;
  } else {
    const hashed = simScenarioSnapshotHash(runScenarioIdentity(scenario));
    if (!hashed.ok) return hashed;
    snapshotHash = hashed.value;
  }

  const displacementField: SolverSimField = {
    id: "displacement",
    unit: "mm",
    extent: [mesh.nx, mesh.ny, mesh.nz],
    originM: scenario.grid.originM,
    spacingM: scenario.grid.spacingM,
    dataType: "float64",
    values: Array.from(displacementMagnitude),
    dimension: "length",
  };
  const vonMisesField: SolverSimField = {
    id: "von-mises",
    unit: "Pa",
    extent: [mesh.nx, mesh.ny, mesh.nz],
    originM: scenario.grid.originM,
    spacingM: scenario.grid.spacingM,
    dataType: "float64",
    values: Array.from(vonMises),
    dimension: "pressure",
  };

  return simOk(
    Object.freeze({
      scenarioName: scenario.name,
      scenarioSnapshotHash: snapshotHash,
      regime: simRegimeReport({}),
      grid: {
        nx: mesh.nx,
        ny: mesh.ny,
        nz: mesh.nz,
        spacingM: mesh.spacingM,
        elementCount: mesh.elementCount,
        nodeCount: mesh.nodeCount,
        freeDofCount: system.freeDofCount,
        fixedDofCount: system.fixedDofCount,
      },
      solver: outcome,
      displacementField,
      vonMisesField,
      maxDeflectionM,
      vonMisesMaxPa,
      ...(factorOfSafety === undefined ? {} : { factorOfSafety }),
      materialSafety: Object.freeze(materialSafety),
    }),
  );
}

/** The projected field blocks a completed run persists. */
function reportFields(
  report: StructuralRunReport,
): SimParseResult<readonly SimResultFieldBlock[], SimError> {
  const projected = projectSimResult({
    scalars: [],
    fields: [report.displacementField, report.vonMisesField],
  });
  if (!projected.ok) return projected;
  return simOk(projected.value.fields);
}

/**
 * Assembles the persistence-fit {@link SimResult}: the summary (schema
 * version, snapshot hash, status, the empty regime report — the honest
 * structural claim, the dynamics precedent — and the projected
 * quantities with explicit units), the projected displacement/von Mises
 * field blocks, and no histories (statics has no time axis).
 */
export function structuralRunSimResult(
  report: StructuralRunReport,
): SimParseResult<SimResult, SimError> {
  const scalars: SolverSimScalar[] = [
    {
      name: "max-deflection",
      dimension: "length",
      value: report.maxDeflectionM,
    },
    {
      name: "von-mises-max",
      dimension: "pressure",
      value: report.vonMisesMaxPa,
    },
    {
      name: "solver-iterations",
      dimension: "dimensionless",
      value: report.solver.iterations,
    },
    {
      name: "solver-relative-residual",
      dimension: "dimensionless",
      value: report.solver.relativeResidual,
    },
  ];
  if (report.factorOfSafety !== undefined) {
    scalars.push({
      name: "factor-of-safety",
      dimension: "dimensionless",
      value: report.factorOfSafety,
    });
  }
  for (const entry of report.materialSafety) {
    if (entry.factorOfSafety === undefined) continue;
    scalars.push({
      name: `factor-of-safety-${entry.materialId}`,
      dimension: "dimensionless",
      value: entry.factorOfSafety,
    });
  }
  const fields = reportFields(report);
  if (!fields.ok) return fields;
  const projected = projectSimResult({ scalars, fields: [] });
  if (!projected.ok) return projected;
  return simOk({
    summary: {
      schemaVersion: SIM_RESULT_SUMMARY_VERSION,
      scenarioSnapshotHash: report.scenarioSnapshotHash,
      status: "completed",
      regime: report.regime,
      quantities: projected.value.scalars,
      servedBackend: "cpu",
    },
    fields: fields.value,
    histories: [],
  });
}
