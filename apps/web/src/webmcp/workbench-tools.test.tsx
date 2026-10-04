/**
 * The eight workbench WebMCP tools against the REAL domain surfaces: a
 * fresh `CadStore` over the app's own workbench session (the same session
 * factory `useWorkbenchStore` boots), the real `parseCommand` /
 * `serializeCommand` round trip, and the engine-level read paths the
 * Measurement block renders. Plus one integration mount: the REAL workbench
 * engine (worker session stubbed, the established workbench-engine test
 * pattern) with the hook registered for its lifetime.
 */

import { cleanup, render } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBodyId,
  createParameterId,
  createRenderProjection,
  getParameter,
  length,
  printExpression,
  projectTessellation,
  serializeCommand,
} from "@slopcad/cad-core";
import { createCadStore, setParameterCommand } from "@slopcad/cad-react";
import type { CadStore } from "@slopcad/cad-react";
import type { CadCommandDescriptor } from "@slopcad/ui/components/cad/cad-command-menu";
import type { PlateRenderState } from "../render-fixture/plate-render-scene";

import { createCadWorkbenchSession } from "../cad-workbench/session";
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

/** The eight tool names, in registration order. */
const TOOL_NAMES = [
  "cad_get_document_summary",
  "cad_list_commands",
  "cad_run_command",
  "cad_set_parameter",
  "cad_undo",
  "cad_redo",
  "cad_apply_commands",
  "cad_measure",
] as const;

/** The mutable live state one test surface reads through accessors. */
interface TestSurfaceState {
  applied: PlateRenderState | null;
  commands: readonly CadCommandDescriptor[];
  measureText: string | null;
}

/** A fresh store over the app's own workbench session. */
function freshStore(): CadStore {
  return createCadStore({ session: createCadWorkbenchSession() });
}

/** Binds the eight tools over one store + mutable surface state. */
function bindTools(store: CadStore, state: TestSurfaceState): () => void {
  return bindWebMcpTools(
    createWorkbenchWebMcpTools({
      appliedState: () => state.applied,
      commands: () => state.commands,
      measureText: () => state.measureText,
      store,
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

/** The empty surface state every test starts from. */
function surfaceState(
  commands: readonly CadCommandDescriptor[],
): TestSurfaceState {
  return { applied: null, commands, measureText: null };
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
      { id: "body_plate", kind: "solid", name: "plate", visible: true },
    ]);
    expect(payload.featureKinds).toContain("translate");
    expect(payload.featureKinds).toContain("rotate");
    expect(payload.parameters.map((p) => p.name)).toContain("holeDiameter");
    const hole = payload.parameters.find((p) => p.name === "holeDiameter");
    expect(hole?.value.dimension).toBe("length");
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
      commands: [spyCommand("probe.engine").descriptor],
      engine,
    });
    return <div data-testid="webmcp-engine-harness" />;
  }

  it("registers all eight tools for the mount and unregisters on unmount", () => {
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
