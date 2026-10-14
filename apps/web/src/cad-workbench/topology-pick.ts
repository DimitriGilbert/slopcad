/**
 * The fillet / chamfer / shell verbs' authoring seam — the chain
 * workbench's pick surface (`./CadChainWorkbenchPage`'s fillet action),
 * generalized to every topology cut and every computed body, with NO new
 * picking mechanism (the moveFace / deleteFace / replaceFace verbs,
 * `./face-op-pick`, pick their one face through the same seam):
 *
 *  - the pick ADDRESS is a `(kind, ordinal)` of the target body's
 *    topology snapshot, taken from the VISIBLE document scene (the
 *    engine's on-demand `documentTopology` query — the same kernel
 *    snapshot the chain scene returns for its fillet target);
 *  - each picked ordinal mints a persistent topology reference on that
 *    snapshot (`mintTopologyReference` — the OCCT kernel's history-based
 *    name, so the pick survives every rebuild and dimension edit) and
 *    commits as a document reference record
 *    ({@link topologyReferenceCreateCommand}, the chain action's own
 *    command, shared);
 *  - the feature lands in the bridge's canonical layout (`./topology-cut`
 *    module doc): ONE feature/body target, the reference inputs, and ONE
 *    length parameter (the radius, the symmetric chamfer distance, or the
 *    wall thickness).
 *
 * The pick GESTURE is the chain's too: every pickable entity's absolute
 * centroid projects through the scene camera into a CSS-pixel anchor
 * ({@link topologyTargetAnchorsOf}, the chain's `data-edge-anchors`
 * projection), and a viewport click selects the nearest anchor within
 * {@link TOPOLOGY_PICK_RADIUS_PX} ({@link nearestTopologyAnchor}, the
 * chain's `pickEdgeAt`) — the multi-pick verbs toggle it into the
 * selection, the single-face verbs replace it ({@link nextTopologyPicks}).
 *
 * The chamfer is symmetric: the kernel contract (`ChamferInput`) carries
 * one distance shared by every edge and no angle, so the verb authors
 * exactly that — no field the kernel would ignore.
 */

import {
  createBodyId,
  createFeatureId,
  createReferenceId,
  length,
  mintTopologyReference,
  referenceProvenance,
  serializeTopologyReference,
} from "@slopcad/cad-core";
import type {
  BodyId,
  CadCommand,
  CadDocument,
  FeatureInputRef,
  ReferenceId,
  RenderCamera,
  RenderVector3,
  TopologySnapshot,
} from "@slopcad/cad-core";
import { renderCameraScreenPoint } from "@slopcad/cad-r3f";
import type { FaceOpKind } from "./face-op";

import {
  authoringLabelOf,
  authoringParameterCommand,
  authoringParameterIdOf,
  authoringParameterNameOf,
  authoringRefusal,
  authoringSuffixOf,
  type AuthoringPlan,
} from "./authoring-id";
import {
  isTopologyCutKind,
  topologyCutEntityKindOf,
  type TopologyCutEntityKind,
  type TopologyCutKind,
} from "./topology-cut";

export type { TopologyCutKind } from "./topology-cut";
export { isTopologyCutKind, TOPOLOGY_CUT_KINDS } from "./topology-cut";

/** The size each verb's form starts with (mm). */
export const TOPOLOGY_CUT_DEFAULT_SIZE_MM: Readonly<
  Record<TopologyCutKind, number>
> = {
  fillet: 2,
  chamfer: 1,
  shell: 1,
};

/**
 * Builds the `reference.create` command for ONE picked snapshot ordinal:
 * mints the persistent reference on the snapshot it was picked from and
 * serializes it into a document reference record. `null` when the
 * snapshot carries no such entity or the entity cannot back a persistent
 * reference (no identity, no re-anchor measure).
 */
export function topologyReferenceCreateCommand(
  document: CadDocument,
  snapshot: TopologySnapshot,
  pick: {
    readonly ordinal: number;
    readonly kind: TopologyCutEntityKind;
    readonly id: ReferenceId;
    readonly name: string;
  },
): CadCommand | null {
  const provenance = referenceProvenance(document, snapshot.bodyId);
  if (!provenance.ok) return null;
  const minted = mintTopologyReference(
    snapshot,
    pick.ordinal,
    provenance.value,
    { id: pick.id, kind: pick.kind },
  );
  if (!minted.ok) return null;
  return {
    type: "reference.create",
    id: pick.id,
    name: pick.name,
    reference: { ...serializeTopologyReference(minted.value) },
  };
}

/**
 * Every verb that picks on a target's topology: the topology cuts and the
 * local face ops.
 */
export type TopologyPickVerb = TopologyCutKind | FaceOpKind;

/**
 * The entity kind a verb picks: edges for fillet/chamfer, faces for the
 * shell and every face op.
 */
function topologyPickEntityKindOf(
  verb: TopologyPickVerb,
): TopologyCutEntityKind {
  return isTopologyCutKind(verb) ? topologyCutEntityKindOf(verb) : "face";
}

/**
 * The entities of one target snapshot a verb may pick: the verb's entity
 * kind, carrying an identity payload (the only entities that can back a
 * persistent reference), in snapshot ordinal order.
 */
function pickableEntitiesOf(
  snapshot: TopologySnapshot,
  verb: TopologyPickVerb,
): TopologySnapshot["entities"] {
  const entityKind = topologyPickEntityKindOf(verb);
  return snapshot.entities.filter(
    (entity) => entity.kind === entityKind && entity.identity !== null,
  );
}

/** Maximum distance (CSS px) a click may land from an anchor to pick it. */
const TOPOLOGY_PICK_RADIUS_PX = 24;

/**
 * The frame the anchors project into: the scene camera and the CSS-pixel
 * size of the canvas the clicks land on.
 */
export interface TopologyAnchorFrame {
  readonly camera: RenderCamera;
  readonly width: number;
  readonly height: number;
}

/**
 * Projects one absolute centroid (mm) into its CSS-pixel anchor point —
 * one-decimal rounded (sub-pixel precision is noise), so the published
 * surface is byte-stable for identical state.
 */
export function topologyAnchorPointOf(
  centroidMm: RenderVector3,
  frame: TopologyAnchorFrame,
): readonly [number, number] {
  const screen = renderCameraScreenPoint(
    frame.camera,
    centroidMm,
    frame.width,
    frame.height,
  );
  return [Number(screen[0].toFixed(1)), Number(screen[1].toFixed(1))];
}

/** One pickable entity's projected anchor: its ordinal and CSS-pixel point. */
export interface TopologyPickAnchor {
  readonly ordinal: number;
  readonly point: readonly [number, number];
}

/**
 * The projected anchors of a target snapshot's pickable entities for a
 * verb (those with an absolute centroid), in snapshot ordinal order — a
 * pure function of the snapshot and the frame.
 */
function topologyPickAnchorsOf(
  snapshot: TopologySnapshot,
  verb: TopologyPickVerb,
  frame: TopologyAnchorFrame,
): readonly TopologyPickAnchor[] {
  return pickableEntitiesOf(snapshot, verb).flatMap((entity) => {
    const centroid = entity.geometry.centroidAbsoluteMm;
    return centroid === undefined
      ? []
      : [
          {
            ordinal: entity.ordinal,
            point: topologyAnchorPointOf(centroid, frame),
          },
        ];
  });
}

/** One pickable target's anchor: the body it lies on, its ordinal, its point. */
export interface TopologyTargetAnchor extends TopologyPickAnchor {
  readonly bodyId: string;
}

/**
 * The projected anchors of every offered target for a verb, in target
 * order — the ONE anchor set both the viewport markers draw and a click
 * selects from.
 */
export function topologyTargetAnchorsOf(
  targets: readonly {
    readonly bodyId: string;
    readonly snapshot: TopologySnapshot;
  }[],
  verb: TopologyPickVerb,
  frame: TopologyAnchorFrame,
): readonly TopologyTargetAnchor[] {
  return targets.flatMap((target) =>
    topologyPickAnchorsOf(target.snapshot, verb, frame).map((anchor) => ({
      bodyId: target.bodyId,
      ...anchor,
    })),
  );
}

/**
 * The anchor nearest to the CSS-pixel point `(x, y)` within
 * {@link TOPOLOGY_PICK_RADIUS_PX}; `null` when none is that near (the
 * first of equally near anchors wins).
 */
export function nearestTopologyAnchor<
  Anchor extends { readonly point: readonly [number, number] },
>(anchors: Iterable<Anchor>, x: number, y: number): Anchor | null {
  let best: { readonly anchor: Anchor; readonly distance: number } | null =
    null;
  for (const anchor of anchors) {
    const distance = Math.hypot(anchor.point[0] - x, anchor.point[1] - y);
    if (
      distance <= TOPOLOGY_PICK_RADIUS_PX &&
      (best === null || distance < best.distance)
    ) {
      best = { anchor, distance };
    }
  }
  return best === null ? null : best.anchor;
}

/** A verb's current viewport picks: ONE target body and its ordinals. */
export interface TopologyPicks {
  readonly bodyId: string;
  readonly ordinals: readonly number[];
}

/**
 * The picks after one viewport hit: the topology cuts toggle the hit
 * entity in or out of the selection on the same body (a hit on another
 * body starts that body's selection); the face ops pick exactly one face,
 * so the hit replaces the pick.
 */
export function nextTopologyPicks(
  current: TopologyPicks | null,
  hit: { readonly bodyId: string; readonly ordinal: number },
  verb: TopologyPickVerb,
): TopologyPicks {
  if (
    !isTopologyCutKind(verb) ||
    current === null ||
    current.bodyId !== hit.bodyId
  ) {
    return { bodyId: hit.bodyId, ordinals: [hit.ordinal] };
  }
  return {
    bodyId: hit.bodyId,
    ordinals: current.ordinals.includes(hit.ordinal)
      ? current.ordinals.filter((ordinal) => ordinal !== hit.ordinal)
      : [...current.ordinals, hit.ordinal],
  };
}

/** One pickable entity of a target snapshot: its ordinal and its label. */
export interface TopologyPickOption {
  readonly ordinal: number;
  readonly label: string;
}

/** A fixed-precision number for a pick label (trailing zeros trimmed). */
function measure(value: number): string {
  return String(Number(value.toFixed(3)));
}

/**
 * The pickable entities of one target snapshot for a verb — edges for
 * fillet/chamfer, faces for shell and the face ops — each labelled with
 * the kernel's own measures (edge length / face area, absolute centroid),
 * in snapshot ordinal order. Entities that cannot back a persistent
 * reference (no identity payload) are not offered.
 */
export function topologyPickOptionsOf(
  snapshot: TopologySnapshot,
  verb: TopologyPickVerb,
): readonly TopologyPickOption[] {
  const entityKind = topologyPickEntityKindOf(verb);
  return pickableEntitiesOf(snapshot, verb).map((entity) => {
    const { lengthMm, areaMm2, centroidAbsoluteMm } = entity.geometry;
    const size =
      entityKind === "edge"
        ? lengthMm === undefined
          ? ""
          : ` · ${measure(lengthMm)} mm`
        : areaMm2 === undefined
          ? ""
          : ` · ${measure(areaMm2)} mm²`;
    const at =
      centroidAbsoluteMm === undefined
        ? ""
        : ` at (${centroidAbsoluteMm.map(measure).join(", ")})`;
    return {
      ordinal: entity.ordinal,
      label: `${entityKind === "edge" ? "Edge" : "Face"} ${String(entity.ordinal)}${size}${at}`,
    };
  });
}

/**
 * One topology-cut verb's authoring input: the kind, the target snapshot
 * the picks address (its `bodyId` is the target body), the picked
 * ordinals, and the size (mm).
 */
export interface TopologyCutSubmission {
  readonly kind: TopologyCutKind;
  readonly snapshot: TopologySnapshot;
  readonly ordinals: readonly number[];
  readonly sizeMm: number;
}

/** What each verb's size is, in the refusal text. */
const SIZE_NOUN: Readonly<Record<TopologyCutKind, string>> = {
  fillet: "fillet radius",
  chamfer: "chamfer distance",
  shell: "wall thickness",
};

/**
 * The first free suffix for a topology cut: its feature, body, size
 * parameter (id and name), and one reference record per pick.
 */
function topologyCutSuffixOf(
  document: CadDocument,
  kind: TopologyCutKind,
  pickCount: number,
): string {
  return authoringSuffixOf(document, (suffix) => [
    `feat_${kind}${suffix}`,
    `body_${kind}${suffix}`,
    authoringParameterIdOf(kind, "size", suffix),
    authoringParameterNameOf(kind, "size", suffix),
    ...Array.from({ length: pickCount }, (_, index) => [
      topologyPickReferenceIdOf(kind, suffix, index),
      topologyPickReferenceNameOf(kind, suffix, index),
    ]).flat(),
  ]);
}

/** The reference-record id one pick mints (`ref_fillet_pick2_0`). */
export function topologyPickReferenceIdOf(
  verb: TopologyPickVerb,
  suffix: string,
  index: number,
): string {
  return `ref_${verb}_pick${suffix}_${String(index)}`;
}

/** The reference-record name one pick mints (`filletPick2_0`). */
export function topologyPickReferenceNameOf(
  verb: TopologyPickVerb,
  suffix: string,
  index: number,
): string {
  return `${verb}Pick${suffix}_${String(index)}`;
}

/**
 * The target input of a pick verb over `bodyId`: the producing feature (the
 * chain action's form) when `bodyId` is that feature's FIRST output — the
 * body a feature target resolves to (`topologyCutTargetBodyIdOf`) — else
 * the body itself (an imported body has no producing feature; a later
 * output of a multi-output producer, e.g. a duplicate's second copy, is
 * not what the feature target names).
 */
export function topologyPickTargetInputOf(
  document: CadDocument,
  bodyId: BodyId,
): FeatureInputRef {
  const producer = document.features.find((entry) =>
    entry.outputs.includes(bodyId),
  );
  return producer !== undefined && producer.outputs[0] === bodyId
    ? { kind: "feature", id: producer.id }
    : { kind: "body", id: bodyId };
}

/**
 * Plans the topology-cut verb's ONE atomic transaction: the size
 * parameter (named `<kind>Size` so the parameter panel re-drives it), one
 * reference record per picked ordinal (minted on the picked snapshot),
 * the output body, and the feature in the canonical bridge layout. The
 * reader's domain is enforced BEFORE any commit — a strictly positive,
 * finite size, a non-empty duplicate-free selection, every pick minting —
 * so a committed cut is one the document scene renders.
 */
export function topologyCutCreateCommands(
  document: CadDocument,
  submission: TopologyCutSubmission,
): AuthoringPlan {
  const { kind, snapshot, ordinals, sizeMm } = submission;
  const entityKind = topologyCutEntityKindOf(kind);
  if (!Number.isFinite(sizeMm) || !(sizeMm > 0)) {
    return authoringRefusal(
      "kernel/parameter-invalid",
      `The ${SIZE_NOUN[kind]} must be a finite, strictly positive length (mm).`,
    );
  }
  if (ordinals.length === 0 || new Set(ordinals).size !== ordinals.length) {
    return authoringRefusal(
      "kernel/invalid-operands",
      kind === "shell"
        ? "Pick at least one face to open — a shell removes the picked faces and hollows the rest."
        : `Pick at least one edge to ${kind}.`,
    );
  }
  const suffix = topologyCutSuffixOf(document, kind, ordinals.length);
  const references: CadCommand[] = [];
  for (const [index, ordinal] of ordinals.entries()) {
    const command = topologyReferenceCreateCommand(document, snapshot, {
      ordinal,
      kind: entityKind,
      id: createReferenceId(topologyPickReferenceIdOf(kind, suffix, index)),
      name: topologyPickReferenceNameOf(kind, suffix, index),
    });
    if (command === null) {
      return authoringRefusal(
        "reference/mint-unavailable",
        `The picked ${entityKind} ${String(ordinal)} of body "${snapshot.bodyId}" cannot back a persistent reference (it vanished, or the kernel cannot name it); re-pick it from the current scene.`,
      );
    }
    references.push(command);
  }
  const size = authoringParameterCommand(kind, "size", suffix, length(sizeMm));
  const bodyId = createBodyId(`body_${kind}${suffix}`);
  return {
    ok: true,
    bodyId,
    commands: [
      size.command,
      ...references,
      { type: "body.create", id: bodyId, name: authoringLabelOf(kind, suffix) },
      {
        type: "feature.create",
        id: createFeatureId(`feat_${kind}${suffix}`),
        kind,
        inputs: [
          topologyPickTargetInputOf(document, snapshot.bodyId),
          ...ordinals.map((_, index) => ({
            kind: "reference" as const,
            id: createReferenceId(
              topologyPickReferenceIdOf(kind, suffix, index),
            ),
          })),
          { kind: "parameter", id: size.id },
        ],
        outputs: [bodyId],
      },
    ],
  };
}
