/**
 * The tool-options descriptors: the TOP′ bar exists only for an ARMED
 * tool, it names the tool it belongs to, and it never offers a control the
 * engine cannot honour.
 */

import {
  MEASURE_TOOL_ID,
  ROTATE_TOOL_ID,
  SELECT_TOOL_ID,
  TRANSLATE_TOOL_ID,
} from "@slopcad/cad-react";
import { describe, expect, it, vi } from "vitest";

import {
  describeArmedTool,
  type WorkbenchToolOptionsInput,
} from "./tool-options";

function input(
  overrides: Partial<WorkbenchToolOptionsInput> = {},
): WorkbenchToolOptionsInput {
  return {
    toolId: SELECT_TOOL_ID,
    phase: "active",
    selectionCount: 0,
    onCancel: () => {},
    onClearSelection: () => {},
    ...overrides,
  };
}

describe("describeArmedTool", () => {
  it("describes nothing unless a tool is live", () => {
    expect(describeArmedTool(input({ phase: "idle" }))).toBeNull();
    expect(describeArmedTool(input({ phase: "completed" }))).toBeNull();
    expect(describeArmedTool(input({ toolId: null }))).toBeNull();
  });

  it("describes nothing for a tool it has no vocabulary for", () => {
    // An unknown tool gets NO bar rather than an empty one claiming it has
    // options — the bar is never a surface that invents affordances.
    expect(describeArmedTool(input({ toolId: "fillet" }))).toBeNull();
  });

  it("names each registry tool and prompts for its next gesture", () => {
    for (const toolId of [
      SELECT_TOOL_ID,
      MEASURE_TOOL_ID,
      TRANSLATE_TOOL_ID,
      ROTATE_TOOL_ID,
    ]) {
      const descriptor = describeArmedTool(input({ toolId }));
      expect(descriptor?.toolLabel).not.toBe("");
      expect(descriptor?.hint).toContain("Esc cancels");
    }
  });

  it("gives every armed tool the cancel lever, and only select the clear", () => {
    const select = describeArmedTool(input({ selectionCount: 2 }));
    expect(select?.controls.map((control) => control.id)).toEqual([
      "clear-selection",
      "cancel",
    ]);
    const rotate = describeArmedTool(input({ toolId: ROTATE_TOOL_ID }));
    expect(rotate?.controls.map((control) => control.id)).toEqual(["cancel"]);
  });

  it("disables the clear with its reason rather than hiding it", () => {
    const clear = describeArmedTool(input({ selectionCount: 0 }))?.controls[0];
    expect(clear?.kind).toBe("action");
    if (clear?.kind !== "action")
      throw new Error("unreachable: asserted above");
    expect(clear.disabled).toBe(true);
    expect(clear.title).toContain("nothing to clear");
    const full = describeArmedTool(input({ selectionCount: 1 }))?.controls[0];
    expect(full?.kind === "action" ? full.disabled : null).toBe(false);
  });

  it("wires each control to the callback it claims", () => {
    const onCancel = vi.fn();
    const onClearSelection = vi.fn();
    const descriptor = describeArmedTool(
      input({ onCancel, onClearSelection, selectionCount: 1 }),
    );
    for (const control of descriptor?.controls ?? []) {
      if (control.kind === "action") control.onRun();
    }
    expect(onClearSelection).toHaveBeenCalledTimes(1);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
