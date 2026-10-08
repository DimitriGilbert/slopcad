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

/**
 * Compiles a serialized scenario into solver space WITH its geometry
 * (Phase 63c): the 61a {@link compileSimScenario} plus, for flow
 * scenarios that carry a tessellation, the voxelized occupancy slice at
 * the domain's mid-height plane (and its factor-2 refined twin when the
 * grid-convergence flag is set), plus the flow-run controls read from
 * the record. Thermal and structural scenarios compile exactly as the
 * 61a door compiles them (the fake engine's contract surface; the
 * structural decline stays the 61a door's own).
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
  if (compiled.value.kind !== "flow" || input.tessellation === undefined) {
    return simOk(compiled.value);
  }
  if (!isPlainRecord(input.scenario)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "A scenario must be a plain serialized scenario object.",
        input.scenario,
      ),
    );
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
