/**
 * The geometry-aware compile door (Phase 63c): {@link compileSimScenario}
 * wrapped with the solver-side half of law S3 — the scenario's referenced
 * bodies' tessellation becomes the voxelized 2D occupancy slice the flow
 * engine consumes, at compile time, inside the compiled problem. The 61a
 * compile boundary stays untouched (it converts the scenario's authored
 * fields); this module is its 63c extension over the SAME input shape plus
 * the tessellation wire, so every compile path that has geometry can
 * produce a problem a real engine can run, and every path that does not
 * keeps the 61a behavior byte-for-byte.
 *
 * ## What compile adds here
 *
 * - **The occupancy slice** — `voxelizeSimTessellationSlice` at the
 *   scenario's own domain and resolution, on the plane perpendicular to
 *   the domain's THIRD axis at its mid-height (the deterministic,
 *   authored-nowhere choice: the same mid-height node plane the Phase 62
 *   fixture slices). The slice is solver-space solver geometry (SI
 *   metres, x-fastest) attached to the compiled scenario as
 *   `occupancySlice` — deliberately NOT part of the worker wire form: it
 *   is consumed where it is produced (worker-side, by the engine) and
 *   never needs to cross back.
 * - **The refined twin** — when the scenario flags the grid-convergence
 *   self-check, the same slice voxelized at HALF the resolution (the
 *   factor-2 ladder's second rung, `@slopcad/sim-flow`'s convergence
 *   contract), attached as `occupancySliceRefined`.
 * - **The run controls** — the scenario record's flow-run fields (step
 *   budget, grid-convergence flag), read at the compile door exactly like
 *   every other authored field, plus the derived averaging window (law
 *   S9's time-averaging opens at half the budget, so resolved unsteady
 *   runs always carry mean/fluctuation fields). Attached as `run`.
 *
 * Determinism is structural: the domain resolution, the plane coordinate,
 * and the voxelizer are all fixed arithmetic over the inputs — the same
 * scenario and tessellation compile to the bitwise-identical problem.
 */

import type { SimError } from "./errors";
import type { SimOccupancyGrid } from "./voxel-grid";
import type { SimParseResult } from "./result";
import type {
  CompiledSimDynamics,
  CompiledSimDynamicsForceSample,
  CompiledSimDynamicsLoad,
  CompiledSimDynamicsTorqueSample,
  CompiledSimScenario,
  SimBodyBoundsMm,
  SimCompileInput,
  SimMechanismWire,
} from "./units";

import { SIM_ERROR_CODES, simError } from "./errors";
import { simFail, simOk } from "./result";
import { MM_PER_M } from "./units";
import {
  voxelizeSimTessellation,
  voxelizeSimTessellationSlice,
} from "./voxelizer";
import { compileSimScenario } from "./units";

/**
 * The flow-run controls a compiled flow scenario carries: the record's
 * own fields plus the derived averaging window — everything the engine's
 * run driver needs that is not physics.
 */
export interface CompiledSimRunControls {
  /** The fixed step budget — a scenario field, never a runtime knob. */
  readonly stepBudget: number;
  /**
   * The first COMPLETED step inside the time-averaging window (law S9:
   * derived as half the budget, rounded up, so every flow run carries
   * mean/fluctuation fields).
   */
  readonly averagingStartStep: number;
  /** Whether the grid-convergence self-check runs (the factor-2 ladder). */
  readonly gridConvergence: boolean;
}

/**
 * The default step budget a flow scenario record left unspecified — the
 * authoring form always sends one; this default keeps hand-written
 * scenario JSON runnable (a short but non-trivial window).
 */
export const SIM_FLOW_DEFAULT_STEP_BUDGET = 1200;

/** What {@link compileSimScenarioWithGeometry} consumes. */
export interface GeometrySimCompileInput extends SimCompileInput {
  /**
   * The merged tessellation of the scenario's referenced bodies, the
   * voxelizer's wire form (flat mm positions/indices, optional normals).
   * Absent on a flow scenario leaves the compiled problem without solver
   * geometry — the flow engine declines that run loudly
   * (`sim/geometry-unavailable`), never fabricates an empty tunnel.
   */
  readonly tessellation?: unknown;
  /**
   * The serialized `DocumentMaterialRecord` wire objects the scenario's
   * material assignments may reference (Phase 65c) — the `motor`
   * precedent: plain JSON the compile pairs by id and the solver door
   * re-validates field-by-field. Consumed by the thermal branch.
   */
  readonly materials?: readonly unknown[];
  /**
   * The referenced bodies' OWN tessellations, one entry per body (Phase
   * 65c): the thermal branch voxelizes each body separately so the
   * per-cell material map is per-BODY honest — the merged slice cannot
   * say which body a voxel belongs to. Bodies appear in assignment
   * order; the first body claiming an overlapping voxel wins
   * (deterministic, the author's ambiguity stated).
   */
  readonly bodyTessellations?: readonly SimBodyTessellation[];
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** A finite [x, y, z] triple or a structured decline (the units door's rule). */
function finiteTriple(
  input: unknown,
  what: string,
): SimParseResult<readonly [number, number, number], SimError> {
  const source: readonly unknown[] | null = Array.isArray(input)
    ? (input as readonly unknown[])
    : null;
  const entries: readonly unknown[] =
    source === null ? [] : [source[0], source[1], source[2]];
  if (
    entries.length !== 3 ||
    !entries.every(
      (entry) => typeof entry === "number" && Number.isFinite(entry),
    )
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `${what} must be an array of three finite numbers.`,
        input,
      ),
    );
  }
  return simOk([
    entries[0] as number,
    entries[1] as number,
    entries[2] as number,
  ]);
}

/**
 * Resolves the scenario's domain box in document millimetres — the same
 * resolution rule the 61a boundary applies (explicit bounds verbatim, or
 * the referenced bodies' combined bounds plus margin), restated here
 * because the compiled scenario carries only SI and the voxelizer speaks
 * millimetres. Runs only AFTER the 61a compile succeeded, so the input's
 * domain shape is already known-valid; a disagreement with that
 * validation declines structurally rather than guessing.
 */
function resolveDomainMm(
  scenario: Record<string, unknown>,
  bodyBounds: readonly SimBodyBoundsMm[],
): SimParseResult<
  readonly [
    readonly [number, number, number],
    readonly [number, number, number],
    number,
  ],
  SimError
> {
  const domain = scenario.domain;
  if (!isPlainRecord(domain)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "A scenario's domain must be a plain object with a kind field.",
        domain,
      ),
    );
  }
  const boundsById = new Map<string, SimBodyBoundsMm>();
  for (const entry of bodyBounds) {
    boundsById.set(entry.bodyId, entry);
  }
  if (domain.kind === "explicit") {
    const min = domain.min;
    const max = domain.max;
    if (
      !Array.isArray(min) ||
      min.length !== 3 ||
      !Array.isArray(max) ||
      max.length !== 3
    ) {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          "An explicit domain's min and max corners must be triples (the 61a compile already validated them).",
          domain,
        ),
      );
    }
    return simOk([
      [min[0] ?? 0, min[1] ?? 0, min[2] ?? 0],
      [max[0] ?? 0, max[1] ?? 0, max[2] ?? 0],
      domain.resolutionMm as number,
    ]);
  }
  const bodyIds = Array.isArray(domain.bodyIds) ? domain.bodyIds : [];
  const marginMm = domain.marginMm as number;
  const min: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];
  for (const bodyId of bodyIds) {
    const entry = boundsById.get(bodyId as string);
    if (entry === undefined) {
      return simFail(
        simError(
          SIM_ERROR_CODES.geometryUnavailable,
          `The scenario references body "${String(bodyId)}", but no geometry bounds were supplied for it; the compile boundary refuses to guess a domain.`,
          bodyId,
        ),
      );
    }
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis] ?? Infinity, entry.minMm[axis] ?? 0);
      max[axis] = Math.max(max[axis] ?? -Infinity, entry.maxMm[axis] ?? 0);
    }
  }
  return simOk([
    [
      (min[0] ?? 0) - marginMm,
      (min[1] ?? 0) - marginMm,
      (min[2] ?? 0) - marginMm,
    ],
    [
      (max[0] ?? 0) + marginMm,
      (max[1] ?? 0) + marginMm,
      (max[2] ?? 0) + marginMm,
    ],
    domain.resolutionMm as number,
  ]);
}

/** Parses a flow scenario record's run controls (defaults applied here). */
function compileRunControls(
  scenario: Record<string, unknown>,
): SimParseResult<CompiledSimRunControls, SimError> {
  let stepBudget = SIM_FLOW_DEFAULT_STEP_BUDGET;
  if (scenario.stepBudget !== undefined && scenario.stepBudget !== null) {
    const value = scenario.stepBudget;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 2) {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          "A flow scenario's step budget must be an integer of at least 2 (so the averaging window opens inside the run).",
          value,
        ),
      );
    }
    stepBudget = value;
  }
  let gridConvergence = false;
  if (
    scenario.gridConvergence !== undefined &&
    scenario.gridConvergence !== null
  ) {
    if (typeof scenario.gridConvergence !== "boolean") {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          "A flow scenario's grid-convergence flag must be a boolean.",
          scenario.gridConvergence,
        ),
      );
    }
    gridConvergence = scenario.gridConvergence;
  }
  return simOk({
    stepBudget,
    averagingStartStep: Math.max(1, Math.ceil(stepBudget / 2)),
    gridConvergence,
  });
}

/** The slice's grid name — the compiled problem's own, fixed. */
const OCCUPANCY_SLICE_NAME = "flow-slice";

// ---------------------------------------------------------------------------
// The thermal compile products (Phase 65c)
// ---------------------------------------------------------------------------

/**
 * One resolved body→material pairing of a thermal scenario: the body's id
 * and its serialized `DocumentMaterialRecord` wire object — re-validated
 * field-by-field at the solver door (`@slopcad/sim-thermal`'s material
 * door), exactly the `motor` precedent (the record crosses as plain JSON
 * the consumer re-validates).
 */
export interface CompiledSimThermalMaterial {
  readonly bodyId: string;
  readonly record: unknown;
}

/**
 * The thermal compile products a thermal scenario carries (Phase 65c):
 * the authored solve stance re-validated at this door (the 61a trust
 * discipline — the record layer validated the same fields; the compile
 * boundary re-reads every field it consumes) plus the per-cell material
 * map over {@link CompiledSimScenario.occupancySlice}'s cells — a 1-based
 * index into {@link materials}, 0 on fluid cells. Like the occupancy
 * slice, deliberately NOT part of the worker wire form: consumed
 * worker-side where produced.
 */
export interface CompiledSimThermal {
  readonly radiationMode: "off" | "linearized" | "full";
  readonly solveMode: "steady" | "transient";
  /** Whether the transient run couples to the fluid (the 65b buoyant march). */
  readonly cht: boolean;
  /** The source's total power, W per metre of the slice's unit depth. */
  readonly sourceW: number;
  /** The uniform initial field, K — also the ambient reference. */
  readonly initialTemperatureK: number;
  /** The equilibrium boundary's external convection coefficient, W/(m²·K). */
  readonly ambientConvectionWPerM2K: number;
  /** The transient march's physical end time, s (present iff transient). */
  readonly durationS?: number;
  /** The transient march's sampling cadence, s (present iff transient). */
  readonly sampleIntervalS?: number;
  readonly materials: readonly CompiledSimThermalMaterial[];
  /** Per-cell 1-based material index over the occupancy slice; 0 on fluid. */
  readonly materialIndex: Uint16Array;
}

/** The thermal radiation-mode vocabulary, restated at this door. */
const THERMAL_RADIATION_MODES = ["off", "linearized", "full"] as const;
/** The thermal solve-mode vocabulary, restated at this door. */
const THERMAL_SOLVE_MODES = ["steady", "transient"] as const;

type ThermalRadiationMode = (typeof THERMAL_RADIATION_MODES)[number];
type ThermalSolveMode = (typeof THERMAL_SOLVE_MODES)[number];

function isThermalRadiationMode(input: unknown): input is ThermalRadiationMode {
  return (
    typeof input === "string" &&
    THERMAL_RADIATION_MODES.includes(input as ThermalRadiationMode)
  );
}

function isThermalSolveMode(input: unknown): input is ThermalSolveMode {
  return (
    typeof input === "string" &&
    THERMAL_SOLVE_MODES.includes(input as ThermalSolveMode)
  );
}

/**
 * Re-reads the thermal stance from the raw scenario record (the
 * `compileRunControls` precedent — the 61a boundary already validated the
 * record's shape; the thermal door re-validates every field it consumes
 * before any solver consumes it).
 */
function parseThermalStance(
  scenario: Record<string, unknown>,
): SimParseResult<
  Omit<CompiledSimThermal, "materials" | "materialIndex">,
  SimError
> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  const stance = scenario.thermal;
  if (!isPlainRecord(stance)) {
    return refuse(
      "A thermal scenario must carry its thermal solve stance (the radiation mode, the solve mode, the source, and the ambient boundary) — the compile door refuses to guess physics.",
      stance,
    );
  }
  const radiationMode = stance.radiationMode;
  if (!isThermalRadiationMode(radiationMode)) {
    return refuse(
      `A thermal stance's radiation mode must be one of ${THERMAL_RADIATION_MODES.join(", ")}.`,
      radiationMode,
    );
  }
  const solveMode = stance.solveMode;
  if (!isThermalSolveMode(solveMode)) {
    return refuse(
      `A thermal stance's solve mode must be one of ${THERMAL_SOLVE_MODES.join(", ")}.`,
      solveMode,
    );
  }
  if (typeof stance.cht !== "boolean") {
    return refuse(
      "A thermal stance's conjugate-coupling flag must be a boolean.",
      stance.cht,
    );
  }
  if (solveMode === "steady" && stance.cht) {
    return refuse(
      "A steady thermal scenario cannot request the conjugate coupled march — the coupling advances in physical time, so it is transient by construction.",
      stance,
    );
  }
  const finitePositive = (
    value: unknown,
    what: string,
  ): SimParseResult<number, SimError> =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? simOk(value)
      : refuse(
          `A thermal stance's ${what} must be a positive finite number.`,
          value,
        );
  const sourceW = finitePositive(stance.sourceW, "source power");
  if (!sourceW.ok) return sourceW;
  const initialTemperatureK = finitePositive(
    stance.initialTemperatureK,
    "initial temperature",
  );
  if (!initialTemperatureK.ok) return initialTemperatureK;
  const ambientConvectionWPerM2K = stance.ambientConvectionWPerM2K;
  if (
    typeof ambientConvectionWPerM2K !== "number" ||
    !Number.isFinite(ambientConvectionWPerM2K) ||
    ambientConvectionWPerM2K < 0
  ) {
    return refuse(
      "A thermal stance's ambient convection coefficient must be a finite number ≥ 0 W/(m²·K).",
      ambientConvectionWPerM2K,
    );
  }
  let durationS: number | undefined;
  let sampleIntervalS: number | undefined;
  if (solveMode === "transient") {
    const duration = finitePositive(stance.durationS, "transient duration");
    if (!duration.ok) return duration;
    const interval = finitePositive(
      stance.sampleIntervalS,
      "transient sample interval",
    );
    if (!interval.ok) return interval;
    const sampleCount = Math.round(duration.value / interval.value);
    if (
      sampleCount < 1 ||
      Math.abs(sampleCount * interval.value - duration.value) >
        1e-9 * duration.value
    ) {
      return refuse(
        "A transient thermal stance's duration must be an integer multiple of its sample interval so every sample lands on the cadence.",
        { durationS: duration.value, sampleIntervalS: interval.value },
      );
    }
    durationS = duration.value;
    sampleIntervalS = interval.value;
  }
  return simOk({
    radiationMode,
    solveMode,
    cht: stance.cht,
    sourceW: sourceW.value,
    initialTemperatureK: initialTemperatureK.value,
    ambientConvectionWPerM2K,
    ...(durationS === undefined ? {} : { durationS }),
    ...(sampleIntervalS === undefined ? {} : { sampleIntervalS }),
  });
}

/** One body's tessellation entry of {@link GeometrySimCompileInput}. */
export interface SimBodyTessellation {
  readonly bodyId: string;
  /** The body's own triangle soup, the voxelizer's wire form (flat mm). */
  readonly tessellation: unknown;
}

// ---------------------------------------------------------------------------
// The 3D flow compile products (Phase 66c)
// ---------------------------------------------------------------------------

/** The boundary-treatment vocabulary, restated at this door. */
const FLOW3D_BOUNDARY_TREATMENTS = ["staircase", "cut-cell"] as const;

/** The rotation-kind vocabulary, restated at this door. */
const FLOW3D_ROTATION_KINDS = ["mrf", "resolved-rotation"] as const;

/** The rpm-mode vocabulary, restated at this door. */
const FLOW3D_RPM_MODES = ["fixed", "motor"] as const;

type Flow3dBoundaryTreatment = (typeof FLOW3D_BOUNDARY_TREATMENTS)[number];
type Flow3dRotationKind = (typeof FLOW3D_ROTATION_KINDS)[number];
type Flow3dRpmMode = (typeof FLOW3D_RPM_MODES)[number];

function isFlow3dRotationKind(input: unknown): input is Flow3dRotationKind {
  return (
    typeof input === "string" &&
    FLOW3D_ROTATION_KINDS.includes(input as Flow3dRotationKind)
  );
}

function isFlow3dRpmMode(input: unknown): input is Flow3dRpmMode {
  return (
    typeof input === "string" &&
    FLOW3D_RPM_MODES.includes(input as Flow3dRpmMode)
  );
}

/** The compiled rotation half of a 3D stance: pure SI (law S4's door). */
export interface CompiledSimFlow3dRotation {
  readonly kind: Flow3dRotationKind;
  /** One point on the shaft axis, m (converted from authored mm HERE). */
  readonly axisPointM: readonly [number, number, number];
  /** The axis direction, normalized at this door. */
  readonly axisDirection: readonly [number, number, number];
  /** The rotating zone's radius about the axis, m. */
  readonly zoneRadiusM: number;
  readonly rpmMode: Flow3dRpmMode;
  /** The fixed shaft rate, rad/s (rpm × 2π/60 — converted HERE); iff fixed. */
  readonly fixedOmegaRadPerS?: number;
  /** The authored blade count (BPF arithmetic). */
  readonly bladeCount: number;
}

/**
 * The 3D flow compile products a `flow` scenario with a 3D stance
 * carries (Phase 66c): the re-validated rotation (SI), plus the FULL-3D
 * occupancy grid attached as {@link CompiledSimScenario.occupancy3d}
 * (beside the 2D slice the wind-tunnel branch attaches — the same
 * worker-side-only discipline: consumed where produced, never on the
 * wire).
 */
export interface CompiledSimFlow3d {
  /** The implemented boundary treatment — "staircase" today, always. */
  readonly boundaryTreatment: "staircase";
  readonly rotation?: CompiledSimFlow3dRotation;
}

/** The 3D occupancy grid's name — the compiled problem's own, fixed. */
const OCCUPANCY_3D_NAME = "flow3d-domain";

/** rpm → rad/s at the compile door (the motor record's own constant). */
const RPM_TO_RAD_PER_S = (2 * Math.PI) / 60;

/**
 * Re-reads the 3D stance from the raw scenario record (the
 * `parseThermalStance` precedent — the record layer validated the same
 * fields; this door re-validates every field it consumes, converts the
 * authored millimetres to SI, and owns the cut-cell decline: the
 * reserved treatment is refused HERE, loudly, with the recorded
 * raise-or-decline verdict's pointer — never silently accepted as the
 * staircase it is not).
 */
function parseFlow3dStance(
  scenario: Record<string, unknown>,
): SimParseResult<CompiledSimFlow3d, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  const stance = scenario.flow3d;
  if (!isPlainRecord(stance)) {
    return refuse(
      "A flow scenario's 3D stance must be a plain object (an optional rotation inside).",
      stance,
    );
  }
  if (
    stance.boundaryTreatment !== undefined &&
    stance.boundaryTreatment !== null
  ) {
    const value = stance.boundaryTreatment;
    if (
      typeof value !== "string" ||
      !FLOW3D_BOUNDARY_TREATMENTS.includes(value as Flow3dBoundaryTreatment)
    ) {
      return refuse(
        `A 3D stance's boundary treatment must be one of: ${FLOW3D_BOUNDARY_TREATMENTS.join(", ")}.`,
        value,
      );
    }
    if (value === "cut-cell") {
      return simFail(
        simError(
          SIM_ERROR_CODES.boundaryTreatmentUnsupported,
          'The reserved "cut-cell" boundary treatment has no solver: the Phase 66c raise-or-decline verdict DECLINED it against the Phase 62 distance field (staircase accuracy bands + the grid-convergence precedent cover the honesty instead — docs/architecture/adr-simulation.md, "The cut-cell decision"). Raise it with the owner and a dedicated phase lands it; this boundary refuses to silently serve the staircase under a cut-cell label.',
          value,
        ),
      );
    }
  }
  // The only implemented treatment survives the refusal above.
  const boundaryTreatment = "staircase" as const;
  if (stance.rotation === undefined || stance.rotation === null) {
    return simOk({ boundaryTreatment });
  }
  const rotation = stance.rotation;
  if (!isPlainRecord(rotation)) {
    return refuse(
      "A 3D stance's rotation must be a plain object with kind, axis, zone, mode, and blade fields.",
      rotation,
    );
  }
  if (!isFlow3dRotationKind(rotation.kind)) {
    return refuse(
      `A 3D stance's rotation kind must be one of: ${FLOW3D_ROTATION_KINDS.join(", ")}.`,
      rotation.kind,
    );
  }
  const tripleOf = (
    input: unknown,
    what: string,
  ): SimParseResult<readonly [number, number, number], SimError> => {
    // The element-wise copy keeps the element type `unknown` (never the
    // `any` Array.isArray narrows to), so every component narrows
    // through its own typeof/finite check below (the section-triple
    // precedent).
    const source: readonly unknown[] | null = Array.isArray(input)
      ? (input as readonly unknown[])
      : null;
    const entries: readonly unknown[] =
      source === null ? [] : [source[0], source[1], source[2]];
    if (entries.length !== 3) {
      return refuse(`A 3D stance's ${what} must be a triple.`, input);
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
      return refuse(
        `A 3D stance's ${what} must be three finite numbers.`,
        input,
      );
    }
    return simOk([x, y, z]);
  };
  const axisPointMm = tripleOf(rotation.axisPointMm, "rotation axis point");
  if (!axisPointMm.ok) return axisPointMm;
  const axisDirection = tripleOf(
    rotation.axisDirection,
    "rotation axis direction",
  );
  if (!axisDirection.ok) return axisDirection;
  const [dx, dy, dz] = [
    axisDirection.value[0] ?? 0,
    axisDirection.value[1] ?? 0,
    axisDirection.value[2] ?? 0,
  ];
  const directionNorm = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (!(directionNorm > 0)) {
    return refuse(
      "A 3D stance's rotation axis direction must be non-zero.",
      rotation.axisDirection,
    );
  }
  if (
    typeof rotation.zoneRadiusMm !== "number" ||
    !Number.isFinite(rotation.zoneRadiusMm) ||
    rotation.zoneRadiusMm <= 0
  ) {
    return refuse(
      "A 3D stance's rotating zone radius must be a positive finite number of millimetres.",
      rotation.zoneRadiusMm,
    );
  }
  if (!isFlow3dRpmMode(rotation.rpmMode)) {
    return refuse(
      `A 3D stance's rpm mode must be one of: ${FLOW3D_RPM_MODES.join(", ")}.`,
      rotation.rpmMode,
    );
  }
  const rpmMode = rotation.rpmMode;
  let fixedOmegaRadPerS: number | undefined;
  if (rpmMode === "fixed") {
    if (
      typeof rotation.fixedRpm !== "number" ||
      !Number.isFinite(rotation.fixedRpm) ||
      rotation.fixedRpm <= 0
    ) {
      return refuse(
        "A fixed-rpm 3D stance's shaft rate must be a positive finite rpm value.",
        rotation.fixedRpm,
      );
    }
    fixedOmegaRadPerS = rotation.fixedRpm * RPM_TO_RAD_PER_S;
  } else if (scenario.motorId === undefined || scenario.motorId === null) {
    return simFail(
      simError(
        SIM_ERROR_CODES.motorInvalid,
        "A motor-driven 3D stance selects no motor record — the operating point solves T_motor(ω) = T_load(ω) against the scenario's selected `motors` record, and the compile refuses to guess one.",
        scenario.motorId,
      ),
    );
  }
  if (
    typeof rotation.bladeCount !== "number" ||
    !Number.isInteger(rotation.bladeCount) ||
    rotation.bladeCount < 1
  ) {
    return refuse(
      "A 3D stance's blade count must be a positive integer (the authored field the BPF arithmetic consumes).",
      rotation.bladeCount,
    );
  }
  return simOk({
    boundaryTreatment,
    rotation: Object.freeze({
      kind: rotation.kind,
      axisPointM: [
        (axisPointMm.value[0] ?? 0) / MM_PER_M,
        (axisPointMm.value[1] ?? 0) / MM_PER_M,
        (axisPointMm.value[2] ?? 0) / MM_PER_M,
      ] as const,
      axisDirection: [
        dx / directionNorm,
        dy / directionNorm,
        dz / directionNorm,
      ] as const,
      zoneRadiusM: rotation.zoneRadiusMm / 1000,
      rpmMode,
      ...(fixedOmegaRadPerS === undefined ? {} : { fixedOmegaRadPerS }),
      bladeCount: rotation.bladeCount,
    }),
  });
}

/**
 * The 3D flow compile branch: the scenario's 3D stance re-validated
 * into SI (the cut-cell decline lives inside), the merged tessellation
 * voxelized into the FULL-3D occupancy grid (`voxelizeSimTessellation`
 * — the Phase 62 native output the D3Q19 kernel consumes directly),
 * and the run controls read exactly like the 2D branch's. The 3D
 * factor-2 grid-convergence ladder is NOT part of this surface: a
 * flagged scenario declines loudly here rather than silently skipping
 * the self-check the 2D tunnel runs.
 */
function compileFlow3dProducts(
  scenario: Record<string, unknown>,
  input: GeometrySimCompileInput,
  bodyBounds: readonly SimBodyBoundsMm[],
): SimParseResult<
  Pick<CompiledSimScenario, "occupancy3d" | "flow3d" | "run">,
  SimError
> {
  const stance = parseFlow3dStance(scenario);
  if (!stance.ok) return stance;
  if (input.tessellation === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.geometryUnavailable,
        "A 3D flow run needs the scenario's voxelized body geometry: compile with the bodies' tessellation — the 3D engine refuses to fabricate an empty domain.",
        scenario.name,
      ),
    );
  }
  const run = compileRunControls(scenario);
  if (!run.ok) return run;
  if (run.value.gridConvergence) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "A 3D flow scenario cannot flag the grid-convergence self-check yet: the factor-2 ladder's refined 3D twin (8× the nodes) is not part of Phase 66c's surface, and this door declines the flag loudly instead of silently skipping the self-check the 2D tunnel runs. Resolution guidance and accuracy bands cover 3D honesty today; the ladder needs its own phase or ruling.",
        scenario.gridConvergence,
      ),
    );
  }
  const domain = resolveDomainMm(scenario, bodyBounds);
  if (!domain.ok) return domain;
  const [minMm, maxMm, resolutionMm] = domain.value;
  const grid = voxelizeSimTessellation({
    tessellation: input.tessellation,
    domain: {
      kind: "explicit",
      minMm,
      maxMm,
      resolutionMm,
    },
    name: OCCUPANCY_3D_NAME,
  });
  if (!grid.ok) return grid;
  return simOk({
    occupancy3d: grid.value,
    flow3d: stance.value,
    run: run.value,
  });
}

/**
 * The thermal compile branch's shared core (Phase 65c, restated for
 * Phase 68c's stove mode): voxelizes each referenced body's
 * tessellation at the domain's mid-height plane (the SAME plane rule
 * the flow slice uses), unions the per-body grids into the occupancy
 * slice, and resolves the per-cell material map — every solid cell
 * carries the 1-based material index of the FIRST body claiming it
 * (deterministic in input order; overlapping bodies are the author's
 * ambiguity, the map is not). Every voxelized body must carry a
 * material assignment whose id names one of the supplied records;
 * anything else declines loudly.
 */
function voxelizeSolidMaterialMap(
  scenario: Record<string, unknown>,
  input: GeometrySimCompileInput,
  bodyBounds: readonly SimBodyBoundsMm[],
): SimParseResult<
  {
    readonly occupancySlice: SimOccupancyGrid;
    readonly materials: readonly CompiledSimThermalMaterial[];
    readonly materialIndex: Uint16Array;
  },
  SimError
> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));

  const bodies = input.bodyTessellations ?? [];
  if (bodies.length === 0) {
    return refuse(
      "The compile needs the referenced bodies' tessellations (one entry per body); the compile door refuses to fabricate an empty solid.",
      input.bodyTessellations,
    );
  }
  const domain = resolveDomainMm(scenario, bodyBounds);
  if (!domain.ok) return domain;
  const [minMm, maxMm, resolutionMm] = domain.value;
  const planeCoordinateMm = ((minMm[2] ?? 0) + (maxMm[2] ?? 0)) / 2;
  const sliceDomain = {
    kind: "explicit" as const,
    minMm,
    maxMm,
    resolutionMm,
  };
  const plane = { axis: "z" as const, coordinateMm: planeCoordinateMm };

  // The material records, indexed by their wire id (shape-checked here;
  // the solver door re-validates every consumed field).
  const recordsById = new Map<string, unknown>();
  for (const record of input.materials ?? []) {
    if (!isPlainRecord(record) || typeof record.id !== "string") {
      return refuse(
        "The compile's material records must be plain objects carrying a string id.",
        record,
      );
    }
    recordsById.set(record.id, record);
  }
  const assignments = Array.isArray(scenario.materials)
    ? (scenario.materials as readonly unknown[])
    : [];
  const materialOfBody = new Map<string, string>();
  for (const entry of assignments) {
    if (!isPlainRecord(entry)) {
      return refuse(
        "A scenario's material assignment must be a plain object with bodyId and materialId fields.",
        entry,
      );
    }
    if (
      typeof entry.bodyId !== "string" ||
      typeof entry.materialId !== "string"
    ) {
      return refuse(
        "A scenario's material assignment must carry string bodyId and materialId values.",
        entry,
      );
    }
    materialOfBody.set(entry.bodyId, entry.materialId);
  }

  const materials: {
    readonly bodyId: string;
    readonly record: unknown;
  }[] = [];
  const indexByMaterialId = new Map<string, number>();
  let reference: SimOccupancyGrid | undefined;
  const materialIndexParts: Uint16Array[] = [];
  for (const body of bodies) {
    if (!isPlainRecord(body) || typeof body.bodyId !== "string") {
      return refuse(
        "The compile's body tessellations must carry a string bodyId beside the tessellation.",
        body,
      );
    }
    const materialId = materialOfBody.get(body.bodyId);
    if (materialId === undefined) {
      return refuse(
        `The scenario voxelizes body "${body.bodyId}" but assigns it no material; every solid the conduction solve sees must carry one, and the compile door declines instead of guessing.`,
        body.bodyId,
      );
    }
    let materialListIndex = indexByMaterialId.get(materialId);
    if (materialListIndex === undefined) {
      const record = recordsById.get(materialId);
      if (record === undefined) {
        return refuse(
          `The scenario assigns material "${materialId}" but no supplied material record carries that id; the compile refuses a selection it cannot resolve.`,
          materialId,
        );
      }
      materialListIndex = materials.length + 1;
      indexByMaterialId.set(materialId, materialListIndex);
      materials.push({ bodyId: body.bodyId, record });
    }
    const slice = voxelizeSimTessellationSlice({
      tessellation: body.tessellation,
      domain: sliceDomain,
      plane,
      name: OCCUPANCY_SLICE_NAME,
    });
    if (!slice.ok) return slice;
    if (reference === undefined) {
      reference = slice.value;
    } else {
      if (
        slice.value.shape[0] !== reference.shape[0] ||
        slice.value.shape[1] !== reference.shape[1] ||
        slice.value.shape[2] !== reference.shape[2]
      ) {
        return refuse(
          "The compile's per-body slices disagree on their lattice shape; every body must voxelize over the SAME domain at the SAME resolution.",
          {
            first: [...reference.shape],
            body: [...slice.value.shape],
          },
        );
      }
      for (let cell = 0; cell < reference.cells.length; cell += 1) {
        reference.cells[cell] =
          reference.cells[cell] === 1 ? 1 : (slice.value.cells[cell] ?? 0);
      }
    }
    const assigned = materialListIndex;
    const bodyIndex = new Uint16Array(slice.value.cells.length);
    for (let cell = 0; cell < bodyIndex.length; cell += 1) {
      bodyIndex[cell] = slice.value.cells[cell] === 1 ? assigned : 0;
    }
    materialIndexParts.push(bodyIndex);
  }
  const union = reference;
  if (union === undefined) {
    return refuse(
      "The compile needs at least one body tessellation.",
      input.bodyTessellations,
    );
  }
  const materialIndex = new Uint16Array(union.cells.length);
  for (const part of materialIndexParts) {
    for (let cell = 0; cell < materialIndex.length; cell += 1) {
      const claimed = part[cell] ?? 0;
      if (claimed !== 0 && materialIndex[cell] === 0) {
        materialIndex[cell] = claimed;
      }
    }
  }
  for (let cell = 0; cell < union.cells.length; cell += 1) {
    if (union.cells[cell] === 1 && materialIndex[cell] === 0) {
      return refuse(
        "A solid voxel resolved no material — the per-cell material map must cover every solid cell.",
        cell,
      );
    }
  }
  return simOk({ occupancySlice: union, materials, materialIndex });
}

/**
 * The thermal compile branch: voxelizes each referenced body's
 * tessellation at the domain's mid-height plane (the SAME plane rule the
 * flow slice uses), unions the per-body grids into the occupancy slice,
 * and resolves the per-cell material map — every solid cell carries the
 * 1-based material index of the FIRST body claiming it (deterministic in
 * input order; overlapping bodies are the author's ambiguity, the map is
 * not). Every voxelized body must carry a material assignment whose id
 * names one of the supplied records; anything else declines loudly.
 */
function compileThermalProducts(
  scenario: Record<string, unknown>,
  input: GeometrySimCompileInput,
  bodyBounds: readonly SimBodyBoundsMm[],
): SimParseResult<
  Pick<CompiledSimScenario, "occupancySlice" | "thermal">,
  SimError
> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  const stance = parseThermalStance(scenario);
  if (!stance.ok) return stance;

  const solid = voxelizeSolidMaterialMap(scenario, input, bodyBounds);
  if (!solid.ok) return solid;
  const union = solid.value.occupancySlice;

  if (stance.value.cht) {
    let fluidCells = 0;
    for (let cell = 0; cell < union.cells.length; cell += 1) {
      if (union.cells[cell] !== 1) fluidCells += 1;
    }
    if (fluidCells === 0) {
      return refuse(
        "The scenario requests the conjugate coupled march, but the voxelized solids fill the whole slice — there is no fluid domain to convect through, and the compile declines the coupled stance instead of silently sealing it.",
        union.shape,
      );
    }
  }

  return simOk({
    occupancySlice: union,
    thermal: {
      ...stance.value,
      materials: solid.value.materials,
      materialIndex: solid.value.materialIndex,
    },
  });
}

// ---------------------------------------------------------------------------
// The dynamics compile products (Phase 67c)
// ---------------------------------------------------------------------------

/**
 * Compiles a dynamics scenario's products (Phase 67c, the
 * `compileThermalProducts` precedent): the serialized solve stance
 * re-validated field-by-field (the record layer validated the same
 * fields; this door re-checks every field it consumes), the mechanism
 * wire validated structurally (plain arrays, non-empty — the 67
 * dynamics door re-validates every record inside them and converts the
 * document units, its own documented S4 stance), the load couplings
 * converted to SI (the application point's mm → m; times, forces, and
 * efforts are authored SI-adjacent already), and the serialized motor
 * record carried verbatim for the door's own one conversion site.
 */
function compileDynamicsProducts(
  input: GeometrySimCompileInput,
): SimParseResult<Pick<CompiledSimScenario, "dynamics">, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  const scenario = input.scenario;
  if (!isPlainRecord(scenario)) {
    return refuse(
      "A scenario must be a plain serialized scenario object.",
      scenario,
    );
  }
  const stance = scenario.dynamics;
  if (!isPlainRecord(stance)) {
    return refuse(
      "A dynamics scenario must carry its dynamics solve stance (the time step, the duration, the sample cadence) — the compile door refuses to guess a march.",
      stance,
    );
  }
  const positive = (
    value: unknown,
    what: string,
  ): SimParseResult<number, SimError> =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? simOk(value)
      : refuse(
          `A dynamics stance's ${what} must be a positive finite number.`,
          value,
        );
  const timeStepS = positive(stance.timeStepS, "time step");
  if (!timeStepS.ok) return timeStepS;
  const durationS = positive(stance.durationS, "duration");
  if (!durationS.ok) return durationS;
  const sampleIntervalS = positive(stance.sampleIntervalS, "sample interval");
  if (!sampleIntervalS.ok) return sampleIntervalS;
  const steps = Math.round(durationS.value / timeStepS.value);
  if (
    steps < 1 ||
    Math.abs(steps * timeStepS.value - durationS.value) > 1e-9 * durationS.value
  ) {
    return refuse(
      "A dynamics stance's duration must be an integer multiple of its time step so the march ends exactly on the step lattice.",
      { durationS: durationS.value, timeStepS: timeStepS.value },
    );
  }
  const cadenceSteps = Math.round(sampleIntervalS.value / timeStepS.value);
  if (
    cadenceSteps < 1 ||
    Math.abs(cadenceSteps * timeStepS.value - sampleIntervalS.value) >
      1e-9 * sampleIntervalS.value ||
    sampleIntervalS.value > durationS.value
  ) {
    return refuse(
      "A dynamics stance's sample interval must be an integer number of time steps, at most the duration.",
      { sampleIntervalS: sampleIntervalS.value, timeStepS: timeStepS.value },
    );
  }
  let provider: "reference" | "mujoco" = "reference";
  if (stance.provider !== undefined && stance.provider !== null) {
    if (stance.provider !== "reference" && stance.provider !== "mujoco") {
      return refuse(
        'A dynamics stance\'s provider must be "reference" or "mujoco".',
        stance.provider,
      );
    }
    provider = stance.provider;
  }
  let motorJointId: string | undefined;
  if (stance.motorJointId !== undefined && stance.motorJointId !== null) {
    if (typeof stance.motorJointId !== "string") {
      return refuse(
        "A dynamics stance's motor joint must be a joint id string.",
        stance.motorJointId,
      );
    }
    motorJointId = stance.motorJointId;
  }

  // The mechanism wire: structural validation only (the dynamics door
  // owns the field-by-field restatement).
  const wire = input.mechanism;
  if (!isPlainRecord(wire)) {
    return refuse(
      "A dynamics compile needs the document's mechanism wire (occurrences, joints, mass properties, grounded ids) — the compile door refuses to fabricate a mechanism.",
      wire,
    );
  }
  if (
    !Array.isArray(wire.occurrences) ||
    wire.occurrences.length === 0 ||
    !Array.isArray(wire.joints) ||
    !Array.isArray(wire.masses)
  ) {
    return refuse(
      "A mechanism wire must carry non-empty occurrences and joints arrays plus its mass-properties list.",
      {
        occurrences: Array.isArray(wire.occurrences)
          ? wire.occurrences.length
          : "absent",
        joints: Array.isArray(wire.joints) ? wire.joints.length : "absent",
        masses: Array.isArray(wire.masses) ? wire.masses.length : "absent",
      },
    );
  }
  if (wire.grounded !== undefined && !Array.isArray(wire.grounded)) {
    return refuse(
      "A mechanism wire's grounded list must be an array.",
      wire.grounded,
    );
  }
  let groundedIds: readonly string[] | undefined;
  if (Array.isArray(wire.grounded)) {
    const ids: string[] = [];
    for (const id of wire.grounded) {
      if (typeof id !== "string") {
        return refuse(
          "A mechanism wire's grounded entries must be occurrence id strings — the compile door never guesses which bodies weld to ground.",
          id,
        );
      }
      ids.push(id);
    }
    groundedIds = ids;
  }
  const mechanism: SimMechanismWire = {
    occurrences: wire.occurrences,
    joints: wire.joints,
    masses: wire.masses,
    ...(groundedIds === undefined ? {} : { grounded: groundedIds }),
  };

  // The load couplings: SI magnitudes, the application point converted.
  const loads: CompiledSimDynamicsLoad[] = [];
  if (stance.loads !== undefined && stance.loads !== null) {
    if (!Array.isArray(stance.loads)) {
      return refuse(
        "A dynamics stance's loads must be an array of series records.",
        stance.loads,
      );
    }
    for (const entry of stance.loads) {
      if (!isPlainRecord(entry)) {
        return refuse(
          "Each dynamics load must be a plain object with a kind field.",
          entry,
        );
      }
      const samplesWire = entry.samples;
      if (!Array.isArray(samplesWire) || samplesWire.length < 2) {
        return refuse(
          "A dynamics load must carry at least two samples (a series interpolates).",
          samplesWire,
        );
      }
      const parseTimes = (samples: readonly unknown[]): number[] => {
        const times: number[] = [];
        for (const sample of samples) {
          if (!isPlainRecord(sample)) continue; // declined below on shape
          const t = sample.tS;
          if (
            typeof t !== "number" ||
            !Number.isFinite(t) ||
            t < 0 ||
            t > durationS.value
          ) {
            return [];
          }
          times.push(t);
        }
        return times;
      };
      if (entry.kind === "flow-force") {
        if (typeof entry.occurrenceId !== "string") {
          return refuse(
            "A flow-force load must carry its occurrence id string.",
            entry.occurrenceId,
          );
        }
        const times = parseTimes(samplesWire);
        let ordered = times.length === samplesWire.length;
        for (let index = 1; ordered && index < times.length; index += 1) {
          if ((times[index] ?? 0) <= (times[index - 1] ?? 0)) ordered = false;
        }
        if (!ordered) {
          return refuse(
            "A flow-force load's sample times must be finite, strictly increasing, and inside the duration.",
            samplesWire,
          );
        }
        const samples: CompiledSimDynamicsForceSample[] = [];
        for (const sample of samplesWire) {
          if (!isPlainRecord(sample)) {
            return refuse(
              "A flow-force sample must be a plain object.",
              sample,
            );
          }
          const forceN = finiteTriple(
            sample.forceN,
            "A flow-force sample's force",
          );
          if (!forceN.ok) return forceN;
          let atWorldPointM: readonly [number, number, number] | undefined;
          if (
            sample.atWorldPointMm !== undefined &&
            sample.atWorldPointMm !== null
          ) {
            const pointMm = finiteTriple(
              sample.atWorldPointMm,
              "A flow-force sample's application point",
            );
            if (!pointMm.ok) return pointMm;
            atWorldPointM = [
              pointMm.value[0] / MM_PER_M,
              pointMm.value[1] / MM_PER_M,
              pointMm.value[2] / MM_PER_M,
            ];
          }
          samples.push({
            tS: sample.tS as number,
            forceN: forceN.value,
            ...(atWorldPointM === undefined ? {} : { atWorldPointM }),
          });
        }
        loads.push({
          kind: "flow-force",
          occurrenceId: entry.occurrenceId,
          samples: Object.freeze(samples),
        });
        continue;
      }
      if (entry.kind === "joint-torque") {
        if (
          typeof entry.name !== "string" ||
          entry.name.trim().length < 1 ||
          entry.name.trim().length > 64
        ) {
          return refuse(
            "A joint-torque load's name must be 1-64 characters (trimmed).",
            entry.name,
          );
        }
        if (typeof entry.jointId !== "string") {
          return refuse(
            "A joint-torque load must carry its joint id string.",
            entry.jointId,
          );
        }
        const times = parseTimes(samplesWire);
        let ordered = times.length === samplesWire.length;
        for (let index = 1; ordered && index < times.length; index += 1) {
          if ((times[index] ?? 0) <= (times[index - 1] ?? 0)) ordered = false;
        }
        if (!ordered) {
          return refuse(
            "A joint-torque load's sample times must be finite, strictly increasing, and inside the duration.",
            samplesWire,
          );
        }
        const samples: CompiledSimDynamicsTorqueSample[] = [];
        for (const sample of samplesWire) {
          if (!isPlainRecord(sample)) {
            return refuse(
              "A joint-torque sample must be a plain object.",
              sample,
            );
          }
          if (
            typeof sample.effortNPerM !== "number" ||
            !Number.isFinite(sample.effortNPerM)
          ) {
            return refuse(
              "A joint-torque sample's effort must be a finite number (N·m).",
              sample.effortNPerM,
            );
          }
          samples.push({
            tS: sample.tS as number,
            effortNPerM: sample.effortNPerM,
          });
        }
        loads.push({
          kind: "joint-torque",
          name: entry.name.trim(),
          jointId: entry.jointId,
          samples: Object.freeze(samples),
        });
        continue;
      }
      return refuse(
        'A dynamics load\'s kind must be "flow-force" or "joint-torque".',
        entry.kind,
      );
    }
  }

  const dynamics: CompiledSimDynamics = Object.freeze({
    provider,
    timeStepS: timeStepS.value,
    durationS: durationS.value,
    sampleIntervalS: sampleIntervalS.value,
    ...(motorJointId === undefined ? {} : { motorJointId }),
    mechanism,
    loads: Object.freeze(loads),
    ...(input.motor === undefined ? {} : { motorWire: input.motor }),
  });
  return simOk({ dynamics });
}

// ---------------------------------------------------------------------------
// The combustion compile products (Phase 68c)
// ---------------------------------------------------------------------------

/** The combustion stance's mode vocabulary, restated at this door. */
const COMBUSTION_MODES = ["stove", "engine"] as const;

/** The combustion stance's fuel vocabulary, restated at this door. */
const COMBUSTION_FUELS = ["CH4", "C8H18-ISO", "C8H18-N"] as const;

/** The engine mode's fuels (those with a published flame-speed fit). */
const COMBUSTION_ENGINE_FUELS = ["C8H18-ISO", "C8H18-N"] as const;

/** The sweep-axis vocabulary, restated at this door. */
const COMBUSTION_SWEEP_KINDS = [
  "compressionRatio",
  "equivalenceRatio",
  "sparkTiming",
] as const;

/** The equivalence-ratio ceiling the chemistry carries (the 68a door's). */
const COMBUSTION_MAX_EQUIVALENCE_RATIO = 5;

type CombustionMode = (typeof COMBUSTION_MODES)[number];
type CombustionFuel = (typeof COMBUSTION_FUELS)[number];
type CombustionSweepKind = (typeof COMBUSTION_SWEEP_KINDS)[number];

/**
 * The STOVE-mode compile products (Phase 68c): the re-validated fire
 * stance plus the SAME per-cell material map the thermal branch builds
 * (the 65-family solve), consumed worker-side by the combustion stove
 * engine beside {@link CompiledSimScenario.occupancySlice}.
 */
export interface CompiledSimCombustionStove {
  readonly mode: "stove";
  readonly fuel: CombustionFuel;
  readonly equivalenceRatio: number;
  readonly chargeTemperatureK: number;
  readonly chargePressureBar: number;
  readonly wallConvectionWPerM2K: number;
  /** The fire-side wall temperature, K — resolved (default: the field). */
  readonly wallTemperatureK: number;
  readonly radiationMode: ThermalRadiationMode;
  readonly initialTemperatureK: number;
  readonly ambientConvectionWPerM2K: number;
  readonly durationS: number;
  readonly sampleIntervalS: number;
  readonly materials: readonly CompiledSimThermalMaterial[];
  /** Per-cell 1-based material index over the occupancy slice; 0 on fluid. */
  readonly materialIndex: Uint16Array;
}

/**
 * The ENGINE-mode compile products (Phase 68c): the re-validated 0D
 * Otto stance with the slider-crank geometry converted to SI HERE (the
 * one mm→m site for the chamber, law S4). No voxelization — the 0D
 * chamber has no spatial domain; the Phase 67 seam is the volume
 * formula the cycle integrates.
 */
export interface CompiledSimCombustionEngine {
  readonly mode: "engine";
  readonly fuel: Exclude<CombustionFuel, "CH4">;
  readonly geometry: {
    readonly boreM: number;
    readonly crankRadiusM: number;
    readonly rodLengthM: number;
    readonly compressionRatio: number;
  };
  readonly speedRpm: number;
  readonly charge: {
    readonly intakePressureBar: number;
    readonly intakeTK: number;
    readonly equivalenceRatio: number;
  };
  readonly spark: {
    readonly timingBTDCDeg: number;
    readonly turbulenceSpeedMultiplier?: number;
  };
  readonly wallHeat:
    | { readonly mode: "adiabatic" }
    | { readonly mode: "woschni"; readonly wallTemperatureK: number };
  readonly friction?: {
    readonly aBar: number;
    readonly bBarPerBar: number;
    readonly cBarPerMPerS: number;
    readonly dBarPerM2S2: number;
    readonly pumpingMepBar: number;
  };
  readonly sweep?: {
    readonly kind: CombustionSweepKind;
    readonly from: number;
    readonly to: number;
    readonly steps: number;
  };
}

/** The combustion compile products, mode-locked (Phase 68c). */
export type CompiledSimCombustion =
  CompiledSimCombustionStove | CompiledSimCombustionEngine;

function isCombustionMode(input: unknown): input is CombustionMode {
  return (
    typeof input === "string" &&
    COMBUSTION_MODES.includes(input as CombustionMode)
  );
}

function isCombustionFuel(input: unknown): input is CombustionFuel {
  return (
    typeof input === "string" &&
    COMBUSTION_FUELS.includes(input as CombustionFuel)
  );
}

/**
 * Re-reads the combustion stance from the raw scenario record (the
 * `parseThermalStance` precedent — the record layer validated the same
 * fields; this door re-validates every field it consumes), converting
 * the engine mode's millimetres to SI and resolving the stove mode's
 * optional wall temperature against its initial field.
 */
type CombustionStanceWire =
  | Omit<CompiledSimCombustionStove, "materials" | "materialIndex">
  | CompiledSimCombustionEngine;

function parseCombustionStance(
  scenario: Record<string, unknown>,
): SimParseResult<CombustionStanceWire, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  const positive = (
    value: unknown,
    what: string,
    max?: number,
  ): SimParseResult<number, SimError> =>
    typeof value === "number" && Number.isFinite(value) && value > 0
      ? max === undefined || value <= max
        ? simOk(value)
        : refuse(
            `A combustion stance's ${what} must be at most ${String(max)}.`,
            value,
          )
      : refuse(
          `A combustion stance's ${what} must be a positive finite number.`,
          value,
        );
  const stance = scenario.combustion;
  if (!isPlainRecord(stance)) {
    return refuse(
      "A combustion scenario must carry its combustion solve stance (the stove fire or the 0D engine cycle) — the compile door refuses to guess physics.",
      stance,
    );
  }
  if (!isCombustionMode(stance.mode)) {
    return refuse(
      `A combustion stance's mode must be one of ${COMBUSTION_MODES.join(", ")}.`,
      stance.mode,
    );
  }
  if (!isCombustionFuel(stance.fuel)) {
    return refuse(
      `A combustion stance's fuel must be one of ${COMBUSTION_FUELS.join(", ")}.`,
      stance.fuel,
    );
  }
  if (stance.mode === "stove") {
    const equivalenceRatio = positive(
      stance.equivalenceRatio,
      "equivalence ratio",
      COMBUSTION_MAX_EQUIVALENCE_RATIO,
    );
    if (!equivalenceRatio.ok) return equivalenceRatio;
    const chargeTemperatureK = positive(
      stance.chargeTemperatureK,
      "charge temperature",
    );
    if (!chargeTemperatureK.ok) return chargeTemperatureK;
    const chargePressureBar = positive(
      stance.chargePressureBar,
      "charge pressure",
    );
    if (!chargePressureBar.ok) return chargePressureBar;
    const wallConvectionWPerM2K = positive(
      stance.wallConvectionWPerM2K,
      "wall convection coefficient",
    );
    if (!wallConvectionWPerM2K.ok) return wallConvectionWPerM2K;
    if (!isThermalRadiationMode(stance.radiationMode)) {
      return refuse(
        `A stove stance's radiation mode must be one of ${THERMAL_RADIATION_MODES.join(", ")}.`,
        stance.radiationMode,
      );
    }
    const initialTemperatureK = positive(
      stance.initialTemperatureK,
      "initial temperature",
    );
    if (!initialTemperatureK.ok) return initialTemperatureK;
    if (
      typeof stance.ambientConvectionWPerM2K !== "number" ||
      !Number.isFinite(stance.ambientConvectionWPerM2K) ||
      stance.ambientConvectionWPerM2K < 0
    ) {
      return refuse(
        "A stove stance's ambient convection coefficient must be a finite number ≥ 0 W/(m²·K).",
        stance.ambientConvectionWPerM2K,
      );
    }
    const durationS = positive(stance.durationS, "duration");
    if (!durationS.ok) return durationS;
    const sampleIntervalS = positive(stance.sampleIntervalS, "sample interval");
    if (!sampleIntervalS.ok) return sampleIntervalS;
    const sampleCount = Math.round(durationS.value / sampleIntervalS.value);
    if (
      sampleCount < 1 ||
      Math.abs(sampleCount * sampleIntervalS.value - durationS.value) >
        1e-9 * durationS.value
    ) {
      return refuse(
        "A stove stance's duration must be an integer multiple of its sample interval so every sample lands on the cadence.",
        { durationS: durationS.value, sampleIntervalS: sampleIntervalS.value },
      );
    }
    let wallTemperatureK = initialTemperatureK.value;
    if (
      stance.wallTemperatureK !== undefined &&
      stance.wallTemperatureK !== null
    ) {
      const parsed = positive(stance.wallTemperatureK, "wall temperature");
      if (!parsed.ok) return parsed;
      wallTemperatureK = parsed.value;
    }
    return simOk({
      mode: "stove",
      fuel: stance.fuel,
      equivalenceRatio: equivalenceRatio.value,
      chargeTemperatureK: chargeTemperatureK.value,
      chargePressureBar: chargePressureBar.value,
      wallConvectionWPerM2K: wallConvectionWPerM2K.value,
      wallTemperatureK,
      radiationMode: stance.radiationMode,
      initialTemperatureK: initialTemperatureK.value,
      ambientConvectionWPerM2K: stance.ambientConvectionWPerM2K,
      durationS: durationS.value,
      sampleIntervalS: sampleIntervalS.value,
    });
  }
  // The engine mode.
  if (!(COMBUSTION_ENGINE_FUELS as readonly string[]).includes(stance.fuel)) {
    return refuse(
      `An engine stance's fuel must be one of ${COMBUSTION_ENGINE_FUELS.join(", ")} (the fuels with a published laminar flame-speed fit).`,
      stance.fuel,
    );
  }
  const geometry = stance.geometry;
  if (!isPlainRecord(geometry)) {
    return refuse(
      "An engine stance must carry its slider-crank geometry (bore, crank radius, rod, compression ratio) in millimetres.",
      geometry,
    );
  }
  const boreMm = positive(geometry.boreMm, "bore");
  if (!boreMm.ok) return boreMm;
  const crankRadiusMm = positive(geometry.crankRadiusMm, "crank radius");
  if (!crankRadiusMm.ok) return crankRadiusMm;
  const rodLengthMm = positive(geometry.rodLengthMm, "rod length");
  if (!rodLengthMm.ok) return rodLengthMm;
  if (rodLengthMm.value <= crankRadiusMm.value) {
    return refuse(
      "An engine stance's rod must be longer than its crank radius — the linkage's assembly condition l > r.",
      { rodLengthMm: rodLengthMm.value, crankRadiusMm: crankRadiusMm.value },
    );
  }
  const compressionRatio = positive(
    geometry.compressionRatio,
    "compression ratio",
  );
  if (!compressionRatio.ok) return compressionRatio;
  if (compressionRatio.value <= 1) {
    return refuse(
      "An engine stance's compression ratio must exceed 1.",
      geometry.compressionRatio,
    );
  }
  const speedRpm = positive(stance.speedRpm, "speed");
  if (!speedRpm.ok) return speedRpm;
  const charge = stance.charge;
  if (!isPlainRecord(charge)) {
    return refuse(
      "An engine stance must carry its trapped charge (intake pressure, intake temperature, equivalence ratio).",
      charge,
    );
  }
  const intakePressureBar = positive(
    charge.intakePressureBar,
    "intake pressure",
  );
  if (!intakePressureBar.ok) return intakePressureBar;
  const intakeTK = positive(charge.intakeTK, "intake temperature");
  if (!intakeTK.ok) return intakeTK;
  const equivalenceRatio = positive(
    charge.equivalenceRatio,
    "equivalence ratio",
    COMBUSTION_MAX_EQUIVALENCE_RATIO,
  );
  if (!equivalenceRatio.ok) return equivalenceRatio;
  const spark = stance.spark;
  if (!isPlainRecord(spark)) {
    return refuse(
      "An engine stance must carry its spark timing (degrees before compression TDC).",
      spark,
    );
  }
  const timingBTDCDeg = spark.timingBTDCDeg;
  if (
    typeof timingBTDCDeg !== "number" ||
    !Number.isFinite(timingBTDCDeg) ||
    timingBTDCDeg <= 0 ||
    timingBTDCDeg >= 178
  ) {
    return refuse(
      "An engine stance's spark timing must lie strictly inside the compression stroke (0–178° before TDC).",
      timingBTDCDeg,
    );
  }
  let turbulenceSpeedMultiplier: number | undefined;
  if (
    spark.turbulenceSpeedMultiplier !== undefined &&
    spark.turbulenceSpeedMultiplier !== null
  ) {
    const parsed = positive(
      spark.turbulenceSpeedMultiplier,
      "turbulence flame-speed multiplier",
    );
    if (!parsed.ok) return parsed;
    turbulenceSpeedMultiplier = parsed.value;
  }
  const wallHeat = stance.wallHeat;
  let compiledWallHeat:
    | { readonly mode: "adiabatic" }
    | { readonly mode: "woschni"; readonly wallTemperatureK: number };
  if (isPlainRecord(wallHeat) && wallHeat.mode === "woschni") {
    const wallTemperatureK = positive(
      wallHeat.wallTemperatureK,
      "Woschni wall temperature",
    );
    if (!wallTemperatureK.ok) return wallTemperatureK;
    compiledWallHeat = {
      mode: "woschni",
      wallTemperatureK: wallTemperatureK.value,
    };
  } else if (isPlainRecord(wallHeat) && wallHeat.mode === "adiabatic") {
    compiledWallHeat = { mode: "adiabatic" };
  } else {
    return refuse(
      'An engine stance must carry its wall-heat boundary (mode "adiabatic" or "woschni").',
      wallHeat,
    );
  }
  let friction: CompiledSimCombustionEngine["friction"];
  if (
    stance.friction !== undefined &&
    stance.friction !== null &&
    isPlainRecord(stance.friction)
  ) {
    const nonNegativeFinite = (value: unknown): number | null => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return null;
      }
      return value;
    };
    const aBar = nonNegativeFinite(stance.friction.aBar);
    if (aBar === null) {
      return refuse(
        "A friction field's a must be a non-negative finite number.",
        stance.friction.aBar,
      );
    }
    const bBarPerBar = nonNegativeFinite(stance.friction.bBarPerBar);
    if (bBarPerBar === null) {
      return refuse(
        "A friction field's b must be a non-negative finite number.",
        stance.friction.bBarPerBar,
      );
    }
    const cBarPerMPerS = nonNegativeFinite(stance.friction.cBarPerMPerS);
    if (cBarPerMPerS === null) {
      return refuse(
        "A friction field's c must be a non-negative finite number.",
        stance.friction.cBarPerMPerS,
      );
    }
    const dBarPerM2S2 = nonNegativeFinite(stance.friction.dBarPerM2S2);
    if (dBarPerM2S2 === null) {
      return refuse(
        "A friction field's d must be a non-negative finite number.",
        stance.friction.dBarPerM2S2,
      );
    }
    const pumpingMepBar = nonNegativeFinite(stance.friction.pumpingMepBar);
    if (pumpingMepBar === null) {
      return refuse(
        "A friction field's pumping MEP must be a non-negative finite number.",
        stance.friction.pumpingMepBar,
      );
    }
    friction = {
      aBar,
      bBarPerBar,
      cBarPerMPerS,
      dBarPerM2S2,
      pumpingMepBar,
    };
  }
  let sweep: CompiledSimCombustionEngine["sweep"];
  if (stance.sweep !== undefined && stance.sweep !== null) {
    if (!isPlainRecord(stance.sweep)) {
      return refuse(
        "An engine stance's sweep must be an object (kind, from, to, steps).",
        stance.sweep,
      );
    }
    if (
      typeof stance.sweep.kind !== "string" ||
      !COMBUSTION_SWEEP_KINDS.includes(stance.sweep.kind as CombustionSweepKind)
    ) {
      return refuse(
        `An engine stance's sweep kind must be one of ${COMBUSTION_SWEEP_KINDS.join(", ")}.`,
        stance.sweep.kind,
      );
    }
    const from = stance.sweep.from;
    const to = stance.sweep.to;
    if (
      typeof from !== "number" ||
      !Number.isFinite(from) ||
      typeof to !== "number" ||
      !Number.isFinite(to)
    ) {
      return refuse("A sweep's from and to values must be finite numbers.", {
        from,
        to,
      });
    }
    const steps = stance.sweep.steps;
    if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1) {
      return refuse(
        "A sweep needs at least 1 interval (a positive integer step count).",
        steps,
      );
    }
    sweep = {
      kind: stance.sweep.kind as CombustionSweepKind,
      from,
      to,
      steps,
    };
  }
  return simOk({
    mode: "engine",
    fuel: stance.fuel as Exclude<CombustionFuel, "CH4">,
    geometry: {
      boreM: boreMm.value / MM_PER_M,
      crankRadiusM: crankRadiusMm.value / MM_PER_M,
      rodLengthM: rodLengthMm.value / MM_PER_M,
      compressionRatio: compressionRatio.value,
    },
    speedRpm: speedRpm.value,
    charge: {
      intakePressureBar: intakePressureBar.value,
      intakeTK: intakeTK.value,
      equivalenceRatio: equivalenceRatio.value,
    },
    spark: {
      timingBTDCDeg,
      ...(turbulenceSpeedMultiplier === undefined
        ? {}
        : { turbulenceSpeedMultiplier }),
    },
    wallHeat: compiledWallHeat,
    ...(friction === undefined ? {} : { friction }),
    ...(sweep === undefined ? {} : { sweep }),
  });
}

/**
 * The combustion compile branch (Phase 68c): the mode-locked stance
 * re-validated at this door; the STOVE mode voxelizes the SAME
 * per-body material map the thermal branch builds (the 65-family
 * solve) beside its occupancy slice, and the ENGINE mode converts the
 * authored slider-crank millimetres to SI with NO voxelization (the 0D
 * chamber has no spatial domain).
 */
function compileCombustionProducts(
  scenario: Record<string, unknown>,
  input: GeometrySimCompileInput,
  bodyBounds: readonly SimBodyBoundsMm[],
): SimParseResult<
  Pick<CompiledSimScenario, "occupancySlice" | "combustion">,
  SimError
> {
  const stance = parseCombustionStance(scenario);
  if (!stance.ok) return stance;
  if (stance.value.mode === "engine") {
    return simOk({ combustion: stance.value });
  }
  const solid = voxelizeSolidMaterialMap(scenario, input, bodyBounds);
  if (!solid.ok) return solid;
  return simOk({
    occupancySlice: solid.value.occupancySlice,
    combustion: {
      ...stance.value,
      materials: solid.value.materials,
      materialIndex: solid.value.materialIndex,
    },
  });
}

/**
 * Compiles a serialized scenario into solver space WITH its geometry
 * (Phase 63c, extended 65c): the 61a {@link compileSimScenario} plus,
 * for flow scenarios that carry a tessellation, the voxelized occupancy
 * slice at the domain's mid-height plane (and its factor-2 refined twin
 * when the grid-convergence flag is set), plus the flow-run controls
 * read from the record. Thermal scenarios that carry per-body
 * tessellations and material records compile their thermal products
 * (`compileThermalProducts`): the union occupancy slice at the SAME
 * mid-height plane plus the per-cell material map and the re-validated
 * solve stance, attached as `thermal`. Anything else compiles exactly
 * as the 61a door compiles it (the engine declines a geometry-less run
 * loudly; the structural decline stays the 61a door's own).
 */
export function compileSimScenarioWithGeometry(
  input: GeometrySimCompileInput,
): SimParseResult<CompiledSimScenario, SimError> {
  const compiled = compileSimScenario({
    scenario: input.scenario,
    ...(input.motor === undefined ? {} : { motor: input.motor }),
    ...(input.bodyBounds === undefined ? {} : { bodyBounds: input.bodyBounds }),
  });
  if (!compiled.ok) return compiled;
  if (!isPlainRecord(input.scenario)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "A scenario must be a plain serialized scenario object.",
        input.scenario,
      ),
    );
  }
  if (compiled.value.kind === "dynamics") {
    // The dynamics branch (Phase 67c): the mechanism wire is the
    // document's own resolved state (occurrences, joint records, mass
    // properties), re-validated structurally here and converted by the
    // 67 dynamics door — the thermal door's record discipline. No
    // voxelization: the mechanism IS the geometry.
    const dynamics = compileDynamicsProducts(input);
    if (!dynamics.ok) return dynamics;
    return simOk({ ...compiled.value, ...dynamics.value });
  }
  if (compiled.value.kind === "combustion") {
    // The combustion branch (Phase 68c): the mode-locked stance with
    // the stove mode's per-body material map (the 65-family voxelization)
    // or the engine mode's SI chamber geometry (no voxelization — the 0D
    // chamber has no spatial domain).
    const combustion = compileCombustionProducts(
      input.scenario,
      input,
      input.bodyBounds ?? [],
    );
    if (!combustion.ok) return combustion;
    return simOk({ ...compiled.value, ...combustion.value });
  }
  if (compiled.value.kind === "thermal") {
    // The 3D stance is the flow kind's alone: a thermal record carrying
    // one declines here (the record boundary locked it first; this door
    // re-checks every field it consumes — never a silently dropped
    // stance).
    if (input.scenario.flow3d !== undefined && input.scenario.flow3d !== null) {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          'A "thermal" scenario cannot carry a 3D flow stance; it is the flow kind\'s alone.',
          input.scenario.flow3d,
        ),
      );
    }
    if (input.bodyTessellations === undefined) {
      return simOk(compiled.value);
    }
    const thermal = compileThermalProducts(
      input.scenario,
      input,
      input.bodyBounds ?? [],
    );
    if (!thermal.ok) return thermal;
    return simOk({ ...compiled.value, ...thermal.value });
  }
  if (compiled.value.kind !== "flow" || input.tessellation === undefined) {
    return simOk(compiled.value);
  }
  // The 3D fork (Phase 66c): a flow scenario carrying a 3D stance
  // compiles the FULL-3D occupancy grid and its rotation products
  // instead of the 2D slice — the record vocabulary's honest fork the
  // engines route on (each engine declines the other's scenarios
  // loudly, never a silent misroute).
  if (input.scenario.flow3d !== undefined && input.scenario.flow3d !== null) {
    const flow3d = compileFlow3dProducts(
      input.scenario,
      input,
      input.bodyBounds ?? [],
    );
    if (!flow3d.ok) return flow3d;
    return simOk({ ...compiled.value, ...flow3d.value });
  }
  const domain = resolveDomainMm(input.scenario, input.bodyBounds ?? []);
  if (!domain.ok) return domain;
  const [minMm, maxMm, resolutionMm] = domain.value;
  // The deterministic slice plane: perpendicular to the domain's third
  // axis, at its mid-height — the plane the Phase 62 fixture renders and
  // the 2D wind tunnel inherits.
  const planeCoordinateMm = ((minMm[2] ?? 0) + (maxMm[2] ?? 0)) / 2;
  const sliceDomain = {
    kind: "explicit" as const,
    minMm,
    maxMm,
    resolutionMm,
  };
  const slice = voxelizeSimTessellationSlice({
    tessellation: input.tessellation,
    domain: sliceDomain,
    plane: { axis: "z" as const, coordinateMm: planeCoordinateMm },
    name: OCCUPANCY_SLICE_NAME,
  });
  if (!slice.ok) return slice;
  const run = compileRunControls(input.scenario);
  if (!run.ok) return run;
  if (!run.value.gridConvergence) {
    return simOk({
      ...compiled.value,
      occupancySlice: slice.value,
      run: run.value,
    });
  }
  // The refined rung's lattice contract (the 63b drift consumer's own):
  // EXACTLY twice the coarse node count per axis, so coarse node (x, y)
  // coincides with refined node (2x, 2y). The node-centered floor rule
  // at half the resolution gives 2n − 1 nodes over the same bounds, so
  // the refined domain's max corner extends to min + (n − ¼)·h — the
  // one deterministic window that yields exactly 2n nodes — and the
  // classification runs against the real tessellation over the covered
  // span (the half-coarse-cell fringe the ladder's own shape demands).
  const refinedMaxMm: [number, number, number] = [
    minMm[0] ?? 0,
    minMm[1] ?? 0,
    maxMm[2] ?? 0,
  ];
  const refinedShape = slice.value.shape;
  for (const axis of [0, 1] as const) {
    const nodes = refinedShape[axis] ?? 1;
    refinedMaxMm[axis] = (minMm[axis] ?? 0) + (nodes - 0.25) * resolutionMm;
  }
  const refined = voxelizeSimTessellationSlice({
    tessellation: input.tessellation,
    domain: {
      ...sliceDomain,
      maxMm: refinedMaxMm,
      resolutionMm: resolutionMm / 2,
    },
    plane: { axis: "z" as const, coordinateMm: planeCoordinateMm },
    name: OCCUPANCY_SLICE_NAME,
  });
  if (!refined.ok) return refined;
  return simOk({
    ...compiled.value,
    occupancySlice: slice.value,
    occupancySliceRefined: refined.value,
    run: run.value,
  });
}
