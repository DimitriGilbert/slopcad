import {
  addBody,
  addDocumentParameter,
  addFeature,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSession,
  getDocumentParameter,
  length,
  parseExpression,
  valueIn,
  type CadDocument,
  type CadSession,
  type ParameterId,
} from "@slopcad/cad-react";

/** The plate body's stable id (the projected render object's source). */
export const PLATE_BODY_ID = createBodyId("body_plate");

/** The bore diameter parameter the panel edits and the kernel consumes. */
export const HOLE_DIAMETER_PARAMETER = createParameterId("param_hole_diameter");

/** The translate feature's id in the example document. */
export const TRANSLATE_FEATURE_ID = createFeatureId("feat_translate_plate");

/** The translate component parameter ids, in x, y, z order. */
export const TRANSLATE_PARAMETER_IDS: readonly [
  ParameterId,
  ParameterId,
  ParameterId,
] = [
  createParameterId("param_translate_x"),
  createParameterId("param_translate_y"),
  createParameterId("param_translate_z"),
];

/** The expression-driven parameter the panel renders as an expression row. */
const VOLUME_HINT_PARAMETER = createParameterId("param_volume_hint");

/** The boot value of the bore diameter (mm). */
export const HOLE_DIAMETER_DEFAULT_MM = 8;

/**
 * Unwraps a document-building result or throws with the failing step
 * named — the deterministic boot document must never construct partially.
 */
function unwrap<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(
      `The example document rejected ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

/**
 * Builds the example's session: plate body, the hole diameter (at the
 * default), the translate components, the translate feature, and the
 * expression-driven volume hint (cached at the matching 16 mm value).
 */
export function createPlateSession(): CadSession {
  let document = createDocument(createDocumentId("doc_plate_workbench"));
  document = unwrap(
    addBody(document, { id: PLATE_BODY_ID, name: "plate" }),
    "the plate body",
  ).document;
  document = unwrap(
    addDocumentParameter(document, {
      id: HOLE_DIAMETER_PARAMETER,
      name: "holeDiameter",
      value: length(HOLE_DIAMETER_DEFAULT_MM),
    }),
    "the holeDiameter parameter",
  ).document;
  for (const [id, name] of [
    [TRANSLATE_PARAMETER_IDS[0], "translate_x"],
    [TRANSLATE_PARAMETER_IDS[1], "translate_y"],
    [TRANSLATE_PARAMETER_IDS[2], "translate_z"],
  ] as const) {
    document = unwrap(
      addDocumentParameter(document, { id, name, value: length(0) }),
      `the ${name} parameter`,
    ).document;
  }
  document = unwrap(
    addFeature(document, {
      id: TRANSLATE_FEATURE_ID,
      kind: "translate",
      inputs: [
        { kind: "body", id: PLATE_BODY_ID },
        { kind: "parameter", id: TRANSLATE_PARAMETER_IDS[0] },
        { kind: "parameter", id: TRANSLATE_PARAMETER_IDS[1] },
        { kind: "parameter", id: TRANSLATE_PARAMETER_IDS[2] },
      ],
      outputs: [PLATE_BODY_ID],
    }),
    "the translate feature",
  ).document;
  const expression = parseExpression("holeDiameter * 2");
  if (!expression.ok) {
    throw new Error(
      `The example document rejected the volume hint expression: ${expression.error.message}`,
    );
  }
  document = unwrap(
    addDocumentParameter(document, {
      id: VOLUME_HINT_PARAMETER,
      name: "volumeHint",
      value: length(HOLE_DIAMETER_DEFAULT_MM * 2),
      expression: expression.value,
    }),
    "the volumeHint parameter",
  ).document;
  return createSession(document);
}

/**
 * Reads the document's stored bore diameter in canonical millimetres, or
 * `null` when the parameter is absent or not a length.
 */
export function holeDiameterMmOf(document: CadDocument): number | null {
  const parameter = getDocumentParameter(document, HOLE_DIAMETER_PARAMETER);
  if (parameter === undefined || parameter.value.dimension !== "length") {
    return null;
  }
  return valueIn(parameter.value, "mm");
}

/**
 * Reads the document's translate components in canonical millimetres, or
 * `null` for any component that is absent or not a length.
 */
export function translateComponentsMmOf(
  document: CadDocument,
): readonly [number, number, number] | null {
  const components: number[] = [];
  for (const id of TRANSLATE_PARAMETER_IDS) {
    const parameter = getDocumentParameter(document, id);
    if (parameter === undefined || parameter.value.dimension !== "length") {
      return null;
    }
    components.push(valueIn(parameter.value, "mm"));
  }
  const [x, y, z] = components;
  if (x === undefined || y === undefined || z === undefined) {
    return null;
  }
  return [x, y, z];
}
