/**
 * The `/workbench` fixture's CAD document (Phase 14): the session the
 * CadProvider store is composed over. It models the same plate as the
 * Phase 13 fixture document — one body, translate/rotate plumbing — plus
 * the parameter the workbench edits through the React hooks:
 * `param_hole_diameter`, the through-bore diameter the worker computation
 * consumes. Deterministic (explicit ids), so the workbench boots identically
 * every run.
 *
 * The page's executor stand-in: after every committed `parameter.set` on
 * the hole parameter (hook edit, undo, redo alike) the page re-dispatches
 * the worker computation with the document's stored value — the document is
 * the source of truth, the worker follows it.
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
  createSession,
  valueIn,
  type BodyId,
  type CadDocument,
  type CadSession,
  type FeatureId,
  type ParameterId,
} from "@slopcad/cad-core";

/** The workbench's stable plate body id (same body the projection carries). */
const WORKBENCH_BODY_ID: BodyId = createBodyId("body_plate");

/** The hole diameter parameter the hooks edit. */
const WORKBENCH_HOLE_PARAMETER: ParameterId = createParameterId(
  "param_hole_diameter",
);

/** The translate component parameter ids, in x, y, z order. */
const WORKBENCH_TRANSLATE_PARAMETERS: readonly [
  ParameterId,
  ParameterId,
  ParameterId,
] = [
  createParameterId("param_translate_x"),
  createParameterId("param_translate_y"),
  createParameterId("param_translate_z"),
];

/** The rotate-about-+Z angle parameter id. */
const WORKBENCH_ROTATE_PARAMETER: ParameterId =
  createParameterId("param_rotate_z");

/** The workbench's translate feature id (tool resolution target). */
const WORKBENCH_TRANSLATE_FEATURE: FeatureId = createFeatureId(
  "feat_translate_plate",
);

/** The workbench's rotate feature id (tool resolution target). */
const WORKBENCH_ROTATE_FEATURE: FeatureId =
  createFeatureId("feat_rotate_plate");

interface DocumentResult {
  readonly ok: boolean;
  readonly value?: { readonly document: CadDocument };
  readonly error?: { readonly message: string };
}

/**
 * Unwraps a document-building result or throws with the failing step named
 * — the deterministic boot documents must never construct partially.
 */
export function requireDocumentOk(
  result: DocumentResult,
  what: string,
): CadDocument {
  if (!result.ok || result.value === undefined) {
    throw new Error(
      `Workbench document rejected ${what}: ${String(result.error?.message)}`,
    );
  }
  return result.value.document;
}

/**
 * Builds the workbench session: the plate body, the hole diameter (at the
 * scene's default), and the translate/rotate feature plumbing, all at
 * identity values.
 */
export function createWorkbenchSession(holeDiameterMm: number): CadSession {
  let document = createDocument(createDocumentId("doc_workbench_fixture"));
  document = requireDocumentOk(
    addBody(document, { id: WORKBENCH_BODY_ID, name: "plate" }),
    "the plate body",
  );
  document = requireDocumentOk(
    addDocumentParameter(document, {
      id: WORKBENCH_HOLE_PARAMETER,
      name: "holeDiameter",
      value: length(holeDiameterMm),
    }),
    "the hole diameter parameter",
  );
  for (const [id, name] of [
    [WORKBENCH_TRANSLATE_PARAMETERS[0], "translate_x"],
    [WORKBENCH_TRANSLATE_PARAMETERS[1], "translate_y"],
    [WORKBENCH_TRANSLATE_PARAMETERS[2], "translate_z"],
  ] as const) {
    document = requireDocumentOk(
      addDocumentParameter(document, { id, name, value: length(0) }),
      `parameter ${name}`,
    );
  }
  document = requireDocumentOk(
    addDocumentParameter(document, {
      id: WORKBENCH_ROTATE_PARAMETER,
      name: "rotate_z",
      value: angle(0),
    }),
    "parameter rotate_z",
  );
  document = requireDocumentOk(
    addFeature(document, {
      id: WORKBENCH_TRANSLATE_FEATURE,
      kind: "translate",
      inputs: [
        { kind: "body", id: WORKBENCH_BODY_ID },
        { kind: "parameter", id: WORKBENCH_TRANSLATE_PARAMETERS[0] },
        { kind: "parameter", id: WORKBENCH_TRANSLATE_PARAMETERS[1] },
        { kind: "parameter", id: WORKBENCH_TRANSLATE_PARAMETERS[2] },
      ],
      outputs: [WORKBENCH_BODY_ID],
    }),
    "the translate feature",
  );
  document = requireDocumentOk(
    addFeature(document, {
      id: WORKBENCH_ROTATE_FEATURE,
      kind: "rotate",
      inputs: [
        { kind: "body", id: WORKBENCH_BODY_ID },
        { kind: "parameter", id: WORKBENCH_ROTATE_PARAMETER },
      ],
      outputs: [WORKBENCH_BODY_ID],
    }),
    "the rotate feature",
  );
  return createSession(document);
}

/**
 * Reads the document's stored hole diameter in canonical millimetres, or
 * `null` when the parameter is absent (never in this fixture's document).
 */
export function holeDiameterMm(document: CadDocument): number | null {
  const parameter = getDocumentParameter(document, WORKBENCH_HOLE_PARAMETER);
  if (parameter === undefined) return null;
  return parameter.value.dimension === "length"
    ? valueIn(parameter.value, "mm")
    : null;
}
