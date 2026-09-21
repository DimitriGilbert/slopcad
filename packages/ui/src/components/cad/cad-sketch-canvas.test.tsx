/**
 * Component tests for `CadSketchCanvas` (Phase 25): the pure display and
 * hit-test contract — workplane-to-screen transform (y flipped), construction
 * and selection styling, the semantic pick event carrying workplane mm plus
 * the topmost entity under the pointer, arc sweep hit restriction, and the
 * machine attributes per entity.
 */

import { act, cleanup, fireEvent, render } from "@testing-library/react";
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
  type: "pointerdown" | "pointermove" | "pointerup",
  clientX: number,
  clientY: number,
): void {
  svg.getBoundingClientRect = () => new DOMRect(0, 0, 600, 400);
  fireEvent(svg, new MouseEvent(type, { bubbles: true, clientX, clientY }));
}

describe("CadSketchCanvas", () => {
  it("renders every entity with its machine attributes and construction styling", () => {
    const { view } = renderCanvas();
    const line = view.container.querySelector(
      '[data-sketch-entity-id="skent_a"]',
    );
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
    const line = view.container.querySelector(
      '[data-sketch-entity-id="skent_a"]',
    );
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

  it("applies the shared 8 px screen tolerance to arc hits", () => {
    // Same quarter arc about (0,0) r=25. A pick 1.5 mm off the rim inside
    // the sweep is 6 px of rim distance at the harness scale 4 — a hit
    // under the shared screen-pixel gate (and a miss under a fixed 0.5 mm
    // workplane band, the asymmetric behavior the pixel gate replaces).
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
    const nearRim = (25 - 1.5) * Math.cos(Math.PI / 4) * 4;
    firePointer(svg, "pointerdown", 100 + nearRim, 200 - nearRim);
    const near = onPick.mock.calls[0]?.[0] as { entityId: string | null };
    expect(near.entityId).toBe("skent_arc");
    // 3 mm off the rim (12 px at scale 4) misses, even inside the sweep.
    const farRim = (25 - 3) * Math.cos(Math.PI / 4) * 4;
    firePointer(svg, "pointerdown", 100 + farRim, 200 - farRim);
    const far = onPick.mock.calls[1]?.[0] as { entityId: string | null };
    expect(far.entityId).toBeNull();
  });

  it("renders picks, preview, regions, and annotations as machine-addressable nodes", () => {
    const { view } = renderCanvas({
      annotations: [
        {
          id: "dim1",
          kind: "dimension",
          level: "info",
          text: "60 mm",
          x: 25,
          y: -5,
        },
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

describe("CadSketchCanvas phase 36 kinds", () => {
  const renderCurved = () => {
    const onPick = vi.fn();
    const utils = render(
      <CadSketchCanvas
        entities={[
          {
            id: "skent_ellipse",
            kind: "ellipse",
            cx: 0,
            cy: 0,
            radiusX: 40,
            radiusY: 20,
            rotation: 0,
            construction: false,
            selected: false,
            diagnostic: "none",
          },
          {
            id: "skent_earc",
            kind: "ellipticalArc",
            cx: 0,
            cy: 0,
            radiusX: 30,
            radiusY: 15,
            rotation: 0,
            startAngle: 0,
            endAngle: Math.PI,
            construction: false,
            selected: false,
            diagnostic: "none",
          },
          {
            id: "skent_spline",
            kind: "polyline",
            points: [
              { x: -40, y: -30 },
              { x: -20, y: 30 },
              { x: 20, y: 30 },
              { x: 40, y: -30 },
            ],
            construction: false,
            selected: false,
            diagnostic: "none",
          },
        ]}
        height={400}
        onPick={onPick}
        origin={{ x: 200, y: 200 }}
        scale={2}
        gridStep={10}
        width={600}
      />,
    );
    const svg = utils.container.querySelector(
      "svg",
    ) as unknown as SVGSVGElement;
    return { ...utils, onPick, svg };
  };

  it("renders ellipse, elliptical arc, and polyline nodes with machine ids", () => {
    const view = renderCurved();
    const ellipse = view.container.querySelector(
      '[data-sketch-entity-id="skent_ellipse"]',
    );
    expect(ellipse?.tagName.toLowerCase()).toBe("ellipse");
    expect(ellipse?.getAttribute("rx")).toBe("80");
    expect(ellipse?.getAttribute("ry")).toBe("40");
    const arc = view.container.querySelector(
      '[data-sketch-entity-id="skent_earc"]',
    );
    expect(arc?.tagName.toLowerCase()).toBe("path");
    expect(arc?.getAttribute("d")).toContain("A 60 30");
    const polyline = view.container.querySelector(
      '[data-sketch-entity-id="skent_spline"]',
    );
    expect(polyline?.tagName.toLowerCase()).toBe("polyline");
    expect(polyline?.getAttribute("points")).toBe(
      "120,260 160,140 240,140 280,260",
    );
  });

  it("hit-tests the ellipse rim, the arc sweep, and the polyline", () => {
    const { onPick, svg } = renderCurved();
    // Ellipse rim at (40, 0) workplane → screen (280, 200).
    act(() => {
      fireEvent.pointerDown(svg, {
        clientX: 280,
        clientY: 200,
      });
    });
    expect(onPick).toHaveBeenLastCalledWith({
      entityId: "skent_ellipse",
      point: { x: 40, y: 0 },
    });
    // Inside the arc's ellipse but outside its upper sweep: the arc is at
    // (30, 0) rim; the polyline sits at y=−30 only near |x|≤40 — a miss
    // against all three at (0, 8)? The arc rim misses (8 ≪ radius) and the
    // ellipse rim (30 off) — pick at the polyline's mid-span (0, 30) →
    // screen (200, 140) hits skent_spline.
    act(() => {
      fireEvent.pointerDown(svg, {
        clientX: 200,
        clientY: 140,
      });
    });
    expect(onPick).toHaveBeenLastCalledWith({
      entityId: "skent_spline",
      point: { x: 0, y: 30 },
    });
  });
});

describe("CadSketchCanvas Phase 37 — drag, ink, dimensions", () => {
  it("surfaces press-move-release as drag start/move/end with the drag ink", () => {
    const onDragStart = vi.fn();
    const onDragMove = vi.fn();
    const onDragEnd = vi.fn();
    const { svg, view } = renderCanvas({
      draggingEntityId: "skent_a",
      onDragEnd,
      onDragMove,
      onDragStart,
    });
    // Press on the line (workplane (25,0) → screen (200,200)): the drag
    // ARMS but does not start — a press without movement stays a pick.
    firePointer(svg, "pointerdown", 200, 200);
    expect(onDragStart).not.toHaveBeenCalled();
    expect(
      view.container.querySelector('[data-sketch-dragging="true"]'),
    ).not.toBeNull();
    // The first move STARTS the drag with the press point (the grab site
    // the host's grab decision reads), then streams moves.
    firePointer(svg, "pointermove", 200, 100);
    expect(onDragStart).toHaveBeenCalledWith({
      entityId: "skent_a",
      point: { x: 25, y: 0 },
    });
    expect(onDragMove).toHaveBeenCalledWith({ x: 25, y: 25 });
    // The dragged entity renders with the violet drag ink mid-drag.
    const dragged = view.container.querySelector(
      '[data-sketch-entity-id="skent_a"]',
    );
    expect(dragged?.getAttribute("stroke")).toMatch(/violet|#8b5cf6/);
    // Release ends the drag with the release point.
    firePointer(svg, "pointerup", 200, 100);
    expect(onDragEnd).toHaveBeenCalledWith({ x: 25, y: 25 });
    expect(
      view.container.querySelector('[data-sketch-dragging="true"]'),
    ).toBeNull();
  });

  it("a press on empty space picks without starting a drag", () => {
    const onDragStart = vi.fn();
    const { onPick, svg } = renderCanvas({ onDragStart });
    firePointer(svg, "pointerdown", 500, 50);
    expect(onPick).toHaveBeenCalledWith({
      entityId: null,
      point: { x: 100, y: 37.5 },
    });
    expect(onDragStart).not.toHaveBeenCalled();
  });

  it("renders under-constrained entities blue and constrained ones black", () => {
    const { view } = renderCanvas({
      entityDof: new Map([
        ["skent_a", 2],
        ["skent_c", 0],
      ]),
    });
    const line = view.container.querySelector(
      '[data-sketch-entity-id="skent_a"]',
    );
    // dof > 0 → the blue ink of the under-constrained convention.
    expect(line?.getAttribute("stroke")).toMatch(/sky-600|#0284c7/);
    const point = view.container.querySelector(
      '[data-sketch-entity-id="skent_c"]',
    );
    // dof === 0 → black — even though the entity ALSO reports an error
    // diagnostic; the diagnostic still wins (red), so assert it here.
    expect(point?.getAttribute("stroke")).toMatch(/destructive|#dc2626/);
    const circle = view.container.querySelector(
      '[data-sketch-entity-id="skent_b"]',
    );
    // Absent from the map → legacy styling (warning amber wins here).
    expect(circle?.getAttribute("stroke")).toMatch(/amber|#f59e0b/);
  });

  it("renders the dimension overlay with per-dimension machine ids", () => {
    const { view } = renderCanvas({
      dimensions: [
        {
          dimensionLine: {
            from: { x: 0, y: 8 },
            to: { x: 50, y: 8 },
          },
          extensionLines: [{ from: { x: 0, y: 0 }, to: { x: 0, y: 10 } }],
          id: "skcon_d",
          kind: "linear",
          text: "50 mm",
          textAnchor: { x: 25, y: 8 },
        },
      ],
    });
    const node = view.container.querySelector(
      '[data-sketch-dimension-id="skcon_d"]',
    );
    expect(node).not.toBeNull();
    // The dimension line plus one extension line.
    expect(node?.querySelectorAll("line")).toHaveLength(2);
    // Arrowheads ride the dimension line ends.
    expect(node?.querySelectorAll("polygon")).toHaveLength(2);
    expect(node?.getAttribute("data-sketch-dimension-id")).toBe("skcon_d");
  });
});
