/**
 * The workbench's thread wiring (Phase 40): the document reader and
 * validation seam for the ISO thread feature — the thread sibling of
 * `./hole`. The feature targets the document's LAST EXTRUDE feature (the
 * hole precedent: the workbench's base solid), carries its specification
 * as plain parameters (major diameter, pitch, length, mode, handedness —
 * the ISO designation is the FORM's picker, never persisted state), and
 * the axis as a datum axis input or a world-axis selector parameter.
 *
 * The tool geometry itself is `planThreadCut`'s ONE source of truth (the
 * bridge and the worker scene compose the identical cut) — this module
 * only reads the document and refuses doomed submissions before anything
 * commits.
 */

import { valueIn, type AnyDimensionalValue } from "@slopcad/cad-core";
import type { FeatureRecord } from "@slopcad/cad-core";

import { resolveSessionDatumAxis } from "./datum";
import { documentExtrudeRequest, type ExtrudeSceneRequest } from "./extrude";

/** The thread feature's modes, as the dimensionless parameter carries them. */
export const THREAD_MODE_VALUES = {
  external: 1,
  internal: 2,
  cosmetic: 3,
} as const;

/** One thread's five numbers, in the feature's declared parameter order. */
export interface ThreadCutInput {
  readonly majorDiameterMm: number;
  readonly pitchMm: number;
  readonly lengthMm: number;
  readonly mode: number;
  readonly handedness: number;
  /** The world-axis selector (1 = X, 2 = Y, 3 = Z); unused with a datum. */
  readonly axis: number;
}

/** The form's defaults: an M6×1 external thread, 6 mm long, right-handed. */
export const THREAD_DEFAULTS: ThreadCutInput = {
  majorDiameterMm: 6,
  pitchMm: 1,
  lengthMm: 6,
  mode: THREAD_MODE_VALUES.external,
  handedness: 1,
  axis: 3,
};

/** The outcome of one thread validation attempt (the structured refusal). */
export type ThreadValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string; readonly message: string };

/**
 * Refuses the impossible thread submissions BEFORE any commit (the sweep
 * action's validation seam): the roadmap's named declines — zero pitch,
 * zero major diameter (zero radius), negative length — plus the mode and
 * handedness domains.
 */
export function validateThreadSubmission(
  input: ThreadCutInput,
): ThreadValidation {
  if (input.majorDiameterMm <= 0) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `The thread's major diameter must be strictly positive (got ${String(input.majorDiameterMm)} mm).`,
    };
  }
  if (input.pitchMm <= 0) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `The thread's pitch must be strictly positive (got ${String(input.pitchMm)} mm) — a zero pitch is not a thread.`,
    };
  }
  if (input.lengthMm <= 0) {
    return {
      ok: false,
      code: "kernel/parameter-invalid",
      message: `The thread's length must be strictly positive (got ${String(input.lengthMm)} mm).`,
    };
  }
  if (
    input.mode !== THREAD_MODE_VALUES.external &&
    input.mode !== THREAD_MODE_VALUES.internal &&
    input.mode !== THREAD_MODE_VALUES.cosmetic
  ) {
    return {
      ok: false,
      code: "kernel/feature-input-invalid",
      message: "The thread's mode must be external, internal, or cosmetic.",
    };
  }
  if (input.handedness !== 1 && input.handedness !== -1) {
    return {
      ok: false,
      code: "kernel/feature-input-invalid",
      message: "The thread's handedness must be right (+1) or left (-1).",
    };
  }
  if (input.axis !== 1 && input.axis !== 2 && input.axis !== 3) {
    return {
      ok: false,
      code: "kernel/feature-input-invalid",
      message: "The thread's axis selector must be X (1), Y (2), or Z (3).",
    };
  }
  return { ok: true };
}

/** Reads a parameter's canonical magnitude, or `null` off-dimension. */
function magnitudeIn(
  value: AnyDimensionalValue | undefined,
  dimension: "length" | "dimensionless",
  unit: "mm" | "1",
): number | null {
  if (value === undefined || value.dimension !== dimension) return null;
  const magnitude = valueIn(value, unit);
  return Number.isFinite(magnitude) ? magnitude : null;
}

/**
 * The document's LAST extrude feature — the solid the next thread cuts
 * (the hole precedent: the workbench's base solid).
 */
export function threadTargetFeatureOf(
  document: Parameters<typeof documentExtrudeRequest>[0],
): FeatureRecord | undefined {
  const bases = document.features.filter((entry) => entry.kind === "extrude");
  return bases[bases.length - 1];
}

/** The worker-scene payload the document's thread executes as. */
export interface ThreadSceneRequest {
  /** The base extrusion the thread cuts. */
  readonly base: ExtrudeSceneRequest;
  /** The thread's numbers (the feature's parameter roles, in order). */
  readonly thread: ThreadCutInput;
  /**
   * The resolved datum axis line, present exactly when the feature
   * declares a datum input (the helix reader's discipline): the scene
   * frames the cut on THIS line, never on the world-axis selector — and
   * an unresolvable datum declines the whole request (`null`) rather
   * than silently falling back to world Z.
   */
  readonly datumAxis?: {
    readonly origin: readonly [number, number, number];
    readonly direction: readonly [number, number, number];
  };
  /** The thread feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/**
 * Reads the document's FIRST thread feature into its worker-scene request,
 * pairing it with the base extrusion its target names (the last extrude —
 * the engine's create action guarantees the pairing). `null` when the
 * document carries no thread feature, the base no longer resolves, the
 * feature's parameters no longer read, or a declared datum axis no longer
 * resolves in-session (the helix reader's discipline — callers render the
 * prior scene rather than fabricate geometry; the world-Z fallback is
 * reserved for the selector form that actually declared it).
 */
export function documentThreadSceneRequest(
  document: Parameters<typeof documentExtrudeRequest>[0],
): ThreadSceneRequest | null {
  const feature = document.features.find((entry) => entry.kind === "thread");
  if (feature === undefined) return null;
  const bodyId = feature.outputs[0];
  const parameterRefs = feature.inputs.filter(
    (ref) => ref.kind === "parameter",
  );
  // Five fixed parameters; the SIXTH is the world-axis selector, present
  // exactly when no datum axis input was declared (the bridge's layout).
  const datumRef = feature.inputs.find((ref) => ref.kind === "datum");
  const expected = datumRef === undefined ? 6 : 5;
  if (bodyId === undefined || parameterRefs.length !== expected) return null;
  const values = parameterRefs.map((ref) => {
    const parameter = document.parameters.parameters.find(
      (entry) => entry.id === ref.id,
    );
    return parameter === undefined ? undefined : parameter.value;
  });
  const majorDiameter = magnitudeIn(values[0], "length", "mm");
  const pitch = magnitudeIn(values[1], "length", "mm");
  const threadLength = magnitudeIn(values[2], "length", "mm");
  const mode = magnitudeIn(values[3], "dimensionless", "1");
  const handedness = magnitudeIn(values[4], "dimensionless", "1");
  const axis = magnitudeIn(values[5], "dimensionless", "1") ?? 3;
  if (
    majorDiameter === null ||
    pitch === null ||
    threadLength === null ||
    mode === null ||
    handedness === null
  ) {
    return null;
  }
  // The datum-axis form resolves through the session's axis seam — the
  // helix reader's discipline: an unresolvable datum declines the scene
  // request (the caller renders the prior scene), NEVER a silent
  // world-Z cut on the wrong axis.
  let datumAxis: ThreadSceneRequest["datumAxis"];
  if (datumRef !== undefined) {
    const resolved = resolveSessionDatumAxis(document, datumRef.id);
    if (!resolved.ok) return null;
    datumAxis = {
      origin: [resolved.origin[0], resolved.origin[1], resolved.origin[2]],
      direction: [
        resolved.direction[0],
        resolved.direction[1],
        resolved.direction[2],
      ],
    };
  }
  const base = documentExtrudeRequest(document);
  if (base === null) return null;
  return {
    base,
    thread: {
      majorDiameterMm: majorDiameter,
      pitchMm: pitch,
      lengthMm: threadLength,
      mode,
      handedness,
      axis,
    },
    ...(datumAxis === undefined ? {} : { datumAxis }),
    bodyId,
  };
}
