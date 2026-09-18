/**
 * Component tests for `CadSketchToolbar` (Phase 25). The toolbar composes
 * the existing Button primitive over prop data, so these tests exercise
 * exactly the component's own decisions: group rendering with the digit
 * shortcut running across groups in order, the pressed state following
 * `activeToolId`, the single activation path shared by click and keyboard,
 * the disabled-tool and inert-strip disciplines, and the label plumbing.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CAD_SKETCH_TOOLBAR_LABELS,
  CadSketchToolbar,
  type CadSketchToolbarProps,
} from "./cad-sketch-toolbar";

afterEach(cleanup);

const GROUPS: CadSketchToolbarProps["groups"] = [
  {
    id: "tools",
    label: "Tools",
    toolIds: ["select", "line", "circle", "rectangle", "trim", "construction"],
  },
  {
    id: "constraints",
    label: "Constraints",
    toolIds: ["horizontal", "vertical", "distance"],
  },
];

/** The button of tool `toolId` (the strip's `data-sketch-tool-id` surface). */
function toolButton(toolId: string): HTMLElement {
  const element = document.querySelector(`[data-sketch-tool-id="${toolId}"]`);
  if (element === null) throw new Error(`no button for tool ${toolId}`);
  return element as HTMLElement;
}

function renderToolbar(props: Partial<CadSketchToolbarProps> = {}) {
  const onActivate = vi.fn();
  const view = render(
    <CadSketchToolbar
      activeToolId="select"
      groups={GROUPS}
      onActivate={onActivate}
      {...props}
    />,
  );
  return { onActivate, view };
}

describe("CadSketchToolbar", () => {
  it("renders labeled groups and every tool button", () => {
    renderToolbar();
    expect(screen.getByRole("group", { name: "Sketch tools" })).toBeDefined();
    expect(screen.getByRole("group", { name: "Tools" })).toBeDefined();
    expect(screen.getByRole("group", { name: "Constraints" })).toBeDefined();
    for (const toolId of ["select", "line", "trim", "horizontal", "distance"]) {
      expect(toolButton(toolId)).toBeDefined();
    }
  });

  it("presses exactly the active tool", () => {
    renderToolbar({ activeToolId: "line" });
    expect(toolButton("line").getAttribute("aria-pressed")).toBe("true");
    for (const toolId of ["select", "circle", "distance"]) {
      expect(toolButton(toolId).getAttribute("aria-pressed")).toBe("false");
    }
  });

  it("activates through clicks and digit keys along one path", () => {
    const { onActivate } = renderToolbar();
    fireEvent.click(toolButton("distance"));
    expect(onActivate).toHaveBeenLastCalledWith("distance");
    // "2" is the second tool across groups (line).
    fireEvent.keyDown(screen.getByRole("group", { name: "Sketch tools" }), {
      key: "2",
    });
    expect(onActivate).toHaveBeenLastCalledWith("line");
    expect(onActivate).toHaveBeenCalledTimes(2);
    // Modified digits are ignored.
    fireEvent.keyDown(screen.getByRole("group", { name: "Sketch tools" }), {
      key: "2",
      ctrlKey: true,
    });
    expect(onActivate).toHaveBeenCalledTimes(2);
  });

  it("renders disabled tools inert and skips them for shortcuts", () => {
    const { onActivate } = renderToolbar({ disabledToolIds: ["trim"] });
    expect(toolButton("trim").hasAttribute("disabled")).toBe(true);
    fireEvent.click(toolButton("trim"));
    expect(onActivate).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("group", { name: "Sketch tools" }), {
      key: "5",
    });
    expect(onActivate).not.toHaveBeenCalled();
  });

  it("is inert without an activation surface: disabled buttons, no activation", () => {
    render(<CadSketchToolbar activeToolId={null} groups={GROUPS} />);
    expect(toolButton("select").hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("group", { name: "Sketch tools" }), {
      key: "1",
    });
    // No activation surface existed to be called; the strip simply rendered.
    expect(
      document.querySelector('[data-sketch-tool-id="line"]'),
    ).not.toBeNull();
  });

  it("falls back to the raw tool id when labels omit a tool", () => {
    render(
      <CadSketchToolbar
        activeToolId={null}
        groups={[{ id: "tools", label: "Tools", toolIds: ["mystery"] }]}
        labels={{ tools: {} }}
      />,
    );
    expect(screen.getByText("mystery")).toBeDefined();
    expect(CAD_SKETCH_TOOLBAR_LABELS.tools.line?.label).toBe("Line");
  });
});
