/**
 * The TOP′ bar and its rail twin: both render ONE descriptor, so these
 * tests pin the shared contract — a tool with no descriptor renders
 * nothing at all (never an empty strip claiming options), a toggle
 * publishes its state as `aria-pressed`, an action never pretends to have
 * one, a control that cannot run is disabled WITH its reason, and a
 * readout is a value, not a control.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolOptionsDescriptor } from "./tool-options-bar";

import { ToolOptionsBar, ToolOptionsPanel } from "./tool-options-bar";

afterEach(cleanup);

function descriptor(
  overrides: Partial<ToolOptionsDescriptor> = {},
): ToolOptionsDescriptor {
  return {
    toolLabel: "Select",
    hint: "pick geometry in the viewport · Esc cancels",
    controls: [
      {
        kind: "toggle",
        id: "through-all",
        label: "through all",
        pressed: true,
        title: "Cut through the whole body.",
        onToggle: () => {},
      },
      {
        kind: "action",
        id: "clear-selection",
        label: "clear",
        disabled: true,
        title: "Nothing is selected; there is nothing to clear.",
        onRun: () => {},
      },
      { kind: "readout", id: "picked", label: "picked", value: "2" },
    ],
    ...overrides,
  };
}

describe("ToolOptionsBar", () => {
  it("renders nothing without a descriptor", () => {
    const { container } = render(<ToolOptionsBar descriptor={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("names the armed tool, prints its hint, and publishes its state", () => {
    render(<ToolOptionsBar descriptor={descriptor()} />);
    const bar = screen.getByRole("group", { name: "Tool options" });
    expect(bar.getAttribute("data-tool-options")).toBe("Select");
    expect(bar.textContent).toContain(
      "pick geometry in the viewport · Esc cancels",
    );
    expect(
      screen
        .getByRole("button", { name: "through all" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    // A momentary action carries no pressed state at all.
    const clear = screen.getByRole("button", { name: "clear" });
    expect(clear.hasAttribute("aria-pressed")).toBe(false);
    // It cannot run, and it says why instead of disappearing.
    expect(clear.hasAttribute("disabled")).toBe(true);
    expect(clear.getAttribute("title")).toBe(
      "Nothing is selected; there is nothing to clear.",
    );
  });

  it("runs the toggle and the action through their own handlers", () => {
    const onToggle = vi.fn();
    const onRun = vi.fn();
    render(
      <ToolOptionsBar
        descriptor={descriptor({
          controls: [
            {
              kind: "toggle",
              id: "symmetric",
              label: "symmetric",
              pressed: false,
              title: "Grow both ways from the plane.",
              onToggle,
            },
            {
              kind: "action",
              id: "cancel",
              label: "cancel",
              title: "Cancel the live activation.",
              onRun,
            },
          ],
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "symmetric" }));
    fireEvent.click(screen.getByRole("button", { name: "cancel" }));
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onRun).toHaveBeenCalledTimes(1);
  });
});

describe("ToolOptionsPanel", () => {
  it("renders nothing without a descriptor", () => {
    const { container } = render(<ToolOptionsPanel descriptor={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the same descriptor down a rail: readouts become rows", () => {
    render(<ToolOptionsPanel descriptor={descriptor()} />);
    const panel = screen.getByRole("group", { name: "Select options" });
    expect(panel.textContent).toContain("Select");
    expect(panel.textContent).toContain("pick geometry in the viewport");
    // The readout is a property ROW here, not a control.
    const picked = panel.querySelector('[data-tool-option="picked"]');
    expect(picked?.getAttribute("data-slot")).toBe("property-row");
    expect(picked?.textContent).toContain("2");
    // The controls are the same two, with the same published truths.
    expect(
      screen
        .getByRole("button", { name: "through all" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: "clear" }).hasAttribute("disabled"),
    ).toBe(true);
  });
});
