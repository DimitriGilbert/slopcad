/**
 * The structured hole planner's unit tests (Phase 42): the pure meridian
 * math, the shared structural battery, and the tool spans — pinned against
 * INDEPENDENTLY re-derived formulas (the validator-re-derives discipline:
 * the expectations here do not call the planner's own helpers).
 *
 * The meridian conventions under pin (see hole-specification.ts's module
 * doc): depth to the drill TIP point, tip angle INCLUDED (180° flat),
 * entry-measured counterbore/countersink, the taper's geometric close, and
 * the through rule `depth ≥ extent` with the tool spanning
 * `extent + overshoot` past both faces.
 */

import { describe, expect, it } from "vitest";

import {
  HOLE_POSITION_LIMIT,
  HOLE_TYPE_VALUES,
  holeTipExtentMm,
  planStructuredHoleCut,
  rotationAligningYTo,
  structuredHoleAnalyticVolumeMm3,
  structuredHoleProblem,
  structuredHoleRoles,
  type StructuredHoleSpec,
} from "./hole-specification";
import { HOLE_TOOL_OVERSHOOT_MM } from "./core-bridge";
import { isoThreadMinorDiameter } from "./thread-profile";

/** A spec with every field set, overridable per case. */
const BASE: StructuredHoleSpec = {
  type: HOLE_TYPE_VALUES.straight,
  diameterMm: 8,
  depthMm: 6,
  tipAngleDeg: 180,
  cboreDiameterMm: 14,
  cboreDepthMm: 3,
  csinkDiameterMm: 14,
  csinkAngleDeg: 90,
  taperAngleDeg: 10,
  threadMajorMm: 6,
  threadPitchMm: 1,
};

/** The bounds of a 30 × 20 × 10 plate centred nowhere special. */
const PLATE_BOUNDS = {
  min: [-15, -10, 0] as const,
  max: [15, 10, 10] as const,
};

const IDENTITY_U: readonly [number, number, number] = [1, 0, 0];
const IDENTITY_V: readonly [number, number, number] = [0, 1, 0];
const AXIS_Z: readonly [number, number, number] = [0, 0, 1];

/** Plans `BASE` with overrides against the plate, Z axis, centred. */
function planWith(overrides: Partial<StructuredHoleSpec>) {
  return planStructuredHoleCut({
    spec: { ...BASE, ...overrides },
    positions: [{ u: 0, v: 0 }],
    axisDirection: AXIS_Z,
    inPlaneU: IDENTITY_U,
    inPlaneV: IDENTITY_V,
    bounds: PLATE_BOUNDS,
  });
}

describe("hole tip extent", () => {
  it("is zero at the flat 180° and follows (r)/tan(θ/2) otherwise", () => {
    expect(holeTipExtentMm(4, 180)).toBe(0);
    // θ = 90°: h = r/tan(45°) = r.
    expect(holeTipExtentMm(4, 90)).toBeCloseTo(4, 12);
    // θ = 118°: h = r/tan(59°).
    expect(holeTipExtentMm(4, 118)).toBeCloseTo(
      4 / Math.tan((59 * Math.PI) / 180),
      12,
    );
  });
});

describe("structuredHoleProblem (the shared battery)", () => {
  it("accepts every well-formed type", () => {
    for (const type of [
      HOLE_TYPE_VALUES.straight,
      HOLE_TYPE_VALUES.counterbore,
      HOLE_TYPE_VALUES.countersink,
      HOLE_TYPE_VALUES.taper,
      HOLE_TYPE_VALUES.threaded,
    ]) {
      expect(structuredHoleProblem({ ...BASE, type })).toBeNull();
    }
  });

  it("refuses the structural domains with named messages", () => {
    expect(structuredHoleProblem({ ...BASE, type: 9 })?.code).toBe(
      "kernel/parameter-invalid",
    );
    expect(
      structuredHoleProblem({ ...BASE, diameterMm: 0 })?.message,
    ).toContain("diameter");
    expect(structuredHoleProblem({ ...BASE, depthMm: 0 })?.message).toContain(
      "depth",
    );
    expect(
      structuredHoleProblem({
        ...BASE,
        type: HOLE_TYPE_VALUES.counterbore,
        cboreDiameterMm: 8,
      })?.message,
    ).toContain("EXCEED");
    expect(
      structuredHoleProblem({
        ...BASE,
        type: HOLE_TYPE_VALUES.countersink,
        csinkAngleDeg: 180,
      })?.message,
    ).toContain("countersink");
    expect(
      structuredHoleProblem({
        ...BASE,
        type: HOLE_TYPE_VALUES.taper,
        taperAngleDeg: 0,
      })?.message,
    ).toContain("taper");
    expect(
      structuredHoleProblem({
        ...BASE,
        type: HOLE_TYPE_VALUES.threaded,
        threadPitchMm: 0,
      })?.message,
    ).toContain("pitch");
    // The tip angle domain rides the tipped types only.
    expect(
      structuredHoleProblem({
        ...BASE,
        type: HOLE_TYPE_VALUES.taper,
        tipAngleDeg: 0,
      }),
    ).toBeNull();
  });
});

describe("structuredHoleRoles (the parameter schema)", () => {
  it("lists the straight world form's seven roles in declared order", () => {
    expect(
      structuredHoleRoles("straight", {}).map((role) => role.name),
    ).toEqual([
      "type",
      "diameter",
      "depth",
      "tipAngle",
      "positionX",
      "positionY",
      "axis",
    ]);
  });

  it("drops the positions with a sketch and the axis with a datum", () => {
    expect(
      structuredHoleRoles("straight", { sketchPositions: true }).map(
        (r) => r.name,
      ),
    ).toEqual(["type", "diameter", "depth", "tipAngle", "axis"]);
    expect(
      structuredHoleRoles("straight", { datumAxis: true }).map((r) => r.name),
    ).toEqual([
      "type",
      "diameter",
      "depth",
      "tipAngle",
      "positionX",
      "positionY",
    ]);
    expect(
      structuredHoleRoles("threaded", {
        sketchPositions: true,
        datumAxis: true,
      }).map((r) => r.name),
    ).toEqual(["type", "depth", "tipAngle", "threadMajor", "threadPitch"]);
  });
});

describe("rotationAligningYTo", () => {
  it("is identity for +y and a half turn about x for −y", () => {
    expect(rotationAligningYTo([0, 1, 0])).toEqual({
      axis: [1, 0, 0],
      angleRad: 0,
    });
    expect(rotationAligningYTo([0, -1, 0])).toEqual({
      axis: [1, 0, 0],
      angleRad: Math.PI,
    });
  });

  it("carries local +y onto +z with the quarter turn about x", () => {
    // Rotating +π/2 about +x sends +y to +z (right-hand rule); the axis
    // normalizes to ±x with a possible −0 component (float artifact).
    const rotation = rotationAligningYTo([0, 0, 1]);
    expect(Math.abs(rotation.axis[0])).toBeCloseTo(1, 12);
    expect(rotation.axis[1]).toBeCloseTo(0, 12);
    expect(rotation.axis[2]).toBeCloseTo(0, 12);
    expect(rotation.angleRad).toBeCloseTo(Math.PI / 2, 12);
  });
});

/** The meridian loop's start vertices, compared at float tolerance. */
function loopStarts(
  loop: readonly { readonly kind: string; readonly start?: unknown }[],
): readonly (readonly [number, number])[] {
  return loop.map((segment) => {
    if (
      segment.kind === "line" &&
      Array.isArray(segment.start) &&
      segment.start.length === 2
    ) {
      return [segment.start[0] as number, segment.start[1] as number];
    }
    throw new Error("the meridian loop must be line segments");
  });
}

/** Asserts the loop's start vertices against expected (x, y) pairs. */
function expectLoopCloseTo(
  loop: readonly { readonly kind: string; readonly start?: unknown }[],
  expected: readonly (readonly [number, number])[],
): void {
  const starts = loopStarts(loop);
  expect(starts).toHaveLength(expected.length);
  for (let index = 0; index < expected.length; index += 1) {
    const start = starts[index];
    const want = expected[index];
    if (start === undefined || want === undefined) continue;
    expect(start[0]).toBeCloseTo(want[0], 9);
    expect(start[1]).toBeCloseTo(want[1], 9);
  }
}

describe("planStructuredHoleCut (the meridian math)", () => {
  it("plans the blind straight hole: tip at the base, wall to the overshoot", () => {
    // Ø8, depth 6 to a 118° tip: h = 4/tan(59°) ≈ 2.4023; blind on a 10 mm
    // plate. The meridian (x = radius, y from the tool base):
    // (0,0) → (4, h) → (4, 7) → (0,7) — tool span depth + overshoot.
    const planned = planWith({
      type: HOLE_TYPE_VALUES.straight,
      tipAngleDeg: 118,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.through).toBe(false);
    expect(planned.plan.positions).toHaveLength(1);
    const loop = planned.plan.positions[0]?.revolveTool.loop ?? [];
    expect(loop).toHaveLength(4);
    const h = holeTipExtentMm(4, 118);
    expect(loop[0]).toEqual({ kind: "line", start: [0, 0], end: [4, h] });
    expect(loop[1]).toEqual({
      kind: "line",
      start: [4, h],
      end: [4, 6 + HOLE_TOOL_OVERSHOOT_MM],
    });
    // The translation puts the tool base at entry − depth on the axis.
    const translation =
      planned.plan.positions[0]?.revolveTool.placement.translation;
    expect(translation?.z).toBeDefined();
    // valueIn on the dimensional value is not imported here; the structural
    // pin above plus the bridge fixtures carry the placement.
    expect(translation).toBeTruthy();
    // The revolve axis is the meridian's local y through the origin, full
    // turn.
    expect(planned.plan.positions[0]?.revolveTool.axis).toEqual({
      point: [0, 0],
      direction: [0, 1],
    });
  });

  it("plans the through hole past both faces", () => {
    const planned = planWith({
      type: HOLE_TYPE_VALUES.straight,
      depthMm: 10,
      tipAngleDeg: 180,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.through).toBe(true);
    // The tool spans extent + 2·overshoot: 10 + 2 = 12; flat tip at the base.
    const loop = planned.plan.positions[0]?.revolveTool.loop ?? [];
    expect(loop[0]).toEqual({
      kind: "line",
      start: [0, 0],
      end: [4, 0],
    });
    expect(loop[1]?.kind === "line" ? loop[1].end : null).toEqual([4, 12]);
  });

  it("plans the counterbore: annulus floor at entry − cboreDepth", () => {
    const planned = planWith({
      type: HOLE_TYPE_VALUES.counterbore,
      tipAngleDeg: 180,
      cboreDiameterMm: 14,
      cboreDepthMm: 3,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const loop = planned.plan.positions[0]?.revolveTool.loop ?? [];
    // (0,0) → (4,0) → (4, yCb) → (7, yCb) → (7, 7) → (0,7): yCb = depth −
    // cboreDepth = 3.
    expectLoopCloseTo(loop, [
      [0, 0],
      [4, 0],
      [4, 3],
      [7, 3],
      [7, 7],
      [0, 7],
    ]);
  });

  it("plans the countersink: cone from the throat to the rim at the entry", () => {
    // Ø8 throat, Ø14 rim at 90° included: h_cs = (7 − 4)/tan(45°) = 3.
    const planned = planWith({
      type: HOLE_TYPE_VALUES.countersink,
      tipAngleDeg: 180,
      csinkDiameterMm: 14,
      csinkAngleDeg: 90,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const loop = planned.plan.positions[0]?.revolveTool.loop ?? [];
    expectLoopCloseTo(loop, [
      [0, 0],
      [4, 0],
      [4, 3],
      [7, 6],
      [7, 7],
      [0, 7],
    ]);
  });

  it("plans the closing taper from the entry diameter and clamps the depth", () => {
    // Ø8 entry at 90° included: slope tan(45°) = 1, closes at z = 4 — before
    // the authored 6 mm. The tool ends at the point: triangle + cap.
    const planned = planWith({
      type: HOLE_TYPE_VALUES.taper,
      taperAngleDeg: 90,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.through).toBe(false);
    const loop = planned.plan.positions[0]?.revolveTool.loop ?? [];
    expectLoopCloseTo(loop, [
      [0, 0],
      [4 + HOLE_TOOL_OVERSHOOT_MM, 5],
      [0, 5],
    ]);
  });

  it("plans the truncated taper with a flat base", () => {
    // Ø8 at 30° included: slope tan(15°) ≈ 0.2679; authored 6 mm leaves
    // rBase = 4 − 6·tan(15°) ≈ 2.392.
    const planned = planWith({
      type: HOLE_TYPE_VALUES.taper,
      taperAngleDeg: 30,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const loop = planned.plan.positions[0]?.revolveTool.loop ?? [];
    const rBase = 4 - 6 * Math.tan((15 * Math.PI) / 180);
    expectLoopCloseTo(loop, [
      [0, 0],
      [rBase, 0],
      [4 + Math.tan((15 * Math.PI) / 180), 7],
      [0, 7],
    ]);
  });

  it("plans the threaded hole: pilot at the ISO minor plus the ridge sweep", () => {
    const planned = planWith({
      type: HOLE_TYPE_VALUES.threaded,
      tipAngleDeg: 180,
      threadMajorMm: 6,
      threadPitchMm: 1,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    // The pilot rides the ISO basic minor d₁ = 6 − 2·(5H/8) with H = √3/2.
    const minor = isoThreadMinorDiameter(6, 1);
    expect(planned.plan.threadMinorDiameterMm).toBeCloseTo(minor, 12);
    const loop = planned.plan.positions[0]?.revolveTool.loop ?? [];
    expect(loop[1]?.kind === "line" ? loop[1].end : null).toEqual([
      minor / 2,
      6 + HOLE_TOOL_OVERSHOOT_MM,
    ]);
    // The ridge sweep is present, internal mode, from the entry.
    const threadTool = planned.plan.positions[0]?.threadTool;
    expect(threadTool).toBeDefined();
  });

  it("refuses the tip and entry features that cannot fit the tool", () => {
    // Ø8 30° tip: h = 4/tan(15°) ≈ 14.928 — beyond the blind 6 mm depth.
    const acute = planWith({
      type: HOLE_TYPE_VALUES.straight,
      tipAngleDeg: 30,
    });
    expect(acute.ok).toBe(false);
    if (acute.ok) return;
    expect(acute.problem.message).toContain("tip");
    // A cbore swallowing the straight section on a through hole: extent 10,
    // tool depth 11; a cbore to 11 mm leaves nothing straight below.
    const swallowing = planWith({
      type: HOLE_TYPE_VALUES.counterbore,
      depthMm: 12,
      cboreDepthMm: 11,
    });
    expect(swallowing.ok).toBe(false);
    if (swallowing.ok) return;
    expect(swallowing.problem.message).toContain("counterbore");
  });

  it("refuses the empty position list and the position ceiling", () => {
    const empty = planStructuredHoleCut({
      spec: BASE,
      positions: [],
      axisDirection: AXIS_Z,
      inPlaneU: IDENTITY_U,
      inPlaneV: IDENTITY_V,
      bounds: PLATE_BOUNDS,
    });
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.problem.code).toBe("kernel/feature-input-invalid");
    const tooMany = planStructuredHoleCut({
      spec: BASE,
      positions: Array.from({ length: HOLE_POSITION_LIMIT + 1 }, () => ({
        u: 0,
        v: 0,
      })),
      axisDirection: AXIS_Z,
      inPlaneU: IDENTITY_U,
      inPlaneV: IDENTITY_V,
      bounds: PLATE_BOUNDS,
    });
    expect(tooMany.ok).toBe(false);
    if (tooMany.ok) return;
    expect(tooMany.problem.message).toContain(String(HOLE_POSITION_LIMIT));
  });

  it("plans one tool set per sketch position, in order", () => {
    const planned = planStructuredHoleCut({
      spec: BASE,
      positions: [
        { u: -5, v: -4 },
        { u: 5, v: 4 },
      ],
      axisDirection: AXIS_Z,
      inPlaneU: IDENTITY_U,
      inPlaneV: IDENTITY_V,
      bounds: PLATE_BOUNDS,
    });
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.positions).toHaveLength(2);
  });
});

describe("structuredHoleAnalyticVolumeMm3 (the authoring expectation)", () => {
  it("matches the re-derived cylinder + tip cone for the straight hole", () => {
    const r = 4;
    const h = holeTipExtentMm(r, 118);
    const expected = Math.PI * r * r * (6 - h) + (Math.PI * r * r * h) / 3;
    expect(
      structuredHoleAnalyticVolumeMm3({ ...BASE, tipAngleDeg: 118 }),
    ).toBeCloseTo(expected, 9);
  });

  it("matches the re-derived frustum for the truncated taper", () => {
    const r0 = 4;
    const slope = Math.tan((15 * Math.PI) / 180);
    const depthEff = Math.min(6, r0 / slope);
    const r1 = r0 - depthEff * slope;
    const expected = (Math.PI * depthEff * (r1 * r1 + r1 * r0 + r0 * r0)) / 3;
    expect(
      structuredHoleAnalyticVolumeMm3({
        ...BASE,
        type: HOLE_TYPE_VALUES.taper,
        taperAngleDeg: 30,
      }),
    ).toBeCloseTo(expected, 9);
  });

  it("adds the counterbore annulus over the straight hole", () => {
    const straight = structuredHoleAnalyticVolumeMm3(BASE);
    const counterbored = structuredHoleAnalyticVolumeMm3({
      ...BASE,
      type: HOLE_TYPE_VALUES.counterbore,
    });
    const annulus = Math.PI * (7 * 7 - 4 * 4) * 3;
    expect(counterbored - straight).toBeCloseTo(annulus, 9);
  });

  it("exceeds the pilot-only threaded volume (the ridge adds material)", () => {
    const threaded = structuredHoleAnalyticVolumeMm3({
      ...BASE,
      type: HOLE_TYPE_VALUES.threaded,
    });
    const minor = isoThreadMinorDiameter(6, 1);
    expect(threaded).toBeGreaterThan(Math.PI * (minor / 2) ** 2 * 6);
  });
});
