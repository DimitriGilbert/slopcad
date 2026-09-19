import { useRef } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
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
  CAD_SCENE_BACKGROUND,
  CadScene,
  toolKeyEvent,
  toolModifiersFromNative,
  toolPointerEvent,
  type CadPick,
  type CadPickCategory,
} from "@slopcad/cad-r3f";
import { cn } from "cn";

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
  className,
  labels: labelOverrides,
  onHover,
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
}: CadViewportProps) {
  const labels: CadViewportLabels = {
    ...CAD_VIEWPORT_LABELS,
    ...labelOverrides,
  };
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
        "relative h-80 w-full overflow-hidden outline-none focus-visible:ring-1 focus-visible:ring-ring/50",
        className,
      )}
      role="group"
      style={{ backgroundColor: CAD_SCENE_BACKGROUND }}
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
          onSelectionRendered={onSelectionRendered}
          onSettled={onSettled}
          pickCategory={pickCategory}
          projection={projection}
          regeneration={regeneration}
          selection={selection}
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
