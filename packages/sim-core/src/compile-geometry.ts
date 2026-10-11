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
  CompiledSimScenario,
  SimBodyBoundsMm,
  SimCompileInput,
} from "./units";

import { SIM_ERROR_CODES, simError } from "./errors";
import { simFail, simOk } from "./result";
import { voxelizeSimTessellationSlice } from "./voxelizer";
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

  const bodies = input.bodyTessellations ?? [];
  if (bodies.length === 0) {
    return refuse(
      "A thermal compile needs the referenced bodies' tessellations (one entry per body); the compile door refuses to fabricate an empty solid.",
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
        "A thermal compile's material records must be plain objects carrying a string id.",
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
        "A thermal compile's body tessellations must carry a string bodyId beside the tessellation.",
        body,
      );
    }
    const materialId = materialOfBody.get(body.bodyId);
    if (materialId === undefined) {
      return refuse(
        `The thermal scenario voxelizes body "${body.bodyId}" but assigns it no material; every solid the conduction solve sees must carry one, and the compile door declines instead of guessing.`,
        body.bodyId,
      );
    }
    let materialListIndex = indexByMaterialId.get(materialId);
    if (materialListIndex === undefined) {
      const record = recordsById.get(materialId);
      if (record === undefined) {
        return refuse(
          `The scenario assigns material "${materialId}" but no supplied material record carries that id; the thermal compile refuses a selection it cannot resolve.`,
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
          "The thermal compile's per-body slices disagree on their lattice shape; every body must voxelize over the SAME domain at the SAME resolution.",
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
      "A thermal compile needs at least one body tessellation.",
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
    thermal: { ...stance.value, materials, materialIndex },
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
  if (compiled.value.kind === "thermal") {
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
