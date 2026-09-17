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
  type DocumentId,
  type FeatureId,
  type IdGenerator,
  type IdGeneratorState,
  parseBodyId,
  parseDocumentId,
  parseFeatureId,
  parseParameterId,
  type ParameterId,
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

/** A solid/body entry of the document, identified by its stable {@link BodyId}. */
export interface Body {
  readonly id: BodyId;
  readonly name: string;
}

/** Input accepted by {@link addBody}; the id is generated when omitted. */
export interface BodyInput {
  readonly id?: BodyId;
  readonly name: string;
}

/**
 * A typed reference to an entity a feature consumes. The `kind`/`id` pair is
 * validated for consistency (the id must carry the wire prefix of its
 * declared kind).
 */
export type FeatureInputRef =
  | { readonly kind: "parameter"; readonly id: ParameterId }
  | { readonly kind: "feature"; readonly id: FeatureId }
  | { readonly kind: "body"; readonly id: BodyId };

/** The entity kinds a feature input may reference. */
export const FEATURE_INPUT_KINDS = ["parameter", "feature", "body"] as const;

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
  /**
   * Persisted counters of the document's id generator. Serializing this
   * state (and raising it past every numeric id at parse time) is what keeps
   * generated ids unique across save/load.
   */
  readonly idGeneratorState: IdGeneratorState;
}

/** A kind-tagged view of any entity resolvable by id within a document. */
export type DocumentEntity =
  | { readonly kind: "parameter"; readonly parameter: Parameter }
  | { readonly kind: "body"; readonly body: Body }
  | { readonly kind: "feature"; readonly feature: FeatureRecord };

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

/** Stable failure codes produced when document input is rejected. */
export const DOCUMENT_ERROR_CODES = {
  malformed: "document/malformed",
  versionUnsupported: "document/version-unsupported",
  generatorStateInvalid: "document/generator-state-invalid",
  generatorExhausted: "document/generator-exhausted",
  idInvalid: "document/id-invalid",
  idConflict: "document/id-conflict",
  bodyNameInvalid: "document/body-name-invalid",
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
  if (typeof name !== "string" || name.length === 0 || name.length > BODY_NAME_MAX_LENGTH) {
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

function parseBodyIdList(input: unknown): ParseResult<readonly BodyId[], DocumentError> {
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
    document.features.some((feature) => feature.id === id)
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
  const body = Object.freeze({ id, name: name.value });
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
      bodies: Object.freeze(
        document.bodies.filter((body) => body.id !== id),
      ),
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
    idGeneratorState = claimExplicitId(idGeneratorState, "feature", parsed.value);
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
  const reordered = reorderFeatureRecords(document.features, id, afterFeatureId);
  if (!reordered.ok) {
    const code =
      reordered.error.code === FEATURE_HISTORY_ERROR_CODES.reorderUnknownFeature
        ? DOCUMENT_ERROR_CODES.notFound
        : DOCUMENT_ERROR_CODES.reorderInvalid;
    return fail(docError(code, reordered.error.message, reordered.error.input));
  }
  return ok(
    Object.freeze({ ...document, features: reordered.value }),
  );
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

/** Canonical JSON form of a body. */
export interface SerializedBody {
  readonly id: string;
  readonly name: string;
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

/** Canonical JSON form of a whole document, in fixed key order. */
export interface SerializedCadDocument {
  readonly formatVersion: number;
  readonly id: string;
  readonly idGenerator: IdGeneratorState;
  readonly parameters: SerializedParameterCollection;
  readonly bodies: readonly SerializedBody[];
  readonly features: readonly SerializedFeatureRecord[];
}

/** Serializes a document to its canonical, deterministic JSON form. */
export function serializeCadDocument(
  document: CadDocument,
): SerializedCadDocument {
  return {
    formatVersion: CAD_DOCUMENT_FORMAT_VERSION,
    id: document.id,
    idGenerator: document.idGeneratorState,
    parameters: serializeParameterCollection(document.parameters),
    bodies: document.bodies.map((body) => ({ id: body.id, name: body.name })),
    features: document.features.map((feature) => ({
      id: feature.id,
      kind: feature.kind,
      inputs: feature.inputs.map((ref) => ({ kind: ref.kind, id: ref.id })),
      outputs: [...feature.outputs],
    })),
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
  return ok(Object.freeze({ id: parsedId.value, name: name.value }));
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
  const parsedBodies = parseSerializedList(input.bodies, "bodies", parseSerializedBody);
  if (!parsedBodies.ok) return parsedBodies;
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
  for (const body of parsedBodies.value) {
    const added = addBody(document, { id: body.id, name: body.name });
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
