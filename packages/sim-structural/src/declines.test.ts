/**
 * The loud declines (Phase 69): every unbudgeted, unreachable, or
 * ill-posed input refuses with a structured `sim/*` error naming the
 * cause — never a fabricated result, never a silently vanished load.
 */

import { describe, expect, it } from "vitest";
import { SIM_ERROR_CODES } from "@slopcad/sim-core";
import type { StructuralRunScenario } from "./run";

import { runStructuralScenario } from "./run";
import { analyticGrid, boxGrid, steelScenario } from "./fixtures";

/**
 * A body touching only the grid's min faces: an 8×4×4 grid whose low-x
 * half is solid (the y/z extents stay filled), so the xMax face alone is
 * out of reach for fixtures and loads alike.
 */
function baseScenario(): StructuralRunScenario {
  const grid = analyticGrid([8, 4, 4], 0.005, (i) => i < 4, "test-offset-box");
  return steelScenario(grid, {
    gravityMPerS2: [0, 0, 0],
    conditions: [{ kind: "fixed-support", face: "xMin" }],
  });
}

describe("the structural door's loud declines", () => {
  it("declines a fixture-starved scenario as singular, before solving", () => {
    const grid = boxGrid(4, 2, 2, 0.005);
    const run = runStructuralScenario(
      steelScenario(grid, { gravityMPerS2: [0, 0, 0], conditions: [] }),
    );
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error.code).toBe(SIM_ERROR_CODES.scenarioInvalid);
      expect(run.error.message).toContain("singular");
    }
  });

  it("declines loads on faces the body does not reach (never a silent zero)", () => {
    // The body fills the grid's y/z extents but only its low-x half,
    // so xMax is the out-of-reach face.
    for (const condition of [
      { kind: "force-load", face: "xMax", forceN: [0, -1, 0] },
      { kind: "pressure-load", face: "xMax", pressurePa: 1e5 },
    ] as const) {
      const run = runStructuralScenario({
        ...baseScenario(),
        conditions: [{ kind: "fixed-support", face: "xMin" }, condition],
      });
      expect(run.ok).toBe(false);
      if (!run.ok) {
        expect(run.error.message).toMatch(/vanish|does not reach/);
      }
    }
  });

  it("declines fixtures on faces the body does not reach", () => {
    const run = runStructuralScenario({
      ...baseScenario(),
      conditions: [{ kind: "fixed-support", face: "xMax" }],
    });
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error.message).toContain("does not reach");
    }
  });

  it("declines point loads and point fixes too far from the body", () => {
    const far: [number, number, number] = [0.5, 0.5, 0.5];
    for (const condition of [
      { kind: "point-load", atWorldPointM: far, forceN: [0, -1, 0] },
      { kind: "point-fix", atWorldPointM: far },
    ] as const) {
      const run = runStructuralScenario({
        ...baseScenario(),
        conditions: [{ kind: "fixed-support", face: "xMin" }, condition],
      });
      expect(run.ok).toBe(false);
      if (!run.ok) {
        expect(run.error.message).toContain("declines");
      }
    }
  });

  it("declines non-finite load magnitudes at the door", () => {
    const run = runStructuralScenario({
      ...baseScenario(),
      conditions: [
        { kind: "fixed-support", face: "xMin" },
        {
          kind: "force-load",
          face: "xMin",
          forceN: [Number.NaN, 0, 0],
        },
      ],
    });
    expect(run.ok).toBe(false);
  });

  it("declines an unknown condition kind and a bad axis", () => {
    const unknown = runStructuralScenario({
      ...baseScenario(),
      conditions: [
        { kind: "magnetic-chuck", face: "xMin" } as unknown as never,
      ],
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.error.message).toContain("magnetic-chuck");
    }
    const badAxis = runStructuralScenario({
      ...baseScenario(),
      conditions: [{ kind: "axis-fix", axis: "w", face: "xMin" } as never],
    });
    expect(badAxis.ok).toBe(false);
  });

  it("declines the thermal-expansion load against a record with no α", () => {
    const grid = boxGrid(6, 2, 2, 0.005);
    const scenario = steelScenario(grid, {
      gravityMPerS2: [0, 0, 0],
      thermalDeltaTK: new Float64Array(grid.cells.length).fill(20),
      conditions: [
        { kind: "fixed-support", face: "xMin" },
        { kind: "fixed-support", face: "xMax" },
      ],
    });
    const noAlpha = {
      ...scenario,
      materials: scenario.materials.map((material) => {
        const { thermalExpansionPerK, ...rest } = material;
        void thermalExpansionPerK;
        return rest;
      }),
    };
    const run = runStructuralScenario(noAlpha);
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error.message).toContain("thermalExpansionPerK");
      expect(run.error.message).toContain("mat_steel");
    }
  });

  it("declines a thermal field of the wrong length", () => {
    const grid = boxGrid(6, 2, 2, 0.005);
    const run = runStructuralScenario(
      steelScenario(grid, {
        gravityMPerS2: [0, 0, 0],
        thermalDeltaTK: new Float64Array(3).fill(20),
        conditions: [{ kind: "fixed-support", face: "xMin" }],
      }),
    );
    expect(run.ok).toBe(false);
  });

  it("declines a scenario whose materials lack the elasticity pair", () => {
    const grid = boxGrid(6, 2, 2, 0.005);
    const run = runStructuralScenario(
      steelScenario(grid, {
        gravityMPerS2: [0, 0, 0],
        conditions: [{ kind: "fixed-support", face: "xMin" }],
        materials: [
          {
            id: "mat_rubber",
            name: "Unparameterised rubber",
            densityKgPerM3: 1100,
            youngsModulusPa: Number.NaN,
            poissonRatio: 0.49,
          },
        ],
      }),
    );
    // The run door re-validates the elasticity pair (the thermal door's
    // conductivity precedent) before any assembly.
    expect(run.ok).toBe(false);
    if (!run.ok) {
      expect(run.error.message).toContain("mat_rubber");
    }
  });

  it("declines an empty name and a bad snapshot hash", () => {
    const grid = boxGrid(4, 2, 2, 0.005);
    const unnamed = runStructuralScenario(
      steelScenario(grid, {
        gravityMPerS2: [0, 0, 0],
        name: "",
        conditions: [{ kind: "fixed-support", face: "xMin" }],
      }),
    );
    expect(unnamed.ok).toBe(false);
    const badHash = runStructuralScenario(
      steelScenario(grid, {
        gravityMPerS2: [0, 0, 0],
        scenarioSnapshotHash: "",
        conditions: [{ kind: "fixed-support", face: "xMin" }],
      }),
    );
    expect(badHash.ok).toBe(false);
  });
});
