/**
 * The workbench's cross-feature chain wiring (Phase 26 phase-level): the
 * one module that reads the accumulated document — extrude, then hole(s),
 * then fillet(s) — into the single chain-scene request the OCCT worker
 * session executes as ONE composition. The sequel to `./extrude` and
 * `./hole`, composed with them: the base resolves through `./extrude`'s
 * per-feature reader, every hole through `./hole`'s five-parameter reader,
 * and each fillet through this module's own reader.
 *
 * ## The chain's document vocabulary
 *
 * The workflow builds the document the same way the workbench's actions
 * do — atomic transactions of the serializable command vocabulary:
 *
 *  - the sketch → extrude action commits the sketch record, the signed
 *    distance parameter, the output body, and the `extrude` feature;
 *  - the hole action commits the five hole parameters, the output body,
 *    and the `hole` feature targeting the last extrude;
 *  - the fillet action commits the radius parameter, a document
 *    REFERENCE record holding the persistent topology reference minted
 *    from the picked edge of the applied scene's target snapshot, the
 *    output body, and the `fillet` feature in the bridge's canonical
 *    layout: one feature input (the target), the reference input, and the
 *    radius parameter input.
 *
 * The reference decision (Phase N3, replacing the earlier snapshot-ordinal
 * parameter): the OCCT kernel's identity payloads are history-based
 * construction names (`occt-name/1`), which read no dimension, so a
 * reference minted in one dispatch re-resolves `valid` in every rebuild —
 * including the upstream-edit cascade (a depth edit changes the edge's
 * length, not its name). The chain scene resolves it per dispatch; a
 * `missing` reference tries the bounded repair before the fillet stage
 * refuses — never a silent re-attach. Documents authored before names
 * (the radius parameter plus a DIMENSIONLESS edge-ordinal parameter —
 * `./topology-cut`'s `chainFilletInputOf`) still read, their ordinals
 * judged by the kernel.
 *
 * ## The scene request
 *
 * {@link documentChainSceneRequest} reads the whole chain into one
 * {@link ChainSceneRequest}: the last extrude as the base (the scene
 * composition's base, the hole action's target), every hole cutting that
 * base in document order, the fillet target (the last hole's output, else
 * the base's), and every fillet addressing that target's snapshot. Feature
 * ids ride along so a failed dispatch attributes its stage failure. `null`
 * when the document carries no extrude or any input no longer resolves —
 * callers render the prior scene rather than fabricate geometry.
 */

import type { CadDocument, FeatureRecord } from "@slopcad/cad-core";
import type {
  ChainFilletRequest,
  ChainHoleRequest,
  ChainSceneRequest,
} from "../worker-fixture/chain-scene";

import { extrudeSceneRequestOfFeature } from "./extrude";
import {
  holeBaseFeatureOf,
  holeCutInputOfFeature,
  isStructuredHoleFeature,
  structuredHoleCutInputOfFeature,
} from "./hole";
import {
  topologyCutInputOf,
  topologyCutTargetBodyIdOf,
  type TopologyCutSelection,
} from "./topology-cut";

/** The radius a fillet action creates its radius parameter with (mm). */
export const CHAIN_FILLET_DEFAULT_RADIUS_MM = 3;

/**
 * The solid the next fillet rounds: the LAST hole's output when holes
 * exist, else the last extrude's output — the newest solid stage.
 */
export function filletBaseFeatureOf(
  document: CadDocument,
): FeatureRecord | undefined {
  const holes = document.features.filter((entry) => entry.kind === "hole");
  const lastHole = holes[holes.length - 1];
  if (lastHole !== undefined) return lastHole;
  return holeBaseFeatureOf(document);
}

/**
 * Reads one chain fillet feature's radius and edge selection through the
 * document scene's topology-cut reader (`./topology-cut` — the ONE reader
 * of both fillet layouts): the canonical reference form the pick authors,
 * or the legacy single-ordinal form. `null` when the feature's target, its
 * radius, or its selection no longer resolves.
 */
export function chainFilletOf(
  document: CadDocument,
  feature: FeatureRecord,
): {
  readonly radiusMm: number;
  readonly selection: TopologyCutSelection;
} | null {
  const targetBodyId = topologyCutTargetBodyIdOf(document, feature);
  if (targetBodyId === null) return null;
  const input = topologyCutInputOf(document, feature, "fillet", targetBodyId);
  if (input === null) return null;
  return { radiusMm: input.sizeMm, selection: input.selection };
}

/**
 * The feature/body input's referenced id of one feature (its single solid
 * source), or `null` when the layout is malformed.
 */
function solidTargetIdOf(feature: FeatureRecord): string | null {
  const targetRefs = feature.inputs.filter(
    (ref) => ref.kind === "feature" || ref.kind === "body",
  );
  const target = targetRefs[0];
  return target === undefined ? null : target.id;
}

/**
 * Reads the accumulated chain document into the worker-scene request: the
 * LAST extrude as the base, every hole cutting that base (document order),
 * the fillet target (last hole's output, else the base's output), and
 * every fillet addressing that target (document order). The rendered body
 * is the newest output (the last fillet's, else the target's). `null` when
 * the document carries no extrude, the base no longer resolves, any hole
 * cuts a different base, or any fillet targets another solid or no longer
 * resolves — callers render the prior scene rather than fabricate geometry.
 */
export function documentChainSceneRequest(
  document: CadDocument,
): { readonly request: ChainSceneRequest; readonly bodyId: string } | null {
  const extrudes = document.features.filter(
    (entry) => entry.kind === "extrude",
  );
  const base = extrudes[extrudes.length - 1];
  if (base === undefined) return null;
  const baseRequest = extrudeSceneRequestOfFeature(document, base);
  if (baseRequest === null) return null;

  const holes: ChainHoleRequest[] = [];
  for (const holeFeature of document.features) {
    if (holeFeature.kind !== "hole") continue;
    if (solidTargetIdOf(holeFeature) !== base.id) return null;
    // Phase 52 chain composition: a hole feature whose FIRST parameter is
    // the dimensionless type selector rides the structured form (the hole
    // scene's dispatch rule); the flat five-parameter form stays
    // byte-compatible. Both compose into the ONE chain request.
    if (isStructuredHoleFeature(document, holeFeature)) {
      const structured = structuredHoleCutInputOfFeature(document, holeFeature);
      if (structured === null) return null;
      holes.push({ featureId: holeFeature.id, ...structured });
      continue;
    }
    const hole = holeCutInputOfFeature(document, holeFeature);
    if (hole === null) return null;
    holes.push({ featureId: holeFeature.id, ...hole });
  }

  const filletBase = filletBaseFeatureOf(document);
  if (filletBase === undefined) return null;
  const targetBodyId = filletBase.outputs[0];
  if (targetBodyId === undefined) return null;

  const fillets: ChainFilletRequest[] = [];
  for (const filletFeature of document.features) {
    if (filletFeature.kind !== "fillet") continue;
    if (solidTargetIdOf(filletFeature) !== filletBase.id) return null;
    const fillet = chainFilletOf(document, filletFeature);
    if (fillet === null) return null;
    fillets.push({ featureId: filletFeature.id, ...fillet });
  }

  const filletFeatures = document.features.filter(
    (entry) => entry.kind === "fillet",
  );
  const lastFilletFeature = filletFeatures[filletFeatures.length - 1];
  const filletOutput = lastFilletFeature?.outputs[0];
  const bodyId = filletOutput ?? targetBodyId;

  return {
    request: {
      base: {
        loop: baseRequest.loop,
        placement: baseRequest.placement,
        distanceMm: baseRequest.distanceMm,
      },
      baseFeatureId: base.id,
      targetBodyId,
      holes,
      fillets,
    },
    bodyId,
  };
}

/**
 * Whether ONE more extrude action would invalidate the chain scene request
 * for the document it lands on (the chain page's extrude action guard):
 * the new extrude becomes the base, so every existing hole — cut into the
 * previous last extrude — mismatches the base check, and with no holes an
 * existing fillet — targeted at the previous newest stage — mismatches the
 * fillet-target check the same way. A document with neither holes nor
 * fillets composes the new extrude cleanly (a fresh base with nothing
 * built on the old one). Guarding the action keeps the page from
 * committing a valid transaction the dispatch could no longer resolve —
 * the viewport would silently freeze on the last settled scene.
 */
export function nextExtrudeInvalidatesChain(document: CadDocument): boolean {
  return document.features.some(
    (feature) => feature.kind === "hole" || feature.kind === "fillet",
  );
}

/**
 * Whether ONE more hole action would invalidate the chain scene request
 * for the document it lands on (the chain page's hole action guard): the
 * new hole becomes the fillet target (the newest solid stage), so an
 * existing fillet — targeted at the previous newest stage — no longer
 * matches it. Holes without fillets compose legally (every hole cuts the
 * same base), so only a fillet guards the action.
 */
export function nextHoleInvalidatesChain(document: CadDocument): boolean {
  return document.features.some((feature) => feature.kind === "fillet");
}
