/**
 * Resolved rotation (Phase 66b) — the SHOWCASE: an immersed moving
 * boundary for a rotating geometry, in the LAB frame (no body forces —
 * the difficulty is entirely in the moving-boundary bookkeeping, which
 * is why MRF exists as the honest default; risk S3).
 *
 * ## The scheme, stated honestly
 *
 * The rotor is an analytic occupancy predicate authored in
 * displacement coordinates from the axis (the θ = 0 attitude); each
 * step the geometry advances exactly Ω_lat = Ω·dt radians (the
 * staircase grid's angular rotation) by evaluating the predicate on
 * Rodrigues-rotated displacements, and the solid mask is rebuilt —
 * deterministic, θ = step·Ω_lat (a product, never an accumulated sum:
 * no drift). Nodes the rotor covers convert their populations to the
 * full-way parked convention (in-place pair reflection — Ladd's
 * fresh-cell conversion); nodes it uncovers are born at the mean
 * neighboring-fluid density and rest — the standard immersed-LBM
 * coarseness, stated.
 *
 * Boundary links reflect with the wall velocity at the link midpoint —
 * `./torque-3d`'s rotating sink: the parked population gains
 * δ_i = −6·w_i·ρ_f·(c_i·u_w) with u_w = Ω_lat×r_mid the rigid wall
 * velocity at the midpoint, and the rotor's axial torque is the
 * momentum exchange (2·f_i + δ_i)·c_i crossed with the lever arm,
 * per step, in SI. The static solids sharing the lattice (the tube)
 * take plain bounce-back and book no rotor torque.
 *
 * ## The per-revolution substep discipline
 *
 * The per-step angular advance is the stability knob: the tip's
 * lattice velocity Ω_lat·r_tip must stay under the low-Mach ceiling
 * (the compile refuses loudly beyond it — pick a finer dt, a smaller
 * lattice velocity, or a slower shaft). Sample-resolution honesty:
 * resolving fluctuation content at the blade-passing frequency needs
 * ≥ 2 samples per blade passage — stepsPerRevolution ≥ 2·bladeCount
 * for a blade-resolving run; the meta reports stepsPerRevolution so
 * the honesty fields can state the margin (advisory, never a decline).
 *
 * Determinism (law S2): fixed step order — mask advance, macroscopic,
 * collision, streaming, faces, reflection with the sink, swap — over
 * pure arithmetic and one transcendental pair per step, pinned
 * bitwise by test.
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  type SimHistorySeries,
  type SimParseResult,
  type SolverSimField,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";

import {
  type Lbm3dFace,
  type Lbm3dFaceCondition,
  type Lbm3dFaceMomentumLedger,
  LBM3D_FACES,
  lbm3dApplyFaceConditions,
} from "./boundaries-3d";
import {
  D3Q19_OPPOSITE,
  D3Q19_Q,
  D3Q19_VELOCITIES,
  D3Q19_WEIGHTS,
} from "./d3q19";
import { Lbm3dForceAccumulator } from "./forces-3d";
import { LBM_MAX_LATTICE_VELOCITY } from "./lattice-units";
import {
  type Lbm3dRotationAxis,
  type Lbm3dRotationAxisSpec,
  lbm3dCompileAxis,
  lbm3dOmegaLattice,
  lbm3dStepsPerRevolution,
} from "./rotation-3d";
import { lbm3dCollide } from "./relaxation-3d";
import {
  lbm3dLatticeSnapshotOf,
  lbm3dMacroscopicOf,
  lbm3dSISnapshotOf,
  lbm3dSolverFieldsOf,
} from "./readout-3d";
import {
  type Lbm3dLatticeSnapshot,
  type Lbm3dMomentumBookkeeping,
  type Lbm3dRunMeta,
  type Lbm3dSISnapshot,
  type Lbm3dStepperConfig,
  createLbm3dStepper,
  lbm3dCompileFace,
} from "./stepper-3d";
import {
  createLbm3dState,
  lbm3dComputeMacroscopic,
  lbm3dReflectSolids,
  lbm3dTotalMomentum,
  type Lbm3dSolidMask,
  type Lbm3dState,
} from "./state-3d";
import { lbm3dStream, lbm3dSwap } from "./streaming-3d";
import {
  Lbm3dTorqueAccumulator,
  lbm3dRotatingWallTorqueSink,
  type Lbm3dTorqueLedger,
} from "./torque-3d";

/**
 * What {@link createResolvedRotation3dStepper} consumes — the 66a
 * stepper's SI config (whose mask carries the STATIC solids — the
 * tube, the hub bearing block) plus the rotation: the axis, the shaft
 * rate, and the rotor as an occupancy predicate over DISPLACEMENT
 * coordinates from the axis, authored at the θ = 0 attitude.
 */
export interface Lbm3dResolvedRotationConfig extends Omit<
  Lbm3dStepperConfig,
  "rotation"
> {
  /** The routing marker — required, so static doors refuse misroutes. */
  readonly rotation: { readonly kind: "resolved-rotation" };
  /** The rotation axis, SI (converted to lattice cells at compile). */
  readonly axis: Lbm3dRotationAxisSpec;
  /** The shaft rate, rad/s — positive about +ê, non-zero. */
  readonly omegaRadPerS: number;
  /** The rotor at θ = 0: true where the displacement is inside the body. */
  readonly rotor: (
    displacementX: number,
    displacementY: number,
    displacementZ: number,
  ) => boolean;
}

/** The immutable resolved-rotation run facts a driver displays or hashes. */
export interface Lbm3dResolvedRotationMeta extends Lbm3dRunMeta {
  readonly axis: Lbm3dRotationAxis;
  readonly omegaRadPerS: number;
  /** Ω in lattice units — radians per lattice step. */
  readonly omegaLattice: number;
  /** The rotor's largest perpendicular radius (tip radius), cells. */
  readonly rotorRadiusLattice: number;
  /** Steps one shaft revolution takes (2π/|Ω_lat|). */
  readonly stepsPerRevolution: number;
  /** Rotor nodes at the θ = 0 attitude (the rigid body's cell count). */
  readonly rotorNodeCount: number;
  /** Static solid nodes (the mask the config carried). */
  readonly staticSolidNodeCount: number;
}

/** The deterministic resolved-rotation stepper — Phase 66b's showcase door. */
export interface Lbm3dResolvedRotationStepper {
  readonly meta: Lbm3dResolvedRotationMeta;
  /** The completed step count (monotone; frozen on divergence). */
  get step(): number;
  /** Whether the run diverged (NaN/negative density) and froze. */
  get diverged(): boolean;
  /** Advances one step (a no-op once diverged). */
  advance(): void;
  /** Advances `steps` steps (a no-op once diverged). */
  run(steps: number): void;
  /** Total momentum over ALL distributions (solid storage included). */
  momentumLattice(): {
    readonly x: number;
    readonly y: number;
    readonly z: number;
  };
  /** The last completed step's momentum ledger (undefined before step 1). */
  lastStepBookkeeping(): Lbm3dMomentumBookkeeping | undefined;
  /** The total fluid-on-solids force samples and history triple. */
  forceState(): {
    readonly current: {
      readonly dragN: number;
      readonly liftN: number;
      readonly sideN: number;
    };
    readonly history: readonly SimHistorySeries[];
  };
  /** The ROTOR's axial torque samples and history (static drag excluded). */
  rotationState(): {
    readonly current: {
      readonly torqueNPerM: number;
    };
    readonly history: readonly SimHistorySeries[];
  };
  /** Macroscopic fields, lattice units (solid columns zero). */
  snapshotLattice(): Lbm3dLatticeSnapshot;
  /** Macroscopic fields, SI (solid columns zero). */
  snapshotSI(): Lbm3dSISnapshot;
  /** The S4-ready solver fields (the 66a field set and labels). */
  solverFields(): readonly SolverSimField[];
  /** Live read-only views of the nineteen SoA distribution arrays. */
  distributions(): readonly Float32Array[];
}

/**
 * Creates the resolved-rotation stepper: validates the static half
 * through a CPU twin (every shared refusal, the unit closure, the
 * rates), compiles the axis, measures the rotor's tip radius from the
 * θ = 0 attitude (rigid body — rotation-invariant), and owns a mask
 * it rebuilds every step. Refuses, beyond the twin's own refusals: a
 * foreign rotation marker, a bad axis, a zero or non-finite shaft
 * rate, a rotor with no cells, and a tip lattice velocity past the
 * low-Mach ceiling (the substep discipline).
 */
export function createResolvedRotation3dStepper(
  config: Lbm3dResolvedRotationConfig,
): SimParseResult<Lbm3dResolvedRotationStepper, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  const markerKind: string = config.rotation.kind;
  if (config.rotation.kind !== "resolved-rotation") {
    return refuse(
      `The resolved-rotation door takes configs marked kind "resolved-rotation", received "${markerKind}".`,
      config.rotation,
    );
  }
  if (
    typeof config.omegaRadPerS !== "number" ||
    !Number.isFinite(config.omegaRadPerS)
  ) {
    return refuse(
      "A resolved-rotation shaft rate must be a finite number of rad/s.",
      config.omegaRadPerS,
    );
  }
  if (config.omegaRadPerS === 0) {
    return refuse(
      "A resolved-rotation shaft rate must be non-zero — a stationary geometry is the static stepper's door, not this one.",
      config.omegaRadPerS,
    );
  }
  const originM: readonly [number, number, number] = config.originM ?? [
    0, 0, 0,
  ];
  const axis = lbm3dCompileAxis(config.axis, originM, config.cellSizeM);
  if (!axis.ok) return axis;
  const twinConfig: Lbm3dStepperConfig = {
    mask: config.mask,
    fluid: config.fluid,
    cellSizeM: config.cellSizeM,
    characteristicVelocityMPerS: config.characteristicVelocityMPerS,
    ...(config.latticeVelocity === undefined
      ? {}
      : { latticeVelocity: config.latticeVelocity }),
    ...(config.collision === undefined ? {} : { collision: config.collision }),
    west: config.west,
    east: config.east,
    south: config.south,
    north: config.north,
    bottom: config.bottom,
    top: config.top,
    ...(config.referencePressurePa === undefined
      ? {}
      : { referencePressurePa: config.referencePressurePa }),
    originM: config.originM,
  };
  const twin = createLbm3dStepper(twinConfig);
  if (!twin.ok) return twin;
  const base = twin.value.meta;
  const { nx, ny, nz } = base;
  const plane = nx * ny;
  const nodes = nx * ny * nz;
  const staticSolid = config.mask.solid;
  const [ex, ey, ez] = axis.value.direction;
  const [axp, ayp, azp] = axis.value.pointLattice;

  // --- The rotor at θ = 0: mask, node count, and tip radius -----------
  const rotorAt = (theta: number, out: Uint8Array): Uint8Array => {
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    const oneMinusCos = 1 - cos;
    for (let z = 0; z < nz; z += 1) {
      for (let y = 0; y < ny; y += 1) {
        for (let x = 0; x < nx; x += 1) {
          const dx = x - axp;
          const dy = y - ayp;
          const dz = z - azp;
          // Rodrigues for R(−θ): v = d·cosθ − (ê×d)·sinθ + ê(ê·d)(1−cosθ).
          const along = dx * ex + dy * ey + dz * ez;
          const kx = ey * dz - ez * dy;
          const ky = ez * dx - ex * dz;
          const kz = ex * dy - ey * dx;
          out[x + y * nx + z * plane] = config.rotor(
            dx * cos - kx * sin + ex * along * oneMinusCos,
            dy * cos - ky * sin + ey * along * oneMinusCos,
            dz * cos - kz * sin + ez * along * oneMinusCos,
          )
            ? 1
            : 0;
        }
      }
    }
    return out;
  };
  const rotorCurrent = rotorAt(0, new Uint8Array(nodes));
  let rotorNodeCount = 0;
  let rotorRadiusLattice = 0;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const index = x + y * nx + z * plane;
        if (rotorCurrent[index] !== 1) continue;
        rotorNodeCount += 1;
        const dx = x - axp;
        const dy = y - ayp;
        const dz = z - azp;
        const along = dx * ex + dy * ey + dz * ez;
        const px = dx - along * ex;
        const py = dy - along * ey;
        const pz = dz - along * ez;
        rotorRadiusLattice = Math.max(
          rotorRadiusLattice,
          Math.sqrt(px * px + py * py + pz * pz),
        );
      }
    }
  }
  if (rotorNodeCount === 0) {
    return refuse(
      "A resolved-rotation rotor predicate selected no nodes — there is no geometry to rotate.",
      config.rotor,
    );
  }
  const omegaLattice = lbm3dOmegaLattice(
    config.omegaRadPerS,
    base.units.timeStepS,
  );
  const tipVelocity = Math.abs(omegaLattice) * rotorRadiusLattice;
  if (tipVelocity > LBM_MAX_LATTICE_VELOCITY) {
    return refuse(
      `The rotor's tip lattice velocity (${tipVelocity.toPrecision(4)}, |Ω_lat|·r_tip) exceeds the ${String(LBM_MAX_LATTICE_VELOCITY)} low-Mach ceiling — the per-revolution substep discipline refuses it: slow the shaft or pair the characteristic velocity with a smaller lattice velocity (a finer dt).`,
      { omegaRadPerS: config.omegaRadPerS, rotorRadiusLattice },
    );
  }

  // --- The face conditions (the exported 66a compiler — one source) ----
  const conditions: Partial<Record<Lbm3dFace, Lbm3dFaceCondition>> = {};
  for (const face of LBM3D_FACES) {
    const spec = config[face];
    const compiled = lbm3dCompileFace(
      face,
      spec,
      base.units,
      base.referencePressurePa,
    );
    if (!compiled.ok) return compiled;
    conditions[face] = compiled.value;
  }
  const faceConditions = conditions as Record<Lbm3dFace, Lbm3dFaceCondition>;

  // --- State: the union mask this stepper owns and mutates --------------
  const solid = new Uint8Array(nodes);
  let staticSolidNodeCount = 0;
  for (let index = 0; index < nodes; index += 1) {
    if (staticSolid[index] === 1) {
      solid[index] = 1;
      staticSolidNodeCount += 1;
    } else if (rotorCurrent[index] === 1) {
      solid[index] = 1;
    }
  }
  const ownedMask: Lbm3dSolidMask = { nx, ny, nz, solid };
  const state: Lbm3dState = createLbm3dState(ownedMask);
  const forces = new Lbm3dForceAccumulator(base.units);
  const torques = new Lbm3dTorqueAccumulator(base.units);
  const faceLedger: Lbm3dFaceMomentumLedger = { x: 0, y: 0, z: 0 };
  const torqueLedger: Lbm3dTorqueLedger = { tauLat: 0 };
  const torqueSink = lbm3dRotatingWallTorqueSink(
    torqueLedger,
    axis.value,
    omegaLattice,
    rotorCurrent,
    state.rho,
    nx,
    ny,
  );
  let step = 0;
  let diverged = false;
  let bookkeeping: Lbm3dMomentumBookkeeping | undefined;
  const meta: Lbm3dResolvedRotationMeta = Object.freeze({
    ...base,
    axis: axis.value,
    omegaRadPerS: config.omegaRadPerS,
    omegaLattice,
    rotorRadiusLattice,
    stepsPerRevolution: lbm3dStepsPerRevolution(omegaLattice),
    rotorNodeCount,
    staticSolidNodeCount,
  });

  /** Reflects a covered node's populations in place (parked convention). */
  const parkCovered = (index: number): void => {
    for (let i = 1; i < D3Q19_Q; i += 1) {
      const opposite = D3Q19_OPPOSITE[i] ?? 0;
      if (opposite <= i) continue;
      const column = state.f[i];
      const mirror = state.f[opposite];
      if (column === undefined || mirror === undefined) continue;
      const carried = column[index] ?? 0;
      column[index] = mirror[index] ?? 0;
      mirror[index] = carried;
    }
  };

  /** A fresh node: equilibrium at the mean neighboring-fluid density, at rest. */
  const seedFresh = (x: number, y: number, z: number): void => {
    const index = x + y * nx + z * plane;
    let sum = 0;
    let count = 0;
    for (let i = 1; i < D3Q19_Q; i += 1) {
      const [cx, cy, cz] = D3Q19_VELOCITIES[i] ?? [0, 0, 0];
      const nxx = x + cx;
      const nyy = y + cy;
      const nzz = z + cz;
      if (
        nxx < 0 ||
        nxx >= nx ||
        nyy < 0 ||
        nyy >= ny ||
        nzz < 0 ||
        nzz >= nz
      ) {
        continue;
      }
      const neighbor = nxx + nyy * nx + nzz * plane;
      if (solid[neighbor] === 1) continue;
      sum += state.rho[neighbor] ?? 1;
      count += 1;
    }
    const rho = count > 0 ? sum / count : 1;
    for (let i = 0; i < D3Q19_Q; i += 1) {
      const column = state.f[i];
      if (column === undefined) continue;
      column[index] = (D3Q19_WEIGHTS[i] ?? 0) * rho;
    }
  };

  const advance = (): void => {
    if (diverged) return;
    step += 1;
    // The rotor at θ = step·Ω_lat — product, never accumulated sum.
    const nextRotor = rotorAt(step * omegaLattice, new Uint8Array(nodes));
    for (let index = 0; index < nodes; index += 1) {
      const wasRotor = rotorCurrent[index] === 1;
      const isRotor = nextRotor[index] === 1;
      if (wasRotor === isRotor) continue;
      const x = index % nx;
      const y = Math.floor(index / nx) % ny;
      const z = Math.floor(index / (nx * ny));
      if (isRotor && staticSolid[index] !== 1) {
        solid[index] = 1;
        parkCovered(index);
      } else if (!isRotor && staticSolid[index] !== 1) {
        solid[index] = 0;
        seedFresh(x, y, z);
      }
    }
    rotorCurrent.set(nextRotor);
    if (!lbm3dComputeMacroscopic(state)) {
      diverged = true;
      return;
    }
    lbm3dCollide(state, base.rates);
    const dropped = lbm3dStream(state);
    lbm3dApplyFaceConditions(state, faceConditions, faceLedger);
    torqueLedger.tauLat = 0;
    const impulse = lbm3dReflectSolids(state, torqueSink);
    forces.record(impulse.impulseX, impulse.impulseY, impulse.impulseZ);
    torques.record(torqueLedger.tauLat);
    lbm3dSwap(state);
    bookkeeping = {
      step,
      droppedX: dropped.droppedX,
      droppedY: dropped.droppedY,
      droppedZ: dropped.droppedZ,
      faceDeltaX: faceLedger.x,
      faceDeltaY: faceLedger.y,
      faceDeltaZ: faceLedger.z,
      solidImpulseX: impulse.impulseX,
      solidImpulseY: impulse.impulseY,
      solidImpulseZ: impulse.impulseZ,
    };
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
    rotationState: () => ({
      current: torques.current(),
      history: torques.history(),
    }),
    snapshotLattice: () => lbm3dLatticeSnapshotOf(state, step),
    snapshotSI: () =>
      lbm3dSISnapshotOf(state, step, base.units, base.referencePressurePa),
    solverFields(): readonly SolverSimField[] {
      const macro = lbm3dMacroscopicOf(state);
      return lbm3dSolverFieldsOf(
        macro,
        [nx, ny, nz],
        base.units,
        base.referencePressurePa,
        originM,
      );
    },
  });
}
