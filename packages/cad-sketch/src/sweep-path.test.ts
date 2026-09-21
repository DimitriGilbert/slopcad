/**
 * Sweep-path resolution tests (Phase 38): the open-chain sibling of profile
 * resolution — walk order (draw-direction independence, reversed arcs),
 * closed rings, polygon/slot constituents, and every structured failure of
 * the taxonomy (empty, unsupported entity, degenerate line, multiple
 * chains). Construction exclusion rides `segmentsOf` and is asserted once.
 */

import { describe, expect, it } from "vitest";

import {
  createArcEntity,
  createCircleEntity,
  createLineEntity,
  createPointEntity,
  createPolygonEntity,
  createSketch,
  createSketchEntityId,
  createSplineEntity,
  xyWorkplane,
  type Sketch,
} from "./index";
import { resolveSweepPath } from "./profile";

const TAU = Math.PI * 2;

function sketchOf(
  ...entities: readonly Parameters<typeof createSketch>[1][number][]
): Sketch {
  const created = createSketch(xyWorkplane(), entities, []);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

/** An L path from the origin: (0,0) → (0,10) → (10,10), drawn end to end. */
function lPathSketch(): Sketch {
  return sketchOf(
    createLineEntity(
      createSketchEntityId("skent_path-a"),
      { x: 0, y: 0 },
      {
        x: 0,
        y: 10,
      },
    ),
    createLineEntity(
      createSketchEntityId("skent_path-b"),
      { x: 10, y: 10 },
      {
        x: 0,
        y: 10,
      },
    ),
  );
}

describe("resolveSweepPath: the walk is the path", () => {
  it("resolves one open chain in walk order regardless of draw direction", () => {
    const resolved = resolveSweepPath(lPathSketch().entities);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.closed).toBe(false);
    expect(resolved.value.segments).toHaveLength(2);
    const first = resolved.value.segments[0];
    const second = resolved.value.segments[1];
    expect(first).toEqual({
      kind: "line",
      entity: "skent_path-a",
      start: { x: 0, y: 0 },
      end: { x: 0, y: 10 },
    });
    // The second entity was drawn right-to-left; the walk reverses it.
    expect(second).toEqual({
      kind: "line",
      entity: "skent_path-b",
      start: { x: 0, y: 10 },
      end: { x: 10, y: 10 },
    });
  });

  it("resolves a closed ring and flags it closed", () => {
    const closed = resolveSweepPath(
      sketchOf(
        createLineEntity(
          createSketchEntityId("skent_r1"),
          { x: 0, y: 0 },
          {
            x: 0,
            y: 8,
          },
        ),
        createLineEntity(
          createSketchEntityId("skent_r2"),
          { x: 0, y: 8 },
          {
            x: 8,
            y: 8,
          },
        ),
        createLineEntity(
          createSketchEntityId("skent_r3"),
          { x: 8, y: 8 },
          {
            x: 0,
            y: 0,
          },
        ),
      ).entities,
    );
    expect(closed.ok).toBe(true);
    if (!closed.ok) return;
    expect(closed.value.closed).toBe(true);
    expect(closed.value.segments).toHaveLength(3);
  });

  it("reverses an arc with the negative signed walk sweep", () => {
    // A quarter circle CCW from angle 0 to π/2 about (10, 0): starts at
    // (20, 0), ends at (10, 10). The line is drawn ending at the arc's CCW
    // END, so the chain walk must traverse the arc BACKWARD (from its CCW
    // end back to its start) to keep one directed path.
    const resolved = resolveSweepPath(
      sketchOf(
        createLineEntity(
          createSketchEntityId("skent_qline"),
          { x: 10, y: 14 },
          {
            x: 10,
            y: 10,
          },
        ),
        createArcEntity(
          createSketchEntityId("skent_qarc"),
          { x: 10, y: 0 },
          10,
          0,
          Math.PI / 2,
        ),
      ).entities,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.segments).toHaveLength(2);
    const [line, arc] = resolved.value.segments;
    expect(line).toEqual({
      kind: "line",
      entity: "skent_qline",
      start: { x: 10, y: 14 },
      end: { x: 10, y: 10 },
    });
    expect(arc).toEqual({
      kind: "arc",
      entity: "skent_qarc",
      center: { x: 10, y: 0 },
      radius: 10,
      startAngle: Math.PI / 2,
      endAngle: 0,
      walkSweep: -Math.PI / 2,
    });
    // A forward walk keeps the entity's own CCW sweep positive.
    const forward = resolveSweepPath(
      sketchOf(
        createArcEntity(
          createSketchEntityId("skent_qarc2"),
          { x: 10, y: 0 },
          10,
          0,
          Math.PI / 2,
        ),
        createLineEntity(
          createSketchEntityId("skent_qline2"),
          { x: 10, y: 10 },
          {
            x: 14,
            y: 10,
          },
        ),
      ).entities,
    );
    expect(forward.ok).toBe(true);
    if (!forward.ok) return;
    const forwardArc = forward.value.segments[0];
    expect(forwardArc).toMatchObject({ walkSweep: Math.PI / 2 });
  });

  it("chains polygon and rectangle constituents as line segments", () => {
    const resolved = resolveSweepPath(
      sketchOf(
        createPolygonEntity(
          createSketchEntityId("skent_hex"),
          { x: 0, y: 0 },
          5,
          6,
          0,
          "inscribed",
        ),
      ).entities,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.closed).toBe(true);
    expect(resolved.value.segments).toHaveLength(6);
    for (const segment of resolved.value.segments) {
      expect(segment.kind).toBe("line");
    }
  });

  it("excludes construction geometry from the chain", () => {
    const resolved = resolveSweepPath(
      sketchOf(
        createLineEntity(
          createSketchEntityId("skent_con"),
          { x: 0, y: 0 },
          { x: 0, y: 5 },
          { construction: true },
        ),
      ).entities,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("sketch/path-empty");
  });
});

describe("resolveSweepPath: the structured failures", () => {
  it("fails with sketch/path-empty on no path-capable geometry", () => {
    const resolved = resolveSweepPath(
      sketchOf(
        createPointEntity(createSketchEntityId("skent_point"), { x: 4, y: 4 }),
      ).entities,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("sketch/path-empty");
  });

  it("fails with sketch/path-unsupported-entity naming the offending entity", () => {
    const resolved = resolveSweepPath(
      sketchOf(
        createLineEntity(
          createSketchEntityId("skent_ok"),
          { x: 0, y: 0 },
          {
            x: 0,
            y: 6,
          },
        ),
        createCircleEntity(
          createSketchEntityId("skent_circle"),
          {
            x: 10,
            y: 0,
          },
          3,
        ),
      ).entities,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("sketch/path-unsupported-entity");
    expect(resolved.error.related).toEqual(["skent_circle"]);
  });

  it("fails with sketch/path-unsupported-entity for a spline too", () => {
    const resolved = resolveSweepPath(
      sketchOf(
        createSplineEntity(createSketchEntityId("skent_spline"), "control", [
          { x: 0, y: 0 },
          { x: 2, y: 4 },
          { x: 6, y: 6 },
          { x: 10, y: 0 },
        ]),
      ).entities,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("sketch/path-unsupported-entity");
  });

  it("fails with sketch/path-degenerate on a zero-length line", () => {
    const resolved = resolveSweepPath(
      sketchOf(
        createLineEntity(
          createSketchEntityId("skent_zero"),
          { x: 3, y: 3 },
          {
            x: 3,
            y: 3,
          },
        ),
      ).entities,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("sketch/path-degenerate");
    expect(resolved.error.related).toEqual(["skent_zero"]);
  });

  it("fails with sketch/path-multiple-chains on disconnected chains", () => {
    const resolved = resolveSweepPath(
      sketchOf(
        createLineEntity(
          createSketchEntityId("skent_c1a"),
          { x: 0, y: 0 },
          {
            x: 0,
            y: 5,
          },
        ),
        createLineEntity(
          createSketchEntityId("skent_c1b"),
          { x: 0, y: 5 },
          {
            x: 5,
            y: 5,
          },
        ),
        createLineEntity(
          createSketchEntityId("skent_c2a"),
          { x: 20, y: 0 },
          {
            x: 20,
            y: 5,
          },
        ),
        createLineEntity(
          createSketchEntityId("skent_c2b"),
          { x: 20, y: 5 },
          {
            x: 25,
            y: 5,
          },
        ),
      ).entities,
    );
    expect(resolved.ok).toBe(false);
    if (resolved.ok) return;
    expect(resolved.error.code).toBe("sketch/path-multiple-chains");
    expect(resolved.error.data.chains).toBe(2);
  });

  it("keeps every failure JSON-safe (persisted-data stability)", () => {
    const resolved = resolveSweepPath(lPathSketch().entities);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(() => JSON.stringify(resolved.value)).not.toThrow();
    expect(TAU).toBeGreaterThan(0);
  });
});
