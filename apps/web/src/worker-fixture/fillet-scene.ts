/**
 * The workbench's fillet scene (Phase 26.5): the REAL OpenCascade kernel
 * executing the box → topology → fillet chain inside the browser worker —
 * the snapshot-driven picking data and the fillet itself through the same
 * worker channel.
 *
 * Every dispatch rebuilds the chain from a fresh `solid.createBox` so each
 * computation is a pure function of (edge ordinal, radius): the box's
 * `solid.topology` snapshot supplies the EDGE ENTITIES the picking layer
 * projects (ordinal, measured length, centroid), and — when a fillet is
 * requested — `solid.fillet` consumes one of those very ordinals, closing
 * the pick-by-snapshot loop. The kernel's structured failures (an oversized
 * radius probed as `IsDone = false` → `kernel/fillet-failed`) reject the
 * computation, which the page surfaces verbatim.
 */

import { createBodyId, length } from "@slopcad/cad-core";
import type { ComputationContext } from "@slopcad/cad-kernel";
import type { PlateMeasurement } from "./plate-scene";

/** The fixture box's extents (mm) — the analytic corner-fillet fixture. */
export const FILLET_BOX = {
  width: 30,
  depth: 20,
  height: 10,
} as const;

/** The fixture body id the snapshot labels (the picking layer's body). */
export const FILLET_BODY_ID = "body_fillet_box";

/** One pickable edge of the box snapshot, in picking-layer form. */
export interface FilletSceneEdge {
  /** The snapshot edge ordinal — the `solid.fillet` address. */
  readonly ordinal: number;
  /** The kernel-measured edge length (mm). */
  readonly lengthMm: number;
  /** The edge centroid in world millimetres (the projection anchor). */
  readonly centroidMm: readonly [number, number, number];
}

/** What one fillet-scene dispatch computes. */
export interface FilletScene {
  /** The un-filleted box's measurement (the picking stage's scene). */
  readonly box: PlateMeasurement;
  /** The pickable edges, in snapshot order. */
  readonly edges: readonly FilletSceneEdge[];
  /** The filleted solid's measurement, when a fillet was requested. */
  readonly filleted: PlateMeasurement | null;
  /** The edge ordinal the executed fillet consumed, when it ran. */
  readonly filletEdge: number | null;
  /** The radius the executed fillet used, when it ran. */
  readonly filletRadiusMm: number | null;
}

/** The dispatch parameters one fillet scene computation runs with. */
export interface FilletSceneRequest {
  /** The selected snapshot edge ordinal, or `null` for the picking stage. */
  readonly edgeOrdinal: number | null;
  /** The fillet radius (mm), or `null` for the picking stage. */
  readonly radiusMm: number | null;
}

/**
 * Runs the box → topology → (fillet) → measure chain through the worker
 * operation matrix. The topology request carries the fixture body id and
 * regeneration 0 — labels the snapshot needs, not facts it fabricates.
 */
export async function computeFilletScene(
  context: ComputationContext,
  request: FilletSceneRequest,
): Promise<FilletScene> {
  const box = await context.request("solid.createBox", {
    width: length(FILLET_BOX.width, "mm"),
    depth: length(FILLET_BOX.depth, "mm"),
    height: length(FILLET_BOX.height, "mm"),
  });
  const topology = await context.request("solid.topology", {
    solid: box.solid,
    bodyId: createBodyId(FILLET_BODY_ID),
    regeneration: 0,
  });
  const edges = topology.snapshot.entities
    .filter((entity) => entity.kind === "edge")
    .map((entity) => {
      const centroid = entity.geometry.centroidAbsoluteMm;
      const lengthMm = entity.geometry.lengthMm;
      if (centroid === undefined || lengthMm === undefined) {
        throw new Error(
          `The box snapshot's edge at ordinal ${String(entity.ordinal)} carries no centroid or length; the picking layer cannot project it.`,
        );
      }
      return {
        ordinal: entity.ordinal,
        lengthMm,
        centroidMm: [centroid[0], centroid[1], centroid[2]] as const,
      };
    });
  const boxVolume = await context.request("solid.volume", {
    solid: box.solid,
  });
  const boxBounds = await context.request("solid.bounds", { solid: box.solid });
  const boxTessellation = await context.request("solid.tessellate", {
    solid: box.solid,
  });

  let filleted: PlateMeasurement | null = null;
  let filletEdge: number | null = null;
  let filletRadiusMm: number | null = null;
  if (request.edgeOrdinal !== null && request.radiusMm !== null) {
    filletEdge = request.edgeOrdinal;
    filletRadiusMm = request.radiusMm;
    const rounded = await context.request("solid.fillet", {
      target: box.solid,
      edges: [request.edgeOrdinal],
      radius: length(request.radiusMm, "mm"),
    });
    const volume = await context.request("solid.volume", {
      solid: rounded.solid,
    });
    const bounds = await context.request("solid.bounds", {
      solid: rounded.solid,
    });
    const tessellation = await context.request("solid.tessellate", {
      solid: rounded.solid,
    });
    filleted = {
      volume: volume.volume,
      bounds: bounds.bounds,
      triangles: tessellation.tessellation.indices.length / 3,
      tessellation: tessellation.tessellation,
    };
  }

  return {
    box: {
      volume: boxVolume.volume,
      bounds: boxBounds.bounds,
      triangles: boxTessellation.tessellation.indices.length / 3,
      tessellation: boxTessellation.tessellation,
    },
    edges,
    filleted,
    filletEdge,
    filletRadiusMm,
  };
}
