/**
 * The geometry-aware compile door's COMBUSTION branch tests (Phase
 * 68c): the mode-locked stance re-validated at the door with the STOVE
 * mode's per-body material map (the 65c voxelization, the same door
 * the thermal branch rides) or the ENGINE mode's slider-crank geometry
 * converted to SI with no voxelization. The truths this file owns:
 *
 * - the engine products convert mm → m HERE (the one S4 site for the
 *   chamber) and attach no occupancy — the 0D chamber has no spatial
 *   domain;
 * - the stove products carry the SAME union slice + material map the
 *   thermal branch builds, beside the re-validated fire stance;
 * - the loud declines: a missing stance, an off-lattice cadence, an
 *   engine fuel without a flame-speed fit, a condition on the engine
 *   mode, and the rod-not-longer-than-crank assembly refusal;
 * - the snapshot hash moves when the stance moves (the provenance law).
 *
 * Node-env vitest, no network — the law-S2/S5 stance.
 */

import { describe, expect, it } from "vitest";

import { compileSimScenarioWithGeometry } from "./compile-geometry";
import { compileSimScenario } from "./units";

/** An aligned box soup in the voxelizer's wire form (the flow fixture's builder). */
function boxTessellationWire(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
): { readonly positions: number[]; readonly indices: number[] } {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  return {
    positions: [
      x0,
      y0,
      z0,
      x1,
      y0,
      z0,
      x1,
      y1,
      z0,
      x0,
      y1,
      z0,
      x0,
      y0,
      z1,
      x1,
      y0,
      z1,
      x1,
      y1,
      z1,
      x0,
      y1,
      z1,
    ],
    indices: [
      0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 2, 6, 3, 6, 7, 0,
      3, 7, 0, 7, 4, 1, 2, 6, 1, 6, 5,
    ],
  };
}

const STEEL = {
  id: "mat_steel",
  name: "Steel",
  densityGPerCm3: 7.8,
  thermalConductivityWPerMK: 45,
  specificHeatJPerKgK: 466,
  emissivity: 0.6,
};

/** The demo bar (the thermal branch's own fixture geometry). */
const BAR = boxTessellationWire([40, 15, 0], [60, 25, 10]);

/** The serialized engine-mode scenario the door consumes. */
function engineScenario(overrides?: {
  readonly combustion?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    name: "otto",
    kind: "combustion",
    domain: {
      kind: "explicit",
      min: [0, 0, 0],
      max: [100, 40, 10],
      resolutionMm: 5,
    },
    conditions: [],
    fluid: "air",
    materials: [],
    ...(overrides?.combustion === undefined
      ? {}
      : { combustion: overrides.combustion }),
  };
}

/** The demo engine stance (the 68c demo numbers). */
function engineStance(): Record<string, unknown> {
  return {
    mode: "engine",
    fuel: "C8H18-ISO",
    geometry: {
      boreMm: 86,
      crankRadiusMm: 43,
      rodLengthMm: 143,
      compressionRatio: 10,
    },
    speedRpm: 1500,
    charge: { intakePressureBar: 1, intakeTK: 300, equivalenceRatio: 1 },
    spark: { timingBTDCDeg: 25 },
    wallHeat: { mode: "woschni", wallTemperatureK: 450 },
    sweep: { kind: "sparkTiming", from: 10, to: 50, steps: 4 },
  };
}

/** The serialized stove-mode scenario the door consumes. */
function stoveScenario(overrides?: {
  readonly combustion?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    name: "stove-fire",
    kind: "combustion",
    domain: {
      kind: "explicit",
      min: [0, 0, 0],
      max: [100, 40, 10],
      resolutionMm: 5,
    },
    conditions: [],
    fluid: "air",
    materials: [{ bodyId: "body_bar", materialId: "mat_steel" }],
    ...(overrides?.combustion === undefined
      ? {}
      : { combustion: overrides.combustion }),
  };
}

/** The lit-methane stove stance. */
function stoveStance(): Record<string, unknown> {
  return {
    mode: "stove",
    fuel: "CH4",
    equivalenceRatio: 1,
    chargeTemperatureK: 1400,
    chargePressureBar: 1,
    wallConvectionWPerM2K: 30,
    radiationMode: "linearized",
    initialTemperatureK: 293.15,
    ambientConvectionWPerM2K: 5,
    durationS: 30,
    sampleIntervalS: 1,
  };
}

describe("the compile door's combustion branch — engine mode", () => {
  it("converts the chamber to SI and attaches no occupancy", () => {
    const compiled = compileSimScenarioWithGeometry({
      scenario: engineScenario({ combustion: engineStance() }),
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    expect(compiled.value.kind).toBe("combustion");
    const stance = compiled.value.combustion;
    expect(stance).toBeDefined();
    if (stance === undefined || stance.mode !== "engine") return;
    expect(stance.geometry.boreM).toBeCloseTo(0.086, 12);
    expect(stance.geometry.crankRadiusM).toBeCloseTo(0.043, 12);
    expect(stance.geometry.rodLengthM).toBeCloseTo(0.143, 12);
    expect(stance.geometry.compressionRatio).toBe(10);
    expect(stance.sweep?.kind).toBe("sparkTiming");
    expect(compiled.value.occupancySlice).toBeUndefined();
    // The hash is stable across compiles of the same record.
    const again = compileSimScenarioWithGeometry({
      scenario: engineScenario({ combustion: engineStance() }),
    });
    expect(again.ok).toBe(true);
    if (again.ok) {
      expect(again.value.scenarioSnapshotHash).toBe(
        compiled.value.scenarioSnapshotHash,
      );
    }
  });

  it("declines a missing stance, a bad fuel, and a condition on the 0D chamber", () => {
    const missing = compileSimScenarioWithGeometry({
      scenario: engineScenario(),
    });
    expect(missing.ok).toBe(false);

    const methane = compileSimScenarioWithGeometry({
      scenario: engineScenario({
        combustion: { ...engineStance(), fuel: "CH4" },
      }),
    });
    expect(methane.ok).toBe(false);
    if (!methane.ok) {
      expect(methane.error.message).toContain("flame-speed fit");
    }

    const conditioned = compileSimScenario({
      scenario: {
        ...engineScenario({ combustion: engineStance() }),
        conditions: [
          { kind: "fixed-temperature", face: "xMin", temperatureK: 300 },
        ],
      },
    });
    expect(conditioned.ok).toBe(false);
    if (!conditioned.ok) {
      expect(conditioned.error.message).toContain(
        "no domain-face boundary conditions",
      );
    }
  });

  it("refuses the linkage that cannot assemble", () => {
    const shortRod = compileSimScenarioWithGeometry({
      scenario: engineScenario({
        combustion: {
          ...engineStance(),
          geometry: {
            boreMm: 86,
            crankRadiusMm: 43,
            rodLengthMm: 40,
            compressionRatio: 10,
          },
        },
      }),
    });
    expect(shortRod.ok).toBe(false);
    if (!shortRod.ok) {
      expect(shortRod.error.message).toContain(
        "rod must be longer than its crank radius",
      );
    }
  });
});

describe("the compile door's combustion branch — stove mode", () => {
  it("builds the SAME per-body material map the thermal branch builds", () => {
    const compiled = compileSimScenarioWithGeometry({
      scenario: stoveScenario({ combustion: stoveStance() }),
      materials: [STEEL],
      bodyTessellations: [{ bodyId: "body_bar", tessellation: BAR }],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const stance = compiled.value.combustion;
    expect(stance).toBeDefined();
    if (stance === undefined || stance.mode !== "stove") return;
    expect(stance.fuel).toBe("CH4");
    expect(stance.wallTemperatureK).toBe(293.15); // resolved to the field
    expect(stance.materials.length).toBe(1);
    expect(stance.materialIndex.length).toBe(21 * 9);
    const slice = compiled.value.occupancySlice;
    expect(slice).toBeDefined();
    if (slice !== undefined) {
      expect([...slice.shape]).toEqual([21, 9, 1]);
      let solid = 0;
      for (const cell of slice.cells) solid += cell;
      expect(solid).toBeGreaterThan(0);
    }
  });

  it("resolves the authored wall temperature over the field default", () => {
    const compiled = compileSimScenarioWithGeometry({
      scenario: stoveScenario({
        combustion: { ...stoveStance(), wallTemperatureK: 500 },
      }),
      materials: [STEEL],
      bodyTessellations: [{ bodyId: "body_bar", tessellation: BAR }],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const stance = compiled.value.combustion;
    if (stance === undefined || stance.mode !== "stove") return;
    expect(stance.wallTemperatureK).toBe(500);
  });

  it("declines the off-lattice cadence and the unassigned body", () => {
    const offLattice = compileSimScenarioWithGeometry({
      scenario: stoveScenario({
        combustion: { ...stoveStance(), sampleIntervalS: 0.7 },
      }),
      materials: [STEEL],
      bodyTessellations: [{ bodyId: "body_bar", tessellation: BAR }],
    });
    expect(offLattice.ok).toBe(false);
    if (!offLattice.ok) {
      expect(offLattice.error.message).toContain("integer multiple");
    }

    const unassigned = compileSimScenarioWithGeometry({
      scenario: {
        ...stoveScenario({ combustion: stoveStance() }),
        materials: [],
      },
      materials: [STEEL],
      bodyTessellations: [{ bodyId: "body_bar", tessellation: BAR }],
    });
    expect(unassigned.ok).toBe(false);
  });

  it("moves the snapshot hash when the stance moves", () => {
    const base = compileSimScenarioWithGeometry({
      scenario: stoveScenario({ combustion: stoveStance() }),
      materials: [STEEL],
      bodyTessellations: [{ bodyId: "body_bar", tessellation: BAR }],
    });
    const moved = compileSimScenarioWithGeometry({
      scenario: stoveScenario({
        combustion: { ...stoveStance(), chargePressureBar: 1.2 },
      }),
      materials: [STEEL],
      bodyTessellations: [{ bodyId: "body_bar", tessellation: BAR }],
    });
    expect(base.ok).toBe(true);
    expect(moved.ok).toBe(true);
    if (!base.ok || !moved.ok) return;
    expect(moved.value.scenarioSnapshotHash).not.toBe(
      base.value.scenarioSnapshotHash,
    );
  });
});
