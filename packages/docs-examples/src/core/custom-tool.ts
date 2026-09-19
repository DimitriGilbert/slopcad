/**
 * The `custom tools` guide's runnable example
 * (docs/guides/custom-tools.md): a complete tool written against the
 * headless tool system — state, a pure event reducer, a registry entry —
 * driven through a real `ToolManager` over the reference
 * `createToolRuntime` host, with no DOM and no React. The example tool is
 * a two-click "stamp" tool: the first click picks the anchor, the second
 * click issues the body-creating transaction and completes with a
 * `commands` completion detail.
 */

import {
  createBodyId,
  createDocument,
  createDocumentId,
  createParameterId,
  createSelectionState,
  createSession,
  createToolManager,
  createToolRuntime,
  length,
  registerTool,
  type CadDocument,
  type CadSession,
  type CadTool,
  type ToolInputEvent,
  type ToolStateBase,
} from "@slopcad/cad-core";

/** The example tool's state: how many clicks it has seen. */
interface StampToolState extends ToolStateBase {
  readonly clicks: number;
}

/**
 * The example tool ("stamp"): `pointer-down` counts a click. The first
 * click picks the anchor under the pointer (single mode) when the pointer
 * carries a pick. The second click issues the stamp transaction through
 * the context — the only document path a tool has — and completes with
 * the transaction as the completion detail.
 */
export const stampTool: CadTool<StampToolState> = {
  id: "guide.stamp",
  initialState: { stage: "await-anchor", clicks: 0 },
  onEvent(state, event: ToolInputEvent, context) {
    if (event.type !== "pointer-down") {
      return { state, phase: "active" };
    }
    const clicks = state.clicks + 1;
    if (clicks === 1) {
      if (event.pick !== null) {
        const picked = context.applySelection({
          type: "pick",
          reference: event.pick.reference,
          additive: false,
        });
        if (!picked.ok) {
          return {
            state: { stage: "failed", clicks },
            phase: "active",
            failure: {
              code: "guide/stamp-pick",
              message: picked.error.message,
            },
          };
        }
      }
      return { state: { stage: "await-target", clicks }, phase: "active" };
    }
    const transaction = {
      commands: [
        {
          type: "body.create",
          id: createBodyId("body_stamp_1"),
          name: "stamp 1",
        },
        {
          type: "parameter.create",
          id: createParameterId("param_stamp_depth_1"),
          name: "stampDepth1",
          value: length(3),
        },
      ],
    } as const;
    const stamped = context.issue(transaction);
    if (!stamped.ok) {
      return {
        state: { stage: "failed", clicks },
        phase: "active",
        failure: {
          code: "guide/stamp-commit",
          message: stamped.error.message,
        },
      };
    }
    return {
      state: { stage: "done", clicks },
      phase: "completed",
      detail: {
        kind: "commands",
        transaction,
        summary: "Stamped one body with a depth parameter.",
      },
    };
  },
};

/** What the example reports back to the guide and the docs page. */
export interface CustomToolExampleSummary {
  readonly toolId: string;
  readonly phases: readonly string[];
  readonly finalPhase: string;
  readonly bodyCount: number;
  readonly parameterCount: number;
  readonly completionSummary: string | null;
}

/** Drives the stamp tool through a real manager and reports the run. */
export function runCustomToolExample(): CustomToolExampleSummary {
  const runtime = createToolRuntime({
    session: sessionOver(createDocument(createDocumentId("doc_guide_stamp"))),
    selection: createSelectionState(0),
  });
  const manager = createToolManager({
    tools: [registerTool(stampTool)],
    context: runtime,
  });

  const phases: string[] = [];
  manager.activate(stampTool.id);
  phases.push(manager.phase);

  // First click over empty space (no pick under the pointer).
  manager.dispatch({
    type: "pointer-down",
    point: [10, 10, 0],
    pick: null,
    modifiers: { alt: false, ctrl: false, meta: false, shift: false },
  });
  phases.push(manager.phase);

  // Second click commits the stamp transaction and completes the tool.
  manager.dispatch({
    type: "pointer-down",
    point: [12, 12, 0],
    pick: null,
    modifiers: { alt: false, ctrl: false, meta: false, shift: false },
  });
  phases.push(manager.phase);

  const document: CadDocument = runtime.session.document;
  const completion = manager.completion;
  return {
    toolId: stampTool.id,
    phases,
    finalPhase: manager.phase,
    bodyCount: document.bodies.length,
    parameterCount: document.parameters.parameters.length,
    completionSummary:
      completion !== null && completion.detail.kind === "commands"
        ? completion.detail.summary
        : null,
  };
}

function sessionOver(document: CadDocument): CadSession {
  return createSession(document);
}
