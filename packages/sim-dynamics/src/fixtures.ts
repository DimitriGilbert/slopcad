/**
 * Analytic mechanism fixtures (Phase 67a): the shared wire-form builders
 * the ground-truth suites assemble — each one hand-solvable, each one
 * documented with the closed form its suite asserts against. Pure data
 * builders over the door's wire contract; no kernel internals.
 */

import type {
  DynamicsBuildInput,
  DynamicsControl,
  DynamicsStepResult,
  DynamicsSystem,
} from "./contract";

import { createReferenceDynamicsEngine } from "./engine";

/** Steps once, throwing the structured decline as a test failure. */
export function mustStep(
  system: DynamicsSystem,
  control: DynamicsControl,
): DynamicsStepResult {
  const result = system.step(control);
  if (!result.ok) {
    throw new Error(
      `The reference kernel declined a step: ${result.error.message}`,
    );
  }
  return result.value;
}

/** Builds through the reference engine, throwing declines as failures. */
export function mustBuild(input: DynamicsBuildInput): DynamicsSystem {
  const result = createReferenceDynamicsEngine().build(input);
  if (!result.ok) {
    throw new Error(
      `The reference kernel declined the build: ${result.error.message}`,
    );
  }
  return result.value;
}

/** Standard gravity, m/s² (the Phase 61 default, −Y). */
export const G_STANDARD: readonly [number, number, number] = [0, -9.80665, 0];

const IDENTITY_ROTATION: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

/** A rotation about z by `angle` radians, row-major. */
export function rotZ(angle: number): readonly number[] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

function at(
  occurrenceId: string,
  translationMm: readonly [number, number, number],
  rotation: readonly number[] = IDENTITY_ROTATION,
): {
  id: string;
  placement: {
    rotation: readonly number[];
    translation: readonly [number, number, number];
  };
} {
  return {
    id: occurrenceId,
    placement: { rotation, translation: [...translationMm] },
  };
}

/**
 * The free-fall fixture: ONE 1-kg body at the world origin, gravity on,
 * no joints, ungrounded — the free 6-DOF root under a pure gravity body
 * force. The body is a sphere of radius 30 mm (I = 2/5·m·r², the honest
 * tensor the door's point-mass stance asks for on rotating bodies); the
 * fall stays translation-only (gravity acts at the COG, zero initial
 * spin), so the closed forms are untouched: semi-implicit Euler
 * integrates yₙ = −g·dt²·n(n+1)/2 exactly.
 */
export function freeFallBuild(): DynamicsBuildInput {
  const radius = 0.03;
  const sphereInertia = 0.4 * 1 * radius * radius;
  return {
    occurrences: [at("body", [0, 0, 0])],
    joints: [],
    masses: [
      {
        occurrenceId: "body",
        massGrams: 1000,
        centerOfGravityMm: [0, 0, 0],
        inertiaTensorKgM2: [
          sphereInertia,
          0,
          0,
          0,
          sphereInertia,
          0,
          0,
          0,
          sphereInertia,
        ],
      },
    ],
    gravityMPerS2: G_STANDARD,
  };
}

/**
 * The pendulum fixture: a grounded base at the origin and ONE rod whose
 * COG sits `lengthM` from the pivot on a z-axis revolute — a point-mass
 * pendulum with I = m·L². `theta0` is the initial angle FROM THE
 * HANGING DIRECTION (−Y), placed along the swing; `rates0` the initial
 * angular rate.
 */
export function pendulumBuild(options: {
  readonly lengthM: number;
  readonly massKg: number;
  readonly theta0?: number;
  readonly rates0?: number;
  readonly viscous?: number;
  readonly frictionLoss?: number;
}): DynamicsBuildInput {
  const { lengthM, massKg } = options;
  const theta0 = options.theta0 ?? 0;
  const sin = Math.sin(theta0);
  const cos = Math.cos(theta0);
  const cogMm: readonly [number, number, number] = [
    lengthM * sin * 1000,
    -lengthM * cos * 1000,
    0,
  ];
  return {
    occurrences: [at("base", [0, 0, 0]), at("rod", [0, 0, 0])],
    joints: [
      {
        id: "jnt_pivot",
        name: "Pivot",
        kind: "revolute",
        baseOccurrenceId: "base",
        occurrenceId: "rod",
        frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
        ...(options.viscous === undefined
          ? {}
          : { viscousDampingNPerMSPerRad: options.viscous }),
        ...(options.frictionLoss === undefined
          ? {}
          : { frictionLossNPerM: options.frictionLoss }),
      },
    ],
    masses: [
      { occurrenceId: "base", massGrams: 1000, centerOfGravityMm: [0, 0, 0] },
      {
        occurrenceId: "rod",
        massGrams: massKg * 1000,
        centerOfGravityMm: cogMm,
      },
    ],
    grounded: ["base"],
    gravityMPerS2: G_STANDARD,
    initialJointRates: options.rates0
      ? [{ jointId: "jnt_pivot", rates: [options.rates0] }]
      : undefined,
  };
}

/**
 * The spin-down fixture: a grounded base and one rotor on a z-axis
 * revolute at the rotor's own COG (the rotor's frame origin sits ON the
 * joint axis), with a spin inertia `inertiaKgM2` about z and an initial
 * rate `omega0`. The gravity wrench vanishes (COG on the axis), so the
 * closed forms are the pure friction ODEs.
 */
export function spinDownBuild(options: {
  readonly inertiaKgM2: number;
  readonly omega0: number;
  readonly viscous?: number;
  readonly frictionLoss?: number;
  readonly kind?: "revolute" | "slider";
  readonly massKg?: number;
}): DynamicsBuildInput {
  const inertia = options.inertiaKgM2;
  const mass = (options.massKg ?? 1) * 1000;
  const joint =
    options.kind === "slider"
      ? {
          id: "jnt_slide",
          name: "Slide",
          kind: "slider" as const,
          baseOccurrenceId: "base",
          occurrenceId: "rotor",
          frame: { origin: [0, 0, 0], axis: [1, 0, 0] },
        }
      : {
          id: "jnt_spin",
          name: "Spin",
          kind: "revolute" as const,
          baseOccurrenceId: "base",
          occurrenceId: "rotor",
          frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
        };
  return {
    occurrences: [at("base", [0, 0, 0]), at("rotor", [0, 0, 0])],
    joints: [
      {
        ...joint,
        ...(options.viscous === undefined
          ? {}
          : { viscousDampingNPerMSPerRad: options.viscous }),
        ...(options.frictionLoss === undefined
          ? {}
          : { frictionLossNPerM: options.frictionLoss }),
      },
    ],
    masses: [
      { occurrenceId: "base", massGrams: 1000, centerOfGravityMm: [0, 0, 0] },
      {
        occurrenceId: "rotor",
        massGrams: mass,
        centerOfGravityMm: [0, 0, 0],
        inertiaTensorKgM2:
          options.kind === "slider"
            ? undefined
            : [0, 0, 0, 0, 0, 0, 0, 0, inertia],
      },
    ],
    grounded: ["base"],
    gravityMPerS2: [0, 0, 0],
    initialJointRates: [
      {
        jointId: options.kind === "slider" ? "jnt_slide" : "jnt_spin",
        rates: [options.omega0],
      },
    ],
  };
}

/**
 * The tumbling-body fixture: ONE free body at the world origin with an
 * offset COG and an asymmetric inertia tensor, zero gravity, initial
 * rates on its free joint — linear and angular momentum conservation in
 * the cleanest form (no forces at all).
 */
export function tumblingBuild(rates: readonly number[]): DynamicsBuildInput {
  return {
    occurrences: [at("body", [0, 0, 0])],
    joints: [],
    masses: [
      {
        occurrenceId: "body",
        massGrams: 2000,
        centerOfGravityMm: [30, -10, 20],
        inertiaTensorKgM2: [0.004, 0, 0, 0, 0.003, 0, 0, 0, 0.002],
      },
    ],
    gravityMPerS2: [0, 0, 0],
    initialJointRates: [{ jointId: "body::free", rates: [...rates] }],
  };
}

/**
 * The cylindrical fixture (multi-DOF ground truth): a grounded base and
 * one body on a VERTICAL cylindrical joint (axis +Y) with its COG ON
 * the axis — the two DOFs of one axis decouple exactly: the slide is
 * the pure semi-implicit fall `uₙ = −g·dt²·n(n+1)/2` (with initial rate
 * `u₀`: `uₙ = u₀·dt·n − g·dt²·n(n+1)/2`) and the spin rides at its
 * constant initial rate `ω₀` (torque-free about the axis: the gravity
 * wrench through the on-axis COG has no axial moment, and the
 * single-axis motion subspace kills every bias projection).
 */
export function cylindricalBuild(options: {
  readonly massKg: number;
  readonly spin0: number;
  readonly slide0?: number;
}): DynamicsBuildInput {
  return {
    occurrences: [at("base", [0, 0, 0]), at("body", [0, 0, 0])],
    joints: [
      {
        id: "jnt_cyl",
        name: "Cylinder",
        kind: "cylindrical",
        baseOccurrenceId: "base",
        occurrenceId: "body",
        frame: { origin: [0, 0, 0], axis: [0, 1, 0] },
      },
    ],
    masses: [
      { occurrenceId: "base", massGrams: 1000, centerOfGravityMm: [0, 0, 0] },
      {
        occurrenceId: "body",
        massGrams: options.massKg * 1000,
        centerOfGravityMm: [0, 0, 0],
        inertiaTensorKgM2: [0.002, 0, 0, 0, 0.003, 0, 0, 0, 0.004],
      },
    ],
    grounded: ["base"],
    gravityMPerS2: G_STANDARD,
    initialJointRates: [
      { jointId: "jnt_cyl", rates: [options.spin0, options.slide0 ?? 0] },
    ],
  };
}

/**
 * The planar fixture (multi-DOF ground truth, the moving-origin
 * gauge's cleanest exposure): a grounded base and one body on a
 * HORIZONTAL planar joint (normal z) whose frame origin sits AT the
 * joint anchor with its COG there — gravity drives the in-plane fall
 * while the body spins at its constant rate (no axial torque), and the
 * x-slide rides at its initial velocity `vx0` forever (no in-plane
 * force). The auxiliary basis of ẑ is e₁ = (−1,0,0), e₂ = (0,−1,0), so
 * the initial rates below carry the sign flip; the closed forms are the
 * world trajectory: `xₙ = vx0·dt·n` exactly, `yₙ = −g·dt²·n(n+1)/2`,
 * `θₙ = ω₀·dt·n`, and `p_x = m·vx0` conserved. A body that both spins
 * and slides has ω × v_O ≠ 0 — the spurious `[ω×(h×v_O); m·ω×v_O]` of
 * a wrong moving-origin gauge bends both slides (it grows with the
 * falling v_y), so this fixture fails loudly there.
 */
export function planarBuild(options: {
  readonly massKg: number;
  readonly spin0: number;
  readonly vx0: number;
}): DynamicsBuildInput {
  return {
    occurrences: [at("base", [0, 0, 0]), at("body", [0, 0, 0])],
    joints: [
      {
        id: "jnt_plane",
        name: "Plane",
        kind: "planar",
        baseOccurrenceId: "base",
        occurrenceId: "body",
        frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
      },
    ],
    masses: [
      { occurrenceId: "base", massGrams: 1000, centerOfGravityMm: [0, 0, 0] },
      {
        occurrenceId: "body",
        massGrams: options.massKg * 1000,
        centerOfGravityMm: [0, 0, 0],
        inertiaTensorKgM2: [0.002, 0, 0, 0, 0.003, 0, 0, 0, 0.004],
      },
    ],
    grounded: ["base"],
    gravityMPerS2: G_STANDARD,
    initialJointRates: [
      { jointId: "jnt_plane", rates: [options.spin0, -options.vx0, 0] },
    ],
  };
}

/**
 * The ball fixture (multi-DOF ground truth): a grounded base and one
 * body on a BALL joint at the world origin whose own frame origin
 * hangs 0.1 m off the joint centre (bTranslation ≠ 0), with an offset
 * COG and an asymmetric tensor — torque-free tumbling about a FIXED
 * point. The analytic ground truth is the world angular momentum about
 * the anchor (the constraint wrench acts at the pinned point, zero
 * moment about it): exactly conserved in the continuum, conserved to
 * the integrator's order in the kernel. The body origin ORBITS the
 * anchor (v_O = ω×pb ≠ 0 with h ≠ 0) — the exact moving-origin-gauge
 * territory: the spurious gauge pair appears as dt-independent angular
 * momentum and energy drain.
 */
export function ballSpinBuild(): DynamicsBuildInput {
  return {
    occurrences: [at("base", [0, 0, 0]), at("body", [100, 0, 0])],
    joints: [
      {
        id: "jnt_ball",
        name: "Ball",
        kind: "ball",
        baseOccurrenceId: "base",
        occurrenceId: "body",
        frame: { origin: [0, 0, 0] },
      },
    ],
    masses: [
      { occurrenceId: "base", massGrams: 1000, centerOfGravityMm: [0, 0, 0] },
      {
        occurrenceId: "body",
        massGrams: 2000,
        centerOfGravityMm: [120, -10, 30],
        inertiaTensorKgM2: [0.004, 0, 0, 0, 0.003, 0, 0, 0, 0.002],
      },
    ],
    grounded: ["base"],
    gravityMPerS2: [0, 0, 0],
    initialJointRates: [{ jointId: "jnt_ball", rates: [1.1, -0.6, 0.8] }],
  };
}

/**
 * The motor-vs-drag fixture: a spin rotor (inertia `I`, rotor inertia
 * included when the motor record carries one) on a z revolute with
 * viscous damping `d`, driven by a motor record — the steady state
 * solves T_motor(ω*) = d·ω*; the transient is the first-order ramp.
 */
export function motorDragBuild(options: {
  readonly inertiaKgM2: number;
  readonly viscous: number;
  readonly motor: Record<string, unknown>;
}): DynamicsBuildInput {
  return {
    occurrences: [at("base", [0, 0, 0]), at("rotor", [0, 0, 0])],
    joints: [
      {
        id: "jnt_drive",
        name: "Drive",
        kind: "revolute",
        baseOccurrenceId: "base",
        occurrenceId: "rotor",
        frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
        viscousDampingNPerMSPerRad: options.viscous,
      },
    ],
    masses: [
      { occurrenceId: "base", massGrams: 1000, centerOfGravityMm: [0, 0, 0] },
      {
        occurrenceId: "rotor",
        massGrams: 1000,
        centerOfGravityMm: [0, 0, 0],
        inertiaTensorKgM2: [0, 0, 0, 0, 0, 0, 0, 0, options.inertiaKgM2],
      },
    ],
    grounded: ["base"],
    gravityMPerS2: [0, 0, 0],
    motors: [{ jointId: "jnt_drive", motor: options.motor }],
  };
}

/**
 * The slider-crank fixture (Phase 67c's engine-kinematics demo twin):
 * the classic single-cylinder mechanism as WIRE-FORM joint records — a
 * grounded `frame`, a `crank` on a z revolute at the origin, a
 * connecting `rod` on a z revolute at the crank pin, and a `piston` on
 * an x SLIDER along the crank's centreline — with the WRIST PIN
 * (rod↔piston revolute) CLOSING THE LOOP (the four-bar fixture's
 * discipline: the piston already has its tree parent, the pin is the
 * loop joint). Planar 1-DOF by Grübler; the closed-form kinematics the
 * suite asserts: at crank angle θ the piston sits at
 * `x_p(θ) = r·cosθ + √(l² − r²·sin²θ)`, so the slide DOF reads
 * `s(θ) = x_p(θ) − (r + l)` (negative semicycle — the piston only
 * comes back toward the crank).
 *
 * The initial pose (θ = 0: crank pin at (r, 0), rod along +x, piston
 * at (r + l, 0)) is exactly closed, so the build needs no projection.
 */
export function sliderCrankBuild(options: {
  readonly crankRadiusM: number;
  readonly rodLengthM: number;
  readonly crankMassKg: number;
  readonly rodMassKg: number;
  readonly pistonMassKg: number;
  readonly motor?: Record<string, unknown>;
  readonly viscous?: number;
  readonly frictionLoss?: number;
}): DynamicsBuildInput {
  const r = options.crankRadiusM;
  const l = options.rodLengthM;
  const mm = 1000;
  const friction = {
    ...(options.viscous === undefined
      ? {}
      : { viscousDampingNPerMSPerRad: options.viscous }),
    ...(options.frictionLoss === undefined
      ? {}
      : { frictionLossNPerM: options.frictionLoss }),
  };
  // Slender-rod inertias about each link's own COG, kg·m²: I = m·L²/12
  // on the bending axes and the polar axis alike (the isotropic rod —
  // the honest hand-solvable tensor for planar rotation about z).
  const crankInertia =
    (options.crankMassKg * r * r) / 12 + options.crankMassKg * (r / 2) ** 2;
  const rodInertia =
    (options.rodMassKg * l * l) / 12 + options.rodMassKg * (l / 2) ** 2;
  const pistonInertia = (options.pistonMassKg * (0.02 * 0.02)) / 12;
  return {
    occurrences: [
      at("frame", [0, 0, 0]),
      at("crank", [0, 0, 0]),
      at("rod", [r * mm, 0, 0]),
      at("piston", [(r + l) * mm, 0, 0]),
    ],
    joints: [
      {
        id: "jnt_crank",
        name: "Crank main bearing",
        kind: "revolute",
        baseOccurrenceId: "frame",
        occurrenceId: "crank",
        frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
        ...friction,
      },
      {
        id: "jnt_conrod",
        name: "Crank pin",
        kind: "revolute",
        baseOccurrenceId: "crank",
        occurrenceId: "rod",
        frame: { origin: [r * mm, 0, 0], axis: [0, 0, 1] },
        ...friction,
      },
      {
        id: "jnt_slide",
        name: "Piston line",
        kind: "slider",
        baseOccurrenceId: "frame",
        occurrenceId: "piston",
        frame: { origin: [(r + l) * mm, 0, 0], axis: [1, 0, 0] },
      },
      {
        id: "jnt_wrist",
        name: "Wrist pin",
        kind: "revolute",
        baseOccurrenceId: "rod",
        occurrenceId: "piston",
        // No friction fields: this joint CLOSES THE LOOP, and the
        // kernel declines friction on a closing joint loudly (the
        // stated posture — never silently dropped); the wrist pin's
        // dissipation is outside the tree-joint cone vocabulary.
        frame: { origin: [l * mm, 0, 0], axis: [0, 0, 1] },
      },
    ],
    masses: [
      { occurrenceId: "frame", massGrams: 1000, centerOfGravityMm: [0, 0, 0] },
      {
        occurrenceId: "crank",
        massGrams: options.crankMassKg * 1000,
        centerOfGravityMm: [(r / 2) * mm, 0, 0],
        inertiaTensorKgM2: [
          crankInertia,
          0,
          0,
          0,
          crankInertia,
          0,
          0,
          0,
          crankInertia,
        ],
      },
      {
        occurrenceId: "rod",
        massGrams: options.rodMassKg * 1000,
        centerOfGravityMm: [(r + l / 2) * mm, 0, 0],
        inertiaTensorKgM2: [
          rodInertia,
          0,
          0,
          0,
          rodInertia,
          0,
          0,
          0,
          rodInertia,
        ],
      },
      {
        occurrenceId: "piston",
        massGrams: options.pistonMassKg * 1000,
        centerOfGravityMm: [(r + l) * mm, 0, 0],
        inertiaTensorKgM2: [
          pistonInertia,
          0,
          0,
          0,
          pistonInertia,
          0,
          0,
          0,
          pistonInertia,
        ],
      },
    ],
    grounded: ["frame"],
    gravityMPerS2: G_STANDARD,
    ...(options.motor === undefined
      ? {}
      : { motors: [{ jointId: "jnt_crank", motor: options.motor }] }),
  };
}

/**
 * The closed-form piston slide at crank angle θ, m (the kinematic
 * ground truth the slider-crank suite asserts):
 * `s(θ) = r·cosθ + √(l² − r²·sin²θ) − (r + l)`.
 */
export function sliderCrankPistonSlideM(
  crankRadiusM: number,
  rodLengthM: number,
  crankAngleRad: number,
): number {
  const r = crankRadiusM;
  const l = rodLengthM;
  const sin = Math.sin(crankAngleRad);
  const cos = Math.cos(crankAngleRad);
  return r * cos + Math.sqrt(Math.max(0, l * l - r * r * sin * sin)) - (r + l);
}

/**
 * The demo motor record (Phase 67c): a DC brushed motor whose line
 * drives the slider-crank's crank at demo-friendly speeds — the SAME
 * abstraction the Phase 66 fan record rides (one motor vocabulary
 * across the domains).
 */
export const SLIDER_CRANK_MOTOR: Record<string, unknown> = {
  id: "mtr_crank",
  name: "Crank motor",
  kind: "dc-brushed",
  stallTorqueMNm: 80,
  noLoadSpeedRpm: 1500,
  nominalVoltageV: 12,
  rotorInertiaKgM2: 0.0004,
};

/**
 * The four-bar loop fixture (Phase 67a's closed-loop ground truth): a
 * grounded `frame`, crank `linkA` at pivot 1, coupler `linkB` from the
 * crank tip, a rigidly-welded `pinE` at the coupler's outboard end, and
 * rocker `linkC` at pivot 2 — the pinE↔linkC revolute CLOSES THE LOOP
 * (pinE already has its tree parent). Classic dimensions: pivots 0.18 m
 * apart, crank and rocker 0.1 m, coupler 0.12 m; link frames sit at
 * their INBOARD pivots; every link is a point mass at its outboard end;
 * the initial pose is the closed configuration above pivot line (the
 * hand-solved circle intersection), so the build needs no projection.
 * Planar 1-DOF by Grübler; the suite asserts the loop residual stays
 * under the closure tolerance through a gravity swing.
 */
export function fourBarBuild(): DynamicsBuildInput {
  const pivot2X = 0.18;
  const crank = 0.1;
  const coupler = 0.12;
  const rocker = 0.1;
  // Circle intersection: |E − T| = coupler, |E − P2| = rocker, with the
  // crank at θ₁ = 0 (T = (crank, 0), both pivots on X).
  const dx = pivot2X - crank;
  const a = (dx * dx + coupler * coupler - rocker * rocker) / (2 * dx);
  const h = Math.sqrt(coupler * coupler - a * a);
  const tipX = crank + a;
  const tipY = h;
  const mm = 1000;
  return {
    occurrences: [
      at("frame", [0, 0, 0]),
      at("linkA", [0, 0, 0]),
      at("linkB", [crank * mm, 0, 0], rotZ(Math.atan2(tipY, a))),
      at("pinE", [tipX * mm, tipY * mm, 0]),
      at("linkC", [pivot2X * mm, 0, 0], rotZ(Math.atan2(tipY, tipX - pivot2X))),
    ],
    joints: [
      {
        id: "jnt_crank",
        name: "Crank pivot",
        kind: "revolute",
        baseOccurrenceId: "frame",
        occurrenceId: "linkA",
        frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
      },
      {
        id: "jnt_coupler",
        name: "Coupler pivot",
        kind: "revolute",
        baseOccurrenceId: "linkA",
        occurrenceId: "linkB",
        frame: { origin: [crank * mm, 0, 0], axis: [0, 0, 1] },
      },
      {
        id: "jnt_weld",
        name: "Coupler pin",
        kind: "rigid",
        baseOccurrenceId: "linkB",
        occurrenceId: "pinE",
      },
      {
        id: "jnt_rocker",
        name: "Rocker pivot",
        kind: "revolute",
        baseOccurrenceId: "frame",
        occurrenceId: "linkC",
        frame: { origin: [pivot2X * mm, 0, 0], axis: [0, 0, 1] },
      },
      {
        id: "jnt_loop",
        name: "Closing pin",
        kind: "revolute",
        baseOccurrenceId: "linkC",
        occurrenceId: "pinE",
        frame: { origin: [rocker * mm, 0, 0], axis: [0, 0, 1] },
      },
    ],
    masses: [
      { occurrenceId: "frame", massGrams: 1000, centerOfGravityMm: [0, 0, 0] },
      {
        occurrenceId: "linkA",
        massGrams: 200,
        centerOfGravityMm: [crank * mm, 0, 0],
      },
      {
        occurrenceId: "linkB",
        massGrams: 300,
        centerOfGravityMm: [tipX * mm, tipY * mm, 0],
      },
      {
        occurrenceId: "pinE",
        massGrams: 50,
        centerOfGravityMm: [tipX * mm, tipY * mm, 0],
      },
      {
        occurrenceId: "linkC",
        massGrams: 200,
        centerOfGravityMm: [tipX * mm, tipY * mm, 0],
      },
    ],
    grounded: ["frame"],
    gravityMPerS2: G_STANDARD,
  };
}
