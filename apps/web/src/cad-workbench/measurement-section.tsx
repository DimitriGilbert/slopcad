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
 */

import type { ReactElement, ReactNode } from "react";
import type { BoundsReadout } from "./bounds-inspection";
import type { MassPropertiesReadout } from "./mass-properties-inspection";
import type { RadiusReadout } from "./radius-inspection";

export interface WorkbenchMeasurementSectionProps {
  /** The distance row's composed text, or `null` for the em-dash state. */
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

/** One labeled row: muted label left, mono value right (or an em-dash). */
function MeasurementRow({
  label,
  text,
  children,
}: {
  readonly label: string;
  readonly text: string | null;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      {text === null ? (
        <span className="text-muted-foreground font-mono">—</span>
      ) : (
        <span className="text-right font-mono">{children}</span>
      )}
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
  return (
    <section
      aria-label="Measurement"
      className="border-border bg-background w-48 border"
    >
      <div className="text-muted-foreground border-border border-b px-2 py-1.5 text-xs font-medium tracking-wider uppercase">
        Measurement
      </div>
      <div className="flex flex-col gap-1.5 px-2 py-2 text-xs">
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
    </section>
  );
}
