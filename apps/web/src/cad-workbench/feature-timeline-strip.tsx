/**
 * The feature timeline strip (Phase 20, extracted for the Phase 26 chain
 * workbench): the history surface no component owns — one chip per feature
 * in document order, joined five-way status per chip
 * (`valid`/`stale`/`failed`/`suppressed`/`beyond-rollback` — suppression
 * wins over parking), the rollback marker as a clickable element BETWEEN
 * chips, a suppress toggle per chip, and the run counter. Both workbench
 * pages (the Phase 15 composition and the Phase 26 chain) mount this ONE
 * implementation over their own documents; the Phase 28 complete
 * workbench composes the exported parts ({@link FeatureTimelineChips},
 * {@link FeatureTimelineSummary}) so its scrolling timeline region can
 * keep the counter outside the scrolled content.
 */

import type { ReactElement } from "react";
import type {
  FeatureId,
  FeatureRollbackPoint,
  FeatureTimelineEntry,
  FeatureTimelineStatus,
} from "@slopcad/cad-react";
import { Eye, EyeOff } from "lucide-react";

/** Visual presentation of one joined timeline status. */
const TIMELINE_STATUS_PRESENTATION: Readonly<
  Record<
    FeatureTimelineStatus,
    { readonly dot: string; readonly text: string; readonly chip: string }
  >
> = Object.freeze({
  // The healthy state stays quiet; failures are the only loud chip.
  valid: Object.freeze({
    dot: "bg-muted-foreground/40",
    text: "text-muted-foreground",
    chip: "border-border",
  }),
  stale: Object.freeze({
    dot: "bg-amber-500",
    text: "text-amber-600 dark:text-amber-400",
    chip: "border-border",
  }),
  failed: Object.freeze({
    dot: "bg-destructive",
    text: "text-destructive font-medium",
    chip: "border-destructive/60",
  }),
  suppressed: Object.freeze({
    dot: "border border-muted-foreground/60 bg-transparent",
    text: "text-muted-foreground italic",
    chip: "border-dashed border-border",
  }),
  "beyond-rollback": Object.freeze({
    dot: "bg-sky-500",
    text: "text-sky-600 dark:text-sky-400",
    chip: "border-dashed border-sky-500/60",
  }),
});

/** The joined-status labels the timeline chip renders. */
const TIMELINE_STATUS_LABELS: Readonly<Record<FeatureTimelineStatus, string>> =
  Object.freeze({
    valid: "Valid",
    stale: "Stale",
    failed: "Failed",
    suppressed: "Suppressed",
    "beyond-rollback": "Parked",
  });

export interface FeatureTimelineStripProps {
  readonly entries: readonly FeatureTimelineEntry[];
  readonly rollback: FeatureRollbackPoint | null;
  readonly executed: readonly FeatureId[];
  readonly onRollback: (rollback: FeatureRollbackPoint | null) => void;
  readonly onToggleSuppressed: (id: FeatureId) => void;
}

/**
 * The feature timeline strip: the one-stop composition of the timeline's
 * two surfaces — {@link FeatureTimelineChips} (the rollback gaps and the
 * chips) followed by {@link FeatureTimelineSummary} (the run counter).
 * Pages that give the timeline no scrolling region of its own mount this;
 * a page that scrolls the chain inside a narrower region composes the two
 * parts directly, so the counter can sit OUTSIDE the scrolled content —
 * a summary that rides the scroll region clips mid-word exactly when the
 * chain grows long enough to matter.
 */
export function FeatureTimelineStrip({
  entries,
  executed,
  rollback,
  onRollback,
  onToggleSuppressed,
}: FeatureTimelineStripProps): ReactElement {
  return (
    <>
      <FeatureTimelineChips
        entries={entries}
        rollback={rollback}
        onRollback={onRollback}
        onToggleSuppressed={onToggleSuppressed}
      />
      <FeatureTimelineSummary
        entries={entries}
        executed={executed}
        rollback={rollback}
      />
    </>
  );
}

/** Props of {@link FeatureTimelineChips}: the strip without its summary. */
export interface FeatureTimelineChipsProps {
  readonly entries: readonly FeatureTimelineEntry[];
  readonly rollback: FeatureRollbackPoint | null;
  readonly onRollback: (rollback: FeatureRollbackPoint | null) => void;
  readonly onToggleSuppressed: (id: FeatureId) => void;
}

/**
 * The chips and gaps of the feature timeline: one gap before each chip and
 * one after the last, each a named rollback target; the gap the marker
 * currently occupies renders the marker and clears it when clicked. This
 * is the surface a scrolling host region scrolls — nothing else belongs
 * inside it.
 */
export function FeatureTimelineChips({
  entries,
  rollback,
  onRollback,
  onToggleSuppressed,
}: FeatureTimelineChipsProps): ReactElement {
  const activeIndex =
    rollback === null
      ? null
      : rollback.afterFeatureId === null
        ? 0
        : entries.findIndex((entry) => entry.id === rollback.afterFeatureId) +
          1;
  const lastEntry = entries[entries.length - 1];
  return (
    <>
      {entries.map((entry, index) => {
        const before = entries[index - 1];
        return (
          <TimelineFragment
            key={entry.id}
            entry={entry}
            gapAnchorId={before?.id ?? null}
            gapLabel={
              before === undefined
                ? `Roll back before ${entry.kind}`
                : `Roll back after ${before.kind}`
            }
            activeGap={activeIndex === index}
            onSetRollback={(anchorId) => {
              onRollback({ afterFeatureId: anchorId });
            }}
            onClearRollback={() => {
              onRollback(null);
            }}
            onToggleSuppressed={onToggleSuppressed}
          />
        );
      })}
      <TimelineGap
        label={`Roll back after ${lastEntry?.kind ?? ""}`}
        active={activeIndex !== null && activeIndex >= entries.length}
        onSet={() => {
          if (lastEntry !== undefined) {
            onRollback({ afterFeatureId: lastEntry.id });
          }
        }}
        onClear={() => {
          onRollback(null);
        }}
      />
    </>
  );
}

/** Props of {@link FeatureTimelineSummary}. */
export interface FeatureTimelineSummaryProps {
  /** The timeline entries, for the parked count. */
  readonly entries: readonly FeatureTimelineEntry[];
  /** The last run's executed sequence, for the executed count. */
  readonly executed: readonly FeatureId[];
  /** The current rollback marker, for the `rollback ·` prefix. */
  readonly rollback: FeatureRollbackPoint | null;
}

/**
 * The timeline's right-aligned summary: the marker's position and the
 * last run's executed/parked counts as one mono counter. `shrink-0` and
 * `whitespace-nowrap` keep it a single unclipped line wherever the host
 * places it — inside a plain flex row (the strip's own composition) or
 * outside a scrolling region (the complete workbench's).
 */
export function FeatureTimelineSummary({
  entries,
  executed,
  rollback,
}: FeatureTimelineSummaryProps): ReactElement {
  const parkedCount = entries.filter(
    (entry) => entry.status === "beyond-rollback",
  ).length;
  return (
    <span
      className="text-muted-foreground ml-auto shrink-0 whitespace-nowrap pl-3 font-mono text-[11px]"
      data-testid="timeline-summary"
    >
      {rollback === null ? "" : "rollback · "}
      {` ${String(executed.length)} executed`}
      {parkedCount > 0 ? ` · ${String(parkedCount)} parked` : ""}
    </span>
  );
}

interface TimelineFragmentProps {
  readonly entry: FeatureTimelineEntry;
  /** The feature id the gap before this chip sits after (`null` = start). */
  readonly gapAnchorId: FeatureId | null;
  readonly gapLabel: string;
  readonly activeGap: boolean;
  readonly onSetRollback: (anchorId: FeatureId | null) => void;
  readonly onClearRollback: () => void;
  readonly onToggleSuppressed: (id: FeatureId) => void;
}

/** One chip plus the rollback gap before it. */
function TimelineFragment({
  entry,
  gapAnchorId,
  gapLabel,
  activeGap,
  onSetRollback,
  onClearRollback,
  onToggleSuppressed,
}: TimelineFragmentProps): ReactElement {
  const presentation = TIMELINE_STATUS_PRESENTATION[entry.status];
  const suppressed = entry.status === "suppressed";
  return (
    <>
      <TimelineGap
        label={gapLabel}
        active={activeGap}
        onSet={() => {
          onSetRollback(gapAnchorId);
        }}
        onClear={onClearRollback}
      />
      <span
        className={`flex shrink-0 items-center gap-1.5 border px-2 py-1 text-xs ${presentation.chip}`}
        data-testid="timeline-chip"
        data-timeline-id={entry.id}
        data-timeline-status={entry.status}
        title={
          entry.diagnostics.length === 0
            ? `${entry.kind} (${String(entry.id)})`
            : entry.diagnostics
                .map((diagnostic) => diagnostic.message)
                .join("\n")
        }
      >
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${presentation.dot}`}
        />
        <span className={presentation.text}>{entry.kind}</span>
        <span className={`text-[11px] leading-none ${presentation.text}`}>
          {TIMELINE_STATUS_LABELS[entry.status]}
        </span>
        <button
          type="button"
          aria-label={
            suppressed ? `Include ${entry.kind}` : `Suppress ${entry.kind}`
          }
          aria-pressed={suppressed}
          className="text-muted-foreground hover:text-foreground ml-0.5 inline-flex size-4 cursor-pointer items-center justify-center"
          title={
            suppressed ? `Include ${entry.kind}` : `Suppress ${entry.kind}`
          }
          onClick={() => {
            onToggleSuppressed(entry.id);
          }}
        >
          {suppressed ? (
            <Eye aria-hidden="true" className="size-3" />
          ) : (
            <EyeOff aria-hidden="true" className="size-3" />
          )}
        </button>
      </span>
    </>
  );
}

/**
 * The rollback gap between two chips (or before the first / after the
 * last): a narrow named button. When the marker occupies this gap, the gap
 * renders the amber marker bar and clicking removes it.
 */
function TimelineGap({
  label,
  active,
  onSet,
  onClear,
}: {
  readonly label: string;
  readonly active: boolean;
  readonly onSet: () => void;
  readonly onClear: () => void;
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={active ? `Remove rollback point — ${label}` : label}
      className="hover:bg-muted relative h-5 w-3 shrink-0 cursor-pointer"
      title={active ? `Remove rollback point — ${label}` : label}
      onClick={() => {
        if (active) {
          onClear();
        } else {
          onSet();
        }
      }}
    >
      {active ? (
        <span
          aria-hidden="true"
          className="bg-amber-500 absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2"
          data-testid="rollback-marker"
        />
      ) : null}
    </button>
  );
}
