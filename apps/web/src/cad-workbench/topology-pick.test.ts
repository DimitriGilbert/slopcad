/**
 * The fillet / chamfer / shell verbs' authoring seam: the pick options a
 * target snapshot offers per verb, the ONE transaction
 * `topologyCutCreateCommands` plans (size parameter, minted persistent
 * references, body, feature in the canonical bridge layout), its
 * pre-commit refusals, and the round trip through the document scene —
 * each verb authors a feature that renders, a cut of a cut chains, and
 * repeated verbs mint collision-free ids.
 */

import { describe, expect, it } from "vitest";
import {
  angle,
  applyTransaction,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createParameterId,
  dimensionless,
  length,
} from "@slopcad/cad-core";
import type {
  CadCommand,
  CadDocument,
  TopologySnapshot,
} from "@slopcad/cad-core";

import { extrudeCamera } from "../render-fixture/plate-render-scene";
import { documentSceneBodies } from "./document-scene";
import { PRIMITIVE_DEFAULTS, primitiveCreateCommands } from "./primitive";
import { highestResolvableScene } from "./scene-fallback";
import { documentTopologyCutSceneRequests } from "./topology-cut";
import {
  isTopologyCutKind,
  nearestTopologyAnchor,
  nextTopologyPicks,
  TOPOLOGY_CUT_KINDS,
  topologyAnchorPointOf,
  topologyCutCreateCommands,
  topologyPickOptionsOf,
  topologyTargetAnchorsOf,
  type TopologyCutSubmission,
} from "./topology-pick";

const DOC = createDocumentId("doc_topology_cut_verbs");
const KERNEL_ID = "fixture-kernel";
const SCHEMA = "fixture-snapshot-v1";

/** A blank document carrying one primitive box (`body_box`). */
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
  return applied.value;
}

/**
 * The box document plus ONE duplicate feature (`feat_dup`) of the box
 * with TWO copies — a multi-output producer whose outputs are
 * `body_dup_a` (first) and `body_dup_b` (second).
 */
function duplicatedBoxDocument(): CadDocument {
  // The bridge's duplicate layout, in declared order: dx, dy, dz, count,
  // axis (3 = world Z), angle.
  const parameters = (
    [
      ["dupDx", length(20)],
      ["dupDy", length(0)],
      ["dupDz", length(0)],
      ["dupCount", dimensionless(2)],
      ["dupAxis", dimensionless(3)],
      ["dupAngle", angle(0, "deg")],
    ] as const
  ).map(([name, value]) => ({
    id: createParameterId(`param_${name}`),
    name,
    value,
  }));
  const applied = applyTransaction(boxDocument(), {
    commands: [
      ...parameters.map((parameter): CadCommand => ({
        type: "parameter.create",
        ...parameter,
      })),
      { type: "body.create", id: createBodyId("body_dup_a"), name: "copy 1" },
      { type: "body.create", id: createBodyId("body_dup_b"), name: "copy 2" },
      {
        type: "feature.create",
        id: createFeatureId("feat_dup"),
        kind: "duplicate",
        inputs: [
          { kind: "feature", id: createFeatureId("feat_box") },
          ...parameters.map(({ id }) => ({ kind: "parameter" as const, id })),
        ],
        outputs: [createBodyId("body_dup_a"), createBodyId("body_dup_b")],
      },
    ],
  });
  if (!applied.ok) throw new Error(applied.error.message);
  return applied.value;
}

/**
 * A hand-built persistent snapshot of `bodyId`: two named edges (0, 1),
 * one unnamed edge (2), and two named faces (0, 1).
 */
function snapshotOf(bodyId: string): TopologySnapshot {
  const identity = (hash: number) => ({
    kernelId: KERNEL_ID,
    schema: SCHEMA,
    data: { hash },
  });
  const edge = (ordinal: number, named: boolean) => ({
    kind: "edge" as const,
    ordinal,
    identity: named ? identity(100 + ordinal) : null,
    geometry: {
      lengthMm: 10,
      centroidAbsoluteMm: [ordinal, 0, 0] as const,
      centroidRelativeMm: [ordinal, 0, 0] as const,
    },
  });
  const face = (ordinal: number) => ({
    kind: "face" as const,
    ordinal,
    identity: identity(200 + ordinal),
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
    entities: [edge(0, true), edge(1, true), edge(2, false), face(0), face(1)],
  };
}

/** Plans and commits one submission, failing loudly on refusal. */
function commit(
  document: CadDocument,
  submission: TopologyCutSubmission,
): CadDocument {
  const plan = topologyCutCreateCommands(document, submission);
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

describe("topologyPickOptionsOf: the verb's entity kind, named entities only", () => {
  it("offers the named edges to fillet/chamfer and the faces to shell", () => {
    const snapshot = snapshotOf("body_box");
    expect(topologyPickOptionsOf(snapshot, "fillet")).toEqual([
      { ordinal: 0, label: "Edge 0 · 10 mm at (0, 0, 0)" },
      { ordinal: 1, label: "Edge 1 · 10 mm at (1, 0, 0)" },
    ]);
    expect(topologyPickOptionsOf(snapshot, "chamfer")).toHaveLength(2);
    expect(topologyPickOptionsOf(snapshot, "shell")).toEqual([
      { ordinal: 0, label: "Face 0 · 100 mm² at (0, 0, 0)" },
      { ordinal: 1, label: "Face 1 · 100 mm² at (0, 0, 1)" },
    ]);
  });

  it("names exactly the three verbs", () => {
    expect(TOPOLOGY_CUT_KINDS.every(isTopologyCutKind)).toBe(true);
    expect(isTopologyCutKind("box")).toBe(false);
  });
});

describe("the viewport pick gesture: projected anchors, nearest click, picks", () => {
  const frame = {
    camera: extrudeCamera({ min: [0, 0, 0], max: [10, 10, 10] }),
    width: 640,
    height: 480,
  };
  const targets = [
    { bodyId: "body_box", snapshot: snapshotOf("body_box") },
    { bodyId: "body_other", snapshot: snapshotOf("body_other") },
  ];

  it("projects every target's pickable entities of the verb's kind through the camera", () => {
    const edges = topologyTargetAnchorsOf(targets, "fillet", frame);
    expect(edges.map(({ bodyId, ordinal }) => [bodyId, ordinal])).toEqual([
      ["body_box", 0],
      ["body_box", 1],
      ["body_other", 0],
      ["body_other", 1],
    ]);
    expect(edges[1]?.point).toEqual(topologyAnchorPointOf([1, 0, 0], frame));
    const faces = topologyTargetAnchorsOf(targets, "moveFace", frame);
    expect(faces[1]?.point).toEqual(topologyAnchorPointOf([0, 0, 1], frame));
    expect(topologyTargetAnchorsOf(targets, "shell", frame)).toHaveLength(4);
  });

  it("picks the nearest anchor within the radius and nothing beyond it", () => {
    const anchors = [
      { ordinal: 0, point: [100, 100] as const },
      { ordinal: 1, point: [110, 100] as const },
    ];
    expect(nearestTopologyAnchor(anchors, 108, 101)?.ordinal).toBe(1);
    expect(nearestTopologyAnchor(anchors, 100, 123)?.ordinal).toBe(0);
    expect(nearestTopologyAnchor(anchors, 100, 140)).toBeNull();
    expect(nearestTopologyAnchor([], 0, 0)).toBeNull();
  });

  it("toggles the cuts' multi-pick on one body and replaces the face ops' single pick", () => {
    const first = nextTopologyPicks(
      null,
      { bodyId: "body_box", ordinal: 0 },
      "fillet",
    );
    expect(first).toEqual({ bodyId: "body_box", ordinals: [0] });
    const both = nextTopologyPicks(
      first,
      { bodyId: "body_box", ordinal: 1 },
      "fillet",
    );
    expect(both).toEqual({ bodyId: "body_box", ordinals: [0, 1] });
    expect(
      nextTopologyPicks(both, { bodyId: "body_box", ordinal: 0 }, "shell"),
    ).toEqual({ bodyId: "body_box", ordinals: [1] });
    expect(
      nextTopologyPicks(both, { bodyId: "body_other", ordinal: 1 }, "chamfer"),
    ).toEqual({ bodyId: "body_other", ordinals: [1] });
    expect(
      nextTopologyPicks(both, { bodyId: "body_box", ordinal: 1 }, "moveFace"),
    ).toEqual({ bodyId: "body_box", ordinals: [1] });
  });
});

describe("topologyCutCreateCommands: the canonical bridge layout", () => {
  it.each(TOPOLOGY_CUT_KINDS)(
    "plans the size parameter, the minted references, the body, and the %s feature",
    (kind) => {
      const document = boxDocument();
      const plan = topologyCutCreateCommands(document, {
        kind,
        snapshot: snapshotOf("body_box"),
        ordinals: [0, 1],
        sizeMm: 1.5,
      });
      if (!plan.ok) throw new Error(plan.message);
      expect(plan.bodyId).toBe(`body_${kind}`);
      expect(plan.commands.map((command) => command.type)).toEqual([
        "parameter.create",
        "reference.create",
        "reference.create",
        "body.create",
        "feature.create",
      ]);
      const feature = plan.commands[4];
      if (feature?.type !== "feature.create") throw new Error("no feature");
      expect(feature.kind).toBe(kind);
      expect(feature.inputs).toEqual([
        { kind: "feature", id: "feat_box" },
        { kind: "reference", id: `ref_${kind}_pick_0` },
        { kind: "reference", id: `ref_${kind}_pick_1` },
        { kind: "parameter", id: `param_${kind}_size` },
      ]);
      expect(feature.outputs).toEqual([`body_${kind}`]);
    },
  );

  it("refuses a non-positive size, an empty or repeated selection, and an unnameable pick", () => {
    const document = boxDocument();
    const base = {
      kind: "fillet" as const,
      snapshot: snapshotOf("body_box"),
      ordinals: [0],
      sizeMm: 1,
    };
    const codeOf = (submission: TopologyCutSubmission) => {
      const plan = topologyCutCreateCommands(document, submission);
      return plan.ok ? "ok" : plan.code;
    };
    expect(codeOf({ ...base, sizeMm: 0 })).toBe("kernel/parameter-invalid");
    expect(codeOf({ ...base, sizeMm: Number.NaN })).toBe(
      "kernel/parameter-invalid",
    );
    expect(codeOf({ ...base, ordinals: [] })).toBe("kernel/invalid-operands");
    expect(codeOf({ ...base, ordinals: [0, 0] })).toBe(
      "kernel/invalid-operands",
    );
    expect(codeOf({ ...base, ordinals: [2] })).toBe(
      "reference/mint-unavailable",
    );
    expect(codeOf({ ...base, ordinals: [9] })).toBe(
      "reference/mint-unavailable",
    );
    expect(codeOf(base)).toBe("ok");
  });
});

describe("each topology-cut verb authors a feature that renders", () => {
  it.each(TOPOLOGY_CUT_KINDS)("renders the committed %s", (kind) => {
    const document = commit(boxDocument(), {
      kind,
      snapshot: snapshotOf("body_box"),
      ordinals: [1],
      sizeMm: 2,
    });
    expect(sceneBodiesOf(document)).toEqual([
      { bodyId: `body_${kind}`, kind: "topologyCut" },
    ]);
    const [request] = documentTopologyCutSceneRequests(document);
    expect(request?.kind).toBe(kind);
    expect(request?.sizeMm).toBe(2);
    expect(highestResolvableScene(document)).toBe("topologyCut");
  });

  it("chains a cut of a cut and mints collision-free ids on repeat", () => {
    let document = commit(boxDocument(), {
      kind: "fillet",
      snapshot: snapshotOf("body_box"),
      ordinals: [0],
      sizeMm: 1,
    });
    document = commit(document, {
      kind: "fillet",
      snapshot: snapshotOf("body_fillet"),
      ordinals: [1],
      sizeMm: 0.5,
    });
    expect(sceneBodiesOf(document)).toEqual([
      { bodyId: "body_fillet2", kind: "topologyCut" },
    ]);
    const requests = documentTopologyCutSceneRequests(document);
    expect(requests.map((request) => request.bodyId)).toEqual([
      "body_fillet",
      "body_fillet2",
    ]);
  });

  it.each([
    ["body_dup_a", { kind: "feature", id: "feat_dup" }],
    ["body_dup_b", { kind: "body", id: "body_dup_b" }],
  ] as const)(
    "renders a cut of a multi-output producer's %s (its own target input)",
    (bodyId, target) => {
      const source = duplicatedBoxDocument();
      const plan = topologyCutCreateCommands(source, {
        kind: "fillet",
        snapshot: snapshotOf(bodyId),
        ordinals: [0],
        sizeMm: 1,
      });
      if (!plan.ok) throw new Error(plan.message);
      const feature = plan.commands.find(
        (command) => command.type === "feature.create",
      );
      if (feature?.type !== "feature.create") throw new Error("no feature");
      expect(feature.inputs[0]).toEqual(target);
      const document = commit(source, {
        kind: "fillet",
        snapshot: snapshotOf(bodyId),
        ordinals: [0],
        sizeMm: 1,
      });
      const requests = documentTopologyCutSceneRequests(document);
      expect(requests.map((request) => request.bodyId)).toEqual([
        "body_fillet",
      ]);
      expect(sceneBodiesOf(document)).toContainEqual({
        bodyId: "body_fillet",
        kind: "topologyCut",
      });
    },
  );
});
