/**
 * The workbench session's datum resolution (Phase 39): the SESSION-layer
 * seam the roadmap assigns to the workbench — datum records resolve to
 * sketch workplanes and feature placements here, on the browser side of
 * the worker boundary, with `packages/cad-sketch/src/workplane.ts`
 * untouched (the datum frame IS a workplane-shaped frame; the conversion
 * is the identity of shapes).
 *
 * ## What the session can honestly resolve
 *
 * The session sees document records and the settled scene — not the
 * kernel's persistent topology — so its face resolution is ANALYTIC and
 * deliberately narrow: a `sessionFace` reference names a body produced by
 * an extrude feature, and the resolver derives that extrusion's two cap
 * planes from the driving sketch's workplane and the signed distance
 * parameter. The cap is picked by matching the datum definition's recorded
 * normal (`normalAtDefinition`) against the cap normals; a definition
 * whose normal matches no cap (a side wall, a curved face) is a structured
 * `session/face-not-resolvable` failure — never a guessed plane.
 *
 * The payoff is the moved-face battery, live in the workbench: edit the
 * base extrusion's depth parameter and the datum re-resolves to the cap's
 * NEW plane — the sketch anchored on it (and every feature that consumes
 * that sketch through a datum input) follows the face. Delete the driving
 * feature and the datum fails structured, so the scene falls back honestly
 * instead of fabricating geometry.
 *
 * The executor bridge's own datum seam (the kernel-side half) is
 * caller-supplied the same way; OCCT hosts with a persistent TopologyView
 * resolve reference-dependent definitions through the Phase 22 protocol
 * instead of this analytic stand-in.
 */

import {
  getDocumentDatum,
  getDocumentSketch,
  parseDatumId,
  parseDatumPayload,
  resolveDatumPayload,
  type CadDocument,
  type DatumTopologyResolver,
  type DatumVec3,
  type FeatureRecord,
  type ParseFailure,
  type RenderProjection,
  groupSyntheticFaces,
  syntheticFaceAnchor,
  syntheticFaceMeanNormal,
} from "@slopcad/cad-core";
import {
  parseSketch,
  workplaneToPlacement,
  type Workplane,
} from "@slopcad/cad-sketch";

/** The reference payload the session mints for a face-anchored datum. */
export interface SessionFaceReference {
  /** The payload discriminator (the session's own reference vocabulary). */
  readonly kind: "sessionFace";
  /** The body whose face the datum anchors to. */
  readonly bodyId: string;
  /**
   * The picked face's normal at pick time — the cap-selection key. The
   * session resolver derives the referenced extrusion's two cap planes and
   * picks the one this normal aligns with, so the datum follows the RIGHT
   * face when the body moves.
   */
  readonly faceNormal: readonly [number, number, number];
}

/** Structured failures of the session datum resolver. */
export const SESSION_DATUM_ERROR_CODES = {
  /** The datum record is absent or its payload does not parse. */
  datumInvalid: "session/datum-invalid",
  /** The datum is not a plane. */
  datumNotAPlane: "session/datum-not-a-plane",
  /** The reference is not a session face reference. */
  referenceInvalid: "session/reference-invalid",
  /** The referenced body has no resolvable extrude feature. */
  faceNotResolvable: "session/face-not-resolvable",
} as const;

function sessionFailure(
  code: string,
  message: string,
  input: unknown,
): { readonly ok: false; readonly error: ParseFailure } {
  return { ok: false, error: { code, message, input } };
}

/** Normalizes a direction; null when degenerate. */
function unit(a: DatumVec3): DatumVec3 | null {
  const length = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]);
  if (length < 1e-12) return null;
  return [a[0] / length, a[1] / length, a[2] / length];
}

/** Cross product. */
function cross(a: DatumVec3, b: DatumVec3): DatumVec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Dot product. */
function dot(a: DatumVec3, b: DatumVec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Combines `a + s·b`. */
function combine(a: DatumVec3, s: number, b: DatumVec3): DatumVec3 {
  return [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];
}

/**
 * A deterministic in-plane x axis for a unit normal: the least-aligned
 * world axis is projected into the plane, so the frame never flips with
 * float noise, identical normals yield identical frames, and a +z plane
 * keeps the world +x as its sketch x.
 */
function inPlaneXAxisOf(normal: DatumVec3): DatumVec3 {
  const seed: DatumVec3 =
    Math.abs(normal[0]) < 0.9
      ? [1, 0, 0]
      : Math.abs(normal[1]) < 0.9
        ? [0, 1, 0]
        : [0, 0, 1];
  const projection = dot(seed, normal);
  const xAxis = unit([
    seed[0] - projection * normal[0],
    seed[1] - projection * normal[1],
    seed[2] - projection * normal[2],
  ]);
  if (xAxis === null) {
    throw new Error(
      "Session datum frame: the in-plane x axis degenerated for a unit normal.",
    );
  }
  return xAxis;
}

/** The analytic cap planes of one extrude feature: origin + unit normal each. */
interface CapPlane {
  readonly origin: DatumVec3;
  readonly normal: DatumVec3;
}

/**
 * Derives the two cap planes of the body's producing extrude feature from
 * the driving sketch's workplane and the signed distance parameter.
 * `null` when the body has no producing extrude, the sketch no longer
 * parses, or the distance no longer resolves — the structured absence the
 * resolver reports instead of a plane.
 */
function extrudeCapPlanesOfBody(
  document: CadDocument,
  bodyId: string,
): readonly CapPlane[] | null {
  const bodyProducers = document.features.filter(
    (feature: FeatureRecord) =>
      feature.kind === "extrude" &&
      feature.outputs.some((output) => output === bodyId),
  );
  const producer = bodyProducers[0];
  if (producer === undefined) return null;
  const sketchRef = producer.inputs.find((ref) => ref.kind === "sketch");
  const distanceRef = producer.inputs.find((ref) => ref.kind === "parameter");
  if (
    sketchRef === undefined ||
    sketchRef.kind !== "sketch" ||
    distanceRef === undefined ||
    distanceRef.kind !== "parameter"
  ) {
    return null;
  }
  const record = getDocumentSketch(document, sketchRef.id);
  if (record === undefined) return null;
  const sketch = parseSketch(record.sketch);
  if (!sketch.ok) return null;
  const parameter = document.parameters.parameters.find(
    (candidate) => candidate.id === distanceRef.id,
  );
  if (parameter === undefined || parameter.value.dimension !== "length") {
    return null;
  }
  const depth = parameter.value.value;
  if (depth === 0) return null;
  const { workplane } = sketch.value;
  const normal: DatumVec3 = [
    workplane.normal.x,
    workplane.normal.y,
    workplane.normal.z,
  ];
  const origin: DatumVec3 = [
    workplane.origin.x,
    workplane.origin.y,
    workplane.origin.z,
  ];
  const sign = depth > 0 ? 1 : -1;
  // Front cap: rides the extrusion's end, normal along the travel
  // direction; back cap: sits on the sketch plane, normal against it.
  return [
    {
      origin: combine(origin, depth, normal),
      normal: [normal[0] * sign, normal[1] * sign, normal[2] * sign],
    },
    {
      origin,
      normal: [-normal[0] * sign, -normal[1] * sign, -normal[2] * sign],
    },
  ];
}

/**
 * The session datum resolver: explicit datum definitions resolve through
 * cad-core's own math; `sessionFace` references resolve analytically
 * against the referenced body's extrude caps (see the module docs). The
 * payload's `faceNormal` picks the cap; cad-core's datum resolution then
 * aligns the frame to the definition's recorded normal.
 */
export function sessionDatumResolverOf(
  document: CadDocument,
): DatumTopologyResolver {
  return {
    facePlane: (reference) => {
      if (
        typeof reference !== "object" ||
        reference === null ||
        (reference as { kind?: unknown }).kind !== "sessionFace"
      ) {
        return sessionFailure(
          SESSION_DATUM_ERROR_CODES.referenceInvalid,
          'A session datum face reference must be a { kind: "sessionFace", bodyId, faceNormal } payload.',
          reference,
        );
      }
      const bodyId = (reference as { bodyId?: unknown }).bodyId;
      const faceNormal = (reference as { faceNormal?: unknown }).faceNormal;
      if (
        typeof bodyId !== "string" ||
        !Array.isArray(faceNormal) ||
        faceNormal.length !== 3 ||
        faceNormal.some((c) => typeof c !== "number" || !Number.isFinite(c))
      ) {
        return sessionFailure(
          SESSION_DATUM_ERROR_CODES.referenceInvalid,
          "A session datum face reference must name its body id and the picked face normal.",
          reference,
        );
      }
      const pickedNormal: DatumVec3 = [
        faceNormal[0] as number,
        faceNormal[1] as number,
        faceNormal[2] as number,
      ];
      const caps = extrudeCapPlanesOfBody(document, bodyId);
      if (caps === null) {
        return sessionFailure(
          SESSION_DATUM_ERROR_CODES.faceNotResolvable,
          `Body "${bodyId}" has no resolvable extrude faces in this session; the datum plane cannot resolve.`,
          reference,
        );
      }
      const picked = caps.find((cap) => dot(cap.normal, pickedNormal) > 0.5);
      if (picked === undefined) {
        return sessionFailure(
          SESSION_DATUM_ERROR_CODES.faceNotResolvable,
          `Body "${bodyId}"'s extrusion has no cap matching the picked face normal; the driving face changed or was a side wall, and the datum refuses to guess.`,
          reference,
        );
      }
      const normal = unit(picked.normal);
      if (normal === null) {
        return sessionFailure(
          SESSION_DATUM_ERROR_CODES.faceNotResolvable,
          `Body "${bodyId}"'s extrusion has a degenerate normal; the datum plane cannot resolve.`,
          reference,
        );
      }
      return {
        ok: true,
        value: {
          origin: picked.origin,
          normal,
          xAxis: inPlaneXAxisOf(normal),
        },
      };
    },
    faceCylinderAxis: () =>
      sessionFailure(
        SESSION_DATUM_ERROR_CODES.faceNotResolvable,
        "The session resolver cannot type curved surfaces; cylinder-axis datums resolve on the kernel side.",
        null,
      ),
    edgeLine: () =>
      sessionFailure(
        SESSION_DATUM_ERROR_CODES.faceNotResolvable,
        "The session resolver cannot address edges; edge datums resolve on the kernel side.",
        null,
      ),
  };
}

/**
 * Resolves a datum plane record into the session's plane geometry
 * (origin, unit normal, in-plane unit x axis). Every failure — unknown
 * record, unparseable payload, unresolvable reference — is structured.
 */
export function resolveSessionDatumPlane(
  document: CadDocument,
  datumId: string,
):
  | {
      readonly ok: true;
      readonly origin: DatumVec3;
      readonly normal: DatumVec3;
      readonly xAxis: DatumVec3;
    }
  | {
      readonly ok: false;
      readonly error: ParseFailure;
    } {
  // The id crosses the session seam as a plain string; parse it through
  // the id utilities before it touches the branded-registry lookup — an
  // unparseable id is the same structured absence as a missing record.
  const parsedId = parseDatumId(datumId);
  if (!parsedId.ok) {
    return sessionFailure(
      SESSION_DATUM_ERROR_CODES.datumInvalid,
      `No datum record "${datumId}" exists in the document.`,
      datumId,
    );
  }
  const record = getDocumentDatum(document, parsedId.value);
  if (record === undefined) {
    return sessionFailure(
      SESSION_DATUM_ERROR_CODES.datumInvalid,
      `No datum record "${datumId}" exists in the document.`,
      datumId,
    );
  }
  const payload = parseDatumPayload(record.datum);
  if (!payload.ok) {
    return sessionFailure(
      SESSION_DATUM_ERROR_CODES.datumInvalid,
      `Datum "${datumId}" has an invalid payload: ${payload.error.message}`,
      record.datum,
    );
  }
  if (payload.value.datumType !== "plane") {
    return sessionFailure(
      SESSION_DATUM_ERROR_CODES.datumNotAPlane,
      `Datum "${datumId}" is not a datum plane.`,
      record.datum,
    );
  }
  const resolved = resolveDatumPayload(
    payload.value,
    sessionDatumResolverOf(document),
  );
  if (!resolved.ok) {
    // The resolver's own structured failure propagates verbatim — the
    // session's `session/face-not-resolvable` (or whatever the seam
    // answered) is the honest code, not a wrapped generic.
    return { ok: false, error: resolved.error };
  }
  if (
    resolved.value.datumType !== "plane" ||
    resolved.value.plane === undefined
  ) {
    return sessionFailure(
      SESSION_DATUM_ERROR_CODES.datumNotAPlane,
      `Datum "${datumId}" resolved to a ${resolved.value.datumType}.`,
      resolved.value,
    );
  }
  const plane = resolved.value.plane;
  return { ok: true, ...plane };
}

/** The identity of one selectable scene face: body, point, and mean normal. */
export interface SceneFacePick {
  /** The body the face belongs to (the synthetic reference's body id). */
  readonly bodyId: string;
  /** A point on the face (the synthetic face anchor, world mm). */
  readonly point: DatumVec3;
  /** The face's mean normal (world axes), or `null` for a curved face. */
  readonly normal: DatumVec3 | null;
}

/**
 * Mints a session face reference payload for a picked face — the datum
 * definition's `reference` field verbatim. `null` for a curved face (no
 * single normal to anchor a plane on): the caller states that instead of
 * guessing.
 */
export function sessionFaceReferenceOf(
  pick: SceneFacePick,
): SessionFaceReference | null {
  if (pick.normal === null) return null;
  return { kind: "sessionFace", bodyId: pick.bodyId, faceNormal: pick.normal };
}

/**
 * Builds the sketch WORKPLANE of a face-anchored pick: normal from the
 * face, deterministic in-plane x, origin at the picked anchor point (the
 * sketch's (0,0) sits at the face anchor — the drawn profile's coordinates
 * are face-relative). The sketch domain's Workplane type is exactly this
 * shape, so sketches boot on it directly. `null` for a curved face.
 */
export function faceDatumWorkplane(pick: SceneFacePick): Workplane | null {
  const normal = unit(pick.normal ?? [0, 0, 0]);
  if (normal === null) return null;
  return {
    origin: { x: pick.point[0], y: pick.point[1], z: pick.point[2] },
    normal: { x: normal[0], y: normal[1], z: normal[2] },
    xAxis: axisRecord(inPlaneXAxisOf(normal)),
  };
}

function axisRecord(a: DatumVec3): { x: number; y: number; z: number } {
  return { x: a[0], y: a[1], z: a[2] };
}

/**
 * Resolves a picked synthetic face (the viewport selection) into a
 * {@link SceneFacePick} against the applied projection: the face's anchor
 * point and mean normal, computed through the same synthetic-face helpers
 * the anchor surface publishes. `null` when the projection no longer
 * carries the body or the face index — the honest "nothing to anchor on".
 */
export function sceneFacePickOfSelection(
  projection: RenderProjection,
  reference: {
    readonly kind: "face";
    readonly bodyId: string;
    readonly faceIndex: number;
  },
): SceneFacePick | null {
  const object = projection.objects.find(
    (candidate) => candidate.bodyId === reference.bodyId,
  );
  if (object === undefined) return null;
  const grouping = groupSyntheticFaces(object);
  const face = grouping.faces[reference.faceIndex];
  if (face === undefined || face.index !== reference.faceIndex) return null;
  return {
    bodyId: reference.bodyId,
    point: syntheticFaceAnchor(object, grouping, reference.faceIndex),
    normal: syntheticFaceMeanNormal(object, grouping, reference.faceIndex),
  };
}

/**
 * The kernel placement of a session datum plane — the same conversion the
 * sketch domain applies to its own workplanes, applied to the datum's
 * re-resolved frame. This is what lets an extrude feature whose inputs
 * name a datum follow the datum when the driving face moves.
 */
export function sessionDatumPlacement(document: CadDocument, datumId: string) {
  const plane = resolveSessionDatumPlane(document, datumId);
  if (!plane.ok) return plane;
  return {
    ok: true as const,
    placement: workplaneToPlacement({
      origin: axisRecord(plane.origin),
      normal: axisRecord(plane.normal),
      xAxis: axisRecord(plane.xAxis),
    }),
  };
}

/** Dot helper re-exported for the engine's face matching (keeps math local). */
export const sessionDatumMath = { dot, cross, unit, combine };
