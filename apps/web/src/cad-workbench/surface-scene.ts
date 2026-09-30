/**
 * The workbench's Phase 49 surface-scene wiring: the document reader and
 * rebuild plan that turn the document's LATEST surface-family feature
 * (`create-sheet`, `trim-surface`, `thicken-surface`, `knit-surface`,
 * `offset-surface`) into the worker-scene request the fixture session
 * executes. The plan is the scene-side mirror of the executor bridge's
 * own input discipline — the same input layouts, the same operand
 * resolution — expressed as a tree the worker evaluates call by call, so
 * a sheet operand of a sheet operand (trim a patch, thicken the trimmed
 * sheet) rebuilds exactly the geometry the features describe.
 */

import {
  angle,
  length,
  valueIn,
  type CadDocument,
  type FeatureRecord,
} from "@slopcad/cad-core";
import type { SheetSurfaceInput } from "@slopcad/cad-kernel";

import { sessionDatumPlacement } from "./datum";

/** The surface-family feature kinds the sheet scene rebuilds. */
const SURFACE_FEATURE_KINDS = [
  "create-sheet",
  "trim-surface",
  "thicken-surface",
  "knit-surface",
  "offset-surface",
] as const;

/** The maximum rebuild depth (a pathological feature chain stops here). */
const MAX_PLAN_DEPTH = 32;

/**
 * The worker-side rebuild plan of one sheet-family body: a tree of kernel
 * calls. `patch` is the `create-sheet` plane kind (the tab's authored
 * base); every other node consumes the plans of its declared body
 * operands.
 */
export type SheetBuildPlan =
  | { readonly kind: "patch"; readonly input: SheetSurfaceInput }
  | {
      readonly kind: "trim";
      readonly sheet: SheetBuildPlan;
      readonly tool: SheetBuildPlan;
      readonly keepInside: boolean;
    }
  | {
      readonly kind: "thicken";
      readonly sheet: SheetBuildPlan;
      readonly thicknessMm: number;
      readonly side: 1 | -1;
    }
  | {
      readonly kind: "knit";
      readonly bodies: readonly SheetBuildPlan[];
      readonly toleranceMm: number;
    }
  | {
      readonly kind: "offset";
      readonly sheet: SheetBuildPlan;
      readonly distanceMm: number;
    };

/** The worker-scene payload the sheet scene executes. */
export interface SheetSceneRequest {
  /** The feature's output body id (the rendered body). */
  readonly bodyId: string;
  /** The rebuild plan the worker evaluates. */
  readonly plan: SheetBuildPlan;
}

/** Reads one parameter's magnitude in its unit, or null when absent. */
function parameterMagnitude(
  document: CadDocument,
  id: string,
  dimension: "length" | "dimensionless",
  unit: "mm" | "1",
): number | null {
  const parameter = document.parameters.parameters.find(
    (entry) => entry.id === id,
  );
  const value = parameter?.value;
  if (value === undefined || value.dimension !== dimension) return null;
  const magnitude = valueIn(value, unit);
  return Number.isFinite(magnitude) ? magnitude : null;
}

/** Finds the feature that outputs the given body, or undefined. */
function producingFeature(
  document: CadDocument,
  bodyId: string,
): FeatureRecord | undefined {
  return document.features.find((feature) =>
    feature.outputs.some((output) => output === bodyId),
  );
}

/** Builds the rebuild plan of one body, or null when it is not rebuildable. */
function sheetPlanOf(
  document: CadDocument,
  bodyId: string,
  depth: number,
): SheetBuildPlan | null {
  if (depth > MAX_PLAN_DEPTH) return null;
  const feature = producingFeature(document, bodyId);
  if (feature === undefined) return null;
  if (feature.kind === "create-sheet")
    return patchPlanOf(document, feature, depth);
  if (feature.kind === "trim-surface")
    return trimPlanOf(document, feature, depth);
  if (feature.kind === "thicken-surface") {
    return thickenPlanOf(document, feature, depth);
  }
  if (feature.kind === "knit-surface")
    return knitPlanOf(document, feature, depth);
  if (feature.kind === "offset-surface") {
    return offsetPlanOf(document, feature, depth);
  }
  return null;
}

/** Resolves a body-input plan of a sheet-consuming feature. */
function operandPlan(
  document: CadDocument,
  feature: FeatureRecord,
  index: number,
  depth: number,
): SheetBuildPlan | null {
  const ref = feature.inputs[index];
  if (ref === undefined || ref.kind !== "body") return null;
  return sheetPlanOf(document, ref.id, depth + 1);
}

/** Resolves a length parameter input's magnitude. */
function lengthInput(
  document: CadDocument,
  feature: FeatureRecord,
  index: number,
): number | null {
  const ref = feature.inputs[index];
  if (ref === undefined || ref.kind !== "parameter") return null;
  return parameterMagnitude(document, ref.id, "length", "mm");
}

/** Resolves a dimensionless parameter input's magnitude. */
function dimensionlessInput(
  document: CadDocument,
  feature: FeatureRecord,
  index: number,
): number | null {
  const ref = feature.inputs[index];
  if (ref === undefined || ref.kind !== "parameter") return null;
  return parameterMagnitude(document, ref.id, "dimensionless", "1");
}

/**
 * Builds the plane-patch plan of a `create-sheet` feature: the datum
 * input's resolved placement plus the four u/v bound parameters — the
 * bridge's input layout verbatim. Deeper analytic kinds (the tab does not
 * author them yet) return null so the scene keeps its honest fallback.
 */
function patchPlanOf(
  document: CadDocument,
  feature: FeatureRecord,
  depth: number,
): SheetBuildPlan | null {
  const datumRef = feature.inputs[0];
  const kindValue = dimensionlessInput(document, feature, 1);
  if (datumRef === undefined || datumRef.kind !== "datum") return null;
  if (kindValue === null || Math.round(kindValue) !== 0) return null;
  const uMin = lengthInput(document, feature, 2);
  const uMax = lengthInput(document, feature, 3);
  const vMin = lengthInput(document, feature, 4);
  const vMax = lengthInput(document, feature, 5);
  if (uMin === null || uMax === null || vMin === null || vMax === null) {
    return null;
  }
  const placed = sessionDatumPlacement(document, datumRef.id);
  if (!placed.ok) return null;
  if (depth > MAX_PLAN_DEPTH) return null;
  // The datum frame → kernel placement conversion (the datum-anchored
  // extrude's own adaptation, verbatim): a WorkplanePlacement's radian
  // rotation becomes the contract's AngleValue rotation.
  const placement = {
    rotation: {
      axis: placed.placement.rotation.axis,
      angle: angle(placed.placement.rotation.angleRad, "rad"),
    },
    translation: {
      x: length(placed.placement.translation.x),
      y: length(placed.placement.translation.y),
      z: length(placed.placement.translation.z),
    },
  };
  return {
    kind: "patch",
    input: {
      kind: "plane",
      placement,
      uMin: { dimension: "length", unit: "mm", value: uMin },
      uMax: { dimension: "length", unit: "mm", value: uMax },
      vMin: { dimension: "length", unit: "mm", value: vMin },
      vMax: { dimension: "length", unit: "mm", value: vMax },
    },
  };
}

/** Builds the trim plan: target sheet, tool sheet, keep side. */
function trimPlanOf(
  document: CadDocument,
  feature: FeatureRecord,
  depth: number,
): SheetBuildPlan | null {
  const sheet = operandPlan(document, feature, 0, depth);
  const tool = operandPlan(document, feature, 1, depth);
  const keep = dimensionlessInput(document, feature, 2);
  if (sheet === null || tool === null || keep === null) return null;
  return {
    kind: "trim",
    sheet,
    tool,
    keepInside: keep === 1,
  };
}

/** Builds the thicken plan: sheet, wall thickness, side. */
function thickenPlanOf(
  document: CadDocument,
  feature: FeatureRecord,
  depth: number,
): SheetBuildPlan | null {
  const sheet = operandPlan(document, feature, 0, depth);
  const thickness = lengthInput(document, feature, 1);
  const side = dimensionlessInput(document, feature, 2);
  if (sheet === null || thickness === null || side === null) return null;
  if (side !== 1 && side !== -1) return null;
  return {
    kind: "thicken",
    sheet,
    thicknessMm: thickness,
    side,
  };
}

/** Builds the knit plan: two or more operand sheets, sewing tolerance. */
function knitPlanOf(
  document: CadDocument,
  feature: FeatureRecord,
  depth: number,
): SheetBuildPlan | null {
  const toleranceRef = feature.inputs.at(-1);
  if (toleranceRef === undefined || toleranceRef.kind !== "parameter") {
    return null;
  }
  const tolerance = parameterMagnitude(
    document,
    toleranceRef.id,
    "length",
    "mm",
  );
  if (tolerance === null || !(tolerance > 0)) return null;
  const bodies: SheetBuildPlan[] = [];
  for (let index = 0; index < feature.inputs.length - 1; index += 1) {
    const operand = operandPlan(document, feature, index, depth);
    if (operand === null) return null;
    bodies.push(operand);
  }
  if (bodies.length < 2) return null;
  return { kind: "knit", bodies, toleranceMm: tolerance };
}

/** Builds the offset plan: sheet, signed distance. */
function offsetPlanOf(
  document: CadDocument,
  feature: FeatureRecord,
  depth: number,
): SheetBuildPlan | null {
  const sheet = operandPlan(document, feature, 0, depth);
  const distance = lengthInput(document, feature, 1);
  if (sheet === null || distance === null || distance === 0) return null;
  return { kind: "offset", sheet, distanceMm: distance };
}

/**
 * Reads ONE sheet-family body's scene request: its rebuild plan (the same
 * recursive evaluation the document reader uses). `null` when the body has
 * no producing surface feature or the plan no longer rebuilds — callers
 * render the prior scene rather than fabricate geometry. The per-body
 * extraction the document readers share (`documentSheetSceneRequest` here,
 * the document-scene builder's per-body requests in `./document-scene`).
 */
export function sheetSceneRequestOfBody(
  document: CadDocument,
  bodyId: string,
): SheetSceneRequest | null {
  const plan = sheetPlanOf(document, bodyId, 0);
  if (plan === null) return null;
  return { bodyId, plan };
}

/**
 * Reads the document's sheet scene request: the output body of the
 * document's LAST surface-family feature, with its rebuild plan. Absent
 * surface features (or an unrebuildable chain) is null — the honest
 * fallback ladder answer.
 */
export function documentSheetSceneRequest(
  document: CadDocument,
): SheetSceneRequest | null {
  let latest: FeatureRecord | undefined;
  let latestIndex = -1;
  for (const [index, feature] of document.features.entries()) {
    if (
      (SURFACE_FEATURE_KINDS as readonly string[]).includes(feature.kind) &&
      index > latestIndex
    ) {
      latest = feature;
      latestIndex = index;
    }
  }
  const bodyId = latest?.outputs[0];
  if (latest === undefined || bodyId === undefined) return null;
  return sheetSceneRequestOfBody(document, bodyId);
}
