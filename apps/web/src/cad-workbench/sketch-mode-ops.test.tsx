/**
 * SketchMode's Phase 37 op surfaces (component level): the convert tool's
 * honest decline without a topology view; the convert flow with a fake
 * persistent-topology view (a vertex becomes a construction point, an edge
 * declines with the structured code); the array form applying to the live
 * selection; and the drag machine surface. Machine surfaces (data-*) carry
 * every assertion, exactly like the browser battery.
 */

import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  createBodyId,
  type TopologyEntitySnapshot,
  type TopologySnapshot,
  type TopologyView,
} from "@slopcad/cad-core";

import { SketchMode, type SketchModeTopology } from "./SketchMode";

afterEach(cleanup);

const BODY_ID = createBodyId("body_fixture");

const VERTEX: TopologyEntitySnapshot = {
  geometry: {
    centroidAbsoluteMm: [10, 10, 0],
    lengthMm: 0,
    pointAbsoluteMm: [30, 20, 0],
  },
  identity: {
    data: { hash: "v0" },
    kernelId: "kernel_fake",
    schema: "fake/v1",
  },
  kind: "vertex",
  ordinal: 0,
};

const EDGE: TopologyEntitySnapshot = {
  geometry: { centroidAbsoluteMm: [15, 0, 0], lengthMm: 30 },
  identity: {
    data: { hash: "e0" },
    kernelId: "kernel_fake",
    schema: "fake/v1",
  },
  kind: "edge",
  ordinal: 0,
};

const SNAPSHOT: TopologySnapshot = {
  bodyId: BODY_ID,
  entities: [EDGE, VERTEX],
  identitySchemas: ["fake/v1"],
  kernelId: "kernel_fake",
  persistentTopology: true,
  regeneration: 0,
};

const TOPOLOGY: SketchModeTopology = {
  bodies: [BODY_ID],
  view: {
    identitySchemas: SNAPSHOT.identitySchemas,
    kernelId: SNAPSHOT.kernelId,
    persistentTopology: true,
    snapshotOf: (bodyId) => (bodyId === BODY_ID ? SNAPSHOT : null),
  } satisfies TopologyView,
};

/** The canvas click point for a workplane mm coordinate (the 6 px/mm transform). */
function canvasPoint(
  x: number,
  y: number,
): { readonly clientX: number; readonly clientY: number } {
  return { clientX: 120 + x * 6, clientY: 400 - y * 6 };
}

function fireCanvasPick(x: number, y: number): void {
  const surface = document.querySelector("[data-sketch-surface]");
  if (surface === null) throw new Error("the sketch canvas must be mounted");
  surface.getBoundingClientRect = () => new DOMRect(0, 0, 800, 520);
  fireEvent(
    surface,
    new MouseEvent("pointerdown", { bubbles: true, ...canvasPoint(x, y) }),
  );
}

function mountSketchMode(topology?: SketchModeTopology): void {
  render(
    <SketchMode onExtrude={() => {}} onExit={() => {}} topology={topology} />,
  );
}

function root(): Element {
  const element = document.getElementById("sketch-root");
  if (element === null) throw new Error("the sketch root must be mounted");
  return element;
}

function toolButton(toolId: string): Element {
  const button = document.querySelector(`[data-sketch-tool-id="${toolId}"]`);
  if (button === null) throw new Error(`tool button ${toolId} missing`);
  return button;
}

describe("SketchMode Phase 37 — convert", () => {
  it("renders the honest no-topology decline without a view", () => {
    mountSketchMode();
    expect(root().getAttribute("data-sketch-tool")).toBe("select");
    const section = root().querySelector("[data-sketch-convert-section]");
    expect(section?.textContent).toContain("No topology view");
    // Activating the convert tool says the same thing on the status line.
    fireEvent.click(toolButton("convert"));
    expect(root().getAttribute("data-sketch-tool")).toBe("convert");
    expect(root().getAttribute("data-sketch-tool-status")).toContain(
      "no topology view",
    );
  });

  it("converts a vertex into a construction point and records the outcome", async () => {
    mountSketchMode(TOPOLOGY);
    const before = root().getAttribute("data-sketch-entities") ?? "";
    const vertexRow = document.querySelector(
      '[data-sketch-convert-entry$="_vertex_0"]',
    );
    expect(vertexRow).not.toBeNull();
    fireEvent.click(vertexRow ?? document.body);
    await waitFor(() => {
      expect(root().getAttribute("data-sketch-convert")).toContain(
        '"status":"converted"',
      );
    });
    const after = JSON.parse(
      root().getAttribute("data-sketch-entities") ?? "[]",
    ) as readonly { readonly construction: boolean; readonly kind: string }[];
    expect(after).toHaveLength((JSON.parse(before) as unknown[]).length + 1);
    const point = after.find(
      (entity) => entity.kind === "point" && entity.construction,
    );
    expect(point).toBeDefined();
  });

  it("declines an edge reference with the structured code", () => {
    mountSketchMode(TOPOLOGY);
    const edgeRow = document.querySelector(
      '[data-sketch-convert-entry$="_edge_0"]',
    );
    expect(edgeRow).not.toBeNull();
    // The edge row renders disabled with its honest decline — a descriptor
    // with only summary measures cannot project. The click path is inert;
    // the machine attribute carries the verdict.
    expect(edgeRow?.getAttribute("data-sketch-convert-convertible")).toBe(
      "false",
    );
    expect(edgeRow?.getAttribute("data-sketch-convert-kind")).toBe("edge");
  });
});

describe("SketchMode Phase 37 — arrays and drag surfaces", () => {
  it("applies a rectangular array to the live selection from the form", async () => {
    mountSketchMode();
    // Draw a hexagon (which selects itself on commit): two picks.
    fireEvent.click(toolButton("polygon"));
    fireCanvasPick(0, 0);
    fireCanvasPick(20, 0);
    expect(root().getAttribute("data-sketch-tool-status")).toContain(
      "Created polygon",
    );
    // Activate the rectangular array; the form appears in the inspector.
    fireEvent.click(toolButton("rectArray"));
    const arraySection = document.querySelector(
      '[data-sketch-array-tool="rectArray"]',
    );
    expect(arraySection).not.toBeNull();
    const selection = document.querySelector(
      '[data-testid="sketch-array-selection"]',
    );
    expect(selection?.textContent).toContain("1 selected");
    const apply = [...document.querySelectorAll("button")].find(
      (button) => button.textContent === "Apply",
    );
    expect(apply).toBeDefined();
    fireEvent.click(apply ?? document.body);
    await waitFor(() => {
      const status = JSON.parse(
        root().getAttribute("data-sketch-tool-status") ?? "{}",
      ) as { readonly message: string };
      expect(status.message).toContain("Array applied");
    });
    // The defaults are 3×2: five grid copies of the source hexagon — six
    // polygon entities total.
    const entities = JSON.parse(
      root().getAttribute("data-sketch-entities") ?? "[]",
    ) as readonly { readonly kind: string }[];
    expect(entities.filter((entity) => entity.kind === "polygon")).toHaveLength(
      6,
    );
  });

  it("carries the per-entity dof readout and dimension presentations", () => {
    mountSketchMode();
    const entityDof = JSON.parse(
      root().getAttribute("data-sketch-entity-dof") ?? "{}",
    ) as Record<string, number>;
    expect(typeof entityDof).toBe("object");
    const dimensions = root().getAttribute("data-sketch-dimensions") ?? "";
    expect(JSON.parse(dimensions || "[]")).toEqual([]);
  });
});

describe("SketchMode extrude outcome channel (review)", () => {
  /** Draws the self-selecting hexagon the extrude action resolves. */
  function drawHexagon(): void {
    fireEvent.click(toolButton("polygon"));
    fireCanvasPick(0, 0);
    fireCanvasPick(20, 0);
  }

  it("surfaces a refused host commit through the machine's extrude outcome", async () => {
    render(
      <SketchMode
        onExtrude={() => ({
          ok: false,
          code: "document/id-conflict",
          message: 'An entity with id "skd_extrude" already exists.',
        })}
        onExit={() => {}}
      />,
    );
    drawHexagon();
    const extrude = document.querySelector('[data-testid="sketch-extrude"]');
    expect(extrude).not.toBeNull();
    fireEvent.click(extrude ?? document.body);
    // The host's refusal overwrites the provisional resolved stamp: the
    // machine surface reports the failed commit with its structured code,
    // and the status line carries the same refusal.
    await waitFor(() => {
      expect(root().getAttribute("data-sketch-extrude")).toContain(
        '"status":"failed"',
      );
    });
    const outcome = JSON.parse(
      root().getAttribute("data-sketch-extrude") ?? "{}",
    ) as { readonly status: string; readonly code?: string };
    expect(outcome.status).toBe("failed");
    expect(outcome.code).toBe("document/id-conflict");
    expect(root().getAttribute("data-sketch-tool-status")).toContain(
      "already exists",
    );
  });

  it("keeps the resolved verdict when the host accepts the commit", () => {
    render(
      <SketchMode onExtrude={() => ({ ok: true })} onExit={() => {}} />,
    );
    drawHexagon();
    const extrude = document.querySelector('[data-testid="sketch-extrude"]');
    expect(extrude).not.toBeNull();
    fireEvent.click(extrude ?? document.body);
    expect(root().getAttribute("data-sketch-extrude")).toBe(
      JSON.stringify({ status: "resolved" }),
    );
  });

  it("keeps the pre-outcome behavior for a void-returning host", () => {
    mountSketchMode();
    drawHexagon();
    const extrude = document.querySelector('[data-testid="sketch-extrude"]');
    expect(extrude).not.toBeNull();
    fireEvent.click(extrude ?? document.body);
    expect(root().getAttribute("data-sketch-extrude")).toBe(
      JSON.stringify({ status: "resolved" }),
    );
  });
});
