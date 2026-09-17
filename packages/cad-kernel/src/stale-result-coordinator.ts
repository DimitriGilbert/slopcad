/**
 * The stale-result coordinator (Phase 10.4): the session layer that binds
 * computations to revisions, routes their results through the stale-result
 * guard, and keeps the worker's solid state leak-free while updates race.
 *
 * ## The flow of one update
 *
 * {@link StaleResultCoordinator.update} records a document change and
 * dispatches its computation in one synchronous step:
 *
 * 1. **Stamp** — the coordinator's {@link RevisionClock} is bumped and the
 *    computation carries that {@link RevisionTag} from here on: the revision
 *    of the document state it is computed FROM. The bump is monotonic, so
 *    this dispatch supersedes every still-running older computation exactly
 *    now.
 * 2. **Replace** — under the `"cancel"` policy (the default) the still-pending
 *    request ids of superseded computations are cancelled through the Phase
 *    10.2 client (eager: the worker stops, and the client's pinned
 *    cancellation rule discards any late success). Under `"complete"` they run
 *    to the end and their results are adjudicated by the guard instead — the
 *    policy is observable behavior, not correctness; both leave the newest
 *    revision's result visible.
 * 3. **Run** — the computation executes against a {@link ComputationContext}
 *    that stamps every request with the computation's revision-side identity
 *    (deterministic request ids the coordinator can cancel) and records every
 *    session solid the computation mints.
 * 4. **Guard** — the finished result is applied through the Phase 10.4 guard's
 *    atomic check-and-apply: it becomes the visible state only if its
 *    revision is still current. A dropped result is returned to the caller as
 *    a structured {@link DroppedComputation} and recorded in
 *    {@link StaleResultCoordinator.drops} — never silently.
 * 5. **Release** — solids minted for computations that did not become visible
 *    (dropped, or failed) are disposed over the channel, as are the solids
 *    backing the previously visible state when a new result replaces it. The
 *    worker session therefore holds exactly the visible state's solids — the
 *    no-leak invariant the Phase 10.4 tests probe. Disposals complete before
 *    the update's outcome settles; a disposal the channel refuses is recorded
 *    in {@link StaleResultCoordinator.disposalFailures} rather than papered
 *    over.
 *
 * ## Late mints and cancelled successes — the invariant after ANY interleaving
 *
 * Two interleavings would leak solids past the release paths above, and both
 * are closed structurally rather than by hoping they never happen:
 *
 * - **Late mints** — a success can land for a computation whose fate is
 *   already decided: a request the computation fired but never awaited
 *   (concurrent requests), or simply out-of-order delivery. The computation
 *   is *sealed* in the same synchronous step as its fate (the guard's
 *   decision, or the failure's catch, always before an await); its mint set
 *   is final from that moment. A mint recorded afterwards is garbage by
 *   definition — it backs nothing visible and nobody will ever reference it —
 *   so the recording site disposes it immediately (the late-mint release).
 * - **Cancelled stragglers** — under the `"cancel"` policy a success may
 *   already be executing (or its response in flight) when its request is
 *   voided. The pinned Phase 10.2 rule discards it client-side, so the
 *   coordinator never learns its mint. The discard itself is hygienic: the
 *   client best-effort disposes the solid the straggler minted (see
 *   `./worker-client`). The default policy stays `"cancel"` — rapid updates
 *   must not queue worker work — precisely because that hygiene makes it
 *   leak-free; `"complete"` needs no such care because every result reaches
 *   the guard and leaves through the release paths above.
 *
 * The drop and disposal-failure diagnostics are bounded to the most recent
 * `DIAGNOSTIC_LOG_CAPACITY` entries (see `./diagnostic-log`): they accumulate
 * once per raced update, so they are a bounded diagnostic window, not an
 * unbounded audit trail.
 *
 * A computation that fails while still current rejects the update with the
 * structured {@link WorkerRequestFailure} (the caller must see real errors);
 * one that fails after being superseded resolves as dropped — its outcome is
 * void, not an error the caller should act on. A non-protocol throw out of a
 * computation is always rethrown: it is caller code misbehaving, never a
 * staleness signal.
 *
 * There are no timers and no threads: an update's fate is decided by revision
 * comparison at application time, so races are stageable deterministically
 * over the in-memory transport with hand-delivered resolutions.
 */

import type { RevisionClock, RevisionTag } from "./revision";
import type { RevisionedResult, StaleDropReason } from "./stale-result-guard";
import type { WorkerClient } from "./worker-client";
import type {
  WorkerIdGenerator,
  WorkerRequestId,
  WorkerSolidId,
} from "./worker-ids";
import type {
  WorkerOperationId,
  WorkerOperationInput,
  WorkerOperationResult,
} from "./worker-operations";

import { createDiagnosticLog } from "./diagnostic-log";
import { WorkerRequestFailure } from "./worker-client";
import { createWorkerIdGenerator } from "./worker-ids";
import { resultMintsSolids } from "./worker-operations";
import { createRevisionClock } from "./revision";
import { createRevisionedState } from "./stale-result-guard";

/**
 * What happens to a still-running computation when a newer update is
 * dispatched: `"cancel"` voids its pending requests eagerly (the default, so
 * rapid updates do not queue work on the worker); `"complete"` lets them
 * finish so the guard adjudicates every result. Both policies leave exactly
 * the newest revision's result visible, and both are leak-free: a cancelled
 * request's straggling success is disposed by the client's discard hygiene,
 * while every completed result leaves through the coordinator's release
 * paths (including the late-mint release).
 */
export type SupersededComputationPolicy = "cancel" | "complete";

/**
 * The surface a computation runs against: its dispatch revision, plus the
 * worker request entry that records every solid the computation mints.
 */
export interface ComputationContext {
  /** The document revision this computation is computed FROM. */
  readonly revision: RevisionTag;
  /**
   * Executes one worker operation as part of this computation. Identical to
   * the client's `request` except that the coordinator owns the request id —
   * stamped at dispatch, so the computation's requests can be cancelled when
   * it is superseded.
   */
  request<O extends WorkerOperationId>(
    operation: O,
    input: WorkerOperationInput<O>,
  ): Promise<WorkerOperationResult<O>>;
}

/** One computation: async work over the worker channel, seeded with a context. */
export type ComputationRun<S> = (context: ComputationContext) => Promise<S>;

/** The fate of an update whose result became the visible state. */
export interface AppliedComputation<S> {
  readonly outcome: "applied";
  readonly revision: RevisionTag;
  readonly result: S;
}

/**
 * The fate of an update whose result never became visible — structured and
 * observable, never silent. `failure` is present when the computation ended
 * in a void worker failure (cancellation, transport) instead of a result.
 */
export interface DroppedComputation {
  readonly outcome: "dropped";
  readonly revision: RevisionTag;
  readonly reason: StaleDropReason;
  readonly currentRevision: RevisionTag;
  readonly failure?: WorkerRequestFailure;
}

/** What `update` settles with: applied, or dropped with why. */
export type ComputationOutcome<S> = AppliedComputation<S> | DroppedComputation;

/** Options of {@link createStaleResultCoordinator}. */
export interface StaleResultCoordinatorOptions {
  /** The worker client computations execute over. */
  readonly client: WorkerClient;
  /**
   * The revision clock — the document's monotonic state identity. Defaults to
   * a fresh clock the coordinator owns; inject one to pin or replay stamps.
   */
  readonly clock?: RevisionClock;
  /**
   * Mints the coordinator's request ids (every request it issues —
   * computations' and disposals' — carries an explicit id from this
   * generator). Defaults to a fresh generator; share the session's generator
   * when other traffic speaks on the same client with default-minted ids.
   */
  readonly ids?: WorkerIdGenerator;
  /** How superseded in-flight computations are treated; defaults to `"cancel"`. */
  readonly superseded?: SupersededComputationPolicy;
}

/** The rapid-update-safe computation surface over one worker client. */
export interface StaleResultCoordinator<S> {
  /** The revision the document stands at — the one a dispatched computation is stamped with. */
  currentRevision(): RevisionTag;
  /**
   * Records a document change and dispatches its computation. Resolves with
   * the computation's structured fate once its result has been applied or
   * dropped and its consequences (disposals) have settled; rejects with the
   * structured {@link WorkerRequestFailure} only when the computation failed
   * while still current.
   */
  update(run: ComputationRun<S>): Promise<ComputationOutcome<S>>;
  /** The guarded visible state — always the newest applied revision's result. */
  visible(): Readonly<RevisionedResult<S>> | null;
  /**
   * The retained drops, in settle order — what was dropped and why. Bounded
   * to the most recent `DIAGNOSTIC_LOG_CAPACITY` entries (a diagnostic
   * window, not an audit trail; see `./diagnostic-log`).
   */
  drops(): readonly DroppedComputation[];
  /**
   * Disposals the channel refused, verbatim — observable, never swallowed.
   * Bounded to the most recent `DIAGNOSTIC_LOG_CAPACITY` entries like
   * {@link StaleResultCoordinator.drops}.
   */
  disposalFailures(): readonly WorkerRequestFailure[];
}

/** Internal bookkeeping of one in-flight computation. */
interface RunningComputation {
  readonly revision: RevisionTag;
  readonly requestIds: Set<WorkerRequestId>;
  readonly mints: Set<WorkerSolidId>;
  /**
   * True once the computation's fate is decided and its mint set is final.
   * Sealed in the same synchronous step as the fate itself — the guard's
   * decision, or a failure's catch — and always before the next await, so
   * every mint recorded afterwards is a late mint, released at its recording
   * site instead of accumulating into a set nobody will release.
   */
  sealed: boolean;
}

/**
 * Creates the stale-result coordinator over `options.client`. The coordinator
 * owns the revision clock and the guarded visible state by default; both are
 * injectable for deterministic tests and diagnostics.
 */
export function createStaleResultCoordinator<S>(
  options: StaleResultCoordinatorOptions,
): StaleResultCoordinator<S> {
  const client = options.client;
  const clock = options.clock ?? createRevisionClock();
  const ids = options.ids ?? createWorkerIdGenerator();
  const policy = options.superseded ?? "cancel";
  const guard = createRevisionedState<S>({ clock });
  const running = new Set<RunningComputation>();
  // Bounded by design: drops and refused disposals accumulate once per raced
  // update, so both logs keep the most recent DIAGNOSTIC_LOG_CAPACITY entries
  // — a diagnostic window, not an audit trail (see ./diagnostic-log).
  const dropLog = createDiagnosticLog<DroppedComputation>();
  const disposalFaults = createDiagnosticLog<WorkerRequestFailure>();
  // The solids backing the visible state — released when a newer result
  // replaces it, so the worker session holds exactly the visible state.
  let appliedMints = new Set<WorkerSolidId>();

  /**
   * Disposes `mints` over the channel and settles only when every disposal
   * has. A disposal the channel refuses is a structured worker failure and is
   * recorded in `disposalFailures` (observable); anything else rethrows —
   * it is channel corruption, not a disposal outcome.
   */
  async function releaseMints(
    mints: ReadonlySet<WorkerSolidId>,
  ): Promise<void> {
    const disposals: Array<Promise<void>> = [];
    for (const solid of mints) {
      disposals.push(
        client.request("solid.dispose", { solid }, ids.nextRequestId()).then(
          () => undefined,
          (error: unknown) => {
            if (error instanceof WorkerRequestFailure) {
              disposalFaults.push(error);
              return;
            }
            throw error;
          },
        ),
      );
    }
    await Promise.all(disposals);
  }

  /**
   * Records a mint on its computation — or, when the computation is already
   * sealed, releases the mint on the spot (the late-mint release). A success
   * that lands after the fate was decided mints garbage nobody else will ever
   * reference; releasing it here keeps the invariant — the worker session
   * holds exactly the visible revision's solids — true after ANY
   * interleaving. The release is deliberately not awaited (there is no caller
   * by definition): a refusal lands in `disposalFailures` like any other
   * disposal, and channel corruption surfaces as an unhandled rejection —
   * the loudest signal left when no promise can be rejected responsibly.
   */
  function recordMint(
    computation: RunningComputation,
    mint: WorkerSolidId,
  ): void {
    if (!computation.sealed) {
      computation.mints.add(mint);
      return;
    }
    void releaseMints(new Set([mint]));
  }

  return {
    currentRevision(): RevisionTag {
      return clock.current();
    },

    async update(run: ComputationRun<S>): Promise<ComputationOutcome<S>> {
      // Stamp and replace synchronously: the bump is the dispatch moment, and
      // everything still running is superseded exactly now — before the first
      // await, so no result can slip past this decision.
      const revision = clock.bump();
      if (policy === "cancel") {
        for (const computation of running) {
          for (const id of computation.requestIds) client.cancel(id);
        }
      }
      const computation: RunningComputation = {
        revision,
        requestIds: new Set<WorkerRequestId>(),
        mints: new Set<WorkerSolidId>(),
        sealed: false,
      };
      running.add(computation);

      const context: ComputationContext = {
        revision,
        request(operation, input) {
          const id = ids.nextRequestId();
          computation.requestIds.add(id);
          return client.request(operation, input, id).then((result) => {
            for (const mint of resultMintsSolids(operation, result)) {
              recordMint(computation, mint);
            }
            return result;
          });
        },
      };

      try {
        const result = await run(context);
        const decision = guard.apply({ revision, state: result });
        // Seal in the same synchronous step as the decision — before any
        // await — so the mint set is final exactly when the fate is: mints
        // arriving during the releases below are late mints, disposed at
        // their recording site.
        computation.sealed = true;
        if (decision.outcome === "applied") {
          // Swap synchronously at the guard's commit, then release what the
          // replaced state backed: each mint is disposed exactly once.
          const replaced = appliedMints;
          appliedMints = new Set<WorkerSolidId>(computation.mints);
          await releaseMints(replaced);
          return { outcome: "applied", revision, result };
        }
        const dropped: DroppedComputation = {
          outcome: "dropped",
          revision,
          reason: decision.reason,
          currentRevision: decision.currentRevision,
        };
        dropLog.push(dropped);
        await releaseMints(computation.mints);
        return dropped;
      } catch (error) {
        // The computation ended in a failure: whatever it minted is garbage,
        // released before the fate is reported. Sealing first makes any mint
        // that lands mid-release a late mint, released at its recording site.
        computation.sealed = true;
        await releaseMints(computation.mints);
        if (
          error instanceof WorkerRequestFailure &&
          clock.current() !== revision
        ) {
          // A superseded computation's failure is void — dropped, not an
          // error the caller should act on.
          const dropped: DroppedComputation = {
            outcome: "dropped",
            revision,
            reason: "superseded",
            currentRevision: clock.current(),
            failure: error,
          };
          dropLog.push(dropped);
          return dropped;
        }
        throw error;
      } finally {
        running.delete(computation);
      }
    },

    visible(): Readonly<RevisionedResult<S>> | null {
      return guard.visible();
    },

    drops(): readonly DroppedComputation[] {
      return dropLog.snapshot();
    },

    disposalFailures(): readonly WorkerRequestFailure[] {
      return disposalFaults.snapshot();
    },
  };
}
