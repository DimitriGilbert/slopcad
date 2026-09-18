/**
 * Feature regeneration state (Phase 6.3): the explicit, serializable model of
 * where every feature in a document stands with respect to regeneration —
 * valid, stale, failed, or suppressed — plus the pure orchestration that
 * advances those states.
 *
 * This module never executes geometry. No kernel exists yet, so regeneration
 * is modeled as a pure function over (features, states, suppressed set, a
 * caller-supplied deterministic executor callback): the executor decides, per
 * feature, whether rebuilding it succeeds or fails with structured Phase 3
 * diagnostics; the orchestration owns only state — who executes, in what
 * order, and what each feature's next state is. Staleness marking composes
 * {@link affectedFeatures}; execution order comes from
 * {@link featureEvaluationOrder}.
 *
 * ## States and transitions
 *
 * - `valid`: regenerated successfully; its outputs are current.
 * - `stale`: needs regeneration — never regenerated, invalidated by a change,
 *   or gated by an upstream failure.
 * - `failed`: its last regeneration attempt failed; carries the attempt's
 *   diagnostics.
 * - `suppressed`: excluded by the author; the executor never sees it and its
 *   outputs do not regenerate.
 *
 * Transitions, all driven by {@link regenerate} or {@link markStale}:
 * stale → valid (executed, succeeded); stale → failed (executed, failed,
 * diagnostics attached); any → suppressed (suppressed at run time);
 * failed → valid / failed → failed (re-executed; the new outcome replaces the
 * old diagnostics); valid → stale (invalidated by a change or gated by an
 * upstream failure); suppressed → valid (unsuppressed — suppressed ≠ valid,
 * so the feature is due and rebuilds immediately). Invariant: diagnostics are
 * non-empty exactly in the failed state — they are the diagnostics of the
 * feature's last failed execution attempt, and any transition away from
 * failed clears them.
 *
 * ## Suppression
 *
 * Suppression is an authoring exclusion, not an error: a suppressed feature is
 * skipped (never executed, no diagnostics) and never gates its dependents.
 * Newly suppressing a feature is itself a change — the model loses its
 * contribution — so dependents are marked due and re-execute without it;
 * suppression that persists unchanged changes nothing, so dependents rebuild
 * only for their own reasons. If a dependent cannot tolerate the missing
 * contribution, its own executor fails it with diagnostics. This mirrors how
 * suppressing a fillet in a conventional CAD system rebuilds downstream
 * features, which then succeed or fail on their own merits.
 *
 * ## Failure isolation
 *
 * When the executor fails a feature, that feature becomes failed with the
 * executor's diagnostics attached, and everything downstream of it becomes
 * stale — not failed: their inputs are stale, not erroneous, and they are
 * never executed this run, so they cannot produce diagnostics. Gating
 * propagates transitively through feature→feature edges only; parameters and
 * bodies are sources with no regeneration state and never gate. States are
 * written strictly in evaluation order, so upstream and unrelated branches
 * keep the states they already earned — a later failure can never rewrite an
 * earlier feature's result.
 *
 * ## The executor-results registry (last-known-valid state)
 *
 * Alongside the state map, a run carries a RESULTS REGISTRY — per feature,
 * the record of its most recent execution attempt: success (with the
 * executor's optional result payload, plain {@link DiagnosticDataValue}
 * data — no kernel, geometry results are modeled as the data the executor
 * reports) or failure (with its diagnostics). The registry is threaded
 * BETWEEN runs via the input's `results`: a feature that does not execute
 * this run keeps its prior record — so when a downstream feature fails, the
 * upstream features that executed before it refresh their records and the
 * gated features retain their last-known-valid ones, exactly the plan's
 * "preserve last-known-valid upstream state where possible". Suppressed
 * features drop their records (the model has excluded their contribution);
 * parked features (below) retain theirs — their last execution is still the
 * last thing that happened to them. The registry is RUN state: it is
 * deliberately not persisted (the native format persists states, and a
 * future kernel's result payloads are derived kernel data that must never
 * become canonical), and the next run overwrites the entries it owns.
 *
 * ## The rollback point
 *
 * The optional `rollbackPoint` input is the Phase 20 marker between
 * features (see `feature-history.ts`): regeneration executes only the
 * features UP TO the marker — the boundary rule is
 * {@link rollbackZoneBoundary}, shared with the timeline view — and the
 * features after it are PARKED: never executed, never gating, their next
 * state `stale` (from any prior state, diagnostics cleared — parking is
 * exclusion from the run's scope, not an outcome; the module doc in
 * `feature-history.ts` records why this is deliberately NOT a fifth state
 * and how it differs from suppression, which wins when both apply). A
 * marker naming a feature the list does not have is rejected with
 * `regeneration/rollback-unknown-feature`. A parked feature keeps its prior
 * results-registry entry, so un-rolling finds the last-known-valid record
 * exactly where parking left it.
 *
 * ## Recovery
 *
 * Recovery needs no special path: a failed feature is simply due on the next
 * run (failed ≠ valid), so once the executor's outcome changes to success the
 * feature returns to valid with diagnostics cleared, and because it executed,
 * its dependents are marked due and re-evaluate per the graph. A parked
 * feature is equally due (stale ≠ valid): moving the marker past it
 * re-executes it on the next run.
 *
 * ## Determinism and serialization
 *
 * The same inputs always yield the same resulting state map, executed
 * sequence, and results registry. Produced maps are keyed in the document
 * insertion order of the feature list — the canonical order — and
 * {@link serializeRegenerationStates} emits a fixed-shape entry list in that
 * order. {@link parseRegenerationStates} validates untrusted maps strictly
 * (every diagnostic re-validated through `parseDiagnostic`) and round-trips
 * serialization output exactly.
 */

import {
  type Diagnostic,
  type DiagnosticDataValue,
  parseDiagnostic,
} from "./diagnostics";
import { type FeatureRecord } from "./document";
import {
  affectedFeatures,
  featureEvaluationOrder,
  type FeatureGraphError,
  type FeatureGraphNodeId,
} from "./feature-graph";
import {
  rollbackZoneBoundary,
  type FeatureRollbackPoint,
} from "./feature-history";
import { type FeatureId, parseFeatureId } from "./ids";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";
import { CAD_DOCUMENT_FORMAT_VERSION } from "./version";

/** The four regeneration states a feature can hold. */
export const FEATURE_REGENERATION_STATES = [
  "valid",
  "stale",
  "failed",
  "suppressed",
] as const;

export type FeatureRegenerationState =
  (typeof FEATURE_REGENERATION_STATES)[number];

const STATE_SET: ReadonlySet<string> = new Set(FEATURE_REGENERATION_STATES);

/** Type guard for untrusted regeneration state values. */
export function isFeatureRegenerationState(
  input: unknown,
): input is FeatureRegenerationState {
  return typeof input === "string" && STATE_SET.has(input);
}

/**
 * The regeneration status of one feature: its state plus the diagnostics of
 * its last failed execution attempt. Diagnostics are non-empty exactly when
 * the state is `failed`.
 */
export interface FeatureRegenerationStatus {
  readonly state: FeatureRegenerationState;
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * Regeneration state of a whole feature list, keyed by feature id. Maps
 * produced here are keyed in document insertion order of the feature list;
 * parsed maps keep their persisted order until the next producer run.
 */
export type RegenerationStateMap = ReadonlyMap<
  FeatureId,
  FeatureRegenerationStatus
>;

/** Stable failure codes produced when regeneration rejects input. */
export const REGENERATION_ERROR_CODES = {
  malformed: "regeneration/malformed",
  versionUnsupported: "regeneration/version-unsupported",
  executorMalformed: "regeneration/executor-malformed",
  rollbackUnknownFeature: "regeneration/rollback-unknown-feature",
} as const;

export type RegenerationErrorCode =
  (typeof REGENERATION_ERROR_CODES)[keyof typeof REGENERATION_ERROR_CODES];

/**
 * Structured failure describing why regeneration input was rejected: a
 * malformed serialized state map, an unsupported format version, an
 * executor that violated its contract, or a rollback point naming a
 * feature the list does not have. Like `diagnostic/malformed`, these
 * codes stay out of `DIAGNOSTIC_CODES` because this module imports the
 * diagnostics parser (a one-way dependency that keeps the module graph
 * acyclic).
 */
export interface RegenerationError extends ParseFailure {
  readonly code: RegenerationErrorCode;
}

function regenerationError(
  code: RegenerationErrorCode,
  message: string,
  input: unknown,
): RegenerationError {
  return { code, message, input };
}

const NO_DIAGNOSTICS: readonly Diagnostic[] = Object.freeze([]);

const VALID_STATUS: FeatureRegenerationStatus = Object.freeze({
  state: "valid",
  diagnostics: NO_DIAGNOSTICS,
});

const STALE_STATUS: FeatureRegenerationStatus = Object.freeze({
  state: "stale",
  diagnostics: NO_DIAGNOSTICS,
});

const SUPPRESSED_STATUS: FeatureRegenerationStatus = Object.freeze({
  state: "suppressed",
  diagnostics: NO_DIAGNOSTICS,
});

function failedStatus(
  diagnostics: readonly Diagnostic[],
): FeatureRegenerationStatus {
  return Object.freeze({
    state: "failed",
    diagnostics: Object.freeze(diagnostics),
  });
}

/**
 * Marks the initial regeneration states of a feature list: every feature is
 * stale (never regenerated) with no diagnostics, keyed in document insertion
 * order.
 */
export function initialRegenerationStates(
  features: readonly FeatureRecord[],
): RegenerationStateMap {
  const states = new Map<FeatureId, FeatureRegenerationStatus>();
  for (const feature of features) {
    states.set(feature.id, STALE_STATUS);
  }
  return states;
}

/**
 * Marks the features affected by changed graph nodes stale, preserving
 * everything else. A changed parameter or body — a source node — invalidates
 * exactly its {@link affectedFeatures} set; a changed feature is a definition
 * change, so the feature itself goes stale along with its downstream (edit a
 * feature and both it and its dependents must rebuild; a changed *output
 * body* is expressed by passing the body id instead, which invalidates the
 * body's consumers only).
 *
 * Suppression outlives invalidation: a suppressed prior stays suppressed, so a
 * change can never wake a feature the author excluded. Failed features that
 * are invalidated return to stale with their diagnostics cleared. The result
 * is keyed exactly by the feature list, in document insertion order: features
 * without a prior entry default to stale, and prior entries of features no
 * longer in the list are dropped. The result is independent of the order of
 * the changed nodes.
 */
export function markStale(
  features: readonly FeatureRecord[],
  states: RegenerationStateMap,
  changed: readonly FeatureGraphNodeId[],
): RegenerationStateMap {
  const affected = new Set<FeatureId>();
  for (const node of changed) {
    const changedFeature = features.find((feature) => feature.id === node);
    if (changedFeature !== undefined) affected.add(changedFeature.id);
    for (const id of affectedFeatures(features, node)) {
      affected.add(id);
    }
  }
  const result = new Map<FeatureId, FeatureRegenerationStatus>();
  for (const feature of features) {
    const prior = states.get(feature.id);
    if (prior !== undefined && prior.state === "suppressed") {
      result.set(feature.id, prior);
      continue;
    }
    result.set(
      feature.id,
      affected.has(feature.id) ? STALE_STATUS : (prior ?? STALE_STATUS),
    );
  }
  return result;
}

/**
 * What the executor concluded about one feature: success — with an optional
 * plain-data result payload (the geometry result as data; {@link DiagnosticDataValue}
 * keeps it JSON-safe and kernel-free) — or failure with diagnostics.
 */
export type FeatureExecutionOutcome =
  | { readonly ok: true; readonly result?: DiagnosticDataValue }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/**
 * The executor-results registry's record of one feature's most recent
 * execution attempt: success (carrying the executor's result payload, or
 * `null` when the executor reported none) or failure (carrying the
 * attempt's diagnostics). See the module doc for the threading rules.
 */
export type FeatureExecutionRecord =
  | { readonly ok: true; readonly result: DiagnosticDataValue | null }
  | { readonly ok: false; readonly diagnostics: readonly Diagnostic[] };

/** The executor-results registry: last attempt records, keyed by feature id. */
export type RegenerationResultMap = ReadonlyMap<
  FeatureId,
  FeatureExecutionRecord
>;

/**
 * The caller-supplied, deterministic rebuild decider: given a feature, return
 * whether regenerating it succeeds, or fails with at least one diagnostic.
 * The executor must be a pure function of the feature — the orchestration
 * calls it at most once per feature, in evaluation order — and it never
 * executes here: the geometry-kernel phases supply real executors later.
 */
export type FeatureExecutor = (
  feature: FeatureRecord,
) => FeatureExecutionOutcome;

/** Input of {@link regenerate}. */
export interface RegenerateInput {
  /** The feature list to regenerate, in document insertion order. */
  readonly features: readonly FeatureRecord[];
  /** The prior state map; missing entries are treated as stale. */
  readonly states: RegenerationStateMap;
  /**
   * Features suppressed for this run: skipped, never executed, never gating.
   * Ids absent from the feature list are ignored.
   */
  readonly suppressed: readonly FeatureId[];
  /** The deterministic executor that decides each feature's outcome. */
  readonly execute: FeatureExecutor;
  /**
   * The Phase 20 rollback marker, or `null`/`undefined` for none: features
   * after the marker are parked (never executed, next state stale). A
   * marker naming a feature the list does not have fails the run with
   * `regeneration/rollback-unknown-feature`.
   */
  readonly rollbackPoint?: FeatureRollbackPoint | null;
  /**
   * The prior executor-results registry; missing entries are treated as
   * absent. Features that do not execute keep their prior record (see the
   * module doc's threading rules).
   */
  readonly results?: RegenerationResultMap;
}

/** Result of a regeneration run: the next state map and what actually executed. */
export interface RegenerationRun {
  /** Next states, keyed in document insertion order of the feature list. */
  readonly states: RegenerationStateMap;
  /** The features the executor was invoked for, in evaluation order. */
  readonly executed: readonly FeatureId[];
  /**
   * The next executor-results registry, keyed in document insertion order:
   * refreshed for every feature that executed, retained (last-known-valid)
   * for every feature that did not — except suppressed features, which drop
   * their records.
   */
  readonly results: RegenerationResultMap;
}

/**
 * Runs one regeneration pass over a feature list. Every non-suppressed feature
 * that is due — stale, failed, or previously suppressed, or with an upstream
 * feature that changed this run (including one that just became suppressed) —
 * is executed exactly once, in {@link featureEvaluationOrder} order; a
 * failing feature is marked failed with its diagnostics and gates its
 * dependents stale; suppression skips without gating; valid features with an
 * unchanged upstream keep their state untouched; and the optional rollback
 * point parks every feature after the marker — never executed, next state
 * stale, prior result retained. The executor-results registry is threaded
 * through: refreshed entries for what executed, retained entries for what
 * did not (dropped only by suppression). A cyclic graph is rejected
 * with the graph module's structured `graph/cycle` failure, an executor
 * failing a feature without at least one valid diagnostic is rejected with
 * `regeneration/executor-malformed`, and a rollback point naming an absent
 * feature with `regeneration/rollback-unknown-feature` — all leave the
 * caller's inputs untouched.
 */
export function regenerate(
  input: RegenerateInput,
): ParseResult<RegenerationRun, RegenerationError | FeatureGraphError> {
  const { features, states, suppressed, execute } = input;
  const order = featureEvaluationOrder(features);
  if (!order.ok) return order;

  const boundary = rollbackZoneBoundary(features, input.rollbackPoint ?? null);
  if (!boundary.ok) {
    return fail(
      regenerationError(
        REGENERATION_ERROR_CODES.rollbackUnknownFeature,
        boundary.error.message,
        input.rollbackPoint,
      ),
    );
  }

  const byId = new Map<FeatureId, FeatureRecord>(
    features.map((feature) => [feature.id, feature]),
  );
  const documentIndex = new Map<FeatureId, number>(
    features.map((feature, index) => [feature.id, index]),
  );
  const suppressedSet = new Set<FeatureId>(suppressed);
  const priorResults: RegenerationResultMap = input.results ?? new Map();
  const evaluated = new Map<FeatureId, FeatureRegenerationStatus>();
  const evaluatedResults = new Map<FeatureId, FeatureExecutionRecord>();
  // Features whose contribution changed this run: they executed, or they just
  // became suppressed (the model lost their outputs). Drives downstream due.
  const changed = new Set<FeatureId>();
  // Features that failed this run or are gated behind a failure: their
  // dependents are marked stale and never executed.
  const blocked = new Set<FeatureId>();
  const executed: FeatureId[] = [];

  for (const id of order.value) {
    const feature = byId.get(id);
    if (feature === undefined) {
      throw new Error(
        "Invariant violation: an evaluation order only contains features from the list.",
      );
    }
    const prior = states.get(id) ?? STALE_STATUS;
    const parked = (documentIndex.get(id) ?? features.length) >= boundary.value;

    if (parked && !suppressedSet.has(id)) {
      // Parked: beyond the rollback marker. Never executed, never gating;
      // the durable state is stale (due) from any prior state, diagnostics
      // cleared, and the last execution record is retained verbatim.
      evaluated.set(id, STALE_STATUS);
      const priorRecord = priorResults.get(id);
      if (priorRecord !== undefined) evaluatedResults.set(id, priorRecord);
      continue;
    }

    if (suppressedSet.has(id)) {
      evaluated.set(id, SUPPRESSED_STATUS);
      if (prior.state !== "suppressed") changed.add(id);
      continue;
    }

    if (
      feature.inputs.some(
        (ref) => ref.kind === "feature" && blocked.has(ref.id),
      )
    ) {
      evaluated.set(id, STALE_STATUS);
      blocked.add(id);
      const priorRecord = priorResults.get(id);
      if (priorRecord !== undefined) evaluatedResults.set(id, priorRecord);
      continue;
    }

    const due =
      prior.state !== "valid" ||
      feature.inputs.some(
        (ref) => ref.kind === "feature" && changed.has(ref.id),
      );
    if (!due) {
      evaluated.set(id, prior);
      const priorRecord = priorResults.get(id);
      if (priorRecord !== undefined) evaluatedResults.set(id, priorRecord);
      continue;
    }

    const outcome = execute(feature);
    if (outcome.ok) {
      evaluated.set(id, VALID_STATUS);
      changed.add(id);
      evaluatedResults.set(
        id,
        Object.freeze({ ok: true, result: outcome.result ?? null }),
      );
    } else {
      if (outcome.diagnostics.length === 0) {
        return fail(
          regenerationError(
            REGENERATION_ERROR_CODES.executorMalformed,
            `The executor returned a failing outcome for feature "${id}" without diagnostics; a failure must carry at least one diagnostic.`,
            outcome,
          ),
        );
      }
      const diagnostics: Diagnostic[] = [];
      for (const diagnostic of outcome.diagnostics) {
        const parsed = parseDiagnostic(diagnostic);
        if (!parsed.ok) {
          return fail(
            regenerationError(
              REGENERATION_ERROR_CODES.executorMalformed,
              `The executor returned an invalid diagnostic for feature "${id}": ${parsed.error.message}`,
              diagnostic,
            ),
          );
        }
        diagnostics.push(parsed.value);
      }
      const frozen = Object.freeze(diagnostics);
      evaluated.set(id, failedStatus(frozen));
      blocked.add(id);
      evaluatedResults.set(
        id,
        Object.freeze({ ok: false, diagnostics: frozen }),
      );
    }
    executed.push(id);
  }

  const result = new Map<FeatureId, FeatureRegenerationStatus>();
  const results = new Map<FeatureId, FeatureExecutionRecord>();
  for (const feature of features) {
    result.set(feature.id, evaluated.get(feature.id) ?? STALE_STATUS);
    const record = evaluatedResults.get(feature.id);
    if (record !== undefined) results.set(feature.id, record);
  }
  return ok({
    states: result,
    executed: Object.freeze(executed),
    results,
  });
}

/** Canonical JSON form of one feature's regeneration status. */
export interface SerializedFeatureRegenerationStatus {
  readonly id: string;
  readonly state: FeatureRegenerationState;
  readonly diagnostics: readonly Diagnostic[];
}

/** Canonical JSON form of a whole regeneration state map, in fixed key order. */
export interface SerializedRegenerationStateMap {
  readonly formatVersion: number;
  readonly features: readonly SerializedFeatureRegenerationStatus[];
}

/**
 * Serializes a state map to its canonical, deterministic JSON form: one entry
 * per feature, in the map's own (canonical document-insertion) key order.
 * Diagnostics are plain serializable data already, so they are carried
 * unchanged.
 */
export function serializeRegenerationStates(
  states: RegenerationStateMap,
): SerializedRegenerationStateMap {
  const features: SerializedFeatureRegenerationStatus[] = [];
  for (const [id, status] of states) {
    features.push({
      id,
      state: status.state,
      diagnostics: [...status.diagnostics],
    });
  }
  return { formatVersion: CAD_DOCUMENT_FORMAT_VERSION, features };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/**
 * Parses untrusted input (e.g. a state map revived from persisted JSON) as a
 * {@link RegenerationStateMap}. Every field is validated strictly — feature
 * ids, states, the failed-state diagnostics invariant (non-empty exactly in
 * `failed`), and every diagnostic through `parseDiagnostic` — while unknown
 * fields are ignored so future format versions deserialize without data
 * corruption. The revived map keeps the persisted entry order.
 */
export function parseRegenerationStates(
  input: unknown,
): ParseResult<RegenerationStateMap, RegenerationError> {
  if (!isPlainRecord(input)) {
    return fail(
      regenerationError(
        REGENERATION_ERROR_CODES.malformed,
        "A serialized regeneration state map must be a plain object.",
        input,
      ),
    );
  }
  if (input.formatVersion !== CAD_DOCUMENT_FORMAT_VERSION) {
    return fail(
      regenerationError(
        REGENERATION_ERROR_CODES.versionUnsupported,
        `A serialized regeneration state map must carry formatVersion ${CAD_DOCUMENT_FORMAT_VERSION}.`,
        input.formatVersion,
      ),
    );
  }
  if (!Array.isArray(input.features)) {
    return fail(
      regenerationError(
        REGENERATION_ERROR_CODES.malformed,
        "The serialized regeneration states must be an array of feature entries.",
        input.features,
      ),
    );
  }
  const states = new Map<FeatureId, FeatureRegenerationStatus>();
  for (const entry of input.features) {
    if (!isPlainRecord(entry)) {
      return fail(
        regenerationError(
          REGENERATION_ERROR_CODES.malformed,
          "A serialized regeneration state entry must be a plain object with id, state, and diagnostics fields.",
          entry,
        ),
      );
    }
    const parsedId = parseFeatureId(entry.id);
    if (!parsedId.ok) {
      return fail(
        regenerationError(
          REGENERATION_ERROR_CODES.malformed,
          `A regeneration state entry needs a valid feature id: ${parsedId.error.message}`,
          entry,
        ),
      );
    }
    if (states.has(parsedId.value)) {
      return fail(
        regenerationError(
          REGENERATION_ERROR_CODES.malformed,
          `The serialized regeneration states contain a duplicate feature id: "${parsedId.value}".`,
          entry,
        ),
      );
    }
    if (!isFeatureRegenerationState(entry.state)) {
      return fail(
        regenerationError(
          REGENERATION_ERROR_CODES.malformed,
          `A regeneration state must be one of: ${FEATURE_REGENERATION_STATES.join(", ")}.`,
          entry,
        ),
      );
    }
    const state = entry.state;
    let diagnostics: readonly Diagnostic[] = NO_DIAGNOSTICS;
    if (entry.diagnostics !== undefined) {
      if (!Array.isArray(entry.diagnostics)) {
        return fail(
          regenerationError(
            REGENERATION_ERROR_CODES.malformed,
            "Regeneration state diagnostics must be an array of diagnostics.",
            entry,
          ),
        );
      }
      const parsedDiagnostics: Diagnostic[] = [];
      for (const diagnostic of entry.diagnostics) {
        const parsed = parseDiagnostic(diagnostic);
        if (!parsed.ok) {
          return fail(
            regenerationError(
              REGENERATION_ERROR_CODES.malformed,
              `A regeneration state entry carries an invalid diagnostic: ${parsed.error.message}`,
              entry,
            ),
          );
        }
        parsedDiagnostics.push(parsed.value);
      }
      diagnostics = Object.freeze(parsedDiagnostics);
    }
    if ((state === "failed") !== diagnostics.length > 0) {
      return fail(
        regenerationError(
          REGENERATION_ERROR_CODES.malformed,
          "A failed regeneration state must carry at least one diagnostic, and only a failed state may carry diagnostics.",
          entry,
        ),
      );
    }
    states.set(
      parsedId.value,
      state === "failed"
        ? failedStatus(diagnostics)
        : Object.freeze({ state, diagnostics: NO_DIAGNOSTICS }),
    );
  }
  return ok(states);
}
