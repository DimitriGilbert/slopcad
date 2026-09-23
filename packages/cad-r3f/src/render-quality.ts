/**
 * Render quality (Phase 59): the opt-in quality mode's data and fixed
 * constants — soft shadows, screen-space ambient occlusion, and the
 * post-processing pass chain, all documented constants so the mode is
 * deterministic given state.
 *
 * ## Opt-in, unpinned, byte-safe
 *
 * The default is and stays `"standard"`: every pinned baseline renders
 * through the unchanged boot path (no shadows, no composer, no AO), and
 * NOTHING pins quality-mode bytes of a specific document — the user-camera
 * overlay's discipline. What quality mode must still honor is the
 * determinism LAW, not a baseline: the same state renders identical bytes
 * run-over-run (fixed shadow-map resolution and bias, single-frame AO —
 * no temporal accumulation — fixed pass chain), which the snapshot
 * determinism suite asserts.
 *
 * ## SwiftShader-safe by construction
 *
 * Quality defaults were chosen for the software rasterizer the e2e
 * harness runs: PCF soft shadows at a fixed 1024 map, an SSAO pass with a
 * small fixed kernel, and a straight render → AO → output chain. The mode
 * is demand-frame friendly: pixels change only when state changes, one
 * heavier frame per change, never a continuous rAF loop.
 */

/** The render quality modes. */
export type CadRenderQuality = "standard" | "quality";

/** Every render quality mode (exhaustive list constant). */
export const CAD_RENDER_QUALITIES: readonly CadRenderQuality[] = [
  "standard",
  "quality",
];

/** Normalizes an unknown quality id to the boot default. */
export function renderQualityById(id: string): CadRenderQuality {
  return id === "quality" ? "quality" : "standard";
}

/** The quality mode's shadow-map resolution (fixed for determinism). */
export const CAD_QUALITY_SHADOW_MAP_SIZE = 1024;

/** Shadow depth bias in world units (millimetres): acne without, peter-panning with too much. */
export const CAD_QUALITY_SHADOW_BIAS = -0.0005;

/** Normal-offset bias (millimetres) against self-shadow acne on curved walls. */
export const CAD_QUALITY_SHADOW_NORMAL_BIAS = 0.6;

/**
 * The key light's orthographic shadow-camera half-extent in millimetres:
 * a fixed ±250 box frames every fixture-scale part, and being fixed it
 * keeps the shadow raster deterministic (fit-to-bounds would move the
 * map's texels with the model).
 */
export const CAD_QUALITY_SHADOW_CAMERA_EXTENT_MM = 250;

/** The shadow-catching ground plane's opacity (the plane draws ONLY shadow). */
export const CAD_QUALITY_SHADOW_GROUND_OPACITY = 0.28;

/** SSAO kernel radius in millimetres (scene scale is millimetres). */
export const CAD_QUALITY_SSAO_KERNEL_RADIUS_MM = 4;

/** SSAO distance falloff start/end in millimetres (occlusion locality). */
export const CAD_QUALITY_SSAO_MIN_DISTANCE_MM = 0.5;
export const CAD_QUALITY_SSAO_MAX_DISTANCE_MM = 40;
