/**
 * BOTTOM — `WorkbenchTimelineBand`, where the document is in its history.
 *
 * ## What this replaces
 *
 * An inline `h-9` region of `complete-workbench.tsx`: the band's surface,
 * its container query, its scroll-snap mask and its two chip parts, all
 * written at the composition root beside three thousand lines of engine
 * wiring.
 *
 * ## What it owns
 *
 * The band's own height (`h-9`), rung and top rule; the chain's scroll
 * discipline (snap, masked edges, and the container query that folds the
 * chips away entirely once the window can no longer host one); and the
 * health counter OUTSIDE the scrolled content, so a long chain can never
 * clip it mid-word and the counter can never squeeze the chips.
 *
 * The ROLLBACK marker is a first-class part of the chain, not a second
 * track: `FeatureTimelineChips` renders it as a clickable element
 * BETWEEN chips — the position a rollback actually has in a feature list —
 * and the band keeps it inside the same scroll container so the marker
 * scrolls with the chips it sits between.
 *
 * The band is `historyTimeline`'s slot content, so a host still replaces
 * it whole.
 */

import type { ReactElement } from "react";
import type {
  FeatureId,
  FeatureRollbackPoint,
  FeatureTimelineEntry,
} from "@slopcad/cad-react";

import {
  FeatureTimelineChips,
  FeatureTimelineSummary,
} from "../feature-timeline-strip";

/** Props of {@link WorkbenchTimelineBand}. */
export interface WorkbenchTimelineBandProps {
  /**
   * The document's timeline, or `null` before the engine has derived one
   * (the band then prints the regeneration issue, or an ellipsis).
   */
  readonly entries: readonly FeatureTimelineEntry[] | null;
  /** The structured regeneration issue, when the timeline is unavailable. */
  readonly issue: string | null;
  /**
   * The rollback point (`null` = the chain's end), and the setter a
   * marker click runs.
   */
  readonly rollback: FeatureRollbackPoint | null;
  readonly onRollback: (point: FeatureRollbackPoint | null) => void;
  /** Flips one feature's suppression. */
  readonly onToggleSuppressed: (featureId: FeatureId) => void;
}

/** BOTTOM: the feature chain, its rollback marker, and its health count. */
export function WorkbenchTimelineBand({
  entries,
  issue,
  onRollback,
  onToggleSuppressed,
  rollback,
}: WorkbenchTimelineBandProps): ReactElement {
  return (
    <div
      aria-label="Feature timeline"
      className="flex h-9 min-w-0 shrink-0 items-center gap-(--gap-group) overflow-hidden border-t border-rule bg-chrome px-(--pad-panel)"
      data-testid="complete-feature-timeline"
      data-zone="bottom"
      role="group"
    >
      <span className="label-section shrink-0 text-ink-faint">Timeline</span>
      {entries === null ? (
        <span className="shrink-0 text-ui text-ink-dim">
          {issue ?? "\u2026"}
        </span>
      ) : (
        <>
          {/* The document's history gets the FULL frame width: the feature
              band is its own row below the workspace (the silhouette CAD
              engineers already trust), so the chain stops competing with
              the command row for pixels. The chain scrolls HERE alone; the
              counter sits outside the scrolled content, so a long feature
              chain can never clip it mid-word (nor can the counter squeeze
              the chips). Scroll snap keeps every rest position whole-chip,
              the edges fade, and the container query collapses the chips
              entirely once the window can no longer host one. */}
          <div className="h-full min-w-0 flex-1 @container">
            <div className="no-scrollbar flex h-full w-full snap-x snap-mandatory items-center gap-1 overflow-x-auto @max-[150px]:hidden [mask-image:linear-gradient(to_right,transparent_0,black_10px,black_calc(100%_-_14px),transparent)]">
              <FeatureTimelineChips
                entries={entries}
                rollback={rollback}
                onRollback={onRollback}
                onToggleSuppressed={onToggleSuppressed}
              />
            </div>
          </div>
          <FeatureTimelineSummary entries={entries} rollback={rollback} />
        </>
      )}
    </div>
  );
}
