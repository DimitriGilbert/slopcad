/**
 * The stepper (Phase 63a): the pure, deterministic driver that owns one
 * 2D LBM run — the shape 63b/63c drive from the worker and the shape
 * Phase 64's GPU provider is validated against. Everything a step does
 * is fixed-order arithmetic over the SoA state:
 *
 *   1. macroscopic recompute (the divergence sentinel lives here; with
 *      a buoyancy block, the Guo half-force correction and the force
 *      field from the caller's live temperature — Phase 65b);
 *   2. collision (BGK/TRT, `./relaxation`, with Guo forcing when the
 *      buoyancy block is present);
 *   3. push streaming (`./streaming`);
 *   4. face conditions (Zou/He, convective, walls — `./boundaries`);
 *   5. full-way bounce-back reflection + momentum-exchange impulse;
 *   6. buffer swap, force recording, ledger close.
 *
 * Pause/step/resume is the object itself: `run(k)`, read state, `run(m)`
 * — the entire evolution lives in the stepper, no timers, no ambient
 * state, no React, no DOM, no node APIs (law S2), so the same inputs
 * produce bitwise-identical bytes every time (pinned by test). A run
 * that diverges sets `diverged` and freezes — a blown-up BGK run
 * reports itself instead of fabricating fields.
 *
 * SI sits at this door (law S4): the config takes SI (velocities m/s,
 * pressures Pa, the fluid state, the cell size), `lattice-units` derives
 * the closure once, and every read-out accessor converts back —
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
import type { LbmBuoyancyConfig } from "./buoyancy";

import {
  type LbmFace,
  type LbmFaceCondition,
  type LbmFaceMomentumLedger,
  lbmApplyFaceConditions,
} from "./boundaries";
import {
  lbmBuoyancyForceLattice,
  lbmBuoyancyProblem,
  lbmForceFieldTotal,
} from "./buoyancy";
import { D2Q9_Q, D2Q9_VELOCITIES } from "./d2q9";
import { LbmForceAccumulator } from "./forces";
import {
  LBM_MAX_LATTICE_VELOCITY,
  type LbmUnitSystem,
  lbmUnitSystem,
} from "./lattice-units";
import {
  type LbmCollisionModel,
  lbmCollide,
  lbmCollisionModelProblem,
  lbmRelaxationRates,
  type LbmRelaxationRates,
} from "./relaxation";
import {
  createLbmState,
  lbmComputeMacroscopic,
  lbmReflectSolids,
  lbmTotalMomentum,
  type LbmSolidMask,
  type LbmState,
} from "./state";
import { lbmStream, lbmSwap } from "./streaming";

/** A face condition authored in SI — the stepper converts to lattice units. */
export type LbmFaceSpec =
  | {
      readonly kind: "velocity-inlet";
      /** The inlet velocity vector, m/s (its normal must point into the domain). */
      readonly velocityMPerS: readonly [number, number];
    }
  | {
      readonly kind: "pressure-outlet";
      /** The outlet static pressure, Pa (read against the reference pressure). */
      readonly pressurePa: number;
    }
  | { readonly kind: "convective-outflow" }
  | { readonly kind: "wall"; readonly slip: boolean }
  | { readonly kind: "symmetry" };

/** What {@link createLbmStepper} consumes — SI at the door, per law S4. */
export interface LbmStepperConfig {
  /** The lattice shape and solids — the Phase 62a node interpretation. */
  readonly mask: LbmSolidMask;
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
  readonly west: LbmFaceSpec;
  readonly east: LbmFaceSpec;
  readonly south: LbmFaceSpec;
  readonly north: LbmFaceSpec;
  /** The pressure the lattice density ρ = 1 encodes, Pa (default 0 — gauge). */
  readonly referencePressurePa?: number;
  /** The lattice origin in the solver's SI frame, m (default [0, 0]). */
  readonly originM?: readonly [number, number];
  /**
   * The Boussinesq buoyancy coupling (Phase 65b): the per-node body
   * force −β·(T − T_ref)·g applied through Guo collision forcing every
   * step, read from the CALLER-OWNED live temperature field (the CHT
   * coupled march's `./cht` advances it between flow steps). Absent =
   * the unforced kernel, bitwise the Phase 63 behavior.
   */
  readonly buoyancy?: LbmBuoyancyConfig;
}

/** The immutable run facts a driver displays or hashes (S9 honesty). */
export interface LbmRunMeta {
  readonly nx: number;
  readonly ny: number;
  readonly units: LbmUnitSystem;
  readonly collision: LbmCollisionModel;
  readonly rates: LbmRelaxationRates;
  readonly referencePressurePa: number;
  /** The buoyancy coupling's SI facts when the run forces (absent = unforced). */
  readonly buoyancy:
    | {
        readonly gravityMPerS2: readonly [number, number];
        readonly thermalExpansionPerK: number;
        readonly referenceTemperatureK: number;
      }
    | undefined;
}

/** One completed step's exact momentum ledger, lattice units. */
export interface LbmMomentumBookkeeping {
  readonly step: number;
  /** Momentum dropped with populations pushed out of the domain. */
  readonly droppedX: number;
  readonly droppedY: number;
  /** Σ (new − old)·c over face-condition overwrites. */
  readonly faceDeltaX: number;
  readonly faceDeltaY: number;
  /** 2·Σ f·c handed to solids (the force impulse, body-signed). */
  readonly solidImpulseX: number;
  readonly solidImpulseY: number;
  /** Σ F over fluid nodes — the body force collision injected this step (0 unforced). */
  readonly bodyForceX: number;
  readonly bodyForceY: number;
}

/** Macroscopic fields in lattice units (solid columns zero). */
export interface LbmLatticeSnapshot {
  readonly step: number;
  readonly rho: Float64Array;
  readonly ux: Float64Array;
  readonly uy: Float64Array;
}

/** Macroscopic fields in SI (solid columns zero). */
export interface LbmSISnapshot {
  readonly step: number;
  readonly densityKgPerM3: Float64Array;
  readonly velocityXMPerS: Float64Array;
  readonly velocityYMPerS: Float64Array;
  readonly pressurePa: Float64Array;
}

/** The deterministic 2D LBM stepper. */
export interface LbmStepper {
  readonly meta: LbmRunMeta;
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
  momentumLattice(): { readonly x: number; readonly y: number };
  /** The last completed step's momentum ledger (undefined before step 1). */
  lastStepBookkeeping(): LbmMomentumBookkeeping | undefined;
  /** The current force samples and the deterministic history pair. */
  forceState(): {
    readonly current: {
      readonly dragNPerM: number;
      readonly liftNPerM: number;
    };
    readonly history: readonly SimHistorySeries[];
  };
  /** Macroscopic fields, lattice units, freshly computed (copies). */
  snapshotLattice(): LbmLatticeSnapshot;
  /** Macroscopic fields, SI, freshly computed (copies). */
  snapshotSI(): LbmSISnapshot;
  /**
   * Live read-only views of the nine SoA distribution arrays — the
   * layout contract's surface: the Phase 64 harness diffs these buffers
   * against GPU readbacks, and the determinism pins compare their bytes.
   * Aliased, never copied; treat as read-only.
   */
  distributions(): readonly Float32Array[];
  /**
   * The S4-ready solver fields (velocity-x, velocity-y, speed, pressure;
   * x-fastest values, float32 storage honesty): feed `projectSimResult`
   * directly, no second conversion site. The declared unit labels are
   * the POST-projection document units (the sim-core grid precedent:
   * the projection converts the values, the label was already final).
   */
  solverFields(): readonly SolverSimField[];
}

/**
 * Compiles one face's SI spec into its lattice condition, refusing the
 * inputs the boundary math cannot honor (inlet orientation and lattice
 * speed, outlet density positivity).
 */
function compileFace(
  face: LbmFace,
  spec: LbmFaceSpec,
  units: LbmUnitSystem,
  referencePressurePa: number,
): SimParseResult<LbmFaceCondition, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  switch (spec.kind) {
    case "velocity-inlet": {
      const [vx, vy] = spec.velocityMPerS;
      if (
        typeof vx !== "number" ||
        !Number.isFinite(vx) ||
        typeof vy !== "number" ||
        !Number.isFinite(vy)
      ) {
        return refuse(
          "A velocity-inlet's velocity must be a pair of finite m/s values.",
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
              : vy < 0;
      if (!inward) {
        return refuse(
          `A velocity-inlet on the ${face} face must point into the domain (its normal component's sign), received [${String(vx)}, ${String(vy)}] m/s.`,
          spec.velocityMPerS,
        );
      }
      const speed = Math.sqrt(vx * vx + vy * vy);
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
 * Creates the stepper from the SI config, refusing every input an
 * honest kernel will not run: mask shape and values, fluid scales, the
 * unit closure's stability band, the collision knob, inlet orientation
 * and magnitude, and outlet density positivity. On success the state
 * exists at step 0 as the rest equilibrium.
 */
export function createLbmStepper(
  config: LbmStepperConfig,
): SimParseResult<LbmStepper, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  const { mask } = config;
  const nx = mask.nx;
  const ny = mask.ny;
  if (
    !Number.isInteger(nx) ||
    !Number.isInteger(ny) ||
    nx < 3 ||
    ny < 3 ||
    mask.solid.length !== nx * ny
  ) {
    return refuse(
      `A stepper's mask needs integer extents of at least 3 and nx·ny values, received ${String(nx)}×${String(ny)} with ${String(mask.solid.length)} values.`,
      { nx, ny, length: mask.solid.length },
    );
  }
  for (const value of mask.solid) {
    if (value !== 0 && value !== 1) {
      return refuse(
        `A stepper's mask values must each be exactly 0 or 1, received ${String(value)}.`,
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
      "A stepper's fluid state needs a positive finite kinematic viscosity and reference density.",
      config.fluid,
    );
  }
  const collision: LbmCollisionModel = config.collision ?? { kind: "trt" };
  const collisionProblem = lbmCollisionModelProblem(collision);
  if (collisionProblem !== undefined) {
    return refuse(collisionProblem, collision);
  }
  const units = lbmUnitSystem({
    cellSizeM: config.cellSizeM,
    characteristicVelocityMPerS: config.characteristicVelocityMPerS,
    kinematicViscosityM2PerS: config.fluid.kinematicViscosityM2PerS,
    referenceDensityKgPerM3: config.fluid.densityKgPerM3,
    ...(config.latticeVelocity === undefined
      ? {}
      : { latticeVelocity: config.latticeVelocity }),
  });
  if (!units.ok) return units;
  const referencePressurePa = config.referencePressurePa ?? 0;
  if (!Number.isFinite(referencePressurePa)) {
    return refuse(
      "A stepper's reference pressure must be a finite number of pascals.",
      referencePressurePa,
    );
  }
  const originM = config.originM ?? [0, 0];
  if (
    !Array.isArray(originM) ||
    originM.length !== 2 ||
    originM.some(
      (entry) => typeof entry !== "number" || !Number.isFinite(entry),
    )
  ) {
    return refuse(
      "A stepper's lattice origin must be a pair of finite metres.",
      originM,
    );
  }
  const west = compileFace(
    "west",
    config.west,
    units.value,
    referencePressurePa,
  );
  if (!west.ok) return west;
  const east = compileFace(
    "east",
    config.east,
    units.value,
    referencePressurePa,
  );
  if (!east.ok) return east;
  const south = compileFace(
    "south",
    config.south,
    units.value,
    referencePressurePa,
  );
  if (!south.ok) return south;
  const north = compileFace(
    "north",
    config.north,
    units.value,
    referencePressurePa,
  );
  if (!north.ok) return north;
  const conditions: Record<LbmFace, LbmFaceCondition> = {
    west: west.value,
    east: east.value,
    south: south.value,
    north: north.value,
  };
  const rates = lbmRelaxationRates(collision, units.value.tauPlus);
  const buoyancyProblem =
    config.buoyancy === undefined
      ? undefined
      : lbmBuoyancyProblem(config.buoyancy, mask);
  if (buoyancyProblem !== undefined) {
    return refuse(buoyancyProblem, config.buoyancy);
  }
  const state: LbmState = createLbmState(mask);
  const forces = new LbmForceAccumulator(units.value);
  const ledger: LbmFaceMomentumLedger = { x: 0, y: 0 };
  let step = 0;
  let diverged = false;
  let bookkeeping: LbmMomentumBookkeeping | undefined;
  const meta: LbmRunMeta = Object.freeze({
    nx,
    ny,
    units: units.value,
    collision,
    rates,
    referencePressurePa,
    buoyancy:
      config.buoyancy === undefined
        ? undefined
        : {
            gravityMPerS2: config.buoyancy.gravityMPerS2,
            thermalExpansionPerK: config.buoyancy.thermalExpansionPerK,
            referenceTemperatureK: config.buoyancy.referenceTemperatureK,
          },
  });

  const advance = (): void => {
    if (diverged) return;
    let forceX: Float64Array | undefined;
    let forceY: Float64Array | undefined;
    let bodyForceX = 0;
    let bodyForceY = 0;
    if (config.buoyancy !== undefined) {
      const field = lbmBuoyancyForceLattice(config.buoyancy, mask, units.value);
      forceX = field.fx;
      forceY = field.fy;
      // The ledger's body-force term — the field's own total, so the
      // stepper books the same sum everywhere (`./buoyancy`).
      const total = lbmForceFieldTotal(field, mask);
      bodyForceX = total.x;
      bodyForceY = total.y;
    }
    if (!lbmComputeMacroscopic(state, forceX, forceY)) {
      diverged = true;
      return;
    }
    lbmCollide(state, rates, forceX, forceY);
    const dropped = lbmStream(state);
    lbmApplyFaceConditions(state, conditions, ledger);
    const impulse = lbmReflectSolids(state);
    forces.record(impulse.impulseX, impulse.impulseY);
    lbmSwap(state);
    step += 1;
    bookkeeping = {
      step,
      droppedX: dropped.droppedX,
      droppedY: dropped.droppedY,
      faceDeltaX: ledger.x,
      faceDeltaY: ledger.y,
      solidImpulseX: impulse.impulseX,
      solidImpulseY: impulse.impulseY,
      bodyForceX,
      bodyForceY,
    };
  };

  const snapshotMacroscopic = (): {
    rho: Float64Array;
    ux: Float64Array;
    uy: Float64Array;
  } => {
    const rho = new Float64Array(nx * ny);
    const ux = new Float64Array(nx * ny);
    const uy = new Float64Array(nx * ny);
    for (let index = 0; index < mask.solid.length; index += 1) {
      if (mask.solid[index] === 1) continue;
      let sum = 0;
      let mx = 0;
      let my = 0;
      for (let i = 0; i < D2Q9_Q; i += 1) {
        const value = state.f[i]?.[index] ?? 0;
        sum += value;
        mx += value * (D2Q9_VELOCITIES[i]?.[0] ?? 0);
        my += value * (D2Q9_VELOCITIES[i]?.[1] ?? 0);
      }
      rho[index] = sum;
      ux[index] = mx / sum;
      uy[index] = my / sum;
    }
    return { rho, ux, uy };
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
    momentumLattice: () => lbmTotalMomentum(state),
    lastStepBookkeeping: () => bookkeeping,
    distributions: () => state.f,
    forceState: () => ({
      current: forces.current(),
      history: forces.history(),
    }),
    snapshotLattice(): LbmLatticeSnapshot {
      const macro = snapshotMacroscopic();
      return { step, rho: macro.rho, ux: macro.ux, uy: macro.uy };
    },
    snapshotSI(): LbmSISnapshot {
      const macro = snapshotMacroscopic();
      const densityKgPerM3 = new Float64Array(macro.rho.length);
      const velocityXMPerS = new Float64Array(macro.rho.length);
      const velocityYMPerS = new Float64Array(macro.rho.length);
      const pressurePa = new Float64Array(macro.rho.length);
      for (let index = 0; index < macro.rho.length; index += 1) {
        const rho = macro.rho[index] ?? 0;
        densityKgPerM3[index] = rho * units.value.densityFactor;
        velocityXMPerS[index] =
          (macro.ux[index] ?? 0) * units.value.velocityFactor;
        velocityYMPerS[index] =
          (macro.uy[index] ?? 0) * units.value.velocityFactor;
        pressurePa[index] =
          referencePressurePa + (rho - 1) * units.value.pressureFactorPa;
      }
      return {
        step,
        densityKgPerM3,
        velocityXMPerS,
        velocityYMPerS,
        pressurePa,
      };
    },
    solverFields(): readonly SolverSimField[] {
      const macro = snapshotMacroscopic();
      const dx = units.value.cellSizeM;
      const velocityValuesX: number[] = [];
      const velocityValuesY: number[] = [];
      const speedValues: number[] = [];
      const pressureValues: number[] = [];
      for (let index = 0; index < macro.rho.length; index += 1) {
        const vx = (macro.ux[index] ?? 0) * units.value.velocityFactor;
        const vy = (macro.uy[index] ?? 0) * units.value.velocityFactor;
        velocityValuesX.push(vx);
        velocityValuesY.push(vy);
        speedValues.push(Math.sqrt(vx * vx + vy * vy));
        pressureValues.push(
          referencePressurePa +
            ((macro.rho[index] ?? 0) - 1) * units.value.pressureFactorPa,
        );
      }
      const geometry = {
        extent: [nx, ny, 1] as const,
        originM: [originM[0] ?? 0, originM[1] ?? 0, 0] as const,
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
