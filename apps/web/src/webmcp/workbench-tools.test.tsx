/**
 * The workbench WebMCP tools against the REAL domain surfaces: a fresh
 * `CadStore` over the app's own workbench session (the same session factory
 * `useWorkbenchStore` boots), the real `parseCommand` / `serializeCommand`
 * round trip, and the engine-level read paths the Measurement block
 * renders. Plus one integration mount: the REAL workbench engine (worker
 * session stubbed, the established workbench-engine test pattern) with the
 * hook registered for its lifetime. The capture tool's angle math and
 * orchestration live in ./capture-views.test.ts (node env, snapshot
 * functions mocked); the Phase 2.2 read tools' own suite is
 * ./document-diagnostics.test.ts.
 */

import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBodyId,
  createParameterId,
  createReferenceId,
  createRenderProjection,
  getParameter,
  length,
  parseReferenceId,
  printExpression,
  projectTessellation,
  serializeCommand,
} from "@slopcad/cad-core";
import type { TopologySnapshot } from "@slopcad/cad-core";
import { createCadStore, setParameterCommand } from "@slopcad/cad-react";
import type { CadStore } from "@slopcad/cad-react";
import type { CadCommandDescriptor } from "@slopcad/ui/components/cad/cad-command-menu";
import type {
  DocumentTopologyInventory,
  FixtureRenderState,
} from "../render-fixture/fixture-session";
import type { PlateRenderState } from "../render-fixture/plate-render-scene";

import { topologyReferenceOf } from "../cad-workbench/topology-cut";
import { FEATURE_KIND_VOCABULARY } from "./feature-vocabulary";
import {
  createCadWorkbenchDemoSession,
  WORKBENCH_DEMO_SESSION_KEY,
} from "../cad-workbench/session";
import {
  useWorkbenchEngine,
  WorkbenchStoreProvider,
} from "../cad-workbench/workbench-engine";
import {
  executeWebMcpTool,
  unregisterWebMcpTool,
  webMcpToolNames,
} from "./registry";
import { bindWebMcpTools } from "./use-webmcp-tools";
import {
  createWorkbenchWebMcpTools,
  useWorkbenchWebMcpTools,
  type WorkbenchCaptureSurface,
} from "./workbench-tools";

/** The stub session the engine boots against (headless, all no-ops). */
vi.mock("../render-fixture/fixture-session", () => ({
  bootRenderFixtureSession: (): {
    dispatch(): void;
    dispatchExtrude(): void;
    dispatchRevolve(): void;
    dispatchSweep(): void;
    dispatchLoft(): void;
    dispatchHole(): void;
    dispose(): void;
  } => ({
    dispatch: () => {},
    dispatchExtrude: () => {},
    dispatchRevolve: () => {},
    dispatchSweep: () => {},
    dispatchLoft: () => {},
    dispatchHole: () => {},
    dispose: () => {},
  }),
  faceAnchorSurface: (): string => "[]",
}));

/** The structured outcome of driving one tool through the registry. */
type ToolRun =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

// The engine mounts boot the demo document (the session module's opt-in).
window.localStorage.setItem(WORKBENCH_DEMO_SESSION_KEY, "1");

/** The twelve workbench tool names, in registration order. */
const TOOL_NAMES = [
  "cad_get_document_summary",
  "cad_list_commands",
  "cad_run_command",
  "cad_set_parameter",
  "cad_undo",
  "cad_redo",
  "cad_apply_commands",
  "cad_measure",
  "cad_skill",
  "cad_capture_views",
  "cad_get_document",
  "cad_get_diagnostics",
] as const;

/** The mutable live state one test surface reads through accessors. */
interface TestSurfaceState {
  applied: FixtureRenderState | null;
  commands: readonly CadCommandDescriptor[];
  measureText: string | null;
  /** What the on-demand topology query answers. */
  topology: DocumentTopologyInventory | null;
  /** How many times a tool issued the on-demand topology query. */
  topologyQueries: number;
}

/** A fresh store over the app's demo workbench session. */
function freshStore(): CadStore {
  return createCadStore({ session: createCadWorkbenchDemoSession() });
}

/**
 * The capture surface stub the non-capture tests mount: the viewport is
 * honestly absent (null canvas), so nothing here touches the DOM. The
 * capture tool's own tests drive a spied surface in ./capture-views.test.ts.
 */
function stubCaptureSurface(): WorkbenchCaptureSurface {
  return {
    canvas: () => null,
    convention: () => "third-angle",
    renderedFrames: () => 0,
    rootId: "webmcp-test-root",
    setUserCamera: () => {},
    userCamera: () => null,
  };
}

/** Binds the twelve workbench tools over one store + mutable surface state. */
function bindTools(store: CadStore, state: TestSurfaceState): () => void {
  return bindWebMcpTools(
    createWorkbenchWebMcpTools({
      appliedState: () => state.applied,
      capture: stubCaptureSurface(),
      commands: () => state.commands,
      documentTopology: () => {
        state.topologyQueries += 1;
        return Promise.resolve(state.topology);
      },
      measureText: () => state.measureText,
      mode: () => "model",
      regenerationIssue: () => null,
      sketchSolve: () => null,
      store,
      timeline: () => null,
    }),
  );
}

/**
 * Drives one tool with raw JSON input through the registry boundary. The
 * tool's DOMAIN refusals (`{ ok: false, code, message }`) are tool RESULTS
 * — the registry stringifies whatever a handler returns (the spec's
 * DOMString), so they surface here as refusals; only boundary failures
 * (unknown tool, schema-invalid input, handler throw) fail at the registry.
 */
async function runTool(name: string, input: unknown): Promise<ToolRun> {
  const outcome = await executeWebMcpTool(name, input, {
    signal: new AbortController().signal,
  });
  if (!outcome.ok) {
    return { code: outcome.code, message: outcome.message, ok: false };
  }
  const payload: unknown = JSON.parse(outcome.result);
  if (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { readonly ok?: unknown }).ok === false
  ) {
    const refusal = payload as {
      readonly code: string;
      readonly message: string;
    };
    return { code: refusal.code, message: refusal.message, ok: false };
  }
  return { ok: true, payload };
}

/** A runnable spy command descriptor. */
function spyCommand(
  id: string,
  disabled = false,
): {
  readonly descriptor: CadCommandDescriptor;
  readonly ran: () => number;
} {
  let calls = 0;
  return {
    descriptor: {
      disabled,
      group: "Probe",
      id,
      label: `Run ${id}`,
      run: () => {
        calls += 1;
      },
    },
    ran: () => calls,
  };
}

/** The probe triangle the measure tests settle as their applied scene. */
const PROBE_TESSELLATION = {
  indices: [0, 1, 2],
  positions: [0, 0, 0, 30, 0, 0, 0, 20, 0],
};

/** Builds a real render state (projected body, kernel-shaped measurement). */
function renderStateOf(bodyId: string): PlateRenderState {
  const object = projectTessellation(createBodyId(bodyId), PROBE_TESSELLATION);
  if (!object.ok) throw new Error(object.error.message);
  const projection = createRenderProjection([object.value], {
    fovDeg: 45,
    kind: "perspective",
    position: [80, -80, 60],
    target: [0, 0, 0],
    up: [0, 0, 1],
  });
  if (!projection.ok) throw new Error(projection.error.message);
  return {
    measurement: {
      area: 300,
      bounds: { max: [30, 20, 0], min: [0, 0, 0] },
      triangles: 1,
      tessellation: PROBE_TESSELLATION,
      volume: 100,
    },
    projection: projection.value,
  };
}

/**
 * A hand-built persistent snapshot for one body (the fixture-view
 * precedent of the bridge's fillet tests): two edges and one face, each
 * with a kernel identity and its geometric descriptor.
 */
function snapshotOf(bodyId: string): TopologySnapshot {
  return {
    bodyId: createBodyId(bodyId),
    entities: [
      {
        geometry: { centroidAbsoluteMm: [5, 0, 0], lengthMm: 10 },
        identity: { data: { hash: 11 }, kernelId: "occt", schema: "probe" },
        kind: "edge",
        ordinal: 0,
      },
      {
        geometry: { centroidAbsoluteMm: [10, 5, 0], lengthMm: 10 },
        identity: { data: { hash: 12 }, kernelId: "occt", schema: "probe" },
        kind: "edge",
        ordinal: 1,
      },
      {
        geometry: { areaMm2: 100, centroidAbsoluteMm: [5, 5, 10] },
        identity: { data: { hash: 21 }, kernelId: "occt", schema: "probe" },
        kind: "face",
        ordinal: 0,
      },
    ],
    identitySchemas: ["probe"],
    kernelId: "occt",
    persistentTopology: true,
    regeneration: 3,
  };
}

/**
 * What the on-demand topology query answers for a visible document scene
 * that computed these snapshots' bodies (rendered or compute-only consumed
 * targets alike — the query snapshots every computed solid).
 */
function inventoryOf(
  ...snapshots: readonly TopologySnapshot[]
): DocumentTopologyInventory {
  return {
    revision: 3,
    snapshots: new Map(
      snapshots.map((snapshot) => [String(snapshot.bodyId), snapshot]),
    ),
  };
}

/** A serialized length `parameter.create` (canonical mm). */
function lengthParameter(id: string, value: number) {
  return {
    formatVersion: 1,
    id,
    name: id.slice("param_".length),
    type: "parameter.create",
    value: { dimension: "length", unit: "mm", value },
  };
}

/** The serialized batch authoring a 10 mm box `feat_box` under `bodyId`. */
function boxBatch(bodyId: string) {
  return [
    lengthParameter("param_w", 10),
    lengthParameter("param_d", 10),
    lengthParameter("param_h", 10),
    { formatVersion: 1, id: bodyId, name: "box", type: "body.create" },
    {
      formatVersion: 1,
      id: "feat_box",
      inputs: [
        { id: "param_w", kind: "parameter" },
        { id: "param_d", kind: "parameter" },
        { id: "param_h", kind: "parameter" },
      ],
      kind: "box",
      outputs: [bodyId],
      type: "feature.create",
    },
  ];
}

/** The serialized batch authoring a 10 mm box under `body_box`. */
const BOX_BATCH = boxBatch("body_box");

/** One summary inventory entry, as the tool serializes it. */
interface InventoryEntry {
  readonly geometry: Record<string, unknown>;
  readonly ordinal: number;
  readonly reference: Record<string, unknown> | null;
  readonly referenceId: string | null;
  readonly referenced: boolean;
}

/** One summary body record with its topology inventory. */
interface SummaryBody {
  readonly id: string;
  readonly topology: {
    readonly edges: readonly InventoryEntry[];
    readonly faces: readonly InventoryEntry[];
    readonly persistent: boolean;
    readonly regeneration: number;
  } | null;
}

/** The summary's body records (the tool must succeed). */
async function summaryBodies(): Promise<readonly SummaryBody[]> {
  const run = await runTool("cad_get_document_summary", {});
  if (!run.ok) throw new Error(run.message);
  return (run.payload as { readonly bodies: readonly SummaryBody[] }).bodies;
}

/** The empty surface state every test starts from. */
function surfaceState(
  commands: readonly CadCommandDescriptor[],
): TestSurfaceState {
  return {
    applied: null,
    commands,
    measureText: null,
    topology: null,
    topologyQueries: 0,
  };
}

afterEach(() => {
  cleanup();
  for (const name of webMcpToolNames()) unregisterWebMcpTool(name);
});

describe("cad_get_document_summary", () => {
  it("reports the store's live document counts, kinds, and records", async () => {
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([]));
    const run = await runTool("cad_get_document_summary", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.payload).toMatchObject({
      counts: { bodies: 1, features: 2, parameters: 7 },
      documentId: "doc_cad_workbench",
    });
    const payload = run.payload as {
      bodies: { id: string; kind: string; name: string }[];
      featureKinds: string[];
      parameters: { name: string; value: { dimension: string } }[];
    };
    expect(payload.bodies).toEqual([
      {
        id: "body_plate",
        kind: "solid",
        name: "plate",
        topology: null,
        visible: true,
      },
    ]);
    expect(payload.featureKinds).toContain("translate");
    expect(payload.featureKinds).toContain("rotate");
    expect(payload.parameters.map((p) => p.name)).toContain("holeDiameter");
    const hole = payload.parameters.find((p) => p.name === "holeDiameter");
    expect(hole?.value.dimension).toBe("length");
    unbind();
  });

  it("reports featureKinds as the kinds IN THE TIMELINE, not the vocabulary", async () => {
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([]));
    await runTool("cad_apply_commands", { commands: BOX_BATCH });
    const run = await runTool("cad_get_document_summary", {});
    if (!run.ok) throw new Error(run.message);
    const payload = run.payload as {
      featureKinds: string[];
      featureVocabulary?: unknown;
    };
    expect(payload.featureKinds).toEqual([
      ...new Set(store.getDocument().features.map((f) => String(f.kind))),
    ]);
    expect(payload.featureKinds).toContain("box");
    // A vocabulary kind absent from the timeline is not reported.
    expect(payload.featureKinds).not.toContain("fillet");
    expect(payload.featureVocabulary).toBeUndefined();
    unbind();
  });

  it("queries the topology inventory ONLY when the summary is called", async () => {
    const store = freshStore();
    const state = surfaceState([]);
    const unbind = bindTools(store, state);
    await runTool("cad_apply_commands", { commands: BOX_BATCH });
    state.applied = renderStateOf("body_plate");
    state.topology = inventoryOf(snapshotOf("body_box"));
    // No other tool — nor binding the tools — pays for a topology query.
    await runTool("cad_list_commands", {});
    await runTool("cad_measure", {});
    await runTool("cad_skill", {});
    expect(state.topologyQueries).toBe(0);
    await runTool("cad_get_document_summary", {});
    expect(state.topologyQueries).toBe(1);
    await runTool("cad_get_document_summary", {});
    expect(state.topologyQueries).toBe(2);
    unbind();
  });

  it("reports every body's topology null when the query answers nothing", async () => {
    const store = freshStore();
    const state = surfaceState([]);
    const unbind = bindTools(store, state);
    await runTool("cad_apply_commands", { commands: BOX_BATCH });
    const bodies = await summaryBodies();
    expect(bodies.map((body) => body.topology)).toEqual([null, null]);
    unbind();
  });

  it("exposes the settled scene's persistent edge/face inventory per body", async () => {
    const store = freshStore();
    const state = surfaceState([]);
    const unbind = bindTools(store, state);
    expect(
      (await runTool("cad_apply_commands", { commands: BOX_BATCH })).ok,
    ).toBe(true);
    state.topology = inventoryOf(snapshotOf("body_box"));
    const box = (await summaryBodies()).find((body) => body.id === "body_box");
    expect(box?.topology).toMatchObject({ persistent: true, regeneration: 3 });
    expect(box?.topology?.edges.map((edge) => edge.referenceId)).toEqual([
      "ref_body_box_edge_0",
      "ref_body_box_edge_1",
    ]);
    const face = box?.topology?.faces[0];
    expect(face).toMatchObject({
      geometry: { areaMm2: 100 },
      ordinal: 0,
      referenceId: "ref_body_box_face_0",
      referenced: false,
    });
    // The ready-to-store payload is the canonical persistent reference:
    // bound to the body, its producing feature path, and the identity.
    expect(face?.reference).toMatchObject({
      bodyId: "body_box",
      id: "ref_body_box_face_0",
      identity: { data: { hash: 21 }, kernelId: "occt", schema: "probe" },
      kind: "face",
      provenance: { bodyId: "body_box", featurePath: ["feat_box"] },
    });
    // A body without a settled snapshot reports no inventory.
    const plate = (await summaryBodies()).find(
      (body) => body.id === "body_plate",
    );
    expect(plate?.topology).toBeNull();
    unbind();
  });

  it("bounds the reference id of a body whose id would overflow it", async () => {
    const longBodyId = `body_${"a".repeat(55)}`;
    // The canonical `ref_<body>_<kind>_<ordinal>` id overflows the payload.
    expect(parseReferenceId(`ref_${longBodyId}_edge_0`).ok).toBe(false);
    const store = freshStore();
    const state = surfaceState([]);
    const unbind = bindTools(store, state);
    expect(
      (await runTool("cad_apply_commands", { commands: boxBatch(longBodyId) }))
        .ok,
    ).toBe(true);
    state.topology = inventoryOf(snapshotOf(longBodyId));
    const bodies = await summaryBodies();
    expect(
      bodies.find((body) => body.id === "body_plate")?.topology,
    ).toBeNull();
    const box = bodies.find((body) => body.id === longBodyId);
    const ids = box?.topology?.edges.map((edge) => edge.referenceId) ?? [];
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id?.startsWith(`ref_${longBodyId.slice(0, 40)}-`)).toBe(true);
      expect(parseReferenceId(id).ok).toBe(true);
    }
    const edge = box?.topology?.edges[0];
    if (edge?.reference == null || edge.referenceId === null) {
      throw new Error("no minted edge reference");
    }
    expect(edge.reference).toMatchObject({
      bodyId: longBodyId,
      id: edge.referenceId,
    });
    expect(
      (
        await runTool("cad_apply_commands", {
          commands: [
            {
              formatVersion: 1,
              id: edge.referenceId,
              name: "edge0",
              reference: edge.reference,
              type: "reference.create",
            },
          ],
        })
      ).ok,
    ).toBe(true);
    const again = (await summaryBodies()).find(
      (body) => body.id === longBodyId,
    );
    expect(again?.topology?.edges[0]?.referenceId).toBe(edge.referenceId);
    expect(again?.topology?.edges[0]?.referenced).toBe(true);
    unbind();
  });

  it("offers no payload when the kernel keeps no persistent topology", async () => {
    const store = freshStore();
    const state = surfaceState([]);
    const unbind = bindTools(store, state);
    await runTool("cad_apply_commands", { commands: BOX_BATCH });
    state.topology = inventoryOf({
      ...snapshotOf("body_box"),
      persistentTopology: false,
    });
    const box = (await summaryBodies()).find((body) => body.id === "body_box");
    expect(box?.topology?.persistent).toBe(false);
    expect(box?.topology?.edges.every((edge) => edge.reference === null)).toBe(
      true,
    );
    unbind();
  });

  it("round-trips an inventory reference into a fillet the reader accepts", async () => {
    const store = freshStore();
    const state = surfaceState([]);
    const unbind = bindTools(store, state);
    await runTool("cad_apply_commands", { commands: BOX_BATCH });
    state.topology = inventoryOf(snapshotOf("body_box"));
    const edge = (await summaryBodies()).find((body) => body.id === "body_box")
      ?.topology?.edges[1];
    if (edge?.reference == null || edge.referenceId === null) {
      throw new Error("no minted edge reference");
    }
    const run = await runTool("cad_apply_commands", {
      commands: [
        {
          formatVersion: 1,
          id: edge.referenceId,
          name: "edge1",
          reference: edge.reference,
          type: "reference.create",
        },
        lengthParameter("param_radius", 1),
        {
          formatVersion: 1,
          id: "body_round",
          name: "round",
          type: "body.create",
        },
        {
          formatVersion: 1,
          id: "feat_round",
          inputs: [
            { id: "feat_box", kind: "feature" },
            { id: edge.referenceId, kind: "reference" },
            { id: "param_radius", kind: "parameter" },
          ],
          kind: "fillet",
          outputs: ["body_round"],
          type: "feature.create",
        },
      ],
    });
    expect(run.ok).toBe(true);
    // The document-side reader the fillet scene uses accepts the record.
    expect(
      topologyReferenceOf(
        store.getDocument(),
        createReferenceId(edge.referenceId),
        "edge",
        "body_box",
      ),
    ).not.toBeNull();
    const again = (await summaryBodies()).find(
      (body) => body.id === "body_box",
    );
    expect(again?.topology?.edges[1]?.referenced).toBe(true);
    expect(again?.topology?.edges[0]?.referenced).toBe(false);
    unbind();
  });

  it("keeps a consumed target's inventory and re-selects through feature.update", async () => {
    const store = freshStore();
    const state = surfaceState([]);
    const unbind = bindTools(store, state);
    await runTool("cad_apply_commands", { commands: BOX_BATCH });
    state.topology = inventoryOf(snapshotOf("body_box"));
    const first = (await summaryBodies()).find((body) => body.id === "body_box")
      ?.topology?.edges[1];
    if (first?.reference == null || first.referenceId === null) {
      throw new Error("no minted edge reference");
    }
    const filletOf = (type: string, referenceId: string) => ({
      formatVersion: 1,
      id: "feat_round",
      inputs: [
        { id: "feat_box", kind: "feature" },
        { id: referenceId, kind: "reference" },
        { id: "param_radius", kind: "parameter" },
      ],
      kind: "fillet",
      outputs: ["body_round"],
      type,
    });
    expect(
      (
        await runTool("cad_apply_commands", {
          commands: [
            {
              formatVersion: 1,
              id: first.referenceId,
              name: "edge1",
              reference: first.reference,
              type: "reference.create",
            },
            lengthParameter("param_radius", 1),
            {
              formatVersion: 1,
              id: "body_round",
              name: "round",
              type: "body.create",
            },
            filletOf("feature.create", first.referenceId),
          ],
        })
      ).ok,
    ).toBe(true);
    // The fillet renders in the box's place; the box's regenerated
    // snapshot (a new identity for edge 1) rides the consumed channel.
    const regenerated: TopologySnapshot = {
      ...snapshotOf("body_box"),
      entities: snapshotOf("body_box").entities.map((entity) =>
        entity.kind === "edge" && entity.ordinal === 1
          ? {
              ...entity,
              identity: {
                data: { hash: 99 },
                kernelId: "occt",
                schema: "probe",
              },
            }
          : entity,
      ),
      regeneration: 4,
    };
    state.topology = inventoryOf(snapshotOf("body_round"), regenerated);
    const bodies = await summaryBodies();
    const box = bodies.find((body) => body.id === "body_box");
    expect(box?.topology).toMatchObject({ persistent: true, regeneration: 4 });
    expect(
      bodies.find((body) => body.id === "body_round")?.topology?.edges,
    ).toHaveLength(2);
    // The stored record keeps its old identity; the inventory offers the
    // current one — store it under a fresh id and update the op.
    const current = box?.topology?.edges[1];
    expect(current?.referenced).toBe(true);
    expect(current?.reference).toMatchObject({
      identity: { data: { hash: 99 } },
    });
    const freshId = "ref_body_box_edge_1_b";
    const reselect = await runTool("cad_apply_commands", {
      commands: [
        {
          formatVersion: 1,
          id: freshId,
          name: "edge1b",
          reference: current?.reference,
          type: "reference.create",
        },
        filletOf("feature.update", freshId),
      ],
    });
    expect(reselect.ok).toBe(true);
    expect(
      topologyReferenceOf(
        store.getDocument(),
        createReferenceId(freshId),
        "edge",
        "body_box",
      )?.identity.data,
    ).toEqual({ hash: 99 });
    expect(
      store
        .getDocument()
        .features.find((feature) => String(feature.id) === "feat_round")
        ?.inputs.map((input) => String(input.id)),
    ).toEqual(["feat_box", freshId, "param_radius"]);
    unbind();
  });
});

describe("cad_list_commands", () => {
  it("lists the live vocabulary with availability", async () => {
    const runnable = spyCommand("probe.runnable");
    const disabled = spyCommand("probe.disabled", true);
    const store = freshStore();
    const unbind = bindTools(
      store,
      surfaceState([runnable.descriptor, disabled.descriptor]),
    );
    const run = await runTool("cad_list_commands", {});
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.payload).toMatchObject({
        commands: [
          { available: true, group: "Probe", id: "probe.runnable" },
          { available: false, group: "Probe", id: "probe.disabled" },
        ],
      });
    }
    unbind();
  });

  it("serves the authorable feature kinds with their canonical layouts", async () => {
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([]));
    const run = await runTool("cad_list_commands", {});
    if (!run.ok) throw new Error(run.message);
    const payload = run.payload as {
      featureKinds?: unknown;
      featureVocabulary: typeof FEATURE_KIND_VOCABULARY;
    };
    // The authoring list is `featureVocabulary`; `featureKinds` stays the
    // summary's "kinds in the timeline" and is not served here.
    expect(payload.featureKinds).toBeUndefined();
    const { featureVocabulary } = payload;
    expect(featureVocabulary.map((entry) => entry.kind)).toEqual([
      "box",
      "sphere",
      "cylinder",
      "cone",
      "fillet",
      "chamfer",
      "shell",
      "moveFace",
      "deleteFace",
      "replaceFace",
      "patternFace",
    ]);
    const layout = (kind: string) =>
      featureVocabulary
        .find((entry) => entry.kind === kind)
        ?.inputs.map((slot) => `${slot.kind}:${slot.count}`);
    expect(layout("cone")).toEqual([
      "parameter:1",
      "parameter:1",
      "parameter:1",
    ]);
    expect(layout("fillet")).toEqual([
      "feature:1",
      "reference:1+",
      "parameter:1",
    ]);
    expect(layout("moveFace")).toEqual([
      "feature:1",
      "reference:1",
      "parameter:1",
      "parameter:1",
    ]);
    expect(layout("replaceFace")).toEqual([
      "feature:1",
      "reference:1",
      "datum:1",
    ]);
    expect(layout("patternFace")).toHaveLength(8);
    // patternFace's bounding face is a persistent FACE reference, so it
    // needs a kernel with persistent topology — not "any kernel".
    expect(
      featureVocabulary.find((entry) => entry.kind === "patternFace")
        ?.capability,
    ).toBe("persistentTopology");
    expect(
      featureVocabulary
        .filter((entry) =>
          entry.inputs.some((slot) => slot.kind === "reference"),
        )
        .every((entry) => entry.capability !== null),
    ).toBe(true);
    expect(
      featureVocabulary
        .find((entry) => entry.kind === "shell")
        ?.inputs.find((slot) => slot.kind === "reference")?.domain,
    ).toContain("FACE");
    // The served data IS the module's vocabulary (one source of truth).
    expect(featureVocabulary).toEqual(FEATURE_KIND_VOCABULARY);
    unbind();
  });

  it("reads the LIVE list, not the mount-time one", async () => {
    const first = spyCommand("probe.first");
    const second = spyCommand("probe.second");
    const state = surfaceState([first.descriptor]);
    const store = freshStore();
    const unbind = bindTools(store, state);
    state.commands = [second.descriptor];
    const run = await runTool("cad_list_commands", {});
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.payload).toMatchObject({
        commands: [{ id: "probe.second" }],
      });
    }
    unbind();
  });
});

describe("cad_run_command", () => {
  it("fires the descriptor's own run() — the palette row's dispatch", async () => {
    const command = spyCommand("probe.command");
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([command.descriptor]));
    const run = await runTool("cad_run_command", {
      commandId: "probe.command",
    });
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.payload).toMatchObject({ ran: "probe.command" });
    expect(command.ran()).toBe(1);
    unbind();
  });

  it("accepts an empty args object (the nullary vocabulary)", async () => {
    const command = spyCommand("probe.nullary");
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([command.descriptor]));
    const run = await runTool("cad_run_command", {
      args: {},
      commandId: "probe.nullary",
    });
    expect(run.ok).toBe(true);
    expect(command.ran()).toBe(1);
    unbind();
  });

  it("refuses non-empty args honestly: no command takes arguments", async () => {
    const command = spyCommand("probe.args");
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([command.descriptor]));
    const run = await runTool("cad_run_command", {
      args: { depth: 5 },
      commandId: "probe.args",
    });
    expect(run).toMatchObject({
      code: "workbench/command-args-unsupported",
      ok: false,
    });
    expect(command.ran()).toBe(0);
    unbind();
  });

  it("refuses a disabled command the same way the palette row does", async () => {
    const command = spyCommand("probe.blocked", true);
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([command.descriptor]));
    const run = await runTool("cad_run_command", {
      commandId: "probe.blocked",
    });
    expect(run).toMatchObject({
      code: "workbench/command-unavailable",
      ok: false,
    });
    expect(command.ran()).toBe(0);
    unbind();
  });

  it("refuses an id outside the mount-time enum at the schema", async () => {
    const command = spyCommand("probe.present");
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([command.descriptor]));
    const run = await runTool("cad_run_command", {
      commandId: "probe.never_was",
    });
    expect(run).toMatchObject({ code: "webmcp/invalid-input", ok: false });
    unbind();
  });

  it("refuses a mount-time id the live vocabulary has dropped", async () => {
    const command = spyCommand("probe.gone");
    const state = surfaceState([command.descriptor]);
    const store = freshStore();
    const unbind = bindTools(store, state);
    state.commands = [];
    const run = await runTool("cad_run_command", { commandId: "probe.gone" });
    expect(run).toMatchObject({
      code: "workbench/command-unknown",
      ok: false,
    });
    unbind();
  });
});

describe("cad_set_parameter", () => {
  const HOLE_ID = "param_hole_diameter";

  it("commits a number in the parameter's own dimension", async () => {
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([]));
    const run = await runTool("cad_set_parameter", {
      id: HOLE_ID,
      value: 12,
    });
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.payload).toMatchObject({
        name: "holeDiameter",
        parameterId: HOLE_ID,
        value: { dimension: "length", value: 12 },
      });
    }
    const stored = getParameter(
      store.getParameters(),
      createParameterId(HOLE_ID),
    );
    expect(stored?.value.value).toBe(12);
    unbind();
  });

  it("commits a string AS the defining expression; the document re-derives the value", async () => {
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([]));
    // The unit literal keeps the parameter a length (the expression defines
    // the dimension — a bare `6 * 2` would honestly re-dimension it).
    const run = await runTool("cad_set_parameter", {
      id: HOLE_ID,
      value: "6mm * 2",
    });
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.payload).toMatchObject({
        name: "holeDiameter",
        value: { dimension: "length", unit: "mm", value: 12 },
        expression: "6mm * 2",
      });
    }
    const stored = getParameter(
      store.getParameters(),
      createParameterId(HOLE_ID),
    );
    expect(stored?.value.value).toBe(12);
    const storedExpression = stored?.expression ?? null;
    expect(
      storedExpression === null ? null : printExpression(storedExpression),
    ).toBe("6mm * 2");
    unbind();
  });

  it("re-drives dependents through the stored expression and refuses a closing cycle", async () => {
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([]));
    // The boot pair: volumeHint = holeDiameter * 2, boreRadius =
    // holeDiameter / 2. Repoint volumeHint at boreRadius (still a DAG)…
    const repointed = await runTool("cad_set_parameter", {
      id: "param_volume_hint",
      value: "boreRadius * 4",
    });
    expect(repointed.ok).toBe(true);
    expect(
      getParameter(
        store.getParameters(),
        createParameterId("param_volume_hint"),
      )?.value.value,
    ).toBe(16);
    // …then closing the loop (boreRadius through volumeHint) is refused
    // with the domain's own cycle error, naming the chain.
    const cycled = await runTool("cad_set_parameter", {
      id: "param_bore_radius",
      value: "volumeHint / 4",
    });
    expect(cycled).toMatchObject({ code: "parameter/cycle", ok: false });
    if (!cycled.ok) expect(cycled.message).toContain("boreRadius → volumeHint");
    // The refusal left both expressions exactly as the DAG had them.
    expect(
      getParameter(
        store.getParameters(),
        createParameterId("param_bore_radius"),
      )?.value.value,
    ).toBe(4);
    unbind();
  });

  it("refuses an unknown parameter id structurally", async () => {
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([]));
    const run = await runTool("cad_set_parameter", {
      id: "param_nope",
      value: 1,
    });
    expect(run).toMatchObject({
      code: "workbench/parameter-unknown",
      ok: false,
    });
    unbind();
  });

  it("refuses a malformed expression without committing", async () => {
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([]));
    const run = await runTool("cad_set_parameter", {
      id: HOLE_ID,
      value: "6 * * 2",
    });
    expect(run.ok).toBe(false);
    const stored = getParameter(
      store.getParameters(),
      createParameterId(HOLE_ID),
    );
    // The workbench boots the hole diameter at the scene default (8 mm).
    expect(stored?.value.value).toBe(8);
    unbind();
  });
});

describe("cad_undo and cad_redo", () => {
  it("refuse at the history base and head, and move one commit otherwise", async () => {
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([]));
    const undoRefused = await runTool("cad_undo", {});
    expect(undoRefused).toMatchObject({ ok: false });

    expect(
      store.applyCommand(
        setParameterCommand(
          createParameterId("param_hole_diameter"),
          length(21),
        ),
      ).ok,
    ).toBe(true);

    const undone = await runTool("cad_undo", {});
    expect(undone.ok).toBe(true);
    if (undone.ok) expect(undone.payload).toMatchObject({ canRedo: true });
    expect(
      getParameter(
        store.getParameters(),
        createParameterId("param_hole_diameter"),
      )?.value.value,
    ).toBe(8);

    const redone = await runTool("cad_redo", {});
    expect(redone.ok).toBe(true);
    expect(
      getParameter(
        store.getParameters(),
        createParameterId("param_hole_diameter"),
      )?.value.value,
    ).toBe(21);

    const redoRefused = await runTool("cad_redo", {});
    expect(redoRefused).toMatchObject({ ok: false });
    unbind();
  });
});

describe("cad_apply_commands", () => {
  it("strictly parses serialized commands, then applies one atomic transaction", async () => {
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([]));
    const serialized = serializeCommand(
      setParameterCommand(createParameterId("param_hole_diameter"), length(33)),
    );
    const run = await runTool("cad_apply_commands", {
      commands: [serialized],
    });
    expect(run.ok).toBe(true);
    if (run.ok) expect(run.payload).toMatchObject({ applied: 1 });
    expect(
      getParameter(
        store.getParameters(),
        createParameterId("param_hole_diameter"),
      )?.value.value,
    ).toBe(33);
    unbind();
  });

  it("applies NOTHING when one entry fails the strict parse", async () => {
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([]));
    const good = serializeCommand(
      setParameterCommand(createParameterId("param_hole_diameter"), length(44)),
    );
    const run = await runTool("cad_apply_commands", {
      commands: [good, { type: "parameter.set", nope: true }],
    });
    expect(run.ok).toBe(false);
    if (!run.ok) expect(run.message).toContain("commands[1]");
    expect(
      getParameter(
        store.getParameters(),
        createParameterId("param_hole_diameter"),
      )?.value.value,
    ).toBe(8);
    unbind();
  });

  it("surfaces the domain's own transaction refusal", async () => {
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([]));
    const unknownTarget = serializeCommand(
      setParameterCommand(createParameterId("param_nope"), length(1)),
    );
    const run = await runTool("cad_apply_commands", {
      commands: [unknownTarget],
    });
    expect(run.ok).toBe(false);
    unbind();
  });
});

describe("cad_skill", () => {
  it("serves the authoring guide as a markdown document", async () => {
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([]));
    const run = await runTool("cad_skill", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const payload = run.payload as {
      format: string;
      skill: string;
    };
    expect(payload.format).toBe("markdown");
    // The doc teaches the write path, the strict-parse contract, the
    // silent skcon_ failure, and points at the reference batch.
    expect(payload.skill).toContain("cad_apply_commands");
    expect(payload.skill).toContain("skcon_");
    expect(payload.skill).toContain("formatVersion");
    expect(payload.skill).toContain("parametric-cup.commands.json");
    // It teaches every new feature kind and the selection addressing.
    for (const entry of FEATURE_KIND_VOCABULARY) {
      expect(payload.skill).toContain(`| ${entry.kind} |`);
    }
    expect(payload.skill).toContain("## Selection addressing");
    expect(payload.skill).toContain("topology.edges");
    expect(payload.skill).toContain('"kind": "reference"');
    expect(payload.skill).toContain("reference.create");
    // The authoring list's name, distinct from the timeline kinds.
    expect(payload.skill).toContain("featureVocabulary");
    expect(payload.skill).toContain("`featureKinds` (the feature kinds IN THE");
    // The real guarantee, with the failure modes and the named states.
    expect(payload.skill).toContain("### The guarantee");
    expect(payload.skill).toContain("SURVIVES\nrebuilds and dimension edits");
    expect(payload.skill).toContain("DELETED, SPLIT into an ambiguous set");
    expect(payload.skill).toContain("unnamed-op entity");
    expect(payload.skill).toContain("`valid`, `repaired`, or `missing`");
    expect(payload.skill).toContain("reference-unresolved");
    unbind();
  });

  it("states the same guarantee in the summary tool's own description", () => {
    const summary = createWorkbenchWebMcpTools({
      appliedState: () => null,
      commands: () => [],
      documentTopology: () => Promise.resolve(null),
      measureText: () => null,
      store: freshStore(),
    }).find((entry) => entry.name === "cad_get_document_summary");
    const description = summary?.description ?? "";
    expect(description).toContain("survives rebuilds and dimension edits");
    expect(description).toContain("deleted, split ambiguously");
    expect(description).toContain(
      "repaired or refused, and the state is named",
    );
    expect(description).toContain("featureVocabulary");
  });
});

describe("cad_measure", () => {
  it("refuses before the scene has settled", async () => {
    const store = freshStore();
    const unbind = bindTools(store, surfaceState([]));
    const run = await runTool("cad_measure", {});
    expect(run).toMatchObject({
      code: "workbench/measure-no-settled-scene",
      ok: false,
    });
    unbind();
  });

  it("reads the settled scene's kernel measurements", async () => {
    const store = freshStore();
    const state = surfaceState([]);
    state.applied = renderStateOf("body_plate");
    state.measureText = "12.500";
    const unbind = bindTools(store, state);
    const run = await runTool("cad_measure", {});
    expect(run.ok).toBe(true);
    if (run.ok) {
      expect(run.payload).toEqual({
        areaMm2: 300,
        bodyId: "body_plate",
        boundsMm: { max: [30, 20, 0], min: [0, 0, 0] },
        lastMeasureDistanceMm: "12.500",
        ok: true,
        triangles: 1,
        volumeMm3: 100,
      });
    }
    unbind();
  });

  it("accepts the measured body id or a feature producing it", async () => {
    const store = freshStore();
    const state = surfaceState([]);
    state.applied = renderStateOf("body_plate");
    const unbind = bindTools(store, state);
    const byBody = await runTool("cad_measure", {
      featureOrBodyId: "body_plate",
    });
    expect(byBody.ok).toBe(true);
    const byFeature = await runTool("cad_measure", {
      featureOrBodyId: "feat_translate_plate",
    });
    expect(byFeature.ok).toBe(true);
    unbind();
  });

  it("refuses a subject the settled scene did not measure", async () => {
    const store = freshStore();
    const state = surfaceState([]);
    state.applied = renderStateOf("body_plate");
    const unbind = bindTools(store, state);
    const run = await runTool("cad_measure", {
      featureOrBodyId: "body_nope",
    });
    expect(run).toMatchObject({
      code: "workbench/measure-subject-mismatch",
      ok: false,
    });
    unbind();
  });
});

describe("the workbench mount (real engine)", () => {
  /** The page-shaped harness: the real engine plus the tool mount. */
  function EngineHarness(): ReactElement {
    const engine = useWorkbenchEngine({
      rootId: "webmcp-test-root",
      statusId: "webmcp-test-status",
      volumeId: "webmcp-test-volume",
      errorId: "webmcp-test-error",
    });
    useWorkbenchWebMcpTools({
      capture: stubCaptureSurface(),
      commands: [spyCommand("probe.engine").descriptor],
      engine,
    });
    return <div data-testid="webmcp-engine-harness" />;
  }

  it("registers all twelve tools for the mount and unregisters on unmount", () => {
    const { unmount } = render(
      <WorkbenchStoreProvider>
        <EngineHarness />
      </WorkbenchStoreProvider>,
    );
    expect(webMcpToolNames()).toEqual([...TOOL_NAMES]);
    expect(window.__slopcadWebMcpTools?.().map((tool) => tool.name)).toEqual([
      ...TOOL_NAMES,
    ]);
    unmount();
    expect(webMcpToolNames()).toEqual([]);
  });
});
