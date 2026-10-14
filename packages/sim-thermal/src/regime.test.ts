/**
 * The S9 regime pins (law S9): Prandtl ALWAYS — computed from the same
 * sim-core function the compile boundary uses — and Rayleigh whenever
 * the buoyancy gate's inputs exist, with the ΔT magnitude rule EXACTLY
 * the 61a compile boundary's (verified by running the REAL compile
 * boundary on the same scenario and comparing numbers bitwise).
 */

import { describe, expect, it } from "vitest";
import {
  SIM_FLUID_AIR,
  compileSimScenario,
  simPrandtl,
  simRayleigh,
  simFluidState,
} from "@slopcad/sim-core";
import type { ThermalRunScenario } from "./run";

import { thermalSolidMaterialFromRecord } from "./material";
import { runThermalScenario } from "./run";
import {
  STEEL_WIRE,
  analyticGrid,
  testFluid,
  uniformMaterialIndex,
} from "./fixtures";

function scenario(
  materials: ThermalRunScenario["materials"],
  overrides: Partial<ThermalRunScenario> = {},
): ThermalRunScenario {
  const grid = analyticGrid([8, 1, 1], 0.01, () => true, "regime-rod");
  return {
    name: "regime",
    grid,
    materials,
    cellMaterialIndex: uniformMaterialIndex(grid, 1),
    fluid: testFluid(),
    radiationMode: "off",
    characteristicLengthM: 0.1,
    mode: { kind: "steady", toleranceK: 1e-11 },
    conditions: [
      { kind: "fixed-temperature", face: "xMin", temperatureK: 360 },
    ],
    ...overrides,
  };
}

/** The parsed steel record, loudly (the fixtures' wire form). */
function steelOrThrow(): ThermalRunScenario["materials"][number] {
  const parsed = thermalSolidMaterialFromRecord(STEEL_WIRE);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

describe("S9 regime wiring", () => {
  it("reports Prandtl always, from the sim-core function", () => {
    const run = runThermalScenario(scenario([steelOrThrow()]));
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const fluid = testFluid();
    expect(run.value.regime.prandtl).toBe(
      simPrandtl(
        fluid.dynamicViscosityPaS,
        fluid.specificHeatJPerKgK,
        fluid.thermalConductivityWPerMK,
      ),
    );
  });

  it("reports Rayleigh under the 61a magnitude rule (the largest |ΔT| wins)", () => {
    const run = runThermalScenario(
      scenario([steelOrThrow()], {
        conditions: [
          // A colder-than-fluid wall ordered FIRST: |293.15 − 300| = 6.85
          // must not shrink the later warm wall's |360 − 300| = 60.
          {
            kind: "convection-ambient",
            face: "xMax",
            heatTransferCoefficientWPerM2K: 5,
            ambientTemperatureK: 293.15,
          },
          { kind: "fixed-temperature", face: "xMin", temperatureK: 360 },
        ],
      }),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const fluid = testFluid();
    const expected = simRayleigh(
      9.80665,
      fluid.thermalExpansionPerK,
      60,
      0.1,
      fluid.kinematicViscosityM2PerS,
      fluid.thermalDiffusivityM2PerS,
    );
    expect(run.value.regime.rayleigh).toBe(expected);
    // Sub-critical: no buoyancy flag.
    expect(run.value.regime.qualitative).not.toContain("buoyancy-driven");
  });

  it("matches the 61a compile boundary's report bitwise on the same scenario", () => {
    // The serialized thermal scenario the compile boundary consumes —
    // the same conditions and fluid the run scenario carries.
    const serialized = {
      name: "compile-pin",
      kind: "thermal",
      domain: {
        kind: "explicit",
        min: [0, 0, 0],
        max: [80, 10, 10],
        resolutionMm: 10,
      },
      fluid: "air",
      conditions: [
        { kind: "fixed-temperature", face: "xMin", temperatureK: 360 },
        {
          kind: "convection-ambient",
          face: "xMax",
          heatTransferCoefficientWPerM2K: 5,
          ambientTemperatureK: 293.15,
        },
      ],
    };
    const compiled = compileSimScenario({ scenario: serialized });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.regime.rayleigh).toBeDefined();
    expect(compiled.value.regime.prandtl).toBeDefined();

    // The run driver with the SAME fluid state the compile boundary
    // evaluated (air at its reference temperature) and the compile's own
    // characteristic length — the numbers must be the same floats.
    const air = simFluidState(SIM_FLUID_AIR, SIM_FLUID_AIR.referenceK);
    if (!air.ok) throw new Error(air.error.message);
    const run = runThermalScenario(
      scenario([steelOrThrow()], {
        fluid: air.value,
        characteristicLengthM: compiled.value.characteristicLengthM,
        conditions: [
          { kind: "fixed-temperature", face: "xMin", temperatureK: 360 },
          {
            kind: "convection-ambient",
            face: "xMax",
            heatTransferCoefficientWPerM2K: 5,
            ambientTemperatureK: 293.15,
          },
        ],
      }),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.value.regime.prandtl).toBe(compiled.value.regime.prandtl);
    expect(run.value.regime.rayleigh).toBe(compiled.value.regime.rayleigh);
  });

  it("raises the buoyancy-driven flag above the advisory Ra threshold", () => {
    const run = runThermalScenario(
      scenario([steelOrThrow()], {
        characteristicLengthM: 0.5,
        conditions: [
          { kind: "fixed-temperature", face: "xMin", temperatureK: 500 },
        ],
      }),
    );
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const fluid = testFluid();
    const expected = simRayleigh(
      9.80665,
      fluid.thermalExpansionPerK,
      200,
      0.5,
      fluid.kinematicViscosityM2PerS,
      fluid.thermalDiffusivityM2PerS,
    );
    expect(run.value.regime.rayleigh).toBe(expected);
    expect(expected).toBeGreaterThan(1e9);
    expect(run.value.regime.qualitative).toContain("buoyancy-driven");
  });

  it("omits Rayleigh without a temperature-difference scale or gravity", () => {
    // No temperature-bearing condition: the ambient spec's T_amb is not
    // a ΔT candidate under the 61a rule (the rule reads conditions
    // only), so a body in ambient air with no fixed-T condition reports
    // Pr without Ra — the 65b record shape threads ambient ΔT through
    // conditions when the coupling needs it.
    const noDelta = runThermalScenario(
      scenario([steelOrThrow()], {
        conditions: [],
        ambient: {
          heatTransferCoefficientWPerM2K: 10,
          ambientTemperatureK: 293.15,
        },
        sourceWPerM3: new Float64Array(8),
      }),
    );
    expect(noDelta.ok).toBe(true);
    if (!noDelta.ok) return;
    expect(noDelta.value.regime.rayleigh).toBeUndefined();

    const noGravity = runThermalScenario(
      scenario([steelOrThrow()], {
        gravityMPerS2: [0, 0, 0],
      }),
    );
    expect(noGravity.ok).toBe(true);
    if (!noGravity.ok) return;
    expect(noGravity.value.regime.rayleigh).toBeUndefined();
    expect(noGravity.value.regime.prandtl).toBeDefined();
  });
});
