/**
 * The geometry-aware compile door's THERMAL branch tests (Phase 65c):
 * the per-body tessellations + material records the 65c compile input
 * carries become the compiled problem's solver geometry — the union
 * occupancy slice at the domain's mid-height plane plus the per-cell
 * material map — with the solve stance re-validated at the door. The
 * truths this file owns:
 *
 * - the products attach ONLY for thermal scenarios that carry the
 *   per-body geometry (a geometry-less compile stays the 61a shape);
 * - the material map is per-BODY honest: one box → one material on
 *   exactly its cells; two boxes → two materials on their own cells;
 * - the loud declines: an unassigned body, an unresolvable material
 *   id, a steady coupled stance, and a transient budget off cadence;
 * - the scenario-snapshot hash moves when the stance moves (the
 *   provenance law: the record's content IS the run's identity).
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

const INSULATION = {
  id: "mat_insulation",
  name: "Insulation",
  densityGPerCm3: 0.6,
  thermalConductivityWPerMK: 0.3,
  specificHeatJPerKgK: 1000,
  emissivity: 0.85,
};

/** The serialized thermal scenario the door consumes (mm document space). */
function thermalScenario(overrides?: {
  readonly materials?: readonly unknown[];
  readonly thermal?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    name: "stove",
    kind: "thermal",
    domain: {
      kind: "explicit",
      min: [0, 0, 0],
      max: [20, 10, 10],
      resolutionMm: 5,
    },
    conditions: [],
    fluid: "air",
    materials: overrides?.materials ?? [
      { bodyId: "body_a", materialId: "mat_steel" },
    ],
    thermal: overrides?.thermal ?? {
      radiationMode: "linearized",
      solveMode: "steady",
      cht: false,
      sourceW: 5,
      initialTemperatureK: 293.15,
      ambientConvectionWPerM2K: 5,
    },
  };
}

describe("the thermal compile branch", () => {
  it("attaches the slice and the per-cell material map for one assigned body", () => {
    const compiled = compileSimScenarioWithGeometry({
      scenario: thermalScenario(),
      materials: [STEEL],
      bodyTessellations: [
        {
          bodyId: "body_a",
          tessellation: boxTessellationWire([0, 0, 0], [10, 10, 10]),
        },
      ],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const slice = compiled.value.occupancySlice;
    const thermal = compiled.value.thermal;
    expect(slice).toBeDefined();
    expect(thermal).toBeDefined();
    if (slice === undefined || thermal === undefined) return;

    // The slice: [nx, ny, 1] at the domain's mid-height z = 5 mm.
    expect([...slice.shape]).toEqual([5, 3, 1]);
    expect(slice.cells.length).toBe(15);
    // The box [0,10]×[0,10] at 5 mm over the 20×10 domain: the first
    // three x columns solid in all three y rows (closed-set nodes).
    let solid = 0;
    for (const cell of slice.cells) solid += cell;
    expect(solid).toBe(9);

    // The material map: steel (index 1) on exactly the solid cells.
    expect(thermal.materials).toHaveLength(1);
    expect((thermal.materials[0]?.record as { readonly id: string }).id).toBe(
      "mat_steel",
    );
    for (let cell = 0; cell < slice.cells.length; cell += 1) {
      expect(thermal.materialIndex[cell]).toBe(slice.cells[cell]);
    }

    // The stance rides through re-validated.
    expect(thermal.radiationMode).toBe("linearized");
    expect(thermal.solveMode).toBe("steady");
    expect(thermal.sourceW).toBe(5);
  });

  it("splits two bodies into their own materials on their own cells", () => {
    const compiled = compileSimScenarioWithGeometry({
      scenario: thermalScenario({
        materials: [
          { bodyId: "body_a", materialId: "mat_steel" },
          { bodyId: "body_b", materialId: "mat_insulation" },
        ],
      }),
      materials: [STEEL, INSULATION],
      bodyTessellations: [
        {
          bodyId: "body_a",
          tessellation: boxTessellationWire([0, 0, 0], [10, 10, 10]),
        },
        {
          bodyId: "body_b",
          tessellation: boxTessellationWire([15, 0, 0], [20, 10, 10]),
        },
      ],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;
    const slice = compiled.value.occupancySlice;
    const thermal = compiled.value.thermal;
    if (slice === undefined || thermal === undefined) return;
    expect(thermal.materials).toHaveLength(2);
    // x ∈ [0,10) → steel (1); x = 15..20 → insulation (2).
    for (let j = 0; j < 3; j += 1) {
      for (let i = 0; i < 5; i += 1) {
        const cell = i + j * 5;
        const solid = slice.cells[cell] === 1;
        if (i <= 2) {
          expect(thermal.materialIndex[cell]).toBe(solid ? 1 : 0);
        } else {
          expect(thermal.materialIndex[cell]).toBe(solid ? 2 : 0);
        }
      }
    }
  });

  it("keeps the 61a compile shape for thermal scenarios without per-body geometry", () => {
    const geometryLess = compileSimScenarioWithGeometry({
      scenario: thermalScenario(),
      materials: [STEEL],
    });
    expect(geometryLess.ok).toBe(true);
    if (geometryLess.ok) {
      expect(geometryLess.value.occupancySlice).toBeUndefined();
      expect(geometryLess.value.thermal).toBeUndefined();
    }
    // And the plain 61a door never sees the new fields at all.
    const plain = compileSimScenario({ scenario: thermalScenario() });
    expect(plain.ok).toBe(true);
  });

  it("declines unassigned bodies, unresolvable materials, and stance violations loudly", () => {
    const unassigned = compileSimScenarioWithGeometry({
      scenario: thermalScenario({ materials: [] }),
      materials: [STEEL],
      bodyTessellations: [
        {
          bodyId: "body_a",
          tessellation: boxTessellationWire([0, 0, 0], [10, 10, 10]),
        },
      ],
    });
    expect(unassigned.ok).toBe(false);
    if (!unassigned.ok) {
      expect(unassigned.error.message).toContain("assigns it no material");
    }

    const unknownMaterial = compileSimScenarioWithGeometry({
      scenario: thermalScenario(),
      materials: [],
      bodyTessellations: [
        {
          bodyId: "body_a",
          tessellation: boxTessellationWire([0, 0, 0], [10, 10, 10]),
        },
      ],
    });
    expect(unknownMaterial.ok).toBe(false);
    if (!unknownMaterial.ok) {
      expect(unknownMaterial.error.message).toContain(
        "no supplied material record",
      );
    }

    const steadyCoupled = compileSimScenarioWithGeometry({
      scenario: thermalScenario({
        thermal: {
          radiationMode: "off",
          solveMode: "steady",
          cht: true,
          sourceW: 5,
          initialTemperatureK: 293.15,
          ambientConvectionWPerM2K: 5,
        },
      }),
      materials: [STEEL],
      bodyTessellations: [
        {
          bodyId: "body_a",
          tessellation: boxTessellationWire([0, 0, 0], [10, 10, 10]),
        },
      ],
    });
    expect(steadyCoupled.ok).toBe(false);
    if (!steadyCoupled.ok) {
      expect(steadyCoupled.error.message).toContain(
        "transient by construction",
      );
    }

    const offCadence = compileSimScenarioWithGeometry({
      scenario: thermalScenario({
        thermal: {
          radiationMode: "off",
          solveMode: "transient",
          cht: false,
          sourceW: 5,
          initialTemperatureK: 293.15,
          ambientConvectionWPerM2K: 5,
          durationS: 10,
          sampleIntervalS: 3,
        },
      }),
      materials: [STEEL],
      bodyTessellations: [
        {
          bodyId: "body_a",
          tessellation: boxTessellationWire([0, 0, 0], [10, 10, 10]),
        },
      ],
    });
    expect(offCadence.ok).toBe(false);
    if (!offCadence.ok) {
      expect(offCadence.error.message).toContain("integer multiple");
    }
  });

  it("moves the scenario-snapshot hash when the stance moves", () => {
    const base = compileSimScenarioWithGeometry({
      scenario: thermalScenario(),
      materials: [STEEL],
      bodyTessellations: [
        {
          bodyId: "body_a",
          tessellation: boxTessellationWire([0, 0, 0], [10, 10, 10]),
        },
      ],
    });
    const hotter = compileSimScenarioWithGeometry({
      scenario: thermalScenario({
        thermal: {
          radiationMode: "linearized",
          solveMode: "steady",
          cht: false,
          sourceW: 6,
          initialTemperatureK: 293.15,
          ambientConvectionWPerM2K: 5,
        },
      }),
      materials: [STEEL],
      bodyTessellations: [
        {
          bodyId: "body_a",
          tessellation: boxTessellationWire([0, 0, 0], [10, 10, 10]),
        },
      ],
    });
    if (!base.ok || !hotter.ok) {
      throw new Error("the thermal compile fixtures must compile");
    }
    expect(hotter.value.scenarioSnapshotHash).not.toBe(
      base.value.scenarioSnapshotHash,
    );
  });
});
