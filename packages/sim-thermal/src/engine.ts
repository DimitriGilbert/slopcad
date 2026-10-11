/**
 * The real thermal engine behind the Phase 61 `SimEngine` contract
 * (Phase 65c, the sim-flow `./engine` precedent): the adapter that
 * turns one COMPILED thermal scenario into a conduction run. One `run`
 * call:
 *
 * 1. **Consumes the compiled problem** — the 65c geometry-aware
 *    compile's products: the occupancy slice (the voxelized solids at
 *    the domain's mid-height plane) becomes the UNIT-DEPTH SLAB grid
 *    `[nx, ny, 1]` with spacing `[h, h, 1]` — every joule, watt and
 *    capacity is PER METRE OF DEPTH, the exact convention the 65b
 *    coupled march uses, so a sealed run and its coupled twin speak the
 *    same units. The compiled per-cell material map indexes materials
 *    re-validated through this package's own material door
 *    (`./material`), and the compiled boundary conditions become the
 *    65a face conditions (the thermal set on the four lateral faces;
 *    the slab's front and back are the 2D statement's adiabatic z
 *    faces).
 * 2. **Runs the 65a driver** — `runThermalScenario` verbatim (steady
 *    Picard/solve or the implicit transient march per the compiled
 *    stance), then `thermalRunSimResult` for the finalized
 *    `SimResult`: the S9 regime the compile boundary computed (Pr
 *    always, Ra under the ΔT rule), the scenario-snapshot hash, the
 *    temperature extremes, the energy-ledger facts (source, convection
 *    and radiation losses, the measured imbalance), and the
 *    temperature field as the 62-overlay block.
 * 3. **Emits** — one macrotask yield (the cooperative cancellation
 *    window the contract documents), a progress hop at each stage, and
 *    ONE final preview round: the projected temperature block split
 *    into protocol chunks, bitwise the block the finalized result
 *    carries (the fake engine's last-round discipline). The 65a/65b
 *    drivers are whole-run APIs — consumed, never reworked (the phase
 *    rule) — so the streaming cadence is one committed round per run,
 *    stated here honestly rather than faked per-step.
 *
 * The CONJUGATE stance (the `cht` flag) is NOT this engine's: the
 * coupled march lives with the flow kernel it advances in lockstep
 * with (`@slopcad/sim-flow`'s CHT engine, behind the same routed
 * default engine that routes this one). A direct call with the flag
 * declines loudly — the sealed solve never silently downgrades a
 * coupled scenario (the CPU engine's gpu-preference decline
 * precedent).
 *
 * Determinism is the whole stance (law S2): no clock reads, no
 * randomness, a fixed emission schedule — the same compiled problem
 * produces the bitwise-identical result and notification stream every
 * time.
 */

import {
  type CompiledSimThermal,
  type SimDomainFace,
  type SimEngine,
  type SimEngineFieldChunk,
  type SimEngineProgress,
  type SimEngineRequest,
  type SimError,
  SIM_ERROR_CODES,
  type SimErrorCode,
  type SimOccupancyGrid,
  type SimParseResult,
  type SimResult,
  type SimResultFieldBlock,
  type SimScenarioKind,
  type SolverSimField,
  projectSimResult,
  simError,
  simFail,
  simOk,
  splitSimFieldBlock,
} from "@slopcad/sim-core";
import type { ThermalFaceConditionEntry } from "./boundaries";
import type { ThermalSteadySpec } from "./steady";
import type { ThermalTransientSpec } from "./transient";
import type { ThermalRunReport } from "./run";
import type { ThermalSolidMaterial } from "./material";

import { thermalSolidMaterialFromRecord } from "./material";
import { runThermalScenario, thermalRunSimResult } from "./run";

/** The conduction engine's stable id (the worker host's routing key). */
export const THERMAL_SIM_ENGINE_ID = "thermal-fvm-cpu-reference";

/** The scenario kinds this engine solves. */
export const THERMAL_SUPPORTED_KINDS: readonly SimScenarioKind[] = ["thermal"];

/**
 * The values-per-chunk ceiling a preview round splits its block into —
 * the flow engine's framing knob (`LBM_PREVIEW_CHUNK_MAX_VALUES`),
 * restated so both thermal engines frame identically.
 */
export const THERMAL_PREVIEW_CHUNK_MAX_VALUES = 16384;

const refuse = (
  code: SimErrorCode,
  message: string,
  at: unknown,
): SimParseResult<never, SimError> => simFail(simError(code, message, at));

/** One macrotask turn — the cooperative cancellation window. */
function yieldOnce(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** The lateral faces the unit-depth slab consumes. */
const LATERAL_FACES: readonly SimDomainFace[] = [
  "xMin",
  "xMax",
  "yMin",
  "yMax",
];

/**
 * Maps the compiled conditions onto the 65a face-condition entries:
 * the thermal set (fixed-temperature, heat-flux, convection-ambient)
 * rides the four lateral faces verbatim; a condition on the slab's
 * front/back (zMin/zMax) is outside the 2D statement and declines; the
 * flow vocabulary (inlets, outlets, walls, symmetry — the coupled
 * march's set) declines here, naming the coupled engine that consumes
 * it.
 */
function thermalFaceConditions(
  request: SimEngineRequest,
): SimParseResult<readonly ThermalFaceConditionEntry[], SimError> {
  const entries: ThermalFaceConditionEntry[] = [];
  for (const condition of request.compiled.conditions) {
    if (condition.face === "zMin" || condition.face === "zMax") {
      return refuse(
        SIM_ERROR_CODES.scenarioInvalid,
        `A condition on the "${condition.face}" face is outside the thermal slab's 2D statement — the slab consumes the four lateral faces, its front and back are the per-metre depth's adiabatic planes.`,
        condition,
      );
    }
    if (!LATERAL_FACES.includes(condition.face)) {
      return refuse(
        SIM_ERROR_CODES.scenarioInvalid,
        `A thermal condition must address a lateral face of the slice.`,
        condition,
      );
    }
    switch (condition.kind) {
      case "fixed-temperature":
        if (condition.temperatureK === undefined) {
          return refuse(
            SIM_ERROR_CODES.scenarioInvalid,
            "A compiled fixed-temperature condition carried no temperature.",
            condition,
          );
        }
        entries.push({
          kind: "fixed-temperature",
          face: condition.face,
          temperatureK: condition.temperatureK,
        });
        break;
      case "heat-flux":
        if (condition.fluxWPerM2 === undefined) {
          return refuse(
            SIM_ERROR_CODES.scenarioInvalid,
            "A compiled heat-flux condition carried no flux.",
            condition,
          );
        }
        entries.push({
          kind: "heat-flux",
          face: condition.face,
          fluxWPerM2: condition.fluxWPerM2,
        });
        break;
      case "convection-ambient":
        if (
          condition.heatTransferCoefficientWPerM2K === undefined ||
          condition.ambientTemperatureK === undefined
        ) {
          return refuse(
            SIM_ERROR_CODES.scenarioInvalid,
            "A compiled convection-ambient condition carried no coefficient or ambient temperature.",
            condition,
          );
        }
        entries.push({
          kind: "convection-ambient",
          face: condition.face,
          heatTransferCoefficientWPerM2K:
            condition.heatTransferCoefficientWPerM2K,
          ambientTemperatureK: condition.ambientTemperatureK,
          ...(condition.emissivity === undefined
            ? {}
            : { emissivity: condition.emissivity }),
        });
        break;
      default:
        return refuse(
          SIM_ERROR_CODES.scenarioInvalid,
          `A "${condition.kind}" condition is the coupled march's vocabulary (the flow side of conjugate heat transfer); the sealed conduction solve consumes fixed-temperature, heat-flux, and convection-ambient — save the scenario with the coupled stance for the march that consumes it.`,
          condition,
        );
    }
  }
  return simOk(entries);
}

/** The unit-depth slab form of the compiled occupancy slice (the 65b convention). */
function slabGridOf(slice: SimOccupancyGrid, name: string): SimOccupancyGrid {
  return {
    semantic: "occupancy",
    name,
    shape: [slice.shape[0] ?? 1, slice.shape[1] ?? 1, 1],
    originM: [
      slice.originM[0] ?? 0,
      slice.originM[1] ?? 0,
      slice.originM[2] ?? 0,
    ],
    spacingM: [slice.spacingM[0] ?? 1, slice.spacingM[1] ?? 1, 1],
    cells: slice.cells,
  };
}

/** Parses the compiled material records through this package's own door. */
function thermalMaterialsOf(
  thermal: CompiledSimThermal,
): SimParseResult<readonly ThermalSolidMaterial[], SimError> {
  const materials: ThermalSolidMaterial[] = [];
  for (const entry of thermal.materials) {
    const parsed = thermalSolidMaterialFromRecord(entry.record);
    if (!parsed.ok) return parsed;
    materials.push(parsed.value);
  }
  if (materials.length === 0) {
    return refuse(
      SIM_ERROR_CODES.scenarioInvalid,
      "A thermal run needs at least one resolved material record.",
      thermal.materials,
    );
  }
  return simOk(materials);
}

/** Publishes one preview round: the document-space temperature block, chunked. */
export function thermalPublishPreview(
  fields: readonly SolverSimField[],
  onFieldChunk: (chunk: SimEngineFieldChunk) => void,
): void {
  const temperature = fields.find((field) => field.id === "temperature");
  if (temperature === undefined) return;
  const projected = projectSimResult({ scalars: [], fields: [temperature] });
  if (!projected.ok) return;
  const block: SimResultFieldBlock | undefined = projected.value.fields[0];
  if (block === undefined) return;
  const chunkCount = Math.max(
    1,
    Math.ceil(block.values.length / THERMAL_PREVIEW_CHUNK_MAX_VALUES),
  );
  for (const chunk of splitSimFieldBlock(block, chunkCount)) {
    onFieldChunk(chunk);
  }
}

async function runThermalEngine(
  request: SimEngineRequest,
  onProgress?: (progress: SimEngineProgress) => void,
  onFieldChunk?: (chunk: SimEngineFieldChunk) => void,
): Promise<SimParseResult<SimResult, SimError>> {
  const compiled = request.compiled;
  if (!THERMAL_SUPPORTED_KINDS.includes(compiled.kind)) {
    return refuse(
      SIM_ERROR_CODES.scenarioKindUnsupported,
      `The conduction thermal engine does not solve the "${compiled.kind}" scenario kind (it solves thermal; structural is Phase 69's carve).`,
      compiled.kind,
    );
  }
  if (compiled.backend === "gpu") {
    return refuse(
      SIM_ERROR_CODES.backendUnavailable,
      'The scenario prefers the "gpu" backend, but the thermal domain ships the CPU reference kernel only — there is no GPU provider to route to, and the engine declines the preference loudly instead of silently ignoring it.',
      compiled.backend,
    );
  }
  const slice = compiled.occupancySlice;
  const thermal = compiled.thermal;
  if (slice === undefined || thermal === undefined) {
    return refuse(
      SIM_ERROR_CODES.geometryUnavailable,
      "A thermal run needs the compile's voxelized solids and material map: compile with the bodies' tessellations and the material records (the geometry-aware compile door), and this engine refuses to fabricate an empty solid.",
      compiled.name,
    );
  }
  if (thermal.cht) {
    return refuse(
      SIM_ERROR_CODES.scenarioInvalid,
      "The scenario requests the conjugate coupled march (the buoyant plume), which lives with the flow kernel it advances in lockstep with — the routed default engine serves it; this sealed conduction engine declines the coupled stance instead of silently downgrading it.",
      { scenario: compiled.name, cht: thermal.cht },
    );
  }
  let mode: ThermalSteadySpec | ThermalTransientSpec;
  if (thermal.solveMode === "steady") {
    mode = {
      kind: "steady",
      initialTemperatureK: thermal.initialTemperatureK,
    };
  } else {
    const durationS = thermal.durationS;
    const sampleIntervalS = thermal.sampleIntervalS;
    if (durationS === undefined || sampleIntervalS === undefined) {
      return refuse(
        SIM_ERROR_CODES.scenarioInvalid,
        "A transient thermal compile must carry its duration and sample interval; the engine declines a march with no budget instead of defaulting one.",
        thermal,
      );
    }
    mode = {
      kind: "transient",
      scheme: "implicit",
      durationS,
      sampleIntervalS,
      initialTemperatureK: thermal.initialTemperatureK,
    };
  }
  const conditions = thermalFaceConditions(request);
  if (!conditions.ok) return conditions;
  const materials = thermalMaterialsOf(thermal);
  if (!materials.ok) return materials;

  // The uniform source: the authored watts distributed over every solid
  // cell of the per-metre slab (W/m³ = W / (cellArea × 1 m × cellCount)).
  const slab = slabGridOf(slice, `${compiled.name}-thermal-slab`);
  const cellCount = slab.shape[0] * slab.shape[1];
  let solidCount = 0;
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (slab.cells[cell] === 1) solidCount += 1;
  }
  if (solidCount === 0) {
    return refuse(
      SIM_ERROR_CODES.geometryUnavailable,
      "The compiled solids voxelized to an empty slab — there is nothing to conduct, and the engine declines instead of solving an empty domain.",
      slice,
    );
  }
  const cellAreaM2 = (slab.spacingM[0] ?? 1) * (slab.spacingM[1] ?? 1);
  const sourceWPerM3 = new Float64Array(cellCount);
  const perCellWPerM3 = thermal.sourceW / (cellAreaM2 * solidCount);
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (slab.cells[cell] === 1) sourceWPerM3[cell] = perCellWPerM3;
  }

  onProgress?.({ step: 0, totalSteps: 1 });
  await yieldOnce();
  const report: SimParseResult<ThermalRunReport, SimError> = runThermalScenario(
    {
      name: compiled.name,
      grid: slab,
      materials: materials.value,
      cellMaterialIndex: thermal.materialIndex,
      fluid: compiled.fluid,
      conditions: conditions.value,
      ambient: {
        heatTransferCoefficientWPerM2K: thermal.ambientConvectionWPerM2K,
        ambientTemperatureK: thermal.initialTemperatureK,
      },
      radiationMode: thermal.radiationMode,
      sourceWPerM3,
      gravityMPerS2: compiled.gravityMPerS2,
      characteristicLengthM: compiled.characteristicLengthM,
      mode,
      scenarioSnapshotHash: compiled.scenarioSnapshotHash,
      regime: compiled.regime,
    },
  );
  if (!report.ok) return report;
  onProgress?.({ step: 1, totalSteps: 1 });
  if (onFieldChunk !== undefined && report.value.temperatureField !== null) {
    thermalPublishPreview([report.value.temperatureField], onFieldChunk);
  }
  return thermalRunSimResult(report.value);
}

/** The deterministic conduction thermal engine (law S2's CPU oracle adapter). */
export function createThermalSimEngine(): SimEngine {
  return {
    id: THERMAL_SIM_ENGINE_ID,
    supportedKinds: THERMAL_SUPPORTED_KINDS,
    backend: "cpu",
    run: (request, onProgress, onFieldChunk) =>
      runThermalEngine(request, onProgress, onFieldChunk),
  };
}
