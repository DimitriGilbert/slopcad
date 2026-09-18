/**
 * Profile resolution tests (Phase 26.1): closed-chain resolution from
 * entities, the construction exclusion, and every structured failure of the
 * taxonomy — empty, open chain, degenerate, self-intersecting
 * (line×line, line×arc, and arc×arc crossings), multiple loops — plus the
 * workplane placement transform the extrude executes under.
 */

import { describe, expect, it } from "vitest";

import {
  createArcEntity,
  createCircleEntity,
  createLineEntity,
  createPointEntity,
  createRectangleEntity,
  createSketch,
  createSketchEntityId,
  frontWorkplane,
  xyWorkplane,
  type Sketch,
} from "./index";
import {
  PROFILE_ENDPOINT_TOLERANCE_MM,
  profileLoopSignedArea,
  resolveExtrudeProfile,
  resolveProfileLoops,
} from "./profile";
import { workplaneToPlacement } from "./workplane-placement";

function rectangleSketch(): {
  readonly sketch: Sketch;
  readonly rectangleId: ReturnType<typeof createSketchEntityId>;
} {
  const bottom = createSketchEntityId("skent_p-bottom");
  const right = createSketchEntityId("skent_p-right");
  const top = createSketchEntityId("skent_p-top");
  const left = createSketchEntityId("skent_p-left");
  const rectangleId = createSketchEntityId("skent_p-rect");
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(bottom, { x: 10, y: 10 }, { x: 30, y: 10 }),
      createLineEntity(right, { x: 30, y: 10 }, { x: 30, y: 25 }),
      createLineEntity(top, { x: 30, y: 25 }, { x: 10, y: 25 }),
      createLineEntity(left, { x: 10, y: 25 }, { x: 10, y: 10 }),
      createRectangleEntity(rectangleId, [bottom, right, top, left]),
    ],
    [],
  );
  if (!created.ok) throw new Error(created.error.message);
  return { sketch: created.value, rectangleId };
}

describe("resolveProfileLoops", () => {
  it("resolves a rectangle's four lines into one closed loop (rectangle record contributes no boundary of its own)", () => {
    const { sketch } = rectangleSketch();
    const resolved = resolveProfileLoops(sketch.entities);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.loops.length).toBe(1);
    const loop = resolved.value.loops[0];
    if (loop === undefined) throw new Error("loop missing");
    expect(loop.segments.length).toBe(4);
    expect(loop.segments.every((segment) => segment.kind === "line")).toBe(
      true,
    );
    expect(Math.abs(profileLoopSignedArea(loop))).toBeCloseTo(20 * 15, 6);
  });

  it("resolves a circle into its own closed loop", () => {
    const created = createSketch(
      xyWorkplane(),
      [createCircleEntity(createSketchEntityId("skent_c1"), { x: 0, y: 0 }, 5)],
      [],
    );
    if (!created.ok) throw new Error(created.error.message);
    const resolved = resolveProfileLoops(created.value.entities);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.loops.length).toBe(1);
    const loop = resolved.value.loops[0];
    if (loop === undefined) throw new Error("loop missing");
    expect(loop.segments[0]?.kind).toBe("circle");
    expect(Math.abs(profileLoopSignedArea(loop))).toBeCloseTo(Math.PI * 25, 6);
  });

  it("closes a mixed line+arc chain (a stadium slot)", () => {
    const arcId = createSketchEntityId("skent_a1");
    // Two horizontal lines joined by a half-circle arc at each end; the
    // entities are drawn in MIXED directions on purpose (the walk must be
    // orientation-agnostic and the area walk-accurate).
    const lineBottom = createSketchEntityId("skent_l-bottom");
    const lineTop = createSketchEntityId("skent_l-top");
    const created = createSketch(
      xyWorkplane(),
      [
        createLineEntity(lineBottom, { x: 10, y: 0 }, { x: 0, y: 0 }),
        createLineEntity(lineTop, { x: 0, y: 10 }, { x: 10, y: 10 }),
        createArcEntity(arcId, { x: 10, y: 5 }, 5, -Math.PI / 2, Math.PI / 2),
        createArcEntity(
          createSketchEntityId("skent_a-left"),
          { x: 0, y: 5 },
          5,
          Math.PI / 2,
          (3 * Math.PI) / 2,
        ),
      ],
      [],
    );
    if (!created.ok) throw new Error(created.error.message);
    const resolved = resolveProfileLoops(created.value.entities);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.loops.length).toBe(1);
    const loop = resolved.value.loops[0];
    if (loop === undefined) throw new Error("loop missing");
    expect(loop.segments.map((segment) => segment.kind).sort()).toEqual([
      "arc",
      "arc",
      "line",
      "line",
    ]);
    // Area = rectangle 10×10 + full circle r=5 (the two half-round ends).
    const expected = 10 * 10 + Math.PI * 25;
    expect(Math.abs(profileLoopSignedArea(loop))).toBeCloseTo(expected, 6);
  });

  it("excludes construction entities from the profile", () => {
    const { sketch } = rectangleSketch();
    // Turn the top edge into construction geometry: the chain opens.
    const topEdge = sketch.entities.find(
      (candidate) =>
        candidate.kind === "line" && candidate.y1 === 25 && candidate.y2 === 25,
    );
    expect(topEdge).toBeDefined();
    const reconstructed = createSketch(
      sketch.workplane,
      sketch.entities.map((candidate) =>
        candidate.id === topEdge?.id
          ? { ...candidate, construction: true }
          : candidate,
      ),
      [],
    );
    if (!reconstructed.ok) throw new Error(reconstructed.error.message);
    const resolved = resolveProfileLoops(reconstructed.value.entities);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("sketch/profile-open-chain");
  });

  it("fails with sketch/profile-empty when no profile-capable geometry exists", () => {
    const created = createSketch(
      xyWorkplane(),
      [createPointEntity(createSketchEntityId("skent_pt"), { x: 1, y: 2 })],
      [],
    );
    if (!created.ok) throw new Error(created.error.message);
    const resolved = resolveProfileLoops(created.value.entities);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("sketch/profile-empty");
  });

  it("fails with sketch/profile-open-chain when the chain cannot close, naming the gap", () => {
    const a = createSketchEntityId("skent_o-a");
    const b = createSketchEntityId("skent_o-b");
    const created = createSketch(
      xyWorkplane(),
      [
        createLineEntity(a, { x: 0, y: 0 }, { x: 10, y: 0 }),
        createLineEntity(b, { x: 10, y: 0 }, { x: 10, y: 7 }),
      ],
      [],
    );
    if (!created.ok) throw new Error(created.error.message);
    const resolved = resolveProfileLoops(created.value.entities);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("sketch/profile-open-chain");
    expect(resolved.error.data.gapMm).toBeCloseTo(Math.hypot(10, 7), 6);
    expect(resolved.error.related).toEqual([a, b]);
  });

  it("fails with sketch/profile-degenerate for a zero-length line", () => {
    const created = createSketch(
      xyWorkplane(),
      [
        createLineEntity(
          createSketchEntityId("skent_z"),
          { x: 1, y: 1 },
          { x: 1, y: 1 },
        ),
      ],
      [],
    );
    if (!created.ok) throw new Error(created.error.message);
    const resolved = resolveProfileLoops(created.value.entities);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("sketch/profile-degenerate");
  });

  it("fails with sketch/profile-degenerate for a two-line zero-area loop", () => {
    const a = createSketchEntityId("skent_d-a");
    const b = createSketchEntityId("skent_d-b");
    const created = createSketch(
      xyWorkplane(),
      [
        createLineEntity(a, { x: 0, y: 0 }, { x: 10, y: 0 }),
        createLineEntity(b, { x: 10, y: 0 }, { x: 0, y: 0 }),
      ],
      [],
    );
    if (!created.ok) throw new Error(created.error.message);
    const resolved = resolveProfileLoops(created.value.entities);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("sketch/profile-degenerate");
  });

  it("detects a line×line self-crossing (a bowtie quadrilateral)", () => {
    const a = createSketchEntityId("skent_s-a");
    const b = createSketchEntityId("skent_s-b");
    const c = createSketchEntityId("skent_s-c");
    const d = createSketchEntityId("skent_s-d");
    const created = createSketch(
      xyWorkplane(),
      [
        createLineEntity(a, { x: 0, y: 0 }, { x: 10, y: 10 }),
        createLineEntity(b, { x: 10, y: 10 }, { x: 10, y: 0 }),
        createLineEntity(c, { x: 10, y: 0 }, { x: 0, y: 10 }),
        createLineEntity(d, { x: 0, y: 10 }, { x: 0, y: 0 }),
      ],
      [],
    );
    if (!created.ok) throw new Error(created.error.message);
    const resolved = resolveProfileLoops(created.value.entities);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("sketch/profile-self-intersecting");
    expect(resolved.error.related.length).toBe(2);
    expect(resolved.error.data.x).toBeCloseTo(5, 6);
    expect(resolved.error.data.y).toBeCloseTo(5, 6);
  });

  it("detects an arc×arc self-crossing (two r5 half-circles at (0,0)/(8,0) plus closing lines) on the extrude path", () => {
    // Two upper half-circles of radius 5 centred (0,0) and (8,0), joined by
    // two closing lines into one closed loop. The underlying circles cross
    // at (4, ±3); both arcs' sweeps cover (4, 3), so the boundary crosses
    // there. No line pair crosses and every line×arc touch is a shared
    // joint — only arc×arc detection rejects this loop, and it fires during
    // profile RESOLUTION, before any kernel ever sees the loop.
    const leftArc = createSketchEntityId("skent_aa-left");
    const rightArc = createSketchEntityId("skent_aa-right");
    const created = createSketch(
      xyWorkplane(),
      [
        createArcEntity(leftArc, { x: 0, y: 0 }, 5, 0, Math.PI),
        createArcEntity(rightArc, { x: 8, y: 0 }, 5, 0, Math.PI),
        createLineEntity(
          createSketchEntityId("skent_aa-join"),
          { x: -5, y: 0 },
          { x: 3, y: 0 },
        ),
        createLineEntity(
          createSketchEntityId("skent_aa-close"),
          { x: 13, y: 0 },
          { x: 5, y: 0 },
        ),
      ],
      [],
    );
    if (!created.ok) throw new Error(created.error.message);
    const resolved = resolveExtrudeProfile(created.value.entities);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("sketch/profile-self-intersecting");
    expect(resolved.error.related).toEqual([leftArc, rightArc]);
    expect(resolved.error.data.x).toBeCloseTo(4, 6);
    expect(resolved.error.data.y).toBeCloseTo(3, 6);
  });

  it("tolerances endpoint adjacency at PROFILE_ENDPOINT_TOLERANCE_MM", () => {
    const a = createSketchEntityId("skent_t-a");
    const b = createSketchEntityId("skent_t-b");
    const c = createSketchEntityId("skent_t-c");
    const d = createSketchEntityId("skent_t-d");
    const epsilon = PROFILE_ENDPOINT_TOLERANCE_MM / 2;
    const created = createSketch(
      xyWorkplane(),
      [
        createLineEntity(a, { x: 0, y: 0 }, { x: 10, y: 0 }),
        createLineEntity(b, { x: 10 + epsilon, y: 0 }, { x: 10, y: 10 }),
        createLineEntity(c, { x: 10, y: 10 }, { x: 0, y: 10 }),
        createLineEntity(d, { x: 0, y: 10 }, { x: 0, y: 0 }),
      ],
      [],
    );
    if (!created.ok) throw new Error(created.error.message);
    const resolved = resolveProfileLoops(created.value.entities);
    expect(resolved.ok).toBe(true);
  });

  it("resolves several disjoint loops and reports them (rectangle + circle)", () => {
    const { sketch } = rectangleSketch();
    const withCircle = createSketch(
      sketch.workplane,
      [
        ...sketch.entities,
        createCircleEntity(
          createSketchEntityId("skent_c2"),
          { x: -20, y: 0 },
          4,
        ),
      ],
      [],
    );
    if (!withCircle.ok) throw new Error(withCircle.error.message);
    const resolved = resolveProfileLoops(withCircle.value.entities);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.loops.length).toBe(2);
  });
});

describe("resolveExtrudeProfile", () => {
  it("returns the single loop for an extrudable sketch", () => {
    const { sketch } = rectangleSketch();
    const resolved = resolveExtrudeProfile(sketch.entities);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.segments.length).toBe(4);
  });

  it("fails with sketch/profile-multiple-loops when several loops exist", () => {
    const { sketch } = rectangleSketch();
    const withCircle = createSketch(
      sketch.workplane,
      [
        ...sketch.entities,
        createCircleEntity(
          createSketchEntityId("skent_c3"),
          { x: -20, y: 0 },
          4,
        ),
      ],
      [],
    );
    if (!withCircle.ok) throw new Error(withCircle.error.message);
    const resolved = resolveExtrudeProfile(withCircle.value.entities);
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("sketch/profile-multiple-loops");
    expect(resolved.error.data.loops).toBe(2);
  });
});

describe("workplaneToPlacement", () => {
  it("gives the identity rotation for the XY workplane", () => {
    const placement = workplaneToPlacement(xyWorkplane());
    expect(placement.rotation.angleRad).toBe(0);
    expect(placement.rotation.axis).toEqual([0, 0, 1]);
    expect(placement.translation).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("rotates the local +z onto a front workplane's −y normal", () => {
    const placement = workplaneToPlacement(frontWorkplane(4));
    expect(placement.rotation.angleRad).toBeCloseTo(Math.PI / 2, 12);
    const [x, y, z] = placement.rotation.axis;
    // Rodrigues: rotating +z by angle π/2 about this axis must give −y.
    const dot = x * x + y * y + z * z;
    expect(dot).toBeCloseTo(1, 12);
    const rotated = [
      // R(v) = v cosθ + (k×v) sinθ + k (k·v) (1 − cosθ), v = (0,0,1)
      y * Math.sin(placement.rotation.angleRad),
      -x * Math.sin(placement.rotation.angleRad),
      z * z * (1 - Math.cos(placement.rotation.angleRad)),
    ];
    expect(rotated[0]).toBeCloseTo(0, 9);
    expect(rotated[1]).toBeCloseTo(-1, 9);
    expect(rotated[2]).toBeCloseTo(0, 9);
    expect(placement.translation).toEqual({ x: 0, y: 4, z: 0 });
  });

  it("is deterministic: identical frames produce identical placements", () => {
    const first = workplaneToPlacement(frontWorkplane(4));
    const second = workplaneToPlacement(frontWorkplane(4));
    expect(second).toEqual(first);
  });
});
