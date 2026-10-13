/**
 * Colormaps as data (ROADMAP-SIM Phase 62b): the fixed visual mapping a
 * field overlay paints scalar values with — the exact Phase 59
 * light-rig/lighting.ts discipline, restated for colormaps. Every map is a
 * NAMED, pure-data record (anchor stops plus piecewise-linear
 * interpolation in sRGB), selectable by id through a total lookup, with
 * deterministic output: the same map and the same scalar always produce
 * the same color triple — no LUT caches keyed on anything but the inputs,
 * no dithering, no gamma surprise.
 *
 * ## The three first maps
 *
 * - `viridis` — the perceptually-uniform default (matplotlib's published
 *   anchor values, restated as stop data), the honest default a field
 *   view should start from.
 * - `jet` — the classic piecewise-linear jet, the look of the owner's
 *   `cfd-ts` lineage (ROADMAP-SIM §3): its ideas seed this table, its
 *   code is not copied — the six-stop form below is public-domain
 *   arithmetic.
 * - `coolwarm` — Moreland's diverging blue–neutral–red, the map
 *   signed quantities (pressure coefficients, signed distances) read
 *   best through; carried as its three canonical anchors.
 *
 * ## Color spaces
 *
 * Stop colors are authored sRGB triples in [0, 1] (the published anchor
 * values), and {@link sampleFieldColormap} interpolates IN sRGB — the
 * data form. three.js consumes vertex colors in its linear working
 * space, so geometry builders paint through {@link fieldColorRamp},
 * which applies the exact sRGB→linear transfer (the piecewise
 * IEC 61966-2-1 curve) after interpolation. Both steps are pure math
 * with pinned test values; converting first and interpolating in linear
 * would be a DIFFERENT (also deterministic) map — this file defines
 * interpolate-in-sRGB as the authored semantics.
 */

/** One colormap anchor: a position in [0, 1] and its sRGB color triple. */
export interface FieldColormapStop {
  readonly position: number;
  /** sRGB channels in [0, 1] — the published anchor values' form. */
  readonly color: readonly [number, number, number];
}

/** A named colormap: ordered anchor stops plus linear interpolation. */
export interface FieldColormap {
  /** The map's stable id (the overlay selector's handle). */
  readonly id: string;
  /** The map's display label. */
  readonly label: string;
  /** Anchors strictly ascending by position, starting at 0 and ending at 1. */
  readonly stops: readonly FieldColormapStop[];
}

/**
 * The viridis anchors — matplotlib's published values (BSD-licensed
 * data, restated): the perceptually-uniform default.
 */
export const CAD_FIELD_COLORMAP_VIRIDIS: FieldColormap = Object.freeze({
  id: "viridis",
  label: "Viridis",
  stops: Object.freeze([
    Object.freeze({
      position: 0,
      color: Object.freeze([0.267004, 0.004874, 0.329415] as const),
    }),
    Object.freeze({
      position: 0.25,
      color: Object.freeze([0.229739, 0.322361, 0.545706] as const),
    }),
    Object.freeze({
      position: 0.5,
      color: Object.freeze([0.127568, 0.566949, 0.550556] as const),
    }),
    Object.freeze({
      position: 0.75,
      color: Object.freeze([0.369214, 0.788888, 0.382914] as const),
    }),
    Object.freeze({
      position: 1,
      color: Object.freeze([0.993248, 0.906157, 0.143936] as const),
    }),
  ]),
});

/**
 * The classic piecewise-linear jet — the `cfd-ts` lineage's look, restated
 * as public-domain stop arithmetic (no code copied): dark blue → blue →
 * cyan → yellow → red → dark red with the canonical eighth-fraction
 * breaks.
 */
export const CAD_FIELD_COLORMAP_JET: FieldColormap = Object.freeze({
  id: "jet",
  label: "Jet",
  stops: Object.freeze([
    Object.freeze({
      position: 0,
      color: Object.freeze([0, 0, 0.5] as const),
    }),
    Object.freeze({
      position: 0.125,
      color: Object.freeze([0, 0, 1] as const),
    }),
    Object.freeze({
      position: 0.375,
      color: Object.freeze([0, 1, 1] as const),
    }),
    Object.freeze({
      position: 0.625,
      color: Object.freeze([1, 1, 0] as const),
    }),
    Object.freeze({
      position: 0.875,
      color: Object.freeze([1, 0, 0] as const),
    }),
    Object.freeze({
      position: 1,
      color: Object.freeze([0.5, 0, 0] as const),
    }),
  ]),
});

/**
 * The coolwarm anchors — Moreland's diverging map carried as its three
 * canonical anchors (cool blue, neutral grey, warm red), the map signed
 * quantities read best through.
 */
export const CAD_FIELD_COLORMAP_COOLWARM: FieldColormap = Object.freeze({
  id: "coolwarm",
  label: "Cool–warm",
  stops: Object.freeze([
    Object.freeze({
      position: 0,
      color: Object.freeze([0.231, 0.299, 0.754] as const),
    }),
    Object.freeze({
      position: 0.5,
      color: Object.freeze([0.865, 0.865, 0.865] as const),
    }),
    Object.freeze({
      position: 1,
      color: Object.freeze([0.706, 0.016, 0.15] as const),
    }),
  ]),
});

/** Every colormap the overlays offer, in selector order (viridis first: the default). */
export const CAD_FIELD_COLORMAPS: readonly FieldColormap[] = Object.freeze([
  CAD_FIELD_COLORMAP_VIRIDIS,
  CAD_FIELD_COLORMAP_JET,
  CAD_FIELD_COLORMAP_COOLWARM,
]);

/** The map ids, for exhaustive selectors and session validation. */
export const CAD_FIELD_COLORMAP_IDS: readonly string[] = Object.freeze(
  CAD_FIELD_COLORMAPS.map((map) => map.id),
);

/** Reads a colormap by id; an unknown id falls back to the viridis default. */
export function fieldColormapById(id: string): FieldColormap {
  return (
    CAD_FIELD_COLORMAPS.find((map) => map.id === id) ??
    CAD_FIELD_COLORMAP_VIRIDIS
  );
}

/**
 * Samples a colormap at position `t` — clamped to [0, 1], then linearly
 * interpolated per channel between the bracketing stops (exactly a stop
 * at its position). Pure: same map and `t`, same triple.
 */
export function sampleFieldColormap(
  map: FieldColormap,
  t: number,
): readonly [number, number, number] {
  const stops = map.stops;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (first === undefined || last === undefined) {
    throw new RangeError(
      `The colormap "${map.id}" carries no stops; a colormap needs at least one.`,
    );
  }
  if (t <= first.position) return first.color;
  if (t >= last.position) return last.color;
  for (let index = 0; index < stops.length - 1; index += 1) {
    const lower = stops[index];
    const upper = stops[index + 1];
    if (lower === undefined || upper === undefined) continue;
    if (t >= lower.position && t <= upper.position) {
      const span = upper.position - lower.position;
      if (span <= 0) return lower.color;
      const fraction = (t - lower.position) / span;
      return [
        lower.color[0] + fraction * (upper.color[0] - lower.color[0]),
        lower.color[1] + fraction * (upper.color[1] - lower.color[1]),
        lower.color[2] + fraction * (upper.color[2] - lower.color[2]),
      ];
    }
  }
  // Unreachable for well-formed stops (ascending, first ≤ t ≤ last).
  return last.color;
}

/**
 * The exact sRGB→linear transfer of IEC 61966-2-1 (the curve three.js
 * vertex colors assume they receive): the linear half below 0.04045, the
 * 2.4-power curve above. Pure math — the same input always the same
 * output, no table, no approximation.
 */
export function fieldSrgbToLinear(channel: number): number {
  return channel <= 0.04045
    ? channel / 12.92
    : ((channel + 0.055) / 1.055) ** 2.4;
}

/**
 * How an overlay paints values: a colormap plus the value window it maps
 * onto the map's [0, 1]. Absent `valueRange` normalizes by the field's
 * own range (the builder passes it as the fallback window — the decoded
 * grid's documented [min, max]); an explicit range pins the legend
 * (comparative views keep one window across runs).
 */
export interface FieldColorScale {
  readonly colormap: FieldColormap;
  readonly valueRange?: readonly [number, number];
}

/**
 * Compiles a color scale into the per-value paint function the geometry
 * builders consume: value → normalized position over the effective window
 * (clamped) → colormap sample (sRGB) → linear triple. A degenerate window
 * (max ≤ min, e.g. a constant field with no explicit range) maps
 * everything to the scale's bottom, never a NaN. Deterministic end to end.
 */
export function fieldColorRamp(
  scale: FieldColorScale,
  fallbackRange: readonly [number, number],
): (value: number) => readonly [number, number, number] {
  const window: readonly [number, number] =
    scale.valueRange === undefined ? fallbackRange : scale.valueRange;
  return (value: number): readonly [number, number, number] => {
    const [min, max] = window;
    const t = max > min ? (value - min) / (max - min) : 0;
    const clamped = Math.min(Math.max(t, 0), 1);
    const [r, g, b] = sampleFieldColormap(scale.colormap, clamped);
    return [fieldSrgbToLinear(r), fieldSrgbToLinear(g), fieldSrgbToLinear(b)];
  };
}
