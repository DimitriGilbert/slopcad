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
import { Button } from "@slopcad/ui/components/button";
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
                className="fill-signal/10 stroke-signal"
                data-testid="viewport-zoom-window-rect"
                height={Math.abs(drag.y - drag.startY)}
                width={Math.abs(drag.x - drag.startX)}
                x={Math.min(drag.x, drag.startX)}
                y={Math.min(drag.y, drag.startY)}
              />
            </svg>
          ) : null}
          <span className="text-muted-foreground absolute top-2 left-1/2 -translate-x-1/2 rounded-sm border border-border bg-background/95 px-2 py-1 text-xs">
            Drag a window to zoom — Esc cancels
          </span>
        </div>
      ) : null}
      <div
        aria-label="View tools"
        className="bg-background/95 border-border pointer-events-auto absolute right-3 bottom-3 flex w-[104px] flex-col gap-1.5 rounded-md border p-1.5 shadow-lg shadow-black/25"
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
                  className="fill-muted/60 stroke-muted-foreground/70"
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
                  className="fill-foreground"
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
                className="hover:bg-signal/25 absolute rounded-[4px]"
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
                className="hover:bg-signal/40 absolute size-2.5 rounded-full"
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
        <div className="grid grid-cols-2 gap-1">
          {STANDARD_VIEWS.map((view) => (
            <Button
              data-testid={view.testId}
              key={view.id}
              onClick={() => {
                commandStandardView(view.id);
              }}
              size="xs"
              title={`${view.label} view`}
              type="button"
              variant="outline"
            >
              {view.label}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1">
          <Button
            aria-label="Fit the view to the model bounds"
            data-testid="view-fit"
            disabled={bounds === null || effectiveCamera === null}
            onClick={commandFit}
            size="xs"
            title="Fit to bounds"
            type="button"
            variant="outline"
          >
            <Maximize aria-hidden="true" className="size-3.5" />
          </Button>
          <Button
            aria-label={zoomWindowArmed ? "Cancel zoom window" : "Zoom window"}
            aria-pressed={zoomWindowArmed}
            data-testid="view-zoom-window"
            onClick={() => {
              setZoomWindowArmed((armed) => !armed);
              setDrag(null);
            }}
            size="xs"
            title="Zoom window"
            type="button"
            variant={zoomWindowArmed ? "default" : "outline"}
          >
            <ZoomIn aria-hidden="true" className="size-3.5" />
          </Button>
          <Button
            aria-label="Look at the selection"
            data-testid="view-look-at"
            disabled={lookAt === null || effectiveCamera === null}
            onClick={commandLookAt}
            size="xs"
            title="Look at selection"
            type="button"
            variant="outline"
          >
            <Crosshair aria-hidden="true" className="size-3.5" />
          </Button>
          <Button
            aria-label={`Switch to ${projectionLabel} projection`}
            data-testid="view-projection-toggle"
            disabled={effectiveCamera === null}
            onClick={commandProjectionToggle}
            size="xs"
            title={`${projectionLabel} projection`}
            type="button"
            variant="outline"
          >
            <Box aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
        <div
          className="grid grid-cols-2 gap-1"
          role="group"
          aria-label="Display mode"
        >
          {DISPLAY_MODES.map((mode) => (
            <Button
              aria-pressed={session.displayMode === mode.id}
              data-testid={`display-mode-${mode.id}`}
              key={mode.id}
              onClick={() => {
                onDisplayMode(mode.id);
              }}
              size="xs"
              title={`${mode.label} display`}
              type="button"
              variant={session.displayMode === mode.id ? "default" : "outline"}
            >
              {mode.label}
            </Button>
          ))}
        </div>
        <div
          className="grid grid-cols-3 gap-1"
          role="group"
          aria-label="Light rig"
        >
          {LIGHT_RIGS.map((rig) => (
            <Button
              aria-pressed={session.lightRig === rig.id}
              data-testid={`light-rig-${rig.id}`}
              key={rig.id}
              onClick={() => {
                onLightRig(rig.id);
              }}
              size="xs"
              title={`${rig.label} light rig`}
              type="button"
              variant={session.lightRig === rig.id ? "default" : "outline"}
            >
              {rig.label}
            </Button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-1">
          <Button
            aria-label="Toggle first/third-angle convention"
            data-testid="view-convention-toggle"
            onClick={() => {
              onConvention(
                session.convention === "third-angle"
                  ? "first-angle"
                  : "third-angle",
              );
            }}
            size="xs"
            title={`Convention: ${
              session.convention === "third-angle"
                ? "third angle"
                : "first angle"
            }`}
            type="button"
            variant="outline"
          >
            <Frame aria-hidden="true" className="size-3.5" />
          </Button>
          <Button
            aria-label="Reset the view to the document spec"
            data-testid="view-reset"
            disabled={session.userCamera === null}
            onClick={() => {
              onUserCamera(null);
            }}
            size="xs"
            title="Reset to spec view"
            type="button"
            variant="outline"
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
          </Button>
        </div>
        <div
          className="grid grid-cols-2 gap-1"
          role="group"
          aria-label="Render quality"
        >
          <Button
            aria-pressed={session.renderQuality === "standard"}
            data-testid="render-quality-standard"
            onClick={() => {
              onRenderQuality("standard");
            }}
            size="xs"
            title="Standard render (the deterministic boot path)"
            type="button"
            variant={
              session.renderQuality === "standard" ? "default" : "outline"
            }
          >
            Standard
          </Button>
          <Button
            aria-pressed={session.renderQuality === "quality"}
            data-testid="render-quality-quality"
            onClick={() => {
              onRenderQuality("quality");
            }}
            size="xs"
            title="Quality render: soft shadows, ambient occlusion (opt-in)"
            type="button"
            variant={
              session.renderQuality === "quality" ? "default" : "outline"
            }
          >
            Quality
          </Button>
        </div>
      </div>
    </div>
  );
}
