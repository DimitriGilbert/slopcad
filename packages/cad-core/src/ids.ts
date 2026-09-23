/**
 * Branded, type-distinct identifiers for the kernel-neutral CAD document
 * model: documents, parameters, features, bodies, and references.
 *
 * Every id is a plain string in a documented wire format (`<prefix>_<payload>`,
 * e.g. `param_width` or `feat_000042`) so ids serialize, compare, and index
 * like strings while the type system prevents accidentally mixing kinds — a
 * `ParameterId` is not assignable where a `FeatureId` is expected, and a bare
 * string is not assignable where any branded id is expected. These ids are the
 * identity foundation for the document model, feature graph, references, and
 * persistence in later phases.
 */

import { type ParseResult, fail, ok } from "./result";

/**
 * Sole branding site of the package. A `unique symbol` property keeps id
 * kinds mutually incompatible at the type level while remaining invisible at
 * runtime, so branded ids stay plain serializable strings.
 */
declare const cadIdBrand: unique symbol;

type BrandedId<K extends CadIdKind> = string & {
  readonly [cadIdBrand]: K;
};

/** The domain object kinds that carry branded ids. */
export const CAD_ID_KINDS = [
  "document",
  "parameter",
  "feature",
  "body",
  "reference",
  "sketch",
  "datum",
  "section",
  "occurrence",
  "curve",
  "sheet",
  "drawingView",
  "mate",
  "joint",
] as const;

export type CadIdKind = (typeof CAD_ID_KINDS)[number];

/** Identifier of a CAD document (e.g. `doc_root`). */
export type DocumentId = BrandedId<"document">;
/** Identifier of a document-level parameter (e.g. `param_width`). */
export type ParameterId = BrandedId<"parameter">;
/** Identifier of a feature record in the feature graph (e.g. `feat_extrude-1`). */
export type FeatureId = BrandedId<"feature">;
/** Identifier of a solid/body produced by the feature graph (e.g. `body_solid`). */
export type BodyId = BrandedId<"body">;
/**
 * Identifier of a persistent reference to a domain or topology entity
 * (e.g. `ref_face-top`), kept separate from raw kernel handles by design.
 */
export type ReferenceId = BrandedId<"reference">;
/**
 * Identifier of a sketch document entity (e.g. `skd_profile-base`): the
 * document-resident record a feature input references when the feature
 * consumes a sketch's profile (Phase 26.1's extrude).
 */
export type SketchDocumentId = BrandedId<"sketch">;
/**
 * Identifier of a named datum entity (e.g. `dtm_plane-top`): the
 * document-resident record of datum reference geometry — a plane, an axis,
 * a point, or a coordinate system (Phase 39) — that features and sketches
 * address through the `datum` input kind.
 */
export type DatumId = BrandedId<"datum">;
/**
 * Identifier of a section display record (e.g. `sec_mid-height`): the
 * document-resident, non-destructive section plane the viewport clips
 * and measures on (Phase 46) — display state persisted as a model
 * artifact, the roadmap's document-record recommendation.
 */
export type SectionId = BrandedId<"section">;
/**
 * Identifier of a component occurrence (e.g. `occ_bolt-1`): the
 * document-resident record that places a source — a body of the same
 * document, another document, or a registry component — into the
 * document's assembly tree (Phase 50). An occurrence PATH (the chain of
 * occurrence ids from the root document to a leaf) is the stable address
 * every later assembly phase (mates, patterns, BOM tables) uses.
 */
export type OccurrenceId = BrandedId<"occurrence">;
/**
 * Identifier of a 3D curve entity (e.g. `crv_spine-guide`): the
 * document-resident record of a free-standing curve — spline, helix, or
 * equation curve (Phase 47) — that sweep features address through the
 * `curve` input kind.
 */
export type CurveId = BrandedId<"curve">;
/**
 * Identifier of a drawing sheet (e.g. `sht_000001`): the document-resident
 * record of one drawing sheet — a standard size, an orientation, and the
 * views placed on it (Phase 53).
 */
export type SheetId = BrandedId<"sheet">;
/**
 * Identifier of a drawing view (e.g. `dwv_front`): one projected base view
 * — front, top, right, or isometric — placed on a sheet at a scale, possibly
 * aligned to a parent base view (Phase 53).
 */
export type DrawingViewId = BrandedId<"drawingView">;
/**
 * Identifier of an assembly mate (e.g. `mat_face-flush`): the
 * document-resident record constraining two occurrences' mated topology
 * through persistent references (Phase 51).
 */
export type MateId = BrandedId<"mate">;
/**
 * Identifier of an assembly joint (e.g. `jnt_hinge`): the document-resident
 * record granting a motion vocabulary between two occurrences (Phase 51).
 */
export type JointId = BrandedId<"joint">;

type CadIdTable = {
  document: DocumentId;
  parameter: ParameterId;
  feature: FeatureId;
  body: BodyId;
  reference: ReferenceId;
  sketch: SketchDocumentId;
  datum: DatumId;
  section: SectionId;
  occurrence: OccurrenceId;
  curve: CurveId;
  sheet: SheetId;
  drawingView: DrawingViewId;
  mate: MateId;
  joint: JointId;
};

/** The branded id type of a given id kind. */
export type CadId<K extends CadIdKind> = CadIdTable[K];

/** Union of every branded id kind; accepted wherever any domain id fits. */
export type AnyCadId = CadIdTable[keyof CadIdTable];

/**
 * Canonical wire prefixes. The prefix determines the kind of an id on the
 * wire; prefixes are lowercase and case-sensitive.
 */
export const CAD_ID_PREFIXES: Readonly<Record<CadIdKind, string>> = {
  document: "doc",
  parameter: "param",
  feature: "feat",
  body: "body",
  reference: "ref",
  sketch: "skd",
  datum: "dtm",
  section: "sec",
  occurrence: "occ",
  curve: "crv",
  sheet: "sht",
  drawingView: "dwv",
  mate: "mat",
  joint: "jnt",
};

const PREFIX_TO_KIND: ReadonlyMap<string, CadIdKind> = new Map(
  CAD_ID_KINDS.map((kind) => [CAD_ID_PREFIXES[kind], kind] as const),
);

/**
 * Maximum length of the payload after the `<prefix>_` separator. Payloads may
 * use `A-Z a-z 0-9 . _ -` and must start with an alphanumeric character, so
 * explicit user-provided ids stay readable while remaining safe as object
 * keys and filename components.
 */
export const CAD_ID_MAX_PAYLOAD_LENGTH = 64;

const ID_PAYLOAD_PATTERN = new RegExp(
  `^[A-Za-z0-9][A-Za-z0-9._-]{0,${CAD_ID_MAX_PAYLOAD_LENGTH - 1}}$`,
);

/** Stable failure codes produced when an id fails wire-format validation. */
export const ID_ERROR_CODES = {
  notAString: "id/not-a-string",
  empty: "id/empty",
  wrongPrefix: "id/wrong-prefix",
  invalidPayload: "id/invalid-payload",
} as const;

export type IdErrorCode = (typeof ID_ERROR_CODES)[keyof typeof ID_ERROR_CODES];

/** Structured failure describing why input was rejected as an id. */
export interface IdParseError {
  readonly code: IdErrorCode;
  readonly message: string;
  readonly input: unknown;
}

function idError(
  code: IdErrorCode,
  message: string,
  input: unknown,
): IdParseError {
  return { code, message, input };
}

/**
 * Core wire-format validator shared by every kind. This is the single place
 * where a validated string is trusted as a branded id; the cast only brands
 * input that has already passed the checks above.
 */
function parseIdOfKind<K extends CadIdKind>(
  kind: K,
  input: unknown,
): ParseResult<CadId<K>, IdParseError> {
  if (typeof input !== "string") {
    return fail(
      idError(
        ID_ERROR_CODES.notAString,
        `A ${kind} id must be a string.`,
        input,
      ),
    );
  }
  if (input.length === 0) {
    return fail(
      idError(ID_ERROR_CODES.empty, `A ${kind} id must not be empty.`, input),
    );
  }
  const prefix = `${CAD_ID_PREFIXES[kind]}_`;
  if (!input.startsWith(prefix)) {
    return fail(
      idError(
        ID_ERROR_CODES.wrongPrefix,
        `A ${kind} id must start with "${prefix}".`,
        input,
      ),
    );
  }
  const payload = input.slice(prefix.length);
  if (!ID_PAYLOAD_PATTERN.test(payload)) {
    return fail(
      idError(
        ID_ERROR_CODES.invalidPayload,
        `The payload of a ${kind} id must be 1-${CAD_ID_MAX_PAYLOAD_LENGTH} characters, start alphanumeric, and use only A-Z a-z 0-9 . _ - .`,
        input,
      ),
    );
  }
  return ok(input as CadId<K>);
}

/** Parses untrusted input as a {@link DocumentId}. */
export function parseDocumentId(
  input: unknown,
): ParseResult<DocumentId, IdParseError> {
  return parseIdOfKind("document", input);
}

/** Parses untrusted input as a {@link ParameterId}. */
export function parseParameterId(
  input: unknown,
): ParseResult<ParameterId, IdParseError> {
  return parseIdOfKind("parameter", input);
}

/** Parses untrusted input as a {@link FeatureId}. */
export function parseFeatureId(
  input: unknown,
): ParseResult<FeatureId, IdParseError> {
  return parseIdOfKind("feature", input);
}

/** Parses untrusted input as a {@link BodyId}. */
export function parseBodyId(input: unknown): ParseResult<BodyId, IdParseError> {
  return parseIdOfKind("body", input);
}

/** Parses untrusted input as a {@link ReferenceId}. */
export function parseReferenceId(
  input: unknown,
): ParseResult<ReferenceId, IdParseError> {
  return parseIdOfKind("reference", input);
}

/** Parses untrusted input as a {@link SketchDocumentId}. */
export function parseSketchDocumentId(
  input: unknown,
): ParseResult<SketchDocumentId, IdParseError> {
  return parseIdOfKind("sketch", input);
}

/** Parses untrusted input as a {@link SectionId}. */
export function parseSectionId(
  input: unknown,
): ParseResult<SectionId, IdParseError> {
  return parseIdOfKind("section", input);
}

/** Parses untrusted input as an {@link OccurrenceId}. */
export function parseOccurrenceId(
  input: unknown,
): ParseResult<OccurrenceId, IdParseError> {
  return parseIdOfKind("occurrence", input);
}

/** Parses untrusted input as a {@link MateId}. */
export function parseMateId(input: unknown): ParseResult<MateId, IdParseError> {
  return parseIdOfKind("mate", input);
}

/** Parses untrusted input as a {@link JointId}. */
export function parseJointId(
  input: unknown,
): ParseResult<JointId, IdParseError> {
  return parseIdOfKind("joint", input);
}

/** Parses untrusted input as a {@link DatumId}. */
export function parseDatumId(
  input: unknown,
): ParseResult<DatumId, IdParseError> {
  return parseIdOfKind("datum", input);
}

/** Parses untrusted input as a {@link CurveId}. */
export function parseCurveId(
  input: unknown,
): ParseResult<CurveId, IdParseError> {
  return parseIdOfKind("curve", input);
}

/** Parses untrusted input as a {@link SheetId}. */
export function parseSheetId(
  input: unknown,
): ParseResult<SheetId, IdParseError> {
  return parseIdOfKind("sheet", input);
}

/** Parses untrusted input as a {@link DrawingViewId}. */
export function parseDrawingViewId(
  input: unknown,
): ParseResult<DrawingViewId, IdParseError> {
  return parseIdOfKind("drawingView", input);
}

/** An id of any kind together with the kind it was recognized as. */
export interface ParsedCadId<K extends CadIdKind = CadIdKind> {
  readonly kind: K;
  readonly id: CadId<K>;
}

/**
 * Parses untrusted input as an id of any kind, classifying it by its wire
 * prefix. Used where the expected kind is not statically known (generic
 * stores, persisted payloads).
 */
export function parseAnyCadId(
  input: unknown,
): ParseResult<ParsedCadId, IdParseError> {
  if (typeof input !== "string") {
    return fail(
      idError(ID_ERROR_CODES.notAString, "A CAD id must be a string.", input),
    );
  }
  if (input.length === 0) {
    return fail(
      idError(ID_ERROR_CODES.empty, "A CAD id must not be empty.", input),
    );
  }
  const separator = input.indexOf("_");
  if (separator <= 0) {
    return fail(
      idError(
        ID_ERROR_CODES.wrongPrefix,
        `A CAD id must start with one of: ${CAD_ID_KINDS.map(
          (kind) => `"${CAD_ID_PREFIXES[kind]}_"`,
        ).join(", ")}.`,
        input,
      ),
    );
  }
  const kind = PREFIX_TO_KIND.get(input.slice(0, separator));
  if (kind === undefined) {
    return fail(
      idError(
        ID_ERROR_CODES.wrongPrefix,
        `Unknown id prefix "${input.slice(0, separator + 1)}"; expected one of: ${CAD_ID_KINDS.map(
          (known) => `"${CAD_ID_PREFIXES[known]}_"`,
        ).join(", ")}.`,
        input,
      ),
    );
  }
  const parsed = parseIdOfKind(kind, input);
  if (!parsed.ok) return parsed;
  return ok({ kind, id: parsed.value });
}

/** Thrown by the `create*Id` constructors when input violates the wire format. */
export class CadIdValidationError extends Error {
  readonly error: IdParseError;

  constructor(error: IdParseError) {
    super(error.message);
    this.name = "CadIdValidationError";
    this.error = error;
  }
}

function createId<K extends CadIdKind>(
  kind: K,
  raw: string,
): ParseResult<CadId<K>, IdParseError> {
  return parseIdOfKind(kind, raw);
}

function requireId<K extends CadIdKind>(kind: K, raw: string): CadId<K> {
  const result = createId(kind, raw);
  if (!result.ok) throw new CadIdValidationError(result.error);
  return result.value;
}

/**
 * Adopts an explicit user-provided document id exactly as given. The id must
 * already match the `doc_…` wire format; it is never rewritten or normalized.
 * Throws {@link CadIdValidationError} otherwise.
 */
export function createDocumentId(raw: string): DocumentId {
  return requireId("document", raw);
}

/**
 * Adopts an explicit user-provided parameter id exactly as given
 * (`param_…` wire format). Throws {@link CadIdValidationError} on mismatch.
 */
export function createParameterId(raw: string): ParameterId {
  return requireId("parameter", raw);
}

/**
 * Adopts an explicit user-provided feature id exactly as given
 * (`feat_…` wire format). Throws {@link CadIdValidationError} on mismatch.
 */
export function createFeatureId(raw: string): FeatureId {
  return requireId("feature", raw);
}

/**
 * Adopts an explicit user-provided body id exactly as given
 * (`body_…` wire format). Throws {@link CadIdValidationError} on mismatch.
 */
export function createBodyId(raw: string): BodyId {
  return requireId("body", raw);
}

/**
 * Adopts an explicit user-provided reference id exactly as given
 * (`ref_…` wire format). Throws {@link CadIdValidationError} on mismatch.
 */
export function createReferenceId(raw: string): ReferenceId {
  return requireId("reference", raw);
}

/**
 * Adopts an explicit user-provided sketch document id exactly as given
 * (`skd_…` wire format). Throws {@link CadIdValidationError} on mismatch.
 */
export function createSketchDocumentId(raw: string): SketchDocumentId {
  return requireId("sketch", raw);
}

/**
 * Adopts an explicit user-provided datum id exactly as given (`dtm_…` wire
 * format). Throws {@link CadIdValidationError} on mismatch.
 */
export function createDatumId(raw: string): DatumId {
  return requireId("datum", raw);
}

/**
 * Adopts an explicit user-provided section id exactly as given (`sec_…`
 * wire format). Throws {@link CadIdValidationError} on mismatch.
 */
export function createSectionId(raw: string): SectionId {
  return requireId("section", raw);
}
/**
 * Adopts an explicit user-provided curve id exactly as given (`crv_…` wire
 * format). Throws {@link CadIdValidationError} on mismatch.
 */
export function createCurveId(raw: string): CurveId {
  return requireId("curve", raw);
}

/**
 * Adopts an explicit user-provided occurrence id exactly as given (`occ_…`
 * wire format). Throws {@link CadIdValidationError} on mismatch.
 */
export function createOccurrenceId(raw: string): OccurrenceId {
  return requireId("occurrence", raw);
}

/**
 * Adopts an explicit user-provided sheet id exactly as given (`sht_…` wire
 * format). Throws {@link CadIdValidationError} on mismatch.
 */
export function createSheetId(raw: string): SheetId {
  return requireId("sheet", raw);
}

/**
 * Adopts an explicit user-provided drawing view id exactly as given
 * (`dwv_…` wire format). Throws {@link CadIdValidationError} on mismatch.
 */
export function createDrawingViewId(raw: string): DrawingViewId {
  return requireId("drawingView", raw);
}

/**
 * Adopts an explicit user-provided mate id exactly as given (`mat_…` wire
 * format). Throws {@link CadIdValidationError} on mismatch.
 */
export function createMateId(raw: string): MateId {
  return requireId("mate", raw);
}

/**
 * Adopts an explicit user-provided joint id exactly as given (`jnt_…` wire
 * format). Throws {@link CadIdValidationError} on mismatch.
 */
export function createJointId(raw: string): JointId {
  return requireId("joint", raw);
}

/**
 * Serializable per-kind counters of an {@link IdGenerator}. Persisting this
 * state lets a reloaded document resume id generation without collisions.
 */
export type IdGeneratorState = Readonly<Record<CadIdKind, number>>;

/**
 * Stable failure code carried by {@link CadIdGeneratorExhaustedError} when
 * the generator refuses to emit an id past the exact-integer range.
 */
export const ID_GENERATOR_ERROR_CODES = {
  exhausted: "id/generator-exhausted",
} as const;

export type IdGeneratorErrorCode =
  (typeof ID_GENERATOR_ERROR_CODES)[keyof typeof ID_GENERATOR_ERROR_CODES];

/**
 * Thrown by the {@link IdGenerator} methods when the counter for a kind is
 * already at Number.MAX_SAFE_INTEGER. Ids with numeric payloads beyond
 * 2^53 - 1 are outside the generator's contract — float64 counters stop
 * being exact there, and continuing would let rounding re-emit an id the
 * generator already produced — so the generator refuses structurally
 * instead. The exhausted counter is left untouched and every other kind
 * keeps emitting.
 */
export class CadIdGeneratorExhaustedError extends Error {
  readonly code: IdGeneratorErrorCode;
  readonly kind: CadIdKind;

  constructor(kind: CadIdKind) {
    super(
      `The ${kind} id counter has reached Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}); ids with numeric payloads beyond it are outside the generator's contract.`,
    );
    this.name = "CadIdGeneratorExhaustedError";
    this.code = ID_GENERATOR_ERROR_CODES.exhausted;
    this.kind = kind;
  }
}

/**
 * Deterministic generator of document-scoped ids. Each `next*` method throws
 * {@link CadIdGeneratorExhaustedError} — leaving the counter untouched —
 * when that kind's counter is already at Number.MAX_SAFE_INTEGER, so
 * emission never leaves the exact-integer range.
 */
export interface IdGenerator {
  nextDocumentId(): DocumentId;
  nextParameterId(): ParameterId;
  nextFeatureId(): FeatureId;
  nextBodyId(): BodyId;
  nextReferenceId(): ReferenceId;
  nextSketchDocumentId(): SketchDocumentId;
  nextDatumId(): DatumId;
  nextSectionId(): SectionId;
  nextOccurrenceId(): OccurrenceId;
  nextCurveId(): CurveId;
  nextSheetId(): SheetId;
  nextDrawingViewId(): DrawingViewId;
  nextMateId(): MateId;
  nextJointId(): JointId;
  /** Immutable snapshot of the counters; round-trips through JSON. */
  state(): IdGeneratorState;
}

const DEFAULT_GENERATOR_STATE: IdGeneratorState = Object.freeze({
  document: 0,
  parameter: 0,
  feature: 0,
  body: 0,
  reference: 0,
  sketch: 0,
  datum: 0,
  section: 0,
  occurrence: 0,
  curve: 0,
  sheet: 0,
  drawingView: 0,
  mate: 0,
  joint: 0,
});

/** Width of the zero-padded counter in generated ids (`feat_000042`). */
const ID_COUNTER_WIDTH = 6;

function normalizeGeneratorState(
  initial: IdGeneratorState,
): Record<CadIdKind, number> {
  const counters: Record<CadIdKind, number> = {
    ...DEFAULT_GENERATOR_STATE,
    ...initial,
  };
  for (const kind of CAD_ID_KINDS) {
    const count = counters[kind];
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError(
        `IdGeneratorState.${kind} must be a non-negative integer, received ${String(count)}.`,
      );
    }
  }
  return counters;
}

/**
 * Creates a deterministic id generator. Identical starting state always
 * produces identical id sequences (no randomness, no clock), which keeps
 * command replay and document regeneration reproducible. Generated ids pass
 * through the wire-format validators, so a generator can never emit an id
 * that would fail to parse — and never a numeric payload beyond
 * Number.MAX_SAFE_INTEGER (2^53 - 1): once a counter reaches that bound the
 * next method throws {@link CadIdGeneratorExhaustedError} instead, so
 * float64 rounding can never make the generator re-emit an id it has
 * already produced.
 */
export function createIdGenerator(
  initial: IdGeneratorState = DEFAULT_GENERATOR_STATE,
): IdGenerator {
  const counters = normalizeGeneratorState(initial);
  const nextRawId = (kind: CadIdKind): string => {
    const current = counters[kind];
    if (current >= Number.MAX_SAFE_INTEGER) {
      throw new CadIdGeneratorExhaustedError(kind);
    }
    const count = current + 1;
    counters[kind] = count;
    return `${CAD_ID_PREFIXES[kind]}_${String(count).padStart(ID_COUNTER_WIDTH, "0")}`;
  };
  return {
    nextDocumentId: () => requireId("document", nextRawId("document")),
    nextParameterId: () => requireId("parameter", nextRawId("parameter")),
    nextFeatureId: () => requireId("feature", nextRawId("feature")),
    nextBodyId: () => requireId("body", nextRawId("body")),
    nextReferenceId: () => requireId("reference", nextRawId("reference")),
    nextSketchDocumentId: () => requireId("sketch", nextRawId("sketch")),
    nextDatumId: () => requireId("datum", nextRawId("datum")),
    nextSectionId: () => requireId("section", nextRawId("section")),
    nextOccurrenceId: () => requireId("occurrence", nextRawId("occurrence")),
    nextCurveId: () => requireId("curve", nextRawId("curve")),
    nextSheetId: () => requireId("sheet", nextRawId("sheet")),
    nextDrawingViewId: () => requireId("drawingView", nextRawId("drawingView")),
    nextMateId: () => requireId("mate", nextRawId("mate")),
    nextJointId: () => requireId("joint", nextRawId("joint")),
    state: () => Object.freeze({ ...counters }),
  };
}
