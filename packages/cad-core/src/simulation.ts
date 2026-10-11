/**
 * Simulation scenarios as document records (Phase 61, ROADMAP-SIM law S1):
 * an additive `simulations` document section carrying {@link SimScenario}
 * rows addressed exactly like configuration rows — named records over the
 * SAME document (deltas, never a second document), added/updated/removed
 * through the document layer with ids enforced at the add boundary and
 * re-enforced at native parse (`docs/architecture/adr-simulation.md`).
 *
 * A scenario is pure simulation INTENT: which physics kind runs, the
 * solution domain (explicit bounds or derived from named bodies), boundary
 * conditions on the domain box faces, the working fluid (a named record of
 * the sim-core fluid property set — cad-core stores the name, sim-core
 * resolves it), per-body solid material assignments (material records live
 * at the consumer layer, so their ids are shape-validated here and
 * existence-checked by the resolver seam), the gravity vector (default
 * standard gravity, −Y), an optional motor selection for fan scenarios
 * (a `motors` document record), and a backend preference (the CPU oracle
 * is the wire-absent default; GPU is a provider hint, never a correctness
 * claim — laws S2/S5).
 *
 * The kind vocabulary reserves `structural` now (Phase 69's carve: the
 * spine lays the vocabulary so Phase 69 never reworks it). A structural
 * scenario is a valid RECORD — it stores, round-trips, and hashes — but
 * compiling it declines with a `sim/*` code until the Phase 69 solver
 * lands; the decline lives at the sim-core compile boundary, not here.
 *
 * Units: the document is canonical millimetres, so lengths (domain
 * bounds, resolution, margins) are mm; velocities are m/s, pressures Pa,
 * temperatures K, forces N — the SI-adjacent units the S4 boundary
 * converts from. Motor records alone author in mN·m and rpm (datasheet
 * units; see `motors.ts`). Serialization is canonical (fixed key order,
 * declaration order preserved) and parsing validates untrusted input
 * strictly with stable `simulation/*` failure codes.
 */

import { type MaterialId, parseMaterialId } from "./document-mass";
import {
  type BodyId,
  type MotorId,
  type SimulationId,
  parseBodyId,
  parseMotorId,
  parseSimulationId,
} from "./ids";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/** A finite [x, y, z] triple in the scenario's documented units. */
export type SimVec3 = readonly [number, number, number];

/**
 * The scenario kinds (Phase 61 carve; `structural` is reserved for Phase 69
 * and declines at the sim-core compile boundary until that phase lands).
 */
export const SIM_SCENARIO_KINDS = ["flow", "thermal", "structural"] as const;

export type SimScenarioKind = (typeof SIM_SCENARIO_KINDS)[number];

/**
 * The backend preference vocabulary: the CPU reference kernel is the
 * wire-absent default and always the test truth (law S5); `gpu` is a
 * preference the host may honor with a provider, never a requirement.
 */
export const SIM_BACKEND_PREFERENCES = ["cpu", "gpu"] as const;

export type SimBackendPreference = (typeof SIM_BACKEND_PREFERENCES)[number];

/** The six faces of the solution-domain box a condition may address. */
export const SIM_DOMAIN_FACES = [
  "xMin",
  "xMax",
  "yMin",
  "yMax",
  "zMin",
  "zMax",
] as const;

export type SimDomainFace = (typeof SIM_DOMAIN_FACES)[number];

/**
 * Standard gravity, m/s² (the CGPM defining value) — the default gravity
 * vector's magnitude, directed −Y.
 */
export const STANDARD_GRAVITY_M_PER_S2 = 9.80665;

/** The default gravity vector: standard gravity, −Y. */
export const DEFAULT_SIM_GRAVITY_M_PER_S2: SimVec3 = [
  0,
  -STANDARD_GRAVITY_M_PER_S2,
  0,
];

/**
 * The solution domain: explicit axis-aligned bounds in canonical mm plus a
 * target cell size, or derived from named bodies' bounds plus a margin and
 * a target cell size (the voxelizer resolves the bounds at run time; the
 * record carries the intent).
 */
export type SimScenarioDomain =
  | {
      readonly kind: "explicit";
      /** The domain box's minimum corner, mm. */
      readonly min: SimVec3;
      /** The domain box's maximum corner, mm (strictly greater on every axis). */
      readonly max: SimVec3;
      /** The target voxel/cell size, mm (strictly positive). */
      readonly resolutionMm: number;
    }
  | {
      readonly kind: "body";
      /** The bodies whose combined bounds (plus margin) form the domain. */
      readonly bodyIds: readonly BodyId[];
      /** The margin around the combined body bounds, mm (non-negative). */
      readonly marginMm: number;
      readonly resolutionMm: number;
    };

/**
 * One boundary condition on one domain-box face. The flow set (inlet,
 * outlet, wall, symmetry — the Phase 63 wind-tunnel vocabulary) is allowed
 * on flow AND thermal scenarios (conjugate heat transfer has a flow side);
 * the thermal set (Phase 65) and the structural set (Phase 69, fixtures
 * and loads) are kind-locked. One condition per face — two conditions on
 * one face is a modeling conflict refused at build time.
 */
export type SimBoundaryCondition =
  | {
      readonly kind: "velocity-inlet";
      readonly face: SimDomainFace;
      /** The inlet speed magnitude, m/s (strictly positive). */
      readonly speedMPerS: number;
      /** The inflow direction (any finite non-zero vector; normalized at compile). */
      readonly direction: SimVec3;
    }
  | {
      readonly kind: "pressure-outlet";
      readonly face: SimDomainFace;
      /** The outlet static (gauge) pressure, Pa. */
      readonly pressurePa: number;
    }
  | {
      readonly kind: "wall";
      readonly face: SimDomainFace;
      /** `true` for a slip wall, `false` for no-slip. */
      readonly slip: boolean;
    }
  | { readonly kind: "symmetry"; readonly face: SimDomainFace }
  | {
      readonly kind: "fixed-temperature";
      readonly face: SimDomainFace;
      /** The prescribed wall temperature, K (strictly positive). */
      readonly temperatureK: number;
    }
  | {
      readonly kind: "heat-flux";
      readonly face: SimDomainFace;
      /** The prescribed heat flux, W/m² (positive into the domain). */
      readonly fluxWPerM2: number;
    }
  | {
      readonly kind: "convection-ambient";
      readonly face: SimDomainFace;
      /** The external convection coefficient, W/(m²·K) (strictly positive). */
      readonly heatTransferCoefficientWPerM2K: number;
      /** The ambient temperature, K (strictly positive). */
      readonly ambientTemperatureK: number;
      /** The surface emissivity [0, 1]; absent = no radiation loss. */
      readonly emissivity?: number;
    }
  | { readonly kind: "fixed-support"; readonly face: SimDomainFace }
  | {
      readonly kind: "force-load";
      readonly face: SimDomainFace;
      /** The applied force vector, N. */
      readonly forceN: SimVec3;
    }
  | {
      readonly kind: "pressure-load";
      readonly face: SimDomainFace;
      /** The applied pressure, Pa (positive pushes on the face). */
      readonly pressurePa: number;
    };

/** Which scenario kinds each condition kind may ride on. */
export const SIM_CONDITION_KIND_SCENARIOS: Readonly<
  Record<SimBoundaryCondition["kind"], readonly SimScenarioKind[]>
> = Object.freeze({
  "velocity-inlet": Object.freeze(["flow", "thermal"] as const),
  "pressure-outlet": Object.freeze(["flow", "thermal"] as const),
  wall: Object.freeze(["flow", "thermal"] as const),
  symmetry: Object.freeze(["flow", "thermal"] as const),
  "fixed-temperature": Object.freeze(["thermal"] as const),
  "heat-flux": Object.freeze(["thermal"] as const),
  "convection-ambient": Object.freeze(["thermal"] as const),
  "fixed-support": Object.freeze(["structural"] as const),
  "force-load": Object.freeze(["structural"] as const),
  "pressure-load": Object.freeze(["structural"] as const),
});

/** One solid material assignment: a document body, a consumer-layer material. */
export interface SimMaterialAssignment {
  readonly bodyId: BodyId;
  readonly materialId: MaterialId;
}

/**
 * The Stefan–Boltzmann treatments a thermal scenario may request for its
 * radiating surfaces (Phase 65, §7.12): `off` (conduction/convection
 * only), `linearized` (the standard solver-friendly slope), `full` (the
 * exact quartic law, Picard-lagged).
 */
export const SIM_THERMAL_RADIATION_MODES = [
  "off",
  "linearized",
  "full",
] as const;

export type SimThermalRadiationMode =
  (typeof SIM_THERMAL_RADIATION_MODES)[number];

/** The solve stances a thermal scenario may take (Phase 65). */
export const SIM_THERMAL_SOLVE_MODES = ["steady", "transient"] as const;

export type SimThermalSolveMode = (typeof SIM_THERMAL_SOLVE_MODES)[number];

/**
 * The rotating-machinery kinds a flow scenario's 3D stance can select
 * (Phase 66): MRF — the honest steady-fan default — or resolved
 * rotation — the immersed moving-boundary showcase.
 */
export const SIM_FLOW3D_ROTATION_KINDS = ["mrf", "resolved-rotation"] as const;

export type SimFlow3dRotationKind = (typeof SIM_FLOW3D_ROTATION_KINDS)[number];

/**
 * How a rotating scenario's shaft speed is set (Phase 66): a fixed
 * authored rpm (motor-less scenarios), or the motor-driven operating
 * point — the sim solves T_motor(ω) = T_load(ω) against the selected
 * `motors` record instead of assuming a speed.
 */
export const SIM_FLOW3D_RPM_MODES = ["fixed", "motor"] as const;

export type SimFlow3dRpmMode = (typeof SIM_FLOW3D_RPM_MODES)[number];

/**
 * The boundary treatments the 3D stance vocabulary reserves (Phase 66c,
 * the cut-cell decision): `staircase` is the implemented law-S3
 * treatment; `cut-cell` is a RESERVED record value — it stores and
 * round-trips here, and the sim-core compile boundary declines it
 * loudly (`sim/boundary-treatment-unsupported`) until a dedicated
 * cut-cell phase exists, exactly the `structural` carve's discipline.
 */
export const SIM_FLOW3D_BOUNDARY_TREATMENTS = [
  "staircase",
  "cut-cell",
] as const;

export type SimFlow3dBoundaryTreatment =
  (typeof SIM_FLOW3D_BOUNDARY_TREATMENTS)[number];

/**
 * A thermal scenario's solve stance (Phase 65c, law S1-additive): the
 * radiation mode, the steady-vs-transient choice with its budget, the
 * heat source, the ambient equilibrium boundary, and whether the
 * transient run couples to the fluid (the conjugate buoyant march).
 * Required on `thermal` scenarios, refused on every other kind — one
 * shape, one truth. Units are the SI-adjacent authoring units (K, W,
 * W/(m²·K), s); the source is W per metre of the 2D slice's depth, the
 * unit-depth slab convention the solver package documents.
 */
export interface SimScenarioThermalSpec {
  readonly radiationMode: SimThermalRadiationMode;
  readonly solveMode: SimThermalSolveMode;
  /**
   * Whether the transient run couples to the fluid domain — the
   * conjugate buoyant march (Phase 65b). Steady scenarios refuse the
   * flag: the coupled march is transient by construction.
   */
  readonly cht: boolean;
  /** The volumetric heat source's TOTAL power, W per metre of depth (> 0). */
  readonly sourceW: number;
  /** The uniform initial field, K (> 0); also the ambient reference. */
  readonly initialTemperatureK: number;
  /**
   * The equilibrium boundary's external convection coefficient h,
   * W/(m²·K) (≥ 0) — §7.12's authored h for exposed faces facing the
   * domain's fluid, alongside the radiation mode's loss.
   */
  readonly ambientConvectionWPerM2K: number;
  /** The transient march's physical end time, s (> 0); required iff transient. */
  readonly durationS?: number;
  /** The history/field sampling cadence, s (> 0); required iff transient. */
  readonly sampleIntervalS?: number;
}

/** Canonical JSON form of a thermal spec; fixed key order, optionals last. */
export interface SerializedSimScenarioThermalSpec {
  readonly radiationMode: SimThermalRadiationMode;
  readonly solveMode: SimThermalSolveMode;
  readonly cht: boolean;
  readonly sourceW: number;
  readonly initialTemperatureK: number;
  readonly ambientConvectionWPerM2K: number;
  readonly durationS?: number;
  readonly sampleIntervalS?: number;
}

/**
 * The rotation half of a flow scenario's 3D stance (Phase 66): the
 * machinery kind, the shaft axis (document millimetres — the S4
 * boundary converts), the rotating zone's radius (the cylinder that
 * encloses the rotor, the MRF frame region and the resolved rotor's
 * extent alike), the speed stance (fixed rpm or the motor-driven
 * operating point), and the authored blade count the BPF arithmetic
 * consumes. `fixedRpm` is required exactly when the mode is `fixed`
 * and refused otherwise, the `durationS`-iff-transient rule's shape.
 */
export interface SimScenarioFlow3dRotation {
  readonly kind: SimFlow3dRotationKind;
  /** One point on the shaft axis, mm (document space). */
  readonly axisPointMm: SimVec3;
  /** The axis direction, unnormalized, non-zero (any finite triple). */
  readonly axisDirection: SimVec3;
  /** The rotating zone's radius about the axis, mm (strictly positive). */
  readonly zoneRadiusMm: number;
  readonly rpmMode: SimFlow3dRpmMode;
  /** The fixed shaft rate, rpm (strictly positive); required iff fixed mode. */
  readonly fixedRpm?: number;
  /** The authored blade count (BPF = blades × rpm — a scenario field). */
  readonly bladeCount: number;
}

/**
 * A flow scenario's 3D stance (Phase 66c, law S1-additive): opts the
 * scenario into the 3D flow engine — the D3Q19 CPU oracle, and for
 * rotating scenarios the MRF/resolved-rotation paths. Absent on a flow
 * scenario the run stays the 2D wind tunnel (the slice discipline);
 * present, the 2D engine declines it loudly and the routed engine
 * serves the 3D domain (the same record vocabulary's honest fork).
 * Required on no other kind — the stance is the flow kind's alone.
 */
export interface SimScenarioFlow3dSpec {
  /**
   * The boundary treatment (law S3): `staircase` (the default) or the
   * reserved `cut-cell` — see {@link SIM_FLOW3D_BOUNDARY_TREATMENTS}.
   */
  readonly boundaryTreatment?: SimFlow3dBoundaryTreatment;
  /** The rotating machinery; absent = the static 3D external-flow door. */
  readonly rotation?: SimScenarioFlow3dRotation;
}

/** Canonical JSON form of the 3D stance; fixed key order, optionals last. */
export interface SerializedSimScenarioFlow3dSpec {
  readonly boundaryTreatment?: SimFlow3dBoundaryTreatment;
  readonly rotation?: {
    readonly kind: SimFlow3dRotationKind;
    readonly axisPointMm: readonly [number, number, number];
    readonly axisDirection: readonly [number, number, number];
    readonly zoneRadiusMm: number;
    readonly rpmMode: SimFlow3dRpmMode;
    readonly fixedRpm?: number;
    readonly bladeCount: number;
  };
}

function isSimThermalRadiationMode(
  input: unknown,
): input is SimThermalRadiationMode {
  return (
    typeof input === "string" &&
    SIM_THERMAL_RADIATION_MODES.includes(input as SimThermalRadiationMode)
  );
}

function isSimThermalSolveMode(input: unknown): input is SimThermalSolveMode {
  return (
    typeof input === "string" &&
    SIM_THERMAL_SOLVE_MODES.includes(input as SimThermalSolveMode)
  );
}

function isSimFlow3dRotationKind(
  input: unknown,
): input is SimFlow3dRotationKind {
  return (
    typeof input === "string" &&
    SIM_FLOW3D_ROTATION_KINDS.includes(input as SimFlow3dRotationKind)
  );
}

function isSimFlow3dRpmMode(input: unknown): input is SimFlow3dRpmMode {
  return (
    typeof input === "string" &&
    SIM_FLOW3D_RPM_MODES.includes(input as SimFlow3dRpmMode)
  );
}

function isSimFlow3dBoundaryTreatment(
  input: unknown,
): input is SimFlow3dBoundaryTreatment {
  return (
    typeof input === "string" &&
    SIM_FLOW3D_BOUNDARY_TREATMENTS.includes(input as SimFlow3dBoundaryTreatment)
  );
}

/**
 * Parses the 3D stance, kind-locked: any kind but `flow` carrying one
 * declines (the stance is the flow kind's alone), and a rotation's own
 * fields are cross-checked (fixed rpm exactly when the fixed mode).
 */
function parseFlow3dSpec(
  input: unknown,
  kind: SimScenarioKind,
): ParseResult<SimScenarioFlow3dSpec | undefined, SimulationError> {
  if (input === undefined || input === null) {
    return ok(undefined);
  }
  if (kind !== "flow") {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.flow3dSpecInvalid,
        `A "${kind}" scenario cannot carry a 3D flow stance; it is the flow kind's alone.`,
        input,
      ),
    );
  }
  if (!isPlainRecord(input)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.flow3dSpecInvalid,
        "A 3D flow stance must be an object with an optional rotation field.",
        input,
      ),
    );
  }
  let boundaryTreatment: SimFlow3dBoundaryTreatment | undefined;
  if (
    input.boundaryTreatment !== undefined &&
    input.boundaryTreatment !== null
  ) {
    if (!isSimFlow3dBoundaryTreatment(input.boundaryTreatment)) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.flow3dSpecInvalid,
          `A 3D flow stance's boundary treatment must be one of: ${SIM_FLOW3D_BOUNDARY_TREATMENTS.join(", ")}.`,
          input.boundaryTreatment,
        ),
      );
    }
    boundaryTreatment = input.boundaryTreatment;
  }
  if (input.rotation === undefined || input.rotation === null) {
    return ok(
      Object.freeze(
        boundaryTreatment === undefined ? {} : { boundaryTreatment },
      ),
    );
  }
  const rotation = input.rotation;
  if (!isPlainRecord(rotation)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.flow3dSpecInvalid,
        "A 3D stance's rotation must be an object with kind, axis, zone, mode, and blade fields.",
        rotation,
      ),
    );
  }
  if (!isSimFlow3dRotationKind(rotation.kind)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.flow3dSpecInvalid,
        `A 3D stance's rotation kind must be one of: ${SIM_FLOW3D_ROTATION_KINDS.join(", ")}.`,
        rotation.kind,
      ),
    );
  }
  const axisPointMm = parseVec3(
    rotation.axisPointMm,
    SIMULATION_ERROR_CODES.flow3dSpecInvalid,
    "A 3D stance's rotation axis point",
  );
  if (!axisPointMm.ok) return axisPointMm;
  const axisDirection = parseVec3(
    rotation.axisDirection,
    SIMULATION_ERROR_CODES.flow3dSpecInvalid,
    "A 3D stance's rotation axis direction",
  );
  if (!axisDirection.ok) return axisDirection;
  if (axisDirection.value.every((component) => component === 0)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.flow3dSpecInvalid,
        "A 3D stance's rotation axis direction must be non-zero.",
        rotation.axisDirection,
      ),
    );
  }
  const zoneRadiusMm = parsePositiveNumber(
    rotation.zoneRadiusMm,
    SIMULATION_ERROR_CODES.flow3dSpecInvalid,
    "A 3D stance's rotating zone radius",
  );
  if (!zoneRadiusMm.ok) return zoneRadiusMm;
  if (!isSimFlow3dRpmMode(rotation.rpmMode)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.flow3dSpecInvalid,
        `A 3D stance's rpm mode must be one of: ${SIM_FLOW3D_RPM_MODES.join(", ")}.`,
        rotation.rpmMode,
      ),
    );
  }
  const rpmMode = rotation.rpmMode;
  let fixedRpm: number | undefined;
  if (rpmMode === "fixed") {
    const parsed = parsePositiveNumber(
      rotation.fixedRpm,
      SIMULATION_ERROR_CODES.flow3dSpecInvalid,
      "A fixed-rpm 3D stance's shaft rate",
    );
    if (!parsed.ok) return parsed;
    fixedRpm = parsed.value;
  } else if (rotation.fixedRpm !== undefined && rotation.fixedRpm !== null) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.flow3dSpecInvalid,
        "A motor-driven 3D stance cannot also author a fixed rpm — the operating point solves the speed.",
        rotation.fixedRpm,
      ),
    );
  }
  const bladeCount = rotation.bladeCount;
  if (
    typeof bladeCount !== "number" ||
    !Number.isInteger(bladeCount) ||
    bladeCount < 1
  ) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.flow3dSpecInvalid,
        "A 3D stance's blade count must be a positive integer (the authored field the BPF arithmetic consumes).",
        bladeCount,
      ),
    );
  }
  return ok(
    Object.freeze({
      ...(boundaryTreatment === undefined ? {} : { boundaryTreatment }),
      rotation: Object.freeze({
        kind: rotation.kind,
        axisPointMm: axisPointMm.value,
        axisDirection: axisDirection.value,
        zoneRadiusMm: zoneRadiusMm.value,
        rpmMode,
        ...(fixedRpm === undefined ? {} : { fixedRpm }),
        bladeCount,
      }),
    }),
  );
}

/**
 * Parses the thermal solve stance, kind-locked: a `thermal` scenario
 * without one declines (there is no default physics), and any other
 * kind carrying one declines (the stance is thermal's alone).
 */
function parseThermalSpec(
  input: unknown,
  kind: SimScenarioKind,
): ParseResult<SimScenarioThermalSpec | undefined, SimulationError> {
  if (input === undefined || input === null) {
    if (kind === "thermal") {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.thermalSpecInvalid,
          "A thermal scenario must carry its thermal solve stance (radiation mode, solve mode, source, ambient).",
          input,
        ),
      );
    }
    return ok(undefined);
  }
  if (kind !== "thermal") {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.thermalSpecInvalid,
        `A "${kind}" scenario cannot carry a thermal solve stance; it is the thermal kind's alone.`,
        input,
      ),
    );
  }
  if (!isPlainRecord(input)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.thermalSpecInvalid,
        "A thermal solve stance must be an object with radiationMode and solveMode fields.",
        input,
      ),
    );
  }
  if (!isSimThermalRadiationMode(input.radiationMode)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.thermalSpecInvalid,
        `A thermal solve stance's radiation mode must be one of: ${SIM_THERMAL_RADIATION_MODES.join(", ")}.`,
        input.radiationMode,
      ),
    );
  }
  const radiationMode: SimThermalRadiationMode = input.radiationMode;
  const solveMode = input.solveMode;
  if (!isSimThermalSolveMode(solveMode)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.thermalSpecInvalid,
        `A thermal solve stance's solve mode must be one of: ${SIM_THERMAL_SOLVE_MODES.join(", ")}.`,
        solveMode,
      ),
    );
  }
  if (typeof input.cht !== "boolean") {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.thermalSpecInvalid,
        "A thermal solve stance's conjugate-coupling flag must be a boolean.",
        input.cht,
      ),
    );
  }
  if (solveMode === "steady" && input.cht) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.thermalSpecInvalid,
        "A steady thermal scenario cannot request the conjugate coupled march — the coupling advances in physical time, so it is transient by construction.",
        input,
      ),
    );
  }
  const sourceW = parsePositiveNumber(
    input.sourceW,
    SIMULATION_ERROR_CODES.thermalSpecInvalid,
    "A thermal solve stance's source power",
  );
  if (!sourceW.ok) return sourceW;
  const initialTemperatureK = parsePositiveNumber(
    input.initialTemperatureK,
    SIMULATION_ERROR_CODES.thermalSpecInvalid,
    "A thermal solve stance's initial temperature",
  );
  if (!initialTemperatureK.ok) return initialTemperatureK;
  const ambientConvectionRaw = parseFiniteNumber(
    input.ambientConvectionWPerM2K,
    SIMULATION_ERROR_CODES.thermalSpecInvalid,
    "A thermal solve stance's ambient convection coefficient",
  );
  if (!ambientConvectionRaw.ok) return ambientConvectionRaw;
  if (ambientConvectionRaw.value < 0) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.thermalSpecInvalid,
        "A thermal solve stance's ambient convection coefficient must be non-negative W/(m²·K).",
        input.ambientConvectionWPerM2K,
      ),
    );
  }
  let durationS: number | undefined;
  let sampleIntervalS: number | undefined;
  if (solveMode === "transient") {
    const duration = parsePositiveNumber(
      input.durationS,
      SIMULATION_ERROR_CODES.thermalSpecInvalid,
      "A transient thermal stance's duration",
    );
    if (!duration.ok) return duration;
    const interval = parsePositiveNumber(
      input.sampleIntervalS,
      SIMULATION_ERROR_CODES.thermalSpecInvalid,
      "A transient thermal stance's sample interval",
    );
    if (!interval.ok) return interval;
    const intervals = duration.value / interval.value;
    const sampleCount = Math.round(intervals);
    if (
      sampleCount < 1 ||
      Math.abs(sampleCount * interval.value - duration.value) >
        1e-9 * duration.value
    ) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.thermalSpecInvalid,
          "A transient thermal stance's duration must be an integer multiple of its sample interval so every sample lands on the cadence.",
          { durationS: duration.value, sampleIntervalS: interval.value },
        ),
      );
    }
    durationS = duration.value;
    sampleIntervalS = interval.value;
  }
  return ok(
    Object.freeze({
      radiationMode,
      solveMode,
      cht: input.cht,
      sourceW: sourceW.value,
      initialTemperatureK: initialTemperatureK.value,
      ambientConvectionWPerM2K: ambientConvectionRaw.value,
      ...(durationS === undefined ? {} : { durationS }),
      ...(sampleIntervalS === undefined ? {} : { sampleIntervalS }),
    }),
  );
}

/**
 * The scenario's authored fields (identity aside): everything a
 * {@link SimScenario} carries except its id — the shape the document add
 * path takes and the command payloads ride.
 */
export interface SimScenarioBody {
  /** The scenario's name (1-64 characters after trimming; unique in the document). */
  readonly name: string;
  readonly kind: SimScenarioKind;
  readonly domain: SimScenarioDomain;
  readonly conditions: readonly SimBoundaryCondition[];
  /**
   * The working fluid's name — a named record of the sim-core fluid
   * property set (air, water, glycol). cad-core stores the name;
   * sim-core's compile boundary resolves it (`sim/fluid-unknown`
   * otherwise), so this package hardcodes no fluid registry.
   */
  readonly fluid: string;
  readonly materials: readonly SimMaterialAssignment[];
  /** The gravity vector, m/s² (default standard gravity, −Y). */
  readonly gravityMPerS2: SimVec3;
  /**
   * The flow run's fixed step budget (Phase 63c): a positive integer of
   * lattice steps — a scenario field, never a runtime knob. Absent = the
   * compile boundary's documented default.
   */
  readonly stepBudget?: number;
  /**
   * Whether the run also climbs the factor-2 grid-convergence ladder and
   * reports the drift (Phase 63c's built-in trust indicator, advisory).
   */
  readonly gridConvergence?: boolean;
  /**
   * The thermal solve stance (Phase 65c): required on `thermal`
   * scenarios, refused on every other kind.
   */
  readonly thermal?: SimScenarioThermalSpec;
  /**
   * The 3D flow stance (Phase 66c): present = the 3D engine serves this
   * flow scenario (static external flow, or rotating machinery); absent
   * = the 2D wind tunnel. Refused on every other kind.
   */
  readonly flow3d?: SimScenarioFlow3dSpec;
  /** The selected motor record for fan scenarios; absent = motor-less. */
  readonly motorId?: MotorId;
  /** The backend preference; absent = the CPU default. */
  readonly backend?: SimBackendPreference;
}

/** A simulation scenario record: a {@link SimScenarioBody} with its identity. */
export interface SimScenario extends SimScenarioBody {
  readonly id: SimulationId;
}

/** Input accepted by the document-level {@link addDocumentSimulation}. */
export interface SimScenarioInput {
  readonly id?: SimulationId;
  readonly name: string;
  readonly kind: SimScenarioKind;
  readonly domain: SimScenarioDomain;
  readonly conditions?: readonly SimBoundaryCondition[];
  readonly fluid: string;
  readonly materials?: readonly SimMaterialAssignment[];
  readonly gravityMPerS2?: SimVec3;
  readonly stepBudget?: number;
  readonly gridConvergence?: boolean;
  readonly thermal?: SimScenarioThermalSpec;
  readonly flow3d?: SimScenarioFlow3dSpec;
  readonly motorId?: MotorId;
  readonly backend?: SimBackendPreference;
}

/**
 * The scenario payload a `simulation.create`/`simulation.update` command
 * carries: the authored fields with the same defaults the add path
 * applies (gravity defaults to standard gravity −Y; the backend defaults
 * to the CPU oracle).
 */
export type SimScenarioDraft = Omit<SimScenarioInput, "id">;

/** Stable failure codes produced when scenario input is rejected. */
export const SIMULATION_ERROR_CODES = {
  malformed: "simulation/malformed",
  idInvalid: "simulation/id-invalid",
  nameInvalid: "simulation/name-invalid",
  kindInvalid: "simulation/kind-invalid",
  domainInvalid: "simulation/domain-invalid",
  conditionInvalid: "simulation/condition-invalid",
  conditionKindMismatch: "simulation/condition-kind-mismatch",
  conditionFaceDuplicate: "simulation/condition-face-duplicate",
  fluidInvalid: "simulation/fluid-invalid",
  materialsInvalid: "simulation/materials-invalid",
  gravityInvalid: "simulation/gravity-invalid",
  motorInvalid: "simulation/motor-invalid",
  backendInvalid: "simulation/backend-invalid",
  runControlsInvalid: "simulation/run-controls-invalid",
  thermalSpecInvalid: "simulation/thermal-spec-invalid",
  flow3dSpecInvalid: "simulation/flow3d-spec-invalid",
} as const;

export type SimulationErrorCode =
  (typeof SIMULATION_ERROR_CODES)[keyof typeof SIMULATION_ERROR_CODES];

/** Structured failure describing why scenario input was rejected. */
export interface SimulationError extends ParseFailure {
  readonly code: SimulationErrorCode;
}

function simulationError(
  code: SimulationErrorCode,
  message: string,
  input: unknown,
): SimulationError {
  return { code, message, input };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * The scenario naming rule: 1-64 characters after trimming — the
 * configuration naming rule (a display label, unique in the document).
 */
export function isValidSimulationName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= 64;
}

/** Whether the input is one of the declared scenario kinds. */
export function isSimScenarioKind(input: unknown): input is SimScenarioKind {
  return (
    typeof input === "string" &&
    SIM_SCENARIO_KINDS.includes(input as SimScenarioKind)
  );
}

function isSimDomainFace(input: unknown): input is SimDomainFace {
  return (
    typeof input === "string" &&
    SIM_DOMAIN_FACES.includes(input as SimDomainFace)
  );
}

/** Parses a finite [x, y, z] triple or fails with the given code. */
function parseVec3(
  input: unknown,
  code: SimulationErrorCode,
  what: string,
): ParseResult<SimVec3, SimulationError> {
  // The element-wise copy keeps the element type `unknown` (never the
  // `any` Array.isArray narrows to), so every component narrows through
  // its own typeof/finite check below (the section-triple precedent).
  const source: readonly unknown[] | null = Array.isArray(input)
    ? (input as readonly unknown[])
    : null;
  const entries: readonly unknown[] =
    source === null ? [] : [source[0], source[1], source[2]];
  if (entries.length !== 3) {
    return fail(
      simulationError(
        code,
        `${what} must be an array of three numbers.`,
        input,
      ),
    );
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
    return fail(
      simulationError(
        code,
        `${what} must be an array of three finite numbers.`,
        input,
      ),
    );
  }
  return ok([x, y, z]);
}

/** Parses a finite strictly-positive number or fails with the given code. */
function parsePositiveNumber(
  input: unknown,
  code: SimulationErrorCode,
  what: string,
): ParseResult<number, SimulationError> {
  if (typeof input !== "number" || !Number.isFinite(input) || input <= 0) {
    return fail(
      simulationError(code, `${what} must be a positive finite number.`, input),
    );
  }
  return ok(input);
}

/** Parses a finite number or fails with the given code. */
function parseFiniteNumber(
  input: unknown,
  code: SimulationErrorCode,
  what: string,
): ParseResult<number, SimulationError> {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return fail(
      simulationError(code, `${what} must be a finite number.`, input),
    );
  }
  return ok(input);
}

function parseDomain(
  input: unknown,
): ParseResult<SimScenarioDomain, SimulationError> {
  if (!isPlainRecord(input)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.domainInvalid,
        "A scenario domain must be an object with a kind field.",
        input,
      ),
    );
  }
  if (input.kind === "explicit") {
    const min = parseVec3(
      input.min,
      SIMULATION_ERROR_CODES.domainInvalid,
      "An explicit domain's min corner",
    );
    if (!min.ok) return min;
    const max = parseVec3(
      input.max,
      SIMULATION_ERROR_CODES.domainInvalid,
      "An explicit domain's max corner",
    );
    if (!max.ok) return max;
    for (let axis = 0; axis < 3; axis += 1) {
      if ((max.value[axis] ?? 0) <= (min.value[axis] ?? 0)) {
        return fail(
          simulationError(
            SIMULATION_ERROR_CODES.domainInvalid,
            "An explicit domain's max corner must be strictly greater than its min corner on every axis.",
            input,
          ),
        );
      }
    }
    const resolutionMm = parsePositiveNumber(
      input.resolutionMm,
      SIMULATION_ERROR_CODES.domainInvalid,
      "An explicit domain's resolution",
    );
    if (!resolutionMm.ok) return resolutionMm;
    return ok(
      Object.freeze({
        kind: "explicit",
        min: min.value,
        max: max.value,
        resolutionMm: resolutionMm.value,
      }),
    );
  }
  if (input.kind === "body") {
    if (!Array.isArray(input.bodyIds) || input.bodyIds.length === 0) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.domainInvalid,
          "A body-derived domain must name at least one body.",
          input,
        ),
      );
    }
    const bodyIds: BodyId[] = [];
    for (const entry of input.bodyIds) {
      const parsed = parseBodyId(entry);
      if (!parsed.ok) {
        return fail(
          simulationError(
            SIMULATION_ERROR_CODES.domainInvalid,
            `A body-derived domain must carry valid body ids: ${parsed.error.message}`,
            input,
          ),
        );
      }
      if (bodyIds.includes(parsed.value)) {
        return fail(
          simulationError(
            SIMULATION_ERROR_CODES.domainInvalid,
            `The body-derived domain names body "${parsed.value}" more than once.`,
            input,
          ),
        );
      }
      bodyIds.push(parsed.value);
    }
    const marginMm = parseFiniteNumber(
      input.marginMm,
      SIMULATION_ERROR_CODES.domainInvalid,
      "A body-derived domain's margin",
    );
    if (!marginMm.ok) return marginMm;
    if (marginMm.value < 0) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.domainInvalid,
          "A body-derived domain's margin must be non-negative.",
          input,
        ),
      );
    }
    const resolutionMm = parsePositiveNumber(
      input.resolutionMm,
      SIMULATION_ERROR_CODES.domainInvalid,
      "A body-derived domain's resolution",
    );
    if (!resolutionMm.ok) return resolutionMm;
    return ok(
      Object.freeze({
        kind: "body",
        bodyIds: Object.freeze(bodyIds),
        marginMm: marginMm.value,
        resolutionMm: resolutionMm.value,
      }),
    );
  }
  return fail(
    simulationError(
      SIMULATION_ERROR_CODES.domainInvalid,
      'A scenario domain\'s kind must be "explicit" or "body".',
      input,
    ),
  );
}

/** Canonical JSON form of a domain; fixed key order, discriminated by kind. */
export type SerializedSimScenarioDomain =
  | {
      readonly kind: "explicit";
      readonly min: readonly [number, number, number];
      readonly max: readonly [number, number, number];
      readonly resolutionMm: number;
    }
  | {
      readonly kind: "body";
      readonly bodyIds: readonly string[];
      readonly marginMm: number;
      readonly resolutionMm: number;
    };

function serializeDomain(
  domain: SimScenarioDomain,
): SerializedSimScenarioDomain {
  return domain.kind === "explicit"
    ? {
        kind: "explicit",
        min: [...domain.min],
        max: [...domain.max],
        resolutionMm: domain.resolutionMm,
      }
    : {
        kind: "body",
        bodyIds: [...domain.bodyIds],
        marginMm: domain.marginMm,
        resolutionMm: domain.resolutionMm,
      };
}

function parseCondition(
  input: unknown,
): ParseResult<SimBoundaryCondition, SimulationError> {
  if (!isPlainRecord(input)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.conditionInvalid,
        "A boundary condition must be an object with kind and face fields.",
        input,
      ),
    );
  }
  const faceError = simulationError(
    SIMULATION_ERROR_CODES.conditionInvalid,
    `A boundary condition's face must be one of: ${SIM_DOMAIN_FACES.join(", ")}.`,
    input.face,
  );
  if (!isSimDomainFace(input.face)) return fail(faceError);
  const face = input.face;
  switch (input.kind) {
    case "velocity-inlet": {
      const speedMPerS = parsePositiveNumber(
        input.speedMPerS,
        SIMULATION_ERROR_CODES.conditionInvalid,
        "A velocity-inlet's speed",
      );
      if (!speedMPerS.ok) return speedMPerS;
      const direction = parseVec3(
        input.direction,
        SIMULATION_ERROR_CODES.conditionInvalid,
        "A velocity-inlet's direction",
      );
      if (!direction.ok) return direction;
      if (direction.value.every((component) => component === 0)) {
        return fail(
          simulationError(
            SIMULATION_ERROR_CODES.conditionInvalid,
            "A velocity-inlet's direction must be non-zero.",
            input.direction,
          ),
        );
      }
      return ok(
        Object.freeze({
          kind: "velocity-inlet",
          face,
          speedMPerS: speedMPerS.value,
          direction: direction.value,
        }),
      );
    }
    case "pressure-outlet": {
      const pressurePa = parseFiniteNumber(
        input.pressurePa,
        SIMULATION_ERROR_CODES.conditionInvalid,
        "A pressure-outlet's pressure",
      );
      if (!pressurePa.ok) return pressurePa;
      return ok(
        Object.freeze({
          kind: "pressure-outlet",
          face,
          pressurePa: pressurePa.value,
        }),
      );
    }
    case "wall": {
      if (typeof input.slip !== "boolean") {
        return fail(
          simulationError(
            SIMULATION_ERROR_CODES.conditionInvalid,
            "A wall condition's slip flag must be a boolean.",
            input.slip,
          ),
        );
      }
      return ok(Object.freeze({ kind: "wall", face, slip: input.slip }));
    }
    case "symmetry":
      return ok(Object.freeze({ kind: "symmetry", face }));
    case "fixed-temperature": {
      const temperatureK = parsePositiveNumber(
        input.temperatureK,
        SIMULATION_ERROR_CODES.conditionInvalid,
        "A fixed-temperature's temperature",
      );
      if (!temperatureK.ok) return temperatureK;
      return ok(
        Object.freeze({
          kind: "fixed-temperature",
          face,
          temperatureK: temperatureK.value,
        }),
      );
    }
    case "heat-flux": {
      const fluxWPerM2 = parseFiniteNumber(
        input.fluxWPerM2,
        SIMULATION_ERROR_CODES.conditionInvalid,
        "A heat-flux's flux",
      );
      if (!fluxWPerM2.ok) return fluxWPerM2;
      return ok(
        Object.freeze({
          kind: "heat-flux",
          face,
          fluxWPerM2: fluxWPerM2.value,
        }),
      );
    }
    case "convection-ambient": {
      const heatTransferCoefficientWPerM2K = parsePositiveNumber(
        input.heatTransferCoefficientWPerM2K,
        SIMULATION_ERROR_CODES.conditionInvalid,
        "A convection-ambient's heat transfer coefficient",
      );
      if (!heatTransferCoefficientWPerM2K.ok) {
        return heatTransferCoefficientWPerM2K;
      }
      const ambientTemperatureK = parsePositiveNumber(
        input.ambientTemperatureK,
        SIMULATION_ERROR_CODES.conditionInvalid,
        "A convection-ambient's ambient temperature",
      );
      if (!ambientTemperatureK.ok) return ambientTemperatureK;
      let emissivity: number | undefined;
      if (input.emissivity !== undefined && input.emissivity !== null) {
        if (
          typeof input.emissivity !== "number" ||
          !Number.isFinite(input.emissivity) ||
          input.emissivity < 0 ||
          input.emissivity > 1
        ) {
          return fail(
            simulationError(
              SIMULATION_ERROR_CODES.conditionInvalid,
              "A convection-ambient's emissivity must be a finite number in [0, 1].",
              input.emissivity,
            ),
          );
        }
        emissivity = input.emissivity;
      }
      return ok(
        Object.freeze({
          kind: "convection-ambient",
          face,
          heatTransferCoefficientWPerM2K: heatTransferCoefficientWPerM2K.value,
          ambientTemperatureK: ambientTemperatureK.value,
          ...(emissivity === undefined ? {} : { emissivity }),
        }),
      );
    }
    case "fixed-support":
      return ok(Object.freeze({ kind: "fixed-support", face }));
    case "force-load": {
      const forceN = parseVec3(
        input.forceN,
        SIMULATION_ERROR_CODES.conditionInvalid,
        "A force-load's force",
      );
      if (!forceN.ok) return forceN;
      return ok(
        Object.freeze({ kind: "force-load", face, forceN: forceN.value }),
      );
    }
    case "pressure-load": {
      const pressurePa = parseFiniteNumber(
        input.pressurePa,
        SIMULATION_ERROR_CODES.conditionInvalid,
        "A pressure-load's pressure",
      );
      if (!pressurePa.ok) return pressurePa;
      return ok(
        Object.freeze({
          kind: "pressure-load",
          face,
          pressurePa: pressurePa.value,
        }),
      );
    }
    default:
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.conditionInvalid,
          `A boundary condition's kind must be one of: ${Object.keys(
            SIM_CONDITION_KIND_SCENARIOS,
          ).join(", ")}.`,
          input.kind,
        ),
      );
  }
}

/** Canonical JSON form of a boundary condition; discriminated by `kind`. */
export type SerializedSimBoundaryCondition =
  | {
      readonly kind: "velocity-inlet";
      readonly face: string;
      readonly speedMPerS: number;
      readonly direction: readonly [number, number, number];
    }
  | {
      readonly kind: "pressure-outlet";
      readonly face: string;
      readonly pressurePa: number;
    }
  | { readonly kind: "wall"; readonly face: string; readonly slip: boolean }
  | { readonly kind: "symmetry"; readonly face: string }
  | {
      readonly kind: "fixed-temperature";
      readonly face: string;
      readonly temperatureK: number;
    }
  | {
      readonly kind: "heat-flux";
      readonly face: string;
      readonly fluxWPerM2: number;
    }
  | {
      readonly kind: "convection-ambient";
      readonly face: string;
      readonly heatTransferCoefficientWPerM2K: number;
      readonly ambientTemperatureK: number;
      readonly emissivity?: number;
    }
  | { readonly kind: "fixed-support"; readonly face: string }
  | {
      readonly kind: "force-load";
      readonly face: string;
      readonly forceN: readonly [number, number, number];
    }
  | {
      readonly kind: "pressure-load";
      readonly face: string;
      readonly pressurePa: number;
    };

function serializeCondition(
  condition: SimBoundaryCondition,
): SerializedSimBoundaryCondition {
  switch (condition.kind) {
    case "velocity-inlet":
      return {
        kind: "velocity-inlet",
        face: condition.face,
        speedMPerS: condition.speedMPerS,
        direction: [...condition.direction],
      };
    case "pressure-outlet":
      return {
        kind: "pressure-outlet",
        face: condition.face,
        pressurePa: condition.pressurePa,
      };
    case "wall":
      return { kind: "wall", face: condition.face, slip: condition.slip };
    case "symmetry":
      return { kind: "symmetry", face: condition.face };
    case "fixed-temperature":
      return {
        kind: "fixed-temperature",
        face: condition.face,
        temperatureK: condition.temperatureK,
      };
    case "heat-flux":
      return {
        kind: "heat-flux",
        face: condition.face,
        fluxWPerM2: condition.fluxWPerM2,
      };
    case "convection-ambient":
      return {
        kind: "convection-ambient",
        face: condition.face,
        heatTransferCoefficientWPerM2K:
          condition.heatTransferCoefficientWPerM2K,
        ambientTemperatureK: condition.ambientTemperatureK,
        ...(condition.emissivity === undefined
          ? {}
          : { emissivity: condition.emissivity }),
      };
    case "fixed-support":
      return { kind: "fixed-support", face: condition.face };
    case "force-load":
      return {
        kind: "force-load",
        face: condition.face,
        forceN: [...condition.forceN],
      };
    case "pressure-load":
      return {
        kind: "pressure-load",
        face: condition.face,
        pressurePa: condition.pressurePa,
      };
  }
}

function parseConditions(
  input: unknown,
  kind: SimScenarioKind,
): ParseResult<readonly SimBoundaryCondition[], SimulationError> {
  if (input === undefined || input === null) {
    return ok(Object.freeze([]));
  }
  if (!Array.isArray(input)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.conditionInvalid,
        "A scenario's boundary conditions must be an array.",
        input,
      ),
    );
  }
  const conditions: SimBoundaryCondition[] = [];
  const facesSeen = new Set<SimDomainFace>();
  for (const entry of input) {
    const parsed = parseCondition(entry);
    if (!parsed.ok) return parsed;
    const condition = parsed.value;
    const allowed = SIM_CONDITION_KIND_SCENARIOS[condition.kind];
    if (!allowed.includes(kind)) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.conditionKindMismatch,
          `A "${condition.kind}" condition cannot ride a "${kind}" scenario (allowed kinds: ${allowed.join(", ")}).`,
          entry,
        ),
      );
    }
    if (facesSeen.has(condition.face)) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.conditionFaceDuplicate,
          `More than one boundary condition addresses the "${condition.face}" face.`,
          entry,
        ),
      );
    }
    facesSeen.add(condition.face);
    conditions.push(condition);
  }
  return ok(Object.freeze(conditions));
}

function parseMaterials(
  input: unknown,
): ParseResult<readonly SimMaterialAssignment[], SimulationError> {
  if (input === undefined || input === null) {
    return ok(Object.freeze([]));
  }
  if (!Array.isArray(input)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.materialsInvalid,
        "A scenario's material assignments must be an array.",
        input,
      ),
    );
  }
  const assignments: SimMaterialAssignment[] = [];
  for (const entry of input) {
    if (!isPlainRecord(entry)) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.materialsInvalid,
          "A material assignment must be an object with bodyId and materialId fields.",
          entry,
        ),
      );
    }
    const parsedBody = parseBodyId(entry.bodyId);
    if (!parsedBody.ok) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.materialsInvalid,
          `A material assignment must carry a valid body id: ${parsedBody.error.message}`,
          entry,
        ),
      );
    }
    if (typeof entry.materialId !== "string") {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.materialsInvalid,
          "A material assignment must carry a valid material id (a `mat_`-prefixed string).",
          entry,
        ),
      );
    }
    const parsedMaterial = parseMaterialId(entry.materialId);
    if (!parsedMaterial.ok) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.materialsInvalid,
          `A material assignment must carry a valid material id: ${parsedMaterial.error.message}`,
          entry,
        ),
      );
    }
    if (assignments.some((row) => row.bodyId === parsedBody.value)) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.materialsInvalid,
          `The scenario assigns body "${parsedBody.value}" more than once; one body takes one material.`,
          entry,
        ),
      );
    }
    assignments.push(
      Object.freeze({
        bodyId: parsedBody.value,
        materialId: parsedMaterial.value,
      }),
    );
  }
  return ok(Object.freeze(assignments));
}

/**
 * Validates and freezes a scenario's authored fields from (typed or
 * untrusted) input — the build boundary the document add path and the
 * native parse boundary share.
 */
export function buildSimScenarioBody(
  name: unknown,
  kind: unknown,
  domain: unknown,
  conditions: unknown,
  fluid: unknown,
  materials: unknown,
  gravityMPerS2: unknown,
  motorId: unknown,
  backend: unknown,
  stepBudget: unknown,
  gridConvergence: unknown,
  thermal?: unknown,
  flow3d?: unknown,
): ParseResult<SimScenarioBody, SimulationError> {
  if (typeof name !== "string" || !isValidSimulationName(name)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.nameInvalid,
        "A scenario name must be 1-64 characters (trimmed).",
        name,
      ),
    );
  }
  if (!isSimScenarioKind(kind)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.kindInvalid,
        `A scenario kind must be one of: ${SIM_SCENARIO_KINDS.join(", ")}.`,
        kind,
      ),
    );
  }
  const parsedDomain = parseDomain(domain);
  if (!parsedDomain.ok) return parsedDomain;
  const parsedConditions = parseConditions(conditions, kind);
  if (!parsedConditions.ok) return parsedConditions;
  if (typeof fluid !== "string" || fluid.trim().length === 0) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.fluidInvalid,
        "A scenario's fluid must be a non-empty name of a sim-core fluid property record.",
        fluid,
      ),
    );
  }
  const parsedMaterials = parseMaterials(materials);
  if (!parsedMaterials.ok) return parsedMaterials;
  let gravity: SimVec3 = DEFAULT_SIM_GRAVITY_M_PER_S2;
  if (gravityMPerS2 !== undefined && gravityMPerS2 !== null) {
    const parsedGravity = parseVec3(
      gravityMPerS2,
      SIMULATION_ERROR_CODES.gravityInvalid,
      "A scenario's gravity vector",
    );
    if (!parsedGravity.ok) return parsedGravity;
    gravity = parsedGravity.value;
  }
  let parsedMotorId: MotorId | undefined;
  if (motorId !== undefined && motorId !== null) {
    const parsed = parseMotorId(motorId);
    if (!parsed.ok) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.motorInvalid,
          `A scenario's motor selection must be a valid motor id: ${parsed.error.message}`,
          motorId,
        ),
      );
    }
    parsedMotorId = parsed.value;
  }
  let parsedBackend: SimBackendPreference | undefined;
  if (backend !== undefined && backend !== null) {
    const match = SIM_BACKEND_PREFERENCES.find(
      (candidate) => candidate === backend,
    );
    if (match === undefined) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.backendInvalid,
          `A scenario's backend preference must be one of: ${SIM_BACKEND_PREFERENCES.join(", ")}.`,
          backend,
        ),
      );
    }
    parsedBackend = match;
  }
  let parsedStepBudget: number | undefined;
  if (stepBudget !== undefined && stepBudget !== null) {
    if (
      typeof stepBudget !== "number" ||
      !Number.isInteger(stepBudget) ||
      stepBudget < 2
    ) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.runControlsInvalid,
          "A scenario's step budget must be an integer of at least 2 (so the averaging window opens inside the run).",
          stepBudget,
        ),
      );
    }
    parsedStepBudget = stepBudget;
  }
  let parsedGridConvergence: boolean | undefined;
  if (gridConvergence !== undefined && gridConvergence !== null) {
    if (typeof gridConvergence !== "boolean") {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.runControlsInvalid,
          "A scenario's grid-convergence flag must be a boolean.",
          gridConvergence,
        ),
      );
    }
    parsedGridConvergence = gridConvergence;
  }
  const parsedThermal = parseThermalSpec(thermal, kind);
  if (!parsedThermal.ok) return parsedThermal;
  const parsedFlow3d = parseFlow3dSpec(flow3d, kind);
  if (!parsedFlow3d.ok) return parsedFlow3d;
  return ok(
    Object.freeze({
      name: name.trim(),
      kind,
      domain: parsedDomain.value,
      conditions: parsedConditions.value,
      fluid: fluid.trim(),
      materials: parsedMaterials.value,
      gravityMPerS2: gravity,
      ...(parsedStepBudget === undefined
        ? {}
        : { stepBudget: parsedStepBudget }),
      ...(parsedGridConvergence === undefined
        ? {}
        : { gridConvergence: parsedGridConvergence }),
      ...(parsedThermal.value === undefined
        ? {}
        : { thermal: parsedThermal.value }),
      ...(parsedFlow3d.value === undefined
        ? {}
        : { flow3d: parsedFlow3d.value }),
      ...(parsedMotorId === undefined ? {} : { motorId: parsedMotorId }),
      ...(parsedBackend === undefined ? {} : { backend: parsedBackend }),
    }),
  );
}

/** Canonical JSON form of a scenario's authored fields; fixed key order. */
export interface SerializedSimScenarioBody {
  readonly name: string;
  readonly kind: string;
  readonly domain: SerializedSimScenarioDomain;
  readonly conditions: readonly SerializedSimBoundaryCondition[];
  readonly fluid: string;
  readonly materials: readonly {
    readonly bodyId: string;
    readonly materialId: string;
  }[];
  readonly gravityMPerS2: readonly [number, number, number];
  readonly stepBudget?: number;
  readonly gridConvergence?: boolean;
  readonly thermal?: SerializedSimScenarioThermalSpec;
  readonly flow3d?: SerializedSimScenarioFlow3dSpec;
  readonly motorId?: string;
  /** Present exactly when the preference is not the CPU default. */
  readonly backend?: Exclude<SimBackendPreference, "cpu">;
}

/**
 * Serializes a scenario's authored fields; the identity rides separately.
 * Tolerates the draft form (optional collections, gravity, and run
 * controls) by omitting the same optionals the build boundary omits, so a
 * command payload serializes canonically without a build round-trip.
 */
export function serializeSimScenarioBody(
  scenario: SimScenarioDraft,
): SerializedSimScenarioBody {
  const conditions = scenario.conditions ?? [];
  const materials = scenario.materials ?? [];
  const gravity =
    scenario.gravityMPerS2 === undefined
      ? DEFAULT_SIM_GRAVITY_M_PER_S2
      : scenario.gravityMPerS2;
  return {
    name: scenario.name,
    kind: scenario.kind,
    domain: serializeDomain(scenario.domain),
    conditions: conditions.map(serializeCondition),
    fluid: scenario.fluid,
    materials: materials.map((assignment) => ({
      bodyId: assignment.bodyId,
      materialId: assignment.materialId,
    })),
    gravityMPerS2: [...gravity],
    ...(scenario.stepBudget === undefined
      ? {}
      : { stepBudget: scenario.stepBudget }),
    ...(scenario.gridConvergence === undefined
      ? {}
      : { gridConvergence: scenario.gridConvergence }),
    ...(scenario.thermal === undefined
      ? {}
      : {
          thermal: {
            radiationMode: scenario.thermal.radiationMode,
            solveMode: scenario.thermal.solveMode,
            cht: scenario.thermal.cht,
            sourceW: scenario.thermal.sourceW,
            initialTemperatureK: scenario.thermal.initialTemperatureK,
            ambientConvectionWPerM2K: scenario.thermal.ambientConvectionWPerM2K,
            ...(scenario.thermal.durationS === undefined
              ? {}
              : { durationS: scenario.thermal.durationS }),
            ...(scenario.thermal.sampleIntervalS === undefined
              ? {}
              : { sampleIntervalS: scenario.thermal.sampleIntervalS }),
          },
        }),
    ...(scenario.flow3d === undefined
      ? {}
      : {
          flow3d: {
            ...(scenario.flow3d.boundaryTreatment === undefined ||
            scenario.flow3d.boundaryTreatment === "staircase"
              ? {}
              : { boundaryTreatment: scenario.flow3d.boundaryTreatment }),
            ...(scenario.flow3d.rotation === undefined
              ? {}
              : {
                  rotation: {
                    kind: scenario.flow3d.rotation.kind,
                    axisPointMm: [...scenario.flow3d.rotation.axisPointMm],
                    axisDirection: [...scenario.flow3d.rotation.axisDirection],
                    zoneRadiusMm: scenario.flow3d.rotation.zoneRadiusMm,
                    rpmMode: scenario.flow3d.rotation.rpmMode,
                    ...(scenario.flow3d.rotation.fixedRpm === undefined
                      ? {}
                      : { fixedRpm: scenario.flow3d.rotation.fixedRpm }),
                    bladeCount: scenario.flow3d.rotation.bladeCount,
                  },
                }),
          },
        }),
    ...(scenario.motorId === undefined ? {} : { motorId: scenario.motorId }),
    ...(scenario.backend === undefined || scenario.backend === "cpu"
      ? {}
      : { backend: scenario.backend }),
  };
}

/**
 * Parses untrusted input as a scenario's authored fields. Ids are validated
 * for wire shape; whether they name records the document owns is the
 * caller's (the document and native-format layers') cross-check.
 */
export function parseSimScenarioBody(
  input: unknown,
): ParseResult<SimScenarioBody, SimulationError> {
  if (!isPlainRecord(input)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.malformed,
        "A serialized scenario must be a plain object with name, kind, domain, and fluid fields.",
        input,
      ),
    );
  }
  return buildSimScenarioBody(
    input.name,
    input.kind,
    input.domain,
    input.conditions,
    input.fluid,
    input.materials,
    input.gravityMPerS2,
    input.motorId,
    input.backend,
    input.stepBudget,
    input.gridConvergence,
    input.thermal,
    input.flow3d,
  );
}

/** Canonical JSON form of a scenario record; fixed key order, additive discipline. */
export interface SerializedSimScenario extends SerializedSimScenarioBody {
  readonly id: string;
}

/** Serializes a scenario record to its canonical, deterministic JSON form. */
export function serializeSimScenario(
  scenario: SimScenario,
): SerializedSimScenario {
  return { id: scenario.id, ...serializeSimScenarioBody(scenario) };
}

/**
 * Parses untrusted input (e.g. a scenario revived from persisted JSON) as a
 * {@link SimScenario}: the id must be wire-valid and every authored field
 * parses through {@link parseSimScenarioBody}.
 */
export function parseSimScenario(
  input: unknown,
): ParseResult<SimScenario, SimulationError> {
  if (!isPlainRecord(input)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.malformed,
        "A serialized scenario must be a plain object with an id field.",
        input,
      ),
    );
  }
  const parsedId = parseSimulationId(input.id);
  if (!parsedId.ok) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.idInvalid,
        `A scenario id must be a valid simulation id: ${parsedId.error.message}`,
        input.id,
      ),
    );
  }
  const body = parseSimScenarioBody(input);
  if (!body.ok) return body;
  return ok(Object.freeze({ id: parsedId.value, ...body.value }));
}

/** Returns the scenario with the given id, or undefined. */
export function getSimScenario(
  scenarios: readonly SimScenario[],
  id: SimulationId,
): SimScenario | undefined {
  return scenarios.find((scenario) => scenario.id === id);
}
