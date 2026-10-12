/**
 * The composed workbench's boot session: an EMPTY document — no bodies,
 * no parameters, no features. A real workbench boot is a blank bench; the
 * author commits the first body through the sketch → solid actions and
 * the document scene renders it from that transaction on.
 *
 * The demo document below (the drilled plate, the through-bore diameter
 * the parameter panel edits, the translate-about-the-plate feature —
 * three length-component parameters — the rotate-about-+Z feature
 * downstream of the translate feature, the expression-driven pair
 * `volumeHint` (`holeDiameter * 2`) and `boreRadius` (`holeDiameter / 2`),
 * and the disabled mid-height section record) is the fixture the test
 * surfaces pin: a lean, real product document with a two-feature
 * timeline (the Phase 20 history surface's upstream/downstream pair) and
 * a section record to toggle. It boots only behind {@link
 * WORKBENCH_DEMO_SESSION_KEY} — the flag the e2e session's browser
 * context and the jsdom suites set once — or a `?demo` search parameter.
 * Saved documents from the demo era still carry its records, so the
 * plate scene machinery below keeps serving them; the flag only picks
 * the BOOT document.
 *
 * Deterministic (explicit ids), so the demo boots identically every run.
 * The hole parameter keeps the shared fixture id, so the established
 * `holeDiameterMm` reader works on this document unchanged.
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

/**
 * The opt-in flag a harness sets to boot the demo document instead of the
 * clean bench: a `slopcad:workbench-demo-session` localStorage key (the
 * e2e context's init script and the jsdom suites' setup), or a `?demo`
 * search parameter on the workbench route.
 */
export const WORKBENCH_DEMO_SESSION_KEY = "slopcad:workbench-demo-session";

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
 * Builds the workbench's boot session: one empty document. The clean
 * bench is the product default — the first authoring transaction adds
 * the first record.
 */
export function createCadWorkbenchSession(): CadSession {
  return createSession(createDocument(createDocumentId("doc_cad_workbench")));
}

/**
 * Whether this boot wants the demo document: the localStorage flag or a
 * `?demo` search parameter, absent outside a browser (server render,
 * Node callers) — the clean bench is the default everywhere.
 */
function demoSessionRequested(): boolean {
  if (typeof window === "undefined") return false;
  try {
    if (window.localStorage.getItem(WORKBENCH_DEMO_SESSION_KEY) !== null) {
      return true;
    }
  } catch {
    // localStorage denied (privacy mode): the search flag still applies.
  }
  return new URLSearchParams(window.location.search).has("demo");
}

/**
 * The session the workbench store boots: the demo plate document behind
 * the flag, the clean empty document otherwise.
 */
export function workbenchSessionForBoot(): CadSession {
  return demoSessionRequested()
    ? createCadWorkbenchDemoSession()
    : createCadWorkbenchSession();
}

/**
 * Builds the demo workbench session: the plate at the scene's default
 * bore, `holeDiameter`, the translate components, and `rotate_z` at
 * identity, `volumeHint` defined as `holeDiameter * 2`, and `boreRadius`
 * defined as `holeDiameter / 2` — both cached at their matching values
 * (the honest boot: cache equals what the expression produces at the
 * default). Feature order: translate first, rotate second (downstream).
 */
export function createCadWorkbenchDemoSession(): CadSession {
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
