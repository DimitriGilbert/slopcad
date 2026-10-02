/**
 * The workbench's duplicate & transform wiring (Phase 60): the document
 * reader, validation seam, and authoring input for the `duplicate` feature
 * kind — one SOURCE body (which remains, unconsumed: the SolidWorks
 * move/copy semantics — the copies render BESIDE it), a per-step transform
 * `T = rotate ∘ translate` (translation first, then the rotation about a
 * world axis through the origin), and a copy count. Copy i is `T^i(source)`
 * — CUMULATIVE, the circular-pattern mental model — and the copies'_places
 * come from the bridge's own `planDuplicateInstances`, so the scene and
 * the executor compose identical arrangements (the array-pattern
 * planner's role).
 *
 * Iterative use is free: the copies are ordinary bodies in the dialog's
 * body pool (the 19a relaxation), so a duplicate of a duplicate is a
 * duplicate of a computed body — the operand machinery carries it.
 */

import { valueIn } from "@slopcad/cad-core";
import type { FeatureRecord } from "@slopcad/cad-core";
import {
  DUPLICATE_COUNT_LIMIT,
  planDuplicateInstances,
} from "@slopcad/cad-kernel";
import type { FeatureNumberValue } from "./parameter-reference";
import type { SceneOperand, documentExtrudeRequest } from "./extrude";

import { sceneOperandOfBody } from "./extrude";

/** The world axes the rotation rides (the bridge's selector domain). */
export const DUPLICATE_AXES = [1, 2, 3] as const;

/** The duplicate dialog's authoring submission (the $-able numbers raw). */
export interface DuplicateSubmission {
  /** The source body (which remains) — any computable body. */
  readonly sourceBodyId: string;
  /** The per-step translation, mm — literals or `$name` references. */
  readonly dxMm: FeatureNumberValue;
  readonly dyMm: FeatureNumberValue;
  readonly dzMm: FeatureNumberValue;
  /** The rotation's world axis (1 = X, 2 = Y, 3 = Z). */
  readonly axis: 1 | 2 | 3;
  /** The per-step rotation, degrees — a literal or a `$name` reference. */
  readonly angleDeg: FeatureNumberValue;
  /** The copy count — a literal or a `$name` reference. */
  readonly count: FeatureNumberValue;
}

/** The form's defaults: three copies stepping 15 mm along x, no rotation. */
export const DUPLICATE_DEFAULTS: {
  readonly dxMm: number;
  readonly dyMm: number;
  readonly dzMm: number;
  readonly axis: 1 | 2 | 3;
  readonly angleDeg: number;
  readonly count: number;
} = {
  dxMm: 15,
  dyMm: 0,
  dzMm: 0,
  axis: 3,
  angleDeg: 0,
  count: 3,
};

/** The outcome of one validation attempt (the structured refusal). */
export type DuplicateValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Refuses the impossible duplicate submissions BEFORE any commit — the
 * literal-only battery (the form's expressionNumber fields already refuse
 * malformed `$name` tokens). The RESOLVED-value battery (the identity
 * transform, the count domain over a referenced parameter's live value)
 * is the handler's business: a reference cannot be judged until it
 * resolves against the document.
 */
export function validateDuplicateSubmission(
  input: DuplicateSubmission,
): DuplicateValidation {
  for (const [label, value] of [
    ["dx", input.dxMm],
    ["dy", input.dyMm],
    ["dz", input.dzMm],
  ] as const) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return {
        ok: false,
        code: "kernel/parameter-invalid",
        message: `The duplicate's ${label} offset must be a finite number (mm).`,
      };
    }
  }
  if (typeof input.angleDeg === "number" && !Number.isFinite(input.angleDeg)) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: "The duplicate's rotation angle must be a finite number (deg).",
    };
  }
  if (
    typeof input.count === "number" &&
    (!Number.isInteger(input.count) ||
      input.count < 1 ||
      input.count > DUPLICATE_COUNT_LIMIT)
  ) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `The copy count must be a whole number between 1 and ${String(DUPLICATE_COUNT_LIMIT)} (got ${String(input.count)}).`,
    };
  }
  if (!DUPLICATE_AXES.includes(input.axis)) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: "The rotation axis must be a world axis (X, Y, or Z).",
    };
  }
  if (input.sourceBodyId.length === 0) {
    return {
      ok: false,
      code: "kernel/feature-input-invalid",
      message: "A duplicate needs a source body — pick the body to copy.",
    };
  }
  return { ok: true };
}

/**
 * The document's computable bodies, name verbatim — the duplicate
 * dialog's body pool (the 19a relaxation): any body whose producer
 * carries a computable scene (`sceneOperandOfBody`), the boolean pool's
 * exact rule. The source stays out of nothing: duplicating a body is
 * legal wherever its solid can be computed, including the copies of an
 * earlier duplicate (the verb's iterative use).
 */
export function duplicateSourceOptions(
  document: Parameters<typeof documentExtrudeRequest>[0],
): readonly { readonly id: string; readonly name: string }[] {
  return document.bodies.flatMap((body) =>
    sceneOperandOfBody(document, body.id) !== null
      ? [{ id: body.id, name: body.name }]
      : [],
  );
}

/**
 * The feature that OWNS a body: the first feature (document order) whose
 * outputs include the body — the model tree's own first-producer rule.
 */
export function duplicateProducingFeature(
  document: Parameters<typeof documentExtrudeRequest>[0],
  bodyId: string,
): FeatureRecord | undefined {
  return document.features.find((feature) =>
    feature.outputs.some((output) => output === bodyId),
  );
}

/** The worker-scene payload ONE copy of a duplicate feature executes as. */
export interface DuplicateSceneRequest {
  /**
   * The source body's operand source: a plain extrusion rides its own
   * derivation (the established composition), a composition's output — a
   * pad, hole, boolean, moved body, or an earlier duplicate's copy —
   * references the computed solid the document pass hands over.
   */
  readonly base: SceneOperand;
  /** The copy's ordinal, 1-based (copy 1 is T^1 of the source). */
  readonly ordinal: number;
  /** The copy's accumulated translation (mm) — the plan's T^i term. */
  readonly translationMm: readonly [number, number, number];
  /** The copy's rotation (the plan's i·θ about the world axis). */
  readonly rotation?: {
    readonly axis: readonly [number, number, number];
    readonly angleRad: number;
  };
  /** The copy's own output body id (the rendered body). */
  readonly bodyId: string;
}

/** The world-axis selector's direction (the bridge's mapping). */
const WORLD_AXIS_DIRECTION: Readonly<
  Record<number, readonly [number, number, number]>
> = Object.freeze({
  1: [1, 0, 0] as const,
  2: [0, 1, 0] as const,
  3: [0, 0, 1] as const,
});

/**
 * A duplicate feature's parameter magnitudes, read by declared order
 * (the bridge's input layout): dx, dy, dz (length), count (dimensionless),
 * axis (dimensionless integer), angle (angle). `null` when any fails to
 * read — the feature declines honestly, the other features still render.
 */
function duplicateParametersOf(
  feature: FeatureRecord,
  document: Parameters<typeof documentExtrudeRequest>[0],
): {
  readonly offsetMm: readonly [number, number, number];
  readonly count: number;
  readonly axis: readonly [number, number, number];
  readonly angleRad: number;
} | null {
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  if (parameterRefs.length !== 6) return null;
  const magnitudeOf = (
    index: number,
    dimension: "length" | "dimensionless" | "angle",
    unit: "mm" | "1" | "rad",
  ): number | null => {
    const ref = parameterRefs[index];
    if (ref === undefined || ref.kind !== "parameter") return null;
    const parameter = document.parameters.parameters.find(
      (entry) => entry.id === ref.id,
    );
    if (parameter === undefined || parameter.value.dimension !== dimension) {
      return null;
    }
    try {
      const magnitude = valueIn(parameter.value, unit);
      return Number.isFinite(magnitude) ? magnitude : null;
    } catch {
      return null;
    }
  };
  const dx = magnitudeOf(0, "length", "mm");
  const dy = magnitudeOf(1, "length", "mm");
  const dz = magnitudeOf(2, "length", "mm");
  const count = magnitudeOf(3, "dimensionless", "1");
  const axisValue = magnitudeOf(4, "dimensionless", "1");
  const angleRad = magnitudeOf(5, "angle", "rad");
  if (
    dx === null ||
    dy === null ||
    dz === null ||
    count === null ||
    axisValue === null ||
    angleRad === null
  ) {
    return null;
  }
  const axis = WORLD_AXIS_DIRECTION[axisValue];
  if (axis === undefined) return null;
  return {
    offsetMm: [dx, dy, dz],
    count,
    axis,
    angleRad,
  };
}

/**
 * Reads EVERY duplicate feature into its copies' worker-scene requests,
 * in document order — ALL of them render (the verb's iterative use means
 * a document may carry many), and each copy is its own body scene: the
 * source's operand resolved once per feature, the shared planner's
 * per-copy placement (the bridge's exact T^i plan). The SOURCE body is
 * NOT consumed: it renders through its own scene beside the copies. A
 * feature whose parameters, source, or outputs no longer resolve is
 * skipped honestly — the other duplicates still render.
 */
export function documentDuplicateSceneRequests(
  document: Parameters<typeof documentExtrudeRequest>[0],
): readonly DuplicateSceneRequest[] {
  const requests: DuplicateSceneRequest[] = [];
  for (const feature of document.features) {
    if (feature.kind !== "duplicate") continue;
    const sourceRef = feature.inputs.find(
      (ref) => ref.kind === "feature" || ref.kind === "body",
    );
    const parameters = duplicateParametersOf(feature, document);
    if (sourceRef === undefined || parameters === null) continue;
    const sourceBodyId =
      sourceRef.kind === "body"
        ? sourceRef.id
        : document.features.find((entry) => entry.id === sourceRef.id)
            ?.outputs[0];
    if (sourceBodyId === undefined) continue;
    const base = sceneOperandOfBody(document, sourceBodyId);
    if (base === null) continue;
    const plans = planDuplicateInstances({
      offsetMm: [...parameters.offsetMm],
      axis: parameters.axis,
      angleRad: parameters.angleRad,
      count: parameters.count,
    });
    for (const [index, plan] of plans.entries()) {
      const bodyId = feature.outputs[index];
      if (bodyId === undefined) continue;
      requests.push({
        base,
        ordinal: plan.ordinal,
        translationMm: plan.translationMm,
        ...(parameters.angleRad === 0
          ? {}
          : {
              rotation: {
                axis: plan.rotationAxis,
                angleRad: plan.rotationAngleRad,
              },
            }),
        bodyId,
      });
    }
  }
  return requests;
}
