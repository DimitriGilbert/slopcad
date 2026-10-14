/**
 * The real structural engine behind the Phase 61 `SimEngine` contract
 * (Phase 69b, the `@slopcad/sim-thermal` `./engine` precedent): the
 * adapter that turns one COMPILED structural scenario into a
 * linear-elastic static run. One `run` call:
 *
 * 1. **Consumes the compiled problem** — the 69b geometry-aware
 *    compile's products: the FULL-3D occupancy grid (one hexahedral
 *    element per occupied voxel node — the thermal cell-interpretation
 *    precedent on the 3D twin), the per-node material map indexing
 *    materials re-validated through this package's own material door
 *    (`./material`), the compiled boundary conditions mapped onto the
 *    69a door's entries (faces, rollers, and points), the body-force
 *    family (self-weight through the scenario's gravity vector gated by
 *    the stance's switch, the RESOLVED centrifugal stance, and the
 *    per-node ΔT field the compile sampled from a chained Phase 65
 *    run), and the scenario-snapshot hash.
 * 2. **Runs the 69a driver** — `runStructuralScenario` verbatim (the
 *    mesh, the condition resolution, the Jacobi-CG assembly and solve,
 *    the field recovery), then `structuralRunSimResult` for the
 *    finalized `SimResult`: the empty regime report (law S9's honest
 *    structural claim, the dynamics precedent), the max-deflection and
 *    von Mises scalars, the factor-of-safety family (yield-bearing
 *    materials only), and the displacement/von Mises fields as the
 *    62-overlay blocks.
 * 3. **Emits** — one macrotask yield (the cooperative cancellation
 *    window the contract documents), a progress hop per stage, and ONE
 *    final preview round per field: the projected von Mises block, then
 *    the displacement block (published LAST so the page's
 *    last-applied-wins live overlay deterministically names the
 *    displacement — the 62c paint), bitwise the blocks the finalized
 *    result carries (the thermal engine's last-round discipline; the
 *    69a driver is a whole-run API — consumed, never reworked).
 *
 * Determinism is the whole stance (law S2): no clock reads, no
 * randomness, a fixed emission schedule — the same compiled problem
 * produces the bitwise-identical result and notification stream every
 * time.
 */

import {
  type CompiledSimStructural,
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
import type { StructuralConditionEntry } from "./run";
import type { StructuralRunReport } from "./run";
import type { StructuralSolidMaterial } from "./material";

import { structuralSolidMaterialFromRecord } from "./material";
import { runStructuralScenario, structuralRunSimResult } from "./run";

/** The structural engine's stable id (the worker host's routing key). */
export const STRUCTURAL_SIM_ENGINE_ID = "structural-voxel-fem-cpu-reference";

/** The scenario kinds this engine solves. */
export const STRUCTURAL_SUPPORTED_KINDS: readonly SimScenarioKind[] = [
  "structural",
];

/**
 * The values-per-chunk ceiling a preview round splits its block into —
 * the flow engine's framing knob (`LBM_PREVIEW_CHUNK_MAX_VALUES`),
 * restated so the structural preview frames identically.
 */
export const STRUCTURAL_PREVIEW_CHUNK_MAX_VALUES = 16384;

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

/**
 * Maps the compiled conditions onto the 69a door's condition entries:
 * the structural set rides verbatim (the face family, the roller, the
 * points — the compile already converted the point millimetres to SI);
 * every other kind is another domain's vocabulary and declines loudly,
 * naming this engine's own set.
 */
function structuralConditions(
  request: SimEngineRequest,
): SimParseResult<readonly StructuralConditionEntry[], SimError> {
  const entries: StructuralConditionEntry[] = [];
  for (const condition of request.compiled.conditions) {
    switch (condition.kind) {
      case "fixed-support":
        if (condition.face === undefined) {
          return refuse(
            SIM_ERROR_CODES.scenarioInvalid,
            "A compiled fixed-support condition carried no face.",
            condition,
          );
        }
        entries.push({ kind: "fixed-support", face: condition.face });
        break;
      case "axis-fix":
        if (condition.face === undefined || condition.axis === undefined) {
          return refuse(
            SIM_ERROR_CODES.scenarioInvalid,
            "A compiled axis-fix condition carried no face or axis.",
            condition,
          );
        }
        entries.push({
          kind: "axis-fix",
          axis: condition.axis,
          face: condition.face,
        });
        break;
      case "point-fix": {
        const at = condition.atWorldPointM;
        if (at === undefined) {
          return refuse(
            SIM_ERROR_CODES.scenarioInvalid,
            "A compiled point-fix condition carried no application point.",
            condition,
          );
        }
        entries.push({ kind: "point-fix", atWorldPointM: at });
        break;
      }
      case "force-load":
        if (condition.face === undefined || condition.forceN === undefined) {
          return refuse(
            SIM_ERROR_CODES.scenarioInvalid,
            "A compiled force-load condition carried no face or force.",
            condition,
          );
        }
        entries.push({
          kind: "force-load",
          face: condition.face,
          forceN: condition.forceN,
        });
        break;
      case "pressure-load":
        if (
          condition.face === undefined ||
          condition.pressurePa === undefined
        ) {
          return refuse(
            SIM_ERROR_CODES.scenarioInvalid,
            "A compiled pressure-load condition carried no face or pressure.",
            condition,
          );
        }
        entries.push({
          kind: "pressure-load",
          face: condition.face,
          pressurePa: condition.pressurePa,
        });
        break;
      case "point-load": {
        const at = condition.atWorldPointM;
        if (at === undefined || condition.forceN === undefined) {
          return refuse(
            SIM_ERROR_CODES.scenarioInvalid,
            "A compiled point-load condition carried no application point or force.",
            condition,
          );
        }
        entries.push({
          kind: "point-load",
          atWorldPointM: at,
          forceN: condition.forceN,
        });
        break;
      }
      default:
        return refuse(
          SIM_ERROR_CODES.scenarioInvalid,
          `A "${condition.kind}" condition is another domain's vocabulary (the flow/thermal sets); the structural solve consumes fixed-support, axis-fix, point-fix, force-load, pressure-load, and point-load.`,
          condition,
        );
    }
  }
  return simOk(Object.freeze(entries));
}

/** Parses the compiled material records through this package's own door. */
function structuralMaterialsOf(
  structural: CompiledSimStructural,
): SimParseResult<readonly StructuralSolidMaterial[], SimError> {
  const materials: StructuralSolidMaterial[] = [];
  for (const entry of structural.materials) {
    const parsed = structuralSolidMaterialFromRecord(entry.record);
    if (!parsed.ok) return parsed;
    materials.push(parsed.value);
  }
  if (materials.length === 0) {
    return refuse(
      SIM_ERROR_CODES.scenarioInvalid,
      "A structural run needs at least one resolved material record.",
      structural.materials,
    );
  }
  return simOk(materials);
}

/** Publishes one preview round: a document-space block, chunked. */
function publishPreviewRound(
  field: SolverSimField,
  onFieldChunk: (chunk: SimEngineFieldChunk) => void,
): void {
  const projected = projectSimResult({ scalars: [], fields: [field] });
  if (!projected.ok) return;
  const block: SimResultFieldBlock | undefined = projected.value.fields[0];
  if (block === undefined) return;
  const chunkCount = Math.max(
    1,
    Math.ceil(block.values.length / STRUCTURAL_PREVIEW_CHUNK_MAX_VALUES),
  );
  for (const chunk of splitSimFieldBlock(block, chunkCount)) {
    onFieldChunk(chunk);
  }
}

async function runStructuralEngine(
  request: SimEngineRequest,
  onProgress?: (progress: SimEngineProgress) => void,
  onFieldChunk?: (chunk: SimEngineFieldChunk) => void,
): Promise<SimParseResult<SimResult, SimError>> {
  const compiled = request.compiled;
  if (!STRUCTURAL_SUPPORTED_KINDS.includes(compiled.kind)) {
    return refuse(
      SIM_ERROR_CODES.scenarioKindUnsupported,
      `The structural engine does not solve the "${compiled.kind}" scenario kind (it solves structural alone — the coarse voxel FEM domain).`,
      compiled.kind,
    );
  }
  if (compiled.backend === "gpu") {
    return refuse(
      SIM_ERROR_CODES.backendUnavailable,
      'The scenario prefers the "gpu" backend, but the structural domain ships the CPU reference kernel only (the §9 MFEM note is the raised fidelity path, not a GPU provider) — the engine declines the preference loudly instead of silently ignoring it.',
      compiled.backend,
    );
  }
  const grid: SimOccupancyGrid | undefined = compiled.occupancy3d;
  const structural: CompiledSimStructural | undefined = compiled.structural;
  if (grid === undefined || structural === undefined) {
    return refuse(
      SIM_ERROR_CODES.geometryUnavailable,
      "A structural run needs the compile's voxelized body and material map: compile with the bodies' tessellations and the material records (the geometry-aware compile door), and this engine refuses to fabricate a structure.",
      compiled.name,
    );
  }
  const conditions = structuralConditions(request);
  if (!conditions.ok) return conditions;
  const materials = structuralMaterialsOf(structural);
  if (!materials.ok) return materials;

  // The body-force family: self-weight rides the scenario's compiled
  // gravity vector gated by the stance's switch (off = the zero vector,
  // the 69a door's documented disabling convention).
  const gravityMPerS2: readonly [number, number, number] = structural.selfWeight
    ? [
        compiled.gravityMPerS2[0] ?? 0,
        compiled.gravityMPerS2[1] ?? 0,
        compiled.gravityMPerS2[2] ?? 0,
      ]
    : [0, 0, 0];

  onProgress?.({ step: 0, totalSteps: 1 });
  await yieldOnce();
  const report: SimParseResult<StructuralRunReport, SimError> =
    runStructuralScenario({
      name: compiled.name,
      grid,
      materials: materials.value,
      cellMaterialIndex: structural.materialIndex,
      conditions: conditions.value,
      gravityMPerS2,
      ...(structural.centrifugal === undefined
        ? {}
        : { centrifugal: structural.centrifugal }),
      ...(structural.thermalDeltaTK === undefined
        ? {}
        : { thermalDeltaTK: structural.thermalDeltaTK }),
      scenarioSnapshotHash: compiled.scenarioSnapshotHash,
    });
  if (!report.ok) return report;
  onProgress?.({ step: 1, totalSteps: 1 });
  if (onFieldChunk !== undefined) {
    // Von Mises first, displacement LAST — the page's last-applied-wins
    // live overlay deterministically names the displacement field.
    publishPreviewRound(report.value.vonMisesField, onFieldChunk);
    publishPreviewRound(report.value.displacementField, onFieldChunk);
  }
  return structuralRunSimResult(report.value);
}

/** The deterministic coarse voxel FEM engine (law S2's CPU oracle adapter). */
export function createStructuralSimEngine(): SimEngine {
  return {
    id: STRUCTURAL_SIM_ENGINE_ID,
    supportedKinds: STRUCTURAL_SUPPORTED_KINDS,
    backend: "cpu",
    run: (request, onProgress, onFieldChunk) =>
      runStructuralEngine(request, onProgress, onFieldChunk),
  };
}
