/**
 * The CAD document (Phase 6.1): the kernel-neutral root object that owns a
 * stable {@link DocumentId}, document-level parameters (a reused
 * {@link ParameterCollection}), body records, feature records, and the id
 * generator state that keeps ids unique across save/load.
 *
 * Id-space ownership: the document owns one id space shared by every entity
 * kind. Every add checks the document-wide registry (parameters, bodies, and
 * features together, keyed by the full id string) and rejects a colliding id
 * with `document/id-conflict` — cross-kind collisions are impossible by wire
 * prefix, but the registry enforces the invariant uniformly anyway. An
 * explicit id with a purely numeric payload (`body_000042`) additionally
 * claims that counter value in the generator, so a later generated id can
 * never collide with an explicit one; non-numeric payloads are unreachable
 * by the generator's zero-padded counters and need no claim. Both boundaries
 * of the numeric id space are closed by construction: every registrable
 * numeric payload is at most Number.MAX_SAFE_INTEGER (2^53 - 1) — larger
 * ones are rejected with `document/id-invalid` at every add and parse
 * boundary, so every registrable numeric payload is claimable — and the
 * generator never emits a payload beyond that bound either, refusing with a
 * structured `document/generator-exhausted` failure instead, so float64
 * rounding can never re-emit an already-generated id and duplicates are
 * impossible at both the explicit and the generated boundary. Parsing
 * revives the persisted generator state only after validating it
 * (`document/generator-state-invalid` instead of a leaked RangeError) and
 * raises it to at least every numeric id present in the document, so even a
 * tampered, lowered state cannot make a revived document re-emit an existing
 * id.
 *
 * Feature records are pure data: a feature kind string (real feature kinds
 * arrive with the geometry-kernel phases) plus declared inputs (typed
 * references to parameters, upstream features, or bodies) and outputs (body
 * ids). Every declared reference must resolve to a live entity at add time,
 * and removing a referenced entity is rejected (`document/in-use`), so the
 * invariant "all references resolve" holds at all times — the raw material
 * the Phase 6.2 dependency graph consumes. Removal never cascades: deleting
 * a feature leaves its output bodies in place until they are removed
 * explicitly.
 *
 * Everything here is immutable, frozen, JSON-serializable state, independent
 * of React, geometry kernels, and the browser. `serializeCadDocument` writes
 * a canonical fixed-key-order form and `parseCadDocument` validates untrusted
 * input strictly (unknown fields are ignored for forward compatibility) and
 * round-trips it exactly.
 */

import {
  FEATURE_HISTORY_ERROR_CODES,
  reorderFeatureRecords,
} from "./feature-history";
import {
  type AnyCadId,
  type BodyId,
  CAD_ID_KINDS,
  CAD_ID_PREFIXES,
  CadIdGeneratorExhaustedError,
  type CadIdKind,
  createIdGenerator,
  type DatumId,
  type DocumentId,
  type FeatureId,
  type IdGenerator,
  type IdGeneratorState,
  parseBodyId,
  parseDatumId,
  parseDocumentId,
  parseFeatureId,
  parseParameterId,
  type ParameterId,
  parseReferenceId,
  parseSectionId,
  type ReferenceId,
  type SectionId,
  parseSketchDocumentId,
  type SketchDocumentId,
} from "./ids";
import {
  addParameter,
  EMPTY_PARAMETER_COLLECTION,
  getParameter,
  type Parameter,
  type ParameterCollection,
  type ParameterError,
  type ParameterInput,
  parseParameterCollection,
  removeParameter,
  serializeParameterCollection,
  type SerializedParameterCollection,
} from "./parameter";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";
import { CAD_DOCUMENT_FORMAT_VERSION } from "./version";

/**
 * A solid/body entry of the document, identified by its stable {@link BodyId}.
 *
 * Phase 44 grows the record with two DISPLAY flags — `visible` and
 * `isolated` — the body-management vocabulary: `visible: false` hides the
 * body from rendering (the projection filter's keep rule), `isolated:
 * true` marks it as one of the bodies that, whenever ANY body is
 * isolated, are the ONLY ones rendering. Both are optional with
 * visibility-on / isolation-off defaults, emitted on the wire exactly
 * when non-default (`visible: false`, `isolated: true`) — the
 * id-generator counter precedent — so documents that never touched the
 * flags serialize byte-identically to their pre-flag form, and an old
 * reader's tolerant body parse simply drops them (display state, never
 * model data: the flags change no geometry, feature, or parameter).
 */
export interface Body {
  readonly id: BodyId;
  readonly name: string;
  /** Present exactly when the body is hidden (`false`); default visible. */
  readonly visible?: boolean;
  /** Present exactly when the body is isolated (`true`); default not. */
  readonly isolated?: boolean;
}

/** Input accepted by {@link addBody}; the id is generated when omitted. */
export interface BodyInput {
  readonly id?: BodyId;
  readonly name: string;
  /** Present exactly when the body is hidden (`false`); default visible. */
  readonly visible?: boolean;
  /** Present exactly when the body is isolated (`true`); default not. */
  readonly isolated?: boolean;
}

/**
 * A sketch document entity (Phase 26.1): the document-resident record of a
 * sketch, carrying its canonical serialized form verbatim (cad-core stays
 * sketch-format-agnostic — the sketch domain owns the payload's schema and
 * its parse/serialize; the document guarantees only identity, a name, and
 * JSON-safe fixed storage). Features reference a sketch record through a
 * `{ kind: "sketch" }` input.
 */
export interface DocumentSketch {
  readonly id: SketchDocumentId;
  readonly name: string;
  /** The sketch domain's canonical serialized sketch, stored verbatim. */
  readonly sketch: Readonly<Record<string, unknown>>;
}

/** Input accepted by {@link addDocumentSketch}. */
export interface DocumentSketchInput {
  readonly id?: SketchDocumentId;
  readonly name: string;
  readonly sketch: Readonly<Record<string, unknown>>;
}

/**
 * A persistent-reference entity (Phase 26.5): the document-resident record
 * of a Phase 22 {@link TopologyEntityReference} — face, edge, or vertex —
 * carrying its canonical serialized form verbatim (cad-core's persistent-
 * reference module owns the payload's schema and its parse/serialize; the
 * document guarantees only identity, a name, and JSON-safe fixed storage,
 * the exact discipline the sketch records follow). Features reference a
 * record through a `{ kind: "reference" }` input; the EXECUTOR resolves it
 * against the owning solid's current topology snapshot — a moved or
 * vanished entity surfaces there as a structured reference failure, never
 * as silent re-attachment.
 */
export interface DocumentReference {
  readonly id: ReferenceId;
  readonly name: string;
  /** The persistent-reference module's canonical serialized form, stored verbatim. */
  readonly reference: Readonly<Record<string, unknown>>;
}

/** Input accepted by {@link addDocumentReference}. */
export interface DocumentReferenceInput {
  readonly id?: ReferenceId;
  readonly name: string;
  readonly reference: Readonly<Record<string, unknown>>;
}

/**
 * A named datum entity (Phase 39): the document-resident record of datum
 * reference geometry — a plane, an axis, a point, or a coordinate system —
 * carrying its canonical serialized payload verbatim (the datum module owns
 * the payload's schema and its parse/resolve; the document guarantees only
 * identity, a name, and JSON-safe fixed storage — the sketch and
 * persistent-reference discipline). Features address a datum through a
 * `{ kind: "datum" }` input; the EXECUTOR resolves the payload against the
 * datum's definition, with reference-dependent definitions re-resolving
 * through the caller-supplied topology seam every regeneration.
 */
export interface DocumentDatum {
  readonly id: DatumId;
  readonly name: string;
  /** The datum module's canonical serialized payload, stored verbatim. */
  readonly datum: Readonly<Record<string, unknown>>;
}

/** Input accepted by {@link addDocumentDatum}. */
export interface DocumentDatumInput {
  readonly id?: DatumId;
  readonly name: string;
  readonly datum: Readonly<Record<string, unknown>>;
}

/**
 * A typed reference to an entity a feature consumes. The `kind`/`id` pair is
 * validated for consistency (the id must carry the wire prefix of its
 * declared kind).
 */
export type FeatureInputRef =
  | { readonly kind: "parameter"; readonly id: ParameterId }
  | { readonly kind: "feature"; readonly id: FeatureId }
  | { readonly kind: "body"; readonly id: BodyId }
  | { readonly kind: "sketch"; readonly id: SketchDocumentId }
  | { readonly kind: "reference"; readonly id: ReferenceId }
  | { readonly kind: "datum"; readonly id: DatumId };

/** The entity kinds a feature input may reference. */
export const FEATURE_INPUT_KINDS = [
  "parameter",
  "feature",
  "body",
  "sketch",
  "reference",
  "datum",
] as const;

export type FeatureInputKind = (typeof FEATURE_INPUT_KINDS)[number];

/**
 * A feature record: what the feature is (its kind string — real kinds arrive
 * with the geometry-kernel phases) and what it consumes and produces, as
 * typed references to stable ids. Inputs may reference parameters, upstream
 * features, and bodies; outputs are body ids. Order and duplicates are
 * preserved as declared — this is data for the dependency graph, not
 * behavior.
 */
export interface FeatureRecord {
  readonly id: FeatureId;
  readonly kind: string;
  readonly inputs: readonly FeatureInputRef[];
  readonly outputs: readonly BodyId[];
}

/** Input accepted by {@link addFeature}; the id is generated when omitted. */
export interface FeatureRecordInput {
  readonly id?: FeatureId;
  readonly kind: string;
  readonly inputs: readonly FeatureInputRef[];
  readonly outputs: readonly BodyId[];
}

/**
 * A parameter as accepted by {@link addDocumentParameter}; the id is
 * generated when omitted, unlike the collection-level {@link ParameterInput}.
 */
export type DocumentParameterInput = Omit<ParameterInput, "id"> & {
  readonly id?: ParameterId;
};

/** The CAD document: stable id, owned parameters, bodies, features, id space. */
export interface CadDocument {
  readonly id: DocumentId;
  readonly parameters: ParameterCollection;
  readonly bodies: readonly Body[];
  readonly features: readonly FeatureRecord[];
  /** The document's sketch entities, in add order (empty in older files). */
  readonly sketches: readonly DocumentSketch[];
  /**
   * The document's persistent-reference records, in add order (empty in
   * older files; Phase 26.5-additive).
   */
  readonly references: readonly DocumentReference[];
  /**
   * The document's named datum records, in add order (empty in older
   * files; Phase 39-additive).
   */
  readonly datums: readonly DocumentDatum[];
  /**
   * The document's section display records, in add order (empty in older
   * files; Phase 46-additive): non-destructive section planes the
   * viewport clips and measures on — display state persisted as a MODEL
   * ARTIFACT (the roadmap's document-record recommendation; the camera
   * overlay stays session-scoped instead).
   */
  readonly sections: readonly DocumentSection[];
  /**
   * Persisted counters of the document's id generator. Serializing this
   * state (and raising it past every numeric id at parse time) is what keeps
   * generated ids unique across save/load.
   */
  readonly idGeneratorState: IdGeneratorState;
}

/**
 * One section display record (Phase 46): a named, non-destructive section
 * plane — an AD-HOC plane (origin and unit-scale normal in canonical
 * millimetres, the resolved form a datum plane resolves to) with its kept
 * side and its display toggle. Up to {@link DOCUMENT_SECTION_LIMIT}
 * records address the viewport's clipping budget.
 */
export interface DocumentSection {
  readonly id: SectionId;
  /** The record's name (1-64 characters, the datum naming rule). */
  readonly name: string;
  /** The plane's world origin (mm), one component per axis, finite. */
  readonly origin: readonly [number, number, number];
  /** The plane's world normal, any finite non-zero vector (normalized on use). */
  readonly normal: readonly [number, number, number];
  /** `+1` keeps the normal's side, `−1` the opposite. */
  readonly keepSide: 1 | -1;
  /** Whether the viewport applies the record (off = persisted but inert). */
  readonly enabled: boolean;
}

/** How many section display records a document may carry (the clip budget). */
export const DOCUMENT_SECTION_LIMIT = 3;

/** A kind-tagged view of any entity resolvable by id within a document. */
export type DocumentEntity =
  | { readonly kind: "parameter"; readonly parameter: Parameter }
  | { readonly kind: "body"; readonly body: Body }
  | { readonly kind: "feature"; readonly feature: FeatureRecord }
  | { readonly kind: "sketch"; readonly sketch: DocumentSketch }
  | { readonly kind: "datum"; readonly datum: DocumentDatum };

/** Result of {@link addBody}: the next document plus the added body. */
export interface BodyAddResult {
  readonly document: CadDocument;
  readonly body: Body;
}

/** Result of {@link addFeature}: the next document plus the added record. */
export interface FeatureAddResult {
  readonly document: CadDocument;
  readonly feature: FeatureRecord;
}

/** Result of {@link addDocumentParameter}: next document plus the parameter. */
export interface DocumentParameterAddResult {
  readonly document: CadDocument;
  readonly parameter: Parameter;
}

/** Result of {@link addDocumentSketch}: next document plus the sketch. */
export interface DocumentSketchAddResult {
  readonly document: CadDocument;
  readonly sketch: DocumentSketch;
}

/** Result of {@link addDocumentReference}: next document plus the record. */
export interface DocumentReferenceAddResult {
  readonly document: CadDocument;
  readonly reference: DocumentReference;
}

/** Result of {@link addDocumentDatum}: next document plus the record. */
export interface DocumentDatumAddResult {
  readonly document: CadDocument;
  readonly datum: DocumentDatum;
}

/** Stable failure codes produced when document input is rejected. */
export const DOCUMENT_ERROR_CODES = {
  malformed: "document/malformed",
  versionUnsupported: "document/version-unsupported",
  generatorStateInvalid: "document/generator-state-invalid",
  generatorExhausted: "document/generator-exhausted",
  idInvalid: "document/id-invalid",
  idConflict: "document/id-conflict",
  bodyNameInvalid: "document/body-name-invalid",
  sketchNameInvalid: "document/sketch-name-invalid",
  sketchPayloadInvalid: "document/sketch-payload-invalid",
  referenceNameInvalid: "document/reference-name-invalid",
  referencePayloadInvalid: "document/reference-payload-invalid",
  datumNameInvalid: "document/datum-name-invalid",
  sectionNameInvalid: "document/section-name-invalid",
  sectionLimitExceeded: "document/section-limit-exceeded",
  datumPayloadInvalid: "document/datum-payload-invalid",
  featureKindInvalid: "document/feature-kind-invalid",
  inputKindInvalid: "document/input-kind-invalid",
  inputUnknown: "document/input-unknown",
  inputOrderInvalid: "document/input-order-invalid",
  outputUnknown: "document/output-unknown",
  notFound: "document/not-found",
  inUse: "document/in-use",
  reorderInvalid: "document/reorder-invalid",
} as const;

export type DocumentErrorCode =
  (typeof DOCUMENT_ERROR_CODES)[keyof typeof DOCUMENT_ERROR_CODES];

/** Structured failure describing why document input was rejected. */
export interface DocumentError extends ParseFailure {
  readonly code: DocumentErrorCode;
}

function docError(
  code: DocumentErrorCode,
  message: string,
  input: unknown,
): DocumentError {
  return { code, message, input };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

const BODY_NAME_MAX_LENGTH = 64;

function validateBodyName(name: unknown): ParseResult<string, DocumentError> {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > BODY_NAME_MAX_LENGTH
  ) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.bodyNameInvalid,
        `A body name must be a string of 1-${BODY_NAME_MAX_LENGTH} characters.`,
        name,
      ),
    );
  }
  return ok(name);
}

const FEATURE_KIND_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/**
 * Validates untrusted input as a feature kind string: 1-64 characters,
 * starting with a letter, drawn from letters, digits, dots, underscores, and
 * hyphens (real feature kinds arrive with the geometry-kernel phases). The
 * command layer reuses this so a serialized feature command and a document
 * feature record validate their kind through one source of truth.
 */
export function parseFeatureKind(
  kind: unknown,
): ParseResult<string, DocumentError> {
  if (typeof kind !== "string" || !FEATURE_KIND_PATTERN.test(kind)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.featureKindInvalid,
        "A feature kind must be 1-64 characters, start with a letter, and use only letters, digits, dots, underscores, and hyphens (real feature kinds arrive with the geometry-kernel phases).",
        kind,
      ),
    );
  }
  return ok(kind);
}

/**
 * Validates untrusted input as a {@link FeatureInputRef}: a plain object
 * whose `kind`/`id` pair is consistent (the id must carry the wire prefix of
 * its declared kind). The command layer reuses this so serialized commands
 * and feature records parse input references through one source of truth.
 */
export function parseFeatureInputRef(
  input: unknown,
): ParseResult<FeatureInputRef, DocumentError> {
  if (!isPlainRecord(input)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A feature input must be a plain object with kind and id fields.",
        input,
      ),
    );
  }
  const { kind } = input;
  if (kind === "parameter") {
    const parsed = parseParameterId(input.id);
    if (!parsed.ok) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idInvalid,
          `A parameter input reference must carry a valid parameter id: ${parsed.error.message}`,
          input,
        ),
      );
    }
    return ok(Object.freeze({ kind, id: parsed.value }));
  }
  if (kind === "feature") {
    const parsed = parseFeatureId(input.id);
    if (!parsed.ok) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idInvalid,
          `A feature input reference must carry a valid feature id: ${parsed.error.message}`,
          input,
        ),
      );
    }
    return ok(Object.freeze({ kind, id: parsed.value }));
  }
  if (kind === "body") {
    const parsed = parseBodyId(input.id);
    if (!parsed.ok) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idInvalid,
          `A body input reference must carry a valid body id: ${parsed.error.message}`,
          input,
        ),
      );
    }
    return ok(Object.freeze({ kind, id: parsed.value }));
  }
  if (kind === "sketch") {
    const parsed = parseSketchDocumentId(input.id);
    if (!parsed.ok) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idInvalid,
          `A sketch input reference must carry a valid sketch id: ${parsed.error.message}`,
          input,
        ),
      );
    }
    return ok(Object.freeze({ kind, id: parsed.value }));
  }
  if (kind === "reference") {
    const parsed = parseReferenceId(input.id);
    if (!parsed.ok) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idInvalid,
          `A reference input reference must carry a valid reference id: ${parsed.error.message}`,
          input,
        ),
      );
    }
    return ok(Object.freeze({ kind, id: parsed.value }));
  }
  if (kind === "datum") {
    const parsed = parseDatumId(input.id);
    if (!parsed.ok) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idInvalid,
          `A datum input reference must carry a valid datum id: ${parsed.error.message}`,
          input,
        ),
      );
    }
    return ok(Object.freeze({ kind, id: parsed.value }));
  }
  return fail(
    docError(
      DOCUMENT_ERROR_CODES.inputKindInvalid,
      `A feature input kind must be one of: ${FEATURE_INPUT_KINDS.join(", ")}.`,
      input,
    ),
  );
}

function parseFeatureInputRefs(
  input: unknown,
): ParseResult<readonly FeatureInputRef[], DocumentError> {
  if (!Array.isArray(input)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "Feature inputs must be an array of input references.",
        input,
      ),
    );
  }
  const refs: FeatureInputRef[] = [];
  for (const entry of input) {
    const parsed = parseFeatureInputRef(entry);
    if (!parsed.ok) return parsed;
    refs.push(parsed.value);
  }
  return ok(Object.freeze(refs));
}

function parseBodyIdList(
  input: unknown,
): ParseResult<readonly BodyId[], DocumentError> {
  if (!Array.isArray(input)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "Feature outputs must be an array of body ids.",
        input,
      ),
    );
  }
  const ids: BodyId[] = [];
  for (const entry of input) {
    const parsed = parseBodyId(entry);
    if (!parsed.ok) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idInvalid,
          `A feature output must be a valid body id: ${parsed.error.message}`,
          entry,
        ),
      );
    }
    ids.push(parsed.value);
  }
  return ok(Object.freeze(ids));
}

const NUMERIC_PAYLOAD_PATTERN = /^\d+$/;

/**
 * Keeps the registrable numeric id space inside the claimable range. Claims
 * are honored only up to Number.MAX_SAFE_INTEGER, and the generator never
 * emits beyond that bound either (see {@link generateId}), so a purely
 * numeric payload above it could never be claimed nor safely regenerated.
 * Rejecting such ids here — at every add and parse boundary, with the
 * stable `document/id-invalid` code — is what makes the claimable range
 * (numeric payloads of at most Number.MAX_SAFE_INTEGER) and the registrable
 * range coincide exactly, instead of leaving an unclaimable no-man's-land
 * above the bound.
 */
function unclaimablePayloadError(
  kind: CadIdKind,
  id: string,
): DocumentError | undefined {
  const payload = id.slice(CAD_ID_PREFIXES[kind].length + 1);
  if (!NUMERIC_PAYLOAD_PATTERN.test(payload)) return undefined;
  if (Number(payload) <= Number.MAX_SAFE_INTEGER) return undefined;
  return docError(
    DOCUMENT_ERROR_CODES.idInvalid,
    `A ${kind} id with a numeric payload above Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}) is outside the generator's claimable range and could collide with a generated id; use a non-numeric payload or a numeric value of at most ${Number.MAX_SAFE_INTEGER}.`,
    id,
  );
}

/**
 * Claims an explicit id's counter value in the generator state. Generated
 * ids are `<prefix>_<zero-padded counter>`, so only a purely numeric payload
 * can ever collide with a future emission. The add and parse boundaries
 * reject payloads above Number.MAX_SAFE_INTEGER first (see
 * {@link unclaimablePayloadError}), so the skip below is a backstop that
 * only shields direct branded-id callers (createDocument) from poisoning a
 * counter with an inexact value.
 */
function claimExplicitId(
  state: IdGeneratorState,
  kind: CadIdKind,
  id: string,
): IdGeneratorState {
  const payload = id.slice(CAD_ID_PREFIXES[kind].length + 1);
  if (!NUMERIC_PAYLOAD_PATTERN.test(payload)) return state;
  const value = Number(payload);
  if (value > Number.MAX_SAFE_INTEGER) return state;
  return state[kind] >= value
    ? state
    : Object.freeze({ ...state, [kind]: value });
}

/** Component-wise maximum of two generator states. */
function raiseGeneratorState(
  base: IdGeneratorState,
  floor: IdGeneratorState,
): IdGeneratorState {
  const raised: Record<CadIdKind, number> = {
    document: Math.max(base.document, floor.document),
    parameter: Math.max(base.parameter, floor.parameter),
    feature: Math.max(base.feature, floor.feature),
    body: Math.max(base.body, floor.body),
    reference: Math.max(base.reference, floor.reference),
    sketch: Math.max(base.sketch, floor.sketch),
    datum: Math.max(base.datum, floor.datum),
    section: Math.max(base.section, floor.section),
  };
  return Object.freeze(raised);
}

/** An id freshly emitted by the document's generator plus the advanced state. */
interface GeneratedId<I extends AnyCadId> {
  readonly id: I;
  readonly state: IdGeneratorState;
}

/**
 * Emits the next id of a kind from the document's own generator. The
 * generator's structural exhaustion refusal — a counter already at
 * Number.MAX_SAFE_INTEGER, beyond which float64 rounding could re-emit an
 * existing id — is converted here into a `document/generator-exhausted`
 * failure, so the caller's document stays untouched and the caller learns
 * of the refusal through the same structured channel as every other
 * rejection.
 */
function generateId<I extends AnyCadId>(
  state: IdGeneratorState,
  nextId: (generator: IdGenerator) => I,
): ParseResult<GeneratedId<I>, DocumentError> {
  const generator = createIdGenerator(state);
  try {
    const id = nextId(generator);
    return ok({ id, state: generator.state() });
  } catch (error) {
    if (!(error instanceof CadIdGeneratorExhaustedError)) throw error;
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.generatorExhausted,
        `The document's id generator can no longer emit ${error.kind} ids: its counter has reached Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}) and numeric payloads beyond it are outside the generator's contract. Add the entity with an explicit id instead.`,
        state,
      ),
    );
  }
}

function isIdRegistered(document: CadDocument, id: string): boolean {
  return (
    document.parameters.parameters.some((parameter) => parameter.id === id) ||
    document.bodies.some((body) => body.id === id) ||
    document.features.some((feature) => feature.id === id) ||
    document.sketches.some((sketch) => sketch.id === id) ||
    document.references.some((reference) => reference.id === id) ||
    document.datums.some((datum) => datum.id === id)
  );
}

function featureInputResolves(
  document: CadDocument,
  ref: FeatureInputRef,
): boolean {
  if (ref.kind === "parameter") {
    return document.parameters.parameters.some(
      (parameter) => parameter.id === ref.id,
    );
  }
  if (ref.kind === "feature") {
    return document.features.some((feature) => feature.id === ref.id);
  }
  if (ref.kind === "sketch") {
    return document.sketches.some((sketch) => sketch.id === ref.id);
  }
  if (ref.kind === "reference") {
    return document.references.some((reference) => reference.id === ref.id);
  }
  if (ref.kind === "datum") {
    return document.datums.some((datum) => datum.id === ref.id);
  }
  return document.bodies.some((body) => body.id === ref.id);
}

/**
 * Creates an empty document under the given stable id. The document's own id
 * claims its counter in the generator state when its payload is numeric, so
 * later document-id emissions can never collide with it.
 */
export function createDocument(id: DocumentId): CadDocument {
  return Object.freeze({
    id,
    parameters: EMPTY_PARAMETER_COLLECTION,
    bodies: Object.freeze([]),
    features: Object.freeze([]),
    sketches: Object.freeze([]),
    references: Object.freeze([]),
    datums: Object.freeze([]),
    sections: Object.freeze([]),
    idGeneratorState: claimExplicitId(
      createIdGenerator().state(),
      "document",
      id,
    ),
  });
}

/** Returns the body with the given id, or undefined. */
export function getBody(document: CadDocument, id: BodyId): Body | undefined {
  return document.bodies.find((body) => body.id === id);
}

/** Returns the feature record with the given id, or undefined. */
export function getFeature(
  document: CadDocument,
  id: FeatureId,
): FeatureRecord | undefined {
  return document.features.find((feature) => feature.id === id);
}

/** Returns the sketch record with the given id, or undefined. */
export function getDocumentSketch(
  document: CadDocument,
  id: SketchDocumentId,
): DocumentSketch | undefined {
  return document.sketches.find((sketch) => sketch.id === id);
}

/** Returns the document-level parameter with the given id, or undefined. */
export function getDocumentParameter(
  document: CadDocument,
  id: ParameterId,
): Parameter | undefined {
  return getParameter(document.parameters, id);
}

/** Resolves any entity id (parameter, body, or feature) within the document. */
export function getDocumentEntity(
  document: CadDocument,
  id: AnyCadId,
): DocumentEntity | undefined {
  const parameter = document.parameters.parameters.find(
    (candidate) => candidate.id === id,
  );
  if (parameter !== undefined) return { kind: "parameter", parameter };
  const body = document.bodies.find((candidate) => candidate.id === id);
  if (body !== undefined) return { kind: "body", body };
  const feature = document.features.find((candidate) => candidate.id === id);
  if (feature !== undefined) return { kind: "feature", feature };
  const sketch = document.sketches.find((candidate) => candidate.id === id);
  if (sketch !== undefined) return { kind: "sketch", sketch };
  const datum = document.datums.find((candidate) => candidate.id === id);
  if (datum !== undefined) return { kind: "datum", datum };
  return undefined;
}

/**
 * Adds a body. Without an explicit id a deterministic id is generated from
 * the document's own generator; with one, the id is validated against the
 * document-wide registry (rejecting collisions with any entity kind) and its
 * numeric payload claims the generator counter.
 */
export function addBody(
  document: CadDocument,
  input: BodyInput,
): ParseResult<BodyAddResult, DocumentError> {
  const name = validateBodyName(input.name);
  if (!name.ok) return name;
  let id: BodyId;
  let idGeneratorState = document.idGeneratorState;
  if (input.id === undefined) {
    const generated = generateId(idGeneratorState, (generator) =>
      generator.nextBodyId(),
    );
    if (!generated.ok) return generated;
    id = generated.value.id;
    idGeneratorState = generated.value.state;
  } else {
    const parsed = parseBodyId(input.id);
    if (!parsed.ok) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idInvalid,
          `A body id must be a valid body id: ${parsed.error.message}`,
          input.id,
        ),
      );
    }
    const unclaimable = unclaimablePayloadError("body", parsed.value);
    if (unclaimable !== undefined) return fail(unclaimable);
    if (isIdRegistered(document, parsed.value)) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idConflict,
          `An entity with id "${parsed.value}" already exists in document "${document.id}".`,
          input,
        ),
      );
    }
    id = parsed.value;
    idGeneratorState = claimExplicitId(idGeneratorState, "body", parsed.value);
  }
  const body = Object.freeze({
    id,
    name: name.value,
    ...(input.visible === undefined ? {} : { visible: input.visible }),
    ...(input.isolated === undefined ? {} : { isolated: input.isolated }),
  });
  return ok({
    document: Object.freeze({
      ...document,
      bodies: Object.freeze([...document.bodies, body]),
      idGeneratorState,
    }),
    body,
  });
}

/**
 * Updates a body's mutable record fields (Phase 44): the display name and
 * the two display flags. Only the fields the update CARRIES change — a
 * rename keeps the flags, a visibility toggle keeps the name — so each
 * concern rides its own `body.update` command and undo replays exactly
 * what happened. The name (when carried) follows {@link addBody}'s
 * validation; the flags (when carried) must be real booleans, never
 * smuggled truthy values.
 */
export function updateBody(
  document: CadDocument,
  id: BodyId,
  input: {
    readonly name?: string;
    readonly visible?: boolean;
    readonly isolated?: boolean;
  },
): ParseResult<CadDocument, DocumentError> {
  const body = getBody(document, id);
  if (body === undefined) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.notFound,
        `No body with id "${id}" exists in document "${document.id}".`,
        id,
      ),
    );
  }
  if (
    input.name === undefined &&
    input.visible === undefined &&
    input.isolated === undefined
  ) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A body update must carry at least one of a name, a visible flag, or an isolated flag.",
        input,
      ),
    );
  }
  let name = body.name;
  if (input.name !== undefined) {
    const validated = validateBodyName(input.name);
    if (!validated.ok) return validated;
    name = validated.value;
  }
  const visible = input.visible === undefined ? body.visible : input.visible;
  const isolated =
    input.isolated === undefined ? body.isolated : input.isolated;
  return ok(
    Object.freeze({
      ...document,
      bodies: Object.freeze(
        document.bodies.map((candidate) =>
          candidate.id === id
            ? Object.freeze({
                id,
                name,
                ...(visible === undefined ? {} : { visible }),
                ...(isolated === undefined ? {} : { isolated }),
              })
            : candidate,
        ),
      ),
    }),
  );
}

/**
 * Removes the body with the given id. Refused with `in-use` while any feature
 * declares the body as an input or output; removal never cascades.
 */
export function removeBody(
  document: CadDocument,
  id: BodyId,
): ParseResult<CadDocument, DocumentError> {
  if (getBody(document, id) === undefined) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.notFound,
        `No body with id "${id}" exists in document "${document.id}".`,
        id,
      ),
    );
  }
  const blocking = document.features.find(
    (feature) =>
      feature.outputs.includes(id) ||
      feature.inputs.some((ref) => ref.kind === "body" && ref.id === id),
  );
  if (blocking !== undefined) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.inUse,
        `Body "${id}" is referenced by feature "${blocking.id}".`,
        id,
      ),
    );
  }
  return ok(
    Object.freeze({
      ...document,
      bodies: Object.freeze(document.bodies.filter((body) => body.id !== id)),
    }),
  );
}

/**
 * Adds a feature record. The kind string and every input/output reference
 * are validated; each declared input must resolve to a live parameter,
 * feature, or body, and each output to an existing body. Without an explicit
 * id a deterministic id is generated from the document's own generator.
 */
export function addFeature(
  document: CadDocument,
  input: FeatureRecordInput,
): ParseResult<FeatureAddResult, DocumentError> {
  const kind = parseFeatureKind(input.kind);
  if (!kind.ok) return kind;
  const inputs = parseFeatureInputRefs(input.inputs);
  if (!inputs.ok) return inputs;
  const outputs = parseBodyIdList(input.outputs);
  if (!outputs.ok) return outputs;
  let id: FeatureId;
  let idGeneratorState = document.idGeneratorState;
  if (input.id === undefined) {
    const generated = generateId(idGeneratorState, (generator) =>
      generator.nextFeatureId(),
    );
    if (!generated.ok) return generated;
    id = generated.value.id;
    idGeneratorState = generated.value.state;
  } else {
    const parsed = parseFeatureId(input.id);
    if (!parsed.ok) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idInvalid,
          `A feature id must be a valid feature id: ${parsed.error.message}`,
          input.id,
        ),
      );
    }
    const unclaimable = unclaimablePayloadError("feature", parsed.value);
    if (unclaimable !== undefined) return fail(unclaimable);
    if (isIdRegistered(document, parsed.value)) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idConflict,
          `An entity with id "${parsed.value}" already exists in document "${document.id}".`,
          input,
        ),
      );
    }
    id = parsed.value;
    idGeneratorState = claimExplicitId(
      idGeneratorState,
      "feature",
      parsed.value,
    );
  }
  for (const ref of inputs.value) {
    if (!featureInputResolves(document, ref)) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.inputUnknown,
          `Feature input (${ref.kind} "${ref.id}") does not resolve to an entity in document "${document.id}".`,
          input,
        ),
      );
    }
  }
  for (const output of outputs.value) {
    if (getBody(document, output) === undefined) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.outputUnknown,
          `Feature output body "${output}" does not exist in document "${document.id}".`,
          input,
        ),
      );
    }
  }
  const feature = Object.freeze({
    id,
    kind: kind.value,
    inputs: inputs.value,
    outputs: outputs.value,
  });
  return ok({
    document: Object.freeze({
      ...document,
      features: Object.freeze([...document.features, feature]),
      idGeneratorState,
    }),
    feature,
  });
}

/**
 * Removes the feature record with the given id. Refused with `in-use` while
 * another feature declares it as an input; removal never cascades, so the
 * removed feature's output bodies remain in the document.
 */
export function removeFeature(
  document: CadDocument,
  id: FeatureId,
): ParseResult<CadDocument, DocumentError> {
  if (getFeature(document, id) === undefined) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.notFound,
        `No feature with id "${id}" exists in document "${document.id}".`,
        id,
      ),
    );
  }
  const blocking = document.features.find((feature) =>
    feature.inputs.some((ref) => ref.kind === "feature" && ref.id === id),
  );
  if (blocking !== undefined) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.inUse,
        `Feature "${id}" is referenced by feature "${blocking.id}".`,
        id,
      ),
    );
  }
  return ok(
    Object.freeze({
      ...document,
      features: Object.freeze(
        document.features.filter((feature) => feature.id !== id),
      ),
    }),
  );
}

/**
 * The mutable fields of a feature record — everything except its identity —
 * as accepted by {@link updateFeature}. Semantics are wholesale replacement
 * (Phase 7 `feature.update` semantics): the record ends with exactly these
 * kind, inputs, and outputs.
 */
export interface FeatureRecordUpdate {
  readonly kind: string;
  readonly inputs: readonly FeatureInputRef[];
  readonly outputs: readonly BodyId[];
}

/** Result of {@link updateFeature}: the next document plus the replaced record. */
export interface FeatureUpdateResult {
  readonly document: CadDocument;
  readonly feature: FeatureRecord;
}

/**
 * Replaces a feature record's mutable fields — kind, inputs, and outputs —
 * keeping its id, its position in the feature list, the document's id
 * generator state, and every other feature (downstream references point at
 * the stable id, so they survive the update unchanged).
 *
 * The replacement is validated exactly like {@link addFeature} (kind shape,
 * input reference shape and resolution, output existence), plus one rule
 * that add-time validation gets for free and an update would otherwise
 * lose: a feature input of kind `feature` must reference a feature declared
 * *earlier* in the feature list (`document/input-order-invalid` otherwise —
 * this also covers self-reference). The feature list is kept backward-
 * referencable because {@link parseCadDocument} rebuilds documents by
 * replaying the records in order, so an update that introduced a forward or
 * self reference would produce a document that no longer round-trips through
 * {@link serializeCadDocument} and {@link parseCadDocument} exactly.
 */
export function updateFeature(
  document: CadDocument,
  id: FeatureId,
  update: FeatureRecordUpdate,
): ParseResult<FeatureUpdateResult, DocumentError> {
  const kind = parseFeatureKind(update.kind);
  if (!kind.ok) return kind;
  const inputs = parseFeatureInputRefs(update.inputs);
  if (!inputs.ok) return inputs;
  const outputs = parseBodyIdList(update.outputs);
  if (!outputs.ok) return outputs;
  const index = document.features.findIndex((feature) => feature.id === id);
  if (index < 0) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.notFound,
        `No feature with id "${id}" exists in document "${document.id}".`,
        id,
      ),
    );
  }
  for (const ref of inputs.value) {
    if (ref.kind === "feature") {
      const target = document.features.findIndex(
        (feature) => feature.id === ref.id,
      );
      if (target < 0) {
        return fail(
          docError(
            DOCUMENT_ERROR_CODES.inputUnknown,
            `Feature input (feature "${ref.id}") does not resolve to an entity in document "${document.id}".`,
            update,
          ),
        );
      }
      if (target >= index) {
        return fail(
          docError(
            DOCUMENT_ERROR_CODES.inputOrderInvalid,
            `Feature "${id}" cannot reference feature "${ref.id}" as an input: feature inputs must reference features declared earlier in the document, so the record list stays replayable in order.`,
            update,
          ),
        );
      }
      continue;
    }
    if (!featureInputResolves(document, ref)) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.inputUnknown,
          `Feature input (${ref.kind} "${ref.id}") does not resolve to an entity in document "${document.id}".`,
          update,
        ),
      );
    }
  }
  for (const output of outputs.value) {
    if (getBody(document, output) === undefined) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.outputUnknown,
          `Feature output body "${output}" does not exist in document "${document.id}".`,
          update,
        ),
      );
    }
  }
  const feature = Object.freeze({
    id,
    kind: kind.value,
    inputs: inputs.value,
    outputs: outputs.value,
  });
  const features = [...document.features];
  features[index] = feature;
  return ok({
    document: Object.freeze({
      ...document,
      features: Object.freeze(features),
    }),
    feature,
  });
}

/**
 * Moves the feature `id` to immediately after `afterFeatureId` (or to the
 * front when the anchor is `null`) — the Phase 20 reorder as a document
 * substrate operation. The move and its validation are the pure
 * {@link reorderFeatureRecords} rule (the input-order replayability rule is
 * enforced on the RESULT), with failures remapped to this module's stable
 * codes: an unknown moved feature is `document/not-found`; an invalid
 * anchor or an order-rule violation is `document/reorder-invalid`. Like
 * every substrate operation it is pure: the input document is untouched,
 * records keep their identities, and the id generator state is unchanged.
 */
export function reorderFeature(
  document: CadDocument,
  id: FeatureId,
  afterFeatureId: FeatureId | null,
): ParseResult<CadDocument, DocumentError> {
  const reordered = reorderFeatureRecords(
    document.features,
    id,
    afterFeatureId,
  );
  if (!reordered.ok) {
    const code =
      reordered.error.code === FEATURE_HISTORY_ERROR_CODES.reorderUnknownFeature
        ? DOCUMENT_ERROR_CODES.notFound
        : DOCUMENT_ERROR_CODES.reorderInvalid;
    return fail(docError(code, reordered.error.message, reordered.error.input));
  }
  return ok(Object.freeze({ ...document, features: reordered.value }));
}

/**
 * Adds a document-level parameter through the reused collection machinery.
 * The id is checked against the document-wide registry first (a duplicate is
 * `document/id-conflict`); the collection's own structured failures (name
 * conflicts, invalid values, expressions, metadata) propagate unchanged.
 * Without an explicit id a deterministic parameter id is generated.
 */
export function addDocumentParameter(
  document: CadDocument,
  input: DocumentParameterInput,
): ParseResult<DocumentParameterAddResult, DocumentError | ParameterError> {
  let id: ParameterId;
  let idGeneratorState = document.idGeneratorState;
  if (input.id === undefined) {
    const generated = generateId(idGeneratorState, (generator) =>
      generator.nextParameterId(),
    );
    if (!generated.ok) return generated;
    id = generated.value.id;
    idGeneratorState = generated.value.state;
  } else {
    const unclaimable = unclaimablePayloadError("parameter", input.id);
    if (unclaimable !== undefined) return fail(unclaimable);
    if (isIdRegistered(document, input.id)) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idConflict,
          `An entity with id "${input.id}" already exists in document "${document.id}".`,
          input,
        ),
      );
    }
    id = input.id;
    idGeneratorState = claimExplicitId(idGeneratorState, "parameter", input.id);
  }
  const added = addParameter(document.parameters, { ...input, id });
  if (!added.ok) return added;
  const parameter = getParameter(added.value, id);
  if (parameter === undefined) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        `The added parameter "${id}" could not be read back from the collection.`,
        input,
      ),
    );
  }
  return ok({
    document: Object.freeze({
      ...document,
      parameters: added.value,
      idGeneratorState,
    }),
    parameter,
  });
}

/**
 * Removes a document-level parameter. Refused with `in-use` while any feature
 * declares the parameter as an input; unknown ids surface the collection's
 * `parameter/not-found`.
 */
export function removeDocumentParameter(
  document: CadDocument,
  id: ParameterId,
): ParseResult<CadDocument, DocumentError | ParameterError> {
  const blocking = document.features.find((feature) =>
    feature.inputs.some((ref) => ref.kind === "parameter" && ref.id === id),
  );
  if (blocking !== undefined) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.inUse,
        `Parameter "${id}" is referenced by feature "${blocking.id}".`,
        id,
      ),
    );
  }
  const removed = removeParameter(document.parameters, id);
  if (!removed.ok) return removed;
  return ok(Object.freeze({ ...document, parameters: removed.value }));
}

/** A sketch name shares the body name rules (1-64 characters). */
function validateSketchName(name: unknown): ParseResult<string, DocumentError> {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > BODY_NAME_MAX_LENGTH
  ) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.sketchNameInvalid,
        `A sketch name must be a string of 1-${BODY_NAME_MAX_LENGTH} characters.`,
        name,
      ),
    );
  }
  return ok(name);
}

/** A sketch payload must be a plain object (its schema is the sketch domain's). */
function validateSketchPayload(
  sketch: unknown,
): ParseResult<Readonly<Record<string, unknown>>, DocumentError> {
  if (!isPlainRecord(sketch)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.sketchPayloadInvalid,
        "A sketch record's payload must be a plain object (the sketch domain's canonical serialized form).",
        sketch,
      ),
    );
  }
  return ok(sketch);
}

/**
 * Deep-freezes plain serialized data (the sketch payload's contract shape —
 * acyclic records and arrays): a recursive copy with every level frozen,
 * non-container values passing through untouched. The stored sketch record
 * thereby owns its payload outright — nothing stays shared with, or
 * mutable through, the caller's input.
 */
function deepFreezePlainData(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(deepFreezePlainData));
  }
  if (isPlainRecord(value)) {
    const frozen: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      frozen[key] = deepFreezePlainData(entry);
    }
    return Object.freeze(frozen);
  }
  return value;
}

function frozenSketchPayload(
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  // The recursion preserves the payload's shape (record in, record out).
  return deepFreezePlainData(payload) as Readonly<Record<string, unknown>>;
}

function frozenReferencePayload(
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  // The recursion preserves the payload's shape (record in, record out).
  return deepFreezePlainData(payload) as Readonly<Record<string, unknown>>;
}

/**
 * Adds a sketch document entity. The payload is stored verbatim (deeply
 * frozen — a recursive freeze over its plain data); its schema is the
 * sketch domain's, validated there on use.
 */
export function addDocumentSketch(
  document: CadDocument,
  input: DocumentSketchInput,
): ParseResult<DocumentSketchAddResult, DocumentError> {
  const name = validateSketchName(input.name);
  if (!name.ok) return name;
  const payload = validateSketchPayload(input.sketch);
  if (!payload.ok) return payload;
  let id: SketchDocumentId;
  let idGeneratorState = document.idGeneratorState;
  if (input.id === undefined) {
    const generated = generateId(idGeneratorState, (generator) =>
      generator.nextSketchDocumentId(),
    );
    if (!generated.ok) return generated;
    id = generated.value.id;
    idGeneratorState = generated.value.state;
  } else {
    const parsed = parseSketchDocumentId(input.id);
    if (!parsed.ok) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idInvalid,
          `A sketch id must be a valid sketch id: ${parsed.error.message}`,
          input.id,
        ),
      );
    }
    const unclaimable = unclaimablePayloadError("sketch", parsed.value);
    if (unclaimable !== undefined) return fail(unclaimable);
    if (isIdRegistered(document, parsed.value)) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idConflict,
          `An entity with id "${parsed.value}" already exists in document "${document.id}".`,
          input,
        ),
      );
    }
    id = parsed.value;
    idGeneratorState = claimExplicitId(
      idGeneratorState,
      "sketch",
      parsed.value,
    );
  }
  const sketch = Object.freeze({
    id,
    name: name.value,
    sketch: frozenSketchPayload(payload.value),
  });
  return ok({
    document: Object.freeze({
      ...document,
      sketches: Object.freeze([...document.sketches, sketch]),
      idGeneratorState,
    }),
    sketch,
  });
}

/**
 * Removes the sketch record with the given id. Refused with `in-use` while
 * any feature declares it as an input; removal never cascades.
 */
export function removeDocumentSketch(
  document: CadDocument,
  id: SketchDocumentId,
): ParseResult<CadDocument, DocumentError> {
  if (getDocumentSketch(document, id) === undefined) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.notFound,
        `No sketch with id "${id}" exists in document "${document.id}".`,
        id,
      ),
    );
  }
  const blocking = document.features.find((feature) =>
    feature.inputs.some((ref) => ref.kind === "sketch" && ref.id === id),
  );
  if (blocking !== undefined) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.inUse,
        `Sketch "${id}" is referenced by feature "${blocking.id}".`,
        id,
      ),
    );
  }
  return ok(
    Object.freeze({
      ...document,
      sketches: Object.freeze(
        document.sketches.filter((sketch) => sketch.id !== id),
      ),
    }),
  );
}

/** A reference name shares the body name rules (1-64 characters). */
function validateReferenceName(
  name: unknown,
): ParseResult<string, DocumentError> {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > BODY_NAME_MAX_LENGTH
  ) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.referenceNameInvalid,
        `A reference name must be a string of 1-${BODY_NAME_MAX_LENGTH} characters.`,
        name,
      ),
    );
  }
  return ok(name);
}

/** A reference payload must be a plain object (its schema is the persistent-reference module's). */
function validateReferencePayload(
  reference: unknown,
): ParseResult<Readonly<Record<string, unknown>>, DocumentError> {
  if (!isPlainRecord(reference)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.referencePayloadInvalid,
        "A reference record's payload must be a plain object (the persistent-reference module's canonical serialized form).",
        reference,
      ),
    );
  }
  return ok(reference);
}

/**
 * Adds a persistent-reference document entity. The payload is stored
 * verbatim (deeply frozen, the sketch discipline); its schema is the
 * persistent-reference module's, validated there on use
 * (`parseTopologyReference`).
 */
export function addDocumentReference(
  document: CadDocument,
  input: DocumentReferenceInput,
): ParseResult<DocumentReferenceAddResult, DocumentError> {
  const name = validateReferenceName(input.name);
  if (!name.ok) return name;
  const payload = validateReferencePayload(input.reference);
  if (!payload.ok) return payload;
  let id: ReferenceId;
  let idGeneratorState = document.idGeneratorState;
  if (input.id === undefined) {
    const generated = generateId(idGeneratorState, (generator) =>
      generator.nextReferenceId(),
    );
    if (!generated.ok) return generated;
    id = generated.value.id;
    idGeneratorState = generated.value.state;
  } else {
    const parsed = parseReferenceId(input.id);
    if (!parsed.ok) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idInvalid,
          `A reference id must be a valid reference id: ${parsed.error.message}`,
          input.id,
        ),
      );
    }
    const unclaimable = unclaimablePayloadError("reference", parsed.value);
    if (unclaimable !== undefined) return fail(unclaimable);
    if (isIdRegistered(document, parsed.value)) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idConflict,
          `An entity with id "${parsed.value}" already exists in document "${document.id}".`,
          input,
        ),
      );
    }
    id = parsed.value;
    idGeneratorState = claimExplicitId(
      idGeneratorState,
      "reference",
      parsed.value,
    );
  }
  const reference = Object.freeze({
    id,
    name: name.value,
    reference: frozenReferencePayload(payload.value),
  });
  return ok({
    document: Object.freeze({
      ...document,
      references: Object.freeze([...document.references, reference]),
      idGeneratorState,
    }),
    reference,
  });
}

/**
 * Removes the reference record with the given id. Refused with `in-use`
 * while any feature declares it as an input; removal never cascades.
 */
export function removeDocumentReference(
  document: CadDocument,
  id: ReferenceId,
): ParseResult<CadDocument, DocumentError> {
  if (getDocumentReference(document, id) === undefined) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.notFound,
        `No reference with id "${id}" exists in document "${document.id}".`,
        id,
      ),
    );
  }
  const blocking = document.features.find((feature) =>
    feature.inputs.some((ref) => ref.kind === "reference" && ref.id === id),
  );
  if (blocking !== undefined) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.inUse,
        `Reference "${id}" is referenced by feature "${blocking.id}".`,
        id,
      ),
    );
  }
  return ok(
    Object.freeze({
      ...document,
      references: Object.freeze(
        document.references.filter((reference) => reference.id !== id),
      ),
    }),
  );
}

/**
 * Returns the reference record with the given id, or undefined.
 */
export function getDocumentReference(
  document: CadDocument,
  id: ReferenceId,
): DocumentReference | undefined {
  return document.references.find((reference) => reference.id === id);
}

/** A datum name shares the body name rules (1-64 characters). */
function validateDatumName(name: unknown): ParseResult<string, DocumentError> {
  if (
    typeof name !== "string" ||
    name.length === 0 ||
    name.length > BODY_NAME_MAX_LENGTH
  ) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.datumNameInvalid,
        `A datum name must be a string of 1-${BODY_NAME_MAX_LENGTH} characters.`,
        name,
      ),
    );
  }
  return ok(name);
}

/**
 * A datum payload must be a plain object (its schema is the datum module's,
 * validated there on use through `parseDatumPayload`).
 */
function validateDatumPayload(
  datum: unknown,
): ParseResult<Readonly<Record<string, unknown>>, DocumentError> {
  if (!isPlainRecord(datum)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.datumPayloadInvalid,
        "A datum record's payload must be a plain object (the datum module's canonical serialized form).",
        datum,
      ),
    );
  }
  return ok(datum);
}

function frozenDatumPayload(
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  // The recursion preserves the payload's shape (record in, record out).
  return deepFreezePlainData(payload) as Readonly<Record<string, unknown>>;
}

/**
 * Adds a named datum document entity. The payload is stored verbatim
 * (deeply frozen, the sketch discipline); its schema is the datum module's,
 * validated there on use (`parseDatumPayload`).
 */
export function addDocumentDatum(
  document: CadDocument,
  input: DocumentDatumInput,
): ParseResult<DocumentDatumAddResult, DocumentError> {
  const name = validateDatumName(input.name);
  if (!name.ok) return name;
  const payload = validateDatumPayload(input.datum);
  if (!payload.ok) return payload;
  let id: DatumId;
  let idGeneratorState = document.idGeneratorState;
  if (input.id === undefined) {
    const generated = generateId(idGeneratorState, (generator) =>
      generator.nextDatumId(),
    );
    if (!generated.ok) return generated;
    id = generated.value.id;
    idGeneratorState = generated.value.state;
  } else {
    const parsed = parseDatumId(input.id);
    if (!parsed.ok) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idInvalid,
          `A datum id must be a valid datum id: ${parsed.error.message}`,
          input.id,
        ),
      );
    }
    const unclaimable = unclaimablePayloadError("datum", parsed.value);
    if (unclaimable !== undefined) return fail(unclaimable);
    if (isIdRegistered(document, parsed.value)) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idConflict,
          `An entity with id "${parsed.value}" already exists in document "${document.id}".`,
          input,
        ),
      );
    }
    id = parsed.value;
    idGeneratorState = claimExplicitId(idGeneratorState, "datum", parsed.value);
  }
  const datum = Object.freeze({
    id,
    name: name.value,
    datum: frozenDatumPayload(payload.value),
  });
  return ok({
    document: Object.freeze({
      ...document,
      datums: Object.freeze([...document.datums, datum]),
      idGeneratorState,
    }),
    datum,
  });
}

/**
 * Removes the datum record with the given id. Refused with `in-use` while
 * any feature declares it as an input; removal never cascades.
 */
export function removeDocumentDatum(
  document: CadDocument,
  id: DatumId,
): ParseResult<CadDocument, DocumentError> {
  if (getDocumentDatum(document, id) === undefined) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.notFound,
        `No datum with id "${id}" exists in document "${document.id}".`,
        id,
      ),
    );
  }
  const blocking = document.features.find((feature) =>
    feature.inputs.some((ref) => ref.kind === "datum" && ref.id === id),
  );
  if (blocking !== undefined) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.inUse,
        `Datum "${id}" is referenced by feature "${blocking.id}".`,
        id,
      ),
    );
  }
  return ok(
    Object.freeze({
      ...document,
      datums: Object.freeze(document.datums.filter((datum) => datum.id !== id)),
    }),
  );
}

/**
 * Returns the datum record with the given id, or undefined.
 */
export function getDocumentDatum(
  document: CadDocument,
  id: DatumId,
): DocumentDatum | undefined {
  return document.datums.find((datum) => datum.id === id);
}

/** Input of {@link addDocumentSection}: the record's authored fields. */
export interface DocumentSectionInput {
  /** An explicit id (`sec_…`), or absent to generate the next one. */
  readonly id?: SectionId;
  readonly name: string;
  readonly origin: readonly [number, number, number];
  readonly normal: readonly [number, number, number];
  readonly keepSide: 1 | -1;
  readonly enabled: boolean;
}

/** Result of {@link addDocumentSection}: the next document plus the record. */
export interface DocumentSectionAddResult {
  readonly document: CadDocument;
  readonly section: DocumentSection;
}

/**
 * Adds one section display record (Phase 46) — the datum builders'
 * discipline: an explicit id must be well formed and unclaimed (or the
 * next generated id is minted), the name carries the datum naming rule,
 * the plane must be finite with a non-zero normal, and the document's
 * record budget ({@link DOCUMENT_SECTION_LIMIT}) is a structured refusal,
 * not a silent drop.
 */
export function addDocumentSection(
  document: CadDocument,
  input: DocumentSectionInput,
): ParseResult<DocumentSectionAddResult, DocumentError> {
  if (document.sections.length >= DOCUMENT_SECTION_LIMIT) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.sectionLimitExceeded,
        `A document carries at most ${String(DOCUMENT_SECTION_LIMIT)} section display records (the viewport's clipping budget).`,
        input.name,
      ),
    );
  }
  const name =
    typeof input.name === "string" &&
    input.name.length >= 1 &&
    input.name.length <= 64
      ? input.name
      : null;
  if (name === null) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.sectionNameInvalid,
        "A section name must be a string of 1-64 characters.",
        input.name,
      ),
    );
  }
  const planeOk =
    input.origin.every((component) => Number.isFinite(component)) &&
    input.normal.every((component) => Number.isFinite(component)) &&
    input.normal[0] * input.normal[0] +
      input.normal[1] * input.normal[1] +
      input.normal[2] * input.normal[2] >
      0;
  if (!planeOk) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A section plane must carry a finite origin and a non-zero finite normal.",
        { origin: input.origin, normal: input.normal },
      ),
    );
  }
  let id: SectionId;
  let idGeneratorState = document.idGeneratorState;
  if (input.id === undefined) {
    const generated = generateId(idGeneratorState, (generator) =>
      generator.nextSectionId(),
    );
    if (!generated.ok) return generated;
    id = generated.value.id;
    idGeneratorState = generated.value.state;
  } else {
    const parsed = parseSectionId(input.id);
    if (!parsed.ok) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idInvalid,
          `A section id must be a valid section id: ${parsed.error.message}`,
          input.id,
        ),
      );
    }
    const unclaimable = unclaimablePayloadError("section", parsed.value);
    if (unclaimable !== undefined) return fail(unclaimable);
    if (isIdRegistered(document, parsed.value)) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.idConflict,
          `The section id ${String(parsed.value)} is already registered in this document.`,
          parsed.value,
        ),
      );
    }
    id = parsed.value;
  }
  const origin: readonly [number, number, number] = [
    input.origin[0],
    input.origin[1],
    input.origin[2],
  ];
  const normal: readonly [number, number, number] = [
    input.normal[0],
    input.normal[1],
    input.normal[2],
  ];
  const section: DocumentSection = Object.freeze({
    id,
    name,
    origin,
    normal,
    keepSide: input.keepSide === -1 ? -1 : 1,
    enabled: input.enabled === true,
  });
  return ok({
    document: Object.freeze({
      ...document,
      sections: Object.freeze([...document.sections, section]),
      idGeneratorState,
    }),
    section,
  });
}

/**
 * Flips one section record's display toggle in place (Phase 46): the
 * record persists either way — `enabled` is display state, and an unknown
 * id is the structured not-found refusal.
 */
export function setDocumentSectionEnabled(
  document: CadDocument,
  id: SectionId,
  enabled: boolean,
): ParseResult<CadDocument, DocumentError> {
  if (!document.sections.some((section) => section.id === id)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.notFound,
        `No section display record ${String(id)} exists in this document.`,
        id,
      ),
    );
  }
  return ok(
    Object.freeze({
      ...document,
      sections: Object.freeze(
        document.sections.map((section) =>
          section.id === id ? { ...section, enabled } : section,
        ),
      ),
    }),
  );
}

/** Reads one section display record by id, or `undefined`. */
export function getDocumentSection(
  document: CadDocument,
  id: SectionId,
): DocumentSection | undefined {
  return document.sections.find((section) => section.id === id);
}

/** Canonical JSON form of a body (the Phase 44 display flags ride only when non-default). */
export interface SerializedBody {
  readonly id: string;
  readonly name: string;
  /** Present exactly when the body is hidden; absent = visible (additive). */
  readonly visible?: false;
  /** Present exactly when the body is isolated; absent = not (additive). */
  readonly isolated?: true;
}

/** Canonical JSON form of a feature input reference. */
export interface SerializedFeatureInputRef {
  readonly kind: string;
  readonly id: string;
}

/** Canonical JSON form of a feature record. */
export interface SerializedFeatureRecord {
  readonly id: string;
  readonly kind: string;
  readonly inputs: readonly SerializedFeatureInputRef[];
  readonly outputs: readonly string[];
}

/**
 * Canonical JSON form of the id generator state. The `sketch` counter is
 * Phase 26.1-additive, the `datum` counter Phase 39-additive, and the
 * `section` counter Phase 46-additive: each is emitted exactly when
 * nonzero, so documents that never carried ids of that kind serialize
 * byte-identically to their earlier form; parsing defaults an absent
 * counter to zero.
 */
export type SerializedIdGeneratorState = Omit<
  IdGeneratorState,
  "sketch" | "datum" | "section"
> & {
  readonly sketch?: number;
  readonly datum?: number;
  readonly section?: number;
};

function serializeIdGeneratorState(
  state: IdGeneratorState,
): SerializedIdGeneratorState {
  return {
    document: state.document,
    parameter: state.parameter,
    feature: state.feature,
    body: state.body,
    reference: state.reference,
    ...(state.sketch === 0 ? {} : { sketch: state.sketch }),
    ...(state.datum === 0 ? {} : { datum: state.datum }),
    ...(state.section === 0 ? {} : { section: state.section }),
  };
}

/** Canonical JSON form of a whole document, in fixed key order. */
export interface SerializedCadDocument {
  readonly formatVersion: number;
  readonly id: string;
  readonly idGenerator: SerializedIdGeneratorState;
  readonly parameters: SerializedParameterCollection;
  readonly bodies: readonly SerializedBody[];
  readonly features: readonly SerializedFeatureRecord[];
  /** Present exactly when the document carries sketch entities (additive). */
  readonly sketches?: readonly {
    readonly id: string;
    readonly name: string;
    readonly sketch: Readonly<Record<string, unknown>>;
  }[];
  /** Present exactly when the document carries reference records (additive). */
  readonly references?: readonly {
    readonly id: string;
    readonly name: string;
    readonly reference: Readonly<Record<string, unknown>>;
  }[];
  /** Present exactly when the document carries section records (additive). */
  readonly sections?: readonly {
    readonly id: string;
    readonly name: string;
    readonly origin: readonly [number, number, number];
    readonly normal: readonly [number, number, number];
    readonly keepSide: 1 | -1;
    readonly enabled: boolean;
  }[];
  /** Present exactly when the document carries datum records (additive). */
  readonly datums?: readonly {
    readonly id: string;
    readonly name: string;
    readonly datum: Readonly<Record<string, unknown>>;
  }[];
}

/** Serializes a document to its canonical, deterministic JSON form. */
export function serializeCadDocument(
  document: CadDocument,
): SerializedCadDocument {
  return {
    formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
    id: document.id,
    idGenerator: serializeIdGeneratorState(document.idGeneratorState),
    parameters: serializeParameterCollection(document.parameters),
    bodies: document.bodies.map((body) => ({
      id: body.id,
      name: body.name,
      // The display flags ride only when non-default (Phase 44) — the
      // id-generator counter precedent — so a flagless document
      // serializes byte-identically to its pre-flag form.
      ...(body.visible === undefined || body.visible
        ? {}
        : { visible: false as const }),
      ...(body.isolated === undefined || !body.isolated
        ? {}
        : { isolated: true as const }),
    })),
    features: document.features.map((feature) => ({
      id: feature.id,
      kind: feature.kind,
      inputs: feature.inputs.map((ref) => ({ kind: ref.kind, id: ref.id })),
      outputs: [...feature.outputs],
    })),
    // Additive (Phase 26.1): emitted only when sketches exist, so documents
    // from before sketches serialize byte-identically to their old form.
    ...(document.sketches.length === 0
      ? {}
      : {
          sketches: document.sketches.map((sketch) => ({
            id: sketch.id,
            name: sketch.name,
            sketch: sketch.sketch,
          })),
        }),
    // Additive (Phase 26.5): emitted only when reference records exist, so
    // documents from before references serialize byte-identically to their
    // old form.
    ...(document.references.length === 0
      ? {}
      : {
          references: document.references.map((reference) => ({
            id: reference.id,
            name: reference.name,
            reference: reference.reference,
          })),
        }),
    // Additive (Phase 39): emitted only when datum records exist, so
    // documents from before datums serialize byte-identically to their
    // old form.
    ...(document.datums.length === 0
      ? {}
      : {
          datums: document.datums.map((datum) => ({
            id: datum.id,
            name: datum.name,
            datum: datum.datum,
          })),
        }),
    // Additive (Phase 46): emitted only when section display records
    // exist, so documents from before sections serialize byte-identically
    // to their old form.
    ...(document.sections.length === 0
      ? {}
      : {
          sections: document.sections.map((section) => ({
            id: section.id,
            name: section.name,
            origin: [...section.origin],
            normal: [...section.normal],
            keepSide: section.keepSide,
            enabled: section.enabled,
          })),
        }),
  };
}

/**
 * Validates untrusted generator state before it reaches the generator,
 * answering the RangeError the generator would otherwise throw at this trust
 * boundary with a structured `document/generator-state-invalid` failure.
 * Missing counters default to zero; unknown keys are ignored.
 */
function parseIdGeneratorState(
  input: unknown,
): ParseResult<IdGeneratorState, DocumentError> {
  if (!isPlainRecord(input)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.generatorStateInvalid,
        "The serialized id generator state must be a plain object of non-negative integer counters keyed by id kind.",
        input,
      ),
    );
  }
  const state: Record<CadIdKind, number> = { ...createIdGenerator().state() };
  for (const kind of CAD_ID_KINDS) {
    const value = input[kind];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return fail(
        docError(
          DOCUMENT_ERROR_CODES.generatorStateInvalid,
          `The id generator counter for "${kind}" must be a non-negative integer.`,
          input,
        ),
      );
    }
    state[kind] = value;
  }
  return ok(Object.freeze(state));
}

function parseSerializedBody(input: unknown): ParseResult<Body, DocumentError> {
  if (!isPlainRecord(input)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A serialized body must be a plain object with id and name fields.",
        input,
      ),
    );
  }
  const parsedId = parseBodyId(input.id);
  if (!parsedId.ok) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.idInvalid,
        `A body id must be a valid body id: ${parsedId.error.message}`,
        input.id,
      ),
    );
  }
  const name = validateBodyName(input.name);
  if (!name.ok) return name;
  // The Phase 44 display flags: strictly boolean when present (never a
  // smuggled truthy), absent meaning the default (visible, not isolated).
  if (input.visible !== undefined && typeof input.visible !== "boolean") {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A serialized body's visible flag must be a boolean when present.",
        input.visible,
      ),
    );
  }
  if (input.isolated !== undefined && typeof input.isolated !== "boolean") {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A serialized body's isolated flag must be a boolean when present.",
        input.isolated,
      ),
    );
  }
  return ok(
    Object.freeze({
      id: parsedId.value,
      name: name.value,
      ...(input.visible === undefined ? {} : { visible: input.visible }),
      ...(input.isolated === undefined ? {} : { isolated: input.isolated }),
    }),
  );
}

function parseSerializedSketch(input: unknown): ParseResult<
  {
    id: SketchDocumentId;
    name: string;
    sketch: Readonly<Record<string, unknown>>;
  },
  DocumentError
> {
  if (!isPlainRecord(input)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A serialized sketch record must be a plain object with id, name, and sketch fields.",
        input,
      ),
    );
  }
  const parsedId = parseSketchDocumentId(input.id);
  if (!parsedId.ok) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.idInvalid,
        `A sketch id must be a valid sketch id: ${parsedId.error.message}`,
        input.id,
      ),
    );
  }
  const name = validateSketchName(input.name);
  if (!name.ok) return name;
  const payload = validateSketchPayload(input.sketch);
  if (!payload.ok) return payload;
  return ok({
    id: parsedId.value,
    name: name.value,
    sketch: payload.value,
  });
}

function parseSerializedReference(input: unknown): ParseResult<
  {
    id: ReferenceId;
    name: string;
    reference: Readonly<Record<string, unknown>>;
  },
  DocumentError
> {
  if (!isPlainRecord(input)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A serialized reference record must be a plain object with id, name, and reference fields.",
        input,
      ),
    );
  }
  const parsedId = parseReferenceId(input.id);
  if (!parsedId.ok) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.idInvalid,
        `A reference id must be a valid reference id: ${parsedId.error.message}`,
        input.id,
      ),
    );
  }
  const name = validateReferenceName(input.name);
  if (!name.ok) return name;
  const payload = validateReferencePayload(input.reference);
  if (!payload.ok) return payload;
  return ok({
    id: parsedId.value,
    name: name.value,
    reference: payload.value,
  });
}

function parseSerializedSection(
  input: unknown,
): ParseResult<DocumentSection, DocumentError> {
  if (!isPlainRecord(input)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A serialized section record must be a plain object with id, name, origin, normal, keepSide, and enabled fields.",
        input,
      ),
    );
  }
  const parsedId = parseSectionId(input.id);
  if (!parsedId.ok) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.idInvalid,
        `A section id must be a valid section id: ${parsedId.error.message}`,
        input.id,
      ),
    );
  }
  const origin = parseSectionTriple(input.origin);
  if (!origin.ok) return origin;
  const normal = parseSectionTriple(input.normal);
  if (!normal.ok) return normal;
  if (
    !(
      normal.value[0] * normal.value[0] +
        normal.value[1] * normal.value[1] +
        normal.value[2] * normal.value[2] >
      0
    )
  ) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A serialized section normal must be a non-zero finite vector.",
        input.normal,
      ),
    );
  }
  if (input.keepSide !== 1 && input.keepSide !== -1) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A serialized section keepSide must be 1 or -1.",
        input.keepSide,
      ),
    );
  }
  if (typeof input.enabled !== "boolean") {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A serialized section enabled field must be a boolean.",
        input.enabled,
      ),
    );
  }
  const name = validateSectionName(input.name);
  if (!name.ok) return name;
  return ok(
    Object.freeze({
      id: parsedId.value,
      name: name.value,
      origin: origin.value,
      normal: normal.value,
      keepSide: input.keepSide,
      enabled: input.enabled,
    }),
  );
}

/** Parses a finite [x, y, z] triple or fails structured. */
function parseSectionTriple(
  input: unknown,
): ParseResult<[number, number, number], DocumentError> {
  // The element-wise copy keeps the element type `unknown` (never the
  // `any` Array.isArray narrows to), so every component narrows through
  // its own typeof/finite check below.
  const source: readonly unknown[] | null = Array.isArray(input)
    ? (input as readonly unknown[])
    : null;
  const entries: readonly unknown[] =
    source === null ? [] : [source[0], source[1], source[2]];
  if (entries === null || entries.length !== 3) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A serialized section triple must be an array of exactly three finite numbers.",
        input,
      ),
    );
  }
  const first = entries[0];
  const second = entries[1];
  const third = entries[2];
  if (
    typeof first !== "number" ||
    !Number.isFinite(first) ||
    typeof second !== "number" ||
    !Number.isFinite(second) ||
    typeof third !== "number" ||
    !Number.isFinite(third)
  ) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A serialized section triple must be an array of exactly three finite numbers.",
        input,
      ),
    );
  }
  return ok([first, second, third]);
}

function validateSectionName(
  input: unknown,
): ParseResult<string, DocumentError> {
  if (typeof input !== "string" || input.length < 1 || input.length > 64) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.sectionNameInvalid,
        "A section name must be a string of 1-64 characters.",
        input,
      ),
    );
  }
  return ok(input);
}

function parseSerializedDatum(input: unknown): ParseResult<
  {
    id: DatumId;
    name: string;
    datum: Readonly<Record<string, unknown>>;
  },
  DocumentError
> {
  if (!isPlainRecord(input)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A serialized datum record must be a plain object with id, name, and datum fields.",
        input,
      ),
    );
  }
  const parsedId = parseDatumId(input.id);
  if (!parsedId.ok) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.idInvalid,
        `A datum id must be a valid datum id: ${parsedId.error.message}`,
        input.id,
      ),
    );
  }
  const name = validateDatumName(input.name);
  if (!name.ok) return name;
  const payload = validateDatumPayload(input.datum);
  if (!payload.ok) return payload;
  return ok({
    id: parsedId.value,
    name: name.value,
    datum: payload.value,
  });
}

function parseSerializedFeature(
  input: unknown,
): ParseResult<FeatureRecord, DocumentError> {
  if (!isPlainRecord(input)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A serialized feature must be a plain object with id, kind, inputs, and outputs fields.",
        input,
      ),
    );
  }
  const parsedId = parseFeatureId(input.id);
  if (!parsedId.ok) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.idInvalid,
        `A feature id must be a valid feature id: ${parsedId.error.message}`,
        input.id,
      ),
    );
  }
  const kind = parseFeatureKind(input.kind);
  if (!kind.ok) return kind;
  const inputs = parseFeatureInputRefs(input.inputs);
  if (!inputs.ok) return inputs;
  const outputs = parseBodyIdList(input.outputs);
  if (!outputs.ok) return outputs;
  return ok(
    Object.freeze({
      id: parsedId.value,
      kind: kind.value,
      inputs: inputs.value,
      outputs: outputs.value,
    }),
  );
}

function parseSerializedList<T>(
  input: unknown,
  what: string,
  parseItem: (item: unknown) => ParseResult<T, DocumentError>,
): ParseResult<readonly T[], DocumentError> {
  if (!Array.isArray(input)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        `The serialized ${what} must be an array.`,
        input,
      ),
    );
  }
  const items: T[] = [];
  for (const entry of input) {
    const parsed = parseItem(entry);
    if (!parsed.ok) return parsed;
    items.push(parsed.value);
  }
  return ok(Object.freeze(items));
}

/**
 * Parses untrusted input (e.g. a document revived from persisted JSON) as a
 * {@link CadDocument}. Every field is validated strictly — including the id
 * generator state, before it is used — and unknown fields are ignored so
 * future format versions deserialize without data corruption. The document
 * is rebuilt by replaying the same add paths used at authoring time, which
 * re-establishes the document-wide id registry and the "all references
 * resolve" invariant; finally the persisted generator state is revived and
 * raised past every numeric id present, so a tampered, lowered state cannot
 * make the revived document re-emit an existing id.
 */
export function parseCadDocument(
  input: unknown,
): ParseResult<CadDocument, DocumentError | ParameterError> {
  if (!isPlainRecord(input)) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.malformed,
        "A serialized CAD document must be a plain object.",
        input,
      ),
    );
  }
  if (input.formatVersion !== CAD_DOCUMENT_FORMAT_VERSION) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.versionUnsupported,
        `A serialized document must carry formatVersion ${CAD_DOCUMENT_FORMAT_VERSION}.`,
        input.formatVersion,
      ),
    );
  }
  const parsedId = parseDocumentId(input.id);
  if (!parsedId.ok) {
    return fail(
      docError(
        DOCUMENT_ERROR_CODES.idInvalid,
        `A document id must be a valid document id: ${parsedId.error.message}`,
        input.id,
      ),
    );
  }
  const unclaimableDocId = unclaimablePayloadError("document", parsedId.value);
  if (unclaimableDocId !== undefined) return fail(unclaimableDocId);
  const parsedGeneratorState = parseIdGeneratorState(input.idGenerator);
  if (!parsedGeneratorState.ok) return parsedGeneratorState;
  const parsedParameters = parseParameterCollection(input.parameters);
  if (!parsedParameters.ok) return parsedParameters;
  const parsedBodies = parseSerializedList(
    input.bodies,
    "bodies",
    parseSerializedBody,
  );
  if (!parsedBodies.ok) return parsedBodies;
  const parsedSketches = parseSerializedList(
    input.sketches ?? [],
    "sketches",
    parseSerializedSketch,
  );
  if (!parsedSketches.ok) return parsedSketches;
  const parsedReferences = parseSerializedList(
    input.references ?? [],
    "references",
    parseSerializedReference,
  );
  if (!parsedReferences.ok) return parsedReferences;
  const parsedDatums = parseSerializedList(
    input.datums ?? [],
    "datums",
    parseSerializedDatum,
  );
  if (!parsedDatums.ok) return parsedDatums;
  const parsedSections = parseSerializedList(
    input.sections ?? [],
    "sections",
    parseSerializedSection,
  );
  if (!parsedSections.ok) return parsedSections;
  const parsedFeatures = parseSerializedList(
    input.features,
    "features",
    parseSerializedFeature,
  );
  if (!parsedFeatures.ok) return parsedFeatures;

  let document = createDocument(parsedId.value);
  for (const parameter of parsedParameters.value.parameters) {
    const added = addDocumentParameter(document, parameter);
    if (!added.ok) return added;
    document = added.value.document;
  }
  for (const sketch of parsedSketches.value) {
    const added = addDocumentSketch(document, sketch);
    if (!added.ok) return added;
    document = added.value.document;
  }
  for (const reference of parsedReferences.value) {
    const added = addDocumentReference(document, reference);
    if (!added.ok) return added;
    document = added.value.document;
  }
  for (const datum of parsedDatums.value) {
    const added = addDocumentDatum(document, datum);
    if (!added.ok) return added;
    document = added.value.document;
  }
  for (const section of parsedSections.value) {
    const added = addDocumentSection(document, section);
    if (!added.ok) return added;
    document = added.value.document;
  }
  for (const body of parsedBodies.value) {
    const added = addBody(document, {
      id: body.id,
      name: body.name,
      ...(body.visible === undefined ? {} : { visible: body.visible }),
      ...(body.isolated === undefined ? {} : { isolated: body.isolated }),
    });
    if (!added.ok) return added;
    document = added.value.document;
  }
  for (const feature of parsedFeatures.value) {
    const added = addFeature(document, {
      id: feature.id,
      kind: feature.kind,
      inputs: feature.inputs,
      outputs: feature.outputs,
    });
    if (!added.ok) return added;
    document = added.value.document;
  }
  return ok(
    Object.freeze({
      ...document,
      idGeneratorState: raiseGeneratorState(
        parsedGeneratorState.value,
        document.idGeneratorState,
      ),
    }),
  );
}
