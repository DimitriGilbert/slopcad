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
 * - the **DRO band** — the viewport's own bottom edge, because it reads
 *   the camera and the picked entity, not the document's history. The
 *   band is rendered from a DATA descriptor here, so the cockpit no longer
 *   carries 90 lines of readout markup.
 *
 * The canvas itself stays the host's element: the engine owns the
 * projection, the camera session and the settle protocol, and threading
 * fifteen of those through a zone would only move the wiring. The zone
 * takes the canvas as its child and frames it.
 */

import type { ReactElement, ReactNode } from "react";

/** The DRO band's facts — formatted by their owner, printed here. */
export interface WorkbenchViewportDro {
  /** Whether an import preview owns the stage (the band swaps vocabulary). */
  readonly showingPreview: boolean;
  /** Whether the rendered frame agrees with the document (the lamp). */
  readonly settled: boolean;
  /** The import preview's facts, when one is showing. */
  readonly preview: {
    readonly source: string;
    readonly triangles: string;
    readonly volumeText: string;
  } | null;
  /** The document's facts, or `null` while the scene computes. */
  readonly document: {
    readonly sceneKind: string;
    readonly extentsText: string;
    readonly volumeText: string;
    readonly triangles: string;
  } | null;
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
      {/* The DRO band: the viewport region's readout, edge to edge along
          its bottom — the same honest engine numbers the machine surfaces
          carry (scene kind, extents, volume, triangles), plus the settle
          lamp and the live tool state. Never a second source of truth. In
          the dark register the band reads as an emissive instrument: amber
          digits over near-black glass (the cockpit's glance-mark); light
          stays plain ink on paper. */}
      <div
        className="flex h-7 shrink-0 items-center gap-(--gap-group) overflow-hidden border-t border-rule bg-well px-(--pad-panel) font-mono text-data whitespace-nowrap ink-dim"
        data-testid="viewport-dro"
      >
        <span
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${
            dro.settled ? "bg-status-ok" : "bg-signal motion-safe:animate-pulse"
          }`}
        />
        {/* The static facts: the band's shrinkable half. */}
        <div className="flex min-w-0 items-center gap-(--gap-group) overflow-hidden">
          {dro.showingPreview ? (
            <>
              <span className="ink tabular">
                import · {dro.preview?.source ?? ""}
              </span>
              <span>
                tris <span className={DRO_VALUE}>{dro.preview?.triangles}</span>
              </span>
              <span>
                vol{" "}
                <span className={DRO_VALUE}>
                  {dro.preview === null ? "…" : `${dro.preview.volumeText} mm³`}
                </span>
              </span>
              <span>geometry only, not in the document</span>
            </>
          ) : dro.document === null ? (
            <span className="ink tabular">computing…</span>
          ) : (
            <>
              <span className="ink tabular">{dro.document.sceneKind}</span>
              <span>
                extents{" "}
                <span className={DRO_VALUE}>{dro.document.extentsText}</span>
              </span>
              <span>
                vol{" "}
                <span className={DRO_VALUE}>
                  {`${dro.document.volumeText} mm³`}
                </span>
              </span>
              <span>
                tris <span className={DRO_VALUE}>{dro.document.triangles}</span>
              </span>
            </>
          )}
        </div>
        {/* The live tool state rides the DRO's right end: what is armed,
            and how it cancels. It used to be `hidden … sm:flex` — the
            most VOLATILE fact in the band, deleted by viewport width.
            It is `shrink-0` now instead: the band's static facts (scene,
            extents, volume, triangles) give up their width first, and
            what is armed is always on screen. */}
        <span className="ml-auto flex shrink-0 items-center gap-(--gap-group)">
          {dro.armedToolId === null ? null : (
            <span>
              tool <span className="ink tabular">{dro.armedToolId}</span> · Esc
              cancels
            </span>
          )}
          <span>
            sel <span className={DRO_VALUE}>{String(dro.selectionCount)}</span>
          </span>
        </span>
      </div>
    </div>
  );
}
