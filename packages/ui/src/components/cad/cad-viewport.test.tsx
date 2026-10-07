/**
 * Component tests for `CadViewport` (Phase 15.1). jsdom has no WebGL, so
 * `CadScene` is replaced at the package boundary with a props-capturing
 * stub (the scene's own pixel behavior is browser evidence in
 * `apps/web/e2e-render`); the cad-r3f tool-input normalizers stay REAL
 * (pure functions from the `tool-input` subpath, which imports no R3F), so
 * the interaction tests assert the exact normalized events the viewport
 * dispatches. Everything between the props and the scene — provider
 * mirroring, precedence, overlay layer, labels, tool routing — is the
 * component's own code under test.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import type { ReactElement } from "react";
import {
  createBodyId,
  createDocument,
  createDocumentId,
  createSession,
  registerTool,
  CadProvider,
  createCadStore,
  type CadSession,
  type CadTool,
  type SelectionReference,
  type ToolInputEvent,
  type ToolStateBase,
  type ToolTransition,
} from "@slopcad/cad-react";
import type { CadPick, CadSceneProps } from "@slopcad/cad-r3f";
import type * as ToolInput from "@slopcad/cad-r3f/tool-input";
import { makeObject, makeProjection } from "@slopcad/cad-r3f/render-fixtures";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { CadViewport, CAD_VIEWPORT_LABELS } from "./cad-viewport";

/** Props `CadViewport` handed to the (stubbed) scene, per render. */
const sceneSink = vi.hoisted(() => ({
  scenes: [] as CadSceneProps[],
}));

vi.mock("@slopcad/cad-r3f", async () => {
  // The pure tool-input normalizers load without touching R3F; the rest of
  // the package needs a real canvas, so only the scene is stubbed here.
  const toolInput: typeof ToolInput = await vi.importActual(
    "@slopcad/cad-r3f/tool-input",
  );
  return {
    CAD_SCENE_BACKGROUND: "#101318",
    // The studio palette's constants (the Machinist night bed) — pure
    // string values, no canvas needed.
    CAD_SCENE_GRID_COLOR: "#374151",
    CAD_SCENE_GRID_CENTER_COLOR: "#4b5563",
    CAD_SCENE_AXIS_X_COLOR: "#ef4444",
    CAD_SCENE_AXIS_Y_COLOR: "#22c55e",
    CAD_SCENE_AXIS_Z_COLOR: "#3b82f6",
    CAD_SCENE_ORIGIN_MARKER_COLOR: "#e5e7eb",
    CadScene: (props: CadSceneProps): ReactElement => {
      sceneSink.scenes.push(props);
      return createElement("div", { "data-testid": "cad-scene-stub" });
    },
    toolKeyEvent: toolInput.toolKeyEvent,
    toolModifiersFromNative: toolInput.toolModifiersFromNative,
    toolPointerEvent: toolInput.toolPointerEvent,
  };
});

const PLATE = makeObject("plate", {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 0, -1],
  indices: [0, 1, 2, 0, 1, 3],
});
const PROJECTION = makeProjection([PLATE]);
const BODY_ID = createBodyId("body_plate");
const BODY_REFERENCE: SelectionReference = { kind: "body", bodyId: BODY_ID };

/** The body pick a real scene would report for a hit on the plate. */
function bodyPick(): CadPick {
  return {
    reference: BODY_REFERENCE,
    renderObjectId: PLATE.id,
    worldPoint: [1, 2, 3],
  };
}

/** A minimal deterministic session (document identity only). */
function sessionOf(): CadSession {
  return createSession(createDocument(createDocumentId("doc_viewport_test")));
}

/** A tool whose state records the normalized events it receives. */
interface ProbeToolState extends ToolStateBase {
  readonly stage: "events";
  readonly events: readonly string[];
}

/** Compact record of one normalized event: type, pick presence, shift. */
function describeEvent(event: ToolInputEvent): string {
  switch (event.type) {
    case "pointer-down":
    case "pointer-move":
    case "pointer-up": {
      const presence = event.pick === null ? "empty" : "pick";
      const shift = event.modifiers.shift ? "+shift" : "";
      return `${event.type}:${presence}${shift}`;
    }
    default:
      return `${event.type}:${event.key}`;
  }
}

function probeTool(): CadTool<ProbeToolState> {
  return {
    id: "probe",
    initialState: { stage: "events", events: [] },
    onEvent(
      state: ProbeToolState,
      event: ToolInputEvent,
    ): ToolTransition<ProbeToolState> {
      return {
        state: {
          stage: "events",
          events: [...state.events, describeEvent(event)],
        },
        phase: "active",
      };
    },
  };
}

/** Latest props the viewport handed to the scene stub. */
function latestSceneProps(): CadSceneProps {
  const props = sceneSink.scenes.at(-1);
  if (props === undefined) {
    throw new Error("The viewport never rendered the scene.");
  }
  return props;
}

beforeEach(() => {
  sceneSink.scenes = [];
});

afterEach(cleanup);

describe("CadViewport", () => {
  it("passes prop-driven state straight through to the scene", () => {
    const selection: readonly SelectionReference[] = [BODY_REFERENCE];
    render(
      <CadViewport
        projection={PROJECTION}
        regeneration={4}
        selection={selection}
      />,
    );
    const props = latestSceneProps();
    expect(props.projection).toBe(PROJECTION);
    expect(props.selection).toBe(selection);
    expect(props.regeneration).toBe(4);
  });

  it("renders the default loading state and container label", () => {
    render(<CadViewport projection={null} />);
    expect(screen.getByRole("status").textContent).toBe(
      CAD_VIEWPORT_LABELS.loading,
    );
    expect(screen.getByRole("group").getAttribute("aria-label")).toBe(
      CAD_VIEWPORT_LABELS.viewportLabel,
    );
  });

  it("renders label overrides in place of the defaults", () => {
    render(
      <CadViewport
        labels={{ viewportLabel: "Modello 3D", loading: "Calcolo…" }}
        projection={null}
      />,
    );
    expect(screen.getByRole("status").textContent).toBe("Calcolo…");
    expect(screen.getByRole("group").getAttribute("aria-label")).toBe(
      "Modello 3D",
    );
  });

  it("renders the overlay slot in a pointer-transparent layer above the scene", () => {
    render(
      <CadViewport
        overlay={
          <button type="button" data-testid="overlay-button">
            Overlay
          </button>
        }
        projection={PROJECTION}
      />,
    );
    const layer = screen.getByTestId("overlay-button").parentElement;
    expect(layer?.classList.contains("pointer-events-none")).toBe(true);
    expect(layer?.classList.contains("absolute")).toBe(true);
    // The scene stays mounted below the overlay.
    expect(screen.getByTestId("cad-scene-stub")).not.toBeNull();
  });

  it("mirrors provider selection state when no props are given", () => {
    const store = createCadStore({ session: sessionOf() });
    expect(store.pick(BODY_REFERENCE, false).ok).toBe(true);
    render(
      <CadProvider store={store}>
        <CadViewport projection={PROJECTION} />
      </CadProvider>,
    );
    const props = latestSceneProps();
    expect(props.selection).toEqual([BODY_REFERENCE]);
    expect(props.regeneration).toBe(0);
  });

  it("prefers explicit selection props over the provider's mirrored state", () => {
    const store = createCadStore({ session: sessionOf() });
    expect(store.pick(BODY_REFERENCE, false).ok).toBe(true);
    const faceSelection: readonly SelectionReference[] = [
      { kind: "face", bodyId: BODY_ID, regeneration: 1, faceIndex: 2 },
    ];
    render(
      <CadProvider store={store}>
        <CadViewport
          projection={PROJECTION}
          regeneration={7}
          selection={faceSelection}
        />
      </CadProvider>,
    );
    const props = latestSceneProps();
    expect(props.selection).toBe(faceSelection);
    expect(props.regeneration).toBe(7);
  });

  it("routes picks to the active tool through the real normalizers", () => {
    const store = createCadStore({
      session: sessionOf(),
      tools: [registerTool(probeTool())],
    });
    store.armTool("probe");
    render(
      <CadProvider store={store}>
        <CadViewport projection={PROJECTION} />
      </CadProvider>,
    );
    // The scene resolves a pick on a press (in a real browser its canvas
    // listeners run at target phase, before the container's bubble phase).
    latestSceneProps().onPickDown?.(bodyPick());
    latestSceneProps().onPickUp?.(bodyPick());
    // Then an empty-space click: DOM events no scene callback claimed.
    const scene = screen.getByTestId("cad-scene-stub");
    fireEvent.pointerDown(scene, { shiftKey: true });
    fireEvent.pointerUp(scene, { shiftKey: true });
    const surface = store.getToolSurface();
    expect(surface.phase).toBe("active");
    expect(surface.toolState).toEqual({
      stage: "events",
      events: [
        "pointer-down:pick",
        "pointer-up:pick",
        // The empty-space events carry the CAPTURE-phase modifier snapshot.
        "pointer-down:empty+shift",
        "pointer-up:empty+shift",
      ],
    });
    // The pick never leaks into the selection: the active tool owns it.
    expect(store.getSelection().selected).toEqual([]);
  });

  it("delivers the stranded pointer-up when the release lands outside the viewport", () => {
    const store = createCadStore({
      session: sessionOf(),
      tools: [registerTool(probeTool())],
    });
    store.armTool("probe");
    render(
      <CadProvider store={store}>
        <CadViewport projection={PROJECTION} />
      </CadProvider>,
    );
    // The press happens in the viewport; the release happens over foreign
    // page chrome — no container or scene handler can see it.
    fireEvent.pointerDown(screen.getByTestId("cad-scene-stub"), {
      pointerId: 4,
    });
    fireEvent.pointerUp(window, { pointerId: 4 });
    const surface = store.getToolSurface();
    // The gesture TERMINATED (no drag-on-hover), with the empty-space up.
    expect(surface.phase).toBe("active");
    expect(surface.toolState).toEqual({
      stage: "events",
      events: ["pointer-down:empty", "pointer-up:empty"],
    });
  });

  it("cancels the live tool when the tracked gesture is pointercancelled", () => {
    const store = createCadStore({
      session: sessionOf(),
      tools: [registerTool(probeTool())],
    });
    store.armTool("probe");
    render(
      <CadProvider store={store}>
        <CadViewport projection={PROJECTION} />
      </CadProvider>,
    );
    fireEvent.pointerDown(screen.getByTestId("cad-scene-stub"), {
      pointerId: 9,
    });
    fireEvent.pointerCancel(window, { pointerId: 9 });
    const surface = store.getToolSurface();
    expect(surface.phase).toBe("cancelled");
    // The cancel replaced the up: no pointer-up ever reached the tool.
    expect(surface.toolState).toEqual({
      stage: "events",
      events: ["pointer-down:empty"],
    });
  });

  it("delivers the stranded pointer-up when the release lands on an overlay control", () => {
    const store = createCadStore({
      session: sessionOf(),
      tools: [registerTool(probeTool())],
    });
    store.armTool("probe");
    render(
      <CadProvider store={store}>
        <CadViewport
          overlay={
            <button type="button" data-testid="overlay-release">
              Release here
            </button>
          }
          projection={PROJECTION}
        />
      </CadProvider>,
    );
    fireEvent.pointerDown(screen.getByTestId("cad-scene-stub"), {
      pointerId: 2,
    });
    // The release targets the overlay: the container's empty-space branch
    // excludes it, and the window fallback still ends the gesture.
    fireEvent.pointerUp(screen.getByTestId("overlay-release"), {
      pointerId: 2,
    });
    const surface = store.getToolSurface();
    expect(surface.phase).toBe("active");
    expect(surface.toolState).toEqual({
      stage: "events",
      events: ["pointer-down:empty", "pointer-up:empty"],
    });
  });

  it("leaves overlay-originated presses entirely to the overlay", () => {
    const store = createCadStore({
      session: sessionOf(),
      tools: [registerTool(probeTool())],
    });
    store.armTool("probe");
    render(
      <CadProvider store={store}>
        <CadViewport
          overlay={
            <button type="button" data-testid="overlay-press">
              Press here
            </button>
          }
          projection={PROJECTION}
        />
      </CadProvider>,
    );
    fireEvent.pointerDown(screen.getByTestId("overlay-press"), {
      pointerId: 3,
    });
    fireEvent.pointerUp(screen.getByTestId("overlay-press"), { pointerId: 3 });
    const surface = store.getToolSurface();
    expect(surface.phase).toBe("active");
    // No viewport gesture was armed: the tool's event stream is untouched.
    expect(surface.toolState).toEqual({ stage: "events", events: [] });
  });

  it("delivers an in-viewport release exactly once (no window fallback repeat)", () => {
    const store = createCadStore({
      session: sessionOf(),
      tools: [registerTool(probeTool())],
    });
    store.armTool("probe");
    render(
      <CadProvider store={store}>
        <CadViewport projection={PROJECTION} />
      </CadProvider>,
    );
    const scene = screen.getByTestId("cad-scene-stub");
    // Down and up both inside the container: the container dispatches the
    // empty-space up and the bubbling window event must not repeat it.
    fireEvent.pointerDown(scene, { pointerId: 6 });
    fireEvent.pointerUp(scene, { pointerId: 6 });
    const surface = store.getToolSurface();
    expect(surface.phase).toBe("active");
    expect(surface.toolState).toEqual({
      stage: "events",
      events: ["pointer-down:empty", "pointer-up:empty"],
    });
  });

  it("cancels the live tool on Escape from the focused viewport", () => {
    const store = createCadStore({
      session: sessionOf(),
      tools: [registerTool(probeTool())],
    });
    store.armTool("probe");
    render(
      <CadProvider store={store}>
        <CadViewport projection={PROJECTION} />
      </CadProvider>,
    );
    fireEvent.keyDown(screen.getByRole("group"), { key: "Escape" });
    expect(store.getToolSurface().phase).toBe("cancelled");
  });

  it("applies picks directly to the selection when no tool is active", () => {
    const store = createCadStore({ session: sessionOf() });
    render(
      <CadProvider store={store}>
        <CadViewport projection={PROJECTION} />
      </CadProvider>,
    );
    const scene = screen.getByTestId("cad-scene-stub");
    fireEvent.pointerDown(scene, { shiftKey: false });
    latestSceneProps().onPickUp?.(bodyPick());
    expect(store.getSelection().selected).toEqual([BODY_REFERENCE]);
    // An empty-space click (no pick on down OR up) clears it again.
    fireEvent.pointerDown(scene, { shiftKey: false });
    fireEvent.pointerUp(scene, { shiftKey: false });
    expect(store.getSelection().selected).toEqual([]);
  });

  it("uses the explicit pick surface exclusively when any pick prop is set", () => {
    const store = createCadStore({
      session: sessionOf(),
      tools: [registerTool(probeTool())],
    });
    store.armTool("probe");
    const picks: string[] = [];
    render(
      <CadProvider store={store}>
        <CadViewport
          onHover={(pick) => {
            picks.push(pick === null ? "out" : "over");
          }}
          onPickUp={(pick) => {
            picks.push(`up:${pick.reference.kind}`);
          }}
          projection={PROJECTION}
        />
      </CadProvider>,
    );
    const surfaceBefore = store.getToolSurface();
    latestSceneProps().onPickUp?.(bodyPick());
    latestSceneProps().onHover?.(null);
    // The store's tool surface never moved: the props took over.
    expect(store.getToolSurface()).toBe(surfaceBefore);
    expect(picks).toEqual(["up:body", "out"]);
  });

  it("keeps a providerless viewport display-only without pick props", () => {
    render(<CadViewport projection={PROJECTION} />);
    const props = latestSceneProps();
    expect(props.onPick).toBeUndefined();
    expect(props.onPickDown).toBeUndefined();
    expect(props.onPickUp).toBeUndefined();
    expect(props.onHover).toBeUndefined();
  });
});
