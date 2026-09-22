/**
 * The workbench's move-body wiring (Phase 44): the document readers and
 * validation seams for the UI over the EXISTING `translate` feature kind
 * — the roadmap's "move body via translate/rotate features (UI for
 * existing tools)". The authored rotation rides the kind's Phase 44
 * growth (the optional axis + angle parameter pair), so one dialog moves
 * a body and, optionally, re-aims it about a world axis.
 */

import { valueIn } from "@slopcad/cad-core";
import type { FeatureRecord } from "@slopcad/cad-core";

import { documentExtrudeRequest, type ExtrudeSceneRequest } from "./extrude";

/** The world axes the rotation pair selects (the bridge's selector domain). */
export const MOVE_BODY_AXES = [1, 2, 3] as const;

/** The move-body dialog's authoring input. */
export interface MoveBodyInput {
  /** The translation offsets, mm. */
  readonly offsetMm: readonly [number, number, number];
  /** The optional rotation: a world-axis selector (1 = X, 2 = Y, 3 = Z) and degrees. */
  readonly rotation: {
    readonly axis: 1 | 2 | 3;
    readonly angleDeg: number;
  } | null;
}

/** The form's defaults: a 10 mm x-offset, no rotation. */
export const MOVE_BODY_DEFAULTS: MoveBodyInput = {
  offsetMm: [10, 0, 0],
  rotation: null,
};

/** The outcome of one validation attempt (the structured refusal). */
export type MoveBodyValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Refuses the impossible move submissions BEFORE any commit: non-finite
 * offsets, or a rotation whose angle is non-finite. A ZERO move is
 * legal input (the identity transform) and the honest no-op the kernel
 * returns — the dialog leaves judging usefulness to the author.
 */
export function validateMoveBodySubmission(
  input: MoveBodyInput,
): MoveBodyValidation {
  const [x, y, z] = input.offsetMm;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: "The move's offsets must be finite numbers (mm).",
    };
  }
  if (
    input.rotation !== null &&
    (!Number.isFinite(input.rotation.angleDeg) ||
      !MOVE_BODY_AXES.includes(input.rotation.axis))
  ) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message:
        "The move's rotation needs a world axis (X, Y, or Z) and a finite angle in degrees.",
    };
  }
  return { ok: true };
}

/**
 * The document's LAST extrude feature — the solid the move acts on (the
 * thread/rib/scale precedent: the workbench's base solid).
 */
export function moveBodyTargetFeatureOf(
  document: Parameters<typeof documentExtrudeRequest>[0],
): FeatureRecord | undefined {
  const bases = document.features.filter((entry) => entry.kind === "extrude");
  return bases[bases.length - 1];
}

/** The worker-scene payload one move-body feature executes as. */
export interface MoveBodySceneRequest {
  /** The base extrusion the feature moves. */
  readonly base: ExtrudeSceneRequest;
  /** The translation offsets (mm). */
  readonly offsetMm: readonly [number, number, number];
  /** The optional rotation (world-axis direction + canonical radians). */
  readonly rotation?:
    | {
        readonly axis: readonly [number, number, number];
        readonly angleRad: number;
      }
    | undefined;
  /** The feature's output body id (the rendered body). */
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
 * Reads the document's move-body feature (the first `translate` carrying
 * the move's authored parameters) into its worker-scene request, pairing
 * it with the base extrusion (the last extrude — the engine's create
 * action guarantees the pairing). `null` when the document carries none,
 * the base no longer resolves, or the parameters no longer read.
 */
export function documentMoveBodySceneRequest(
  document: Parameters<typeof documentExtrudeRequest>[0],
): MoveBodySceneRequest | null {
  const feature = document.features.find(
    (entry) =>
      entry.kind === "translate" &&
      entry.inputs.filter((ref) => ref.kind === "parameter").length >= 4,
  );
  if (feature === undefined) return null;
  const bodyId = feature.outputs[0];
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  if (bodyId === undefined || parameterRefs.length < 4) return null;
  const base = documentExtrudeRequest(document);
  if (base === null) return null;
  const magnitudeOf = (
    id: (typeof parameterRefs)[number]["id"],
    dimension: "length" | "dimensionless" | "angle",
    unit: "mm" | "1" | "rad",
  ): number | null => {
    const parameter = document.parameters.parameters.find(
      (entry) => entry.id === id,
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
  const xRef = parameterRefs[0];
  const yRef = parameterRefs[1];
  const zRef = parameterRefs[2];
  if (xRef === undefined || yRef === undefined || zRef === undefined) {
    return null;
  }
  const x = magnitudeOf(xRef.id, "length", "mm");
  const y = magnitudeOf(yRef.id, "length", "mm");
  const z = magnitudeOf(zRef.id, "length", "mm");
  if (x === null || y === null || z === null) return null;
  let rotation: MoveBodySceneRequest["rotation"];
  if (parameterRefs.length >= 6) {
    const axisRef = parameterRefs[3];
    const angleRef = parameterRefs[4];
    if (axisRef === undefined || angleRef === undefined) return null;
    const axisValue = magnitudeOf(axisRef.id, "dimensionless", "1");
    const angleRad = magnitudeOf(angleRef.id, "angle", "rad");
    if (axisValue === null || angleRad === null) return null;
    const axis = WORLD_AXIS_DIRECTION[axisValue];
    if (axis === undefined) return null;
    rotation = { axis, angleRad };
  }
  const scene: MoveBodySceneRequest = {
    base,
    offsetMm: [x, y, z],
    ...(rotation === undefined ? {} : { rotation }),
    bodyId,
  };
  return scene;
}
