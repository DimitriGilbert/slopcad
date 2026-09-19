/**
 * The native-compatibility fixture generator (Phase 35.2): writes the
 * committed `packages/cad-core/fixtures/workbench-extrude.native.json` by
 * building the document the REAL workbench journey persists — a parametric
 * sketch (rectangle + distance constraint) recorded into the document, an
 * expression-driven extrude depth, and an extrude feature consuming both —
 * with the parameter substrate (including the expression parameter) in the
 * base document and the modeling steps applied as real session
 * transactions, exactly the discipline the Phase 17 plate fixture follows.
 *
 * This extends the golden fixture set beyond the Phase 17 documents: the
 * original three carry primitives/booleans/failed/rolled-back states; this
 * one carries the sketch domain's serialized payload inside a native
 * document (the `{ kind: "sketch" }` feature-input surface), which the
 * workbench and the projects e2e journey persist in production.
 *
 * Self-checking: the generator refuses to write unless the produced
 * document validates, round-trips to byte-identical text, and re-parses
 * with the log replay agreeing with the head state (the format's own
 * consistency refusal). Run from the repo root:
 *
 *   pnpm --filter web write-native-compatibility-fixture
 *
 * (Node executes the TypeScript source directly through type stripping.)
 * Regenerating a golden fixture is always a deliberate act — the
 * compatibility suite pins byte identity, so a regenerated fixture shows up
 * as a diff.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  addDocumentParameter,
  addDocumentSketch,
  applySessionCommand,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createNativeCadDocument,
  createParameterId,
  createSession,
  createSketchDocumentId,
  length,
  parseExpression,
  parseNativeCadDocumentFromString,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  validateNativeCadDocument,
  type CadDocument,
  type CadSession,
} from "@slopcad/cad-core";
import {
  createDistanceConstraint,
  createLineEntity,
  createSketch,
  createSketchConstraintId,
  createSketchEntityId,
  pointTarget,
  serializeSketch,
  xyWorkplane,
} from "@slopcad/cad-sketch";

const DOC = createDocumentId("doc_workbench_extrude");
const SKETCH = createSketchDocumentId("skd_profile");
const DEPTH = createParameterId("param_extrude_depth");
const BASE = createParameterId("param_base_depth");
const BODY = createBodyId("body_pad");
const FEATURE = createFeatureId("feat_extrude");

const TARGET =
  "../../../packages/cad-core/fixtures/workbench-extrude.native.json";

function requireOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(
      `The fixture generator failed at ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

/** The parametric sketch the workbench journey draws: a 24×16 rectangle. */
function sketchPayload(): Record<string, unknown> {
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(
        createSketchEntityId("skent_rect_a"),
        { x: 0, y: 0 },
        { x: 24, y: 0 },
      ),
      createLineEntity(
        createSketchEntityId("skent_rect_b"),
        { x: 24, y: 0 },
        { x: 24, y: 16 },
      ),
      createLineEntity(
        createSketchEntityId("skent_rect_c"),
        { x: 24, y: 16 },
        { x: 0, y: 16 },
      ),
      createLineEntity(
        createSketchEntityId("skent_rect_d"),
        { x: 0, y: 16 },
        { x: 0, y: 0 },
      ),
    ],
    [
      createDistanceConstraint(
        createSketchConstraintId("skcon_width"),
        pointTarget(createSketchEntityId("skent_rect_a"), "start"),
        pointTarget(createSketchEntityId("skent_rect_a"), "end"),
        length(24),
      ),
    ],
  );
  if (!created.ok) throw new Error(created.error.message);
  return serializeSketch(created.value) as unknown as Record<string, unknown>;
}

/** The parameter substrate: baseDepth drives the expression-backed depth. */
function baseDocument(): CadDocument {
  let document = createDocument(DOC);
  document = requireOk(
    addDocumentSketch(document, {
      id: SKETCH,
      name: "profile",
      sketch: sketchPayload(),
    }),
    "sketch.create",
  ).document;
  document = requireOk(
    addDocumentParameter(document, {
      id: BASE,
      name: "baseDepth",
      value: length(6),
    }),
    "the baseDepth parameter",
  ).document;
  document = requireOk(
    addDocumentParameter(document, {
      id: DEPTH,
      name: "extrudeDepth",
      value: length(12),
      expression: requireOk(
        parseExpression("baseDepth * 2"),
        "the depth expression",
      ),
    }),
    "the extrudeDepth parameter",
  ).document;
  return document;
}

/** Applies one session command, refusing failures. */
function command(
  session: CadSession,
  what: string,
  cmd: Parameters<typeof applySessionCommand>[1],
): CadSession {
  return requireOk(applySessionCommand(session, cmd), what);
}

let session = createSession(baseDocument());
session = command(session, "body.create", {
  type: "body.create",
  id: BODY,
  name: "pad",
});
session = command(session, "feature.create", {
  type: "feature.create",
  id: FEATURE,
  kind: "extrude",
  inputs: [
    { kind: "sketch", id: SKETCH },
    { kind: "parameter", id: DEPTH },
  ],
  outputs: [BODY],
});
// A replayable parametric edit: baseDepth 6 → 9. The extrudeDepth cache
// stays 12 (the format stores the cached evaluation; recomputation is the
// regeneration pipeline's concern) and the feature persists as stale —
// the honest mid-edit state the workbench saves.
session = command(session, "the baseDepth edit", {
  type: "parameter.set",
  id: BASE,
  value: length(9),
});

const native = requireOk(
  createNativeCadDocument(session.document, {
    name: "workbench-extrude",
    unitSystem: "metric",
  }),
  "the native document",
);
const text = stringifyNativeCadDocument(
  serializeNativeCadDocument({
    ...native,
    history: session.history,
    regeneration: new Map([[FEATURE, { state: "stale", diagnostics: [] }]]),
    rollback: null,
  }),
);

// Self-checks before writing anything.
const validation = validateNativeCadDocument(JSON.parse(text));
if (!validation.valid) {
  throw new Error(
    `The generated document failed validation: ${JSON.stringify(validation.issues)}`,
  );
}
const reparsed = requireOk(
  parseNativeCadDocumentFromString(text),
  "the generated document's own re-parse",
);
if (stringifyNativeCadDocument(serializeNativeCadDocument(reparsed)) !== text) {
  throw new Error(
    "The generated document is not byte-stable across a round trip.",
  );
}
const headParams = new Map(
  reparsed.document.parameters.parameters.map((entry) => [
    entry.name,
    entry.value.value,
  ]),
);
if (
  headParams.get("baseDepth") !== 9 ||
  headParams.get("extrudeDepth") !== 12
) {
  throw new Error(
    `The head parameters drifted: ${JSON.stringify([...headParams])}`,
  );
}
if (reparsed.history.cursor !== 3) {
  throw new Error(
    `The persisted log lost transactions: cursor ${String(reparsed.history.cursor)}, expected 3.`,
  );
}

const target = new URL(TARGET, import.meta.url);
await mkdir(fileURLToPath(new URL(".", target)), { recursive: true });
await writeFile(fileURLToPath(target), text, "utf8");
console.log(`wrote ${fileURLToPath(target)} (${String(text.length)} bytes)`);
