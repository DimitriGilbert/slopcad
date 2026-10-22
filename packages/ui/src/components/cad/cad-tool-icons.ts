/**
 * The cockpit's tool ICONOGRAPHY — one frozen, exhaustive record mapping
 * every id the model strip can run to the mark that stands for it.
 *
 * Before this file the only tool metadata in the repo was `{label,
 * tooltip}` prose in `CAD_TOOLBAR_LABELS` / `CAD_SKETCH_TOOLBAR_LABELS`,
 * which is why the command row could only ever be a row of words. An icon
 * strip needs a mark per id, typed so a new verb cannot be added without
 * choosing one — the records below are keyed by literal-union ids, so a
 * missing entry is a type error, not a blank button.
 *
 * ## What lives here and what does not
 *
 * The record carries the two things that are the same wherever the verb
 * appears: its MARK and its NAME. It deliberately does NOT carry the
 * description, because a cockpit verb's description is contextual — "Cut
 * a hole into the latest extrusion" and "Sketch and extrude a profile
 * first; a hole cuts an existing solid" are the same verb in two document
 * states, and only the host knows which. Hosts pass the live description
 * as `title`.
 *
 * Shortcuts are likewise the host's: the model tools' digit shortcuts come
 * from registry ORDER (see `CadToolbar`), not from identity.
 */

import {
  Axis3d,
  Bolt,
  Box,
  Circle,
  Columns3,
  Combine,
  Command,
  Cone,
  Copy,
  Download,
  Drill,
  FlipHorizontal2,
  Grid2x2,
  Group,
  Layers,
  MousePointer2,
  Move,
  Move3d,
  PencilLine,
  Redo2,
  Rotate3d,
  Route,
  Ruler,
  Scaling,
  Scissors,
  Shell,
  Sheet,
  Slice,
  Spline,
  Spool,
  SquarePen,
  Undo2,
  Upload,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/** A tool's invariant presentation: the mark, and the name beside it. */
export interface CadToolIcon {
  /** The mark that stands for the tool at strip size. */
  readonly icon: LucideIcon;
  /** The tool's accessible name — the string an icon-only button carries. */
  readonly label: string;
}

/** The four registry tools the model mode arms. */
export type CadModelToolId = "select" | "measure" | "translate" | "rotate";

/**
 * Every verb the model strip can run: the four registry tools' siblings —
 * history, the palette, file exchange — plus the eighteen feature verbs
 * and the five sheet verbs that until now lived in the command menu only.
 */
export type CadModelCommandId =
  | "undo"
  | "redo"
  | "commands"
  | "import"
  | "export"
  | "sketch"
  | "sketchOnFace"
  | "sweep"
  | "loft"
  | "helix"
  | "thread"
  | "hole"
  | "holeSpec"
  | "draft"
  | "rib"
  | "scale"
  | "thicken"
  | "split"
  | "pattern"
  | "patternPath"
  | "mirror"
  | "boolean"
  | "moveBody"
  | "datum"
  | "surfaceCreate"
  | "surfaceTrim"
  | "surfaceThicken"
  | "surfaceKnit"
  | "surfaceOffset";

/**
 * The model tools' marks. The labels match `CAD_TOOLBAR_LABELS` exactly —
 * the toolbar's labels stay the one source of its PROSE, and these are
 * the same strings so an icon-only button's accessible name is unchanged
 * from the text button it replaced.
 */
export const CAD_MODEL_TOOL_ICONS: Readonly<
  Record<CadModelToolId, CadToolIcon>
> = Object.freeze({
  select: { icon: MousePointer2, label: "Select" },
  measure: { icon: Ruler, label: "Measure" },
  translate: { icon: Move3d, label: "Translate" },
  rotate: { icon: Rotate3d, label: "Rotate" },
});

/**
 * The model verbs' marks. Every label is the accessible name the text
 * button carried before the strip became icons — the strings moved from
 * the button's text content to its `aria-label`, and not one of them
 * changed.
 */
export const CAD_MODEL_COMMAND_ICONS: Readonly<
  Record<CadModelCommandId, CadToolIcon>
> = Object.freeze({
  undo: { icon: Undo2, label: "Undo" },
  redo: { icon: Redo2, label: "Redo" },
  commands: { icon: Command, label: "Commands" },
  import: { icon: Upload, label: "Import" },
  export: { icon: Download, label: "Export" },
  sketch: { icon: PencilLine, label: "Sketch" },
  sketchOnFace: { icon: SquarePen, label: "Sketch on face" },
  sweep: { icon: Spline, label: "Sweep" },
  loft: { icon: Layers, label: "Loft" },
  helix: { icon: Spool, label: "Helix" },
  thread: { icon: Bolt, label: "Thread" },
  hole: { icon: Circle, label: "Hole" },
  holeSpec: { icon: Drill, label: "Hole spec…" },
  draft: { icon: Cone, label: "Draft" },
  rib: { icon: Columns3, label: "Rib" },
  scale: { icon: Scaling, label: "Scale" },
  thicken: { icon: Shell, label: "Thicken" },
  split: { icon: Slice, label: "Split" },
  pattern: { icon: Grid2x2, label: "Pattern" },
  patternPath: { icon: Route, label: "Path pattern" },
  mirror: { icon: FlipHorizontal2, label: "Mirror" },
  boolean: { icon: Combine, label: "Boolean" },
  moveBody: { icon: Move, label: "Move" },
  datum: { icon: Axis3d, label: "Datum" },
  surfaceCreate: { icon: Sheet, label: "Sheet" },
  surfaceTrim: { icon: Scissors, label: "Trim surface" },
  surfaceThicken: { icon: Box, label: "Thicken surface" },
  surfaceKnit: { icon: Group, label: "Knit surfaces" },
  surfaceOffset: { icon: Copy, label: "Offset surface" },
});
