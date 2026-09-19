/**
 * The `STEP/IGES` guide's runnable example (docs/guides/step-iges.md):
 * the OpenCascade exchange surface, exercised over the real OCCT worker
 * thread — a fillet (the operation that needs OCCT's exact
 * `BRepFilletAPI`), a deterministic STEP export, a STEP re-import whose
 * solids carry the data-level `"imported-step"` provenance (geometry
 * only, no parametric history), and an IGES import through the optional
 * `occt-import-js` fallback engine, which yields MESHES (the same class
 * of body an STL import produces), not solids.
 */

import { readFileSync } from "node:fs";
import { createBodyId } from "@slopcad/cad-core";
import type { WorkerClient } from "@slopcad/cad-kernel";
import { length } from "@slopcad/cad-core";
import { createIgesEngine, importIgesMeshes } from "@slopcad/cad-kernel-occt";
import {
  createNodeOcctWorkerChannel,
  type NodeOcctWorkerChannel,
} from "@slopcad/cad-kernel-occt/node-occt-worker";

/** The committed IGES fixture: a 10 mm cube (see the package's fixtures). */
const IGES_FIXTURE = new URL(
  "../../../cad-kernel-occt/fixtures/cube-10mm.igs",
  import.meta.url,
);

/** What the example reports back to the guide and the docs page. */
export interface StepExampleSummary {
  readonly boxVolumeMm3: number;
  readonly filletedVolumeMm3: number;
  readonly filletEdgeOrdinal: number;
  readonly stepBytes: number;
  readonly importedOrigin: string;
  readonly importedVolumeMm3: number;
  readonly importAgreementRelative: number;
  readonly igesMeshCount: number;
  readonly igesFirstMeshExtentsMm: readonly number[];
}

/**
 * Runs the OCCT exchange chain on a real worker thread and the IGES
 * import in-process, reporting the measured facts the guide states.
 */
export async function runStepExample(): Promise<StepExampleSummary> {
  const channel: NodeOcctWorkerChannel = createNodeOcctWorkerChannel();
  try {
    const client: WorkerClient = channel.client;

    // Box → topology → fillet one edge → measure. The topology snapshot's
    // edge ordinals are the fillet's addressing vocabulary.
    const box = await client.request("solid.createBox", {
      width: length(30),
      depth: length(20),
      height: length(10),
    });
    const boxVolume = await client.request("solid.volume", {
      solid: box.solid,
    });
    const topology = await client.request("solid.topology", {
      solid: box.solid,
      bodyId: createBodyId("body_guide_step"),
      regeneration: 0,
    });
    const edge = topology.snapshot.entities.find(
      (entity) => entity.kind === "edge",
    );
    if (edge === undefined) {
      throw new Error("The box topology snapshot reported no edges.");
    }
    const filleted = await client.request("solid.fillet", {
      target: box.solid,
      edges: [edge.ordinal],
      radius: length(2),
    });
    const filletedVolume = await client.request("solid.volume", {
      solid: filleted.solid,
    });

    // STEP export (deterministic Part 21 bytes) and re-import.
    const exported = await client.request("step.export", {
      solids: [filleted.solid],
    });
    const imported = await client.request("step.import", {
      data: exported.data,
    });
    const importedSolid = imported.solids[0];
    if (importedSolid === undefined) {
      throw new Error("The STEP re-import produced no solids.");
    }
    const importedVolume = await client.request("solid.volume", {
      solid: importedSolid.solid,
    });

    // IGES import: the fallback engine reads MESHES (never solids).
    const iges = importIgesMeshes(
      await createIgesEngine(),
      new Uint8Array(readFileSync(IGES_FIXTURE)),
    );
    if (!iges.ok) {
      throw new Error(`The IGES fixture import failed: ${iges.error.message}`);
    }
    const firstMesh = iges.value.meshes[0];
    if (firstMesh === undefined) {
      throw new Error("The IGES fixture produced no meshes.");
    }
    const positions = firstMesh.tessellation.positions;
    const xs = positions.filter((_, i) => i % 3 === 0);
    const extents = [Math.max(...xs) - Math.min(...xs)] as const;

    return {
      boxVolumeMm3: boxVolume.volume,
      filletedVolumeMm3: filletedVolume.volume,
      filletEdgeOrdinal: edge.ordinal,
      stepBytes: exported.data.byteLength,
      importedOrigin: importedSolid.origin,
      importedVolumeMm3: importedVolume.volume,
      importAgreementRelative:
        Math.abs(importedVolume.volume - filletedVolume.volume) /
        filletedVolume.volume,
      igesMeshCount: iges.value.meshes.length,
      igesFirstMeshExtentsMm: extents,
    };
  } finally {
    await channel.close();
  }
}
