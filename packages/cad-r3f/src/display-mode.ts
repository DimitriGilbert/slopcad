/**
 * Display modes (Phase 45): how `CadModel`'s surfaces and feature edges
 * render — a pure table the component applies, so every mode is a
 * documented renderer pass state rather than ad-hoc material flags.
 *
 * ## The modes and the honest scope of each
 *
 * - `shaded` (the default): the established bytes — lit surfaces, no
 *   edges. Everything about the render baselines assumes this mode.
 * - `shaded-edges`: lit surfaces plus the feature-edge overlay.
 * - `wireframe`: ALL feature edges, none occluded — surfaces stay mounted
 *   but write neither color nor depth, so they neither draw nor hide
 *   anything (picking still works: the meshes raycast as always).
 * - `hidden-line`: edges-only WITH occlusion — surfaces stay invisible
 *   (`colorWrite: false`) but DO write depth, so edges behind the model
 *   are removed by the depth test. This is the honest pre-HLR reading of
 *   "hidden line": true hidden-LINE-REMOVAL (computed visible-edge
 *   drawings, dimmed hidden edges, silhouettes) belongs to the drawings
 *   phase; what this mode gives is depth-buffer occlusion of the same
 *   feature edges `shaded-edges` draws.
 * - `zebra` (Phase 58): lit-surface write masks with the material's
 *   shader patched to draw reflection stripes — the environment-zebra
 *   surface-quality view. The stripes are a deterministic function of the
 *   surface normal and the view vector at a fixed stripe frequency (see
 *   `ZEBRA_STRIPE_COUNT` in `cad-model.tsx`), so the same scene state
 *   always yields the same bands; the mode is opt-in and the default
 *   boot raster is untouched.
 *
 * Feature edges come from three.js `EdgesGeometry` at a documented
 * threshold angle: an edge appears where adjacent triangles meet at more
 * than the threshold. Consequences stated plainly: box edges (90°)
 * appear; a tessellated cylinder shows its rim circles but NOT its
 * silhouette from an oblique view (no adjacent-triangle angle crosses the
 * threshold there) — silhouette extraction is an HLR/drawings concern.
 */

import { EdgesGeometry } from "three";
import type { BufferGeometry } from "three";

/** The renderer pass states {@link CadModel} cycles through. */
export type CadDisplayMode =
  "shaded" | "shaded-edges" | "wireframe" | "hidden-line" | "zebra";

/** Every display mode the component accepts (exhaustive list constant). */
export const CAD_DISPLAY_MODES: readonly CadDisplayMode[] = [
  "shaded",
  "shaded-edges",
  "wireframe",
  "hidden-line",
  "zebra",
];

/**
 * The feature-edge threshold in degrees: adjacent triangles meeting at
 * more than this angle draw their shared edge. Low enough that CAD
 * surface transitions (fillet boundaries, chamfers) read; high enough
 * that tessellation noise stays out.
 */
export const CAD_EDGE_FEATURE_ANGLE_DEG = 20;

/** The feature-edge ink: machinist-bright against the studio graphite. */
export const CAD_MODEL_EDGE_COLOR = "#d8e2f2";

/**
 * How the surface pass renders under one mode. The meshes are always
 * MOUNTED (picking works in every mode); only their write masks change.
 */
export interface SurfacePassState {
  /** Whether lit surface color is drawn. */
  readonly colorWrite: boolean;
  /** Whether surfaces occupy the depth buffer (occluding). */
  readonly depthWrite: boolean;
  /**
   * True exactly under the zebra mode (Phase 58): the surface material
   * patches its shader to draw the reflection stripes. Absent everywhere
   * else, so the established modes' pass records — and every raster pin
   * taken under them — are identical to their pre-zebra form.
   */
  readonly stripes?: true;
}

/** How the feature-edge pass renders under one mode. */
export interface EdgePassState {
  /** Whether the edge overlay draws at all. */
  readonly visible: boolean;
}

/** The full pass table for one display mode. */
export interface DisplayModePasses {
  readonly surfaces: SurfacePassState;
  readonly edges: EdgePassState;
}

const PASSES: Readonly<Record<CadDisplayMode, DisplayModePasses>> =
  Object.freeze({
    shaded: {
      edges: { visible: false },
      surfaces: { colorWrite: true, depthWrite: true },
    },
    "shaded-edges": {
      edges: { visible: true },
      surfaces: { colorWrite: true, depthWrite: true },
    },
    "hidden-line": {
      edges: { visible: true },
      surfaces: { colorWrite: false, depthWrite: true },
    },
    wireframe: {
      edges: { visible: true },
      surfaces: { colorWrite: false, depthWrite: false },
    },
    zebra: {
      edges: { visible: false },
      surfaces: { colorWrite: true, depthWrite: true, stripes: true },
    },
  } satisfies Record<CadDisplayMode, DisplayModePasses>);

/**
 * The pass states of one display mode (the pure table read the renderer
 * applies — the single source of truth for mode → pass decisions).
 */
export function displayModePasses(mode: CadDisplayMode): DisplayModePasses {
  return PASSES[mode];
}

/**
 * Builds one object's feature-edge geometry from its surface geometry:
 * `EdgesGeometry` at the documented threshold. Deterministic — the same
 * surface geometry always yields the same edge set. The caller owns
 * disposal (the same lifecycle as the face-highlight geometries).
 */
export function buildFeatureEdgeGeometry(
  surface: BufferGeometry,
): EdgesGeometry {
  return new EdgesGeometry(surface, CAD_EDGE_FEATURE_ANGLE_DEG);
}
