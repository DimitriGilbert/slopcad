/**
 * Units boundary tests (law S4): the document-mm ↔ solver-SI conversions
 * live in exactly the two functions — scenario compile (document →
 * solver) and result projection (solver → document, explicit units on
 * every projected quantity) — and the motor record's authored datasheet
 * units (mN·m, rpm) become SI ONLY here.
 */

import { describe, expect, it } from "vitest";

import { SIM_ERROR_CODES } from "./errors";
import {
  type SimCompileInput,
  compileSimScenario,
  projectSimResult,
} from "./units";
import { simScenarioSnapshotHash } from "./snapshot";

function requireOk<T, E extends { readonly message: string }>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(
      `The compile test rejected ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

/** A serialized flow scenario over an explicit 1000×500×500 mm domain. */
function flowScenario(): Record<string, unknown> {
  return {
    id: "sim_000001",
    name: "Wind tunnel",
    kind: "flow",
    domain: {
      kind: "explicit",
      min: [-500, -250, -250],
      max: [500, 250, 250],
      resolutionMm: 2,
    },
    conditions: [
      {
        kind: "velocity-inlet",
        face: "xMin",
        speedMPerS: 10,
        direction: [1, 0, 0],
      },
      { kind: "pressure-outlet", face: "xMax", pressurePa: 0 },
      { kind: "wall", face: "yMin", slip: false },
      { kind: "symmetry", face: "yMax" },
    ],
    fluid: "air",
    materials: [],
    gravityMPerS2: [0, -9.80665, 0],
  };
}

describe("scenario compile (document → solver)", () => {
  it("converts the domain from document millimetres to SI metres", () => {
    const compiled = requireOk(
      compileSimScenario({ scenario: flowScenario() }),
      "the wind-tunnel compile",
    );
    expect(compiled.domainMinM).toEqual([-0.5, -0.25, -0.25]);
    expect(compiled.domainMaxM).toEqual([0.5, 0.25, 0.25]);
    expect(compiled.cellSizeM).toBeCloseTo(0.002, 12);
  });

  it("reports the hand-computed Re, Ma, and Pr against the air fits", () => {
    const compiled = requireOk(
      compileSimScenario({ scenario: flowScenario() }),
      "the wind-tunnel compile",
    );
    // L = the domain's smallest extent = 0.5 m; air at 300 K:
    // Re = 1.176472549·10·0.5/1.845921383e-5 = 318668.108
    expect(compiled.regime.reynolds).toBeCloseTo(318668.107926, 3);
    // Ma = 10/347.2
    expect(compiled.regime.mach).toBeCloseTo(0.028801843318, 9);
    // Pr = 1.845921383e-5·1006/0.0263
    expect(compiled.regime.prandtl).toBeCloseTo(0.706082475779, 9);
    // Re > 4000: the advisory turbulence flag rides, the run proceeds.
    expect(compiled.regime.qualitative).toEqual(["turbulence-dominated"]);
  });

  it("scales Ra by the largest temperature magnitude, colder wall first", () => {
    // Air at 300 K over the same explicit domain (L = 0.5 m):
    // ν = 1.5690305605e-5 m²/s, α = 2.2221632944e-5 m²/s, so
    // Ra(ΔT = 20 K) = 9.80665·(1/300)·20·0.5³/(ν·α) = 234386210.381
    // and Ra(ΔT = 5 K) = 58596552.595 — Ra is linear in the magnitude.
    const thermalScenario = (wallTemperaturesK: number[]) => ({
      ...flowScenario(),
      kind: "thermal" as const,
      conditions: wallTemperaturesK.map((temperatureK, index) => ({
        kind: "fixed-temperature" as const,
        face: index === 0 ? ("yMin" as const) : ("yMax" as const),
        temperatureK,
      })),
    });
    const colderFirst = requireOk(
      compileSimScenario({ scenario: thermalScenario([280, 305]) }),
      "the colder-first thermal compile",
    );
    expect(colderFirst.regime.rayleigh).toBeCloseTo(234386210.3805734, 3);
    expect(colderFirst.regime.qualitative).toEqual([]);
    // A −20 K wall followed by a +5 K wall must scale by 20 K (4× the
    // warm-only run) — never by the signed first delta, whose 5 K would
    // under-report Ra fourfold.
    const warmOnly = requireOk(
      compileSimScenario({ scenario: thermalScenario([305]) }),
      "the warm-only thermal compile",
    );
    expect(warmOnly.regime.rayleigh).toBeCloseTo(58596552.59514335, 3);
    expect(colderFirst.regime.rayleigh ?? 0).toBeCloseTo(
      (warmOnly.regime.rayleigh ?? 0) * 4,
      3,
    );
  });

  it("normalizes the inlet direction and carries the SI velocity vector", () => {
    const scenario = flowScenario();
    const conditions = scenario.conditions as { direction: number[] }[];
    conditions[0]!.direction = [2, 0, 0];
    const compiled = requireOk(
      compileSimScenario({ scenario }),
      "the normalized-inlet compile",
    );
    expect(compiled.conditions[0]?.velocityMPerS).toEqual([10, 0, 0]);
  });

  it("defaults gravity to standard gravity −Y when the field is absent", () => {
    const scenario = flowScenario();
    delete scenario.gravityMPerS2;
    const compiled = requireOk(
      compileSimScenario({ scenario }),
      "the default-gravity compile",
    );
    expect(compiled.gravityMPerS2).toEqual([0, -9.80665, 0]);
  });

  it("resolves body-derived domains from the supplied geometry bounds", () => {
    const input: SimCompileInput = {
      scenario: {
        id: "sim_000002",
        name: "Around the part",
        kind: "flow",
        domain: {
          kind: "body",
          bodyIds: ["body_000001"],
          marginMm: 25,
          resolutionMm: 1,
        },
        conditions: [],
        fluid: "water",
        materials: [],
      },
      bodyBounds: [
        {
          bodyId: "body_000001",
          minMm: [0, 0, 0],
          maxMm: [100, 50, 50],
        },
      ],
    };
    const compiled = requireOk(
      compileSimScenario(input),
      "the body-derived compile",
    );
    expect(compiled.domainMinM).toEqual([-0.025, -0.025, -0.025]);
    expect(compiled.domainMaxM).toEqual([0.125, 0.075, 0.075]);
    expect(compiled.fluid.fluidId).toBe("water");
  });

  it("declines a body-derived domain without geometry as unavailable", () => {
    const result = compileSimScenario({
      scenario: {
        name: "Around the part",
        kind: "flow",
        domain: {
          kind: "body",
          bodyIds: ["body_000001"],
          marginMm: 25,
          resolutionMm: 1,
        },
        conditions: [],
        fluid: "air",
        materials: [],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(SIM_ERROR_CODES.geometryUnavailable);
  });

  it("declines the structural kind loudly (the Phase 69 carve)", () => {
    const scenario = flowScenario();
    scenario.kind = "structural";
    const result = compileSimScenario({ scenario });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(SIM_ERROR_CODES.scenarioKindUnsupported);
  });

  it("declines unknown fluids and malformed scenarios", () => {
    const unknownFluid = flowScenario();
    unknownFluid.fluid = "unobtanium";
    const fluidResult = compileSimScenario({ scenario: unknownFluid });
    expect(fluidResult.ok).toBe(false);
    if (fluidResult.ok) return;
    expect(fluidResult.error.code).toBe(SIM_ERROR_CODES.fluidUnknown);

    const malformed = compileSimScenario({ scenario: { name: 7 } });
    expect(malformed.ok).toBe(false);
    if (malformed.ok) return;
    expect(malformed.error.code).toBe(SIM_ERROR_CODES.scenarioInvalid);
  });

  it("carries the scenario-snapshot hash onto the compiled scenario", () => {
    const scenario = flowScenario();
    const compiled = requireOk(
      compileSimScenario({ scenario }),
      "the hashed compile",
    );
    const direct = requireOk(
      simScenarioSnapshotHash(scenario),
      "the direct hash",
    );
    expect(compiled.scenarioSnapshotHash).toBe(direct);
  });

  it("passes the gpu backend preference through, defaulting to cpu", () => {
    const cpu = requireOk(
      compileSimScenario({ scenario: flowScenario() }),
      "the cpu compile",
    );
    expect(cpu.backend).toBe("cpu");
    const gpuScenario = flowScenario();
    gpuScenario.backend = "gpu";
    const gpu = requireOk(
      compileSimScenario({ scenario: gpuScenario }),
      "the gpu compile",
    );
    expect(gpu.backend).toBe("gpu");
  });
});

describe("motor unit honesty (authored mN·m / rpm → SI, only here)", () => {
  const motor = {
    id: "mot_000001",
    name: "Fan drive",
    kind: "dc-brushed",
    stallTorqueMNm: 100,
    noLoadSpeedRpm: 6000,
    nominalVoltageV: 12,
    rotorInertiaKgM2: 1.2e-5,
  };

  function scenarioWithMotor(): Record<string, unknown> {
    return { ...flowScenario(), motorId: "mot_000001" };
  }

  it("converts the linear trio to SI at the boundary", () => {
    const compiled = requireOk(
      compileSimScenario({ scenario: scenarioWithMotor(), motor }),
      "the motor compile",
    );
    expect(compiled.motor).toBeDefined();
    if (compiled.motor === undefined) return;
    expect(compiled.motor.kind).toBe("dc-brushed");
    if (compiled.motor.kind === "tabulated") {
      throw new Error("The analytic motor compiled to a table.");
    }
    // 100 mN·m = 0.1 N·m — the only conversion site.
    expect(compiled.motor.stallTorqueNPerM).toBeCloseTo(0.1, 12);
    // 6000 rpm = 6000·2π/60 rad/s.
    expect(compiled.motor.noLoadSpeedRadPerS).toBeCloseTo(628.318530718, 8);
    expect(compiled.motor.nominalVoltageV).toBe(12);
    expect(compiled.motor.rotorInertiaKgM2).toBe(1.2e-5);
    // The derived authoring views: Kv = 6000/12 rpm/V and
    // Kt = 1/(Kv·2π/60) from the ideal-motor identity.
    expect(compiled.motor.kvRpmPerV).toBeCloseTo(500, 10);
    expect(compiled.motor.ktNPerA).toBeCloseTo(0.019098593171, 10);
  });

  it("converts tabulated points to SI keeping their declaration order", () => {
    const compiled = requireOk(
      compileSimScenario({
        scenario: scenarioWithMotor(),
        motor: {
          id: "mot_000001",
          name: "Measured fan drive",
          kind: "tabulated",
          points: [
            { speedRpm: 0, torqueMNm: 80 },
            { speedRpm: 3000, torqueMNm: 40 },
            { speedRpm: 6000, torqueMNm: 0 },
          ],
        },
      }),
      "the tabulated compile",
    );
    expect(compiled.motor).toBeDefined();
    if (compiled.motor === undefined || compiled.motor.kind !== "tabulated") {
      throw new Error("The tabulated motor did not compile to a table.");
    }
    expect(compiled.motor.points).toHaveLength(3);
    expect(compiled.motor.points[0]?.torqueNPerM).toBeCloseTo(0.08, 12);
    expect(compiled.motor.points[1]?.speedRadPerS).toBeCloseTo(
      314.159265359,
      8,
    );
    expect(compiled.motor.points[2]?.torqueNPerM).toBe(0);
  });

  it("declines a motor payload that does not match the selection", () => {
    const mismatched = compileSimScenario({
      scenario: scenarioWithMotor(),
      motor: { ...motor, id: "mot_000999" },
    });
    expect(mismatched.ok).toBe(false);
    if (mismatched.ok) return;
    expect(mismatched.error.code).toBe(SIM_ERROR_CODES.motorInvalid);

    const absent = compileSimScenario({
      scenario: scenarioWithMotor(),
    });
    expect(absent.ok).toBe(false);
    if (absent.ok) return;
    expect(absent.error.code).toBe(SIM_ERROR_CODES.motorInvalid);
  });

  it("keeps the motor's presence out of motor-less scenarios", () => {
    const compiled = requireOk(
      compileSimScenario({ scenario: flowScenario(), motor }),
      "the motor-less compile",
    );
    expect(compiled.motor).toBeUndefined();
  });
});

describe("result projection (solver → document)", () => {
  it("converts lengths to millimetres and stamps explicit units", () => {
    const projected = requireOk(
      projectSimResult({
        scalars: [
          { name: "drag", dimension: "force", value: 1.25 },
          { name: "tipDeflection", dimension: "length", value: 0.0032 },
          { name: "maxTemperature", dimension: "temperature", value: 355.4 },
          { name: "liftOverDrag", dimension: "dimensionless", value: 2.5 },
        ],
        fields: [],
      }),
      "the projection",
    );
    expect(projected.scalars).toEqual([
      { name: "drag", value: 1.25, unit: "N" },
      { name: "tipDeflection", value: 3.2, unit: "mm" },
      { name: "maxTemperature", value: 355.4, unit: "K" },
      { name: "liftOverDrag", value: 2.5, unit: "1" },
    ]);
  });

  it("projects field geometry from metres to millimetres", () => {
    const projected = requireOk(
      projectSimResult({
        scalars: [],
        fields: [
          {
            id: "velocityMagnitude",
            unit: "m/s",
            extent: [2, 1, 1],
            originM: [0, 0, 0],
            spacingM: [0.001, 0.001, 0.001],
            dataType: "float64",
            values: [1, 2],
            dimension: "velocity",
          },
        ],
      }),
      "the field projection",
    );
    const field = projected.fields[0];
    expect(field?.originMm).toEqual([0, 0, 0]);
    expect(field?.spacingMm).toEqual([1, 1, 1]);
    // Velocity projects to mm/s: 1 m/s → 1000 mm/s.
    expect(field?.values).toEqual([1000, 2000]);
  });

  it("declines non-finite projected quantities", () => {
    const result = projectSimResult({
      scalars: [{ name: "drag", dimension: "force", value: Number.NaN }],
      fields: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(SIM_ERROR_CODES.quantityInvalid);
  });

  it("declines a field whose extent and value count disagree", () => {
    const result = projectSimResult({
      scalars: [],
      fields: [
        {
          id: "temperature",
          extent: [2, 2, 1],
          originM: [0, 0, 0],
          spacingM: [1, 1, 1],
          dataType: "float64",
          values: [300, 301, 302],
          dimension: "temperature",
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe(SIM_ERROR_CODES.quantityInvalid);
  });
});
