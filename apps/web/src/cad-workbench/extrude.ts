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

import {
  angle,
  getDocumentDatum,
  getDocumentSketch,
  length,
  parseDatumPayload,
  valueIn,
} from "@slopcad/cad-core";
import type {
  AnyDimensionalValue,
  BodyId,
  CadDocument,
  DatumId,
  FeatureRecord,
  ParseFailure,
  ParseResult,
  RenderProjection,
  SketchDocumentId,
} from "@slopcad/cad-core";
import type {
  KernelProfileResolution,
  KernelProfileResolver,
  KernelResolvedProfile,
} from "@slopcad/cad-kernel";
import {
  applySolvedParameters,
  boundDimensionParameterId,
  createReferenceSketchSolver,
  parseSketch,
  resolveExtrudeProfile,
  resolveSketchDimensionBindings,
  workplaneToPlacement,
  type ProfileSegment,
  type Sketch,
  type SketchParameterLookup,
} from "@slopcad/cad-sketch";

import {
  computedFaceOrdinalOfObject,
  computedFacePlanesOfObject,
  sessionDatumPlacement,
  type ComputedFacePlane,
  type ComputedFaceSource,
} from "./datum";

/**
 * The scene-side sketch solver (Phase 26a): stateless, created once — the
 * committed sketches whose dimensions bind document parameters re-solve
 * against the CURRENT parameter values on every scene derivation.
 */
const SCENE_SKETCH_SOLVER = createReferenceSketchSolver();

/**
 * The document's parameter environment as the sketch domain's injected
 * lookup: parameter id → current value, `undefined` when absent. The one
 * adapter between the document model and `SketchParameterLookup`.
 */
export function documentParameterLookupOf(
  document: CadDocument,
): SketchParameterLookup {
  return (parameterId) => {
    const parameter = document.parameters.parameters.find(
      (candidate) => candidate.id === parameterId,
    );
    return parameter === undefined ? undefined : { value: parameter.value };
  };
}

/**
 * Re-solves a parsed sketch whose dimensions bind document parameters
 * against the document's CURRENT parameter values (the sketch stays
 * canonical data; the environment arrives here, at consume time). An
 * unbound sketch returns as-is — reference-identical, so every established
 * literal flow rides the identical path it always has. A bound sketch
 * resolves, re-solves through the reference solver, and applies the solved
 * parameters; a dangling binding or an unresolvable solve is a structured
 * failure the caller's honest fallback answers for.
 */
export function resolveDocumentSketch(
  document: CadDocument,
  sketch: Sketch,
): ParseResult<Sketch, ParseFailure> {
  const resolution = resolveSketchDimensionBindings(
    sketch.constraints,
    documentParameterLookupOf(document),
  );
  if (!resolution.ok) {
    return {
      ok: false,
      error: {
        code: resolution.error.code,
        message: resolution.error.message,
        input: sketch,
      },
    };
  }
  if (resolution.value === sketch.constraints) {
    return { ok: true, value: sketch };
  }
  const solved = SCENE_SKETCH_SOLVER.solve(sketch.entities, resolution.value);
  if (solved.status === "failed") {
    const diagnostic = solved.diagnostics[0];
    return {
      ok: false,
      error: {
        code: diagnostic?.code ?? "sketch/solver-not-converged",
        message:
          diagnostic?.message ??
          "The bound sketch's re-solve failed without a diagnostic.",
        input: sketch,
      },
    };
  }
  return {
    ok: true,
    value: applySolvedParameters(
      { ...sketch, constraints: resolution.value },
      solved.parameters,
    ),
  };
}

/**
 * The document sketch ids whose payloads bind ANY of the given parameters —
 * the invalidation edge between a changed parameter and the features that
 * consume a parameter-bound sketch. The feature graph sees only declared
 * inputs (a feature consumes the sketch, not the sketch's bindings), so a
 * host's staleness pass composes this over its changed-parameter set: the
 * returned sketch ids ride `markStale` as changed nodes and the existing
 * sketch→feature edges invalidate the right consumers. Unparseable payload
 * shapes contribute nothing (they refuse at solve with their own
 * diagnostics).
 */
export function sketchIdsBoundToParameters(
  document: CadDocument,
  parameterIds: ReadonlySet<string>,
): readonly SketchDocumentId[] {
  if (parameterIds.size === 0) return [];
  const bound: SketchDocumentId[] = [];
  for (const record of document.sketches) {
    const sketch = parseSketch(record.sketch);
    if (!sketch.ok) continue;
    const binds = sketch.value.constraints.some((constraint) => {
      const parameterId = boundDimensionParameterId(constraint);
      return parameterId !== null && parameterIds.has(parameterId);
    });
    if (binds) bound.push(record.id);
  }
  return bound;
}

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
    // Parameter-bound sketches re-solve against the CURRENT document
    // parameters (a parameter.set re-drives the profile with no new
    // wiring); unbound sketches resolve from their stored coordinates
    // exactly as before.
    const resolved = resolveDocumentSketch(document, sketch.value);
    if (!resolved.ok) {
      return { ok: false, error: resolved.error };
    }
    const profile = resolveExtrudeProfile(resolved.value.entities);
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
 * the extrusion follows. The optional computed-face source extends that
 * re-derivation to datums anchored on COMPUTED bodies (a boolean cavity
 * floor, a holed face — see `./datum`); without it such a datum refuses
 * and the request is null, the honest scene fallback. `null` when the
 * feature's inputs no longer resolve — callers render the prior scene
 * rather than fabricate geometry. The per-feature extraction the document
 * readers share (`documentExtrudeRequest` here, the hole scene's base
 * resolution in `./hole`).
 */
export function extrudeSceneRequestOfFeature(
  document: CadDocument,
  feature: FeatureRecord,
  computedFaces?: ComputedFaceSource,
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
    const datumPlacement = sessionDatumPlacement(
      document,
      datumRef.id,
      computedFaces,
    );
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
  computedFaces?: ComputedFaceSource,
): ExtrudeSceneRequest | null {
  let feature: FeatureRecord | undefined;
  for (const entry of document.features) {
    if (entry.kind === "extrude") feature = entry;
  }
  if (feature === undefined) return null;
  return extrudeSceneRequestOfFeature(document, feature, computedFaces);
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
 * rides the plain extrude scene), or the pad's datum anchors on a COMPUTED
 * body (the extrude then renders as its own body on the datum plane, the
 * computed body beside it) — or any input no longer resolves.
 */
export function documentPadSceneRequest(
  document: CadDocument,
  computedFaces?: ComputedFaceSource,
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
  // The computed-anchor decline: a pad whose datum anchors on a COMPUTED
  // body (a standoff sketched on a boolean cavity floor) is not the
  // two-extrude composition — unioning it over the FIRST extrude would
  // rebuild the un-composed base and erase every feature applied to it.
  // The extrude renders as its OWN body on the datum's re-resolved plane
  // (the plain per-feature scene, the computed source riding along), the
  // computed body beside it — the document scene's aggregate is the
  // honest shell + post.
  for (const ref of pad.inputs) {
    if (ref.kind === "datum" && datumAnchorsComputedBody(document, ref.id)) {
      return null;
    }
  }
  const baseRequest = extrudeSceneRequestOfFeature(
    document,
    base,
    computedFaces,
  );
  const padRequest = extrudeSceneRequestOfFeature(document, pad, computedFaces);
  const bodyId = pad.outputs[0];
  if (baseRequest === null || padRequest === null || bodyId === undefined) {
    return null;
  }
  return { base: baseRequest, pad: padRequest, bodyId };
}

/**
 * Whether the datum record's face reference anchors on a COMPUTED-classified
 * body (a boolean, hole, pad, or moved body). Unreadable records decline —
 * the caller's ordinary refusal path answers for them.
 *
 * The classification here is deliberately REDUCED (producer kind only —
 * the hole/boolean family and the translate-with-authored-pair move): the
 * full `sceneOperandOfBody` re-enters the pad reader, which consults this
 * very predicate for its computed-anchor decline — a cycle. A pad output
 * as the anchor body therefore classifies as its extrude producer here,
 * and a pad-on-pad-anchor composition proceeds exactly as it always has.
 */
function datumAnchorsComputedBody(
  document: CadDocument,
  datumId: DatumId,
): boolean {
  const record = getDocumentDatum(document, datumId);
  if (record === undefined) return false;
  const payload = parseDatumPayload(record.datum);
  if (
    !payload.ok ||
    payload.value.datumType !== "plane" ||
    payload.value.definition !== "faceOffset"
  ) {
    return false;
  }
  const reference = payload.value.reference as {
    readonly kind?: unknown;
    readonly bodyId?: unknown;
  };
  if (reference.kind !== "sessionFace") return false;
  if (typeof reference.bodyId !== "string") return false;
  const producer = document.features.find((feature) =>
    feature.outputs.includes(reference.bodyId as BodyId),
  );
  if (producer === undefined) return false;
  if (
    producer.kind === "hole" ||
    producer.kind === "union" ||
    producer.kind === "subtract" ||
    producer.kind === "intersect"
  ) {
    return true;
  }
  return (
    producer.kind === "translate" &&
    producer.inputs.filter((ref) => ref.kind === "parameter").length >= 4
  );
}

/**
 * The computed-face source the engine derives from the settled scene: the
 * applied projection's analytic face planes for every COMPUTED-classified
 * body (`sceneOperandOfBody` — a boolean, hole, pad, or moved body; a
 * plain extrusion is never listed, so its datum resolution cannot take
 * the computed path). The planes ride the SAME synthetic-face grouping the
 * picker addresses, so the datum's recorded ordinal addresses the faces
 * deterministically (the ordinal contract in `./datum`). `digest` is a
 * deterministic fingerprint of the planes — the engine's staleness key
 * for the follow-along re-dispatch (a document edit that moves a
 * computed face changes the digest on the next settle, and the scene
 * re-dispatches once so datum-anchored features follow). `null` when the
 * projection is absent or carries no computed body.
 *
 * Determinism: the planes and the digest are pure functions of
 * (document, projection) — no Date, no random.
 */
export interface SessionComputedFaces extends ComputedFaceSource {
  /** The deterministic staleness fingerprint of the planes. */
  readonly digest: string;
}

export function sessionComputedFacesOf(
  document: CadDocument,
  projection: RenderProjection | null,
): SessionComputedFaces | null {
  if (projection === null) return null;
  const entries: {
    readonly bodyId: string;
    readonly planes: readonly ComputedFacePlane[];
  }[] = [];
  const seen = new Set<string>();
  for (const object of projection.objects) {
    if (object.bodyId === undefined || seen.has(object.bodyId)) continue;
    if (sceneOperandOfBody(document, object.bodyId)?.kind !== "computed") {
      continue;
    }
    seen.add(object.bodyId);
    entries.push({
      bodyId: object.bodyId,
      planes: computedFacePlanesOfObject(object),
    });
  }
  if (entries.length === 0) return null;
  return {
    planesOf: (bodyId) =>
      entries.find((entry) => entry.bodyId === bodyId)?.planes,
    digest: entries
      .map(
        (entry) =>
          `${entry.bodyId}|${entry.planes
            .map(
              (plane) => `${plane.origin.join(",")};${plane.normal.join(",")}`,
            )
            .join("|")}`,
      )
      .join("||"),
  };
}

/**
 * The picked face's same-normal ordinal at pick time (the computed path's
 * reference key — the contract in `./datum`): `null` unless the picked
 * body is COMPUTED-classified (a plain extrusion's reference stays
 * ordinal-free, its caps path untouched) or the reference no longer
 * matches the projection.
 */
export function computedFacePickOrdinal(
  document: CadDocument,
  projection: RenderProjection,
  reference: {
    readonly kind: "face";
    readonly bodyId: string;
    readonly faceIndex: number;
  },
): number | null {
  if (sceneOperandOfBody(document, reference.bodyId)?.kind !== "computed") {
    return null;
  }
  const object = projection.objects.find(
    (candidate) => candidate.bodyId === reference.bodyId,
  );
  if (object === undefined) return null;
  return computedFaceOrdinalOfObject(object, reference.faceIndex);
}

/**
 * Whether any extrude feature anchors its datum on a COMPUTED-classified
 * body (a sketch-on-face datum on a boolean cavity floor, a holed face, a
 * pad face, a moved body) — the engine's gate for the follow-along
 * re-dispatch: only documents carrying such a datum need the scene-settle
 * digest in their dispatch triggers, so every established flow's dispatch
 * rhythm stays exactly as it is.
 */
export function hasComputedAnchoredExtrude(document: CadDocument): boolean {
  for (const feature of document.features) {
    if (feature.kind !== "extrude") continue;
    for (const ref of feature.inputs) {
      if (ref.kind !== "datum") continue;
      if (datumAnchorsComputedBody(document, ref.id)) return true;
    }
  }
  return false;
}
