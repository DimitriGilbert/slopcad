/**
 * The workbench's topology-cut wiring: the document readers for the three
 * topology-addressed bridge kinds — `fillet`, `chamfer` (both on EDGES),
 * and `shell` (on FACES) — read into the worker-scene requests the
 * document pass executes through the kernel's own `solid.fillet` /
 * `solid.chamfer` / `solid.shell` operations.
 *
 * ## The two selection forms (both pre-existing, none invented)
 *
 * - The bridge's CANONICAL layout (`@slopcad/cad-kernel`'s core bridge,
 *   `runEdgeCutOperation`, the form `@slopcad/cad-jsx` compiles): ONE
 *   feature/body input (the target solid), ONE OR MORE reference inputs
 *   (document reference records whose payloads are persistent
 *   `TopologyEntityReference`s of the call's entity kind, addressing the
 *   target's own body), exactly ONE length parameter (the radius, the
 *   symmetric distance, or the wall thickness), and no sketch input. The
 *   reader runs the bridge's document-side battery (record present,
 *   payload parses, entity kind, owning body, provenance intact); the
 *   CURRENT-regeneration resolution — the reference against the target's
 *   own topology snapshot, then `transientSelectionOf` to an ordinal —
 *   runs in the worker, where the target's solid exists
 *   (`../worker-fixture/topology-cut-scene`). A stale reference refuses
 *   there with its validity state named, never a silent re-attach.
 * - The chain workbench's legacy ORDINAL form ({@link chainFilletInputOf},
 *   what its fillet action authored before Phase N3 — FILLET only): ONE
 *   feature/body input, no reference inputs, and EXACTLY two parameters —
 *   the radius (LENGTH) first, then ONE DIMENSIONLESS whole-number edge
 *   ordinal of the target's snapshot, judged by the kernel at execution
 *   (a stale ordinal is the kernel's structured refusal). A chamfer or
 *   shell without references, or a fillet with any other parameter
 *   layout, is no layout anything authors — it emits no scene entry. The
 *   chain workbench (`./chain`) reads BOTH forms through
 *   {@link topologyCutInputOf}, so the chain and the document scene judge
 *   one layout.
 *
 * ## The domain (enforced BEFORE any scene exists)
 *
 * The size is strictly positive and finite and the selection non-empty
 * (the `./pattern` precedent): an out-of-domain feature is a refused
 * feature — it emits no scene entry, so the document scene never presents
 * a successful verdict over geometry regeneration rejects.
 *
 * ## The composition
 *
 * EVERY topology-cut feature renders (a plural reader, the transform
 * patterns' precedent), each consuming its target's CURRENT solid through
 * the shared operand seam (`./extrude`'s `sceneOperandOfBody`) — so a
 * fillet over a chamfer over a box composes in document order, each op's
 * output the next op's target.
 */

import type {
  CadDocument,
  FeatureRecord,
  ReferenceId,
  TopologyEntityReference,
} from "@slopcad/cad-core";
import {
  getDocumentReference,
  parseTopologyReference,
  provenanceIntact,
} from "@slopcad/cad-core";

import { sceneOperandOfBody, type SceneOperand } from "./extrude";
import { magnitudeIn, parameterValueOf } from "./parameter-magnitude";

/** The topology-addressed feature kinds (the bridge's `TopologyCutKind`). */
export type TopologyCutKind = "fillet" | "chamfer" | "shell";

/** The topology entity kind one cut addresses: edges, or faces (shell). */
export type TopologyCutEntityKind = "edge" | "face";

/** The entity kind each topology-cut kind addresses (the bridge's rule). */
export function topologyCutEntityKindOf(
  kind: TopologyCutKind,
): TopologyCutEntityKind {
  return kind === "shell" ? "face" : "edge";
}

/**
 * One cut's entity selection: the canonical persistent references (each
 * resolved against the target's current snapshot in the worker) or
 * snapshot ordinals the worker passes to the kernel verbatim (the
 * document reader emits this form only for the chain workbench's
 * single-ordinal fillet).
 */
export type TopologyCutSelection =
  | {
      readonly kind: "references";
      readonly references: readonly TopologyEntityReference[];
    }
  | { readonly kind: "ordinals"; readonly ordinals: readonly number[] };

/** The worker-scene payload one fillet/chamfer/shell executes as. */
export interface TopologyCutSceneRequest {
  /** The cut's feature kind (selects the kernel operation). */
  readonly kind: TopologyCutKind;
  /** The cut solid's source (the feature's feature/body target). */
  readonly target: SceneOperand;
  /** The target's body id — the snapshot label the references resolve on. */
  readonly targetBodyId: string;
  /** The radius, symmetric distance, or wall thickness (mm, > 0). */
  readonly sizeMm: number;
  /** The non-empty edge (fillet/chamfer) or face (shell) selection. */
  readonly selection: TopologyCutSelection;
  /** The feature's output body id (the rendered body). */
  readonly bodyId: string;
}

const TOPOLOGY_CUT_KINDS: ReadonlySet<string> = new Set([
  "fillet",
  "chamfer",
  "shell",
]);

function isTopologyCutKind(kind: string): kind is TopologyCutKind {
  return TOPOLOGY_CUT_KINDS.has(kind);
}

/** A strictly positive, finite length parameter in mm, else `null`. */
function positiveLengthMm(document: CadDocument, id: string): number | null {
  const mm = magnitudeIn(parameterValueOf(document, id), "length", "mm");
  return mm !== null && mm > 0 ? mm : null;
}

/**
 * Reads one fillet feature's inputs in declared role order: one feature or
 * body input (the target) and two parameter inputs — the radius (a length,
 * strictly positive and finite) and the picked edge's snapshot ordinal
 * (dimensionless whole number, >= 0). `null` when the layout is malformed
 * or any parameter no longer resolves. The ONE reader of this legacy layout
 * (what the chain workbench authored before Phase N3's references):
 * {@link topologyCutInputOf} reads the ordinal form through it.
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
  const radiusMm = magnitudeIn(
    parameterValueOf(document, radiusRef.id),
    "length",
    "mm",
  );
  const edgeRaw = magnitudeIn(
    parameterValueOf(document, edgeRef.id),
    "dimensionless",
    "1",
  );
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
 * The bridge's document-side reference battery for ONE reference input
 * (shared by every topology-addressed reader — the cuts here, the face
 * ops in `./face-op`, the face pattern in `./pattern`): the record is
 * present, its payload parses as a persistent topology reference of
 * `entityKind`, addresses the target's own body, and its provenance is
 * intact. `null` on any failure — the current-regeneration resolution is
 * the worker's.
 */
export function topologyReferenceOf(
  document: CadDocument,
  referenceId: ReferenceId,
  entityKind: TopologyCutEntityKind,
  targetBodyId: string,
): TopologyEntityReference | null {
  const record = getDocumentReference(document, referenceId);
  if (record === undefined) return null;
  const parsed = parseTopologyReference(record.reference);
  if (!parsed.ok) return null;
  const reference = parsed.value;
  if (reference.kind !== entityKind) return null;
  if (reference.bodyId !== targetBodyId) return null;
  if (!provenanceIntact(document, reference.provenance)) return null;
  return reference;
}

/**
 * The size and selection of ONE topology-cut feature's inputs in either
 * form (see the module doc), or `null` when the layout breaks, the size
 * leaves its domain, or the selection is empty. The references are
 * validated against the document here; their current-regeneration
 * resolution is the worker's.
 */
export function topologyCutInputOf(
  document: CadDocument,
  feature: FeatureRecord,
  kind: TopologyCutKind,
  targetBodyId: string,
): {
  readonly sizeMm: number;
  readonly selection: TopologyCutSelection;
} | null {
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  const referenceRefs = feature.inputs.filter(
    (ref) => ref.kind === "reference",
  );
  if (feature.inputs.some((ref) => ref.kind === "sketch")) return null;
  if (referenceRefs.length > 0) {
    const sizeRef = parameterRefs[0];
    if (parameterRefs.length !== 1 || sizeRef === undefined) return null;
    const sizeMm = positiveLengthMm(document, sizeRef.id);
    if (sizeMm === null) return null;
    const references: TopologyEntityReference[] = [];
    for (const ref of referenceRefs) {
      const reference = topologyReferenceOf(
        document,
        ref.id,
        topologyCutEntityKindOf(kind),
        targetBodyId,
      );
      if (reference === null) return null;
      references.push(reference);
    }
    return { sizeMm, selection: { kind: "references", references } };
  }
  // The chain workbench's legacy single-ordinal fillet — the only ordinal
  // layout anything authored.
  if (kind !== "fillet") return null;
  const chainInput = chainFilletInputOf(document, feature);
  if (chainInput === null) return null;
  return {
    sizeMm: chainInput.radiusMm,
    selection: { kind: "ordinals", ordinals: [chainInput.edgeOrdinal] },
  };
}

/**
 * The body id of a feature's single feature/body target, or `null` when
 * the feature declares other than exactly one target or the target
 * feature produced no body.
 */
export function topologyCutTargetBodyIdOf(
  document: CadDocument,
  feature: FeatureRecord,
): string | null {
  const targetRefs = feature.inputs.filter(
    (ref) => ref.kind === "feature" || ref.kind === "body",
  );
  const targetRef = targetRefs[0];
  if (targetRefs.length !== 1 || targetRef === undefined) return null;
  if (targetRef.kind === "body") return targetRef.id;
  return (
    document.features.find((entry) => entry.id === targetRef.id)?.outputs[0] ??
    null
  );
}

/**
 * Reads ONE fillet/chamfer/shell feature into its worker-scene request.
 * `null` when the feature is not a topology cut, declares other than
 * exactly one output, its target serves no operand, or its inputs leave
 * the layout or the domain — the refused feature renders nothing.
 */
export function topologyCutSceneRequestOfFeature(
  document: CadDocument,
  feature: FeatureRecord,
): TopologyCutSceneRequest | null {
  const kind = feature.kind;
  if (!isTopologyCutKind(kind)) return null;
  const bodyId = feature.outputs[0];
  if (bodyId === undefined || feature.outputs.length !== 1) return null;
  const targetBodyId = topologyCutTargetBodyIdOf(document, feature);
  if (targetBodyId === null || targetBodyId === bodyId) return null;
  const input = topologyCutInputOf(document, feature, kind, targetBodyId);
  if (input === null) return null;
  const target = sceneOperandOfBody(document, targetBodyId);
  if (target === null) return null;
  return {
    kind,
    target,
    targetBodyId,
    sizeMm: input.sizeMm,
    selection: input.selection,
    bodyId,
  };
}

/**
 * Reads EVERY fillet/chamfer/shell feature of the document into its
 * worker-scene request, in document order. A feature whose target,
 * layout, or domain no longer resolves is skipped honestly — the other
 * cuts still render.
 */
export function documentTopologyCutSceneRequests(
  document: CadDocument,
): readonly TopologyCutSceneRequest[] {
  const requests: TopologyCutSceneRequest[] = [];
  for (const feature of document.features) {
    const request = topologyCutSceneRequestOfFeature(document, feature);
    if (request !== null) requests.push(request);
  }
  return requests;
}
