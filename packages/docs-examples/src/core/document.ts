/**
 * The `cad-core`, `parameters`, and `expressions` guides' runnable example
 * (docs/guides/cad-core.md, docs/guides/parameters.md,
 * docs/guides/expressions.md): a real parametric document built from the
 * public surface alone — a plate body, a `holeDiameter` length parameter,
 * an expression-driven `volumeHint` parameter, and a translate feature
 * that declares the body and its parameter inputs. This is the same
 * composition the workbench session builds
 * (apps/web/src/cad-workbench/session.ts), trimmed to the API the guides
 * teach.
 */

import {
  addBody,
  addDocumentParameter,
  addFeature,
  angle,
  applySessionCommand,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSession,
  evaluateExpression,
  featureTimeline,
  length,
  parameterEnvironment,
  parseExpression,
  type BodyId,
  type CadDocument,
  type FeatureId,
  type ParameterId,
} from "@slopcad/cad-core";

/** The example's stable ids (explicit ids make the build deterministic). */
export const PLATE_BODY: BodyId = createBodyId("body_plate");
export const HOLE_PARAMETER: ParameterId = createParameterId("param_hole");
export const BORE_PARAMETER: ParameterId = createParameterId("param_bore");
export const SPIN_PARAMETER: ParameterId = createParameterId("param_spin");
export const TRANSLATE_FEATURE: FeatureId = createFeatureId(
  "feat_translate_plate",
);

/** What the example reports back to the guide and the docs page. */
export interface DocumentExampleSummary {
  readonly parameterCount: number;
  readonly holeDiameterMm: number;
  readonly volumeHintMm: number;
  readonly featureCount: number;
  readonly timelineKinds: readonly string[];
  readonly editedHoleDiameterMm: number;
  readonly editedVolumeHintMm: number;
}

/**
 * Builds the example document and reports the facts the guide states:
 * a 10 mm hole, `volumeHint = holeDiameter * 2` evaluated by the
 * expression engine, one translate feature, and what a `parameter.set`
 * command does to the expression-driven parameter.
 */
export function runDocumentExample(): DocumentExampleSummary {
  const expression = parseExpression("holeDiameter * 2");
  if (!expression.ok) {
    throw new Error(
      `The guide's expression was rejected: ${expression.error.message}`,
    );
  }

  let document = createDocument(createDocumentId("doc_guide_plate"));
  document = unwrap(
    addBody(document, { id: PLATE_BODY, name: "plate" }),
    "plate body",
  ).document;
  document = unwrap(
    addDocumentParameter(document, {
      id: HOLE_PARAMETER,
      name: "holeDiameter",
      value: length(10),
      metadata: { label: "Through-bore diameter" },
    }),
    "holeDiameter parameter",
  ).document;
  document = unwrap(
    addDocumentParameter(document, {
      id: BORE_PARAMETER,
      name: "boreDepth",
      value: length(4),
    }),
    "boreDepth parameter",
  ).document;
  document = unwrap(
    addDocumentParameter(document, {
      id: SPIN_PARAMETER,
      name: "spin",
      value: angle(0),
    }),
    "spin parameter",
  ).document;
  document = unwrap(
    addDocumentParameter(document, {
      id: createParameterId("param_volume_hint"),
      name: "volumeHint",
      value: length(20),
      expression: expression.value,
    }),
    "volumeHint parameter",
  ).document;
  document = unwrap(
    addFeature(document, {
      id: TRANSLATE_FEATURE,
      kind: "translate",
      inputs: [
        { kind: "body", id: PLATE_BODY },
        { kind: "parameter", id: BORE_PARAMETER },
      ],
      outputs: [PLATE_BODY],
    }),
    "translate feature",
  ).document;

  // The expression engine, evaluated over the document's own parameters.
  const hint = evaluateExpression(
    expression.value,
    parameterEnvironment(document.parameters),
  );
  if (!hint.ok) {
    throw new Error(
      `Evaluating the guide's expression failed: ${hint.error.message}`,
    );
  }

  // A parameter edit through the command surface — the same
  // `parameter.set` command the parameter panel issues inside a
  // transaction.
  const session = createSession(document);
  const edited = unwrap(
    applySessionCommand(session, {
      type: "parameter.set",
      id: HOLE_PARAMETER,
      value: length(12.5),
    }),
    "holeDiameter edit",
  );
  const editedHint = evaluateExpression(
    expression.value,
    parameterEnvironment(edited.document.parameters),
  );
  if (!editedHint.ok) {
    throw new Error(
      `Re-evaluating the guide's expression failed: ${editedHint.error.message}`,
    );
  }

  const timeline = featureTimeline({
    features: edited.document.features,
    states: new Map(),
    rollback: null,
    suppressed: [],
  });
  if (!timeline.ok) {
    throw new Error(
      `The timeline refused the document: ${timeline.error.message}`,
    );
  }

  return {
    parameterCount: edited.document.parameters.parameters.length,
    holeDiameterMm: valueOf(document, HOLE_PARAMETER),
    volumeHintMm: hint.value.value,
    featureCount: edited.document.features.length,
    timelineKinds: timeline.value.map((entry) => entry.kind),
    editedHoleDiameterMm: valueOf(edited.document, HOLE_PARAMETER),
    editedVolumeHintMm: editedHint.value.value,
  };
}

function valueOf(document: CadDocument, id: ParameterId): number {
  const found = document.parameters.parameters.find(
    (parameter) => parameter.id === id,
  );
  if (found === undefined) {
    throw new Error(
      `The parameter ${String(id)} disappeared from the document.`,
    );
  }
  return found.value.value;
}

/** The ParseResult unwrap every guide snippet needs. */
export function unwrap<T, E extends { readonly message: string }>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(`Building ${what} failed: ${result.error.message}`);
  }
  return result.value;
}
