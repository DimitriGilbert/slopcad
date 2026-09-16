/**
 * The composed workbench's document: the plate body, the through-bore
 * diameter the parameter panel edits, the rotate-about-+Z feature (with its
 * angle parameter), and the expression-driven `volumeHint`. A lean, real
 * product document — every tool the workbench's toolbar registers resolves
 * against it, and every parameter it carries is one the operator edits.
 * (The Phase 15.1–15.4 component fixture keeps the wider four-tool document
 * for component testing; see `workbench-fixture`.)
 *
 * Deterministic (explicit ids), so the workbench boots identically every
 * run. The hole parameter keeps the shared fixture id, so the established
 * `holeDiameterMm` reader works on this document unchanged.
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
  createSession,
  length,
  parseExpression,
  type CadSession,
  type ParameterId,
} from "@slopcad/cad-react";

import { PLATE_HOLE_DIAMETER_DEFAULT_MM } from "../worker-fixture/plate-scene";
import { requireDocumentOk } from "../workbench-fixture/workbench-document";

/** The stable plate body id (same body the projection carries). */
const PLATE_BODY_ID = createBodyId("body_plate");

/** The rotate-about-+Z angle parameter id. */
const ROTATE_PARAMETER: ParameterId = createParameterId("param_rotate_z");

/** The rotate feature id (the tree's feature group). */
const ROTATE_FEATURE = createFeatureId("feat_rotate_plate");

/** The volumeHint parameter id (stable across boots). */
const VOLUME_HINT_PARAMETER = createParameterId("param_volume_hint");

/** The hole diameter parameter id — the shared fixture id (see module doc). */
const HOLE_PARAMETER = createParameterId("param_hole_diameter");

/**
 * Builds the workbench session: the plate at the scene's default bore,
 * `holeDiameter` and `rotate_z` at identity, and `volumeHint` defined as
 * `holeDiameter * 2`, cached at the matching value.
 */
export function createCadWorkbenchSession(): CadSession {
  const parsed = parseExpression("holeDiameter * 2");
  if (!parsed.ok) {
    throw new Error(`Workbench expression rejected: ${parsed.error.message}`);
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
    expression: parsed.value,
  });
  document = requireDocumentOk(hinted, "the volumeHint parameter");
  document = requireDocumentOk(
    addFeature(document, {
      id: ROTATE_FEATURE,
      kind: "rotate",
      inputs: [
        { kind: "body", id: PLATE_BODY_ID },
        { kind: "parameter", id: ROTATE_PARAMETER },
      ],
      outputs: [PLATE_BODY_ID],
    }),
    "the rotate feature",
  );
  return createSession(document);
}
