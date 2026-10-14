/**
 * The workbench's local face-op wiring: the document readers for the
 * three direct-manipulation bridge kinds — `moveFace`, `deleteFace`, and
 * `replaceFace` — read into the worker-scene requests the document pass
 * executes through the kernel's own `solid.moveFace` / `solid.deleteFace`
 * / `solid.replaceFace` operations.
 *
 * ## The canonical layout (the bridge's `runLocalFaceOperation`)
 *
 * EXACTLY one feature/body input (the target solid) and EXACTLY one
 * reference input (a persistent FACE reference addressing the target's
 * own body), plus per kind:
 *
 * - `moveFace`: exactly two parameters in declared order — axis
 *   (DIMENSIONLESS, 1 = X, 2 = Y, 3 = Z) and distance (LENGTH, signed,
 *   finite); no datum.
 * - `deleteFace`: exactly one parameter — the heal flag (DIMENSIONLESS,
 *   1 heal, 0 raw); no datum.
 * - `replaceFace`: no parameters and exactly one datum PLANE input,
 *   resolved through the session's plane seam (`./datum` — the mirror
 *   reader's discipline: an unresolvable datum declines the feature).
 *
 * The reference runs the shared document-side battery
 * (`./topology-cut`'s `topologyReferenceOf`); its current-regeneration
 * resolution to a face ordinal runs in the worker
 * (`../worker-fixture/face-op-scene`).
 *
 * ## The domain (enforced BEFORE any scene exists)
 *
 * The bridge's parameter domains — a whole-number world axis in 1..3, a
 * finite distance, a heal flag of exactly 0 or 1 — are checked here (the
 * `./pattern` precedent): an out-of-domain feature emits no scene entry.
 *
 * ## The composition
 *
 * EVERY face-op feature renders (a plural reader), each consuming its
 * target's CURRENT solid through the shared operand seam
 * (`./extrude`'s `sceneOperandOfBody`) — a move over a fillet over a box
 * composes in document order.
 */

import type {
  CadDocument,
  FeatureRecord,
  TopologyEntityReference,
} from "@slopcad/cad-core";

import { resolveSessionDatumPlane } from "./datum";
import { sceneOperandOfBody, type SceneOperand } from "./extrude";
import { magnitudeIn, parameterValueOf } from "./parameter-magnitude";
import { topologyCutTargetBodyIdOf, topologyReferenceOf } from "./topology-cut";
import { worldAxisDirectionOf } from "./world-axis";

/** The local face-op feature kinds (the bridge's own trio), in display order. */
export const FACE_OP_KINDS = ["moveFace", "deleteFace", "replaceFace"] as const;

/** The local face-op feature kinds (the bridge's own trio). */
export type FaceOpKind = (typeof FACE_OP_KINDS)[number];

/** One face op's resolved operation (the kernel call's own inputs). */
export type FaceOpOperation =
  | {
      readonly kind: "moveFace";
      /** The world-axis unit direction the face moves along. */
      readonly direction: readonly [number, number, number];
      /** The signed travel along the direction (mm). */
      readonly distanceMm: number;
    }
  | {
      readonly kind: "deleteFace";
      /** Whether the neighbouring faces extend to close the gap. */
      readonly heal: boolean;
    }
  | {
      readonly kind: "replaceFace";
      /** The resolved datum plane the face re-closes at. */
      readonly plane: {
        readonly origin: readonly [number, number, number];
        readonly normal: readonly [number, number, number];
      };
    };

/** The worker-scene payload one moveFace/deleteFace/replaceFace executes as. */
export interface FaceOpSceneRequest {
  /** The operated solid's source (the feature's feature/body target). */
  readonly target: SceneOperand;
  /** The target's body id — the snapshot label the reference resolves on. */
  readonly targetBodyId: string;
  /** The persistent face reference (resolved in the worker). */
  readonly face: TopologyEntityReference;
  /** The kind-specific operation. */
  readonly operation: FaceOpOperation;
  /** The feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/** Whether `kind` names a local face-op kind. */
export function isFaceOpKind(kind: string): kind is FaceOpKind {
  return (FACE_OP_KINDS as readonly string[]).includes(kind);
}

/**
 * The kind-specific operation of ONE face op, or `null` when its
 * parameter/datum layout breaks or a value leaves the bridge's domain.
 */
function faceOpOperationOf(
  document: CadDocument,
  feature: FeatureRecord,
  kind: FaceOpKind,
): FaceOpOperation | null {
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  const datumRefs = feature.inputs.filter((ref) => ref.kind === "datum");
  const valueOf = (index: number) => {
    const ref = parameterRefs[index];
    return ref === undefined ? undefined : parameterValueOf(document, ref.id);
  };
  if (kind === "moveFace") {
    if (parameterRefs.length !== 2 || datumRefs.length !== 0) return null;
    const axis = magnitudeIn(valueOf(0), "dimensionless", "1");
    const direction = axis === null ? undefined : worldAxisDirectionOf(axis);
    const distanceMm = magnitudeIn(valueOf(1), "length", "mm");
    if (direction === undefined || distanceMm === null) return null;
    return { kind, direction, distanceMm };
  }
  if (kind === "deleteFace") {
    if (parameterRefs.length !== 1 || datumRefs.length !== 0) return null;
    const heal = magnitudeIn(valueOf(0), "dimensionless", "1");
    if (heal !== 0 && heal !== 1) return null;
    return { kind, heal: heal === 1 };
  }
  const datumRef = datumRefs[0];
  if (
    parameterRefs.length !== 0 ||
    datumRefs.length !== 1 ||
    datumRef === undefined
  ) {
    return null;
  }
  const resolved = resolveSessionDatumPlane(document, datumRef.id);
  if (!resolved.ok) return null;
  return {
    kind,
    plane: {
      origin: [resolved.origin[0], resolved.origin[1], resolved.origin[2]],
      normal: [resolved.normal[0], resolved.normal[1], resolved.normal[2]],
    },
  };
}

/**
 * Reads ONE moveFace/deleteFace/replaceFace feature into its worker-scene
 * request. `null` when the feature is not a face op, declares other than
 * exactly one output, one target, and one face reference, its target
 * serves no operand, or its inputs leave the layout or the domain — the
 * refused feature renders nothing.
 */
export function faceOpSceneRequestOfFeature(
  document: CadDocument,
  feature: FeatureRecord,
): FaceOpSceneRequest | null {
  const kind = feature.kind;
  if (!isFaceOpKind(kind)) return null;
  const bodyId = feature.outputs[0];
  if (bodyId === undefined || feature.outputs.length !== 1) return null;
  const targetBodyId = topologyCutTargetBodyIdOf(document, feature);
  if (targetBodyId === null || targetBodyId === bodyId) return null;
  const referenceRefs = feature.inputs.filter(
    (ref) => ref.kind === "reference",
  );
  const faceRef = referenceRefs[0];
  if (referenceRefs.length !== 1 || faceRef === undefined) return null;
  const face = topologyReferenceOf(document, faceRef.id, "face", targetBodyId);
  if (face === null) return null;
  const operation = faceOpOperationOf(document, feature, kind);
  if (operation === null) return null;
  const target = sceneOperandOfBody(document, targetBodyId);
  if (target === null) return null;
  return { target, targetBodyId, face, operation, bodyId };
}

/**
 * Reads EVERY moveFace/deleteFace/replaceFace feature of the document
 * into its worker-scene request, in document order. A feature whose
 * target, layout, or domain no longer resolves is skipped honestly — the
 * other face ops still render.
 */
export function documentFaceOpSceneRequests(
  document: CadDocument,
): readonly FaceOpSceneRequest[] {
  const requests: FaceOpSceneRequest[] = [];
  for (const feature of document.features) {
    const request = faceOpSceneRequestOfFeature(document, feature);
    if (request !== null) requests.push(request);
  }
  return requests;
}
