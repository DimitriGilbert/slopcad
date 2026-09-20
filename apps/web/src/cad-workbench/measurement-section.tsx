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
import type { BoundsReadout } from "./bounds-inspection";
import type { MassPropertiesReadout } from "./mass-properties-inspection";
import type { RadiusReadout } from "./radius-inspection";

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
}

/** One labeled row: muted label left, mono value right. Rendered only
 * when a value exists — an empty instrument row is a lie. */
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
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="text-right font-mono">{children}</span>
    </div>
  );
}

/** The measurement block: the composed workbench pages' shared instance. */
export function WorkbenchMeasurementSection({
  boundsState,
  distanceSource,
  distanceText,
  massPropertiesState,
  radiusState,
}: WorkbenchMeasurementSectionProps): ReactElement {
  const measured =
    distanceText !== null ||
    boundsState.text !== null ||
    radiusState.text !== null ||
    massPropertiesState.volumeText !== null ||
    massPropertiesState.areaText !== null;
  return (
    <section
      aria-label="Measurement"
      className="border-border w-full shrink-0 border-t"
    >
      <div className="text-muted-foreground border-border bg-background/30 border-b px-2.5 py-1.5 font-mono text-[10.5px] font-medium tracking-[0.08em] uppercase">
        Measurement
      </div>
      {measured ? (
        <div className="flex flex-col gap-2 px-2.5 py-2.5 text-xs">
          <MeasurementRow label="Distance" text={distanceText}>
            <span id="workbench-measure-readout" className="block break-words">
              {distanceText}
            </span>
            <span
              id="workbench-distance-source"
              className="text-muted-foreground block"
            >
              {distanceSource}
            </span>
          </MeasurementRow>
          <MeasurementRow label="Bounds" text={boundsState.text}>
            <span id="workbench-bounds-readout" className="block break-words">
              {boundsState.text}
            </span>
            <span
              id="workbench-bounds-tightness"
              className="text-muted-foreground block"
            >
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
            <span
              id="workbench-radius-source"
              className="text-muted-foreground block"
            >
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
        </div>
      ) : (
        <p className="text-muted-foreground px-2.5 py-2.5 font-mono text-[11px]">
          select a body to measure
        </p>
      )}
    </section>
  );
}
