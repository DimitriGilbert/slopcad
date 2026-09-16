/**
 * The stale-result guard (Phase 10.4): the gatekeeper that owns the visible
 * document state and enforces the plan's hard rule — a stale result can NEVER
 * replace newer state.
 *
 * A result is meaningful only together with the {@link RevisionTag} of the
 * document state it was computed FROM (see `./revision`). The guard compares
 * every arriving candidate's revision against the coordinator's clock at
 * application time and decides atomically:
 *
 * - `candidate.revision === current` — **apply**: the candidate is the result
 *   of the newest document state; it becomes the visible state in the same
 *   synchronous step as the check, so no other application can interleave
 *   between comparison and commit (no torn or partial application is even
 *   representable — the visible state is always exactly one candidate).
 * - `candidate.revision < current` — **drop as superseded**: a newer
 *   revision is current; the older result computed from replaced state must
 *   never become visible, no matter when it arrives.
 * - `candidate.revision > current` — **drop as unrelated**: the candidate
 *   speaks a revision this document never had; it is never applied either,
 *   because showing it would replace state with one computed from a document
 *   that does not exist.
 *
 * Drops are structured and observable, never silent: every drop is returned
 * to the caller AND recorded in a drop log ({@link RevisionedState.drops})
 * with what was dropped (its revision) and why (the reason and the revision
 * it lost to) — the diagnostics surface the Phase 10.4 race tests pin. The
 * log is bounded to the most recent {@link DIAGNOSTIC_LOG_CAPACITY} entries
 * (see `./diagnostic-log`): a diagnostic window, not an audit trail.
 *
 * The guard is pure bookkeeping over an injected clock — no transport, no
 * timers — so races are staged deterministically in tests by choosing the
 * order of `bump` and `apply` calls.
 */

import type { RevisionClock, RevisionTag } from "./revision";

import { createDiagnosticLog } from "./diagnostic-log";

/** Why a candidate was dropped: superseded by a newer revision, or unrelated. */
export type StaleDropReason = "superseded" | "unrelated";

/** The structured decision of one application attempt. */
export type StaleGuardDecision =
  | { readonly outcome: "applied"; readonly revision: RevisionTag }
  | {
      readonly outcome: "dropped";
      readonly reason: StaleDropReason;
      /** The revision the dropped candidate was computed from. */
      readonly resultRevision: RevisionTag;
      /** The revision that was current at application time. */
      readonly currentRevision: RevisionTag;
    };

/** A result stamped with the document revision it was computed from. */
export interface RevisionedResult<S> {
  readonly revision: RevisionTag;
  readonly state: S;
}

/** The observable record of one dropped application attempt. */
export interface StaleDrop {
  readonly reason: StaleDropReason;
  readonly resultRevision: RevisionTag;
  readonly currentRevision: RevisionTag;
}

/**
 * The guarded visible state of one projection. `apply` is the single entry
 * point through which any computed result may become visible.
 */
export interface RevisionedState<S> {
  /** The revision the document stands at right now (the clock's current). */
  currentRevision(): RevisionTag;
  /** The visible state and the revision it was computed from; null before any apply. */
  visible(): Readonly<RevisionedResult<S>> | null;
  /**
   * Atomically decides whether `candidate` may become the visible state and
   * commits it in the same synchronous step when it may. A result of revision
   * N applies only if N is current at application time; anything older is
   * dropped as superseded, anything newer as unrelated — and both are
   * recorded. The returned decision is the caller's observation; the (bounded)
   * drop log is the retained one.
   */
  apply(candidate: RevisionedResult<S>): StaleGuardDecision;
  /** Every retained drop, in push order — what was dropped and why. */
  drops(): readonly StaleDrop[];
}

/** Options of {@link createRevisionedState}. */
export interface RevisionedStateOptions {
  /** The clock that defines "current"; owned by the coordinator layer. */
  readonly clock: RevisionClock;
}

/** Creates the guarded visible state for one projection shape `S`. */
export function createRevisionedState<S>(
  options: RevisionedStateOptions,
): RevisionedState<S> {
  const { clock } = options;
  let visible: Readonly<RevisionedResult<S>> | null = null;
  // Bounded by design: drops accumulate once per raced update, so the log
  // keeps the most recent DIAGNOSTIC_LOG_CAPACITY entries — a diagnostic
  // window, not an audit trail (see ./diagnostic-log).
  const dropLog = createDiagnosticLog<StaleDrop>();
  return {
    currentRevision(): RevisionTag {
      return clock.current();
    },
    visible(): Readonly<RevisionedResult<S>> | null {
      return visible;
    },
    apply(candidate: RevisionedResult<S>): StaleGuardDecision {
      const current = clock.current();
      if (candidate.revision === current) {
        // Check and commit in one synchronous step: an interleaved
        // application is not representable — there is no await between them.
        visible = candidate;
        return { outcome: "applied", revision: current };
      }
      const drop: StaleDrop = {
        reason: candidate.revision < current ? "superseded" : "unrelated",
        resultRevision: candidate.revision,
        currentRevision: current,
      };
      dropLog.push(drop);
      return { outcome: "dropped", ...drop };
    },
    drops(): readonly StaleDrop[] {
      return dropLog.snapshot();
    },
  };
}
