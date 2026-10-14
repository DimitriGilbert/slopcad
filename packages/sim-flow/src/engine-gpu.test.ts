/**
 * The WGSL provider engine and the backend router's tests (Phase 64a,
 * requirement 2 + 5): the scenario's backend preference selects the
 * provider through the routed default engine — gpu → WGSL when the
 * device source finds one, the documented GRACEFUL CPU FALLBACK when
 * it does not (the Phase 63 decline promoted into the router) — and
 * the provider engine itself finalizes a contract-shaped result over
 * the fake device (the orchestration exercised end to end: compile →
 * submits → readbacks → report). Determinism of the routed path is
 * pinned on the fake, where the whole pipeline is host-controlled.
 */

import { describe, expect, it } from "vitest";
import { compileSimScenarioWithGeometry } from "@slopcad/sim-core";

import { boxTessellationWire } from "./fixtures";
import { createDefaultSimEngine } from "./engine";
import { LBM_WGSL_SIM_ENGINE_ID, createWgslSimEngine } from "./engine-gpu";
import { requestWebGpuDevice } from "./gpu-device";
import { createWgslFakeDevice } from "./wgsl-fake-device";

/** The contract fixture of `./engine.test.ts`, shared verbatim in shape. */
function tunnelScenario(overrides?: {
  readonly stepBudget?: number;
  readonly backend?: "cpu" | "gpu";
}): Record<string, unknown> {
  return {
    name: "contract-tunnel",
    kind: "flow",
    domain: {
      kind: "explicit",
      min: [0, 0, 0],
      max: [100, 40, 10],
      resolutionMm: 5,
    },
    conditions: [
      {
        kind: "velocity-inlet",
        face: "xMin",
        speedMPerS: 0.005,
        direction: [1, 0, 0],
      },
      { kind: "wall", face: "yMin", slip: false },
      { kind: "symmetry", face: "yMax" },
    ],
    fluid: "air",
    stepBudget: overrides?.stepBudget ?? 24,
    ...(overrides?.backend === undefined ? {} : { backend: overrides.backend }),
  };
}

const OBSTACLE = boxTessellationWire([40, 15, 0], [60, 25, 10]);

function compileTunnel(overrides?: {
  readonly stepBudget?: number;
  readonly backend?: "cpu" | "gpu";
}) {
  return compileSimScenarioWithGeometry({
    scenario: tunnelScenario(overrides),
    tessellation: OBSTACLE,
  });
}

describe("the routed default engine's backend selection", () => {
  it("falls back to the CPU oracle gracefully when no device exists — the 63 decline promoted", async () => {
    let detections = 0;
    const routed = createDefaultSimEngine({
      deviceSource: () => {
        detections += 1;
        return Promise.resolve(undefined);
      },
    });
    const compiled = compileTunnel({ backend: "gpu" });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const run = await routed.run({ compiled: compiled.value });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    // The CPU twin ran: real histories at the full budget, completed,
    // and the honest backend marker records the FALLBACK (a gpu
    // preference served by the CPU oracle — Phase 64b's marker).
    expect(run.value.summary.status).toBe("completed");
    expect(run.value.summary.servedBackend).toBe("cpu");
    expect(run.value.histories[0]?.samples.length).toBe(24);
    expect(run.value.fields.map((field) => field.id)).toContain("speed");
    // Detection is memoized per engine instance — deterministic routing.
    const second = await routed.run({ compiled: compiled.value });
    expect(second.ok).toBe(true);
    expect(detections).toBe(1);
  });

  it("serves a gpu-preferred flow scenario on the WGSL provider when the device source finds one", async () => {
    const device = createWgslFakeDevice();
    const routed = createDefaultSimEngine({
      deviceSource: () => Promise.resolve(device),
    });
    const compiled = compileTunnel({ backend: "gpu" });
    if (!compiled.ok) return;
    const progress: number[] = [];
    const run = await routed.run({ compiled: compiled.value }, (entry) =>
      progress.push(entry.step),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.summary.status).toBe("completed");
    // The provider executed the run (the honest backend marker).
    expect(run.value.summary.servedBackend).toBe("gpu");
    expect(run.value.histories[0]?.samples.length).toBe(24);
    // The provider ran: the fake's trace shows the step pipeline.
    const entryPoints = new Set(
      device.trace.dispatches.map((dispatch) => dispatch.entryPoint),
    );
    expect(entryPoints.has("collide_step")).toBe(true);
    expect(entryPoints.has("macro_out")).toBe(true);
    expect(progress[progress.length - 1]).toBe(24);
    // The readback framing end to end: the fake executes no shader, so
    // the macro readback carries the SEEDED state (rho = 1 at fluid
    // nodes, 0 at the obstacle's 15 solid nodes) — every fluid-node
    // pressure projects to exactly the reference pressure, and the
    // solid nodes share the single (rho − 1) constant.
    const pressure = run.value.fields.find((field) => field.id === "pressure");
    expect(pressure).toBeDefined();
    if (pressure !== undefined) {
      expect(pressure.values.length).toBe(21 * 9);
      const fluidZeroes = pressure.values.filter((value) => value === 0);
      const solidValues = pressure.values.filter((value) => value !== 0);
      expect(fluidZeroes.length).toBe(21 * 9 - 15);
      expect(solidValues.length).toBe(15);
      expect(new Set(solidValues).size).toBe(1);
      expect(solidValues[0]).toBeLessThan(0);
    }
  });

  it("keeps cpu-preferred scenarios on the CPU engine even when a device exists", async () => {
    const device = createWgslFakeDevice();
    const routed = createDefaultSimEngine({
      deviceSource: () => Promise.resolve(device),
    });
    const compiled = compileTunnel({ backend: "cpu" });
    if (!compiled.ok) return;
    const run = await routed.run({ compiled: compiled.value });
    expect(run.ok).toBe(true);
    expect(device.trace.dispatches.length).toBe(0);
  });

  it("is deterministic on the provider path: identical runs on fresh fakes", async () => {
    const runOnce = async () => {
      const device = createWgslFakeDevice();
      const routed = createDefaultSimEngine({
        deviceSource: () => Promise.resolve(device),
      });
      const compiled = compileTunnel({ backend: "gpu" });
      if (!compiled.ok) throw new Error(compiled.error.message);
      const run = await routed.run({ compiled: compiled.value });
      if (!run.ok) throw new Error(run.error.message);
      return {
        summary: run.value.summary,
        fields: run.value.fields,
        histories: run.value.histories,
        trace: JSON.stringify(device.trace),
      };
    };
    const first = await runOnce();
    const second = await runOnce();
    expect(second.summary).toEqual(first.summary);
    expect(second.fields).toEqual(first.fields);
    expect(second.histories).toEqual(first.histories);
    expect(second.trace).toBe(first.trace);
  });

  it("resolves the default device source to the honest absent on a node host", async () => {
    // navigator.gpu does not exist under node: the real feature-detect
    // seam resolves undefined — never a fabricated device.
    expect(await requestWebGpuDevice()).toBeUndefined();
  });
});

describe("createWgslSimEngine (the direct provider engine)", () => {
  it("declares the gpu backend and the flow kind, and declines the rest loudly", async () => {
    const engine = createWgslSimEngine(createWgslFakeDevice());
    expect(engine.id).toBe(LBM_WGSL_SIM_ENGINE_ID);
    expect(engine.backend).toBe("gpu");
    expect(engine.supportedKinds).toEqual(["flow"]);
    const thermal = compileSimScenarioWithGeometry({
      scenario: {
        name: "warm",
        kind: "thermal",
        domain: {
          kind: "explicit",
          min: [0, 0, 0],
          max: [10, 10, 10],
          resolutionMm: 2,
        },
        conditions: [],
        fluid: "air",
      },
    });
    expect(thermal.ok).toBe(true);
    if (!thermal.ok) return;
    const run = await engine.run({ compiled: thermal.value });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.code).toBe("sim/scenario-kind-unsupported");
  });

  it("declines a flow run without geometry, never fabricating an empty tunnel", async () => {
    const engine = createWgslSimEngine(createWgslFakeDevice());
    const compiled = compileSimScenarioWithGeometry({
      scenario: tunnelScenario(),
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const run = await engine.run({ compiled: compiled.value });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.code).toBe("sim/geometry-unavailable");
  });
});
