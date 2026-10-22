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
  /** The feature count, or `null` before the timeline exists. */
  readonly featureCount: number | null;
  /** The `statusBar` slot's node (see the chrome/content contract above). */
  readonly statusBar: ReactNode;
}

/** The status band: the settle lamp, the document plate, the status bar. */
export function WorkbenchStatusBand({
  extentsText,
  featureCount,
  sceneKind,
  settled,
  statusBar,
}: WorkbenchStatusBandProps): ReactElement {
  return (
    <div
      className="flex shrink-0 items-center gap-(--gap-group) border-t border-rule bg-panel pl-(--pad-panel)"
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
      {/* The document plate: what this document IS, live. */}
      <div
        aria-label="Document"
        className="flex shrink-0 items-center gap-(--gap-group)"
        role="group"
      >
        <Readout label="scene">{sceneKind}</Readout>
        <Readout label="extents">{extentsText ?? "computing…"}</Readout>
        {featureCount === null ? null : (
          <Readout label="features">{String(featureCount)}</Readout>
        )}
      </div>
      <div className="flex min-w-0 flex-1 items-center">{statusBar}</div>
    </div>
  );
}
