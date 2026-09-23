/**
 * Phase 54 drawing-annotation fixtures: parse/serialize round-trips in both
 * directions, the structured declines, and the fixed-key serialization
 * order the byte-determinism law pins.
 */

import { describe, expect, it } from "vitest";

import {
  parseDrawingAnnotation,
  parseDrawingDimension,
  parseDrawingDimensionId,
  serializeDrawingAnnotation,
  serializeDrawingDimension,
  type DrawingAnnotation,
  type DrawingAnnotationId,
  type DrawingDimension,
  type DrawingDimensionId,
} from "./drawing-annotations";

const LINEAR = {
  kind: "linear",
  id: "drdim_extrude-depth" as DrawingDimensionId,
  viewId: "view_front",
  orientation: "vertical",
  from: { x: 100, y: 40 },
  to: { x: 100, y: 60 },
  offsetMm: 6,
  valueMm: 20,
  origin: {
    source: "model",
    kind: "feature-parameter",
    featureId: "feat_base",
    parameterId: "param_depth",
    parameterName: "depth",
  },
} as const;

describe("drawing dimension round-trip (Phase 54)", () => {
  it("parse(serialize(d)) equals d for every kind", () => {
    const dimensions: readonly DrawingDimension[] = [
      LINEAR,
      {
        kind: "radial",
        id: "drdim_fillet-radius" as DrawingDimensionId,
        viewId: "view_front",
        center: { x: 50, y: 50 },
        rim: { x: 54, y: 54 },
        valueMm: 4,
        origin: { source: "reference" },
      },
      {
        kind: "diameter",
        id: "drdim_hole-diameter" as DrawingDimensionId,
        viewId: "view_top",
        center: { x: 60, y: 60 },
        radiusMm: 5,
        anchorAngleRad: Math.PI / 4,
        valueMm: 10,
        origin: { source: "reference" },
      },
      {
        kind: "angular",
        id: "drdim_taper-angle" as DrawingDimensionId,
        viewId: "view_front",
        vertex: { x: 30, y: 30 },
        startAngleRad: 0,
        endAngleRad: Math.PI / 3,
        arcRadiusMm: 10,
        valueDeg: 60,
        origin: { source: "reference" },
      },
    ];
    for (const dimension of dimensions) {
      const parsed = parseDrawingDimension(
        serializeDrawingDimension(dimension),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value).toEqual(dimension);
    }
  });

  it("serializes in fixed key order regardless of authoring order", () => {
    const reordered = {
      origin: LINEAR.origin,
      valueMm: LINEAR.valueMm,
      offsetMm: LINEAR.offsetMm,
      to: LINEAR.to,
      from: LINEAR.from,
      orientation: LINEAR.orientation,
      viewId: LINEAR.viewId,
      id: LINEAR.id,
      kind: LINEAR.kind,
    };
    const canonical = JSON.stringify(serializeDrawingDimension(LINEAR));
    expect(JSON.stringify(serializeDrawingDimension(reordered as never))).toBe(
      canonical,
    );
    expect(canonical.indexOf('"kind"')).toBeLessThan(
      canonical.indexOf('"origin"'),
    );
  });

  it("declines structured: unknown kind, bad id, unknown origin", () => {
    const badKind = parseDrawingDimension({ ...LINEAR, kind: "diametral" });
    expect(badKind.ok).toBe(false);
    const badId = parseDrawingDimension({ ...LINEAR, id: "dim_extrude" });
    expect(badId.ok).toBe(false);
    const badOrigin = parseDrawingDimension({
      ...LINEAR,
      origin: { source: "elsewhere" },
    });
    expect(badOrigin.ok).toBe(false);
    if (!badOrigin.ok) {
      expect(badOrigin.error.code).toBe("drawing-annotations/invalid-field");
    }
  });

  it("rejects non-numeric geometry with the missing-field code", () => {
    const parsed = parseDrawingDimension({ ...LINEAR, valueMm: "20" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.error.code).toBe("drawing-annotations/missing-field");
    }
  });
});

describe("drawing annotation round-trip (Phase 54)", () => {
  it("parse(serialize(a)) equals a for every kind", () => {
    const annotations: readonly DrawingAnnotation[] = [
      {
        kind: "note",
        id: "drann_note-1" as DrawingAnnotationId,
        viewId: "view_front",
        anchor: { x: 30, y: 180 },
        text: " chamfer after plating",
      },
      {
        kind: "leader",
        id: "drann_leader-1" as DrawingAnnotationId,
        viewId: "view_front",
        tip: { x: 60, y: 55 },
        elbow: { x: 80, y: 75 },
        text: "inspect edge",
      },
      {
        kind: "holeCallout",
        id: "drann_hole-1" as DrawingAnnotationId,
        viewId: "view_top",
        tip: { x: 60, y: 60 },
        elbow: { x: 90, y: 80 },
        diameterMm: 8,
        depthMm: 6,
      },
      {
        kind: "threadCallout",
        id: "drann_thread-1" as DrawingAnnotationId,
        viewId: "view_top",
        tip: { x: 60, y: 60 },
        elbow: { x: 90, y: 90 },
        designation: "M8x1.25",
        depthMm: null,
      },
      {
        kind: "featureControlFrame",
        id: "drann_fcf-1" as DrawingAnnotationId,
        viewId: "view_front",
        anchor: { x: 40, y: 160 },
        characteristic: "flatness",
        toleranceMm: 0.05,
        datumRefs: ["A", "B"],
      },
    ];
    for (const annotation of annotations) {
      const parsed = parseDrawingAnnotation(
        serializeDrawingAnnotation(annotation),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value).toEqual(annotation);
    }
  });

  it("declines structured: unknown characteristic, non-string datum refs", () => {
    const badCharacteristic = parseDrawingAnnotation({
      kind: "featureControlFrame",
      id: "drann_fcf-2",
      viewId: "v",
      anchor: { x: 0, y: 0 },
      characteristic: "vibrancy",
      toleranceMm: 0.1,
      datumRefs: [],
    });
    expect(badCharacteristic.ok).toBe(false);
    if (!badCharacteristic.ok) {
      expect(badCharacteristic.error.code).toBe(
        "drawing-annotations/unknown-characteristic",
      );
    }
    const badDatums = parseDrawingAnnotation({
      kind: "featureControlFrame",
      id: "drann_fcf-3",
      viewId: "v",
      anchor: { x: 0, y: 0 },
      characteristic: "position",
      toleranceMm: 0.1,
      datumRefs: [1],
    });
    expect(badDatums.ok).toBe(false);
  });
});

describe("drawing id parsing", () => {
  it("accepts both prefixes and declines cross-prefix use", () => {
    expect(parseDrawingDimensionId("drdim_ok.1-x").ok).toBe(true);
    expect(parseDrawingDimensionId("drann_ok").ok).toBe(false);
    expect(parseDrawingDimensionId("drdim_").ok).toBe(false);
  });
});
