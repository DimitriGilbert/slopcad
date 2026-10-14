/**
 * MRF — the moving reference frame (Phase 66b), the HONEST DEFAULT for
 * steady fan analysis (risk S3's named fallback): the rotating zone is
 * solved as the FROZEN-ROTOR steady rotating-frame equations, and the
 * formulation is stated up front because it decides everything else.
 *
 * ## The formulation, derived (frozen rotor, lab-variable populations)
 *
 * Lattice populations are frame-AGNOSTIC — the macroscopic velocity
 * they encode, u_h = Σf·c/ρ, is the LAB velocity everywhere on the
 * lattice — and the lattice itself is lab-fixed (static grid, static
 * zone mask), so streaming transports by u_h under the lattice's
 * single, lab time. The rotating-frame momentum equation, whose native
 * variable is u_rel = u_h − Ω×r, becomes in u_h EXACTLY (substitute
 * u_rel = u_h − Ω×r into the relative form, use (u_rel·∇)(Ω×r) =
 * Ω×u_rel and Ω×(Ω×r) = −Ω²r⊥; the centrifugal cancels against half
 * the Coriolis):
 *
 *   ∂u_h/∂t|rot + (u_rel·∇)u_h = −∇p/ρ + ν∇²u_h − Ω×u_h
 *
 * — ONE Coriolis at the lab velocity, NO centrifugal, transported by
 * u_rel, steady in the rotating frame. (Cross-check the identity: with
 * ∂/∂t|rot = ∂/∂t|lab + ((Ω×r)·∇) − Ω×, this reduces to the plain
 * unforced lab NS — as it must, u_h being the lab velocity.)
 *
 * The frozen rotor wants the STEADY rotating-frame equations,
 * (u_rel·∇)u_h = −∇p/ρ + ν∇²u_h − Ω×u_h. The lattice integrates
 * ∂u_h/∂t + (u_h·∇)u_h = −∇p/ρ + ν∇²u_h + F/ρ (native lab advection),
 * so the Guo force the collision applies must supply exactly the
 * advection mismatch plus the one Coriolis:
 *
 *   F/ρ = ((Ω×r)·∇)u_h − Ω×u_h  — the implemented zone force.
 *
 * Its fixed points are the formulation's honesty anchors, all exact:
 * at REST u_h = 0 the force vanishes (uniform pressure, no head); in
 * RIGID CO-ROTATION u_h = Ω×r the azimuthal self-derivative
 * ((Ω×r)·∇)(Ω×r) = Ω×(Ω×r) cancels the Coriolis term exactly — no
 * force, and the physical head ∇p = ρΩ²r⊥ (the centripetal balance,
 * HALF the head a naive double-count produces); for AXISYMMETRIC
 * THROUGH-FLOW ALONG the axis (u_h ∥ Ω) both terms vanish — no
 * manufactured swirl and no radial pumping. The fixtures pin all
 * three. The force enters collision through the Guo forcing seam
 * `./relaxation-3d` grew for exactly this consumer, and the rotor's
 * no-slip (u_rel = 0 at the wall) is u_h = Ω×r — a MOVING wall in the
 * lab variables, carried by the standard moving-wall bounce-back
 * correction at the link midpoints (`./torque-3d`'s rotating sink —
 * the same machinery resolved rotation uses, so the two schemes
 * measure rotor torque identically by construction). The stator and
 * domain walls outside the zone are static in the lab — plain
 * bounce-back.
 *
 * ## The interface, and the coarseness, stated honestly
 *
 * The zone boundary needs NO population treatment at all: since the
 * populations are frame-agnostic, they cross the zone boundary as the
 * SAME fluid — raw exchange, exactly conservative in both mass and
 * momentum by construction (there are no interface terms in the
 * momentum audit). The frame difference lives entirely in the zone's
 * body force and the rotor's wall velocity. The coarseness, then:
 * the ((Ω×r)·∇)u_h term is evaluated by lattice differences —
 * second-order central in the open interior, FIRST-ORDER one-sided
 * where a solid or the domain edge blocks one neighbor, and zero on a
 * doubly-blocked axis (a crevice) — the one first-order piece of the
 * formulation, stated here; the forces end abruptly at the staircase
 * zone boundary (an O(dx) force jump — law S3's geometry honesty,
 * nothing new); and the moving-wall correction is first-order in the
 * tip speed, the same first-order honesty the resolved path carries.
 * Two earlier drafts of this zone force are deleted history, both
 * caught by fixtures: a draft that re-projected crossing populations
 * between frames was a momentum pump (it spun the stationary zone
 * toward rigid co-rotation), and a draft that applied the full
 * relative-frame force pair −2Ω×u_h − Ω²r⊥ at the LAB velocity solved
 * a different equation — wrong at first order in Ω (it differs from
 * the exact force by Ω×u_h + Ω²r⊥ + ((Ω×r)·∇)u_h, demanded a doubled
 * ∇p = 2ρΩ²r⊥ head at co-rotation, and manufactured a −2Ω×u swirl in
 * through-flow). The raw interface and the fixed-point fixtures in
 * `./mrf-3d.test.ts` are the evidence.
 *
 * ## Torque, the load-curve currency
 *
 * The rotor's axial torque is the moving-wall momentum exchange per
 * boundary link crossed with its lever arm — a per-step series in SI
 * N·m, the input `./fan-3d` builds T_load(ω) from (windowed means of
 * the negated series; with Ω > 0 about +ê the steady fluid-on-rotor
 * torque is negative). A fixed-RPM run (motor-less scenarios) is this
 * door with a constant Ω; the motor-driven operating point is
 * `./fan-3d`'s solve over a ladder of these runs.
 *
 * Determinism (law S2): fixed step order over the same arrays —
 * macroscopic, frame forces, forced collision, streaming, faces,
 * reflection with the torque sink, swap — all pure arithmetic, pinned
 * bitwise by test. The exact momentum audit closes as
 *   ΔM = frame forces + face overwrites − solid impulses − dropped.
 *
 * One stated coarseness of the moving-boundary family: the parked
 * moving-wall correction leaves an O(u_w) mass residual per bounce
 * (each parked population gains δ without a compensating partner —
 * the standard full-way treatment; measured 0.7 % of the domain mass
 * over the 4000-step Couette fixture at Ω_lat·r_rotor = 0.09), and
 * the density field carries it. The rest of the books — momentum
 * included — close exactly.
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
import { Lbm3dForceAccumulator } from "./forces-3d";
import { LBM_MAX_LATTICE_VELOCITY } from "./lattice-units";
import {
  type Lbm3dRotationAxis,
  type Lbm3dRotationAxisSpec,
  lbm3dCompileAxis,
  lbm3dOmegaLattice,
  lbm3dPerpendicularRadius,
  lbm3dStepsPerRevolution,
} from "./rotation-3d";
import { lbm3dCollide, type Lbm3dGuoForcing } from "./relaxation-3d";
import {
  lbm3dLatticeSnapshotOf,
  lbm3dMacroscopicOf,
  lbm3dSISnapshotOf,
  lbm3dSolverFieldsOf,
  type Lbm3dVelocityShift,
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
  type Lbm3dState,
} from "./state-3d";
import { lbm3dStream, lbm3dSwap } from "./streaming-3d";
import {
  Lbm3dTorqueAccumulator,
  lbm3dMrfRotorTorqueSink,
  type Lbm3dTorqueLedger,
} from "./torque-3d";

/**
 * What {@link createMrf3dStepper} consumes — the 66a stepper's SI
 * config plus the rotation: the axis, the frame rate, and the rotating
 * zone as a predicate over LATTICE node coordinates (the module
 * evaluates it once; the zone is static for the run's life — the
 * frozen rotor's zone).
 */
export interface Lbm3dMrfConfig extends Omit<Lbm3dStepperConfig, "rotation"> {
  /** The routing marker — required, so static doors refuse misroutes. */
  readonly rotation: { readonly kind: "mrf" };
  /** The rotation axis, SI (converted to lattice cells at compile). */
  readonly axis: Lbm3dRotationAxisSpec;
  /** The frame rate, rad/s — positive about +ê, non-zero. */
  readonly omegaRadPerS: number;
  /** The rotating zone: true inside the frame region (lattice coords). */
  readonly rotatingZone: (x: number, y: number, z: number) => boolean;
}

/** The immutable MRF run facts a driver displays or hashes. */
export interface Lbm3dMrfMeta extends Lbm3dRunMeta {
  readonly axis: Lbm3dRotationAxis;
  readonly omegaRadPerS: number;
  /** Ω in lattice units — radians per lattice step. */
  readonly omegaLattice: number;
  /** The largest perpendicular radius of the zone's fluid nodes, cells. */
  readonly zoneRadiusLattice: number;
  /** Steps one frame revolution takes (2π/|Ω_lat|). */
  readonly stepsPerRevolution: number;
  /** Fluid nodes inside the rotating zone. */
  readonly zoneFluidNodeCount: number;
  /** Solid nodes inside the zone — the rotor whose links carry u_w. */
  readonly rotorNodeCount: number;
}

/** One completed MRF step's exact momentum ledger, lattice units. */
export interface Lbm3dMrfBookkeeping extends Lbm3dMomentumBookkeeping {
  /** Σ F over the zone's frame forces this step (the Guo momentum). */
  readonly frameForceX: number;
  readonly frameForceY: number;
  readonly frameForceZ: number;
}

/**
 * One zone fluid node: flat index, its lattice coordinates (the
 * difference stencils' base), and its frame velocity w = Ω_lat·(ê×r)
 * — the azimuthal transport vector of the ((Ω×r)·∇)u_h term, static
 * geometry folded once at compile.
 */
interface MrfZoneNode {
  readonly index: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly wx: number;
  readonly wy: number;
  readonly wz: number;
}

/** The deterministic MRF stepper — the Phase 66b steady-rotation CPU door. */
export interface Lbm3dMrfStepper {
  readonly meta: Lbm3dMrfMeta;
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
  /** The last completed step's extended ledger (undefined before step 1). */
  lastStepBookkeeping(): Lbm3dMrfBookkeeping | undefined;
  /** The total fluid-on-solids force samples and history triple. */
  forceState(): {
    readonly current: {
      readonly dragN: number;
      readonly liftN: number;
      readonly sideN: number;
    };
    readonly history: readonly SimHistorySeries[];
  };
  /** The ROTOR's axial torque samples and history (the load currency). */
  rotationState(): {
    readonly current: {
      readonly torqueNPerM: number;
    };
    readonly history: readonly SimHistorySeries[];
  };
  /** Macroscopic fields, lattice units (raw Σf·c/ρ velocities). */
  snapshotLattice(): Lbm3dLatticeSnapshot;
  /** Macroscopic fields, SI — physical (half-force-shifted) in the zone. */
  snapshotSI(): Lbm3dSISnapshot;
  /** The S4-ready solver fields (the 66a field set and labels). */
  solverFields(): readonly SolverSimField[];
  /** Live read-only views of the nineteen SoA distribution arrays. */
  distributions(): readonly Float32Array[];
}

/**
 * Builds a rotating-zone mask as a cylinder about the axis — the fan
 * analysis's zone shape (a cylinder enclosing the rotor, inside the
 * tube): true where the perpendicular radius is within `radiusCells`
 * of the axis line. The predicate form `Lbm3dMrfConfig` wants is
 * `mrfCylindricalZonePredicate(...)`; this array form serves tests and
 * inspections.
 */
export function mrfCylindricalZone(
  axis: Lbm3dRotationAxis,
  nx: number,
  ny: number,
  nz: number,
  radiusCells: number,
): Uint8Array {
  const zone = new Uint8Array(nx * ny * nz);
  const plane = nx * ny;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        zone[x + y * nx + z * plane] =
          lbm3dPerpendicularRadius(axis, x, y, z) <= radiusCells ? 1 : 0;
      }
    }
  }
  return zone;
}

/** The predicate twin of {@link mrfCylindricalZone} (the config's form). */
export function mrfCylindricalZonePredicate(
  axis: Lbm3dRotationAxis,
  radiusCells: number,
): (x: number, y: number, z: number) => boolean {
  return (x, y, z) => lbm3dPerpendicularRadius(axis, x, y, z) <= radiusCells;
}

/**
 * Creates the MRF stepper: validates through a static CPU twin (the
 * WGSL provider's own precedent — one source for every refusal, the
 * unit closure, and the rates), then owns its state and drives the
 * shared primitives with the zone frame force and the rotor's
 * moving-wall torque sink. A rotorless zone is LEGAL — the frame force
 * applies wherever the zone predicate says, its fixed points are the
 * module doc's rest and co-rotation anchors, and the door's own
 * refusals are about the frame and the lattice, not the rotor (the
 * fan analysis separately requires its rotor at `./fan-3d`'s door).
 * Refuses, beyond the twin's own refusals: a foreign rotation marker,
 * a bad axis, a zero/non-finite frame rate, an empty rotating zone,
 * and a frame speed whose zone-edge lattice velocity exceeds the
 * low-Mach ceiling.
 */
export function createMrf3dStepper(
  config: Lbm3dMrfConfig,
): SimParseResult<Lbm3dMrfStepper, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  const markerKind: string = config.rotation.kind;
  if (config.rotation.kind !== "mrf") {
    return refuse(
      `The MRF door takes configs marked kind "mrf", received "${markerKind}".`,
      config.rotation,
    );
  }
  if (
    typeof config.omegaRadPerS !== "number" ||
    !Number.isFinite(config.omegaRadPerS)
  ) {
    return refuse(
      "An MRF frame rate must be a finite number of rad/s.",
      config.omegaRadPerS,
    );
  }
  if (config.omegaRadPerS === 0) {
    return refuse(
      "An MRF frame rate must be non-zero — a stationary frame is the static stepper's door, not this one.",
      config.omegaRadPerS,
    );
  }
  const originM: readonly [number, number, number] = config.originM ?? [
    0, 0, 0,
  ];
  const axis = lbm3dCompileAxis(config.axis, originM, config.cellSizeM);
  if (!axis.ok) return axis;
  // The static twin: every shared refusal, the unit closure, the rates.
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
  const mask = config.mask;
  const omegaLattice = lbm3dOmegaLattice(
    config.omegaRadPerS,
    base.units.timeStepS,
  );

  // --- The zone, its fluid nodes, its radius, and the rotor mask ------
  const zone = new Uint8Array(nodes);
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        zone[x + y * nx + z * plane] = config.rotatingZone(x, y, z) ? 1 : 0;
      }
    }
  }
  const zoneNodes: MrfZoneNode[] = [];
  let zoneRadiusLattice = 0;
  const rotor = new Uint8Array(nodes);
  let rotorNodeCount = 0;
  const [ex, ey, ez] = axis.value.direction;
  const [axp, ayp, azp] = axis.value.pointLattice;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const index = x + y * nx + z * plane;
        if (zone[index] !== 1) continue;
        if (mask.solid[index] === 1) {
          rotor[index] = 1;
          rotorNodeCount += 1;
          continue;
        }
        const rx = x - axp;
        const ry = y - ayp;
        const rz = z - azp;
        const along = rx * ex + ry * ey + rz * ez;
        const px = rx - along * ex;
        const py = ry - along * ey;
        const pz = rz - along * ez;
        zoneRadiusLattice = Math.max(
          zoneRadiusLattice,
          Math.sqrt(px * px + py * py + pz * pz),
        );
        // The node's frame velocity w = Ω_lat·(ê×r) — the azimuthal
        // transport vector of the force's ((Ω×r)·∇)u_h term, static
        // geometry folded once (the r⊥ projection drops out: ê×r is
        // already perpendicular to the axis).
        zoneNodes.push({
          index,
          x,
          y,
          z,
          wx: omegaLattice * (ey * rz - ez * ry),
          wy: omegaLattice * (ez * rx - ex * rz),
          wz: omegaLattice * (ex * ry - ey * rx),
        });
      }
    }
  }
  if (zoneNodes.length === 0) {
    return refuse(
      "An MRF rotating zone must contain fluid nodes — the predicate selected none.",
      config.rotatingZone,
    );
  }
  const zoneEdgeVelocity = Math.abs(omegaLattice) * zoneRadiusLattice;
  if (zoneEdgeVelocity > LBM_MAX_LATTICE_VELOCITY) {
    return refuse(
      `The MRF frame's zone-edge lattice velocity (${zoneEdgeVelocity.toPrecision(4)}, |Ω_lat|·R_zone) exceeds the ${String(LBM_MAX_LATTICE_VELOCITY)} low-Mach ceiling — slow the frame, shrink the zone, or pair the characteristic velocity with a smaller lattice velocity (a finer dt).`,
      { omegaRadPerS: config.omegaRadPerS, zoneRadiusLattice },
    );
  }

  // --- The face conditions (the exported 66a compiler — one source) ----------
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

  // --- State, accumulators, force/shift arrays -------------------------------
  const state: Lbm3dState = createLbm3dState(mask);
  const forces = new Lbm3dForceAccumulator(base.units);
  const torques = new Lbm3dTorqueAccumulator(base.units);
  const fx = new Float64Array(nodes);
  const fy = new Float64Array(nodes);
  const fz = new Float64Array(nodes);
  const shiftX = new Float64Array(nodes);
  const shiftY = new Float64Array(nodes);
  const shiftZ = new Float64Array(nodes);
  const forcing: Lbm3dGuoForcing = { fx, fy, fz };
  const velocityShift: Lbm3dVelocityShift = {
    dx: shiftX,
    dy: shiftY,
    dz: shiftZ,
  };
  const faceLedger: Lbm3dFaceMomentumLedger = { x: 0, y: 0, z: 0 };
  const torqueLedger: Lbm3dTorqueLedger = { tauLat: 0 };
  const torqueSink = lbm3dMrfRotorTorqueSink(
    torqueLedger,
    axis.value,
    omegaLattice,
    rotor,
    state.rho,
    nx,
    ny,
  );
  /**
   * One partial derivative of a macroscopic field at a zone node along
   * a unit lattice axis — the ((Ω×r)·∇)u_h term's stencil, honoring
   * the solids: second-order central where both neighbors are fluid,
   * first-order one-sided where a solid (or the domain edge) blocks
   * one side, and zero on a doubly-blocked axis (the crevice case —
   * the module doc's stated first-order coarseness). Lattice spacing
   * is 1: a halving on the central form, no scaling elsewhere.
   */
  const axisPartial = (
    field: Float64Array,
    x: number,
    y: number,
    z: number,
    axisX: number,
    axisY: number,
    axisZ: number,
  ): number => {
    const forwardX = x + axisX;
    const forwardY = y + axisY;
    const forwardZ = z + axisZ;
    const backwardX = x - axisX;
    const backwardY = y - axisY;
    const backwardZ = z - axisZ;
    const forwardFluid =
      forwardX >= 0 &&
      forwardX < nx &&
      forwardY >= 0 &&
      forwardY < ny &&
      forwardZ >= 0 &&
      forwardZ < nz &&
      mask.solid[forwardX + forwardY * nx + forwardZ * plane] !== 1;
    const backwardFluid =
      backwardX >= 0 &&
      backwardX < nx &&
      backwardY >= 0 &&
      backwardY < ny &&
      backwardZ >= 0 &&
      backwardZ < nz &&
      mask.solid[backwardX + backwardY * nx + backwardZ * plane] !== 1;
    const here = field[x + y * nx + z * plane] ?? 0;
    if (forwardFluid && backwardFluid) {
      return (
        ((field[forwardX + forwardY * nx + forwardZ * plane] ?? 0) -
          (field[backwardX + backwardY * nx + backwardZ * plane] ?? 0)) /
        2
      );
    }
    if (forwardFluid) {
      return (field[forwardX + forwardY * nx + forwardZ * plane] ?? 0) - here;
    }
    if (backwardFluid) {
      return (
        here - (field[backwardX + backwardY * nx + backwardZ * plane] ?? 0)
      );
    }
    return 0;
  };
  let step = 0;
  let diverged = false;
  let bookkeeping: Lbm3dMrfBookkeeping | undefined;
  const meta: Lbm3dMrfMeta = Object.freeze({
    ...base,
    axis: axis.value,
    omegaRadPerS: config.omegaRadPerS,
    omegaLattice,
    zoneRadiusLattice,
    stepsPerRevolution: lbm3dStepsPerRevolution(omegaLattice),
    zoneFluidNodeCount: zoneNodes.length,
    rotorNodeCount,
  });

  const advance = (): void => {
    if (diverged) return;
    if (!lbm3dComputeMacroscopic(state)) {
      diverged = true;
      return;
    }
    // The frozen-rotor zone force, the exact lab-variable form the
    // module doc derives: a = ((Ω×r)·∇)u_h − Ω×u_h (the steady
    // rotating-frame equations carried by the lattice's native lab
    // advection); F = ρ·a; shift = a/2 (the half-force velocity
    // correction the Guo scheme's physical velocity carries). The
    // azimuthal derivative is w·(the per-axis partials above), w the
    // node's folded frame velocity.
    fx.fill(0);
    fy.fill(0);
    fz.fill(0);
    shiftX.fill(0);
    shiftY.fill(0);
    shiftZ.fill(0);
    let frameForceX = 0;
    let frameForceY = 0;
    let frameForceZ = 0;
    for (const node of zoneNodes) {
      const index = node.index;
      const rho = state.rho[index] ?? 1;
      const ux = state.ux[index] ?? 0;
      const uy = state.uy[index] ?? 0;
      const uz = state.uz[index] ?? 0;
      const { x, y, z, wx, wy, wz } = node;
      const axx =
        wx * axisPartial(state.ux, x, y, z, 1, 0, 0) +
        wy * axisPartial(state.ux, x, y, z, 0, 1, 0) +
        wz * axisPartial(state.ux, x, y, z, 0, 0, 1) -
        omegaLattice * (ey * uz - ez * uy);
      const ayy =
        wx * axisPartial(state.uy, x, y, z, 1, 0, 0) +
        wy * axisPartial(state.uy, x, y, z, 0, 1, 0) +
        wz * axisPartial(state.uy, x, y, z, 0, 0, 1) -
        omegaLattice * (ez * ux - ex * uz);
      const azz =
        wx * axisPartial(state.uz, x, y, z, 1, 0, 0) +
        wy * axisPartial(state.uz, x, y, z, 0, 1, 0) +
        wz * axisPartial(state.uz, x, y, z, 0, 0, 1) -
        omegaLattice * (ex * uy - ey * ux);
      const forceX = rho * axx;
      const forceY = rho * ayy;
      const forceZ = rho * azz;
      fx[index] = forceX;
      fy[index] = forceY;
      fz[index] = forceZ;
      shiftX[index] = axx / 2;
      shiftY[index] = ayy / 2;
      shiftZ[index] = azz / 2;
      frameForceX += forceX;
      frameForceY += forceY;
      frameForceZ += forceZ;
    }
    lbm3dCollide(state, base.rates, forcing);
    const dropped = lbm3dStream(state);
    lbm3dApplyFaceConditions(state, faceConditions, faceLedger);
    torqueLedger.tauLat = 0;
    const impulse = lbm3dReflectSolids(state, torqueSink);
    forces.record(impulse.impulseX, impulse.impulseY, impulse.impulseZ);
    torques.record(torqueLedger.tauLat);
    lbm3dSwap(state);
    step += 1;
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
      frameForceX,
      frameForceY,
      frameForceZ,
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
      lbm3dSISnapshotOf(
        state,
        step,
        base.units,
        base.referencePressurePa,
        velocityShift,
      ),
    solverFields(): readonly SolverSimField[] {
      const macro = lbm3dMacroscopicOf(state);
      return lbm3dSolverFieldsOf(
        macro,
        [nx, ny, nz],
        base.units,
        base.referencePressurePa,
        originM,
        velocityShift,
      );
    },
  });
}
