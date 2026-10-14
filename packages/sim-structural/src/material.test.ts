/**
 * The structural material door (Phase 69a): the additive-fields honesty
 * of the Phase 69 record extension, consumed through the
 * `@slopcad/sim-thermal` material-door precedent — every field the door
 * consumes re-validated, every absence declined loudly by the ONE
 * consumer that needs it.
 */

import { describe, expect, it } from "vitest";

import { structuralSolidMaterialFromRecord } from "./material";
import { ALUMINIUM_WIRE, STEEL_WIRE } from "./fixtures";

describe("structuralSolidMaterialFromRecord", () => {
  it("parses the complete structural record with the density converted", () => {
    const parsed = structuralSolidMaterialFromRecord(STEEL_WIRE);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.id).toBe("mat_steel");
    expect(parsed.value.name).toBe("Steel S235");
    // The one conversion this door owns: g/cm³ → kg/m³.
    expect(parsed.value.densityKgPerM3).toBeCloseTo(7850, 10);
    expect(parsed.value.youngsModulusPa).toBe(210e9);
    expect(parsed.value.poissonRatio).toBe(0.3);
    expect(parsed.value.yieldStrengthPa).toBe(250e6);
    expect(parsed.value.thermalExpansionPerK).toBe(1.2e-5);
  });

  it("declines a record without the elasticity pair, naming the field", () => {
    const noE = structuralSolidMaterialFromRecord({
      id: "mat_plain",
      name: "Plain alloy",
      densityGPerCm3: 1.2,
      poissonRatio: 0.33,
    });
    expect(noE.ok).toBe(false);
    if (!noE.ok) {
      expect(noE.error.message).toContain("youngsModulusPa");
    }
    const noNu = structuralSolidMaterialFromRecord({
      id: "mat_plain",
      name: "Plain alloy",
      densityGPerCm3: 1.2,
      youngsModulusPa: 210e9,
    });
    expect(noNu.ok).toBe(false);
    if (!noNu.ok) {
      expect(noNu.error.message).toContain("poissonRatio");
    }
  });

  it("declines Poisson's ratio outside the isotropic-stability band", () => {
    for (const poissonRatio of [-1, 0.5, -1.5, 0.7, Number.NaN]) {
      const parsed = structuralSolidMaterialFromRecord({
        ...ALUMINIUM_WIRE,
        poissonRatio,
      });
      expect(parsed.ok).toBe(false);
    }
    // The interior boundaries parse: −0.99 and 0.499 are inside.
    for (const poissonRatio of [-0.99, 0.499]) {
      const parsed = structuralSolidMaterialFromRecord({
        ...ALUMINIUM_WIRE,
        poissonRatio,
      });
      expect(parsed.ok).toBe(true);
    }
  });

  it("declines a record without a usable density (the body forces need it)", () => {
    const parsed = structuralSolidMaterialFromRecord({
      ...ALUMINIUM_WIRE,
      densityGPerCm3: 0,
    });
    expect(parsed.ok).toBe(false);
  });

  it("rides the consumer-scoped absences honestly", () => {
    // No yield strength: the record parses, runs, and only the
    // factor-of-safety consumer declines — the specific-heat precedent.
    const parsed = structuralSolidMaterialFromRecord({
      id: "mat_no-yield",
      name: "Yieldless alloy",
      densityGPerCm3: 4.4,
      youngsModulusPa: 113.8e9,
      poissonRatio: 0.34,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.yieldStrengthPa).toBeUndefined();
      expect(parsed.value.thermalExpansionPerK).toBeUndefined();
    }
    // A present-but-invalid optional field still declines.
    const badYield = structuralSolidMaterialFromRecord({
      ...ALUMINIUM_WIRE,
      yieldStrengthPa: 0,
    });
    expect(badYield.ok).toBe(false);
    const badAlpha = structuralSolidMaterialFromRecord({
      ...ALUMINIUM_WIRE,
      thermalExpansionPerK: Number.POSITIVE_INFINITY,
    });
    expect(badAlpha.ok).toBe(false);
  });

  it("falls back to the record id for the display name", () => {
    const parsed = structuralSolidMaterialFromRecord({
      id: "mat_nameless",
      name: "   ",
      densityGPerCm3: 1.2,
      youngsModulusPa: 3e9,
      poissonRatio: 0.4,
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.name).toBe("mat_nameless");
    }
  });
});
