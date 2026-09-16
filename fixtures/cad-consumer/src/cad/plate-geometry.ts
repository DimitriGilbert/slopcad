/**
 * The consumer's real geometry pipeline: the parametric plate computed on
 * the main thread through the Manifold kernel adapter — box minus bore,
 * translated by the document's translate components — projected into the
 * renderer-neutral `RenderProjection` the installed `CadViewport` draws.
 * The camera is DATA: the plate's CAD home view (eye in the (+x, −y, +z)
 * octant, z-up), framing the plate's `[0,30] × [0,20] × [0,10]` kernel
 * placement at a ~40° elevation in the viewport's default size.
 */

import {
  createRenderProjection,
  length,
  projectTessellation,
  type ProjectionError,
  type ParseResult,
  type RenderCamera,
  type RenderProjection,
} from "@slopcad/cad-react";
import {
  createManifoldRuntime,
  manifoldKernelFromRuntime,
} from "@slopcad/cad-kernel-manifold";
import type { GeometryKernel, Tessellation } from "@slopcad/cad-kernel";
// Vite asset pin: the dependency optimizer breaks manifold.js's own
// `new URL("manifold.wasm", import.meta.url)` resolution, so the runtime
// receives an explicit `locateFile` (the same approach the app's worker
// entry documents).
import wasmUrl from "manifold-3d/manifold.wasm?url";

import { PLATE_BODY_ID } from "./consumer-document";

/** The plate's x extent (mm). */
const PLATE_WIDTH_MM = 30;
/** The plate's y extent (mm). */
const PLATE_DEPTH_MM = 20;
/** The plate's z extent (mm) — also the bore's height. */
const PLATE_HEIGHT_MM = 10;

/** The deterministic home-view camera for the plate scene. */
const PLATE_CAMERA: RenderCamera = {
  kind: "perspective",
  position: [44, -30, 47],
  target: [15, 10, 5],
  up: [0, 0, 1],
  fovDeg: 40,
};

/** What one build produces: the projection, or why the kernel refused. */
export type PlateBuild =
  | { readonly ok: true; readonly projection: RenderProjection }
  | { readonly ok: false; readonly error: string };

let kernelPromise: Promise<GeometryKernel> | null = null;

/**
 * Initializes the Manifold kernel once per page (the WASM heap is a
 * per-realm singleton; the runtime module memoizes behind this promise).
 */
export function getPlateKernel(): Promise<GeometryKernel> {
  kernelPromise ??= createManifoldRuntime({
    locateFile: () => wasmUrl,
  }).then(manifoldKernelFromRuntime);
  return kernelPromise;
}

function unwrap<T>(result: ParseResult<T, ProjectionError>, what: string): T {
  if (!result.ok) {
    throw new Error(`${what} rejected: ${result.error.message}`);
  }
  return result.value;
}

/**
 * Builds the plate for one document state: the bore diameter (mm) and the
 * translate components (mm). Real geometry every time — the kernel decides
 * whether the parameters produce a solid (e.g. a bore that consumes the
 * whole plate fails) and the projection carries the tessellation of the
 * transformed result.
 */
export async function buildPlateProjection(parameters: {
  readonly holeDiameterMm: number;
  readonly translateMm: readonly [number, number, number];
}): Promise<PlateBuild> {
  try {
    const kernel = await getPlateKernel();
    const plate = kernel.createBox({
      width: length(PLATE_WIDTH_MM),
      depth: length(PLATE_DEPTH_MM),
      height: length(PLATE_HEIGHT_MM),
    });
    if (!plate.ok) return { ok: false, error: plate.error.message };
    const boreRadiusMm = parameters.holeDiameterMm / 2;
    const bore = kernel.createCylinder({
      radius: length(boreRadiusMm),
      height: length(PLATE_HEIGHT_MM),
    });
    if (!bore.ok) return { ok: false, error: bore.error.message };
    const placedBore = kernel.transform(bore.value, {
      x: length(PLATE_WIDTH_MM / 2),
      y: length(PLATE_DEPTH_MM / 2),
      z: length(0),
    });
    if (!placedBore.ok) return { ok: false, error: placedBore.error.message };
    const drilled = kernel.subtract(plate.value, [placedBore.value]);
    if (!drilled.ok) return { ok: false, error: drilled.error.message };
    const [tx, ty, tz] = parameters.translateMm;
    const moved =
      tx === 0 && ty === 0 && tz === 0
        ? drilled
        : kernel.transform(drilled.value, {
            x: length(tx),
            y: length(ty),
            z: length(tz),
          });
    if (!moved.ok) return { ok: false, error: moved.error.message };
    const tessellated = kernel.tessellate(moved.value);
    if (!tessellated.ok) return { ok: false, error: tessellated.error.message };
    const tessellation: Tessellation = tessellated.value;
    const object = unwrap(
      projectTessellation(PLATE_BODY_ID, tessellation),
      "The plate projection",
    );
    const projection = unwrap(
      createRenderProjection([object], PLATE_CAMERA),
      "The plate scene",
    );
    return { ok: true, projection };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
