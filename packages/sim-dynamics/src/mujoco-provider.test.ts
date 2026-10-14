/**
 * The MuJoCo provider's runtime pins (Phase 67b): the wasm-backed
 * mapping — FK stations of every joint kind against the mates' chain
 * composition, the state round-trip's identity, run-to-run determinism
 * (what MuJoCo's own posture allows, stated), the engine-factory seam,
 * and the build's parity declines. Gated on the wasm loading in THIS
 * environment: a failure SKIPS LOUDLY with the reason printed — never
 * silently, and never a silent fallback to the reference.
 */

import { describe, expect, it } from "vitest";
import type { DynamicsBuildInput } from "./contract";

import { probeMujocoWasm } from "./mujoco-bindings";
import { DEFAULT_DYNAMICS_ENGINE, createDynamicsEngine } from "./engine-select";
import { DYNAMICS_REFERENCE_ENGINE_ID } from "./engine";
import {
  DYNAMICS_MUJOCO_ENGINE_ID,
  type MujocoProbeOutcome,
  createMujocoDynamicsEngine,
  probeMujocoState,
} from "./mujoco-provider";
import { compileMechanism } from "./door";
import { jointFreeRotation, jointFreeTranslation } from "./joints";
import {
  type Mat3,
  add3,
  mulMat3,
  mulMat3Vec,
  sub3,
  transposeMat3,
} from "./spatial";

// ---- The loud gate --------------------------------------------------------
const wasm = await probeMujocoWasm();
const gate = wasm.ok ? describe : describe.skip;
if (!wasm.ok) {
  console.warn(
    `[sim-dynamics] MuJoCo provider tests SKIPPED — the wasm module cannot load in this environment: ${wasm.error.message}`,
  );
}

// ---------------------------------------------------------------------------
// The FK oracle: the mates' chain W_base ∘ T(o) ∘ Free(q) ∘ B, from the
// door's own compiled values — the mapping's per-kind ground truth.
// ---------------------------------------------------------------------------

function chainPose(
  input: DynamicsBuildInput,
  jointId: string,
  q: readonly number[],
  childId: string,
): { rotation: Mat3; translationMm: [number, number, number] } {
  const compiled = compileMechanism(input);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error(compiled.error.message);
  const mechanism = compiled.value;
  const child = mechanism.bodies.find((b) => b.id === childId);
  const wire = mechanism.joints.find((j) => j.id === jointId);
  if (child === undefined || wire === undefined) {
    throw new Error("Unreachable: the fixture names its bodies and joints.");
  }
  const base = mechanism.bodies.find((b) => b.id === wire.baseId);
  if (base === undefined) {
    throw new Error("Unreachable: the door validated the endpoints.");
  }
  const layout = wire.layout;
  const freeRotation = jointFreeRotation(layout, q);
  const freeTranslation = jointFreeTranslation(layout, q);
  const origin = wire.origin ?? [0, 0, 0];
  // B = T(−o) ∘ W_child(0) in base-local coordinates.
  const toBaseLocal = transposeMat3(base.initialR);
  const bRotation = mulMat3(toBaseLocal, child.initialR);
  const bTranslation = sub3(
    mulMat3Vec(toBaseLocal, sub3(child.initialT, base.initialT)),
    origin,
  );
  const rotation = mulMat3(base.initialR, mulMat3(freeRotation, bRotation));
  const translation = add3(
    base.initialT,
    mulMat3Vec(
      base.initialR,
      add3(
        origin,
        add3(freeTranslation, mulMat3Vec(freeRotation, bTranslation)),
      ),
    ),
  );
  return {
    rotation,
    translationMm: [
      translation[0] * 1000,
      translation[1] * 1000,
      translation[2] * 1000,
    ],
  };
}

function freeRootPose(
  input: DynamicsBuildInput,
  q: readonly number[],
  bodyId: string,
): { rotation: Mat3; translationMm: [number, number, number] } {
  const compiled = compileMechanism(input);
  expect(compiled.ok).toBe(true);
  if (!compiled.ok) throw new Error(compiled.error.message);
  const body = compiled.value.bodies.find((b) => b.id === bodyId);
  if (body === undefined) {
    throw new Error("Unreachable: the fixture names its bodies.");
  }
  const freeRotation = jointFreeRotation(
    {
      kind: "free",
      rotational: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      translational: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
    },
    [q[0] ?? 0, q[1] ?? 0, q[2] ?? 0],
  );
  const freeTranslation = jointFreeTranslation(
    {
      kind: "free",
      rotational: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
      translational: [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1],
      ],
    },
    q,
  );
  const rotation = mulMat3(freeRotation, body.initialR);
  const translation = add3(
    freeTranslation,
    mulMat3Vec(freeRotation, body.initialT),
  );
  return {
    rotation,
    translationMm: [
      translation[0] * 1000,
      translation[1] * 1000,
      translation[2] * 1000,
    ],
  };
}

/** One two-body wire fixture with a rotated base and an offset child. */
function kindBuild(
  kind: "revolute" | "slider" | "cylindrical" | "planar" | "ball" | "rigid",
): DynamicsBuildInput {
  const c = Math.cos(0.3);
  const s = Math.sin(0.3);
  const c2 = Math.cos(1.1);
  const s2 = Math.sin(1.1);
  return {
    occurrences: [
      {
        id: "base",
        placement: {
          rotation: [c, -s, 0, s, c, 0, 0, 0, 1],
          translation: [20, -30, 15],
        },
      },
      {
        id: "child",
        placement: {
          rotation: [c2, -s2, 0, s2, c2, 0, 0, 0, 1],
          translation: [75, 12, -8],
        },
      },
    ],
    joints: [
      kind === "rigid"
        ? {
            id: "j",
            kind,
            baseOccurrenceId: "base",
            occurrenceId: "child",
          }
        : {
            id: "j",
            kind,
            baseOccurrenceId: "base",
            occurrenceId: "child",
            frame:
              kind === "ball"
                ? { origin: [50, 20, 10] }
                : { origin: [50, 20, 10], axis: [0, 1, 1] },
          },
    ],
    masses: [
      { occurrenceId: "base", massGrams: 1000, centerOfGravityMm: [0, 0, 0] },
      {
        occurrenceId: "child",
        massGrams: 700,
        centerOfGravityMm: [90, 20, -5],
        inertiaTensorKgM2: [0.004, 0.0002, 0, 0.0002, 0.003, 0, 0, 0, 0.002],
      },
    ],
    grounded: ["base"],
    gravityMPerS2: [0, 0, 0],
  };
}

const STATIONS: Readonly<Record<string, readonly number[]>> = {
  revolute: [0.7],
  slider: [0.03],
  cylindrical: [0.5, 0.02],
  planar: [0.4, 0.02, -0.015],
  ball: [0.3, -0.2, 0.5],
  rigid: [],
};

async function probeAt(
  input: DynamicsBuildInput,
  q: readonly number[],
): Promise<MujocoProbeOutcome> {
  const probe = await probeMujocoState({
    input,
    q,
    qd: q.map(() => 0),
  });
  expect(probe.ok).toBe(true);
  if (!probe.ok) throw new Error(probe.error.message);
  return probe.value;
}

function expectPoseClose(
  pose:
    | { rotation: readonly number[]; translationMm: readonly number[] }
    | undefined,
  expected: { rotation: Mat3; translationMm: readonly number[] },
  digits: number,
): void {
  if (pose === undefined) throw new Error("Unreachable: the child is posed.");
  expected.rotation.forEach((value, index) => {
    expect(pose.rotation[index] ?? 0).toBeCloseTo(value, digits);
  });
  expected.translationMm.forEach((value, index) => {
    expect(pose.translationMm[index] ?? 0).toBeCloseTo(value, digits);
  });
}

gate("the MuJoCo provider's mapping pins", () => {
  it("loads the wasm module once and creates the engine with its stable id", async () => {
    expect(wasm.ok).toBe(true);
    const engine = await createMujocoDynamicsEngine();
    expect(engine.ok).toBe(true);
    if (!engine.ok) return;
    expect(engine.value.id).toBe(DYNAMICS_MUJOCO_ENGINE_ID);
  });

  it.each([...Object.keys(STATIONS)] as const)(
    "maps the %s joint's FK to the mates' chain at a nonzero station",
    async (kind) => {
      const typedKind = kind as
        "revolute" | "slider" | "cylindrical" | "planar" | "ball" | "rigid";
      const probe = await probeAt(kindBuild(typedKind), STATIONS[kind] ?? []);
      const expected = chainPose(
        kindBuild(typedKind),
        "j",
        STATIONS[kind] ?? [],
        "child",
      );
      expectPoseClose(probe.poses[1], expected, 9);
      // The base is grounded: unmoved at every station.
      const base = probe.poses[0];
      expect(base?.translationMm[0]).toBeCloseTo(20, 9);
    },
    20_000,
  );

  it("maps the free root's FK to the world-anchored chain", async () => {
    const free: DynamicsBuildInput = {
      occurrences: [
        {
          id: "loose",
          placement: {
            rotation: [0, -1, 0, 1, 0, 0, 0, 0, 1],
            translation: [40, 25, -60],
          },
        },
      ],
      joints: [],
      masses: [
        {
          occurrenceId: "loose",
          massGrams: 1500,
          centerOfGravityMm: [70, -10, 30],
          inertiaTensorKgM2: [0.006, 0, 0, 0, 0.005, 0, 0, 0, 0.004],
        },
      ],
      gravityMPerS2: [0, 0, 0],
    };
    const q = [0.25, -0.4, 0.6, 0.05, -0.03, 0.08];
    const probe = await probeAt(free, q);
    const expected = freeRootPose(free, q, "loose");
    expectPoseClose(probe.poses[0], expected, 9);
  });

  it("round-trips our state through MuJoCo identically", async () => {
    // Axis kinds: exact. Ball/free: wrap-exact through the quaternion
    // conversions (same principal vector back).
    const cases: readonly (readonly [DynamicsBuildInput, readonly number[]])[] =
      [
        [kindBuild("revolute"), [0.7]],
        [kindBuild("slider"), [0.03]],
        [kindBuild("cylindrical"), [0.5, 0.02]],
        [kindBuild("planar"), [0.4, 0.02, -0.015]],
        [kindBuild("ball"), [0.3, -0.2, 0.5]],
      ];
    for (const [input, q] of cases) {
      const probe = await probeAt(input, q);
      q.forEach((value, index) => {
        expect(probe.q[index] ?? 0).toBeCloseTo(value, 12);
      });
    }
    const free: DynamicsBuildInput = {
      occurrences: [
        {
          id: "loose",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
      ],
      joints: [],
      masses: [
        {
          occurrenceId: "loose",
          massGrams: 1000,
          centerOfGravityMm: [0, 0, 0],
          inertiaTensorKgM2: [0.002, 0, 0, 0, 0.003, 0, 0, 0, 0.004],
        },
      ],
      gravityMPerS2: [0, 0, 0],
    };
    const q = [0.2, 0.4, -0.3, 0.11, -0.07, 0.05];
    const probe = await probeAt(free, q);
    q.forEach((value, index) => {
      expect(probe.q[index] ?? 0).toBeCloseTo(value, 12);
    });
  });

  it("determinism: two identical runs produce identical results (same binary, same platform)", async () => {
    const run = async (): Promise<string> => {
      // A FRESH engine per run (the wasm module stays memoized): the
      // build path is inside the determinism statement.
      const engine = await createMujocoDynamicsEngine();
      expect(engine.ok).toBe(true);
      if (!engine.ok) throw new Error(engine.error.message);
      const built = engine.value.build(kindBuild("revolute"));
      expect(built.ok).toBe(true);
      if (!built.ok) throw new Error(built.error.message);
      const frames: unknown[] = [];
      for (let index = 0; index < 120; index += 1) {
        const step = built.value.step({ timeStepS: 0.001 });
        expect(step.ok).toBe(true);
        if (!step.ok) throw new Error(step.error.message);
        frames.push(step.value);
      }
      return JSON.stringify(frames);
    };
    const first = await run();
    const second = await run();
    expect(second).toBe(first);
  });

  it("steps and reports the contract's result data for a frictionless pendulum", async () => {
    const engine = await createMujocoDynamicsEngine();
    expect(engine.ok).toBe(true);
    if (!engine.ok) return;
    const built = engine.value.build(kindBuild("revolute"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const step = built.value.step({ timeStepS: 0.001 });
    expect(step.ok).toBe(true);
    if (!step.ok) return;
    const value = step.value;
    expect(built.value.bodyCount).toBe(2);
    expect(built.value.dofCount).toBe(1);
    expect(built.value.loopJointCount).toBe(0);
    expect(value.timeS).toBeCloseTo(0.001, 12);
    expect(value.occurrences.length).toBe(2);
    expect(value.joints[0]?.kind).toBe("revolute");
    expect(Math.abs(value.joints[0]?.dofs[0]?.viscousForce ?? 0)).toBe(0);
    expect(value.energy.kineticJ).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(value.energy.auditJ)).toBe(true);
    expect(value.solver.coneIterations).toBeGreaterThanOrEqual(0);
  });

  it("declines a non-positive time step like the reference", async () => {
    const engine = await createMujocoDynamicsEngine();
    expect(engine.ok).toBe(true);
    if (!engine.ok) return;
    const built = engine.value.build(kindBuild("revolute"));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const step = built.value.step({ timeStepS: 0 });
    expect(step.ok).toBe(false);
    if (step.ok) return;
    expect(step.error.message).toContain("positive finite");
  });

  it("declines friction and motors on closing joints (the parity refusals)", async () => {
    const engine = await createMujocoDynamicsEngine();
    expect(engine.ok).toBe(true);
    if (!engine.ok) return;
    const loopBuild = (
      overrides: Record<string, unknown>,
    ): DynamicsBuildInput => ({
      // A minimal three-body loop: frame grounded, a and b on frame,
      // and the loop joint re-claiming a from b.
      occurrences: [
        {
          id: "frame",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
        {
          id: "a",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
        {
          id: "b",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [200, 0, 0],
          },
        },
      ],
      joints: [
        {
          id: "j1",
          kind: "revolute",
          baseOccurrenceId: "frame",
          occurrenceId: "a",
          frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
        },
        {
          id: "j2",
          kind: "revolute",
          baseOccurrenceId: "frame",
          occurrenceId: "b",
          frame: { origin: [200, 0, 0], axis: [0, 0, 1] },
        },
        {
          id: "jloop",
          kind: "revolute",
          baseOccurrenceId: "b",
          occurrenceId: "a",
          frame: { origin: [-100, 0, 0], axis: [0, 0, 1] },
          ...overrides,
        },
      ],
      masses: [
        {
          occurrenceId: "frame",
          massGrams: 1000,
          centerOfGravityMm: [0, 0, 0],
        },
        { occurrenceId: "a", massGrams: 200, centerOfGravityMm: [100, 0, 0] },
        { occurrenceId: "b", massGrams: 200, centerOfGravityMm: [100, 0, 0] },
      ],
      grounded: ["frame"],
      gravityMPerS2: [0, 0, 0],
    });
    const friction = engine.value.build(
      loopBuild({ viscousDampingNPerMSPerRad: 0.01 }),
    );
    expect(friction.ok).toBe(false);
    if (friction.ok) return;
    expect(friction.error.message).toContain("closes a loop");

    const motor = engine.value.build({
      ...loopBuild({}),
      motors: [
        {
          jointId: "jloop",
          motor: {
            id: "m",
            kind: "dc-brushed",
            stallTorqueMNm: 100,
            noLoadSpeedRpm: 6000,
            nominalVoltageV: 12,
          },
        },
      ],
    });
    expect(motor.ok).toBe(false);
    if (motor.ok) return;
    expect(motor.error.message).toContain("motor rides joint");
  });

  it("declines an initially-unclosed loop (no projection — stated difference)", async () => {
    const engine = await createMujocoDynamicsEngine();
    expect(engine.ok).toBe(true);
    if (!engine.ok) return;
    // Same loop as above but b's anchor 1 mm off the closed point.
    const built = engine.value.build({
      occurrences: [
        {
          id: "frame",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
        {
          id: "a",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [0, 0, 0],
          },
        },
        {
          id: "b",
          placement: {
            rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
            translation: [201, 0, 0],
          },
        },
      ],
      joints: [
        {
          id: "j1",
          kind: "revolute",
          baseOccurrenceId: "frame",
          occurrenceId: "a",
          frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
        },
        {
          id: "j2",
          kind: "revolute",
          baseOccurrenceId: "frame",
          occurrenceId: "b",
          frame: { origin: [200, 0, 0], axis: [0, 0, 1] },
        },
        {
          id: "jloop",
          kind: "revolute",
          baseOccurrenceId: "b",
          occurrenceId: "a",
          frame: { origin: [-100, 0, 0], axis: [0, 0, 1] },
        },
      ],
      masses: [
        {
          occurrenceId: "frame",
          massGrams: 1000,
          centerOfGravityMm: [0, 0, 0],
        },
        { occurrenceId: "a", massGrams: 200, centerOfGravityMm: [100, 0, 0] },
        { occurrenceId: "b", massGrams: 200, centerOfGravityMm: [100, 0, 0] },
      ],
      grounded: ["frame"],
      gravityMPerS2: [0, 0, 0],
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe("sim/loop-unresolved");
    expect(built.error.message).toContain("does not project");
  });
});

gate("the engine-factory seam", () => {
  it("defaults to the reference oracle and routes the opt-in providers", async () => {
    expect(DEFAULT_DYNAMICS_ENGINE).toBe("reference");
    const reference = await createDynamicsEngine();
    expect(reference.ok).toBe(true);
    if (!reference.ok) return;
    expect(reference.value.id).toBe(DYNAMICS_REFERENCE_ENGINE_ID);
    // Unchanged default behavior: the reference branch builds directly.
    const built = reference.value.build(kindBuild("revolute"));
    expect(built.ok).toBe(true);

    const mujoco = await createDynamicsEngine("mujoco");
    expect(mujoco.ok).toBe(true);
    if (!mujoco.ok) return;
    expect(mujoco.value.id).toBe(DYNAMICS_MUJOCO_ENGINE_ID);

    const again = await createDynamicsEngine("reference");
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.value.id).toBe(DYNAMICS_REFERENCE_ENGINE_ID);
  });
});
