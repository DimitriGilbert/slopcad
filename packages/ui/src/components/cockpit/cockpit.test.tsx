import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Panel, PanelBody, PanelHeader, PanelSection } from "./panel";
import { PropertyRow, Readout, StatusDot } from "./property-row";
import { KeyCap, ToolButton, ToolGroup } from "./tool-button";

afterEach(cleanup);

describe("Panel", () => {
  it("names its elevation rung so the ramp is inspectable", () => {
    const { container } = render(<Panel elevation="overlay">body</Panel>);
    const panel = container.querySelector("[data-slot='panel']");
    expect(panel?.getAttribute("data-elevation")).toBe("overlay");
    expect(panel?.classList.contains("bg-overlay")).toBe(true);
  });

  it("is furniture, not document structure, unless asked", () => {
    const { rerender } = render(<PanelHeader title="Model tree" />);
    expect(screen.queryByRole("heading")).toBeNull();
    rerender(<PanelHeader title="Model tree" titleAs="h2" />);
    expect(screen.getByRole("heading", { name: "Model tree" })).not.toBeNull();
  });

  it("renders a trailing slot only when one is given", () => {
    const { container, rerender } = render(<PanelHeader title="Properties" />);
    expect(
      container.querySelector("[data-slot='panel-header-trailing']"),
    ).toBeNull();
    rerender(<PanelHeader title="Properties" trailing={3} />);
    expect(
      container.querySelector("[data-slot='panel-header-trailing']")
        ?.textContent,
    ).toBe("3");
  });

  it("scrolls in the body and only pads when inset", () => {
    const { container, rerender } = render(<PanelBody>rows</PanelBody>);
    const body = container.querySelector("[data-slot='panel-body']");
    expect(body?.classList.contains("overflow-y-auto")).toBe(true);
    expect(body?.classList.contains("p-(--pad-panel)")).toBe(false);
    rerender(<PanelBody inset>prose</PanelBody>);
    expect(
      container
        .querySelector("[data-slot='panel-body']")
        ?.classList.contains("p-(--pad-panel)"),
    ).toBe(true);
  });

  it("stacks sections inside one panel without a second surface", () => {
    const { container } = render(
      <PanelSection title="Measurement">
        <PropertyRow label="Volume">5501.553</PropertyRow>
      </PanelSection>,
    );
    const section = container.querySelector("[data-slot='panel-section']");
    expect(section).not.toBeNull();
    expect(section?.className).not.toContain("bg-panel");
  });

  it("is a plain named group until asked to disclose", () => {
    const { container } = render(
      <PanelSection title="Measurement">
        <PropertyRow label="Volume">5501.553</PropertyRow>
      </PanelSection>,
    );
    expect(
      container.querySelector("[data-slot='panel-section-toggle']"),
    ).toBeNull();
    expect(
      container
        .querySelector("[data-slot='panel-section']")
        ?.getAttribute("data-state"),
    ).toBeNull();
  });

  it("discloses through a labelled button that publishes its state", () => {
    const { container } = render(
      <PanelSection collapsible id="rail-measure" title="Measurement">
        <PropertyRow label="Volume">5501.553</PropertyRow>
      </PanelSection>,
    );
    const toggle = screen.getByRole("button", { name: "Measurement" });
    const section = container.querySelector("[data-slot='panel-section']");
    const content = container.querySelector(
      "[data-slot='panel-section-content']",
    );

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe("rail-measure-content");
    expect(content?.id).toBe("rail-measure-content");
    expect(section?.getAttribute("data-state")).toBe("open");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(section?.getAttribute("data-state")).toBe("closed");
    // Hidden, never unmounted: a closed section keeps its content's state.
    expect(content?.className).toBe("hidden");
    expect(screen.getByText("5501.553")).not.toBeNull();
  });

  it("honours a controlled open state and reports every toggle", () => {
    const seen: boolean[] = [];
    render(
      <PanelSection
        collapsible
        onOpenChange={(next) => seen.push(next)}
        open={false}
        title="Parameters"
      >
        <PropertyRow label="width">20</PropertyRow>
      </PanelSection>,
    );
    const toggle = screen.getByRole("button", { name: "Parameters" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    // Controlled: the prop still wins, and the host heard the request.
    expect(seen).toEqual([true]);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps a trailing control outside the disclosure button", () => {
    render(
      <PanelSection
        collapsible
        title="Selection"
        trailing={<button type="button">clear</button>}
      >
        rows
      </PanelSection>,
    );
    const toggle = screen.getByRole("button", { name: "Selection" });
    const clear = screen.getByRole("button", { name: "clear" });
    expect(toggle.contains(clear)).toBe(false);
  });
});

describe("ToolButton", () => {
  it("defaults to a non-submitting button", () => {
    render(<ToolButton>Extrude</ToolButton>);
    expect(
      screen.getByRole("button", { name: "Extrude" }).getAttribute("type"),
    ).toBe("button");
  });

  it("carries the armed truth in the accessibility tree", () => {
    render(<ToolButton aria-pressed>Select</ToolButton>);
    expect(screen.getByRole("button", { pressed: true })).not.toBeNull();
  });

  it("leaves momentary actions unpressed", () => {
    render(<ToolButton>Undo</ToolButton>);
    const button = screen.getByRole("button", { name: "Undo" });
    expect(button.getAttribute("aria-pressed")).toBeNull();
  });

  it("disables natively and stops pointer events", () => {
    render(<ToolButton disabled>Redo</ToolButton>);
    const button = screen.getByRole("button", { name: "Redo" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.classList.contains("disabled:pointer-events-none")).toBe(
      true,
    );
  });

  it("names a tool group for assistive technology", () => {
    render(
      <ToolGroup label="Sketch tools">
        <ToolButton>Line</ToolButton>
      </ToolGroup>,
    );
    expect(screen.getByRole("group", { name: "Sketch tools" })).not.toBeNull();
  });

  it("keeps key caps out of the accessible name", () => {
    render(
      <ToolButton aria-keyshortcuts="s">
        Select
        <KeyCap>S</KeyCap>
      </ToolButton>,
    );
    const button = screen.getByRole("button", { name: "Select" });
    expect(button.getAttribute("aria-keyshortcuts")).toBe("s");
  });
});

describe("PropertyRow", () => {
  it("pairs a label with a tabular value on one line", () => {
    const { container } = render(
      <PropertyRow label="Diameter" unit="mm">
        8.000
      </PropertyRow>,
    );
    expect(
      container.querySelector("[data-slot='property-label']")?.textContent,
    ).toBe("Diameter");
    const value = container.querySelector("[data-slot='property-value']");
    expect(value?.textContent).toBe("8.000mm");
    expect(value?.classList.contains("tabular")).toBe(true);
  });

  it("publishes selection as state, not just as colour", () => {
    const { container, rerender } = render(
      <PropertyRow label="plate">body</PropertyRow>,
    );
    const row = () => container.querySelector("[data-slot='property-row']");
    expect(row()?.getAttribute("data-selected")).toBeNull();
    rerender(
      <PropertyRow label="plate" selected>
        body
      </PropertyRow>,
    );
    expect(row()?.getAttribute("data-selected")).toBe("true");
    expect(row()?.classList.contains("bg-select-wash")).toBe(true);
  });

  it("omits the unit element entirely when there is no unit", () => {
    const { container } = render(<PropertyRow label="Name">plate</PropertyRow>);
    expect(
      container.querySelector("[data-slot='property-value']")?.textContent,
    ).toBe("plate");
  });
});

describe("Readout", () => {
  it("prints a dim name and a mono value", () => {
    const { container } = render(
      <Readout label="vol" unit="mm³">
        5501.553
      </Readout>,
    );
    const readout = container.querySelector("[data-slot='readout']");
    expect(readout?.textContent).toBe("vol5501.553mm³");
  });
});

describe("StatusDot", () => {
  it("never communicates by hue alone", () => {
    render(<StatusDot tone="ok" label="valid" />);
    expect(screen.getByText("valid").classList.contains("sr-only")).toBe(true);
  });

  it("names its tone for inspection and picks that tone's lamp", () => {
    const { container } = render(<StatusDot tone="error" label="failed" />);
    const dot = container.querySelector("[data-slot='status-dot']");
    expect(dot?.getAttribute("data-tone")).toBe("error");
    expect(
      dot
        ?.querySelector("[aria-hidden='true']")
        ?.classList.contains("bg-destructive"),
    ).toBe(true);
  });
});
