/**
 * The S4 units boundary: SI inside the solver boundary, canonical
 * millimetres outside (the document). Unit conversion happens in EXACTLY
 * TWO functions — {@link compileSimScenario} (document → solver space)
 * and {@link projectSimResult} (solver → document space, with explicit
 * units on every projected quantity) — and nowhere else in the sim
 * stack. The motor record's authored datasheet units (mN·m, rpm) convert
 * to SI (N·m, rad/s) ONLY here, at the compile door.
 *
 * sim-core depends on nothing at runtime, so the boundary consumes the
 * scenario and motor records in their CANONICAL SERIALIZED JSON forms
 * (the wire contract `@slopcad/cad-core`'s serializers emit) and
 * re-validates every field it consumes — the same trust discipline the
 * kernel's wire boundary applies to document-derived payloads. The
 * scenario's lengths (domain bounds, margins, resolution) are document
 * millimetres; everything the document already authors SI-adjacent
 * (velocities m/s, pressures Pa, temperatures K, forces N) passes the
 * boundary with its magnitude checked, and the compiled scenario carries
 * pure SI (metres, metres-per-cell) for the solvers.
 */

import type {
  CompiledSimRunControls,
  CompiledSimThermal,
} from "./compile-geometry";
import type { SimOccupancyGrid } from "./voxel-grid";

import { type SimError, SIM_ERROR_CODES, simError } from "./errors";
import { getSimFluid, type SimFluidState, simFluidState } from "./fluids";
import {
  simMach,
  simPrandtl,
  simRayleigh,
  simRegimeReport,
  type SimRegimeReport,
  simReynolds,
} from "./regime";
import { simScenarioSnapshotHash } from "./snapshot";
import { type SimParseResult, simFail, simOk } from "./result";
import {
  type SimDomainFace,
  type SimScenarioKind,
  isSimScenarioKind,
} from "./vocabulary";

/** The mm-to-metre factor — the one length conversion constant of S4. */
export const MM_PER_M = 1000;

/** rpm → rad/s (2π/60). */
const RPM_TO_RAD_PER_S = (2 * Math.PI) / 60;

/** mN·m → N·m (1e-3). */
const MN_M_TO_N_M = 1e-3;

// ---------------------------------------------------------------------------
// Document-space structural parsing (the wire contract's fields, re-validated)
// ---------------------------------------------------------------------------

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function finiteTriple(
  input: unknown,
  what: string,
): SimParseResult<readonly [number, number, number], SimError> {
  // The element-wise copy keeps the element type `unknown` (never the
  // `any` Array.isArray narrows to), so every component narrows through
  // its own typeof/finite check below.
  const source: readonly unknown[] | null = Array.isArray(input)
    ? (input as readonly unknown[])
    : null;
  const entries: readonly unknown[] =
    source === null ? [] : [source[0], source[1], source[2]];
  if (entries.length !== 3) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
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
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `${what} must be an array of three finite numbers.`,
        input,
      ),
    );
  }
  return simOk([x, y, z]);
}

interface ParsedDomain {
  readonly kind: "explicit" | "body";
  readonly minMm?: readonly [number, number, number];
  readonly maxMm?: readonly [number, number, number];
  readonly bodyIds?: readonly string[];
  readonly marginMm?: number;
  readonly resolutionMm: number;
}

function parseDomain(input: unknown): SimParseResult<ParsedDomain, SimError> {
  if (!isPlainRecord(input)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "A scenario's domain must be a plain object with a kind field.",
        input,
      ),
    );
  }
  if (input.resolutionMm === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "A scenario's domain must carry a resolutionMm.",
        input,
      ),
    );
  }
  if (
    typeof input.resolutionMm !== "number" ||
    !Number.isFinite(input.resolutionMm) ||
    input.resolutionMm <= 0
  ) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "A scenario's domain resolution must be a positive finite number of millimetres.",
        input.resolutionMm,
      ),
    );
  }
  if (input.kind === "explicit") {
    const min = finiteTriple(input.min, "An explicit domain's min corner");
    if (!min.ok) return min;
    const max = finiteTriple(input.max, "An explicit domain's max corner");
    if (!max.ok) return max;
    for (let axis = 0; axis < 3; axis += 1) {
      if ((max.value[axis] ?? 0) <= (min.value[axis] ?? 0)) {
        return simFail(
          simError(
            SIM_ERROR_CODES.scenarioInvalid,
            "An explicit domain's max corner must exceed its min corner on every axis.",
            input,
          ),
        );
      }
    }
    return simOk({
      kind: "explicit",
      minMm: min.value,
      maxMm: max.value,
      resolutionMm: input.resolutionMm,
    });
  }
  if (input.kind === "body") {
    if (!Array.isArray(input.bodyIds) || input.bodyIds.length === 0) {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          "A body-derived domain must name at least one body.",
          input,
        ),
      );
    }
    for (const bodyId of input.bodyIds) {
      if (typeof bodyId !== "string" || bodyId.length === 0) {
        return simFail(
          simError(
            SIM_ERROR_CODES.scenarioInvalid,
            "A body-derived domain must carry non-empty body ids.",
            input.bodyIds,
          ),
        );
      }
    }
    if (
      typeof input.marginMm !== "number" ||
      !Number.isFinite(input.marginMm) ||
      input.marginMm < 0
    ) {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          "A body-derived domain's margin must be a non-negative finite number of millimetres.",
          input.marginMm,
        ),
      );
    }
    return simOk({
      kind: "body",
      bodyIds: input.bodyIds,
      marginMm: input.marginMm,
      resolutionMm: input.resolutionMm,
    });
  }
  return simFail(
    simError(
      SIM_ERROR_CODES.scenarioInvalid,
      'A scenario domain\'s kind must be "explicit" or "body".',
      input.kind,
    ),
  );
}

/** A compiled boundary condition: the wire fields, magnitudes re-checked. */
export interface CompiledSimCondition {
  readonly kind: string;
  readonly face: SimDomainFace;
  /** The inlet velocity VECTOR in m/s (direction normalized × speed). */
  readonly velocityMPerS?: readonly [number, number, number];
  readonly pressurePa?: number;
  readonly slip?: boolean;
  readonly temperatureK?: number;
  readonly fluxWPerM2?: number;
  readonly heatTransferCoefficientWPerM2K?: number;
  readonly ambientTemperatureK?: number;
  readonly emissivity?: number;
  readonly forceN?: readonly [number, number, number];
}

function parseCondition(
  input: unknown,
): SimParseResult<CompiledSimCondition, SimError> {
  if (!isPlainRecord(input)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "A boundary condition must be a plain object with kind and face fields.",
        input,
      ),
    );
  }
  const faces = ["xMin", "xMax", "yMin", "yMax", "zMin", "zMax"];
  if (typeof input.face !== "string" || !faces.includes(input.face)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `A boundary condition's face must be one of: ${faces.join(", ")}.`,
        input.face,
      ),
    );
  }
  const face = input.face as SimDomainFace;
  const checkFinite = (
    value: unknown,
    what: string,
  ): SimParseResult<number, SimError> => {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          `${what} must be a finite number.`,
          value,
        ),
      );
    }
    return simOk(value);
  };
  switch (input.kind) {
    case "velocity-inlet": {
      const speed = checkFinite(input.speedMPerS, "A velocity-inlet's speed");
      if (!speed.ok) return speed;
      if (speed.value <= 0) {
        return simFail(
          simError(
            SIM_ERROR_CODES.scenarioInvalid,
            "A velocity-inlet's speed must be positive.",
            input.speedMPerS,
          ),
        );
      }
      const direction = finiteTriple(
        input.direction,
        "A velocity-inlet's direction",
      );
      if (!direction.ok) return direction;
      const [dx, dy, dz] = direction.value;
      const norm = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (norm === 0) {
        return simFail(
          simError(
            SIM_ERROR_CODES.scenarioInvalid,
            "A velocity-inlet's direction must be non-zero.",
            input.direction,
          ),
        );
      }
      // The S4 normalization: unit direction × speed — the solver-space
      // velocity vector, in m/s.
      return simOk({
        kind: "velocity-inlet",
        face,
        velocityMPerS: [
          ((dx ?? 0) / norm) * speed.value,
          ((dy ?? 0) / norm) * speed.value,
          ((dz ?? 0) / norm) * speed.value,
        ],
      });
    }
    case "pressure-outlet": {
      const pressurePa = checkFinite(
        input.pressurePa,
        "A pressure-outlet's pressure",
      );
      if (!pressurePa.ok) return pressurePa;
      return simOk({
        kind: "pressure-outlet",
        face,
        pressurePa: pressurePa.value,
      });
    }
    case "wall": {
      if (typeof input.slip !== "boolean") {
        return simFail(
          simError(
            SIM_ERROR_CODES.scenarioInvalid,
            "A wall condition's slip flag must be a boolean.",
            input.slip,
          ),
        );
      }
      return simOk({ kind: "wall", face, slip: input.slip });
    }
    case "symmetry":
      return simOk({ kind: "symmetry", face });
    case "fixed-temperature": {
      const temperatureK = checkFinite(
        input.temperatureK,
        "A fixed-temperature's temperature",
      );
      if (!temperatureK.ok) return temperatureK;
      if (temperatureK.value <= 0) {
        return simFail(
          simError(
            SIM_ERROR_CODES.scenarioInvalid,
            "A fixed-temperature's temperature must be positive (kelvin).",
            input.temperatureK,
          ),
        );
      }
      return simOk({
        kind: "fixed-temperature",
        face,
        temperatureK: temperatureK.value,
      });
    }
    case "heat-flux": {
      const fluxWPerM2 = checkFinite(input.fluxWPerM2, "A heat-flux's flux");
      if (!fluxWPerM2.ok) return fluxWPerM2;
      return simOk({ kind: "heat-flux", face, fluxWPerM2: fluxWPerM2.value });
    }
    case "convection-ambient": {
      const heatTransferCoefficientWPerM2K = checkFinite(
        input.heatTransferCoefficientWPerM2K,
        "A convection-ambient's heat transfer coefficient",
      );
      if (!heatTransferCoefficientWPerM2K.ok) {
        return heatTransferCoefficientWPerM2K;
      }
      const ambientTemperatureK = checkFinite(
        input.ambientTemperatureK,
        "A convection-ambient's ambient temperature",
      );
      if (!ambientTemperatureK.ok) return ambientTemperatureK;
      if (
        input.emissivity !== undefined &&
        (typeof input.emissivity !== "number" ||
          !Number.isFinite(input.emissivity) ||
          input.emissivity < 0 ||
          input.emissivity > 1)
      ) {
        return simFail(
          simError(
            SIM_ERROR_CODES.scenarioInvalid,
            "A convection-ambient's emissivity must be a finite number in [0, 1].",
            input.emissivity,
          ),
        );
      }
      return simOk({
        kind: "convection-ambient",
        face,
        heatTransferCoefficientWPerM2K: heatTransferCoefficientWPerM2K.value,
        ambientTemperatureK: ambientTemperatureK.value,
        ...(input.emissivity === undefined
          ? {}
          : { emissivity: input.emissivity }),
      });
    }
    case "fixed-support":
      return simOk({ kind: "fixed-support", face });
    case "force-load": {
      const forceN = finiteTriple(input.forceN, "A force-load's force");
      if (!forceN.ok) return forceN;
      return simOk({ kind: "force-load", face, forceN: forceN.value });
    }
    case "pressure-load": {
      const pressurePa = checkFinite(
        input.pressurePa,
        "A pressure-load's pressure",
      );
      if (!pressurePa.ok) return pressurePa;
      return simOk({
        kind: "pressure-load",
        face,
        pressurePa: pressurePa.value,
      });
    }
    default:
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          `A boundary condition's kind is not part of the compile boundary's vocabulary: ${String(input.kind)}.`,
          input.kind,
        ),
      );
  }
}

// ---------------------------------------------------------------------------
// Motor SI conversion (the ONLY place authored mN·m/rpm become N·m/rad·s⁻¹)
// ---------------------------------------------------------------------------

/** A compiled analytic motor: the torque-speed line in SI plus derived views. */
export interface CompiledSimMotorLine {
  readonly kind: "dc-brushed" | "bldc";
  /** The stall (locked-rotor) torque, N·m (authored mN·m × 1e-3). */
  readonly stallTorqueNPerM: number;
  /** The no-load speed, rad/s (authored rpm × 2π/60). */
  readonly noLoadSpeedRadPerS: number;
  /** The nominal voltage, V (authored, already SI). */
  readonly nominalVoltageV: number;
  /** The rotor inertia, kg·m², when authored. */
  readonly rotorInertiaKgM2?: number;
  /**
   * The derived speed constant Kv, rpm/V — the authoring view computed
   * from the stored trio (noLoadSpeedRpm / nominalVoltageV), never stored
   * separately (one storage shape serves both mental models).
   */
  readonly kvRpmPerV: number;
  /**
   * The derived torque constant Kt, N·m/A — from the ideal-motor identity
   * Kt · Kv[rad/s/V] = 1, so Kt = 60/(2π · Kv[rpm/V]).
   */
  readonly ktNPerA: number;
}

/** A compiled tabulated motor: the measured curve in SI. */
export interface CompiledSimMotorTable {
  readonly kind: "tabulated";
  readonly points: readonly {
    readonly speedRadPerS: number;
    readonly torqueNPerM: number;
  }[];
  readonly rotorInertiaKgM2?: number;
}

export type CompiledSimMotor = CompiledSimMotorLine | CompiledSimMotorTable;

function parseMotor(
  input: unknown,
  expectedId: string,
): SimParseResult<CompiledSimMotor, SimError> {
  const invalid = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.motorInvalid, message, at));
  if (!isPlainRecord(input)) {
    return invalid(
      "A selected motor must be a plain serialized motor record.",
      input,
    );
  }
  if (input.id !== expectedId) {
    return invalid(
      `The motor payload carries id ${String(input.id)}, but the scenario selects ${expectedId}.`,
      input.id,
    );
  }
  let rotorInertiaKgM2: number | undefined;
  if (input.rotorInertiaKgM2 !== undefined) {
    if (
      typeof input.rotorInertiaKgM2 !== "number" ||
      !Number.isFinite(input.rotorInertiaKgM2) ||
      input.rotorInertiaKgM2 <= 0
    ) {
      return invalid(
        "A motor's rotor inertia must be a positive finite kg·m² value.",
        input.rotorInertiaKgM2,
      );
    }
    rotorInertiaKgM2 = input.rotorInertiaKgM2;
  }
  const positive = (
    value: unknown,
    what: string,
  ): SimParseResult<number, SimError> => {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return invalid(
        `A motor's ${what} must be a positive finite value.`,
        value,
      );
    }
    return simOk(value);
  };
  if (input.kind === "dc-brushed" || input.kind === "bldc") {
    const stallTorqueMNm = positive(input.stallTorqueMNm, "stall torque");
    if (!stallTorqueMNm.ok) return stallTorqueMNm;
    const noLoadSpeedRpm = positive(input.noLoadSpeedRpm, "no-load speed");
    if (!noLoadSpeedRpm.ok) return noLoadSpeedRpm;
    const nominalVoltageV = positive(input.nominalVoltageV, "nominal voltage");
    if (!nominalVoltageV.ok) return nominalVoltageV;
    // The S4 conversion — authored datasheet units to SI, ONLY here.
    const stallTorqueNPerM = stallTorqueMNm.value * MN_M_TO_N_M;
    const noLoadSpeedRadPerS = noLoadSpeedRpm.value * RPM_TO_RAD_PER_S;
    const kvRpmPerV = noLoadSpeedRpm.value / nominalVoltageV.value;
    const ktNPerA = 1 / (kvRpmPerV * RPM_TO_RAD_PER_S);
    return simOk({
      kind: input.kind,
      stallTorqueNPerM,
      noLoadSpeedRadPerS,
      nominalVoltageV: nominalVoltageV.value,
      ...(rotorInertiaKgM2 === undefined ? {} : { rotorInertiaKgM2 }),
      kvRpmPerV,
      ktNPerA,
    });
  }
  if (input.kind === "tabulated") {
    if (!Array.isArray(input.points) || input.points.length < 2) {
      return invalid(
        "A tabulated motor must carry at least two torque-speed points.",
        input.points,
      );
    }
    const points: { speedRadPerS: number; torqueNPerM: number }[] = [];
    for (const entry of input.points) {
      if (!isPlainRecord(entry)) {
        return invalid(
          "A torque-speed point must be a plain object with speedRpm and torqueMNm.",
          entry,
        );
      }
      if (
        typeof entry.speedRpm !== "number" ||
        !Number.isFinite(entry.speedRpm) ||
        entry.speedRpm < 0
      ) {
        return invalid(
          "A tabulated motor's point speed must be a non-negative finite rpm value (0 is the stall point).",
          entry.speedRpm,
        );
      }
      const speedRpm = entry.speedRpm;
      const torqueMNm = entry.torqueMNm;
      if (typeof torqueMNm !== "number" || !Number.isFinite(torqueMNm)) {
        return invalid(
          "A torque-speed point's torque must be a finite number.",
          entry.torqueMNm,
        );
      }
      points.push({
        speedRadPerS: speedRpm * RPM_TO_RAD_PER_S,
        torqueNPerM: torqueMNm * MN_M_TO_N_M,
      });
    }
    return simOk({
      kind: "tabulated",
      points: Object.freeze(points),
      ...(rotorInertiaKgM2 === undefined ? {} : { rotorInertiaKgM2 }),
    });
  }
  return invalid(
    `A motor record's kind must be "dc-brushed", "bldc", or "tabulated".`,
    input.kind,
  );
}

// ---------------------------------------------------------------------------
// Compile (document → solver) — one of the TWO conversion functions
// ---------------------------------------------------------------------------

/** One body's axis-aligned geometry bounds in document millimetres. */
export interface SimBodyBoundsMm {
  readonly bodyId: string;
  readonly minMm: readonly [number, number, number];
  readonly maxMm: readonly [number, number, number];
}

/** What {@link compileSimScenario} consumes. */
export interface SimCompileInput {
  /** The scenario's canonical serialized JSON (document space, mm). */
  readonly scenario: unknown;
  /**
   * The selected motor's canonical serialized record, when the scenario
   * carries a motor selection — the compile door is the only place its
   * authored mN·m/rpm become SI.
   */
  readonly motor?: unknown;
  /**
   * Geometry measurements for the scenario's referenced bodies (document
   * mm) — the voxelizer's output at run time. A body-derived domain (or
   * the regime characteristic length) that needs bounds the caller did
   * supply declines with `sim/geometry-unavailable`, never guesses.
   */
  readonly bodyBounds?: readonly SimBodyBoundsMm[];
}

/** The scenario in solver space: pure SI, plus the S9 report and provenance. */
export interface CompiledSimScenario {
  readonly kind: SimScenarioKind;
  readonly name: string;
  /** The resolved domain box, m (min corner). */
  readonly domainMinM: readonly [number, number, number];
  /** The resolved domain box, m (max corner). */
  readonly domainMaxM: readonly [number, number, number];
  /** The target cell size, m. */
  readonly cellSizeM: number;
  /**
   * The characteristic length the regime numbers are formed with, m —
   * documented proxy: the largest extent of the measured bodies when
   * bounds cover the scenario's bodies, else the domain box's smallest
   * extent. Advisory like every S9 threshold.
   */
  readonly characteristicLengthM: number;
  /** The gravity vector, m/s² (authored; default standard gravity, −Y). */
  readonly gravityMPerS2: readonly [number, number, number];
  readonly conditions: readonly CompiledSimCondition[];
  readonly fluid: SimFluidState;
  readonly motor?: CompiledSimMotor;
  readonly backend: "cpu" | "gpu";
  /** The S9 regime report, computed at compile time. */
  readonly regime: SimRegimeReport;
  /** The scenario record's content hash at run time (§7.11 provenance). */
  readonly scenarioSnapshotHash: string;
  /**
   * The voxelized 2D occupancy slice of the scenario's bodies (Phase 63c,
   * `./compile-geometry`): solver geometry in SI metres, consumed by the
   * flow engine where it is produced (worker-side). Deliberately NOT part
   * of the worker wire form — the geometry-aware compile attaches it, the
   * plain compile never does, and neither ever needs it to cross back.
   */
  readonly occupancySlice?: SimOccupancyGrid;
  /**
   * The factor-2 refined twin of {@link occupancySlice}, attached when the
   * scenario flags the grid-convergence self-check (the ladder's second
   * rung, voxelized at half the resolution).
   */
  readonly occupancySliceRefined?: SimOccupancyGrid;
  /**
   * The flow-run controls (Phase 63c): the record's step budget and
   * grid-convergence flag plus the derived averaging window. Attached by
   * the geometry-aware compile for flow scenarios.
   */
  readonly run?: CompiledSimRunControls;
  /**
   * The thermal compile products (Phase 65c): the re-validated solve
   * stance, the resolved body→material records, and the per-cell
   * material map over {@link occupancySlice}'s cells. Attached by the
   * geometry-aware compile for thermal scenarios that carry per-body
   * tessellations and material records; consumed worker-side by the
   * thermal engines, never part of the wire form.
   */
  readonly thermal?: CompiledSimThermal;
}

/**
 * Compiles a serialized scenario into solver space (S4, document → SI):
 * resolves the domain (mm → m; body-derived domains need the caller's
 * body bounds), evaluates the fluid at its reference temperature,
 * converts the motor's authored datasheet units to SI (the ONLY site),
 * computes the S9 regime numbers, and stamps the scenario-snapshot hash.
 * The `structural` kind declines with `sim/scenario-kind-unsupported` —
 * the Phase 69 carve: the vocabulary exists, the solver does not yet.
 */
export function compileSimScenario(
  input: SimCompileInput,
): SimParseResult<CompiledSimScenario, SimError> {
  const scenario = input.scenario;
  if (!isPlainRecord(scenario)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "A scenario must be a plain serialized scenario object.",
        scenario,
      ),
    );
  }
  if (typeof scenario.name !== "string" || scenario.name.length === 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "A scenario must carry a non-empty name.",
        scenario.name,
      ),
    );
  }
  if (!isSimScenarioKind(scenario.kind)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        `A scenario kind must be one of: flow, thermal, structural.`,
        scenario.kind,
      ),
    );
  }
  if (scenario.kind === "structural") {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioKindUnsupported,
        'The "structural" scenario kind is a reserved record vocabulary (Phase 69); no solver exists for it yet, and this boundary declines loudly instead of fabricating a result.',
        scenario,
      ),
    );
  }
  const kind = scenario.kind;

  // --- Domain (mm → m) -----------------------------------------------------
  const domain = parseDomain(scenario.domain);
  if (!domain.ok) return domain;
  let domainMinMm: readonly [number, number, number];
  let domainMaxMm: readonly [number, number, number];
  const boundsById = new Map<string, SimBodyBoundsMm>();
  for (const entry of input.bodyBounds ?? []) {
    boundsById.set(entry.bodyId, entry);
  }
  const boundsOf = (
    bodyIds: readonly string[],
  ): SimParseResult<
    readonly [
      readonly [number, number, number],
      readonly [number, number, number],
    ],
    SimError
  > => {
    const found: SimBodyBoundsMm[] = [];
    for (const bodyId of bodyIds) {
      const entry = boundsById.get(bodyId);
      if (entry === undefined) {
        return simFail(
          simError(
            SIM_ERROR_CODES.geometryUnavailable,
            `The scenario references body "${bodyId}", but no geometry bounds were supplied for it; the compile boundary refuses to guess a domain.`,
            bodyId,
          ),
        );
      }
      found.push(entry);
    }
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
    for (const entry of found) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis] ?? Infinity, entry.minMm[axis] ?? 0);
        max[axis] = Math.max(max[axis] ?? -Infinity, entry.maxMm[axis] ?? 0);
      }
    }
    return simOk([min, max]);
  };
  if (domain.value.kind === "explicit") {
    domainMinMm = domain.value.minMm ?? [0, 0, 0];
    domainMaxMm = domain.value.maxMm ?? [0, 0, 0];
  } else {
    const bodyIds = domain.value.bodyIds ?? [];
    const combined = boundsOf(bodyIds);
    if (!combined.ok) return combined;
    const margin = domain.value.marginMm ?? 0;
    const [min, max] = combined.value;
    domainMinMm = [
      (min[0] ?? 0) - margin,
      (min[1] ?? 0) - margin,
      (min[2] ?? 0) - margin,
    ];
    domainMaxMm = [
      (max[0] ?? 0) + margin,
      (max[1] ?? 0) + margin,
      (max[2] ?? 0) + margin,
    ];
  }
  const domainMinM: readonly [number, number, number] = [
    (domainMinMm[0] ?? 0) / MM_PER_M,
    (domainMinMm[1] ?? 0) / MM_PER_M,
    (domainMinMm[2] ?? 0) / MM_PER_M,
  ];
  const domainMaxM: readonly [number, number, number] = [
    (domainMaxMm[0] ?? 0) / MM_PER_M,
    (domainMaxMm[1] ?? 0) / MM_PER_M,
    (domainMaxMm[2] ?? 0) / MM_PER_M,
  ];
  const cellSizeM = domain.value.resolutionMm / MM_PER_M;

  // --- Conditions (SI magnitudes re-checked, directions normalized) --------
  if (scenario.conditions !== undefined && scenario.conditions !== null) {
    if (!Array.isArray(scenario.conditions)) {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          "A scenario's boundary conditions must be an array.",
          scenario.conditions,
        ),
      );
    }
  }
  const conditions: CompiledSimCondition[] = [];
  const conditionList = Array.isArray(scenario.conditions)
    ? scenario.conditions
    : [];
  for (const entry of conditionList) {
    const parsed = parseCondition(entry);
    if (!parsed.ok) return parsed;
    conditions.push(parsed.value);
  }

  // --- Gravity --------------------------------------------------------------
  let gravityMPerS2: readonly [number, number, number] = [0, -9.80665, 0];
  if (scenario.gravityMPerS2 !== undefined) {
    const parsed = finiteTriple(
      scenario.gravityMPerS2,
      "A scenario's gravity vector",
    );
    if (!parsed.ok) return parsed;
    gravityMPerS2 = parsed.value;
  }

  // --- Fluid -----------------------------------------------------------------
  if (typeof scenario.fluid !== "string" || scenario.fluid.length === 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioInvalid,
        "A scenario must carry a non-empty fluid selection.",
        scenario.fluid,
      ),
    );
  }
  const fluid = getSimFluid(scenario.fluid);
  if (fluid === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.fluidUnknown,
        `The scenario selects fluid "${scenario.fluid}", which no fluid property record defines (known: air, water, glycol).`,
        scenario.fluid,
      ),
    );
  }
  const fluidState = simFluidState(fluid, fluid.referenceK);
  if (!fluidState.ok) return fluidState;

  // --- Motor (the only mN·m/rpm → N·m/rad·s⁻¹ site) --------------------------
  let motor: CompiledSimMotor | undefined;
  if (scenario.motorId !== undefined && scenario.motorId !== null) {
    if (typeof scenario.motorId !== "string") {
      return simFail(
        simError(
          SIM_ERROR_CODES.motorInvalid,
          "A scenario's motor selection must be a motor id string.",
          scenario.motorId,
        ),
      );
    }
    if (input.motor === undefined) {
      return simFail(
        simError(
          SIM_ERROR_CODES.motorInvalid,
          `The scenario selects motor "${scenario.motorId}", but no motor record was supplied to compile.`,
          scenario.motorId,
        ),
      );
    }
    const parsedMotor = parseMotor(input.motor, scenario.motorId);
    if (!parsedMotor.ok) return parsedMotor;
    motor = parsedMotor.value;
  }

  // --- Characteristic length and the S9 regime numbers ------------------------
  const materialBodyIds: string[] = [];
  if (Array.isArray(scenario.materials)) {
    for (const entry of scenario.materials) {
      if (isPlainRecord(entry) && typeof entry.bodyId === "string") {
        materialBodyIds.push(entry.bodyId);
      }
    }
  }
  const covered =
    materialBodyIds.length > 0 &&
    materialBodyIds.every((bodyId) => boundsById.has(bodyId));
  let characteristicLengthM: number;
  if (covered) {
    const combined = boundsOf(materialBodyIds);
    if (!combined.ok) return combined;
    const [min, max] = combined.value;
    characteristicLengthM =
      Math.max(
        (max[0] ?? 0) - (min[0] ?? 0),
        (max[1] ?? 0) - (min[1] ?? 0),
        (max[2] ?? 0) - (min[2] ?? 0),
      ) / MM_PER_M;
  } else {
    characteristicLengthM = Math.min(
      (domainMaxM[0] ?? 0) - (domainMinM[0] ?? 0),
      (domainMaxM[1] ?? 0) - (domainMinM[1] ?? 0),
      (domainMaxM[2] ?? 0) - (domainMinM[2] ?? 0),
    );
  }
  const inletSpeeds = conditions
    .map((condition) => condition.velocityMPerS)
    .filter((velocity): velocity is readonly [number, number, number] => {
      return velocity !== undefined;
    })
    .map((velocity) =>
      Math.sqrt(
        (velocity[0] ?? 0) ** 2 +
          (velocity[1] ?? 0) ** 2 +
          (velocity[2] ?? 0) ** 2,
      ),
    );
  const speedMPerS =
    inletSpeeds.length > 0 ? Math.max(...inletSpeeds) : undefined;
  const gravityMagnitude = Math.sqrt(
    (gravityMPerS2[0] ?? 0) ** 2 +
      (gravityMPerS2[1] ?? 0) ** 2 +
      (gravityMPerS2[2] ?? 0) ** 2,
  );
  // The buoyancy scale is an unsigned magnitude: the largest |ΔT| across
  // the thermal conditions, so a colder-than-fluid wall ordered first
  // cannot shrink the scale a later warmer wall should set (Ra scales
  // with the magnitude either way).
  let deltaTemperatureK: number | undefined;
  for (const condition of conditions) {
    if (condition.temperatureK !== undefined) {
      const magnitude = Math.abs(
        condition.temperatureK - fluidState.value.temperatureK,
      );
      deltaTemperatureK = Math.max(deltaTemperatureK ?? 0, magnitude);
    }
    if (condition.ambientTemperatureK !== undefined) {
      const magnitude = Math.abs(
        condition.ambientTemperatureK - fluidState.value.temperatureK,
      );
      deltaTemperatureK = Math.max(deltaTemperatureK ?? 0, magnitude);
    }
  }
  const regime = simRegimeReport({
    ...(speedMPerS === undefined
      ? {}
      : {
          reynolds: simReynolds(
            fluidState.value.densityKgPerM3,
            speedMPerS,
            characteristicLengthM,
            fluidState.value.dynamicViscosityPaS,
          ),
          mach: simMach(speedMPerS, fluidState.value.speedOfSoundMPerS),
        }),
    prandtl: simPrandtl(
      fluidState.value.dynamicViscosityPaS,
      fluidState.value.specificHeatJPerKgK,
      fluidState.value.thermalConductivityWPerMK,
    ),
    ...(kind === "thermal" && deltaTemperatureK !== undefined
      ? {
          rayleigh: simRayleigh(
            gravityMagnitude,
            fluidState.value.thermalExpansionPerK,
            deltaTemperatureK,
            characteristicLengthM,
            fluidState.value.kinematicViscosityM2PerS,
            fluidState.value.thermalDiffusivityM2PerS,
          ),
        }
      : {}),
  });

  // --- Provenance and backend -------------------------------------------------
  const snapshotHash = simScenarioSnapshotHash(scenario);
  if (!snapshotHash.ok) return snapshotHash;
  let backend: "cpu" | "gpu" = "cpu";
  if (scenario.backend !== undefined && scenario.backend !== null) {
    if (scenario.backend !== "cpu" && scenario.backend !== "gpu") {
      return simFail(
        simError(
          SIM_ERROR_CODES.scenarioInvalid,
          'A scenario\'s backend preference must be "cpu" or "gpu".',
          scenario.backend,
        ),
      );
    }
    backend = scenario.backend;
  }

  return simOk(
    Object.freeze({
      kind,
      name: scenario.name,
      domainMinM,
      domainMaxM,
      cellSizeM,
      characteristicLengthM,
      gravityMPerS2,
      conditions: Object.freeze(conditions),
      fluid: fluidState.value,
      ...(motor === undefined ? {} : { motor }),
      backend,
      regime,
      scenarioSnapshotHash: snapshotHash.value,
    }),
  );
}

// ---------------------------------------------------------------------------
// Projection (solver → document) — the second of the TWO conversion functions
// ---------------------------------------------------------------------------

/** The dimension families a solver quantity may declare. */
export const SIM_QUANTITY_DIMENSIONS = [
  "length",
  "area",
  "volume",
  "velocity",
  "acceleration",
  "force",
  "pressure",
  "torque",
  "angularVelocity",
  "power",
  "energy",
  "temperature",
  "temperatureDifference",
  "time",
  "frequency",
  "mass",
  "dimensionless",
] as const;

export type SimQuantityDimension = (typeof SIM_QUANTITY_DIMENSIONS)[number];

/** A solver-space scalar: a name, its dimension, and its SI value. */
export interface SolverSimScalar {
  readonly name: string;
  readonly dimension: SimQuantityDimension;
  /** The value in the dimension's SI unit (m, m², m/s, N, Pa, K, s, …). */
  readonly value: number;
}

/** A solver-space uniform field block (SI geometry). */
export interface SolverSimField {
  readonly id: string;
  readonly unit?: string;
  readonly extent: readonly [number, number, number];
  /** The block's origin corner, m. */
  readonly originM: readonly [number, number, number];
  /** The cell spacing, m. */
  readonly spacingM: readonly [number, number, number];
  readonly dataType: "float32" | "float64";
  readonly values: readonly number[];
  readonly dimension: SimQuantityDimension;
}

/** A solver's outcome: the scalars and fields the projection converts. */
export interface SolverSimOutcome {
  readonly scalars: readonly SolverSimScalar[];
  readonly fields: readonly SolverSimField[];
}

/**
 * A projected quantity: the value in its DOCUMENT-SPACE unit, with the
 * unit explicit on the quantity — the S4 law's "explicit units on every
 * projected quantity".
 */
export interface SimProjectedQuantity {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
}

/** A projected uniform field block (document-space mm geometry). */
export interface SimProjectedField {
  readonly id: string;
  readonly unit?: string;
  readonly extent: readonly [number, number, number];
  /** The block's origin corner, mm. */
  readonly originMm: readonly [number, number, number];
  /** The cell spacing, mm. */
  readonly spacingMm: readonly [number, number, number];
  readonly dataType: "float32" | "float64";
  readonly values: readonly number[];
}

/** The projection's output. */
export interface SimProjectedOutcome {
  readonly scalars: readonly SimProjectedQuantity[];
  readonly fields: readonly SimProjectedField[];
}

/**
 * The document-space unit every dimension projects to, and the factor the
 * SI value multiplies by. Lengths convert (the document is canonical mm);
 * the SI-adjacent families the document already speaks (forces, pressures,
 * temperatures, times) keep their magnitudes and gain explicit units.
 */
export const SIM_PROJECTION_UNITS: Readonly<
  Record<
    SimQuantityDimension,
    { readonly unit: string; readonly factor: number }
  >
> = Object.freeze({
  length: { unit: "mm", factor: MM_PER_M },
  area: { unit: "mm^2", factor: MM_PER_M * MM_PER_M },
  volume: { unit: "mm^3", factor: MM_PER_M * MM_PER_M * MM_PER_M },
  velocity: { unit: "mm/s", factor: MM_PER_M },
  acceleration: { unit: "m/s^2", factor: 1 },
  force: { unit: "N", factor: 1 },
  pressure: { unit: "Pa", factor: 1 },
  torque: { unit: "N*m", factor: 1 },
  angularVelocity: { unit: "rad/s", factor: 1 },
  power: { unit: "W", factor: 1 },
  energy: { unit: "J", factor: 1 },
  temperature: { unit: "K", factor: 1 },
  temperatureDifference: { unit: "K", factor: 1 },
  time: { unit: "s", factor: 1 },
  frequency: { unit: "Hz", factor: 1 },
  mass: { unit: "kg", factor: 1 },
  dimensionless: { unit: "1", factor: 1 },
});

/**
 * Projects a solver outcome into document space (S4, solver → document):
 * every scalar gains its explicit document unit (lengths m → mm), and
 * field geometry converts to millimetres. Non-finite values decline
 * structured — a projected NaN is a fake result, never a quantity.
 */
export function projectSimResult(
  outcome: SolverSimOutcome,
): SimParseResult<SimProjectedOutcome, SimError> {
  const scalars: SimProjectedQuantity[] = [];
  for (const scalar of outcome.scalars) {
    if (typeof scalar.value !== "number" || !Number.isFinite(scalar.value)) {
      return simFail(
        simError(
          SIM_ERROR_CODES.quantityInvalid,
          `The projected quantity "${scalar.name}" is not a finite number.`,
          scalar,
        ),
      );
    }
    const projection = SIM_PROJECTION_UNITS[scalar.dimension];
    if (projection === undefined) {
      return simFail(
        simError(
          SIM_ERROR_CODES.quantityInvalid,
          `The projected quantity "${scalar.name}" declares the unknown dimension "${String(scalar.dimension)}".`,
          scalar,
        ),
      );
    }
    scalars.push(
      Object.freeze({
        name: scalar.name,
        value: scalar.value * projection.factor,
        unit: projection.unit,
      }),
    );
  }
  const fields: SimProjectedField[] = [];
  for (const field of outcome.fields) {
    const [ex, ey, ez] = field.extent;
    if (
      typeof ex !== "number" ||
      !Number.isInteger(ex) ||
      ex <= 0 ||
      typeof ey !== "number" ||
      !Number.isInteger(ey) ||
      ey <= 0 ||
      typeof ez !== "number" ||
      !Number.isInteger(ez) ||
      ez <= 0 ||
      field.values.length !== ex * ey * ez
    ) {
      return simFail(
        simError(
          SIM_ERROR_CODES.quantityInvalid,
          `The projected field "${field.id}" extent and value count disagree.`,
          field,
        ),
      );
    }
    for (const value of field.values) {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return simFail(
          simError(
            SIM_ERROR_CODES.quantityInvalid,
            `The projected field "${field.id}" carries a non-finite value.`,
            value,
          ),
        );
      }
    }
    const tripleOf = (
      triple: readonly [number, number, number],
    ): SimParseResult<readonly [number, number, number], SimError> => {
      if (
        !Array.isArray(triple) ||
        triple.length !== 3 ||
        triple.some(
          (entry) => typeof entry !== "number" || !Number.isFinite(entry),
        )
      ) {
        return simFail(
          simError(
            SIM_ERROR_CODES.quantityInvalid,
            `The projected field "${field.id}" carries a malformed triple.`,
            triple,
          ),
        );
      }
      return simOk(triple);
    };
    const origin = tripleOf(field.originM);
    if (!origin.ok) return origin;
    const spacing = tripleOf(field.spacingM);
    if (!spacing.ok) return spacing;
    const projection = SIM_PROJECTION_UNITS[field.dimension];
    if (projection === undefined) {
      return simFail(
        simError(
          SIM_ERROR_CODES.quantityInvalid,
          `The projected field "${field.id}" declares the unknown dimension "${String(field.dimension)}".`,
          field,
        ),
      );
    }
    const originMm: readonly [number, number, number] = [
      (origin.value[0] ?? 0) * MM_PER_M,
      (origin.value[1] ?? 0) * MM_PER_M,
      (origin.value[2] ?? 0) * MM_PER_M,
    ];
    const spacingMm: readonly [number, number, number] = [
      (spacing.value[0] ?? 0) * MM_PER_M,
      (spacing.value[1] ?? 0) * MM_PER_M,
      (spacing.value[2] ?? 0) * MM_PER_M,
    ];
    const projectedExtent: readonly [number, number, number] = [ex, ey, ez];
    fields.push(
      Object.freeze({
        id: field.id,
        ...(field.unit === undefined ? {} : { unit: field.unit }),
        extent: projectedExtent,
        originMm,
        spacingMm,
        dataType: field.dataType,
        values: field.values.map((value) => value * projection.factor),
      }),
    );
  }
  return simOk(
    Object.freeze({
      scalars: Object.freeze(scalars),
      fields: Object.freeze(fields),
    }),
  );
}
