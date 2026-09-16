/**
 * Picking (Phase 12): the pure bridge between a renderer raycast and the
 * CAD-domain selection model. A pointer event yields a render object and a
 * triangle index; {@link resolvePickReference} maps that hit through the
 * synthetic face grouping to a **domain** {@link SelectionReference} — a
 * stable body reference or a regeneration-tagged synthetic face reference.
 *
 * The rule this module exists to enforce: **raw triangle indices are never
 * public selection identity.** The triangle index is consumed here; the
 * payload every consumer receives is the domain reference (see
 * {@link CadPick}). A hit that cannot be resolved — a triangle index
 * outside its render object — fails structurally instead of emitting a
 * degraded reference.
 *
 * {@link renderCameraScreenPoint} is the pure spec→screen projection used by
 * the browser fixture's deterministic test hook: given the projection's
 * {@link RenderCamera} (the same data the scene camera is mapped from) and a
 * world point, it returns the CSS-pixel point of the viewport the point
 * projects to, so tests can aim a pointer at a known face anchor without
 * guessing pixels. The mapping mirrors the scene camera's construction
 * (spec-verbatim position/up/`lookAt`, vertical `fovDeg`, orthographic view
 * volume) and is pinned against three.js camera projection in the unit
 * tests.
 */

import {
  renderObjectIdBodyId,
  syntheticFaceOfTriangle,
  type BodyId,
  type FeatureId,
  type ParseFailure,
  type ParseResult,
  type RenderCamera,
  type RenderObject,
  type RenderVector3,
  type SelectionReference,
  type SyntheticFaceGrouping,
} from "@slopcad/cad-core";
import { fail, ok } from "@slopcad/cad-core";

/** The pick categories the renderer resolves (Phase 12 scope: body, face). */
export const CAD_PICK_CATEGORIES = ["body", "face"] as const;

export type CadPickCategory = (typeof CAD_PICK_CATEGORIES)[number];

/** Stable failure codes produced when a renderer hit cannot be resolved. */
export const PICK_ERROR_CODES = {
  /** The hit's triangle index is outside the render object. */
  triangleOutOfRange: "pick/triangle-out-of-range",
} as const;

export type PickErrorCode = (typeof PICK_ERROR_CODES)[keyof typeof PICK_ERROR_CODES];

/** Structured failure describing why a renderer hit was not resolvable. */
export interface PickError extends ParseFailure {
  readonly code: PickErrorCode;
}

function pickError(code: PickErrorCode, message: string, input: unknown): PickError {
  return { code, message, input };
}

/** A resolved pick: the domain reference plus the hit's provenance. */
export interface CadPick {
  /** THE payload: a stable or regeneration-tagged synthetic reference. */
  readonly reference: SelectionReference;
  /** The render object that was hit (stable id, see the projection contract). */
  readonly renderObjectId: string;
  /** The hit object's feature provenance, when the projection carried it. */
  readonly featureId?: FeatureId;
  /** World-space point of the hit, canonical millimetres. */
  readonly worldPoint: RenderVector3;
}

/** Inputs of {@link resolvePickReference}. */
export interface ResolvePickInput {
  readonly object: RenderObject;
  readonly grouping: SyntheticFaceGrouping;
  /** The raycast triangle index (three.js `intersection.faceIndex`). */
  readonly triangleIndex: number;
  /** The renderer's current regeneration identity (stamps synthetic refs). */
  readonly regeneration: number;
  readonly category: CadPickCategory;
}

/**
 * Resolves a renderer hit to its domain selection reference. The `face`
 * category maps the triangle through the synthetic face grouping and tags
 * the reference with `regeneration`; the `body` category addresses the
 * object's stable body id. The body id is total over the projection
 * contract: a render object id always derives from a body id
 * (`rend_<body payload>`), with an explicit `bodyId` provenance preferred
 * when the object carries one.
 */
export function resolvePickReference(
  input: ResolvePickInput,
): ParseResult<SelectionReference, PickError> {
  const bodyId: BodyId = input.object.bodyId ?? renderObjectIdBodyId(input.object.id);
  if (input.category === "body") {
    return ok({ kind: "body", bodyId });
  }
  let faceIndex: number;
  try {
    faceIndex = syntheticFaceOfTriangle(input.grouping, input.triangleIndex);
  } catch (error) {
    if (error instanceof RangeError) {
      return fail(
        pickError(
          PICK_ERROR_CODES.triangleOutOfRange,
          error.message,
          input.triangleIndex,
        ),
      );
    }
    throw error;
  }
  return ok({ kind: "face", bodyId, regeneration: input.regeneration, faceIndex });
}

// ---------------------------------------------------------------------------
// Spec → screen projection (the fixture's deterministic test hook)
// ---------------------------------------------------------------------------

function normalize(x: number, y: number, z: number): readonly [number, number, number] {
  const length = Math.hypot(x, y, z);
  if (length === 0) {
    throw new RangeError("Cannot normalize a zero-length direction.");
  }
  return [x / length, y / length, z / length];
}

/**
 * Projects a world point to viewport CSS pixels through a render camera
 * SPEC — the same data {@link RenderCamera} gives the scene camera, no
 * renderer required: origin at the viewport's top-left, x right, y down
 * (the convention DOM pointer coordinates and Playwright's element-relative
 * positions use). Deterministic float64 math; pinned against three.js
 * camera projection in `picking.test.ts`. Points behind the camera are not
 * meaningful on screen; callers project anchors of a framed model.
 */
export function renderCameraScreenPoint(
  spec: RenderCamera,
  point: RenderVector3,
  width: number,
  height: number,
): readonly [number, number] {
  // View basis identical to the scene camera's `lookAt` (spec up wins).
  const forward = normalize(
    spec.target[0] - spec.position[0],
    spec.target[1] - spec.position[1],
    spec.target[2] - spec.position[2],
  );
  const right = normalize(
    forward[1] * spec.up[2] - forward[2] * spec.up[1],
    forward[2] * spec.up[0] - forward[0] * spec.up[2],
    forward[0] * spec.up[1] - forward[1] * spec.up[0],
  );
  const up: readonly [number, number, number] = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ];
  const dx = point[0] - spec.position[0];
  const dy = point[1] - spec.position[1];
  const dz = point[2] - spec.position[2];
  const x = dx * right[0] + dy * right[1] + dz * right[2];
  const y = dx * up[0] + dy * up[1] + dz * up[2];
  const depth = dx * forward[0] + dy * forward[1] + dz * forward[2];
  let ndcX: number;
  let ndcY: number;
  if (spec.kind === "perspective") {
    const tanHalfFov = Math.tan((spec.fovDeg * Math.PI) / 360);
    const aspect = width / height;
    ndcX = x / (aspect * depth * tanHalfFov);
    ndcY = y / (depth * tanHalfFov);
  } else {
    ndcX = x / (spec.viewWidth / 2);
    ndcY = y / (spec.viewHeight / 2);
  }
  return [((ndcX + 1) / 2) * width, ((1 - ndcY) / 2) * height];
}
