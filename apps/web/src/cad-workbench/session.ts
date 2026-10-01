/**
 * The composed workbench's document: the plate body, the through-bore
 * diameter the parameter panel edits, the translate-about-the-plate feature
 * (three length-component parameters), the rotate-about-+Z feature
 * downstream of the translate feature, and the expression-driven pair
 * `volumeHint` (`holeDiameter * 2`) and `boreRadius` (`holeDiameter / 2`) —
 * two levels of stored expressions, so a single `holeDiameter` commit
 * re-derives both through the command vocabulary's recompute. A lean, real
 * product document with a two-feature timeline — the Phase 20 history
 * surface (rollback, suppression, failure recovery) needs an
 * upstream/downstream pair to act on, so the rotate feature declares the
 * translate feature as an input. Every tool the workbench's toolbar
 * registers resolves against it: rotate resolves the rotate feature
 * (body + exactly one angle parameter), translate resolves the translate
 * feature (body + three length parameters).
 *
 * Deterministic (explicit ids), so the workbench boots identically every
 * run. The hole parameter keeps the shared fixture id, so the established
 * `holeDiameterMm` reader works on this document unchanged. Parameters
 * touch no feature, so the tree's derivation, the executor stand-in, and
 * the boot scene are unaffected by the expression-driven pair.
 */

import {
  addBody,
  addDocumentParameter,
  addDocumentSection,
  addFeature,
  angle,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  createSectionId,
  createSession,
  length,
  parseExpression,
  type BodyId,
  type CadSession,
  type FeatureId,
  type ParameterId,
} from "@slopcad/cad-react";

import { PLATE_HOLE_DIAMETER_DEFAULT_MM } from "../worker-fixture/plate-scene";
import { requireDocumentOk } from "../workbench-fixture/workbench-document";

/** The stable plate body id (same body the projection carries). */
const PLATE_BODY_ID: BodyId = createBodyId("body_plate");

/** The rotate-about-+Z angle parameter id. */
const ROTATE_PARAMETER: ParameterId = createParameterId("param_rotate_z");

/** The translate component parameter ids, in x, y, z order. */
const TRANSLATE_PARAMETERS: readonly [ParameterId, ParameterId, ParameterId] = [
  createParameterId("param_translate_x"),
  createParameterId("param_translate_y"),
  createParameterId("param_translate_z"),
];

/** The translate feature id (the timeline's upstream feature). */
const TRANSLATE_FEATURE: FeatureId = createFeatureId("feat_translate_plate");

/** The rotate feature id (the timeline's downstream feature). */
const ROTATE_FEATURE: FeatureId = createFeatureId("feat_rotate_plate");

/** The volumeHint parameter id (stable across boots). */
const VOLUME_HINT_PARAMETER = createParameterId("param_volume_hint");

/** The boreRadius parameter id (stable across boots). */
const BORE_RADIUS_PARAMETER = createParameterId("param_bore_radius");

/** The hole diameter parameter id — the shared fixture id (see module doc). */
const HOLE_PARAMETER = createParameterId("param_hole_diameter");

/**
 * Builds the workbench session: the plate at the scene's default bore,
 * `holeDiameter`, the translate components, and `rotate_z` at identity,
 * `volumeHint` defined as `holeDiameter * 2`, and `boreRadius` defined as
 * `holeDiameter / 2` — both cached at their matching values (the honest
 * boot: cache equals what the expression produces at the default). Feature
 * order: translate first, rotate second (downstream).
 */
export function createCadWorkbenchSession(): CadSession {
  const hint = parseExpression("holeDiameter * 2");
  if (!hint.ok) {
    throw new Error(`Workbench expression rejected: ${hint.error.message}`);
  }
  const radius = parseExpression("holeDiameter / 2");
  if (!radius.ok) {
    throw new Error(`Workbench expression rejected: ${radius.error.message}`);
  }
  let document = createDocument(createDocumentId("doc_cad_workbench"));
  document = requireDocumentOk(
    addBody(document, { id: PLATE_BODY_ID, name: "plate" }),
    "the plate body",
  );
  document = requireDocumentOk(
    addDocumentParameter(document, {
      id: HOLE_PARAMETER,
      name: "holeDiameter",
      value: length(PLATE_HOLE_DIAMETER_DEFAULT_MM),
    }),
    "the hole diameter parameter",
  );
  for (const [id, name] of [
    [TRANSLATE_PARAMETERS[0], "translate_x"],
    [TRANSLATE_PARAMETERS[1], "translate_y"],
    [TRANSLATE_PARAMETERS[2], "translate_z"],
  ] as const) {
    document = requireDocumentOk(
      addDocumentParameter(document, { id, name, value: length(0) }),
      `parameter ${name}`,
    );
  }
  document = requireDocumentOk(
    addDocumentParameter(document, {
      id: ROTATE_PARAMETER,
      name: "rotate_z",
      value: angle(0),
    }),
    "the rotate angle parameter",
  );
  const hinted = addDocumentParameter(document, {
    id: VOLUME_HINT_PARAMETER,
    name: "volumeHint",
    value: length(PLATE_HOLE_DIAMETER_DEFAULT_MM * 2),
    expression: hint.value,
  });
  document = requireDocumentOk(hinted, "the volumeHint parameter");
  const radiused = addDocumentParameter(document, {
    id: BORE_RADIUS_PARAMETER,
    name: "boreRadius",
    value: length(PLATE_HOLE_DIAMETER_DEFAULT_MM / 2),
    expression: radius.value,
  });
  document = requireDocumentOk(radiused, "the boreRadius parameter");
  document = requireDocumentOk(
    addFeature(document, {
      id: TRANSLATE_FEATURE,
      kind: "translate",
      inputs: [
        { kind: "body", id: PLATE_BODY_ID },
        { kind: "parameter", id: TRANSLATE_PARAMETERS[0] },
        { kind: "parameter", id: TRANSLATE_PARAMETERS[1] },
        { kind: "parameter", id: TRANSLATE_PARAMETERS[2] },
      ],
      outputs: [PLATE_BODY_ID],
    }),
    "the translate feature",
  );
  // The Phase 46 section display record: the plate's mid-height plane
  // (centre, +z normal, the normal's side kept), PERSISTED DISABLED — a
  // fresh boot clips nothing and computes no section, so the unsectioned
  // settle and its raster stay byte-identical (the boot-state law).
  document = requireDocumentOk(
    addDocumentSection(document, {
      id: createSectionId("sec_mid_height"),
      name: "mid-height",
      origin: [15, 10, 5],
      normal: [0, 0, 1],
      keepSide: 1,
      enabled: false,
    }),
    "the mid-height section record",
  );
  document = requireDocumentOk(
    addFeature(document, {
      id: ROTATE_FEATURE,
      kind: "rotate",
      inputs: [
        { kind: "body", id: PLATE_BODY_ID },
        { kind: "feature", id: TRANSLATE_FEATURE },
        { kind: "parameter", id: ROTATE_PARAMETER },
      ],
      outputs: [PLATE_BODY_ID],
    }),
    "the rotate feature",
  );
  return createSession(document);
}
