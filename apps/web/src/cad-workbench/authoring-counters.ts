/**
 * The engine's authoring id-counter reseed (the review fix for the
 * `replaceSession` door): the create actions mint ids from per-mount
 * counters with the engine convention `<stem><occurrence>` — the first
 * occurrence's suffix is empty (`feat_extrude`), later ones append the
 * number (`feat_extrude2`). A whole-document adoption over a live engine
 * (`store.replaceSession` — the TSX import path, a document open) can
 * carry ids that already use those stems — the product's own TSX exporter
 * emits the document's literal ids as explicit props, so EVERY export
 * round-trip carries exactly `skd_extrude`/`param_extrude_depth`/
 * `body_extrude`/`feat_extrude`-style ids — and the next create action
 * would re-mint the same id. The atomic transaction layer refuses an
 * already-registered id, so the whole verb silently dies.
 *
 * {@link maxAuthoringOccurrencesOf} scans an adopted document's entity ids
 * for the engine-convention stems and reports, per counter, the highest
 * occurrence in use; the engine advances each counter past it before the
 * author continues. The scan is pure document data — no React, no scene.
 */

import type { CadDocument } from "@slopcad/cad-core";

/** The engine's per-mount authoring counters, by their verb. */
export type AuthoringCounterName =
  | "extrude"
  | "revolve"
  | "hole"
  | "structuredHole"
  | "sketch"
  | "sweep"
  | "loft"
  | "surface"
  | "helix"
  | "thread"
  | "rib"
  | "scale"
  | "thicken"
  | "split"
  | "pattern"
  | "patternPath"
  | "mirror"
  | "boolean"
  | "moveBody"
  | "duplicate"
  | "datum"
  | "curve";

/**
 * One counter's id vocabulary: the anchored shapes the verb's create
 * action mints, with ONE capture group carrying the occurrence digits
 * (empty = the first occurrence). The patterns cover the exact id forms
 * the engine's handlers build — including the embedded-role forms
 * (`param_pattern1_direction2`, `body_dup2_c3`, `param_loft_z1_0`,
 * `param_shole_tipAngle1`) — and nothing else: a near-miss like
 * `param_patternpath_count1` must not read as the pattern counter's stem.
 */
const AUTHORING_STEMS: readonly {
  readonly name: AuthoringCounterName;
  readonly pattern: RegExp;
}[] = [
  {
    name: "extrude",
    pattern:
      /^(?:skd_extrude|param_extrude_depth|param_extrude_taper|body_extrude|feat_extrude)(\d*)$/,
  },
  {
    name: "revolve",
    pattern:
      /^(?:skd_revolve|param_revolve_sweep|param_revolve_axis|body_revolve|feat_revolve)(\d*)$/,
  },
  {
    name: "hole",
    pattern:
      /^(?:param_hole_diameter|param_hole_depth|param_hole_x|param_hole_y|param_hole_axis|body_hole|feat_hole)(\d*)$/,
  },
  {
    name: "structuredHole",
    pattern: /^(?:param_shole_[a-z][a-zA-Z]*|body_shole|feat_shole)(\d*)$/,
  },
  { name: "sketch", pattern: /^skd_sketch(\d*)$/ },
  { name: "sweep", pattern: /^(?:body_sweep|feat_sweep)(\d*)$/ },
  {
    name: "loft",
    pattern: /^(?:body_loft|feat_loft|param_loft_z)(\d*)(?:_\d+)?$/,
  },
  {
    name: "surface",
    pattern:
      /^(?:body_surface(?:_(?:solid|knit|offset))?|feat_surface(?:_(?:trim|thicken|knit|offset))?|param_surface_(?:kind|umin|umax|vmin|vmax|keep|t|side|tol|dist))(\d*)$/,
  },
  {
    name: "helix",
    pattern:
      /^(?:body_helix|feat_helix|param_helix_(?:radius|pitch|turns|handedness|start|taper))(\d*)$/,
  },
  {
    name: "thread",
    pattern:
      /^(?:body_thread|feat_thread|param_thread_(?:major|pitch|length|mode|handedness|axis))(\d*)$/,
  },
  { name: "rib", pattern: /^(?:body_rib|feat_rib|param_rib_thickness)(\d*)$/ },
  { name: "scale", pattern: /^(?:body_scale|feat_scale|param_scale_factor)(\d*)$/ },
  {
    name: "thicken",
    pattern: /^(?:body_thicken|feat_thicken|param_thicken_thickness)(\d*)$/,
  },
  { name: "split", pattern: /^(?:body_split|feat_split|param_split_side)(\d*)$/ },
  {
    name: "pattern",
    pattern:
      /^(?:body_pattern|feat_pattern|param_pattern)(\d*)(?:_(?:direction|count|spacing|skip)\d+)?$/,
  },
  {
    name: "patternPath",
    pattern:
      /^(?:body_patternpath|feat_patternpath|param_patternpath_(?:count|spacing|orientation))(\d*)$/,
  },
  { name: "mirror", pattern: /^(?:body_mirror|feat_mirror|param_mirror_merge)(\d*)$/ },
  { name: "boolean", pattern: /^(?:body_boolean|feat_boolean)(\d*)$/ },
  {
    name: "moveBody",
    pattern:
      /^(?:body_moved|feat_move|param_move_(?:x|y|z|axis|angle))(\d*)$/,
  },
  {
    name: "duplicate",
    pattern:
      /^(?:feat_duplicate|param_duplicate_(?:dx|dy|dz|count|axis|angle)|body_dup)(\d*)(?:_c\d+)?$/,
  },
  { name: "datum", pattern: /^(?:dtm_face_plane|dtm_datum)(\d*)$/ },
  { name: "curve", pattern: /^crv_curve(\d*)$/ },
];

/** The scan result: per counter, the highest engine-convention occurrence. */
export type AuthoringCounterMaxima = Readonly<
  Record<AuthoringCounterName, number>
>;

/**
 * Scans the document's entity ids (features, sketches, parameters, bodies,
 * datums, curves) for the engine-convention stems and reports each
 * counter's maximum occurrence in use — 0 when the document carries none,
 * so the counters keep their fresh-mount behavior on a stem-free
 * document.
 */
export function maxAuthoringOccurrencesOf(
  document: CadDocument,
): AuthoringCounterMaxima {
  const ids: readonly string[] = [
    ...document.features.map((feature) => feature.id),
    ...document.sketches.map((sketch) => sketch.id),
    ...document.parameters.parameters.map((parameter) => parameter.id),
    ...document.bodies.map((body) => body.id),
    ...document.datums.map((datum) => datum.id),
    ...document.curves.map((curve) => curve.id),
  ];
  const maxima: Record<AuthoringCounterName, number> = {
    extrude: 0,
    revolve: 0,
    hole: 0,
    structuredHole: 0,
    sketch: 0,
    sweep: 0,
    loft: 0,
    surface: 0,
    helix: 0,
    thread: 0,
    rib: 0,
    scale: 0,
    thicken: 0,
    split: 0,
    pattern: 0,
    patternPath: 0,
    mirror: 0,
    boolean: 0,
    moveBody: 0,
    duplicate: 0,
    datum: 0,
    curve: 0,
  };
  for (const id of ids) {
    for (const stem of AUTHORING_STEMS) {
      const match = stem.pattern.exec(id);
      if (match === null) continue;
      const digits = match[1];
      if (digits === undefined) continue;
      const occurrence = digits === "" ? 1 : Number.parseInt(digits, 10);
      if (occurrence > maxima[stem.name]) {
        maxima[stem.name] = occurrence;
      }
    }
  }
  return maxima;
}
