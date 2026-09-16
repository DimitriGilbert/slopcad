/**
 * Unit tests for the Phase 13 tool manager: the deterministic lifecycle
 * (inactive → active → completed | cancelled, explicit transitions only,
 * refused transitions throw), single-active-tool routing, the completion
 * and failure surfaces, and — pinned — the atomicity rule: a cancelled
 * activation issues nothing further, so the document and its history are
 * untouched after a mid-gesture cancel.
 */

import { describe, expect, it } from "vitest";
import type { ToolContext } from "./tool-context";

import { length } from "./dimensional";
import {
  addBody,
  addDocumentParameter,
  createDocument,
  type CadDocument,
} from "./document";
import {
  createBodyId,
  createDocumentId,
  createParameterId,
  type BodyId,
  type ParameterId,
} from "./ids";
import { createSelectionState, type SelectionState } from "./selection";
import {
  applySessionTransaction,
  createSession,
  type CadSession,
} from "./session";
import { NO_TOOL_MODIFIERS, type ToolInputEvent } from "./tool-events";
import {
  createToolManager,
  registerTool,
  type CadTool,
  type ToolCompletionDetail,
  type ToolStateBase,
  type ToolTransition,
} from "./tool-manager";

const BODY: BodyId = createBodyId("body_test");
const PARAMETER: ParameterId = createParameterId("param_probe");

/**
 * A two-stage probe tool: pointer-down arms it (gesture state lives ONLY in
 * tool state), pointer-up completes by issuing one parameter.set command.
 */
interface ProbeState extends ToolStateBase {
  readonly stage: "idle" | "armed";
}

function probeTool(id: string, parameter: ParameterId): CadTool<ProbeState> {
  return {
    id,
    initialState: { stage: "idle" },
    onEvent(
      state: ProbeState,
      event: ToolInputEvent,
      context: ToolContext,
    ): ToolTransition<ProbeState> {
      if (event.type === "pointer-down") {
        return { state: { stage: "armed" }, phase: "active" };
      }
      if (event.type === "pointer-up") {
        const issued = context.issue({
          commands: [{ type: "parameter.set", id: parameter, value: length(2) }],
        });
        if (!issued.ok) throw new Error(issued.error.message);
        return {
          state: { stage: "idle" },
          phase: "completed",
          detail: { kind: "none" },
        };
      }
      return { state, phase: "active" };
    },
  };
}

function pointerDown(): ToolInputEvent {
  return { type: "pointer-down", point: null, pick: null, modifiers: NO_TOOL_MODIFIERS };
}

function pointerUp(): ToolInputEvent {
  return { type: "pointer-up", point: null, pick: null, modifiers: NO_TOOL_MODIFIERS };
}

function pointerMove(): ToolInputEvent {
  return { type: "pointer-move", point: null, pick: null, modifiers: NO_TOOL_MODIFIERS };
}

interface Harness {
  readonly manager: ReturnType<typeof createToolManager>;
  readonly context: ToolContext;
  readonly issued: readonly unknown[];
}

function makeHarness(
  tools: readonly CadTool<ProbeState>[],
  options: { readonly session?: CadSession } = {},
): Harness {
  const issued: unknown[] = [];
  let session: CadSession =
    options.session ??
    (() => {
      let document: CadDocument = createDocument(
        createDocumentId("doc_manager_test"),
      );
      const body = addBody(document, { id: BODY, name: "test" });
      if (!body.ok) throw new Error(body.error.message);
      document = body.value.document;
      const parameter = addDocumentParameter(document, {
        id: PARAMETER,
        name: "probe",
        value: length(0),
      });
      if (!parameter.ok) throw new Error(parameter.error.message);
      document = parameter.value.document;
      return createSession(document);
    })();
  const selection: SelectionState = createSelectionState(0);
  const context: ToolContext = {
    get session(): CadSession {
      return session;
    },
    selection,
    projection: null,
    issue(transaction) {
      const applied = applySessionTransaction(session, transaction);
      if (applied.ok) {
        session = applied.value;
        issued.push(JSON.parse(JSON.stringify(transaction.commands)));
      }
      return applied;
    },
    applySelection: () => {
      throw new Error("selection is not expected in manager tests");
    },
  };
  const manager = createToolManager({
    tools: tools.map((tool) => registerTool(tool)),
    context,
  });
  return { manager, context, issued };
}

describe("tool manager lifecycle", () => {
  it("starts inactive with no tool, state, completion, or failure", () => {
    const { manager } = makeHarness([probeTool("probe", PARAMETER)]);
    expect(manager.phase).toBe("inactive");
    expect(manager.toolId).toBeNull();
    expect(manager.toolState).toBeNull();
    expect(manager.completion).toBeNull();
    expect(manager.failure).toBeNull();
  });

  it("activates only from inactive and begins at the tool's initial state", () => {
    const { manager } = makeHarness([probeTool("probe", PARAMETER)]);
    manager.activate("probe");
    expect(manager.phase).toBe("active");
    expect(manager.toolId).toBe("probe");
    expect(manager.toolState).toEqual({ stage: "idle" });
    expect(() => manager.activate("probe")).toThrow(/inactive/);
  });

  it("refuses to activate an unregistered tool", () => {
    const { manager } = makeHarness([probeTool("probe", PARAMETER)]);
    expect(() => manager.activate("ghost")).toThrow(/ghost/);
  });

  it("routes events only to the active tool and completes on its decision", () => {
    const { manager } = makeHarness([probeTool("probe", PARAMETER)]);
    expect(() => manager.dispatch(pointerDown())).toThrow(/active/);
    manager.activate("probe");
    manager.dispatch(pointerDown());
    expect(manager.toolState).toEqual({ stage: "armed" });
    manager.dispatch(pointerUp());
    expect(manager.phase).toBe("completed");
    expect(manager.completion).toEqual({
      toolId: "probe",
      detail: { kind: "none" } satisfies ToolCompletionDetail,
    });
    expect(manager.toolState).toEqual({ stage: "idle" });
    expect(() => manager.dispatch(pointerUp())).toThrow(/active/);
  });

  it("cancels only a live activation and keeps the final state as evidence", () => {
    const { manager } = makeHarness([probeTool("probe", PARAMETER)]);
    expect(() => manager.cancel()).toThrow(/inactive/);
    manager.activate("probe");
    manager.dispatch(pointerDown());
    manager.cancel();
    expect(manager.phase).toBe("cancelled");
    expect(manager.completion).toBeNull();
    expect(manager.toolState).toEqual({ stage: "armed" });
    // Terminal: a further cancel is refused — reset is the way out.
    expect(() => manager.cancel()).toThrow(/cancelled/);
  });

  it("resets terminal phases to inactive and refuses while active", () => {
    const { manager } = makeHarness([probeTool("probe", PARAMETER)]);
    manager.reset();
    expect(manager.phase).toBe("inactive");
    manager.activate("probe");
    expect(() => manager.reset()).toThrow(/cancel/);
    manager.cancel();
    manager.reset();
    expect(manager.phase).toBe("inactive");
    expect(manager.toolId).toBeNull();
    expect(manager.toolState).toBeNull();
    manager.reset();
    expect(manager.phase).toBe("inactive");
    manager.activate("probe");
    manager.dispatch(pointerDown());
    manager.dispatch(pointerUp());
    manager.reset();
    expect(manager.phase).toBe("inactive");
    expect(manager.completion).toBeNull();
  });

  it("keeps exactly one active tool and a fresh state per activation", () => {
    const { manager } = makeHarness([
      probeTool("a", PARAMETER),
      probeTool("b", PARAMETER),
    ]);
    manager.activate("a");
    manager.dispatch(pointerDown());
    expect(manager.toolState).toEqual({ stage: "armed" });
    manager.cancel();
    manager.reset();
    manager.activate("b");
    expect(manager.toolId).toBe("b");
    expect(manager.toolState).toEqual({ stage: "idle" });
    expect(() => manager.activate("a")).toThrow(/inactive/);
  });

  it("rejects duplicate registry ids and malformed tool ids", () => {
    expect(() =>
      makeHarness([probeTool("dup", PARAMETER), probeTool("dup", PARAMETER)]),
    ).toThrow(/twice/);
    expect(() => makeHarness([probeTool("1bad", PARAMETER)])).toThrow(/tool id/);
  });

  it("surfaces a tool's last structured failure until the next activation", () => {
    const failing: CadTool<ProbeState> = {
      id: "failing",
      initialState: { stage: "idle" },
      onEvent(
        state: ProbeState,
        event: ToolInputEvent,
      ): ToolTransition<ProbeState> {
        if (event.type === "pointer-move") {
          return {
            state,
            phase: "active",
            failure: { code: "tool/test-failure", message: "expected" },
          };
        }
        return { state, phase: "active" };
      },
    };
    const { manager } = makeHarness([failing]);
    manager.activate("failing");
    manager.dispatch(pointerMove());
    expect(manager.failure).toEqual({
      code: "tool/test-failure",
      message: "expected",
    });
    manager.dispatch(pointerDown());
    expect(manager.failure).toEqual({
      code: "tool/test-failure",
      message: "expected",
    });
    manager.cancel();
    manager.reset();
    manager.activate("failing");
    expect(manager.failure).toBeNull();
  });

  it("pins the atomicity rule: cancelling mid-gesture issues nothing", () => {
    const { manager, context, issued } = makeHarness([
      probeTool("probe", PARAMETER),
    ]);
    const sessionBefore = context.session;
    manager.activate("probe");
    // The in-flight gesture: armed but NOT committed.
    manager.dispatch(pointerDown());
    expect(manager.toolState).toEqual({ stage: "armed" });
    manager.cancel();
    expect(issued).toEqual([]);
    expect(context.session).toBe(sessionBefore);
    expect(context.session.history.entries.length).toBe(
      sessionBefore.history.entries.length,
    );
    // Re-arming completes the gesture and issues exactly the one command.
    manager.reset();
    manager.activate("probe");
    manager.dispatch(pointerDown());
    manager.dispatch(pointerUp());
    expect(manager.phase).toBe("completed");
    expect(issued).toEqual([
      [{ type: "parameter.set", id: PARAMETER, value: length(2) }],
    ]);
    const stored = context.session.document.parameters.parameters.find(
      (parameter) => parameter.id === PARAMETER,
    );
    expect(stored?.value).toEqual(length(2));
  });
});
