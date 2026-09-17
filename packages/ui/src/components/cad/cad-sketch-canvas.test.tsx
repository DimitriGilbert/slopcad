/**
 * Component tests for `CadSketchCanvas` (Phase 25): the pure display and
 * hit-test contract — workplane-to-screen transform (y flipped), construction
 * and selection styling, the semantic pick event carrying workplane mm plus
 * the topmost entity under the pointer, arc sweep hit restriction, and the
 * machine attributes per entity.
 */

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CadSketchCanvas,
  type CadSketchCanvasEntity,
} from "./cad-sketch-canvas";

afterEach(cleanup);

const ORIGIN = { x: 100, y: 200 };
const SCALE = 4;

const ENTITIES: readonly CadSketchCanvasEntity[] = [
  {
    id: "skent_a",
    kind: "line",
    x1: 0,
    y1: 0,
    x2: 50,
    y2: 0,
    construction: false,
    selected: false,
    diagnostic: "none",
  },
  {
    id: "skent_b",
    kind: "circle",
    cx: 25,
    cy: 30,
    radius: 10,
    construction: true,
    selected: true,
    diagnostic: "warning",
  },
  {
    id: "skent_c",
    kind: "point",
    x: 50,
    y: 0,
    construction: false,
    selected: false,
    diagnostic: "error",
  },
];

function renderCanvas(props = {}) {
  const onPick = vi.fn();
  const onHover = vi.fn();
  const view = render(
    <CadSketchCanvas
      entities={ENTITIES}
      gridStep={10}
      height={400}
      labels={{ workplaneBadge: "XY" }}
      onHover={onHover}
      onPick={onPick}
      origin={ORIGIN}
      scale={SCALE}
      width={600}
      {...props}
    />,
  );
  const svg = view.container.querySelector("svg");
  if (svg === null) throw new Error("the canvas must render an svg");
  return { onHover, onPick, svg, view };
}

/** Fires a pointer event at given CLIENT coordinates (jsdom, no layout). */
function firePointer(
  svg: Element,
  type: "pointerdown" | "pointermove",
  clientX: number,
  clientY: number,
): void {
  svg.getBoundingClientRect = () =>
    new DOMRect(0, 0, 600, 400);
  fireEvent(svg, new MouseEvent(type, { bubbles: true, clientX, clientY }));
}

describe("CadSketchCanvas", () => {
  it("renders every entity with its machine attributes and construction styling", () => {
    const { view } = renderCanvas();
    const line = view.container.querySelector('[data-sketch-entity-id="skent_a"]');
    expect(line?.getAttribute("data-sketch-construction")).toBeNull();
    expect(line?.getAttribute("data-sketch-selected")).toBeNull();
    expect(line?.getAttribute("data-sketch-diagnostic")).toBe("none");
    const circle = view.container.querySelector(
      '[data-sketch-entity-id="skent_b"]',
    );
    expect(circle?.getAttribute("data-sketch-construction")).toBe("true");
    expect(circle?.getAttribute("data-sketch-selected")).toBe("true");
    expect(circle?.getAttribute("data-sketch-diagnostic")).toBe("warning");
    const point = view.container.querySelector(
      '[data-sketch-entity-id="skent_c"]',
    );
    expect(point?.getAttribute("data-sketch-diagnostic")).toBe("error");
    expect(
      view.container.querySelector('[data-slot="cad-sketch-canvas"]'),
    ).not.toBeNull();
  });

  it("maps screen y down: the origin renders at (origin.x, origin.y)", () => {
    const { view } = renderCanvas();
    const line = view.container.querySelector('[data-sketch-entity-id="skent_a"]');
    // Workplane (0,0) → screen (100, 200); (50,0) → (300, 200).
    expect(line?.getAttribute("x1")).toBe("100");
    expect(line?.getAttribute("y1")).toBe("200");
    expect(line?.getAttribute("x2")).toBe("300");
    expect(line?.getAttribute("y2")).toBe("200");
  });

  it("emits picks in workplane mm with the topmost entity hit", () => {
    const { onPick, svg } = renderCanvas();
    // A click at client (100, 200) is workplane (0, 0) — on line a and point
    // distance > tolerance; the line is the hit.
    firePointer(svg, "pointerdown", 100, 200);
    expect(onPick).toHaveBeenCalledTimes(1);
    const pick = onPick.mock.calls[0]?.[0] as {
      entityId: string | null;
      point: { x: number; y: number };
    };
    expect(pick.entityId).toBe("skent_a");
    expect(pick.point.x).toBeCloseTo(0, 6);
    expect(pick.point.y).toBeCloseTo(0, 6);

    // A click at client (304, 200) is workplane (51, 0): within 8px of point
    // skent_c (the topmost entity, later in the view model).
    firePointer(svg, "pointerdown", 304, 200);
    const second = onPick.mock.calls[1]?.[0] as { entityId: string | null };
    expect(second.entityId).toBe("skent_c");

    // Empty canvas: no entity within tolerance.
    firePointer(svg, "pointerdown", 550, 50);
    const third = onPick.mock.calls[2]?.[0] as { entityId: string | null };
    expect(third.entityId).toBeNull();
  });

  it("reports hovers as entity ids and clears them off-geometry", () => {
    const { onHover, svg } = renderCanvas();
    firePointer(svg, "pointermove", 100, 200);
    expect(onHover).toHaveBeenLastCalledWith("skent_a");
    firePointer(svg, "pointermove", 550, 50);
    expect(onHover).toHaveBeenLastCalledWith(null);
  });

  it("restricts arc hits to the arc's sweep", () => {
    // A quarter arc from angle 0 to π/2 about (0,0) r=25.
    const arcOnly: readonly CadSketchCanvasEntity[] = [
      {
        id: "skent_arc",
        kind: "arc",
        cx: 0,
        cy: 0,
        radius: 25,
        startAngle: 0,
        endAngle: Math.PI / 2,
        construction: false,
        selected: false,
        diagnostic: "none",
      },
    ];
    const { onPick, svg } = renderCanvas({ entities: arcOnly });
    // On the rim at angle π/4: workplane ≈ (17.68, 17.68) → screen
    // (100 + 70.7, 200 − 70.7).
    firePointer(svg, "pointerdown", 170.7, 129.3);
    const hit = onPick.mock.calls[0]?.[0] as { entityId: string | null };
    expect(hit.entityId).toBe("skent_arc");
    // On the rim at angle 3π/4 (outside the sweep): no hit.
    firePointer(svg, "pointerdown", 100 - 70.7, 200 - 70.7);
    const missed = onPick.mock.calls[1]?.[0] as { entityId: string | null };
    expect(missed.entityId).toBeNull();
  });

  it("renders picks, preview, regions, and annotations as machine-addressable nodes", () => {
    const { view } = renderCanvas({
      annotations: [
        { id: "dim1", kind: "dimension", level: "info", text: "60 mm", x: 25, y: -5 },
      ],
      picks: [{ x: 10, y: 10 }],
      preview: { from: { x: 0, y: 0 }, kind: "line", to: { x: 30, y: 20 } },
      regions: [
        {
          diagnostic: "none",
          id: "skent_rect",
          points: [
            { x: 0, y: 0 },
            { x: 50, y: 0 },
            { x: 50, y: 40 },
            { x: 0, y: 40 },
          ],
          selected: false,
        },
      ],
    });
    expect(
      view.container.querySelector('[data-sketch-annotation-id="dim1"]'),
    ).not.toBeNull();
    expect(
      view.container.querySelector('[data-sketch-region-id="skent_rect"]'),
    ).not.toBeNull();
    expect(view.container.textContent).toContain("60 mm");
    expect(view.container.textContent).toContain("XY");
  });
});
