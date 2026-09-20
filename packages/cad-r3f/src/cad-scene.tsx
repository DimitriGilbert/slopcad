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
 * first frame that frame-loops after the projection's CONTENT is applied —
 * its geometry synced through the model's geometry controller AND its
 * camera mapped onto the scene camera. The probe gates on a settle ledger
 * of what has actually been applied, not on the projection prop's
 * identity: R3F can schedule a demand frame between a commit and the
 * passive effects that apply it (geometry sync, camera application), and a
 * prop-identity probe would certify pixels that frame has not drawn. This
 * is the same timing the Phase 1.6 spike used to stamp rendered-volume
 * markers, now owned by the scene package (the spike handed the app a
 * page-level convention; this is the package-level equivalent). Pixels may
 * only be compared once a settle consumer has reported.
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
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  selectionReferenceKey,
  type RenderCamera,
  type RenderProjection,
  type RenderVector3,
  type SelectionReference,
} from "@slopcad/cad-core";
import type { CadPick, CadPickCategory } from "./picking";

import { CadModel } from "./cad-model";
import {
  applySceneCamera,
  createSceneCamera,
  type SceneCamera,
} from "./scene-camera";
import {
  CadSceneGround,
  CAD_SCENE_AXIS_X_COLOR,
  CAD_SCENE_AXIS_Y_COLOR,
  CAD_SCENE_AXIS_Z_COLOR,
  CAD_SCENE_GRID_CENTER_COLOR,
  CAD_SCENE_GRID_COLOR,
  CAD_SCENE_ORIGIN_MARKER_COLOR,
} from "./scene-ground";
import { CadSceneLights } from "./scene-lights";

/**
 * The scene's clear color. Studio graphite (the Machinist dark token
 * family), chosen so the grid grays, the RGB axis colors, and the
 * default CadModel material all read at AA-off, DPR-1 rasterization.
 */
export const CAD_SCENE_BACKGROUND = "#101318";

/** The default model material color (mirrors cad-model's constant). */
const CAD_SCENE_DEFAULT_MODEL_COLOR = "#aabdd6";

/**
 * The studio display palette: everything theme-carrying in the scene's
 * ink. The amber SELECTION highlight is deliberately absent — it is a
 * deterministic domain signal, not studio ink (see selection-highlight).
 */
export interface CadScenePalette {
  /** The backdrop (the `<color attach="background">` clear color). */
  readonly background: string;
  /** Minor grid line color. */
  readonly gridMinor: string;
  /** Major (centre-line) grid color. */
  readonly gridMajor: string;
  /** The X axis's convention color. */
  readonly axisX: string;
  /** The Y axis's convention color. */
  readonly axisY: string;
  /** The Z axis's convention color. */
  readonly axisZ: string;
  /** The origin marker's color. */
  readonly originMarker: string;
  /** The model's base material color (metalness/roughness unchanged). */
  readonly model: string;
}

/** The default palette: the documented Machinist night-bed constants. */
export const CAD_SCENE_DEFAULT_PALETTE: CadScenePalette = Object.freeze({
  background: CAD_SCENE_BACKGROUND,
  gridMinor: CAD_SCENE_GRID_COLOR,
  gridMajor: CAD_SCENE_GRID_CENTER_COLOR,
  axisX: CAD_SCENE_AXIS_X_COLOR,
  axisY: CAD_SCENE_AXIS_Y_COLOR,
  axisZ: CAD_SCENE_AXIS_Z_COLOR,
  originMarker: CAD_SCENE_ORIGIN_MARKER_COLOR,
  model: CAD_SCENE_DEFAULT_MODEL_COLOR,
} satisfies CadScenePalette);

/**
 * The content ledger the settle probe gates on: what has actually been
 * APPLIED to the scene, as opposed to what the props say. `SceneModel`
 * marks {@link SettleLedger.syncedProjection} once the geometry controller
 * has committed that projection's buffers, and `SceneCameraRig` marks
 * {@link SettleLedger.appliedCamera} once it has mapped that spec onto the
 * scene camera. `SettleProbe` reports a projection only on the first frame
 * where both entries cover it — prop identity alone proves nothing about
 * the pixels a frame will draw.
 */
export interface SettleLedger {
  /** The projection whose geometry the model has actually synced. */
  syncedProjection: RenderProjection | null;
  /** The camera spec the rig has actually applied (compared by content). */
  appliedCamera: RenderCamera | null;
}

function vectorsEqual(a: RenderVector3, b: RenderVector3): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/**
 * Whether two camera specs carry the same view: kind, framing vectors, and
 * the kind's projection parameters, compared by VALUE. Projections rebuild
 * their camera object on every change, and a host may equally share one
 * memoized spec across projections — the settle gate must care about the
 * camera content on screen, never about object identity.
 */
export function camerasEqual(a: RenderCamera, b: RenderCamera): boolean {
  if (a.kind !== b.kind) return false;
  if (!vectorsEqual(a.position, b.position)) return false;
  if (!vectorsEqual(a.target, b.target)) return false;
  if (!vectorsEqual(a.up, b.up)) return false;
  if (a.kind === "perspective" && b.kind === "perspective") {
    return a.fovDeg === b.fovDeg;
  }
  if (a.kind === "orthographic" && b.kind === "orthographic") {
    return a.viewWidth === b.viewWidth && a.viewHeight === b.viewHeight;
  }
  return false;
}

export interface CadSceneProps {
  /** The validated render projection, camera spec included. */
  readonly projection: RenderProjection;
  /**
   * Fires once per projection change, on the first demand frame after its
   * geometry is committed AND its camera applied (see the settle protocol
   * above).
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
  /**
   * The studio display palette: backdrop, ground ink, and the model's base
   * material color. Defaults to {@link CAD_SCENE_DEFAULT_PALETTE} (the
   * documented Machinist night-bed constants); a chrome-carrying host
   * resolves its own scheme+mode and passes the matching palette —
   * geometry, camera, and the amber selection highlight stay deterministic
   * either way. The palette object should be identity-stable per scheme
   * and mode (the host exports it) so ordinary renders never swap scene
   * ink.
   */
  readonly palette?: CadScenePalette;
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
function SceneCameraRig({
  settle,
  spec,
}: {
  settle: SettleLedger;
  spec: RenderCamera;
}): null {
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
    // Settle gate (b): record the spec this effect actually applied. Marked
    // after the application so the probe can never see a camera as applied
    // before it is.
    settle.appliedCamera = spec;
  }, [camera, invalidate, set, settle, size.height, size.width, spec]);
  return null;
}

/**
 * Mounts the model renderer, converts every applied geometry snapshot into
 * exactly one `invalidate()` (the demand-frame trigger on updates), and
 * invalidates on selection/picking-prop changes so a freshly mounted
 * highlight or material change reaches the next demand frame.
 */
function SceneModel({
  material,
  onPick,
  onPickDown,
  onPickUp,
  onHover,
  pickCategory,
  projection,
  regeneration,
  selection,
  settle,
}: {
  material?: { readonly color: string };
  onPick?: (pick: CadPick) => void;
  onPickDown?: (pick: CadPick) => void;
  onPickUp?: (pick: CadPick) => void;
  onHover?: (pick: CadPick | null) => void;
  pickCategory?: CadPickCategory;
  projection: RenderProjection;
  regeneration?: number;
  selection?: readonly SelectionReference[];
  settle: SettleLedger;
}): ReactElement {
  const invalidate = useThree((state) => state.invalidate);
  // Settle gate (a), the totality half: CadModel's geometry effects run
  // before this component's own (children first in the passive flush), so by
  // the time this effect runs, the controller has committed this
  // projection's buffers — including the content-equal update whose diff was
  // a no-op and whose `onSync` therefore stayed silent.
  useEffect(() => {
    settle.syncedProjection = projection;
  }, [settle, projection]);
  useEffect(() => {
    invalidate();
  }, [invalidate, material, pickCategory, regeneration, selection]);
  return (
    <CadModel
      material={material}
      onHover={onHover}
      onPick={onPick}
      onPickDown={onPickDown}
      onPickUp={onPickUp}
      onSync={() => {
        // Settle gate (a), the geometry-sync path's own report: the
        // snapshot instance changed, so this projection's content was
        // written into the buffers.
        settle.syncedProjection = projection;
        invalidate();
      }}
      pickCategory={pickCategory}
      projection={projection}
      regeneration={regeneration}
      selection={selection}
    />
  );
}

/**
 * The settle probe: reports the current projection once, on the first frame
 * the demand loop runs after that projection's content is applied — its
 * geometry synced through the model's controller AND its camera applied by
 * the rig (the settle ledger), not merely after the projection prop
 * arrived (module doc).
 */
export function SettleProbe({
  onSettled,
  projection,
  settle,
}: {
  onSettled?: () => void;
  projection: RenderProjection;
  settle: SettleLedger;
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
    // Content gate: a frame scheduled during the projection's commit can run
    // before the passive effects apply its geometry and camera, so prop
    // identity is not evidence the frame will draw this projection.
    if (settle.syncedProjection !== projection) {
      return;
    }
    const appliedCamera = settle.appliedCamera;
    if (
      appliedCamera === null ||
      !camerasEqual(appliedCamera, projection.camera)
    ) {
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
  palette = CAD_SCENE_DEFAULT_PALETTE,
  pickCategory,
  projection,
  regeneration,
  selection,
  showGround = true,
}: CadSceneProps): ReactElement {
  // One settle ledger per mounted scene, shared by the appliers (the model's
  // geometry sync, the rig's camera effect) and the probe that gates on them.
  const [settle] = useState<SettleLedger>(() => ({
    syncedProjection: null,
    appliedCamera: null,
  }));
  // Identity-stable per palette so the model's material prop and the
  // ground's memoized geometry never churn across ordinary renders.
  const groundColors = useMemo(
    () => ({
      minor: palette.gridMinor,
      major: palette.gridMajor,
      axisX: palette.axisX,
      axisY: palette.axisY,
      axisZ: palette.axisZ,
      origin: palette.originMarker,
    }),
    [
      palette.axisX,
      palette.axisY,
      palette.axisZ,
      palette.gridMajor,
      palette.gridMinor,
      palette.originMarker,
    ],
  );
  const material = useMemo(() => ({ color: palette.model }), [palette.model]);
  return (
    <Canvas
      frameloop="demand"
      dpr={1}
      gl={{ antialias: false, preserveDrawingBuffer: true }}
    >
      <color attach="background" args={[palette.background]} />
      <SceneCameraRig settle={settle} spec={projection.camera} />
      <CadSceneLights />
      {showGround ? (
        <CadSceneGround
          colors={groundColors}
          target={projection.camera.target}
        />
      ) : null}
      <SceneModel
        material={material}
        onHover={onHover}
        onPick={onPick}
        onPickDown={onPickDown}
        onPickUp={onPickUp}
        pickCategory={pickCategory}
        projection={projection}
        regeneration={regeneration}
        selection={selection}
        settle={settle}
      />
      <SelectionProbe
        onSelectionRendered={onSelectionRendered}
        selection={selection}
      />
      <SettleProbe
        onSettled={onSettled}
        projection={projection}
        settle={settle}
      />
    </Canvas>
  );
}
