/**
 * IGES-side helpers for the /io fixture (Phase 21.5): the imported-IGES
 * flow, main-thread — deliberately NOT the worker path STEP and BREP use.
 *
 * ## Why main-thread (the honest placement)
 *
 * `occt-import-js` reads IGES to MESHES, not OCCT solids — there is no
 * kernel session to speak to, so the worker protocol (whose import
 * operations exist to mint session SOLIDS) has nothing to carry. The mesh
 * imports the /io fixture already serves run exactly this way: STL parses
 * in the browser (cad-io), and IGES joins it — a lazily-booted ~7.3 MB
 * wasm engine on the MAIN thread, initialized once per page on first IGES
 * import, reading to triangle soups with names. The payload mirrors the
 * cad-io mesh-import provenance (`origin: "imported-iges"`): an IGES
 * import is a mesh body like an STL import, no parametric history behind
 * it, and nothing downstream sees a feature or a solid.
 *
 * ## The wasm pin
 *
 * The engine's emscripten glue fetches `occt-import-js.wasm` relative to
 * itself by default, which bundler-hashed assets break — so the pin lives
 * in the OWNING package (`@slopcad/cad-kernel-occt/occt-iges-engine.web`:
 * the bundler's `?url` import of the hashed asset feeds the standard
 * `locateFile` hook, the `occt-worker.web` discipline minus the worker
 * scope). The module imports here are dynamic, so pages that never import
 * IGES never even download the glue.
 */

import type { RenderProjection } from "@slopcad/cad-core";
import {
  createBodyId,
  createRenderProjection,
  projectTessellation,
} from "@slopcad/cad-core";
import type { Tessellation } from "@slopcad/cad-kernel";
import type { IgesEngine } from "@slopcad/cad-kernel-occt/occt-iges-import";

import {
  fitCameraToBounds,
  meshBounds,
  meshSignedVolume,
  type MeshBounds,
} from "./io-mesh";
import { unionBounds } from "./io-step";

/** The lazily-booted engine: one wasm instance per page, on first import. */
let enginePromise: Promise<IgesEngine> | undefined;

function bootIgesEngine(): Promise<IgesEngine> {
  // The package's own browser entry owns the wasm pin (the `?url` import
  // must resolve from the package that carries the dependency). A failed
  // boot clears the page-level memo — the package runtime's twin
  // discipline — so a transient fetch/instantiate failure is retried on
  // the next import instead of bricking the page until reload.
  enginePromise ??= import("@slopcad/cad-kernel-occt/occt-iges-engine.web")
    .then(({ createBrowserIgesEngine }) => createBrowserIgesEngine())
    .catch((error: unknown) => {
      enginePromise = undefined;
      throw error;
    });
  return enginePromise;
}

/** What one successful IGES import leaves the fixture holding. */
export interface ImportedIgesState {
  /** The validated projection the imported-mesh viewport renders. */
  readonly projection: RenderProjection;
  /** Imported mesh count (one body per mesh in the projection). */
  readonly meshCount: number;
  /** Total triangle count across the imported soups. */
  readonly triangles: number;
  /** The soups' combined divergence-theorem volume in mm³. */
  readonly volume: number;
  /** The soups' combined axis-aligned bounds in mm. */
  readonly bounds: MeshBounds;
  /** The meshes' IGES-carried names (null entries for blank names). */
  readonly names: readonly (string | null)[];
}

/**
 * Validates the imported soups through the public projection boundary —
 * one body per mesh, honest `body_imported_iges_<n>` ids — and assembles
 * the imported-mesh viewport's render state. Throws only when cad-core
 * rejects a soup (an upstream bug: the importer never returns malformed
 * geometry as success), so a rejection is loud instead of a blank viewport.
 */
function buildImportedIgesState(
  soups: readonly Tessellation[],
  names: readonly (string | null)[],
): ImportedIgesState {
  const bodies = soups.map((soup, index) => {
    const object = projectTessellation(
      createBodyId(`body_imported_iges_${String(index)}`),
      soup,
    );
    if (!object.ok) {
      throw new Error(`Imported IGES rejected: ${object.error.message}`);
    }
    return object.value;
  });
  const projectionResult = createRenderProjection(
    bodies,
    fitCameraToBounds(unionBounds(soups.map(meshBounds))),
  );
  if (!projectionResult.ok) {
    throw new Error(
      `Imported IGES rejected: ${projectionResult.error.message}`,
    );
  }
  return {
    projection: projectionResult.value,
    meshCount: soups.length,
    triangles: soups.reduce(
      (total, soup) => total + soup.indices.length / 3,
      0,
    ),
    volume: soups.reduce((total, soup) => total + meshSignedVolume(soup), 0),
    bounds: unionBounds(soups.map(meshBounds)),
    names,
  };
}

/** What the IGES import flow reports back to the page. */
export interface ImportedIgesFlow {
  /** The render state the imported-mesh viewport adopts. */
  readonly state: ImportedIgesState;
  /** The mesh-level provenance detail the import readout publishes. */
  readonly detail: {
    readonly origin: "imported-iges";
    readonly meshes: number;
    readonly unit: "mm";
  };
}

/**
 * Runs the IGES import flow: boots the engine on first use (the ~7.3 MB
 * wasm — pages that never import IGES never pay it), reads the bytes to
 * mesh bodies in canonical millimetres, and assembles the render state.
 * Rejects with the importer's structured failure message
 * (`iges-import/*: …`) — the fixture surfaces it verbatim.
 */
export async function importIgesBytes(
  bytes: Uint8Array,
): Promise<ImportedIgesFlow> {
  const engine = await bootIgesEngine();
  const { importIgesMeshes } =
    await import("@slopcad/cad-kernel-occt/occt-iges-import");
  const imported = importIgesMeshes(engine, bytes);
  if (!imported.ok) {
    throw new Error(`${imported.error.code}: ${imported.error.message}`);
  }
  return {
    state: buildImportedIgesState(
      imported.value.meshes.map((mesh) => mesh.tessellation),
      imported.value.meshes.map((mesh) => mesh.name),
    ),
    detail: {
      origin: "imported-iges",
      meshes: imported.value.meshes.length,
      unit: "mm",
    },
  };
}
