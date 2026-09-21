/**
 * Dimension presentation (Phase 37) against hand fixtures: aligned
 * distances offset along the left normal with overshooting extension
 * lines; distanceX/distanceY run axis-aligned dimension lines; radial and
 * diametral leaders anchor at the documented angles; the angular arc spans
 * the stored value from the first operand's direction; serialization is
 * fixed-key-order and byte-stable across runs.
 */

import { describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";

import {
  createAngleConstraint,
  createDistanceConstraint,
  createDistanceXConstraint,
  createDistanceYConstraint,
  createDiameterConstraint,
  createRadiusConstraint,
} from "./constraints";
import {
  DIAMETRAL_TEXT_STANDOFF_MM,
  DIMENSION_CIRCLE_ANCHOR_ANGLE_RAD,
  DIMENSION_LINE_OFFSET_MM,
  dimensionPresentation,
  dimensionText,
  serializeDimensionPresentation,
  sketchDimensionPresentations,
} from "./dimensions";
import {
  createCircleEntity,
  createLineEntity,
  createPointEntity,
} from "./entities";
import { createSketch } from "./sketch";
import { createSketchConstraintId, createSketchEntityId } from "./sketch-ids";
import { xyWorkplane } from "./workplane";

const eid = createSketchEntityId;
const cid = createSketchConstraintId;

function sketchOf(
  entities: Parameters<typeof createSketch>[1],
  constraints: Parameters<typeof createSketch>[2],
): ReturnType<typeof createSketch> {
  return createSketch(xyWorkplane(), entities, constraints);
}

function requireSketch(sketch: ReturnType<typeof createSketch>) {
  if (!sketch.ok) throw new Error(sketch.error.message);
  return sketch.value;
}

describe("dimensionText", () => {
  it("formats every dimensional kind in its canonical unit", () => {
    const circle = createCircleEntity(eid("skent_c"), { x: 0, y: 0 }, 5);
    const sketch = requireSketch(
      sketchOf(
        [circle],
        [
          createRadiusConstraint(cid("skcon_r"), circle.id, length(5)),
          createDiameterConstraint(cid("skcon_d"), circle.id, length(10)),
        ],
      ),
    );
    const radius = sketch.constraints[0];
    const diameter = sketch.constraints[1];
    expect(radius !== undefined && dimensionText(radius)).toBe("R 5");
    expect(diameter !== undefined && dimensionText(diameter)).toBe("⌀ 10");
  });
});

describe("dimensionPresentation — linear", () => {
  it("offsets an aligned distance along the left normal and overshoots the extension lines", () => {
    const a = eid("skent_a");
    const b = eid("skent_b");
    const sketch = requireSketch(
      sketchOf(
        [
          createPointEntity(a, { x: 0, y: 0 }, {}),
          createPointEntity(b, { x: 30, y: 0 }, {}),
        ],
        [
          createDistanceConstraint(
            cid("skcon_d"),
            { entity: a, point: "center" },
            { entity: b, point: "center" },
            length(30),
          ),
        ],
      ),
    );
    const constraint = sketch.constraints[0];
    if (constraint === undefined || constraint.kind !== "distance") {
      throw new Error("expected the distance constraint");
    }
    const presentation = dimensionPresentation(sketch, constraint);
    expect(presentation !== null && presentation.kind).toBe("linear");
    if (presentation === null || presentation.kind !== "linear") return;
    // a→b runs +x; the left normal is +y: the dimension line sits 8 above.
    expect(presentation.dimensionLine.from.y).toBeCloseTo(
      DIMENSION_LINE_OFFSET_MM,
      9,
    );
    expect(presentation.dimensionLine.to.y).toBeCloseTo(
      DIMENSION_LINE_OFFSET_MM,
      9,
    );
    expect(presentation.dimensionLine.from.x).toBeCloseTo(0, 9);
    expect(presentation.dimensionLine.to.x).toBeCloseTo(30, 9);
    expect(presentation.extensionLines).toHaveLength(2);
    expect(presentation.text).toBe("30 mm");
    expect(presentation.textAnchor.y).toBeCloseTo(DIMENSION_LINE_OFFSET_MM, 9);
  });

  it("draws distanceX as a horizontal dimension line spanning the x separation", () => {
    const a = eid("skent_a");
    const b = eid("skent_b");
    const sketch = requireSketch(
      sketchOf(
        [
          createPointEntity(a, { x: 0, y: 0 }, {}),
          createPointEntity(b, { x: 20, y: 12 }, {}),
        ],
        [
          createDistanceXConstraint(
            cid("skcon_dx"),
            { entity: a, point: "center" },
            { entity: b, point: "center" },
            length(20),
          ),
        ],
      ),
    );
    const constraint = sketch.constraints[0];
    if (constraint === undefined || constraint.kind !== "distanceX") {
      throw new Error("expected the distanceX constraint");
    }
    const presentation = dimensionPresentation(sketch, constraint);
    if (presentation === null || presentation.kind !== "linear") {
      throw new Error("expected a linear presentation");
    }
    // The measured separation is along x, so the dimension line spans it
    // horizontally at the mid y, with vertical extension lines.
    expect(presentation.dimensionLine.from.x).toBeCloseTo(0, 9);
    expect(presentation.dimensionLine.to.x).toBeCloseTo(20, 9);
    expect(presentation.dimensionLine.from.y).toBeCloseTo(6, 9);
    expect(presentation.dimensionLine.to.y).toBeCloseTo(6, 9);
    expect(presentation.extensionLines[0]).toEqual({
      from: { x: 0, y: 0 },
      to: { x: 0, y: 6 },
    });
    expect(presentation.text).toBe("Δx 20 mm");
  });

  it("draws distanceY as a vertical dimension line spanning the y separation", () => {
    const a = eid("skent_a");
    const b = eid("skent_b");
    const sketch = requireSketch(
      sketchOf(
        [
          createPointEntity(a, { x: 0, y: 0 }, {}),
          createPointEntity(b, { x: 20, y: 12 }, {}),
        ],
        [
          createDistanceYConstraint(
            cid("skcon_dy"),
            { entity: a, point: "center" },
            { entity: b, point: "center" },
            length(12),
          ),
        ],
      ),
    );
    const constraint = sketch.constraints[0];
    if (constraint === undefined || constraint.kind !== "distanceY") {
      throw new Error("expected the distanceY constraint");
    }
    const presentation = dimensionPresentation(sketch, constraint);
    if (presentation === null || presentation.kind !== "linear") {
      throw new Error("expected a linear presentation");
    }
    // The measured separation is along y: a vertical dimension line at the
    // mid x, with horizontal extension lines.
    expect(presentation.dimensionLine.from.y).toBeCloseTo(0, 9);
    expect(presentation.dimensionLine.to.y).toBeCloseTo(12, 9);
    expect(presentation.dimensionLine.from.x).toBeCloseTo(10, 9);
    expect(presentation.dimensionLine.to.x).toBeCloseTo(10, 9);
    expect(presentation.text).toBe("Δy 12 mm");
  });
});

describe("dimensionPresentation — radial and diametral", () => {
  it("anchors a radius leader on a full circle at the documented angle", () => {
    const circle = createCircleEntity(eid("skent_c"), { x: 10, y: 10 }, 5);
    const sketch = requireSketch(
      sketchOf(
        [circle],
        [createRadiusConstraint(cid("skcon_r"), circle.id, length(5))],
      ),
    );
    const constraint = sketch.constraints[0];
    if (constraint === undefined || constraint.kind !== "radius") {
      throw new Error("expected the radius constraint");
    }
    const presentation = dimensionPresentation(sketch, constraint);
    if (presentation === null || presentation.kind !== "radial") {
      throw new Error("expected a radial presentation");
    }
    expect(presentation.leader.from.x).toBeCloseTo(10, 9);
    expect(presentation.leader.from.y).toBeCloseTo(10, 9);
    const anchor = DIMENSION_CIRCLE_ANCHOR_ANGLE_RAD;
    expect(presentation.leader.to.x).toBeCloseTo(10 + 5 * Math.cos(anchor), 9);
    expect(presentation.leader.to.y).toBeCloseTo(10 + 5 * Math.sin(anchor), 9);
    expect(presentation.text).toBe("R 5");
  });

  it("draws a diameter line across the circle through the center", () => {
    const circle = createCircleEntity(eid("skent_c"), { x: 10, y: 10 }, 5);
    const sketch = requireSketch(
      sketchOf(
        [circle],
        [createDiameterConstraint(cid("skcon_d"), circle.id, length(10))],
      ),
    );
    const constraint = sketch.constraints[0];
    if (constraint === undefined || constraint.kind !== "diameter") {
      throw new Error("expected the diameter constraint");
    }
    const presentation = dimensionPresentation(sketch, constraint);
    if (presentation === null || presentation.kind !== "diametral") {
      throw new Error("expected a diametral presentation");
    }
    const anchor = DIMENSION_CIRCLE_ANCHOR_ANGLE_RAD;
    expect(presentation.line.from.x).toBeCloseTo(10 + 5 * Math.cos(anchor), 9);
    expect(presentation.line.to.x).toBeCloseTo(10 - 5 * Math.cos(anchor), 9);
    // The label anchors beyond the rim (never on the across-line at the
    // center, where it would sit on the line it names).
    expect(presentation.textAnchor.x).toBeCloseTo(
      10 + (5 + DIAMETRAL_TEXT_STANDOFF_MM) * Math.cos(anchor),
      9,
    );
    expect(presentation.textAnchor.y).toBeCloseTo(
      10 + (5 + DIAMETRAL_TEXT_STANDOFF_MM) * Math.sin(anchor),
      9,
    );
    expect(presentation.text).toBe("⌀ 10");
  });
});

describe("dimensionPresentation — angular", () => {
  it("spans the stored value from the first operand's direction at the vertex", () => {
    const a = eid("skent_a");
    const b = eid("skent_b");
    const sketch = requireSketch(
      sketchOf(
        [
          createLineEntity(a, { x: 0, y: 0 }, { x: 40, y: 0 }),
          createLineEntity(b, { x: 0, y: 0 }, { x: 0, y: 30 }),
        ],
        [createAngleConstraint(cid("skcon_ang"), a, b, angle(90, "deg"))],
      ),
    );
    const constraint = sketch.constraints[0];
    if (constraint === undefined || constraint.kind !== "angle") {
      throw new Error("expected the angle constraint");
    }
    const presentation = dimensionPresentation(sketch, constraint);
    if (presentation === null || presentation.kind !== "angular") {
      throw new Error("expected an angular presentation");
    }
    expect(presentation.arc.center.x).toBeCloseTo(0, 9);
    expect(presentation.arc.center.y).toBeCloseTo(0, 9);
    expect(presentation.arc.startAngle).toBeCloseTo(0, 9);
    expect(presentation.arc.endAngle).toBeCloseTo(Math.PI / 2, 9);
    expect(presentation.text).toBe("90°");
  });

  it("falls back to a bare label for parallel operands", () => {
    const a = eid("skent_a");
    const b = eid("skent_b");
    const sketch = requireSketch(
      sketchOf(
        [
          createLineEntity(a, { x: 0, y: 0 }, { x: 40, y: 0 }),
          createLineEntity(b, { x: 0, y: 10 }, { x: 40, y: 10 }),
        ],
        [createAngleConstraint(cid("skcon_ang"), a, b, angle(0.0001, "deg"))],
      ),
    );
    const constraint = sketch.constraints[0];
    if (constraint === undefined || constraint.kind !== "angle") {
      throw new Error("expected the angle constraint");
    }
    const presentation = dimensionPresentation(sketch, constraint);
    if (presentation === null || presentation.kind !== "label") {
      throw new Error("expected the label fallback");
    }
    expect(presentation.textAnchor.y).toBeCloseTo(0, 9);
  });
});

describe("serialization", () => {
  it("serializes to a fixed-key-order record, byte-stable across runs", () => {
    const a = eid("skent_a");
    const b = eid("skent_b");
    const sketch = requireSketch(
      sketchOf(
        [
          createPointEntity(a, { x: 0, y: 0 }, {}),
          createPointEntity(b, { x: 30, y: 0 }, {}),
        ],
        [
          createDistanceConstraint(
            cid("skcon_d"),
            { entity: a, point: "center" },
            { entity: b, point: "center" },
            length(30),
          ),
        ],
      ),
    );
    const first = serializeDimensionPresentation(
      sketchDimensionPresentations(sketch)[0] as never,
    );
    const second = serializeDimensionPresentation(
      sketchDimensionPresentations(sketch)[0] as never,
    );
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(Object.keys(first)).toEqual([
      "kind",
      "id",
      "text",
      "dimensionLine",
      "extensionLines",
      "textAnchor",
    ]);
  });
});
