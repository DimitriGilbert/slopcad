/**
 * Cycle-sweep pins (Phase 68b — the heavy suite, timeouts measured):
 * the efficiency-trend data against the textbook SI signatures —
 * thermal efficiency rising with compression ratio toward the ideal
 * Otto ceiling, efficiency peaking lean of stoichiometric with IMEP
 * peaking at stoichiometric, an interior MBT-like spark optimum, and
 * the knock integral marking the advance boundary — plus the sweep
 * door's spray decline and the CSV projection's byte determinism.
 */

import { describe, expect, it } from "vitest";

import {
  exportOttoSweepCsv,
  ottoCycleSweep,
  type OttoCycleScenario,
} from "./index";

function must<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) throw new Error(`${what}: ${result.error.message}`);
  return result.value;
}

const BASE: OttoCycleScenario = {
  combustionMode: "premixed",
  fuel: "C8H18-ISO",
  geometry: {
    boreM: 0.086,
    crankRadiusM: 0.043,
    rodLengthM: 0.143,
    compressionRatio: 10,
  },
  speedRpm: 1500,
  charge: {
    intakePressureBar: 1.01325,
    intakeTK: 298.15,
    equivalenceRatio: 1,
  },
  spark: { timingBTDCDeg: 25 },
  wallHeat: { mode: "woschni", wallTemperatureK: 450 },
};

describe("the compression-ratio sweep", () => {
  it(
    "raises efficiency and peak pressure monotonically",
    { timeout: 60_000 },
    () => {
      const sweep = must(
        ottoCycleSweep({
          base: BASE,
          kind: "compressionRatio",
          from: 8,
          to: 12,
          steps: 4,
        }),
        "CR sweep",
      );
      for (let i = 1; i < sweep.rows.length; i += 1) {
        const prev = sweep.rows[i - 1];
        const row = sweep.rows[i];
        if (prev === undefined || row === undefined) continue;
        expect(row.indicatedThermalEfficiency).toBeGreaterThan(
          prev.indicatedThermalEfficiency,
        );
        expect(row.brakeThermalEfficiency).toBeGreaterThan(
          prev.brakeThermalEfficiency,
        );
        expect(row.peakPressureBar).toBeGreaterThan(prev.peakPressureBar);
        // Higher compression runs hotter at the spark state: the derived
        // burn duration shortens.
        expect(row.burnDurationDeg).toBeLessThan(prev.burnDurationDeg);
      }
    },
  );
});

describe("the equivalence-ratio sweep", () => {
  it("peaks efficiency lean of stoichiometric and IMEP at stoichiometric", () => {
    const sweep = must(
      ottoCycleSweep({
        base: BASE,
        kind: "equivalenceRatio",
        from: 0.8,
        to: 1.2,
        steps: 4,
      }),
      "phi sweep",
    );
    const rows = sweep.rows;
    const lean = rows[1];
    const stoich = rows[2];
    const rich = rows[4];
    if (lean === undefined || stoich === undefined || rich === undefined) {
      throw new Error("missing sweep rows");
    }
    // The classic SI trends (Heywood Ch. 15): indicated efficiency
    // peaks lean of φ = 1 (less heat loss to dissociation-rich burned
    // gas, lower burned temperatures), falls rich.
    expect(lean.indicatedThermalEfficiency).toBeGreaterThan(
      stoich.indicatedThermalEfficiency,
    );
    expect(stoich.indicatedThermalEfficiency).toBeGreaterThan(
      rich.indicatedThermalEfficiency,
    );
    // IMEP (per-cycle work) peaks at or near stoichiometric against
    // both the lean and rich ends.
    expect(stoich.imepPa).toBeGreaterThan(lean.imepPa);
    expect(stoich.imepPa).toBeGreaterThan(rich.imepPa);
    // Lean mixtures burn slower: the derived duration lengthens.
    expect(rows[0]?.burnDurationDeg ?? 0).toBeGreaterThan(
      stoich.burnDurationDeg,
    );
  });
});

describe("the spark-timing sweep", () => {
  it(
    "finds an interior MBT-like optimum and marks the knock boundary",
    { timeout: 120_000 },
    () => {
      const sweep = must(
        ottoCycleSweep({
          base: BASE,
          kind: "sparkTiming",
          from: 8,
          to: 44,
          steps: 9,
        }),
        "spark sweep",
      );
      const rows = sweep.rows;
      // An interior optimum: the maximum IMEP is at neither end of the
      // advance span (the classic MBT behavior — retarded burns into
      // the expansion, over-advanced fights compression).
      let best = 0;
      for (let i = 1; i < rows.length; i += 1) {
        if ((rows[i]?.imepPa ?? 0) > (rows[best]?.imepPa ?? 0)) best = i;
      }
      expect(best).toBeGreaterThan(0);
      expect(best).toBeLessThan(rows.length - 1);
      // The knock integral rises monotonically with advance — the
      // spark-advance boundary the Livengood–Wu integral marks.
      for (let i = 1; i < rows.length; i += 1) {
        expect(rows[i]?.knockIntegral ?? 0).toBeGreaterThan(
          rows[i - 1]?.knockIntegral ?? 0,
        );
      }
    },
  );
});

describe("the sweep surface itself", () => {
  it("declines spray loud at the sweep door", () => {
    const declined = ottoCycleSweep({
      base: { ...BASE, combustionMode: "spray" },
      kind: "sparkTiming",
      from: 10,
      to: 20,
      steps: 2,
    });
    expect(declined.ok).toBe(false);
    if (!declined.ok) {
      expect(declined.error.code).toBe("sim/combustion-mode-unsupported");
      expect(declined.error.message).toContain("fitted burn curve");
    }
  });

  it(
    "projects deterministic CSV byte-identically (law S7)",
    { timeout: 60_000 },
    () => {
      const sweep = must(
        ottoCycleSweep({
          base: BASE,
          kind: "compressionRatio",
          from: 9,
          to: 10,
          steps: 2,
        }),
        "sweep",
      );
      const first = must(exportOttoSweepCsv(sweep), "csv first");
      const second = must(exportOttoSweepCsv(sweep), "csv second");
      expect(second).toBe(first);
      expect(first.split("\n")[0]).toContain("compressionRatio");
      expect(first.split("\n")[0]).toContain("brake-thermal-efficiency");
      expect(first.split("\n").filter((line) => line.length > 0).length).toBe(
        4,
      );
    },
  );

  it("declines malformed spans and propagates row declines loudly", () => {
    expect(
      ottoCycleSweep({
        base: BASE,
        kind: "sparkTiming",
        from: 10,
        to: 20,
        steps: 0,
      }).ok,
    ).toBe(false);
    // A span whose row the cycle declines (over-rich past CO
    // saturation) fails the sweep naming the row value.
    const overRich = ottoCycleSweep({
      base: BASE,
      kind: "equivalenceRatio",
      from: 1,
      to: 3.5,
      steps: 5,
    });
    expect(overRich.ok).toBe(false);
    if (!overRich.ok) {
      expect(overRich.error.message).toContain("declined at");
    }
  });
});
