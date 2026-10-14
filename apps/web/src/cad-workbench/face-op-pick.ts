/**
 * The moveFace / deleteFace / replaceFace verbs' authoring seam — the
 * topology-cut verbs' pick surface (`./topology-pick`) with ONE face
 * picked instead of a set, and NO new picking mechanism:
 *
 *  - the pick ADDRESS is a face ordinal of the target body's topology
 *    snapshot, taken from the VISIBLE document scene (the engine's
 *    on-demand `documentTopology` query);
 *  - the picked face mints ONE persistent topology reference on that
 *    snapshot and commits as a document reference record
 *    (`topologyReferenceCreateCommand`, shared with the cuts and the
 *    chain workbench);
 *  - the feature lands in the bridge's canonical layout (`./face-op`
 *    module doc): ONE feature/body target, the ONE face reference, then
 *    per kind — moveFace's axis (dimensionless 1/2/3) and signed distance
 *    (length), deleteFace's heal flag (dimensionless 1/0), or
 *    replaceFace's ONE datum plane.
 *
 * The reader's domain is enforced BEFORE any commit (a whole world axis,
 * a finite non-zero distance — the kernel contract refuses a zero move as
 * a no-op — and a datum plane the session resolves), so a committed face
 * op is one the document scene reads.
 */

import {
  createBodyId,
  createDatumId,
  createFeatureId,
  createReferenceId,
  dimensionless,
  length,
} from "@slopcad/cad-core";
import type {
  CadDocument,
  FeatureInputRef,
  TopologySnapshot,
} from "@slopcad/cad-core";

import {
  authoringLabelOf,
  authoringParameterCommand,
  authoringRefusal,
  authoringSuffixOf,
  type AuthoringParameter,
  type AuthoringPlan,
} from "./authoring-id";
import { resolveSessionDatumPlane } from "./datum";
import {
  topologyPickReferenceIdOf,
  topologyPickReferenceNameOf,
  topologyPickTargetInputOf,
  topologyReferenceCreateCommand,
} from "./topology-pick";
import { worldAxisDirectionOf } from "./world-axis";

export type { FaceOpKind } from "./face-op";
export { FACE_OP_KINDS, isFaceOpKind } from "./face-op";

/** The values each face-op form starts with. */
export const FACE_OP_DEFAULTS = {
  /** World Z (the bridge's selector 3). */
  axis: 3,
  /** The signed travel (mm). */
  distanceMm: 1,
  /** Extend the neighbours to close the gap. */
  heal: true,
} as const;

/** The kind-specific half of one face-op submission. */
export type FaceOpSpecification =
  | {
      readonly kind: "moveFace";
      /** The world-axis selector (1 = X, 2 = Y, 3 = Z); the plan refuses any other. */
      readonly axis: number;
      readonly distanceMm: number;
    }
  | { readonly kind: "deleteFace"; readonly heal: boolean }
  | { readonly kind: "replaceFace"; readonly datumPlaneId: string };

/**
 * One face-op verb's authoring input: the target snapshot the pick
 * addresses (its `bodyId` is the target body), the picked face ordinal,
 * and the kind-specific specification.
 */
export interface FaceOpSubmission {
  readonly snapshot: TopologySnapshot;
  readonly ordinal: number;
  readonly specification: FaceOpSpecification;
}

/**
 * The parameters one specification mints for a suffix, in the bridge's
 * declared order: moveFace's axis then distance, deleteFace's heal flag,
 * none for replaceFace (its plane is a datum input).
 */
function faceOpParametersOf(
  specification: FaceOpSpecification,
  suffix: string,
): readonly AuthoringParameter[] {
  const kind = specification.kind;
  switch (specification.kind) {
    case "moveFace":
      return [
        authoringParameterCommand(
          kind,
          "axis",
          suffix,
          dimensionless(specification.axis),
        ),
        authoringParameterCommand(
          kind,
          "distance",
          suffix,
          length(specification.distanceMm),
        ),
      ];
    case "deleteFace":
      return [
        authoringParameterCommand(
          kind,
          "heal",
          suffix,
          dimensionless(specification.heal ? 1 : 0),
        ),
      ];
    case "replaceFace":
      return [];
  }
}

/**
 * The first free suffix for a face op: its feature, body, parameters (id
 * and name), and the one reference record.
 */
function faceOpSuffixOf(
  document: CadDocument,
  specification: FaceOpSpecification,
): string {
  const kind = specification.kind;
  return authoringSuffixOf(document, (suffix) => [
    `feat_${kind}${suffix}`,
    `body_${kind}${suffix}`,
    ...faceOpParametersOf(specification, suffix).flatMap((parameter) => [
      parameter.id,
      parameter.command.name,
    ]),
    topologyPickReferenceIdOf(kind, suffix, 0),
    topologyPickReferenceNameOf(kind, suffix, 0),
  ]);
}

/**
 * Plans the face-op verb's ONE atomic transaction: the kind's parameters
 * (named `<kind>Axis` / `<kind>Distance` / `<kind>Heal` so the parameter
 * panel re-drives them), the face reference record (minted on the picked
 * snapshot), the output body, and the feature in the canonical bridge
 * layout. Every reader domain check runs BEFORE the plan exists.
 */
export function faceOpCreateCommands(
  document: CadDocument,
  submission: FaceOpSubmission,
): AuthoringPlan {
  const { snapshot, ordinal, specification } = submission;
  const kind = specification.kind;
  if (specification.kind === "moveFace") {
    if (worldAxisDirectionOf(specification.axis) === undefined) {
      return authoringRefusal(
        "kernel/parameter-invalid",
        "The move axis must be the world X, Y, or Z axis.",
      );
    }
    if (
      !Number.isFinite(specification.distanceMm) ||
      specification.distanceMm === 0
    ) {
      return authoringRefusal(
        "kernel/parameter-invalid",
        "The move distance must be a finite, non-zero length (mm) — a zero move is a no-op.",
      );
    }
  }
  if (specification.kind === "replaceFace") {
    const plane = resolveSessionDatumPlane(
      document,
      specification.datumPlaneId,
    );
    if (!plane.ok) {
      return authoringRefusal(plane.error.code, plane.error.message);
    }
  }
  const suffix = faceOpSuffixOf(document, specification);
  const referenceId = createReferenceId(
    topologyPickReferenceIdOf(kind, suffix, 0),
  );
  const reference = topologyReferenceCreateCommand(document, snapshot, {
    ordinal,
    kind: "face",
    id: referenceId,
    name: topologyPickReferenceNameOf(kind, suffix, 0),
  });
  if (reference === null) {
    return authoringRefusal(
      "reference/mint-unavailable",
      `The picked face ${String(ordinal)} of body "${snapshot.bodyId}" cannot back a persistent reference (it vanished, or the kernel cannot name it); re-pick it from the current scene.`,
    );
  }
  const parameters = faceOpParametersOf(specification, suffix);
  const trailing: readonly FeatureInputRef[] =
    specification.kind === "replaceFace"
      ? [{ kind: "datum", id: createDatumId(specification.datumPlaneId) }]
      : parameters.map((parameter) => ({
          kind: "parameter" as const,
          id: parameter.id,
        }));
  const bodyId = createBodyId(`body_${kind}${suffix}`);
  return {
    ok: true,
    bodyId,
    commands: [
      ...parameters.map((parameter) => parameter.command),
      reference,
      { type: "body.create", id: bodyId, name: authoringLabelOf(kind, suffix) },
      {
        type: "feature.create",
        id: createFeatureId(`feat_${kind}${suffix}`),
        kind,
        inputs: [
          topologyPickTargetInputOf(document, snapshot.bodyId),
          { kind: "reference", id: referenceId },
          ...trailing,
        ],
        outputs: [bodyId],
      },
    ],
  };
}
