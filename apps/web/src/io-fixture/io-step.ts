/**
 * STEP-side helpers for the /io fixture (Phases 21.3/21.4): the
 * imported-STEP flow between "worker answered" and "pixels settled", plus
 * the export flow that rebuilds the source plate on the OpenCascade worker,
 * honest to what STEP exchange IS in this app.
 *
 * ## The worker round trip (`importStepBytesOverWorker`)
 *
 * STEP import is an OpenCascade capability, so the fixture speaks the real
 * worker protocol to a lazily-booted OCCT worker: `step.import` with the
 * file's raw bytes (the vocabulary's base64 wire form is applied by the
 * client's serializer), then `solid.tessellate` per imported solid, then
 * `solid.dispose` per solid — the session keeps nothing after the flow.
 * The result's `origin: "imported-step"` refs are the data-level provenance
 * marker: imported solids are geometry-only bodies, and the fixture treats
 * them that way — nothing downstream ever sees a feature or a history.
 *
 * ## The export flow (`exportPlateStepOverWorker`) and its design decision
 *
 * STEP export is likewise OpenCascade-ONLY, but the /io source plate is
 * Manifold-built — a Manifold solid handle cannot be handed to the OCCT
 * worker (different kernel, different session, different process). Of the
 * honest options — export a previously imported STEP solid, or boot OCCT
 * and rebuild the plate there — the fixture rebuilds: the same 30×20×10
 * plate with the ⌀8 through-bore at (15, 10) is constructed through the
 * worker protocol's own primitive/transform/boolean operations on the OCCT
 * worker, exported with `step.export`, and every session solid the build
 * minted is disposed. The readout says exactly that; nothing pretends the
 * Manifold source was exported. The held bytes then round-trip through the
 * import flow above — a full OCCT export→import cycle through the browser.
 *
 * ## The render state (`buildImportedStepState`)
 *
 * Every imported solid validates through the public `projectTessellation`
 * boundary under its own body id (`body_imported_step_<n>`) and the soups
 * assemble into one projection with the fitted home-view camera. Volume and
 * bounds are computed HERE from the exact soups the kernel returned (the
 * divergence-theorem measure, summed per solid) — the readout is the
 * imported geometry's own, never a kernel-side claim.
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

const mm = (value: number) => length(value, "mm");

/** One imported solid's provenance-marked wire ref (mirrored shape). */
export interface ImportedStepRef {
  readonly solid: string;
  readonly origin: "imported-step";
}

/** What the worker's `step.import` result means at the call site. */
export interface ImportedStepFlow {
  /** The provenance refs, in file order. */
  readonly refs: readonly ImportedStepRef[];
  /** One validated soup per imported solid, in file order. */
  readonly soups: readonly Tessellation[];
}

/**
 * Runs the STEP import flow over a live OCCT worker client: import, then
 * tessellate and dispose each imported solid. Rejects with the channel's
 * structured failure (a `WorkerRequestFailure` whose `error.code` is the
 * stable `worker/*` or `step-import/*` cause) — the fixture surfaces those
 * codes verbatim.
 */
export async function importStepBytesOverWorker(
  client: WorkerClient,
  bytes: Uint8Array,
): Promise<ImportedStepFlow> {
  const imported = await client.request("step.import", { data: bytes });
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

/** What one successful STEP import leaves the fixture holding. */
export interface ImportedStepState {
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
 * Validates the imported soups through the public projection boundary — one
 * body per solid, distinct stable ids — and assembles the imported-mesh
 * viewport's render state. Throws only when cad-core rejects a soup (an
 * upstream bug: the importer never returns malformed geometry as success),
 * so a rejection is loud instead of a blank viewport.
 */
export function buildImportedStepState(
  soups: readonly Tessellation[],
): ImportedStepState {
  const bodies = soups.map((soup, index) => {
    const object = projectTessellation(
      createBodyId(`body_imported_step_${String(index)}`),
      soup,
    );
    if (!object.ok) {
      throw new Error(`Imported STEP rejected: ${object.error.message}`);
    }
    return object.value;
  });
  const projectionResult = createRenderProjection(
    bodies,
    fitCameraToBounds(unionBounds(soups.map(meshBounds))),
  );
  if (!projectionResult.ok) {
    throw new Error(
      `Imported STEP rejected: ${projectionResult.error.message}`,
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
 * The axis-aligned union of bounds (the single-soup case is itself).
 * Shared with the Phase 21.5 BREP twin (`./io-brep`), whose multi-solid
 * state assembles from the same mesh math.
 */
export function unionBounds(boundsList: readonly MeshBounds[]): MeshBounds {
  const first = boundsList[0];
  if (first === undefined) {
    throw new Error("Union bounds require at least one imported soup.");
  }
  const min: [number, number, number] = [
    first.min[0],
    first.min[1],
    first.min[2],
  ];
  const max: [number, number, number] = [
    first.max[0],
    first.max[1],
    first.max[2],
  ];
  for (const bounds of boundsList) {
    for (const axis of [0, 1, 2] as const) {
      min[axis] = Math.min(min[axis], bounds.min[axis]);
      max[axis] = Math.max(max[axis], bounds.max[axis]);
    }
  }
  return { min, max };
}

/**
 * The exported plate's dimensions — exactly the /io source plate (and the
 * committed kernel fixture): a 30×20×10 plate with a ⌀8 through-bore at
 * (15, 10). The export rebuilds THIS scene on the OCCT worker because STEP
 * export is an OpenCascade capability and the source solid is Manifold's.
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
 * the worker protocol's own operations, exports it with `step.export`, and
 * disposes every session solid the build minted. Rejects with the channel's
 * structured failure (a `WorkerRequestFailure` whose `error.code` /
 * `error.data.kernelCode` are the stable `worker/*` / `step-export/*`
 * causes). The bytes are the exporter's deterministic output: the same
 * rebuild exports byte-identically across fresh workers.
 */
export async function exportPlateStepOverWorker(
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
    const exported = await client.request("step.export", {
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
