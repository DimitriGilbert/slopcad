/**
 * The moveFace / deleteFace / replaceFace verbs' authoring seam: the face
 * options a target snapshot offers, the ONE transaction
 * `faceOpCreateCommands` plans (the kind's parameters, the minted face
 * reference, the body, the feature in the canonical bridge layout), its
 * pre-commit refusals, and the round trip through the document scene —
 * each verb authors a feature that renders, and a repeated verb mints
 * collision-free ids.
 */

import { describe, expect, it } from "vitest";
import {
  addDocumentDatum,
  applyTransaction,
  createBodyId,
  createDatumId,
  createDocument,
  createDocumentId,
  DATUM_FORMAT_VERSION,
} from "@slopcad/cad-core";
import type { CadDocument, TopologySnapshot } from "@slopcad/cad-core";

import { documentSceneBodies } from "./document-scene";
import { documentFaceOpSceneRequests } from "./face-op";
import {
  FACE_OP_KINDS,
  faceOpCreateCommands,
  isFaceOpKind,
  type FaceOpKind,
  type FaceOpSpecification,
  type FaceOpSubmission,
} from "./face-op-pick";
import { PRIMITIVE_DEFAULTS, primitiveCreateCommands } from "./primitive";
import { highestResolvableScene, honestSceneFallback } from "./scene-fallback";
import { topologyPickOptionsOf } from "./topology-pick";

const DOC = createDocumentId("doc_face_op_verbs");
const KERNEL_ID = "fixture-kernel";
const SCHEMA = "fixture-snapshot-v1";

/** A blank document carrying one primitive box (`body_box`) and the z = 12 plane `dtm_top`. */
function boxDocument(): CadDocument {
  const plan = primitiveCreateCommands(createDocument(DOC), {
    shape: PRIMITIVE_DEFAULTS.box,
    offsetMm: [0, 0, 0],
  });
  if (!plan.ok) throw new Error(plan.message);
  const applied = applyTransaction(createDocument(DOC), {
    commands: plan.commands,
  });
  if (!applied.ok) throw new Error(applied.error.message);
  const withDatum = addDocumentDatum(applied.value, {
    id: createDatumId("dtm_top"),
    name: "top",
    datum: {
      formatVersion: DATUM_FORMAT_VERSION,
      datumType: "plane",
      definition: "originFrame",
      origin: [0, 0, 12],
      normal: [0, 0, 1],
      xAxis: [1, 0, 0],
    },
  });
  if (!withDatum.ok) throw new Error(withDatum.error.message);
  return withDatum.value.document;
}

/**
 * A hand-built persistent snapshot of `bodyId`: one named edge (0), two
 * named faces (0, 1), and one unnamed face (2).
 */
function snapshotOf(bodyId: string): TopologySnapshot {
  const identity = (hash: number) => ({
    kernelId: KERNEL_ID,
    schema: SCHEMA,
    data: { hash },
  });
  const face = (ordinal: number, named: boolean) => ({
    kind: "face" as const,
    ordinal,
    identity: named ? identity(200 + ordinal) : null,
    geometry: {
      areaMm2: 100,
      centroidAbsoluteMm: [0, 0, ordinal] as const,
      centroidRelativeMm: [0, 0, ordinal] as const,
    },
  });
  return {
    kernelId: KERNEL_ID,
    persistentTopology: true,
    identitySchemas: [SCHEMA],
    bodyId: createBodyId(bodyId),
    regeneration: 0,
    entities: [
      {
        kind: "edge",
        ordinal: 0,
        identity: identity(100),
        geometry: {
          lengthMm: 10,
          centroidAbsoluteMm: [0, 0, 0],
          centroidRelativeMm: [0, 0, 0],
        },
      },
      face(0, true),
      face(1, true),
      face(2, false),
    ],
  };
}

/** The in-domain specification each kind authors in these tests. */
const SPECIFICATIONS = {
  moveFace: { kind: "moveFace", axis: 3, distanceMm: -2 },
  deleteFace: { kind: "deleteFace", heal: true },
  replaceFace: { kind: "replaceFace", datumPlaneId: "dtm_top" },
} as const satisfies Readonly<Record<FaceOpKind, FaceOpSpecification>>;

/** Plans and commits one submission, failing loudly on refusal. */
function commit(
  document: CadDocument,
  submission: FaceOpSubmission,
): CadDocument {
  const plan = faceOpCreateCommands(document, submission);
  if (!plan.ok) throw new Error(plan.message);
  const applied = applyTransaction(document, { commands: plan.commands });
  if (!applied.ok) throw new Error(applied.error.message);
  return applied.value;
}

/** The scene's rendered bodies as `{ bodyId, kind }` pairs. */
function sceneBodiesOf(
  document: CadDocument,
): readonly { readonly bodyId: string; readonly kind: string }[] {
  return documentSceneBodies(document, new Set(), null)
    .filter((entry) => entry.consumedOnly !== true)
    .map((entry) => ({ bodyId: entry.bodyId, kind: entry.scene.kind }));
}

describe("the face-op pick surface: named faces only", () => {
  it.each(FACE_OP_KINDS)("offers %s the snapshot's named faces", (kind) => {
    expect(topologyPickOptionsOf(snapshotOf("body_box"), kind)).toEqual([
      { ordinal: 0, label: "Face 0 · 100 mm² at (0, 0, 0)" },
      { ordinal: 1, label: "Face 1 · 100 mm² at (0, 0, 1)" },
    ]);
  });

  it("names exactly the three verbs", () => {
    expect(FACE_OP_KINDS.every(isFaceOpKind)).toBe(true);
    expect(isFaceOpKind("shell")).toBe(false);
  });
});

describe("faceOpCreateCommands: the canonical bridge layout", () => {
  it("plans moveFace's axis and distance parameters, the face reference, the body, and the feature", () => {
    const plan = faceOpCreateCommands(boxDocument(), {
      snapshot: snapshotOf("body_box"),
      ordinal: 1,
      specification: SPECIFICATIONS.moveFace,
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.bodyId).toBe("body_moveFace");
    expect(plan.commands.map((command) => command.type)).toEqual([
      "parameter.create",
      "parameter.create",
      "reference.create",
      "body.create",
      "feature.create",
    ]);
    const [axis, distance] = plan.commands;
    if (axis?.type !== "parameter.create") throw new Error("no axis");
    if (distance?.type !== "parameter.create") throw new Error("no distance");
    expect(axis.name).toBe("moveFaceAxis");
    expect(axis.value.dimension).toBe("dimensionless");
    expect(axis.value.value).toBe(3);
    expect(distance.name).toBe("moveFaceDistance");
    expect(distance.value.dimension).toBe("length");
    expect(distance.value.value).toBe(-2);
    const feature = plan.commands[4];
    if (feature?.type !== "feature.create") throw new Error("no feature");
    expect(feature.kind).toBe("moveFace");
    expect(feature.inputs).toEqual([
      { kind: "feature", id: "feat_box" },
      { kind: "reference", id: "ref_moveFace_pick_0" },
      { kind: "parameter", id: "param_moveFace_axis" },
      { kind: "parameter", id: "param_moveFace_distance" },
    ]);
    expect(feature.outputs).toEqual(["body_moveFace"]);
  });

  it.each([
    [true, 1],
    [false, 0],
  ] as const)(
    "plans deleteFace's heal flag (%s → %d) after the face reference",
    (heal, flag) => {
      const plan = faceOpCreateCommands(boxDocument(), {
        snapshot: snapshotOf("body_box"),
        ordinal: 0,
        specification: { kind: "deleteFace", heal },
      });
      if (!plan.ok) throw new Error(plan.message);
      const [parameter] = plan.commands;
      if (parameter?.type !== "parameter.create") throw new Error("no heal");
      expect(parameter.name).toBe("deleteFaceHeal");
      expect(parameter.value.value).toBe(flag);
      const feature = plan.commands.at(-1);
      if (feature?.type !== "feature.create") throw new Error("no feature");
      expect(feature.inputs).toEqual([
        { kind: "feature", id: "feat_box" },
        { kind: "reference", id: "ref_deleteFace_pick_0" },
        { kind: "parameter", id: "param_deleteFace_heal" },
      ]);
    },
  );

  it("plans replaceFace with NO parameter and the datum plane as its trailing input", () => {
    const plan = faceOpCreateCommands(boxDocument(), {
      snapshot: snapshotOf("body_box"),
      ordinal: 0,
      specification: SPECIFICATIONS.replaceFace,
    });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.commands.map((command) => command.type)).toEqual([
      "reference.create",
      "body.create",
      "feature.create",
    ]);
    const feature = plan.commands[2];
    if (feature?.type !== "feature.create") throw new Error("no feature");
    expect(feature.inputs).toEqual([
      { kind: "feature", id: "feat_box" },
      { kind: "reference", id: "ref_replaceFace_pick_0" },
      { kind: "datum", id: "dtm_top" },
    ]);
  });

  it("refuses an off-domain axis or distance, a non-plane datum, and an unnameable pick", () => {
    const document = boxDocument();
    const codeOf = (
      specification: FaceOpSpecification,
      ordinal = 0,
    ): string => {
      const plan = faceOpCreateCommands(document, {
        snapshot: snapshotOf("body_box"),
        ordinal,
        specification,
      });
      return plan.ok ? "ok" : plan.code;
    };
    const move = SPECIFICATIONS.moveFace;
    expect(codeOf({ ...move, axis: 0 })).toBe("kernel/parameter-invalid");
    expect(codeOf({ ...move, axis: 1.5 })).toBe("kernel/parameter-invalid");
    expect(codeOf({ ...move, distanceMm: 0 })).toBe("kernel/parameter-invalid");
    expect(codeOf({ ...move, distanceMm: Number.POSITIVE_INFINITY })).toBe(
      "kernel/parameter-invalid",
    );
    expect(
      codeOf({ kind: "replaceFace", datumPlaneId: "dtm_missing" }),
    ).not.toBe("ok");
    expect(codeOf(SPECIFICATIONS.deleteFace, 2)).toBe(
      "reference/mint-unavailable",
    );
    expect(codeOf(SPECIFICATIONS.deleteFace, 9)).toBe(
      "reference/mint-unavailable",
    );
    expect(codeOf(move)).toBe("ok");
  });
});

describe("each face-op verb authors a feature that renders", () => {
  it.each(FACE_OP_KINDS)("renders the committed %s", (kind) => {
    const document = commit(boxDocument(), {
      snapshot: snapshotOf("body_box"),
      ordinal: 1,
      specification: SPECIFICATIONS[kind],
    });
    expect(sceneBodiesOf(document)).toEqual([
      { bodyId: `body_${kind}`, kind: "faceOp" },
    ]);
    const [request] = documentFaceOpSceneRequests(document);
    expect(request?.operation.kind).toBe(kind);
    expect(request?.targetBodyId).toBe("body_box");
    expect(request?.bodyId).toBe(`body_${kind}`);
    expect(highestResolvableScene(document)).toBe("faceOp");
    expect(honestSceneFallback(document, "faceOp")).toBeNull();
  });

  it("resolves the authored operation's values", () => {
    const moved = commit(boxDocument(), {
      snapshot: snapshotOf("body_box"),
      ordinal: 0,
      specification: { kind: "moveFace", axis: 1, distanceMm: 4 },
    });
    expect(documentFaceOpSceneRequests(moved)[0]?.operation).toEqual({
      kind: "moveFace",
      direction: [1, 0, 0],
      distanceMm: 4,
    });
    const replaced = commit(boxDocument(), {
      snapshot: snapshotOf("body_box"),
      ordinal: 0,
      specification: SPECIFICATIONS.replaceFace,
    });
    expect(documentFaceOpSceneRequests(replaced)[0]?.operation).toEqual({
      kind: "replaceFace",
      plane: { origin: [0, 0, 12], normal: [0, 0, 1] },
    });
  });

  it("chains a face op of a face op and mints collision-free ids on repeat", () => {
    let document = commit(boxDocument(), {
      snapshot: snapshotOf("body_box"),
      ordinal: 0,
      specification: SPECIFICATIONS.moveFace,
    });
    document = commit(document, {
      snapshot: snapshotOf("body_moveFace"),
      ordinal: 1,
      specification: { kind: "moveFace", axis: 2, distanceMm: 1 },
    });
    expect(sceneBodiesOf(document)).toEqual([
      { bodyId: "body_moveFace2", kind: "faceOp" },
    ]);
    expect(
      documentFaceOpSceneRequests(document).map((request) => request.bodyId),
    ).toEqual(["body_moveFace", "body_moveFace2"]);
  });
});
