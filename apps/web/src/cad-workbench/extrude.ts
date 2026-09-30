/**
 * The workbench's extrude wiring (Phase 26.1): the one module that bridges
 * the sketch domain, the document model, and the kernel contract for the
 * sketch → extrude → solid workflow.
 *
 * ## The profile resolver (the bridge's caller-supplied seam)
 *
 * {@link sketchProfileResolverOf} resolves a document's sketch records into
 * kernel-vocabulary profiles: the record's serialized payload is parsed by
 * the sketch domain (`parseSketch`), the entities are resolved by
 * `resolveExtrudeProfile` (closed-chain resolution with the sketch-domain
 * structured failures — construction geometry excluded), and the sketch's
 * workplane becomes the kernel placement via `workplaneToPlacement`. This
 * is the function a `createKernelFeatureExecutor` context carries; kernel
 * execution stays out of the document model and the sketch domain's
 * structured failure codes ride through verbatim.
 *
 * ## The worker-scene request
 *
 * {@link documentExtrudeRequest} reads the document's FIRST extrude feature
 * (the sketch input, the signed distance parameter) into the payload the
 * workbench's worker computation executes (`solid.extrude` + measurements):
 * the loop and placement come from the document's sketch record through the
 * same resolution path, and the signed distance from the parameter — so a
 * `parameter.set` on the distance re-dispatches the REAL kernel execution.
 */

import { angle, getDocumentSketch, length, valueIn } from "@slopcad/cad-core";
import type {
  AnyDimensionalValue,
  BodyId,
  CadDocument,
  FeatureRecord,
  ParseFailure,
  SketchDocumentId,
} from "@slopcad/cad-core";
import type {
  KernelProfileResolution,
  KernelProfileResolver,
  KernelResolvedProfile,
} from "@slopcad/cad-kernel";
import {
  parseSketch,
  resolveExtrudeProfile,
  workplaneToPlacement,
  type ProfileSegment,
} from "@slopcad/cad-sketch";

import { sessionDatumPlacement } from "./datum";

/** One profile segment mapped into the kernel contract's tuple form. */
export function kernelSegment(
  segment: ProfileSegment,
): KernelResolvedProfile["loop"][number] {
  if (segment.kind === "line") {
    return {
      kind: "line",
      start: [segment.start.x, segment.start.y],
      end: [segment.end.x, segment.end.y],
    };
  }
  if (segment.kind === "arc") {
    return {
      kind: "arc",
      center: [segment.center.x, segment.center.y],
      radius: segment.radius,
      startAngle: angle(segment.startAngle, "rad"),
      endAngle: angle(segment.endAngle, "rad"),
    };
  }
  if (segment.kind === "circle") {
    return {
      kind: "circle",
      center: [segment.center.x, segment.center.y],
      radius: segment.radius,
    };
  }
  if (segment.kind === "ellipse") {
    return {
      kind: "ellipse",
      center: [segment.center.x, segment.center.y],
      radiusX: segment.radiusX,
      radiusY: segment.radiusY,
      rotation: angle(segment.rotation, "rad"),
    };
  }
  if (segment.kind === "ellipticalArc") {
    return {
      kind: "ellipticalArc",
      center: [segment.center.x, segment.center.y],
      radiusX: segment.radiusX,
      radiusY: segment.radiusY,
      rotation: angle(segment.rotation, "rad"),
      startAngle: angle(segment.startAngle, "rad"),
      endAngle: angle(segment.endAngle, "rad"),
    };
  }
  return {
    kind: "spline",
    flavor: segment.flavor,
    points: segment.points.map((point) => [point.x, point.y] as const),
  };
}

/**
 * The document's sketch-profile resolver: the caller-supplied seam the
 * kernel feature executor needs for `extrude` features.
 */
export function sketchProfileResolverOf(
  document: CadDocument,
): KernelProfileResolver {
  return (sketchId: SketchDocumentId): KernelProfileResolution => {
    const record = getDocumentSketch(document, sketchId);
    if (record === undefined) {
      const failure: ParseFailure = {
        code: "document/not-found",
        message: `No sketch record "${sketchId}" exists in the document.`,
        input: sketchId,
      };
      return { ok: false, error: failure };
    }
    const sketch = parseSketch(record.sketch);
    if (!sketch.ok) {
      const failure: ParseFailure = {
        code: sketch.error.code,
        message: sketch.error.message,
        input: sketch.error.input,
      };
      return { ok: false, error: failure };
    }
    const profile = resolveExtrudeProfile(sketch.value.entities);
    if (!profile.ok) {
      const failure: ParseFailure = {
        code: profile.error.code,
        message: profile.error.message,
        input: profile.error.data,
      };
      return { ok: false, error: failure };
    }
    const placement = workplaneToPlacement(sketch.value.workplane);
    return {
      ok: true,
      value: {
        loop: profile.value.segments.map(kernelSegment),
        placement: {
          rotation: {
            axis: placement.rotation.axis,
            angle: angle(placement.rotation.angleRad, "rad"),
          },
          translation: {
            x: length(placement.translation.x),
            y: length(placement.translation.y),
            z: length(placement.translation.z),
          },
        },
      },
    };
  };
}

/** The worker-scene payload one extrude feature executes as. */
export interface ExtrudeSceneRequest {
  /** The closed profile loop (kernel contract form). */
  readonly loop: KernelResolvedProfile["loop"];
  /** The placement (rotation axis/angle + translation). */
  readonly placement: KernelResolvedProfile["placement"];
  /** The SIGNED distance in mm (sign = direction). */
  readonly distanceMm: number;
  /**
   * The optional draft taper (Phase 41) in canonical radians — present
   * exactly when the feature declares its third, angle-typed parameter
   * with a non-zero value, and carried to `solid.extrude` verbatim.
   */
  readonly taperRad?: number;
  /** The extrude feature's output body id (the rendered body). */
  readonly bodyId: string;
}

function signedLengthMm(value: AnyDimensionalValue): number | null {
  return value.dimension === "length" ? valueIn(value, "mm") : null;
}

/**
 * How a consuming composition (boolean, hole, move) obtains one operand's
 * solid: the plain-extrude DERIVATION — the operand's own sketch extrusion,
 * re-executed inside the consuming scene exactly as it always has (the
 * default for plain-extrude operands, so every established flow rides the
 * identical worker operations) — or a COMPUTED reference: the operand's own
 * scene is itself a composition (pad, hole, boolean, moved body), so the
 * document pass evaluates that scene first and hands its solid over keyed
 * by the body id. Real-CAD semantics: a consumer composes from the
 * operand's CURRENT geometry, never a re-derivation that would erase the
 * features applied to it.
 */
export type SceneOperand =
  | { readonly kind: "extrude"; readonly request: ExtrudeSceneRequest }
  | { readonly kind: "computed"; readonly bodyId: string };

/**
 * Resolves one body's operand source from its producing feature (the
 * first-producer rule): a plain extrusion derives through the per-feature
 * reader; a pad, hole, boolean, or moved body rides its computed solid; a
 * body without an operand-capable producer — data-only display chains,
 * seeded records, sheets — declines. `null` declines the consuming scene,
 * the honest prior-render fallback.
 */
export function sceneOperandOfBody(
  document: CadDocument,
  bodyId: string,
): SceneOperand | null {
  const producer = document.features.find((feature) =>
    feature.outputs.includes(bodyId as BodyId),
  );
  if (producer === undefined) return null;
  if (producer.kind === "extrude") {
    // The pad composition's output body is an extrude feature's output
    // whose SCENE is the base+pad union — a raw derivation of the pad
    // extrusion alone would drop the base, so it rides the computed solid.
    if (documentPadSceneRequest(document)?.bodyId === bodyId) {
      return { kind: "computed", bodyId };
    }
    const derivation = extrudeSceneRequestOfFeature(document, producer);
    return derivation === null
      ? null
      : { kind: "extrude", request: derivation };
  }
  if (
    producer.kind === "hole" ||
    producer.kind === "union" ||
    producer.kind === "subtract" ||
    producer.kind === "intersect"
  ) {
    return { kind: "computed", bodyId };
  }
  // The move-body feature is the translate kind carrying the authored
  // parameter pair (the move reader's own gate).
  if (
    producer.kind === "translate" &&
    producer.inputs.filter((ref) => ref.kind === "parameter").length >= 4
  ) {
    return { kind: "computed", bodyId };
  }
  return null;
}

/**
 * Reads ONE extrude feature into its worker-scene request, resolving the
 * profile through the same path the executor bridge uses. When the feature
 * declares a DATUM input (the sketch-on-face association, Phase 39), the
 * placement is overridden with the datum's RE-RESOLVED frame — the edit-
 * driving-face re-derivation: moving the driving face moves the datum, and
 * the extrusion follows. `null` when the feature's inputs no longer resolve
 * — callers render the prior scene rather than fabricate geometry. The
 * per-feature extraction the document readers share (`documentExtrudeRequest`
 * here, the hole scene's base resolution in `./hole`).
 */
export function extrudeSceneRequestOfFeature(
  document: CadDocument,
  feature: FeatureRecord,
): ExtrudeSceneRequest | null {
  const sketchRef = feature.inputs.find((ref) => ref.kind === "sketch");
  const distanceRef = feature.inputs.find((ref) => ref.kind === "parameter");
  const datumRef = feature.inputs.find((ref) => ref.kind === "datum");
  const bodyId = feature.outputs[0];
  if (
    sketchRef === undefined ||
    sketchRef.kind !== "sketch" ||
    distanceRef === undefined ||
    distanceRef.kind !== "parameter" ||
    bodyId === undefined
  ) {
    return null;
  }
  const parameter = document.parameters.parameters.find(
    (candidate) => candidate.id === distanceRef.id,
  );
  if (parameter === undefined) return null;
  const distanceMm = signedLengthMm(parameter.value);
  if (distanceMm === null || distanceMm === 0) return null;
  // The Phase 41 draft taper: an optional THIRD input, an angle-typed
  // parameter after the distance. Zero or absent = the plain prism.
  let taperRad: number | undefined;
  const taperRef = feature.inputs.find(
    (ref) =>
      ref.kind === "parameter" &&
      ref.id !== (distanceRef as { readonly id: string }).id,
  );
  if (taperRef !== undefined && taperRef.kind === "parameter") {
    const taperParameter = document.parameters.parameters.find(
      (candidate) => candidate.id === taperRef.id,
    );
    if (
      taperParameter !== undefined &&
      taperParameter.value.dimension === "angle"
    ) {
      const radians = valueIn(taperParameter.value, "rad");
      if (Number.isFinite(radians) && radians !== 0) taperRad = radians;
    }
  }
  const resolved = sketchProfileResolverOf(document)(sketchRef.id);
  if (!resolved.ok) return null;
  // The datum override: the sketch's baked workplane is the authoring-time
  // snapshot; a datum-anchored extrude re-derives its placement from the
  // datum record every dispatch (a structured resolution failure makes the
  // whole request null — the honest scene fallback).
  let placement = resolved.value.placement;
  if (datumRef !== undefined && datumRef.kind === "datum") {
    const datumPlacement = sessionDatumPlacement(document, datumRef.id);
    if (!datumPlacement.ok) return null;
    placement = {
      rotation: {
        axis: datumPlacement.placement.rotation.axis,
        angle: angle(datumPlacement.placement.rotation.angleRad, "rad"),
      },
      translation: {
        x: length(datumPlacement.placement.translation.x),
        y: length(datumPlacement.placement.translation.y),
        z: length(datumPlacement.placement.translation.z),
      },
    };
  }
  return {
    loop: resolved.value.loop,
    placement,
    distanceMm,
    ...(taperRad === undefined ? {} : { taperRad }),
    bodyId,
  };
}

/**
 * Reads the document's LAST extrude feature into its worker-scene request,
 * resolving the profile through the same path the executor bridge uses.
 * `null` when the document carries no extrude feature or the feature's
 * inputs no longer resolve — callers render the prior scene rather than
 * fabricate geometry. (The last, not the first: the sketch-on-face flow
 * stacks a pad extrude ON the base one, and the scene follows the newest
 * solid the author created — the hole scene's base-selection precedent.)
 */
export function documentExtrudeRequest(
  document: CadDocument,
): ExtrudeSceneRequest | null {
  let feature: FeatureRecord | undefined;
  for (const entry of document.features) {
    if (entry.kind === "extrude") feature = entry;
  }
  if (feature === undefined) return null;
  return extrudeSceneRequestOfFeature(document, feature);
}

/**
 * The pad composition scene request (Phase 39): the base extrusion and the
 * datum-anchored pad extrusion unioned into ONE output body — the body id
 * the composition renders under (the pad feature's output).
 */
export interface PadSceneRequest {
  /** The base extrusion (the driving body). */
  readonly base: ExtrudeSceneRequest;
  /** The pad extrusion, placed on the datum's re-resolved frame. */
  readonly pad: ExtrudeSceneRequest;
  /** The pad feature's output body id (the rendered body). */
  readonly bodyId: string;
}

/**
 * The pad composition scene reader (Phase 39): the document's FIRST
 * extrude feature is the base, the LAST is the pad (datum-anchored — its
 * placement re-resolves through `sessionDatumPlacement` on every dispatch).
 * `null` when the document does not carry the composition — fewer than two
 * extrudes, or the pad is not datum-anchored (a plain second extrude still
 * rides the plain extrude scene) — or any input no longer resolves.
 */
export function documentPadSceneRequest(
  document: CadDocument,
): PadSceneRequest | null {
  const extrudes = document.features.filter(
    (entry) => entry.kind === "extrude",
  );
  const base = extrudes[0];
  const pad = extrudes[extrudes.length - 1];
  if (
    base === undefined ||
    pad === undefined ||
    base.id === pad.id ||
    !pad.inputs.some((ref) => ref.kind === "datum")
  ) {
    return null;
  }
  const baseRequest = extrudeSceneRequestOfFeature(document, base);
  const padRequest = extrudeSceneRequestOfFeature(document, pad);
  const bodyId = pad.outputs[0];
  if (baseRequest === null || padRequest === null || bodyId === undefined) {
    return null;
  }
  return { base: baseRequest, pad: padRequest, bodyId };
}
