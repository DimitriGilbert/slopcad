/**
 * Convert entities (Phase 37): projects model topology into a sketch as
 * reference (construction) geometry, consuming the persistent-reference
 * protocol — `TopologyEntityReference` records resolved against a
 * `TopologyView` — from `cad-core/src/persistent-reference.ts`.
 *
 * ## The honest projection (disclosed scope)
 *
 * What converts is exactly what the topology snapshot's geometry descriptor
 * certifies: a **vertex** carries its absolute model-space point
 * (`pointAbsoluteMm`), which projects onto the sketch's workplane
 * (`worldToWorkplane` — orthogonal along the plane normal; the out-of-plane
 * offset is disclosed in the outcome, not silently dropped) and becomes a
 * construction point. An **edge** carries only its centroid and length; a
 * **face** only its area, centroid, and (cylindrical) radius — neither
 * carries the curve or boundary the word "project" wants, so both decline
 * with `sketch-convert/curve-unavailable` rather than inventing geometry
 * from summary measures. When a kernel grows curve-carrying descriptors,
 * this module is where they land.
 *
 * ## Resolution is the protocol, not a reimplementation
 *
 * Each reference resolves through cad-core's own
 * `resolveTopologyReference` against the view's CURRENT snapshot of its
 * body: a transient-topology kernel resolves `invalid`/
 * `kernel-transient-topology`, a stale identity `missing`, a kernel or
 * schema mismatch `invalid` — and every non-usable outcome declines with a
 * structured `sketch-convert/*` code naming the resolution state. The
 * convert result is per-reference (one may convert while another
 * declines), and the converted command is an ordinary
 * `sketch.entity.create` command — a construction-flagged point — riding
 * the existing interpreter, history, and wire format.
 */

import {
  type ParseResult,
  fail,
  ok,
  resolveTopologyReference,
  type TopologyEntityReference,
  type TopologyView,
} from "@slopcad/cad-core";
import type { SketchCommand } from "./commands";
import type { Sketch } from "./sketch";
import type { SketchEntityId } from "./sketch-ids";

import { createPointEntity } from "./entities";
import { createSketchOpIdAllocator } from "./entity-ops";
import { worldToWorkplane, type Workplane } from "./workplane";

/** Stable failure codes for convert requests that cannot run at all. */
export const SKETCH_CONVERT_ERROR_CODES = {
  viewMissing: "sketch-convert/view-missing",
} as const;

export type SketchConvertErrorCode =
  (typeof SKETCH_CONVERT_ERROR_CODES)[keyof typeof SKETCH_CONVERT_ERROR_CODES];

/** Structured failure describing why a convert request was rejected. */
export interface SketchConvertError {
  readonly code: SketchConvertErrorCode;
  readonly message: string;
  readonly input: unknown;
}

/** Stable decline codes carried per reference. */
export const SKETCH_CONVERT_DECLINE_CODES = {
  transientTopology: "sketch-convert/kernel-transient-topology",
  kernelMismatch: "sketch-convert/kernel-mismatch",
  schemaUnknown: "sketch-convert/schema-unknown",
  referenceAmbiguous: "sketch-convert/reference-ambiguous",
  referenceInvalid: "sketch-convert/reference-invalid",
  referenceMissing: "sketch-convert/reference-missing",
  curveUnavailable: "sketch-convert/curve-unavailable",
  descriptorIncomplete: "sketch-convert/descriptor-incomplete",
} as const;

export type SketchConvertDeclineCode =
  (typeof SKETCH_CONVERT_DECLINE_CODES)[keyof typeof SKETCH_CONVERT_DECLINE_CODES];

/** One reference's convert outcome. */
export type ConvertedTopologyEntity =
  | {
      readonly reference: TopologyEntityReference;
      readonly status: "converted";
      /** The out-of-plane projection offset (mm) the workplane normal saw. */
      readonly offsetMm: number;
      /** The construction-point creation command (the sole write). */
      readonly command: SketchCommand;
    }
  | {
      readonly reference: TopologyEntityReference;
      readonly status: "declined";
      readonly code: SketchConvertDeclineCode;
      readonly message: string;
    };

export interface ConvertTopologyEntitiesRequest {
  /** The references to convert, in conversion order. */
  readonly references: readonly TopologyEntityReference[];
  /** The resolving kernel's topology view (the snapshot source). */
  readonly view: TopologyView | null;
  /**
   * The workplane the sketch draws on; model points project onto it
   * orthogonally along its normal. Defaults to the sketch's own workplane
   * when omitted.
   */
  readonly workplane?: Workplane;
}

/**
 * Resolves and converts each reference against the view, producing one
 * outcome per reference. The request declines as a whole only when there
 * is no view at all (`sketch-convert/view-missing` — a host without
 * topology refuses honestly instead of pretending).
 */
export function convertTopologyEntities(
  sketch: Sketch,
  request: ConvertTopologyEntitiesRequest,
): ParseResult<readonly ConvertedTopologyEntity[], SketchConvertError> {
  if (request.view === null) {
    return fail({
      code: SKETCH_CONVERT_ERROR_CODES.viewMissing,
      message:
        "No topology view is available: convert needs a persistent-topology kernel's view of the model. Nothing was converted.",
      input: request.references,
    });
  }
  const mint = createSketchOpIdAllocator(sketch);
  const view = request.view;
  const outcomes: ConvertedTopologyEntity[] = request.references.map(
    (reference) =>
      convertOne(request.workplane ?? sketch.workplane, view, reference, mint),
  );
  return ok(outcomes);
}

function convertOne(
  workplane: Workplane,
  view: TopologyView,
  reference: TopologyEntityReference,
  mint: (base: string) => SketchEntityId,
): ConvertedTopologyEntity {
  const snapshot = view.snapshotOf(reference.bodyId);
  const resolved = resolveTopologyReference(reference, snapshot);
  if (!resolved.ok) {
    return declined(
      reference,
      SKETCH_CONVERT_DECLINE_CODES.referenceInvalid,
      `Resolution refused the reference: ${resolved.error.message}`,
    );
  }
  const state = resolved.value.validity.state;
  if (state === "missing") {
    return declined(
      reference,
      SKETCH_CONVERT_DECLINE_CODES.referenceMissing,
      `The reference no longer resolves (state "missing"): the body's current topology has no entity with its identity.`,
    );
  }
  if (state === "ambiguous") {
    return declined(
      reference,
      SKETCH_CONVERT_DECLINE_CODES.referenceAmbiguous,
      `The reference resolves ambiguously to ${String(resolved.value.validity.candidates?.length ?? 0)} entities; disambiguate it first.`,
    );
  }
  if (state === "invalid") {
    return declined(
      reference,
      reference.validity.reason === "kernel-transient-topology"
        ? SKETCH_CONVERT_DECLINE_CODES.transientTopology
        : reference.validity.reason === "kernel-mismatch"
          ? SKETCH_CONVERT_DECLINE_CODES.kernelMismatch
          : reference.validity.reason === "schema-unknown"
            ? SKETCH_CONVERT_DECLINE_CODES.schemaUnknown
            : SKETCH_CONVERT_DECLINE_CODES.referenceInvalid,
      `The reference is invalid (${reference.validity.reason ?? "unspecified reason"}); convert declined.`,
    );
  }
  // "valid" (or "repaired" — the protocol's usable states): project what
  // the current descriptor certifies.
  const ordinal = resolved.value.validity.ordinal;
  const entity =
    ordinal === undefined
      ? undefined
      : snapshot?.entities.find(
          (candidate) =>
            candidate.kind === reference.kind && candidate.ordinal === ordinal,
        );
  if (reference.kind !== "vertex") {
    return declined(
      reference,
      SKETCH_CONVERT_DECLINE_CODES.curveUnavailable,
      `A model ${reference.kind} carries only summary measures (centroid, ${reference.kind === "edge" ? "length" : "area"}${reference.kind === "face" ? ", analytic cylinder radius when cylindrical" : ""}) — not the ${reference.kind === "edge" ? "curve" : "boundary"} projection needs. Nothing was invented from the summaries.`,
    );
  }
  const absolute =
    entity?.geometry.pointAbsoluteMm ?? reference.geometry.pointAbsoluteMm;
  if (absolute === undefined) {
    return declined(
      reference,
      SKETCH_CONVERT_DECLINE_CODES.descriptorIncomplete,
      "The vertex's descriptor carries no absolute point; convert cannot place the construction point.",
    );
  }
  const projected = worldToWorkplane(workplane, {
    x: absolute[0],
    y: absolute[1],
    z: absolute[2],
  });
  return {
    reference,
    status: "converted",
    offsetMm: projected.offset,
    command: {
      type: "sketch.entity.create",
      entity: createPointEntity(
        mint("convert"),
        { x: projected.x, y: projected.y },
        { construction: true },
      ),
    },
  };
}

function declined(
  reference: TopologyEntityReference,
  code: SketchConvertDeclineCode,
  message: string,
): ConvertedTopologyEntity {
  return { code, message, reference, status: "declined" };
}
