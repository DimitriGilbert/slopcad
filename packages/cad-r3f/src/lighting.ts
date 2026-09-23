/**
 * Light rigs as data (Phase 59): the fixed Phase 11.3 rig generalizes into
 * named, pure-data presets — {@link CadLightRig} records the ambient level
 * and the two directional lights' directions and intensities, and the rig
 * named `"studio"` IS the pinned constants (`scene-lights.tsx`), so the
 * default render is byte-identical to the pre-preset scene. Every rig is
 * deterministic given state: fixed kinds, fixed coordinates, fixed
 * intensities, no environment probes, nothing clock- or frame-derived.
 */

/** One directional light of a rig: position (z-up mm scene) + intensity. */
export interface CadRigLight {
  readonly position: readonly [number, number, number];
  readonly intensity: number;
}

/** A named light rig: ambient fill + key + fill directional lights. */
export interface CadLightRig {
  /** The rig's stable id (the viewport selector's handle). */
  readonly id: string;
  /** The rig's display label. */
  readonly label: string;
  readonly ambient: number;
  readonly key: CadRigLight;
  readonly fill: CadRigLight;
}

/** The studio rig's constants — verbatim the pinned Phase 11.3 values. */
export const CAD_LIGHT_RIG_STUDIO: CadLightRig = Object.freeze({
  id: "studio",
  label: "Studio",
  ambient: 1.2,
  key: Object.freeze({
    position: Object.freeze([60, 80, 40] as const),
    intensity: 2.0,
  }),
  fill: Object.freeze({
    position: Object.freeze([-50, -20, -60] as const),
    intensity: 0.6,
  }),
});

/**
 * The north-window rig: one soft high key straight overhead and a gentle
 * neutral fill — a diffuse, low-contrast reading light for judging form.
 */
export const CAD_LIGHT_RIG_NORTH_WINDOW: CadLightRig = Object.freeze({
  id: "north-window",
  label: "North window",
  ambient: 1.5,
  key: Object.freeze({
    position: Object.freeze([10, 10, 90] as const),
    intensity: 1.6,
  }),
  fill: Object.freeze({
    position: Object.freeze([-60, -30, 20] as const),
    intensity: 0.5,
  }),
});

/**
 * The inspection rig: a steep key and a strong opposing fill flatten
 * shadows for face-boundary checking — higher contrast than the studio.
 */
export const CAD_LIGHT_RIG_INSPECTION: CadLightRig = Object.freeze({
  id: "inspection",
  label: "Inspection",
  ambient: 1.0,
  key: Object.freeze({
    position: Object.freeze([20, 40, 80] as const),
    intensity: 2.4,
  }),
  fill: Object.freeze({
    position: Object.freeze([-70, -50, -10] as const),
    intensity: 1.1,
  }),
});

/** Every rig the viewport offers, in selector order. */
export const CAD_LIGHT_RIGS: readonly CadLightRig[] = Object.freeze([
  CAD_LIGHT_RIG_STUDIO,
  CAD_LIGHT_RIG_NORTH_WINDOW,
  CAD_LIGHT_RIG_INSPECTION,
]);

/** The rig ids, for exhaustive selectors and session validation. */
export const CAD_LIGHT_RIG_IDS: readonly string[] = Object.freeze(
  CAD_LIGHT_RIGS.map((rig) => rig.id),
);

/** Reads a rig by id; an unknown id falls back to the studio default. */
export function lightRigById(id: string): CadLightRig {
  return CAD_LIGHT_RIGS.find((rig) => rig.id === id) ?? CAD_LIGHT_RIG_STUDIO;
}
