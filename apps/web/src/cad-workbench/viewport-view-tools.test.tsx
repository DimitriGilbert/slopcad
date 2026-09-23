/**
 * Phase 45 view-tools strip: command semantics on the component surface —
 * every button writes the overlay through the callback (never the
 * document), standard views derive the analytic cameras, reset is the
 * explicit spec-law return, look-at declines honestly without a
 * selection, and the zoom window commits on drag release. jsdom; the
 * strip owns no renderer.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBodyId } from "@slopcad/cad-core";
import type { RenderCamera } from "@slopcad/cad-core";
import { standardViewCamera } from "@slopcad/cad-r3f";

import { createViewportViewSession } from "./viewport-view";
import {
  CadViewportViewTools,
  selectionLookAtPoint,
  type CadViewportViewToolsProps,
} from "./viewport-view-tools";

afterEach(cleanup);

const BOUNDS = { max: [30, 20, 10], min: [0, 0, 0] } as const;

const SPEC_CAMERA: RenderCamera = {
  fovDeg: 40,
  kind: "perspective",
  position: [44, -30, 47],
  target: [15, 10, 5],
  up: [0, 0, 1],
};

/** A projection stub with one renderable body carrying a bounds box. */
const PROJECTION = {
  camera: SPEC_CAMERA,
  objects: [
    {
      bodyId: createBodyId("body_plate"),
      bounds: { max: [30, 20, 10], min: [0, 0, 0] },
      id: "rend_plate",
    },
  ],
} as unknown as CadViewportViewToolsProps["projection"];

/** jsdom lays nothing out: the strip reads its frame from the root's
 * rect, so tests stub an 800x600 box on the rendered root. */
function stubRootRect(): void {
  const root = screen.getByTestId("viewport-view-tools");
  Object.defineProperty(root, "getBoundingClientRect", {
    value: () => ({ height: 600, width: 800, x: 0, y: 0 }) as DOMRect,
  });
}

function Harness(
  overrides: Partial<CadViewportViewToolsProps> = {},
): CadViewportViewToolsProps {
  const props: CadViewportViewToolsProps = {
    bounds: BOUNDS,
    currentCamera: SPEC_CAMERA,
    onConvention: vi.fn(),
    onDisplayMode: vi.fn(),
    onLightRig: vi.fn(),
    onRenderQuality: vi.fn(),
    onUserCamera: vi.fn(),
    projection: PROJECTION,
    selection: [],
    session: createViewportViewSession(),
    ...overrides,
  };
  return props;
}

describe("CadViewportViewTools commands", () => {
  it("the Front button writes the analytic front-view camera", () => {
    const props = Harness();
    render(<CadViewportViewTools {...props} />);
    fireEvent.click(screen.getByTestId("view-front"));
    expect(props.onUserCamera).toHaveBeenCalledTimes(1);
    expect(props.onUserCamera).toHaveBeenCalledWith(
      standardViewCamera("front", {
        bounds: BOUNDS,
        convention: "third-angle",
      }),
    );
  });

  it("the Iso button follows the convention (first angle mirrors the corner)", () => {
    const onUserCamera = vi.fn();
    const props = Harness({
      onUserCamera,
      session: { ...createViewportViewSession(), convention: "first-angle" },
    });
    render(<CadViewportViewTools {...props} />);
    fireEvent.click(screen.getByTestId("view-iso"));
    const camera = onUserCamera.mock.calls[0]?.[0] as RenderCamera;
    expect(camera.position[0]).toBeLessThan(camera.target[0]);
  });

  it("Fit writes a camera framed on the bounds center, keeping the view direction", () => {
    const onUserCamera = vi.fn();
    const props = Harness({ onUserCamera });
    render(<CadViewportViewTools {...props} />);
    stubRootRect();
    fireEvent.click(screen.getByTestId("view-fit"));
    const camera = onUserCamera.mock.calls[0]?.[0] as RenderCamera;
    expect(camera.target).toEqual([15, 10, 5]);
    expect(camera.kind).toBe("perspective");
  });

  it("the projection toggle writes the orthographic twin of the current pose", () => {
    const onUserCamera = vi.fn();
    const props = Harness({ onUserCamera });
    render(<CadViewportViewTools {...props} />);
    stubRootRect();
    fireEvent.click(screen.getByTestId("view-projection-toggle"));
    const camera = onUserCamera.mock.calls[0]?.[0] as RenderCamera;
    expect(camera.kind).toBe("orthographic");
    expect(camera.position).toEqual(SPEC_CAMERA.position);
  });

  it("Reset writes null (the explicit spec-law return) and is disabled at spec law", () => {
    const props = Harness({
      session: {
        ...createViewportViewSession(),
        userCamera: SPEC_CAMERA,
      },
    });
    render(<CadViewportViewTools {...props} />);
    fireEvent.click(screen.getByTestId("view-reset"));
    expect(props.onUserCamera).toHaveBeenCalledWith(null);

    const atSpec = Harness();
    cleanup();
    render(<CadViewportViewTools {...atSpec} />);
    expect(
      screen.getByTestId("view-reset").getAttribute("disabled"),
    ).not.toBeNull();
  });

  it("display-mode buttons write the mode and mark the active one pressed", () => {
    const props = Harness();
    render(<CadViewportViewTools {...props} />);
    fireEvent.click(screen.getByTestId("display-mode-wireframe"));
    expect(props.onDisplayMode).toHaveBeenCalledWith("wireframe");
    expect(
      screen.getByTestId("display-mode-shaded").getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByTestId("display-mode-wireframe").getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("the convention toggle writes first-angle from third-angle", () => {
    const props = Harness();
    render(<CadViewportViewTools {...props} />);
    fireEvent.click(screen.getByTestId("view-convention-toggle"));
    expect(props.onConvention).toHaveBeenCalledWith("first-angle");
  });

  it("look-at declines (disabled) without a selection, writes the re-target with one", () => {
    const empty = Harness();
    render(<CadViewportViewTools {...empty} />);
    expect(
      screen.getByTestId("view-look-at").getAttribute("disabled"),
    ).not.toBeNull();
    cleanup();

    const onUserCamera = vi.fn();
    const props = Harness({
      onUserCamera,
      selection: [{ bodyId: createBodyId("body_plate"), kind: "body" }],
    });
    render(<CadViewportViewTools {...props} />);
    fireEvent.click(screen.getByTestId("view-look-at"));
    const camera = onUserCamera.mock.calls[0]?.[0] as RenderCamera;
    expect(camera.target).toEqual([15, 10, 5]);
  });

  it("zoom window arms, draws the rectangle, and commits a camera on release", () => {
    const onUserCamera = vi.fn();
    const props = Harness({ onUserCamera });
    render(<CadViewportViewTools {...props} />);
    fireEvent.click(screen.getByTestId("view-zoom-window"));
    const layer = screen.getByTestId("viewport-zoom-window");
    stubRootRect();
    fireEvent.pointerDown(layer, { button: 0, clientX: 200, clientY: 150 });
    fireEvent.pointerMove(layer, { clientX: 600, clientY: 350 });
    expect(screen.getByTestId("viewport-zoom-window-rect")).toBeDefined();
    fireEvent.pointerUp(layer);
    const camera = onUserCamera.mock.calls[0]?.[0] as RenderCamera;
    expect(camera.kind).toBe("perspective");
    if (camera.kind !== "perspective") throw new Error("expected persp");
    expect(camera.fovDeg).toBe(SPEC_CAMERA.fovDeg);
    if (SPEC_CAMERA.kind !== "perspective") throw new Error("spec is persp");
    // The layer disarms after the commit.
    expect(screen.queryByTestId("viewport-zoom-window")).toBeNull();
  });
});

describe("selectionLookAtPoint", () => {
  it("returns the union-bounds center for a body selection", () => {
    const point = selectionLookAtPoint(
      [{ bodyId: createBodyId("body_plate"), kind: "body" }],
      PROJECTION,
    );
    expect(point).toEqual([15, 10, 5]);
  });

  it("declines with no selection or an unresolvable projection", () => {
    expect(selectionLookAtPoint([], PROJECTION)).toBeNull();
    expect(
      selectionLookAtPoint(
        [{ kind: "feature", featureId: "f1" } as never],
        PROJECTION,
      ),
    ).toBeNull();
    expect(
      selectionLookAtPoint(
        [{ bodyId: createBodyId("body_plate"), kind: "body" }],
        null,
      ),
    ).toBeNull();
  });
});
