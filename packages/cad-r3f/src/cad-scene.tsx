/**
 * `CadScene` — the Phase 11.3 deterministic CAD scene: one mountable unit
 * composing the spec camera ({@link SceneCameraRig}), the fixed light rig
 * (`CadSceneLights`), the ground furniture (`CadSceneGround`: grid, world
 * axes, origin marker), and the Phase 11.2 `CadModel` — everything a
 * viewport renders, and nothing frame-dependent. Phase 12 picking builds on
 * this exact composition.
 *
 * ## Determinism contract (the spike rules, restated as scene law)
 *
 * - `frameloop="demand"`: pixels change only after an explicit
 *   `invalidate()` — one per applied projection sync (`SceneModel`) and one
 *   per camera application (`SceneCameraRig`). No rAF drift, no animation,
 *   no controls.
 * - `dpr={1}` and `antialias: false`: no GPU-dependent resolve or MSAA.
 * - `preserveDrawingBuffer: true`: the canvas survives compositing for
 *   byte-exact screenshot capture.
 * - Fixed camera (from the projection's own {@link RenderCamera} spec),
 *   fixed lights, fixed furniture; geometry is the only variable.
 * - The background is a documented constant instead of a transparent
 *   canvas, so pixels never depend on page CSS behind the canvas.
 *
 * ## Settle protocol
 *
 * `onSettled` fires once per projection change, from `useFrame` on the
 * first frame that frame-loops after the new geometry is committed — the
 * same timing the Phase 1.6 spike used to stamp rendered-volume markers,
 * now owned by the scene package (the spike handed the app a page-level
 * convention; this is the package-level equivalent). Pixels may only be
 * compared once a settle consumer has reported.
 */

import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { useEffect, useRef } from "react";
import type { ReactElement } from "react";
import type { RenderCamera, RenderProjection } from "@slopcad/cad-core";

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
 * Mounts the model renderer and converts every applied geometry snapshot
 * into exactly one `invalidate()` — the demand-frame trigger on updates.
 */
function SceneModel({
  projection,
}: {
  projection: RenderProjection;
}): ReactElement {
  const invalidate = useThree((state) => state.invalidate);
  return <CadModel projection={projection} onSync={() => invalidate()} />;
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
  useEffect(() => {
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
 * The deterministic CAD scene: camera + lights + ground furniture + model,
 * as one mountable unit. Renders into its parent element's full box; give
 * the parent a fixed size for fixed-viewport pixel evidence.
 */
export function CadScene({
  onSettled,
  projection,
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
      <SceneModel projection={projection} />
      <SettleProbe onSettled={onSettled} projection={projection} />
    </Canvas>
  );
}
