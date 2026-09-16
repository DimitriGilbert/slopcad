/**
 * The revision model (Phase 10.4): the monotonic identity that binds every
 * computation to the document state it was computed FROM.
 *
 * The settled architecture keeps the CAD domain in a worker and the main
 * thread a command/projection client, so a regeneration result is only
 * meaningful together with the document revision it was dispatched against.
 * A {@link RevisionTag} is that binding: a branded, non-negative, monotonically
 * increasing integer minted by a {@link RevisionClock}, which is owned by the
 * coordinator/session layer (Phase 10.4's stale-result coordinator owns one by
 * default and accepts an injected clock for tests and diagnostics).
 *
 * ## Discipline
 *
 * - The clock only moves forward: `bump()` records a document change (a
 *   parameter edit, a feature mutation) and returns the revision the *next*
 *   computation is stamped with. The revision is the document state's
 *   identity, not a computation sequence number — recomputations of unchanged
 *   state share a revision, and results are stamped with the revision that was
 *   current at dispatch, then correlated back through the request id that
 *   carried them (see `./stale-result-guard` for how the stamp is enforced).
 * - Like the worker id generator, the counter refuses to cross
 *   `Number.MAX_SAFE_INTEGER`, where float64 counters stop being exact and
 *   monotonicity would silently break: {@link RevisionClockExhaustedError}.
 * - A {@link RevisionTag} is a plain number at runtime (the brand is a
 *   compile-time phantom), so revisions compare with `===`, `<`, `>` directly
 *   and survive structured clones — but only {@link createRevisionTag} mints
 *   trusted tags from untrusted input, exactly once, with validation.
 */

/**
 * Sole branding site of the module: a `unique symbol` property keeps a
 * {@link RevisionTag} from being confused with a bare number at the type
 * level while staying invisible at runtime.
 */
declare const revisionTagBrand: unique symbol;

/** The identity of one document state; comparable, monotonic, never negative. */
export type RevisionTag = number & {
  readonly [revisionTagBrand]: "revision";
};

/** The revision of the pristine document, before any change was recorded. */
export const REVISION_ZERO = 0 as RevisionTag;

/** Validating constructor of trusted revision tags from untrusted numbers. */
export function createRevisionTag(value: number): RevisionTag {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(
      `A revision tag must be a non-negative integer, received ${String(value)}.`,
    );
  }
  return value as RevisionTag;
}

/** Stable failure code of {@link RevisionClockExhaustedError}. */
export const REVISION_CLOCK_ERROR_CODES = {
  exhausted: "revision/clock-exhausted",
} as const;

export type RevisionClockErrorCode =
  (typeof REVISION_CLOCK_ERROR_CODES)[keyof typeof REVISION_CLOCK_ERROR_CODES];

/**
 * Thrown by {@link RevisionClock.bump} when the counter is already at
 * `Number.MAX_SAFE_INTEGER`. The counter is left untouched; a revision past
 * that point could round to one already issued, breaking monotonicity.
 */
export class RevisionClockExhaustedError extends Error {
  readonly code: RevisionClockErrorCode;

  constructor() {
    super(
      `The revision clock has reached Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER}); revisions beyond it are outside the clock's contract.`,
    );
    this.name = "RevisionClockExhaustedError";
    this.code = REVISION_CLOCK_ERROR_CODES.exhausted;
  }
}

/** The monotonic revision counter owned by a coordinator/session layer. */
export interface RevisionClock {
  /** The revision of the document state as it stands right now. */
  current(): RevisionTag;
  /**
   * Records a document change: advances the clock by one and returns the new
   * current revision — the revision a computation dispatched now is stamped
   * with. Throws {@link RevisionClockExhaustedError} at the exact-integer
   * limit; never moves backwards.
   */
  bump(): RevisionTag;
}

/**
 * Creates a deterministic revision clock. Identical starting revisions always
 * produce identical bump sequences — no randomness, no clock reading — so a
 * coordinator driven by a fresh clock replays identically.
 */
export function createRevisionClock(
  initial: RevisionTag = REVISION_ZERO,
): RevisionClock {
  // The counter is a plain number internally; every value that leaves the
  // clock is minted through the validating constructor — one branding site.
  let current: number = initial;
  return {
    current(): RevisionTag {
      return createRevisionTag(current);
    },
    bump(): RevisionTag {
      if (current >= Number.MAX_SAFE_INTEGER) {
        throw new RevisionClockExhaustedError();
      }
      current += 1;
      return createRevisionTag(current);
    },
  };
}
