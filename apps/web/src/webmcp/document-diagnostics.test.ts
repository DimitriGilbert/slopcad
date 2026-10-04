// @vitest-environment node

/**
 * The Phase 2.2 workbench read tools (`cad_get_document` /
 * `cad_get_diagnostics`, PLAN-AGENT-CHAT D11): the compact model-oriented
 * outline and the structured diagnostics read, driven through the registry
 * boundary against a REAL `CadStore` over the app's own workbench session.
 * The engine-side reads (mode, timeline, regeneration issue, sketch solve)
 * are surface accessors — mocked here; the live binding is the complete
 * workbench's own mount (workbench-tools.test.tsx pins the eleven-tool
 * registration). No DOM, no WebGL.
 *
 * Also pins the phase-wide output-shape constraint: the tools' RESULT field
 * names never contain apiKey-like fragments, so the relay's D1 deep scan can
 * never mistake a payload for a credential carrier.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  addBody,
  addDocumentReference,
  addMate,
  addOccurrence,
  createBodyId,
  createDocument,
  createDocumentId,
  createFeatureId,
  createOccurrenceId,
  createParameterId,
  createReferenceId,
  createSession,
  type FeatureTimelineEntry,
  length,
} from "@slopcad/cad-core";
import {
  createCadStore,
  setParameterCommand,
  type CadStore,
} from "@slopcad/cad-react";
import type { PlateRenderState } from "../render-fixture/plate-render-scene";

import { createCadWorkbenchSession } from "../cad-workbench/session";
import {
  executeWebMcpTool,
  registerWebMcpTool,
  unregisterWebMcpTool,
  webMcpToolNames,
  webMcpToolSnapshot,
} from "./registry";
import { bindWebMcpTools } from "./use-webmcp-tools";
import {
  createWorkbenchWebMcpTools,
  type SketchSolveReadout,
  type WorkbenchCaptureSurface,
} from "./workbench-tools";

/** The structured outcome of driving one tool through the registry. */
type ToolRun =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The mutable engine-side state the mocked surface reads. */
interface SurfaceState {
  applied: PlateRenderState | null;
  commands: readonly [];
  measureText: string | null;
  mode: string;
  regenerationIssue: string | null;
  sketchSolve: SketchSolveReadout | null;
  timeline: readonly FeatureTimelineEntry[] | null;
}

/** The apiKey-like fragments no output field name may contain (D1). */
const FORBIDDEN_FRAGMENTS = [
  "token",
  "secret",
  "password",
  "credential",
  "key",
] as const;

/**
 * Recursively asserts no field name in the payload carries an apiKey-like
 * fragment (the relay's D1 deep-scan constraint, pinned per tool).
 */
function expectNoApiKeyLikeFieldNames(payload: unknown): void {
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) scan(entry);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [fieldName, entry] of Object.entries(
        value as Record<string, unknown>,
      )) {
        const normalized = fieldName.toLowerCase();
        for (const fragment of FORBIDDEN_FRAGMENTS) {
          expect(
            normalized.includes(fragment),
            `field "${fieldName}" must not contain "${fragment}"`,
          ).toBe(false);
        }
        scan(entry);
      }
    }
  };
  scan(payload);
}

/** A fresh store over the app's own workbench session. */
function freshStore(): CadStore {
  return createCadStore({ session: createCadWorkbenchSession() });
}

/** A store over a purpose-built document (the outline's assembly probe). */
function storeOver(document: Parameters<typeof createSession>[0]): CadStore {
  return createCadStore({ session: createSession(document) });
}

/** The capture stub: no viewport in node — the capture tool is not under test. */
function stubCaptureSurface(): WorkbenchCaptureSurface {
  return {
    canvas: () => null,
    convention: () => "third-angle",
    renderedFrames: () => 0,
    rootId: "document-diagnostics-test-root",
    setUserCamera: () => {},
    userCamera: () => null,
  };
}

/** The mutable default surface state. */
function surfaceState(): SurfaceState {
  return {
    applied: null,
    commands: [],
    measureText: null,
    mode: "model",
    regenerationIssue: null,
    sketchSolve: null,
    timeline: null,
  };
}

/** Binds the workbench tools over one store + mutable surface state. */
function bindTools(store: CadStore, state: SurfaceState): () => void {
  return bindWebMcpTools(
    createWorkbenchWebMcpTools({
      appliedState: () => state.applied,
      capture: stubCaptureSurface(),
      commands: () => state.commands,
      measureText: () => state.measureText,
      mode: () => state.mode,
      regenerationIssue: () => state.regenerationIssue,
      sketchSolve: () => state.sketchSolve,
      store,
      timeline: () => state.timeline,
    }),
  );
}

/**
 * Drives one tool with raw JSON input through the registry boundary,
 * decoding the tool's own refusals the way the agent loop does.
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

afterEach(() => {
  for (const name of webMcpToolNames()) unregisterWebMcpTool(name);
});

describe("cad_get_document", () => {
  it("outlines the boot document compactly: mode, features, $-variables, bodies, history, selection", async () => {
    const store = freshStore();
    store.pick({ bodyId: createBodyId("body_plate"), kind: "body" }, false);
    const unbind = bindTools(store, surfaceState());
    const run = await runTool("cad_get_document", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expectNoApiKeyLikeFieldNames(run.payload);
    expect(run.payload).toMatchObject({
      documentId: "doc_cad_workbench",
      history: { canRedo: false, canUndo: false, cursor: 0, depth: 0 },
      mode: "model",
      ok: true,
    });
    const payload = run.payload as {
      bodies: { id: string; name: string }[];
      features: { id: string; kind: string; status: string | null }[];
      parameters: {
        expression: string | null;
        name: string;
        value: { dimension: string };
      }[];
      selection: { selected: unknown[] };
    };
    expect(payload.bodies).toEqual([
      { id: "body_plate", kind: "solid", name: "plate", visible: true },
    ]);
    // The feature outline carries kinds with statuses joined when the
    // timeline exists — `null` stays honest before the first run.
    expect(payload.features.map((feature) => feature.kind)).toEqual([
      "translate",
      "rotate",
    ]);
    expect(payload.features.every((feature) => feature.status === null)).toBe(
      true,
    );
    // The $-variables: names, canonical-unit values, and defining
    // expressions (the boot pair is expression-driven).
    expect(payload.parameters.map((parameter) => parameter.name)).toContain(
      "holeDiameter",
    );
    const hint = payload.parameters.find(
      (parameter) => parameter.name === "volumeHint",
    );
    expect(hint?.expression).toBe("holeDiameter * 2");
    expect(hint?.value.dimension).toBe("length");
    expect(payload.selection.selected).toEqual([
      { bodyId: "body_plate", kind: "body" },
    ]);
    unbind();
  });

  it("joins the live timeline statuses into the feature outline", async () => {
    const store = freshStore();
    const state = surfaceState();
    state.timeline = [
      {
        diagnostics: [],
        id: createFeatureId("feat_translate_plate"),
        kind: "translate",
        status: "suppressed",
      },
    ];
    const unbind = bindTools(store, state);
    const run = await runTool("cad_get_document", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const payload = run.payload as {
      features: { id: string; status: string | null }[];
    };
    const translate = payload.features.find(
      (feature) => feature.id === "feat_translate_plate",
    );
    expect(translate?.status).toBe("suppressed");
    unbind();
  });

  it("reports the live history cursor and mode as they move", async () => {
    const store = freshStore();
    const state = surfaceState();
    state.mode = "sketch";
    const unbind = bindTools(store, state);
    expect(
      store.applyCommand(
        setParameterCommand(
          createParameterId("param_hole_diameter"),
          length(42),
        ),
      ).ok,
    ).toBe(true);
    const run = await runTool("cad_get_document", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.payload).toMatchObject({
      history: { canUndo: true, cursor: 1, depth: 1 },
      mode: "sketch",
    });
    unbind();
  });

  it("outlines the document's assembly records when it carries them", async () => {
    // A store over a document that carries occurrences and a mate: the
    // SAME outline shape the assembly pages' tool renders.
    let document = createDocument(createDocumentId("doc_outline_probe"));
    const body = addBody(document, {
      id: createBodyId("body_probe"),
      name: "probe",
    });
    if (!body.ok) throw new Error(body.error.message);
    document = body.value.document;
    const reference = addDocumentReference(document, {
      name: "probe face",
      reference: { synthetic: true },
    });
    if (!reference.ok) throw new Error(reference.error.message);
    document = reference.value.document;
    const first = addOccurrence(document, {
      id: createOccurrenceId("occ_probe_a"),
      name: "probe a",
      source: { bodyId: createBodyId("body_probe"), kind: "body" },
    });
    if (!first.ok) throw new Error(first.error.message);
    document = first.value.document;
    const second = addOccurrence(document, {
      bomFlag: "phantom",
      id: createOccurrenceId("occ_probe_b"),
      name: "probe b",
      placement: { kind: "offset", translation: [40, 0, 0] },
      source: { bodyId: createBodyId("body_probe"), kind: "body" },
    });
    if (!second.ok) throw new Error(second.error.message);
    document = second.value.document;
    const referenceId = String(reference.value.reference.id);
    const mate = addMate(document, {
      first: {
        occurrenceId: createOccurrenceId("occ_probe_a"),
        referenceId: createReferenceId(referenceId),
      },
      kind: "coincident",
      name: "a to b",
      second: {
        occurrenceId: createOccurrenceId("occ_probe_b"),
        referenceId: createReferenceId(referenceId),
      },
    });
    if (!mate.ok) throw new Error(mate.error.message);
    document = mate.value.document;

    const unbind = bindTools(storeOver(document), surfaceState());
    const run = await runTool("cad_get_document", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expectNoApiKeyLikeFieldNames(run.payload);
    const payload = run.payload as {
      mates: { id: string; kind: string }[];
      occurrences: {
        bomFlag: string;
        id: string;
        sourceKind: string;
        sourceName: string;
        translation: number[] | null;
      }[];
    };
    expect(payload.occurrences).toEqual([
      {
        bomFlag: "default",
        datumId: null,
        id: "occ_probe_a",
        name: "probe a",
        sourceKind: "body",
        sourceName: "probe",
        translation: null,
      },
      {
        bomFlag: "phantom",
        datumId: null,
        id: "occ_probe_b",
        name: "probe b",
        sourceKind: "body",
        sourceName: "probe",
        translation: [40, 0, 0],
      },
    ]);
    expect(payload.mates).toHaveLength(1);
    const outlinedMate = payload.mates[0];
    expect(outlinedMate).toMatchObject({
      first: { occurrenceId: "occ_probe_a", referenceId },
      kind: "coincident",
      name: "a to b",
      second: { occurrenceId: "occ_probe_b", referenceId },
      value: null,
    });
    expect(outlinedMate?.id).toMatch(/^mat_/);
    unbind();
  });

  it("rejects non-object input at the registry schema, never throwing", async () => {
    const store = freshStore();
    const unbind = bindTools(store, surfaceState());
    const run = await runTool("cad_get_document", "not-an-object");
    expect(run).toMatchObject({ code: "webmcp/invalid-input", ok: false });
    unbind();
  });
});

describe("cad_get_diagnostics", () => {
  it("reports the clean workbench: no issue, empty diagnostics, trivially solved assembly", async () => {
    const store = freshStore();
    const unbind = bindTools(store, surfaceState());
    const run = await runTool("cad_get_diagnostics", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expectNoApiKeyLikeFieldNames(run.payload);
    expect(run.payload).toMatchObject({
      assembly: {
        jointCount: 0,
        mateCount: 0,
        occurrenceCount: 0,
        solveDiagnostics: [],
        solveStatus: "solved",
      },
      ok: true,
      regeneration: { issue: null },
      sketch: null,
    });
    unbind();
  });

  it("surfaces the regeneration issue and the failed features' diagnostics", async () => {
    const store = freshStore();
    const state = surfaceState();
    state.regenerationIssue = "feature feat_rotate_plate: kernel refused";
    state.timeline = [
      {
        diagnostics: [
          {
            code: "kernel/operation-failed",
            message: "revolve axis degenerate",
            primary: "feat_rotate_plate",
            severity: "error",
          },
        ],
        id: createFeatureId("feat_rotate_plate"),
        kind: "rotate",
        status: "failed",
      },
    ];
    const unbind = bindTools(store, state);
    const run = await runTool("cad_get_diagnostics", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.payload).toMatchObject({
      regeneration: {
        features: [
          {
            diagnostics: [
              {
                code: "kernel/operation-failed",
                message: "revolve axis degenerate",
                severity: "error",
              },
            ],
            id: createFeatureId("feat_rotate_plate"),
            kind: "rotate",
            status: "failed",
          },
        ],
        issue: "feature feat_rotate_plate: kernel refused",
      },
    });
    unbind();
  });

  it("carries the sketch solver readout while the sketch workspace is mounted", async () => {
    const store = freshStore();
    const state = surfaceState();
    state.mode = "sketch";
    state.sketchSolve = {
      diagnostics: [
        {
          code: "sketch/constraint-conflicting",
          message: "dimension contradicts the horizontal pair",
          severity: "error",
        },
      ],
      dof: null,
      status: "failed",
    };
    const unbind = bindTools(store, state);
    const run = await runTool("cad_get_diagnostics", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.payload).toMatchObject({
      sketch: {
        diagnostics: [
          {
            code: "sketch/constraint-conflicting",
            message: "dimension contradicts the horizontal pair",
            severity: "error",
          },
        ],
        dof: null,
        status: "failed",
      },
    });
    unbind();
  });

  it("reports the anchor-less mate solve honestly (assembly/mate-unresolved)", async () => {
    // A document with occurrences and a mate: no executor anchor seam
    // exists anywhere yet, so the solver's own honest diagnostic is the
    // answer — never a fabricated solve.
    let document = createDocument(createDocumentId("doc_mate_diag"));
    const body = addBody(document, {
      id: createBodyId("body_mate"),
      name: "m",
    });
    if (!body.ok) throw new Error(body.error.message);
    document = body.value.document;
    const reference = addDocumentReference(document, {
      name: "m face",
      reference: { synthetic: true },
    });
    if (!reference.ok) throw new Error(reference.error.message);
    document = reference.value.document;
    for (const id of ["occ_mate_a", "occ_mate_b"]) {
      const occurrence = addOccurrence(document, {
        id: createOccurrenceId(id),
        name: id,
        source: { bodyId: createBodyId("body_mate"), kind: "body" },
      });
      if (!occurrence.ok) throw new Error(occurrence.error.message);
      document = occurrence.value.document;
    }
    const referenceId = createReferenceId(String(reference.value.reference.id));
    const mate = addMate(document, {
      first: { occurrenceId: createOccurrenceId("occ_mate_a"), referenceId },
      kind: "distance",
      name: "a b apart",
      second: { occurrenceId: createOccurrenceId("occ_mate_b"), referenceId },
      value: 12,
    });
    if (!mate.ok) throw new Error(mate.error.message);
    document = mate.value.document;

    const unbind = bindTools(storeOver(document), surfaceState());
    const run = await runTool("cad_get_diagnostics", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expectNoApiKeyLikeFieldNames(run.payload);
    expect(run.payload).toMatchObject({
      assembly: {
        jointDof: { rotational: 0, translational: 0 },
        mateCount: 1,
        occurrenceCount: 2,
        solveDiagnostics: [
          {
            code: "assembly/mate-unresolved",
            severity: "error",
          },
        ],
        solveStatus: "unresolved",
      },
    });
    unbind();
  });

  it("derives JSON object schemas for the registry snapshot", () => {
    const store = freshStore();
    const entries = createWorkbenchWebMcpTools({
      appliedState: () => null,
      capture: stubCaptureSurface(),
      commands: () => [],
      measureText: () => null,
      mode: () => "model",
      regenerationIssue: () => null,
      sketchSolve: () => null,
      store,
      timeline: () => null,
    });
    for (const entry of entries) registerWebMcpTool(entry);
    for (const name of ["cad_get_document", "cad_get_diagnostics"]) {
      const tool = webMcpToolSnapshot().find((entry) => entry.name === name);
      expect(tool).toBeDefined();
      if (tool === undefined) continue;
      expect((tool.inputSchema as { readonly type?: string }).type).toBe(
        "object",
      );
      expect(tool.annotations).toMatchObject({ readOnlyHint: true });
    }
  });
});
