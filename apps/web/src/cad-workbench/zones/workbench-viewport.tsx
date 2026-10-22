/**
 * CENTER — `WorkbenchViewport`, the machine bed and its own bottom edge.
 *
 * ## What this replaces
 *
 * `defaultViewport`, a ~390-line inline region of `complete-workbench.tsx`
 * that was three things at once: the frame (and its topology-pick pointer
 * seam), one opaque `overlay` fragment of absolutely-positioned siblings
 * each re-deriving its own corner, and the DRO band's whole markup.
 *
 * ## What it is now
 *
 * A zone that owns exactly the pixels between the rails:
 *
 * - the **canvas frame** — full bleed, no bezel, no stage; it carries the
 *   topology-pick pointer seam and the showing stamp;
 * - the **HUD**, as `CadViewportHud`'s NAMED corners (the host supplies
 *   what goes in each; the zone owns where they are and the
 *   pointer-events discipline);
 * - the **DRO band** — the viewport's own bottom edge. It prints the
 *   LIVE facts — the armed tool, the selection count, the pick seam —
 *   the facts that change per action. The document's facts (scene kind,
 *   extents, volume, triangles, the settle lamp) live in the status band
 *   below the frame: one fact, one place, never printed twice ~60px
 *   apart.
 *
 * The canvas itself stays the host's element: the engine owns the
 * projection, the camera session and the settle protocol, and threading
 * fifteen of those through a zone would only move the wiring. The zone
 * takes the canvas as its child and frames it.
 */

import type { ReactElement, ReactNode } from "react";

/** The DRO band's facts — the live ones only, formatted by their owner. */
export interface WorkbenchViewportDro {
  /**
   * Whether an import preview owns the stage. The band prints no scene
   * facts either way — `WorkbenchStatusBand` owns those — but the frame's
   * `data-viewport-showing` stamp still reports what the stage holds.
   */
  readonly showingPreview: boolean;
  /** The armed tool's id, or `null` when nothing is armed. */
  readonly armedToolId: string | null;
  /** How many references the selection holds. */
  readonly selectionCount: number;
}

/** Props of {@link WorkbenchViewport}. */
export interface WorkbenchViewportProps {
  /** The canvas element (the host's `CadViewport`, HUD included). */
  readonly children: ReactNode;
  /** The DRO band's facts. */
  readonly dro: WorkbenchViewportDro;
  /**
   * The topology verbs' non-modal pick seam: the verb being picked for
   * (published as `data-topology-picking`) and the frame-level pointer
   * handler that resolves a pick.
   */
  readonly topologyPickingVerb?: string;
  readonly onFramePointerDown?: (
    event: React.PointerEvent<HTMLDivElement>,
  ) => void;
  /** Hidden (never unmounted) while another mode owns the frame. */
  readonly hidden?: boolean;
}

/**
 * The DRO's value ink: instrument ink, tabular, in BOTH registers.
 *
 * These digits used to be emissive amber with a glow. They are data, not a
 * signal — and the accent rule (DESIGN.md) reserves the signal colour for
 * the armed tool, the selected entity and one confirming action. With a
 * body selected the old treatment put amber on the extents, the volume,
 * the triangle count AND the tool name at once, which is how a cockpit
 * stops being readable: when everything glows, nothing reads.
 */
const DRO_VALUE = "ink tabular";

/** CENTER: the canvas frame, the HUD's layer, and the DRO band. */
export function WorkbenchViewport({
  children,
  dro,
  hidden = false,
  onFramePointerDown,
  topologyPickingVerb,
}: WorkbenchViewportProps): ReactElement {
  return (
    <div
      className={`${hidden ? "hidden" : "flex"} min-h-0 min-w-0 flex-1 flex-col`}
      data-viewport-showing={dro.showingPreview ? "import" : "document"}
      data-zone="center"
      id="workbench-complete-viewport"
    >
      {/* The canvas owns every pixel the docks leave it: full-bleed, no
          bezel, no stage — the machine fills its frame. The settle and
          selection stamps are the host's, on the canvas itself. */}
      <div
        className="relative min-h-0 flex-1"
        data-topology-picking={topologyPickingVerb}
        onPointerDown={onFramePointerDown}
      >
        {children}
      </div>
      {/* The DRO band: the viewport region's LIVE readout, edge to edge
          along its bottom — what is armed, how many references are held,
          and whether the frame is picking. The document's numbers (scene,
          extents, volume, triangles) and the settle lamp live in the
          status band below: each fact prints exactly once, so an operator
          never reads two values for one truth. In the dark register the
          band reads as an emissive instrument: plain digits over
          near-black glass; light stays plain ink on paper. */}
      <div
        className="flex h-7 shrink-0 items-center justify-end gap-(--gap-group) overflow-hidden border-t border-rule bg-well px-(--pad-panel) font-mono text-data whitespace-nowrap ink-dim"
        data-testid="viewport-dro"
      >
        {topologyPickingVerb === undefined ? null : (
          <span>
            pick <span className="ink tabular">{topologyPickingVerb}</span>
          </span>
        )}
        {dro.armedToolId === null ? null : (
          <span>
            tool <span className="ink tabular">{dro.armedToolId}</span> · Esc
            cancels
          </span>
        )}
        <span>
          sel <span className={DRO_VALUE}>{String(dro.selectionCount)}</span>
        </span>
      </div>
    </div>
  );
}
