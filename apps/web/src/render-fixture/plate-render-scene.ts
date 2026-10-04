/**
 * The `/render` fixture's projection assembly (Phase 11.3): turns the plate
 * computation's measurements — which already carry the tessellation, kernel
 * crease-aware normals included — into the renderer-neutral
 * {@link RenderProjection} the deterministic CAD scene consumes: one render
 * object projected through the public `projectTessellation` boundary under
 * the stable body id `body_plate`, plus the fixture's documented camera
 * spec.
 *
 * The camera is DATA authored for this fixture's fixed 800×520 viewport:
 * a perspective eye in the (+x, −y, +z) octant — the CAD "home view" that
 * looks at the origin corner, so the scene's origin marker and all three
 * axes read while the top face (and the bore through it) stays clearly
 * visible at a ~40° elevation — with the CAD-conventional z-up and the
 * plate's centre as target so the model is framed, not clipped. The plate
 * occupies `[0,30] × [0,20] × [0,10]` under the kernel placement
 * conventions, which is what the target coordinates and the grid's position
 * on that centre both assume.
 */

import {
  createBodyId,
  createRenderProjection,
  projectTessellation,
  type ParseResult,
  type ProjectionError,
  type RenderCamera,
  type RenderProjection,
  type RenderVector3,
} from "@slopcad/cad-core";
import {
  WorkerRequestFailure,
  type ComputationContext,
} from "@slopcad/cad-kernel";
import type { DocumentSceneMeasurement } from "../worker-fixture/document-scene";
import type { ExtrudeSceneRequest } from "../worker-fixture/extrude-scene";

import {
  computePlateWithHole,
  computeSectionedPlateWithHole,
  type PlateMeasurement,
  type PlateSectionPlane,
} from "../worker-fixture/plate-scene";

/**
 * The fixture's deterministic camera (see the module doc for the decisions
 * behind every value). Eye distance ≈ 65 mm at fov 40 frames the 30 × 20 mm
 * plate with margin in the 800×520 viewport.
 */
const RENDER_FIXTURE_CAMERA: RenderCamera = {
  kind: "perspective",
  position: [44, -30, 47],
  target: [15, 10, 5],
  up: [0, 0, 1],
  fovDeg: 40,
};

/** The projected body's stable id: `rend_plate` derives from it. */
const PLATE_BODY_ID = createBodyId("body_plate");

/**
 * The section display request (Phase 46): the plane a document section
 * record resolved to, plus the view mode — `true` displays the CUT solid
 * (cap faces included in its boundary), `false` clips the whole plate at
 * the render layer.
 */
export interface SectionDisplayRequest extends PlateSectionPlane {
  readonly viewMode: boolean;
}

/** What the render fixture renders: the measurements plus their projection. */
export interface PlateRenderState {
  readonly measurement: PlateMeasurement;
  readonly projection: RenderProjection;
  /**
   * The cross-section face's kernel measurements (Phase 46): present
   * exactly when the settle ran a section — absent before, and absent
   * when the kernel declined the cut (a declined section carries no
   * numbers, never zeros).
   */
  readonly section?: {
    readonly areaMm2: number;
    readonly centroidMm: readonly [number, number, number];
  };
}

function unwrap<T>(result: ParseResult<T, ProjectionError>): T {
  if (!result.ok) {
    throw new Error(`Plate projection rejected: ${result.error.message}`);
  }
  return result.value;
}

/**
 * Projects one plate measurement into its render state. Pure — the same
 * measurement always yields the same projection bytes, which is what makes
 * the fixture's settled scene byte-reproducible.
 */
function plateRenderState(
  measurement: PlateMeasurement,
  section?: PlateRenderState["section"],
): PlateRenderState {
  const object = unwrap(
    projectTessellation(PLATE_BODY_ID, measurement.tessellation),
  );
  return {
    measurement,
    ...(section === undefined ? {} : { section }),
    projection: unwrap(createRenderProjection([object], RENDER_FIXTURE_CAMERA)),
  };
}

/**
 * Computes the plate with a through bore of `holeDiameterMm` in the worker
 * (the shared Phase 10 scene) and projects the result — optionally cutting
 * the section first (Phase 46): view mode displays and measures the CUT
 * solid; otherwise the whole plate renders (the render layer clips it) and
 * only the face measurements ride along. A DECLINED section (a plane the
 * kernel refuses — `kernel/section-empty` class) settles the whole plate
 * with no section fields: a declined section carries no numbers.
 */
export async function computePlateRenderState(
  context: ComputationContext,
  holeDiameterMm: number,
  section?: SectionDisplayRequest | null,
): Promise<PlateRenderState> {
  if (section === undefined || section === null) {
    return plateRenderState(
      await computePlateWithHole(context, holeDiameterMm),
    );
  }
  try {
    const sectioned = await computeSectionedPlateWithHole(
      context,
      holeDiameterMm,
      section,
    );
    return plateRenderState(
      section.viewMode ? sectioned.cut : sectioned.measurement,
      sectioned.section,
    );
  } catch (error) {
    // The structured decline channel: the worker's `worker/operation-failed`
    // carries the kernel's own `kernelCode` — matched on the code, never a
    // message substring guess.
    if (
      error instanceof WorkerRequestFailure &&
      (error.error.data as { kernelCode?: unknown } | undefined)?.kernelCode ===
        "kernel/section-empty"
    ) {
      return plateRenderState(
        await computePlateWithHole(context, holeDiameterMm),
      );
    }
    throw error;
  }
}

/**
 * Re-derives the plate's render state translated by a world offset
 * (canonical millimetres) — the fixture's stand-in execution of the
 * document's translate feature (see `fixture-document.ts`). Pure and
 * deterministic: the tessellation positions shift by exactly the offset
 * (normals are directions and pass through unchanged), the projection
 * re-derives through the same `projectTessellation` boundary, and a zero
 * offset returns the input state unchanged, preserving byte-identity.
 * The measurement (volume, kernel bounds) deliberately stays the worker's
 * result: a translation is rigid, so volume is invariant, and the bounds
 * readout describes the kernel computation, not the document placement.
 */
export function offsetPlateRenderState(
  state: PlateRenderState,
  offset: RenderVector3,
): PlateRenderState {
  if (offset[0] === 0 && offset[1] === 0 && offset[2] === 0) return state;
  const tessellation = state.measurement.tessellation;
  const positions: number[] = [];
  for (let index = 0; index < tessellation.positions.length; index += 3) {
    const x = tessellation.positions[index];
    const y = tessellation.positions[index + 1];
    const z = tessellation.positions[index + 2];
    if (x === undefined || y === undefined || z === undefined) break;
    positions.push(x + offset[0], y + offset[1], z + offset[2]);
  }
  const object = unwrap(
    projectTessellation(PLATE_BODY_ID, {
      positions,
      indices: tessellation.indices,
      ...(tessellation.normals !== undefined
        ? { normals: tessellation.normals }
        : {}),
    }),
  );
  return {
    measurement: state.measurement,
    projection: unwrap(createRenderProjection([object], RENDER_FIXTURE_CAMERA)),
  };
}

// ---------------------------------------------------------------------------
// The Phase 26.1 extrude scene assembly
// ---------------------------------------------------------------------------

/** The fixed view direction of the extrude scene camera (the plate home
 * view's proportions: +x, −y, +z octant, z-up), normalized once. */
const EXTRUDE_EYE_DIRECTION: readonly [number, number, number] = (() => {
  const v: readonly [number, number, number] = [29, -40, 42];
  const length = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / length, v[1] / length, v[2] / length];
})();

/**
 * The extrude scene's deterministic camera, derived from the measured
 * bounds: the eye sits on the fixed home-view direction at 2.2× the
 * bounds' largest extent from the bounds centre — the same framing
 * proportion the plate camera's authored values carry. Pure function of
 * the measurement, so identical solids always yield identical projections.
 */
export function extrudeCamera(
  bounds: PlateMeasurement["bounds"],
): RenderCamera {
  const center: [number, number, number] = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const extent = Math.max(
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
    5,
  );
  const distance = 2.2 * extent;
  return {
    kind: "perspective",
    position: [
      center[0] + EXTRUDE_EYE_DIRECTION[0] * distance,
      center[1] + EXTRUDE_EYE_DIRECTION[1] * distance,
      center[2] + EXTRUDE_EYE_DIRECTION[2] * distance,
    ],
    target: center,
    up: [0, 0, 1],
    fovDeg: 40,
  };
}

/**
 * Projects an extrude measurement into its render state under the body id
 * the extrude feature declares — pure and deterministic like the plate
 * twin, so the settled scene is byte-reproducible.
 */
export function extrudeRenderState(
  measurement: PlateMeasurement,
  bodyId: string,
): PlateRenderState {
  const object = unwrap(
    projectTessellation(createBodyId(bodyId), measurement.tessellation),
  );
  return {
    measurement,
    projection: unwrap(
      createRenderProjection([object], extrudeCamera(measurement.bounds)),
    ),
  };
}

// ---------------------------------------------------------------------------
// The document scene assembly (Phase 16 owner fix)
// ---------------------------------------------------------------------------

/**
 * The document scene's render state: one render object per rendered body
 * (the stable `rend_*` ids derive from the body ids, exactly like the
 * imported-STEP assembly) under the bounds-fitted home-view camera — for a
 * single rendered body that camera IS the per-scene camera, so a
 * single-body document scene is byte-identical to its feature-scene twin.
 * The measurement is the document aggregate (the sum over the rendered
 * bodies — the settle surface's truth); a document scene carries no
 * section face measurements (the plate scene's own concern).
 */
export interface DocumentSceneRenderState {
  readonly measurement: DocumentSceneMeasurement;
  readonly projection: RenderProjection;
  readonly section?: undefined;
}

/**
 * Assembles the document scene's render state from the computation's
 * aggregate. Pure — the same measurement always yields the same
 * projection bytes.
 */
export function documentSceneRenderState(
  measurement: DocumentSceneMeasurement,
): DocumentSceneRenderState {
  const objects = measurement.bodies.map((body) =>
    unwrap(
      projectTessellation(
        createBodyId(body.bodyId),
        body.measurement.tessellation,
        undefined,
        body.openShell === true,
      ),
    ),
  );
  return {
    measurement,
    projection: unwrap(
      createRenderProjection(objects, extrudeCamera(measurement.bounds)),
    ),
  };
}

export type { ExtrudeSceneRequest };
