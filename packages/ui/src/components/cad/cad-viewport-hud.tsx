/**
 * `CadViewportHud` — the viewport's overlay layer, with NAMED corners.
 *
 * `CadViewport` has always taken one opaque `overlay` node, and the
 * cockpit passed it a ~250-line fragment of absolutely-positioned
 * siblings: a preview chip at `top-2 left-2`, an alert at `top-2 right-2`,
 * a view-tool panel pinning itself bottom-right, a teaching card
 * translating itself off `left-1/2`, and three camera-projected overlays
 * that cover the whole frame. Every one of those re-derived its own
 * position, and nothing stopped two of them from claiming the same pixels.
 *
 * The HUD gives each of those a NAME and a slot:
 *
 * | Slot           | What belongs there                                |
 * | -------------- | ------------------------------------------------- |
 * | `projected`    | camera-projected geometry over the whole frame    |
 * | `layer`        | an overlay that positions itself (see below)      |
 * | `topLeft`      | mode and preview chips — what the stage is showing |
 * | `topRight`     | alerts about the document or the last action      |
 * | `bottomLeft`   | snap/grid state                                   |
 * | `bottomCenter` | the one transient teaching card                   |
 * | `bottomRight`  | the view tools and the view cube                  |
 *
 * ## Why `layer` exists
 *
 * One overlay in this product is not a corner item: the view/navigation
 * strip pins its own panel bottom-right AND owns a full-frame
 * interaction surface (the zoom window drags a rectangle across the whole
 * canvas). It is already a correct `pointer-events-none` layer with
 * per-element opt-in, and the layout law lists it as a keeper, so the HUD
 * names a full-frame slot for it instead of trapping it in a corner box
 * whose size its own `inset-0` child would then define.
 *
 * ## Pointer discipline
 *
 * The layer and every slot are `pointer-events-none`; a control inside
 * one opts back in with `pointer-events-auto`, exactly as the view tools
 * already do. That is what keeps the canvas live for orbit and pick under
 * a HUD that covers it edge to edge.
 *
 * ## Registration frame
 *
 * The corner ticks are the HUD's own: the stage is framed like a drawing
 * sheet around the workpiece, in the viewport's strong rule. They are
 * decoration, `aria-hidden`, and they are drawn here so no consumer has
 * to re-derive four absolutely-positioned spans.
 */

import { cn } from "cn";
import type { ReactNode } from "react";

/** The HUD's named slots. Every one is optional; absent renders nothing. */
export interface CadViewportHudContent {
  /** Camera-projected overlays: the whole frame, under the corners. */
  readonly projected?: ReactNode;
  /**
   * A full-frame overlay that positions itself and opts its own elements
   * into pointer events (see the module doc).
   */
  readonly layer?: ReactNode;
  /** Mode and preview chips — what the stage is showing. */
  readonly topLeft?: ReactNode;
  /** Alerts about the document or the last action. */
  readonly topRight?: ReactNode;
  /** Snap and grid state. */
  readonly bottomLeft?: ReactNode;
  /** The one transient teaching card. */
  readonly bottomCenter?: ReactNode;
  /** The view tools and the view cube. */
  readonly bottomRight?: ReactNode;
}

/** Props of {@link CadViewportHud}. */
export interface CadViewportHudProps extends CadViewportHudContent {
  /**
   * Whether to draw the registration ticks in the frame's corners.
   * Default `true`; a host whose frame already has an edge passes `false`.
   */
  readonly registration?: boolean;
  /** Extends the layer's classes. */
  readonly className?: string;
}

/** One corner's wrapper: positioned, inert until a child opts in. */
function HudSlot({
  children,
  className,
  name,
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly name: string;
}) {
  if (children === undefined || children === null || children === false) {
    return null;
  }
  return (
    <div
      className={cn("pointer-events-none absolute", className)}
      data-hud-slot={name}
    >
      {children}
    </div>
  );
}

/** The viewport's HUD: named corners over a live canvas. */
export function CadViewportHud({
  bottomCenter,
  bottomLeft,
  bottomRight,
  className,
  layer,
  projected,
  registration = true,
  topLeft,
  topRight,
}: CadViewportHudProps) {
  return (
    <div
      className={cn("pointer-events-none absolute inset-0", className)}
      data-slot="cad-viewport-hud"
    >
      {registration ? (
        <div aria-hidden="true" className="absolute inset-0">
          <span className="absolute top-1.5 left-1.5 size-2.5 border-t border-l border-viewport-rule-strong" />
          <span className="absolute top-1.5 right-1.5 size-2.5 border-t border-r border-viewport-rule-strong" />
          <span className="absolute bottom-1.5 left-1.5 size-2.5 border-b border-l border-viewport-rule-strong" />
          <span className="absolute right-1.5 bottom-1.5 size-2.5 border-r border-b border-viewport-rule-strong" />
        </div>
      ) : null}
      {projected === undefined ? null : (
        <div
          className="pointer-events-none absolute inset-0"
          data-hud-slot="projected"
        >
          {projected}
        </div>
      )}
      {layer === undefined ? null : (
        <div
          className="pointer-events-none absolute inset-0"
          data-hud-slot="layer"
        >
          {layer}
        </div>
      )}
      <HudSlot className="top-2 left-2" name="top-left">
        {topLeft}
      </HudSlot>
      <HudSlot className="top-2 right-2 max-w-sm" name="top-right">
        {topRight}
      </HudSlot>
      <HudSlot className="bottom-2 left-2" name="bottom-left">
        {bottomLeft}
      </HudSlot>
      <HudSlot
        className="bottom-3 left-1/2 w-max max-w-[calc(100%-1rem)] -translate-x-1/2"
        name="bottom-center"
      >
        {bottomCenter}
      </HudSlot>
      <HudSlot className="right-2 bottom-2" name="bottom-right">
        {bottomRight}
      </HudSlot>
    </div>
  );
}
