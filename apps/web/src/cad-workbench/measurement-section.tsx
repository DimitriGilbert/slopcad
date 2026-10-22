/**
 * The measurement home (the Phase 13 block, extended in Phases 27.1-27.4),
 * extracted in Phase 28 so BOTH composed workbench pages render the ONE
 * block: every measurement readout surfaces here — the Distance row
 * carries the selection's reference-pair distance (falling back to the
 * measure tool's point-pair completion), the Bounds row the selected
 * body's kernel-measured bounding dimensions, the Radius row the selected
 * circular/cylindrical reference's radius with its diameter dual, and the
 * Volume/Area rows the selected body's kernel-measured mass properties.
 * All rows format their values through the same dimensional unit
 * infrastructure; every value is engine-derived, nothing is invented.
 *
 * Honesty rule: a row with no value does not exist. The boot state (no
 * selection) is ONE quiet instruction line — never a wall of `n/a` under
 * a status bar that is already reporting the document's volume. Each
 * readout element mounts exactly when its value does (a pinned machine
 * surface: the suites assert `toHaveCount(0)` on unmeasured states).
 */

import type { ReactElement, ReactNode } from "react";
import { Scissors, Slice } from "lucide-react";
import { PanelHeader } from "@slopcad/ui/components/cockpit/panel";
import { PropertyRow } from "@slopcad/ui/components/cockpit/property-row";
import {
  ToolButton,
  ToolGroup,
} from "@slopcad/ui/components/cockpit/tool-button";
import type { BoundsReadout } from "./bounds-inspection";
import type { MassPropertiesReadout } from "./mass-properties-inspection";
import type { RadiusReadout } from "./radius-inspection";
import type { SectionInspectionReadout } from "./section-inspection";

export interface WorkbenchMeasurementSectionProps {
  /** The distance row's composed text, or `null` for the no-value state. */
  readonly distanceText: string | null;
  /** The distance value's provenance (the readout's source or "point pair"). */
  readonly distanceSource: string | null;
  /** The bounds readout (text + tightness). */
  readonly boundsState: BoundsReadout;
  /** The radius readout (text + diameter dual + source). */
  readonly radiusState: RadiusReadout;
  /** The mass-properties readout (volume + area text). */
  readonly massPropertiesState: MassPropertiesReadout;
  /** The section readout (Phase 46): area + centroid text, or nulls. */
  readonly sectionState: SectionInspectionReadout;
  /** Whether the section clip is on (the toggle's pressed state). */
  readonly sectionClipped: boolean;
  /** Whether the section VIEW mode (the cut solid) is on. */
  readonly sectionViewMode: boolean;
  /** Toggles the section clip. */
  readonly onToggleSectionClipped: () => void;
  /** Toggles the section view mode. */
  readonly onToggleSectionViewMode: () => void;
  /**
   * Suppresses the block's own name strip and top rule, for a host that
   * already supplies both. The cockpit's inspector rail wraps this block
   * in a collapsible `PanelSection` named "Measurement" (LAYOUT.md 3.6
   * moved it from LEFT to RIGHT, where it belongs: a measurement is a
   * property of the selection, not part of the document's structure), so
   * a second "MEASUREMENT" band under it would be pure duplication. The
   * legacy Phase 15 page keeps the strip — its DOM is pinned.
   */
  readonly hideHeader?: boolean;
}

/**
 * One labeled row — the cockpit `PropertyRow`, rendered only when a value
 * exists (an empty instrument row is a lie).
 *
 * The block used to carry its own flex pair with its own gap and ink,
 * which is how the measurement home drifted off the density contract: the
 * rows sat at ~22px with 8px of air between them and no separator, so the
 * same facts the status bar prints as a tight DRO read as a loose list
 * here. The primitive supplies the 24px, the label voice and the hairline;
 * every readout's own `id` stays exactly where it was — those ids are the
 * machine surface the suites assert on.
 */
function MeasurementRow({
  label,
  text,
  children,
}: {
  readonly label: string;
  readonly text: string | null;
  readonly children: ReactNode;
}): ReactElement | null {
  if (text === null) return null;
  return (
    /* The flexible column is the VALUE's here, not the label's: a measured
       extent ("20.000 × 20.000 × 20.000 mm") is far longer than its name,
       and under the row's default template it pushed "Bounds" into an
       ellipsis. A readout whose own name is unreadable is not a readout. */
    <PropertyRow
      className="grid-cols-[auto_minmax(0,1fr)] items-baseline [&>[data-slot=property-value]]:min-w-0"
      label={label}
    >
      <span className="w-full min-w-0 text-right break-words">{children}</span>
    </PropertyRow>
  );
}

/** The measurement block: the composed workbench pages' shared instance. */
export function WorkbenchMeasurementSection({
  boundsState,
  distanceSource,
  distanceText,
  hideHeader = false,
  massPropertiesState,
  radiusState,
  sectionState,
  sectionClipped,
  sectionViewMode,
  onToggleSectionClipped,
  onToggleSectionViewMode,
}: WorkbenchMeasurementSectionProps): ReactElement {
  const measured =
    distanceText !== null ||
    boundsState.text !== null ||
    radiusState.text !== null ||
    massPropertiesState.volumeText !== null ||
    massPropertiesState.areaText !== null ||
    sectionState.areaText !== null;
  return (
    <section
      aria-label="Measurement"
      className={
        hideHeader
          ? "w-full min-w-0 shrink-0"
          : "w-full shrink-0 border-t border-rule"
      }
    >
      {hideHeader ? null : (
        <PanelHeader className="bg-well/60" title="Measurement" />
      )}
      {/* The Phase 46 section display controls: the persisted plane's clip
          toggle and the view-mode toggle (the cut solid with cap faces).
          Both are ARMED TOOLS, so their pressed appearance is the
          primitive's: `aria-pressed` carries the truth and `ToolButton`
          paints the one sanctioned wash plus a 1px signal edge.

          Step 3 took them the rest of the way into the strip's dialect:
          icon controls whose `aria-label` and `title` carry the words the
          buttons used to print ("section", "view cut"), so the rail reads
          as one instrument instead of two text chips on a tool row. */}
      <ToolGroup
        className="border-b border-rule/60 px-(--pad-panel) py-(--gap-tight)"
        label="Section display"
        separated={false}
      >
        <ToolButton
          aria-label="section"
          aria-pressed={sectionClipped}
          data-testid="section-clip-toggle"
          onClick={onToggleSectionClipped}
          size="icon"
          title="Clip the scene with the persisted section plane."
        >
          <Scissors aria-hidden="true" />
        </ToolButton>
        <ToolButton
          aria-label="view cut"
          aria-pressed={sectionViewMode}
          data-testid="section-view-toggle"
          disabled={!sectionClipped}
          onClick={onToggleSectionViewMode}
          size="icon"
          title={
            sectionClipped
              ? "Show the cut solid with its cap faces instead of the clipped shell."
              : "Clip the scene first; the cut solid needs a section plane."
          }
        >
          <Slice aria-hidden="true" />
        </ToolButton>
      </ToolGroup>
      {measured ? (
        <div className="flex flex-col">
          <MeasurementRow label="Distance" text={distanceText}>
            <span id="workbench-measure-readout" className="block break-words">
              {distanceText}
            </span>
            <span id="workbench-distance-source" className="block ink-faint">
              {distanceSource}
            </span>
          </MeasurementRow>
          <MeasurementRow label="Bounds" text={boundsState.text}>
            <span id="workbench-bounds-readout" className="block break-words">
              {boundsState.text}
            </span>
            <span id="workbench-bounds-tightness" className="block ink-faint">
              {boundsState.tightness === "tight"
                ? "tight"
                : "may be conservative"}
            </span>
          </MeasurementRow>
          <MeasurementRow label="Radius" text={radiusState.text}>
            <span id="workbench-radius-readout" className="block break-words">
              {radiusState.text}
            </span>
            <span id="workbench-radius-diameter" className="block break-words">
              {radiusState.diameterText}
            </span>
            <span id="workbench-radius-source" className="block ink-faint">
              {radiusState.source}
            </span>
          </MeasurementRow>
          <MeasurementRow label="Volume" text={massPropertiesState.volumeText}>
            <span id="workbench-volume-readout" className="block break-words">
              {massPropertiesState.volumeText}
            </span>
          </MeasurementRow>
          <MeasurementRow label="Area" text={massPropertiesState.areaText}>
            <span id="workbench-area-readout" className="block break-words">
              {massPropertiesState.areaText}
            </span>
          </MeasurementRow>
          {/* The Phase 46 section rows: the active section plane's kernel
              face measurements, rendered only when the settled scene cut
              one — a declined section carries no numbers. */}
          <MeasurementRow label="Section" text={sectionState.areaText}>
            <span
              id="workbench-section-area-readout"
              data-testid="section-area"
              className="block break-words"
            >
              {sectionState.areaText}
            </span>
            <span
              id="workbench-section-centroid-readout"
              data-testid="section-centroid"
              className="block ink-faint"
            >
              {sectionState.centroidText}
            </span>
          </MeasurementRow>
        </div>
      ) : (
        <p className="px-(--pad-row) py-(--gap) font-mono text-data ink-dim">
          select a body to measure
        </p>
      )}
    </section>
  );
}
