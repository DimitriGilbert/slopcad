import { useCallback, useEffect, useRef } from "react";
import type {
  ComponentProps,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
/**
 * The Phase 45 camera/display prop types, derived from `CadScene`'s own
 * public component surface (the component this viewport composes): the
 * ui boundary allowlist stops at the renderer package, and the props
 * pass through untouched — the type follows the component edge, not a
 * re-export chain around the boundary.
 */
type SceneUserCameraProp = ComponentProps<typeof CadScene>["userCamera"];
type SceneOnUserCameraProp = ComponentProps<typeof CadScene>["onUserCamera"];
type SceneDisplayModeProp = ComponentProps<typeof CadScene>["displayMode"];
import {
  CadProviderError,
  useCadSelection,
  useCadTools,
  type CadSelectionApi,
  type CadToolsApi,
  type RenderProjection,
  type SelectionReference,
} from "@slopcad/cad-react";
import {
  CadScene,
  toolKeyEvent,
  toolModifiersFromNative,
  toolPointerEvent,
  type CadPick,
  type CadPickCategory,
  type SceneCameraStateSnapshot,
} from "@slopcad/cad-r3f";
import type { SectionClipPlanes } from "@slopcad/cad-r3f";
import { cn } from "cn";

import { useCadStudioPalette } from "./cad-studio-palette";

/** The user-facing strings of {@link CadViewport}. Overridable via props. */
export interface CadViewportLabels {
  /** Accessible name of the interactive viewport region. */
  readonly viewportLabel: string;
  /** Shown (as a polite status) while no projection is available yet. */
  readonly loading: string;
}

/** Documented label defaults; every render-output string lives here. */
export const CAD_VIEWPORT_LABELS: CadViewportLabels = {
  viewportLabel: "CAD viewport",
  loading: "Computing geometry…",
};

/** Props of {@link CadViewport}. */
export interface CadViewportProps {
  /**
   * The render projection to draw, or `null` for the loading state. The
   * projection is the renderable form of the host's document state — the
   * viewport never derives it from the document itself.
   */
  readonly projection: RenderProjection | null;
  /** The selected references; overrides the provider-mirrored selection. */
  readonly selection?: readonly SelectionReference[];
  /** The regeneration identity; overrides the provider-mirrored value. */
  readonly regeneration?: number;
  /** Which domain reference a click resolves to. Defaults to `"face"`. */
  readonly pickCategory?: CadPickCategory;
  /**
   * Overlay content, rendered over the canvas in a full-size
   * `pointer-events-none` layer (opt elements back in per element).
   */
  readonly overlay?: ReactNode;
  /** Label token overrides, merged over {@link CAD_VIEWPORT_LABELS}. */
  readonly labels?: Partial<CadViewportLabels>;
  /** Extends the container classes; sizes the viewport (default 320px tall). */
  readonly className?: string;
  /**
   * Section clipping planes (Phase 46): passed straight to the scene's
   * body materials when non-empty — the render-level half of a section
   * display record. Absent or empty is the unclipped raster.
   */
  readonly clippingPlanes?: SectionClipPlanes;
  /**
   * Opts the viewport into INTERACTIVE camera controls (left-drag orbit,
   * wheel dolly, middle/shift-drag pan, arrow-key orbit when the viewport
   * has focus). Default `false` — the deterministic spec camera the
   * byte-pinned fixtures render with. With controls on, the boot camera is
   * still the projection's spec camera: pixels change only after a real
   * user gesture, and a camera state is published on the container as
   * `data-camera-mode` / `data-camera-azimuth-deg` /
   * `data-camera-elevation-deg` / `data-camera-distance-mm` ("spec" until
   * the first gesture takes over). While a provider tool is ARMED,
   * left-drag belongs to the tool; camera access rides wheel, pan, and
   * keys until it is cancelled.
   */
  readonly cameraControls?: boolean;
  /**
   * Whether left-drag-orbit is currently available (camera controls only).
   * The default `true` fits every host without provider tools; a host with
   * an armed tool whose gesture vocabulary owns model drags (rotate,
   * translate) passes `false` while that tool is live — the tool keeps its
   * gesture, and wheel zoom, pan, and the arrow keys still move the
   * camera. Click tools (select, measure) do NOT need this: orbiting and
   * clicking coexist (the drag threshold separates them).
   */
  readonly cameraOrbitDragEnabled?: boolean;
  /**
   * The session-scoped USER camera overlay (Phase 45): when present it
   * replaces the projection's spec for rendering only (see
   * `docs/architecture/adr-user-camera-overlay.md`). Default `null` — the
   * spec camera every pinned fixture renders with.
   */
  readonly userCamera?: SceneUserCameraProp;
  /**
   * Receives user-camera RECORDS committed by gestures (drag end, wheel
   * notch, key step) — the host stores them session-scoped and feeds the
   * value back through {@link userCamera}. Fires only from user input.
   * Every commit advances the container's `data-camera-commit-count`
   * (the gesture-commit ledger: one per drag, wheel notch, or key step —
   * never per pointer move).
   */
  readonly onUserCamera?: SceneOnUserCameraProp;
  /**
   * The display mode (Phase 45): `shaded` (the default), `shaded-edges`,
   * `wireframe`, or `hidden-line`.
   */
  readonly displayMode?: SceneDisplayModeProp;
  /** Fires once per projection change, on its first settled demand frame. */
  readonly onSettled?: () => void;
  /** Fires when new selection content reached a rendered frame. */
  readonly onSelectionRendered?: (selectionKey: string) => void;
  /** Explicit click-pick surface (prop-driven mode, see the precedence rule). */
  readonly onPick?: (pick: CadPick) => void;
  /** Explicit pointer-down-pick surface (prop-driven mode). */
  readonly onPickDown?: (pick: CadPick) => void;
  /** Explicit pointer-up-pick surface (prop-driven mode). */
  readonly onPickUp?: (pick: CadPick) => void;
  /** Explicit hover surface (prop-driven mode). */
  readonly onHover?: (pick: CadPick | null) => void;
}

/**
 * Reads the selection hook, mapping the structured "no provider" error to
 * `null` (see the module doc for why this optional read is hook-safe).
 */
function useOptionalCadSelection(): CadSelectionApi | null {
  try {
    return useCadSelection();
  } catch (error) {
    if (error instanceof CadProviderError) return null;
    throw error;
  }
}

/** The tools-concern counterpart of {@link useOptionalCadSelection}. */
function useOptionalCadTools(): CadToolsApi | null {
  try {
    return useCadTools();
  } catch (error) {
    if (error instanceof CadProviderError) return null;
    throw error;
  }
}

/**
 * True when the event originated inside the overlay layer (which never
 * counts as viewport empty space).
 */
function insideOverlay(
  overlayLayer: HTMLDivElement | null,
  target: EventTarget | null,
): boolean {
  return target instanceof Node && overlayLayer?.contains(target) === true;
}

/**
 * The CAD viewport: the deterministic scene plus the interaction and
 * overlay plumbing, in one mountable component. Size it with `className`
 * (the fixture camera specs are authored for their exact viewport).
 */
export function CadViewport({
  cameraControls = false,
  cameraOrbitDragEnabled = true,
  className,
  clippingPlanes,
  displayMode,
  labels: labelOverrides,
  onHover,
  onUserCamera,
  onPick,
  onPickDown,
  onPickUp,
  onSelectionRendered,
  onSettled,
  overlay,
  pickCategory,
  projection,
  regeneration: regenerationProp,
  selection: selectionProp,
  userCamera = null,
}: CadViewportProps) {
  const labels: CadViewportLabels = {
    ...CAD_VIEWPORT_LABELS,
    ...labelOverrides,
  };
  // The studio ink follows the app's scheme + register (see
  // cad-studio-palette); the selection highlight inside the scene stays
  // deterministic amber.
  const studioPalette = useCadStudioPalette();
  const selectionApi = useOptionalCadSelection();
  const toolsApi = useOptionalCadTools();

  const modifiersRef = useRef(
    toolModifiersFromNative({
      shiftKey: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    }),
  );
  /** The scene resolved a pick for the latest pointer down/up. */
  const pickDownRef = useRef(false);
  const pickUpRef = useRef(false);
  /** The latest pointer down resolved no pick (empty space). */
  const emptyDownRef = useRef(false);
  const overlayLayerRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  /**
   * Publishes the camera state on the container's machine surface
   * (`data-camera-*`), directly — a camera drag writes attributes, it
   * never re-renders the viewport.
   */
  const handleCameraState = useCallback(
    (snapshot: SceneCameraStateSnapshot): void => {
      const container = containerRef.current;
      if (container === null) return;
      container.setAttribute("data-camera-mode", snapshot.mode);
      container.setAttribute("data-camera-projection", snapshot.projection);
      container.setAttribute(
        "data-camera-azimuth-deg",
        String(snapshot.azimuthDeg),
      );
      container.setAttribute(
        "data-camera-elevation-deg",
        String(snapshot.elevationDeg),
      );
      container.setAttribute(
        "data-camera-distance-mm",
        String(snapshot.distanceMm),
      );
    },
    [],
  );

  /**
   * The gesture-commit ledger: how many `onUserCamera` records this mount
   * has committed. Written to the container as `data-camera-commit-count`
   * beside the snapshot readouts — it makes the commit-once-per-gesture
   * law (ADR: user-camera overlay) observable from outside the page, the
   * same machine-surface discipline as `data-rendered-frames`.
   */
  const userCameraCommitsRef = useRef(0);
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    container.setAttribute(
      "data-camera-commit-count",
      String(userCameraCommitsRef.current),
    );
  }, []);
  const handleUserCamera = useCallback(
    (camera: Parameters<NonNullable<SceneOnUserCameraProp>>[0]): void => {
      userCameraCommitsRef.current += 1;
      const container = containerRef.current;
      if (container !== null) {
        container.setAttribute(
          "data-camera-commit-count",
          String(userCameraCommitsRef.current),
        );
      }
      onUserCamera?.(camera);
    },
    [onUserCamera],
  );

  const toolActive = toolsApi !== null && toolsApi.phase === "active";
  const explicitInteraction =
    onPick !== undefined ||
    onPickDown !== undefined ||
    onPickUp !== undefined ||
    onHover !== undefined;
  const selection =
    selectionProp !== undefined ? selectionProp : selectionApi?.selected;
  const regeneration =
    regenerationProp !== undefined
      ? regenerationProp
      : selectionApi?.regeneration;

  const handleScenePickDown = (pick: CadPick): void => {
    pickDownRef.current = true;
    if (toolsApi !== null && toolsApi.phase === "active") {
      toolsApi.dispatch(
        toolPointerEvent("pointer-down", pick, modifiersRef.current),
      );
    }
  };

  const handleScenePickUp = (pick: CadPick): void => {
    pickUpRef.current = true;
    if (toolsApi !== null && toolsApi.phase === "active") {
      toolsApi.dispatch(
        toolPointerEvent("pointer-up", pick, modifiersRef.current),
      );
      return;
    }
    // No active tool: the direct-selection defaults (shift = additive).
    selectionApi?.pick(pick.reference, modifiersRef.current.shift);
  };

  const handleSceneHover = (pick: CadPick | null): void => {
    if (toolsApi !== null && toolsApi.phase === "active") {
      toolsApi.dispatch(
        toolPointerEvent("pointer-move", pick, modifiersRef.current),
      );
      return;
    }
    selectionApi?.hoverReference(pick === null ? null : pick.reference);
  };

  // Prop-driven passthrough beats the provider wiring; without either, the
  // scene gets no handlers at all (display-only — its meshes never go
  // interactive).
  const sceneInteraction = explicitInteraction
    ? { onHover, onPick, onPickDown, onPickUp }
    : toolsApi !== null || selectionApi !== null
      ? {
          onHover: handleSceneHover,
          onPickDown: handleScenePickDown,
          onPickUp: handleScenePickUp,
        }
      : {};

  const handleContainerPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    emptyDownRef.current =
      !pickDownRef.current &&
      !insideOverlay(overlayLayerRef.current, event.target);
    if (toolActive && emptyDownRef.current) {
      toolsApi?.dispatch(
        toolPointerEvent("pointer-down", null, toolModifiersFromNative(event)),
      );
    }
  };

  const handleContainerPointerUp = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    const onEmptySpace =
      !pickUpRef.current &&
      !insideOverlay(overlayLayerRef.current, event.target);
    if (toolActive) {
      if (onEmptySpace) {
        toolsApi?.dispatch(
          toolPointerEvent("pointer-up", null, toolModifiersFromNative(event)),
        );
      }
      return;
    }
    // A click that never touched the model clears the selection (a drag
    // that STARTED on the model does not: the down carried a pick).
    if (onEmptySpace && emptyDownRef.current) {
      selectionApi?.clear();
    }
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (insideOverlay(overlayLayerRef.current, event.target)) return;
    if (event.key === "Escape") {
      toolsApi?.cancel();
      return;
    }
    if (toolActive) {
      toolsApi?.dispatch(
        toolKeyEvent("key-down", event.key, toolModifiersFromNative(event)),
      );
    }
  };

  const handleKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (insideOverlay(overlayLayerRef.current, event.target)) return;
    if (toolActive) {
      toolsApi?.dispatch(
        toolKeyEvent("key-up", event.key, toolModifiersFromNative(event)),
      );
    }
  };

  return (
    <div
      aria-label={labels.viewportLabel}
      className={cn(
        "relative h-80 w-full overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-ring/80",
        className,
      )}
      ref={containerRef}
      role="group"
      style={{ backgroundColor: studioPalette.background }}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onPointerDown={handleContainerPointerDown}
      onPointerDownCapture={(event) => {
        modifiersRef.current = toolModifiersFromNative(event);
        pickDownRef.current = false;
      }}
      onPointerUp={handleContainerPointerUp}
      onPointerUpCapture={(event) => {
        modifiersRef.current = toolModifiersFromNative(event);
        pickUpRef.current = false;
      }}
    >
      {projection === null ? (
        <div
          className="flex h-full items-center justify-center text-sm text-muted-foreground"
          role="status"
        >
          {labels.loading}
        </div>
      ) : (
        <CadScene
          cameraControls={cameraControls}
          clippingPlanes={clippingPlanes}
          cameraOrbitDragEnabled={cameraOrbitDragEnabled}
          displayMode={displayMode}
          onCameraState={handleCameraState}
          onSelectionRendered={onSelectionRendered}
          onSettled={onSettled}
          // The wrapper counts commits for the machine surface; it must
          // stay `undefined` without the prop (the scene treats a missing
          // callback as "no overlay host" — a defined wrapper would flip
          // that law).
          onUserCamera={
            onUserCamera === undefined ? undefined : handleUserCamera
          }
          palette={studioPalette}
          pickCategory={pickCategory}
          projection={projection}
          regeneration={regeneration}
          selection={selection}
          userCamera={userCamera}
          {...sceneInteraction}
        />
      )}
      {overlay !== undefined && overlay !== null ? (
        <div
          className="pointer-events-none absolute inset-0"
          ref={overlayLayerRef}
        >
          {overlay}
        </div>
      ) : null}
    </div>
  );
}
