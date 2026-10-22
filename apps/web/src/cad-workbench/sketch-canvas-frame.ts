/**
 * The sketch canvas's FRAME: how big the deterministic 2D surface is when
 * it fills the cockpit's CENTER zone instead of sitting in the middle of a
 * `flex-wrap items-start justify-center` stage.
 *
 * `CadSketchCanvas` is a fixed-size SVG whose pointer math is 1:1 with CSS
 * pixels (`clientX - rect.left`, then `(x - origin.x) / scale`). That is
 * why the canvas is not scaled to fit: scaling would silently break every
 * pick. Instead the HOST measures the frame and hands the canvas its real
 * size, so the surface is as large as the zone with the transform
 * untouched — the workplane ORIGIN stays exactly where
 * `SKETCH_CANVAS.origin` puts it, measured from the frame's top-left
 * corner, and every workplane→pixel derivation (the documented one the
 * harnesses use) keeps its answer.
 *
 * Before a measurement exists — server render, the first client frame, and
 * any environment without a layout (jsdom reports a zero-sized box) — the
 * canvas keeps its documented constant size. A zero-sized canvas is never
 * rendered, and the constants stay the surface's honest fallback.
 */

/** A frame measurement in CSS pixels. */
export interface SketchCanvasBox {
  readonly width: number;
  readonly height: number;
}

/**
 * The size the canvas renders at: the measured frame when it has one,
 * the documented constants otherwise.
 */
export function sketchCanvasSize(
  measured: SketchCanvasBox | null,
  fallback: SketchCanvasBox,
): SketchCanvasBox {
  if (measured === null) return fallback;
  if (!(measured.width > 0) || !(measured.height > 0)) return fallback;
  return {
    height: Math.floor(measured.height),
    width: Math.floor(measured.width),
  };
}
