/**
 * The workbench helix + thread wiring tests (Phase 40): the action-time
 * validation batteries' structured refusals, the document readers that
 * turn the FIRST helix/thread feature into worker-scene requests (spine
 * parameters, the datum-axis frame), and the default placements.
 */

import { describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentDatum,
  addDocumentParameter,
  addDocumentSketch,
  addFeature,
  angle,
  createBodyId,
  createDocument,
  createDocumentId,
  createDatumId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  dimensionless,
  length,
  type CadDocument,
} from "@slopcad/cad-core";
import {
  createCircleEntity,
  createLineEntity,
  createSketch,
  createSketchEntityId,
  serializeSketch,
  xyWorkplane,
} from "@slopcad/cad-sketch";

import {
  documentHelixRequest,
  helixPlacementForAxis,
  helixSpineOf,
  HELIX_DEFAULTS,
  validateHelixSubmission,
} from "./helix";
import { resolveSessionDatumAxis } from "./datum";
import {
  documentThreadSceneRequest,
  THREAD_DEFAULTS,
  THREAD_MODE_VALUES,
  validateThreadSubmission,
} from "./thread";

/** The meridian rectangle: u ∈ [0, 2], v ∈ [−0.75, 0.75]. */
const MERIDIAN_LOOP = [
  { kind: "line", start: [0, -0.75], end: [2, -0.75] },
  { kind: "line", start: [2, -0.75], end: [2, 0.75] },
  { kind: "line", start: [2, 0.75], end: [0, 0.75] },
  { kind: "line", start: [0, 0.75], end: [0, -0.75] },
] as const;

const SPINE = helixSpineOf(HELIX_DEFAULTS);

/** Serializes a sketch of entities on the XY workplane. */
function sketchPayloadOf(
  entities: readonly Parameters<typeof createSketch>[1][number][],
): Record<string, unknown> {
  const created = createSketch(xyWorkplane(), entities, []);
  if (!created.ok) throw new Error(created.error.message);
  return serializeSketch(created.value) as unknown as Record<string, unknown>;
}

/** The meridian rectangle as a resolvable sketch (u ∈ [0,2], v ±0.75). */
function meridianSketchPayload(): Record<string, unknown> {
  return sketchPayloadOf([
    createLineEntity(
      createSketchEntityId("skent_m0"),
      { x: 0, y: -0.75 },
      { x: 2, y: -0.75 },
    ),
    createLineEntity(
      createSketchEntityId("skent_m1"),
      { x: 2, y: -0.75 },
      { x: 2, y: 0.75 },
    ),
    createLineEntity(
      createSketchEntityId("skent_m2"),
      { x: 2, y: 0.75 },
      { x: 0, y: 0.75 },
    ),
    createLineEntity(
      createSketchEntityId("skent_m3"),
      { x: 0, y: 0.75 },
      { x: 0, y: -0.75 },
    ),
  ]);
}

/** The rod's resolvable circle (radius 3 at the origin). */
function rodSketchPayload(): Record<string, unknown> {
  return sketchPayloadOf([
    createCircleEntity(createSketchEntityId("skent_c0"), { x: 0, y: 0 }, 3),
  ]);
}

describe("validateHelixSubmission: the action-time battery", () => {
  it("accepts the sound default coil", () => {
    expect(
      validateHelixSubmission({ loop: MERIDIAN_LOOP, spine: SPINE }),
    ).toEqual({ ok: true });
  });

  it("refuses the degenerate spines with the kernel's own codes", () => {
    const circle = validateHelixSubmission({
      loop: MERIDIAN_LOOP,
      spine: { ...SPINE, pitchMm: 0, taperMm: 0 },
    });
    expect(circle).toMatchObject({ ok: false, code: "kernel/invalid-helix" });
    const crossing = validateHelixSubmission({
      loop: [
        { kind: "line", start: [-12, -0.75], end: [-10, -0.75] },
        { kind: "line", start: [-10, -0.75], end: [-10, 0.75] },
        { kind: "line", start: [-10, 0.75], end: [-12, 0.75] },
        { kind: "line", start: [-12, 0.75], end: [-12, -0.75] },
      ],
      spine: SPINE,
    });
    expect(crossing).toMatchObject({
      ok: false,
      code: "kernel/profile-axis-crossing",
    });
  });

  it("refuses the overlapping-turn submission (the fake kernel's subset)", () => {
    const overlap = validateHelixSubmission({
      loop: [
        { kind: "line", start: [0, -2.5], end: [2, -2.5] },
        { kind: "line", start: [2, -2.5], end: [2, 2.5] },
        { kind: "line", start: [2, 2.5], end: [0, 2.5] },
        { kind: "line", start: [0, 2.5], end: [0, -2.5] },
      ],
      spine: SPINE,
    });
    expect(overlap).toMatchObject({
      ok: false,
      code: "kernel/helix-turn-overlap",
    });
  });
});

describe("helixPlacementForAxis: the datum-axis frame", () => {
  it("maps the world +z datum to the identity placement", () => {
    const placement = helixPlacementForAxis([0, 0, 0], [0, 0, 1]);
    expect(placement.rotation.angle.value).toBeCloseTo(0, 12);
    expect(placement.translation.z.value).toBe(0);
  });

  it("carries a +x axis by a quarter turn about +y", () => {
    const placement = helixPlacementForAxis([1, 2, 3], [1, 0, 0]);
    expect(placement.rotation.axis).toEqual([0, 1, 0]);
    expect(placement.rotation.angle.value).toBeCloseTo(Math.PI / 2, 12);
    expect(placement.translation.x.value).toBe(1);
    expect(placement.translation.y.value).toBe(2);
    expect(placement.translation.z.value).toBe(3);
  });
});

function requireOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function buildHelixDocument(datumAxis: boolean): CadDocument {
  let document = createDocument(createDocumentId("doc_workbench_helix"));
  document = requireOk(
    addDocumentSketch(document, {
      id: createSketchDocumentId("skd_meridian"),
      name: "meridian profile",
      sketch: meridianSketchPayload(),
    }),
  ).document;
  document = requireOk(
    addBody(document, { id: createBodyId("body_spring"), name: "spring" }),
  ).document;
  for (const [name, value] of [
    ["helixRadius", length(10)],
    ["helixPitch", length(4)],
    ["helixTurns", dimensionless(3)],
    ["helixHandedness", dimensionless(-1)],
    ["helixStartAngle", angle(0.5)],
    ["helixTaper", length(0)],
  ] as const) {
    document = requireOk(
      addDocumentParameter(document, {
        id: createParameterId(`param_${name}`),
        name,
        value,
      }),
    ).document;
  }
  let datumId: string | null = null;
  if (datumAxis) {
    datumId = "dtm_axis";
    document = requireOk(
      addDocumentDatum(document, {
        id: createDatumId(datumId),
        name: "helix axis",
        datum: {
          formatVersion: 1,
          datumType: "axis",
          definition: "twoPoints",
          first: [0, 0, 5],
          second: [0, 0, 6],
        },
      }),
    ).document;
  }
  document = requireOk(
    addFeature(document, {
      id: createFeatureId("feat_helix"),
      kind: "helix",
      inputs: [
        { kind: "sketch", id: createSketchDocumentId("skd_meridian") },
        ...[
          "helixRadius",
          "helixPitch",
          "helixTurns",
          "helixHandedness",
          "helixStartAngle",
          "helixTaper",
        ].map((name) => ({
          kind: "parameter" as const,
          id: createParameterId(`param_${name}`),
        })),
        ...(datumId === null
          ? []
          : [{ kind: "datum" as const, id: createDatumId(datumId) }]),
      ],
      outputs: [createBodyId("body_spring")],
    }),
  ).document;
  return document;
}

describe("documentHelixRequest: the scene reader", () => {
  it("reads the spine parameters and the default world-z placement", () => {
    const request = documentHelixRequest(buildHelixDocument(false));
    expect(request).not.toBeNull();
    if (request === null) return;
    expect(request.bodyId).toBe("body_spring");
    expect(request.spine.radius.value).toBe(10);
    expect(request.spine.pitch.value).toBe(4);
    expect(request.spine.turns).toBe(3);
    expect(request.spine.handedness).toBe(-1);
    expect(request.spine.startAngle.value).toBeCloseTo(0.5, 12);
    expect(request.placement.rotation.angle.value).toBe(0);
  });

  it("reads the datum-axis form's frame through the session resolver", () => {
    const request = documentHelixRequest(buildHelixDocument(true));
    expect(request).not.toBeNull();
    if (request === null) return;
    // The twoPoints datum runs along +z through (0,0,5): identity rotation,
    // the translation lifted to the datum origin.
    expect(request.placement.rotation.angle.value).toBeCloseTo(0, 12);
    expect(request.placement.translation.z.value).toBe(5);
  });

  it("returns null without a helix feature", () => {
    expect(
      documentHelixRequest(createDocument(createDocumentId("doc_empty"))),
    ).toBeNull();
  });
});

describe("validateThreadSubmission: the action-time battery", () => {
  it("accepts the default M6 external thread", () => {
    expect(validateThreadSubmission(THREAD_DEFAULTS)).toEqual({ ok: true });
  });

  it("refuses the roadmap's named declines", () => {
    expect(
      validateThreadSubmission({ ...THREAD_DEFAULTS, pitchMm: 0 }),
    ).toMatchObject({ ok: false, code: "kernel/parameter-invalid" });
    expect(
      validateThreadSubmission({ ...THREAD_DEFAULTS, majorDiameterMm: 0 }),
    ).toMatchObject({ ok: false, code: "kernel/parameter-invalid" });
    expect(
      validateThreadSubmission({ ...THREAD_DEFAULTS, lengthMm: -1 }),
    ).toMatchObject({ ok: false, code: "kernel/parameter-invalid" });
    expect(
      validateThreadSubmission({ ...THREAD_DEFAULTS, mode: 9 }),
    ).toMatchObject({ ok: false, code: "kernel/feature-input-invalid" });
    expect(
      validateThreadSubmission({ ...THREAD_DEFAULTS, handedness: 0 }),
    ).toMatchObject({ ok: false, code: "kernel/feature-input-invalid" });
    expect(
      validateThreadSubmission({ ...THREAD_DEFAULTS, axis: 4 }),
    ).toMatchObject({ ok: false, code: "kernel/feature-input-invalid" });
  });

  it("accepts every mode the thread vocabulary carries", () => {
    for (const mode of [
      THREAD_MODE_VALUES.external,
      THREAD_MODE_VALUES.internal,
      THREAD_MODE_VALUES.cosmetic,
    ]) {
      expect(validateThreadSubmission({ ...THREAD_DEFAULTS, mode })).toEqual({
        ok: true,
      });
    }
  });
});

/** The datum-axis forms a thread feature can declare. */
type ThreadAxisDatum =
  | {
      readonly kind: "twoPoints";
      readonly first: readonly [number, number, number];
      readonly second: readonly [number, number, number];
    }
  | { readonly kind: "edge" };

function buildThreadDocument(axis?: ThreadAxisDatum): CadDocument {
  let document = createDocument(createDocumentId("doc_workbench_thread"));
  document = requireOk(
    addBody(document, { id: createBodyId("body_rod"), name: "rod" }),
  ).document;
  document = requireOk(
    addBody(document, {
      id: createBodyId("body_threaded"),
      name: "threaded",
    }),
  ).document;
  document = requireOk(
    addDocumentSketch(document, {
      id: createSketchDocumentId("skd_rod"),
      name: "rod circle",
      sketch: rodSketchPayload(),
    }),
  ).document;
  for (const [name, value] of [
    ["rodDepth", length(6)],
    ["threadMajor", length(6)],
    ["threadPitch", length(1)],
    ["threadLength", length(6)],
    ["threadMode", dimensionless(1)],
    ["threadHandedness", dimensionless(1)],
    ["threadAxis", dimensionless(3)],
  ] as const) {
    document = requireOk(
      addDocumentParameter(document, {
        id: createParameterId(`param_${name}`),
        name,
        value,
      }),
    ).document;
  }
  if (axis !== undefined) {
    document = requireOk(
      addDocumentDatum(document, {
        id: createDatumId("dtm_thread_axis"),
        name: "thread axis",
        datum:
          axis.kind === "twoPoints"
            ? {
                formatVersion: 1,
                datumType: "axis",
                definition: "twoPoints",
                first: [...axis.first],
                second: [...axis.second],
              }
            : {
                formatVersion: 1,
                datumType: "axis",
                definition: "edge",
                reference: { ordinal: 0 },
              },
      }),
    ).document;
  }
  document = requireOk(
    addFeature(document, {
      id: createFeatureId("feat_rod"),
      kind: "extrude",
      inputs: [
        { kind: "sketch", id: createSketchDocumentId("skd_rod") },
        { kind: "parameter", id: createParameterId("param_rodDepth") },
      ],
      outputs: [createBodyId("body_rod")],
    }),
  ).document;
  document = requireOk(
    addFeature(document, {
      id: createFeatureId("feat_thread"),
      kind: "thread",
      inputs: [
        { kind: "feature", id: createFeatureId("feat_rod") },
        { kind: "parameter", id: createParameterId("param_threadMajor") },
        { kind: "parameter", id: createParameterId("param_threadPitch") },
        { kind: "parameter", id: createParameterId("param_threadLength") },
        { kind: "parameter", id: createParameterId("param_threadMode") },
        { kind: "parameter", id: createParameterId("param_threadHandedness") },
        ...(axis === undefined
          ? [
              {
                kind: "parameter" as const,
                id: createParameterId("param_threadAxis"),
              },
            ]
          : [
              {
                kind: "datum" as const,
                id: createDatumId("dtm_thread_axis"),
              },
            ]),
      ],
      outputs: [createBodyId("body_threaded")],
    }),
  ).document;
  return document;
}

describe("documentThreadSceneRequest: the scene reader", () => {
  it("pairs the thread's parameters with the base extrusion", () => {
    const request = documentThreadSceneRequest(buildThreadDocument());
    expect(request).not.toBeNull();
    if (request === null) return;
    expect(request.bodyId).toBe("body_threaded");
    expect(request.thread.majorDiameterMm).toBe(6);
    expect(request.thread.pitchMm).toBe(1);
    expect(request.thread.lengthMm).toBe(6);
    expect(request.thread.mode).toBe(1);
    expect(request.thread.axis).toBe(3);
    expect(request.datumAxis).toBeUndefined();
    expect(request.base).toBeDefined();
  });

  it("frames the datum-axis thread's cut on the resolved line (the helix reader's discipline)", () => {
    // The twoPoints datum runs along +x through (0, 2, 3): the request
    // carries the RESOLVED line the scene cuts on — direction [1,0,0],
    // origin [0,2,3] — never the world-Z default the axis selector would
    // silently supply (the executor bridge honors the same datum; the
    // scene and the bridge compose the identical cut).
    const request = documentThreadSceneRequest(
      buildThreadDocument({
        kind: "twoPoints",
        first: [0, 2, 3],
        second: [1, 2, 3],
      }),
    );
    expect(request).not.toBeNull();
    if (request === null) return;
    expect(request.datumAxis).toBeDefined();
    expect(request.datumAxis?.direction).toEqual([1, 0, 0]);
    expect(request.datumAxis?.origin).toEqual([0, 2, 3]);
    expect(request.thread.majorDiameterMm).toBe(6);
  });

  it("declines a thread whose datum axis does not resolve in-session", () => {
    // An edge-definition axis resolves kernel-side only: the session
    // resolver answers the structured refusal and the reader declines
    // (null — the caller renders the prior scene), never a silent
    // world-Z cut on the wrong axis.
    const document = buildThreadDocument({ kind: "edge" });
    const resolved = resolveSessionDatumAxis(document, "dtm_thread_axis");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.error.code).toBe("session/face-not-resolvable");
    }
    expect(documentThreadSceneRequest(document)).toBeNull();
  });

  it("returns null without a thread feature or a resolvable base", () => {
    expect(
      documentThreadSceneRequest(createDocument(createDocumentId("doc_empty"))),
    ).toBeNull();
  });
});
