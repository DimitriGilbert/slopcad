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
  type JointId,
  type MotorId,
  type OccurrenceId,
  type SimulationId,
  parseBodyId,
  parseJointId,
  parseMotorId,
  parseOccurrenceId,
  parseSimulationId,
} from "./ids";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/** A finite [x, y, z] triple in the scenario's documented units. */
export type SimVec3 = readonly [number, number, number];

/**
 * The scenario kinds (Phase 61 carve; `structural` is reserved for Phase 69
 * and declines at the sim-core compile boundary until that phase lands;
 * `dynamics` is Phase 67's mechanism-dynamics kind — its solve stance is
 * the dynamics kind's alone; `combustion` is Phase 68's kind — the stove
 * with fire and the 0D Otto engine, its two mode-locked stances below).
 */
export const SIM_SCENARIO_KINDS = [
  "flow",
  "thermal",
  "dynamics",
  "combustion",
  "structural",
] as const;

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

/**
 * Which scenario kinds each condition kind may ride on. The thermal set
 * rides `combustion` too (Phase 68's stove mode IS a 65-family thermal
 * solve — its face conditions are the thermal set; the engine mode
 * refuses every condition, the dynamics kind's rule).
 */
export const SIM_CONDITION_KIND_SCENARIOS: Readonly<
  Record<SimBoundaryCondition["kind"], readonly SimScenarioKind[]>
> = Object.freeze({
  "velocity-inlet": Object.freeze(["flow", "thermal"] as const),
  "pressure-outlet": Object.freeze(["flow", "thermal"] as const),
  wall: Object.freeze(["flow", "thermal"] as const),
  symmetry: Object.freeze(["flow", "thermal"] as const),
  "fixed-temperature": Object.freeze(["thermal", "combustion"] as const),
  "heat-flux": Object.freeze(["thermal", "combustion"] as const),
  "convection-ambient": Object.freeze(["thermal", "combustion"] as const),
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

// ---------------------------------------------------------------------------
// The dynamics solve stance (Phase 67c, law S1-additive)
// ---------------------------------------------------------------------------

/**
 * The dynamics engines a scenario may select (Phase 67): `reference` is
 * the deterministic TypeScript kernel — the S2/S5 oracle and the default;
 * `mujoco` is the Apache-2.0 wasm provider behind the SAME contract, an
 * explicit opt-in that declines loudly when its module cannot load,
 * never a silent fallback to the reference.
 */
export const SIM_DYNAMICS_PROVIDERS = ["reference", "mujoco"] as const;

export type SimDynamicsProvider = (typeof SIM_DYNAMICS_PROVIDERS)[number];

/** One sample of a quasi-static load series: a time and its magnitude. */
export interface SimDynamicsLoadSample {
  /** The sample's time, s (≥ 0, within the stance's duration). */
  readonly tS: number;
}

/** One flow-force history sample (a 63/66 run output's drag/lift series). */
export interface SimDynamicsFlowForceSample extends SimDynamicsLoadSample {
  /** The force at the sample's time, N (world components). */
  readonly forceN: SimVec3;
  /** The application point, world mm; absent = the body's COG. */
  readonly atWorldPointMm?: SimVec3;
}

/**
 * One combustion-torque-estimate sample (Phase 68's shape, authored as an
 * external torque series — the Phase 68 integration itself is Phase 68).
 */
export interface SimDynamicsJointTorqueSample extends SimDynamicsLoadSample {
  /** The drive effort at the sample's time, N·m. */
  readonly effortNPerM: number;
}

/**
 * One quasi-static load coupling (Phase 67c): a time series applied
 * per-step. `flow-force` rides a body occurrence (the 2D/3D flow runs'
 * force histories); `joint-torque` rides a joint's drive DOF (the
 * combustion torque estimates). Samples interpolate piecewise-linearly
 * between their points with constant end extrapolation — the tabulated
 * motor's discipline, stated once here.
 */
export type SimScenarioDynamicsLoad =
  | {
      readonly kind: "flow-force";
      /** The occurrence the force history applies to. */
      readonly occurrenceId: OccurrenceId;
      readonly samples: readonly SimDynamicsFlowForceSample[];
    }
  | {
      readonly kind: "joint-torque";
      /** The named estimate (a load record's display identity). */
      readonly name: string;
      /** The joint whose drive DOF the torque series drives. */
      readonly jointId: JointId;
      readonly samples: readonly SimDynamicsJointTorqueSample[];
    };

/**
 * A dynamics scenario's solve stance (Phase 67c, kind-locked): the
 * provider selection (reference default, MuJoCo opt-in), the integration
 * budget (time step, duration, sample cadence — all authored, never
 * runtime knobs), the joint the scenario's selected motor record rides,
 * and the quasi-static load couplings. Required on `dynamics` scenarios
 * and refused on every other kind — the thermal stance's discipline.
 */
export interface SimScenarioDynamicsSpec {
  /**
   * The engine selection; absent = the reference kernel (the S2/S5
   * oracle default — MuJoCo is the explicit opt-in).
   */
  readonly provider?: SimDynamicsProvider;
  /** The integration time step, s (strictly positive). */
  readonly timeStepS: number;
  /** The physical end time, s (strictly positive; an integer number of steps). */
  readonly durationS: number;
  /** The history sampling cadence, s (an integer number of steps; ≤ duration). */
  readonly sampleIntervalS: number;
  /**
   * The joint the scenario's `motorId` selection rides; required exactly
   * when a motor is selected, refused otherwise (the fixedRpm-iff-fixed
   * rule's shape).
   */
  readonly motorJointId?: JointId;
  readonly loads?: readonly SimScenarioDynamicsLoad[];
}

/** Canonical JSON form of a load series; fixed key order, optionals last. */
export type SerializedSimScenarioDynamicsLoad =
  | {
      readonly kind: "flow-force";
      readonly occurrenceId: string;
      readonly samples: readonly {
        readonly tS: number;
        readonly forceN: readonly [number, number, number];
        readonly atWorldPointMm?: readonly [number, number, number];
      }[];
    }
  | {
      readonly kind: "joint-torque";
      readonly name: string;
      readonly jointId: string;
      readonly samples: readonly {
        readonly tS: number;
        readonly effortNPerM: number;
      }[];
    };

/** Canonical JSON form of the dynamics stance; fixed key order, optionals last. */
export interface SerializedSimScenarioDynamicsSpec {
  readonly timeStepS: number;
  readonly durationS: number;
  readonly sampleIntervalS: number;
  readonly motorJointId?: string;
  readonly loads?: SerializedSimScenarioDynamicsLoad[];
  /** Present exactly when the provider is not the reference default. */
  readonly provider?: Exclude<SimDynamicsProvider, "reference">;
}

function isSimDynamicsProvider(input: unknown): input is SimDynamicsProvider {
  return (
    typeof input === "string" &&
    SIM_DYNAMICS_PROVIDERS.includes(input as SimDynamicsProvider)
  );
}

/**
 * Parses one load series' samples' shared spine: at least two samples,
 * strictly increasing times inside `[0, durationS]`, every time finite.
 */
function parseLoadSamples(
  input: readonly unknown[],
  durationS: number,
  what: string,
): ParseResult<readonly number[], SimulationError> {
  if (input.length < 2) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
        `${what} must carry at least two samples (a series interpolates; a constant is one endpoint twice).`,
        input.length,
      ),
    );
  }
  const times: number[] = [];
  for (const entry of input) {
    if (!isPlainRecord(entry)) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
          `${what} must be plain sample objects.`,
          entry,
        ),
      );
    }
    if (
      typeof entry.tS !== "number" ||
      !Number.isFinite(entry.tS) ||
      entry.tS < 0 ||
      entry.tS > durationS
    ) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
          `${what}'s sample times must be finite and inside the stance's duration [0, ${String(durationS)} s].`,
          entry.tS,
        ),
      );
    }
    if (times.length > 0 && entry.tS <= (times.at(-1) ?? 0)) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
          `${what}'s sample times must be strictly increasing.`,
          entry.tS,
        ),
      );
    }
    times.push(entry.tS);
  }
  return ok(times);
}

/** Parses the quasi-static load couplings (unknown input, kind-tagged). */
function parseDynamicsLoads(
  input: unknown,
  durationS: number,
): ParseResult<readonly SimScenarioDynamicsLoad[], SimulationError> {
  if (input === undefined || input === null) {
    return ok(Object.freeze([]));
  }
  if (!Array.isArray(input)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
        "A dynamics stance's loads must be an array of series records.",
        input,
      ),
    );
  }
  const loads: SimScenarioDynamicsLoad[] = [];
  const torqueNames = new Set<string>();
  for (const entry of input) {
    if (!isPlainRecord(entry)) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
          "Each dynamics load must be a plain object with a kind field.",
          entry,
        ),
      );
    }
    if (entry.kind === "flow-force") {
      const occurrence = parseOccurrenceId(entry.occurrenceId);
      if (!occurrence.ok) {
        return fail(
          simulationError(
            SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
            `A flow-force load must carry a valid occurrence id: ${occurrence.error.message}`,
            entry.occurrenceId,
          ),
        );
      }
      if (!Array.isArray(entry.samples)) {
        return fail(
          simulationError(
            SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
            "A flow-force load must carry its samples array.",
            entry.samples,
          ),
        );
      }
      const times = parseLoadSamples(
        entry.samples,
        durationS,
        "A flow-force load",
      );
      if (!times.ok) return times;
      const samples: SimDynamicsFlowForceSample[] = [];
      for (const [index, sample] of entry.samples.entries()) {
        if (!isPlainRecord(sample)) continue; // parseLoadSamples declined already
        const forceN = parseVec3(
          sample.forceN,
          SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
          "A flow-force sample's force",
        );
        if (!forceN.ok) return forceN;
        let atWorldPointMm: SimVec3 | undefined;
        if (
          sample.atWorldPointMm !== undefined &&
          sample.atWorldPointMm !== null
        ) {
          const point = parseVec3(
            sample.atWorldPointMm,
            SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
            "A flow-force sample's application point",
          );
          if (!point.ok) return point;
          atWorldPointMm = point.value;
        }
        samples.push({
          tS: times.value[index] ?? 0,
          forceN: forceN.value,
          ...(atWorldPointMm === undefined ? {} : { atWorldPointMm }),
        });
      }
      loads.push(
        Object.freeze({
          kind: "flow-force",
          occurrenceId: occurrence.value,
          samples: Object.freeze(samples),
        }),
      );
      continue;
    }
    if (entry.kind === "joint-torque") {
      if (
        typeof entry.name !== "string" ||
        entry.name.trim().length < 1 ||
        entry.name.trim().length > 64
      ) {
        return fail(
          simulationError(
            SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
            "A joint-torque load's name must be 1-64 characters (trimmed).",
            entry.name,
          ),
        );
      }
      const joint = parseJointId(entry.jointId);
      if (!joint.ok) {
        return fail(
          simulationError(
            SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
            `A joint-torque load must carry a valid joint id: ${joint.error.message}`,
            entry.jointId,
          ),
        );
      }
      if (!Array.isArray(entry.samples)) {
        return fail(
          simulationError(
            SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
            "A joint-torque load must carry its samples array.",
            entry.samples,
          ),
        );
      }
      const times = parseLoadSamples(
        entry.samples,
        durationS,
        "A joint-torque load",
      );
      if (!times.ok) return times;
      const samples: SimDynamicsJointTorqueSample[] = [];
      for (const [index, sample] of entry.samples.entries()) {
        if (!isPlainRecord(sample)) continue; // parseLoadSamples declined already
        if (
          typeof sample.effortNPerM !== "number" ||
          !Number.isFinite(sample.effortNPerM)
        ) {
          return fail(
            simulationError(
              SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
              "A joint-torque sample's effort must be a finite number (N·m).",
              sample.effortNPerM,
            ),
          );
        }
        samples.push({
          tS: times.value[index] ?? 0,
          effortNPerM: sample.effortNPerM,
        });
      }
      const name = entry.name.trim();
      if (torqueNames.has(name)) {
        return fail(
          simulationError(
            SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
            `The named torque estimate "${name}" appears twice; one name per estimate.`,
            name,
          ),
        );
      }
      torqueNames.add(name);
      loads.push(
        Object.freeze({
          kind: "joint-torque",
          name,
          jointId: joint.value,
          samples: Object.freeze(samples),
        }),
      );
      continue;
    }
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
        'A dynamics load\'s kind must be "flow-force" or "joint-torque".',
        entry.kind,
      ),
    );
  }
  return ok(Object.freeze(loads));
}

/**
 * Parses the dynamics solve stance, kind-locked: a `dynamics` scenario
 * without one declines (there is no default physics), any other kind
 * carrying one declines (the stance is the dynamics kind's alone), and
 * the budget's own fields are cross-checked (integer steps; the sample
 * cadence an integer number of steps inside the duration; the motor
 * joint present exactly when the record selects a motor).
 */
function parseDynamicsSpec(
  input: unknown,
  kind: SimScenarioKind,
  motorId: MotorId | undefined,
): ParseResult<SimScenarioDynamicsSpec | undefined, SimulationError> {
  if (input === undefined || input === null) {
    if (kind === "dynamics") {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
          "A dynamics scenario must carry its dynamics solve stance (time step, duration, sample cadence).",
          input,
        ),
      );
    }
    return ok(undefined);
  }
  if (kind !== "dynamics") {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
        `A "${kind}" scenario cannot carry a dynamics solve stance; it is the dynamics kind's alone.`,
        input,
      ),
    );
  }
  if (!isPlainRecord(input)) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
        "A dynamics solve stance must be an object with timeStepS, durationS, and sampleIntervalS fields.",
        input,
      ),
    );
  }
  const timeStepS = parsePositiveNumber(
    input.timeStepS,
    SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
    "A dynamics stance's time step",
  );
  if (!timeStepS.ok) return timeStepS;
  const durationS = parsePositiveNumber(
    input.durationS,
    SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
    "A dynamics stance's duration",
  );
  if (!durationS.ok) return durationS;
  const sampleIntervalS = parsePositiveNumber(
    input.sampleIntervalS,
    SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
    "A dynamics stance's sample interval",
  );
  if (!sampleIntervalS.ok) return sampleIntervalS;
  // The step lattice: the duration is EXACTLY an integer number of steps
  // and the cadence an integer number of steps inside it, so every sample
  // lands on a step boundary — the transient thermal cadence's rule.
  const steps = Math.round(durationS.value / timeStepS.value);
  if (
    steps < 1 ||
    Math.abs(steps * timeStepS.value - durationS.value) > 1e-9 * durationS.value
  ) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
        "A dynamics stance's duration must be an integer multiple of its time step so the march ends exactly on the lattice.",
        { durationS: durationS.value, timeStepS: timeStepS.value },
      ),
    );
  }
  const cadenceSteps = Math.round(sampleIntervalS.value / timeStepS.value);
  if (
    cadenceSteps < 1 ||
    Math.abs(cadenceSteps * timeStepS.value - sampleIntervalS.value) >
      1e-9 * sampleIntervalS.value ||
    sampleIntervalS.value > durationS.value
  ) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
        "A dynamics stance's sample interval must be an integer number of time steps, at most the duration.",
        { sampleIntervalS: sampleIntervalS.value, timeStepS: timeStepS.value },
      ),
    );
  }
  let provider: SimDynamicsProvider = "reference";
  if (input.provider !== undefined && input.provider !== null) {
    if (!isSimDynamicsProvider(input.provider)) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
          `A dynamics stance's provider must be one of: ${SIM_DYNAMICS_PROVIDERS.join(", ")}.`,
          input.provider,
        ),
      );
    }
    provider = input.provider;
  }
  let motorJointId: JointId | undefined;
  if (input.motorJointId !== undefined && input.motorJointId !== null) {
    if (motorId === undefined) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
          "A dynamics stance's motor joint is authored exactly when the scenario selects a motor record (motorId).",
          input.motorJointId,
        ),
      );
    }
    const parsed = parseJointId(input.motorJointId);
    if (!parsed.ok) {
      return fail(
        simulationError(
          SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
          `A dynamics stance's motor joint must be a valid joint id: ${parsed.error.message}`,
          input.motorJointId,
        ),
      );
    }
    motorJointId = parsed.value;
  } else if (motorId !== undefined) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.dynamicsSpecInvalid,
        `The scenario selects motor "${motorId}" but its dynamics stance names no motor joint — the record rides exactly one joint.`,
        motorId,
      ),
    );
  }
  const loads = parseDynamicsLoads(input.loads, durationS.value);
  if (!loads.ok) return loads;
  return ok(
    Object.freeze({
      timeStepS: timeStepS.value,
      durationS: durationS.value,
      sampleIntervalS: sampleIntervalS.value,
      ...(motorJointId === undefined ? {} : { motorJointId }),
      ...(loads.value.length === 0 ? {} : { loads: loads.value }),
      ...(provider === "reference" ? {} : { provider }),
    }),
  );
}

// ---------------------------------------------------------------------------
// The combustion solve stance (Phase 68c, law S1-additive)
// ---------------------------------------------------------------------------

/**
 * The combustion stance's two modes (Phase 68): `stove` — fire in the
 * Phase 65 CHT domain, the 68b reactor's progress-variable heat release
 * coupled into the 65 thermal solve; `engine` — the 0D Otto cycle over
 * the Phase 67 slider-crank volume seam.
 */
export const SIM_COMBUSTION_MODES = ["stove", "engine"] as const;

export type SimCombustionMode = (typeof SIM_COMBUSTION_MODES)[number];

/**
 * The fuels the combustion vocabulary carries — the curated NASA-7 fuel
 * species with published one-step kinetics (CH4, both octanes) restated
 * at this record boundary (cad-core hardcodes no chemistry registry;
 * sim-combustion owns the data, and the engine mode's subset — the
 * fuels with a published laminar flame-speed fit — is checked in its
 * own parse below).
 */
export const SIM_COMBUSTION_FUELS = ["CH4", "C8H18-ISO", "C8H18-N"] as const;

export type SimCombustionFuel = (typeof SIM_COMBUSTION_FUELS)[number];

/** The engine mode's fuels — those with a published flame-speed fit. */
export const SIM_COMBUSTION_ENGINE_FUELS: readonly SimCombustionFuel[] = [
  "C8H18-ISO",
  "C8H18-N",
];

/** The engine stance's sweep axes (the 68b sweeps, restated). */
export const SIM_COMBUSTION_SWEEP_KINDS = [
  "compressionRatio",
  "equivalenceRatio",
  "sparkTiming",
] as const;

export type SimCombustionSweepKind =
  (typeof SIM_COMBUSTION_SWEEP_KINDS)[number];

/** The engine stance's wall-heat vocabulary: Woschni correlation or adiabatic. */
export const SIM_COMBUSTION_WALL_HEAT_MODES = ["adiabatic", "woschni"] as const;

export type SimCombustionWallHeatMode =
  (typeof SIM_COMBUSTION_WALL_HEAT_MODES)[number];

/**
 * The equivalence-ratio ceiling the chemistry carries (the 68a reactant
 * door's own limit, restated at this record boundary — cad-core hardcodes
 * no chemistry, so the mirrored constant is the contract).
 */
export const SIM_COMBUSTION_MAX_EQUIVALENCE_RATIO = 5;

/**
 * The STOVE mode's stance: the fire — a premixed charge burning in the
 * chamber (the 68b reactor, one-step kinetics) whose progress-variable
 * heat release enters the 65 thermal solve as a volumetric source on
 * the wall cells the chamber wets, the chamber's equilibrium gas state
 * (the 68a products) reported beside it. The march budget and the
 * equilibrium boundary mirror the thermal stance's fields (the same
 * 65-family solve); lengths are document millimetres only where the
 * domain carries them — the stance itself is all SI-adjacent authoring
 * units (K, bar, W/(m²·K), s).
 */
export interface SimScenarioCombustionStoveSpec {
  readonly mode: "stove";
  readonly fuel: SimCombustionFuel;
  /** The charge's equivalence ratio, (0, 5]. */
  readonly equivalenceRatio: number;
  /** The charge's initial temperature, K (> 0). */
  readonly chargeTemperatureK: number;
  /** The charge's initial pressure, bar (> 0). */
  readonly chargePressureBar: number;
  /** The fire → wall convective coupling h, W/(m²·K) (> 0). */
  readonly wallConvectionWPerM2K: number;
  /**
   * The fire-side wall temperature, K; absent = the initial field (the
   * one-way coupling's honest frozen-wall stance, stated).
   */
  readonly wallTemperatureK?: number;
  readonly radiationMode: SimThermalRadiationMode;
  /** The uniform initial field, K (> 0); also the ambient reference. */
  readonly initialTemperatureK: number;
  /** The equilibrium boundary's external convection coefficient (≥ 0). */
  readonly ambientConvectionWPerM2K: number;
  /** The march's physical end time, s (> 0). */
  readonly durationS: number;
  /** The history/field sampling cadence, s (> 0); an integer submultiple. */
  readonly sampleIntervalS: number;
}

/**
 * The ENGINE mode's stance: the 0D Otto closed cycle — the Phase 67
 * slider-crank seam (authored in document millimetres; the compile
 * boundary converts), the IVC charge state, the spark timing, the
 * Woschni wall heat, the Chen–Flynn friction fields, and an optional
 * sweep axis whose rows ride the same result.
 */
export interface SimScenarioCombustionEngineSpec {
  readonly mode: "engine";
  readonly fuel: SimCombustionFuel;
  readonly geometry: {
    /** The cylinder bore, mm (> 0). */
    readonly boreMm: number;
    /** The crank radius (half the stroke), mm (> 0). */
    readonly crankRadiusMm: number;
    /** The connecting-rod length, mm (> crank radius — the linkage). */
    readonly rodLengthMm: number;
    /** The compression ratio (> 1). */
    readonly compressionRatio: number;
  };
  /** The engine speed, rpm (> 0). */
  readonly speedRpm: number;
  readonly charge: {
    /** The trapped charge's pressure at intake-valve closing, bar (> 0). */
    readonly intakePressureBar: number;
    /** The trapped charge's temperature at IVC, K (> 0). */
    readonly intakeTK: number;
    /** The charge's equivalence ratio, (0, 5]. */
    readonly equivalenceRatio: number;
  };
  readonly spark: {
    /** Spark timing, crank degrees BEFORE compression TDC — (0, 178). */
    readonly timingBTDCDeg: number;
    /** The turbulent-flame multiplier (> 0; absent = the published default). */
    readonly turbulenceSpeedMultiplier?: number;
  };
  readonly wallHeat:
    | { readonly mode: "adiabatic" }
    | {
        readonly mode: "woschni";
        /** The coolant-side wall temperature, K (> 0). */
        readonly wallTemperatureK: number;
      };
  /** The Chen–Flynn friction fields (bar-side); absent = the published default. */
  readonly friction?: {
    readonly aBar: number;
    readonly bBarPerBar: number;
    readonly cBarPerMPerS: number;
    readonly dBarPerM2S2: number;
    readonly pumpingMepBar: number;
  };
  /** The optional sweep — one axis, `from` to `to` over `steps` intervals. */
  readonly sweep?: {
    readonly kind: SimCombustionSweepKind;
    readonly from: number;
    readonly to: number;
    readonly steps: number;
  };
}

/** The combustion solve stance, kind-locked to `combustion` (Phase 68c). */
export type SimScenarioCombustionSpec =
  SimScenarioCombustionStoveSpec | SimScenarioCombustionEngineSpec;

/** Canonical JSON form of the combustion stance; fixed key order, optionals last. */
export type SerializedSimScenarioCombustionSpec =
  | {
      readonly mode: "stove";
      readonly fuel: string;
      readonly equivalenceRatio: number;
      readonly chargeTemperatureK: number;
      readonly chargePressureBar: number;
      readonly wallConvectionWPerM2K: number;
      readonly radiationMode: SimThermalRadiationMode;
      readonly initialTemperatureK: number;
      readonly ambientConvectionWPerM2K: number;
      readonly durationS: number;
      readonly sampleIntervalS: number;
      readonly wallTemperatureK?: number;
    }
  | {
      readonly mode: "engine";
      readonly fuel: string;
      readonly geometry: {
        readonly boreMm: number;
        readonly crankRadiusMm: number;
        readonly rodLengthMm: number;
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
        | {
            readonly mode: "woschni";
            readonly wallTemperatureK: number;
          };
      readonly friction?: {
        readonly aBar: number;
        readonly bBarPerBar: number;
        readonly cBarPerMPerS: number;
        readonly dBarPerM2S2: number;
        readonly pumpingMepBar: number;
      };
      readonly sweep?: {
        readonly kind: SimCombustionSweepKind;
        readonly from: number;
        readonly to: number;
        readonly steps: number;
      };
    };

function isSimCombustionMode(input: unknown): input is SimCombustionMode {
  return (
    typeof input === "string" &&
    SIM_COMBUSTION_MODES.includes(input as SimCombustionMode)
  );
}

function isSimCombustionFuel(input: unknown): input is SimCombustionFuel {
  return (
    typeof input === "string" &&
    SIM_COMBUSTION_FUELS.includes(input as SimCombustionFuel)
  );
}

function isSimCombustionSweepKind(
  input: unknown,
): input is SimCombustionSweepKind {
  return (
    typeof input === "string" &&
    SIM_COMBUSTION_SWEEP_KINDS.includes(input as SimCombustionSweepKind)
  );
}

/**
 * Parses the combustion solve stance, kind-locked: a `combustion`
 * scenario without one declines (there is no default physics), any
 * other kind carrying one declines (the stance is the combustion
 * kind's alone), and each mode's own fields are cross-checked (the
 * engine mode's fuel subset — the flame-speed fits; the stove mode's
 * cadence-on-the-lattice rule — the thermal stance's).
 */
function parseCombustionSpec(
  input: unknown,
  kind: SimScenarioKind,
): ParseResult<SimScenarioCombustionSpec | undefined, SimulationError> {
  const code = SIMULATION_ERROR_CODES.combustionSpecInvalid;
  if (input === undefined || input === null) {
    if (kind === "combustion") {
      return fail(
        simulationError(
          code,
          "A combustion scenario must carry its combustion solve stance (the stove fire or the 0D engine cycle).",
          input,
        ),
      );
    }
    return ok(undefined);
  }
  if (kind !== "combustion") {
    return fail(
      simulationError(
        code,
        `A "${kind}" scenario cannot carry a combustion solve stance; it is the combustion kind's alone.`,
        input,
      ),
    );
  }
  if (!isPlainRecord(input)) {
    return fail(
      simulationError(
        code,
        "A combustion solve stance must be an object with a mode field (stove or engine).",
        input,
      ),
    );
  }
  if (!isSimCombustionMode(input.mode)) {
    return fail(
      simulationError(
        code,
        `A combustion stance's mode must be one of: ${SIM_COMBUSTION_MODES.join(", ")}.`,
        input.mode,
      ),
    );
  }
  if (!isSimCombustionFuel(input.fuel)) {
    return fail(
      simulationError(
        code,
        `A combustion stance's fuel must be one of: ${SIM_COMBUSTION_FUELS.join(", ")}.`,
        input.fuel,
      ),
    );
  }
  const positive = (
    value: unknown,
    what: string,
    max?: number,
  ): ParseResult<number, SimulationError> => {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value <= 0 ||
      (max !== undefined && value > max)
    ) {
      return fail(
        simulationError(
          code,
          `${what} must be a positive finite number${max === undefined ? "" : ` at most ${String(max)}`}.`,
          value,
        ),
      );
    }
    return ok(value);
  };
  if (input.mode === "stove") {
    const equivalenceRatio = positive(
      input.equivalenceRatio,
      "A stove stance's equivalence ratio",
      SIM_COMBUSTION_MAX_EQUIVALENCE_RATIO,
    );
    if (!equivalenceRatio.ok) return equivalenceRatio;
    const chargeTemperatureK = positive(
      input.chargeTemperatureK,
      "A stove stance's charge temperature",
    );
    if (!chargeTemperatureK.ok) return chargeTemperatureK;
    const chargePressureBar = positive(
      input.chargePressureBar,
      "A stove stance's charge pressure",
    );
    if (!chargePressureBar.ok) return chargePressureBar;
    const wallConvectionWPerM2K = positive(
      input.wallConvectionWPerM2K,
      "A stove stance's wall convection coefficient",
    );
    if (!wallConvectionWPerM2K.ok) return wallConvectionWPerM2K;
    if (!isSimThermalRadiationMode(input.radiationMode)) {
      return fail(
        simulationError(
          code,
          `A stove stance's radiation mode must be one of: ${SIM_THERMAL_RADIATION_MODES.join(", ")}.`,
          input.radiationMode,
        ),
      );
    }
    const initialTemperatureK = positive(
      input.initialTemperatureK,
      "A stove stance's initial temperature",
    );
    if (!initialTemperatureK.ok) return initialTemperatureK;
    const ambientConvectionRaw = parseFiniteNumber(
      input.ambientConvectionWPerM2K,
      code,
      "A stove stance's ambient convection coefficient",
    );
    if (!ambientConvectionRaw.ok) return ambientConvectionRaw;
    if (ambientConvectionRaw.value < 0) {
      return fail(
        simulationError(
          code,
          "A stove stance's ambient convection coefficient must be non-negative W/(m²·K).",
          input.ambientConvectionWPerM2K,
        ),
      );
    }
    const durationS = positive(input.durationS, "A stove stance's duration");
    if (!durationS.ok) return durationS;
    const sampleIntervalS = positive(
      input.sampleIntervalS,
      "A stove stance's sample interval",
    );
    if (!sampleIntervalS.ok) return sampleIntervalS;
    const sampleCount = Math.round(durationS.value / sampleIntervalS.value);
    if (
      sampleCount < 1 ||
      Math.abs(sampleCount * sampleIntervalS.value - durationS.value) >
        1e-9 * durationS.value
    ) {
      return fail(
        simulationError(
          code,
          "A stove stance's duration must be an integer multiple of its sample interval so every sample lands on the cadence.",
          {
            durationS: durationS.value,
            sampleIntervalS: sampleIntervalS.value,
          },
        ),
      );
    }
    let wallTemperatureK: number | undefined;
    if (
      input.wallTemperatureK !== undefined &&
      input.wallTemperatureK !== null
    ) {
      const parsed = positive(
        input.wallTemperatureK,
        "A stove stance's wall temperature",
      );
      if (!parsed.ok) return parsed;
      wallTemperatureK = parsed.value;
    }
    return ok(
      Object.freeze({
        mode: "stove",
        fuel: input.fuel,
        equivalenceRatio: equivalenceRatio.value,
        chargeTemperatureK: chargeTemperatureK.value,
        chargePressureBar: chargePressureBar.value,
        wallConvectionWPerM2K: wallConvectionWPerM2K.value,
        radiationMode: input.radiationMode,
        initialTemperatureK: initialTemperatureK.value,
        ambientConvectionWPerM2K: ambientConvectionRaw.value,
        durationS: durationS.value,
        sampleIntervalS: sampleIntervalS.value,
        ...(wallTemperatureK === undefined ? {} : { wallTemperatureK }),
      }),
    );
  }
  // The engine mode.
  if (!SIM_COMBUSTION_ENGINE_FUELS.includes(input.fuel)) {
    return fail(
      simulationError(
        code,
        `An engine stance's fuel must be one of: ${SIM_COMBUSTION_ENGINE_FUELS.join(", ")} (the fuels with a published laminar flame-speed fit — the burn-duration grounding declines to guess one).`,
        input.fuel,
      ),
    );
  }
  const geometry = input.geometry;
  if (!isPlainRecord(geometry)) {
    return fail(
      simulationError(
        code,
        "An engine stance must carry its slider-crank geometry (bore, crank radius, rod, compression ratio) in millimetres.",
        geometry,
      ),
    );
  }
  const boreMm = positive(geometry.boreMm, "An engine stance's bore");
  if (!boreMm.ok) return boreMm;
  const crankRadiusMm = positive(
    geometry.crankRadiusMm,
    "An engine stance's crank radius",
  );
  if (!crankRadiusMm.ok) return crankRadiusMm;
  const rodLengthMm = positive(
    geometry.rodLengthMm,
    "An engine stance's rod length",
  );
  if (!rodLengthMm.ok) return rodLengthMm;
  if (rodLengthMm.value <= crankRadiusMm.value) {
    return fail(
      simulationError(
        code,
        "An engine stance's rod must be longer than its crank radius — the linkage's assembly condition l > r.",
        { rodLengthMm: rodLengthMm.value, crankRadiusMm: crankRadiusMm.value },
      ),
    );
  }
  const compressionRatio = positive(
    geometry.compressionRatio,
    "An engine stance's compression ratio",
  );
  if (!compressionRatio.ok) return compressionRatio;
  if (compressionRatio.value <= 1) {
    return fail(
      simulationError(
        code,
        "An engine stance's compression ratio must exceed 1.",
        geometry.compressionRatio,
      ),
    );
  }
  const speedRpm = positive(input.speedRpm, "An engine stance's speed");
  if (!speedRpm.ok) return speedRpm;
  const charge = input.charge;
  if (!isPlainRecord(charge)) {
    return fail(
      simulationError(
        code,
        "An engine stance must carry its trapped charge (intake pressure, intake temperature, equivalence ratio).",
        charge,
      ),
    );
  }
  const intakePressureBar = positive(
    charge.intakePressureBar,
    "An engine charge's intake pressure",
  );
  if (!intakePressureBar.ok) return intakePressureBar;
  const intakeTK = positive(
    charge.intakeTK,
    "An engine charge's intake temperature",
  );
  if (!intakeTK.ok) return intakeTK;
  const equivalenceRatio = positive(
    charge.equivalenceRatio,
    "An engine charge's equivalence ratio",
    SIM_COMBUSTION_MAX_EQUIVALENCE_RATIO,
  );
  if (!equivalenceRatio.ok) return equivalenceRatio;
  const spark = input.spark;
  if (!isPlainRecord(spark)) {
    return fail(
      simulationError(
        code,
        "An engine stance must carry its spark timing (degrees before compression TDC).",
        spark,
      ),
    );
  }
  const timingBTDCDeg = spark.timingBTDCDeg;
  if (
    typeof timingBTDCDeg !== "number" ||
    !Number.isFinite(timingBTDCDeg) ||
    timingBTDCDeg <= 0 ||
    timingBTDCDeg >= 178
  ) {
    return fail(
      simulationError(
        code,
        "An engine stance's spark timing must lie strictly inside the compression stroke (0–178° before TDC).",
        timingBTDCDeg,
      ),
    );
  }
  let turbulenceSpeedMultiplier: number | undefined;
  if (
    spark.turbulenceSpeedMultiplier !== undefined &&
    spark.turbulenceSpeedMultiplier !== null
  ) {
    const parsed = positive(
      spark.turbulenceSpeedMultiplier,
      "An engine stance's turbulence flame-speed multiplier",
    );
    if (!parsed.ok) return parsed;
    turbulenceSpeedMultiplier = parsed.value;
  }
  const wallHeat = input.wallHeat;
  if (!isPlainRecord(wallHeat)) {
    return fail(
      simulationError(
        code,
        'An engine stance must carry its wall-heat boundary (mode "adiabatic" or "woschni").',
        wallHeat,
      ),
    );
  }
  let woschniWallTemperatureK: number | undefined;
  if (wallHeat.mode === "woschni") {
    const wallTemperatureK = positive(
      wallHeat.wallTemperatureK,
      "A Woschni wall temperature",
    );
    if (!wallTemperatureK.ok) return wallTemperatureK;
    woschniWallTemperatureK = wallTemperatureK.value;
  } else if (wallHeat.mode !== "adiabatic") {
    return fail(
      simulationError(
        code,
        `An engine stance's wall-heat mode must be one of: ${SIM_COMBUSTION_WALL_HEAT_MODES.join(", ")}.`,
        wallHeat.mode,
      ),
    );
  }
  let friction:
    | {
        readonly aBar: number;
        readonly bBarPerBar: number;
        readonly cBarPerMPerS: number;
        readonly dBarPerM2S2: number;
        readonly pumpingMepBar: number;
      }
    | undefined;
  if (input.friction !== undefined && input.friction !== null) {
    if (!isPlainRecord(input.friction)) {
      return fail(
        simulationError(
          code,
          "An engine stance's Chen–Flynn friction fields must be an object (a, b, c, d, pumping MEP).",
          input.friction,
        ),
      );
    }
    const nonNegative = (
      value: unknown,
      what: string,
    ): ParseResult<number, SimulationError> => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return fail(
          simulationError(
            code,
            `${what} must be a non-negative finite number.`,
            value,
          ),
        );
      }
      return ok(value);
    };
    const aBar = nonNegative(input.friction.aBar, "A friction field's a");
    if (!aBar.ok) return aBar;
    const bBarPerBar = nonNegative(
      input.friction.bBarPerBar,
      "A friction field's b",
    );
    if (!bBarPerBar.ok) return bBarPerBar;
    const cBarPerMPerS = nonNegative(
      input.friction.cBarPerMPerS,
      "A friction field's c",
    );
    if (!cBarPerMPerS.ok) return cBarPerMPerS;
    const dBarPerM2S2 = nonNegative(
      input.friction.dBarPerM2S2,
      "A friction field's d",
    );
    if (!dBarPerM2S2.ok) return dBarPerM2S2;
    const pumpingMepBar = nonNegative(
      input.friction.pumpingMepBar,
      "A friction field's pumping MEP",
    );
    if (!pumpingMepBar.ok) return pumpingMepBar;
    friction = Object.freeze({
      aBar: aBar.value,
      bBarPerBar: bBarPerBar.value,
      cBarPerMPerS: cBarPerMPerS.value,
      dBarPerM2S2: dBarPerM2S2.value,
      pumpingMepBar: pumpingMepBar.value,
    });
  }
  let sweep:
    | {
        readonly kind: SimCombustionSweepKind;
        readonly from: number;
        readonly to: number;
        readonly steps: number;
      }
    | undefined;
  if (input.sweep !== undefined && input.sweep !== null) {
    if (!isPlainRecord(input.sweep)) {
      return fail(
        simulationError(
          code,
          "An engine stance's sweep must be an object (kind, from, to, steps).",
          input.sweep,
        ),
      );
    }
    if (!isSimCombustionSweepKind(input.sweep.kind)) {
      return fail(
        simulationError(
          code,
          `An engine stance's sweep kind must be one of: ${SIM_COMBUSTION_SWEEP_KINDS.join(", ")}.`,
          input.sweep.kind,
        ),
      );
    }
    const from = parseFiniteNumber(
      input.sweep.from,
      code,
      "A sweep's from value",
    );
    if (!from.ok) return from;
    const to = parseFiniteNumber(input.sweep.to, code, "A sweep's to value");
    if (!to.ok) return to;
    const steps = input.sweep.steps;
    if (typeof steps !== "number" || !Number.isInteger(steps) || steps < 1) {
      return fail(
        simulationError(
          code,
          "A sweep needs at least 1 interval (a positive integer step count).",
          steps,
        ),
      );
    }
    sweep = Object.freeze({
      kind: input.sweep.kind,
      from: from.value,
      to: to.value,
      steps,
    });
  }
  return ok(
    Object.freeze({
      mode: "engine",
      fuel: input.fuel,
      geometry: Object.freeze({
        boreMm: boreMm.value,
        crankRadiusMm: crankRadiusMm.value,
        rodLengthMm: rodLengthMm.value,
        compressionRatio: compressionRatio.value,
      }),
      speedRpm: speedRpm.value,
      charge: Object.freeze({
        intakePressureBar: intakePressureBar.value,
        intakeTK: intakeTK.value,
        equivalenceRatio: equivalenceRatio.value,
      }),
      spark: Object.freeze({
        timingBTDCDeg,
        ...(turbulenceSpeedMultiplier === undefined
          ? {}
          : { turbulenceSpeedMultiplier }),
      }),
      wallHeat:
        woschniWallTemperatureK === undefined
          ? Object.freeze({ mode: "adiabatic" })
          : Object.freeze({
              mode: "woschni",
              wallTemperatureK: woschniWallTemperatureK,
            }),
      ...(friction === undefined ? {} : { friction }),
      ...(sweep === undefined ? {} : { sweep }),
    }),
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
  /**
   * The dynamics solve stance (Phase 67c): required on `dynamics`
   * scenarios, refused on every other kind.
   */
  readonly dynamics?: SimScenarioDynamicsSpec;
  /**
   * The combustion solve stance (Phase 68c): required on `combustion`
   * scenarios (mode stove or engine), refused on every other kind.
   */
  readonly combustion?: SimScenarioCombustionSpec;
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
  readonly dynamics?: SimScenarioDynamicsSpec;
  readonly combustion?: SimScenarioCombustionSpec;
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
  dynamicsSpecInvalid: "simulation/dynamics-spec-invalid",
  combustionSpecInvalid: "simulation/combustion-spec-invalid",
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
  dynamics?: unknown,
  combustion?: unknown,
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
  const parsedDynamics = parseDynamicsSpec(dynamics, kind, parsedMotorId);
  if (!parsedDynamics.ok) return parsedDynamics;
  const parsedCombustion = parseCombustionSpec(combustion, kind);
  if (!parsedCombustion.ok) return parsedCombustion;
  // The engine mode carries no domain-face boundary conditions — the
  // 0D chamber's physics is its authored stance, the dynamics kind's
  // rule (the stove mode consumes the thermal set through the table).
  if (
    parsedCombustion.value?.mode === "engine" &&
    parsedConditions.value.length > 0
  ) {
    return fail(
      simulationError(
        SIMULATION_ERROR_CODES.conditionKindMismatch,
        'An "engine"-mode combustion scenario carries no domain-face boundary conditions — the 0D chamber\'s physics is its authored stance (the stove mode consumes the thermal set).',
        parsedConditions.value,
      ),
    );
  }
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
      ...(parsedDynamics.value === undefined
        ? {}
        : { dynamics: parsedDynamics.value }),
      ...(parsedCombustion.value === undefined
        ? {}
        : { combustion: parsedCombustion.value }),
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
  readonly dynamics?: SerializedSimScenarioDynamicsSpec;
  readonly combustion?: SerializedSimScenarioCombustionSpec;
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
/** Canonical JSON of one load series; fixed key order, optionals last. */
function serializeDynamicsLoad(
  load: SimScenarioDynamicsLoad,
): SerializedSimScenarioDynamicsLoad {
  if (load.kind === "flow-force") {
    return {
      kind: "flow-force",
      occurrenceId: load.occurrenceId,
      samples: load.samples.map((sample) => ({
        tS: sample.tS,
        forceN: [...sample.forceN],
        ...(sample.atWorldPointMm === undefined
          ? {}
          : { atWorldPointMm: [...sample.atWorldPointMm] }),
      })),
    };
  }
  return {
    kind: "joint-torque",
    name: load.name,
    jointId: load.jointId,
    samples: load.samples.map((sample) => ({
      tS: sample.tS,
      effortNPerM: sample.effortNPerM,
    })),
  };
}

/** Canonical JSON of the dynamics stance; fixed key order, optionals last. */
export function serializeSimScenarioDynamicsSpec(
  spec: SimScenarioDynamicsSpec,
): SerializedSimScenarioDynamicsSpec {
  return {
    timeStepS: spec.timeStepS,
    durationS: spec.durationS,
    sampleIntervalS: spec.sampleIntervalS,
    ...(spec.motorJointId === undefined
      ? {}
      : { motorJointId: spec.motorJointId }),
    ...(spec.loads === undefined || spec.loads.length === 0
      ? {}
      : { loads: spec.loads.map(serializeDynamicsLoad) }),
    ...(spec.provider === "reference" ? {} : { provider: spec.provider }),
  };
}

/** Canonical JSON of the combustion stance; fixed key order, optionals last. */
export function serializeSimScenarioCombustionSpec(
  spec: SimScenarioCombustionSpec,
): SerializedSimScenarioCombustionSpec {
  if (spec.mode === "stove") {
    return {
      mode: "stove",
      fuel: spec.fuel,
      equivalenceRatio: spec.equivalenceRatio,
      chargeTemperatureK: spec.chargeTemperatureK,
      chargePressureBar: spec.chargePressureBar,
      wallConvectionWPerM2K: spec.wallConvectionWPerM2K,
      radiationMode: spec.radiationMode,
      initialTemperatureK: spec.initialTemperatureK,
      ambientConvectionWPerM2K: spec.ambientConvectionWPerM2K,
      durationS: spec.durationS,
      sampleIntervalS: spec.sampleIntervalS,
      ...(spec.wallTemperatureK === undefined
        ? {}
        : { wallTemperatureK: spec.wallTemperatureK }),
    };
  }
  return {
    mode: "engine",
    fuel: spec.fuel,
    geometry: { ...spec.geometry },
    speedRpm: spec.speedRpm,
    charge: { ...spec.charge },
    spark: {
      timingBTDCDeg: spec.spark.timingBTDCDeg,
      ...(spec.spark.turbulenceSpeedMultiplier === undefined
        ? {}
        : { turbulenceSpeedMultiplier: spec.spark.turbulenceSpeedMultiplier }),
    },
    wallHeat:
      spec.wallHeat.mode === "woschni"
        ? {
            mode: "woschni",
            wallTemperatureK: spec.wallHeat.wallTemperatureK,
          }
        : { mode: "adiabatic" },
    ...(spec.friction === undefined ? {} : { friction: { ...spec.friction } }),
    ...(spec.sweep === undefined ? {} : { sweep: { ...spec.sweep } }),
  };
}

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
    ...(scenario.dynamics === undefined
      ? {}
      : { dynamics: serializeSimScenarioDynamicsSpec(scenario.dynamics) }),
    ...(scenario.combustion === undefined
      ? {}
      : {
          combustion: serializeSimScenarioCombustionSpec(scenario.combustion),
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
    input.dynamics,
    input.combustion,
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
