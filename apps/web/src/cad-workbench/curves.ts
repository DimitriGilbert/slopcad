/**
 * Workbench curve authoring (Phase 47): the document-record layer the
 * workbench's curve forms drive — authoring validators, the four curve
 * payloads (interpolated spline, control spline, helix/spiral,
 * equation), the Formedible-ready field configuration, and the
 * deterministic scene contribution (the station polyline every renderer
 * re-derives from the same shared evaluation).
 *
 * The discipline of the helix/datum modules: pure functions, structured
 * problems (never throws), and one source of truth — the geometry comes
 * from `evaluateWire` (cad-kernel's shared pure math), so the workbench
 * scene and the kernel can never disagree.
 */

import {
  type CurvePoint3,
  type EquationCurvePayload,
  type HelixCurvePayload,
  type InterpolatedSplinePayload,
  type ControlSplinePayload,
  type SerializedCurve,
  angle,
  curveRecordProblems,
  length,
} from "@slopcad/cad-core";
import { evaluateWire } from "@slopcad/cad-kernel";

/** A world-space 3D point (mm) — the scene's flat segment coordinate. */
export type CurveScenePoint = readonly [number, number, number];

/** The curve kinds the authoring surface offers (display order). */
export const CURVE_KINDS = [
  "interpolated-spline",
  "control-spline",
  "helix",
  "equation",
] as const;

export type CurveKind = (typeof CURVE_KINDS)[number];

/** One authoring submission: the raw fields the form collects. */
export interface CurveAuthoring {
  readonly name: string;
  readonly kind: CurveKind;
  /** Spline points / helix controls: newline-separated `x, y, z` rows (mm). */
  readonly pointsText: string;
  /** Helix fields (mm / turns / handedness). */
  readonly helixRadius: string;
  readonly helixPitch: string;
  readonly helixTurns: string;
  readonly helixHandedness: "right" | "left";
  /** Equation fields: t range plus x/y/z expression sources. */
  readonly tMin: string;
  readonly tMax: string;
  readonly xExpression: string;
  readonly yExpression: string;
  readonly zExpression: string;
}

export const CURVE_DEFAULTS: CurveAuthoring = {
  name: "curve",
  kind: "interpolated-spline",
  pointsText: "0, 0, 0\n20, 0, 20\n40, 10, 40",
  helixRadius: "6",
  helixPitch: "4",
  helixTurns: "2.5",
  helixHandedness: "right",
  tMin: "0",
  tMax: "1",
  xExpression: "10mm * t",
  yExpression: "0mm",
  zExpression: "10mm * (1 - t)",
};

/** A structured authoring problem (the validate-then-build seam). */
export interface CurveAuthoringProblem {
  readonly field: string;
  readonly message: string;
}

function finiteField(
  field: string,
  raw: string,
  problems: CurveAuthoringProblem[],
): number | undefined {
  const value = Number(raw.trim());
  if (!Number.isFinite(value)) {
    problems.push({
      field,
      message: `"${raw}" is not a finite number.`,
    });
    return undefined;
  }
  return value;
}

/** Parses the `x, y, z` rows of the spline text field. */
export function parseCurvePoints(text: string): {
  readonly points: readonly CurvePoint3[];
  readonly problems: readonly CurveAuthoringProblem[];
} {
  const problems: CurveAuthoringProblem[] = [];
  const points: CurvePoint3[] = [];
  for (const [index, line] of text
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row.length > 0)
    .entries()) {
    const parts = line.split(",").map((part) => Number(part.trim()));
    if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
      problems.push({
        field: "pointsText",
        message: `Row ${String(index + 1)} ("${line}") must be three comma-separated finite numbers.`,
      });
      continue;
    }
    const x = parts[0];
    const y = parts[1];
    const z = parts[2];
    if (x === undefined || y === undefined || z === undefined) continue;
    points.push([x, y, z]);
  }
  return { points, problems };
}

/** Builds the payload a submission describes, or its structured problems. */
export function curvePayloadOf(authoring: CurveAuthoring): {
  readonly payload?: SerializedCurve;
  readonly problems: readonly CurveAuthoringProblem[];
} {
  const problems: CurveAuthoringProblem[] = [];
  if (authoring.name.trim().length === 0) {
    problems.push({ field: "name", message: "A curve needs a name." });
  }
  if (
    authoring.kind === "interpolated-spline" ||
    authoring.kind === "control-spline"
  ) {
    const { points, problems: pointProblems } = parseCurvePoints(
      authoring.pointsText,
    );
    problems.push(...pointProblems);
    if (points.length < 2) {
      problems.push({
        field: "pointsText",
        message: "A spline needs at least two points.",
      });
    }
    if (problems.length > 0) return { problems };
    const payload: InterpolatedSplinePayload | ControlSplinePayload = {
      kind: authoring.kind,
      points,
    };
    for (const problem of curveRecordProblems(payload)) {
      problems.push({ field: "pointsText", message: problem.message });
    }
    return problems.length > 0 ? { problems } : { payload, problems };
  }
  if (authoring.kind === "helix") {
    const radius = finiteField("helixRadius", authoring.helixRadius, problems);
    const pitch = finiteField("helixPitch", authoring.helixPitch, problems);
    const turns = finiteField("helixTurns", authoring.helixTurns, problems);
    if (problems.length > 0) return { problems };
    if (radius === undefined || pitch === undefined || turns === undefined) {
      return { problems };
    }
    const payload: HelixCurvePayload = {
      kind: "helix",
      radius: { dimension: "length", unit: "mm", value: radius },
      pitch: { dimension: "length", unit: "mm", value: pitch },
      turns,
      handedness: authoring.helixHandedness === "right" ? 1 : -1,
      startAngle: { dimension: "angle", unit: "rad", value: 0 },
    };
    for (const problem of curveRecordProblems(payload)) {
      problems.push({ field: "helixRadius", message: problem.message });
    }
    return problems.length > 0 ? { problems } : { payload, problems };
  }
  const tMin = finiteField("tMin", authoring.tMin, problems);
  const tMax = finiteField("tMax", authoring.tMax, problems);
  if (problems.length > 0) return { problems };
  if (tMin === undefined || tMax === undefined) return { problems };
  const payload: EquationCurvePayload = {
    kind: "equation",
    tMin,
    tMax,
    x: authoring.xExpression,
    y: authoring.yExpression,
    z: authoring.zExpression,
  };
  for (const problem of curveRecordProblems(payload)) {
    problems.push({ field: "xExpression", message: problem.message });
  }
  return problems.length > 0 ? { problems } : { payload, problems };
}

/** One scene line segment (the deterministic station soup, world mm). */
export interface CurveSceneSegment {
  readonly start: CurveScenePoint;
  readonly end: CurveScenePoint;
}

/**
 * The scene contribution of a curve record: its deterministic polyline as
 * line segments (the SAME shared evaluation the kernel's `wire` op
 * answers — one geometry, no second source of truth).
 */
export function curveSceneSegments(
  curve: SerializedCurve,
): readonly CurveSceneSegment[] {
  const evaluated = evaluateWire(curve);
  if (!evaluated.ok) return [];
  const segments: CurveSceneSegment[] = [];
  const polyline = evaluated.wire.polyline;
  for (let index = 1; index < polyline.length; index += 1) {
    const start = polyline[index - 1];
    const end = polyline[index];
    if (start === undefined || end === undefined) continue;
    segments.push({ start, end });
  }
  return segments;
}

/** The Formedible-ready field configuration of the curve authoring form. */
export const CURVE_FORM_FIELDS = [
  { name: "name", label: "Name", kind: "string" },
  { name: "kind", label: "Curve kind", kind: "select", options: CURVE_KINDS },
  { name: "pointsText", label: "Points (x, y, z per line)", kind: "multiline" },
  { name: "helixRadius", label: "Helix radius (mm)", kind: "string" },
  { name: "helixPitch", label: "Helix pitch (mm)", kind: "string" },
  { name: "helixTurns", label: "Helix turns", kind: "string" },
  {
    name: "helixHandedness",
    label: "Handedness",
    kind: "select",
    options: ["right", "left"],
  },
  { name: "tMin", label: "t min", kind: "string" },
  { name: "tMax", label: "t max", kind: "string" },
  { name: "xExpression", label: "x(t)", kind: "string" },
  { name: "yExpression", label: "y(t)", kind: "string" },
  { name: "zExpression", label: "z(t)", kind: "string" },
] as const;

// Units-typed re-exports for the form's submit wiring (the helix module's
// discipline: authoring strings convert exactly once, at the seam).
export const curveLengthValue = length;
export const curveAngleValue = angle;
