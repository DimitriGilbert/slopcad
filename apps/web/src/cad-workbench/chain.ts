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
 *  - the fillet action commits the radius parameter, the picked edge's
 *    snapshot ordinal as a DIMENSIONLESS parameter (the hole axis
 *    selector's precedent: a structural address, not a physical
 *    quantity), the output body, and the `fillet` feature with one
 *    feature input (the target) and those two parameter inputs.
 *
 * The ordinal-as-parameter decision is disclosed against the alternative:
 * the bridge's canonical `fillet` layout carries Phase 22 persistent
 * REFERENCES, but this kernel's identity payloads are within-regeneration
 * shape hashes (allocation-address-derived — every rebuild produces a
 * disjoint set), so a minted reference resolves `missing` on the very next
 * dispatch, and the repair heuristic refuses measure-changing re-anchors
 * by design (a depth edit changes the recorded edge length — exactly the
 * pinned upstream-edit cascade). The snapshot-ordinal address is the
 * /worker-fillet precedent: on a rebuild-executing chain the snapshot is
 * the honest edge identity, the ordinals are deterministic per topology,
 * and a stale ordinal is judged by the KERNEL (`solid.fillet` rejects the
 * structured failure) — never a silent re-attach.
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
import { valueIn } from "@slopcad/cad-core";
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
 * Reads one fillet feature's inputs in declared role order: one feature or
 * body input (the target) and two parameter inputs — the radius (a length,
 * strictly positive) and the picked edge's snapshot ordinal (dimensionless
 * integer). `null` when the layout is malformed or any parameter no longer
 * resolves.
 */
export function chainFilletInputOf(
  document: CadDocument,
  feature: FeatureRecord,
): { readonly radiusMm: number; readonly edgeOrdinal: number } | null {
  const targetRefs = feature.inputs.filter(
    (ref) => ref.kind === "feature" || ref.kind === "body",
  );
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  if (targetRefs.length !== 1 || parameterRefs.length !== 2) return null;
  const radiusRef = parameterRefs[0];
  const edgeRef = parameterRefs[1];
  if (radiusRef === undefined || edgeRef === undefined) return null;
  const radiusParameter = document.parameters.parameters.find(
    (candidate) => candidate.id === radiusRef.id,
  );
  const radiusMm =
    radiusParameter === undefined ||
    radiusParameter.value.dimension !== "length"
      ? null
      : valueIn(radiusParameter.value, "mm");
  const edgeParameter = document.parameters.parameters.find(
    (candidate) => candidate.id === edgeRef.id,
  );
  const edgeRaw =
    edgeParameter === undefined ||
    edgeParameter.value.dimension !== "dimensionless"
      ? null
      : valueIn(edgeParameter.value, "1");
  if (
    radiusMm === null ||
    !(radiusMm > 0) ||
    edgeRaw === null ||
    !Number.isInteger(edgeRaw) ||
    edgeRaw < 0
  ) {
    return null;
  }
  return { radiusMm, edgeOrdinal: edgeRaw };
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
    const fillet = chainFilletInputOf(document, filletFeature);
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
