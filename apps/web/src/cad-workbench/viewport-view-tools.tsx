/**
 * `CadViewportViewTools` (Phase 45): the viewport's navigation and display
 * strip — the view cube, the standard views, the projection toggle, the
 * display modes, fit, zoom-window, look-at selection, and reset-to-spec.
 * Every control writes the session overlay through the callbacks it gets
 * (`viewport-view.ts`'s record); nothing here touches the document, the
 * engine, or the renderer directly — the composition reads the session
 * back and feeds the viewport through its props.
 *
 * ## Layout and pointer discipline
 *
 * The strip is an overlay layer: `pointer-events-none` at the root, the
 * compact panel and the armed zoom-window layer opt back in. The panel
 * lives at the viewport's bottom-right; the zoom window, when armed,
 * covers the whole viewport and owns the gesture (the rectangle is drawn
 * live; pointer-up commits; Escape cancels).
 *
 * ## The accent rule
 *
 * Every control in the strip is a `ToolButton` — the system's one tool
 * control. That matters here because this panel used to hold FOUR filled
 * amber slabs at rest (the live display mode, the live light rig, the live
 * render quality, and an armed zoom window), which is four more than
 * DESIGN.md allows in one glance. The armed truth is `aria-pressed`, and
 * the primitive renders it as the sanctioned wash plus a 1px signal edge;
 * idle controls are dim ink on nothing, momentary verbs (the standard
 * views, fit, look-at, reset) carry no pressed state at all.
 *
 * Trading the fills for the armed treatment removed the slabs but not the
 * COUNT: display mode, light rig and render quality are all non-null, so
 * three amber-edged pills still sat in this corner permanently — and with
 * a body selected, the amber body, the armed tool and the amber Sketch
 * verb joined them for six accents in one glance. The three are segmented
 * VALUES, not armed states, so they are `ToolValueGroup` +
 * `tone="value"`: an inset track with the current member raised out of
 * it. `aria-pressed` and every `data-testid` are untouched — the armed
 * accent simply stops being spent on a setting that is never off, and the
 * idle members stop being bare words in a grid with no affordance.
 *
 * ## Determinism
 *
 * The view cube is a pure projection of the effective camera
 * (`projectViewCube`); every camera the strip writes comes from the pure
 * command math in `standard-views.ts`. No state lives here beyond the
 * zoom-window drag.
 */

import { useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type {
  RenderBounds,
  RenderCamera,
  RenderProjection,
  RenderVector3,
  SelectionReference,
} from "@slopcad/cad-core";
import {
  cornerIsoDirection,
  fitCameraToBounds,
  isoViewCameraOfDirection,
  projectViewCube,
  retargetCamera,
  standardViewCamera,
  toggleCameraProjection,
  zoomWindowCamera,
  type StandardViewId,
  type ViewportRect,
} from "@slopcad/cad-r3f";
import { selectionReferenceBodyId } from "@slopcad/cad-core";
import {
  Box,
  Crosshair,
  Frame,
  Maximize,
  RotateCcw,
  ZoomIn,
} from "lucide-react";
import {
  ToolButton,
  ToolGroup,
  ToolValueGroup,
} from "@slopcad/ui/components/cockpit/tool-button";
import type { ViewportViewSession } from "./viewport-view";

/** Props of {@link CadViewportViewTools}. */
export interface CadViewportViewToolsProps {
  /** The session record (camera overlay + display preferences). */
  readonly session: ViewportViewSession;
  /** Writes (or clears) the user camera overlay. */
  readonly onUserCamera: (camera: RenderCamera | null) => void;
  /** Writes the display mode. */
  readonly onDisplayMode: (mode: ViewportViewSession["displayMode"]) => void;
  /** Writes the light rig (Phase 59). */
  readonly onLightRig: (rigId: string) => void;
  /** Writes the render quality (Phase 59). */
  readonly onRenderQuality: (
    quality: ViewportViewSession["renderQuality"],
  ) => void;
  /** Writes the angle convention. */
  readonly onConvention: (
    convention: ViewportViewSession["convention"],
  ) => void;
  /** The kernel-measured bounds of the rendered scene (fit, standard views). */
  readonly bounds: RenderBounds | null;
  /** The effective camera (overlay ?? the projection's spec). */
  readonly currentCamera: RenderCamera | null;
  /** The projection the selection resolves against (look-at). */
  readonly projection: RenderProjection | null;
  /** The current selection (look-at). */
  readonly selection: readonly SelectionReference[];
}

/** The standard-view buttons (front/top/right per the roadmap, plus iso). */
const STANDARD_VIEWS: readonly {
  readonly id: StandardViewId;
  readonly label: string;
  readonly testId: string;
}[] = [
  { id: "front", label: "Front", testId: "view-front" },
  { id: "top", label: "Top", testId: "view-top" },
  { id: "right", label: "Right", testId: "view-right" },
  { id: "iso", label: "Iso", testId: "view-iso" },
];

/** The display-mode buttons, in cycling order. */
const DISPLAY_MODES: readonly {
  readonly id: ViewportViewSession["displayMode"];
  readonly label: string;
}[] = [
  { id: "shaded", label: "Shaded" },
  { id: "shaded-edges", label: "+Edges" },
  { id: "wireframe", label: "Wire" },
  { id: "hidden-line", label: "Hidden" },
];

/** The light-rig buttons (Phase 59), in selector order. */
const LIGHT_RIGS: readonly { readonly id: string; readonly label: string }[] = [
  { id: "studio", label: "Studio" },
  { id: "north-window", label: "North" },
  { id: "inspection", label: "Inspect" },
];

/** The view-cube face letters (the short labels drawn on the cube). */
const FACE_LETTERS: Readonly<Record<string, string>> = Object.freeze({
  back: "B",
  bottom: "Bo",
  front: "F",
  left: "L",
  right: "R",
  top: "T",
});

const CUBE_BOX_PX = 72;

/**
 * The world point a look-at aims at: the center of the union bounds of
 * the projection objects the selection references (body picks and
 * face/edge picks all carry a body id). `null` when the selection
 * resolves to nothing renderable — the control declines honestly.
 */
export function selectionLookAtPoint(
  selection: readonly SelectionReference[],
  projection: RenderProjection | null,
): RenderVector3 | null {
  if (projection === null || selection.length === 0) return null;
  const bodyIds = new Set(
    selection
      .map((reference) => selectionReferenceBodyId(reference))
      .filter((id): id is NonNullable<typeof id> => id !== undefined),
  );
  if (bodyIds.size === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  let matched = false;
  for (const object of projection.objects) {
    if (object.bodyId === undefined || !bodyIds.has(object.bodyId)) continue;
    matched = true;
    minX = Math.min(minX, object.bounds.min[0]);
    minY = Math.min(minY, object.bounds.min[1]);
    minZ = Math.min(minZ, object.bounds.min[2]);
    maxX = Math.max(maxX, object.bounds.max[0]);
    maxY = Math.max(maxY, object.bounds.max[1]);
    maxZ = Math.max(maxZ, object.bounds.max[2]);
  }
  if (!matched) return null;
  return [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
}

/** One live zoom-window drag. */
interface ZoomWindowDrag {
  readonly startX: number;
  readonly startY: number;
  x: number;
  y: number;
}

export function CadViewportViewTools({
  bounds,
  currentCamera,
  onConvention,
  onDisplayMode,
  onLightRig,
  onRenderQuality,
  onUserCamera,
  projection,
  selection,
  session,
}: CadViewportViewToolsProps) {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [zoomWindowArmed, setZoomWindowArmed] = useState(false);
  const [drag, setDrag] = useState<ZoomWindowDrag | null>(null);

  const effectiveCamera: RenderCamera | null = currentCamera;

  const cube = useMemo(
    () =>
      effectiveCamera === null
        ? null
        : projectViewCube(effectiveCamera, {
            centerX: CUBE_BOX_PX / 2,
            centerY: CUBE_BOX_PX / 2,
            size: 46,
          }),
    [effectiveCamera],
  );

  /** The viewport's own CSS-pixel rect (the zoom-window's frame). */
  const layerRect = (): { height: number; width: number } => {
    const element = layerRef.current;
    const box = element?.getBoundingClientRect();
    return box === undefined
      ? { height: 0, width: 0 }
      : { height: box.height, width: box.width };
  };

  const commandStandardView = (view: StandardViewId): void => {
    if (bounds === null) return;
    onUserCamera(
      standardViewCamera(view, { bounds, convention: session.convention }),
    );
  };

  const commandCornerIso = (cornerId: string): void => {
    if (bounds === null) return;
    const direction = cornerIsoDirection(cornerId);
    if (direction === null) return;
    onUserCamera(isoViewCameraOfDirection(direction, { bounds }));
  };

  const commandFit = (): void => {
    if (effectiveCamera === null || bounds === null) return;
    const { width, height } = layerRect();
    if (width <= 0 || height <= 0) return;
    onUserCamera(
      fitCameraToBounds(effectiveCamera, {
        aspect: width / height,
        bounds,
      }),
    );
  };

  const commandProjectionToggle = (): void => {
    if (effectiveCamera === null) return;
    const { width, height } = layerRect();
    if (width <= 0 || height <= 0) return;
    onUserCamera(toggleCameraProjection(effectiveCamera, width / height));
  };

  const lookAt = selectionLookAtPoint(selection, projection);

  const commandLookAt = (): void => {
    if (effectiveCamera === null || lookAt === null) return;
    onUserCamera(retargetCamera(effectiveCamera, lookAt));
  };

  const beginZoomDrag = (x: number, y: number): void => {
    setDrag({ startX: x, startY: y, x, y });
  };

  const updateZoomDrag = (x: number, y: number): void => {
    setDrag((current) => (current === null ? current : { ...current, x, y }));
  };

  const commitZoomDrag = (): void => {
    const current = drag;
    setDrag(null);
    setZoomWindowArmed(false);
    if (current === null || effectiveCamera === null) return;
    const { width, height } = layerRect();
    if (width <= 0 || height <= 0) return;
    const rect: ViewportRect = {
      height: Math.abs(current.y - current.startY),
      width: Math.abs(current.x - current.startX),
      x: Math.min(current.x, current.startX),
      y: Math.min(current.y, current.startY),
    };
    if (rect.width < 4 || rect.height < 4) return;
    onUserCamera(
      zoomWindowCamera(effectiveCamera, {
        rect,
        viewport: { height, width },
      }),
    );
  };

  const cancelZoomWindow = (
    event: ReactKeyboardEvent<HTMLDivElement>,
  ): void => {
    if (event.key !== "Escape") return;
    setDrag(null);
    setZoomWindowArmed(false);
  };

  const projectionLabel =
    effectiveCamera?.kind === "orthographic" ? "Perspective" : "Ortho";

  return (
    <div
      className="pointer-events-none absolute inset-0"
      data-testid="viewport-view-tools"
      ref={layerRef}
    >
      {zoomWindowArmed ? (
        <div
          className="pointer-events-auto absolute inset-0 cursor-crosshair"
          data-testid="viewport-zoom-window"
          onKeyDown={cancelZoomWindow}
          onPointerDown={(event) => {
            event.preventDefault();
            (event.target as HTMLElement).focus?.();
            const box = event.currentTarget.getBoundingClientRect();
            beginZoomDrag(event.clientX - box.left, event.clientY - box.top);
          }}
          onPointerMove={(event) => {
            if (drag === null) return;
            const box = event.currentTarget.getBoundingClientRect();
            updateZoomDrag(event.clientX - box.left, event.clientY - box.top);
          }}
          onPointerUp={() => {
            commitZoomDrag();
          }}
          role="application"
          tabIndex={0}
        >
          {drag !== null ? (
            <svg className="pointer-events-none absolute inset-0 h-full w-full">
              <rect
                className="fill-viewport-select/15 stroke-viewport-select"
                data-testid="viewport-zoom-window-rect"
                height={Math.abs(drag.y - drag.startY)}
                width={Math.abs(drag.x - drag.startX)}
                x={Math.min(drag.x, drag.startX)}
                y={Math.min(drag.y, drag.startY)}
              />
            </svg>
          ) : null}
          {/* The gesture's instruction rides the VIEWPORT's own surface
              tokens, not the chrome's: it sits over the bed, which keeps
              its own register (a night bed under light chrome in
              Machinist), so chrome ink on a chrome scrim would be the
              wrong material here. */}
          <span className="absolute top-2 left-1/2 -translate-x-1/2 rounded-sm border border-viewport-rule bg-viewport-scrim px-2 py-1 text-ui text-viewport-ink">
            Drag a window to zoom — Esc cancels
          </span>
        </div>
      ) : null}
      {/* The strip is a floating surface, so it is the system's `overlay`
          rung — the one rung allowed a shadow, and the shadow is the
          scheme-tinted `--elevation-overlay`, not an untinted black drop.
          Its pad and gaps come off the panel tokens, so the strip
          measures like the docks it floats over. The width is
          `--hud-corner-w`, the
          SHARED token the HUD's centre slot keeps clear — this strip is
          the corner furniture that reservation exists for, and the token
          is why the two can no longer disagree about it. */}
      <div
        aria-label="View tools"
        className={`absolute right-3 bottom-3 flex w-(--hud-corner-w) flex-col gap-(--gap) rounded-md border border-rule-strong bg-overlay p-(--pad-row) shadow-overlay ${
          // While the zoom window is armed its full-viewport layer owns the
          // gesture: the panel stands down (no pointer events, visually
          // receded) so a rectangle drawn over it still commits instead of
          // dropping its pointerup on a button.
          zoomWindowArmed
            ? "pointer-events-none opacity-50"
            : "pointer-events-auto"
        }`}
        data-testid="viewport-view-panel"
        role="group"
      >
        {cube !== null ? (
          <div
            className="relative mx-auto"
            style={{ height: CUBE_BOX_PX, width: CUBE_BOX_PX }}
          >
            <svg
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              data-testid="viewport-view-cube"
              height={CUBE_BOX_PX}
              viewBox={`0 0 ${CUBE_BOX_PX} ${CUBE_BOX_PX}`}
              width={CUBE_BOX_PX}
            >
              {cube.faces.map((face) => (
                <polygon
                  className="fill-well stroke-rule-strong"
                  fillOpacity={face.id === cube.faces.at(-1)?.id ? 1 : 0.45}
                  key={face.id}
                  points={face.points
                    .map(
                      (point) =>
                        `${point[0].toFixed(1)},${point[1].toFixed(1)}`,
                    )
                    .join(" ")}
                  strokeWidth="1"
                />
              ))}
              {cube.faces.map((face) => (
                <text
                  className="fill-ink"
                  dominantBaseline="central"
                  fontSize="9"
                  key={`${face.id}-label`}
                  textAnchor="middle"
                  x={face.center[0]}
                  y={face.center[1]}
                >
                  {FACE_LETTERS[face.id] ?? ""}
                </text>
              ))}
            </svg>
            {/* The cube's clickable targets: faces command standard
                views, the nearest corner commands that octant's ISO. */}
            {cube.faces.map((face) => (
              <button
                aria-label={`${face.id} view`}
                className="absolute rounded-[2px] hover:bg-select-wash-strong"
                data-testid={`view-cube-face-${face.id}`}
                key={`hit-${face.id}`}
                onClick={() => {
                  commandStandardView(face.id);
                }}
                style={{
                  height: 18,
                  left: face.center[0] - 9,
                  top: face.center[1] - 9,
                  width: 18,
                }}
                title={`${face.id} view`}
                type="button"
              />
            ))}
            {cube.corners.at(-1) !== undefined ? (
              <button
                aria-label="Iso view of the nearest corner"
                className="absolute size-2.5 rounded-full hover:bg-select-wash-strong"
                data-testid="view-cube-corner"
                onClick={() => {
                  const corner = cube.corners.at(-1);
                  if (corner !== undefined) commandCornerIso(corner.id);
                }}
                style={{
                  left: (cube.corners.at(-1)?.point[0] ?? 0) - 5,
                  top: (cube.corners.at(-1)?.point[1] ?? 0) - 5,
                }}
                title="Iso view (nearest corner)"
                type="button"
              />
            ) : null}
          </div>
        ) : null}
        {/* The four named standard views in ONE row, not a 2×2 block:
            they are momentary camera jumps, they are the shortest labels
            in the panel, and the second row they used to occupy was 26px
            of the height that pushed this corner into the teaching
            card's lane at boot. */}
        <ToolGroup
          className="grid grid-cols-4 gap-(--gap-tight)"
          label="Standard views"
          separated={false}
        >
          {STANDARD_VIEWS.map((view) => (
            <ToolButton
              className="min-w-0 justify-center px-0"
              data-testid={view.testId}
              key={view.id}
              onClick={() => {
                commandStandardView(view.id);
              }}
              size="sm"
              title={`${view.label} view`}
            >
              {view.label}
            </ToolButton>
          ))}
        </ToolGroup>
        {/* The icon verbs keep their natural compact size in one centered
            row — the panel is wide enough that a stretched 2×2 grid would
            read as four empty bars. */}
        <div className="flex justify-center gap-(--gap-tight)">
          <ToolButton
            aria-label="Fit the view to the model bounds"
            className="w-(--control-h) justify-center px-0"
            data-testid="view-fit"
            disabled={bounds === null || effectiveCamera === null}
            onClick={commandFit}
            size="sm"
            title="Fit to bounds"
          >
            <Maximize aria-hidden="true" />
          </ToolButton>
          <ToolButton
            aria-label={zoomWindowArmed ? "Cancel zoom window" : "Zoom window"}
            aria-pressed={zoomWindowArmed}
            className="w-(--control-h) justify-center px-0"
            data-testid="view-zoom-window"
            onClick={() => {
              setZoomWindowArmed((armed) => !armed);
              setDrag(null);
            }}
            size="sm"
            title="Zoom window"
          >
            <ZoomIn aria-hidden="true" />
          </ToolButton>
          <ToolButton
            aria-label="Look at the selection"
            className="w-(--control-h) justify-center px-0"
            data-testid="view-look-at"
            disabled={lookAt === null || effectiveCamera === null}
            onClick={commandLookAt}
            size="sm"
            title="Look at selection"
          >
            <Crosshair aria-hidden="true" />
          </ToolButton>
          <ToolButton
            aria-label={`Switch to ${projectionLabel} projection`}
            className="w-(--control-h) justify-center px-0"
            data-testid="view-projection-toggle"
            disabled={effectiveCamera === null}
            onClick={commandProjectionToggle}
            size="sm"
            title={`${projectionLabel} projection`}
          >
            <Box aria-hidden="true" />
          </ToolButton>
        </div>
        <ToolValueGroup columns={2} label="Display mode">
          {DISPLAY_MODES.map((mode) => (
            <ToolButton
              aria-pressed={session.displayMode === mode.id}
              className="justify-center px-0"
              data-testid={`display-mode-${mode.id}`}
              key={mode.id}
              onClick={() => {
                onDisplayMode(mode.id);
              }}
              size="sm"
              title={`${mode.label} display`}
              tone="value"
            >
              {mode.label}
            </ToolButton>
          ))}
        </ToolValueGroup>
        <ToolValueGroup columns={3} label="Light rig">
          {LIGHT_RIGS.map((rig) => (
            <ToolButton
              aria-pressed={session.lightRig === rig.id}
              className="justify-center px-0"
              data-testid={`light-rig-${rig.id}`}
              key={rig.id}
              onClick={() => {
                onLightRig(rig.id);
              }}
              size="sm"
              title={`${rig.label} light rig`}
              tone="value"
            >
              {rig.label}
            </ToolButton>
          ))}
        </ToolValueGroup>
        <div className="flex justify-center gap-(--gap-tight)">
          <ToolButton
            aria-label="Toggle first/third-angle convention"
            className="w-(--control-h) justify-center px-0"
            data-testid="view-convention-toggle"
            onClick={() => {
              onConvention(
                session.convention === "third-angle"
                  ? "first-angle"
                  : "third-angle",
              );
            }}
            size="sm"
            title={`Convention: ${
              session.convention === "third-angle"
                ? "third angle"
                : "first angle"
            }`}
          >
            <Frame aria-hidden="true" />
          </ToolButton>
          <ToolButton
            aria-label="Reset the view to the document spec"
            className="w-(--control-h) justify-center px-0"
            data-testid="view-reset"
            disabled={session.userCamera === null}
            onClick={() => {
              onUserCamera(null);
            }}
            size="sm"
            title="Reset to spec view"
          >
            <RotateCcw aria-hidden="true" />
          </ToolButton>
        </div>
        <ToolValueGroup columns={2} label="Render quality">
          <ToolButton
            aria-pressed={session.renderQuality === "standard"}
            className="justify-center px-0"
            data-testid="render-quality-standard"
            onClick={() => {
              onRenderQuality("standard");
            }}
            size="sm"
            title="Standard render (the deterministic boot path)"
            tone="value"
          >
            Standard
          </ToolButton>
          <ToolButton
            aria-pressed={session.renderQuality === "quality"}
            className="justify-center px-0"
            data-testid="render-quality-quality"
            onClick={() => {
              onRenderQuality("quality");
            }}
            size="sm"
            title="Quality render: soft shadows, ambient occlusion (opt-in)"
            tone="value"
          >
            Quality
          </ToolButton>
        </ToolValueGroup>
      </div>
    </div>
  );
}
