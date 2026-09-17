/**
 * BREP-side helpers for the /io fixture (Phase 21.5): the imported-BREP
 * flow and the export flow over the SAME lazily-booted OCCT worker the
 * STEP path uses — full parity, by design. The worker protocol carries
 * `brep.import`/`brep.export` exactly like their `step.*` twins (see
 * `@slopcad/cad-kernel`'s vocabulary), so the browser flow speaks them for
 * the same reason it speaks STEP: one channel, one kernel, both of OCCT's
 * exchange forms. The export's honest shape is the STEP twin's: the /io
 * source plate is Manifold-built and cannot cross kernels, so the button
 * REBUILDS the same plate through the worker protocol's own operations and
 * exports it there.
 *
 * The render state (`buildImportedBrepState`) is the STEP twin with honest
 * body ids: every imported solid validates through the public
 * `projectTessellation` boundary under its own `body_imported_brep_<n>`
 * id, volume and bounds computed HERE from the exact soups the kernel
 * returned — the readout is the imported geometry's own, never a
 * kernel-side claim.
 */

import {
  createBodyId,
  createRenderProjection,
  length,
  projectTessellation,
  type RenderProjection,
} from "@slopcad/cad-core";
import type { Tessellation, WorkerClient } from "@slopcad/cad-kernel";

import {
  fitCameraToBounds,
  meshBounds,
  meshSignedVolume,
  type MeshBounds,
} from "./io-mesh";
import { unionBounds } from "./io-step";

const mm = (value: number) => length(value, "mm");

/** One imported solid's provenance-marked wire ref (mirrored shape). */
export interface ImportedBrepRef {
  readonly solid: string;
  readonly origin: "imported-brep";
}

/** What the worker's `brep.import` result means at the call site. */
export interface ImportedBrepFlow {
  /** The provenance refs, in file order. */
  readonly refs: readonly ImportedBrepRef[];
  /** One validated soup per imported solid, in file order. */
  readonly soups: readonly Tessellation[];
}

/**
 * Runs the BREP import flow over a live OCCT worker client: import, then
 * tessellate and dispose each imported solid — the STEP twin's sequence
 * over the `brep.*` vocabulary group. Rejects with the channel's structured
 * failure (a `WorkerRequestFailure` whose `error.code` is the stable
 * `worker/*` or `brep-import/*` cause).
 */
export async function importBrepBytesOverWorker(
  client: WorkerClient,
  bytes: Uint8Array,
): Promise<ImportedBrepFlow> {
  const imported = await client.request("brep.import", { data: bytes });
  const soups: Tessellation[] = [];
  for (const ref of imported.solids) {
    const tessellated = await client.request("solid.tessellate", {
      solid: ref.solid,
    });
    soups.push(tessellated.tessellation);
    await client.request("solid.dispose", { solid: ref.solid });
  }
  return { refs: imported.solids, soups };
}

/** What one successful BREP import leaves the fixture holding. */
export interface ImportedBrepState {
  /** The validated projection the imported-mesh viewport renders. */
  readonly projection: RenderProjection;
  /** Imported solid count (one body per solid in the projection). */
  readonly solidCount: number;
  /** Total triangle count across the imported soups. */
  readonly triangles: number;
  /** The soups' combined divergence-theorem volume in mm³. */
  readonly volume: number;
  /** The soups' combined axis-aligned bounds in mm. */
  readonly bounds: MeshBounds;
}

/**
 * Validates the imported soups through the public projection boundary —
 * one body per solid, honest `body_imported_brep_<n>` ids — and assembles
 * the imported-mesh viewport's render state. Throws only when cad-core
 * rejects a soup (an upstream bug: the importer never returns malformed
 * geometry as success), so a rejection is loud instead of a blank viewport.
 */
export function buildImportedBrepState(
  soups: readonly Tessellation[],
): ImportedBrepState {
  const bodies = soups.map((soup, index) => {
    const object = projectTessellation(
      createBodyId(`body_imported_brep_${String(index)}`),
      soup,
    );
    if (!object.ok) {
      throw new Error(`Imported BREP rejected: ${object.error.message}`);
    }
    return object.value;
  });
  const projectionResult = createRenderProjection(
    bodies,
    fitCameraToBounds(unionBounds(soups.map(meshBounds))),
  );
  if (!projectionResult.ok) {
    throw new Error(
      `Imported BREP rejected: ${projectionResult.error.message}`,
    );
  }
  return {
    projection: projectionResult.value,
    solidCount: soups.length,
    triangles: soups.reduce(
      (total, soup) => total + soup.indices.length / 3,
      0,
    ),
    volume: soups.reduce((total, soup) => total + meshSignedVolume(soup), 0),
    bounds: unionBounds(soups.map(meshBounds)),
  };
}

/**
 * The exported plate's dimensions — exactly the /io source plate (and the
 * committed kernel fixture), the same scene the STEP rebuild uses: a
 * 30×20×10 plate with a ⌀8 through-bore at (15, 10).
 */
const EXPORT_PLATE = {
  widthMm: 30,
  depthMm: 20,
  heightMm: 10,
  boreRadiusMm: 4,
  boreCenterXyMm: [15, 10] as const,
};

/**
 * Rebuilds the source plate's geometry on the OpenCascade worker through
 * the worker protocol's own operations, exports it with `brep.export`, and
 * disposes every session solid the build minted — the STEP twin's honest
 * rebuild, over the BREP writer. The bytes are the writer's deterministic
 * output (no neutralizer exists for BREP — the form carries no timestamp),
 * so the same rebuild exports byte-identically across fresh workers and
 * equals the committed kernel fixture.
 */
export async function exportPlateBrepOverWorker(
  client: WorkerClient,
): Promise<Uint8Array> {
  const [boreX, boreY] = EXPORT_PLATE.boreCenterXyMm;
  const plate = await client.request("solid.createBox", {
    width: mm(EXPORT_PLATE.widthMm),
    depth: mm(EXPORT_PLATE.depthMm),
    height: mm(EXPORT_PLATE.heightMm),
  });
  const boreAtOrigin = await client.request("solid.createCylinder", {
    radius: mm(EXPORT_PLATE.boreRadiusMm),
    height: mm(EXPORT_PLATE.heightMm),
  });
  const bore = await client.request("solid.transform", {
    solid: boreAtOrigin.solid,
    translation: { x: mm(boreX), y: mm(boreY), z: mm(0) },
  });
  const drilled = await client.request("solid.subtract", {
    target: plate.solid,
    tools: [bore.solid],
  });
  try {
    const exported = await client.request("brep.export", {
      solids: [drilled.solid],
    });
    return exported.data;
  } finally {
    // The session keeps nothing: every minted build solid is released,
    // export outcome notwithstanding.
    for (const id of [
      plate.solid,
      boreAtOrigin.solid,
      bore.solid,
      drilled.solid,
    ]) {
      await client.request("solid.dispose", { solid: id });
    }
  }
}
