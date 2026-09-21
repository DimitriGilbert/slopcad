/**
 * The datum native-compatibility fixture generator (Phase 39): writes the
 * committed `packages/cad-core/fixtures/sketch-on-face.native.json` — the
 * native document the sketch-on-face journey persists: a named datum plane
 * record (`datum.create` in the transaction log, the `{ kind: "datum" }`
 * feature-input surface) anchoring a pad extrude to the base extrusion's
 * driving face, plus the face-anchored sketch and the base/pad bodies.
 *
 * This extends the golden fixture set with the datum record's additive
 * growth: the `datums` section, the `datum` id-generator counter, and the
 * datum-addressing feature input the v3 envelope stamp gates (an old
 * reader cannot carry them — see `version.ts`).
 *
 * Self-checking: the generator refuses to write unless the produced
 * document validates, round-trips to byte-identical text, and re-parses
 * with the log replay agreeing with the head state. Run from the repo
 * root:
 *
 *   pnpm --filter web exec tsx scripts/write-native-datum-fixture.ts
 *
 * Regenerating a golden fixture is always a deliberate act — the
 * compatibility suite pins byte identity, so a regenerated fixture shows
 * up as a diff.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  addDocumentParameter,
  addDocumentSketch,
  applySessionCommand,
  createBodyId,
  createDatumId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createNativeCadDocument,
  createParameterId,
  createSession,
  createSketchDocumentId,
  length,
  parseNativeCadDocumentFromString,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  validateNativeCadDocument,
  type CadDocument,
  type CadSession,
} from "@slopcad/cad-core";
import {
  createLineEntity,
  createSketch,
  createSketchEntityId,
  serializeSketch,
  xyWorkplane,
} from "@slopcad/cad-sketch";

const DOC = createDocumentId("doc_sketch_on_face");
const SKETCH = createSketchDocumentId("skd_base");
const DEPTH = createParameterId("param_base_depth");
const PAD_SKETCH = createSketchDocumentId("skd_pad");
const PAD_DEPTH = createParameterId("param_pad_depth");
const DATUM = createDatumId("dtm_face_plane");
const BASE_BODY = createBodyId("body_base");
const PAD_BODY = createBodyId("body_pad");
const BASE_FEATURE = createFeatureId("feat_base_extrude");
const PAD_FEATURE = createFeatureId("feat_pad_extrude");

const TARGET = "../../../packages/cad-core/fixtures/sketch-on-face.native.json";

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

/** A 24×16 rectangle sketch on the identity workplane. */
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
    [],
  );
  if (!created.ok) throw new Error(created.error.message);
  return serializeSketch(created.value) as unknown as Record<string, unknown>;
}

/** The substrate: both sketches and both depth parameters. */
function baseDocument(): CadDocument {
  let document = createDocument(DOC);
  document = requireOk(
    addDocumentSketch(document, {
      id: SKETCH,
      name: "base sketch",
      sketch: sketchPayload(),
    }),
    "the base sketch",
  ).document;
  document = requireOk(
    addDocumentSketch(document, {
      id: PAD_SKETCH,
      name: "pad sketch",
      sketch: sketchPayload(),
    }),
    "the pad sketch",
  ).document;
  document = requireOk(
    addDocumentParameter(document, {
      id: DEPTH,
      name: "baseDepth",
      value: length(10),
    }),
    "the baseDepth parameter",
  ).document;
  document = requireOk(
    addDocumentParameter(document, {
      id: PAD_DEPTH,
      name: "padDepth",
      value: length(6),
    }),
    "the padDepth parameter",
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
session = command(session, "body.create (base)", {
  type: "body.create",
  id: BASE_BODY,
  name: "base",
});
session = command(session, "feature.create (base extrude)", {
  type: "feature.create",
  id: BASE_FEATURE,
  kind: "extrude",
  inputs: [
    { kind: "sketch", id: SKETCH },
    { kind: "parameter", id: DEPTH },
  ],
  outputs: [BASE_BODY],
});
session = command(session, "datum.create (face plane)", {
  type: "datum.create",
  id: DATUM,
  name: "face plane 1",
  datum: {
    formatVersion: 1,
    datumType: "plane",
    definition: "faceOffset",
    reference: {
      kind: "sessionFace",
      bodyId: BASE_BODY,
      faceNormal: [0, 0, 1],
    },
    normalAtDefinition: [0, 0, 1],
    offsetMm: 0,
  },
});
session = command(session, "body.create (pad)", {
  type: "body.create",
  id: PAD_BODY,
  name: "pad",
});
session = command(session, "feature.create (pad extrude)", {
  type: "feature.create",
  id: PAD_FEATURE,
  kind: "extrude",
  inputs: [
    { kind: "sketch", id: PAD_SKETCH },
    { kind: "parameter", id: PAD_DEPTH },
    { kind: "datum", id: DATUM },
  ],
  outputs: [PAD_BODY],
});

const native = requireOk(
  createNativeCadDocument(session.document, {
    name: "sketch-on-face",
    unitSystem: "metric",
  }),
  "the native document",
);
const text = stringifyNativeCadDocument(
  serializeNativeCadDocument({
    ...native,
    history: session.history,
    regeneration: new Map([
      [BASE_FEATURE, { state: "valid", diagnostics: [] }],
      [PAD_FEATURE, { state: "valid", diagnostics: [] }],
    ]),
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
if (reparsed.document.datums.length !== 1) {
  throw new Error("The head document lost the datum record.");
}
const padFeature = reparsed.document.features.find(
  (feature) => feature.id === PAD_FEATURE,
);
if (
  padFeature === undefined ||
  !padFeature.inputs.some((ref) => ref.kind === "datum")
) {
  throw new Error("The pad feature lost its datum input.");
}
if (reparsed.history.cursor !== 5) {
  throw new Error(
    `The persisted log lost transactions: cursor ${String(reparsed.history.cursor)}, expected 5.`,
  );
}

const target = new URL(TARGET, import.meta.url);
await mkdir(fileURLToPath(new URL(".", target)), { recursive: true });
await writeFile(fileURLToPath(target), text, "utf8");
console.log(`wrote ${fileURLToPath(target)} (${String(text.length)} bytes)`);
