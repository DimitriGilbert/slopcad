/**
 * The fan demo's pairing test (Phase 66c): the demo motor's line must
 * cross the demo rotor's load curve inside the engine's ω ladder, over
 * the ANALYTIC TWIN of the tessellated demo body — the tube shell and
 * the paddle rotor as closed-solid predicates at the demo's own domain
 * and resolution (the chorded Manifold circles differ from the analytic
 * radii by ≈0.005 %, orders below the 2 mm voxel scale, so the twin is
 * the honest measurement fixture; the e2e session stage covers the
 * tessellated path through the real kernel worker).
 *
 * The pinned truths: the operating point is FOUND inside the ladder's
 * span at a positive torque, the verify rung agrees with the solve, the
 * chart's history pair rides along, and the S9 fan Re line flags the
 * demo's low-Re regime. This is the fixture that keeps the demo motor
 * and the demo geometry paired as either evolves.
 */

import { describe, expect, it } from "vitest";
import {
  type CompiledSimScenario,
  type SimOccupancyGrid,
  getSimFluid,
  simFluidState,
  simRegimeReport,
  simReynolds,
  simMach,
  simPrandtl,
} from "@slopcad/sim-core";
import { createFlow3dSimEngine } from "@slopcad/sim-flow";
import { FAN_IN_TUBE } from "@slopcad/docs-examples/cadjsx/fan-in-tube";

import {
  FAN_DEMO,
  FAN_DEMO_MOTOR_ID,
  FAN_DEMO_MOTOR_NUMBERS,
  addFanDemoScenario,
  fanDemoDocument,
} from "./fan-demo";

/** The analytic twin: the closed-solid predicate, document mm. */
function fanDemoSolidAt(x: number, y: number, z: number): boolean {
  const radius = Math.hypot(x, y);
  const shell =
    radius >= FAN_IN_TUBE.boreRadius &&
    radius <= FAN_IN_TUBE.outerRadius &&
    z >= 0 &&
    z <= FAN_IN_TUBE.length;
  const zLow = FAN_IN_TUBE.rotorZ - FAN_IN_TUBE.rotorThickness / 2;
  const zHigh = FAN_IN_TUBE.rotorZ + FAN_IN_TUBE.rotorThickness / 2;
  const hub = radius <= FAN_IN_TUBE.hubRadius && z >= zLow && z <= zHigh;
  const barY =
    Math.abs(x) <= FAN_IN_TUBE.bladeThickness / 2 &&
    Math.abs(y) <= FAN_IN_TUBE.barHalfLength &&
    z >= zLow &&
    z <= zHigh;
  const barX =
    Math.abs(y) <= FAN_IN_TUBE.bladeThickness / 2 &&
    Math.abs(x) <= FAN_IN_TUBE.barHalfLength &&
    z >= zLow &&
    z <= zHigh;
  return shell || hub || barY || barX;
}

/** The demo domain's node counts (the voxelizer's floor rule). */
function fanDemoShape(): readonly [number, number, number] {
  const nodes = (min: number, max: number): number =>
    Math.floor((max - min) / FAN_DEMO.resolutionMm) + 1;
  return [
    nodes(FAN_DEMO.domainMinMm[0], FAN_DEMO.domainMaxMm[0]),
    nodes(FAN_DEMO.domainMinMm[1], FAN_DEMO.domainMaxMm[1]),
    nodes(FAN_DEMO.domainMinMm[2], FAN_DEMO.domainMaxMm[2]),
  ];
}

/** The analytic occupancy grid at the demo domain and resolution. */
function fanDemoGrid(): SimOccupancyGrid {
  const [nx, ny, nz] = fanDemoShape();
  const cells = new Uint8Array(nx * ny * nz);
  const step = FAN_DEMO.resolutionMm;
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const wx = (FAN_DEMO.domainMinMm[0] ?? 0) + x * step;
        const wy = (FAN_DEMO.domainMinMm[1] ?? 0) + y * step;
        const wz = (FAN_DEMO.domainMinMm[2] ?? 0) + z * step;
        cells[x + y * nx + z * nx * ny] = fanDemoSolidAt(wx, wy, wz) ? 1 : 0;
      }
    }
  }
  return Object.freeze({
    semantic: "occupancy" as const,
    name: "fan-demo-twin",
    shape: [nx, ny, nz] as const,
    originM: [
      (FAN_DEMO.domainMinMm[0] ?? 0) / 1000,
      (FAN_DEMO.domainMinMm[1] ?? 0) / 1000,
      (FAN_DEMO.domainMinMm[2] ?? 0) / 1000,
    ] as const,
    spacingM: [step / 1000, step / 1000, step / 1000] as const,
    cells,
  });
}

/** The compiled demo problem over the analytic twin. */
function compiledFanDemo(): CompiledSimScenario {
  const air = getSimFluid("air");
  if (air === undefined) throw new Error("the air fluid record is absent");
  const fluid = simFluidState(air, air.referenceK);
  if (!fluid.ok) throw new Error(fluid.error.message);
  const [, , nz] = fanDemoShape();
  const regime = simRegimeReport({
    reynolds: simReynolds(
      fluid.value.densityKgPerM3,
      FAN_DEMO.inletSpeedMPerS,
      ((FAN_DEMO.domainMaxMm[2] ?? 0) - (FAN_DEMO.domainMinMm[2] ?? 0)) / 1000,
      fluid.value.dynamicViscosityPaS,
    ),
    mach: simMach(FAN_DEMO.inletSpeedMPerS, fluid.value.speedOfSoundMPerS),
    prandtl: simPrandtl(
      fluid.value.dynamicViscosityPaS,
      fluid.value.specificHeatJPerKgK,
      fluid.value.thermalConductivityWPerMK,
    ),
  });
  const noLoadRadPerS =
    (FAN_DEMO_MOTOR_NUMBERS.noLoadSpeedRpm * 2 * Math.PI) / 60;
  const stallTorqueNPerM = FAN_DEMO_MOTOR_NUMBERS.stallTorqueMNm / 1000;
  const kvRpmPerV =
    FAN_DEMO_MOTOR_NUMBERS.noLoadSpeedRpm /
    FAN_DEMO_MOTOR_NUMBERS.nominalVoltageV;
  return Object.freeze({
    kind: "flow",
    name: "fan-demo-twin",
    domainMinM: [
      (FAN_DEMO.domainMinMm[0] ?? 0) / 1000,
      (FAN_DEMO.domainMinMm[1] ?? 0) / 1000,
      (FAN_DEMO.domainMinMm[2] ?? 0) / 1000,
    ] as const,
    domainMaxM: [
      (FAN_DEMO.domainMaxMm[0] ?? 0) / 1000,
      (FAN_DEMO.domainMaxMm[1] ?? 0) / 1000,
      (FAN_DEMO.domainMaxMm[2] ?? 0) / 1000,
    ] as const,
    cellSizeM: FAN_DEMO.resolutionMm / 1000,
    characteristicLengthM: nz / 1000,
    gravityMPerS2: [0, -9.80665, 0] as const,
    conditions: [
      {
        kind: "velocity-inlet",
        face: "zMin",
        velocityMPerS: [0, 0, FAN_DEMO.inletSpeedMPerS] as const,
      },
    ] as const,
    fluid: fluid.value,
    motor: {
      kind: "dc-brushed" as const,
      stallTorqueNPerM,
      noLoadSpeedRadPerS: noLoadRadPerS,
      nominalVoltageV: FAN_DEMO_MOTOR_NUMBERS.nominalVoltageV,
      kvRpmPerV,
      ktNPerA: 1 / (kvRpmPerV * ((2 * Math.PI) / 60)),
    },
    backend: "cpu",
    regime,
    scenarioSnapshotHash: "fan-demo-twin",
    occupancy3d: fanDemoGrid(),
    flow3d: {
      boundaryTreatment: "staircase" as const,
      rotation: {
        kind: "mrf" as const,
        axisPointM: [
          (FAN_DEMO.axisPointMm[0] ?? 0) / 1000,
          (FAN_DEMO.axisPointMm[1] ?? 0) / 1000,
          (FAN_DEMO.axisPointMm[2] ?? 0) / 1000,
        ] as const,
        axisDirection: [...FAN_DEMO.axisDirection] as const,
        zoneRadiusM: FAN_DEMO.zoneRadiusMm / 1000,
        rpmMode: "motor" as const,
        bladeCount: FAN_DEMO.bladeCount,
      },
    },
    run: {
      stepBudget: FAN_DEMO.stepBudget,
      averagingStartStep: Math.max(1, Math.ceil(FAN_DEMO.stepBudget / 2)),
      gridConvergence: false,
    },
  });
}

describe("the fan demo pairing (the analytic twin)", () => {
  it("the demo document carries the body, the motor, and the scenario", () => {
    const document = fanDemoDocument();
    expect(document.motors.map((motor) => motor.id)).toContain(
      FAN_DEMO_MOTOR_ID,
    );
    expect(document.bodies.length).toBeGreaterThan(0);
    // The demo scenario applies over the demo document and selects the
    // motor the document carries (the run-time wiring the page repeats).
    const withScenario = addFanDemoScenario(document);
    expect(withScenario.scenarioName).toBe("fan-in-tube");
  });

  it("the demo motor's line crosses the rotor's load curve in the ladder", async () => {
    const compiled = compiledFanDemo();
    const run = await createFlow3dSimEngine().run({ compiled });
    if (!run.ok) throw new Error(run.error.message);
    const quantity = (name: string): number => {
      const found = run.value.summary.quantities.find(
        (entry) => entry.name === name,
      );
      if (found === undefined) throw new Error(`no "${name}" quantity`);
      return found.value;
    };
    const noLoadRadPerS =
      (FAN_DEMO_MOTOR_NUMBERS.noLoadSpeedRpm * 2 * Math.PI) / 60;
    const omega = quantity("operating-speed");
    // FOUND inside the ladder (0.25 … 1 × no-load), at positive torque.
    expect(omega).toBeGreaterThan(0.25 * noLoadRadPerS);
    expect(omega).toBeLessThan(1 * noLoadRadPerS);
    expect(quantity("operating-torque")).toBeGreaterThan(0);
    // The verify rung's independent windowed mean agrees with the solve
    // inside the rung noise band (the piecewise-linear load curve's own
    // accuracy — the guide's band).
    const verify = quantity("verify-rung-torque");
    const solved = quantity("operating-torque");
    expect(Math.abs(verify - solved)).toBeLessThan(0.35 * solved + 1e-12);
    // The chart's data half rides along.
    const load = run.value.histories.find((s) => s.name === "load-torque");
    const motor = run.value.histories.find((s) => s.name === "motor-torque");
    expect(load?.samples).toHaveLength(4);
    expect(motor?.samples).toHaveLength(4);
    // The demo's honest regime: a low-Re fan (the S9 guidance line).
    expect(run.value.summary.regime.qualitative).toContain("low-reynolds-fan");
  }, 240_000);
});
