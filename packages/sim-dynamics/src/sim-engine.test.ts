/**
 * The Phase 61 `SimEngine` adapter's units (Phase 67c): the slider-crank
 * demo twin end-to-end — compile products consumed, the stepped march
 * run, the per-joint dissipation summaries projected, the state
 * histories (the assembly-motion surface's animation data), the one
 * committed dissipation preview round, and every decline the contract
 * demands. The kinematic ground truth is the slider-crank closure
 * `s(θ) = r·cosθ + √(l² − r²·sin²θ) − (r + l)`.
 */

import { describe, expect, it } from "vitest";
import {
  type CompiledSimDynamicsLoad,
  type CompiledSimScenario,
  type SimEngineFieldChunk,
  type SimEngineProgress,
  type SimError,
  type SimParseResult,
  type SimResult,
  reassembleSimFieldChunks,
} from "@slopcad/sim-core";

import {
  DYNAMICS_DISSIPATION_FIELD_ID,
  DYNAMICS_SIM_ENGINE_ID,
  createDynamicsSimEngine,
} from "./sim-engine";
import {
  SLIDER_CRANK_MOTOR,
  sliderCrankBuild,
  sliderCrankPistonSlideM,
} from "./fixtures";

const CRANK_RADIUS_M = 0.03;
const ROD_LENGTH_M = 0.09;
const TIME_STEP_S = 0.001;
const SAMPLE_INTERVAL_S = 0.02;

/** The demo twin's mechanism wire (the document half of the compile). */
function sliderCrankMechanismWire() {
  const build = sliderCrankBuild({
    crankRadiusM: CRANK_RADIUS_M,
    rodLengthM: ROD_LENGTH_M,
    crankMassKg: 0.1,
    rodMassKg: 0.15,
    pistonMassKg: 0.2,
    motor: SLIDER_CRANK_MOTOR,
    viscous: 0.002,
    frictionLoss: 0.004,
  });
  return {
    occurrences: build.occurrences,
    joints: build.joints,
    masses: build.masses,
    ...(build.grounded === undefined ? {} : { grounded: build.grounded }),
  };
}

/** A compiled dynamics scenario over the demo twin (the solver half). */
function compiledSliderCrank(options?: {
  readonly durationS?: number;
  readonly loads?: readonly CompiledSimDynamicsLoad[];
  readonly provider?: "reference" | "mujoco";
}): CompiledSimScenario {
  return {
    kind: "dynamics",
    name: "slider-crank-twin",
    domainMinM: [-0.05, -0.05, -0.02],
    domainMaxM: [0.16, 0.05, 0.02],
    cellSizeM: 0.002,
    characteristicLengthM: 0.21,
    gravityMPerS2: [0, -9.80665, 0],
    conditions: [],
    fluid: {
      fluidId: "air",
      temperatureK: 288.15,
      densityKgPerM3: 1.225,
      dynamicViscosityPaS: 1.79e-5,
      kinematicViscosityM2PerS: 1.46e-5,
      thermalDiffusivityM2PerS: 2.04e-5,
      prandtl: 0.713,
      thermalExpansionPerK: 0.00347,
      specificHeatJPerKgK: 1006,
      thermalConductivityWPerMK: 0.0257,
      speedOfSoundMPerS: 340.3,
    },
    motor: undefined,
    backend: "cpu",
    regime: { qualitative: [] },
    scenarioSnapshotHash: "slider-crank-twin",
    dynamics: {
      provider: options?.provider ?? "reference",
      timeStepS: TIME_STEP_S,
      durationS: options?.durationS ?? 0.5,
      sampleIntervalS: SAMPLE_INTERVAL_S,
      motorJointId: "jnt_crank",
      mechanism: sliderCrankMechanismWire(),
      loads: options?.loads ?? [],
      motorWire: SLIDER_CRANK_MOTOR,
    },
  };
}

describe("the dynamics SimEngine adapter", () => {
  it("runs the slider-crank twin to dissipation summaries and histories", async () => {
    const progress: SimEngineProgress[] = [];
    const chunks: SimEngineFieldChunk[] = [];
    const run = await createDynamicsSimEngine().run(
      { compiled: compiledSliderCrank() },
      (update) => progress.push(update),
      (chunk) => chunks.push(chunk),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error(run.error.message);
    const result = run.value;
    // The march ran its full lattice: the LAST progress is the total.
    expect(progress.at(-1)?.step).toBe(500);
    expect(progress.at(-1)?.totalSteps).toBe(500);
    // The dissipation preview round: one field, reassembling losslessly.
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]?.id).toBe(DYNAMICS_DISSIPATION_FIELD_ID);
    const reassembled = reassembleSimFieldChunks(chunks);
    expect(reassembled.ok).toBe(true);
    if (reassembled.ok) {
      // [joints, samples, 1]: four joints, 25 samples at 20 ms.
      expect(reassembled.value.extent).toEqual([4, 25, 1]);
      expect(reassembled.value.unit).toBe("W");
    }
    // Per-joint dissipated power/work summaries (the Phase 70 material).
    const quantity = (name: string): number => {
      const found = result.summary.quantities.find(
        (entry) => entry.name === name,
      );
      if (found === undefined) throw new Error(`no "${name}" quantity`);
      return found.value;
    };
    // The tree joints carrying friction fields dissipate; the slider
    // (no friction authored) and the wrist pin (a CLOSING joint —
    // friction on it is declined loudly at build) dissipate nothing.
    for (const joint of ["jnt_crank", "jnt_conrod"]) {
      expect(quantity(`joint-${joint}-dissipated-work`)).toBeGreaterThan(0);
    }
    expect(quantity("joint-jnt_slide-dissipated-work")).toBe(0);
    expect(quantity("joint-jnt_wrist-dissipated-work")).toBe(0);
    expect(quantity("dissipated-work-total")).toBeGreaterThan(0);
    expect(quantity("motor-speed-final")).toBeGreaterThan(0);
    // The energy ledger rides as histories.
    const audit = result.histories.find((s) => s.name === "energy:audit");
    expect(audit?.samples.length).toBe(25);
    // The loop closed through the march (residual under the closure
    // tolerance — the quantity mirrors the solver history).
    expect(quantity("loop-residual-worst")).toBeLessThan(1e-6);
  }, 20_000);

  it("the piston slide follows the closure relation s(θ)", async () => {
    const run = await createDynamicsSimEngine().run({
      compiled: compiledSliderCrank(),
    });
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error(run.error.message);
    const times = run.value.histories.find((s) => s.name === "time");
    const crank = run.value.histories.find(
      (s) => s.name === "joint:jnt_crank:dof0:position",
    );
    const slide = run.value.histories.find(
      (s) => s.name === "joint:jnt_slide:dof0:position",
    );
    expect(times?.samples.length).toBeGreaterThan(4);
    if (
      times === undefined ||
      crank === undefined ||
      slide === undefined ||
      run.value.histories.find(
        (s) => s.name === "joint:jnt_crank:dof0:rate",
      ) === undefined
    ) {
      throw new Error("the histories are incomplete");
    }
    let worst = 0;
    for (const [index, crankAngle] of crank.samples.entries()) {
      const predicted = sliderCrankPistonSlideM(
        CRANK_RADIUS_M,
        ROD_LENGTH_M,
        crankAngle,
      );
      const actual = slide.samples[index] ?? 0;
      worst = Math.max(worst, Math.abs(actual - predicted));
    }
    // The semi-implicit crank angle lags the sampled piston by at most
    // one step's rotation (≈ ω·dt ≈ 3 mrad) plus the loop closure's
    // projection residue — the measured band, ×10 margin.
    expect(worst).toBeLessThan(3e-4);
  }, 20_000);

  it("is deterministic: identical runs produce identical results", async () => {
    const first = await createDynamicsSimEngine().run({
      compiled: compiledSliderCrank({ durationS: 0.1 }),
    });
    const second = await createDynamicsSimEngine().run({
      compiled: compiledSliderCrank({ durationS: 0.1 }),
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(second.value.summary)).toBe(
      JSON.stringify(first.value.summary),
    );
    expect(JSON.stringify(second.value.histories)).toBe(
      JSON.stringify(first.value.histories),
    );
  }, 20_000);

  it("declines the kinds it does not solve and the gpu preference", async () => {
    const wrongKind = await createDynamicsSimEngine().run({
      compiled: { ...compiledSliderCrank(), kind: "flow" },
    });
    expect(wrongKind.ok).toBe(false);
    if (wrongKind.ok) return;
    expect(wrongKind.error.code).toBe("sim/scenario-kind-unsupported");

    const gpuPreferred = await createDynamicsSimEngine().run({
      compiled: { ...compiledSliderCrank(), backend: "gpu" },
    });
    expect(gpuPreferred.ok).toBe(false);
    if (gpuPreferred.ok) return;
    expect(gpuPreferred.error.code).toBe("sim/backend-unavailable");
  });

  it("declines a compiled scenario without the dynamics products", async () => {
    const withoutProducts = { ...compiledSliderCrank() };
    delete withoutProducts.dynamics;
    const declined = await createDynamicsSimEngine().run({
      compiled: withoutProducts,
    });
    expect(declined.ok).toBe(false);
    if (declined.ok) return;
    expect(declined.error.message).toContain("mechanism");
  });

  it("applies the quasi-static couplings through the engine path", async () => {
    // A flow-force history on the piston (a 63/66-style drag series) and
    // a combustion torque estimate on the crank (68's shape): both ride
    // the compile products and land in the control terms per step.
    const combined = await createDynamicsSimEngine().run({
      compiled: compiledSliderCrank({
        durationS: 0.2,
        loads: [
          {
            kind: "flow-force",
            occurrenceId: "piston",
            samples: [
              { tS: 0, forceN: [2, 0, 0] },
              { tS: 0.2, forceN: [2, 0, 0] },
            ],
          },
          {
            kind: "joint-torque",
            name: "firing estimate",
            jointId: "jnt_crank",
            samples: [
              { tS: 0, effortNPerM: 0.01 },
              { tS: 0.2, effortNPerM: 0.01 },
            ],
          },
        ],
      }),
    });
    expect(combined.ok).toBe(true);
    if (!combined.ok) throw new Error(combined.error.message);
    const quantityOf = (
      run: SimParseResult<SimResult, SimError>,
      name: string,
    ): number => {
      if (!run.ok) throw new Error(run.error.message);
      const found = run.value.summary.quantities.find(
        (entry) => entry.name === name,
      );
      if (found === undefined) throw new Error(`no "${name}" quantity`);
      return found.value;
    };
    // The flow-force coupling rides the kernel's gravity-sharing loads
    // term — its work lands in the ledger's external-work book (the
    // piston drag acting on the moving piston; the sign is whatever
    // the phases say, the magnitude is the coupling's proof).
    expect(
      Math.abs(quantityOf(combined, "external-work-total")),
    ).toBeGreaterThan(0);
    // The torque estimate rides the joint-efforts term: its energy
    // shows as kinetic + dissipated against the unloaded twin (a
    // positive effort on a positively-spinning crank feeds the
    // mechanism — the 67a ledger books joint efforts on the drive DOF,
    // not in the external-loads term, and the test states that).
    const unloaded = await createDynamicsSimEngine().run({
      compiled: compiledSliderCrank({ durationS: 0.2 }),
    });
    const torqued = await createDynamicsSimEngine().run({
      compiled: compiledSliderCrank({
        durationS: 0.2,
        loads: [
          {
            kind: "joint-torque",
            name: "firing estimate",
            jointId: "jnt_crank",
            samples: [
              { tS: 0, effortNPerM: 0.01 },
              { tS: 0.2, effortNPerM: 0.01 },
            ],
          },
        ],
      }),
    });
    expect(torqued.ok).toBe(true);
    expect(unloaded.ok).toBe(true);
    const energyOf = (run: SimParseResult<SimResult, SimError>): number =>
      quantityOf(run, "dissipated-work-total");
    expect(energyOf(torqued)).toBeGreaterThan(energyOf(unloaded));
  }, 20_000);

  it("serves the MuJoCo provider behind the same contract (opt-in)", async () => {
    const run = await createDynamicsSimEngine().run({
      compiled: compiledSliderCrank({
        durationS: 0.1,
        provider: "mujoco",
      }),
    });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.summary.servedBackend).toBe("cpu");
    expect(run.value.histories.find((s) => s.name === "time")).toBeDefined();
  }, 30_000);

  it("carries the engine's stable id and kind list", () => {
    const engine = createDynamicsSimEngine();
    expect(engine.id).toBe(DYNAMICS_SIM_ENGINE_ID);
    expect(engine.supportedKinds).toEqual(["dynamics"]);
    expect(engine.backend).toBe("cpu");
  });
});
