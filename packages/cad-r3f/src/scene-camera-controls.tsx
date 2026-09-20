/**
 * `SceneCameraControls` — the interactive camera layer of the deterministic
 * scene, mounted inside `CadScene` only when a host opts in
 * (`cameraControls`). The contract it keeps:
 *
 * ## Determinism is structural, not promised
 *
 * With no user input, nothing in this component runs: no effect touches
 * the camera, no frame is scheduled, and the rig's spec application stands
 * — the boot pixels are the spec camera's, byte for byte. A gesture is
 * the only writer: the first orbit/pan/zoom seeds an {@link OrbitState}
 * from the CURRENT camera (the freshly applied spec view, so takeover
 * never jumps), and from then on the state — not the spec — places the
 * camera between demand frames. A content change of the spec (a document
 * edit re-fits the view) resets to spec law and the next gesture re-seeds:
 * the host's existing re-fit behavior is preserved exactly.
 *
 * ## Gesture vocabulary (the CAD conventions)
 *
 * - **Left-drag = orbit** around the seed target (elevation clamped so
 *   the eye can neither dive under the ground plane nor flip through the
 *   pole).
 * - **Wheel = dolly** (exponential, distance clamped inside the scene's
 *   clip planes), `preventDefault`-ed so a zoom never page-scrolls.
 * - **Middle-drag / Shift-left-drag = pan** (the grab-the-model
 *   convention; middle avoids fighting the context menu, and the
 *   pointerdown's `preventDefault` kills browser autoscroll).
 * - **Arrow keys (viewport focused) = orbit** in fixed steps — keyboard
 *   access to the same camera the pointer moves.
 *
 * ## Click vs. drag: selection stays exact
 *
 * Listeners attach to the canvas in the CAPTURE phase, so they run before
 * the pointer ever reaches R3F's container-level handlers. A gesture that
 * never crosses {@link CAD_ORBIT_DRAG_THRESHOLD_PX} is a click: nothing is
 * stopped, and R3F's pick pipeline (down/up/click raycasts) proceeds
 * untouched. A gesture past the threshold is a camera move: its moves and
 * the terminating pointerup/click are stopped before R3F or the host
 * container sees them — a drag never selects, hovers, or clears.
 *
 * ## The machine surface
 *
 * Every applied change (and every reset to spec law) reports a
 * {@link SceneCameraStateSnapshot} through `onCameraState`; the host
 * publishes it as `data-camera-*` attributes. The callback is called
 * outside React's render — a drag never re-renders the host, it only
 * writes attributes and invalidates demand frames.
 */

import { useEffect, useRef } from "react";
import type { RenderCamera } from "@slopcad/cad-core";
import { useThree } from "@react-three/fiber";

export type { SceneCameraStateSnapshot } from "./orbit-controls";

import {
  CAD_ORBIT_DRAG_THRESHOLD_PX,
  CAD_ORBIT_KEY_STEP_DEG,
  createOrbitState,
  orbitByKeys,
  orbitByPixels,
  orbitPosition,
  orbitSnapshot,
  panByPixels,
  sceneCameraStateFromSpec,
  zoomByWheel,
  type OrbitState,
  type SceneCameraStateSnapshot,
} from "./orbit-controls";
import { camerasEqual } from "./scene-camera";

/** Props of {@link SceneCameraControls}. */
export interface SceneCameraControlsProps {
  /** The applied camera spec: re-seeded whenever its content changes. */
  readonly spec: RenderCamera;
  /**
   * Whether left-drag-orbit is currently available. A host with an armed
   * tool that owns model drags passes `false` — the tool keeps its
   * gesture; wheel zoom, pan, and the keyboard still move the camera.
   */
  readonly orbitDragEnabled: boolean;
  /** Receives the camera state after every applied change or reset. */
  readonly onCameraState: (snapshot: SceneCameraStateSnapshot) => void;
}

/** One live pointer gesture, from down to up. */
interface CameraGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  lastX: number;
  lastY: number;
  readonly mode: "orbit" | "pan";
  /** False until the travel crosses the click threshold. */
  dragging: boolean;
}

/**
 * The interactive camera layer. Renders nothing; it owns listeners on the
 * canvas and the user-camera state between gestures (see the module doc
 * for the contract).
 */
export function SceneCameraControls({
  onCameraState,
  orbitDragEnabled,
  spec,
}: SceneCameraControlsProps): null {
  const get = useThree((state) => state.get);
  const invalidate = useThree((state) => state.invalidate);
  const size = useThree((state) => state.size);

  const enabledRef = useRef(true);
  const orbitDragEnabledRef = useRef(orbitDragEnabled);
  const onCameraStateRef = useRef(onCameraState);
  const specRef = useRef(spec);
  useEffect(() => {
    orbitDragEnabledRef.current = orbitDragEnabled;
    onCameraStateRef.current = onCameraState;
  }, [onCameraState, orbitDragEnabled]);

  const orbitRef = useRef<OrbitState | null>(null);
  const gestureRef = useRef<CameraGesture | null>(null);
  /** A drag just ended: the next DOM click is the drag's tail, not a pick. */
  const suppressClickRef = useRef(false);

  /** Seeds the user state from the current camera (a no-op once seeded). */
  const seedFromCamera = (): OrbitState => {
    const existing = orbitRef.current;
    if (existing !== null) return existing;
    const camera = get().camera;
    const specNow = specRef.current;
    const eye: [number, number, number] = [
      camera.position.x,
      camera.position.y,
      camera.position.z,
    ];
    const distance = Math.hypot(
      eye[0] - specNow.target[0],
      eye[1] - specNow.target[1],
      eye[2] - specNow.target[2],
    );
    const verticalFovRad =
      specNow.kind === "perspective"
        ? (specNow.fovDeg * Math.PI) / 180
        : 2 * Math.atan(specNow.viewHeight / 2 / distance);
    const state = createOrbitState({
      position: eye,
      target: specNow.target,
      up: specNow.up,
      verticalFovRad,
      viewportHeight: Math.max(1, get().size.height),
    });
    orbitRef.current = state;
    return state;
  };

  /** Places the camera at the user state and schedules the demand frame. */
  const applyAndReport = (): void => {
    const state = orbitRef.current;
    if (state === null) return;
    const camera = get().camera;
    const [x, y, z] = orbitPosition(state);
    camera.position.set(x, y, z);
    camera.up.set(state.poleX, state.poleY, state.poleZ);
    camera.lookAt(state.targetX, state.targetY, state.targetZ);
    camera.updateMatrixWorld();
    invalidate();
    onCameraStateRef.current(orbitSnapshot(state, "user"));
  };

  /** Returns to spec law (a re-fit): the next gesture re-seeds. */
  const resetToSpec = (): void => {
    orbitRef.current = null;
    gestureRef.current = null;
    onCameraStateRef.current(
      sceneCameraStateFromSpec(specRef.current, Math.max(1, get().size.height)),
    );
  };

  // The initial report: the boot camera is the spec camera, published so
  // tests can assert the starting pose before any gesture.
  useEffect(() => {
    onCameraStateRef.current(
      sceneCameraStateFromSpec(specRef.current, Math.max(1, get().size.height)),
    );
    // Once per mount: this is the boot pose.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Spec content changes re-fit the view (the host's existing behavior):
  // user state is discarded and the machine surface returns to "spec".
  useEffect(() => {
    const previous = specRef.current;
    specRef.current = spec;
    if (previous !== null && !camerasEqual(previous, spec)) {
      resetToSpec();
    }
    // `spec` identity changes every projection rebuild; the content check
    // above decides whether the view actually re-fit.
  }, [spec]);

  // A viewport resize re-applies the SPEC via the rig's own effect; a user
  // camera re-applies itself right after (this effect runs later in the
  // same commit — the controls mount after the rig), so an orbit survives
  // a resize without snapping back to the spec.
  useEffect(() => {
    if (orbitRef.current === null) return;
    applyAndReport();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.height, size.width]);

  // The gesture listeners: capture phase on the canvas, so they run before
  // R3F's container handlers and can hold a camera drag back from the
  // pick pipeline entirely (see the module doc).
  useEffect(() => {
    const canvas = get().gl.domElement;

    const onPointerDown = (event: PointerEvent): void => {
      suppressClickRef.current = false;
      if (!enabledRef.current) return;
      // Mouse and pen only: a single-finger touch still scrolls the page
      // and picks; two-finger camera gestures are a later concern.
      if (event.pointerType === "touch") return;
      const pan =
        (event.pointerType === "mouse" && event.button === 1) ||
        (event.button === 0 && event.shiftKey);
      const orbit = event.button === 0 && !event.shiftKey;
      if (!pan && !orbit) return;
      if (orbit && !orbitDragEnabledRef.current) return;
      if (event.button === 1) {
        // The middle button's browser default is autoscroll.
        event.preventDefault();
      }
      gestureRef.current = {
        dragging: false,
        lastX: event.clientX,
        lastY: event.clientY,
        mode: pan ? "pan" : "orbit",
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
      };
    };

    const onPointerMove = (event: PointerEvent): void => {
      const gesture = gestureRef.current;
      if (gesture === null || event.pointerId !== gesture.pointerId) return;
      if (!gesture.dragging) {
        const traveled = Math.hypot(
          event.clientX - gesture.startX,
          event.clientY - gesture.startY,
        );
        if (traveled < CAD_ORBIT_DRAG_THRESHOLD_PX) return;
        gesture.dragging = true;
        suppressClickRef.current = false;
        seedFromCamera();
        canvas.setPointerCapture(event.pointerId);
      }
      // A live camera drag never reaches the pick pipeline: no hover, no
      // tool dispatch, no container empty-space handling.
      event.stopPropagation();
      const state = orbitRef.current;
      if (state === null) return;
      const dx = event.clientX - gesture.lastX;
      const dy = event.clientY - gesture.lastY;
      if (gesture.mode === "orbit") {
        orbitByPixels(state, dx, dy);
      } else {
        panByPixels(state, dx, dy);
      }
      applyAndReport();
      gesture.lastX = event.clientX;
      gesture.lastY = event.clientY;
    };

    const endGesture = (event: PointerEvent, suppress: boolean): void => {
      const gesture = gestureRef.current;
      if (gesture === null || event.pointerId !== gesture.pointerId) return;
      gestureRef.current = null;
      if (suppress && gesture.dragging) {
        // The drag was camera, not a pick: R3F's pointerup (and the
        // container's selection handling) never see it.
        suppressClickRef.current = true;
        event.stopPropagation();
      }
    };

    const onPointerUp = (event: PointerEvent): void => {
      endGesture(event, true);
    };

    const onPointerCancel = (event: PointerEvent): void => {
      endGesture(event, false);
    };

    const onClick = (event: MouseEvent): void => {
      if (!suppressClickRef.current) return;
      // R3F raycasts DOM clicks: a camera drag's click must not pick.
      suppressClickRef.current = false;
      event.stopPropagation();
    };

    const onWheel = (event: WheelEvent): void => {
      if (!enabledRef.current) return;
      // A zoom never page-scrolls, and R3F's wheel handling never sees it.
      event.preventDefault();
      event.stopPropagation();
      const state = seedFromCamera();
      zoomByWheel(state, event.deltaY);
      applyAndReport();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (!enabledRef.current) return;
      if (
        event.key !== "ArrowLeft" &&
        event.key !== "ArrowRight" &&
        event.key !== "ArrowUp" &&
        event.key !== "ArrowDown"
      ) {
        return;
      }
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      // Keyboard camera access lives where the viewport has focus: the
      // focused element is the viewport host (an ancestor of the canvas),
      // and never a text field.
      const active = document.activeElement;
      if (
        !(active instanceof HTMLElement) ||
        active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        active.tagName === "SELECT" ||
        active.isContentEditable ||
        !active.contains(canvas)
      ) {
        return;
      }
      event.preventDefault();
      const state = seedFromCamera();
      const step = CAD_ORBIT_KEY_STEP_DEG;
      orbitByKeys(
        state,
        event.key === "ArrowLeft"
          ? -step
          : event.key === "ArrowRight"
            ? step
            : 0,
        event.key === "ArrowUp" ? step : event.key === "ArrowDown" ? -step : 0,
      );
      applyAndReport();
    };

    canvas.addEventListener("pointerdown", onPointerDown, { capture: true });
    canvas.addEventListener("pointermove", onPointerMove, { capture: true });
    canvas.addEventListener("pointerup", onPointerUp, { capture: true });
    canvas.addEventListener("pointercancel", onPointerCancel, {
      capture: true,
    });
    canvas.addEventListener("click", onClick, { capture: true });
    canvas.addEventListener("wheel", onWheel, {
      capture: true,
      passive: false,
    });
    document.addEventListener("keydown", onKeyDown);
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown, {
        capture: true,
      });
      canvas.removeEventListener("pointermove", onPointerMove, {
        capture: true,
      });
      canvas.removeEventListener("pointerup", onPointerUp, { capture: true });
      canvas.removeEventListener("pointercancel", onPointerCancel, {
        capture: true,
      });
      canvas.removeEventListener("click", onClick, { capture: true });
      canvas.removeEventListener("wheel", onWheel, { capture: true });
      document.removeEventListener("keydown", onKeyDown);
    };
    // The handlers read everything mutable through refs; `get` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [get]);

  return null;
}
