/**
 * Store-level tests for the `CadStore` runtime composition (the React-free
 * half of the Phase 14 boundary): scoped concern notifications driven by
 * domain identity diffs, the command log, tool lifecycle ops, and the
 * history moves. The React hook pairings live in `hooks.test.tsx`.
 */

import { describe, expect, it, vi } from "vitest";
import {
  applySessionTransaction,
  createFeatureId,
  createParameterId,
  length,
  SELECT_TOOL_ID,
  serializeTransaction,
  type CadTransaction,
} from "@slopcad/cad-core";

import { cadTransaction, setParameterCommand } from "./model";
import {
  createTestSession,
  createTestStore,
  TEST_BODY_ID,
  TEST_WIDTH_PARAMETER,
} from "./test-support";

function requireValue<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(`Test store rejected ${what}: ${result.error.message}`);
  }
  return result.value;
}

function setWidth(mm: number): CadTransaction {
  return cadTransaction(setParameterCommand(TEST_WIDTH_PARAMETER, length(mm)));
}

/** A command that fails structurally: the parameter does not exist. */
function setMissingParameter(): CadTransaction {
  return cadTransaction(
    setParameterCommand(createParameterId("param_missing"), length(1)),
  );
}

function createPlateFeature(): CadTransaction {
  return cadTransaction({
    type: "feature.create",
    id: createFeatureId("feat_plate"),
    kind: "plate",
    inputs: [{ kind: "parameter", id: TEST_WIDTH_PARAMETER }],
    outputs: [TEST_BODY_ID],
  });
}

describe("CadStore notifications", () => {
  it("notifies document subscribers when a transaction commits and not when it fails", () => {
    const store = createTestStore();
    const onDocument = vi.fn();
    store.subscribeDocument(onDocument);

    const failed = store.applyTransaction(setMissingParameter());
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe("transaction/command-failed");
    }
    expect(onDocument).not.toHaveBeenCalled();

    const applied = store.applyTransaction(setWidth(12));
    expect(applied.ok).toBe(true);
    expect(onDocument).toHaveBeenCalledTimes(1);
  });

  it("scopes notifications: a selection change does not notify document or history subscribers", () => {
    const store = createTestStore();
    const onDocument = vi.fn();
    const onHistory = vi.fn();
    const onParameters = vi.fn();
    const onSelection = vi.fn();
    store.subscribeDocument(onDocument);
    store.subscribeHistory(onHistory);
    store.subscribeParameters(onParameters);
    store.subscribeSelection(onSelection);

    const picked = store.pick({ kind: "body", bodyId: TEST_BODY_ID }, false);
    expect(picked.ok).toBe(true);
    expect(onSelection).toHaveBeenCalledTimes(1);
    expect(onDocument).not.toHaveBeenCalled();
    expect(onHistory).not.toHaveBeenCalled();
    expect(onParameters).not.toHaveBeenCalled();
  });

  it("notifies parameters subscribers only when the parameter collection changed", () => {
    const store = createTestStore();
    const onParameters = vi.fn();
    store.subscribeParameters(onParameters);

    expect(store.applyTransaction(createPlateFeature()).ok).toBe(true);
    expect(onParameters).not.toHaveBeenCalled();

    expect(store.applyTransaction(setWidth(14)).ok).toBe(true);
    expect(onParameters).toHaveBeenCalledTimes(1);
  });

  it("notifies history subscribers on commits, undo, and redo, with an accurate view", () => {
    const store = createTestStore();
    const onHistory = vi.fn();
    store.subscribeHistory(onHistory);

    expect(store.getHistoryView()).toEqual({
      canUndo: false,
      canRedo: false,
      cursor: 0,
      depth: 0,
    });

    expect(store.applyTransaction(setWidth(12)).ok).toBe(true);
    expect(store.applyTransaction(setWidth(14)).ok).toBe(true);
    expect(store.getHistoryView()).toEqual({
      canUndo: true,
      canRedo: false,
      cursor: 2,
      depth: 2,
    });

    expect(store.undo().ok).toBe(true);
    expect(store.getHistoryView()).toEqual({
      canUndo: true,
      canRedo: true,
      cursor: 1,
      depth: 2,
    });
    expect(onHistory).toHaveBeenCalledTimes(3);

    expect(store.redo().ok).toBe(true);
    expect(store.getHistoryView().cursor).toBe(2);
    expect(onHistory).toHaveBeenCalledTimes(4);
  });

  it("notifies tools subscribers when the manager surface changes, including tool-issued selection ops", () => {
    const store = createTestStore();
    const onTools = vi.fn();
    const onSelection = vi.fn();
    store.subscribeTools(onTools);
    store.subscribeSelection(onSelection);

    store.activateTool(SELECT_TOOL_ID);
    expect(store.getToolSurface().phase).toBe("active");
    expect(store.getToolSurface().activeToolId).toBe(SELECT_TOOL_ID);
    expect(onTools).toHaveBeenCalledTimes(1);

    // The select tool issues its pick through the context: the store's sync
    // pass observes the runtime change and notifies the selection concern.
    store.dispatchToolEvent({
      type: "pointer-up",
      point: [0, 0, 0],
      pick: {
        reference: { kind: "body", bodyId: TEST_BODY_ID },
        renderObjectId: "rend_plate",
      },
      modifiers: { shift: false, alt: false, ctrl: false, meta: false },
    });
    expect(store.getSelection().selected).toEqual([
      { kind: "body", bodyId: TEST_BODY_ID },
    ]);
    expect(onSelection).toHaveBeenCalledTimes(1);
    // The select tool's state object is a stable singleton (mode tool), so
    // the tools surface is unchanged by the dispatch.
    expect(onTools).toHaveBeenCalledTimes(1);
  });
});

describe("CadStore history and command log", () => {
  it("undo and redo restore documents through the session and refuse structurally", () => {
    const store = createTestStore();
    expect(store.undo()).toMatchObject({
      ok: false,
      error: { code: "history/nothing-to-undo" },
    });

    expect(store.applyTransaction(setWidth(12)).ok).toBe(true);
    const widthAt12 = store.getDocument().parameters;
    expect(store.applyTransaction(setWidth(16)).ok).toBe(true);

    expect(store.undo().ok).toBe(true);
    expect(store.getDocument().parameters).toBe(widthAt12);

    expect(store.redo().ok).toBe(true);
    expect(store.getDocument().parameters).not.toBe(widthAt12);
  });

  it("records every issued transaction in the command log and reports it to onTransaction", () => {
    const issued: string[] = [];
    const store = createTestStore({
      onTransaction: (transaction) => {
        issued.push(JSON.stringify(transaction));
      },
    });

    expect(store.commandLog).toEqual([]);
    const first = setWidth(12);
    expect(store.applyTransaction(first).ok).toBe(true);
    expect(store.applyTransaction(setWidth(14)).ok).toBe(true);

    expect(store.commandLog).toHaveLength(2);
    expect(store.commandLog[0]).toEqual(serializeTransaction(first));
    expect(issued).toHaveLength(2);
    expect(JSON.parse(issued[0] ?? "{}")).toEqual(serializeTransaction(first));

    // History moves are not issues: they add no log entries.
    expect(store.undo().ok).toBe(true);
    expect(store.commandLog).toHaveLength(2);
  });

  it("replaceSession is the one whole-session door and notifies the affected concerns", () => {
    const store = createTestStore();
    const onDocument = vi.fn();
    const onHistory = vi.fn();
    store.subscribeDocument(onDocument);
    store.subscribeHistory(onHistory);

    // The replacement session carries one commit, so the history view moves.
    const next = requireValue(
      applySessionTransaction(createTestSession(), {
        commands: [
          {
            type: "parameter.set",
            id: TEST_WIDTH_PARAMETER,
            value: length(12),
          },
        ],
      }),
      "the replacement session commit",
    );
    store.replaceSession(next);
    expect(store.getSession()).toBe(next);
    expect(onDocument).toHaveBeenCalledTimes(1);
    expect(onHistory).toHaveBeenCalledTimes(1);
    expect(store.getHistoryView().depth).toBe(1);
  });
});

describe("CadStore tool lifecycle", () => {
  it("arm composes cancel-if-active, reset, activate", () => {
    const store = createTestStore();
    store.activateTool(SELECT_TOOL_ID);
    store.armTool("measure");
    expect(store.getToolSurface().activeToolId).toBe("measure");
    expect(store.getToolSurface().phase).toBe("active");
    expect(store.getToolSurface().toolState).toEqual({
      stage: "awaiting-first",
    });
  });

  it("cancel is guarded and idempotent; reset retires terminal phases", () => {
    const store = createTestStore();
    expect(store.cancelTool()).toBe(false);

    store.activateTool(SELECT_TOOL_ID);
    expect(store.cancelTool()).toBe(true);
    expect(store.getToolSurface().phase).toBe("cancelled");
    expect(store.cancelTool()).toBe(false);

    store.resetTool();
    expect(store.getToolSurface().phase).toBe("inactive");
    expect(store.getToolSurface().activeToolId).toBeNull();
  });

  it("surfaces the domain lifecycle contract: dispatch while inactive throws", () => {
    const store = createTestStore();
    expect(() =>
      store.dispatchToolEvent({
        type: "key-down",
        key: "Escape",
        modifiers: { shift: false, alt: false, ctrl: false, meta: false },
      }),
    ).toThrow(RangeError);
  });
});

describe("CadStore immutability surface", () => {
  it("exposes only frozen domain values — feeding raw state back is impossible", () => {
    const store = createTestStore();
    expect(store.applyTransaction(setWidth(12)).ok).toBe(true);

    const document = store.getDocument();
    const selection = store.getSelection();
    const parameters = store.getDocument().parameters;
    expect(Object.isFrozen(document)).toBe(true);
    expect(Object.isFrozen(selection)).toBe(true);
    expect(Object.isFrozen(parameters)).toBe(true);
    expect(Object.isFrozen(store.getSession())).toBe(true);

    // A document is not a transaction: the type system rejects it (pinned
    // by the @ts-expect-error assertions in hooks.test.tsx), and the store
    // has no method that accepts document state at all.
    expect(store.applyTransaction({ commands: [] }).ok).toBe(true);
    expect(createTestStore().getSession().history.cursor).toBe(0);
  });
});
