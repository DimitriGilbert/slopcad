/**
 * The CAD-domain selection model (Phase 12): what "selected" means as data,
 * independent of any renderer, toolkit, or pointer device. Selection is a
 * CAD concern — a set of references into the document and its visible
 * geometry — never Three.js scene-graph state; renderers consume it and
 * report picks against it, but its truth lives here.
 *
 * ## Categories and reference kinds
 *
 * The plan's selection categories split into two identity classes:
 *
 * - **Stable** — `body`, `feature`, and `solid` references address document
 *   entities through their branded ids (`body_…`, `feat_…`), which are
 *   stable across regenerations by the document model's construction. A
 *   `solid` reference addresses the body's current regeneration result (the
 *   solid the feature graph most recently produced for it); it shares the
 *   body's stable id because solids are not independently named entities in
 *   the Manifold era — the body record owns its latest solid.
 * - **Synthetic (transient)** — `face`, `edge`, and `vertex` references
 *   address topology that no current kernel persists: both kernels advertise
 *   `persistentTopology: false`, so face/edge/vertex identity is
 *   *synthesized* per regeneration (Phase 12 groups a render object's
 *   triangles into synthetic faces; edges/vertices are deferred — see
 *   `synthetic-faces.ts`). A synthetic reference therefore carries its
 *   **regeneration identity**: the integer revision of the regeneration its
 *   topology was synthesized from.
 *
 * ## Transience, enforced structurally
 *
 * A synthetic reference is valid for exactly one regeneration and can never
 * survive into a newer regeneration's state. The rule is pinned at three
 * boundaries, each independently testable:
 *
 * 1. {@link beginRegeneration} advances a state to a new regeneration and
 *    strips every synthetic reference from the selection and the hover;
 *    stable references persist.
 * 2. Every mutating operation ({@link pickSelection}, {@link hoverSelection})
 *    rejects a synthetic reference whose regeneration tag does not equal the
 *    state's current regeneration (`selection/stale-reference`) — a stale
 *    ref cannot enter a state in the first place.
 * 3. {@link parseSelectionState} accepts an `expectedRegeneration` option
 *    for revival boundaries (IPC, storage, test hooks): synthetic refs
 *    tagged for any other regeneration fail the parse instead of being
 *    silently revived.
 *
 * Stable references are never revision-checked — that is the entire point of
 * the two identity classes.
 *
 * ## Operations (documented semantics)
 *
 * - `hover` is pointer feedback and is kept separate from the selection: it
 *   lives on the same immutable state but in its own field, may freely
 *   duplicate a selected reference, and is never touched by `clear`.
 * - `pick` with `additive: false` (**single mode**) REPLACES the selection
 *   with the picked reference; picking the already-exclusive reference is
 *   idempotent — single mode never deselects.
 * - `pick` with `additive: true` (**multi mode**, e.g. shift-click) TOGGLES
 *   the picked reference: absent → appended (insertion order preserved),
 *   present → removed.
 * - `clear` empties the selection and leaves the hover alone.
 *
 * All transitions are immutable: inputs are never mutated, results are
 * frozen, and duplicate selection entries are impossible by construction
 * (canonical reference keys, see {@link selectionReferenceKey}).
 *
 * ## Serialization
 *
 * References and states are plain JSON. `serialize*` emit fixed-key-order
 * forms; `parse*` validate untrusted input strictly (kind/id consistency —
 * a `face` reference's `bodyId` must parse as `body_…` — non-negative
 * integer regeneration and index fields, no duplicate entries). Selection
 * state is session data, NOT document data: it never enters
 * `serializeCadDocument` and carries no format version of its own.
 */

import {
  type BodyId,
  type FeatureId,
  type IdParseError,
  parseBodyId,
  parseFeatureId,
} from "./ids";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/** The plan's selection categories. */
export const SELECTION_CATEGORIES = [
  "body",
  "feature",
  "solid",
  "face",
  "edge",
  "vertex",
] as const;

export type SelectionCategory = (typeof SELECTION_CATEGORIES)[number];

/** The categories addressed through stable document ids. */
export const STABLE_SELECTION_KINDS = ["body", "feature", "solid"] as const;

/** The categories addressed through transient synthetic references. */
export const SYNTHETIC_SELECTION_KINDS = ["face", "edge", "vertex"] as const;

export type StableSelectionKind = (typeof STABLE_SELECTION_KINDS)[number];
export type SyntheticSelectionKind = (typeof SYNTHETIC_SELECTION_KINDS)[number];

/** Runtime membership set behind {@link isSyntheticSelectionReference}. */
const SYNTHETIC_KIND_SET: ReadonlySet<string> = new Set(
  SYNTHETIC_SELECTION_KINDS,
);

/**
 * A reference to the current regeneration result of a body (the solid its
 * feature graph most recently produced). Shares the body's stable id: in
 * the Manifold era solids are not independently named entities.
 */
export interface SolidSelectionReference {
  readonly kind: "solid";
  readonly bodyId: BodyId;
}

/** A stable reference union: every kind that survives regenerations. */
export type StableSelectionReference =
  | { readonly kind: "body"; readonly bodyId: BodyId }
  | { readonly kind: "feature"; readonly featureId: FeatureId }
  | SolidSelectionReference;

/** Synthetic face reference: face `faceIndex` of the body's current topology. */
export interface FaceSelectionReference {
  readonly kind: "face";
  readonly bodyId: BodyId;
  /** The regeneration identity this synthetic face was synthesized from. */
  readonly regeneration: number;
  readonly faceIndex: number;
}

/** Synthetic edge reference (model support; Phase 12 picking produces faces). */
export interface EdgeSelectionReference {
  readonly kind: "edge";
  readonly bodyId: BodyId;
  readonly regeneration: number;
  readonly edgeIndex: number;
}

/** Synthetic vertex reference (model support; Phase 12 picking produces faces). */
export interface VertexSelectionReference {
  readonly kind: "vertex";
  readonly bodyId: BodyId;
  readonly regeneration: number;
  readonly vertexIndex: number;
}

/** A synthetic (transient) reference union: valid for one regeneration only. */
export type SyntheticSelectionReference =
  | FaceSelectionReference
  | EdgeSelectionReference
  | VertexSelectionReference;

/** Any selection reference: the payload of a pick and a selection entry. */
export type SelectionReference =
  | StableSelectionReference
  | SyntheticSelectionReference;

/** The body id a reference addresses, for references that carry one. */
export function selectionReferenceBodyId(
  reference: SelectionReference,
): BodyId | undefined {
  switch (reference.kind) {
    case "feature":
      return undefined;
    default:
      return reference.bodyId;
  }
}

/** Whether a reference is synthetic (regeneration-transient). */
export function isSyntheticSelectionReference(
  reference: SelectionReference,
): reference is SyntheticSelectionReference {
  return SYNTHETIC_KIND_SET.has(reference.kind);
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/** Stable failure codes produced by the selection operations and parsers. */
export const SELECTION_ERROR_CODES = {
  /** Input was not a selection reference (wrong shape or unknown kind). */
  notAReference: "selection/not-a-reference",
  /** A reference's id was missing, malformed, or mismatched with its kind. */
  idInvalid: "selection/id-invalid",
  /** A synthetic reference's regeneration or index field was invalid. */
  fieldInvalid: "selection/field-invalid",
  /** A synthetic reference was tagged for a different regeneration. */
  staleReference: "selection/stale-reference",
  /** A serialized state carried the same reference twice. */
  duplicateReference: "selection/duplicate-reference",
  /** A regeneration tag was not a non-negative integer, or did not advance. */
  regenerationInvalid: "selection/regeneration-invalid",
} as const;

export type SelectionErrorCode =
  (typeof SELECTION_ERROR_CODES)[keyof typeof SELECTION_ERROR_CODES];

/** Structured failure describing why a selection operation was rejected. */
export interface SelectionError extends ParseFailure {
  readonly code: SelectionErrorCode;
}

function selectionError(
  code: SelectionErrorCode,
  message: string,
  input: unknown,
): SelectionError {
  return { code, message, input };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// ---------------------------------------------------------------------------
// Canonical keys
// ---------------------------------------------------------------------------

/**
 * Canonical identity key of a selection reference: a deterministic string
 * that is equal exactly when the references are equal. This is the dedupe
 * and toggle basis of every set operation, and the join key renderers use
 * to compare hover/selection content across renders.
 */
export function selectionReferenceKey(reference: SelectionReference): string {
  switch (reference.kind) {
    case "body":
      return `body|${reference.bodyId}`;
    case "feature":
      return `feature|${reference.featureId}`;
    case "solid":
      return `solid|${reference.bodyId}`;
    case "face":
      return `face|${reference.bodyId}|${reference.regeneration}|${reference.faceIndex}`;
    case "edge":
      return `edge|${reference.bodyId}|${reference.regeneration}|${reference.edgeIndex}`;
    case "vertex":
      return `vertex|${reference.bodyId}|${reference.regeneration}|${reference.vertexIndex}`;
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/**
 * The immutable selection state: the current regeneration identity, the
 * selected references in insertion order (duplicates impossible), and the
 * hover — pointer feedback, deliberately separate from the selection.
 */
export interface SelectionState {
  /** The regeneration the state's synthetic references belong to. */
  readonly regeneration: number;
  /** Selected references, insertion order preserved, duplicates impossible. */
  readonly selected: readonly SelectionReference[];
  /** The hovered reference, or `null`. Independent of `selected`. */
  readonly hover: SelectionReference | null;
}

/** Validates a regeneration tag; constructors throw, parsers fail structurally. */
function requireRegeneration(regeneration: number): number {
  if (!isNonNegativeInteger(regeneration)) {
    throw new RangeError(
      `SelectionState.regeneration must be a non-negative integer, received ${String(regeneration)}.`,
    );
  }
  return regeneration;
}

const FROZEN_EMPTY: readonly SelectionReference[] = Object.freeze([]);

/**
 * Creates an empty selection state standing at `regeneration`. Throws a
 * `RangeError` when the tag is not a non-negative integer — a state can
 * never stand at an invented revision.
 */
export function createSelectionState(regeneration = 0): SelectionState {
  return Object.freeze({
    regeneration: requireRegeneration(regeneration),
    selected: FROZEN_EMPTY,
    hover: null,
  });
}

// ---------------------------------------------------------------------------
// Reference serialization / parsing
// ---------------------------------------------------------------------------

/** Fixed-key-order JSON form of a selection reference. */
export type SerializedSelectionReference =
  | { readonly kind: "body"; readonly bodyId: string }
  | { readonly kind: "feature"; readonly featureId: string }
  | { readonly kind: "solid"; readonly bodyId: string }
  | {
      readonly kind: "face";
      readonly bodyId: string;
      readonly regeneration: number;
      readonly faceIndex: number;
    }
  | {
      readonly kind: "edge";
      readonly bodyId: string;
      readonly regeneration: number;
      readonly edgeIndex: number;
    }
  | {
      readonly kind: "vertex";
      readonly bodyId: string;
      readonly regeneration: number;
      readonly vertexIndex: number;
    };

/** Serializes a reference to its canonical fixed-key-order JSON form. */
export function serializeSelectionReference(
  reference: SelectionReference,
): SerializedSelectionReference {
  switch (reference.kind) {
    case "body":
      return { kind: reference.kind, bodyId: reference.bodyId };
    case "feature":
      return { kind: reference.kind, featureId: reference.featureId };
    case "solid":
      return { kind: reference.kind, bodyId: reference.bodyId };
    case "face":
      return {
        kind: reference.kind,
        bodyId: reference.bodyId,
        regeneration: reference.regeneration,
        faceIndex: reference.faceIndex,
      };
    case "edge":
      return {
        kind: reference.kind,
        bodyId: reference.bodyId,
        regeneration: reference.regeneration,
        edgeIndex: reference.edgeIndex,
      };
    case "vertex":
      return {
        kind: reference.kind,
        bodyId: reference.bodyId,
        regeneration: reference.regeneration,
        vertexIndex: reference.vertexIndex,
      };
  }
}

function parseReferenceId<T extends string>(
  input: Record<string, unknown>,
  idField: "bodyId" | "featureId",
  idLabel: string,
  parse: (value: unknown) => ParseResult<T, IdParseError>,
): ParseResult<T, SelectionError> {
  const raw = input[idField];
  const parsed = parse(raw);
  if (!parsed.ok) {
    return fail(
      selectionError(
        SELECTION_ERROR_CODES.idInvalid,
        `A ${idLabel} reference needs a valid ${idField}: ${parsed.error.message}`,
        raw,
      ),
    );
  }
  return ok(parsed.value);
}

/**
 * Parses untrusted input as a {@link SelectionReference}: kind must be
 * known, ids must parse as the id kind their reference kind requires, and
 * synthetic references need non-negative integer regeneration/index fields.
 */
export function parseSelectionReference(
  input: unknown,
): ParseResult<SelectionReference, SelectionError> {
  const invalid = (): ParseResult<SelectionReference, SelectionError> =>
    fail(
      selectionError(
        SELECTION_ERROR_CODES.notAReference,
        "A selection reference must be a plain object with a known kind (body, feature, solid, face, edge, vertex).",
        input,
      ),
    );
  if (!isPlainRecord(input)) return invalid();
  const { kind } = input;
  if (
    kind !== "body" &&
    kind !== "feature" &&
    kind !== "solid" &&
    kind !== "face" &&
    kind !== "edge" &&
    kind !== "vertex"
  ) {
    return invalid();
  }
  if (kind === "feature") {
    const featureId = parseReferenceId(input, "featureId", "feature", parseFeatureId);
    if (!featureId.ok) return featureId;
    const reference: { readonly kind: "feature"; readonly featureId: FeatureId } = {
      kind,
      featureId: featureId.value,
    };
    return ok(reference);
  }
  const bodyId = parseReferenceId(input, "bodyId", kind, parseBodyId);
  if (!bodyId.ok) return bodyId;
  if (kind === "body") {
    const reference: { readonly kind: "body"; readonly bodyId: BodyId } = {
      kind,
      bodyId: bodyId.value,
    };
    return ok(reference);
  }
  if (kind === "solid") {
    const reference: { readonly kind: "solid"; readonly bodyId: BodyId } = {
      kind,
      bodyId: bodyId.value,
    };
    return ok(reference);
  }
  const indexField =
    kind === "face" ? "faceIndex" : kind === "edge" ? "edgeIndex" : "vertexIndex";
  const regeneration = input.regeneration;
  if (!isNonNegativeInteger(regeneration)) {
    return fail(
      selectionError(
        SELECTION_ERROR_CODES.fieldInvalid,
        `A ${kind} reference's regeneration must be a non-negative integer.`,
        regeneration,
      ),
    );
  }
  const index = input[indexField];
  if (!isNonNegativeInteger(index)) {
    return fail(
      selectionError(
        SELECTION_ERROR_CODES.fieldInvalid,
        `A ${kind} reference's ${indexField} must be a non-negative integer.`,
        index,
      ),
    );
  }
  if (kind === "face") {
    const reference: FaceSelectionReference = {
      kind,
      bodyId: bodyId.value,
      regeneration,
      faceIndex: index,
    };
    return ok(reference);
  }
  if (kind === "edge") {
    const reference: EdgeSelectionReference = {
      kind,
      bodyId: bodyId.value,
      regeneration,
      edgeIndex: index,
    };
    return ok(reference);
  }
  const reference: VertexSelectionReference = {
    kind,
    bodyId: bodyId.value,
    regeneration,
    vertexIndex: index,
  };
  return ok(reference);
}

// ---------------------------------------------------------------------------
// Transience enforcement
// ---------------------------------------------------------------------------

/**
 * Checks a reference against the state's current regeneration. Stable
 * references always pass; synthetic references must carry the state's own
 * regeneration tag — this is the boundary that makes a stale synthetic ref
 * structurally unable to enter a newer regeneration's state.
 */
function checkCurrent(
  state: SelectionState,
  reference: SelectionReference,
): ParseResult<SelectionReference, SelectionError> {
  if (
    isSyntheticSelectionReference(reference) &&
    reference.regeneration !== state.regeneration
  ) {
    return fail(
      selectionError(
        SELECTION_ERROR_CODES.staleReference,
        `The ${reference.kind} reference stands at regeneration ${String(reference.regeneration)}, but the selection state stands at ${String(state.regeneration)}; synthetic references are valid for one regeneration only.`,
        reference,
      ),
    );
  }
  return ok(reference);
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Sets the hover: pointer feedback, kept separate from the selection. The
 * hovered reference must be current for the state's regeneration (same
 * transience rule as selection); `null` clears the hover. The hover may
 * freely duplicate a selected reference.
 */
export function hoverSelection(
  state: SelectionState,
  reference: SelectionReference | null,
): ParseResult<SelectionState, SelectionError> {
  if (reference === null) {
    return ok(Object.freeze({ ...state, hover: null }));
  }
  const checked = checkCurrent(state, reference);
  if (!checked.ok) return checked;
  return ok(Object.freeze({ ...state, hover: reference }));
}

/** Options of {@link pickSelection}: single (replace) vs multi (toggle). */
export interface PickOptions {
  /**
   * `false` (single mode): the selection is REPLACED with the picked
   * reference. `true` (multi mode, e.g. shift-click): the picked reference
   * is TOGGLED — appended when absent, removed when present.
   */
  readonly additive: boolean;
}

/**
 * Applies a pointer pick under the documented mode semantics: single mode
 * replaces (idempotent on the already-exclusive reference — single mode
 * never deselects), multi mode toggles with insertion order preserved for
 * the surviving entries. The picked reference must be current for the
 * state's regeneration.
 */
export function pickSelection(
  state: SelectionState,
  reference: SelectionReference,
  options: PickOptions,
): ParseResult<SelectionState, SelectionError> {
  const checked = checkCurrent(state, reference);
  if (!checked.ok) return checked;
  if (!options.additive) {
    return ok(
      Object.freeze({ ...state, selected: Object.freeze([reference]) }),
    );
  }
  const key = selectionReferenceKey(reference);
  const existing = state.selected.some(
    (entry) => selectionReferenceKey(entry) === key,
  );
  const selected = existing
    ? state.selected.filter((entry) => selectionReferenceKey(entry) !== key)
    : [...state.selected, reference];
  return ok(
    Object.freeze({ ...state, selected: Object.freeze(selected) }),
  );
}

/**
 * Clears the selection. The hover is pointer state, not selection state,
 * and is deliberately left untouched.
 */
export function clearSelection(state: SelectionState): SelectionState {
  return Object.freeze({ ...state, selected: FROZEN_EMPTY });
}

/**
 * Advances the state to a new regeneration: every synthetic reference is
 * stripped from the selection and the hover (topology identity died with
 * the old regeneration), while stable references persist. The tag must be
 * a non-negative integer strictly greater than the current one — selection
 * moves forward in time with the document, and a re-derived identical
 * topology is still a NEW synthetic space under a NEW tag.
 */
export function beginRegeneration(
  state: SelectionState,
  regeneration: number,
): ParseResult<SelectionState, SelectionError> {
  if (!isNonNegativeInteger(regeneration) || regeneration <= state.regeneration) {
    return fail(
      selectionError(
        SELECTION_ERROR_CODES.regenerationInvalid,
        `A selection state's regeneration must advance to a non-negative integer greater than ${String(state.regeneration)}, received ${String(regeneration)}.`,
        regeneration,
      ),
    );
  }
  const selected = state.selected.filter(
    (reference) => !isSyntheticSelectionReference(reference),
  );
  const hover =
    state.hover !== null && !isSyntheticSelectionReference(state.hover)
      ? state.hover
      : null;
  return ok(
    Object.freeze({
      regeneration,
      selected: Object.freeze(selected),
      hover,
    }),
  );
}

// ---------------------------------------------------------------------------
// State serialization / parsing
// ---------------------------------------------------------------------------

/** Fixed-key-order JSON form of a {@link SelectionState}. */
export interface SerializedSelectionState {
  readonly regeneration: number;
  readonly selected: readonly SerializedSelectionReference[];
  readonly hover: SerializedSelectionReference | null;
}

/** Serializes a state to its canonical fixed-key-order JSON form. */
export function serializeSelectionState(
  state: SelectionState,
): SerializedSelectionState {
  return {
    regeneration: state.regeneration,
    selected: state.selected.map(serializeSelectionReference),
    hover:
      state.hover === null ? null : serializeSelectionReference(state.hover),
  };
}

/** Options of {@link parseSelectionState}. */
export interface ParseSelectionStateOptions {
  /**
   * When set, the state must STAND at this regeneration
   * (`selection/regeneration-invalid` otherwise — a state from an older
   * regeneration is stale as a whole; advancing a live state is
   * {@link beginRegeneration}'s job, not a parse's), and every synthetic
   * reference it carries must be tagged for it
   * (`selection/stale-reference`) — the revival-boundary half of the
   * transience rule. Stable references carry no tag and always revive.
   */
  readonly expectedRegeneration?: number;
}

/**
 * Parses untrusted input as a {@link SelectionState}: regeneration must be
 * a non-negative integer, every entry and the hover must parse as
 * references, duplicates are rejected, and — when
 * `options.expectedRegeneration` is set — the state and its synthetic
 * references must stand at that regeneration (see the options doc).
 */
export function parseSelectionState(
  input: unknown,
  options: ParseSelectionStateOptions = {},
): ParseResult<SelectionState, SelectionError> {
  const invalidState = (detail: unknown): ParseResult<SelectionState, SelectionError> =>
    fail(
      selectionError(
        SELECTION_ERROR_CODES.notAReference,
        "A serialized selection state must be a plain object with regeneration, selected, and hover fields.",
        detail,
      ),
    );
  if (!isPlainRecord(input)) return invalidState(input);
  if (!isNonNegativeInteger(input.regeneration)) {
    return fail(
      selectionError(
        SELECTION_ERROR_CODES.regenerationInvalid,
        "A serialized selection state's regeneration must be a non-negative integer.",
        input.regeneration,
      ),
    );
  }
  const expected = options.expectedRegeneration;
  if (expected !== undefined && input.regeneration !== expected) {
    return fail(
      selectionError(
        SELECTION_ERROR_CODES.regenerationInvalid,
        `A serialized selection state stands at regeneration ${String(input.regeneration)}, expected ${String(expected)}.`,
        input.regeneration,
      ),
    );
  }
  if (!Array.isArray(input.selected)) return invalidState(input.selected);
  const selected: SelectionReference[] = [];
  const seen = new Set<string>();
  for (const entry of input.selected) {
    const parsed = parseSelectionReference(entry);
    if (!parsed.ok) return parsed;
    const key = selectionReferenceKey(parsed.value);
    if (seen.has(key)) {
      return fail(
        selectionError(
          SELECTION_ERROR_CODES.duplicateReference,
          `A serialized selection state carries the reference "${key}" twice.`,
          entry,
        ),
      );
    }
    if (expected !== undefined) {
      const current = checkCurrent(
        createSelectionState(expected),
        parsed.value,
      );
      if (!current.ok) return current;
    }
    seen.add(key);
    selected.push(parsed.value);
  }
  let hover: SelectionReference | null = null;
  if (input.hover !== null && input.hover !== undefined) {
    const parsed = parseSelectionReference(input.hover);
    if (!parsed.ok) return parsed;
    if (expected !== undefined) {
      const current = checkCurrent(createSelectionState(expected), parsed.value);
      if (!current.ok) return current;
    }
    hover = parsed.value;
  }
  return ok(
    Object.freeze({
      regeneration: input.regeneration,
      selected: Object.freeze(selected),
      hover,
    }),
  );
}
