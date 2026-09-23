/**
 * Viewport snapshot export (Phase 59): PNG capture of the live viewport
 * plus the turntable and isometric series' camera math.
 *
 * ## Determinism discipline
 *
 * Capture rides the e2e-render contract's guarantees — the deterministic
 * scene's `preserveDrawingBuffer: true` canvas at DPR 1 — so a captured
 * frame IS the settled pixels, and the same state always yields the same
 * bytes (asserted by the snapshot determinism suite). Nothing here
 * touches the document, the baselines, or the serialized state: exports
 * are user-command outputs.
 *
 * ## The camera series
 *
 * `turntableCameras` rotates the CURRENT effective camera's eye about the
 * world z-axis through its target (the classic N-step turntable);
 * `isometricSeriesCameras` walks the standard front/top/right/iso views
 * (the standard-views module's azimuth/elevation convention) at the
 * current camera's distance and target. Both are pure functions — the
 * host applies each camera through the session's user-camera overlay,
 * captures the settled frame, and restores the original overlay state.
 */

import type { RenderBounds, RenderCamera } from "@slopcad/cad-core";
import {
  standardViewCamera,
  type StandardViewId,
  type ViewAngleConvention,
} from "@slopcad/cad-r3f";

/** Triggers a browser download of `blob` under `filename`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Waits until the root's `data-rendered-frames` attribute reaches
 * `atLeast` — the frame ledger a camera application must advance before a
 * capture may read the canvas (a capture before the frame is a capture of
 * the PREVIOUS camera's pixels). Resolves anyway at the timeout; the
 * caller's determinism rests on the frame evidence, so a timeout degrades
 * to a possibly-stale frame, never a hang.
 */
export async function waitForRenderedFrame(
  rootId: string,
  atLeast: number,
  timeoutMs = 10_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let observed = 0;
  while (Date.now() < deadline) {
    observed = Number(
      document.getElementById(rootId)?.getAttribute("data-rendered-frames") ??
        "0",
    );
    if (observed >= atLeast) return observed;
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
  }
  return observed;
}

/** Captures the canvas' current pixels as a PNG blob. */
export function captureViewportPng(
  canvas: HTMLCanvasElement,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => {
      resolve(blob);
    }, "image/png");
  });
}

/** Rotates `[x, y, z]` about the z-axis by `angleDeg`. */
function rotateAboutZ(
  [x, y, z]: readonly [number, number, number],
  angleDeg: number,
): [number, number, number] {
  const radians = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [x * cos - y * sin, x * sin + y * cos, z];
}

/**
 * The turntable series: `steps` cameras at `stepDeg` increments about the
 * world z-axis, starting AT the given camera (step 0 renders the current
 * view exactly). The camera kind, target, up, and eye distance are
 * preserved — only the azimuth changes.
 */
export function turntableCameras(
  base: RenderCamera,
  steps: number,
  stepDeg: number,
): RenderCamera[] {
  const cameras: RenderCamera[] = [];
  for (let index = 0; index < steps; index += 1) {
    const angle = index * stepDeg;
    const position = rotateAboutZ(
      [
        base.position[0] - base.target[0],
        base.position[1] - base.target[1],
        base.position[2] - base.target[2],
      ],
      angle,
    );
    const eye: [number, number, number] = [
      base.target[0] + position[0],
      base.target[1] + position[1],
      base.target[2] + position[2],
    ];
    cameras.push({
      ...(base.kind === "perspective"
        ? { kind: "perspective" as const, fovDeg: base.fovDeg }
        : {
            kind: "orthographic" as const,
            viewWidth: base.viewWidth,
            viewHeight: base.viewHeight,
          }),
      position: eye,
      target: base.target,
      up: base.up,
    });
  }
  return cameras;
}

/** The isometric series' standard views, in export order. */
export const ISOMETRIC_SERIES_VIEWS: readonly StandardViewId[] = [
  "front",
  "top",
  "right",
  "iso",
];

/**
 * The isometric series: the four standard views framing the model's
 * measured bounds (the standard-views module owns the azimuth/elevation
 * convention and the fit distance — exactly the view tools' framing).
 */
export function isometricSeriesCameras(
  bounds: RenderBounds,
  convention: ViewAngleConvention,
  fovDeg?: number,
): RenderCamera[] {
  return ISOMETRIC_SERIES_VIEWS.map((view) =>
    standardViewCamera(view, {
      bounds,
      convention,
      ...(fovDeg === undefined ? {} : { fovDeg }),
    }),
  );
}
