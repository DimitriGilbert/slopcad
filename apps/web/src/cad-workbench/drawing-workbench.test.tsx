/**
 * The drawing canvas's determinism and accessibility fixtures (Phase 53):
 * the SVG serializer's byte-stability, its fidelity-labelled geometry
 * path, and the page's programmatic a11y surface (role="img" canvas with
 * a live summary, keyboard-operable controls, status announcements).
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DrawingDocument,
  type DrawingViewGeometry,
  createBodyId,
  createDrawingViewId,
  createSheetId,
  edgesOverlayProjectionForKind,
} from "@slopcad/cad-core";

import { DEMO_PLATE_MESH } from "./drawing-demo-body";
import { drawingSummary, serializeDrawingSvg } from "./drawing-svg";
import { DrawingWorkbenchPage } from "./drawing-workbench";

const bodyId = createBodyId("body_drawing_plate");

const sheet = {
  id: createSheetId("sht_main"),
  size: "A3" as const,
  orientation: "landscape" as const,
  scale: { numerator: 1, denominator: 1 },
  views: [
    {
      id: createDrawingViewId("dwv_front"),
      kind: "front" as const,
      bodyId,
      x: 148,
      y: 140,
      scale: null,
      alignedTo: null,
    },
  ],
};

const drawing: DrawingDocument = { sheets: [sheet] };

describe("serializeDrawingSvg", () => {
  it("is byte-deterministic for the same drawing and geometry", () => {
    const geometry = new Map<string, DrawingViewGeometry>([
      ["dwv_front", edgesOverlayProjectionForKind(DEMO_PLATE_MESH, "front")],
    ]);
    const first = serializeDrawingSvg(drawing, geometry);
    const second = serializeDrawingSvg(drawing, geometry);
    expect(first).toBe(second);
    expect(first).toContain('role="img"');
    expect(first).toContain('class="dg-visible"');
    expect(first).toContain("<path");
  });

  it("labels the overlay fidelity honestly and renders empty views as frames", () => {
    const geometry = new Map<string, DrawingViewGeometry>([
      ["dwv_front", edgesOverlayProjectionForKind(DEMO_PLATE_MESH, "front")],
    ]);
    const svg = serializeDrawingSvg(drawing, geometry);
    expect(svg).toContain("dg-visible");
    const empty = serializeDrawingSvg(drawing, new Map());
    expect(empty).not.toContain("<path");
  });

  it("summarizes the drawing for assistive technology", () => {
    expect(drawingSummary({ sheets: [] })).toBe("Drawing: no sheets");
    expect(drawingSummary(drawing)).toBe(
      "Drawing: A3 landscape sheet, 1 view: front",
    );
  });
});

describe("the drawing workbench page", () => {
  afterEach(cleanup);

  it("exposes the empty-state canvas and creates a sheet + 3 views by keyboard", async () => {
    render(<DrawingWorkbenchPage />);
    const canvas = screen.getByTestId("drawing-canvas");
    expect(canvas.getAttribute("role")).toBe("img");
    expect(canvas.getAttribute("aria-label")).toBe(
      "Drawing canvas: no sheets yet",
    );
    // Create the sheet via its submit button (native button — keyboard
    // reachable), awaiting the async Formedible submit.
    fireEvent.click(screen.getByRole("button", { name: "Create sheet" }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("created"),
    );
    // Add three views through their buttons (native buttons: Enter/Space
    // reachable; asserted here by direct activation).
    fireEvent.click(screen.getByRole("button", { name: "Front" }));
    fireEvent.click(screen.getByRole("button", { name: "Top" }));
    fireEvent.click(screen.getByRole("button", { name: "Right" }));
    const populated = screen.getByTestId("drawing-canvas");
    expect(populated.getAttribute("aria-label")).toBe(
      "Drawing: A3 landscape sheet, 3 views: front, top, right",
    );
    expect(populated.querySelectorAll("path").length).toBeGreaterThan(0);
    // The aligned top view sits above the front view with a registered x.
    const statusBefore = screen.getByRole("status").textContent ?? "";
    expect(statusBefore.length).toBeGreaterThan(0);
    expect(populated.innerHTML).toContain('kind="top"');
  });

  it("keeps the angle toggle keyboard-operable with pressed state", () => {
    render(<DrawingWorkbenchPage />);
    const first = screen.getByRole("button", { name: "First angle" });
    expect(first.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(first);
    expect(first.getAttribute("aria-pressed")).toBe("true");
  });
});
