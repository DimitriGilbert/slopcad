/**
 * Persistent references and topology identity (Phase 22): the kernel-neutral
 * model of references that address a document's entities — feature, body, and
 * solid through their stable document ids (they already exist and survive
 * regenerations by the document model's construction), and face, edge, and
 * vertex through PERSISTENT topology references that carry provenance plus a
 * kernel-agnostic identity payload and re-resolve against each regeneration.
 *
 * ## What the identity experiments proved (this model's ground truth)
 *
 * The Phase 22 experiments (committed in `cad-kernel-occt`'s
 * `topology-identity.test.ts`) measured OCCT's `ReplicadShapeHasher` face
 * hashes across every change class. Findings, each pinned by a test:
 *
 * - Rebuilding the SAME feature graph (fresh kernel builds, same process)
 *   produces a COMPLETELY DISJOINT face-hash set — the hash is derived from
 *   allocation addresses, so kernel identity dies at every regeneration.
 * - A harmless translate changes every hash (location participates) but
 *   preserves every face area BITWISE and shifts every centroid by exactly
 *   the translation vector — so measures relative to the body's centre of
 *   mass are rigid-translation-invariant.
 * - Within one process, a boolean keeps the identity of UNTOUCHED faces,
 *   destroys it for modified/split faces, and mints fresh identity for new
 *   faces — identity survives only along a live kernel lineage.
 * - Serialization (STEP/BREP round trip, cross-process import) destroys
 *   every hash while preserving areas to ~1e-15 relative — geometry, not
 *   kernel identity, is the only cross-regeneration carrier.
 * - Symmetric splits produce geometric twins (equal area, distinct position)
 *   and a compound can carry one TShape twice (equal identity) — both are
 *   real ambiguity sources, and a resolver must report them, never guess.
 *
 * The model therefore gives every persistent reference TWO coordinated
 * payloads: a {@link TopologyIdentityPayload} (opaque data only the
 * resolving kernel interprets — for OCCT the shape hash; never a raw kernel
 * handle crosses this surface) for exact same-lineage resolution, and a
 * {@link TopologyGeometryDescriptor} (body-relative measures) for bounded,
 * explicit repair across regenerations.
 *
 * ## Validity states and structured transitions
 *
 * Every reference carries its current {@link ReferenceValidityRecord} as
 * data — `valid`, `missing`, `ambiguous`, `invalid`, or `repaired` — and
 * moves between states only through {@link applyReferenceValidity}, which
 * enforces the documented transition table:
 *
 * - `valid | missing | ambiguous` are re-measured at every resolution and
 *   may move freely among themselves (identity matched, vanished, or
 *   collided) and into `invalid`.
 * - `repaired` is reachable ONLY from `missing` (bounded repair) or
 *   `ambiguous` (explicit disambiguation) — a valid reference is never
 *   "repaired" silently; its identity must die first, visibly.
 * - `repaired` references are re-measured like any other on later
 *   regenerations and may be repaired again.
 * - `invalid` is terminal: structural breaks (owning body deleted,
 *   provenance gone, wrong kernel, unknown schema) end a reference;
 *   a successor must be minted deliberately.
 *
 * ## The resolution protocol (kernel-capability gated)
 *
 * {@link TopologyView} is the interface a resolving kernel implements. A
 * `persistentTopology: true` kernel (OCCT) answers with
 * {@link TopologySnapshot}s of the current regeneration's topology; a
 * `persistentTopology: false` kernel (Manifold) is reported HONESTLY: its
 * view resolves every topology reference to `invalid` with reason
 * `kernel-transient-topology`, and {@link transientSelectionOf} maps a
 * resolved reference into the Phase 12 synthetic selection reference
 * (regeneration + ordinal) — one model unifying the transient and
 * persistent stances.
 *
 * ## Repair is explicit data, never silent

 * {@link repairTopologyReference} re-anchors a `missing` reference using
 * two deterministic, ordered strategies — identity match against a
 * re-executed provenance path first, then the documented geometric
 * heuristic (an ordered narrowing chain: primary measure within 1e-9
 * relative, body-relative position within 1e-6 mm, always gating) — and
 * REFUSES to guess: no candidate keeps the reference missing, several
 * candidates fail with the candidates listed.
 * A successful repair rewrites the reference's payloads and records the
 * old→new anchors in the validity record. {@link disambiguateTopologyReference}
 * is the explicit, caller-owned way out of `ambiguous`.
 */

import type { BodyId, FeatureId, ReferenceId } from "./ids";
import type { CadDocument } from "./document";
import type {
  EdgeSelectionReference,
  FaceSelectionReference,
  VertexSelectionReference,
} from "./selection";

import { parseBodyId, parseFeatureId, parseReferenceId } from "./ids";
import { getBody } from "./document";
import { featureEvaluationOrder } from "./feature-graph";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

// ---------------------------------------------------------------------------
// Kinds, states, payloads
// ---------------------------------------------------------------------------

/** The plan's topology reference categories (feature/body/solid are stable ids). */
export const TOPOLOGY_REFERENCE_KINDS = ["face", "edge", "vertex"] as const;

export type TopologyReferenceKind = (typeof TOPOLOGY_REFERENCE_KINDS)[number];

/** The plan's five explicit reference validity states. */
export const REFERENCE_VALIDITY_STATES = [
  "valid",
  "missing",
  "ambiguous",
  "invalid",
  "repaired",
] as const;

export type ReferenceValidity = (typeof REFERENCE_VALIDITY_STATES)[number];

/** Runtime membership set behind {@link isTopologyReferenceKind}. */
const TOPOLOGY_KIND_SET: ReadonlySet<string> = new Set(
  TOPOLOGY_REFERENCE_KINDS,
);

/** Whether `kind` is one of the topology reference kinds. */
export function isTopologyReferenceKind(
  kind: string,
): kind is TopologyReferenceKind {
  return TOPOLOGY_KIND_SET.has(kind);
}

/** The structural reasons a reference can be invalid (terminal). */
export const REFERENCE_INVALID_REASONS = [
  /** The owning body no longer exists in the document. */
  "body-absent",
  /** The provenance path no longer leads to the owning body. */
  "provenance-broken",
  /** The resolving kernel persists no topology (Manifold-era behavior). */
  "kernel-transient-topology",
  /** The reference's identity payload belongs to a different kernel. */
  "kernel-mismatch",
  /** The resolving kernel does not know the identity payload's schema. */
  "schema-unknown",
] as const;

export type ReferenceInvalidReason = (typeof REFERENCE_INVALID_REASONS)[number];

/** Runtime membership sets behind the parse guards. */
const VALIDITY_STATE_SET: ReadonlySet<string> = new Set(
  REFERENCE_VALIDITY_STATES,
);
const INVALID_REASON_SET: ReadonlySet<string> = new Set(
  REFERENCE_INVALID_REASONS,
);

/** Whether `state` is one of the five validity states. */
export function isReferenceValidity(state: string): state is ReferenceValidity {
  return VALIDITY_STATE_SET.has(state);
}

/** Whether `reason` is one of the structural invalid reasons. */
export function isReferenceInvalidReason(
  reason: string,
): reason is ReferenceInvalidReason {
  return INVALID_REASON_SET.has(reason);
}

/** A primitive value of an identity payload's data record. */
export type TopologyIdentityDatum = string | number | boolean;

/**
 * The kernel-agnostic topology-identity payload: which kernel minted it,
 * under which schema, and the opaque data only that kernel interprets (for
 * OCCT the shape hash — see `OCCT_TOPOLOGY_IDENTITY_SCHEMA` in
 * `cad-kernel-occt`). No raw kernel handle ever crosses this type.
 */
export interface TopologyIdentityPayload {
  readonly kernelId: string;
  readonly schema: string;
  readonly data: Readonly<Record<string, TopologyIdentityDatum>>;
}

/** A point or vector in canonical millimetres. */
export type ReferenceVector3 = readonly [number, number, number];

/**
 * The kernel-agnostic geometric descriptor of one topology entity, measured
 * in canonical millimetres and DUAL-ANCHORED: the experiments proved no
 * single position anchoring survives every harmless change — absolute
 * positions move under a rigid translation of the whole body, while
 * positions relative to the body's centre of mass drift when a topology
 * change moves that centre — so both are recorded:
 *
 * - `areaMm2` / `lengthMm` (the primary measure, invariant under rigid
 *   motion and topology change alike) is the repair heuristic's first key;
 * - `centroid*` / `point*` positions come in absolute AND body-relative
 *   pairs; the heuristic accepts a candidate whose position matches
 *   EITHER anchoring within its bound, and a candidate matching neither is
 *   not that entity.
 *
 * Fields present per kind: faces carry `areaMm2` + centroid pair, edges
 * `lengthMm` + centroid pair, vertices a point pair.
 */
export interface TopologyGeometryDescriptor {
  readonly areaMm2?: number;
  readonly lengthMm?: number;
  readonly centroidAbsoluteMm?: ReferenceVector3;
  readonly centroidRelativeMm?: ReferenceVector3;
  readonly pointAbsoluteMm?: ReferenceVector3;
  readonly pointRelativeMm?: ReferenceVector3;
}

/**
 * The provenance of a reference's owning body: the feature-graph path that
 * produced it — the producing feature plus its upstream feature ancestors,
 * in evaluation order. An imported body (STEP/BREP import provenance) has
 * NO producing feature and carries the empty path, which is intact by
 * definition.
 */
export interface ReferenceProvenance {
  readonly bodyId: BodyId;
  readonly featurePath: readonly FeatureId[];
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** Stable failure codes produced by the reference operations and parsers. */
export const REFERENCE_ERROR_CODES = {
  /** Input was not shaped like the expected reference construct. */
  notAReference: "reference/not-a-reference",
  /** A field of an otherwise-shaped construct was invalid. */
  fieldInvalid: "reference/field-invalid",
  /** A reference id did not parse as a `ref_…` id. */
  idInvalid: "reference/id-invalid",
  /** An addressed entity (body, producer, ordinal) does not exist. */
  unknownEntity: "reference/unknown-entity",
  /** A validity record was malformed for its own state. */
  stateInvalid: "reference/state-invalid",
  /** A validity transition the table does not allow. */
  transitionInvalid: "reference/transition-invalid",
  /** The owning body has more than one producing feature. */
  provenanceAmbiguous: "reference/provenance-ambiguous",
  /** Repair was attempted outside its documented precondition. */
  repairPrecondition: "reference/repair-precondition",
  /** Repair found no geometric candidate within its bounds. */
  repairNoCandidate: "reference/repair-no-candidate",
  /** Repair found several candidates and refuses to pick one. */
  repairAmbiguous: "reference/repair-ambiguous",
  /** The snapshot entity cannot back a persistent reference. */
  mintUnavailable: "reference/mint-unavailable",
} as const;

export type ReferenceErrorCode =
  (typeof REFERENCE_ERROR_CODES)[keyof typeof REFERENCE_ERROR_CODES];

/** Structured failure describing why a reference operation was rejected. */
export interface ReferenceError extends ParseFailure {
  readonly code: ReferenceErrorCode;
}

function referenceError(
  code: ReferenceErrorCode,
  message: string,
  input: unknown,
): ReferenceError {
  return { code, message, input };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// ---------------------------------------------------------------------------
// Identity and geometry comparison
// ---------------------------------------------------------------------------

/**
 * Whether two identity payloads are the same payload: same kernel, same
 * schema, and the same data record (same keys, `===` values). This is the
 * exact-match rule of resolution and of within-snapshot occurrence collapse.
 */
export function topologyIdentityPayloadEqual(
  a: TopologyIdentityPayload,
  b: TopologyIdentityPayload,
): boolean {
  if (a.kernelId !== b.kernelId || a.schema !== b.schema) return false;
  const aKeys = Object.keys(a.data);
  const bKeys = Object.keys(b.data);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (a.data[key] !== b.data[key]) return false;
  }
  return true;
}

/**
 * Relative tolerance for area/length comparison in repair: OCCT integrates
 * areas exactly (rebuild-measured bitwise equality; serialization drift
 * measured at ~3e-16 relative), so 1e-9 bounds honest equality with orders
 * of magnitude of margin.
 */
export const REFERENCE_MEASURE_RELATIVE_TOLERANCE = 1e-9;

/**
 * Absolute tolerance (mm) for comparing body-relative centroids and vertex
 * positions in repair: rebuild-measured bitwise equality, translation-
 * measured exact shifts, so a micrometre bounds honest equality generously.
 */
export const REFERENCE_POSITION_TOLERANCE_MM = 1e-6;

function measureClose(a: number, b: number): boolean {
  const scale = Math.max(Math.abs(a), Math.abs(b));
  if (scale === 0) return true;
  return Math.abs(a - b) / scale <= REFERENCE_MEASURE_RELATIVE_TOLERANCE;
}

function vectorClose(a: ReferenceVector3, b: ReferenceVector3): boolean {
  return (
    Math.abs(a[0] - b[0]) <= REFERENCE_POSITION_TOLERANCE_MM &&
    Math.abs(a[1] - b[1]) <= REFERENCE_POSITION_TOLERANCE_MM &&
    Math.abs(a[2] - b[2]) <= REFERENCE_POSITION_TOLERANCE_MM
  );
}

/**
 * Whether a snapshot entity's geometry matches the reference's descriptor
 * under the documented bounds: EVERY field the reference records must match
 * (area/length relative, vectors by the position rule below), so an
 * omitted field does not constrain and a recorded field always does.
 * Position fields use the dual-anchoring rule of
 * {@link positionMatches} (either anchoring within bound).
 */
export function topologyGeometryMatches(
  reference: TopologyGeometryDescriptor,
  candidate: TopologyGeometryDescriptor,
): boolean {
  if (reference.areaMm2 !== undefined) {
    if (candidate.areaMm2 === undefined) return false;
    if (!measureClose(reference.areaMm2, candidate.areaMm2)) return false;
  }
  if (reference.lengthMm !== undefined) {
    if (candidate.lengthMm === undefined) return false;
    if (!measureClose(reference.lengthMm, candidate.lengthMm)) return false;
  }
  return positionMatches(reference, candidate);
}

/**
 * The dual-anchoring position rule: a candidate's position matches when it
 * matches within {@link REFERENCE_POSITION_TOLERANCE_MM} under EITHER
 * anchoring the reference records — absolute (unchanged when a topology
 * change elsewhere in the body leaves this entity in place) or
 * body-relative (unchanged when the whole body moves rigidly). A reference
 * recording no position field constrains nothing; a candidate matching
 * neither recorded anchoring is not that entity.
 */
export function positionMatches(
  reference: TopologyGeometryDescriptor,
  candidate: TopologyGeometryDescriptor,
): boolean {
  const absolute =
    (reference.centroidAbsoluteMm !== undefined &&
      candidate.centroidAbsoluteMm !== undefined &&
      vectorClose(
        reference.centroidAbsoluteMm,
        candidate.centroidAbsoluteMm,
      )) ||
    (reference.pointAbsoluteMm !== undefined &&
      candidate.pointAbsoluteMm !== undefined &&
      vectorClose(reference.pointAbsoluteMm, candidate.pointAbsoluteMm));
  const relative =
    (reference.centroidRelativeMm !== undefined &&
      candidate.centroidRelativeMm !== undefined &&
      vectorClose(
        reference.centroidRelativeMm,
        candidate.centroidRelativeMm,
      )) ||
    (reference.pointRelativeMm !== undefined &&
      candidate.pointRelativeMm !== undefined &&
      vectorClose(reference.pointRelativeMm, candidate.pointRelativeMm));
  const recorded =
    reference.centroidAbsoluteMm !== undefined ||
    reference.pointAbsoluteMm !== undefined ||
    reference.centroidRelativeMm !== undefined ||
    reference.pointRelativeMm !== undefined;
  if (!recorded) return true;
  return absolute || relative;
}

/**
 * The repair heuristic's narrowing chain, deterministic at every step: the
 * primary measure first (area for a face, length for an edge — invariant
 * under rigid motion and topology change alike), then the dual-anchoring
 * position rule ALWAYS as a gate — both to distinguish equal-measure
 * candidates and to refuse an equal-measure candidate that moved, like a
 * destroyed top face whose equal-area bottom twin survives (matching it
 * silently is exactly the wrong-entity resolution the model forbids).
 * Decision: position always gates, even an already-unique primary match —
 * an entity that preserved its measure but moved under BOTH anchorings is
 * plausibly a DIFFERENT entity, and silent re-attach across a move is the
 * ambiguity trap this model exists to avoid; the refusal keeps the
 * reference missing for the caller to resolve deliberately.
 */
function narrowGeometryCandidates(
  reference: TopologyGeometryDescriptor,
  candidates: readonly TopologyEntitySnapshot[],
): readonly TopologyEntitySnapshot[] {
  let narrowed = candidates;
  const { areaMm2, lengthMm } = reference;
  if (areaMm2 !== undefined) {
    narrowed = narrowed.filter(
      (entity) =>
        entity.geometry.areaMm2 !== undefined &&
        measureClose(areaMm2, entity.geometry.areaMm2),
    );
  }
  if (lengthMm !== undefined) {
    narrowed = narrowed.filter(
      (entity) =>
        entity.geometry.lengthMm !== undefined &&
        measureClose(lengthMm, entity.geometry.lengthMm),
    );
  }
  return narrowed.filter((entity) =>
    positionMatches(reference, entity.geometry),
  );
}

/**
 * Whether a descriptor carries its kind's PRIMARY measure — the field the
 * repair heuristic keys on first (area for a face, length for an edge, a
 * positioned point for a vertex). A descriptor without it cannot be
 * re-anchored and cannot back a persistent reference.
 */
function missingPrimaryMeasure(
  kind: TopologyReferenceKind,
  descriptor: TopologyGeometryDescriptor,
): boolean {
  if (kind === "face") return descriptor.areaMm2 === undefined;
  if (kind === "edge") return descriptor.lengthMm === undefined;
  return (
    descriptor.pointAbsoluteMm === undefined &&
    descriptor.pointRelativeMm === undefined
  );
}

// ---------------------------------------------------------------------------
// The reference
// ---------------------------------------------------------------------------

/** The deterministic repair strategies, recorded in repair records. */
export const REFERENCE_REPAIR_STRATEGIES = [
  /**
   * Identity matched against the re-executed provenance path's topology —
   * the lineage case the experiments measured (untouched faces keep their
   * kernel identity when no rebuild intervened).
   */
  "provenance-identity",
  /**
   * The documented geometric heuristic re-anchored the reference: area or
   * length within {@link REFERENCE_MEASURE_RELATIVE_TOLERANCE} relative and
   * body-relative position within {@link REFERENCE_POSITION_TOLERANCE_MM}.
   */
  "geometric-reattach",
  /** The caller explicitly picked one of an ambiguous reference's candidates. */
  "disambiguated",
] as const;

export type ReferenceRepairStrategy =
  (typeof REFERENCE_REPAIR_STRATEGIES)[number];

/** Runtime membership set behind {@link isReferenceRepairStrategy}. */
const REPAIR_STRATEGY_SET: ReadonlySet<string> = new Set(
  REFERENCE_REPAIR_STRATEGIES,
);

/** Whether `strategy` is one of the repair strategies. */
export function isReferenceRepairStrategy(
  strategy: string,
): strategy is ReferenceRepairStrategy {
  return REPAIR_STRATEGY_SET.has(strategy);
}

/** One end of a repair record: what the reference was anchored to, and when. */
export interface ReferenceAnchor {
  readonly identity: TopologyIdentityPayload;
  readonly geometry: TopologyGeometryDescriptor;
  readonly regeneration: number;
  /** The snapshot ordinal the anchor addresses, when the anchor resolves. */
  readonly ordinal?: number;
}

/** The explicit old→new record a repair produces — repair is data. */
export interface ReferenceRepairRecord {
  readonly strategy: ReferenceRepairStrategy;
  readonly from: ReferenceAnchor;
  readonly to: ReferenceAnchor;
}

/** The validity state of a reference, as explicit data. */
export interface ReferenceValidityRecord {
  readonly state: ReferenceValidity;
  /** The regeneration this record was measured against. */
  readonly regeneration: number;
  /** valid/repaired: the snapshot ordinal the reference resolves to. */
  readonly ordinal?: number;
  /** ambiguous: every matching ordinal, in snapshot order. */
  readonly candidates?: readonly number[];
  /** invalid: the structural reason. */
  readonly reason?: ReferenceInvalidReason;
  /** repaired: the explicit old→new record. */
  readonly repair?: ReferenceRepairRecord;
}

/**
 * A persistent reference to a face, edge, or vertex of a body's current
 * regeneration topology. Immutable data: minting, resolution, repair, and
 * disambiguation all return new references.
 */
export interface TopologyEntityReference {
  readonly id: ReferenceId;
  readonly kind: TopologyReferenceKind;
  readonly bodyId: BodyId;
  readonly provenance: ReferenceProvenance;
  readonly identity: TopologyIdentityPayload;
  readonly geometry: TopologyGeometryDescriptor;
  readonly validity: ReferenceValidityRecord;
}

/**
 * Any entity a persistent reference can address: feature, body, and solid
 * through their stable document ids (existing since the document model —
 * `body_…`, `feat_…`; a solid reference addresses its body's current
 * regeneration result), and topology through
 * {@link TopologyEntityReference}.
 */
export type PersistentEntityReference =
  | { readonly kind: "feature"; readonly featureId: FeatureId }
  | { readonly kind: "body"; readonly bodyId: BodyId }
  | { readonly kind: "solid"; readonly bodyId: BodyId }
  | TopologyEntityReference;

// ---------------------------------------------------------------------------
// Validity transitions
// ---------------------------------------------------------------------------

/**
 * The allowed validity transitions (see the module doc). `valid → repaired`
 * is deliberately absent: repair requires the identity to have died first
 * (missing) or collided (ambiguous). `invalid` is terminal.
 */
const ALLOWED_VALIDITY_TRANSITIONS: Readonly<
  Record<ReferenceValidity, ReadonlySet<ReferenceValidity>>
> = Object.freeze({
  valid: new Set<ReferenceValidity>([
    "valid",
    "missing",
    "ambiguous",
    "invalid",
  ]),
  missing: new Set<ReferenceValidity>([
    "valid",
    "missing",
    "ambiguous",
    "invalid",
    "repaired",
  ]),
  ambiguous: new Set<ReferenceValidity>([
    "valid",
    "missing",
    "ambiguous",
    "invalid",
    "repaired",
  ]),
  invalid: new Set<ReferenceValidity>(["invalid"]),
  repaired: new Set<ReferenceValidity>([
    "valid",
    "missing",
    "ambiguous",
    "invalid",
    "repaired",
  ]),
});

function isValidityRecordWellFormed(
  record: ReferenceValidityRecord,
): ReferenceError | undefined {
  const invalid = (message: string): ReferenceError =>
    referenceError(
      REFERENCE_ERROR_CODES.stateInvalid,
      `A ${record.state} validity record is malformed: ${message}`,
      record,
    );
  if (!isNonNegativeInteger(record.regeneration)) {
    return invalid("regeneration must be a non-negative integer.");
  }
  switch (record.state) {
    case "valid":
      return record.ordinal === undefined
        ? invalid("a valid record names its ordinal.")
        : undefined;
    case "missing":
      return undefined;
    case "ambiguous":
      return record.candidates === undefined || record.candidates.length < 2
        ? invalid("an ambiguous record lists at least two candidates.")
        : undefined;
    case "invalid":
      return record.reason === undefined
        ? invalid("an invalid record names its reason.")
        : undefined;
    case "repaired":
      return record.repair === undefined || record.ordinal === undefined
        ? invalid("a repaired record carries its repair record and ordinal.")
        : undefined;
  }
}

/**
 * Moves a reference to a new validity state. The record must be well formed
 * for its own state and the transition must be allowed by the table —
 * `reference/transition-invalid` otherwise. The input reference is never
 * mutated; the result is frozen.
 */
export function applyReferenceValidity(
  reference: TopologyEntityReference,
  record: ReferenceValidityRecord,
): ParseResult<TopologyEntityReference, ReferenceError> {
  const malformed = isValidityRecordWellFormed(record);
  if (malformed !== undefined) return fail(malformed);
  const allowed = ALLOWED_VALIDITY_TRANSITIONS[reference.validity.state];
  if (!allowed.has(record.state)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.transitionInvalid,
        `A ${reference.validity.state} reference cannot transition to ${record.state} (allowed: ${[...allowed].join(", ")}).`,
        record,
      ),
    );
  }
  return ok(Object.freeze({ ...reference, validity: Object.freeze(record) }));
}

// ---------------------------------------------------------------------------
// The topology snapshot protocol (kernel-neutral)
// ---------------------------------------------------------------------------

/**
 * One topology entity of a body's current regeneration, as the resolving
 * kernel reports it: its exploration ordinal (occurrence-collapsed — the
 * experiments measured every edge appearing twice in a solid's exploration,
 * once per adjacent face, with the SAME identity), its kernel identity
 * payload (or null when the kernel cannot label topology at all), and its
 * body-relative geometric descriptor. Ordinals number WITHIN the entity's
 * kind — each kind's exploration starts at 0 — so `(kind, ordinal)` is an
 * entity's address in a snapshot, never the ordinal alone.
 */
export interface TopologyEntitySnapshot {
  readonly kind: TopologyReferenceKind;
  readonly ordinal: number;
  readonly identity: TopologyIdentityPayload | null;
  readonly geometry: TopologyGeometryDescriptor;
}

/**
 * A body's current regeneration topology in kernel-neutral form, produced
 * by a persistent-topology kernel: identity schemas it mints, the
 * regeneration measured, the owning body, and the entities in stable
 * ordinal order. Serializable evidence — the resolving kernel's report.
 */
export interface TopologySnapshot {
  readonly kernelId: string;
  readonly persistentTopology: boolean;
  readonly identitySchemas: readonly string[];
  readonly bodyId: BodyId;
  readonly regeneration: number;
  readonly entities: readonly TopologyEntitySnapshot[];
}

/**
 * The resolution protocol's kernel-side interface: which kernel is
 * resolving, whether it persists topology at all, which identity schemas it
 * understands, and the current snapshot of a body's topology (null when the
 * body has no current regeneration result). Kernels implementing this
 * interface live outside cad-core — `cad-kernel-occt` ships the persistent
 * (OCCT) implementation; a `persistentTopology: false` kernel implements it
 * with an empty-schema, null-snapshot stance and is reported honestly as
 * `kernel-transient-topology`.
 */
export interface TopologyView {
  readonly kernelId: string;
  readonly persistentTopology: boolean;
  readonly identitySchemas: readonly string[];
  snapshotOf(bodyId: BodyId): TopologySnapshot | null;
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * Derives the provenance of a body from the document: the feature whose
 * outputs include the body, plus every upstream feature reachable through
 * feature-kind inputs, in evaluation order. An imported body (no producing
 * feature) yields the empty path. Fails when the body does not exist, or is
 * produced by more than one feature (`reference/provenance-ambiguous` — the
 * document model does not forbid shared outputs, so the ambiguity is
 * reported rather than guessed).
 */
export function referenceProvenance(
  document: CadDocument,
  bodyId: BodyId,
): ParseResult<ReferenceProvenance, ReferenceError> {
  if (getBody(document, bodyId) === undefined) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.unknownEntity,
        `No body "${bodyId}" exists in document "${document.id}".`,
        bodyId,
      ),
    );
  }
  const producers = document.features.filter((feature) =>
    feature.outputs.includes(bodyId),
  );
  if (producers.length > 1) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.provenanceAmbiguous,
        `Body "${bodyId}" is produced by ${producers.length} features (${producers.map((feature) => feature.id).join(", ")}); a reference's provenance must be unambiguous.`,
        bodyId,
      ),
    );
  }
  const producer = producers[0];
  if (producer === undefined) {
    return ok(Object.freeze({ bodyId, featurePath: Object.freeze([]) }));
  }
  // Collect the producer plus its transitive feature ancestors.
  const upstream = new Set<FeatureId>([producer.id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const feature of document.features) {
      if (!upstream.has(feature.id)) continue;
      for (const ref of feature.inputs) {
        if (ref.kind === "feature" && !upstream.has(ref.id)) {
          upstream.add(ref.id);
          grew = true;
        }
      }
    }
  }
  const ordered = featureEvaluationOrder(document.features);
  if (!ordered.ok)
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.provenanceAmbiguous,
        `The feature graph behind body "${bodyId}" has no evaluation order: ${ordered.error.message}`,
        bodyId,
      ),
    );
  const featurePath = ordered.value.filter((id) => upstream.has(id));
  return ok(Object.freeze({ bodyId, featurePath: Object.freeze(featurePath) }));
}

/**
 * Whether a provenance path still leads to its body: the body exists, every
 * feature on the path exists, and the path's last feature still outputs the
 * body. The empty path (imported geometry) is intact exactly while the body
 * exists.
 */
export function provenanceIntact(
  document: CadDocument,
  provenance: ReferenceProvenance,
): boolean {
  if (getBody(document, provenance.bodyId) === undefined) return false;
  const { featurePath } = provenance;
  if (featurePath.length === 0) return true;
  const lastId = featurePath[featurePath.length - 1];
  if (lastId === undefined) return false;
  for (const id of featurePath) {
    if (!document.features.some((feature) => feature.id === id)) return false;
  }
  const last = document.features.find((feature) => feature.id === lastId);
  return last !== undefined && last.outputs.includes(provenance.bodyId);
}

// ---------------------------------------------------------------------------
// Minting
// ---------------------------------------------------------------------------

/** Options of {@link mintTopologyReference}. */
export interface MintReferenceOptions {
  /**
   * The reference's stable `ref_…` id. Ids are caller-owned: derive one
   * from the document's id generator (`createIdGenerator(state).nextReferenceId()`)
   * so persisted references never collide.
   */
  readonly id: ReferenceId;
  /**
   * The kind of the entity `ordinal` addresses. Ordinals number WITHIN a
   * kind (a snapshot's producer explores faces, edges, and vertices each
   * from 0 — the OCCT producer measures exactly that), so an ordinal alone
   * cannot name an entity on a multi-kind snapshot: `kind` is required,
   * never defaulted, because no default could be unambiguous when the same
   * ordinal is live in several kinds at once.
   */
  readonly kind: TopologyReferenceKind;
}

/**
 * Mints a persistent reference to the snapshot entity of `options.kind` at
 * `ordinal`: the entity must exist within that kind's numbering (`(kind,
 * ordinal)` is the address — an ordinal that exists only in another kind's
 * numbering is `reference/unknown-entity`), carry an identity payload (a
 * kernel that cannot label topology cannot back a persistent reference),
 * and carry at least one geometric field (identity alone dies at every
 * rebuild — the experiments' headline finding — so a persistent reference
 * always records its re-anchor data). The minted reference stands `valid`
 * at the snapshot's regeneration.
 */
export function mintTopologyReference(
  snapshot: TopologySnapshot,
  ordinal: number,
  provenance: ReferenceProvenance,
  options: MintReferenceOptions,
): ParseResult<TopologyEntityReference, ReferenceError> {
  const entity = snapshot.entities.find(
    (candidate) =>
      candidate.kind === options.kind && candidate.ordinal === ordinal,
  );
  if (entity === undefined) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.unknownEntity,
        `The snapshot of body "${snapshot.bodyId}" at regeneration ${String(snapshot.regeneration)} has no ${options.kind} at ordinal ${String(ordinal)}.`,
        ordinal,
      ),
    );
  }
  if (entity.identity === null) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.mintUnavailable,
        `The ${entity.kind} at ordinal ${String(ordinal)} carries no identity payload; a kernel that cannot label topology cannot back a persistent reference.`,
        entity,
      ),
    );
  }
  if (missingPrimaryMeasure(entity.kind, entity.geometry)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.mintUnavailable,
        `The ${entity.kind} at ordinal ${String(ordinal)} carries no ${entity.kind === "vertex" ? "positioned point" : entity.kind === "face" ? "area" : "length"}; a persistent reference records its re-anchor measure at mint time.`,
        entity,
      ),
    );
  }
  return ok(
    Object.freeze({
      id: options.id,
      kind: entity.kind,
      bodyId: snapshot.bodyId,
      provenance,
      identity: entity.identity,
      geometry: entity.geometry,
      validity: Object.freeze({
        state: "valid",
        regeneration: snapshot.regeneration,
        ordinal,
      }),
    }),
  );
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** Options of {@link resolveDocumentReference}. */
export interface ResolveReferenceOptions {
  /**
   * Whether to re-check the reference's provenance against the document
   * (default `true`); callers that validated provenance separately may
   * disable the check.
   */
  readonly checkProvenance?: boolean;
}

function recordOf(
  state: ReferenceValidity,
  regeneration: number,
  fields: Omit<ReferenceValidityRecord, "state" | "regeneration"> = {},
): ReferenceValidityRecord {
  return Object.freeze({ state, regeneration, ...fields });
}

/**
 * Resolves a reference against one body's current snapshot — the pure core
 * of the protocol. The snapshot's body must match the reference's
 * (`reference/field-invalid` otherwise). Outcomes as validity data:
 *
 * - one same-kind entity with an equal identity payload → `valid`;
 * - several (a real payload collision — the experiments produced them from
 *   one TShape appearing twice) → `ambiguous` with every candidate — NEVER
 *   a silent pick;
 * - none (the identity died with its lineage, the experiments' rebuild
 *   finding) → `missing` — repair is the explicit way forward;
 * - a non-persistent snapshot → `invalid`/`kernel-transient-topology`;
 * - a foreign kernel or unknown schema → `invalid`/`kernel-mismatch`,
 *   `invalid`/`schema-unknown`.
 */
export function resolveTopologyReference(
  reference: TopologyEntityReference,
  snapshot: TopologySnapshot | null,
): ParseResult<TopologyEntityReference, ReferenceError> {
  if (snapshot !== null && snapshot.bodyId !== reference.bodyId) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        `The snapshot describes body "${snapshot.bodyId}", but the reference addresses body "${reference.bodyId}".`,
        snapshot,
      ),
    );
  }
  if (snapshot === null) {
    return applyReferenceValidity(
      reference,
      recordOf("missing", reference.validity.regeneration),
    );
  }
  if (!snapshot.persistentTopology) {
    return applyReferenceValidity(
      reference,
      recordOf("invalid", snapshot.regeneration, {
        reason: "kernel-transient-topology",
      }),
    );
  }
  if (snapshot.kernelId !== reference.identity.kernelId) {
    return applyReferenceValidity(
      reference,
      recordOf("invalid", snapshot.regeneration, {
        reason: "kernel-mismatch",
      }),
    );
  }
  if (
    !snapshot.identitySchemas.some(
      (schema) => schema === reference.identity.schema,
    )
  ) {
    return applyReferenceValidity(
      reference,
      recordOf("invalid", snapshot.regeneration, {
        reason: "schema-unknown",
      }),
    );
  }
  const candidates = snapshot.entities
    .filter(
      (entity) =>
        entity.kind === reference.kind &&
        entity.identity !== null &&
        topologyIdentityPayloadEqual(entity.identity, reference.identity),
    )
    .map((entity) => entity.ordinal);
  if (candidates.length === 1) {
    const ordinal = candidates[0];
    if (ordinal === undefined) {
      return fail(
        referenceError(
          REFERENCE_ERROR_CODES.stateInvalid,
          "Invariant violation: a single candidate always carries its ordinal.",
          candidates,
        ),
      );
    }
    return applyReferenceValidity(
      reference,
      recordOf("valid", snapshot.regeneration, { ordinal }),
    );
  }
  if (candidates.length > 1) {
    return applyReferenceValidity(
      reference,
      recordOf("ambiguous", snapshot.regeneration, { candidates }),
    );
  }
  return applyReferenceValidity(
    reference,
    recordOf("missing", snapshot.regeneration),
  );
}

/**
 * The document-level resolution protocol: checks the owning body and the
 * provenance path against the document first (absent body → `invalid`/
 * `body-absent`; broken provenance → `invalid`/`provenance-broken`, both
 * terminal), then resolves against the view's snapshot of the body —
 * kernel-capability gated through the view itself.
 */
export function resolveDocumentReference(
  document: CadDocument,
  reference: TopologyEntityReference,
  view: TopologyView,
  options: ResolveReferenceOptions = {},
): ParseResult<TopologyEntityReference, ReferenceError> {
  if (getBody(document, reference.bodyId) === undefined) {
    return applyReferenceValidity(
      reference,
      recordOf("invalid", reference.validity.regeneration, {
        reason: "body-absent",
      }),
    );
  }
  if (
    options.checkProvenance !== false &&
    !provenanceIntact(document, reference.provenance)
  ) {
    return applyReferenceValidity(
      reference,
      recordOf("invalid", reference.validity.regeneration, {
        reason: "provenance-broken",
      }),
    );
  }
  const snapshot = view.snapshotOf(reference.bodyId);
  if (snapshot === null && !view.persistentTopology) {
    // A kernel that persists no topology reports honestly regardless of
    // whether the body currently has a solid.
    return applyReferenceValidity(
      reference,
      recordOf("invalid", reference.validity.regeneration, {
        reason: "kernel-transient-topology",
      }),
    );
  }
  return resolveTopologyReference(reference, snapshot);
}

// ---------------------------------------------------------------------------
// Repair (bounded, explicit) and disambiguation
// ---------------------------------------------------------------------------

/** Options of {@link repairTopologyReference}. */
export interface RepairReferenceOptions {
  /**
   * The re-executed provenance path's snapshot — what the feature path
   * produced when re-run. The identity-first strategy matches against it
   * (the lineage case: within one kernel process, untouched faces keep
   * their identity) and anchors to it whole, carrying ITS regeneration
   * into the repaired record (a divergent regeneration is anchored
   * coherently, never mixed with the current snapshot's); the geometric
   * strategy then matches against the current snapshot. Callers pass the
   * current regeneration's snapshot when no separate re-execution exists.
   */
  readonly reexecuted?: TopologySnapshot;
}

function anchorOf(reference: TopologyEntityReference): ReferenceAnchor {
  return {
    identity: reference.identity,
    geometry: reference.geometry,
    regeneration: reference.validity.regeneration,
    ordinal: reference.validity.ordinal,
  };
}

/**
 * Repairs a `missing` reference — re-anchoring is EXPLICIT data, never a
 * silent side effect of resolution. Two deterministic, ordered strategies:
 *
 * 1. `provenance-identity` — exactly one same-kind entity of the
 *    re-executed snapshot (when provided) carries an equal identity
 *    payload; the repair anchors to it WHOLE — its identity, geometry,
 *    ordinal, AND regeneration all come from the re-executed snapshot, so
 *    a divergent re-execution (a different regeneration than the current
 *    snapshot's) still yields a coherent anchor;
 * 2. `geometric-reattach` — the ordered narrowing chain over the current
 *    snapshot's same-kind entities: the primary measure first (area for a
 *    face, length for an edge, position for a vertex, within 1e-9
 *    relative), body-relative position afterwards (within 1e-6 mm), which
 *    ALWAYS gates — it breaks ties among equal-measure candidates AND
 *    refuses an equal-measure candidate that moved under both anchorings,
 *    because an entity that preserved its measure but moved is plausibly a
 *    different entity and silent re-attach across a move is the ambiguity
 *    trap this model forbids (see {@link narrowGeometryCandidates}).
 *
 * Refusals are structured, never guesses: several candidates →
 * `reference/repair-ambiguous` carrying the candidates; none →
 * `reference/repair-no-candidate` (the reference stays missing — explicit
 * invalidation). Precondition: the reference stands `missing`; an
 * `ambiguous` reference must be disambiguated explicitly instead.
 */
export function repairTopologyReference(
  reference: TopologyEntityReference,
  snapshot: TopologySnapshot,
  options: RepairReferenceOptions = {},
): ParseResult<TopologyEntityReference, ReferenceError> {
  if (reference.validity.state !== "missing") {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.repairPrecondition,
        `Repair requires a missing reference; this one stands ${reference.validity.state}.`,
        reference,
      ),
    );
  }
  if (missingPrimaryMeasure(reference.kind, reference.geometry)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.repairPrecondition,
        `Repair requires a ${reference.kind} reference with its primary measure recorded; without it every entity would match.`,
        reference,
      ),
    );
  }
  // Strategy 1: identity match against the re-executed provenance topology.
  if (options.reexecuted !== undefined) {
    const reexecuted = options.reexecuted;
    if (reexecuted.bodyId !== reference.bodyId) {
      return fail(
        referenceError(
          REFERENCE_ERROR_CODES.fieldInvalid,
          `The re-executed snapshot describes body "${reexecuted.bodyId}", but the reference addresses body "${reference.bodyId}".`,
          reexecuted,
        ),
      );
    }
    const identityCandidates = reexecuted.entities.filter(
      (entity) =>
        entity.kind === reference.kind &&
        entity.identity !== null &&
        topologyIdentityPayloadEqual(entity.identity, reference.identity),
    );
    if (identityCandidates.length === 1) {
      const entity = identityCandidates[0];
      if (entity === undefined) {
        return fail(
          referenceError(
            REFERENCE_ERROR_CODES.stateInvalid,
            "Invariant violation: a single candidate always exists.",
            identityCandidates,
          ),
        );
      }
      // The new anchor is the re-executed topology's entity, so its
      // regeneration is the re-executed snapshot's — identity, geometry,
      // ordinal, and regeneration must describe ONE topology, or a repaired
      // reference's coordinates (transientSelectionOf) would address a
      // regeneration whose topology never carried them.
      return repaired(
        reference,
        entity,
        "provenance-identity",
        reexecuted.regeneration,
      );
    }
  }
  // Strategy 2: the documented geometric heuristic against current topology —
  // the ordered narrowing chain (primary measure first, position ALWAYS
  // gating; see narrowGeometryCandidates for why an equal-measure candidate
  // that moved under both anchorings must be refused, not re-attached).
  const candidates = narrowGeometryCandidates(
    reference.geometry,
    snapshot.entities.filter((entity) => entity.kind === reference.kind),
  );
  if (candidates.length > 1) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.repairAmbiguous,
        `Repair found ${candidates.length} geometric candidates (ordinals ${candidates.map((entity) => String(entity.ordinal)).join(", ")}) and refuses to pick one; disambiguate explicitly.`,
        candidates.map((entity) => entity.ordinal),
      ),
    );
  }
  const only = candidates[0];
  if (only === undefined) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.repairNoCandidate,
        "Repair found no entity matching the reference's recorded geometry within its bounds; the reference stays missing.",
        reference.geometry,
      ),
    );
  }
  return repaired(reference, only, "geometric-reattach", snapshot.regeneration);
}

function repaired(
  reference: TopologyEntityReference,
  entity: TopologyEntitySnapshot,
  strategy: ReferenceRepairStrategy,
  regeneration: number,
): ParseResult<TopologyEntityReference, ReferenceError> {
  if (entity.identity === null) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.repairNoCandidate,
        `The ${entity.kind} at ordinal ${String(entity.ordinal)} carries no identity payload and cannot back a repair.`,
        entity,
      ),
    );
  }
  const to: ReferenceAnchor = {
    identity: entity.identity,
    geometry: entity.geometry,
    regeneration,
    ordinal: entity.ordinal,
  };
  return applyReferenceValidity(
    Object.freeze({
      ...reference,
      identity: entity.identity,
      geometry: entity.geometry,
    }),
    recordOf("repaired", regeneration, {
      ordinal: entity.ordinal,
      repair: Object.freeze({
        strategy,
        from: Object.freeze(anchorOf(reference)),
        to: Object.freeze(to),
      }),
    }),
  );
}

/**
 * The explicit way out of `ambiguous`: the caller picks one of the recorded
 * candidates (it must be among them), producing a repaired reference whose
 * strategy records the deliberate choice. The model never resolves an
 * ambiguous reference on its own.
 */
export function disambiguateTopologyReference(
  reference: TopologyEntityReference,
  ordinal: number,
): ParseResult<TopologyEntityReference, ReferenceError> {
  if (reference.validity.state !== "ambiguous") {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.repairPrecondition,
        `Disambiguation requires an ambiguous reference; this one stands ${reference.validity.state}.`,
        reference,
      ),
    );
  }
  const candidates = reference.validity.candidates ?? [];
  if (!candidates.includes(ordinal)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.stateInvalid,
        `Ordinal ${String(ordinal)} is not among the reference's candidates (${candidates.map(String).join(", ")}).`,
        ordinal,
      ),
    );
  }
  // The candidate's identity equals the reference's by construction —
  // ambiguity came from an identity collision — so the anchors differ only
  // in ordinal.
  const to: ReferenceAnchor = {
    identity: reference.identity,
    geometry: reference.geometry,
    regeneration: reference.validity.regeneration,
    ordinal,
  };
  return applyReferenceValidity(
    reference,
    recordOf("repaired", reference.validity.regeneration, {
      ordinal,
      repair: Object.freeze({
        strategy: "disambiguated",
        from: Object.freeze(anchorOf(reference)),
        to: Object.freeze(to),
      }),
    }),
  );
}

// ---------------------------------------------------------------------------
// The Phase 12 bridge (one model, both stances)
// ---------------------------------------------------------------------------

/** The synthetic selection reference a topology reference maps to. */
export type TransientSelectionReference =
  FaceSelectionReference | EdgeSelectionReference | VertexSelectionReference;

/**
 * Maps a RESOLVED persistent reference (valid or repaired) to the Phase 12
 * synthetic selection reference of the current regeneration — the same
 * `{ kind, bodyId, regeneration, index }` data the transient selection
 * model uses. This is the bridge that unifies the two stances: on a
 * persistent-topology kernel, a persistent reference resolves into the
 * current regeneration's synthetic coordinates; on a transient kernel, the
 * synthetic reference (with its one-regeneration validity rule) is all that
 * ever existed. Unresolved references fail — a missing or ambiguous
 * reference has no coordinates to give.
 */
export function transientSelectionOf(
  reference: TopologyEntityReference,
): ParseResult<TransientSelectionReference, ReferenceError> {
  const { state } = reference.validity;
  if (state !== "valid" && state !== "repaired") {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.stateInvalid,
        `Only a resolved reference maps to a synthetic selection; this one stands ${state}.`,
        reference,
      ),
    );
  }
  const ordinal = reference.validity.ordinal;
  if (ordinal === undefined) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.stateInvalid,
        `A ${state} record always names its ordinal.`,
        reference.validity,
      ),
    );
  }
  const regeneration = reference.validity.regeneration;
  switch (reference.kind) {
    case "face":
      return ok({
        kind: "face",
        bodyId: reference.bodyId,
        regeneration,
        faceIndex: ordinal,
      });
    case "edge":
      return ok({
        kind: "edge",
        bodyId: reference.bodyId,
        regeneration,
        edgeIndex: ordinal,
      });
    case "vertex":
      return ok({
        kind: "vertex",
        bodyId: reference.bodyId,
        regeneration,
        vertexIndex: ordinal,
      });
  }
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

function serializeVector(vector: ReferenceVector3): [number, number, number] {
  return [vector[0], vector[1], vector[2]];
}

function serializeGeometry(
  geometry: TopologyGeometryDescriptor,
): SerializedTopologyGeometryDescriptor {
  return {
    ...(geometry.areaMm2 !== undefined ? { areaMm2: geometry.areaMm2 } : {}),
    ...(geometry.lengthMm !== undefined ? { lengthMm: geometry.lengthMm } : {}),
    ...(geometry.centroidAbsoluteMm !== undefined
      ? { centroidAbsoluteMm: serializeVector(geometry.centroidAbsoluteMm) }
      : {}),
    ...(geometry.centroidRelativeMm !== undefined
      ? { centroidRelativeMm: serializeVector(geometry.centroidRelativeMm) }
      : {}),
    ...(geometry.pointAbsoluteMm !== undefined
      ? { pointAbsoluteMm: serializeVector(geometry.pointAbsoluteMm) }
      : {}),
    ...(geometry.pointRelativeMm !== undefined
      ? { pointRelativeMm: serializeVector(geometry.pointRelativeMm) }
      : {}),
  };
}

function serializeIdentity(
  identity: TopologyIdentityPayload,
): SerializedTopologyIdentityPayload {
  const data: Record<string, TopologyIdentityDatum> = {};
  for (const [key, value] of Object.entries(identity.data)) {
    data[key] = value;
  }
  return { kernelId: identity.kernelId, schema: identity.schema, data };
}

function serializeAnchor(anchor: ReferenceAnchor): SerializedReferenceAnchor {
  return {
    identity: serializeIdentity(anchor.identity),
    geometry: serializeGeometry(anchor.geometry),
    regeneration: anchor.regeneration,
    ...(anchor.ordinal !== undefined ? { ordinal: anchor.ordinal } : {}),
  };
}

/** Fixed-key-order JSON form of a geometry descriptor. */
export interface SerializedTopologyGeometryDescriptor {
  readonly areaMm2?: number;
  readonly lengthMm?: number;
  readonly centroidAbsoluteMm?: readonly [number, number, number];
  readonly centroidRelativeMm?: readonly [number, number, number];
  readonly pointAbsoluteMm?: readonly [number, number, number];
  readonly pointRelativeMm?: readonly [number, number, number];
}

/** Fixed-key-order JSON form of an identity payload. */
export interface SerializedTopologyIdentityPayload {
  readonly kernelId: string;
  readonly schema: string;
  readonly data: Readonly<Record<string, TopologyIdentityDatum>>;
}

/** Fixed-key-order JSON form of a repair anchor. */
export interface SerializedReferenceAnchor {
  readonly identity: SerializedTopologyIdentityPayload;
  readonly geometry: SerializedTopologyGeometryDescriptor;
  readonly regeneration: number;
  readonly ordinal?: number;
}

/** Fixed-key-order JSON form of a repair record. */
export interface SerializedReferenceRepairRecord {
  readonly strategy: ReferenceRepairStrategy;
  readonly from: SerializedReferenceAnchor;
  readonly to: SerializedReferenceAnchor;
}

/** Fixed-key-order JSON form of a validity record. */
export interface SerializedReferenceValidityRecord {
  readonly state: ReferenceValidity;
  readonly regeneration: number;
  readonly ordinal?: number;
  readonly candidates?: readonly number[];
  readonly reason?: ReferenceInvalidReason;
  readonly repair?: SerializedReferenceRepairRecord;
}

/** Fixed-key-order JSON form of a provenance path. */
export interface SerializedReferenceProvenance {
  readonly bodyId: string;
  readonly featurePath: readonly string[];
}

/** Fixed-key-order JSON form of a {@link TopologyEntityReference}. */
export interface SerializedTopologyEntityReference {
  readonly id: string;
  readonly kind: TopologyReferenceKind;
  readonly bodyId: string;
  readonly provenance: SerializedReferenceProvenance;
  readonly identity: SerializedTopologyIdentityPayload;
  readonly geometry: SerializedTopologyGeometryDescriptor;
  readonly validity: SerializedReferenceValidityRecord;
}

/** Serializes a reference to its canonical fixed-key-order JSON form. */
export function serializeTopologyReference(
  reference: TopologyEntityReference,
): SerializedTopologyEntityReference {
  const { validity } = reference;
  return {
    id: reference.id,
    kind: reference.kind,
    bodyId: reference.bodyId,
    provenance: {
      bodyId: reference.provenance.bodyId,
      featurePath: [...reference.provenance.featurePath],
    },
    identity: serializeIdentity(reference.identity),
    geometry: serializeGeometry(reference.geometry),
    validity: {
      state: validity.state,
      regeneration: validity.regeneration,
      ...(validity.ordinal !== undefined ? { ordinal: validity.ordinal } : {}),
      ...(validity.candidates !== undefined
        ? { candidates: [...validity.candidates] }
        : {}),
      ...(validity.reason !== undefined ? { reason: validity.reason } : {}),
      ...(validity.repair !== undefined
        ? {
            repair: {
              strategy: validity.repair.strategy,
              from: serializeAnchor(validity.repair.from),
              to: serializeAnchor(validity.repair.to),
            },
          }
        : {}),
    },
  };
}

// --- parsing ---------------------------------------------------------------

function parseVector3(
  input: unknown,
  field: string,
): ParseResult<ReferenceVector3, ReferenceError> {
  if (
    !Array.isArray(input) ||
    input.length !== 3 ||
    !input.every(isFiniteNumber)
  ) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        `A reference's ${field} must be an array of exactly three finite numbers.`,
        input,
      ),
    );
  }
  const first = input[0];
  const second = input[1];
  const third = input[2];
  if (first === undefined || second === undefined || third === undefined) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        `A reference's ${field} must be dense.`,
        input,
      ),
    );
  }
  return ok([first, second, third]);
}

function parseGeometry(
  input: unknown,
): ParseResult<TopologyGeometryDescriptor, ReferenceError> {
  if (!isPlainRecord(input)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        "A reference's geometry must be a plain object.",
        input,
      ),
    );
  }
  const geometry: {
    areaMm2?: number;
    lengthMm?: number;
    centroidAbsoluteMm?: ReferenceVector3;
    centroidRelativeMm?: ReferenceVector3;
    pointAbsoluteMm?: ReferenceVector3;
    pointRelativeMm?: ReferenceVector3;
  } = {};
  if (input.areaMm2 !== undefined) {
    if (!isFiniteNumber(input.areaMm2)) {
      return fail(
        referenceError(
          REFERENCE_ERROR_CODES.fieldInvalid,
          "A reference's areaMm2 must be a finite number.",
          input.areaMm2,
        ),
      );
    }
    geometry.areaMm2 = input.areaMm2;
  }
  if (input.lengthMm !== undefined) {
    if (!isFiniteNumber(input.lengthMm)) {
      return fail(
        referenceError(
          REFERENCE_ERROR_CODES.fieldInvalid,
          "A reference's lengthMm must be a finite number.",
          input.lengthMm,
        ),
      );
    }
    geometry.lengthMm = input.lengthMm;
  }
  if (input.centroidAbsoluteMm !== undefined) {
    const parsed = parseVector3(input.centroidAbsoluteMm, "centroidAbsoluteMm");
    if (!parsed.ok) return parsed;
    geometry.centroidAbsoluteMm = parsed.value;
  }
  if (input.pointAbsoluteMm !== undefined) {
    const parsed = parseVector3(input.pointAbsoluteMm, "pointAbsoluteMm");
    if (!parsed.ok) return parsed;
    geometry.pointAbsoluteMm = parsed.value;
  }
  if (input.centroidRelativeMm !== undefined) {
    const parsed = parseVector3(input.centroidRelativeMm, "centroidRelativeMm");
    if (!parsed.ok) return parsed;
    geometry.centroidRelativeMm = parsed.value;
  }
  if (input.pointRelativeMm !== undefined) {
    const parsed = parseVector3(input.pointRelativeMm, "pointRelativeMm");
    if (!parsed.ok) return parsed;
    geometry.pointRelativeMm = parsed.value;
  }
  return ok(Object.freeze(geometry));
}

function parseIdentity(
  input: unknown,
): ParseResult<TopologyIdentityPayload, ReferenceError> {
  if (!isPlainRecord(input)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        "A reference's identity must be a plain object with kernelId, schema, and data fields.",
        input,
      ),
    );
  }
  if (
    typeof input.kernelId !== "string" ||
    input.kernelId.length === 0 ||
    typeof input.schema !== "string" ||
    input.schema.length === 0
  ) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        "A reference's identity kernelId and schema must be non-empty strings.",
        input,
      ),
    );
  }
  if (!isPlainRecord(input.data)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        "A reference's identity data must be a plain object of primitives.",
        input.data,
      ),
    );
  }
  const data: Record<string, TopologyIdentityDatum> = {};
  for (const key of Object.keys(input.data)) {
    const value: unknown = input.data[key];
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      return fail(
        referenceError(
          REFERENCE_ERROR_CODES.fieldInvalid,
          `A reference's identity data values must be primitives; "${key}" is not.`,
          value,
        ),
      );
    }
    data[key] = value;
  }
  return ok(
    Object.freeze({
      kernelId: input.kernelId,
      schema: input.schema,
      data: Object.freeze(data),
    }),
  );
}

function parseValidity(
  input: unknown,
): ParseResult<ReferenceValidityRecord, ReferenceError> {
  if (!isPlainRecord(input)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        "A reference's validity must be a plain object with state and regeneration fields.",
        input,
      ),
    );
  }
  const state = input.state;
  if (typeof state !== "string" || !isReferenceValidity(state)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        `A reference's validity state must be one of: ${REFERENCE_VALIDITY_STATES.join(", ")}.`,
        input.state,
      ),
    );
  }
  if (!isNonNegativeInteger(input.regeneration)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        "A reference's validity regeneration must be a non-negative integer.",
        input.regeneration,
      ),
    );
  }
  const record: {
    state: ReferenceValidity;
    regeneration: number;
    ordinal?: number;
    candidates?: readonly number[];
    reason?: ReferenceInvalidReason;
  } = { state, regeneration: input.regeneration };
  if (input.ordinal !== undefined) {
    if (!isNonNegativeInteger(input.ordinal)) {
      return fail(
        referenceError(
          REFERENCE_ERROR_CODES.fieldInvalid,
          "A reference's validity ordinal must be a non-negative integer.",
          input.ordinal,
        ),
      );
    }
    record.ordinal = input.ordinal;
  }
  if (input.candidates !== undefined) {
    if (
      !Array.isArray(input.candidates) ||
      !input.candidates.every(isNonNegativeInteger)
    ) {
      return fail(
        referenceError(
          REFERENCE_ERROR_CODES.fieldInvalid,
          "A reference's validity candidates must be an array of non-negative integers.",
          input.candidates,
        ),
      );
    }
    record.candidates = [...input.candidates];
  }
  if (input.reason !== undefined) {
    if (
      typeof input.reason !== "string" ||
      !isReferenceInvalidReason(input.reason)
    ) {
      return fail(
        referenceError(
          REFERENCE_ERROR_CODES.fieldInvalid,
          `A reference's invalid reason must be one of: ${REFERENCE_INVALID_REASONS.join(", ")}.`,
          input.reason,
        ),
      );
    }
    record.reason = input.reason;
  }
  let repair: ReferenceRepairRecord | undefined;
  if (input.repair !== undefined) {
    const parsed = parseRepair(input.repair);
    if (!parsed.ok) return parsed;
    repair = parsed.value;
  }
  const candidate: ReferenceValidityRecord = Object.freeze({
    ...record,
    ...(repair !== undefined ? { repair } : {}),
  });
  const malformed = isValidityRecordWellFormed(candidate);
  if (malformed !== undefined) return fail(malformed);
  return ok(candidate);
}

function parseAnchor(
  input: unknown,
): ParseResult<ReferenceAnchor, ReferenceError> {
  if (!isPlainRecord(input)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        "A repair anchor must be a plain object with identity, geometry, and regeneration fields.",
        input,
      ),
    );
  }
  const identity = parseIdentity(input.identity);
  if (!identity.ok) return identity;
  const geometry = parseGeometry(input.geometry);
  if (!geometry.ok) return geometry;
  if (!isNonNegativeInteger(input.regeneration)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        "A repair anchor's regeneration must be a non-negative integer.",
        input.regeneration,
      ),
    );
  }
  const anchor: {
    identity: TopologyIdentityPayload;
    geometry: TopologyGeometryDescriptor;
    regeneration: number;
    ordinal?: number;
  } = {
    identity: identity.value,
    geometry: geometry.value,
    regeneration: input.regeneration,
  };
  if (input.ordinal !== undefined) {
    if (!isNonNegativeInteger(input.ordinal)) {
      return fail(
        referenceError(
          REFERENCE_ERROR_CODES.fieldInvalid,
          "A repair anchor's ordinal must be a non-negative integer.",
          input.ordinal,
        ),
      );
    }
    anchor.ordinal = input.ordinal;
  }
  return ok(Object.freeze(anchor));
}

function parseRepair(
  input: unknown,
): ParseResult<ReferenceRepairRecord, ReferenceError> {
  if (!isPlainRecord(input)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        "A repair record must be a plain object with strategy, from, and to fields.",
        input,
      ),
    );
  }
  const strategy = input.strategy;
  if (typeof strategy !== "string" || !isReferenceRepairStrategy(strategy)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        `A repair strategy must be one of: ${REFERENCE_REPAIR_STRATEGIES.join(", ")}.`,
        input.strategy,
      ),
    );
  }
  const from = parseAnchor(input.from);
  if (!from.ok) return from;
  const to = parseAnchor(input.to);
  if (!to.ok) return to;
  return ok(
    Object.freeze({
      strategy,
      from: from.value,
      to: to.value,
    }),
  );
}

function parseFeaturePath(
  input: unknown,
): ParseResult<readonly FeatureId[], ReferenceError> {
  if (!Array.isArray(input)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        "A provenance featurePath must be an array of feature ids.",
        input,
      ),
    );
  }
  const ids: FeatureId[] = [];
  for (const entry of input) {
    if (typeof entry !== "string") {
      return fail(
        referenceError(
          REFERENCE_ERROR_CODES.fieldInvalid,
          "A provenance featurePath entry must be a string.",
          entry,
        ),
      );
    }
    const parsed = parseFeatureId(entry);
    if (!parsed.ok) {
      return fail(
        referenceError(
          REFERENCE_ERROR_CODES.idInvalid,
          `A provenance featurePath entry must be a valid feature id: ${parsed.error.message}`,
          entry,
        ),
      );
    }
    ids.push(parsed.value);
  }
  return ok(Object.freeze(ids));
}

/**
 * Parses untrusted input as a {@link TopologyEntityReference}: kind must be
 * a topology kind, ids must parse (`ref_…`, `body_…`, `feat_…`), the
 * identity payload and geometry descriptor must be well formed, and the
 * validity record must be well formed for its own state. The transition
 * table is not re-checked at parse (a persisted record stands as measured);
 * the next resolution applies it.
 */
export function parseTopologyReference(
  input: unknown,
): ParseResult<TopologyEntityReference, ReferenceError> {
  if (!isPlainRecord(input)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.notAReference,
        "A persistent reference must be a plain object with kind, id, bodyId, provenance, identity, geometry, and validity fields.",
        input,
      ),
    );
  }
  if (typeof input.kind !== "string" || !isTopologyReferenceKind(input.kind)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.notAReference,
        `A persistent reference's kind must be one of: ${TOPOLOGY_REFERENCE_KINDS.join(", ")}.`,
        input.kind,
      ),
    );
  }
  const kind: TopologyReferenceKind = input.kind;
  const id = parseReferenceId(input.id);
  if (!id.ok) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.idInvalid,
        `A persistent reference id must be a valid reference id: ${id.error.message}`,
        input.id,
      ),
    );
  }
  const bodyId =
    typeof input.bodyId === "string"
      ? parseBodyIdOrFailure(input.bodyId)
      : fail(
          referenceError(
            REFERENCE_ERROR_CODES.idInvalid,
            "A persistent reference's bodyId must be a string.",
            input.bodyId,
          ),
        );
  if (!bodyId.ok) return bodyId;
  if (!isPlainRecord(input.provenance)) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        "A persistent reference's provenance must be a plain object with bodyId and featurePath.",
        input.provenance,
      ),
    );
  }
  const provenanceBodyId =
    typeof input.provenance.bodyId === "string"
      ? parseBodyIdOrFailure(input.provenance.bodyId)
      : fail(
          referenceError(
            REFERENCE_ERROR_CODES.idInvalid,
            "A provenance bodyId must be a string.",
            input.provenance.bodyId,
          ),
        );
  if (!provenanceBodyId.ok) return provenanceBodyId;
  if (provenanceBodyId.value !== bodyId.value) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.fieldInvalid,
        "A provenance path must lead to the reference's own body.",
        input.provenance,
      ),
    );
  }
  const featurePath = parseFeaturePath(input.provenance.featurePath);
  if (!featurePath.ok) return featurePath;
  const identity = parseIdentity(input.identity);
  if (!identity.ok) return identity;
  const geometry = parseGeometry(input.geometry);
  if (!geometry.ok) return geometry;
  const validity = parseValidity(input.validity);
  if (!validity.ok) return validity;
  return ok(
    Object.freeze({
      id: id.value,
      kind,
      bodyId: bodyId.value,
      provenance: Object.freeze({
        bodyId: provenanceBodyId.value,
        featurePath: featurePath.value,
      }),
      identity: identity.value,
      geometry: geometry.value,
      validity: validity.value,
    }),
  );
}

/** Parses a `body_…` id from untrusted string input into the failure shape. */
function parseBodyIdOrFailure(
  raw: string,
): ParseResult<BodyId, ReferenceError> {
  const parsed = parseBodyId(raw);
  if (!parsed.ok) {
    return fail(
      referenceError(
        REFERENCE_ERROR_CODES.idInvalid,
        `A body id must be a valid body id: ${parsed.error.message}`,
        raw,
      ),
    );
  }
  return ok(parsed.value);
}
