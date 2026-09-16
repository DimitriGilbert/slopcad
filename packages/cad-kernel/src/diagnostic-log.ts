/**
 * The bounded diagnostic log: the fixed-capacity record behind every
 * observable diagnostics surface of the stale-result protection (the guard's
 * drop log, the coordinator's drops and disposal failures).
 *
 * Diagnostics accumulate once per raced update, so an unbounded log would
 * grow without limit over a long editing session of rapid updates. The
 * bounded log instead keeps the most recent {@link DIAGNOSTIC_LOG_CAPACITY}
 * entries — a diagnostic window, not an audit trail: recent history is what
 * diagnoses a race, and the memory cost of keeping it is capped by
 * construction. This decision is applied consistently at every accumulation
 * site in the Phase 10.4 modules.
 */

/** How many entries every diagnostic log keeps; older entries are superseded. */
export const DIAGNOSTIC_LOG_CAPACITY = 128;

/** A bounded, append-only diagnostic log over entries of shape `T`. */
export interface DiagnosticLog<T> {
  /** Records `entry`; when full, the oldest entry is superseded. */
  push(entry: T): void;
  /** The retained entries in push order — at most the capacity. */
  snapshot(): readonly T[];
}

/**
 * Creates a bounded diagnostic log. Pushing past the capacity drops the
 * oldest entry (an array shift over at most `CAPACITY + 1` live entries —
 * bounded work per push, since the capacity is a fixed constant).
 */
export function createDiagnosticLog<T>(): DiagnosticLog<T> {
  const entries: T[] = [];
  return {
    push(entry: T): void {
      entries.push(entry);
      if (entries.length > DIAGNOSTIC_LOG_CAPACITY) entries.shift();
    },
    snapshot(): readonly T[] {
      return [...entries];
    },
  };
}
