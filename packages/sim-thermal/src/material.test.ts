/**
 * The material door's pins: the ρ·c conversion (g/cm³ → kg/m³ × cp —
 * the ONE density conversion of the S4 consumer half), the additive
 * declines (no k = no conduction solve; no cp = no transient march
 * later), and the emissivity band.
 */

import { describe, expect, it } from "vitest";
import { SIM_ERROR_CODES } from "@slopcad/sim-core";

import { thermalSolidMaterialFromRecord } from "./material";
import { materialWire } from "./fixtures";

describe("thermalSolidMaterialFromRecord", () => {
  it("converts the wire record to solver space (ρc = g/cm³ × 1000 × cp)", () => {
    const parsed = thermalSolidMaterialFromRecord({
      id: "mat_steel",
      name: "Steel",
      densityGPerCm3: 7.8,
      thermalConductivityWPerMK: 45,
      specificHeatJPerKgK: 466,
      emissivity: 0.6,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.thermalConductivityWPerMK).toBe(45);
    // 7.8 g/cm³ = 7800 kg/m³; ρc = 7800 × 466 = 3,634,800 J/(m³·K).
    expect(parsed.value.volumetricHeatCapacityJPerM3K).toBe(3_634_800);
    expect(parsed.value.emissivity).toBe(0.6);
    expect(parsed.value.name).toBe("Steel");
  });

  it("parses a record without specific heat with ρc absent (steady-only material)", () => {
    const parsed = thermalSolidMaterialFromRecord(
      materialWire({
        id: "mat_konly",
        densityGPerCm3: 2.7,
        thermalConductivityWPerMK: 200,
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.volumetricHeatCapacityJPerM3K).toBeUndefined();
  });

  it("declines loudly without a conductivity — never a fabricated k", () => {
    const parsed = thermalSolidMaterialFromRecord(
      materialWire({ id: "mat_bare", densityGPerCm3: 1.0 }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe(SIM_ERROR_CODES.scenarioInvalid);
    expect(parsed.error.message).toContain("thermalConductivityWPerMK");
  });

  it("declines an emissivity outside [0, 1]", () => {
    const parsed = thermalSolidMaterialFromRecord(
      materialWire({
        id: "mat_shiny",
        densityGPerCm3: 1.0,
        thermalConductivityWPerMK: 10,
        emissivity: 1.5,
      }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain("emissivity");
  });

  it("declines a non-positive or non-finite density and non-object records", () => {
    expect(
      thermalSolidMaterialFromRecord(
        materialWire({
          id: "mat_x",
          densityGPerCm3: 0,
          thermalConductivityWPerMK: 1,
        }),
      ).ok,
    ).toBe(false);
    expect(
      thermalSolidMaterialFromRecord(
        materialWire({
          id: "mat_x",
          densityGPerCm3: Number.NaN,
          thermalConductivityWPerMK: 1,
        }),
      ).ok,
    ).toBe(false);
    expect(thermalSolidMaterialFromRecord("steel").ok).toBe(false);
    expect(thermalSolidMaterialFromRecord(null).ok).toBe(false);
  });

  it("accepts k = 0 (a perfect insulator is a legitimate authored record)", () => {
    const parsed = thermalSolidMaterialFromRecord(
      materialWire({
        id: "mat_insulator",
        densityGPerCm3: 0.1,
        thermalConductivityWPerMK: 0,
        specificHeatJPerKgK: 1000,
      }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.thermalConductivityWPerMK).toBe(0);
  });
});
