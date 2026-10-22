/**
 * `ToolStrip` contract tests: the strip is a NAMED toolbar, its trailing
 * cluster is always rendered (never hidden by width), and its arrow-key
 * model moves focus without taking the native tab stops away.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ToolButton, ToolGroup } from "./tool-button";
import { ToolStrip } from "./tool-strip";

afterEach(cleanup);

function renderStrip(): HTMLElement {
  render(
    <ToolStrip
      label="Model tools"
      overflow={
        <ToolGroup label="More">
          <ToolButton aria-label="Surface">s</ToolButton>
        </ToolGroup>
      }
    >
      <ToolGroup label="History">
        <ToolButton aria-label="Undo">u</ToolButton>
        <ToolButton aria-label="Redo" disabled>
          r
        </ToolButton>
      </ToolGroup>
      <ToolGroup label="File">
        <ToolButton aria-label="Import">i</ToolButton>
      </ToolGroup>
    </ToolStrip>,
  );
  return screen.getByRole("toolbar", { name: "Model tools" });
}

describe("ToolStrip", () => {
  it("is a named horizontal toolbar containing its named clusters", () => {
    const strip = renderStrip();
    expect(strip.getAttribute("aria-orientation")).toBe("horizontal");
    expect(screen.getByRole("group", { name: "History" })).not.toBeNull();
    expect(screen.getByRole("group", { name: "File" })).not.toBeNull();
  });

  it("renders the trailing cluster unconditionally", () => {
    const strip = renderStrip();
    // The zone invariant: no control hides by viewport width. The overflow
    // cluster is DOM-present at every width, pinned to the inline end.
    const overflow = strip.querySelector("[data-slot='tool-strip-overflow']");
    expect(overflow).not.toBeNull();
    expect(screen.getByRole("button", { name: "Surface" })).not.toBeNull();
  });

  it("omits the trailing cluster element when no overflow is given", () => {
    const { container } = render(
      <ToolStrip label="Bare">
        <ToolGroup label="History">
          <ToolButton aria-label="Undo">u</ToolButton>
        </ToolGroup>
      </ToolStrip>,
    );
    expect(
      container.querySelector("[data-slot='tool-strip-overflow']"),
    ).toBeNull();
  });

  it("walks enabled controls with the arrow keys, skipping disabled ones", () => {
    const strip = renderStrip();
    const undo = screen.getByRole("button", { name: "Undo" });
    const importButton = screen.getByRole("button", { name: "Import" });
    undo.focus();
    // Redo is disabled, so the next stop is Import — a disabled control is
    // never a focus stop, and it is never hidden either.
    fireEvent.keyDown(strip, { key: "ArrowRight" });
    expect(document.activeElement).toBe(importButton);
    fireEvent.keyDown(strip, { key: "ArrowLeft" });
    expect(document.activeElement).toBe(undo);
  });

  it("jumps to the ends with Home and End, wrapping with the arrows", () => {
    const strip = renderStrip();
    const undo = screen.getByRole("button", { name: "Undo" });
    const surface = screen.getByRole("button", { name: "Surface" });
    fireEvent.keyDown(strip, { key: "End" });
    expect(document.activeElement).toBe(surface);
    // Past the end is the beginning: the strip is a ring.
    fireEvent.keyDown(strip, { key: "ArrowRight" });
    expect(document.activeElement).toBe(undo);
    fireEvent.keyDown(strip, { key: "Home" });
    expect(document.activeElement).toBe(undo);
  });

  it("leaves every control a native tab stop", () => {
    renderStrip();
    // A roving tabindex would have put tabindex="-1" on all but one; the
    // cockpit's keyboard journey tabs through the row, so it must not.
    for (const name of ["Undo", "Import", "Surface"]) {
      expect(
        screen.getByRole("button", { name }).hasAttribute("tabindex"),
      ).toBe(false);
    }
  });

  it("yields to a host key handler that claims the key first", () => {
    const onKeyDown = vi.fn<(event: { preventDefault: () => void }) => void>(
      (event) => {
        event.preventDefault();
      },
    );
    render(
      <ToolStrip label="Guarded" onKeyDown={onKeyDown}>
        <ToolGroup label="History">
          <ToolButton aria-label="Undo">u</ToolButton>
          <ToolButton aria-label="Redo">r</ToolButton>
        </ToolGroup>
      </ToolStrip>,
    );
    const undo = screen.getByRole("button", { name: "Undo" });
    undo.focus();
    fireEvent.keyDown(screen.getByRole("toolbar", { name: "Guarded" }), {
      key: "ArrowRight",
    });
    expect(onKeyDown).toHaveBeenCalled();
    expect(document.activeElement).toBe(undo);
  });

  it("ignores modified and unclaimed keys", () => {
    const strip = renderStrip();
    const undo = screen.getByRole("button", { name: "Undo" });
    undo.focus();
    fireEvent.keyDown(strip, { key: "ArrowRight", ctrlKey: true });
    fireEvent.keyDown(strip, { key: "k" });
    expect(document.activeElement).toBe(undo);
  });
});
