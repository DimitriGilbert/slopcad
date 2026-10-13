/**
 * The topology-cut scene computation: ONE fillet/chamfer/shell request
 * (`../cad-workbench/topology-cut` reads it from the document) executes
 * through the kernel's own `solid.fillet` / `solid.chamfer` /
 * `solid.shell` over its target's CURRENT solid (the operand handoff —
 * an earlier cut's output composes the next), and the result is measured
 * the way every scene does. The solid rides the result so a chained cut
 * or any other consumer composes from it.
 *
 * ## The selection's resolution (the bridge's battery, worker-side)
 *
 * The canonical persistent references resolve against the target's
 * topology snapshot at THIS dispatch's regeneration (`solid.topology`
 * labeled with the target body): `resolveTopologyReference` must answer
 * `valid` or `repaired`, and `transientSelectionOf` maps it to the
 * snapshot ordinal the kernel consumes. A name-based identity (the OCCT
 * kernel's `occt-name/1`) re-resolves `valid` across passes — through
 * rebuilds and parameter edits alike — because the name derives from the
 * construction history, not the shape. A `missing` reference (an unnamed
 * operation's output, a deleted or split entity) tries cad-core's bounded
 * `repairMissingReference` against the same snapshot before refusing (the
 * Phase N3 fallback). Any other outcome rejects the scene with the state —
 * and the repair's refusal when one was tried — named: never a silent
 * re-attach, and the document pass renders the target's state in its
 * place. The fixture ordinal form passes straight to the kernel, which
 * judges it.
 *
 * The computation stays a pure carrier of the operation matrix like every
 * other scene: no Date, no random, results derive from the request alone.
 */

import {
  createBodyId,
  length,
  repairMissingReference,
  resolveTopologyReference,
  transientSelectionOf,
} from "@slopcad/cad-core";
import type {
  TopologyEntityReference,
  TopologySnapshot,
} from "@slopcad/cad-core";
import type { ComputationContext, WorkerSolidId } from "@slopcad/cad-kernel";
import type {
  TopologyCutEntityKind,
  TopologyCutSceneRequest,
} from "../cad-workbench/topology-cut";
import type { ComposedSceneResult, ComputedSolids } from "./body-ops-scenes";

import { topologyCutEntityKindOf } from "../cad-workbench/topology-cut";
import { measure, NO_COMPUTED_SOLIDS, operandSolid } from "./body-ops-scenes";

/**
 * Resolves persistent references against ONE topology snapshot (the pure
 * core of {@link resolveReferenceOrdinals}, shared with the chain scene,
 * which already holds its target's snapshot): each reference must resolve
 * `valid` — or, standing `missing`, repair — and map through
 * `transientSelectionOf` to one entity of `entityKind`. Answers the
 * snapshot ordinals in reference order. Throws — the scene's structured
 * rejection, the validity state and any repair refusal named — on any
 * other outcome.
 */
export function referenceOrdinalsIn(
  snapshot: TopologySnapshot,
  references: readonly TopologyEntityReference[],
  entityKind: TopologyCutEntityKind,
  featureKind: string,
): readonly number[] {
  const ordinals: number[] = [];
  for (const reference of references) {
    const resolved = resolveTopologyReference(reference, snapshot);
    if (!resolved.ok) {
      throw new Error(
        `reference-unresolved: the ${featureKind}'s ${entityKind} reference could not resolve against the target's current topology: ${resolved.error.message}`,
      );
    }
    const { reference: outcome, repairError } = repairMissingReference(
      resolved.value,
      snapshot,
    );
    const { state, reason } = outcome.validity;
    const selected = transientSelectionOf(outcome);
    if (!selected.ok) {
      throw new Error(
        `reference-unresolved: the ${featureKind}'s ${entityKind} reference stands ${state}${reason === undefined ? "" : ` (${reason})`} against the target's current topology${repairError === undefined ? "" : `, and its repair refused (${repairError.code}): ${repairError.message}`}. Re-select the ${entityKind} to mint a fresh reference.`,
      );
    }
    const entity = selected.value;
    if (entity.kind === "edge" && entityKind === "edge") {
      ordinals.push(entity.edgeIndex);
    } else if (entity.kind === "face" && entityKind === "face") {
      ordinals.push(entity.faceIndex);
    } else {
      throw new Error(
        `reference-unresolved: the ${featureKind}'s reference resolved to a ${entity.kind}, but the ${featureKind} addresses ${entityKind}s.`,
      );
    }
  }
  return ordinals;
}

/**
 * Resolves persistent references against the target's topology snapshot
 * at THIS dispatch's regeneration (shared by every topology-addressed
 * scene — the cuts here, the face ops, the face pattern) through
 * {@link referenceOrdinalsIn}. Answers the snapshot ordinals in reference
 * order plus the snapshot itself (a consumer may need the resolved
 * entities' descriptors). Throws — the scene's structured rejection — on
 * any outcome but `valid` / `repaired`.
 */
export async function resolveReferenceOrdinals(
  context: ComputationContext,
  target: WorkerSolidId,
  targetBodyId: string,
  references: readonly TopologyEntityReference[],
  entityKind: TopologyCutEntityKind,
  featureKind: string,
): Promise<{
  readonly ordinals: readonly number[];
  readonly snapshot: TopologySnapshot;
}> {
  const { snapshot } = await context.request("solid.topology", {
    solid: target,
    bodyId: createBodyId(targetBodyId),
    regeneration: context.revision,
  });
  return {
    ordinals: referenceOrdinalsIn(
      snapshot,
      references,
      entityKind,
      featureKind,
    ),
    snapshot,
  };
}

/**
 * Resolves the request's selection to the target snapshot's ordinals: the
 * ordinal form verbatim, the reference form through the current
 * regeneration's snapshot (see the module doc).
 */
async function selectionOrdinals(
  context: ComputationContext,
  request: TopologyCutSceneRequest,
  target: WorkerSolidId,
): Promise<readonly number[]> {
  const { selection } = request;
  if (selection.kind === "ordinals") return selection.ordinals;
  const resolved = await resolveReferenceOrdinals(
    context,
    target,
    request.targetBodyId,
    selection.references,
    topologyCutEntityKindOf(request.kind),
    request.kind,
  );
  return resolved.ordinals;
}

/** Computes one fillet/chamfer/shell body: the cut solid plus its measurement. */
export async function computeTopologyCutScene(
  context: ComputationContext,
  request: TopologyCutSceneRequest,
  computed: ComputedSolids = NO_COMPUTED_SOLIDS,
): Promise<ComposedSceneResult> {
  const target = await operandSolid(
    context,
    request.target,
    computed,
    "target",
  );
  const ordinals = await selectionOrdinals(context, request, target);
  const size = length(request.sizeMm, "mm");
  const cut =
    request.kind === "fillet"
      ? await context.request("solid.fillet", {
          target,
          edges: ordinals,
          radius: size,
        })
      : request.kind === "chamfer"
        ? await context.request("solid.chamfer", {
            target,
            edges: ordinals,
            distance: size,
          })
        : await context.request("solid.shell", {
            target,
            faces: ordinals,
            thickness: size,
          });
  const measurement = await measure(context, cut.solid);
  return { measurement, solid: cut.solid };
}
