/**
 * The render fixture's CAD document (Phase 13): the session-backed document
 * the tool system acts on. The Phase 13 tools express their changes as
 * commands against THIS document — the fixture renders the worker-computed
 * plate, but every translate/rotate gesture a tool commits is a real,
 * replayable transaction in this session's history.
 *
 * ## Modeling convention (shared with the tools' resolution rules)
 *
 * - One body, the plate (`body_plate`), matching the projected body id.
 * - A `"translate"` feature declaring the body plus THREE length parameters
 *   (`param_translate_x/y/z`) — the translation's x, y, z components in
 *   canonical millimetres (see `resolveTranslateTarget` in cad-core).
 * - A `"rotate"` feature declaring the body plus ONE angle parameter
 *   (`param_rotate_z`) — the signed rotation about +Z in canonical radians
 *   (see `resolveRotateTarget`).
 *
 * ## The fixture's executor seam
 *
 * Nothing executes document features into solids yet (regeneration is an
 * executor-callback seam; the worker computes the plate directly). The
 * fixture stands in for the translate executor honestly: after each tool
 * dispatch it reads the translate parameters back from the session and
 * re-derives the rendered projection with that world offset
 * (`appliedTranslationOffset` → `offsetPlateRenderState`). Rotation is NOT
 * applied — every kernel declares `transformRotation: false` and no
 * document executor exists, so the rotate command changes the document and
 * nothing else.
 */

import {
  addBody,
  addDocumentParameter,
  addFeature,
  angle,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  getDocumentParameter,
  length,
  resolveTranslateTarget,
  valueIn,
  type BodyId,
  type CadDocument,
  type ParameterId,
  type RenderVector3,
} from "@slopcad/cad-core";
import { createSession, type CadSession } from "@slopcad/cad-core";

/** The fixture's stable plate body id (same body the projection carries). */
export const FIXTURE_BODY_ID: BodyId = createBodyId("body_plate");

/** The translate component parameter ids, in x, y, z order. */
export const FIXTURE_TRANSLATE_PARAMETERS: readonly [
  ParameterId,
  ParameterId,
  ParameterId,
] = [
  createParameterId("param_translate_x"),
  createParameterId("param_translate_y"),
  createParameterId("param_translate_z"),
];

/** The rotate-about-+Z angle parameter id. */
export const FIXTURE_ROTATE_PARAMETER: ParameterId = createParameterId(
  "param_rotate_z",
);

function requireOk<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: { message: string } }, what: string): T {
  if (!result.ok) {
    throw new Error(`Fixture document rejected ${what}: ${result.error.message}`);
  }
  return result.value;
}

/**
 * Builds the fixture's session: the plate body, the translate/rotate
 * parameter plumbing, and the two transform features, all at identity
 * values. Deterministic (explicit ids), so the fixture boots identically
 * every run.
 */
export function createFixtureSession(): CadSession {
  let document: CadDocument = createDocument(
    createDocumentId("doc_render_fixture"),
  );
  document = requireOk(
    addBody(document, { id: FIXTURE_BODY_ID, name: "plate" }),
    "the plate body",
  ).document;
  for (const [id, name] of [
    [FIXTURE_TRANSLATE_PARAMETERS[0], "translate_x"],
    [FIXTURE_TRANSLATE_PARAMETERS[1], "translate_y"],
    [FIXTURE_TRANSLATE_PARAMETERS[2], "translate_z"],
  ] as const) {
    document = requireOk(
      addDocumentParameter(document, { id, name, value: length(0) }),
      `parameter ${name}`,
    ).document;
  }
  document = requireOk(
    addDocumentParameter(document, {
      id: FIXTURE_ROTATE_PARAMETER,
      name: "rotate_z",
      value: angle(0),
    }),
    "parameter rotate_z",
  ).document;
  document = requireOk(
    addFeature(document, {
      id: createFeatureId("feat_translate_plate"),
      kind: "translate",
      inputs: [
        { kind: "body", id: FIXTURE_BODY_ID },
        { kind: "parameter", id: FIXTURE_TRANSLATE_PARAMETERS[0] },
        { kind: "parameter", id: FIXTURE_TRANSLATE_PARAMETERS[1] },
        { kind: "parameter", id: FIXTURE_TRANSLATE_PARAMETERS[2] },
      ],
      outputs: [FIXTURE_BODY_ID],
    }),
    "the translate feature",
  ).document;
  document = requireOk(
    addFeature(document, {
      id: createFeatureId("feat_rotate_plate"),
      kind: "rotate",
      inputs: [
        { kind: "body", id: FIXTURE_BODY_ID },
        { kind: "parameter", id: FIXTURE_ROTATE_PARAMETER },
      ],
      outputs: [FIXTURE_BODY_ID],
    }),
    "the rotate feature",
  ).document;
  return createSession(document);
}

/**
 * Reads the document's applied translation offset for the plate: the
 * translate feature's three length parameters, in canonical millimetres.
 * `[0, 0, 0]` when the translate plumbing is absent (never in this
 * fixture's own document).
 */
export function appliedTranslationOffset(document: CadDocument): RenderVector3 {
  const target = resolveTranslateTarget(document, FIXTURE_BODY_ID);
  if (target === undefined) return [0, 0, 0];
  const components = target.parameters.map((id) => {
    const parameter = getDocumentParameter(document, id);
    return parameter !== undefined && parameter.value.dimension === "length"
      ? valueIn(parameter.value, "mm")
      : 0;
  });
  return [components[0] ?? 0, components[1] ?? 0, components[2] ?? 0];
}
