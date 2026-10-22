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
  AlignHorizontalDistributeCenter,
  AlignHorizontalJustifyCenter,
  AlignVerticalDistributeCenter,
  Angle,
  ArrowLeftRight,
  ArrowUpDown,
  ArrowUpFromLine,
  Axis3d,
  Blend,
  Bolt,
  Box,
  Circle,
  CircleDotDashed,
  Columns3,
  Combine,
  Command,
  Cone,
  Copy,
  CornerDownRight,
  Crosshair,
  Diameter,
  Disc3,
  Dot,
  Download,
  Drill,
  Egg,
  Equal,
  FileInput,
  FlipHorizontal2,
  Grid2x2,
  Group,
  Hexagon,
  Layers,
  LocateFixed,
  Merge,
  Minus,
  MousePointer2,
  Move,
  Move3d,
  MoveHorizontal,
  MoveRight,
  MoveVertical,
  Orbit,
  PencilLine,
  Radius,
  RectangleHorizontal,
  Redo2,
  Replace,
  Rotate3d,
  Route,
  Rows2,
  Ruler,
  Save,
  Scaling,
  Scissors,
  Shapes,
  Shell,
  Sheet,
  Slash,
  Slice,
  Spline,
  Spool,
  Square,
  SquareDashed,
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

/**
 * Every tool the SKETCH strip can arm — the thirty-six ids of
 * `CAD_SKETCH_TOOLBAR_LABELS`, as a literal union so the mark record below
 * cannot miss one.
 */
export type CadSketchToolId =
  // draw
  | "select"
  | "line"
  | "circle"
  | "rectangle"
  | "ellipse"
  | "slot"
  | "trim"
  | "construction"
  | "spline"
  | "polygon"
  // modify
  | "offset"
  | "mirror"
  | "extend"
  | "rectArray"
  | "circArray"
  | "convert"
  | "point"
  // constrain
  | "coincident"
  | "horizontal"
  | "vertical"
  | "pointOnEntity"
  | "pointOnTangent"
  | "collinear"
  | "horizontalPair"
  | "verticalPair"
  | "parallel"
  | "perpendicular"
  | "equal"
  | "midpoint"
  | "tangent"
  // dimension
  | "distance"
  | "distanceX"
  | "distanceY"
  | "radius"
  | "diameter"
  | "angle";

/**
 * The sketch tools' marks. The labels are the strings
 * `CAD_SKETCH_TOOLBAR_LABELS` printed as button text before the strip
 * became icons — they moved to `aria-label` and not one of them changed,
 * so the accessible name of every sketch tool is what it always was. The
 * label record stays the toolbar's own source of prose (it also carries
 * the per-tool tooltip, which is contextual and therefore not here).
 */
export const CAD_SKETCH_TOOL_ICONS: Readonly<
  Record<CadSketchToolId, CadToolIcon>
> = Object.freeze({
  select: { icon: MousePointer2, label: "Select" },
  line: { icon: Slash, label: "Line" },
  circle: { icon: Circle, label: "Circle" },
  rectangle: { icon: Square, label: "Rectangle" },
  ellipse: { icon: Egg, label: "Ellipse" },
  slot: { icon: RectangleHorizontal, label: "Slot" },
  trim: { icon: Scissors, label: "Trim" },
  construction: { icon: SquareDashed, label: "Construction" },
  spline: { icon: Spline, label: "Spline" },
  polygon: { icon: Hexagon, label: "Polygon" },
  offset: { icon: Blend, label: "Offset" },
  mirror: { icon: FlipHorizontal2, label: "Mirror" },
  extend: { icon: MoveRight, label: "Extend" },
  rectArray: { icon: Grid2x2, label: "Rect Array" },
  circArray: { icon: CircleDotDashed, label: "Circ Array" },
  convert: { icon: Replace, label: "Convert" },
  point: { icon: Dot, label: "Point" },
  coincident: { icon: Merge, label: "Coincident" },
  horizontal: { icon: MoveHorizontal, label: "Horizontal" },
  vertical: { icon: MoveVertical, label: "Vertical" },
  pointOnEntity: { icon: Crosshair, label: "Point On" },
  pointOnTangent: { icon: LocateFixed, label: "On Tangent" },
  collinear: { icon: Minus, label: "Collinear" },
  horizontalPair: { icon: AlignHorizontalDistributeCenter, label: "H Align" },
  verticalPair: { icon: AlignVerticalDistributeCenter, label: "V Align" },
  parallel: { icon: Rows2, label: "Parallel" },
  perpendicular: { icon: CornerDownRight, label: "Perpendicular" },
  equal: { icon: Equal, label: "Equal" },
  midpoint: { icon: AlignHorizontalJustifyCenter, label: "Midpoint" },
  tangent: { icon: Orbit, label: "Tangent" },
  distance: { icon: Ruler, label: "Distance" },
  distanceX: { icon: ArrowLeftRight, label: "Dist X" },
  distanceY: { icon: ArrowUpDown, label: "Dist Y" },
  radius: { icon: Radius, label: "Radius" },
  diameter: { icon: Diameter, label: "Diameter" },
  angle: { icon: Angle, label: "Angle" },
});

/** The mark an unknown tool id gets: a shape, never a blank button. */
export const CAD_TOOL_ICON_FALLBACK: LucideIcon = Shapes;

/**
 * The sketch strip's non-tool verbs: leaving the sketch for the model,
 * the two commits that turn a profile into a solid, the standalone save,
 * and the sketch-exchange entry. They are commands, not tools — nothing
 * here is ever `aria-pressed` — but they share the strip and therefore
 * the strip's dialect.
 */
export type CadSketchCommandId =
  "exitSketch" | "extrude" | "revolve" | "saveSketch" | "importSketch";

/** The sketch commands' marks and names. */
export const CAD_SKETCH_COMMAND_ICONS: Readonly<
  Record<CadSketchCommandId, CadToolIcon>
> = Object.freeze({
  exitSketch: { icon: Box, label: "Model" },
  extrude: { icon: ArrowUpFromLine, label: "Extrude" },
  revolve: { icon: Disc3, label: "Revolve" },
  saveSketch: { icon: Save, label: "Save" },
  importSketch: { icon: FileInput, label: "Import DXF or SVG" },
});

/** Whether a tool id is one the sketch mark record knows. */
export function isCadSketchToolId(toolId: string): toolId is CadSketchToolId {
  return Object.hasOwn(CAD_SKETCH_TOOL_ICONS, toolId);
}

/** A run of sketch tools that share one strip slot behind a flyout. */
export interface CadSketchToolFamily {
  /** Stable family id (`data-tool-family` rides the label, not this). */
  readonly id: string;
  /** The family's name — the chevron's accessible name and the menu's. */
  readonly label: string;
  /**
   * The members, in MENU order. The first member present in the rendered
   * cluster is the family's default face.
   */
  readonly memberIds: readonly CadSketchToolId[];
}

/**
 * The sketch strip's families — the mechanism that turns thirty-six tools
 * into fourteen slots.
 *
 * Only the long TAILS fold: the drawing vocabulary stays one mark per
 * tool, because a sketch is drawn with those ten and an operator reaches
 * for them continuously. What folds is everything that is chosen once per
 * constraint — the four coincidence kinds, the four orientation kinds, the
 * five relation kinds, the six dimension kinds, the two arrays and the
 * three entity transforms. A family is one slot at EVERY width; nothing is
 * hidden by the viewport.
 *
 * A tool absent from every family renders as its own strip button, so a
 * host cluster carrying ids this file has never heard of still renders a
 * usable control for each.
 */
export const CAD_SKETCH_TOOL_FAMILIES: readonly CadSketchToolFamily[] =
  Object.freeze([
    {
      id: "transform",
      label: "Transform",
      memberIds: Object.freeze(["offset", "extend", "mirror"]),
    },
    {
      id: "array",
      label: "Array",
      memberIds: Object.freeze(["rectArray", "circArray"]),
    },
    {
      id: "coincidence",
      label: "Coincidence",
      memberIds: Object.freeze([
        "coincident",
        "pointOnEntity",
        "pointOnTangent",
        "midpoint",
      ]),
    },
    {
      id: "orientation",
      label: "Orientation",
      memberIds: Object.freeze([
        "horizontal",
        "vertical",
        "horizontalPair",
        "verticalPair",
      ]),
    },
    {
      id: "relation",
      label: "Relation",
      memberIds: Object.freeze([
        "parallel",
        "perpendicular",
        "collinear",
        "tangent",
        "equal",
      ]),
    },
    {
      id: "dimension",
      label: "Dimension",
      memberIds: Object.freeze([
        "distance",
        "distanceX",
        "distanceY",
        "radius",
        "diameter",
        "angle",
      ]),
    },
  ] satisfies readonly CadSketchToolFamily[]);

/** The family a sketch tool belongs to, or `undefined` for a lone tool. */
export function cadSketchToolFamilyOf(
  toolId: string,
): CadSketchToolFamily | undefined {
  return CAD_SKETCH_TOOL_FAMILIES.find((family) =>
    family.memberIds.some((member) => member === toolId),
  );
}
