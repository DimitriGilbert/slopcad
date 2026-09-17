/**
 * The workbench document's shared extensions (Phase 15): the pieces BOTH
 * browser compositions derive from the same document — the expression-driven
 * parameter that gives the parameter panel real expression data, the executor
 * stand-in that decides feature outcomes from DOCUMENT data, and the
 * regeneration-state derivation the model tree feeds on. Extracted verbatim
 * from the Phase 15.1–15.4 fixture page so the composed workbench page and
 * the component fixture page stay one derivation apart from zero.
 *
 * The executor stand-in is the documented seam: nothing executes document
 * features into solids yet, so the executor decides per feature from the
 * document's own data. The translate feature fails — with a real,
 * registry-coded diagnostic located at the feature — when any of its
 * translation-component parameters holds a negative length; every other
 * feature rebuilds successfully.
 */

import {
  DIAGNOSTIC_CODES,
  getDocumentParameter,
  initialRegenerationStates,
  parseExpression,
  regenerate,
  valueIn,
  createParameterId,
  addDocumentParameter,
  length,
  type CadDocument,
  type FeatureExecutionOutcome,
  type FeatureRecord,
  type RegenerationStateMap,
} from "@slopcad/cad-react";

import { PLATE_HOLE_DIAMETER_DEFAULT_MM } from "../worker-fixture/plate-scene";

/** The extended document's expression-driven parameter id (stable across boots). */
const VOLUME_HINT_PARAMETER = createParameterId("param_volume_hint");

/**
 * Extends the workbench document with the expression-driven `volumeHint`
 * parameter (`holeDiameter * 2`, cached at the matching value) so the
 * parameter panel displays and edits real expression data. Adding a
 * parameter touches no feature, so the tree's derivation and the executor
 * stand-in are unaffected. The cached value goes stale when `holeDiameter`
 * moves — the domain's own semantics (recomputation is the regeneration
 * pipeline's job, never the panel's).
 */
export function workbenchDocumentWithVolumeHint(
  document: CadDocument,
): CadDocument {
  const parsed = parseExpression("holeDiameter * 2");
  if (!parsed.ok) {
    throw new Error(`Fixture expression rejected: ${parsed.error.message}`);
  }
  const added = addDocumentParameter(document, {
    id: VOLUME_HINT_PARAMETER,
    name: "volumeHint",
    value: length(PLATE_HOLE_DIAMETER_DEFAULT_MM * 2),
    expression: parsed.value,
  });
  if (!added.ok) {
    throw new Error(
      `Fixture rejected the volumeHint parameter: ${added.error.message}`,
    );
  }
  return added.value.document;
}

/**
 * The executor stand-in for feature regeneration: decides per feature from
 * the DOCUMENT's data (see the module doc).
 */
function executeWorkbenchFeature(
  feature: FeatureRecord,
  document: CadDocument,
): FeatureExecutionOutcome {
  if (feature.kind !== "translate") return { ok: true };
  const negative: string[] = [];
  for (const ref of feature.inputs) {
    if (ref.kind !== "parameter") continue;
    const parameter = getDocumentParameter(document, ref.id);
    if (parameter === undefined || parameter.value.dimension !== "length") {
      continue;
    }
    const millimetres = valueIn(parameter.value, "mm");
    if (millimetres < 0) {
      negative.push(`${parameter.name} = ${String(millimetres)} mm`);
    }
  }
  if (negative.length === 0) return { ok: true };
  return {
    ok: false,
    diagnostics: [
      {
        severity: "error",
        code: DIAGNOSTIC_CODES.kernelOperationFailed,
        message: `The translate executor refused a negative translation component (${negative.join(", ")}); translation components must be non-negative in this fixture.`,
        location: { primary: feature.id },
      },
    ],
  };
}

/**
 * The executor stand-in for feature regeneration, bound to a document:
 * decides per feature from the DOCUMENT's data (see the module doc). This is
 * the fixture's executor seam the Phase 20 robust regeneration loop runs —
 * parameter edits, rollback, suppression, and failure recovery all drive it
 * through `regenerate`.
 */
export function workbenchExecutor(
  document: CadDocument,
): (feature: FeatureRecord) => FeatureExecutionOutcome {
  return (feature) => executeWorkbenchFeature(feature, document);
}

/**
 * Derives the model tree's regeneration states from the document through
 * the domain's own orchestration: one pass of `regenerate` over the feature
 * list starting from the initial (stale) states.
 */
export function deriveWorkbenchRegenerationStates(
  document: CadDocument,
): RegenerationStateMap {
  const initial = initialRegenerationStates(document.features);
  const run = regenerate({
    features: document.features,
    states: initial,
    suppressed: [],
    execute: workbenchExecutor(document),
  });
  return run.ok ? run.value.states : initial;
}
