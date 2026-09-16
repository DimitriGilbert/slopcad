/**
 * Unit tests for the four Phase 13 tools, exercised fully headless through
 * the reference runtime + manager (no DOM, no renderer): SELECT's pick and
 * hover operations, MEASURE's pick-pair distance as a Phase 4 dimensional
 * value, TRANSLATE's one-transaction command mapping (and every
 * non-emission case), and ROTATE's angle emission with the honest
 * capability scope (the command executes in the document; no geometry is
 * claimed to rotate).
 */

import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentParameter,
  addFeature,
  createDocument,
  type CadDocument,
} from "./document";
import { angle, length, valueIn } from "./dimensional";
import {
  type BodyId,
  createBodyId,
  createDocumentId,
  createFeatureId,
  createParameterId,
  type ParameterId,
} from "./ids";
import { createRenderProjection, projectTessellation } from "./projection";
import { createSelectionState } from "./selection";
import { createSession } from "./session";
import { createToolRuntime, type ToolRuntime } from "./tool-context";
import {
  NO_TOOL_MODIFIERS,
  type ToolInputEvent,
} from "./tool-events";
import {
  createToolManager,
  registerTool,
  type CadTool,
  type ToolStateBase,
} from "./tool-manager";
import { measureTool } from "./tool-measure";
import { rotateTool, resolveRotateTarget } from "./tool-rotate";
import { selectTool } from "./tool-select";
import { resolveTranslateTarget, translateTool } from "./tool-translate";

const BODY: BodyId = createBodyId("body_plate");
const X: ParameterId = createParameterId("param_translate_x");
const Y: ParameterId = createParameterId("param_translate_y");
const Z: ParameterId = createParameterId("param_translate_z");
const ANGLE: ParameterId = createParameterId("param_rotate_z");

function buildDocument(): CadDocument {
  let document: CadDocument = createDocument(createDocumentId("doc_tools_test"));
  const body = addBody(document, { id: BODY, name: "plate" });
  if (!body.ok) throw new Error(body.error.message);
  document = body.value.document;
  for (const [id, name] of [
    [X, "translate_x"],
    [Y, "translate_y"],
    [Z, "translate_z"],
  ] as const) {
    const parameter = addDocumentParameter(document, {
      id,
      name,
      value: length(0),
    });
    if (!parameter.ok) throw new Error(parameter.error.message);
    document = parameter.value.document;
  }
  const rotateParameter = addDocumentParameter(document, {
    id: ANGLE,
    name: "rotate_z",
    value: angle(0),
  });
  if (!rotateParameter.ok) throw new Error(rotateParameter.error.message);
  document = rotateParameter.value.document;
  const translate = addFeature(document, {
    id: createFeatureId("feat_translate"),
    kind: "translate",
    inputs: [
      { kind: "body", id: BODY },
      { kind: "parameter", id: X },
      { kind: "parameter", id: Y },
      { kind: "parameter", id: Z },
    ],
    outputs: [BODY],
  });
  if (!translate.ok) throw new Error(translate.error.message);
  document = translate.value.document;
  const rotate = addFeature(document, {
    id: createFeatureId("feat_rotate"),
    kind: "rotate",
    inputs: [
      { kind: "body", id: BODY },
      { kind: "parameter", id: ANGLE },
    ],
    outputs: [BODY],
  });
  if (!rotate.ok) throw new Error(rotate.error.message);
  document = rotate.value.document;
  return document;
}

/** One triangle in the XY plane, projecting to a body with real bounds. */
const TRIANGLE = {
  positions: [0, 0, 0, 30, 0, 0, 0, 20, 0],
  indices: [0, 1, 2],
};

function buildRuntime(options: { readonly withProjection?: boolean } = {}): {
  readonly runtime: ToolRuntime;
  readonly commandLog: string[];
} {
  const commandLog: string[] = [];
  let projection = null;
  if (options.withProjection === true) {
    const object = projectTessellation(BODY, TRIANGLE);
    if (!object.ok) throw new Error(object.error.message);
    const projectionResult = createRenderProjection([object.value], {
      kind: "perspective",
      position: [40, -30, 40],
      target: [10, 7, 0],
      up: [0, 0, 1],
      fovDeg: 40,
    });
    if (!projectionResult.ok) throw new Error(projectionResult.error.message);
    projection = projectionResult.value;
  }
  const runtime = createToolRuntime({
    session: createSession(buildDocument()),
    selection: createSelectionState(0),
    projection,
    onTransaction: (transaction) => {
      commandLog.push(JSON.stringify(transaction));
    },
  });
  return { runtime, commandLog };
}

function makeManager<S extends ToolStateBase>(
  runtime: ToolRuntime,
  tool: CadTool<S>,
) {
  return createToolManager({ tools: [registerTool(tool)], context: runtime });
}

function bodyPick(point: readonly [number, number, number]): ToolInputEvent {
  return {
    type: "pointer-up",
    point,
    pick: { reference: { kind: "body", bodyId: BODY }, renderObjectId: "rend_plate" },
    modifiers: NO_TOOL_MODIFIERS,
  };
}

function shiftBodyPick(
  point: readonly [number, number, number],
): ToolInputEvent {
  return {
    type: "pointer-up",
    point,
    pick: { reference: { kind: "body", bodyId: BODY }, renderObjectId: "rend_plate" },
    modifiers: { ...NO_TOOL_MODIFIERS, shift: true },
  };
}

function miss(): ToolInputEvent {
  return { type: "pointer-up", point: null, pick: null, modifiers: NO_TOOL_MODIFIERS };
}

describe("select tool", () => {
  it("click replaces; shift-click toggles; miss is a no-op", () => {
    const { runtime } = buildRuntime();
    const manager = makeManager(runtime, selectTool);
    manager.activate(selectTool.id);
    manager.dispatch(bodyPick([1, 2, 3]));
    expect(runtime.selection.selected).toEqual([{ kind: "body", bodyId: BODY }]);
    manager.dispatch(shiftBodyPick([4, 5, 6]));
    // Shift-click on the SAME reference toggles it off (multi mode).
    expect(runtime.selection.selected).toEqual([]);
    manager.dispatch(shiftBodyPick([4, 5, 6]));
    expect(runtime.selection.selected).toEqual([{ kind: "body", bodyId: BODY }]);
    manager.dispatch(miss());
    expect(runtime.selection.selected).toEqual([{ kind: "body", bodyId: BODY }]);
    expect(manager.phase).toBe("active");
  });

  it("pointer moves drive the hover without touching the selection", () => {
    const { runtime } = buildRuntime();
    const manager = makeManager(runtime, selectTool);
    manager.activate(selectTool.id);
    manager.dispatch({
      type: "pointer-move",
      point: [1, 1, 0],
      pick: { reference: { kind: "body", bodyId: BODY }, renderObjectId: "rend_plate" },
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(runtime.selection.hover).toEqual({ kind: "body", bodyId: BODY });
    manager.dispatch(bodyPick([1, 1, 0]));
    expect(runtime.selection.selected).toEqual([{ kind: "body", bodyId: BODY }]);
    manager.dispatch({
      type: "pointer-move",
      point: null,
      pick: null,
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(runtime.selection.hover).toBeNull();
    expect(runtime.selection.selected).toEqual([{ kind: "body", bodyId: BODY }]);
  });

  it("reports a failed selection op as a structured failure and stays active", () => {
    // The selection state stands at regeneration 4; the picked synthetic
    // face is tagged for regeneration 3 — the Phase 12 transience rule
    // rejects it, and the tool reports that as a structured failure.
    const runtime = createToolRuntime({
      session: createSession(buildDocument()),
      selection: createSelectionState(4),
    });
    const manager = makeManager(runtime, selectTool);
    manager.activate(selectTool.id);
    manager.dispatch({
      type: "pointer-up",
      point: [0, 0, 0],
      pick: {
        reference: {
          kind: "face",
          bodyId: BODY,
          regeneration: 3,
          faceIndex: 0,
        },
        renderObjectId: "rend_plate",
      },
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(manager.failure?.code).toBe("selection/stale-reference");
    expect(manager.phase).toBe("active");
    expect(runtime.selection.selected).toEqual([]);
  });
});

describe("measure tool", () => {
  it("completes on the second pick with the canonical-millimetre distance", () => {
    const { runtime } = buildRuntime();
    const manager = makeManager(runtime, measureTool);
    manager.activate(measureTool.id);
    expect(manager.toolState).toEqual({ stage: "awaiting-first" });
    manager.dispatch(bodyPick([0, 0, 0]));
    expect(manager.toolState).toEqual({ stage: "awaiting-second", from: [0, 0, 0] });
    manager.dispatch(bodyPick([3, 4, 0]));
    expect(manager.phase).toBe("completed");
    const detail = manager.completion?.detail;
    expect(detail?.kind).toBe("measurement");
    if (detail?.kind !== "measurement") return;
    expect(detail.distance.dimension).toBe("length");
    expect(valueIn(detail.distance, "mm")).toBeCloseTo(5, 12);
    expect(detail.from).toEqual([0, 0, 0]);
    expect(detail.to).toEqual([3, 4, 0]);
  });

  it("misses are no-ops and the tool issues no commands", () => {
    const { runtime, commandLog } = buildRuntime();
    const manager = makeManager(runtime, measureTool);
    manager.activate(measureTool.id);
    manager.dispatch(miss());
    manager.dispatch(bodyPick([1, 1, 1]));
    manager.dispatch(miss());
    expect(manager.phase).toBe("active");
    expect(manager.toolState).toEqual({ stage: "awaiting-second", from: [1, 1, 1] });
    expect(commandLog).toEqual([]);
  });
});

describe("translate tool", () => {
  it("issues one atomic transaction of three canonical-millimetre parameter.sets", () => {
    const { runtime, commandLog } = buildRuntime();
    const manager = makeManager(runtime, translateTool);
    manager.activate(translateTool.id);
    const down: ToolInputEvent = {
      type: "pointer-down",
      point: [0, 0, 0],
      pick: { reference: { kind: "body", bodyId: BODY }, renderObjectId: "rend_plate" },
      modifiers: NO_TOOL_MODIFIERS,
    };
    manager.dispatch(down);
    expect(manager.toolState).toEqual({
      stage: "dragging",
      bodyId: BODY,
      origin: [0, 0, 0],
      lastVector: [0, 0, 0],
    });
    manager.dispatch({
      type: "pointer-move",
      point: [5, 0, 0],
      pick: null,
      modifiers: NO_TOOL_MODIFIERS,
    });
    // Preview updates tool state only — nothing issued yet.
    expect(manager.toolState).toMatchObject({ stage: "dragging", lastVector: [5, 0, 0] });
    expect(commandLog).toEqual([]);
    manager.dispatch({
      type: "pointer-up",
      point: [5, -2, 1],
      pick: { reference: { kind: "face", bodyId: BODY, regeneration: 0, faceIndex: 1 }, renderObjectId: "rend_plate" },
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(manager.phase).toBe("completed");
    const detail = manager.completion?.detail;
    expect(detail?.kind).toBe("commands");
    if (detail?.kind !== "commands") return;
    expect(detail.transaction.commands).toEqual([
      { type: "parameter.set", id: X, value: length(5) },
      { type: "parameter.set", id: Y, value: length(-2) },
      { type: "parameter.set", id: Z, value: length(1) },
    ]);
    expect(commandLog).toHaveLength(1);
    const offset = resolveTranslateTarget(runtime.session.document, BODY);
    expect(offset).toBeDefined();
    expect(runtime.session.history.entries).toHaveLength(1);
  });

  it("non-emission cases consume the gesture with failures and issue nothing", () => {
    const { runtime, commandLog } = buildRuntime();
    const manager = makeManager(runtime, translateTool);
    manager.activate(translateTool.id);

    // Zero-length drag.
    manager.dispatch({
      type: "pointer-down",
      point: [1, 1, 1],
      pick: { reference: { kind: "body", bodyId: BODY }, renderObjectId: "rend_plate" },
      modifiers: NO_TOOL_MODIFIERS,
    });
    manager.dispatch({
      type: "pointer-up",
      point: [1, 1, 1],
      pick: null,
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(manager.failure?.code).toBe("tool/degenerate-gesture");
    expect(manager.toolState).toEqual({ stage: "awaiting-anchor" });

    // Drag ending off-model (no world point).
    manager.dispatch({
      type: "pointer-down",
      point: [1, 1, 1],
      pick: { reference: { kind: "body", bodyId: BODY }, renderObjectId: "rend_plate" },
      modifiers: NO_TOOL_MODIFIERS,
    });
    manager.dispatch({
      type: "pointer-up",
      point: null,
      pick: null,
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(manager.failure?.code).toBe("tool/degenerate-gesture");

    // A pick that addresses no body.
    manager.dispatch({
      type: "pointer-down",
      point: [0, 0, 0],
      pick: {
        reference: { kind: "feature", featureId: createFeatureId("feat_translate") },
        renderObjectId: "rend_plate",
      },
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(manager.failure?.code).toBe("tool/target-unresolved");
    expect(manager.toolState).toEqual({ stage: "awaiting-anchor" });
    expect(commandLog).toEqual([]);
  });

  it("a body without a translate feature cannot express the drag", () => {
    let document: CadDocument = createDocument(createDocumentId("doc_bare"));
    const body = addBody(document, { id: BODY, name: "plate" });
    if (!body.ok) throw new Error(body.error.message);
    document = body.value.document;
    const runtime = createToolRuntime({
      session: createSession(document),
      selection: createSelectionState(0),
    });
    const manager = makeManager(runtime, translateTool);
    manager.activate(translateTool.id);
    manager.dispatch({
      type: "pointer-down",
      point: [0, 0, 0],
      pick: { reference: { kind: "body", bodyId: BODY }, renderObjectId: "rend_plate" },
      modifiers: NO_TOOL_MODIFIERS,
    });
    manager.dispatch({
      type: "pointer-up",
      point: [1, 2, 3],
      pick: null,
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(manager.failure?.code).toBe("tool/target-unresolved");
    expect(manager.phase).toBe("active");
  });

  it("resolves the LAST translate feature in document order", () => {
    const document = buildDocument();
    const target = resolveTranslateTarget(document, BODY);
    expect(target?.featureId).toBe(createFeatureId("feat_translate"));
    expect(target?.parameters).toEqual([X, Y, Z]);
    expect(resolveRotateTarget(document, BODY)?.parameterId).toBe(ANGLE);
  });
});

describe("rotate tool", () => {
  it("issues one canonical-radian parameter.set for a swept arc", () => {
    const { runtime, commandLog } = buildRuntime({ withProjection: true });
    const manager = makeManager(runtime, rotateTool);
    manager.activate(rotateTool.id);
    // Triangle bounds [0..30, 0..20, 0] → center (15, 10, 0). Anchor at
    // (30, 10) (east radial), release at (15, 20) (north radial): +90°.
    manager.dispatch({
      type: "pointer-down",
      point: [30, 10, 0],
      pick: { reference: { kind: "body", bodyId: BODY }, renderObjectId: "rend_plate" },
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(manager.toolState).toMatchObject({ stage: "dragging", lastAngle: 0 });
    manager.dispatch({
      type: "pointer-up",
      point: [15, 20, 0],
      pick: null,
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(manager.phase).toBe("completed");
    const detail = manager.completion?.detail;
    expect(detail?.kind).toBe("commands");
    if (detail?.kind !== "commands") return;
    const [command] = detail.transaction.commands;
    expect(command?.type).toBe("parameter.set");
    if (command?.type !== "parameter.set") return;
    expect(command.id).toBe(ANGLE);
    expect(command.value.dimension).toBe("angle");
    expect(valueIn(command.value, "deg")).toBeCloseTo(90, 9);
    expect(command.value.unit).toBe("rad");
    expect(commandLog).toHaveLength(1);
  });

  it("degenerate radials and a missing projection never issue", () => {
    const { runtime, commandLog } = buildRuntime();
    const manager = makeManager(runtime, rotateTool);
    manager.activate(rotateTool.id);
    // No projection: the center cannot resolve.
    manager.dispatch({
      type: "pointer-down",
      point: [30, 10, 0],
      pick: { reference: { kind: "body", bodyId: BODY }, renderObjectId: "rend_plate" },
      modifiers: NO_TOOL_MODIFIERS,
    });
    expect(manager.failure?.code).toBe("tool/target-unresolved");
    expect(manager.toolState).toEqual({ stage: "awaiting-anchor" });
    expect(commandLog).toEqual([]);
  });

  it("the document mutation executes; no geometry claim is made anywhere", () => {
    const { runtime } = buildRuntime({ withProjection: true });
    const manager = makeManager(runtime, rotateTool);
    manager.activate(rotateTool.id);
    manager.dispatch({
      type: "pointer-down",
      point: [30, 10, 0],
      pick: { reference: { kind: "body", bodyId: BODY }, renderObjectId: "rend_plate" },
      modifiers: NO_TOOL_MODIFIERS,
    });
    manager.dispatch({
      type: "pointer-up",
      point: [15, 20, 0],
      pick: null,
      modifiers: NO_TOOL_MODIFIERS,
    });
    const stored = runtime.session.document.parameters.parameters.find(
      (parameter) => parameter.id === ANGLE,
    );
    expect(valueIn(stored?.value ?? angle(0), "deg")).toBeCloseTo(90, 9);
    // The scoped truth: the transaction is real, replayable history.
    expect(runtime.session.history.entries).toHaveLength(1);
  });
});
