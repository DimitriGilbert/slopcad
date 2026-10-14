/**
 * The authoring-counter reseed scan (the review fix for the whole-document
 * adoption door): the stem table must read the engine's own id conventions
 * out of an adopted document — including the embedded-role forms the
 * pattern/loft/duplicate verbs mint — and must NOT read near-miss ids
 * (another verb's stem, a foreign prefix) as one of the counter's. The
 * maximum drives the engine's counters, so an under-read re-mints a
 * colliding id and an over-read burns ids silently.
 */

import { describe, expect, it } from "vitest";
import {
  addDocumentParameter,
  createBodyId,
  createCurveId,
  createDatumId,
  createFeatureId,
  createParameterId,
  createSketchDocumentId,
  length,
  type CadDocument,
} from "@slopcad/cad-core";

import { maxAuthoringOccurrencesOf } from "./authoring-counters";
import { createCadWorkbenchSession } from "./session";

/** Adds parameters with the given ids to a copy of the boot document. */
function withParameters(
  ids: readonly string[],
  document: CadDocument = createCadWorkbenchSession().document,
): CadDocument {
  let next = document;
  for (const [index, raw] of ids.entries()) {
    const added = addDocumentParameter(next, {
      id: createParameterId(raw),
      name: `scanFixture${String(index)}`,
      value: length(1),
    });
    if (!added.ok) throw new Error(added.error.message);
    next = added.value.document;
  }
  return next;
}

describe("the authoring-counter reseed scan", () => {
  it("reads the boot fixture's engine-convention hole stem (the stem without an occurrence)", () => {
    const maxima = maxAuthoringOccurrencesOf(
      createCadWorkbenchSession().document,
    );
    // The fixture document's hole parameter id IS the stem without a
    // suffix (param_hole_diameter) — the first occurrence the hole verb
    // must stay past.
    expect(maxima.hole).toBe(1);
    // The translate/rotate fixtures use foreign stems: no counter reads them.
    expect(maxima.extrude).toBe(0);
    expect(maxima.revolve).toBe(0);
    expect(maxima.datum).toBe(0);
  });

  it("reads the exporter's explicit first-occurrence ids as occurrence 1", () => {
    const document = withParameters(["param_extrude_depth"]);
    const scanned: CadDocument = {
      ...document,
      sketches: [
        {
          id: createSketchDocumentId("skd_extrude"),
          name: "extrude sketch",
          sketch: {},
        },
      ],
      features: [
        {
          id: createFeatureId("feat_extrude"),
          kind: "extrude",
          inputs: [],
          outputs: [createBodyId("body_extrude")],
        },
      ],
    };
    const maxima = maxAuthoringOccurrencesOf(scanned);
    // The empty-suffix form IS the first occurrence: the next mint must be
    // the second (feat_extrude2), not a re-mint of feat_extrude.
    expect(maxima.extrude).toBe(1);
  });

  it("reads the highest occurrence across collections and embedded-role forms", () => {
    const document = withParameters([
      "param_pattern1_direction2",
      "param_loft_z2_1",
      "param_shole_diameter4",
    ]);
    const scanned: CadDocument = {
      ...document,
      features: [
        {
          id: createFeatureId("feat_extrude3"),
          kind: "extrude",
          inputs: [],
          outputs: [createBodyId("body_extrude3")],
        },
        {
          id: createFeatureId("feat_pattern1"),
          kind: "patternFeature",
          inputs: [],
          outputs: [createBodyId("body_pattern1")],
        },
        {
          id: createFeatureId("feat_duplicate2"),
          kind: "duplicate",
          inputs: [],
          outputs: [createBodyId("body_dup2_c1"), createBodyId("body_dup2_c2")],
        },
      ],
      datums: [
        {
          id: createDatumId("dtm_face_plane7"),
          name: "face plane 7",
          datum: {},
        },
      ],
      curves: [
        {
          id: createCurveId("crv_curve2"),
          name: "curve 2",
          curve: {
            kind: "interpolated-spline",
            points: [
              [0, 0, 0],
              [1, 1, 1],
            ],
          },
        },
      ],
    };
    const maxima = maxAuthoringOccurrencesOf(scanned);
    expect(maxima.extrude).toBe(3);
    expect(maxima.pattern).toBe(1);
    expect(maxima.duplicate).toBe(2);
    expect(maxima.loft).toBe(2);
    expect(maxima.structuredHole).toBe(4);
    expect(maxima.datum).toBe(7);
    expect(maxima.curve).toBe(2);
  });

  it("reads the structured hole verb's camelCase role ids at their max occurrence", () => {
    const document = withParameters([
      "param_shole_tipAngle1",
      "param_shole_cboreDiameter2",
      "param_shole_positionX3",
    ]);
    const maxima = maxAuthoringOccurrencesOf(document);
    // The engine mints `param_shole_<role><n>` with the role name camelCased
    // (tipAngle, cboreDiameter, positionX) — the old all-lowercase stem read
    // none of them; now each is the structuredHole counter's occurrence and
    // the highest wins.
    expect(maxima.structuredHole).toBe(3);
  });

  it("reads the extrude verb's taper param alongside its feat/body co-stems and still rejects the compiler default", () => {
    const document = withParameters([
      "param_extrude_taper2",
      "param_extrude_depth-1",
    ]);
    const scanned: CadDocument = {
      ...document,
      features: [
        {
          id: createFeatureId("feat_extrude2"),
          kind: "extrude",
          inputs: [],
          outputs: [createBodyId("body_extrude2")],
        },
      ],
    };
    const maxima = maxAuthoringOccurrencesOf(scanned);
    // The taper slot mints `param_extrude_taper<n>` on the same extrude
    // counter as the depth/feat/body stems — occurrence 2 here — while the
    // compiler's default `<kind>-<occurrence>` form still feeds nothing
    // (its strict 0-rejection is pinned in the near-miss test below).
    expect(maxima.extrude).toBe(2);
  });

  it("does not read near-miss ids as another verb's stem", () => {
    const document = withParameters([
      "param_patternpath_count5",
      "param_extrude_depth-1",
    ]);
    const maxima = maxAuthoringOccurrencesOf(document);
    // patternPath's stem feeds patternPath — and a foreign prefix with the
    // shared tail (the compiler's default `<kind>-<occurrence>` scheme)
    // feeds nothing.
    expect(maxima.patternPath).toBe(5);
    expect(maxima.pattern).toBe(0);
    expect(maxima.extrude).toBe(0);
  });
});
