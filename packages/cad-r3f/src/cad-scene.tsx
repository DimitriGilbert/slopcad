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
 *   per camera application (`SceneCameraRig`), one per selection/
 *   picking-prop change (`SceneModel`'s effect; a freshly mounted face
 *   highlight or a material change is otherwise invisible until the next
 *   frame), and — on OPT-IN interactive camera hosts only — one per
 *   applied camera gesture (`SceneCameraControls`). No rAF drift, no
 *   animation, no unscheduled frames.
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
 * `onCameraSettled` is the camera-application counterpart: a COMMITTED
 * camera state that reaches its first rendered frame on an already-settled
 * projection reports once (see SettleProbe). The camera-series exports and
 * every camera-driven render ledger advance ride this signal — a frame's
 * pixels may be captured only after the camera that should have drawn them
 * has provably rendered.
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
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { SSAOPass } from "three/examples/jsm/postprocessing/SSAOPass.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import type { ReactElement } from "react";
import {
  selectionReferenceKey,
  type RenderCamera,
  type RenderProjection,
  type SelectionReference,
} from "@slopcad/cad-core";
import type { CadPick, CadPickCategory } from "./picking";
import type { CadDisplayMode } from "./display-mode";

import { CadModel } from "./cad-model";
import {
  applySceneCamera,
  camerasEqual,
  createSceneCamera,
  type SceneCamera,
} from "./scene-camera";
import {
  SceneCameraControls,
  type SceneCameraStateSnapshot,
} from "./scene-camera-controls";
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
import { CAD_LIGHT_RIG_STUDIO, type CadLightRig } from "./lighting";
import {
  CAD_QUALITY_SHADOW_GROUND_OPACITY,
  CAD_QUALITY_SSAO_KERNEL_RADIUS_MM,
  CAD_QUALITY_SSAO_MAX_DISTANCE_MM,
  CAD_QUALITY_SSAO_MIN_DISTANCE_MM,
  type CadRenderQuality,
} from "./render-quality";
import { CAD_SCENE_GRID_DROP_MM } from "./scene-ground";

// The camera-spec value comparison stays public from here (its original
// home) — the canonical definition lives beside the camera mapping.
export { camerasEqual } from "./scene-camera";
export type { SceneCameraStateSnapshot } from "./scene-camera-controls";

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

export interface CadSceneProps {
  /**
   * Section clipping planes (Phase 46): three.js local clipping applied
   * to the model's materials when non-empty — the render-level half of a
   * section display record, deterministic given state. Absent or empty
   * keeps the unclipped raster byte-identical (the boot-state law).
   */
  readonly clippingPlanes?: THREE.Plane[];
  /** The validated render projection, camera spec included. */
  readonly projection: RenderProjection;
  /**
   * Fires once per projection change, on the first demand frame after its
   * geometry is committed AND its camera applied (see the settle protocol
   * above).
   */
  readonly onSettled?: () => void;
  /**
   * Fires once per COMMITTED camera state that actually rendered, when the
   * projection itself is already settled (see the settle protocol above):
   * a user-camera overlay application, a standard view, a restored spec —
   * each reports on its first demand frame after the rig applied it. Never
   * fires per pointer move (a drag stays off the React render path) and
   * never for the frame that settles a projection (that frame's
   * {@link onSettled} already covers its camera).
   */
  readonly onCameraSettled?: () => void;
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
  /**
   * Opts the scene into INTERACTIVE camera controls (left-drag orbit,
   * wheel dolly, middle/shift-drag pan, arrow-key orbit). Default `false`
   * — the deterministic spec camera, unchanged for every fixture that
   * pins bytes. With controls on, the boot camera is still the spec's
   * (applied by the rig, untouched until the first gesture), so a page
   * with controls renders byte-identically to one without until a user
   * actually moves the camera.
   */
  readonly cameraControls?: boolean;
  /**
   * Whether left-drag-orbit is currently available (camera controls only).
   * A host with an armed tool that owns model drags passes `false` while
   * the tool is live — the tool keeps its gesture; wheel zoom, pan, and
   * the arrow keys still move the camera. Default `true`.
   */
  readonly cameraOrbitDragEnabled?: boolean;
  /**
   * Receives the camera state (mode + azimuth/elevation/distance) once at
   * boot and after every applied camera change — the host's machine
   * surface for tests and readouts. Called outside render; a camera drag
   * never re-renders the host.
   */
  readonly onCameraState?: (snapshot: SceneCameraStateSnapshot) => void;
  /**
   * The session-scoped USER camera overlay (Phase 45): when present it
   * replaces the projection's spec for RENDERING ONLY — the rig applies
   * it through the same spec-is-law mapping, nothing serializes it, and
   * `null` (the default) is the exact pre-Phase-45 behavior. See
   * `docs/architecture/adr-user-camera-overlay.md`.
   */
  readonly userCamera?: RenderCamera | null;
  /**
   * Reports a user-camera RECORD the controls derived from a gesture
   * (committed at gesture end, each wheel notch, each key step — never
   * per pointer move, so a drag stays off the React render path). The
   * host stores it session-scoped and passes it back through
   * {@link userCamera}; it fires only from user input.
   */
  readonly onUserCamera?: (camera: RenderCamera) => void;
  /**
   * The display mode (Phase 45): `shaded` (the default — the pinned
   * bytes), `shaded-edges`, `wireframe`, or `hidden-line` (see
   * `display-mode.ts` for each mode's honest scope).
   */
  readonly displayMode?: CadDisplayMode;
  /**
   * The light rig (Phase 59): a `lighting.ts` preset. Default `"studio"`
   * (the pinned Phase 11.3 constants verbatim), so the boot bytes are the
   * pre-rig scene's bytes.
   */
  readonly lightRig?: CadLightRig;
  /**
   * The render quality (Phase 59): `"standard"` (the default — the pinned
   * boot path) or `"quality"` (soft shadows + SSAO + the fixed post
   * chain, opt-in and unpinned — see `render-quality.ts`).
   */
  readonly renderQuality?: CadRenderQuality;
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
  displayMode,
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
  shadows,
  clippingPlanes,
}: {
  displayMode?: CadDisplayMode;
  material?: { readonly color: string };
  /** Section clipping (Phase 46): absent/empty = the unclipped raster. */
  clippingPlanes?: THREE.Plane[];
  /** Quality mode's shadow participation (Phase 59); default off. */
  shadows?: boolean;
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
  }, [
    clippingPlanes,
    displayMode,
    invalidate,
    material,
    pickCategory,
    regeneration,
    selection,
    shadows,
  ]);
  return (
    <CadModel
      clippingPlanes={clippingPlanes}
      displayMode={displayMode}
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
      shadows={shadows}
    />
  );
}

/**
 * The quality mode's renderer state (Phase 59): shadow maps on, and the
 * fixed render → SSAO → output post chain taking over the frame through a
 * priority-1 `useFrame` (R3F skips its auto-render once any callback has
 * priority > 0, so the composer IS the frame while quality mode is on).
 * Everything is fixed constants — same state, same bytes, run over run —
 * and the default path never mounts this component, so the pinned
 * boot raster is untouched (the opt-in/unpinned discipline). The built
 * chain is tracked and disposed whenever it is replaced (the memo rebuilds
 * on a resize or a camera-kind swap) and on unmount (the quality toggle) —
 * see the disposal effect below.
 */
function QualityPostProcessor(): null {
  const gl = useThree((state) => state.gl);
  const scene = useThree((state) => state.scene);
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    // The hook only ever runs inside a Canvas, but a mocked-three host
    // (the jsdom suites) mounts the scene without a renderer: guard
    // instead of crashing the whole scene tree.
    if (gl === undefined) return;
    gl.shadowMap.enabled = true;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    invalidate();
    return () => {
      gl.shadowMap.enabled = false;
      invalidate();
    };
  }, [gl, invalidate]);
  // The built chain, tracked as a unit (composer + its SSAO pass) so every
  // teardown path can release both. Keyed on size and camera identity: a
  // resize or a camera-kind swap REPLACES the chain, unmount (quality
  // toggled off) DROPS it.
  const chain = useMemo(() => {
    if (gl === undefined) return null;
    const composer = new EffectComposer(gl);
    composer.addPass(new RenderPass(scene, camera));
    const ssao = new SSAOPass(scene, camera, size.width, size.height);
    ssao.kernelRadius = CAD_QUALITY_SSAO_KERNEL_RADIUS_MM;
    ssao.minDistance = CAD_QUALITY_SSAO_MIN_DISTANCE_MM;
    ssao.maxDistance = CAD_QUALITY_SSAO_MAX_DISTANCE_MM;
    composer.addPass(ssao);
    composer.addPass(new OutputPass());
    return { composer, ssao };
  }, [camera, gl, scene, size.height, size.width]);
  // Disposal (three@0.186 semantics): the composer's dispose frees its two
  // ping-pong targets and the copy pass ONLY — the SSAO pass holds its own
  // render targets and materials, released solely by its explicit dispose.
  // The cleanup runs on unmount and whenever the memo rebuilt (the closure's
  // `chain` is the replaced value), so no rebuild strands the old chain's
  // GPU targets on the shared canvas context.
  useEffect(() => {
    return () => {
      chain?.ssao.dispose();
      chain?.composer.dispose();
    };
  }, [chain]);
  useEffect(() => {
    chain?.composer.setSize(size.width, size.height);
  }, [chain, size.height, size.width]);
  useFrame(() => {
    chain?.composer.render();
  }, 1);
  return null;
}

/**
 * The settle probe: reports the current projection once, on the first frame
 * the demand loop runs after that projection's content is applied — its
 * geometry synced through the model's controller AND the EFFECTIVE camera
 * applied by the rig (the user overlay's, when present — the settle ledger),
 * not merely after the projection prop arrived (module doc).
 *
 * The camera-only counterpart: when the projection is already settled and
 * the rig APPLIES a new camera spec (a committed application — the rig
 * writes a fresh spec object per application, and the application's first
 * demand frame carries it), `onCameraSettled` fires once. Application
 * IDENTITY, not camera content, is what counts: a re-applied content-equal
 * camera still rendered a new frame, while frames invalidated by
 * selection/display changes re-run no rig application and count nothing.
 * A drag never re-renders the host per pointer move, so there is nothing
 * to count between commits. The frame that settles a projection also
 * settles its camera (one report, never two).
 */
export function SettleProbe({
  camera,
  onCameraSettled,
  onSettled,
  projection,
  settle,
}: {
  /** The effective camera the frame must have applied (overlay ?? spec). */
  camera: RenderCamera;
  onCameraSettled?: () => void;
  onSettled?: () => void;
  projection: RenderProjection;
  settle: SettleLedger;
}): null {
  const reportedRef = useRef<RenderProjection | null>(null);
  // The appliedCamera OBJECT last reported: the rig reassigns
  // `settle.appliedCamera` on every application, so identity is the
  // application epoch this frame reports.
  const reportedAppliedRef = useRef<RenderCamera | null>(null);
  const onSettledRef = useRef(onSettled);
  const onCameraSettledRef = useRef(onCameraSettled);
  // Layout timing: R3F's demand frame can run after this commit but before
  // the passive-effect flush (the reconciler invalidates during commit), and
  // a stale callback in that window reports the PREVIOUS render's state.
  useLayoutEffect(() => {
    onSettledRef.current = onSettled;
    onCameraSettledRef.current = onCameraSettled;
  });
  useFrame(() => {
    // Content gate: a frame scheduled during the projection's commit can run
    // before the passive effects apply its geometry and camera, so prop
    // identity is not evidence the frame will draw this projection.
    if (settle.syncedProjection !== projection) {
      return;
    }
    const appliedCamera = settle.appliedCamera;
    if (appliedCamera === null || !camerasEqual(appliedCamera, camera)) {
      return;
    }
    if (reportedRef.current !== projection) {
      reportedRef.current = projection;
      // This frame settles the camera too: the camera-only report below
      // must never double-count it.
      reportedAppliedRef.current = appliedCamera;
      onSettledRef.current?.();
      return;
    }
    // A rig application SINCE the last report, rendered by this frame:
    // exactly one report per application.
    if (reportedAppliedRef.current !== appliedCamera) {
      reportedAppliedRef.current = appliedCamera;
      onCameraSettledRef.current?.();
    }
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
  cameraControls = false,
  clippingPlanes,
  cameraOrbitDragEnabled = true,
  displayMode,
  lightRig = CAD_LIGHT_RIG_STUDIO,
  onCameraState,
  onCameraSettled,
  onHover,
  onPick,
  onPickDown,
  onPickUp,
  onSelectionRendered,
  onSettled,
  onUserCamera,
  palette = CAD_SCENE_DEFAULT_PALETTE,
  pickCategory,
  projection,
  regeneration,
  renderQuality = "standard",
  selection,
  showGround = true,
  userCamera = null,
}: CadSceneProps): ReactElement {
  const quality = renderQuality === "quality";
  // The Phase 45 effective camera: the user overlay when present, the
  // projection's spec otherwise (spec law, byte-identical, when absent).
  const effectiveCamera: RenderCamera = userCamera ?? projection.camera;
  // One settle ledger per mounted scene, shared by the appliers (the model's
  // geometry sync, the rig's camera effect) and the probe that gates on them.
  const [settle] = useState<SettleLedger>(() => ({
    syncedProjection: null,
    appliedCamera: null,
  }));
  // The camera-state reporter, identity-stable so the controls' listener
  // wiring never re-runs because the host passed an inline closure.
  const onCameraStateRef = useRef(onCameraState);
  useEffect(() => {
    onCameraStateRef.current = onCameraState;
  });
  const handleCameraState = useCallback(
    (snapshot: SceneCameraStateSnapshot): void => {
      onCameraStateRef.current?.(snapshot);
    },
    [],
  );
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
      gl={{
        antialias: false,
        localClippingEnabled: true,
        preserveDrawingBuffer: true,
      }}
    >
      <color attach="background" args={[palette.background]} />
      <SceneCameraRig settle={settle} spec={effectiveCamera} />
      {cameraControls ? (
        <SceneCameraControls
          cameraSource={userCamera === null ? "spec" : "user"}
          onCameraState={handleCameraState}
          onUserCamera={onUserCamera}
          orbitDragEnabled={cameraOrbitDragEnabled}
          spec={effectiveCamera}
        />
      ) : null}
      <CadSceneLights rig={lightRig} shadowKey={quality} />
      {showGround ? (
        <CadSceneGround colors={groundColors} target={effectiveCamera.target} />
      ) : null}
      {quality && showGround ? (
        // The shadow catcher (quality mode only): draws ONLY the soft
        // shadows the key light casts, on the grid's own plane — the
        // studio's boot scene has no shadow-casting light at all.
        <mesh
          position={[
            effectiveCamera.target[0],
            effectiveCamera.target[1],
            -CAD_SCENE_GRID_DROP_MM,
          ]}
          receiveShadow
          rotation-x={Math.PI / 2}
        >
          <planeGeometry args={[1000, 1000]} />
          <shadowMaterial opacity={CAD_QUALITY_SHADOW_GROUND_OPACITY} />
        </mesh>
      ) : null}
      {quality ? (
        // Mounted ONLY in quality mode: a priority-1 useFrame takes the
        // render loop away from R3F even when its body is a no-op, so a
        // permanently-mounted processor would blank the standard scene.
        <QualityPostProcessor />
      ) : null}
      <SceneModel
        clippingPlanes={clippingPlanes}
        displayMode={displayMode}
        material={material}
        shadows={quality}
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
        camera={effectiveCamera}
        onCameraSettled={onCameraSettled}
        onSettled={onSettled}
        projection={projection}
        settle={settle}
      />
    </Canvas>
  );
}
