/**
 * The SELECT tool (Phase 13): pointer-driven selection through the Phase 12
 * selection model. It has no gesture state — it is a mode tool that stays
 * active until cancelled — and its entire behavior is two issued operations:
 *
 * - **Click** (`pointer-up` with a pick): issues a `pick` operation —
 *   single mode (replace) without Shift, multi mode (toggle) with Shift —
 *   exactly the fixture's documented Phase 12 semantics, now routed through
 *   the tool context.
 * - **Pointer move**: issues the `hover` operation (the pick under the
 *   pointer, or `null` when it left the model). Hover is pointer feedback
 *   and never touches the selection.
 *
 * A click that misses the geometry is a no-op: the tool never synthesizes a
 * reference, and clearing the selection stays an explicit host operation.
 *
 * ## How selection ops ride the command discipline
 *
 * Selection is Phase 12 session data, not document data — it has no
 * transaction history — so the tool does not issue `CadCommand`s for it.
 * Instead it issues serializable `ToolSelectionOperation` data through
 * {@link ToolContext.applySelection}, which applies the pure, immutable
 * Phase 12 operations; a structured failure (e.g. a stale synthetic
 * reference) leaves the state untouched and is reported as the transition's
 * failure. The tool itself never constructs, copies, or mutates a
 * `SelectionState` — the same issue-don't-mutate rule commands follow, one
 * level up. See `tool-context.ts` for the full contract.
 */

import type { CadTool, ToolStateBase, ToolTransition } from "./tool-manager";
import type { ToolContext } from "./tool-context";
import type { ToolInputEvent } from "./tool-events";

/** The select tool's state: a mode tool with no gesture accumulation. */
export interface SelectToolState extends ToolStateBase {
  readonly stage: "ready";
}

const READY_STATE: SelectToolState = Object.freeze({ stage: "ready" });

/** The tool id of {@link selectTool}. */
export const SELECT_TOOL_ID = "select";

/**
 * The SELECT tool: click replaces the selection, shift-click toggles,
 * pointer moves drive the hover, misses are no-ops. Never completes — it
 * stays active until the manager cancels it.
 */
export const selectTool: CadTool<SelectToolState> = {
  id: SELECT_TOOL_ID,
  initialState: READY_STATE,
  onEvent(
    state: SelectToolState,
    event: ToolInputEvent,
    context: ToolContext,
  ): ToolTransition<SelectToolState> {
    if (event.type === "pointer-up") {
      if (event.pick === null) {
        return { state, phase: "active" };
      }
      const applied = context.applySelection({
        type: "pick",
        reference: event.pick.reference,
        additive: event.modifiers.shift,
      });
      if (!applied.ok) {
        return {
          state,
          phase: "active",
          failure: { code: applied.error.code, message: applied.error.message },
        };
      }
      return { state, phase: "active" };
    }
    if (event.type === "pointer-move") {
      const applied = context.applySelection({
        type: "hover",
        reference: event.pick === null ? null : event.pick.reference,
      });
      if (!applied.ok) {
        return {
          state,
          phase: "active",
          failure: { code: applied.error.code, message: applied.error.message },
        };
      }
    }
    // pointer-down, key-down, key-up: selection is click-driven and
    // keyboard-free; both are no-ops.
    return { state, phase: "active" };
  },
};
