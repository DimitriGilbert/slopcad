/**
 * Phase 54 drawing sheet web fixtures: the combined recovery over the real
 * seed document (dimension values derived from the same parameters the
 * geometry regenerates from — including the unit-converted depth), the
 * authoring batteries, and the reference-dimension/revision vocabularies.
 */

import { describe, expect, it } from "vitest";

import {
  seedDrawingDocument,
  referenceDimensionOf,
  validateReferenceDimensionSubmission,
  validateRevisionSubmission,
  validateTemplateSubmission,
  REFERENCE_DIMENSION_DEFAULTS,
  TITLE_BLOCK_DEFAULTS,
  type ReferenceDimensionSubmission,
} from "./drawing-sheet-authoring";
import {
  recoverDrawingEntities,
  threadDesignationFor,
} from "./drawing-sources";

const OPTIONS = {
  viewId: "view_front",
  originXMm: 50,
  originYMm: 128,
  viewWidthMm: 120,
  viewHeightMm: 80,
  scale: 0.5,
  sketchOriginYMm: 128 + 40,
  stackStepMm: 22,
} as const;

describe("combined drawing recovery (Phase 54)", () => {
  it("recovers dimensions and the thread callout from the seed", () => {
    const result = recoverDrawingEntities(seedDrawingDocument(), OPTIONS);
    // Extrude depth + fillet radius + two sketch constraints.
    expect(result.dimensions).toHaveLength(4);
    expect(result.annotations).toHaveLength(1);
    const depth = result.dimensions.find(
      (dimension) => dimension.kind === "linear" && dimension.valueMm === 20,
    );
    expect(depth).toBeDefined();
    const callout = result.annotations[0];
    expect(callout).toBeDefined();
    if (callout === undefined) return;
    if (callout.kind === "leader") {
      expect(callout.text).toContain("M8");
      expect(callout.text).toContain("6");
    }
  });

  it("carries model provenance on every recovered dimension", () => {
    const result = recoverDrawingEntities(seedDrawingDocument(), OPTIONS);
    for (const dimension of result.dimensions) {
      expect(dimension.origin.source).toBe("model");
    }
  });

  it("is deterministic across seeds", () => {
    const a = recoverDrawingEntities(seedDrawingDocument(), OPTIONS);
    const b = recoverDrawingEntities(seedDrawingDocument(), OPTIONS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("derives the ISO designation from the pinned table", () => {
    expect(threadDesignationFor(8, 1.25)).toBe("M8");
    expect(threadDesignationFor(8, 0.75)).toBe("M8x0.75");
    expect(threadDesignationFor(9, 1.25)).toBe("M9x1.25");
  });
});

describe("reference dimension authoring (Phase 54)", () => {
  it("refuses non-positive values before any state changes", () => {
    const verdict = validateReferenceDimensionSubmission({
      ...REFERENCE_DIMENSION_DEFAULTS,
      value: 0,
    });
    expect(verdict.ok).toBe(false);
  });

  it("refuses full-turn angular dimensions", () => {
    const verdict = validateReferenceDimensionSubmission({
      kind: "angular",
      orientation: "aligned",
      value: 360,
    });
    expect(verdict.ok).toBe(false);
  });

  it("authors a reference dimension with fixed id and provenance", () => {
    const submission: ReferenceDimensionSubmission = {
      kind: "linear",
      orientation: "horizontal",
      value: 25,
    };
    const dimension = referenceDimensionOf(submission, 0);
    expect(dimension).not.toBeNull();
    if (dimension === null) return;
    expect(dimension.id).toBe("drdim_ref-0");
    expect(dimension.origin).toEqual({ source: "reference" });
  });

  it("stacks successive reference dimensions deterministically", () => {
    const first = referenceDimensionOf(REFERENCE_DIMENSION_DEFAULTS, 0);
    const second = referenceDimensionOf(REFERENCE_DIMENSION_DEFAULTS, 1);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    if (first === null || second === null) return;
    if (first.kind !== "linear" || second.kind !== "linear") return;
    expect(second.id).toBe("drdim_ref-1");
    expect(first.from.y - second.from.y).toBe(12);
  });
});

describe("sheet authoring batteries (Phase 54)", () => {
  it("refuses unknown template ids", () => {
    expect(validateTemplateSubmission({ templateId: "nope" }).ok).toBe(false);
    expect(
      validateTemplateSubmission({ templateId: "a4-landscape-1-1" }).ok,
    ).toBe(true);
  });

  it("refuses revision rows without a marker or description", () => {
    expect(
      validateRevisionSubmission({
        revision: "",
        description: "x",
        author: "",
        date: "",
      }).ok,
    ).toBe(false);
    expect(
      validateRevisionSubmission({
        revision: "B",
        description: "",
        author: "",
        date: "",
      }).ok,
    ).toBe(false);
  });

  it("seeds a title block with honest defaults", () => {
    expect(TITLE_BLOCK_DEFAULTS.title).toBe("Bracket plate");
    expect(TITLE_BLOCK_DEFAULTS.scale).toBe("1:2");
  });
});
