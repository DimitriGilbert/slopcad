/**
 * The 3D engine's contract tests (Phase 66c), in-process: the real 3D
 * flow engine behind the Phase 61 contract, driven directly over
 * compiled problems from the geometry-aware compile door's flow3d
 * branch. The channel-level truths stay `./engine-node-channel`'s;
 * this file pins the 3D ENGINE's own semantics:
 *
 * - the STATIC door: a box obstacle voxelizes into the full-3D grid,
 *   the run completes with 3D-extent fields and force histories, and
 *   the same problem produces the identical summary twice (law S2);
 * - the routing honesty: the 2D engine declines a 3D-authored scenario
 *   and the 3D engine declines a slice-only one; the routed default
 *   engine serves the 3D stance on the CPU oracle (the summary's
 *   servedBackend record); a direct gpu-preferred call declines;
 * - the MRF FIXED door: the paddle rotor at an authored rpm reports
 *   the BPF arithmetic, the performance extraction, and the S9 fan Re
 *   guidance line (the tiny rotor carries the low-Re qualitative
 *   flag);
 * - the MRF MOTOR-DRIVEN door: the operating point is FOUND (not
 *   assumed) inside the ladder's span, cross-checked against
 *   fan-3d's own analysis at the same ladder, the powers and the BPF
 *   pinned against the found point, and the load/motor history pair
 *   (the published chart's data half) present with equal lengths;
 * - the RESOLVED door: the fixed-rate showcase completes with the
 *   mean/fluctuation torque split (law S9), and the motor-driven
 *   pairing declines loudly (Phase 67's carve);
 * - the compile door's declines: the reserved cut-cell treatment, the
 *   motor-driven stance without a motor selection, the 3D
 *   grid-convergence flag, and the kind lock.
 */

import { describe, expect, it } from "vitest";
import {
  type CompiledSimScenario,
  compileSimScenarioWithGeometry,
  type SimEngineFieldChunk,
  type SimEngineProgress,
  type SimResult,
} from "@slopcad/sim-core";

import { analyzeFanOperatingPoint } from "./fan-3d";
import { boxTessellationWire, mergedTessellationWire } from "./fixtures";
import {
  LBM3D_SIM_ENGINE_ID,
  createDefaultSimEngine,
  createFlow3dSimEngine,
  createLbmSimEngine,
  FLOW3D_LADDER_FRACTIONS,
} from "./index";
import { mrfCylindricalZonePredicate } from "./mrf-3d";
import { lbm3dSolidMaskFromGrid } from "./occupancy-3d";
import { lbm3dCompileAxis } from "./rotation-3d";

/** The demo-sized paddle-rotor domain, mm (the fan-3d paddle shape). */
const PADDLE_DOMAIN = {
  min: [0, 0, 0] as const,
  max: [14, 9, 9] as const,
  resolutionMm: 1,
};

/** The axis the paddle spins about (the domain's x centreline). */
const PADDLE_AXIS = {
  point: [7, 4, 4] as const,
  direction: [1, 0, 0] as const,
  zoneRadiusMm: 4,
};

/** The paddle rotor as merged boxes: a hub plus two cross-bars. */
const PADDLE_ROTOR = mergedTessellationWire([
  boxTessellationWire([6, 3, 3], [8, 5, 5]),
  boxTessellationWire([6.4, 1, 3.4], [7.6, 7, 4.6]),
  boxTessellationWire([6.4, 3.4, 1], [7.6, 4.6, 7]),
]);

/** A serialized dc-brushed motor record in the document's wire form. */
function demoMotorRecord(
  stallTorqueMNm: number,
  noLoadSpeedRpm: number,
  nominalVoltageV: number,
): Record<string, unknown> {
  return {
    id: "mtr_demo",
    name: "demo fan motor",
    kind: "dc-brushed",
    stallTorqueMNm,
    noLoadSpeedRpm,
    nominalVoltageV,
  };
}

/** The fan scenario record (motor-driven MRF unless overridden). */
function fanScenario(overrides?: {
  readonly rotationKind?: "mrf" | "resolved-rotation";
  readonly rpmMode?: "fixed" | "motor";
  readonly fixedRpm?: number;
  readonly boundaryTreatment?: string;
  readonly gridConvergence?: boolean;
  readonly motorId?: string | null;
  readonly stepBudget?: number;
}): Record<string, unknown> {
  const rpmMode = overrides?.rpmMode ?? "motor";
  return {
    name: "fan-in-tube",
    kind: "flow",
    domain: {
      kind: "explicit",
      min: [...PADDLE_DOMAIN.min],
      max: [...PADDLE_DOMAIN.max],
      resolutionMm: PADDLE_DOMAIN.resolutionMm,
    },
    conditions: [
      {
        kind: "velocity-inlet",
        face: "xMin",
        speedMPerS: 0.075,
        direction: [1, 0, 0],
      },
    ],
    fluid: "air",
    stepBudget: overrides?.stepBudget ?? 40,
    ...(overrides?.gridConvergence === undefined
      ? {}
      : { gridConvergence: overrides.gridConvergence }),
    flow3d: {
      ...(overrides?.boundaryTreatment === undefined
        ? {}
        : { boundaryTreatment: overrides.boundaryTreatment }),
      rotation: {
        kind: overrides?.rotationKind ?? "mrf",
        axisPointMm: [...PADDLE_AXIS.point],
        axisDirection: [...PADDLE_AXIS.direction],
        zoneRadiusMm: PADDLE_AXIS.zoneRadiusMm,
        rpmMode,
        ...(rpmMode === "fixed"
          ? { fixedRpm: overrides?.fixedRpm ?? 600 }
          : {}),
        bladeCount: 4,
      },
    },
    ...(overrides?.motorId === null
      ? {}
      : { motorId: overrides?.motorId ?? "mtr_demo" }),
  };
}

/**
 * Compiles the fan scenario with its rotor tessellation and motor:
 * `motor: null` sends NO motor record across the compile wire (the
 * without-a-selection declines), anything else sends the record.
 */
function compileFan(overrides?: {
  readonly scenario?: Record<string, unknown>;
  readonly motor?: Record<string, unknown> | null;
  readonly tessellation?: unknown;
}) {
  return compileSimScenarioWithGeometry({
    scenario: overrides?.scenario ?? fanScenario(),
    ...(overrides?.motor === null
      ? {}
      : { motor: overrides?.motor ?? demoMotorRecord(4e-6, 573, 6) }),
    tessellation:
      overrides?.tessellation === undefined
        ? PADDLE_ROTOR
        : overrides.tessellation,
  });
}

/** Runs the 3D engine over a compiled problem, recording emissions. */
async function run3d(compiled: CompiledSimScenario): Promise<{
  readonly result:
    | { readonly ok: true; readonly value: SimResult }
    | { readonly ok: false; readonly code: string; readonly message: string };
  readonly progress: readonly SimEngineProgress[];
  readonly chunks: readonly SimEngineFieldChunk[];
}> {
  const progress: SimEngineProgress[] = [];
  const chunks: SimEngineFieldChunk[] = [];
  const engine = createFlow3dSimEngine();
  const run = await engine.run(
    { compiled },
    (entry) => progress.push(entry),
    (chunk) => chunks.push(chunk),
  );
  return {
    result: run.ok
      ? { ok: true, value: run.value }
      : { ok: false, code: run.error.code, message: run.error.message },
    progress,
    chunks,
  };
}

/** The value or a loud fixture bug — never undefined flowing on. */
function mustExist<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) {
    throw new Error("a fixture value the test required was absent");
  }
  return value;
}

/** Reads one quantity off a completed result's summary. */
function quantityOf(result: SimResult, name: string): number {
  const found = result.summary.quantities.find((entry) => entry.name === name);
  if (found === undefined) {
    throw new Error(`the result carries no "${name}" quantity`);
  }
  return found.value;
}

// ---------------------------------------------------------------------------
// The static 3D door
// ---------------------------------------------------------------------------

describe("the static 3D door", () => {
  const scenario: Record<string, unknown> = {
    name: "box-crossing",
    kind: "flow",
    domain: {
      kind: "explicit",
      min: [0, 0, 0],
      max: [16, 8, 8],
      resolutionMm: 1,
    },
    conditions: [
      {
        kind: "velocity-inlet",
        face: "xMin",
        speedMPerS: 0.005,
        direction: [1, 0, 0],
      },
    ],
    fluid: "air",
    stepBudget: 20,
    flow3d: {},
  };

  it("runs the 66a oracle over the full-3D grid with 3D fields", async () => {
    const compiled = compileSimScenarioWithGeometry({
      scenario,
      tessellation: boxTessellationWire([7, 3, 3], [9, 5, 5]),
    });
    if (!compiled.ok) throw new Error(compiled.error.message);
    expect(compiled.value.flow3d).toBeDefined();
    expect(compiled.value.occupancy3d?.shape).toEqual([17, 9, 9]);
    expect(compiled.value.occupancySlice).toBeUndefined();
    const run = await run3d(compiled.value);
    if (!run.result.ok) throw new Error(run.result.message);
    const result = run.result.value;
    expect(result.summary.status).toBe("completed");
    expect(result.summary.servedBackend).toBe("cpu");
    expect(quantityOf(result, "steps")).toBe(20);
    // The persisted fields are full-3D blocks (the x-fastest extents).
    const speed = result.fields.find((field) => field.id === "speed");
    expect(speed?.extent).toEqual([17, 9, 9]);
    // The force histories: three per-step series.
    expect(result.histories).toHaveLength(3);
    expect(result.histories[0]?.samples).toHaveLength(20);
    // The preview rounds published (S6's chunk stream).
    expect(run.chunks.length).toBeGreaterThan(0);
    // Determinism (law S2): the identical summary on the repeat run.
    const repeat = await run3d(compiled.value);
    if (!repeat.result.ok) throw new Error(repeat.result.message);
    expect(repeat.result.value.summary).toEqual(result.summary);
  });

  it("declines a domain without a velocity inlet", async () => {
    const noInlet = compileSimScenarioWithGeometry({
      scenario: {
        ...scenario,
        conditions: [{ kind: "wall", face: "xMin", slip: false }],
      },
      tessellation: boxTessellationWire([7, 3, 3], [9, 5, 5]),
    });
    if (!noInlet.ok) throw new Error(noInlet.error.message);
    const run = await run3d(noInlet.value);
    expect(run.result.ok).toBe(false);
    if (run.result.ok) return;
    expect(run.result.message).toContain("velocity-inlet");
  });
});

// ---------------------------------------------------------------------------
// The routing honesty
// ---------------------------------------------------------------------------

describe("the 3D routing honesty", () => {
  it("the 2D engine declines a 3D-authored scenario loudly", async () => {
    const compiled = compileFan();
    if (!compiled.ok) throw new Error(compiled.error.message);
    const run = await createLbmSimEngine().run({ compiled: compiled.value });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.code).toBe("sim/geometry-unavailable");
    expect(run.error.message).toContain("3D stance");
  });

  it("the 3D engine declines a slice-only scenario loudly", async () => {
    const compiled = compileSimScenarioWithGeometry({
      scenario: {
        name: "slice-only",
        kind: "flow",
        domain: {
          kind: "explicit",
          min: [0, 0, 0],
          max: [16, 8, 8],
          resolutionMm: 1,
        },
        conditions: [
          {
            kind: "velocity-inlet",
            face: "xMin",
            speedMPerS: 0.005,
            direction: [1, 0, 0],
          },
        ],
        fluid: "air",
        stepBudget: 20,
      },
      tessellation: boxTessellationWire([7, 3, 3], [9, 5, 5]),
    });
    if (!compiled.ok) throw new Error(compiled.error.message);
    const run = await createFlow3dSimEngine().run({
      compiled: compiled.value,
    });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.message).toContain("2D wind tunnel");
  });

  it("the routed default engine serves the 3D stance on the CPU oracle", async () => {
    const compiled = compileFan({
      scenario: fanScenario({ rpmMode: "fixed", fixedRpm: 600, motorId: null }),
    });
    if (!compiled.ok) throw new Error(compiled.error.message);
    const run = await createDefaultSimEngine().run({
      compiled: compiled.value,
    });
    if (!run.ok) throw new Error(run.error.message);
    expect(run.value.summary.servedBackend).toBe("cpu");
    expect(
      run.value.fields.find((field) => field.id === "speed"),
    ).toBeDefined();
  });

  it("a direct gpu-preferred call to the 3D engine declines", async () => {
    const compiled = compileFan({
      scenario: {
        ...fanScenario({ stepBudget: 20 }),
        backend: "gpu",
      },
    });
    if (!compiled.ok) throw new Error(compiled.error.message);
    const run = await createFlow3dSimEngine().run({
      compiled: compiled.value,
    });
    expect(run.ok).toBe(false);
    if (run.ok) return;
    expect(run.error.code).toBe("sim/backend-unavailable");
  });

  it("the engine declares its id and kinds honestly", () => {
    const engine = createFlow3dSimEngine();
    expect(engine.id).toBe(LBM3D_SIM_ENGINE_ID);
    expect(engine.backend).toBe("cpu");
    expect(engine.supportedKinds).toEqual(["flow"]);
  });
});

// ---------------------------------------------------------------------------
// The compile door's declines
// ---------------------------------------------------------------------------

describe("the flow3d compile declines", () => {
  it("declines the reserved cut-cell treatment loudly", () => {
    const compiled = compileFan({
      scenario: fanScenario({ boundaryTreatment: "cut-cell" }),
    });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.error.code).toBe("sim/boundary-treatment-unsupported");
    expect(compiled.error.message).toContain("cut-cell decision");
  });

  it("declines a motor-driven stance without a motor selection", () => {
    const compiled = compileFan({
      scenario: fanScenario({ motorId: null }),
      motor: null,
    });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.error.code).toBe("sim/motor-invalid");
    expect(compiled.error.message).toContain("motor-driven");
  });

  it("declines the 3D grid-convergence flag (not in 66c's surface)", () => {
    const compiled = compileFan({
      scenario: fanScenario({ gridConvergence: true }),
    });
    expect(compiled.ok).toBe(false);
    if (compiled.ok) return;
    expect(compiled.error.message).toContain("grid-convergence");
  });

  it("keeps the stance kind-locked at the compile door", () => {
    const built = compileSimScenarioWithGeometry({
      scenario: { ...fanScenario(), kind: "thermal" },
      motor: demoMotorRecord(4e-6, 573, 6),
      tessellation: PADDLE_ROTOR,
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.message).toContain("3D flow stance");
  });
});

// ---------------------------------------------------------------------------
// The MRF doors
// ---------------------------------------------------------------------------

describe("the MRF fixed-rpm door", () => {
  it("reports the performance, BPF arithmetic, and the S9 fan Re line", async () => {
    const compiled = compileFan({
      scenario: fanScenario({ rpmMode: "fixed", fixedRpm: 600, motorId: null }),
    });
    if (!compiled.ok) throw new Error(compiled.error.message);
    const run = await run3d(compiled.value);
    if (!run.result.ok) throw new Error(run.result.message);
    const result = run.result.value;
    expect(result.summary.status).toBe("completed");
    const rpm = 600;
    expect(quantityOf(result, "shaft-speed")).toBeCloseTo(
      (rpm * 2 * Math.PI) / 60,
      9,
    );
    // BPF = blades × rpm / 60 — arithmetic from the authored pair.
    expect(quantityOf(result, "blade-pass-frequency")).toBeCloseTo(
      (4 * rpm) / 60,
      9,
    );
    // The S9 guidance line: the tiny rotor is deep in the low-Re band,
    // and the qualitative flag says so on the summary's regime record.
    expect(quantityOf(result, "fan-reynolds-tip")).toBeGreaterThan(0);
    expect(quantityOf(result, "fan-reynolds-tip")).toBeLessThan(1e4);
    expect(result.summary.regime.qualitative).toContain("low-reynolds-fan");
    // The performance extraction at the fixed speed.
    expect(Number.isFinite(quantityOf(result, "airflow"))).toBe(true);
    expect(Number.isFinite(quantityOf(result, "pressure-rise"))).toBe(true);
    // The force + torque histories: four per-step series.
    expect(result.histories).toHaveLength(4);
    expect(result.histories[3]?.samples).toHaveLength(40);
  }, 60_000);
});

describe("the MRF motor-driven door (the operating point)", () => {
  // The demo motor: stall 4e-6 mN·m = 4e-9 N·m (the record's mN·m
  // field, / 1000 for the engine's N·m — the fan-demo twin's own
  // conversion), no-load 573 rpm ≈ 60 rad/s — the paddle's aero load
  // crosses the line inside the engine's ladder.
  const MOTOR = demoMotorRecord(4e-6, 573, 6);
  const NO_LOAD_RAD_PER_S = (573 * 2 * Math.PI) / 60;
  const LADDER = FLOW3D_LADDER_FRACTIONS.map(
    (fraction) => fraction * NO_LOAD_RAD_PER_S,
  );

  it("finds the operating point and reports the full output family", async () => {
    const compiled = compileFan({ motor: MOTOR });
    if (!compiled.ok) throw new Error(compiled.error.message);
    const run = await run3d(compiled.value);
    if (!run.result.ok) throw new Error(run.result.message);
    const result = run.result.value;
    expect(result.summary.status).toBe("completed");

    // FOUND, not assumed: the operating point sits strictly inside the
    // ladder's span, at a positive torque.
    const omega = quantityOf(result, "operating-speed");
    expect(omega).toBeGreaterThan(LADDER[0] ?? 0);
    expect(omega).toBeLessThan(LADDER[LADDER.length - 1] ?? 0);
    const torque = quantityOf(result, "operating-torque");
    expect(torque).toBeGreaterThan(0);
    expect(quantityOf(result, "operating-rpm")).toBeCloseTo(
      (omega * 60) / (2 * Math.PI),
      9,
    );

    // BPF = blades × RPM / 60 — arithmetic from the FOUND point.
    expect(quantityOf(result, "blade-pass-frequency")).toBeCloseTo(
      (4 * quantityOf(result, "operating-rpm")) / 60,
      9,
    );

    // The power identities, exact against the reported point.
    expect(quantityOf(result, "shaft-power")).toBeCloseTo(torque * omega, 15);
    expect(quantityOf(result, "fan-air-power")).toBeCloseTo(
      quantityOf(result, "pressure-rise") * quantityOf(result, "airflow"),
      18,
    );
    // The analytic motor's electrical family: P_elec = V·T/Kt with the
    // compiled Kt (Kv = no-load rpm / nominal V, Kt = 1/(Kv·2π/60)).
    const kt = 1 / ((573 / 6) * ((2 * Math.PI) / 60));
    expect(quantityOf(result, "electrical-power")).toBeCloseTo(
      (6 * torque) / kt,
      12,
    );
    expect(quantityOf(result, "motor-efficiency")).toBeCloseTo(
      quantityOf(result, "shaft-power") /
        quantityOf(result, "electrical-power"),
      9,
    );

    // The verify rung's windowed torque: the solve's cross-check.
    expect(quantityOf(result, "verify-rung-torque")).toBeGreaterThan(0);

    // The published chart's data half: the load and motor series over
    // the SAME uniform ladder, equal lengths, plus the span quantities.
    const load = mustExist(
      result.histories.find((s) => s.name === "load-torque"),
    );
    const motorSeries = mustExist(
      result.histories.find((s) => s.name === "motor-torque"),
    );
    expect(load.unit).toBe("N*m");
    expect(motorSeries.samples).toHaveLength(load.samples.length);
    expect(load.samples).toHaveLength(LADDER.length);
    expect(quantityOf(result, "ladder-min-speed")).toBeCloseTo(
      LADDER[0] ?? 0,
      9,
    );
    expect(quantityOf(result, "ladder-max-speed")).toBeCloseTo(
      LADDER[LADDER.length - 1] ?? 0,
      9,
    );
    // The motor series IS the motor line at the rungs (its last rung is
    // the no-load speed, where the analytic line reaches zero).
    expect(
      motorSeries.samples[motorSeries.samples.length - 1] ?? 1,
    ).toBeCloseTo(0, 15);
    // The verify rung streamed preview rounds (S6) and the persisted
    // speed field is the operating-point solution's.
    expect(run.chunks.length).toBeGreaterThan(0);
    const speed = result.fields.find((field) => field.id === "speed");
    expect(speed?.extent).toEqual([15, 10, 10]);
  }, 120_000);

  it("cross-checks the found point against fan-3d's own analysis", async () => {
    // The engine's rung protocol mirrors fan-3d's; the same ladder and
    // motor MUST find the same operating speed through both doors.
    const compiled = compileFan({ motor: MOTOR });
    if (!compiled.ok) throw new Error(compiled.error.message);
    const run = await run3d(compiled.value);
    if (!run.result.ok) throw new Error(run.result.message);
    const engineOmega = quantityOf(run.result.value, "operating-speed");

    const grid = compiled.value.occupancy3d;
    if (grid === undefined) throw new Error("the compile attached no 3D grid");
    const mask = lbm3dSolidMaskFromGrid(grid);
    if (!mask.ok) throw new Error(mask.error.message);
    const rotation = compiled.value.flow3d?.rotation;
    if (rotation === undefined) throw new Error("no compiled rotation");
    const axis = lbm3dCompileAxis(
      { pointM: rotation.axisPointM, direction: rotation.axisDirection },
      [grid.originM[0] ?? 0, grid.originM[1] ?? 0, grid.originM[2] ?? 0],
      compiled.value.cellSizeM,
    );
    if (!axis.ok) throw new Error(axis.error.message);
    const reference = analyzeFanOperatingPoint(
      {
        mrf: {
          mask: mask.value,
          fluid: compiled.value.fluid,
          cellSizeM: compiled.value.cellSizeM,
          characteristicVelocityMPerS: 0.075,
          // The engine's own 3D damping choice (its baseConfig's
          // lattice-velocity knob) — the reference repeats it so both
          // doors step the same closure.
          latticeVelocity: 0.03,
          west: { kind: "velocity-inlet", velocityMPerS: [0.075, 0, 0] },
          east: { kind: "convective-outflow" },
          south: { kind: "wall", slip: false },
          north: { kind: "wall", slip: false },
          bottom: { kind: "wall", slip: false },
          top: { kind: "wall", slip: false },
          rotation: { kind: "mrf" },
          axis: {
            pointM: rotation.axisPointM,
            direction: rotation.axisDirection,
          },
          rotatingZone: mrfCylindricalZonePredicate(
            axis.value,
            rotation.zoneRadiusM / compiled.value.cellSizeM,
          ),
        },
        bladeCount: rotation.bladeCount,
        omegaLadderRadPerS: LADDER,
        stepsPerRung: 40,
        averageWindowSteps: 20,
      },
      mustExist(compiled.value.motor),
    );
    if (!reference.ok) throw new Error(reference.error.message);
    expect(engineOmega).toBeCloseTo(reference.value.solve.omegaRadPerS, 12);
  }, 180_000);

  it("declines the mis-paired motor with the ambiguity code", async () => {
    // A motor far too WEAK for this fan: its torque line sits under the
    // paddle's load at every rung of the engine's ladder, so no
    // intersection exists inside the swept band — the structured
    // decline, never a guessed point.
    const weak = demoMotorRecord(1e-7, 573, 6);
    const compiled = compileFan({ motor: weak });
    if (!compiled.ok) throw new Error(compiled.error.message);
    const run = await run3d(compiled.value);
    expect(run.result.ok).toBe(false);
    if (run.result.ok) return;
    expect(run.result.code).toBe("sim/operating-point-ambiguous");
  }, 120_000);
});

// ---------------------------------------------------------------------------
// The resolved-rotation door
// ---------------------------------------------------------------------------

describe("the resolved-rotation door (the showcase)", () => {
  it("completes a fixed-rate run with the mean/fluctuation split", async () => {
    const compiled = compileFan({
      scenario: fanScenario({
        rotationKind: "resolved-rotation",
        rpmMode: "fixed",
        fixedRpm: 300,
        motorId: null,
      }),
    });
    if (!compiled.ok) throw new Error(compiled.error.message);
    const run = await run3d(compiled.value);
    if (!run.result.ok) throw new Error(run.result.message);
    const result = run.result.value;
    expect(result.summary.status).toBe("completed");
    // The S9 split: a mean rotor torque AND an RMS fluctuation about it
    // (the resolved rotor sheds an unsteady wake — that is its point).
    expect(quantityOf(result, "mean-rotor-torque")).toBeGreaterThan(0);
    expect(quantityOf(result, "rotor-torque-fluctuation-rms")).toBeGreaterThan(
      0,
    );
    expect(quantityOf(result, "steps-per-revolution")).toBeGreaterThan(0);
    expect(quantityOf(result, "blade-pass-frequency")).toBeCloseTo(
      (4 * 300) / 60,
      9,
    );
    // The showcase streamed its preview rounds too (S6).
    expect(run.chunks.length).toBeGreaterThan(0);
  }, 60_000);

  it("declines the motor-driven pairing loudly (Phase 67's carve)", async () => {
    const compiled = compileFan({
      scenario: fanScenario({ rotationKind: "resolved-rotation" }),
    });
    if (!compiled.ok) throw new Error(compiled.error.message);
    const run = await run3d(compiled.value);
    expect(run.result.ok).toBe(false);
    if (run.result.ok) return;
    expect(run.result.message).toContain("Phase 67");
  });
});
