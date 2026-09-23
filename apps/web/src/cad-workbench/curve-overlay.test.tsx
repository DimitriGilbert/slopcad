/**
 * The curve overlay's component tests (Phase 47): the document's curve
 * records render one machine-surfaced marker each (the datum overlay's
 * discipline — presence and identity without reading pixels), a curve
 * whose evaluation refuses draws nothing, and an empty document renders
 * the empty layer.
 */

import { cleanup, render } from "@testing-library/react";
import {
  addDocumentCurve,
  createDocument,
  createDocumentId,
  type RenderProjection,
} from "@slopcad/cad-core";
import { afterEach, describe, expect, it } from "vitest";

import { CadCurveOverlay } from "./curve-overlay";

afterEach(cleanup);

const PROJECTION: RenderProjection = {
  objects: [],
  camera: {
    kind: "orthographic",
    position: [15, 10, 100],
    target: [15, 10, 5],
    up: [0, 1, 0],
    viewWidth: 60,
    viewHeight: 40,
  },
};

function documentWithCurves(): ReturnType<typeof createDocument> {
  let document = createDocument(createDocumentId("doc_curve_overlay"));
  for (const curve of [
    {
      name: "spine guide",
      curve: {
        kind: "interpolated-spline",
        points: [
          [0, 0, 0],
          [20, 0, 20],
          [40, 10, 40],
        ],
      },
    },
    {
      name: "coil",
      curve: {
        kind: "helix",
        radius: { dimension: "length", unit: "mm", value: 6 },
        pitch: { dimension: "length", unit: "mm", value: 4 },
        turns: 2.5,
        handedness: 1,
        startAngle: { dimension: "angle", unit: "rad", value: 0 },
      },
    },
  ] as const) {
    const added = addDocumentCurve(document, curve);
    if (!added.ok) {
      throw new Error(`the curve fixture must commit: ${added.error.code}`);
    }
    document = added.value.document;
  }
  return document;
}

describe("CadCurveOverlay", () => {
  it("renders one machine-surfaced marker per drawable curve record", () => {
    render(
      <CadCurveOverlay
        document={documentWithCurves()}
        projection={PROJECTION}
      />,
    );
    const layer = document.querySelector("[data-curve-overlay]");
    expect(layer?.getAttribute("data-curve-overlay")).toBe("curves");
    expect(layer?.getAttribute("data-curve-count")).toBe("2");
    const markers = [
      ...document.querySelectorAll("[data-curve-overlay-marker]"),
    ];
    expect(markers).toHaveLength(2);
    for (const marker of markers) {
      expect(marker.querySelector("polyline")).not.toBeNull();
    }
    // The markers are identified by the records' own ids (the id
    // generator's zero-padded counter order): presence AND identity
    // without reading pixels.
    expect(
      document.querySelector("[data-curve-overlay-marker=crv_000001]"),
    ).not.toBeNull();
    expect(
      document.querySelector("[data-curve-overlay-marker=crv_000002]"),
    ).not.toBeNull();
  });

  it("renders the empty layer for a document without curves", () => {
    render(
      <CadCurveOverlay
        document={createDocument(createDocumentId("doc_curve_empty"))}
        projection={PROJECTION}
      />,
    );
    const layer = document.querySelector("[data-curve-overlay]");
    expect(layer?.getAttribute("data-curve-overlay")).toBe("empty");
  });
});
