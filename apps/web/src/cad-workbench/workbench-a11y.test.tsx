/**
 * Accessibility contract tests for the workbench's own chrome (Phase 30):
 * the feature timeline strip's interactive elements (named rollback gaps,
 * pressed-state suppress toggles, the visible-focus ring) and the sketch
 * mode's status line (a polite live region, so editor status and solver
 * refusals are announced) plus its named control groups. These ride the
 * same public surfaces the browser a11y workflows assert.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { ReactElement } from "react";
import type {
  FeatureId,
  FeatureRollbackPoint,
  FeatureTimelineEntry,
} from "@slopcad/cad-react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SketchMode } from "./SketchMode";
import {
  FeatureTimelineChips,
  FeatureTimelineSummary,
} from "./feature-timeline-strip";

afterEach(cleanup);

const FEATURE_ID = "f1" as FeatureId;

const ENTRY: FeatureTimelineEntry = {
  diagnostics: [],
  id: FEATURE_ID,
  kind: "extrude",
  status: "valid",
};

function ChipsHarness(): ReactElement {
  const [rollback, setRollback] = useState<FeatureRollbackPoint | null>(null);
  const [suppressed, setSuppressed] = useState(false);
  return (
    <FeatureTimelineChips
      entries={
        suppressed ? [{ ...ENTRY, status: "suppressed" as const }] : [ENTRY]
      }
      rollback={rollback}
      onRollback={setRollback}
      onToggleSuppressed={() => {
        setSuppressed((current) => !current);
      }}
    />
  );
}

describe("FeatureTimelineChips accessibility", () => {
  it("names the rollback gaps and reports the marker as pressed", () => {
    render(<ChipsHarness />);
    const gap = screen.getByLabelText("Roll back before extrude");
    expect(gap.getAttribute("aria-pressed")).toBe("false");
    // Setting the marker turns the same gap into the removal affordance.
    fireEvent.click(gap);
    expect(
      screen.getByLabelText("Remove rollback point — Roll back before extrude"),
    ).not.toBeNull();
  });

  it("carries a named, pressed-state suppress toggle with the focus ring", () => {
    render(<ChipsHarness />);
    const toggle = screen.getByLabelText("Suppress extrude");
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.className).toContain("focus-visible:ring-1");
    // The pressed state mirrors the suppressed status after activation.
    fireEvent.click(toggle);
    expect(
      screen.getByLabelText("Include extrude").getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("announces the run counter as plain text", () => {
    render(
      <FeatureTimelineSummary
        entries={[ENTRY]}
        executed={[FEATURE_ID]}
        rollback={null}
      />,
    );
    expect(screen.getByTestId("timeline-summary").textContent).toContain(
      "1 executed",
    );
  });
});

describe("SketchMode accessibility", () => {
  it("announces the status line as a polite live region", () => {
    render(<SketchMode onExit={() => {}} onExtrude={() => {}} />);
    const message = screen.getByTestId("sketch-status-message");
    expect(message.getAttribute("aria-live")).toBe("polite");
  });

  it("names the sketch command groups and action buttons", () => {
    render(
      <SketchMode
        onExit={() => {}}
        onExtrude={() => {}}
        onRevolve={() => {}}
      />,
    );
    // The named groups give keyboard users the same map pointer users see.
    expect(screen.getByLabelText("Revolve axis")).not.toBeNull();
    expect(screen.getByLabelText("Sketch history")).not.toBeNull();
    expect(screen.getByLabelText("Sketch tools")).not.toBeNull();
    // Every command-row action carries visible text as its name.
    for (const name of ["Model", "Extrude", "Revolve", "Undo", "Redo"]) {
      expect(screen.getByRole("button", { name })).not.toBeNull();
    }
  });

  it("exposes the solver readout as text, not color alone", () => {
    render(<SketchMode onExit={() => {}} onExtrude={() => {}} />);
    // The solve status renders its label text (the amber coloring of the
    // under-constrained state never carries the status alone).
    expect(screen.getByTestId("sketch-solve-status").textContent).toBe(
      "Solved",
    );
  });

  it("routes the escape key through the editor's escape event", () => {
    const onExit = vi.fn();
    render(<SketchMode onExit={onExit} onExtrude={() => {}} />);
    const root = document.getElementById("sketch-root");
    expect(root).not.toBeNull();
    root?.focus();
    fireEvent.keyDown(root ?? document.body, { key: "Escape" });
    // Escape cancels the in-progress gesture; the mode itself stays.
    expect(onExit).not.toHaveBeenCalled();
  });
});
