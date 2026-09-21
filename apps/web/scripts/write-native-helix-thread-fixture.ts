/**
 * The Phase 40 native-compatibility fixture generator: writes the committed
 * `packages/cad-core/fixtures/helix-thread.native.json` by building the
 * document the REAL helix and thread journeys persist — a meridian sketch
 * (four-line rectangle) consumed by a helix feature with its six spine
 * parameters and a twoPoints datum axis, plus a circle sketch extruded and
 * threaded with a picked ISO specification (major diameter, pitch, length,
 * mode, handedness, world-axis selector) — with the whole parameter
 * substrate in the base document and the modeling steps applied as real
 * session transactions, exactly the discipline the Phase 17/35/39
 * generators follow.
 *
 * The new feature kinds ride the OPEN kind vocabulary the native format
 * already carries: no envelope bump is needed (an older reader keeps the
 * records verbatim and simply does not interpret the kinds — the same
 * additive growth the Phase 38 sweep/loft features shipped under).
 *
 * Self-checking: the generator refuses to write unless the produced
 * document validates, round-trips to byte-identical text, and carries the
 * expected feature kinds and parameter set. Run from the repo root:
 *
 *   pnpm --filter web write-native-helix-thread-fixture
 */

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  addDocumentDatum,
  addDocumentParameter,
  addDocumentSketch,
  angle,
  applySessionCommand,
  createBodyId,
  createDocument,
  createDocumentId,
  createDatumId,
  createFeatureId,
  createNativeCadDocument,
  createParameterId,
  createSession,
  createSketchDocumentId,
  dimensionless,
  length,
  parseNativeCadDocumentFromString,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  validateNativeCadDocument,
  type CadDocument,
  type CadSession,
} from "@slopcad/cad-core";
import {
  createCircleEntity,
  createLineEntity,
  createSketch,
  createSketchEntityId,
  serializeSketch,
  xyWorkplane,
} from "@slopcad/cad-sketch";

const DOC = createDocumentId("doc_workbench_helix_thread");
const MERIDIAN = createSketchDocumentId("skd_meridian");
const CIRCLE = createSketchDocumentId("skd_rod_circle");
const EXTRUDE_DEPTH = createParameterId("param_rod_depth");
const HELIX_RADIUS = createParameterId("param_helix_radius");
const HELIX_PITCH = createParameterId("param_helix_pitch");
const HELIX_TURNS = createParameterId("param_helix_turns");
const HELIX_HANDEDNESS = createParameterId("param_helix_handedness");
const HELIX_START = createParameterId("param_helix_start");
const HELIX_TAPER = createParameterId("param_helix_taper");
const THREAD_MAJOR = createParameterId("param_thread_major");
const THREAD_PITCH = createParameterId("param_thread_pitch");
const THREAD_LENGTH = createParameterId("param_thread_length");
const THREAD_MODE = createParameterId("param_thread_mode");
const THREAD_HANDEDNESS = createParameterId("param_thread_handedness");
const THREAD_AXIS = createParameterId("param_thread_axis");
const AXIS_DATUM = createDatumId("dtm_helix_axis");
const ROD_BODY = createBodyId("body_rod");
const SPRING_BODY = createBodyId("body_spring");
const THREADED_BODY = createBodyId("body_threaded");
const ROD_FEATURE = createFeatureId("feat_rod");
const HELIX_FEATURE = createFeatureId("feat_helix");
const THREAD_FEATURE = createFeatureId("feat_thread");

const TARGET = "../../../packages/cad-core/fixtures/helix-thread.native.json";

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

/** Serializes a sketch of entities on the XY workplane. */
function sketchPayloadOf(
  entities: readonly Parameters<typeof createSketch>[1][number][],
): Record<string, unknown> {
  const created = createSketch(xyWorkplane(), entities, []);
  if (!created.ok) throw new Error(created.error.message);
  return serializeSketch(created.value) as unknown as Record<string, unknown>;
}

/** The meridian rectangle: u ∈ [0, 2], v ∈ [−0.75, 0.75]. */
function meridianSketchPayload(): Record<string, unknown> {
  return sketchPayloadOf([
    createLineEntity(
      createSketchEntityId("skent_mer_a"),
      { x: 0, y: -0.75 },
      { x: 2, y: -0.75 },
    ),
    createLineEntity(
      createSketchEntityId("skent_mer_b"),
      { x: 2, y: -0.75 },
      { x: 2, y: 0.75 },
    ),
    createLineEntity(
      createSketchEntityId("skent_mer_c"),
      { x: 2, y: 0.75 },
      { x: 0, y: 0.75 },
    ),
    createLineEntity(
      createSketchEntityId("skent_mer_d"),
      { x: 0, y: 0.75 },
      { x: 0, y: -0.75 },
    ),
  ]);
}

/** The rod's circle: radius 3 at the origin (an M6 major cylinder). */
function circleSketchPayload(): Record<string, unknown> {
  return sketchPayloadOf([
    createCircleEntity(createSketchEntityId("skent_rod"), { x: 0, y: 0 }, 3),
  ]);
}

/** The parameter + sketch + datum substrate every transaction builds on. */
function baseDocument(): CadDocument {
  let document = createDocument(DOC);
  document = requireOk(
    addDocumentSketch(document, {
      id: MERIDIAN,
      name: "meridian profile",
      sketch: meridianSketchPayload(),
    }),
    "the meridian sketch",
  ).document;
  document = requireOk(
    addDocumentSketch(document, {
      id: CIRCLE,
      name: "rod circle",
      sketch: circleSketchPayload(),
    }),
    "the rod circle sketch",
  ).document;
  document = requireOk(
    addDocumentDatum(document, {
      id: AXIS_DATUM,
      name: "helix axis",
      datum: {
        formatVersion: 1,
        datumType: "axis",
        definition: "twoPoints",
        first: [0, 0, 0],
        second: [0, 0, 1],
      },
    }),
    "the helix axis datum",
  ).document;
  const parameters: [
    ReturnType<typeof createParameterId>,
    string,
    (
      | ReturnType<typeof length>
      | ReturnType<typeof angle>
      | ReturnType<typeof dimensionless>
    ),
  ][] = [
    [EXTRUDE_DEPTH, "rodDepth", length(6)],
    [HELIX_RADIUS, "helixRadius", length(10)],
    [HELIX_PITCH, "helixPitch", length(4)],
    [HELIX_TURNS, "helixTurns", dimensionless(3)],
    [HELIX_HANDEDNESS, "helixHandedness", dimensionless(1)],
    [HELIX_START, "helixStartAngle", angle(0)],
    [HELIX_TAPER, "helixTaper", length(0)],
    [THREAD_MAJOR, "threadMajor", length(6)],
    [THREAD_PITCH, "threadPitch", length(1)],
    [THREAD_LENGTH, "threadLength", length(6)],
    [THREAD_MODE, "threadMode", dimensionless(1)],
    [THREAD_HANDEDNESS, "threadHandedness", dimensionless(1)],
    [THREAD_AXIS, "threadAxis", dimensionless(3)],
  ];
  for (const [id, name, value] of parameters) {
    document = requireOk(
      addDocumentParameter(document, { id, name, value }),
      `parameter ${name}`,
    ).document;
  }
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
session = command(session, "the rod body", {
  type: "body.create",
  id: ROD_BODY,
  name: "rod",
});
session = command(session, "the extrude feature", {
  type: "feature.create",
  id: ROD_FEATURE,
  kind: "extrude",
  inputs: [
    { kind: "sketch", id: CIRCLE },
    { kind: "parameter", id: EXTRUDE_DEPTH },
  ],
  outputs: [ROD_BODY],
});
session = command(session, "the spring body", {
  type: "body.create",
  id: SPRING_BODY,
  name: "spring",
});
session = command(session, "the helix feature", {
  type: "feature.create",
  id: HELIX_FEATURE,
  kind: "helix",
  inputs: [
    { kind: "sketch", id: MERIDIAN },
    { kind: "parameter", id: HELIX_RADIUS },
    { kind: "parameter", id: HELIX_PITCH },
    { kind: "parameter", id: HELIX_TURNS },
    { kind: "parameter", id: HELIX_HANDEDNESS },
    { kind: "parameter", id: HELIX_START },
    { kind: "parameter", id: HELIX_TAPER },
    { kind: "datum", id: AXIS_DATUM },
  ],
  outputs: [SPRING_BODY],
});
session = command(session, "the threaded body", {
  type: "body.create",
  id: THREADED_BODY,
  name: "threaded",
});
session = command(session, "the thread feature", {
  type: "feature.create",
  id: THREAD_FEATURE,
  kind: "thread",
  inputs: [
    { kind: "feature", id: ROD_FEATURE },
    { kind: "parameter", id: THREAD_MAJOR },
    { kind: "parameter", id: THREAD_PITCH },
    { kind: "parameter", id: THREAD_LENGTH },
    { kind: "parameter", id: THREAD_MODE },
    { kind: "parameter", id: THREAD_HANDEDNESS },
    { kind: "parameter", id: THREAD_AXIS },
  ],
  outputs: [THREADED_BODY],
});
// A replayable parametric edit: the thread lengthens 6 → 8 (one more full
// turn at the M6×1 pitch). The features persist as stale — the honest
// mid-edit state the workbench saves.
session = command(session, "the thread length edit", {
  type: "parameter.set",
  id: THREAD_LENGTH,
  value: length(8),
});

const native = requireOk(
  createNativeCadDocument(session.document, {
    name: "helix-thread",
    unitSystem: "metric",
  }),
  "the native document",
);
const text = stringifyNativeCadDocument(
  serializeNativeCadDocument({
    ...native,
    history: session.history,
    regeneration: new Map([
      [ROD_FEATURE, { state: "stale", diagnostics: [] }],
      [HELIX_FEATURE, { state: "stale", diagnostics: [] }],
      [THREAD_FEATURE, { state: "stale", diagnostics: [] }],
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
const kinds = reparsed.document.features.map((feature) => feature.kind);
if (
  !kinds.includes("helix") ||
  !kinds.includes("thread") ||
  !kinds.includes("extrude")
) {
  throw new Error(`The feature kinds drifted: ${JSON.stringify(kinds)}`);
}
const headParams = new Map(
  reparsed.document.parameters.parameters.map((entry) => [
    entry.name,
    entry.value.value,
  ]),
);
if (
  headParams.get("threadLength") !== 8 ||
  headParams.get("helixRadius") !== 10
) {
  throw new Error(
    `The head parameters drifted: ${JSON.stringify([...headParams])}`,
  );
}
if (reparsed.history.cursor !== 7) {
  throw new Error(
    `The persisted log lost transactions: cursor ${String(reparsed.history.cursor)}, expected 7.`,
  );
}

const target = new URL(TARGET, import.meta.url);
await mkdir(fileURLToPath(new URL(".", target)), { recursive: true });
await writeFile(fileURLToPath(target), text, "utf8");
console.log(`wrote ${fileURLToPath(target)} (${String(text.length)} bytes)`);
