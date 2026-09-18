/**
 * The workbench's cross-feature chain scene (Phase 26 phase-level): the
 * REAL kernel executing the WHOLE feature chain — extrude → hole(s) →
 * fillet(s) → topology — inside ONE browser worker session, as ONE
 * composition per document change.
 *
 * ## Kernel reality (the integration decision, disclosed)
 *
 * The chain needs a fillet; the workbench session's Manifold kernel has no
 * fillet (`fillet: false` — every `fillet` call answers the structured
 * `kernel/unsupported-operation`). Mixed-kernel-per-feature is NOT a
 * capability anywhere in the architecture: a fixture session boots exactly
 * ONE worker (`bootRenderFixtureSession`), the worker server hosts exactly
 * ONE kernel (`createWorkerServer({ kernel })`), and the kernel feature
 * bridge runs against exactly ONE kernel instance per run
 * (`createKernelFeatureExecutor` — "use one kernel per bridge (and per
 * run)"). So the honest answer is a SINGLE-KERNEL CHAIN on the one kernel
 * that implements every stage: the OpenCascade worker (the /worker-fillet
 * precedent's entry). Every stage here is a kernel-neutral
 * `ComputationContext` request (`solid.extrude`, `solid.subtract`,
 * `solid.topology`, `solid.fillet`, the measurement trio) the OCCT worker
 * serves through the same operation matrix the Manifold worker does — the
 * per-feature scene modules (`extrude-scene`, `hole-scene`, `fillet-scene`)
 * prove each stage's semantics on their own kernels.
 *
 * ## The chain, per dispatch
 *
 * Every dispatch rebuilds the chain from the document's request: the base
 * `solid.extrude` (the 26.1 request), then one planned tool per hole
 * (`planHoleCut`, the bridge's ONE tool-geometry source of truth) and one
 * `solid.subtract`, then `solid.topology` of the fillet TARGET (the holed
 * solid — or the bare extrusion when no hole exists: the snapshot whose
 * edge ordinals both the picking layer and `solid.fillet` address), then
 * one `solid.fillet` per fillet feature in document order (each applied to
 * the previous result), measuring every stage (`solid.volume`,
 * `solid.bounds`, `solid.tessellate`). A parameter edit upstream therefore
 * re-executes the whole chain — the regeneration cascade IS the dispatch.
 *
 * ## Stage-attributed failures (the propagation carrier)
 *
 * A kernel rejection at any stage rejects the computation — the session's
 * stale-result coordinator never applies it, so the LAST-KNOWN-VALID scene
 * stays visible — but the page must know WHICH feature failed. Every stage
 * wraps its failures in a {@link ChainStageFailure} carrying the stage and
 * the attributed feature id plus the kernel's structured code (e.g.
 * `kernel/fillet-failed` for an oversized radius): upstream stages simply
 * never ran far enough to fail, and the page feeds the verdict into the
 * domain regeneration so the timeline shows exactly
 * extrude=valid, hole=valid, fillet=failed — recovery re-dispatches green.
 */

import { angle, createBodyId, length } from "@slopcad/cad-core";
import type { FeatureId, TopologySnapshot } from "@slopcad/cad-core";
import {
  KERNEL_ERROR_CODES,
  planHoleCut,
  WorkerRequestFailure,
} from "@slopcad/cad-kernel";
import type { ComputationContext, WorkerSolidId } from "@slopcad/cad-kernel";
import type { PlateMeasurement } from "./plate-scene";
import type { ExtrudeSceneRequest } from "./extrude-scene";

/** One hole's five numbers plus the feature id failures attribute to. */
export interface ChainHoleRequest {
  readonly featureId: FeatureId;
  readonly diameterMm: number;
  readonly depthMm: number;
  readonly positionXMm: number;
  readonly positionYMm: number;
  readonly axis: 1 | 2 | 3;
}

/** One fillet's edge address, radius, and feature id (failure attribution). */
export interface ChainFilletRequest {
  readonly featureId: FeatureId;
  /** The target snapshot's edge ordinal — the pick-by-snapshot address. */
  readonly edgeOrdinal: number;
  readonly radiusMm: number;
}

/** The chain request the document reader derives (see cad-workbench/chain). */
export interface ChainSceneRequest {
  /** The base extrusion (the 26.1 request form). */
  readonly base: ExtrudeSceneRequest;
  /** The extrude feature id — the extrude stage's failure attribution. */
  readonly baseFeatureId: FeatureId;
  /** The body id the fillet target's snapshot is labeled with. */
  readonly targetBodyId: string;
  /** The holes, in document order; all cut the base extrusion. */
  readonly holes: readonly ChainHoleRequest[];
  /** The fillets, in document order; all address the target's snapshot. */
  readonly fillets: readonly ChainFilletRequest[];
}

/** What one chain dispatch computes: every stage's measurement plus the
 *  target's topology snapshot (the picking layer's data source). */
export interface ChainScene {
  /** The bare extrusion's measurement (the chain's V1). */
  readonly extruded: PlateMeasurement;
  /** The holed solid's measurement, when the document carries holes (V2). */
  readonly holed: PlateMeasurement | null;
  /** The final filleted solid's measurement, when fillets ran (V3). */
  readonly filleted: PlateMeasurement | null;
  /** The fillet target's snapshot (holed solid, else the extrusion) — the
   *  edge-ordinal address space both the picking layer and `solid.fillet`
   *  consume, at THIS dispatch's regeneration. */
  readonly snapshot: TopologySnapshot;
  /** The ordinals the executed fillets consumed, in document order. */
  readonly filletEdges: readonly number[];
  /** The radii the executed fillets used, in document order. */
  readonly filletRadii: readonly number[];
}

/** The stage a failed chain dispatch got to, and the feature it belongs to. */
export type ChainStage = "extrude" | "hole" | "fillet";

/**
 * A stage-attributed chain failure: the carrier the page's session uses to
 * feed the worker's verdict into the domain regeneration (the attributed
 * feature fails; its upstream keeps the valid states it already earned).
 * Thrown for kernel rejections AND for the chain's own post-conditions —
 * the code is the kernel's structured code when one exists, the
 * operation-failed fallback otherwise.
 */
export class ChainStageFailure extends Error {
  readonly stage: ChainStage;
  readonly featureId: FeatureId;
  readonly kernelCode: string;

  constructor(
    stage: ChainStage,
    featureId: FeatureId,
    kernelCode: string,
    message: string,
  ) {
    super(message);
    this.name = "ChainStageFailure";
    this.stage = stage;
    this.featureId = featureId;
    this.kernelCode = kernelCode;
  }

  /** The error-surface form: the structured code, then the message. */
  surfaceText(): string {
    return `${this.kernelCode}: ${this.message}`;
  }
}

/** Wraps one stage's failure into its attributed {@link ChainStageFailure}. */
function stageFailure(
  stage: ChainStage,
  featureId: FeatureId,
  failure: unknown,
): ChainStageFailure {
  if (failure instanceof ChainStageFailure) return failure;
  if (failure instanceof WorkerRequestFailure) {
    const code = failure.error.data?.kernelCode;
    return new ChainStageFailure(
      stage,
      featureId,
      typeof code === "string" ? code : KERNEL_ERROR_CODES.unsupportedOperation,
      failure.error.message,
    );
  }
  return new ChainStageFailure(
    stage,
    featureId,
    KERNEL_ERROR_CODES.unsupportedOperation,
    failure instanceof Error ? failure.message : String(failure),
  );
}

const mm = (value: number) => length(value, "mm");

/** The measurement set every stage reports (volume, area, bounds, tessellation). */
async function measure(
  context: ComputationContext,
  solid: WorkerSolidId,
): Promise<PlateMeasurement> {
  const volume = await context.request("solid.volume", { solid });
  const area = await context.request("solid.area", { solid });
  const bounds = await context.request("solid.bounds", { solid });
  const tessellation = await context.request("solid.tessellate", { solid });
  return {
    volume: volume.volume,
    area: area.area,
    bounds: bounds.bounds,
    triangles: tessellation.tessellation.indices.length / 3,
    tessellation: tessellation.tessellation,
  };
}

/**
 * The no-op post-condition's carrier (the hole scene's rule, verbatim): a
 * subtract whose tools miss the target returns the target UNCHANGED — the
 * chain refuses it as a stage failure instead of silently continuing.
 */
const NOOP_EPSILON_RELATIVE = 1e-9;

/**
 * Runs the whole chain through the worker operation matrix: extrude →
 * holes → topology → fillets, measuring every stage. Any stage failure
 * rejects with its attributed {@link ChainStageFailure}.
 */
export async function computeChainScene(
  context: ComputationContext,
  request: ChainSceneRequest,
): Promise<ChainScene> {
  // -- Stage 1: the base extrusion (V1) ---------------------------------
  let extrudedSolid: WorkerSolidId;
  let extruded: PlateMeasurement;
  try {
    const extrudedResult = await context.request("solid.extrude", {
      loop: request.base.loop,
      height: mm(Math.abs(request.base.distanceMm)),
      direction: request.base.distanceMm > 0 ? 1 : -1,
      placement: request.base.placement,
    });
    extrudedSolid = extrudedResult.solid;
    extruded = await measure(context, extrudedSolid);
  } catch (failure) {
    throw stageFailure("extrude", request.baseFeatureId, failure);
  }

  // -- Stage 2: the holes (V2) -------------------------------------------
  let holed: PlateMeasurement | null = null;
  let targetSolid = extrudedSolid;
  if (request.holes.length > 0) {
    // The LAST hole is the newest authoring action — the stage's failures
    // (a refused subtract, a no-op cut) attribute to it.
    const lastHole = request.holes[request.holes.length - 1];
    if (lastHole === undefined) {
      throw new Error(
        "Invariant violation: a non-empty hole list has a last entry.",
      );
    }
    try {
      const measured = await context.request("solid.bounds", {
        solid: extrudedSolid,
      });
      const baseVolume = await context.request("solid.volume", {
        solid: extrudedSolid,
      });
      const tools: { readonly solid: WorkerSolidId }[] = [];
      for (const hole of request.holes) {
        const plan = planHoleCut({
          diameterMm: hole.diameterMm,
          depthMm: hole.depthMm,
          positionXMm: hole.positionXMm,
          positionYMm: hole.positionYMm,
          axis: hole.axis,
          bounds: measured.bounds,
        });
        const tool = await context.request("solid.extrude", {
          loop: [{ kind: "circle", center: [0, 0], radius: plan.toolRadiusMm }],
          height: mm(plan.toolHeightMm),
          direction: 1,
          placement: {
            rotation: {
              axis: plan.toolRotationAxis,
              angle: angle(plan.toolRotationAngleRad, "rad"),
            },
            translation: {
              x: mm(plan.toolTranslationMm[0]),
              y: mm(plan.toolTranslationMm[1]),
              z: mm(plan.toolTranslationMm[2]),
            },
          },
        });
        tools.push(tool);
      }
      const cut = await context.request("solid.subtract", {
        target: extrudedSolid,
        tools: tools.map((tool) => tool.solid),
      });
      const cutVolume = await context.request("solid.volume", {
        solid: cut.solid,
      });
      const epsilon = Math.max(
        1e-9,
        Math.abs(baseVolume.volume) * NOOP_EPSILON_RELATIVE,
      );
      if (cutVolume.volume >= baseVolume.volume - epsilon) {
        throw new Error(
          `The hole removed no material: Ø${String(lastHole.diameterMm)} × ${String(lastHole.depthMm)} mm at in-plane (${String(lastHole.positionXMm)}, ${String(lastHole.positionYMm)}) misses the solid (bounds [${measured.bounds.min.join(", ")}] → [${measured.bounds.max.join(", ")}]). Move holeX/holeY onto the solid or grow the diameter — the subtract would otherwise silently return it unchanged.`,
        );
      }
      holed = await measure(context, cut.solid);
      targetSolid = cut.solid;
    } catch (failure) {
      throw stageFailure("hole", lastHole.featureId, failure);
    }
  }

  // -- Stage 3: the target's topology snapshot ---------------------------
  // The snapshot stands at THIS dispatch's regeneration and is labeled with
  // the target body — the addresses `solid.fillet` consumes below are the
  // very ordinals the picking layer projects from this snapshot.
  let snapshot: TopologySnapshot;
  try {
    const topology = await context.request("solid.topology", {
      solid: targetSolid,
      bodyId: createBodyId(request.targetBodyId),
      regeneration: context.revision,
    });
    snapshot = topology.snapshot;
  } catch (failure) {
    throw stageFailure(
      "hole",
      request.holes[request.holes.length - 1]?.featureId ??
        request.baseFeatureId,
      failure,
    );
  }

  // -- Stage 4: the fillets (V3), each on the previous result ------------
  let filleted: PlateMeasurement | null = null;
  let latestSolid = targetSolid;
  const filletEdges: number[] = [];
  const filletRadii: number[] = [];
  for (const fillet of request.fillets) {
    try {
      const rounded = await context.request("solid.fillet", {
        target: latestSolid,
        edges: [fillet.edgeOrdinal],
        radius: mm(fillet.radiusMm),
      });
      latestSolid = rounded.solid;
      filleted = await measure(context, latestSolid);
      filletEdges.push(fillet.edgeOrdinal);
      filletRadii.push(fillet.radiusMm);
    } catch (failure) {
      throw stageFailure("fillet", fillet.featureId, failure);
    }
  }

  return {
    extruded,
    holed,
    filleted,
    snapshot,
    filletEdges,
    filletRadii,
  };
}
