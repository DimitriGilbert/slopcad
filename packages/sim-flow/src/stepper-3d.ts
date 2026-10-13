/**
 * The 3D stepper (Phase 66a): the pure, deterministic driver that owns
 * one D3Q19 LBM run — the CPU oracle the WGSL 3D provider is validated
 * against, run at reduced resolutions (the roadmap's own phrasing: the
 * GPU is first for throughput, the oracle stays the truth). Everything
 * a step does is fixed-order arithmetic over the SoA state:
 *
 *   1. macroscopic recompute (the divergence sentinel lives here);
 *   2. collision (BGK/TRT, `./relaxation-3d` — unforced, the module's
 *      stated scope line);
 *   3. push streaming (`./streaming-3d`);
 *   4. face conditions (Zou/He, convective, walls — `./boundaries-3d`);
 *   5. full-way bounce-back reflection + momentum-exchange impulse
 *      (three components);
 *   6. buffer swap, force recording, ledger close.
 *
 * Pause/step/resume is the object itself: `run(k)`, read state, `run(m)`
 * — the entire evolution lives in the stepper, no timers, no ambient
 * state, no React, no DOM, no node APIs (law S2), so the same inputs
 * produce bitwise-identical bytes every time (pinned by test). A run
 * that diverges sets `diverged` and freezes — a blown-up BGK run
 * reports itself instead of fabricating fields.
 *
 * The audit-ledger discipline of 63a, generalized to 3D: every step's
 * `Lbm3dMomentumBookkeeping` records the three exact terms (face
 * overwrites, solid impulses, dropped populations) per component, and
 * the identity ΔM = face overwrites − solid impulses − dropped closes
 * over ALL distributions (solid bounce-back storage included) — the
 * momentum-change sanity the force integration is pinned against.
 *
 * SI sits at this door (law S4): the config takes SI (velocities m/s,
 * pressures Pa, the fluid state, the cell size), `lattice-units-3d`
 * derives the closure once, and every read-out accessor converts back —
 * `solverFields()` emits sim-core `SolverSimField`s ready for the S4
 * projection with no second conversion site.
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  type SimFluidState,
  type SimHistorySeries,
  type SimParseResult,
  type SolverSimField,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";
import type { Lbm3dRotationMarker } from "./rotation-3d";

import {
  type Lbm3dFace,
  type Lbm3dFaceCondition,
  type Lbm3dFaceMomentumLedger,
  lbm3dApplyFaceConditions,
} from "./boundaries-3d";
import { D3Q19_Q, D3Q19_VELOCITIES } from "./d3q19";
import { Lbm3dForceAccumulator } from "./forces-3d";
import {
  type LbmCollisionModel,
  lbmCollisionModelProblem,
  lbmRelaxationRates,
  type LbmRelaxationRates,
} from "./relaxation";
import {
  LBM_MAX_LATTICE_VELOCITY,
  type LbmUnitSystemInputs,
} from "./lattice-units";
import { type Lbm3dUnitSystem, lbm3dUnitSystem } from "./lattice-units-3d";
import { lbm3dCollide } from "./relaxation-3d";
import {
  createLbm3dState,
  lbm3dComputeMacroscopic,
  lbm3dReflectSolids,
  lbm3dTotalMomentum,
  type Lbm3dSolidMask,
  type Lbm3dState,
} from "./state-3d";
import { lbm3dStream, lbm3dSwap } from "./streaming-3d";

/** A face condition authored in SI — the stepper converts to lattice units. */
export type Lbm3dFaceSpec =
  | {
      readonly kind: "velocity-inlet";
      /** The inlet velocity vector, m/s (its normal must point into the domain). */
      readonly velocityMPerS: readonly [number, number, number];
    }
  | {
      readonly kind: "pressure-outlet";
      /** The outlet static pressure, Pa (read against the reference pressure). */
      readonly pressurePa: number;
    }
  | { readonly kind: "convective-outflow" }
  | { readonly kind: "wall"; readonly slip: boolean }
  | { readonly kind: "symmetry" };

/** What {@link createLbm3dStepper} consumes — SI at the door, per law S4. */
export interface Lbm3dStepperConfig {
  /** The 3D lattice shape and solids — the Phase 62 voxelizer's native output. */
  readonly mask: Lbm3dSolidMask;
  /** The compiled fluid state (sim-core's `SimFluidState`). */
  readonly fluid: SimFluidState;
  /** The voxel cell size, m — the lattice spacing and the grid's spacing. */
  readonly cellSizeM: number;
  /** The characteristic SI velocity, m/s (free-stream or inlet scale). */
  readonly characteristicVelocityMPerS: number;
  /** The characteristic lattice velocity (default 0.05; the low-Mach knob). */
  readonly latticeVelocity?: number;
  /** The collision model (default TRT with the channel-exact Λ = 1/4). */
  readonly collision?: LbmCollisionModel;
  readonly west: Lbm3dFaceSpec;
  readonly east: Lbm3dFaceSpec;
  readonly south: Lbm3dFaceSpec;
  readonly north: Lbm3dFaceSpec;
  readonly bottom: Lbm3dFaceSpec;
  readonly top: Lbm3dFaceSpec;
  /** The pressure the lattice density ρ = 1 encodes, Pa (default 0 — gauge). */
  readonly referencePressurePa?: number;
  /** The lattice origin in the solver's SI frame, m (default [0, 0, 0]). */
  readonly originM?: readonly [number, number, number];
  /**
   * The rotation marker (Phase 66b's routing honesty): PRESENT means
   * this config belongs to a rotating door — `createMrf3dStepper`
   * (kind "mrf") or `createResolvedRotation3dStepper` (kind
   * "resolved-rotation") — and the static 3D stepper refuses it loudly
   * rather than silently running rotation-free physics on a rotating
   * scenario.
   */
  readonly rotation?: Lbm3dRotationMarker;
}

/** The immutable run facts a driver displays or hashes (S9 honesty). */
export interface Lbm3dRunMeta {
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  readonly units: Lbm3dUnitSystem;
  readonly collision: LbmCollisionModel;
  readonly rates: LbmRelaxationRates;
  readonly referencePressurePa: number;
}

/** One completed step's exact momentum ledger, lattice units. */
export interface Lbm3dMomentumBookkeeping {
  readonly step: number;
  /** Momentum dropped with populations pushed out of the domain. */
  readonly droppedX: number;
  readonly droppedY: number;
  readonly droppedZ: number;
  /** Σ (new − old)·c over face-condition overwrites. */
  readonly faceDeltaX: number;
  readonly faceDeltaY: number;
  readonly faceDeltaZ: number;
  /** 2·Σ f·c handed to solids (the force impulse, body-signed). */
  readonly solidImpulseX: number;
  readonly solidImpulseY: number;
  readonly solidImpulseZ: number;
}

/** Macroscopic fields in lattice units (solid columns zero). */
export interface Lbm3dLatticeSnapshot {
  readonly step: number;
  readonly rho: Float64Array;
  readonly ux: Float64Array;
  readonly uy: Float64Array;
  readonly uz: Float64Array;
}

/** Macroscopic fields in SI (solid columns zero). */
export interface Lbm3dSISnapshot {
  readonly step: number;
  readonly densityKgPerM3: Float64Array;
  readonly velocityXMPerS: Float64Array;
  readonly velocityYMPerS: Float64Array;
  readonly velocityZMPerS: Float64Array;
  readonly pressurePa: Float64Array;
}

/** The deterministic 3D LBM stepper — the Phase 66a CPU oracle. */
export interface Lbm3dStepper {
  readonly meta: Lbm3dRunMeta;
  /** The completed step count (monotone; frozen on divergence). */
  get step(): number;
  /** Whether the run diverged (NaN/negative density) and froze. */
  get diverged(): boolean;
  /** Advances one step (a no-op once diverged). */
  advance(): void;
  /** Advances `steps` steps (a no-op once diverged). */
  run(steps: number): void;
  /**
   * The total momentum carried by all distributions (solid bounce-back
   * storage included), lattice units — the audit's M(t).
   */
  momentumLattice(): {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  /** The last completed step's momentum ledger (undefined before step 1). */
  lastStepBookkeeping(): Lbm3dMomentumBookkeeping | undefined;
  /** The current force samples and the deterministic history triple. */
  forceState(): {
    readonly current: {
      readonly dragN: number;
      readonly liftN: number;
      readonly sideN: number;
    };
    readonly history: readonly SimHistorySeries[];
  };
  /** Macroscopic fields, lattice units, freshly computed (copies). */
  snapshotLattice(): Lbm3dLatticeSnapshot;
  /** Macroscopic fields, SI, freshly computed (copies). */
  snapshotSI(): Lbm3dSISnapshot;
  /**
   * Live read-only views of the nineteen SoA distribution arrays — the
   * layout contract's surface: the Phase 66a harness diffs these
   * buffers against GPU readbacks, and the determinism pins compare
   * their bytes. Aliased, never copied; treat as read-only.
   */
  distributions(): readonly Float32Array[];
  /**
   * The S4-ready solver fields (velocity-x/y/z, speed, pressure;
   * x-fastest values, float32 storage honesty): feed `projectSimResult`
   * directly, no second conversion site. The declared unit labels are
   * the POST-projection document units (the sim-core grid precedent).
   */
  solverFields(): readonly SolverSimField[];
}

/**
 * Compiles one face's SI spec into its lattice condition, refusing the
 * inputs the boundary math cannot honor (inlet orientation and lattice
 * speed, outlet density positivity). Exported for the Phase 66b
 * rotating steppers (`./mrf-3d`, `./resolved-rotation-3d`), which own
 * their own state and drive the shared boundary pass — one source of
 * truth for the face algebra.
 */
export function lbm3dCompileFace(
  face: Lbm3dFace,
  spec: Lbm3dFaceSpec,
  units: Lbm3dUnitSystem,
  referencePressurePa: number,
): SimParseResult<Lbm3dFaceCondition, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  switch (spec.kind) {
    case "velocity-inlet": {
      const [vx, vy, vz] = spec.velocityMPerS;
      if (
        typeof vx !== "number" ||
        !Number.isFinite(vx) ||
        typeof vy !== "number" ||
        !Number.isFinite(vy) ||
        typeof vz !== "number" ||
        !Number.isFinite(vz)
      ) {
        return refuse(
          "A velocity-inlet's velocity must be a triple of finite m/s values.",
          spec.velocityMPerS,
        );
      }
      const inward =
        face === "west"
          ? vx > 0
          : face === "east"
            ? vx < 0
            : face === "south"
              ? vy > 0
              : face === "north"
                ? vy < 0
                : face === "bottom"
                  ? vz > 0
                  : vz < 0;
      if (!inward) {
        return refuse(
          `A velocity-inlet on the ${face} face must point into the domain (its normal component's sign), received [${String(vx)}, ${String(vy)}, ${String(vz)}] m/s.`,
          spec.velocityMPerS,
        );
      }
      const speed = Math.sqrt(vx * vx + vy * vy + vz * vz);
      const latticeSpeed = (speed * units.timeStepS) / units.cellSizeM;
      if (latticeSpeed > LBM_MAX_LATTICE_VELOCITY) {
        return refuse(
          `A velocity-inlet's lattice speed (${latticeSpeed.toPrecision(4)}) exceeds the ${String(LBM_MAX_LATTICE_VELOCITY)} low-Mach ceiling — lower the inlet speed or raise the characteristic velocity it is paired with.`,
          spec.velocityMPerS,
        );
      }
      return simOk({
        kind: "velocity",
        ux: (vx * units.timeStepS) / units.cellSizeM,
        uy: (vy * units.timeStepS) / units.cellSizeM,
        uz: (vz * units.timeStepS) / units.cellSizeM,
      });
    }
    case "pressure-outlet": {
      if (
        typeof spec.pressurePa !== "number" ||
        !Number.isFinite(spec.pressurePa)
      ) {
        return refuse(
          "A pressure-outlet's pressure must be a finite number of pascals.",
          spec.pressurePa,
        );
      }
      const rho =
        1 + (spec.pressurePa - referencePressurePa) / units.pressureFactorPa;
      if (!(rho > 0)) {
        return refuse(
          `A pressure-outlet's pressure (${String(spec.pressurePa)} Pa against reference ${String(referencePressurePa)} Pa) drives the lattice density to ${String(rho)} — outside the positive regime, and the kernel will not fabricate its way past it.`,
          spec.pressurePa,
        );
      }
      return simOk({ kind: "pressure", rho });
    }
    case "convective-outflow":
      return simOk({ kind: "convective-outflow" });
    case "wall":
      return simOk({ kind: "wall", slip: spec.slip });
    case "symmetry":
      return simOk({ kind: "symmetry" });
  }
}

/**
 * Creates the 3D stepper from the SI config, refusing every input an
 * honest kernel will not run: mask shape and values, fluid scales, the
 * unit closure's stability band, the collision knob, inlet orientation
 * and magnitude, and outlet density positivity. On success the state
 * exists at step 0 as the rest equilibrium.
 */
export function createLbm3dStepper(
  config: Lbm3dStepperConfig,
): SimParseResult<Lbm3dStepper, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  if (config.rotation !== undefined) {
    const door =
      config.rotation.kind === "mrf"
        ? "createMrf3dStepper (./mrf-3d)"
        : "createResolvedRotation3dStepper (./resolved-rotation-3d)";
    return refuse(
      `The static D3Q19 stepper does not run rotating configs (marker kind "${config.rotation.kind}") — route the config through ${door}, which owns the rotation physics.`,
      config.rotation,
    );
  }
  const { mask } = config;
  const nx = mask.nx;
  const ny = mask.ny;
  const nz = mask.nz;
  if (
    !Number.isInteger(nx) ||
    !Number.isInteger(ny) ||
    !Number.isInteger(nz) ||
    nx < 3 ||
    ny < 3 ||
    nz < 3 ||
    mask.solid.length !== nx * ny * nz
  ) {
    return refuse(
      `A 3D stepper's mask needs integer extents of at least 3 per axis and nx·ny·nz values, received ${String(nx)}×${String(ny)}×${String(nz)} with ${String(mask.solid.length)} values.`,
      { nx, ny, nz, length: mask.solid.length },
    );
  }
  for (const value of mask.solid) {
    if (value !== 0 && value !== 1) {
      return refuse(
        `A 3D stepper's mask values must each be exactly 0 or 1, received ${String(value)}.`,
        value,
      );
    }
  }
  if (
    !Number.isFinite(config.fluid.kinematicViscosityM2PerS) ||
    config.fluid.kinematicViscosityM2PerS <= 0 ||
    !Number.isFinite(config.fluid.densityKgPerM3) ||
    config.fluid.densityKgPerM3 <= 0
  ) {
    return refuse(
      "A 3D stepper's fluid state needs a positive finite kinematic viscosity and reference density.",
      config.fluid,
    );
  }
  const collision: LbmCollisionModel = config.collision ?? { kind: "trt" };
  const collisionProblem = lbmCollisionModelProblem(collision);
  if (collisionProblem !== undefined) {
    return refuse(collisionProblem, collision);
  }
  const unitInputs: LbmUnitSystemInputs = {
    cellSizeM: config.cellSizeM,
    characteristicVelocityMPerS: config.characteristicVelocityMPerS,
    kinematicViscosityM2PerS: config.fluid.kinematicViscosityM2PerS,
    referenceDensityKgPerM3: config.fluid.densityKgPerM3,
    ...(config.latticeVelocity === undefined
      ? {}
      : { latticeVelocity: config.latticeVelocity }),
  };
  const units = lbm3dUnitSystem(unitInputs);
  if (!units.ok) return units;
  const referencePressurePa = config.referencePressurePa ?? 0;
  if (!Number.isFinite(referencePressurePa)) {
    return refuse(
      "A 3D stepper's reference pressure must be a finite number of pascals.",
      referencePressurePa,
    );
  }
  const originM = config.originM ?? [0, 0, 0];
  if (
    !Array.isArray(originM) ||
    originM.length !== 3 ||
    originM.some(
      (entry) => typeof entry !== "number" || !Number.isFinite(entry),
    )
  ) {
    return refuse(
      "A 3D stepper's lattice origin must be a triple of finite metres.",
      originM,
    );
  }
  const faces: readonly (readonly [Lbm3dFace, Lbm3dFaceSpec])[] = [
    ["west", config.west],
    ["east", config.east],
    ["south", config.south],
    ["north", config.north],
    ["bottom", config.bottom],
    ["top", config.top],
  ];
  const conditions: Partial<Record<Lbm3dFace, Lbm3dFaceCondition>> = {};
  for (const [face, spec] of faces) {
    const compiled = lbm3dCompileFace(
      face,
      spec,
      units.value,
      referencePressurePa,
    );
    if (!compiled.ok) return compiled;
    conditions[face] = compiled.value;
  }
  const faceConditions = conditions as Record<Lbm3dFace, Lbm3dFaceCondition>;
  const rates = lbmRelaxationRates(collision, units.value.tauPlus);
  const state: Lbm3dState = createLbm3dState(mask);
  const forces = new Lbm3dForceAccumulator(units.value);
  const ledger: Lbm3dFaceMomentumLedger = { x: 0, y: 0, z: 0 };
  let step = 0;
  let diverged = false;
  let bookkeeping: Lbm3dMomentumBookkeeping | undefined;
  const meta: Lbm3dRunMeta = Object.freeze({
    nx,
    ny,
    nz,
    units: units.value,
    collision,
    rates,
    referencePressurePa,
  });

  const advance = (): void => {
    if (diverged) return;
    if (!lbm3dComputeMacroscopic(state)) {
      diverged = true;
      return;
    }
    lbm3dCollide(state, rates);
    const dropped = lbm3dStream(state);
    lbm3dApplyFaceConditions(state, faceConditions, ledger);
    const impulse = lbm3dReflectSolids(state);
    forces.record(impulse.impulseX, impulse.impulseY, impulse.impulseZ);
    lbm3dSwap(state);
    step += 1;
    bookkeeping = {
      step,
      droppedX: dropped.droppedX,
      droppedY: dropped.droppedY,
      droppedZ: dropped.droppedZ,
      faceDeltaX: ledger.x,
      faceDeltaY: ledger.y,
      faceDeltaZ: ledger.z,
      solidImpulseX: impulse.impulseX,
      solidImpulseY: impulse.impulseY,
      solidImpulseZ: impulse.impulseZ,
    };
  };

  const snapshotMacroscopic = (): {
    rho: Float64Array;
    ux: Float64Array;
    uy: Float64Array;
    uz: Float64Array;
  } => {
    const count = nx * ny * nz;
    const rho = new Float64Array(count);
    const ux = new Float64Array(count);
    const uy = new Float64Array(count);
    const uz = new Float64Array(count);
    for (let index = 0; index < mask.solid.length; index += 1) {
      if (mask.solid[index] === 1) continue;
      let sum = 0;
      let mx = 0;
      let my = 0;
      let mz = 0;
      for (let i = 0; i < D3Q19_Q; i += 1) {
        const value = state.f[i]?.[index] ?? 0;
        sum += value;
        mx += value * (D3Q19_VELOCITIES[i]?.[0] ?? 0);
        my += value * (D3Q19_VELOCITIES[i]?.[1] ?? 0);
        mz += value * (D3Q19_VELOCITIES[i]?.[2] ?? 0);
      }
      rho[index] = sum;
      ux[index] = mx / sum;
      uy[index] = my / sum;
      uz[index] = mz / sum;
    }
    return { rho, ux, uy, uz };
  };

  return simOk({
    meta,
    get step() {
      return step;
    },
    get diverged() {
      return diverged;
    },
    advance,
    run(steps: number): void {
      const budget = Math.max(0, Math.floor(steps));
      for (let index = 0; index < budget; index += 1) {
        advance();
      }
    },
    momentumLattice: () => lbm3dTotalMomentum(state),
    lastStepBookkeeping: () => bookkeeping,
    distributions: () => state.f,
    forceState: () => ({
      current: forces.current(),
      history: forces.history(),
    }),
    snapshotLattice(): Lbm3dLatticeSnapshot {
      const macro = snapshotMacroscopic();
      return {
        step,
        rho: macro.rho,
        ux: macro.ux,
        uy: macro.uy,
        uz: macro.uz,
      };
    },
    snapshotSI(): Lbm3dSISnapshot {
      const macro = snapshotMacroscopic();
      const count = macro.rho.length;
      const densityKgPerM3 = new Float64Array(count);
      const velocityXMPerS = new Float64Array(count);
      const velocityYMPerS = new Float64Array(count);
      const velocityZMPerS = new Float64Array(count);
      const pressurePa = new Float64Array(count);
      for (let index = 0; index < count; index += 1) {
        const rho = macro.rho[index] ?? 0;
        densityKgPerM3[index] = rho * units.value.densityFactor;
        velocityXMPerS[index] =
          (macro.ux[index] ?? 0) * units.value.velocityFactor;
        velocityYMPerS[index] =
          (macro.uy[index] ?? 0) * units.value.velocityFactor;
        velocityZMPerS[index] =
          (macro.uz[index] ?? 0) * units.value.velocityFactor;
        pressurePa[index] =
          referencePressurePa + (rho - 1) * units.value.pressureFactorPa;
      }
      return {
        step,
        densityKgPerM3,
        velocityXMPerS,
        velocityYMPerS,
        velocityZMPerS,
        pressurePa,
      };
    },
    solverFields(): readonly SolverSimField[] {
      const macro = snapshotMacroscopic();
      const dx = units.value.cellSizeM;
      const velocityValuesX: number[] = [];
      const velocityValuesY: number[] = [];
      const velocityValuesZ: number[] = [];
      const speedValues: number[] = [];
      const pressureValues: number[] = [];
      for (let index = 0; index < macro.rho.length; index += 1) {
        const vx = (macro.ux[index] ?? 0) * units.value.velocityFactor;
        const vy = (macro.uy[index] ?? 0) * units.value.velocityFactor;
        const vz = (macro.uz[index] ?? 0) * units.value.velocityFactor;
        velocityValuesX.push(vx);
        velocityValuesY.push(vy);
        velocityValuesZ.push(vz);
        speedValues.push(Math.sqrt(vx * vx + vy * vy + vz * vz));
        pressureValues.push(
          referencePressurePa +
            ((macro.rho[index] ?? 0) - 1) * units.value.pressureFactorPa,
        );
      }
      const geometry = {
        extent: [nx, ny, nz] as const,
        originM: [originM[0] ?? 0, originM[1] ?? 0, originM[2] ?? 0] as const,
        spacingM: [dx, dx, dx] as const,
        dataType: "float32" as const,
      };
      return [
        {
          id: "velocity-x",
          unit: "mm/s",
          dimension: "velocity",
          values: velocityValuesX,
          ...geometry,
        },
        {
          id: "velocity-y",
          unit: "mm/s",
          dimension: "velocity",
          values: velocityValuesY,
          ...geometry,
        },
        {
          id: "velocity-z",
          unit: "mm/s",
          dimension: "velocity",
          values: velocityValuesZ,
          ...geometry,
        },
        {
          id: "speed",
          unit: "mm/s",
          dimension: "velocity",
          values: speedValues,
          ...geometry,
        },
        {
          id: "pressure",
          unit: "Pa",
          dimension: "pressure",
          values: pressureValues,
          ...geometry,
        },
      ];
    },
  });
}
