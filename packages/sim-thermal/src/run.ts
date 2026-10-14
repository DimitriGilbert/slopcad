/**
 * The thermal run driver (Phase 65a, the sim-flow `./run` precedent):
 * one call — {@link runThermalScenario} — takes the solver-space problem
 * pieces (the Phase 62a occupancy grid, the extended material records'
 * per-cell map, the ambient/fluid context, the boundary conditions, the
 * radiation stance, the solve mode) and produces the completed run
 * report; {@link thermalRunSimResult} persists it as a
 * {@link SimResult}. What the layer wires:
 *
 * - **S4, SI inside / mm at the doors** — the problem is consumed in
 *   SI (the grid's metres, the conditions' SI magnitudes, the ρc
 *   conversion at the material door), and the ONLY projection site is
 *   `projectSimResult` at the SimResult seam: the temperature field
 *   declares its dimension and converts through the one boundary, no
 *   second conversion path anywhere.
 * - **S9, regime honesty** — Prandtl ALWAYS (the fluid state the
 *   scenario selected, the same sim-core function the compile boundary
 *   uses); Rayleigh whenever the buoyancy gate's inputs exist — a
 *   non-zero gravity vector AND a temperature-difference scale — with
 *   the ΔT magnitude rule EXACTLY the 61a compile boundary's (the
 *   largest |T − T_ref| over the fixed-temperature and
 *   convection-ambient conditions; pinned equal to the compile-fed
 *   report by test). The 65b buoyancy coupling will consume the same
 *   number; here it is reported, flagged advisory per law S9 — a
 *   buoyancy-driven flag states the regime, never blocks the run.
 * - **Provenance** — the compile boundary's scenario-snapshot hash
 *   rides through when compile-fed; a standalone scenario hashes its
 *   own canonical view through the same sim-core hasher (the flow
 *   driver's precedent), so every report carries comparable identity.
 *
 * Determinism is the layer's stance (law S2): no clock, no randomness,
 * fixed iteration discipline — the same scenario produces the
 * bitwise-identical report (pinned by test). A transient divergence
 * freezes and reports itself; a steady discipline failure declines
 * loudly (`sim/solver-unconverged`); both persist honestly at the seam.
 */

import {
  type SimDomainFace,
  type SimError,
  SIM_ERROR_CODES,
  SIM_RESULT_SUMMARY_VERSION,
  type SimFluidState,
  type SimHistorySeries,
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
  simPrandtl,
  simRayleigh,
  simRegimeReport,
  simScenarioSnapshotHash,
  projectSimResult,
} from "@slopcad/sim-core";
import type {
  ThermalAmbientSpec,
  ThermalFaceConditionEntry,
  ThermalRadiationMode,
  ThermalSurfaceCondition,
} from "./boundaries";
import type { ThermalCellGrid } from "./grid";
import type { ThermalSolidMaterial } from "./material";
import type { ThermalProblem } from "./system";

import { thermalBoundaryFluxLedger, thermalEnclosureFacts } from "./audit";
import { THERMAL_RADIATION_MODES } from "./boundaries";
import { thermalCellGrid, thermalExposedFaces } from "./grid";
import {
  type ResolvedThermalSteadySpec,
  type ThermalSteadyOutcome,
  type ThermalSteadySpec,
  resolveThermalSteadySpec,
  solveThermalSteady,
} from "./steady";
import {
  type ResolvedThermalTransientSpec,
  type ThermalTransientOutcome,
  type ThermalTransientSpec,
  marchThermalTransient,
  resolveThermalTransientSpec,
} from "./transient";
import { resolveThermalFace } from "./system";

/** What {@link runThermalScenario} consumes — SI at the door, law S4. */
export interface ThermalRunScenario {
  readonly name: string;
  /** The Phase 62a occupancy grid — the direct node→cell interpretation. */
  readonly grid: SimOccupancyGrid;
  /** The scenario's material selection, solver space (the material door's output). */
  readonly materials: readonly ThermalSolidMaterial[];
  /** Per-cell 1-based index into materials; 0 on fluid cells. */
  readonly cellMaterialIndex: Uint16Array;
  /** The ambient fluid state (the scenario's fluid selection at its reference). */
  readonly fluid: SimFluidState;
  /** Domain-face conditions (the compiled thermal kinds). */
  readonly conditions?: readonly ThermalFaceConditionEntry[];
  /** The equilibrium boundary default for exposed exterior faces. */
  readonly ambient?: ThermalAmbientSpec;
  /** The Stefan–Boltzmann stance for every radiating surface (§7.12). */
  readonly radiationMode: ThermalRadiationMode;
  /**
   * The linearized mode's surface-temperature estimate, K (defaults to
   * the mode's initial field temperature). Stated honestly: the
   * linearized settled temperature depends on it; the full law's does
   * not — the cross-check fixture's band.
   */
  readonly radiationReferenceK?: number;
  /** Per-cell volumetric heat source, W/m³ (signed; + heats; 0 on fluid cells). */
  readonly sourceWPerM3?: Float64Array;
  /** The gravity vector, m/s² (default standard gravity, −Y) — the Ra gate's input. */
  readonly gravityMPerS2?: readonly [number, number, number];
  /** The characteristic length the S9 numbers are formed with, m. */
  readonly characteristicLengthM: number;
  readonly mode: ThermalSteadySpec | ThermalTransientSpec;
  /** The compile boundary's run-time scenario hash, when compile-fed. */
  readonly scenarioSnapshotHash?: string;
  /** The compile boundary's S9 report, when compile-fed; else computed here. */
  readonly regime?: SimRegimeReport;
}

/** The immutable grid facts every report carries. */
export interface ThermalRunGridFacts {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly spacingM: readonly [number, number, number];
}

/** The settled-temperature summary scalars, K. */
export interface ThermalRunTemperatures {
  readonly minK: number;
  readonly maxK: number;
  readonly meanK: number;
}

/** One completed (or honestly diverged) thermal run. */
export interface ThermalRunReport {
  readonly scenarioName: string;
  readonly scenarioSnapshotHash: string;
  readonly regime: SimRegimeReport;
  readonly grid: ThermalRunGridFacts;
  readonly mode: ThermalSteadyOutcome | ThermalTransientOutcome;
  readonly temperatures: ThermalRunTemperatures;
  /** The final field's boundary flux ledger (the audit's steady half). */
  readonly balance: ReturnType<typeof thermalBoundaryFluxLedger>;
  /** Per-enclosure facts (the §7.12 grey-diffuse enclosure view). */
  readonly enclosures: ReturnType<typeof thermalEnclosureFacts>;
  /** The final temperature field, S4-ready (withheld on divergence). */
  readonly temperatureField: SolverSimField | null;
  /** The transient histories (empty on a steady run). */
  readonly histories: readonly SimHistorySeries[];
  /** The transient divergence sentinel (steady runs decline instead). */
  readonly diverged: boolean;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

const refuse = (
  message: string,
  at: unknown,
): SimParseResult<never, SimError> =>
  simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));

/** Validates one ambient spec's magnitudes. */
function ambientProblem(spec: ThermalAmbientSpec): SimError | undefined {
  if (
    typeof spec.heatTransferCoefficientWPerM2K !== "number" ||
    !Number.isFinite(spec.heatTransferCoefficientWPerM2K) ||
    spec.heatTransferCoefficientWPerM2K < 0
  ) {
    return simError(
      SIM_ERROR_CODES.scenarioInvalid,
      `An ambient spec's convection coefficient must be a finite number ≥ 0 W/(m²·K), received ${String(spec.heatTransferCoefficientWPerM2K)}.`,
      spec.heatTransferCoefficientWPerM2K,
    );
  }
  if (
    typeof spec.ambientTemperatureK !== "number" ||
    !Number.isFinite(spec.ambientTemperatureK) ||
    spec.ambientTemperatureK <= 0
  ) {
    return simError(
      SIM_ERROR_CODES.scenarioInvalid,
      `An ambient spec's temperature must be a positive finite kelvin value, received ${String(spec.ambientTemperatureK)}.`,
      spec.ambientTemperatureK,
    );
  }
  return undefined;
}

/** Validates one authored condition into its face-keyed form. */
function conditionProblem(
  entry: ThermalFaceConditionEntry,
): SimParseResult<
  { readonly face: SimDomainFace; readonly condition: ThermalSurfaceCondition },
  SimError
> {
  const faces: readonly SimDomainFace[] = [
    "xMin",
    "xMax",
    "yMin",
    "yMax",
    "zMin",
    "zMax",
  ];
  if (typeof entry.face !== "string" || !faces.includes(entry.face)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `A thermal condition's face must be one of ${faces.join(", ")}.`,
        entry.face,
      ),
    );
  }
  const checkFinite = (value: unknown, what: string): number | SimError => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `${what} must be a finite number.`,
        value,
      );
    }
    return value;
  };
  const authoredKind: unknown = entry.kind;
  switch (entry.kind) {
    case "fixed-temperature": {
      const temperatureK = checkFinite(
        entry.temperatureK,
        "A fixed-temperature condition's temperature",
      );
      if (typeof temperatureK !== "number") return simFail(temperatureK);
      if (temperatureK <= 0) {
        return simFail(
          simError(
            SIM_ERROR_CODES.scenarioInvalid,
            "A fixed-temperature condition's temperature must be positive (kelvin).",
            entry.temperatureK,
          ),
        );
      }
      return simOk({
        face: entry.face,
        condition: { kind: "fixed-temperature", temperatureK },
      });
    }
    case "heat-flux": {
      const fluxWPerM2 = checkFinite(
        entry.fluxWPerM2,
        "A heat-flux condition's flux",
      );
      if (typeof fluxWPerM2 !== "number") return simFail(fluxWPerM2);
      return simOk({
        face: entry.face,
        condition: { kind: "heat-flux", fluxWPerM2 },
      });
    }
    case "convection-ambient": {
      const heatTransferCoefficientWPerM2K = checkFinite(
        entry.heatTransferCoefficientWPerM2K,
        "A convection-ambient condition's coefficient",
      );
      if (typeof heatTransferCoefficientWPerM2K !== "number") {
        return simFail(heatTransferCoefficientWPerM2K);
      }
      if (heatTransferCoefficientWPerM2K < 0) {
        return simFail(
          simError(
            SIM_ERROR_CODES.scenarioInvalid,
            "A convection-ambient condition's coefficient must be ≥ 0 W/(m²·K).",
            entry.heatTransferCoefficientWPerM2K,
          ),
        );
      }
      const ambientTemperatureK = checkFinite(
        entry.ambientTemperatureK,
        "A convection-ambient condition's ambient temperature",
      );
      if (typeof ambientTemperatureK !== "number") {
        return simFail(ambientTemperatureK);
      }
      if (ambientTemperatureK <= 0) {
        return simFail(
          simError(
            SIM_ERROR_CODES.scenarioInvalid,
            "A convection-ambient condition's ambient temperature must be positive (kelvin).",
            entry.ambientTemperatureK,
          ),
        );
      }
      if (entry.emissivity !== undefined) {
        const emissivity = checkFinite(
          entry.emissivity,
          "A convection-ambient condition's emissivity",
        );
        if (typeof emissivity !== "number") return simFail(emissivity);
        if (emissivity < 0 || emissivity > 1) {
          return simFail(
            simError(
              SIM_ERROR_CODES.scenarioInvalid,
              "A convection-ambient condition's emissivity must lie in [0, 1].",
              entry.emissivity,
            ),
          );
        }
      }
      return simOk({
        face: entry.face,
        condition: {
          kind: "convection-ambient",
          heatTransferCoefficientWPerM2K,
          ambientTemperatureK,
          ...(entry.emissivity === undefined
            ? {}
            : { emissivity: entry.emissivity }),
        },
      });
    }
    default:
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          `A thermal condition's kind must be fixed-temperature, heat-flux, or convection-ambient, received ${String(authoredKind)}.`,
          entry,
        ),
      );
  }
}

/**
 * The steady anchor analysis, PER CONNECTED COMPONENT: the solid region
 * splits into components over positive interior conductance (an edge
 * only where BOTH cells conduct — the harmonic mean with a k = 0 cell
 * is zero, so a non-conducting blob is its own island however
 * geometrically adjacent), and EVERY component must touch a temperature
 * anchor: an exposed face whose boundary conductance actually reaches
 * the row — a Dirichlet wall on a conducting cell (G = 2kA/d > 0 only
 * when k > 0), a convecting face (h·A, independent of k), or a
 * radiating face under a radiation mode (the ε·σ slope, independent of
 * k). An enclosure face is NOT an anchor: the uniform-radiosity
 * exchange conserves identically inside the enclosure, so it can move
 * heat between walls but never out of an isolated component. A
 * component with no anchor — even a source-free one — has no UNIQUE
 * equilibrium (any uniform field balances), and its zero-diagonal rows
 * would be silently held at the initial temperature by the solver while
 * the residual reads ≈ 0; the door declines loudly per component as
 * `sim/scenario-invalid` (an ill-posed problem, not a convergence
 * failure — there is nothing to iterate toward).
 */
function steadyAnchorProblem(
  grid: ThermalCellGrid,
  conductivityWPerMK: Float64Array,
  emissivity: Float64Array,
  ambient: ThermalAmbientSpec | undefined,
  faceConditions: Readonly<
    Partial<Record<SimDomainFace, ThermalSurfaceCondition>>
  >,
  radiationMode: ThermalRadiationMode,
): SimError | undefined {
  const cellCount = grid.nx * grid.ny * grid.nz;

  // Components over positive-conductance edges (a deterministic BFS in
  // fixed index order — the grid module's flood precedent).
  const componentOf = new Int32Array(cellCount).fill(-1);
  const queue = new Int32Array(cellCount);
  let components = 0;
  const strides = [1, grid.nx, grid.nx * grid.ny] as const;
  const extents = [grid.nx, grid.ny, grid.nz] as const;
  for (let seed = 0; seed < cellCount; seed += 1) {
    if (grid.solid[seed] !== 1 || (componentOf[seed] ?? -1) >= 0) continue;
    const id = components;
    components += 1;
    componentOf[seed] = id;
    let head = 0;
    let tail = 0;
    queue[tail] = seed;
    tail += 1;
    while (head < tail) {
      const cell = queue[head] ?? 0;
      head += 1;
      const i = cell % grid.nx;
      const j = Math.floor(cell / grid.nx) % grid.ny;
      const k = Math.floor(cell / (grid.nx * grid.ny));
      const coordinates = [i, j, k];
      for (let axis = 0; axis < 3; axis += 1) {
        const stride = strides[axis] ?? 1;
        const extent = extents[axis] ?? 1;
        const coordinate = coordinates[axis] ?? 0;
        for (const sign of [-1, 1] as const) {
          const next = coordinate + sign;
          if (next < 0 || next >= extent) continue;
          const neighbour = cell + sign * stride;
          if (
            grid.solid[neighbour] !== 1 ||
            (componentOf[neighbour] ?? -1) >= 0 ||
            !((conductivityWPerMK[cell] ?? 0) > 0) ||
            !((conductivityWPerMK[neighbour] ?? 0) > 0)
          ) {
            continue;
          }
          componentOf[neighbour] = id;
          queue[tail] = neighbour;
          tail += 1;
        }
      }
    }
  }

  // The anchors each component touches.
  const anchored = new Uint8Array(components);
  for (const face of thermalExposedFaces(grid)) {
    const resolved = resolveThermalFace(face, ambient, faceConditions);
    let isAnchor = false;
    if (resolved.kind === "dirichlet") {
      isAnchor = (conductivityWPerMK[face.cell] ?? 0) > 0;
    } else if (resolved.kind === "ambient") {
      isAnchor =
        resolved.heatTransferCoefficientWPerM2K > 0 ||
        (radiationMode !== "off" &&
          (resolved.emissivityOverride ?? emissivity[face.cell] ?? 0) > 0);
    }
    if (isAnchor) anchored[componentOf[face.cell] ?? 0] = 1;
  }

  // The unanchored components, named by their first cell.
  const representative = new Int32Array(components).fill(-1);
  let unanchored = 0;
  for (let cell = 0; cell < cellCount; cell += 1) {
    if (grid.solid[cell] !== 1) continue;
    const id = componentOf[cell] ?? -1;
    if (anchored[id] === 1 || (representative[id] ?? -1) >= 0) continue;
    representative[id] = cell;
    unanchored += 1;
  }
  if (unanchored === 0) return undefined;
  const firstCells: number[] = [];
  for (let id = 0; id < components; id += 1) {
    const cell = representative[id];
    if (cell !== undefined && cell >= 0) firstCells.push(cell);
  }
  return simError(
    SIM_ERROR_CODES.scenarioInvalid,
    `The steady problem's solid region has ${String(unanchored)} component(s) with no temperature anchor (first cell(s) ${firstCells.join(", ")}): an anchored boundary elsewhere cannot reach them across zero conductance, and every boundary they touch is adiabatic, non-conducting, or a net-zero enclosure, so no unique equilibrium exists for their heat to settle against — the door declines instead of holding their initial field and reporting it as converged.`,
    { unanchoredComponents: unanchored, firstCells },
  );
}

/** The built problem plus the facts the report needs. */
interface BuiltProblem {
  readonly problem: ThermalProblem;
  readonly grid: ThermalCellGrid;
  readonly faceConditions: Readonly<
    Partial<Record<SimDomainFace, ThermalSurfaceCondition>>
  >;
}

/** Validates the scenario and builds the solver problem (the one door). */
function buildThermalProblem(
  scenario: ThermalRunScenario,
): SimParseResult<BuiltProblem, SimError> {
  // The door re-reads every authored field through typed locals — the
  // one destructuring site the validations below share.
  const materials: readonly ThermalSolidMaterial[] = scenario.materials;
  const cellMaterialIndex: Uint16Array = scenario.cellMaterialIndex;
  if (typeof scenario.name !== "string" || scenario.name.length === 0) {
    return refuse(
      "A thermal run scenario must carry a non-empty name.",
      scenario.name,
    );
  }
  const classified = thermalCellGrid(scenario.grid);
  if (!classified.ok) return classified;
  const grid = classified.value;
  const cellCount = grid.nx * grid.ny * grid.nz;

  if (!Array.isArray(scenario.materials) || scenario.materials.length === 0) {
    return refuse(
      "A thermal run scenario must select at least one material.",
      scenario.materials,
    );
  }
  if (scenario.materials.length > 65535) {
    return refuse(
      "A thermal run scenario's material selection exceeds the 65535 records the per-cell index can address.",
      scenario.materials.length,
    );
  }
  for (const material of materials) {
    const conductivity = material.thermalConductivityWPerMK;
    if (
      typeof conductivity !== "number" ||
      !Number.isFinite(conductivity) ||
      conductivity < 0
    ) {
      return refuse(
        `The material "${material.id}" carries no valid thermal conductivity; the conduction solve declines instead of fabricating one.`,
        material,
      );
    }
  }
  if (
    !(cellMaterialIndex instanceof Uint16Array) ||
    cellMaterialIndex.length !== cellCount
  ) {
    return refuse(
      `A thermal run scenario's per-cell material index must be a Uint16Array of exactly the grid's cell count (${String(cellCount)}).`,
      cellMaterialIndex?.length,
    );
  }
  const conductivityWPerMK = new Float64Array(cellCount).fill(Number.NaN);
  const volumetricHeatCapacityJPerM3K = new Float64Array(cellCount).fill(
    Number.NaN,
  );
  const emissivity = new Float64Array(cellCount).fill(Number.NaN);
  const missingRhoC = new Set<string>();
  for (let cell = 0; cell < cellCount; cell += 1) {
    const index = cellMaterialIndex[cell] ?? 0;
    if (grid.solid[cell] !== 1) {
      if (index !== 0) {
        return refuse(
          "A fluid cell carries a material index; the per-cell map assigns materials to solid cells only, and a stray assignment is a lie the door refuses.",
          cell,
        );
      }
      continue;
    }
    if (index < 1 || index > materials.length) {
      return refuse(
        `A solid cell's material index (${String(index)}) does not address one of the ${String(materials.length)} selected materials.`,
        index,
      );
    }
    const material = materials[index - 1];
    if (material === undefined) {
      return refuse(
        "A solid cell's material index addresses no material.",
        index,
      );
    }
    conductivityWPerMK[cell] = material.thermalConductivityWPerMK;
    if (material.volumetricHeatCapacityJPerM3K !== undefined) {
      volumetricHeatCapacityJPerM3K[cell] =
        material.volumetricHeatCapacityJPerM3K;
    } else {
      missingRhoC.add(material.id);
    }
    if (material.emissivity !== undefined) {
      emissivity[cell] = material.emissivity;
    }
  }
  if (scenario.mode.kind === "transient" && missingRhoC.size > 0) {
    return refuse(
      `The transient march needs ρc on every solid cell; the material record(s) ${[...missingRhoC].join(", ")} carry no specific heat, and the door declines instead of fabricating a capacity.`,
      [...missingRhoC],
    );
  }

  const faceConditions: Partial<
    Record<SimDomainFace, ThermalSurfaceCondition>
  > = {};
  for (const entry of scenario.conditions ?? []) {
    if (!isPlainRecord(entry)) {
      return refuse(
        "A thermal condition must be a plain object with kind and face fields.",
        entry,
      );
    }
    const validated = conditionProblem(entry);
    if (!validated.ok) return validated;
    if (faceConditions[validated.value.face] !== undefined) {
      return refuse(
        `Two thermal conditions address the ${validated.value.face} domain face; one face carries one condition.`,
        validated.value.face,
      );
    }
    faceConditions[validated.value.face] = validated.value.condition;
  }

  if (scenario.ambient !== undefined) {
    const problem = ambientProblem(scenario.ambient);
    if (problem !== undefined) return simFail(problem);
  }

  if (
    typeof scenario.radiationMode !== "string" ||
    !THERMAL_RADIATION_MODES.includes(scenario.radiationMode)
  ) {
    return refuse(
      `A thermal run scenario's radiation mode must be one of ${THERMAL_RADIATION_MODES.join(", ")}.`,
      scenario.radiationMode,
    );
  }

  if (
    !Number.isFinite(scenario.characteristicLengthM) ||
    scenario.characteristicLengthM <= 0
  ) {
    return refuse(
      `A thermal run scenario's characteristic length must be a positive finite number of metres, received ${String(scenario.characteristicLengthM)}.`,
      scenario.characteristicLengthM,
    );
  }

  const sourceWPerM3 = new Float64Array(cellCount);
  if (scenario.sourceWPerM3 !== undefined) {
    if (
      !(scenario.sourceWPerM3 instanceof Float64Array) ||
      scenario.sourceWPerM3.length !== cellCount
    ) {
      return refuse(
        `A thermal run scenario's source field must be a Float64Array of exactly the grid's cell count (${String(cellCount)}).`,
        scenario.sourceWPerM3?.length,
      );
    }
    for (let cell = 0; cell < cellCount; cell += 1) {
      const value = scenario.sourceWPerM3[cell] ?? 0;
      if (!Number.isFinite(value)) {
        return refuse(
          `A thermal run scenario's source field must be finite everywhere, cell ${String(cell)} is not.`,
          value,
        );
      }
      if (grid.solid[cell] !== 1 && value !== 0) {
        return refuse(
          "A thermal run scenario's source field may only heat solid cells; a fluid-cell source is 65b's coupling, not this phase's.",
          cell,
        );
      }
      sourceWPerM3[cell] = value;
    }
  }

  const radiationReferenceK =
    scenario.radiationReferenceK ?? scenario.mode.initialTemperatureK ?? 293.15;
  if (!Number.isFinite(radiationReferenceK) || radiationReferenceK <= 0) {
    return refuse(
      `A thermal run scenario's radiation reference temperature must be positive finite kelvin, received ${String(radiationReferenceK)}.`,
      radiationReferenceK,
    );
  }

  const problem: ThermalProblem = {
    grid,
    conductivityWPerMK,
    volumetricHeatCapacityJPerM3K,
    emissivity,
    sourceWPerM3,
    ambient: scenario.ambient,
    faceConditions,
    radiationMode: scenario.radiationMode,
    radiationReferenceK,
  };

  // The emissivity completeness door: every radiating face must resolve
  // an emissivity (the condition's override or the material's field).
  if (scenario.radiationMode !== "off") {
    const missing = new Set<string>();
    for (const face of thermalExposedFaces(grid)) {
      const resolved = resolveThermalFace(
        face,
        scenario.ambient,
        faceConditions,
      );
      if (resolved.kind !== "ambient" && resolved.kind !== "enclosure") {
        continue;
      }
      const override =
        resolved.kind === "ambient" ? resolved.emissivityOverride : undefined;
      if (override !== undefined) continue;
      if (Number.isNaN(emissivity[face.cell] ?? Number.NaN)) {
        const index = cellMaterialIndex[face.cell] ?? 0;
        const material = materials[index - 1];
        missing.add(material === undefined ? "unknown" : material.id);
      }
    }
    if (missing.size > 0) {
      return refuse(
        `Radiation is on but the material record(s) ${[...missing].join(", ")} carry no emissivity field; §7.12's physics declines loudly instead of guessing one.`,
        [...missing],
      );
    }
  }

  // The steady anchor door, PER CONNECTED COMPONENT: an anchor anywhere
  // in the domain does not reach an island across zero conductance —
  // without an anchor on its OWN boundary a component has no unique
  // equilibrium (its singular rows would park at the initial field and
  // the solver would report residual ≈ 0: a fabricated success).
  if (scenario.mode.kind === "steady") {
    const anchorProblem = steadyAnchorProblem(
      grid,
      conductivityWPerMK,
      emissivity,
      scenario.ambient,
      faceConditions,
      problem.radiationMode,
    );
    if (anchorProblem !== undefined) return simFail(anchorProblem);
  }

  return simOk({ problem, grid, faceConditions });
}

/** The S9 numbers, computed exactly as the 61a compile boundary computes them. */
function thermalRegimeReport(
  scenario: ThermalRunScenario,
): SimParseResult<SimRegimeReport, SimError> {
  const fluid = scenario.fluid;
  const prandtl = simPrandtl(
    fluid.dynamicViscosityPaS,
    fluid.specificHeatJPerKgK,
    fluid.thermalConductivityWPerMK,
  );
  const gravity = scenario.gravityMPerS2 ?? [0, -9.80665, 0];
  const gravityMagnitude = Math.sqrt(
    gravity[0] ** 2 + gravity[1] ** 2 + gravity[2] ** 2,
  );
  // The 61a magnitude rule, restated verbatim: the largest unsigned
  // |T − T_ref| across the temperature-bearing conditions, so a cold
  // wall ordered first cannot shrink a later warm wall's scale.
  let deltaTemperatureK: number | undefined;
  for (const entry of scenario.conditions ?? []) {
    const candidates =
      entry.kind === "fixed-temperature"
        ? [entry.temperatureK]
        : entry.kind === "convection-ambient"
          ? [entry.ambientTemperatureK]
          : [];
    for (const temperatureK of candidates) {
      const magnitude = Math.abs(temperatureK - fluid.temperatureK);
      deltaTemperatureK = Math.max(deltaTemperatureK ?? 0, magnitude);
    }
  }
  return simOk(
    simRegimeReport({
      prandtl,
      ...(gravityMagnitude > 0 &&
      deltaTemperatureK !== undefined &&
      deltaTemperatureK > 0
        ? {
            rayleigh: simRayleigh(
              gravityMagnitude,
              fluid.thermalExpansionPerK,
              deltaTemperatureK,
              scenario.characteristicLengthM,
              fluid.kinematicViscosityM2PerS,
              fluid.thermalDiffusivityM2PerS,
            ),
          }
        : {}),
    }),
  );
}

/** The standalone snapshot identity: the driver's canonical view of the scenario. */
function runScenarioIdentity(scenario: ThermalRunScenario): unknown {
  return {
    name: scenario.name,
    radiationMode: scenario.radiationMode,
    radiationReferenceK:
      scenario.radiationReferenceK ??
      scenario.mode.initialTemperatureK ??
      293.15,
    characteristicLengthM: scenario.characteristicLengthM,
    gravityMPerS2: scenario.gravityMPerS2 ?? [0, -9.80665, 0],
    mode: scenario.mode,
    grid: {
      shape: scenario.grid.shape,
      originM: scenario.grid.originM,
      spacingM: scenario.grid.spacingM,
      cells: Array.from(scenario.grid.cells),
    },
    materials: scenario.materials,
    cellMaterialIndex: Array.from(scenario.cellMaterialIndex),
    ...(scenario.ambient === undefined ? {} : { ambient: scenario.ambient }),
    conditions: scenario.conditions ?? [],
    sourceWPerM3:
      scenario.sourceWPerM3 === undefined
        ? undefined
        : Array.from(scenario.sourceWPerM3),
    fluidId: scenario.fluid.fluidId,
    fluidTemperatureK: scenario.fluid.temperatureK,
  };
}

/**
 * Runs one thermal scenario to its mode's end: validates and builds the
 * problem, computes or rides the S9 report, hashes the provenance,
 * solves (the steady Picard/solve loop or the transient march), audits
 * the final
 * field, and assembles the report. Deterministic end to end.
 */
export function runThermalScenario(
  scenario: ThermalRunScenario,
): SimParseResult<ThermalRunReport, SimError> {
  const built = buildThermalProblem(scenario);
  if (!built.ok) return built;
  const { problem, grid } = built.value;

  let regime: SimRegimeReport;
  if (scenario.regime !== undefined) {
    regime = scenario.regime;
  } else {
    const computed = thermalRegimeReport(scenario);
    if (!computed.ok) return computed;
    regime = computed.value;
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

  let mode: ThermalSteadyOutcome | ThermalTransientOutcome;
  if (scenario.mode.kind === "steady") {
    const spec: SimParseResult<ResolvedThermalSteadySpec, SimError> =
      resolveThermalSteadySpec(scenario.mode);
    if (!spec.ok) return spec;
    const solved = solveThermalSteady(problem, spec.value);
    if (!solved.ok) return solved;
    mode = solved.value;
  } else {
    const spec: SimParseResult<ResolvedThermalTransientSpec, SimError> =
      resolveThermalTransientSpec(scenario.mode);
    if (!spec.ok) return spec;
    const marched = marchThermalTransient(problem, spec.value);
    if (!marched.ok) return marched;
    mode = marched.value;
  }

  const temperatureK = mode.temperatureK;
  const balance = thermalBoundaryFluxLedger({ problem, temperatureK });
  const enclosures = thermalEnclosureFacts(problem, temperatureK);

  let minK = Number.POSITIVE_INFINITY;
  let maxK = Number.NEGATIVE_INFINITY;
  let sum = 0;
  let count = 0;
  for (let cell = 0; cell < temperatureK.length; cell += 1) {
    if (grid.solid[cell] !== 1) continue;
    const value = temperatureK[cell] ?? 0;
    if (value < minK) minK = value;
    if (value > maxK) maxK = value;
    sum += value;
    count += 1;
  }
  const temperatures: ThermalRunTemperatures = {
    minK,
    maxK,
    meanK: count > 0 ? sum / count : scenario.fluid.temperatureK,
  };

  const ambientFillK =
    scenario.ambient?.ambientTemperatureK ?? scenario.fluid.temperatureK;
  const enclosureK = new Map<number, number>();
  for (const enclosure of enclosures) {
    enclosureK.set(enclosure.id, enclosure.temperatureK);
  }
  const values: number[] = [];
  for (let cell = 0; cell < temperatureK.length; cell += 1) {
    if (grid.solid[cell] === 1) {
      values.push(temperatureK[cell] ?? 0);
      continue;
    }
    const enclosure = grid.cavityOf[cell] ?? -1;
    const enclosureTemperature =
      enclosure >= 0 ? enclosureK.get(enclosure) : undefined;
    // The stated coarse fill: fluid cells carry the ambient (or, inside
    // a cavity, the enclosure radiosity) temperature until 65b's
    // conjugate coupling solves them. A NON-EXCHANGING enclosure (every
    // wall ε = 0 → Σ εA = 0 → the radiosity quotient is 0/0 = NaN)
    // carries no radiosity temperature at all — the NaN must not poison
    // the field (the S4 seam would decline a legitimate solve as
    // `sim/quantity-invalid`), so the cavity falls back to the ambient
    // fill. `??` alone does not catch NaN; the finiteness guard does.
    values.push(
      enclosureTemperature !== undefined &&
        Number.isFinite(enclosureTemperature)
        ? enclosureTemperature
        : ambientFillK,
    );
  }
  const temperatureField: SolverSimField = {
    id: "temperature",
    unit: "K",
    extent: [grid.nx, grid.ny, grid.nz],
    originM: scenario.grid.originM,
    spacingM: scenario.grid.spacingM,
    dataType: "float64",
    values,
    dimension: "temperature",
  };

  const diverged = mode.kind === "transient" && mode.diverged;
  return simOk({
    scenarioName: scenario.name,
    scenarioSnapshotHash: snapshotHash,
    regime,
    grid: {
      nx: grid.nx,
      ny: grid.ny,
      nz: grid.nz,
      spacingM: grid.spacingM,
    },
    mode,
    temperatures,
    balance,
    enclosures,
    temperatureField: diverged ? null : temperatureField,
    histories: mode.kind === "transient" ? mode.histories : [],
    diverged,
  });
}

/** The projected field blocks a completed run persists (empty on divergence). */
function reportFields(
  report: ThermalRunReport,
): SimParseResult<readonly SimResultFieldBlock[], SimError> {
  if (report.temperatureField === null) return simOk([]);
  const projected = projectSimResult({
    scalars: [],
    fields: [report.temperatureField],
  });
  if (!projected.ok) return projected;
  return simOk(projected.value.fields);
}

/**
 * Assembles the persistence-fit {@link SimResult}: the summary (schema
 * version, snapshot hash, status, the S9 regime fields, the projected
 * quantities with explicit units — S4's "mm at the doors" for the
 * field geometry, kelvin for the temperatures), the projected
 * temperature field block, and the transient histories. A diverged
 * march persists as a FAILED result carrying `sim/run-diverged` — the
 * field and quantities withheld, histories kept as the honest record.
 */
export function thermalRunSimResult(
  report: ThermalRunReport,
): SimParseResult<SimResult, SimError> {
  const scalars: SolverSimScalar[] = [];
  const balance = report.balance;
  if (!report.diverged) {
    scalars.push(
      {
        name: "max-temperature",
        dimension: "temperature",
        value: report.temperatures.maxK,
      },
      {
        name: "min-temperature",
        dimension: "temperature",
        value: report.temperatures.minK,
      },
      {
        name: "mean-temperature",
        dimension: "temperature",
        value: report.temperatures.meanK,
      },
      { name: "source-power", dimension: "power", value: balance.sourceW },
      {
        name: "convection-heat-out",
        dimension: "power",
        value: balance.convectionOutW,
      },
      {
        name: "radiation-heat-out",
        dimension: "power",
        value: balance.radiationOutW,
      },
      {
        name: "dirichlet-heat-net",
        dimension: "power",
        value: balance.dirichletNetW,
      },
      {
        name: "neumann-heat-in",
        dimension: "power",
        value: balance.neumannInW,
      },
      { name: "net-heat-imbalance", dimension: "power", value: balance.netW },
      {
        name: "full-law-imbalance",
        dimension: "power",
        value: balance.fullLawNetW,
      },
    );
    for (const enclosure of report.enclosures) {
      if (!Number.isFinite(enclosure.temperatureK)) continue;
      scalars.push({
        name: `enclosure-${String(enclosure.id)}-temperature`,
        dimension: "temperature",
        value: enclosure.temperatureK,
      });
    }
    if (report.mode.kind === "steady") {
      scalars.push(
        {
          name: "solver-iterations",
          dimension: "dimensionless",
          value: report.mode.iterations,
        },
        {
          name: "solver-residual",
          dimension: "temperatureDifference",
          value: report.mode.residualK,
        },
        {
          name: "picard-iterations",
          dimension: "dimensionless",
          value: report.mode.outerIterations,
        },
      );
    } else {
      scalars.push(
        {
          name: "physical-duration",
          dimension: "time",
          value: report.mode.physicalDurationS,
        },
        {
          name: "march-steps",
          dimension: "dimensionless",
          value: report.mode.internalSteps,
        },
        {
          name: "stored-energy",
          dimension: "energy",
          value: report.mode.cumulative.storedJ,
        },
        {
          name: "energy-closure",
          dimension: "energy",
          value: report.mode.cumulative.closureJ,
        },
      );
    }
  }
  const fields = reportFields(report);
  if (!fields.ok) return fields;
  const projected = projectSimResult({ scalars, fields: [] });
  if (!projected.ok) return projected;
  const divergedMessage = `The transient march's divergence sentinel froze the run of ${report.scenarioName} at ${String(report.mode.kind === "transient" ? report.mode.physicalDurationS : 0)} s; no fields or quantities are reported for a blown-up march.`;
  return simOk({
    summary: {
      schemaVersion: SIM_RESULT_SUMMARY_VERSION,
      scenarioSnapshotHash: report.scenarioSnapshotHash,
      status: report.diverged ? "failed" : "completed",
      regime: report.regime,
      quantities: projected.value.scalars,
      servedBackend: "cpu",
      ...(report.diverged
        ? {
            failureCode: SIM_ERROR_CODES.runDiverged,
            failureMessage: divergedMessage,
          }
        : {}),
    },
    fields: fields.value,
    histories: report.histories,
  });
}
