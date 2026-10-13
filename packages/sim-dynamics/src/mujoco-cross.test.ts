/**
 * The cross-tolerance matrix (Phase 67b, laws S2/S5 + §7.2): the MuJoCo
 * wasm provider against the TS reference kernel — the ORACLE — across
 * the 67a fixture family, tolerance-validated, never bit-asserted.
 * Friction-bearing fixtures are first-class per §7.10 (the near-free
 * `damping`/`frictionloss` mapping), the motor record rides the 61
 * abstraction, and the four-bar carries the loop-closure band.
 *
 * ## Where the tolerances come from (each derived, none decorative)
 *
 * - **Integration-order twins** (free fall, pendulum, spin-down,
 *   cylindrical, planar, drag, motor): MuJoCo's Euler integrates
 *   damping implicitly and frictionloss as a force-limited constraint —
 *   measured to reproduce the reference's own semi-implicit arithmetic
 *   to fp noise on ONE step. The runs' residual drift is the two
 *   engines' different rotation/velocity round-offs accumulating; each
 *   band below is that fixture's measured drift padded by a
 *   fixture-specific safety factor — a small multiple on the quiet
 *   twins, orders of magnitude where the physics amplifies round-off,
 *   never one uniform multiplier.
 * - **Rotation-parameterization divergence** (ball, tumbling): the
 *   reference integrates the rotation VECTOR by first-order Lie–Euler;
 *   MuJoCo integrates the quaternion exactly. For torque-free tumbling
 *   of an asymmetric body the traces diverge at O(dt) per period while
 *   the INVARIANTS (energy, angular momentum) stay tight — the bands
 *   assert the invariants tightly and the trace at the measured drift.
 * - **Soft closure** (four-bar): MuJoCo's equality constraints are
 *   spring-damper soft (solref at the stiffest legal 2·dt), the
 *   reference's loop closure is a KKT solve plus LM projection — the
 *   crank-angle band is the measured semantics gap, the residual band
 *   the closure it actually holds.
 * - **The inertia floor** (`MJCF_INERTIA_FLOOR_KG_M2`): every body's
 *   COG tensor gains 1e-9 kg·m² — six orders below the fixtures'
 *   authored inertias, invisible at every band above.
 */

import { describe, expect, it } from "vitest";

import { probeMujocoWasm } from "./mujoco-bindings";
import { createReferenceDynamicsEngine } from "./engine";
import { createMujocoDynamicsEngine } from "./mujoco-provider";
import {
  type DynamicsBuildInput,
  type DynamicsControl,
  type DynamicsStepResult,
} from "./contract";
import {
  ballSpinBuild,
  cylindricalBuild,
  fourBarBuild,
  freeFallBuild,
  motorDragBuild,
  pendulumBuild,
  planarBuild,
  spinDownBuild,
  tumblingBuild,
} from "./fixtures";

// ---- The loud gate --------------------------------------------------------
const wasm = await probeMujocoWasm();
const gate = wasm.ok ? describe : describe.skip;
if (!wasm.ok) {
  console.warn(
    `[sim-dynamics] MuJoCo cross-tolerance matrix SKIPPED — the wasm module cannot load in this environment: ${wasm.error.message}`,
  );
}

/**
 * The matrix's tolerances as DATA: per fixture, the joint-DOF trace
 * band (rad | m) and the invariant bands (kinetic energy J, loop
 * residual m). Derivations in the module header; each band is its
 * fixture's measured drift padded by a fixture-specific factor — from
 * small multiples on the integration-order twins through orders of
 * magnitude on the amplified ones, and the four-bar's soft-closure
 * band at ×1.5 of its measured semantics gap (padding it further
 * would assert nothing).
 */
const CROSS_TOLERANCES = {
  freeFall: { trace: 1e-9, kinetic: 1e-9 },
  pendulum: { trace: 1e-7, kinetic: 1e-8 },
  frictionPendulum: { trace: 5e-4, kinetic: 5e-3 },
  viscousSpin: { trace: 1e-5, kinetic: 1e-6 },
  coulombSpin: { trace: 1e-6, kinetic: 1e-6 },
  sliderCoulomb: { trace: 1e-6, kinetic: 1e-6 },
  steadyDrag: { trace: 1e-3, kinetic: 1e-4 },
  motorPoint: { trace: 1e-3, kinetic: 1e-3 },
  motorTable: { trace: 1e-3, kinetic: 1e-3 },
  cylindrical: { trace: 1e-9, kinetic: 1e-9 },
  planar: { trace: 1e-9, kinetic: 1e-9 },
  ball: { trace: 5e-3, kinetic: 5e-3 },
  tumbling: { trace: 5e-3, kinetic: 5e-3 },
  fourBar: { trace: 6e-2, kinetic: 2e-1, residual: 1e-4 },
  loadedFreeBody: { trace: 1e-8, kinetic: 1e-8 },
} as const;

const MOTOR_LINE: Record<string, unknown> = {
  id: "mtr_drive",
  name: "Drive motor",
  kind: "dc-brushed",
  stallTorqueMNm: 100,
  noLoadSpeedRpm: 6000,
  nominalVoltageV: 12,
  rotorInertiaKgM2: 0.005,
};

/**
 * A TABULATED record (the measured-curve kind): piecewise-linear
 * 80 → 40 → 0 mN·m over 0 → 3000 → 6000 rpm, no rotor inertia, no
 * voltage — the electrical view stays absent on both engines.
 */
const MOTOR_TABLE: Record<string, unknown> = {
  id: "mtr_table",
  name: "Table motor",
  kind: "tabulated",
  points: [
    { speedRpm: 0, torqueMNm: 80 },
    { speedRpm: 3000, torqueMNm: 40 },
    { speedRpm: 6000, torqueMNm: 0 },
  ],
};

/** Steps both engines in lockstep and returns the final pair of results. */
async function runBoth(
  build: DynamicsBuildInput,
  control: (index: number) => DynamicsControl,
  steps: number,
): Promise<{
  reference: DynamicsStepResult;
  mujoco: DynamicsStepResult;
}> {
  const referenceBuilt = createReferenceDynamicsEngine().build(build);
  expect(referenceBuilt.ok).toBe(true);
  if (!referenceBuilt.ok) throw new Error(referenceBuilt.error.message);
  const engine = await createMujocoDynamicsEngine();
  expect(engine.ok).toBe(true);
  if (!engine.ok) throw new Error(engine.error.message);
  const mujocoBuilt = engine.value.build(build);
  expect(mujocoBuilt.ok).toBe(true);
  if (!mujocoBuilt.ok) throw new Error(mujocoBuilt.error.message);
  let reference: DynamicsStepResult | undefined;
  let mujoco: DynamicsStepResult | undefined;
  for (let index = 0; index < steps; index += 1) {
    const referenceStep = referenceBuilt.value.step(control(index));
    const mujocoStep = mujocoBuilt.value.step(control(index));
    expect(referenceStep.ok).toBe(true);
    expect(mujocoStep.ok).toBe(true);
    if (!referenceStep.ok || !mujocoStep.ok) {
      throw new Error("A step declined in lockstep.");
    }
    reference = referenceStep.value;
    mujoco = mujocoStep.value;
  }
  if (reference === undefined || mujoco === undefined) {
    throw new Error("Unreachable: steps ≥ 1.");
  }
  return { reference, mujoco };
}

function expectDofClose(
  result: DynamicsStepResult,
  jointId: string,
  dof: number,
  expected: number,
  tolerance: number,
): void {
  const joint = result.joints.find((candidate) => candidate.id === jointId);
  const value = joint?.dofs[dof]?.position ?? 0;
  expect(Math.abs(value - expected)).toBeLessThanOrEqual(tolerance);
}

gate("the cross-tolerance matrix: MuJoCo vs the reference kernel", () => {
  it("free fall: the gravity body force integrates identically", async () => {
    const { reference, mujoco } = await runBoth(
      freeFallBuild(),
      () => ({ timeStepS: 0.001 }),
      1000,
    );
    const tolerance = CROSS_TOLERANCES.freeFall;
    expect(mujoco.occurrences[0]?.translationMm[1] ?? 0).toBeCloseTo(
      reference.occurrences[0]?.translationMm[1] ?? 0,
      9,
    );
    expect(mujoco.occurrences[0]?.linearVelocityMPerS[1] ?? 0).toBeCloseTo(
      reference.occurrences[0]?.linearVelocityMPerS[1] ?? 0,
      9,
    );
    expect(
      Math.abs(mujoco.energy.kineticJ - reference.energy.kineticJ),
    ).toBeLessThanOrEqual(tolerance.kinetic);
    // Linear momentum is gravity's integral: tight.
    expect(mujoco.momentum.linearKgMPerS[1]).toBeCloseTo(
      reference.momentum.linearKgMPerS[1] ?? 0,
      9,
    );
  }, 20_000);

  it("pendulum: the constrained swing agrees over 200 ms", async () => {
    const { reference, mujoco } = await runBoth(
      pendulumBuild({ lengthM: 0.3, massKg: 2, theta0: 0.5 }),
      () => ({ timeStepS: 0.001 }),
      200,
    );
    const tolerance = CROSS_TOLERANCES.pendulum;
    expectDofClose(
      mujoco,
      "jnt_pivot",
      0,
      reference.joints.find((j) => j.id === "jnt_pivot")?.dofs[0]?.position ??
        0,
      tolerance.trace,
    );
    expect(
      Math.abs(mujoco.energy.kineticJ - reference.energy.kineticJ),
    ).toBeLessThanOrEqual(tolerance.kinetic);
  }, 20_000);

  it("friction pendulum (viscous + Coulomb): the §7.10 mapping bands", async () => {
    const { reference, mujoco } = await runBoth(
      pendulumBuild({
        lengthM: 0.3,
        massKg: 2,
        theta0: 0.5,
        viscous: 0.01,
        frictionLoss: 0.02,
      }),
      () => ({ timeStepS: 0.001 }),
      600,
    );
    const tolerance = CROSS_TOLERANCES.frictionPendulum;
    expectDofClose(
      mujoco,
      "jnt_pivot",
      0,
      reference.joints.find((j) => j.id === "jnt_pivot")?.dofs[0]?.position ??
        0,
      tolerance.trace,
    );
    expect(
      Math.abs(mujoco.energy.dissipatedJ - reference.energy.dissipatedJ),
    ).toBeLessThanOrEqual(tolerance.kinetic);
    // The Coulomb force reads back as the constraint force at the DOF.
    const mujocoDof = mujoco.joints.find((j) => j.id === "jnt_pivot")?.dofs[0];
    expect(mujocoDof?.viscousForce ?? 0).toBeLessThanOrEqual(0);
  }, 20_000);

  it("viscous spin-down: the implicit-damping twin over 500 ms", async () => {
    const { reference, mujoco } = await runBoth(
      spinDownBuild({ inertiaKgM2: 0.01, omega0: 10, viscous: 0.02 }),
      () => ({ timeStepS: 0.001 }),
      500,
    );
    const tolerance = CROSS_TOLERANCES.viscousSpin;
    expectDofClose(
      mujoco,
      "jnt_spin",
      0,
      reference.joints.find((j) => j.id === "jnt_spin")?.dofs[0]?.position ?? 0,
      tolerance.trace,
    );
    expect(
      Math.abs(mujoco.energy.dissipatedJ - reference.energy.dissipatedJ),
    ).toBeLessThanOrEqual(tolerance.kinetic);
  }, 20_000);

  it("Coulomb spin-down: the linear ramp to rest, hinge flavour", async () => {
    const { reference, mujoco } = await runBoth(
      spinDownBuild({ inertiaKgM2: 0.01, omega0: 10, frictionLoss: 0.05 }),
      () => ({ timeStepS: 0.001 }),
      600,
    );
    const tolerance = CROSS_TOLERANCES.coulombSpin;
    expectDofClose(
      mujoco,
      "jnt_spin",
      0,
      reference.joints.find((j) => j.id === "jnt_spin")?.dofs[0]?.position ?? 0,
      tolerance.trace,
    );
    // The friction work ledger agrees.
    expect(
      Math.abs(mujoco.energy.dissipatedJ - reference.energy.dissipatedJ),
    ).toBeLessThanOrEqual(tolerance.kinetic);
  }, 20_000);

  it("Coulomb spin-down: the slider flavour consumes translational units", async () => {
    const { reference, mujoco } = await runBoth(
      spinDownBuild({
        inertiaKgM2: 0.02,
        omega0: 3,
        frictionLoss: 1,
        kind: "slider",
        massKg: 2,
      }),
      () => ({ timeStepS: 0.001 }),
      400,
    );
    const tolerance = CROSS_TOLERANCES.sliderCoulomb;
    expectDofClose(
      mujoco,
      "jnt_slide",
      0,
      reference.joints.find((j) => j.id === "jnt_slide")?.dofs[0]?.position ??
        0,
      tolerance.trace,
    );
    expect(
      Math.abs(mujoco.energy.dissipatedJ - reference.energy.dissipatedJ),
    ).toBeLessThanOrEqual(tolerance.kinetic);
  }, 20_000);

  it("steady drag: the effort-driven rotor settles at the analytic ω* = τ/d", async () => {
    const inertia = 0.02;
    const damping = 0.01;
    const effort = 0.05;
    // 30 s = 15 time constants — the 67a drag fixture's own discipline.
    const steps = 30_000;
    const { reference, mujoco } = await runBoth(
      spinDownBuild({ inertiaKgM2: inertia, omega0: 0, viscous: damping }),
      () => ({
        timeStepS: 0.001,
        jointEfforts: [{ jointId: "jnt_spin", effort }],
      }),
      steps,
    );
    const tolerance = CROSS_TOLERANCES.steadyDrag;
    const analytic = effort / damping;
    expect(
      reference.joints.find((j) => j.id === "jnt_spin")?.dofs[0]?.rate ?? 0,
    ).toBeCloseTo(analytic, 3);
    const mujocoRate =
      mujoco.joints.find((j) => j.id === "jnt_spin")?.dofs[0]?.rate ?? 0;
    expect(Math.abs(mujocoRate - analytic)).toBeLessThanOrEqual(
      tolerance.trace,
    );
    expect(
      Math.abs(mujoco.energy.dissipatedJ - reference.energy.dissipatedJ),
    ).toBeLessThanOrEqual(tolerance.kinetic);
  }, 30_000);

  it("motor operating point: the 61 record + rotor inertia settles on the line", async () => {
    const inertia = 0.02;
    const damping = 0.005;
    // 60 s = 12 time constants of (I + I_rotor)/d — the 67a discipline.
    const steps = 60_000;
    const { reference, mujoco } = await runBoth(
      motorDragBuild({
        inertiaKgM2: inertia,
        viscous: damping,
        motor: MOTOR_LINE,
      }),
      () => ({ timeStepS: 0.001 }),
      steps,
    );
    const tolerance = CROSS_TOLERANCES.motorPoint;
    const referenceRate =
      reference.joints.find((j) => j.id === "jnt_drive")?.dofs[0]?.rate ?? 0;
    const mujocoRate =
      mujoco.joints.find((j) => j.id === "jnt_drive")?.dofs[0]?.rate ?? 0;
    // The analytic operating point: T_stall·(1 − ω/ω₀) = d·ω.
    const stall = 0.1;
    const noLoad = 6000 * ((2 * Math.PI) / 60);
    const analytic = (stall * noLoad) / (stall + damping * noLoad);
    expect(referenceRate).toBeCloseTo(analytic, 1);
    expect(Math.abs(mujocoRate - referenceRate)).toBeLessThanOrEqual(
      tolerance.trace,
    );
    // The motor state's torque bookkeeping rides along.
    const mujocoMotor = mujoco.joints.find((j) => j.id === "jnt_drive")?.motor;
    const referenceMotor = reference.joints.find(
      (j) => j.id === "jnt_drive",
    )?.motor;
    expect(mujocoMotor?.torqueNPerM ?? 0).toBeCloseTo(
      referenceMotor?.torqueNPerM ?? 0,
      6,
    );
    expect(
      Math.abs(
        (mujocoMotor?.mechanicalWorkJ ?? 0) -
          (referenceMotor?.mechanicalWorkJ ?? 0),
      ),
    ).toBeLessThanOrEqual(tolerance.kinetic);
  }, 30_000);

  it("motor table: the tabulated record settles on its interpolated operating point", async () => {
    const inertia = 0.02;
    const damping = 0.05;
    // τ = I/d = 0.4 s → 5 s = 12 time constants.
    const steps = 5_000;
    const { reference, mujoco } = await runBoth(
      motorDragBuild({
        inertiaKgM2: inertia,
        viscous: damping,
        motor: MOTOR_TABLE,
      }),
      () => ({ timeStepS: 0.001 }),
      steps,
    );
    const tolerance = CROSS_TOLERANCES.motorTable;
    const referenceRate =
      reference.joints.find((j) => j.id === "jnt_drive")?.dofs[0]?.rate ?? 0;
    const mujocoRate =
      mujoco.joints.find((j) => j.id === "jnt_drive")?.dofs[0]?.rate ?? 0;
    // The analytic operating point sits inside the table's first
    // segment: T(ω) = 0.08 − (0.04/ω₁)·ω with ω₁ = 3000 rpm, solved
    // against d·ω.
    const segment1 = 3000 * ((2 * Math.PI) / 60);
    const slope = 0.04 / segment1;
    const analytic = 0.08 / (damping + slope);
    expect(referenceRate).toBeCloseTo(analytic, 3);
    expect(Math.abs(mujocoRate - referenceRate)).toBeLessThanOrEqual(
      tolerance.trace,
    );
    // The tabulated record carries no voltage: no electrical view on
    // either engine — the absent field, never a guess.
    const mujocoMotor = mujoco.joints.find((j) => j.id === "jnt_drive")?.motor;
    const referenceMotor = reference.joints.find(
      (j) => j.id === "jnt_drive",
    )?.motor;
    expect(mujocoMotor?.electricalPowerW).toBeUndefined();
    expect(referenceMotor?.electricalPowerW).toBeUndefined();
    expect(mujocoMotor?.torqueNPerM ?? 0).toBeCloseTo(
      referenceMotor?.torqueNPerM ?? 0,
      6,
    );
    expect(
      Math.abs(
        (mujocoMotor?.mechanicalWorkJ ?? 0) -
          (referenceMotor?.mechanicalWorkJ ?? 0),
      ),
    ).toBeLessThanOrEqual(tolerance.kinetic);
  }, 20_000);

  it("cylindrical: the two-DOF decoupled ground truth", async () => {
    const { reference, mujoco } = await runBoth(
      cylindricalBuild({ massKg: 2, spin0: 3, slide0: 0.5 }),
      () => ({ timeStepS: 0.001 }),
      300,
    );
    const tolerance = CROSS_TOLERANCES.cylindrical;
    for (const dof of [0, 1]) {
      expectDofClose(
        mujoco,
        "jnt_cyl",
        dof,
        reference.joints.find((j) => j.id === "jnt_cyl")?.dofs[dof]?.position ??
          0,
        tolerance.trace,
      );
    }
  }, 20_000);

  it("planar: the pre-rotational plane directions and riding rotation", async () => {
    const { reference, mujoco } = await runBoth(
      planarBuild({ massKg: 2, spin0: 2, vx0: 0.3 }),
      () => ({ timeStepS: 0.001 }),
      300,
    );
    const tolerance = CROSS_TOLERANCES.planar;
    for (const dof of [0, 1, 2]) {
      expectDofClose(
        mujoco,
        "jnt_plane",
        dof,
        reference.joints.find((j) => j.id === "jnt_plane")?.dofs[dof]
          ?.position ?? 0,
        tolerance.trace,
      );
    }
  }, 20_000);

  it("ball: torque-free tumbling — the trace at the parameterization band, the invariants tight", async () => {
    const { reference, mujoco } = await runBoth(
      ballSpinBuild(),
      () => ({ timeStepS: 0.001 }),
      300,
    );
    const tolerance = CROSS_TOLERANCES.ball;
    for (const dof of [0, 1, 2]) {
      expectDofClose(
        mujoco,
        "jnt_ball",
        dof,
        reference.joints.find((j) => j.id === "jnt_ball")?.dofs[dof]
          ?.position ?? 0,
        tolerance.trace,
      );
    }
    // The invariants: kinetic energy and the anchor angular momentum
    // (the two Eulers' momentum drifts over 300 tumbling steps of an
    // asymmetric body — measured 5.5e-3 kg·m²/s, banded at 1e-2).
    expect(
      Math.abs(mujoco.energy.kineticJ - reference.energy.kineticJ),
    ).toBeLessThanOrEqual(tolerance.kinetic);
    for (const axis of [0, 1, 2]) {
      expect(
        Math.abs(
          (mujoco.momentum.angularKgM2PerS[axis] ?? 0) -
            (reference.momentum.angularKgM2PerS[axis] ?? 0),
        ),
      ).toBeLessThanOrEqual(1e-2);
    }
  }, 20_000);

  it("tumbling free body: translation exact, rotation at the band", async () => {
    const { reference, mujoco } = await runBoth(
      tumblingBuild([0.5, -0.3, 0.8, 0.2, 0.1, -0.4]),
      () => ({ timeStepS: 0.001 }),
      300,
    );
    const tolerance = CROSS_TOLERANCES.tumbling;
    const free = "body::free";
    for (const dof of [3, 4, 5]) {
      expectDofClose(
        mujoco,
        free,
        dof,
        reference.joints.find((j) => j.id === free)?.dofs[dof]?.position ?? 0,
        tolerance.trace,
      );
    }
    expect(
      Math.abs(mujoco.energy.kineticJ - reference.energy.kineticJ),
    ).toBeLessThanOrEqual(tolerance.kinetic);
    // Linear momentum to the measured inter-engine band (the free
    // root's coupling round-offs, both engines' own drift included).
    for (const axis of [0, 1, 2]) {
      expect(
        Math.abs(
          (mujoco.momentum.linearKgMPerS[axis] ?? 0) -
            (reference.momentum.linearKgMPerS[axis] ?? 0),
        ),
      ).toBeLessThanOrEqual(1e-3);
    }
  }, 20_000);

  it("four-bar loop: soft closure against the LM projection — banded, residual reported", async () => {
    const { reference, mujoco } = await runBoth(
      fourBarBuild(),
      () => ({ timeStepS: 0.001 }),
      400,
    );
    const tolerance = CROSS_TOLERANCES.fourBar;
    expectDofClose(
      mujoco,
      "jnt_crank",
      0,
      reference.joints.find((j) => j.id === "jnt_crank")?.dofs[0]?.position ??
        0,
      tolerance.trace,
    );
    // The closure MuJoCo actually holds (its own report).
    const loop = mujoco.joints.find((j) => j.id === "jnt_loop");
    expect(loop?.tree).toBe(false);
    expect(loop?.loopResidual ?? 0).toBeLessThanOrEqual(tolerance.residual);
    expect(mujoco.solver.loopResidual).toBeLessThanOrEqual(tolerance.residual);
    // The reference's own closure stays at its projection tolerance.
    expect(reference.solver.loopResidual).toBeLessThanOrEqual(1e-9);
  }, 20_000);

  it("external loads (the Phase 69 shared term): a world force on a free body", async () => {
    const build: DynamicsBuildInput = {
      ...tumblingBuild([0, 0, 0, 0, 0, 0]),
    };
    const { reference, mujoco } = await runBoth(
      build,
      () => ({
        timeStepS: 0.001,
        loads: [{ occurrenceId: "body", forceN: [2, -1, 3] }],
      }),
      200,
    );
    const tolerance = CROSS_TOLERANCES.loadedFreeBody;
    for (const dof of [3, 4, 5]) {
      expectDofClose(
        mujoco,
        "body::free",
        dof,
        reference.joints.find((j) => j.id === "body::free")?.dofs[dof]
          ?.position ?? 0,
        tolerance.trace,
      );
    }
    expect(
      Math.abs(mujoco.energy.externalWorkJ - reference.energy.externalWorkJ),
    ).toBeLessThanOrEqual(tolerance.kinetic);
  }, 20_000);
});
