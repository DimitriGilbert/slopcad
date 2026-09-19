/**
 * The latest-content gate (the review fix for the background-refetch
 * data-loss path on the project workbench): decides whether a refetched
 * `latest` version's text may enter the store through the whole-session
 * replace — a replace that is NOT undo-recoverable, so unsaved edits must
 * gate it, not just the pin.
 *
 * Refuse when:
 * - the live content is an explicit version pick (`pinned`) — a pinned
 *   version survives latest-pointer refetches until the next save;
 * - the refetched text equals what the store already mirrors — the latest
 *   content enters the store exactly once per distinct text;
 * - the live session is DIRTY (the store's document is no longer the
 *   last-persisted identity): a concurrent save from another tab plus a
 *   refocus must not silently wipe unsaved local edits and flip the
 *   surface to "clean". Nothing is touched in that case (milestones and
 *   pin state stay as they are), so the edit survives and the guard
 *   re-evaluates once the user saves or reverts.
 *
 * A `null` `loadedFrom` is the boot — no baseline content has ever been
 * applied, so "dirty" has no meaning yet and the first read of the latest
 * content always applies.
 */

/** The milestones and refetch inputs the gate decision needs. */
export interface LatestContentGateInput {
  /** An explicit version pick is live; latest refetches never displace it. */
  readonly pinned: boolean;
  /** The persisted text the store mirrors; null before the first read. */
  readonly loadedFrom: string | null;
  /** The refetched latest version's persisted text. */
  readonly latestContent: string;
  /**
   * The dirty identity check the bar's `isDirty` uses: the live document
   * is no longer the last-persisted document identity.
   */
  readonly isDirty: boolean;
}

/** May the refetched latest content enter the store right now? */
export function shouldApplyLatestContent(
  input: LatestContentGateInput,
): boolean {
  if (input.pinned) return false;
  if (input.loadedFrom === null) return true;
  if (input.loadedFrom === input.latestContent) return false;
  return !input.isDirty;
}
