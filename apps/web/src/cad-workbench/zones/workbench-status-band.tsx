/**
 * BOTTOM — `WorkbenchStatusBand`, the cockpit's state edge.
 *
 * The band owns the frame's bottom rule, the settle lamp, the document
 * plate evicted from the tool strip, and whatever the `statusBar` slot
 * supplies. Three things changed when it became a component:
 *
 * 1. **The `pl-9` reach-in is gone.** The lamp used to be absolutely
 *    positioned over the status bar's left padding, with the host writing
 *    `[&_[data-slot='cad-status-bar']]:pl-9` — a descendant selector
 *    reaching into another component's internals to make room for it.
 *    The lamp is now a `StatusDot` sitting in normal flow, and the band's
 *    own layout makes its room.
 * 2. **The document plate came down from TOP.** Scene kind, extents and
 *    feature count are STATUS — they describe where the document is, not
 *    what can be done to it — and they were sitting in the tool strip
 *    consuming the width the verbs needed. They now read as `Readout`
 *    cells in the vocabulary the DRO band already speaks.
 * 3. **The band owns the chrome, the slot owns the content.** The band
 *    draws the top rule and the surface; a `statusBar` slot node renders
 *    inside it and must therefore be transparent and borderless — the
 *    contract the two product routes' nodes keep.
 */

import type { ReactElement, ReactNode } from "react";
import {
  Readout,
  StatusDot,
} from "@slopcad/ui/components/cockpit/property-row";

/** Props of {@link WorkbenchStatusBand}. */
export interface WorkbenchStatusBandProps {
  /**
   * Whether the rendered pixels agree with the document. Lit when they
   * do; a hollow ring while the scene settles or an import preview owns
   * the stage.
   */
  readonly settled: boolean;
  /** The scene the stage is showing (`"import"` for a preview). */
  readonly sceneKind: string;
  /** The settled extents text, or `null` while the scene is computing. */
  readonly extentsText: string | null;
  /** The document's triangle count, or `null` while the scene computes. */
  readonly triangles: string | null;
  /**
   * The import preview's facts while one owns the stage, or `null`. The
   * plate follows the stage (the scene cell already reads `"import"` for
   * a preview), so while a mesh is being inspected the plate prints the
   * import's own tris and volume — the document's numbers are not the
   * thing on the bed.
   */
  readonly preview: {
    readonly source: string;
    readonly triangles: string;
    readonly volumeText: string;
  } | null;
  /** The feature count, or `null` before the timeline exists. */
  readonly featureCount: number | null;
  /** The `statusBar` slot's node (see the chrome/content contract above). */
  readonly statusBar: ReactNode;
  /**
   * Hidden (never unmounted) while another mode owns the frame's bottom
   * edge. The zone law gives each mode the same five zones with different
   * CONTENTS, and sketch mode's status content is the sketch's own band —
   * two stacked status edges would be two sources of one truth. The
   * model's band stays MOUNTED so every machine handle it publishes (the
   * settle lamp, the status bar's own surface) keeps answering.
   */
  readonly hidden?: boolean;
}

/** The status band: the settle lamp, the document plate, the status bar. */
export function WorkbenchStatusBand({
  extentsText,
  featureCount,
  hidden = false,
  preview = null,
  sceneKind,
  settled,
  statusBar,
  triangles,
}: WorkbenchStatusBandProps): ReactElement {
  return (
    <div
      className={`${hidden ? "hidden" : "flex"} shrink-0 items-center gap-(--gap-group) border-t border-rule bg-panel pl-(--pad-panel)`}
      data-slot="workbench-status-band"
      data-zone="bottom"
    >
      {/* The settle protocol, glanceable and machine-readable. "Settled"
          is a STATUS, so the lamp is the status lamp's own green, flat —
          the signal colour stays spent on the armed tool. */}
      <StatusDot
        data-settle-lamp={settled ? "settled" : "waiting"}
        label={settled ? "scene settled" : "scene settling"}
        title={
          settled
            ? "Scene settled — the rendered pixels agree with the document."
            : "Scene settling — the rendered pixels are not yet comparable."
        }
        tone={settled ? "ok" : "idle"}
      />
      {/* The document plate: what the stage IS, live — the document's
          own facts while the document is on the bed (scene, extents,
          triangles, features — the volume the session writer settles
          rides the status strip beside it), the import preview's while
          a mesh is being inspected. The DRO band above used to print the
          same numbers; it keeps the live facts now, one place each. */}
      <div
        aria-label="Document"
        className="flex shrink-0 items-center gap-(--gap-group)"
        role="group"
      >
        {preview === null ? (
          <>
            <Readout label="scene">{sceneKind}</Readout>
            <Readout label="extents">{extentsText ?? "computing…"}</Readout>
            {triangles === null ? null : (
              <Readout label="tris">{triangles}</Readout>
            )}
            {featureCount === null ? null : (
              <Readout label="features">{String(featureCount)}</Readout>
            )}
          </>
        ) : (
          <>
            <Readout label="scene">{`${sceneKind} · ${preview.source}`}</Readout>
            <Readout label="tris">{preview.triangles}</Readout>
            <Readout label="vol" unit="mm³">
              {preview.volumeText}
            </Readout>
          </>
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-center">{statusBar}</div>
    </div>
  );
}
