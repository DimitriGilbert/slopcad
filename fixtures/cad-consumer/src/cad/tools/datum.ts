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
  type RenderObject,
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
  /**
   * Present exactly on COMPUTED-body references (a boolean, hole, pad, or
   * moved body — a body whose plane source is its computed solid): the
   * picked face's same-normal ordinal. The computed resolution filters the
   * body's analytic face planes to those whose normal aligns with
   * `faceNormal` and anchors to the face at this position — see the
   * ordinal contract on {@link computedFacePlanesOfObject}. A plain
   * extrusion's reference omits it: the two-cap path keys on the normal
   * alone, exactly as it always has.
   */
  readonly faceOrdinal?: number;
}

/** Structured failures of the session datum resolver. */
export const SESSION_DATUM_ERROR_CODES = {
  /** The datum record is absent or its payload does not parse. */
  datumInvalid: "session/datum-invalid",
  /** The datum is not a plane. */
  datumNotAPlane: "session/datum-not-a-plane",
  /** The datum is not an axis. */
  datumNotAnAxis: "session/datum-not-an-axis",
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
 * The face-normal alignment the datum reference's `faceNormal` must clear
 * against a candidate plane's normal to count as the SAME face (both dot
 * comparisons in the resolver — the extrude caps' and the computed faces'
 * — share this one threshold; ~60°, generous to tessellation noise,
 * strict enough to separate perpendicular faces).
 */
const FACE_NORMAL_ALIGNMENT_DOT = 0.5;

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
 * One analytic face plane of a computed body's settled mesh: a point on
 * the face (the synthetic face's anchor — the largest triangle's centroid,
 * strictly on the plane) and the face's unit mean normal.
 */
export interface ComputedFacePlane {
  readonly origin: DatumVec3;
  readonly normal: DatumVec3;
}

/**
 * The computed-face source the datum resolution consults for COMPUTED
 * bodies (a boolean, hole, pad, or moved body — a body whose geometry
 * exists only as the scene pass's composition): per body id, the body's
 * analytic face planes in synthetic-face ordinal order. The engine derives
 * it from the applied projection — the settled scene ONE worker dispatch
 * produced, cached until the next settle (the same staleness handling the
 * pick itself rides). Scoping is the caller's contract: only
 * COMPUTED-classified bodies (`sceneOperandOfBody`) belong in the source,
 * so a plain extrusion's resolution can never take the computed path.
 */
export interface ComputedFaceSource {
  readonly planesOf: (
    bodyId: string,
  ) => readonly ComputedFacePlane[] | undefined;
}

/**
 * Derives a computed body's analytic face planes from its settled render
 * object: the object's synthetic faces (the SAME grouping the picker
 * addresses — face ordinals are the grouping's documented first-triangle
 * order), each contributing a plane exactly when it has a single mean
 * normal (a planar face). Curved faces (a bore wall) and degenerate faces
 * contribute nothing — a reference anchored on them has no candidate at
 * any ordinal and refuses, never a guessed plane.
 *
 * ## The ordinal contract for computed bodies
 *
 * Mirroring the extrude-cap path (caps ordered [front, back] by the
 * document derivation; the recorded `faceNormal` picks the cap it aligns
 * with): the candidate list is the body's planar synthetic faces IN
 * SYNTHETIC-FACE ORDINAL ORDER, the datum's `faceOrdinal` is the picked
 * face's position among the faces whose mean normal aligns with the
 * recorded `faceNormal` (dot > {@link FACE_NORMAL_ALIGNMENT_DOT}), and
 * resolution re-derives the list from the body's CURRENT computed mesh and
 * indexes it by the recorded ordinal. Ordinal 0 is the first aligned face
 * — exactly the face the cap path's first-match would pick when only one
 * candidate exists. The ordinal is a pure function of (mesh, picked face):
 * no Date, no random, no scene state beyond the mesh itself.
 */
export function computedFacePlanesOfObject(
  object: RenderObject,
): readonly ComputedFacePlane[] {
  const grouping = groupSyntheticFaces(object);
  const planes: ComputedFacePlane[] = [];
  for (const face of grouping.faces) {
    const meanNormal = syntheticFaceMeanNormal(object, grouping, face.index);
    if (meanNormal === null) continue;
    const anchor = syntheticFaceAnchor(object, grouping, face.index);
    planes.push({
      origin: [anchor[0], anchor[1], anchor[2]],
      normal: [meanNormal[0], meanNormal[1], meanNormal[2]],
    });
  }
  return planes;
}

/**
 * The picked face's same-normal ordinal within one render object (the
 * pick-time half of the ordinal contract above): the position of
 * `faceIndex` among the object's synthetic faces whose mean normal aligns
 * with the picked face's own. `null` when the face has no single normal
 * (curved — the caller refuses before this matters) or the index is
 * outside the grouping (the object and the selection disagree).
 */
export function computedFaceOrdinalOfObject(
  object: RenderObject,
  faceIndex: number,
): number | null {
  const grouping = groupSyntheticFaces(object);
  const face = grouping.faces[faceIndex];
  if (face === undefined || face.index !== faceIndex) return null;
  const pickedNormal = syntheticFaceMeanNormal(object, grouping, faceIndex);
  if (pickedNormal === null) return null;
  let ordinal = 0;
  for (const candidate of grouping.faces) {
    if (candidate.index >= faceIndex) break;
    const normal = syntheticFaceMeanNormal(object, grouping, candidate.index);
    if (normal === null) continue;
    if (dot(normal, pickedNormal) > FACE_NORMAL_ALIGNMENT_DOT) ordinal += 1;
  }
  return ordinal;
}

/**
 * The session datum resolver: explicit datum definitions resolve through
 * cad-core's own math; `sessionFace` references resolve analytically —
 * through the computed-face source when the reference names a body the
 * source carries (a computed body: its planes ARE the truth the scene
 * pass settled), otherwise against the referenced body's extrude caps (see
 * the module docs). The payload's `faceNormal` (and, for computed bodies,
 * `faceOrdinal`) picks the face; cad-core's datum resolution then aligns
 * the frame to the definition's recorded normal.
 */
export function sessionDatumResolverOf(
  document: CadDocument,
  computedFaces?: ComputedFaceSource,
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
      const faceOrdinal = (reference as { faceOrdinal?: unknown }).faceOrdinal;
      if (
        typeof bodyId !== "string" ||
        !Array.isArray(faceNormal) ||
        faceNormal.length !== 3 ||
        faceNormal.some((c) => typeof c !== "number" || !Number.isFinite(c)) ||
        (faceOrdinal !== undefined &&
          (typeof faceOrdinal !== "number" ||
            !Number.isSafeInteger(faceOrdinal) ||
            faceOrdinal < 0))
      ) {
        return sessionFailure(
          SESSION_DATUM_ERROR_CODES.referenceInvalid,
          "A session datum face reference must name its body id and the picked face normal (a computed body adds its non-negative same-normal ordinal).",
          reference,
        );
      }
      const pickedNormal: DatumVec3 = [
        faceNormal[0] as number,
        faceNormal[1] as number,
        faceNormal[2] as number,
      ];
      // The computed path first — but only for a body the source carries
      // (the source is scoped to computed-classified bodies, so a plain
      // extrusion's resolution always falls through to the caps below,
      // byte-identical). A body the source does not carry — no settled
      // scene for it, or the caller supplied no source — refuses below
      // exactly as before.
      if (computedFaces !== undefined) {
        const planes = computedFaces.planesOf(bodyId);
        if (planes !== undefined) {
          const candidates = planes.filter(
            (plane) =>
              dot(plane.normal, pickedNormal) > FACE_NORMAL_ALIGNMENT_DOT,
          );
          const ordinal = faceOrdinal ?? 0;
          const picked = candidates[ordinal];
          if (picked === undefined) {
            return sessionFailure(
              SESSION_DATUM_ERROR_CODES.faceNotResolvable,
              candidates.length === 0
                ? `Body "${bodyId}"'s computed scene has no planar face matching the picked face normal; the driving face changed or was curved, and the datum refuses to guess.`
                : `Body "${bodyId}"'s computed scene has ${String(candidates.length)} face(s) matching the picked normal but none at same-normal ordinal ${String(ordinal)}; the computed topology changed, and the datum refuses to guess.`,
              reference,
            );
          }
          const normal = unit(picked.normal);
          if (normal === null) {
            return sessionFailure(
              SESSION_DATUM_ERROR_CODES.faceNotResolvable,
              `Body "${bodyId}"'s computed face has a degenerate normal; the datum plane cannot resolve.`,
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
        }
      }
      const caps = extrudeCapPlanesOfBody(document, bodyId);
      if (caps === null) {
        return sessionFailure(
          SESSION_DATUM_ERROR_CODES.faceNotResolvable,
          `Body "${bodyId}" has no resolvable extrude faces in this session; the datum plane cannot resolve.`,
          reference,
        );
      }
      const picked = caps.find(
        (cap) => dot(cap.normal, pickedNormal) > FACE_NORMAL_ALIGNMENT_DOT,
      );
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
 * The optional computed-face source activates the computed-body
 * resolution path (see {@link sessionDatumResolverOf}); callers without a
 * settled scene omit it and computed references refuse, as always.
 */
export function resolveSessionDatumPlane(
  document: CadDocument,
  datumId: string,
  computedFaces?: ComputedFaceSource,
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
    sessionDatumResolverOf(document, computedFaces),
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

/**
 * Resolves a datum axis record into the session's axis geometry (origin,
 * unit direction) — the axis sibling of {@link resolveSessionDatumPlane},
 * the helix and thread scene frames' source. Explicit-geometry axes
 * (`twoPoints`) resolve in-session; reference-dependent definitions
 * (`edge`, `faceCylinder`) answer the session resolver's structured
 * "kernel side" refusal — the scene never guesses a frame.
 */
export function resolveSessionDatumAxis(
  document: CadDocument,
  datumId: string,
):
  | {
      readonly ok: true;
      readonly origin: DatumVec3;
      readonly direction: DatumVec3;
    }
  | {
      readonly ok: false;
      readonly error: ParseFailure;
    } {
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
  if (payload.value.datumType !== "axis") {
    return sessionFailure(
      SESSION_DATUM_ERROR_CODES.datumNotAnAxis,
      `Datum "${datumId}" is not a datum axis.`,
      record.datum,
    );
  }
  const resolved = resolveDatumPayload(
    payload.value,
    sessionDatumResolverOf(document),
  );
  if (!resolved.ok) {
    return { ok: false, error: resolved.error };
  }
  if (
    resolved.value.datumType !== "axis" ||
    resolved.value.axis === undefined
  ) {
    return sessionFailure(
      SESSION_DATUM_ERROR_CODES.datumNotAnAxis,
      `Datum "${datumId}" resolved to a ${resolved.value.datumType}.`,
      resolved.value,
    );
  }
  return { ok: true, ...resolved.value.axis };
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
 * name a datum follow the datum when the driving face moves. The optional
 * computed-face source threads through to the plane resolution (a datum
 * anchored on a computed body re-resolves against the body's settled
 * scene — see {@link resolveSessionDatumPlane}).
 */
export function sessionDatumPlacement(
  document: CadDocument,
  datumId: string,
  computedFaces?: ComputedFaceSource,
) {
  const plane = resolveSessionDatumPlane(document, datumId, computedFaces);
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
