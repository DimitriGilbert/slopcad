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
import type { ComputationContext } from "@slopcad/cad-kernel";

import {
  computePlateWithHole,
  type PlateMeasurement,
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

/** What the render fixture renders: the measurements plus their projection. */
export interface PlateRenderState {
  readonly measurement: PlateMeasurement;
  readonly projection: RenderProjection;
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
): PlateRenderState {
  const object = unwrap(
    projectTessellation(PLATE_BODY_ID, measurement.tessellation),
  );
  return {
    measurement,
    projection: unwrap(createRenderProjection([object], RENDER_FIXTURE_CAMERA)),
  };
}

/**
 * Computes the plate with a through bore of `holeDiameterMm` in the worker
 * (the shared Phase 10 scene) and projects the result.
 */
export async function computePlateRenderState(
  context: ComputationContext,
  holeDiameterMm: number,
): Promise<PlateRenderState> {
  return plateRenderState(await computePlateWithHole(context, holeDiameterMm));
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
      ...(tessellation.normals !== undefined ? { normals: tessellation.normals } : {}),
    }),
  );
  return {
    measurement: state.measurement,
    projection: unwrap(createRenderProjection([object], RENDER_FIXTURE_CAMERA)),
  };
}
