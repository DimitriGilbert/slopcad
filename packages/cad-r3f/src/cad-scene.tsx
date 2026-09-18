/**
 * `CadScene` — the Phase 11.3 deterministic CAD scene: one mountable unit
 * composing the spec camera ({@link SceneCameraRig}), the fixed light rig
 * (`CadSceneLights`), the ground furniture (`CadSceneGround`: grid, world
 * axes, origin marker), and the Phase 11.2 `CadModel` — everything a
 * viewport renders, and nothing frame-dependent. Phase 12 picking builds on
 * this exact composition: the scene forwards the selection/picking props to
 * the model and extends the settle protocol to the highlight layer.
 *
 * ## Determinism contract (the spike rules, restated as scene law)
 *
 * - `frameloop="demand"`: pixels change only after an explicit
 *   `invalidate()` — one per applied projection sync (`SceneModel`), one
 *   per camera application (`SceneCameraRig`), and one per selection/
 *   picking-prop change (`SceneModel`'s effect; a freshly mounted face
 *   highlight or a material change is otherwise invisible until the next
 *   frame). No rAF drift, no animation, no controls.
 * - `dpr={1}` and `antialias: false`: no GPU-dependent resolve or MSAA.
 * - `preserveDrawingBuffer: true`: the canvas survives compositing for
 *   byte-exact screenshot capture.
 * - Fixed camera (from the projection's own `RenderCamera` spec), fixed
 *   lights, fixed furniture; geometry and the documented selection
 *   highlight are the only variables.
 * - The background is a documented constant instead of a transparent
 *   canvas, so pixels never depend on page CSS behind the canvas.
 *
 * ## Settle protocols
 *
 * `onSettled` fires once per projection change, from `useFrame` on the
 * first frame that frame-loops after the new geometry is committed — the
 * same timing the Phase 1.6 spike used to stamp rendered-volume markers,
 * now owned by the scene package (the spike handed the app a page-level
 * convention; this is the package-level equivalent). Pixels may only be
 * compared once a settle consumer has reported.
 *
 * `onSelectionRendered` is the Phase 12 counterpart for the highlight
 * layer: it fires with the canonical selection key (the references joined
 * through `selectionReferenceKey`) on the first demand frame that carried
 * that selection — so pixel evidence is taken only when the highlight is
 * provably on screen. R3F pointer events drive picking independently of the
 * frameloop (they raycast on the DOM event), so hover and click callbacks
 * fire between frames and the resulting state change triggers the
 * invalidation above.
 */

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ReactElement } from "react";
import {
  selectionReferenceKey,
  type RenderCamera,
  type RenderProjection,
  type SelectionReference,
} from "@slopcad/cad-core";
import type { CadPick, CadPickCategory } from "./picking";

import { CadModel } from "./cad-model";
import {
  applySceneCamera,
  createSceneCamera,
  type SceneCamera,
} from "./scene-camera";
import { CadSceneGround } from "./scene-ground";
import { CadSceneLights } from "./scene-lights";

/**
 * The scene's clear color. Dark neutral gray, chosen so the grid grays, the
 * RGB axis colors, and the default CadModel material all read at AA-off,
 * DPR-1 rasterization.
 */
export const CAD_SCENE_BACKGROUND = "#111827";

export interface CadSceneProps {
  /** The validated render projection, camera spec included. */
  readonly projection: RenderProjection;
  /**
   * Fires once per projection change, on the first demand frame after its
   * geometry is committed (see the settle protocol above).
   */
  readonly onSettled?: () => void;
  /**
   * Renders the ground furniture (grid, axes, origin marker). Default
   * `true`; the documented override for camera-only views.
   */
  readonly showGround?: boolean;
  /**
   * The current regeneration identity, forwarded to the model for synthetic
   * reference tagging and stale-highlight rejection. Defaults to 0.
   */
  readonly regeneration?: number;
  /** The selected references; drives the selection highlight. */
  readonly selection?: readonly SelectionReference[];
  /** Which domain reference a click resolves to. Defaults to `"face"`. */
  readonly pickCategory?: CadPickCategory;
  /** Reports resolved clicks as domain picks (forwarded to the model). */
  readonly onPick?: (pick: CadPick) => void;
  /** Reports resolved pointer-down picks (forwarded to the model). */
  readonly onPickDown?: (pick: CadPick) => void;
  /** Reports resolved pointer-up picks (forwarded to the model). */
  readonly onPickUp?: (pick: CadPick) => void;
  /** Reports deduplicated hover changes (forwarded to the model). */
  readonly onHover?: (pick: CadPick | null) => void;
  /**
   * Fires on the first demand frame carrying a NEW selection content, with
   * its canonical key — the highlight-layer settle signal.
   */
  readonly onSelectionRendered?: (selectionKey: string) => void;
}

/**
 * Maps the projection's camera spec onto the scene's default camera. The
 * camera instance is stable across renders (rebuilt only when the spec's
 * KIND changes); spec content and viewport size re-apply through an effect,
 * so no render ever constructs render-loop churn. Runs inside the Canvas.
 */
function SceneCameraRig({ spec }: { spec: RenderCamera }): null {
  const size = useThree((state) => state.size);
  const set = useThree((state) => state.set);
  const invalidate = useThree((state) => state.invalidate);
  const cameraRef = useRef<{
    kind: RenderCamera["kind"];
    camera: SceneCamera;
  } | null>(null);
  if (cameraRef.current === null || cameraRef.current.kind !== spec.kind) {
    cameraRef.current = {
      kind: spec.kind,
      camera: createSceneCamera(spec, size.width / size.height),
    };
  }
  const camera = cameraRef.current.camera;
  useEffect(() => {
    applySceneCamera(camera, spec, size.width / size.height);
    set({ camera });
    invalidate();
  }, [camera, invalidate, set, size.height, size.width, spec]);
  return null;
}

/**
 * Mounts the model renderer, converts every applied geometry snapshot into
 * exactly one `invalidate()` (the demand-frame trigger on updates), and
 * invalidates on selection/picking-prop changes so a freshly mounted
 * highlight or material change reaches the next demand frame.
 */
function SceneModel({
  onPick,
  onPickDown,
  onPickUp,
  onHover,
  pickCategory,
  projection,
  regeneration,
  selection,
}: {
  onPick?: (pick: CadPick) => void;
  onPickDown?: (pick: CadPick) => void;
  onPickUp?: (pick: CadPick) => void;
  onHover?: (pick: CadPick | null) => void;
  pickCategory?: CadPickCategory;
  projection: RenderProjection;
  regeneration?: number;
  selection?: readonly SelectionReference[];
}): ReactElement {
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    invalidate();
  }, [invalidate, pickCategory, regeneration, selection]);
  return (
    <CadModel
      onHover={onHover}
      onPick={onPick}
      onPickDown={onPickDown}
      onPickUp={onPickUp}
      onSync={() => invalidate()}
      pickCategory={pickCategory}
      projection={projection}
      regeneration={regeneration}
      selection={selection}
    />
  );
}

/**
 * The settle probe: reports the current projection once, on the first frame
 * the demand loop runs after it became the scene's content (module doc).
 */
function SettleProbe({
  onSettled,
  projection,
}: {
  onSettled?: () => void;
  projection: RenderProjection;
}): null {
  const reportedRef = useRef<RenderProjection | null>(null);
  const onSettledRef = useRef(onSettled);
  // Layout timing: R3F's demand frame can run after this commit but before
  // the passive-effect flush (the reconciler invalidates during commit), and
  // a stale callback in that window reports the PREVIOUS render's state.
  useLayoutEffect(() => {
    onSettledRef.current = onSettled;
  });
  useFrame(() => {
    if (reportedRef.current === projection) {
      return;
    }
    reportedRef.current = projection;
    onSettledRef.current?.();
  });
  return null;
}

/**
 * The highlight-layer settle probe: reports the selection's canonical key
 * once per content change, on the first demand frame that carried it.
 */
function SelectionProbe({
  onSelectionRendered,
  selection,
}: {
  onSelectionRendered?: (selectionKey: string) => void;
  selection?: readonly SelectionReference[];
}): null {
  const key = (selection ?? []).map(selectionReferenceKey).join(";");
  const reportedRef = useRef<string | null>(null);
  const onSelectionRenderedRef = useRef(onSelectionRendered);
  // Layout timing, same race as SettleProbe above: the demand frame must
  // never observe the callback from before this commit.
  useLayoutEffect(() => {
    onSelectionRenderedRef.current = onSelectionRendered;
  });
  useFrame(() => {
    if (reportedRef.current === key) {
      return;
    }
    reportedRef.current = key;
    onSelectionRenderedRef.current?.(key);
  });
  return null;
}

/**
 * The deterministic CAD scene: camera + lights + ground furniture + model,
 * as one mountable unit. Renders into its parent element's full box; give
 * the parent a fixed size for fixed-viewport pixel evidence.
 */
export function CadScene({
  onHover,
  onPick,
  onPickDown,
  onPickUp,
  onSelectionRendered,
  onSettled,
  pickCategory,
  projection,
  regeneration,
  selection,
  showGround = true,
}: CadSceneProps): ReactElement {
  return (
    <Canvas
      frameloop="demand"
      dpr={1}
      gl={{ antialias: false, preserveDrawingBuffer: true }}
    >
      <color attach="background" args={[CAD_SCENE_BACKGROUND]} />
      <SceneCameraRig spec={projection.camera} />
      <CadSceneLights />
      {showGround ? <CadSceneGround target={projection.camera.target} /> : null}
      <SceneModel
        onHover={onHover}
        onPick={onPick}
        onPickDown={onPickDown}
        onPickUp={onPickUp}
        pickCategory={pickCategory}
        projection={projection}
        regeneration={regeneration}
        selection={selection}
      />
      <SelectionProbe
        onSelectionRendered={onSelectionRendered}
        selection={selection}
      />
      <SettleProbe onSettled={onSettled} projection={projection} />
    </Canvas>
  );
}
