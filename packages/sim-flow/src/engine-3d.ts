/**
 * The real 3D flow engine behind the Phase 61 `SimEngine` contract
 * (Phase 66c): the routing adapter that turns a compiled flow scenario
 * carrying a 3D stance (`flow3d` compile products) into a run over the
 * Phase 66a/66b kernels — CONSUMED, never re-implemented:
 *
 * - the STATIC 3D door (a stance without rotation) drives the 66a CPU
 *   oracle (`./stepper-3d`) over the full-3D occupancy grid;
 * - the MRF door (rotation kind "mrf") drives the 66b frozen-rotor
 *   stepper (`./mrf-3d`): a fixed shaft rate runs ONE streamed rung
 *   (fixed-RPM mode — motor-less scenarios keep their door), and the
 *   motor-driven mode sweeps an ω ladder of streamed rungs, solves the
 *   operating point against the compiled motor (`./operating-point`),
 *   and reads the performance AT the FOUND speed (`./fan-3d`'s
 *   extraction) — the rung protocol is fan-3d's own (the windowed tail
 *   mean of the negated rotor-torque series, the load convention),
 *   restated here so every rung streams progress and yields to the
 *   cooperative-cancellation window per step, the contract's own
 *   discipline;
 * - the RESOLVED-ROTATION door (the showcase) drives the 66b immersed
 *   moving-boundary stepper (`./resolved-rotation-3d`) at a FIXED rate
 *   — the motor-driven transient (rotor inertia + motor torque − aero
 *   load → ω(t)) is Phase 67's carve, and this engine declines the
 *   pairing loudly instead of approximating it.
 *
 * Routing honesty (the 66b rotation marker's engine twin): this engine
 * serves flow scenarios WITH 3D compile products and declines a
 * slice-only scenario loudly; the 2D engine declines a 3D-authored
 * scenario the same way — no silent misroute in either direction, and
 * `structural` stays every engine's decline. A GPU-PREFERRED 3D
 * scenario serves on THIS CPU oracle with the preference consumed:
 * no WGSL provider engine adapter is routed for 3D yet, and the honest
 * record is the summary's `servedBackend: "cpu"` — never a fabricated
 * GPU claim.
 *
 * The fan result's data half (law S7): the motor-driven run's load
 * curve rides as TWO history series — `load-torque` and
 * `motor-torque`, both N·m, uniformly sampled over the ladder's ω
 * rungs whose span rides as quantities — so the published fan
 * performance chart (the curve with the operating point superimposed)
 * is deterministic data the panel renders and the CSV exporter
 * writes, exactly the 63d curve-overlay family's shape. The operating
 * point, the powers, the BPF, and the S9 fan Re guidance line ride as
 * summary quantities with explicit units (S4), and the low-Re
 * qualitative flag joins the summary's regime record.
 */

import {
  type SimEngine,
  type SimEngineFieldChunk,
  type SimEngineProgress,
  type SimEngineRequest,
  type SimErrorCode,
  type SimError,
  type SimQualitativeFlag,
  type SimQuantityDimension,
  SIM_ERROR_CODES,
  SIM_FLOW_DEFAULT_STEP_BUDGET,
  SIM_REGIME_THRESHOLDS,
  type SimRegimeReport,
  type SimParseResult,
  type SimScenarioKind,
  type SimHistorySeries,
  type SimResult,
  type SimServedBackend,
  SIM_RESULT_SUMMARY_VERSION,
  type SolverSimField,
  type SolverSimScalar,
  projectSimResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";
import type { Lbm3dSolidMask } from "./state-3d";

import { LBM_PREVIEW_INTERVAL_STEPS, lbmPublishPreview } from "./engine-shared";
import { FAN_LOW_REYNOLDS_ADVISORY, extractFanPerformance } from "./fan-3d";
import { lbm3dSolidMaskFromGrid } from "./occupancy-3d";
import {
  bladePassFrequencyHz,
  motorTorqueAt,
  rpmOf,
  solveOperatingPoint,
  type TorqueSpeedSample,
} from "./operating-point";
import {
  type Lbm3dMrfConfig,
  type Lbm3dMrfStepper,
  createMrf3dStepper,
  mrfCylindricalZonePredicate,
} from "./mrf-3d";
import {
  type Lbm3dResolvedRotationConfig,
  createResolvedRotation3dStepper,
} from "./resolved-rotation-3d";
import {
  type Lbm3dRotationAxis,
  lbm3dCompileAxis,
  lbm3dPerpendicularRadius,
} from "./rotation-3d";
import {
  type Lbm3dStepper,
  type Lbm3dStepperConfig,
  createLbm3dStepper,
} from "./stepper-3d";

/** The 3D engine's stable id (the worker host's engine-selection key). */
export const LBM3D_SIM_ENGINE_ID = "lbm3d-cpu-reference";

/** The scenario kinds the 3D engine solves (the flow kind, 3D stance). */
export const LBM3D_SUPPORTED_KINDS: readonly SimScenarioKind[] = ["flow"];

/**
 * The ω ladder the motor-driven sweep runs, as fractions of the motor's
 * top speed (the analytic kinds' no-load speed, the tabulated kind's
 * fastest authored point): uniform rungs spanning the motor's domain —
 * the piecewise-linear load curve the solve interpolates. Four rungs is
 * the demo-honest count, a coarser curve than a production sweep (the
 * guide's accuracy bands state it).
 */
export const FLOW3D_LADDER_FRACTIONS: readonly number[] = [0.25, 0.5, 0.75, 1];

/** One history series in assembly position (the result model's shape). */
interface SeriesDraft {
  readonly name: string;
  readonly unit: string;
  readonly samples: readonly number[];
}

/** One macrotask yield — the cooperative-cancellation window. */
const yieldToHost = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

function refuse<T>(
  message: string,
  at: unknown,
  code: SimErrorCode = SIM_ERROR_CODES.scenarioInvalid,
): SimParseResult<T, SimError> {
  return simFail(simError(code, message, at));
}

/** The dominant coordinate axis of a (normalized) direction triple. */
function dominantAxisIndex(
  direction: readonly [number, number, number],
): 0 | 1 | 2 {
  const [dx, dy, dz] = direction;
  const components = [Math.abs(dx), Math.abs(dy), Math.abs(dz)];
  let best: 0 | 1 | 2 = 0;
  for (let i = 1; i < 3; i += 1) {
    if ((components[i] ?? 0) > (components[best] ?? 0)) best = i as 0 | 1 | 2;
  }
  return best;
}

/** One solver-space scalar, the dimension literal kept narrow. */
function scalar(
  name: string,
  dimension: SimQuantityDimension,
  value: number,
): SolverSimScalar {
  return { name, dimension, value };
}

// ---------------------------------------------------------------------------
// The face mapping (the 2D `mapFaces` twin, all six faces)
// ---------------------------------------------------------------------------

/** The compiled problem's six-face mapping, declined where 3D refuses. */
interface Mapped3dFaces {
  readonly specs: Pick<
    Lbm3dStepperConfig,
    "west" | "east" | "south" | "north" | "bottom" | "top"
  >;
  readonly characteristicVelocityMPerS: number;
  readonly referencePressurePa: number;
}

type BoxFace = "xMin" | "xMax" | "yMin" | "yMax" | "zMin" | "zMax";

/**
 * Maps a compiled problem's conditions onto the box's six face specs,
 * refusing what the 3D kernel cannot honor: non-flow condition kinds
 * and a domain without a velocity inlet (the characteristic velocity
 * the lattice units derive from). Absent faces take the wind-tunnel
 * defaults' 3D twin: convective outflow on the +X end, no-slip walls
 * elsewhere.
 */
function mapFaces3d(
  request: SimEngineRequest,
): SimParseResult<Mapped3dFaces, SimError> {
  const specs: Record<BoxFace, Lbm3dStepperConfig["west"] | undefined> = {
    xMin: undefined,
    xMax: undefined,
    yMin: undefined,
    yMax: undefined,
    zMin: undefined,
    zMax: undefined,
  };
  let inletSpeed = 0;
  let outletPressure: number | undefined;
  for (const condition of request.compiled.conditions) {
    const face = condition.face;
    if (face === undefined) {
      return refuse(
        `A "${condition.kind}" condition addresses no domain face — the structural point set (Phase 69) is not the 3D flow kernel's vocabulary.`,
        condition,
      );
    }
    switch (condition.kind) {
      case "velocity-inlet": {
        const velocity = condition.velocityMPerS;
        if (velocity === undefined) {
          return refuse(
            "A compiled velocity-inlet condition carried no velocity vector.",
            condition,
          );
        }
        const [vx, vy, vz] = [
          velocity[0] ?? 0,
          velocity[1] ?? 0,
          velocity[2] ?? 0,
        ];
        specs[face] = { kind: "velocity-inlet", velocityMPerS: [vx, vy, vz] };
        inletSpeed = Math.max(
          inletSpeed,
          Math.sqrt(vx * vx + vy * vy + vz * vz),
        );
        break;
      }
      case "pressure-outlet": {
        if (condition.pressurePa === undefined) {
          return refuse(
            "A compiled pressure-outlet condition carried no pressure.",
            condition,
          );
        }
        specs[face] = {
          kind: "pressure-outlet",
          pressurePa: condition.pressurePa,
        };
        outletPressure = condition.pressurePa;
        break;
      }
      case "wall":
        specs[face] = { kind: "wall", slip: condition.slip === true };
        break;
      case "symmetry":
        specs[face] = { kind: "symmetry" };
        break;
      default:
        return refuse(
          `A "${condition.kind}" condition cannot ride the 3D flow kernel (it consumes velocity-inlet, pressure-outlet, wall, and symmetry).`,
          condition,
        );
    }
  }
  if (inletSpeed <= 0) {
    return refuse(
      "A 3D flow scenario needs at least one velocity-inlet on a domain face — the characteristic velocity the lattice units derive from.",
      request.compiled.conditions,
    );
  }
  const spec = (face: BoxFace, fallback: Lbm3dStepperConfig["west"]) => {
    const authored = specs[face];
    return authored === undefined ? fallback : authored;
  };
  return simOk({
    specs: {
      west: spec("xMin", { kind: "wall", slip: false }),
      east: spec("xMax", { kind: "convective-outflow" }),
      south: spec("yMin", { kind: "wall", slip: false }),
      north: spec("yMax", { kind: "wall", slip: false }),
      bottom: spec("zMin", { kind: "wall", slip: false }),
      top: spec("zMax", { kind: "wall", slip: false }),
    },
    characteristicVelocityMPerS: inletSpeed,
    referencePressurePa: outletPressure ?? 0,
  });
}

// ---------------------------------------------------------------------------
// The streaming run loop (the 2D `streamStepper` twin, per-step yields)
// ---------------------------------------------------------------------------

/** What one streamed 3D run wants to emit between steps. */
interface Emission3dChannels {
  readonly onProgress?: (progress: SimEngineProgress) => void;
  readonly onFieldChunk?: (chunk: SimEngineFieldChunk) => void;
  readonly progressBase: number;
  readonly progressTotal: number;
  readonly preview: boolean;
}

/**
 * Steps any 3D stepper to its budget with the contract's discipline: a
 * macrotask yield per step (the cooperative cancellation window — a
 * conforming engine never catches the host's callback throws), progress
 * after every step, and a preview round every
 * {@link LBM_PREVIEW_INTERVAL_STEPS} steps plus the final one (law S6:
 * the round publishes the DOCUMENT-SPACE speed block in protocol
 * chunks, so overlay application IS committed application).
 */
async function stream3d<S extends Lbm3dStepper>(
  stepper: S,
  stepBudget: number,
  channels: Emission3dChannels,
): Promise<void> {
  const publishable = channels.preview && channels.onFieldChunk !== undefined;
  for (let step = 1; step <= stepBudget; step += 1) {
    await yieldToHost();
    stepper.advance();
    if (stepper.diverged) break;
    channels.onProgress?.({
      step: channels.progressBase + stepper.step,
      totalSteps: channels.progressTotal,
    });

    if (
      publishable &&
      (step % LBM_PREVIEW_INTERVAL_STEPS === 0 || step === stepBudget)
    ) {
      lbmPublishPreview(stepper.solverFields(), channels.onFieldChunk);
    }
  }
}

// ---------------------------------------------------------------------------
// The result assembly (the 2D `lbmRunSimResult` twin)
// ---------------------------------------------------------------------------

/** The shared facts every 3D result carries. */
interface Flow3dReportBase {
  readonly scenarioName: string;
  readonly scenarioSnapshotHash: string;
  readonly regime: SimRegimeReport;
  readonly servedBackend: SimServedBackend;
  readonly diverged: boolean;
  readonly steps: number;
  readonly physicalDurationS: number;
  /** Extra S9 flags the run's own regime line raised (the fan Re line). */
  readonly extraQualitative: readonly SimQualitativeFlag[];
}

/**
 * Assembles the SimResult: scalars + fields through the S4 projection,
 * the S9 regime record with the run's own extra flags appended, and the
 * diverged-failure discipline (a blown-up run persists FAILED carrying
 * `sim/run-diverged`, never fabricated fields — a diverged run reports
 * nothing but its failure).
 */
function flow3dSimResult(
  base: Flow3dReportBase,
  scalars: readonly SolverSimScalar[],
  fields: readonly SolverSimField[],
  histories: readonly SeriesDraft[],
): SimParseResult<SimResult, SimError> {
  const projected = projectSimResult({
    scalars: base.diverged ? [] : scalars,
    fields: base.diverged ? [] : fields,
  });
  if (!projected.ok) return projected;
  const qualitative = [...base.regime.qualitative, ...base.extraQualitative];
  return simOk({
    summary: {
      schemaVersion: SIM_RESULT_SUMMARY_VERSION,
      scenarioSnapshotHash: base.scenarioSnapshotHash,
      status: base.diverged ? "failed" : "completed",
      regime: { ...base.regime, qualitative },
      quantities: projected.value.scalars,
      servedBackend: base.servedBackend,
      ...(base.diverged
        ? {
            failureCode: SIM_ERROR_CODES.runDiverged,
            failureMessage: `The 3D kernel's divergence sentinel froze the run of "${base.scenarioName}" at step ${String(base.steps)}; no fields or quantities are reported for a blown-up run.`,
          }
        : {}),
    },
    fields: projected.value.fields,
    histories: base.diverged ? [] : histories,
  });
}

/** A diverged run's terminal assembly (nothing but the failure). */
function diverged3dResult(
  base: Flow3dReportBase,
  stepper: Lbm3dStepper,
): SimParseResult<SimResult, SimError> {
  return flow3dSimResult(
    {
      ...base,
      diverged: true,
      steps: stepper.step,
      physicalDurationS: stepper.step * stepper.meta.units.timeStepS,
    },
    [],
    [],
    [],
  );
}

/** The always-present scalar pair: steps and physical duration. */
function baseScalars(
  steps: number,
  physicalDurationS: number,
): readonly SolverSimScalar[] {
  return [
    scalar("steps", "dimensionless", steps),
    scalar("physical-duration", "time", physicalDurationS),
  ];
}

/**
 * The windowed tail mean (fan-3d's own rung rule): the mean of the
 * LAST `window` samples of a series.
 */
function windowedTailMean(
  samples: readonly number[],
  window: number,
): number | undefined {
  if (samples.length === 0 || window < 1) return undefined;
  const start = Math.max(0, samples.length - window);
  let sum = 0;
  for (let i = start; i < samples.length; i += 1) {
    sum += samples[i] ?? 0;
  }
  return sum / (samples.length - start);
}

/** The RMS fluctuation about a windowed mean (law S9's split). */
function windowedTailFluctuationRms(
  samples: readonly number[],
  window: number,
  mean: number,
): number | undefined {
  if (samples.length === 0 || window < 1) return undefined;
  const start = Math.max(0, samples.length - window);
  let sum = 0;
  let count = 0;
  for (let i = start; i < samples.length; i += 1) {
    const delta = (samples[i] ?? 0) - mean;
    sum += delta * delta;
    count += 1;
  }
  return count > 0 ? Math.sqrt(sum / count) : undefined;
}

// ---------------------------------------------------------------------------
// The fan readouts shared by every rotating door
// ---------------------------------------------------------------------------

/** The rotor's tip radius (cells): solids inside the rotating zone. */
function rotorTipRadiusCells(
  mask: Lbm3dSolidMask,
  axis: Lbm3dRotationAxis,
  radiusCells: number,
): number {
  const { nx, ny, nz } = mask;
  const plane = nx * ny;
  let maxRadius = 0;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const index = x + y * nx + z * plane;
        if (mask.solid[index] !== 1) continue;
        const radius = lbm3dPerpendicularRadius(axis, x, y, z);
        if (radius <= radiusCells) {
          maxRadius = Math.max(maxRadius, radius);
        }
      }
    }
  }
  return maxRadius;
}

/** The tip-dynamic Reynolds line and its S9 flags (fan-3d's rule). */
function fanRegimeOf(
  omegaRadPerS: number,
  tipRadiusM: number,
  kinematicViscosityM2PerS: number,
): {
  readonly reynolds: number;
  readonly flags: readonly SimQualitativeFlag[];
} {
  const tipSpeed = omegaRadPerS * tipRadiusM;
  const reynolds = (tipSpeed * 2 * tipRadiusM) / kinematicViscosityM2PerS;
  const flags: SimQualitativeFlag[] = [];
  if (reynolds < FAN_LOW_REYNOLDS_ADVISORY) flags.push("low-reynolds-fan");
  if (reynolds >= SIM_REGIME_THRESHOLDS.turbulentReynolds) {
    flags.push("turbulence-dominated");
  }
  return { reynolds, flags };
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

async function runFlow3dEngine(
  request: SimEngineRequest,
  onProgress?: (progress: SimEngineProgress) => void,
  onFieldChunk?: (chunk: SimEngineFieldChunk) => void,
): Promise<SimParseResult<SimResult, SimError>> {
  const compiled = request.compiled;
  if (!LBM3D_SUPPORTED_KINDS.includes(compiled.kind)) {
    return simFail(
      simError(
        SIM_ERROR_CODES.scenarioKindUnsupported,
        `The 3D reference flow engine does not solve the "${compiled.kind}" scenario kind (it serves flow scenarios with a 3D stance; structural is served by the structural engine through the routed default engine).`,
        compiled.kind,
      ),
    );
  }
  if (compiled.backend === "gpu") {
    return simFail(
      simError(
        SIM_ERROR_CODES.backendUnavailable,
        'The scenario prefers the "gpu" backend; the 3D reference engine runs it only through the ROUTED default engine (createDefaultSimEngine), which serves the 3D CPU oracle with the preference consumed — a direct 3D-engine call declines loudly instead of silently falling back (no WGSL provider engine adapter is routed for 3D yet; the summary\'s servedBackend is the honest record).',
        compiled.backend,
      ),
    );
  }
  const grid = compiled.occupancy3d;
  const stance = compiled.flow3d;
  if (grid === undefined || stance === undefined) {
    return simFail(
      simError(
        SIM_ERROR_CODES.geometryUnavailable,
        "The 3D flow engine serves flow scenarios carrying a 3D stance (the flow3d compile products): this compiled problem has none — it is the 2D wind tunnel's slice shape, and the 2D engine owns it.",
        compiled.name,
      ),
    );
  }
  const mask = lbm3dSolidMaskFromGrid(grid);
  if (!mask.ok) return mask;
  const faces = mapFaces3d(request);
  if (!faces.ok) return faces;
  const originM: readonly [number, number, number] = [
    grid.originM[0] ?? 0,
    grid.originM[1] ?? 0,
    grid.originM[2] ?? 0,
  ];
  const stepBudget = compiled.run?.stepBudget ?? SIM_FLOW_DEFAULT_STEP_BUDGET;
  const averagingWindow =
    compiled.run?.averagingStartStep ?? Math.max(1, Math.ceil(stepBudget / 2));
  const baseConfig = {
    mask: mask.value,
    fluid: compiled.fluid,
    cellSizeM: compiled.cellSizeM,
    characteristicVelocityMPerS: faces.value.characteristicVelocityMPerS,
    // The 3D damping choice: the low-Mach knob at 0.03 keeps the base
    // flow's lattice speed gentle through voxelized blockage (the
    // staircase tube's effective throat), trading a larger dt for
    // stability headroom — the 2D tunnel's 0.05 default presumes a
    // mostly-open slice; the 3D ducts do not.
    latticeVelocity: 0.03,
    originM,
    referencePressurePa: faces.value.referencePressurePa,
    ...faces.value.specs,
  };
  const base: Flow3dReportBase = {
    scenarioName: compiled.name,
    scenarioSnapshotHash: compiled.scenarioSnapshotHash,
    regime: compiled.regime,
    servedBackend: "cpu",
    diverged: false,
    steps: 0,
    physicalDurationS: 0,
    extraQualitative: [],
  };

  // --- The static 3D door (no rotation): the 66a CPU oracle ----------
  if (stance.rotation === undefined) {
    const created = createLbm3dStepper(baseConfig);
    if (!created.ok) return created;
    const stepper = created.value;
    await stream3d(stepper, stepBudget, {
      ...(onProgress === undefined ? {} : { onProgress }),
      ...(onFieldChunk === undefined ? {} : { onFieldChunk }),
      progressBase: 0,
      progressTotal: stepBudget,
      preview: true,
    });
    if (stepper.diverged) return diverged3dResult(base, stepper);
    const histories = stepper.forceState().history;
    const scalars = [
      ...baseScalars(stepper.step, stepper.step * stepper.meta.units.timeStepS),
    ];
    const forceSeries: readonly (readonly [
      string,
      SimHistorySeries | undefined,
    ])[] = [
      ["mean-drag-force", histories[0]],
      ["mean-lift-force", histories[1]],
      ["mean-side-force", histories[2]],
    ];
    for (const [name, series] of forceSeries) {
      const samples = series?.samples ?? [];
      const mean = windowedTailMean(samples, averagingWindow);
      if (mean !== undefined) {
        scalars.push(scalar(name, "force", mean));
      }
    }
    return flow3dSimResult(
      {
        ...base,
        steps: stepper.step,
        physicalDurationS: stepper.step * stepper.meta.units.timeStepS,
      },
      scalars,
      stepper.solverFields(),
      histories,
    );
  }

  // --- The rotating doors: axis, zone, rotor facts --------------------
  const rotation = stance.rotation;
  const axis = lbm3dCompileAxis(
    { pointM: rotation.axisPointM, direction: rotation.axisDirection },
    originM,
    compiled.cellSizeM,
  );
  if (!axis.ok) return axis;
  const zoneRadiusCells = rotation.zoneRadiusM / compiled.cellSizeM;
  const tipRadiusCells = rotorTipRadiusCells(
    mask.value,
    axis.value,
    zoneRadiusCells,
  );
  if (tipRadiusCells <= 0) {
    return refuse(
      "The rotating scenario's zone encloses no solid nodes — the rotor must live inside the authored rotating zone, and the engine refuses to spin an empty frame.",
      rotation.zoneRadiusM,
    );
  }
  const tipRadiusM = tipRadiusCells * compiled.cellSizeM;
  const axisIndex = dominantAxisIndex(rotation.axisDirection);
  const fanRegime = (omegaRadPerS: number) =>
    fanRegimeOf(
      omegaRadPerS,
      tipRadiusM,
      compiled.fluid.kinematicViscosityM2PerS,
    );

  // --- The resolved-rotation door: the showcase, fixed rate only -----
  if (rotation.kind === "resolved-rotation") {
    if (rotation.rpmMode === "motor") {
      return refuse(
        "The resolved-rotation showcase runs a FIXED shaft rate only: the motor-driven transient (rotor inertia + motor torque − aero load → ω(t)) is Phase 67's dynamics carve, and this engine declines the pairing instead of approximating it — run MRF for the motor-driven operating point.",
        rotation.rpmMode,
      );
    }
    const omega = rotation.fixedOmegaRadPerS ?? 0;
    if (!(omega > 0)) {
      return refuse(
        "A resolved-rotation stance compiled no fixed shaft rate.",
        rotation.fixedOmegaRadPerS,
      );
    }
    // The rotor predicate over displacement coordinates (lattice cells,
    // the 66b contract): the voxelized solid at the nearest node,
    // bounded by the measured tip radius — the staircase rotor carried
    // as the rigid body it is.
    const { nx, ny, nz } = mask.value;
    const plane = nx * ny;
    const [axp, ayp, azp] = axis.value.pointLattice;
    const [ex, ey, ez] = axis.value.direction;
    const rotor = (dx: number, dy: number, dz: number): boolean => {
      const along = dx * ex + dy * ey + dz * ez;
      const px = dx - along * ex;
      const py = dy - along * ey;
      const pz = dz - along * ez;
      if (Math.sqrt(px * px + py * py + pz * pz) > tipRadiusCells) {
        return false;
      }
      const x = Math.round(axp + dx);
      const y = Math.round(ayp + dy);
      const z = Math.round(azp + dz);
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz) {
        return false;
      }
      return mask.value.solid[x + y * nx + z * plane] === 1;
    };
    const config: Lbm3dResolvedRotationConfig = {
      ...baseConfig,
      rotation: { kind: "resolved-rotation" },
      axis: {
        pointM: rotation.axisPointM,
        direction: rotation.axisDirection,
      },
      omegaRadPerS: omega,
      rotor,
    };
    const created = createResolvedRotation3dStepper(config);
    if (!created.ok) return created;
    const stepper = created.value;
    await stream3d(stepper, stepBudget, {
      ...(onProgress === undefined ? {} : { onProgress }),
      ...(onFieldChunk === undefined ? {} : { onFieldChunk }),
      progressBase: 0,
      progressTotal: stepBudget,
      preview: true,
    });
    if (stepper.diverged) return diverged3dResult(base, stepper);
    const histories = [
      ...stepper.forceState().history,
      ...stepper.rotationState().history,
    ];
    const torqueSamples = stepper.rotationState().history[0]?.samples ?? [];
    // The load convention: with Ω > 0 the steady fluid-on-rotor torque
    // is negative, so the load torque is the negated mean (fan-3d's).
    const meanTorque = windowedTailMean(torqueSamples, averagingWindow);
    const fluctuation =
      meanTorque === undefined
        ? undefined
        : windowedTailFluctuationRms(
            torqueSamples,
            averagingWindow,
            meanTorque,
          );
    const regime = fanRegime(omega);
    const scalars: SolverSimScalar[] = [
      ...baseScalars(stepper.step, stepper.step * stepper.meta.units.timeStepS),
      scalar("shaft-speed", "angularVelocity", omega),
      scalar(
        "steps-per-revolution",
        "dimensionless",
        stepper.meta.stepsPerRevolution,
      ),
      scalar("tip-radius", "length", tipRadiusM),
      ...(meanTorque === undefined
        ? []
        : [
            scalar("mean-rotor-torque", "torque", -meanTorque),
            scalar("shaft-power", "power", -meanTorque * omega),
          ]),
      ...(meanTorque !== undefined && fluctuation !== undefined
        ? [scalar("rotor-torque-fluctuation-rms", "torque", fluctuation)]
        : []),
      scalar(
        "blade-pass-frequency",
        "frequency",
        bladePassFrequencyHz(rotation.bladeCount, rpmOf(omega)),
      ),
      scalar("fan-reynolds-tip", "dimensionless", regime.reynolds),
    ];
    return flow3dSimResult(
      {
        ...base,
        steps: stepper.step,
        physicalDurationS: stepper.step * stepper.meta.units.timeStepS,
        extraQualitative: regime.flags,
      },
      scalars,
      stepper.solverFields(),
      histories,
    );
  }

  // --- The MRF door: the honest steady-fan default ---------------------
  const mrfConfig = (omegaRadPerS: number): Lbm3dMrfConfig => ({
    ...baseConfig,
    rotation: { kind: "mrf" },
    axis: {
      pointM: rotation.axisPointM,
      direction: rotation.axisDirection,
    },
    omegaRadPerS,
    rotatingZone: mrfCylindricalZonePredicate(axis.value, zoneRadiusCells),
  });

  // The FIXED mode: one streamed rung at the authored rate, the
  // performance read at it (motor-less scenarios keep their door).
  if (rotation.rpmMode === "fixed") {
    const omega = rotation.fixedOmegaRadPerS ?? 0;
    if (!(omega > 0)) {
      return refuse(
        "A fixed-rpm MRF stance compiled no shaft rate.",
        rotation.fixedOmegaRadPerS,
      );
    }
    const created = createMrf3dStepper(mrfConfig(omega));
    if (!created.ok) return created;
    const stepper = created.value;
    await stream3d(stepper, stepBudget, {
      ...(onProgress === undefined ? {} : { onProgress }),
      ...(onFieldChunk === undefined ? {} : { onFieldChunk }),
      progressBase: 0,
      progressTotal: stepBudget,
      preview: true,
    });
    if (stepper.diverged) return diverged3dResult(base, stepper);
    const histories = [
      ...stepper.forceState().history,
      ...stepper.rotationState().history,
    ];
    const torqueSamples = stepper.rotationState().history[0]?.samples ?? [];
    const meanTorque = windowedTailMean(torqueSamples, averagingWindow);
    const performance = extractFanPerformance(
      stepper.snapshotSI(),
      mask.value,
      axisIndex,
      compiled.cellSizeM,
    );
    if (!performance.ok) return performance;
    const regime = fanRegime(omega);
    const scalars: SolverSimScalar[] = [
      ...baseScalars(stepper.step, stepper.step * stepper.meta.units.timeStepS),
      scalar("shaft-speed", "angularVelocity", omega),
      scalar("tip-radius", "length", tipRadiusM),
      ...(meanTorque === undefined
        ? []
        : [
            scalar("mean-rotor-torque", "torque", -meanTorque),
            scalar("shaft-power", "power", -meanTorque * omega),
          ]),
      scalar("airflow", "volumetricFlow", performance.value.airflowM3PerS),
      scalar("pressure-rise", "pressure", performance.value.deltaPPa),
      scalar(
        "fan-air-power",
        "power",
        performance.value.deltaPPa * performance.value.airflowM3PerS,
      ),
      scalar(
        "blade-pass-frequency",
        "frequency",
        bladePassFrequencyHz(rotation.bladeCount, rpmOf(omega)),
      ),
      scalar("fan-reynolds-tip", "dimensionless", regime.reynolds),
    ];
    return flow3dSimResult(
      {
        ...base,
        steps: stepper.step,
        physicalDurationS: stepper.step * stepper.meta.units.timeStepS,
        extraQualitative: regime.flags,
      },
      scalars,
      stepper.solverFields(),
      histories,
    );
  }

  // The MOTOR-DRIVEN mode: sweep the ladder, solve the operating point,
  // verify AT the found speed — the demo's own path. The motor is the
  // compiled record (the compile door already refused a motor-driven
  // stance without one).
  const motor = compiled.motor;
  if (motor === undefined) {
    return refuse(
      "A motor-driven MRF stance compiled no motor record — the operating point has no T_motor(ω) to solve against.",
      compiled.motor,
      SIM_ERROR_CODES.motorInvalid,
    );
  }
  const motorTopSpeed =
    motor.kind === "tabulated"
      ? Math.max(...motor.points.map((point) => point.speedRadPerS))
      : motor.noLoadSpeedRadPerS;
  if (!(motorTopSpeed > 0)) {
    return refuse(
      "A motor-driven MRF stance needs a motor with a positive top speed to derive the ω ladder from.",
      motor,
      SIM_ERROR_CODES.motorInvalid,
    );
  }
  const ladder = FLOW3D_LADDER_FRACTIONS.map(
    (fraction) => fraction * motorTopSpeed,
  );
  const totalSteps = (ladder.length + 1) * stepBudget;
  const runRung = async (
    omega: number,
    progressBase: number,
    preview: boolean,
  ): Promise<
    SimParseResult<
      { stepper: Lbm3dMrfStepper; meanTorque: number | undefined },
      SimError
    >
  > => {
    const created = createMrf3dStepper(mrfConfig(omega));
    if (!created.ok) return created;
    const stepper = created.value;
    await stream3d(stepper, stepBudget, {
      ...(onProgress === undefined ? {} : { onProgress }),
      ...(onFieldChunk === undefined ? {} : { onFieldChunk }),
      progressBase,
      progressTotal: totalSteps,
      preview,
    });
    if (stepper.diverged) {
      return simFail(
        simError(
          SIM_ERROR_CODES.runDiverged,
          `The MRF rung at ${omega.toPrecision(6)} rad/s diverged (step ${String(stepper.step)}) — the run freezes at its last valid step and no load sample is fabricated.`,
          { omegaRadPerS: omega, step: stepper.step },
        ),
      );
    }
    const samples = stepper.rotationState().history[0]?.samples ?? [];
    return simOk({
      stepper,
      meanTorque: windowedTailMean(samples, averagingWindow),
    });
  };
  const samples: TorqueSpeedSample[] = [];
  for (const [index, omega] of ladder.entries()) {
    const rung = await runRung(omega, index * stepBudget, false);
    if (!rung.ok) return rung;
    if (rung.value.meanTorque === undefined) {
      return refuse(
        "A load-curve rung recorded no torque samples to average.",
        { omegaRadPerS: omega },
      );
    }
    samples.push({ omegaRadPerS: omega, torqueNPerM: -rung.value.meanTorque });
  }
  const solve = solveOperatingPoint(motor, samples);
  if (!solve.ok) return solve;
  // The verification rung AT the found speed — streamed, previewed, and
  // the run whose fields persist (the operating point the chart
  // superimposes onto the swept curve).
  const verify = await runRung(
    solve.value.omegaRadPerS,
    ladder.length * stepBudget,
    true,
  );
  if (!verify.ok) return verify;
  // Unreachable today — the verification rung runs the ladder rungs'
  // own streamed protocol at a speed inside their span, so its torque
  // series carries the same per-step samples. But if it ever recorded
  // none, publishing a 0 N·m cross-check would FABRICATE agreement
  // with the solve — decline loudly instead, the ladder rungs' own
  // missing-mean decline above.
  if (verify.value.meanTorque === undefined) {
    return refuse(
      "The verification rung recorded no torque samples to average.",
      { omegaRadPerS: solve.value.omegaRadPerS },
    );
  }
  const stepper = verify.value.stepper;
  const performance = extractFanPerformance(
    stepper.snapshotSI(),
    mask.value,
    axisIndex,
    compiled.cellSizeM,
  );
  if (!performance.ok) return performance;
  const { omegaRadPerS, torqueNPerM, rpm } = solve.value;
  const regime = fanRegime(omegaRadPerS);
  const electricalPowerW =
    motor.kind === "dc-brushed" || motor.kind === "bldc"
      ? (motor.nominalVoltageV * torqueNPerM) / motor.ktNPerA
      : undefined;
  const shaftPowerW = torqueNPerM * omegaRadPerS;
  const fanAirPowerW =
    performance.value.deltaPPa * performance.value.airflowM3PerS;
  const scalars: readonly SolverSimScalar[] = [
    ...baseScalars(stepper.step, stepper.step * stepper.meta.units.timeStepS),
    scalar("operating-speed", "angularVelocity", omegaRadPerS),
    scalar("operating-rpm", "frequency", rpm),
    scalar("operating-torque", "torque", torqueNPerM),
    scalar("verify-rung-torque", "torque", -verify.value.meanTorque),
    scalar("airflow", "volumetricFlow", performance.value.airflowM3PerS),
    scalar("pressure-rise", "pressure", performance.value.deltaPPa),
    scalar("shaft-power", "power", shaftPowerW),
    scalar("fan-air-power", "power", fanAirPowerW),
    ...(electricalPowerW === undefined
      ? []
      : [
          scalar("electrical-power", "power", electricalPowerW),
          scalar(
            "motor-efficiency",
            "dimensionless",
            shaftPowerW / electricalPowerW,
          ),
          scalar(
            "system-efficiency",
            "dimensionless",
            fanAirPowerW / electricalPowerW,
          ),
          // Phase 70's "air per watt at the operating point": the
          // delivered flow per electrical watt (m³/J) — the motor in the
          // loop makes it the system objective the roadmap names.
          scalar(
            "airflow-per-electrical-watt",
            "volumetricFlowPerPower",
            performance.value.airflowM3PerS / electricalPowerW,
          ),
        ]),
    scalar(
      "blade-pass-frequency",
      "frequency",
      bladePassFrequencyHz(rotation.bladeCount, rpm),
    ),
    scalar("fan-reynolds-tip", "dimensionless", regime.reynolds),
    scalar("tip-radius", "length", tipRadiusM),
    scalar("ladder-min-speed", "angularVelocity", ladder[0] ?? 0),
    scalar(
      "ladder-max-speed",
      "angularVelocity",
      ladder[ladder.length - 1] ?? 0,
    ),
  ];
  // The published fan performance chart's data half: the load curve and
  // the motor curve over the SAME uniform ladder (the operating point
  // superimposes from the quantities above).
  const histories: readonly SeriesDraft[] = [
    {
      name: "load-torque",
      unit: "N*m",
      samples: samples.map((sample) => sample.torqueNPerM),
    },
    {
      name: "motor-torque",
      unit: "N*m",
      samples: ladder.map((omega) => motorTorqueAt(motor, omega)),
    },
  ];
  return flow3dSimResult(
    {
      ...base,
      steps: stepper.step,
      physicalDurationS: stepper.step * stepper.meta.units.timeStepS,
      extraQualitative: regime.flags,
    },
    scalars,
    stepper.solverFields(),
    histories,
  );
}

/** The deterministic 3D reference flow engine (Phase 66c's routing door). */
export function createFlow3dSimEngine(): SimEngine {
  return {
    id: LBM3D_SIM_ENGINE_ID,
    supportedKinds: LBM3D_SUPPORTED_KINDS,
    backend: "cpu",
    run: (request, onProgress, onFieldChunk) =>
      runFlow3dEngine(request, onProgress, onFieldChunk),
  };
}
