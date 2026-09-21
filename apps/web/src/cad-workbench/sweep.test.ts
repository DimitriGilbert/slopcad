/**
 * The workbench sweep wiring tests (Phase 38): the path resolver's
 * planar-XZ mapping (sketch (x, y) → path (x, z), walk-reversed arcs keep
 * their negative signed sweep), the action-time validation battery's
 * structured refusals, and the document reader that turns the FIRST sweep
 * feature into its worker-scene request.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentSketch,
  addFeature,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createSketchDocumentId,
  type CadDocument,
} from "@slopcad/cad-core";
import {
  createArcEntity,
  createLineEntity,
  createSketch,
  createSketchEntityId,
  serializeSketch,
  xyWorkplane,
  type Sketch,
} from "@slopcad/cad-sketch";

import {
  documentSweepRequest,
  sketchPathResolverOf,
  validateSweepSubmission,
} from "./sweep";
import { sketchProfileResolverOf } from "./extrude";

/** A square profile loop centered on the local origin (±5). */
const SQUARE_LOOP = [
  { kind: "line", start: [-5, -5], end: [5, -5] },
  { kind: "line", start: [5, -5], end: [5, 5] },
  { kind: "line", start: [5, 5], end: [-5, 5] },
  { kind: "line", start: [-5, 5], end: [-5, -5] },
] as const;

function sketchOf(
  ...entities: readonly Parameters<typeof createSketch>[1][number][]
): Sketch {
  const created = createSketch(xyWorkplane(), entities, []);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

/** The canonical L path: (0,0) → (0,10) → (10,10), drawn against the walk. */
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

function sketchDocument(pathSketch: Sketch): CadDocument {
  let document = createDocument(createDocumentId("doc_workbench_sweep"));
  const profileSketch = sketchOf(
    createLineEntity(
      createSketchEntityId("skent_p1"),
      { x: -5, y: -5 },
      {
        x: 5,
        y: -5,
      },
    ),
    createLineEntity(
      createSketchEntityId("skent_p2"),
      { x: 5, y: -5 },
      {
        x: 5,
        y: 5,
      },
    ),
    createLineEntity(
      createSketchEntityId("skent_p3"),
      { x: 5, y: 5 },
      {
        x: -5,
        y: 5,
      },
    ),
    createLineEntity(
      createSketchEntityId("skent_p4"),
      { x: -5, y: 5 },
      {
        x: -5,
        y: -5,
      },
    ),
  );
  const sketched = addDocumentSketch(document, {
    id: createSketchDocumentId("skd_profile"),
    name: "profile",
    sketch: serializeSketch(profileSketch) as unknown as Record<
      string,
      unknown
    >,
  });
  if (!sketched.ok) throw new Error(sketched.error.message);
  document = sketched.value.document;
  const pathAdded = addDocumentSketch(document, {
    id: createSketchDocumentId("skd_path"),
    name: "path",
    sketch: serializeSketch(pathSketch) as unknown as Record<string, unknown>,
  });
  if (!pathAdded.ok) throw new Error(pathAdded.error.message);
  document = pathAdded.value.document;
  const body = addBody(document, {
    id: createBodyId("body_tube"),
    name: "tube",
  });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  const featured = addFeature(document, {
    id: createFeatureId("feat_sweep"),
    kind: "sweep",
    inputs: [
      { kind: "sketch", id: createSketchDocumentId("skd_profile") },
      { kind: "sketch", id: createSketchDocumentId("skd_path") },
    ],
    outputs: [createBodyId("body_tube")],
  });
  if (!featured.ok) throw new Error(featured.error.message);
  document = featured.value.document;
  return document;
}

describe("sketchPathResolverOf: the planar-XZ constraint mapping", () => {
  it("maps sketch coordinates onto the local XZ path plane", () => {
    const resolution = sketchPathResolverOf(sketchDocument(lPathSketch()))(
      createSketchDocumentId("skd_path"),
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.value.path).toEqual([
      { kind: "line", start: [0, 0], end: [0, 10] },
      { kind: "line", start: [0, 10], end: [10, 10] },
    ]);
  });

  it("keeps a walk-reversed arc's negative signed sweep", () => {
    // Quarter arc CCW 0 → π/2 about (10, 0), approached from its CCW end:
    // the walk reverses it, so the mapped path runs the negative sweep.
    const pathSketch = sketchOf(
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
    );
    const resolution = sketchPathResolverOf(sketchDocument(pathSketch))(
      createSketchDocumentId("skd_path"),
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    const arc = resolution.value.path[1];
    expect(arc).toEqual({
      kind: "arc",
      center: [10, 0],
      radius: 10,
      startAngle: { dimension: "angle", unit: "rad", value: Math.PI / 2 },
      endAngle: { dimension: "angle", unit: "rad", value: 0 },
    });
  });

  it("carries the sketch domain's failure verbatim for an unresolvable path", () => {
    const disconnected = sketchOf(
      createLineEntity(
        createSketchEntityId("skent_c1"),
        { x: 0, y: 0 },
        {
          x: 0,
          y: 5,
        },
      ),
      createLineEntity(
        createSketchEntityId("skent_c2"),
        { x: 20, y: 0 },
        {
          x: 20,
          y: 5,
        },
      ),
    );
    const resolution = sketchPathResolverOf(sketchDocument(disconnected))(
      createSketchDocumentId("skd_path"),
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) return;
    expect(resolution.error.code).toBe("sketch/path-multiple-chains");
  });
});

describe("validateSweepSubmission: the action-time battery", () => {
  const straight = [{ kind: "line", start: [0, 0], end: [0, 40] }] as const;

  it("accepts a sound straight path", () => {
    const validation = validateSweepSubmission({
      loop: [...SQUARE_LOOP],
      path: [...straight],
    });
    expect(validation).toEqual({ ok: true });
  });

  it("refuses a path that does not start at the origin", () => {
    const validation = validateSweepSubmission({
      loop: [...SQUARE_LOOP],
      path: [{ kind: "line", start: [0, 5], end: [0, 40] }],
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.code).toBe("kernel/invalid-path");
    expect(validation.message).toContain("local origin");
  });

  it("refuses a path whose initial tangent is not +z", () => {
    const validation = validateSweepSubmission({
      loop: [...SQUARE_LOOP],
      path: [{ kind: "line", start: [0, 0], end: [40, 0] }],
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.code).toBe("kernel/invalid-path");
    expect(validation.message).toContain("+z");
  });

  it("refuses a kinked path (G1 rule)", () => {
    const validation = validateSweepSubmission({
      loop: [...SQUARE_LOOP],
      path: [
        { kind: "line", start: [0, 0], end: [0, 10] },
        { kind: "line", start: [0, 10], end: [10, 10] },
      ],
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.code).toBe("kernel/invalid-path");
    expect(validation.message).toContain("tangent discontinuity");
  });

  it("reports the structural problem first when a path both kinks and crosses", () => {
    // The validation order mirrors the kernel contract's: structural
    // problems (G1) refuse with kernel/invalid-path BEFORE the
    // self-intersection battery runs.
    const validation = validateSweepSubmission({
      loop: [{ kind: "circle", center: [0, 0], radius: 1 }],
      path: [
        { kind: "line", start: [0, 0], end: [0, 30] },
        { kind: "line", start: [0, 30], end: [-15, 15] },
        { kind: "line", start: [-15, 15], end: [0, 30] },
      ],
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.code).toBe("kernel/invalid-path");
    expect(validation.message).toContain("tangent discontinuity");
  });

  it("refuses a G1 horseshoe whose return leg crosses its entry leg", () => {
    // Every joint is tangent-continuous (the structural battery passes);
    // the chord battery catches the return leg crossing the entry leg.
    const rad = (value: number) => ({
      dimension: "angle" as const,
      unit: "rad" as const,
      value,
    });
    const validation = validateSweepSubmission({
      loop: [{ kind: "circle", center: [0, 0], radius: 0.5 }],
      path: [
        { kind: "line", start: [0, 0], end: [0, 40] },
        {
          kind: "arc",
          center: [-15, 40],
          radius: 15,
          startAngle: rad(0),
          endAngle: rad(Math.PI),
        },
        { kind: "line", start: [-30, 40], end: [-30, 20] },
        {
          kind: "arc",
          center: [-15, 20],
          radius: 15,
          startAngle: rad(Math.PI),
          endAngle: rad((3 * Math.PI) / 2),
        },
        { kind: "line", start: [-15, 5], end: [15, 5] },
      ],
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.code).toBe("kernel/path-self-intersecting");
  });

  it("refuses a profile that pinches through a bend", () => {
    const wide = [
      { kind: "line", start: [-20, -1], end: [20, -1] },
      { kind: "line", start: [20, -1], end: [20, 1] },
      { kind: "line", start: [20, 1], end: [-20, 1] },
      { kind: "line", start: [-20, 1], end: [-20, -1] },
    ] as const;
    const validation = validateSweepSubmission({
      loop: wide,
      path: [
        { kind: "line", start: [0, 0], end: [0, 10] },
        {
          kind: "arc",
          center: [-10, 10],
          radius: 10,
          startAngle: { dimension: "angle", unit: "rad", value: 0 },
          endAngle: {
            dimension: "angle",
            unit: "rad",
            value: Math.PI / 2,
          },
        },
      ],
    });
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.code).toBe("kernel/sweep-self-intersecting");
    expect(validation.message).toContain("bend axis");
  });
});

describe("documentSweepRequest: the scene reader", () => {
  it("reads the first sweep feature into its scene request", () => {
    const request = documentSweepRequest(sketchDocument(lPathSketch()));
    expect(request).not.toBeNull();
    expect(request?.bodyId).toBe("body_tube");
    expect(request?.path).toEqual([
      { kind: "line", start: [0, 0], end: [0, 10] },
      { kind: "line", start: [0, 10], end: [10, 10] },
    ]);
    expect(request?.loop).toHaveLength(4);
    const profile = sketchProfileResolverOf(sketchDocument(lPathSketch()))(
      createSketchDocumentId("skd_profile"),
    );
    expect(profile.ok).toBe(true);
    if (!profile.ok) return;
    expect(request?.placement).toEqual(profile.value.placement);
  });

  it("returns null for a document without a sweep feature", () => {
    expect(
      documentSweepRequest(createDocument(createDocumentId("doc_empty"))),
    ).toBeNull();
  });
});
