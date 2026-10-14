/**
 * The conjugate-heat-transfer engine behind the Phase 61 `SimEngine`
 * contract (Phase 65c, the `./engine` conduction twin): the adapter
 * that turns one COMPILED coupled thermal scenario into a 65b
 * `runChtScenario` march — flow, fluid thermal field, and solid
 * conduction advanced in lockstep with Boussinesq buoyancy, the
 * conservative interface exchange, and the measured energy ledger.
 * This engine lives in `@slopcad/sim-flow` because its march DOES: the
 * coupled solver is the flow kernel's own (`./cht`), and the sealed
 * conduction twin lives in `@slopcad/sim-thermal` — both behind the
 * same routed default engine, split exactly where the solvers are.
 *
 * One `run` call:
 *
 * 1. **Consumes the compiled problem** — the 65c compile's occupancy
 *    slice becomes the lattice mask, the per-cell material map becomes
 *    the per-node conductivity/ρc arrays (ρc REQUIRED here: the coupled
 *    solid march is implicit), the compiled conditions split into the
 *    flow faces (inlets/outlets/walls/symmetry — walls the buoyant
 *    cavity's default), the scalar's fluid-wall conditions
 *    (fixed-temperature walls; adiabatic otherwise), and the solid
 *    slab's outer-face conditions (convection-ambient, heat-flux).
 * 2. **Derives the buoyancy velocity scale** — w* = √(g·β·ΔT_est·L),
 *    the closure's low-Mach reference, with ΔT_est the larger of the
 *    authored wall scale and the source-driven estimate Q/(h_est·A_ext)
 *    over the exposed solid faces (h_est a NAMED natural-convection
 *    band constant — a scale for the unit closure, stated as such,
 *    never reported as physics).
 * 3. **Runs the march** — the authored (duration, sample cadence)
 *    picks the coupling interval: `couplingIntervalSteps` flow steps
 *    bring one interval as close to the cadence as the lattice's
 *    timestep allows, and the interval count carries the duration.
 * 4. **Finalizes to a `SimResult`** — the S9 regime the compile
 *    computed (Pr always; Ra under the ΔT rule; Re/Ma at the buoyancy
 *    scale), the snapshot hash, the temperature facts, the measured
 *    energy-ledger quantities, the shared temperature field and the
 *    flow fields as the 62-overlay blocks — and a diverged march
 *    persists as a FAILED result (`sim/run-diverged`) with its
 *    histories, never fabricated fields.
 *
 * Emissions: one macrotask yield (the cooperative cancellation
 * window), a progress hop at each stage, and ONE final preview round —
 * the projected temperature block in protocol chunks, bitwise the
 * block the finalized result carries. The 65b driver is a whole-run
 * API — consumed, never reworked — so the streaming cadence is one
 * committed round per run.
 *
 * Determinism (law S2): no clocks, no randomness, a fixed emission
 * schedule — the same compiled problem produces the bitwise-identical
 * result and notification stream every time.
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
  type SimParseResult,
  type SimResult,
  type SimResultFieldBlock,
  type SimScenarioKind,
  type SolverSimScalar,
  SIM_RESULT_SUMMARY_VERSION,
  projectSimResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";
import {
  thermalPublishPreview,
  thermalSolidMaterialFromRecord,
  type ThermalSolidMaterial,
} from "@slopcad/sim-thermal";
import type { ThermalSurfaceCondition } from "@slopcad/sim-thermal";
import type { ChtRunReport } from "./cht";
import type { LbmFaceSpec } from "./stepper";
import type { LbmThermalFaceCondition } from "./thermal-scalar";

import { runChtScenario } from "./cht";
import { lbmUnitSystem } from "./lattice-units";
import { lbmSolidMaskFromGrid } from "./occupancy";

/** The coupled engine's stable id (the worker host's routing key). */
export const CHT_SIM_ENGINE_ID = "thermal-cht-cpu-reference";

/** The scenario kinds this engine solves. */
export const CHT_SUPPORTED_KINDS: readonly SimScenarioKind[] = ["thermal"];

/**
 * The natural-convection band constant of the buoyancy scale's
 * source-driven ΔT estimate, W/(m²·K) — the middle of the textbook
 * laminar band for air in this regime. A closure SCALE for the lattice
 * unit system, never a reported heat-transfer coefficient.
 */
const CHT_BUOYANCY_SCALE_H_W_PER_M2K = 5;

const refuse = (
  message: string,
  at: unknown,
): SimParseResult<never, SimError> =>
  simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));

/** One macrotask turn — the cooperative cancellation window. */
function yieldOnce(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

/** The lateral faces the 2D coupled march consumes. */
const LATERAL_FACES: readonly SimDomainFace[] = [
  "xMin",
  "xMax",
  "yMin",
  "yMax",
];

/**
 * The compiled conditions split into the march's three boundary sets:
 * the FLOW faces (inlets/outlets/walls/symmetry; walls the default for
 * the buoyant cavity), the SCALAR's fluid-wall conditions
 * (fixed-temperature walls Dirichlet, everything else adiabatic), and
 * the SOLID slab's outer-face conditions (convection-ambient,
 * heat-flux). A z-face condition is outside the 2D statement and
 * declines.
 */
interface CoupledFaces {
  readonly flow: Record<"west" | "east" | "south" | "north", LbmFaceSpec>;
  readonly scalar: Record<
    "west" | "east" | "south" | "north",
    LbmThermalFaceCondition
  >;
  readonly solid: Partial<Record<SimDomainFace, ThermalSurfaceCondition>>;
}

function coupledFacesOf(
  request: SimEngineRequest,
): SimParseResult<CoupledFaces, SimError> {
  const faceOf: Record<SimDomainFace, "west" | "east" | "south" | "north"> = {
    xMin: "west",
    xMax: "east",
    yMin: "south",
    yMax: "north",
    zMin: "west",
    zMax: "east",
  };
  const flow: Record<"west" | "east" | "south" | "north", LbmFaceSpec> = {
    west: { kind: "wall", slip: false },
    east: { kind: "wall", slip: false },
    south: { kind: "wall", slip: false },
    north: { kind: "wall", slip: false },
  };
  const scalar: Record<
    "west" | "east" | "south" | "north",
    LbmThermalFaceCondition
  > = {
    west: { kind: "adiabatic" },
    east: { kind: "adiabatic" },
    south: { kind: "adiabatic" },
    north: { kind: "adiabatic" },
  };
  const solid: Partial<Record<SimDomainFace, ThermalSurfaceCondition>> = {};
  for (const condition of request.compiled.conditions) {
    if (condition.face === undefined) {
      return refuse(
        `A "${condition.kind}" condition addresses no domain face — the structural point set (Phase 69) is not the coupled march's vocabulary.`,
        condition,
      );
    }
    if (condition.face === "zMin" || condition.face === "zMax") {
      return refuse(
        `A condition on the "${condition.face}" face is outside the coupled march's 2D statement — the slab consumes the four lateral faces, its front and back are the per-metre depth's adiabatic planes.`,
        condition,
      );
    }
    if (!LATERAL_FACES.includes(condition.face)) {
      return refuse(
        "A thermal condition must address a lateral face of the slice.",
        condition,
      );
    }
    const lateral = faceOf[condition.face];
    switch (condition.kind) {
      case "velocity-inlet": {
        const velocity = condition.velocityMPerS;
        if (velocity === undefined) {
          return refuse(
            "A compiled velocity-inlet condition carried no velocity vector.",
            condition,
          );
        }
        flow[lateral] = {
          kind: "velocity-inlet",
          velocityMPerS: [velocity[0] ?? 0, velocity[1] ?? 0],
        };
        break;
      }
      case "pressure-outlet": {
        if (condition.pressurePa === undefined) {
          return refuse(
            "A compiled pressure-outlet condition carried no pressure.",
            condition,
          );
        }
        flow[lateral] = {
          kind: "pressure-outlet",
          pressurePa: condition.pressurePa,
        };
        break;
      }
      case "wall":
        flow[lateral] = { kind: "wall", slip: condition.slip === true };
        break;
      case "symmetry":
        flow[lateral] = { kind: "symmetry" };
        break;
      case "fixed-temperature": {
        if (condition.temperatureK === undefined) {
          return refuse(
            "A compiled fixed-temperature condition carried no temperature.",
            condition,
          );
        }
        scalar[lateral] = {
          kind: "fixed-temperature",
          temperatureK: condition.temperatureK,
        };
        break;
      }
      case "heat-flux": {
        if (condition.fluxWPerM2 === undefined) {
          return refuse(
            "A compiled heat-flux condition carried no flux.",
            condition,
          );
        }
        solid[condition.face] = {
          kind: "heat-flux",
          fluxWPerM2: condition.fluxWPerM2,
        };
        break;
      }
      case "convection-ambient": {
        if (
          condition.heatTransferCoefficientWPerM2K === undefined ||
          condition.ambientTemperatureK === undefined
        ) {
          return refuse(
            "A compiled convection-ambient condition carried no coefficient or ambient temperature.",
            condition,
          );
        }
        solid[condition.face] = {
          kind: "convection-ambient",
          heatTransferCoefficientWPerM2K:
            condition.heatTransferCoefficientWPerM2K,
          ambientTemperatureK: condition.ambientTemperatureK,
          ...(condition.emissivity === undefined
            ? {}
            : { emissivity: condition.emissivity }),
        };
        break;
      }
      default:
        return refuse(
          `A "${condition.kind}" condition cannot ride the coupled march (it consumes the flow set, fixed-temperature, heat-flux, and convection-ambient).`,
          condition,
        );
    }
  }
  return simOk({ flow, scalar, solid });
}

/** The per-node solid property arrays the march consumes. */
interface SolidProperties {
  readonly conductivityWPerMK: Float64Array;
  readonly volumetricHeatCapacityJPerM3K: Float64Array;
  readonly sourceWPerM3: Float64Array;
  readonly solidCount: number;
}

function solidPropertiesOf(
  thermal: CompiledSimThermal,
  cellSizeM: number,
  cellCount: number,
  solid: Uint8Array,
): SimParseResult<SolidProperties, SimError> {
  const materials: ThermalSolidMaterial[] = [];
  for (const entry of thermal.materials) {
    const parsed = thermalSolidMaterialFromRecord(entry.record);
    if (!parsed.ok) return parsed;
    materials.push(parsed.value);
  }
  if (materials.length === 0) {
    return refuse(
      "A coupled thermal run needs at least one resolved material record.",
      thermal.materials,
    );
  }
  const conductivityWPerMK = new Float64Array(cellCount);
  const volumetricHeatCapacityJPerM3K = new Float64Array(cellCount);
  const sourceWPerM3 = new Float64Array(cellCount);
  const index = thermal.materialIndex;
  if (index.length !== cellCount) {
    return refuse(
      `The compiled per-cell material map's length (${String(index.length)}) must equal the slice's cell count (${String(cellCount)}).`,
      index.length,
    );
  }
  let solidCount = 0;
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (solid[cell] !== 1) continue;
    const materialIndex = index[cell] ?? 0;
    const material = materials[materialIndex - 1];
    if (material === undefined) {
      return refuse(
        `A solid cell's compiled material index (${String(materialIndex)}) addresses no resolved material.`,
        materialIndex,
      );
    }
    const rhoC = material.volumetricHeatCapacityJPerM3K;
    if (rhoC === undefined) {
      return refuse(
        `The coupled solid march needs ρc on every solid cell, and the material "${material.id}" carries no specific heat — the implicit march declines instead of fabricating a capacity.`,
        material,
      );
    }
    conductivityWPerMK[cell] = material.thermalConductivityWPerMK;
    volumetricHeatCapacityJPerM3K[cell] = rhoC;
    solidCount += 1;
  }
  if (solidCount === 0) {
    return refuse(
      "The compiled solids voxelized to an empty lattice — the coupled march has nothing to heat.",
      thermal,
    );
  }
  const cellAreaM2 = cellSizeM * cellSizeM;
  const perCellWPerM3 = thermal.sourceW / (cellAreaM2 * solidCount);
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (solid[cell] === 1) sourceWPerM3[cell] = perCellWPerM3;
  }
  return simOk({
    conductivityWPerMK,
    volumetricHeatCapacityJPerM3K,
    sourceWPerM3,
    solidCount,
  });
}

async function runChtEngine(
  request: SimEngineRequest,
  onProgress?: (progress: SimEngineProgress) => void,
  onFieldChunk?: (chunk: SimEngineFieldChunk) => void,
): Promise<SimParseResult<SimResult, SimError>> {
  const compiled = request.compiled;
  if (!CHT_SUPPORTED_KINDS.includes(compiled.kind)) {
    return refuse(
      `The coupled thermal engine does not solve the "${compiled.kind}" scenario kind (it solves thermal's coupled stance; structural is served by the structural engine through the routed default engine).`,
      compiled.kind,
    );
  }
  if (compiled.backend === "gpu") {
    return simFail(
      simError(
        SIM_ERROR_CODES.backendUnavailable,
        'The scenario prefers the "gpu" backend, but the coupled thermal march ships the CPU reference kernel only — there is no GPU provider to route to, and the engine declines the preference loudly instead of silently ignoring it.',
        compiled.backend,
      ),
    );
  }
  const slice = compiled.occupancySlice;
  const thermal = compiled.thermal;
  if (slice === undefined || thermal === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.geometryUnavailable,
        "A coupled thermal run needs the compile's voxelized solids and material map: compile with the bodies' tessellations and the material records (the geometry-aware compile door), and this engine refuses to fabricate a lattice.",
        compiled.name,
      ),
    );
  }
  if (!thermal.cht) {
    return refuse(
      "This engine serves the conjugate coupled stance (the buoyant plume); the sealed conduction stance is the conduction engine's — the routed default engine picks between them, and a direct mismatched call declines loudly instead of guessing.",
      { scenario: compiled.name, cht: thermal.cht },
    );
  }
  if (thermal.solveMode !== "transient") {
    return refuse(
      "The coupled march is transient by construction; a steady coupled stance cannot compile.",
      thermal.solveMode,
    );
  }
  const durationS = thermal.durationS;
  const sampleIntervalS = thermal.sampleIntervalS;
  if (durationS === undefined || sampleIntervalS === undefined) {
    return refuse(
      "A coupled thermal compile must carry its duration and sample interval; the engine declines a march with no budget instead of defaulting one.",
      thermal,
    );
  }
  const faces = coupledFacesOf(request);
  if (!faces.ok) return faces;
  const mask = lbmSolidMaskFromGrid(slice);
  if (!mask.ok) return mask;
  const cellCount = mask.value.nx * mask.value.ny;
  const properties = solidPropertiesOf(
    thermal,
    compiled.cellSizeM,
    cellCount,
    mask.value.solid,
  );
  if (!properties.ok) return properties;

  // The buoyancy velocity scale (the closure's low-Mach reference):
  // w* = √(g·β·ΔT_est·L). The wall scale: the largest authored
  // |T_wall − T_ref|. The source scale: Q/(h_est·A_ext) over the
  // exposed solid faces — computed here, honestly, from the mask.
  let exposedFaceAreaM2PerM = 0;
  const { nx, ny, solid } = mask.value;
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const cell = i + j * nx;
      if (solid[cell] !== 1) continue;
      const neighbours: readonly (number | null)[] = [
        i > 0 ? cell - 1 : null,
        i < nx - 1 ? cell + 1 : null,
        j > 0 ? cell - nx : null,
        j < ny - 1 ? cell + nx : null,
      ];
      for (const neighbour of neighbours) {
        if (neighbour === null || solid[neighbour] !== 1) {
          exposedFaceAreaM2PerM += compiled.cellSizeM;
        }
      }
    }
  }
  const referenceTemperatureK = thermal.initialTemperatureK;
  let wallScaleK = 0;
  for (const condition of compiled.conditions) {
    if (
      condition.kind === "fixed-temperature" &&
      condition.temperatureK !== undefined
    ) {
      wallScaleK = Math.max(
        wallScaleK,
        Math.abs(condition.temperatureK - referenceTemperatureK),
      );
    }
  }
  const sourceScaleK =
    exposedFaceAreaM2PerM > 0
      ? thermal.sourceW /
        (CHT_BUOYANCY_SCALE_H_W_PER_M2K * exposedFaceAreaM2PerM)
      : 0;
  const gravity = compiled.gravityMPerS2;
  const gravityMagnitude = Math.sqrt(
    (gravity[0] ?? 0) ** 2 + (gravity[1] ?? 0) ** 2 + (gravity[2] ?? 0) ** 2,
  );
  const deltaTEstimateK = Math.max(wallScaleK, sourceScaleK);
  if (gravityMagnitude <= 0 || deltaTEstimateK <= 0) {
    return refuse(
      "The coupled march needs a buoyancy velocity scale (√(g·β·ΔT·L)) and the scenario offers none: zero gravity, or no wall temperature difference and no source-driven excess to scale a plume with. Author gravity, a heated source, or a fixed-temperature wall — the engine declines a march it cannot scale.",
      { gravityMagnitude, deltaTEstimateK },
    );
  }
  const characteristicVelocityMPerS = Math.sqrt(
    gravityMagnitude *
      compiled.fluid.thermalExpansionPerK *
      deltaTEstimateK *
      compiled.characteristicLengthM,
  );

  // The coupling interval: flow steps that bring one interval as close
  // to the authored cadence as the lattice's own timestep allows; the
  // interval count carries the authored duration.
  const units = lbmUnitSystem({
    cellSizeM: compiled.cellSizeM,
    characteristicVelocityMPerS,
    kinematicViscosityM2PerS: compiled.fluid.kinematicViscosityM2PerS,
    referenceDensityKgPerM3: compiled.fluid.densityKgPerM3,
  });
  if (!units.ok) return units;
  const dtFlow = units.value.timeStepS;
  const couplingIntervalSteps = Math.max(
    1,
    Math.round(sampleIntervalS / dtFlow),
  );
  const intervals = Math.max(
    1,
    Math.round(durationS / (couplingIntervalSteps * dtFlow)),
  );

  onProgress?.({ step: 0, totalSteps: 1 });
  await yieldOnce();
  const marched: SimParseResult<ChtRunReport, SimError> = runChtScenario({
    name: compiled.name,
    mask: mask.value,
    cellSizeM: compiled.cellSizeM,
    fluid: compiled.fluid,
    characteristicVelocityMPerS,
    flowFaces: faces.value.flow,
    thermalFaces: faces.value.scalar,
    gravityMPerS2: [gravity[0] ?? 0, gravity[1] ?? 0],
    referenceTemperatureK,
    solidConductivityWPerMK: properties.value.conductivityWPerMK,
    solidVolumetricHeatCapacityJPerM3K:
      properties.value.volumetricHeatCapacityJPerM3K,
    sourceWPerM3: properties.value.sourceWPerM3,
    solidFaceConditions: faces.value.solid,
    initialTemperatureK: thermal.initialTemperatureK,
    characteristicLengthM: compiled.characteristicLengthM,
    couplingIntervalSteps,
    intervals,
  });
  if (!marched.ok) return marched;
  onProgress?.({ step: 1, totalSteps: 1 });
  const report = marched.value;
  if (onFieldChunk !== undefined && report.fields.length > 0) {
    thermalPublishPreview(
      report.fields.filter((field) => field.id === "temperature"),
      onFieldChunk,
    );
  }
  return simOk(chtRunSimResult(compiled, report));
}

/**
 * Assembles the persistence-fit {@link SimResult} of a coupled march:
 * the compile's S9 regime and snapshot hash, the temperature facts, the
 * MEASURED energy-ledger quantities (the 65b conservation claim,
 * reported as numbers), the shared temperature field and the flow
 * fields — and a diverged march as a FAILED result carrying
 * `sim/run-diverged` with its histories, fields withheld.
 */
export function chtRunSimResult(
  compiled: SimEngineRequest["compiled"],
  report: ChtRunReport,
): SimResult {
  const scalars: SolverSimScalar[] = [];
  if (!report.diverged) {
    scalars.push(
      {
        name: "fluid-temperature-mean",
        dimension: "temperature",
        value: report.temperature.fluidMeanK,
      },
      {
        name: "fluid-temperature-max",
        dimension: "temperature",
        value: report.temperature.fluidMaxK,
      },
      {
        name: "fluid-temperature-min",
        dimension: "temperature",
        value: report.temperature.fluidMinK,
      },
      ...(report.temperature.solidMeanK === null
        ? []
        : [
            {
              name: "solid-temperature-mean",
              dimension: "temperature" as const,
              value: report.temperature.solidMeanK,
            },
          ]),
      {
        name: "physical-duration",
        dimension: "time",
        value: report.physicalDurationS,
      },
      { name: "flow-steps", dimension: "dimensionless", value: report.steps },
      {
        name: "coupling-intervals",
        dimension: "dimensionless",
        value: report.intervals,
      },
      {
        name: "fluid-energy-change",
        dimension: "energy",
        value: report.ledger.fluidChangeJPerM,
      },
      {
        name: "solid-energy-change",
        dimension: "energy",
        value: report.ledger.solidChangeJPerM,
      },
      {
        name: "fluid-boundary-energy-in",
        dimension: "energy",
        value: report.ledger.fluidBoundaryInJPerM,
      },
      {
        name: "solid-boundary-energy-in",
        dimension: "energy",
        value: report.ledger.solidBoundaryInJPerM,
      },
      {
        name: "solid-source-energy",
        dimension: "energy",
        value: report.ledger.solidSourceJPerM,
      },
      {
        name: "energy-closure",
        dimension: "energy",
        value: report.ledger.closureJPerM,
      },
    );
  }
  const projected = projectSimResult({ scalars, fields: [] });
  if (!projected.ok) {
    // A projection decline is a malformed quantity — surfaced as a
    // failed result naming the code, never a fabricated one.
    return {
      summary: {
        schemaVersion: SIM_RESULT_SUMMARY_VERSION,
        scenarioSnapshotHash: compiled.scenarioSnapshotHash,
        status: "failed",
        regime: compiled.regime,
        quantities: [],
        servedBackend: "cpu",
        failureCode: projected.error.code,
        failureMessage: projected.error.message,
      },
      fields: [],
      histories: [],
    };
  }
  let fieldBlocks: readonly SimResultFieldBlock[] = [];
  if (report.fields.length > 0) {
    const fields = projectSimResult({ scalars: [], fields: report.fields });
    if (!fields.ok) {
      return {
        summary: {
          schemaVersion: SIM_RESULT_SUMMARY_VERSION,
          scenarioSnapshotHash: compiled.scenarioSnapshotHash,
          status: "failed",
          regime: compiled.regime,
          quantities: [],
          servedBackend: "cpu",
          failureCode: fields.error.code,
          failureMessage: fields.error.message,
        },
        fields: [],
        histories: [],
      };
    }
    fieldBlocks = fields.value.fields;
  }
  const divergedMessage = `The coupled march's divergence sentinel froze the run of ${report.scenarioName} after ${String(report.intervals)} interval(s) (${report.divergence.flow ? "flow" : "thermal"} leg); no fields or quantities are reported for a blown-up march.`;
  return {
    summary: {
      schemaVersion: SIM_RESULT_SUMMARY_VERSION,
      scenarioSnapshotHash: compiled.scenarioSnapshotHash,
      status: report.diverged ? "failed" : "completed",
      regime: compiled.regime,
      quantities: projected.value.scalars,
      servedBackend: "cpu",
      ...(report.diverged
        ? {
            failureCode: SIM_ERROR_CODES.runDiverged,
            failureMessage: divergedMessage,
          }
        : {}),
    },
    fields: fieldBlocks,
    histories: report.histories,
  };
}

/** The deterministic coupled thermal engine (law S2's CPU oracle adapter). */
export function createChtSimEngine(): SimEngine {
  return {
    id: CHT_SIM_ENGINE_ID,
    supportedKinds: CHT_SUPPORTED_KINDS,
    backend: "cpu",
    run: (request, onProgress, onFieldChunk) =>
      runChtEngine(request, onProgress, onFieldChunk),
  };
}
