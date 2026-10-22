/**
 * The model mode's TOOL OPTIONS descriptors — what the TOP′ bar shows for
 * the tool that is armed right now.
 *
 * The bar primitive renders a descriptor and knows no tool; this module is
 * where the cockpit decides what each armed tool offers. It is pure: ids,
 * live facts and callbacks in, one descriptor (or `null`) out, so the
 * mapping is node-testable without mounting the workbench.
 *
 * ## What a tool may claim here
 *
 * Only what the engine can actually do. The four registry tools own one
 * honest lever each today — cancelling the live activation — and the
 * select tool owns a second, clearing the selection; every other option a
 * feature verb takes still lives in its Formedible dialog, and the bar
 * does not pretend otherwise. As the engine grows per-tool state, the
 * descriptors here grow with it; a tool never gets a control the engine
 * cannot honour.
 */

import type {
  ToolOptionsControl,
  ToolOptionsDescriptor,
} from "@slopcad/ui/components/cockpit/tool-options-bar";
import {
  MEASURE_TOOL_ID,
  ROTATE_TOOL_ID,
  SELECT_TOOL_ID,
  TRANSLATE_TOOL_ID,
} from "@slopcad/cad-react";

/** The live facts the descriptors read. */
export interface WorkbenchToolOptionsInput {
  /** The armed tool's id, or `null` when none is. */
  readonly toolId: string | null;
  /** The tool lifecycle phase; only `"active"` is an ARMED tool. */
  readonly phase: string;
  /** How many references the selection holds. */
  readonly selectionCount: number;
  /** Cancels the live activation (the tool's Esc path, as a control). */
  readonly onCancel: () => void;
  /** Clears the selection. */
  readonly onClearSelection: () => void;
}

/** The names the bar prints for the four registry tools. */
const TOOL_LABELS: Readonly<Record<string, string>> = {
  [SELECT_TOOL_ID]: "Select",
  [MEASURE_TOOL_ID]: "Measure",
  [TRANSLATE_TOOL_ID]: "Translate",
  [ROTATE_TOOL_ID]: "Rotate",
};

/** The prompt each tool prints: what the operator does next. */
const TOOL_HINTS: Readonly<Record<string, string>> = {
  [SELECT_TOOL_ID]: "pick geometry in the viewport · Esc cancels",
  [MEASURE_TOOL_ID]: "pick two points or references · Esc cancels",
  [TRANSLATE_TOOL_ID]: "drag a body along an axis · Esc cancels",
  [ROTATE_TOOL_ID]: "drag a body about an axis · Esc cancels",
};

/**
 * The armed tool's bar, or `null` when nothing is armed (or when the armed
 * id is a tool this cockpit has no options vocabulary for — an unknown
 * tool gets no bar rather than an empty one).
 */
export function describeArmedTool(
  input: WorkbenchToolOptionsInput,
): ToolOptionsDescriptor | null {
  if (input.phase !== "active") return null;
  const { toolId } = input;
  if (toolId === null) return null;
  const toolLabel = TOOL_LABELS[toolId];
  const hint = TOOL_HINTS[toolId];
  if (toolLabel === undefined || hint === undefined) return null;

  const controls: ToolOptionsControl[] = [];
  if (toolId === SELECT_TOOL_ID) {
    controls.push({
      kind: "action",
      id: "clear-selection",
      label: "clear",
      disabled: input.selectionCount === 0,
      title:
        input.selectionCount === 0
          ? "Nothing is selected; there is nothing to clear."
          : "Clear the selection without leaving the tool.",
      onRun: input.onClearSelection,
    });
  }
  controls.push({
    kind: "action",
    id: "cancel",
    label: "cancel",
    title: "Cancel the live activation (the same thing Esc does).",
    onRun: input.onCancel,
  });
  return { toolLabel, hint, controls };
}
