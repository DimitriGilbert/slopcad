/**
 * Phase 54 sketch-constraint dimension recovery fixtures: constraint dims
 * recover as drawing dimensions whose values derive from the constraint
 * records themselves (the parametric-source law), unit-converted through
 * `valueIn`, in deterministic document/constraint order.
 */

import { describe, expect, it } from "vitest";
import {
  addDocumentSketch,
  createDocument,
  createDocumentId,
} from "@slopcad/cad-core";

import {
  recoverSketchDimensions,
  dimensionalConstraintIdsOf,
  type SketchDimensionRecoveryOptions,
} from "./drawing-dimension-source";
import { dimensionedRectangleSketch } from "./sketch-fixtures";
import { serializeSketch } from "./sketch";

const OPTIONS: SketchDimensionRecoveryOptions = {
  viewId: "view_front",
  originXMm: 30,
  originYMm: 40,
  scale: 0.5,
  stackStepMm: 14,
};

function documentWithRectangleSketch(): ReturnType<typeof createDocument> {
  let document = createDocument(createDocumentId("doc_drawing_sketch"));
  const added = addDocumentSketch(document, {
    name: "plate",
    sketch: serializeSketch(dimensionedRectangleSketch()) as unknown as Record<
      string,
      unknown
    >,
  });
  if (!added.ok)
    throw new Error(`addDocumentSketch failed: ${JSON.stringify(added.error)}`);
  document = added.value.document;
  return document;
}

describe("sketch-constraint dimension recovery (Phase 54)", () => {
  it("recovers the rectangle's two distance constraints in order", () => {
    const document = documentWithRectangleSketch();
    const dimensions = recoverSketchDimensions(document, OPTIONS);
    expect(dimensions).toHaveLength(2);
    const [width, height] = dimensions;
    expect(width).toBeDefined();
    expect(height).toBeDefined();
    if (width === undefined || height === undefined) return;
    expect(width.kind).toBe("linear");
    expect(height.kind).toBe("linear");
    if (width.kind !== "linear" || height.kind !== "linear") return;
    // Values derive from the SAME constraint records the solver consumes.
    expect(width.valueMm).toBe(60);
    expect(height.valueMm).toBe(40);
    expect(width.origin.source).toBe("model");
    if (
      width.origin.source === "model" &&
      width.origin.kind === "sketch-constraint"
    ) {
      expect(width.origin.constraintId).toBe("skcon_rect-width");
    }
    // Drawn geometry rides the view scale: 60mm at 1:2 spans 30mm.
    expect(width.to.x - width.from.x).toBe(30);
    // The height constraint is a plain distance: an aligned dim whose
    // drawn span rides the view scale (40mm at 1:2 = 20mm).
    if (height.kind === "linear") {
      expect(height.to.x - height.from.x).toBe(20);
    }
  });

  it("stacks deterministically along the view frame's bottom edge", () => {
    const document = documentWithRectangleSketch();
    const dimensions = recoverSketchDimensions(document, OPTIONS);
    const a = JSON.stringify(dimensions);
    const b = JSON.stringify(
      recoverSketchDimensions(documentWithRectangleSketch(), OPTIONS),
    );
    expect(a).toBe(b);
    const [first, second] = dimensions;
    if (first === undefined || second === undefined) return;
    if (first.kind !== "linear" || second.kind !== "linear") return;
    expect(first.from.x - second.from.x).toBe(0);
    expect(second.from.y - first.from.y).toBe(OPTIONS.stackStepMm);
  });

  it("summarizes dimensional constraint ids for the workbench surface", () => {
    const document = documentWithRectangleSketch();
    expect(dimensionalConstraintIdsOf(document)).toEqual([
      "skcon_rect-width",
      "skcon_rect-height",
    ]);
  });

  it("declines an unparsable sketch payload honestly", () => {
    let document = createDocument(createDocumentId("doc_drawing_bad"));
    const added = addDocumentSketch(document, {
      name: "broken",
      sketch: { formatVersion: 99 },
    });
    if (added.ok) document = added.value.document;
    expect(recoverSketchDimensions(document, OPTIONS)).toHaveLength(0);
  });
});
