/**
 * The parametric viewer core's tests (the final registry phase): the pure
 * half of the `parametric-cad-viewer` block, proven against the public
 * cad-core/cad-kernel surfaces alone — parse (the format's own full
 * parser), summary/title derivation, the deterministic home camera, the
 * tessellation projection path (including its structured refusals), and
 * the lossless round trip back to canonical native text.
 */

import { describe, expect, it } from "vitest";
import {
  EMPTY_PARAMETER_COLLECTION,
  addParameter,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSession,
  length,
  parseExpression,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  type CadSession,
  type ParameterCollection,
  type ParseFailure,
  type ParseResult,
  type RenderCamera,
} from "@slopcad/cad-core";

import {
  frameViewerCamera,
  loadViewerSource,
  projectViewerBodies,
  serializeViewerSession,
  viewerTitleOf,
  type ViewerBody,
} from "./parametric-viewer-core";

function requireOk<T, E extends ParseFailure>(
  result: ParseResult<T, E>,
  what: string,
): T {
  if (!result.ok) {
    throw new Error(
      `The test fixture could not build ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

/**
 * Builds the drill document: a plate whose `half` parameter is
 * expression-derived from `width` (both edit-mode field shapes a viewer
 * must summarize).
 */
function buildDrillSession(): CadSession {
  const document = createDocument(createDocumentId("doc_drill-plate"));
  let collection: ParameterCollection = EMPTY_PARAMETER_COLLECTION;
  collection = requireOk(
    addParameter(collection, {
      id: createParameterId("param_width"),
      name: "width",
      value: length(30),
    }),
    "the width parameter",
  );
  const halfExpression = requireOk(
    parseExpression("width / 2"),
    "the half expression",
  );
  collection = requireOk(
    addParameter(collection, {
      id: createParameterId("param_half"),
      name: "half",
      value: length(15),
      expression: halfExpression,
    }),
    "the half parameter",
  );
  return createSession(Object.freeze({ ...document, parameters: collection }));
}

/** Serializes a session into canonical native text with the given metadata. */
function nativeTextOf(
  session: CadSession,
  metadata: Record<string, string>,
): string {
  return stringifyNativeCadDocument(
    serializeNativeCadDocument({
      document: session.document,
      history: session.history,
      regeneration: new Map(),
      metadata,
      rollback: null,
      drawing: null,
    }),
  );
}

function drillNativeText(): string {
  return nativeTextOf(buildDrillSession(), { title: "Drill plate" });
}

/** A closed unit-ish cube's triangle soup, placed at `at` and 10 mm on a side. */
function cubeBody(bodyId: string, at: [number, number, number]): ViewerBody {
  const [x, y, z] = at;
  return {
    bodyId: createBodyId(bodyId),
    tessellation: {
      positions: [
        x,
        y,
        z,
        x + 10,
        y,
        z,
        x + 10,
        y + 10,
        z,
        x,
        y + 10,
        z,
        x,
        y,
        z + 10,
        x + 10,
        y,
        z + 10,
        x + 10,
        y + 10,
        z + 10,
        x,
        y + 10,
        z + 10,
      ],
      indices: [
        0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 2, 6, 7, 2, 7, 3,
        1, 5, 6, 1, 6, 2, 3, 7, 4, 3, 4, 0,
      ],
    },
  };
}

describe("loadViewerSource", () => {
  it("parses canonical native text into the session pair and the summary", () => {
    const loaded = loadViewerSource(drillNativeText());
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.document.id).toBe("doc_drill-plate");
    expect(loaded.summary).toEqual({
      title: "Drill plate",
      parameterCount: 2,
      featureCount: 0,
      bodyCount: 0,
    });
    expect(loaded.session.document).toBe(loaded.document);
    expect(loaded.persisted.metadata).toEqual({ title: "Drill plate" });
  });

  it("falls back to the document id when no metadata title is set", () => {
    const loaded = loadViewerSource(nativeTextOf(buildDrillSession(), {}));
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.summary.title).toBe("doc_drill-plate");
  });

  it("refuses malformed text with the parser's structured message", () => {
    const loaded = loadViewerSource("{not json");
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.error).toContain("valid JSON");
  });

  it("exposes the metadata-title rule as its own function", () => {
    const document = createDocument(createDocumentId("doc_x"));
    expect(viewerTitleOf(document, { title: "  " })).toBe("doc_x");
    expect(viewerTitleOf(document, { title: "Named" })).toBe("Named");
  });
});

describe("projectViewerBodies", () => {
  it("projects bodies into a framed projection with the derived camera", () => {
    const build = projectViewerBodies([
      cubeBody("body_plate", [0, 0, 0]),
      cubeBody("body_boss", [30, 0, 0]),
    ]);
    expect(build.ok).toBe(true);
    if (!build.ok) return;
    expect(build.projection.objects).toHaveLength(2);
    const camera = build.projection.camera;
    if (camera.kind !== "perspective") throw new Error("expected perspective");
    // The scene spans [0,40] x [0,10] x [0,10]; the target is its center.
    expect(camera.target).toEqual([20, 5, 5]);
    expect(camera.up).toEqual([0, 0, 1]);
    // The eye sits in the (+x, -y, +z) octant, away from the target.
    expect(camera.position[0]).toBeGreaterThan(20);
    expect(camera.position[1]).toBeLessThan(5);
    expect(camera.position[2]).toBeGreaterThan(5);
  });

  it("derives the identical camera for the identical objects (determinism)", () => {
    const bodies = [cubeBody("body_plate", [0, 0, 0])];
    const first = projectViewerBodies(bodies);
    const second = projectViewerBodies(bodies);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.projection.camera).toEqual(second.projection.camera);
  });

  it("honors a caller-supplied camera verbatim", () => {
    const camera: RenderCamera = {
      kind: "perspective",
      position: [44, -30, 47],
      target: [5, 5, 5],
      up: [0, 0, 1],
      fovDeg: 40,
    };
    const build = projectViewerBodies(
      [cubeBody("body_plate", [0, 0, 0])],
      camera,
    );
    expect(build.ok).toBe(true);
    if (!build.ok) return;
    expect(build.projection.camera).toEqual(camera);
  });

  it("frames a degenerate zero-extent scene with a valid camera", () => {
    const build = projectViewerBodies([
      {
        bodyId: createBodyId("body_point"),
        tessellation: {
          positions: [5, 5, 5, 5, 5, 5, 5, 5, 5],
          indices: [0, 1, 2],
        },
      },
    ]);
    expect(build.ok).toBe(true);
  });

  it("refuses an empty body list", () => {
    const build = projectViewerBodies([]);
    expect(build.ok).toBe(false);
    if (build.ok) return;
    expect(build.error).toContain("at least one tessellated body");
  });

  it("refuses duplicate body ids through the projection's own code", () => {
    const build = projectViewerBodies([
      cubeBody("body_plate", [0, 0, 0]),
      cubeBody("body_plate", [30, 0, 0]),
    ]);
    expect(build.ok).toBe(false);
    if (build.ok) return;
    expect(build.error).toContain("Duplicate render object id");
  });

  it("carries the feature id as provenance when supplied", () => {
    const build = projectViewerBodies([
      {
        bodyId: createBodyId("body_plate"),
        tessellation: cubeBody("body_plate", [0, 0, 0]).tessellation,
        featureId: createFeatureId("feat_box"),
      },
    ]);
    expect(build.ok).toBe(true);
    if (!build.ok) return;
    expect(build.projection.objects[0]?.featureId).toBe("feat_box");
  });
});

describe("frameViewerCamera", () => {
  it("places the eye along the home-view direction at the derived distance", () => {
    const build = projectViewerBodies([cubeBody("body_plate", [0, 0, 0])]);
    if (!build.ok) throw new Error(build.error);
    const camera = frameViewerCamera(build.projection.objects);
    if (camera.kind !== "perspective") throw new Error("expected perspective");
    // The cube spans [0,10]^3: diagonal ~17.3 mm, distance ~1.7x that.
    const dx = camera.position[0] - camera.target[0];
    const dy = camera.position[1] - camera.target[1];
    const dz = camera.position[2] - camera.target[2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
    expect(distance).toBeGreaterThan(25);
    expect(distance).toBeLessThan(35);
  });
});

describe("serializeViewerSession", () => {
  it("round-trips a loaded source to identical canonical bytes", () => {
    const text = drillNativeText();
    const loaded = loadViewerSource(text);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(serializeViewerSession(loaded.session, loaded.persisted)).toBe(text);
  });

  it("preserves the metadata and the expression parameter through a round trip", () => {
    const loaded = loadViewerSource(drillNativeText());
    if (!loaded.ok) throw new Error(loaded.error);
    const again = loadViewerSource(
      serializeViewerSession(loaded.session, loaded.persisted),
    );
    if (!again.ok) throw new Error(again.error);
    expect(again.persisted.metadata).toEqual({ title: "Drill plate" });
    const half = again.document.parameters.parameters.find(
      (parameter) => parameter.id === "param_half",
    );
    if (half === undefined) throw new Error("the half parameter was lost");
    expect(half.expression).not.toBe(null);
  });
});
