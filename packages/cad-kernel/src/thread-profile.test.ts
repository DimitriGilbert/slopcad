/**
 * The ISO metric thread vocabulary's tests (Phase 40): the designation
 * table's integrity (values, ordering, uniqueness, lookup), the basic
 * profile's dimensional chain (H = √3/2·P, depth 5H/8, minor d₁ =
 * d − 1.0825P, the 30° flank angle), the tool loops' shapes, and the
 * thread cut plan's placement math.
 */

import { describe, expect, it } from "vitest";
import { length, valueIn } from "@slopcad/cad-core";

import {
  ISO_METRIC_THREAD_TABLE,
  isoMetricThreadByDesignation,
  isoThreadDepth,
  isoThreadMinorDiameter,
  isoThreadToolLoop,
  isoThreadTriangleHeight,
  planThreadCut,
  THREAD_MODES,
} from "./thread-profile";
import { helixSweepProblem, helixTurnsOverlap } from "./helix-geometry";

describe("the ISO metric thread table", () => {
  it("carries the standard's coarse values", () => {
    const expected: readonly [string, number][] = [
      ["M1.6", 0.35],
      ["M3", 0.5],
      ["M6", 1],
      ["M8", 1.25],
      ["M10", 1.5],
      ["M12", 1.75],
      ["M24", 3],
      ["M64", 6],
    ];
    for (const [designation, pitch] of expected) {
      const row = isoMetricThreadByDesignation(designation);
      expect(row, designation).toBeDefined();
      if (row === undefined) continue;
      expect(row.pitchMm, `${designation} pitch`).toBe(pitch);
    }
    const m6 = isoMetricThreadByDesignation("M6");
    expect(m6?.majorDiameterMm).toBe(6);
    // The tap drill rides the shop rule d − P.
    expect(m6?.tapDrillMm).toBeCloseTo(5, 12);
    const m8 = isoMetricThreadByDesignation("M8");
    expect(m8?.tapDrillMm).toBeCloseTo(6.75, 12);
  });

  it("carries the fine series beside the coarse rows, ordered and unique", () => {
    const fine = isoMetricThreadByDesignation("M8x1");
    expect(fine?.majorDiameterMm).toBe(8);
    expect(fine?.pitchMm).toBe(1);
    const designations = ISO_METRIC_THREAD_TABLE.map(
      (size) => size.designation,
    );
    expect(new Set(designations).size).toBe(designations.length);
    // Ordered by major diameter, coarse first at equal diameter.
    for (let i = 1; i < ISO_METRIC_THREAD_TABLE.length; i += 1) {
      const previous = ISO_METRIC_THREAD_TABLE[i - 1];
      const current = ISO_METRIC_THREAD_TABLE[i];
      if (previous === undefined || current === undefined) continue;
      expect(current.majorDiameterMm).toBeGreaterThanOrEqual(
        previous.majorDiameterMm,
      );
      // At equal diameter the coarse row (the LARGEST pitch) comes first.
      if (current.majorDiameterMm === previous.majorDiameterMm) {
        expect(current.pitchMm).toBeLessThan(previous.pitchMm);
      }
    }
  });
});

describe("the ISO basic profile chain", () => {
  it("derives H, the depth of engagement, and the basic minor diameter", () => {
    // H = √3/2·P; depth = 5H/8 = 0.5413·P; d₁ = d − 2·depth.
    expect(isoThreadTriangleHeight(1)).toBeCloseTo((Math.sqrt(3) / 2) * 1, 12);
    expect(isoThreadDepth(1)).toBeCloseTo(0.541266, 6);
    expect(isoThreadMinorDiameter(6, 1)).toBeCloseTo(4.9175, 4);
    // M8×1.25: d₁ = 8 − 2·0.6766 = 6.647 (the standard's 6.647).
    expect(isoThreadMinorDiameter(8, 1.25)).toBeCloseTo(6.6468, 4);
  });

  it("builds the external groove trapezoid: 7P/8 mouth, P/4 flat, 30° flanks", () => {
    const loop = isoThreadToolLoop({ pitchMm: 1, mode: "external" });
    expect(loop).toHaveLength(4);
    expect(loop.every((segment) => segment.kind === "line")).toBe(true);
    // The trapezoid's corners: outer face at u = 0 with width 7/8, root
    // flat at u = −5√3/16 with width 1/4 (CCW from the root's −v side).
    const depth = (5 * Math.sqrt(3)) / 16;
    const corners = loop.map((segment) =>
      segment.kind === "line" ? segment.start : null,
    );
    expect(corners).toContainEqual([-depth, -0.125]);
    expect(corners).toContainEqual([0, -0.4375]);
    expect(corners).toContainEqual([0, 0.4375]);
    expect(corners).toContainEqual([-depth, 0.125]);
    // The flank angle: Δv/Δu = (7/16 − 1/8·... from root edge (−d, 1/8)
    // to mouth edge (0, 7/16): Δv = 7/16 − 2/16 = 5/16 over Δu = 5√3/16:
    // slope 1/√3 = tan 30° — the 60° included angle, exact.
    const flankRun = depth;
    const flankRise = 7 / 16 - 1 / 8;
    expect(flankRise / flankRun).toBeCloseTo(Math.tan(Math.PI / 6), 12);
  });

  it("builds the internal ridge trapezoid: 3P/4 at the wall, P/8 at depth", () => {
    const corners = isoThreadToolLoop({ pitchMm: 1, mode: "internal" }).map(
      (segment) => (segment.kind === "line" ? segment.start : null),
    );
    const depth = (5 * Math.sqrt(3)) / 16;
    expect(corners).toContainEqual([-depth, -0.0625]);
    expect(corners).toContainEqual([0, -0.375]);
    expect(corners).toContainEqual([0, 0.375]);
    expect(corners).toContainEqual([-depth, 0.0625]);
  });

  it("keeps both tools non-overlapping and axis-clear (sweepable)", () => {
    for (const mode of ["external", "internal"] as const) {
      const loop = isoThreadToolLoop({ pitchMm: 1.25, mode });
      const spine = {
        radiusMm: 4,
        pitchMm: 1.25,
        turns: 8,
        handedness: 1 as const,
        startAngleRad: 0,
        taperMm: 0,
      };
      expect(helixSweepProblem(loop, spine), mode).toBeNull();
      // The tooth's axial extent (7P/8) stays below the pitch: no turn
      // overlap — the fake kernel's analytic subset covers real threads.
      expect(helixTurnsOverlap(loop, spine), mode).toBe(false);
    }
  });

  it("lists the three modes with the cosmetic annotation last", () => {
    expect(THREAD_MODES).toEqual(["external", "internal", "cosmetic"]);
  });
});

describe("the thread cut plan", () => {
  it("places the tool base at the entry point advancing along the axis", () => {
    const plan = planThreadCut({
      majorDiameterMm: 6,
      pitchMm: 1,
      lengthMm: 6,
      mode: "external",
      handedness: 1,
      startAngleRad: 0,
      advanceDirection: [0, 0, -1],
      axisBaseMm: [1, 2, 6],
    });
    expect(plan.turns).toBeCloseTo(6, 12);
    expect(plan.toolTranslationMm).toEqual([1, 2, 6]);
    // The rotation carrying local +z onto −z: a half turn about +x.
    expect(plan.toolRotationAngleRad).toBeCloseTo(Math.PI, 12);
    expect(valueIn(plan.tool.placement.translation.x, "mm")).toBe(1);
    expect(valueIn(plan.tool.spine.radius, "mm")).toBe(3);
    expect(valueIn(plan.tool.spine.pitch, "mm")).toBe(1);
    expect(plan.tool.spine.turns).toBe(6);
    expect(plan.tool.spine.handedness).toBe(1);
    expect(plan.tool.spine.taper).toBeDefined();
    expect(valueIn(plan.tool.spine.taper ?? length(0), "mm")).toBe(0);
  });

  it("aligns local +z onto a datum-style oblique direction", () => {
    const plan = planThreadCut({
      majorDiameterMm: 10,
      pitchMm: 1.5,
      lengthMm: 15,
      mode: "internal",
      handedness: -1,
      startAngleRad: Math.PI / 4,
      advanceDirection: [1, 0, 0],
      axisBaseMm: [0, 0, 0],
    });
    // +π/2 about Y sends +z to +x.
    expect(plan.toolRotationAxis).toEqual([0, 1, 0]);
    expect(plan.toolRotationAngleRad).toBeCloseTo(Math.PI / 2, 12);
    expect(plan.tool.spine.handedness).toBe(-1);
  });
});
