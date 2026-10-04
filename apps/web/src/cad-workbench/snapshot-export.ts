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
 *
 * ## The agent capture views (Phase 2.1, D10)
 *
 * `captureViewCamera` maps ONE requested view — a named preset or an
 * arbitrary azimuth/elevation pair — to the same framing the series use,
 * and `blobToBase64` encodes a captured PNG as the inline `data` of an
 * image part. These back the `cad_capture_views` WebMCP tool: pure float
 * arithmetic over plain data, DOM-free, so node-env tests drive the angle
 * math with no WebGL.
 */

import type {
  RenderBounds,
  RenderCamera,
  RenderVector3,
} from "@slopcad/cad-core";
import {
  isoViewCameraOfDirection,
  standardViewCamera,
  type ViewAngleConvention,
} from "@slopcad/cad-r3f";

/**
 * How long a series download's object URL is kept alive: the browser
 * consumes an anchor's blob URL ASYNCHRONOUSLY after the click, so a
 * synchronous revoke aborts the download mid-start (Chromium then
 * re-attempts the SAME entry — one file, repeatedly named like the
 * first). A bounded lifetime releases the blob without racing the start.
 */
const DOWNLOAD_URL_LIFETIME_MS = 10_000;

/**
 * The minimum gap between two programmatic downloads of a series: a
 * browser starts anchor downloads asynchronously, and clicks issued in
 * one synchronous task can collapse onto the first download's entry —
 * same name, same bytes. Pacing the loop keeps every file its own.
 */
export const SERIES_DOWNLOAD_SPACING_MS = 250;

/** Triggers a browser download of `blob` under `filename`. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Not synchronous: an immediate revoke races the download's own async
  // start (see DOWNLOAD_URL_LIFETIME_MS).
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, DOWNLOAD_URL_LIFETIME_MS);
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
export const ISOMETRIC_SERIES_VIEWS = ["front", "top", "right", "iso"] as const;

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

/** The named capture presets — the isometric series' four standard views. */
export type CaptureViewPreset = (typeof ISOMETRIC_SERIES_VIEWS)[number];

/**
 * One requested capture view (D10): a named preset, or an arbitrary
 * azimuth/elevation pair in degrees. The pair's frame is the orbit
 * controls' own: azimuth 0° looks from +X (the right view's side),
 * increasing toward +Y, and elevation is degrees above the horizontal
 * plane — so the front view sits at azimuth −90°, and third-angle iso at
 * azimuth −45°, elevation ≈ 35.26°. A pair at a preset's own direction
 * (−90°/0° = front) reproduces that preset's camera to floating-point
 * exactness (≈1e-15): IEEE cos(−90°) is ≈6.1e-17, not zero.
 */
export type CaptureViewRequest =
  | { readonly preset: CaptureViewPreset }
  | { readonly azimuth: number; readonly elevation: number };

/**
 * The eye direction of an azimuth/elevation pair in the repo's Z-up
 * millimetre frame (the same decomposition `orbitPosition` integrates).
 */
function captureViewDirection(
  azimuthDeg: number,
  elevationDeg: number,
): RenderVector3 {
  const azimuth = (azimuthDeg * Math.PI) / 180;
  const elevation = (elevationDeg * Math.PI) / 180;
  const cosElevation = Math.cos(elevation);
  return [
    Math.cos(azimuth) * cosElevation,
    Math.sin(azimuth) * cosElevation,
    Math.sin(elevation),
  ];
}

/**
 * The camera of ONE requested capture view: presets delegate to the
 * standard-views module (its framing, its top-view up, the convention's
 * ISO corner); azimuth/elevation pairs frame the same bounds from the
 * direction the angles describe with the CAD up. Pure — the caller
 * applies it through the session's user-camera overlay and restores the
 * previous overlay state afterwards, exactly as the series exports do.
 */
export function captureViewCamera(
  view: CaptureViewRequest,
  options: {
    readonly bounds: RenderBounds;
    readonly convention: ViewAngleConvention;
  },
): RenderCamera {
  if ("preset" in view) {
    return standardViewCamera(view.preset, options);
  }
  return isoViewCameraOfDirection(
    captureViewDirection(view.azimuth, view.elevation),
    { bounds: options.bounds },
  );
}

/**
 * The image-part name of one requested view — `view-front.png` for a
 * preset, `view-az-45-el30.png` for angles (rounded to whole degrees;
 * two requests inside the same whole degree render indistinguishable
 * frames and share a name honestly).
 */
export function captureViewName(view: CaptureViewRequest): string {
  if ("preset" in view) {
    return `view-${view.preset}.png`;
  }
  return `view-az${Math.round(view.azimuth)}-el${Math.round(view.elevation)}.png`;
}

/**
 * Encodes a blob's bytes as base64 — the inline `data` of an image
 * content part. Chunked `String.fromCharCode` (32 KiB) keeps the spread
 * argument inside engine limits; `btoa` over the binary string is the
 * standard encoding on both the browser and node.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const CHUNK_SIZE = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(
      ...bytes.subarray(offset, offset + CHUNK_SIZE),
    );
  }
  return btoa(binary);
}
