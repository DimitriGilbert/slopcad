/**
 * Feature history (Phase 20): the first-class model of the ordered feature
 * timeline — the document's feature list read as an authored sequence —
 * with an explicit ROLLBACK POINT, explicit REORDERING, and the Phase 6.3
 * suppression integrated into one timeline view.
 *
 * ## The rollback point
 *
 * A {@link FeatureRollbackPoint} is a marker BETWEEN features: it names the
 * feature it sits after (`afterFeatureId`), or the very start of the
 * timeline (`afterFeatureId: null` — every feature is after the start).
 * Regeneration executes only the features UP TO the marker; the features
 * after it are parked: never executed in that run, producing no
 * diagnostics, and gating nothing (a parked feature's dependents are, by
 * the document's backward-reference rule, always later in the timeline —
 * so they park with it).
 *
 * ## State-model decision: parking is not a fifth regeneration state
 *
 * The Phase 6.3 state model stays EXACTLY four states — `valid`, `stale`,
 * `failed`, `suppressed` — because those four describe regeneration
 * OUTCOMES, and parking is not an outcome: it is exclusion from the run's
 * scope, a pure function of the marker's position. A parked feature's
 * durable state is `stale` (it is due: the moment the marker moves past it
 * it must rebuild), and the PARKED STATUS is carried separately —
 * positionally derived, never stored. This is the documented distinction
 * from `suppressed`: suppression is the AUTHOR's exclusion (a per-run input
 * that outlives any marker and wins when both apply), while parking is the
 * MARKER's exclusion (derived from position, gone the moment the marker
 * moves). The timeline view ({@link featureTimeline}) joins the two into
 * one five-way {@link FeatureTimelineStatus} per feature — the four states
 * plus `beyond-rollback` — which is what machine surfaces render; the
 * state MAP itself never grows a fifth value, so persisted regeneration
 * state keeps its Phase 6.3 vocabulary and old readers stay compatible.
 *
 * Parking transitions: any prior state (including `failed`, whose
 * diagnostics clear — the parked feature was not attempted this run)
 * becomes `stale` while parked; on un-parking, `stale` is due and the
 * feature re-executes. Suppression outlives parking: a suppressed feature
 * beyond the marker reads `suppressed`, and un-parking reveals it as
 * suppressed, not stale.
 *
 * ## Reordering
 *
 * {@link reorderFeatureRecords} moves one feature to a new position in the
 * timeline (immediately after an anchor feature, or to the front) and
 * enforces the document's input-order rule on the RESULT: every feature's
 * `feature` inputs must reference features EARLIER in the list — the same
 * replayability rule `updateFeature` enforces — so a reordered record list
 * still round-trips through `parseCadDocument`'s in-order replay. A move
 * that would violate the rule (moving a feature before one of its own
 * inputs, or after a consumer) is rejected with a structured
 * `feature-history/order-invalid` failure naming the offending pair;
 * reordering is never silently clamped.
 *
 * ## Composition with the Phase 7 command layer (decision, disclosed)
 *
 * Reordering is a COMMAND: `feature.reorder` in the serializable command
 * vocabulary, interpreted by `applyCommand` through the document
 * substrate's `reorderFeature` — the same one-interpreter, replayable,
 * undoable path as every other mutation. A session-level side door was
 * rejected deliberately: the Phase 7 history records transactions, so an
 * off-command reorder could never be undone or replayed. The disclosure:
 * the vocabulary gains a fifth type, so a persisted LOG carrying
 * `feature.reorder` is written only by this version and read only by
 * parsers that know the type (the strict `command/type-unknown` rule);
 * existing files, which carry none, are unaffected.
 *
 * The rollback point, by contrast, is NOT a command: it gates EXECUTION,
 * not the document — the feature list is untouched, so there is nothing
 * for the command layer to express, no history entry to record, and no
 * replay semantics to define. It is document-level state that persists
 * additively in the native format (an optional envelope field), and it
 * rides undo/redo implicitly: undoing past the commit that set it restores
 * a document without it, and the timeline re-derives from whatever the
 * cursor holds.
 *
 * ## The host invalidation diff
 *
 * {@link documentChangeInvalidations} compares two documents and returns
 * the changed graph nodes (parameters, bodies, features — by identity) a
 * regeneration host feeds to `markStale` before the next `regenerate` run.
 * Feature-list membership and record-identity changes are nodes like any
 * other (an added feature is due by default; a removed feature's
 * dependents are found by the graph even though the feature itself is
 * gone); REORDERS change no record identity, so a reorder invalidates
 * nothing — states are keyed by feature id and survive a reorder, which
 * is the documented semantics.
 */

// NOTE: this module deliberately imports `./regeneration` TYPE-ONLY. It sits
// below `regeneration.ts` in the runtime graph (regenerate consumes
// `rollbackZoneBoundary`), and a value-level back edge would make the two
// modules' initializations circular. The derivation of
// FEATURE_TIMELINE_STATUSES from FEATURE_REGENERATION_STATES is pinned by
// test instead of by construction (see feature-history.test.ts).
import type {
  FeatureRegenerationState,
  RegenerationStateMap,
} from "./regeneration";

import { type CadDocument, type FeatureRecord } from "./document";
import { type FeatureGraphNodeId } from "./feature-graph";
import { type FeatureId, parseFeatureId } from "./ids";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

// ---------------------------------------------------------------------------
// The rollback point
// ---------------------------------------------------------------------------

/**
 * The rollback marker: the feature it sits after, or `null` for the very
 * start of the timeline (parking every feature). First-class data —
 * validated against a feature list wherever it is consumed.
 */
export interface FeatureRollbackPoint {
  /**
   * The feature the marker sits immediately after; `null` places it before
   * the first feature. Must name a feature of the same list wherever the
   * marker is consumed.
   */
  readonly afterFeatureId: FeatureId | null;
}

/** Stable failure codes produced when feature-history input is rejected. */
export const FEATURE_HISTORY_ERROR_CODES = {
  /** The rollback marker was not the expected shape. */
  rollbackInvalid: "feature-history/rollback-invalid",
  /** The rollback marker names a feature the list does not have. */
  rollbackUnknownFeature: "feature-history/rollback-unknown-feature",
  /** The feature to reorder is not in the list. */
  reorderUnknownFeature: "feature-history/reorder-unknown-feature",
  /** The reorder anchor is the moved feature itself or is not in the list. */
  reorderAnchorInvalid: "feature-history/reorder-anchor-invalid",
  /** The reordered list would break the feature-input order rule. */
  orderInvalid: "feature-history/order-invalid",
} as const;

export type FeatureHistoryErrorCode =
  (typeof FEATURE_HISTORY_ERROR_CODES)[keyof typeof FEATURE_HISTORY_ERROR_CODES];

/**
 * Structured failure describing why a feature-history operation was
 * rejected: a mis-shaped or unknown rollback anchor, an unknown or self
 * reorder anchor, or a reorder that would break the input-order rule.
 */
export interface FeatureHistoryError extends ParseFailure {
  readonly code: FeatureHistoryErrorCode;
}

function featureHistoryError(
  code: FeatureHistoryErrorCode,
  message: string,
  input: unknown,
): FeatureHistoryError {
  return { code, message, input };
}

/**
 * The rollback zone boundary of a feature list: the number of features (in
 * document order) that execute UP TO the marker — `0` when the marker sits
 * at the very start, the anchor's index plus one when it names a feature.
 * A marker naming a feature the list does not have is rejected with
 * `feature-history/rollback-unknown-feature`; `null` (no marker) means the
 * whole list executes. This is the ONE boundary rule every consumer
 * (regeneration, the timeline view, persistence) shares.
 */
export function rollbackZoneBoundary(
  features: readonly FeatureRecord[],
  rollback: FeatureRollbackPoint | null,
): ParseResult<number, FeatureHistoryError> {
  if (rollback === null) return ok(features.length);
  if (rollback.afterFeatureId === null) return ok(0);
  const index = features.findIndex(
    (feature) => feature.id === rollback.afterFeatureId,
  );
  if (index < 0) {
    return fail(
      featureHistoryError(
        FEATURE_HISTORY_ERROR_CODES.rollbackUnknownFeature,
        `The rollback point names feature "${String(rollback.afterFeatureId)}", which the feature list does not have.`,
        rollback,
      ),
    );
  }
  return ok(index + 1);
}

// ---------------------------------------------------------------------------
// Reordering
// ---------------------------------------------------------------------------

/**
 * Moves the feature `id` to immediately after `afterFeatureId` (or to the
 * front when the anchor is `null`), preserving the relative order of every
 * other feature, and validates the RESULT against the input-order rule:
 * every feature's `feature` inputs must reference features earlier in the
 * reordered list. Rejections are structured: `reorder-unknown-feature`
 * (the moved id is absent), `reorder-anchor-invalid` (the anchor is the
 * moved feature itself or absent), `order-invalid` (the move would break
 * the rule; the message names the offending feature and its input). The
 * input list is never modified; the records keep their identities, so
 * regeneration states keyed by id survive a legal reorder unchanged.
 */
export function reorderFeatureRecords(
  features: readonly FeatureRecord[],
  id: FeatureId,
  afterFeatureId: FeatureId | null,
): ParseResult<readonly FeatureRecord[], FeatureHistoryError> {
  const index = features.findIndex((feature) => feature.id === id);
  if (index < 0) {
    return fail(
      featureHistoryError(
        FEATURE_HISTORY_ERROR_CODES.reorderUnknownFeature,
        `The feature "${String(id)}" to reorder is not in the feature list.`,
        id,
      ),
    );
  }
  if (afterFeatureId !== null) {
    if (afterFeatureId === id) {
      return fail(
        featureHistoryError(
          FEATURE_HISTORY_ERROR_CODES.reorderAnchorInvalid,
          `A feature cannot be reordered after itself ("${String(id)}").`,
          afterFeatureId,
        ),
      );
    }
    if (!features.some((feature) => feature.id === afterFeatureId)) {
      return fail(
        featureHistoryError(
          FEATURE_HISTORY_ERROR_CODES.reorderAnchorInvalid,
          `The reorder anchor "${String(afterFeatureId)}" is not in the feature list.`,
          afterFeatureId,
        ),
      );
    }
  }
  const moved = features[index];
  if (moved === undefined) {
    throw new Error(
      "Invariant violation: a found feature index always yields a record.",
    );
  }
  const rest = features.filter((feature) => feature.id !== id);
  let insertion: number;
  if (afterFeatureId === null) {
    insertion = 0;
  } else {
    const anchorIndex = rest.findIndex(
      (feature) => feature.id === afterFeatureId,
    );
    if (anchorIndex < 0) {
      throw new Error(
        "Invariant violation: a validated anchor is always present in the filtered list.",
      );
    }
    insertion = anchorIndex + 1;
  }
  const reordered = [
    ...rest.slice(0, insertion),
    moved,
    ...rest.slice(insertion),
  ];
  for (const [at, feature] of reordered.entries()) {
    for (const ref of feature.inputs) {
      if (ref.kind !== "feature") continue;
      const inputIndex = reordered.findIndex((entry) => entry.id === ref.id);
      if (inputIndex >= at) {
        return fail(
          featureHistoryError(
            FEATURE_HISTORY_ERROR_CODES.orderInvalid,
            `Reordering breaks the input-order rule: feature "${String(feature.id)}" references feature "${String(ref.id)}", which would not be declared earlier in the list.`,
            { id, afterFeatureId },
          ),
        );
      }
    }
  }
  return ok(Object.freeze(reordered));
}

// ---------------------------------------------------------------------------
// The timeline view
// ---------------------------------------------------------------------------

/**
 * The five-way timeline status: the four Phase 6.3 regeneration states plus
 * the positional `beyond-rollback` parking status (see the module doc for
 * why parking is a timeline status and not a state-map value). The list is
 * written out literally to keep this module's runtime graph acyclic (see
 * the import note above); that the first four ARE the regeneration states,
 * in order, is pinned by test.
 */
export const FEATURE_TIMELINE_STATUSES = [
  "valid",
  "stale",
  "failed",
  "suppressed",
  "beyond-rollback",
] as const;

export type FeatureTimelineStatus = (typeof FEATURE_TIMELINE_STATUSES)[number];

const TIMELINE_STATUS_SET: ReadonlySet<string> = new Set(
  FEATURE_TIMELINE_STATUSES,
);

/** Type guard for untrusted timeline status values. */
export function isFeatureTimelineStatus(
  input: unknown,
): input is FeatureTimelineStatus {
  return typeof input === "string" && TIMELINE_STATUS_SET.has(input);
}

/** One feature's entry in the timeline view, in document order. */
export interface FeatureTimelineEntry {
  /** The feature's stable id. */
  readonly id: FeatureId;
  /** The feature's kind string. */
  readonly kind: string;
  /**
   * The joined status: `suppressed` (the author's exclusion wins over the
   * marker's), then `beyond-rollback` (beyond the marker), else the
   * feature's regeneration state.
   */
  readonly status: FeatureTimelineStatus;
  /**
   * The failed state's diagnostics; empty in every other status — the
   * Phase 6.3 invariant, carried through the joined view.
   */
  readonly diagnostics: readonly FeatureTimelineEntryDiagnostic[];
}

/**
 * A diagnostic of a failed timeline entry, as plain serializable data (the
 * fields machine surfaces need: severity, code, message, primary location).
 */
export interface FeatureTimelineEntryDiagnostic {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
  readonly primary: string;
}

/** Input of {@link featureTimeline}. */
export interface FeatureTimelineInput {
  /** The feature list, in document (timeline) order. */
  readonly features: readonly FeatureRecord[];
  /**
   * The regeneration states; missing entries are treated as stale, exactly
   * like `regenerate` treats them.
   */
  readonly states: RegenerationStateMap;
  /** The rollback marker, or `null` for none. */
  readonly rollback: FeatureRollbackPoint | null;
  /** The suppressed feature ids (unknown ids are ignored). */
  readonly suppressed: readonly FeatureId[];
}

/**
 * Joins the timeline into one view: every feature in document order with
 * its five-way status, suppression winning over parking, parking winning
 * over the plain state. The rollback marker is validated against the list
 * (`feature-history/rollback-unknown-feature` when its anchor is absent),
 * so a consumer can render the view without a separate validity check.
 */
export function featureTimeline(
  input: FeatureTimelineInput,
): ParseResult<readonly FeatureTimelineEntry[], FeatureHistoryError> {
  const boundary = rollbackZoneBoundary(input.features, input.rollback);
  if (!boundary.ok) return boundary;
  const suppressedSet = new Set<FeatureId>(input.suppressed);
  const entries: FeatureTimelineEntry[] = [];
  for (const [index, feature] of input.features.entries()) {
    const prior = input.states.get(feature.id);
    const state: FeatureRegenerationState = prior?.state ?? "stale";
    const diagnostics: FeatureTimelineEntryDiagnostic[] = [];
    let status: FeatureTimelineStatus;
    if (suppressedSet.has(feature.id)) {
      status = "suppressed";
    } else if (index >= boundary.value) {
      status = "beyond-rollback";
    } else {
      status = state;
      if (state === "failed") {
        for (const diagnostic of prior?.diagnostics ?? []) {
          diagnostics.push({
            severity: diagnostic.severity,
            code: diagnostic.code,
            message: diagnostic.message,
            primary: diagnostic.location.primary,
          });
        }
      }
    }
    entries.push(
      Object.freeze({
        id: feature.id,
        kind: feature.kind,
        status,
        diagnostics: Object.freeze(diagnostics),
      }),
    );
  }
  return ok(Object.freeze(entries));
}

// ---------------------------------------------------------------------------
// The host invalidation diff
// ---------------------------------------------------------------------------

/**
 * The changed graph nodes between two documents: every parameter, body, and
 * feature whose record identity differs (added, removed, or replaced —
 * records and parameters are immutable, so identity IS content), in
 * deterministic order (the next document's parameter order, then its body
 * order, then its feature order, then ids that only the previous document
 * had). An empty result means nothing a regeneration depends on moved.
 * The result feeds `markStale` directly; a REORDER produces no nodes, so a
 * host that diffs documents never invalidates across a reorder.
 */
export function documentChangeInvalidations(
  previous: CadDocument,
  next: CadDocument,
): readonly FeatureGraphNodeId[] {
  const nodes: FeatureGraphNodeId[] = [];
  const previousParameters = new Map(
    previous.parameters.parameters.map((parameter) => [
      parameter.id,
      parameter,
    ]),
  );
  for (const parameter of next.parameters.parameters) {
    if (previousParameters.get(parameter.id) !== parameter) {
      nodes.push(parameter.id);
    }
  }
  const previousBodies = new Map(
    previous.bodies.map((body) => [body.id, body]),
  );
  for (const body of next.bodies) {
    if (previousBodies.get(body.id) !== body) {
      nodes.push(body.id);
    }
  }
  const previousFeatures = new Map(
    previous.features.map((feature) => [feature.id, feature]),
  );
  for (const feature of next.features) {
    if (previousFeatures.get(feature.id) !== feature) {
      nodes.push(feature.id);
    }
  }
  for (const id of previousFeatures.keys()) {
    if (
      !next.features.some((feature) => feature.id === id) &&
      !nodes.includes(id)
    ) {
      nodes.push(id);
    }
  }
  // Reference records are graph sources too: a replaced record (a re-picked
  // edge, a re-resolution) invalidates its consuming features.
  const previousReferences = new Map(
    previous.references.map((reference) => [reference.id, reference]),
  );
  for (const reference of next.references) {
    if (previousReferences.get(reference.id) !== reference) {
      nodes.push(reference.id);
    }
  }
  for (const id of previousReferences.keys()) {
    if (
      !next.references.some((reference) => reference.id === id) &&
      !nodes.includes(id)
    ) {
      nodes.push(id);
    }
  }
  return Object.freeze(nodes);
}

// ---------------------------------------------------------------------------
// Persistence parsing helper (shared by the native format)
// ---------------------------------------------------------------------------

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * Parses untrusted input as a {@link FeatureRollbackPoint}: a plain object
 * whose `afterFeatureId` is `null` or a valid feature id. Shape only —
 * membership in a concrete feature list is the consumer's check (via
 * {@link rollbackZoneBoundary}), because the list is not part of the
 * marker's shape.
 */
export function parseFeatureRollbackShape(
  input: unknown,
): ParseResult<FeatureRollbackPoint, FeatureHistoryError> {
  if (!isPlainRecord(input)) {
    return fail(
      featureHistoryError(
        FEATURE_HISTORY_ERROR_CODES.rollbackInvalid,
        "A rollback point must be a plain object with an afterFeatureId field.",
        input,
      ),
    );
  }
  if (input.afterFeatureId === null) {
    return ok(Object.freeze({ afterFeatureId: null }));
  }
  const parsed = parseFeatureId(input.afterFeatureId);
  if (!parsed.ok) {
    return fail(
      featureHistoryError(
        FEATURE_HISTORY_ERROR_CODES.rollbackInvalid,
        `A rollback point's afterFeatureId must be null or a valid feature id: ${parsed.error.message}`,
        input.afterFeatureId,
      ),
    );
  }
  return ok(Object.freeze({ afterFeatureId: parsed.value }));
}
