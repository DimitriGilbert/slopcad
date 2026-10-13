/**
 * The workbench's primitive wiring: the document readers for the four
 * bridge primitives — `box`, `sphere`, `cylinder`, `cone` — read into the
 * worker-scene requests the document pass executes through the kernel's
 * own `solid.createBox` / `createSphere` / `createCylinder` /
 * `createCone` operations.
 *
 * ## The canonical layout (the bridge's, not a new one)
 *
 * The readers consume exactly the input layout `@slopcad/cad-kernel`'s
 * core bridge interprets: exactly one output body and ONLY positional
 * length parameters —
 *
 * - `box` — width, depth, height;
 * - `sphere` — radius;
 * - `cylinder` — radius, height;
 * - `cone` — bottomRadius, topRadius, height.
 *
 * ## The domain (enforced BEFORE any scene exists)
 *
 * The kernel contract's own domain gates the request (the `./pattern`
 * precedent): box extents, sphere/cylinder radius, and cylinder/cone
 * height strictly positive; the cone's bottom radius strictly positive
 * and its top radius non-negative (0 is a sharp cone). An out-of-domain
 * feature is a refused feature — it emits no scene entry, so the document
 * scene never presents a successful verdict over geometry regeneration
 * rejects.
 *
 * Every primitive feature renders (an every-feature producer, the
 * extrude/revolve per-feature loop's precedent): primitives consume
 * nothing, so each one is its own lineage root.
 */

import type { CadDocument, FeatureRecord } from "@slopcad/cad-core";

import { magnitudeIn, parameterValueOf } from "./parameter-magnitude";

/** One primitive's resolved dimensions (canonical mm), tagged by kind. */
export type PrimitiveShape =
  | {
      readonly kind: "box";
      readonly widthMm: number;
      readonly depthMm: number;
      readonly heightMm: number;
    }
  | { readonly kind: "sphere"; readonly radiusMm: number }
  | {
      readonly kind: "cylinder";
      readonly radiusMm: number;
      readonly heightMm: number;
    }
  | {
      readonly kind: "cone";
      readonly bottomRadiusMm: number;
      readonly topRadiusMm: number;
      readonly heightMm: number;
    };

/** The worker-scene payload one primitive feature executes as. */
export interface PrimitiveSceneRequest {
  /** The primitive's kind and its in-domain dimensions. */
  readonly shape: PrimitiveShape;
  /** The primitive feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/**
 * The bridge's positional parameter count per primitive kind — its keys
 * are the primitive feature kinds the document scene renders.
 */
const PRIMITIVE_PARAMETER_COUNT: Readonly<Record<string, number>> = {
  box: 3,
  sphere: 1,
  cylinder: 2,
  cone: 3,
};

/**
 * Reads the feature's positional length parameters in canonical mm — the
 * bridge's `readLengths` layout: EVERY input a parameter, exactly `count`
 * of them, each length-typed and finite. `null` on any mismatch.
 */
function primitiveLengthsMm(
  document: CadDocument,
  feature: FeatureRecord,
  count: number,
): readonly number[] | null {
  if (feature.inputs.length !== count) return null;
  const values: number[] = [];
  for (const ref of feature.inputs) {
    if (ref.kind !== "parameter") return null;
    const mm = magnitudeIn(parameterValueOf(document, ref.id), "length", "mm");
    if (mm === null) return null;
    values.push(mm);
  }
  return values;
}

/** Resolves the in-domain shape of one primitive, or `null` (refused). */
function primitiveShapeOf(
  kind: string,
  lengths: readonly number[],
): PrimitiveShape | null {
  const [first, second, third] = lengths;
  if (kind === "box") {
    if (first === undefined || second === undefined || third === undefined) {
      return null;
    }
    if (!(first > 0) || !(second > 0) || !(third > 0)) return null;
    return { kind: "box", widthMm: first, depthMm: second, heightMm: third };
  }
  if (kind === "sphere") {
    if (first === undefined || !(first > 0)) return null;
    return { kind: "sphere", radiusMm: first };
  }
  if (kind === "cylinder") {
    if (first === undefined || second === undefined) return null;
    if (!(first > 0) || !(second > 0)) return null;
    return { kind: "cylinder", radiusMm: first, heightMm: second };
  }
  if (kind === "cone") {
    if (first === undefined || second === undefined || third === undefined) {
      return null;
    }
    if (!(first > 0) || !(second >= 0) || !(third > 0)) return null;
    return {
      kind: "cone",
      bottomRadiusMm: first,
      topRadiusMm: second,
      heightMm: third,
    };
  }
  return null;
}

/**
 * Reads ONE primitive feature into its worker-scene request. `null` when
 * the feature is not a primitive, declares other than exactly one output,
 * breaks the bridge's parameter layout, or carries an out-of-domain
 * dimension — the refused feature renders nothing. The per-feature
 * extraction the document readers share
 * (`documentPrimitiveSceneRequests` here, the document-scene builder's
 * per-body loop in `./document-scene`).
 */
export function primitiveSceneRequestOfFeature(
  document: CadDocument,
  feature: FeatureRecord,
): PrimitiveSceneRequest | null {
  const count = PRIMITIVE_PARAMETER_COUNT[feature.kind];
  const bodyId = feature.outputs[0];
  if (count === undefined || bodyId === undefined) return null;
  if (feature.outputs.length !== 1) return null;
  const lengths = primitiveLengthsMm(document, feature, count);
  if (lengths === null) return null;
  const shape = primitiveShapeOf(feature.kind, lengths);
  return shape === null ? null : { shape, bodyId };
}

/**
 * Reads EVERY primitive feature of the document into its worker-scene
 * request, in document order. A feature whose layout or domain no longer
 * resolves is skipped honestly — the other primitives still render.
 */
export function documentPrimitiveSceneRequests(
  document: CadDocument,
): readonly PrimitiveSceneRequest[] {
  const requests: PrimitiveSceneRequest[] = [];
  for (const feature of document.features) {
    if (!Object.hasOwn(PRIMITIVE_PARAMETER_COUNT, feature.kind)) continue;
    const request = primitiveSceneRequestOfFeature(document, feature);
    if (request !== null) requests.push(request);
  }
  return requests;
}
