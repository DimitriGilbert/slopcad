/**
 * `CadSketchToolbar` (Phase 25): the shadcn-side sketch tool strip — labeled
 * clusters of tool buttons (drawing tools, then constraint tools) driving a
 * host-owned sketch editor through one activation callback. Pure display and
 * event passthrough, built on the existing `Button` primitive — no new
 * primitives, no tool state of its own: the active tool is a prop
 * (`activeToolId`), activation is a prop (`onActivate`), and a tool id
 * missing from the labels map falls back to the raw id — an identifier, not
 * prose, and the documented extension point for custom tools.
 *
 * ## Layout
 *
 * One dense strip of labeled clusters: each group renders a quiet uppercase
 * micro-label and its buttons behind a shared divider, so a sketch toolbar's
 * two vocabularies (drawing vs. constraining) read as two vocabularies
 * instead of one undifferentiated row. `groups` is data: a host can render
 * one cluster or many, in any order.
 *
 * ## Keyboard
 *
 * The shortcut row is positional and documented: the first ten tools across
 * all groups sit on the digit keys `1`–`9` and `0`, and the next ten on the
 * letters `q w e r t y u i o p` (Phase 37's added entity-op tools included).
 * Tools beyond the twentieth get no shortcut — the buttons themselves remain
 * tab-reachable. All shortcuts are handled on the strip container so they
 * work from any focus inside it — the same single `activate` path a click
 * takes; keyboard activation is never a parallel mechanism. Modified digit
 * or letter presses (ctrl/meta/alt) are ignored, and Enter/Space activate
 * the focused button natively. Each button shows its key as a small key cap
 * (aria-hidden — the accessible name is the tool label).
 *
 * ## Disabled discipline
 *
 * `disabledToolIds` renders a button disabled — an inert tool never pretends
 * to activate (the toolbar's documented inert discipline). The strip itself
 * is inert (buttons disabled) when mounted with no `onActivate`: it never
 * pretends to activate anything.
 *
 * All user-facing strings live in {@link CAD_SKETCH_TOOLBAR_LABELS}
 * (overridable via the `labels` prop).
 */

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { cn } from "cn";

import { Button } from "../button";

/** The user-facing strings of one tool's button. */
export interface CadSketchToolLabels {
  /** The button's visible text and accessible name. */
  readonly label: string;
  /** The button's `title` — what activating the tool does. */
  readonly tooltip: string;
}

/** One labeled cluster of tools. */
export interface CadSketchToolbarGroup {
  /** Stable group id (`data-sketch-group-id`). */
  readonly id: string;
  /** The cluster's micro-label (e.g. "Tools", "Constraints"). */
  readonly label: string;
  /** The tool ids in the cluster, in render and shortcut order. */
  readonly toolIds: readonly string[];
}

/** The user-facing strings of {@link CadSketchToolbar}. Overridable via props. */
export interface CadSketchToolbarLabels {
  /** Accessible name of the toolbar group. */
  readonly toolbarLabel: string;
  /** Per-tool labels keyed by tool id. */
  readonly tools: Readonly<Record<string, CadSketchToolLabels>>;
}

/**
 * Documented label defaults for the Phase 25 sketch tool set; every
 * render-output string lives here. Constraint tools carry the constraint
 * kind's name — the same vocabulary the sketch domain uses.
 */
export const CAD_SKETCH_TOOLBAR_LABELS: CadSketchToolbarLabels = {
  toolbarLabel: "Sketch tools",
  tools: {
    select: { label: "Select", tooltip: "Select sketch entities" },
    line: {
      label: "Line",
      tooltip: "Draw a line: click the start, then the end",
    },
    circle: {
      label: "Circle",
      tooltip: "Draw a circle: click the center, then the radius",
    },
    point: {
      label: "Point",
      tooltip: "Place a point entity: one click (hole positions, picks)",
    },
    rectangle: {
      label: "Rectangle",
      tooltip: "Draw a rectangle: click two opposite corners",
    },
    ellipse: {
      label: "Ellipse",
      tooltip:
        "Draw an ellipse: click the center, the axis end, then the other extent",
    },
    slot: {
      label: "Slot",
      tooltip: "Draw a straight slot: click both cap centers, then the radius",
    },
    trim: {
      label: "Trim",
      tooltip: "Trim a line to its nearest intersection: click the end to move",
    },
    construction: {
      label: "Construction",
      tooltip: "Toggle construction geometry on the selected entities",
    },
    spline: {
      label: "Spline",
      tooltip:
        "Draw a spline: click four control points (one cubic Bézier segment)",
    },
    polygon: {
      label: "Polygon",
      tooltip:
        "Draw a hexagon: click the center, then the first vertex (sets size and rotation)",
    },
    offset: {
      label: "Offset",
      tooltip:
        "Offset an entity or chain: click the source, then a point on the offset side",
    },
    mirror: {
      label: "Mirror",
      tooltip:
        "Mirror about a line: click the axis line, then entities to mirror",
    },
    extend: {
      label: "Extend",
      tooltip:
        "Extend a line: click near the end to grow it to the nearest boundary",
    },
    rectArray: {
      label: "Rect Array",
      tooltip:
        "Rectangular array: select entities, set counts and spacings in the inspector, apply",
    },
    circArray: {
      label: "Circ Array",
      tooltip:
        "Circular array: select entities, set count, step, and center in the inspector, apply",
    },
    convert: {
      label: "Convert",
      tooltip:
        "Convert model geometry: pick vertices from the topology list in the inspector",
    },
    coincident: { label: "Coincident", tooltip: "Make two points coincide" },
    horizontal: { label: "Horizontal", tooltip: "Make a line horizontal" },
    vertical: { label: "Vertical", tooltip: "Make a line vertical" },
    pointOnEntity: {
      label: "Point On",
      tooltip:
        "Pin a point onto a curve: click the point entity, then the curve (line, circle/arc, ellipse, spline, polygon, slot)",
    },
    pointOnTangent: {
      label: "On Tangent",
      tooltip:
        "Pin a point onto a spline's end-tangent line: click the point, then the spline end",
    },
    collinear: {
      label: "Collinear",
      tooltip: "Make two lines lie on one infinite line",
    },
    horizontalPair: {
      label: "H Align",
      tooltip: "Make two points share their y",
    },
    verticalPair: {
      label: "V Align",
      tooltip: "Make two points share their x",
    },
    parallel: {
      label: "Parallel",
      tooltip:
        "Make two lines parallel, or a line parallel to a spline's end tangent",
    },
    perpendicular: {
      label: "Perpendicular",
      tooltip:
        "Make two lines perpendicular, or a line perpendicular to a spline's end tangent",
    },
    equal: {
      label: "Equal",
      tooltip: "Equal lengths, radii, or spline endpoint chords",
    },
    midpoint: {
      label: "Midpoint",
      tooltip: "Pin a point to a line's midpoint",
    },
    tangent: {
      label: "Tangent",
      tooltip:
        "Tangency between lines and circles/arcs, a line and a spline, or a G1 joint between two splines",
    },
    distance: {
      label: "Distance",
      tooltip: "Dimension the distance between two points",
    },
    distanceX: {
      label: "Dist X",
      tooltip: "Dimension the signed x separation between two points",
    },
    distanceY: {
      label: "Dist Y",
      tooltip: "Dimension the signed y separation between two points",
    },
    radius: { label: "Radius", tooltip: "Dimension a circle or arc radius" },
    diameter: {
      label: "Diameter",
      tooltip: "Dimension a circle or arc diameter",
    },
    angle: {
      label: "Angle",
      tooltip:
        "Dimension the angle between two lines, or a line and a spline's end tangent",
    },
  },
};

/** Props of {@link CadSketchToolbar}. */
export interface CadSketchToolbarProps {
  /** The labeled clusters to render, in order. */
  readonly groups: readonly CadSketchToolbarGroup[];
  /** The active tool id, or `null` for none. */
  readonly activeToolId: string | null;
  /**
   * The activation surface. Without it the strip is inert: every button
   * renders disabled.
   */
  readonly onActivate?: (toolId: string) => void;
  /** Tool ids rendered disabled (inert, unactivatable). */
  readonly disabledToolIds?: readonly string[];
  /** Label token overrides, merged over {@link CAD_SKETCH_TOOLBAR_LABELS}. */
  readonly labels?: Partial<CadSketchToolbarLabels>;
  /** Extends the container classes. */
  readonly className?: string;
}

/** Digit shortcuts cover the first ten tools; letters cover the next ten. */
const SHORTCUT_KEYS = [
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "0",
  "q",
  "w",
  "e",
  "r",
  "t",
  "y",
  "u",
  "i",
  "o",
  "p",
] as const;

/** The key shortcut of the tool at `index`, or `null` beyond the table. */
function shortcutForIndex(index: number): string | null {
  return SHORTCUT_KEYS[index] ?? null;
}

/** The tool id a key activates, or `null` when the key maps to none. */
function shortcutToolId(
  key: string,
  toolIds: readonly string[],
): string | null {
  const index = SHORTCUT_KEYS.indexOf(key as (typeof SHORTCUT_KEYS)[number]);
  if (index < 0) return null;
  return toolIds[index] ?? null;
}

/**
 * The sketch tool strip: labeled clusters of activation buttons, the active
 * tool pressed, digit-key activation, per-tool descriptions.
 */
export function CadSketchToolbar({
  activeToolId,
  className,
  disabledToolIds = [],
  groups,
  labels: labelOverrides,
  onActivate,
}: CadSketchToolbarProps) {
  const labels: CadSketchToolbarLabels = {
    ...CAD_SKETCH_TOOLBAR_LABELS,
    ...labelOverrides,
  };
  const disabled = new Set(disabledToolIds);

  const flatToolIds = groups.flatMap((group) => group.toolIds);

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (onActivate === undefined) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const toolId = shortcutToolId(event.key, flatToolIds);
    if (toolId === null || disabled.has(toolId)) return;
    event.preventDefault();
    onActivate(toolId);
  };

  return (
    <div
      aria-label={labels.toolbarLabel}
      className={cn(
        "border-border bg-background flex items-stretch gap-3 border p-1",
        className,
      )}
      data-slot="cad-sketch-toolbar"
      onKeyDown={handleKeyDown}
      role="group"
    >
      {groups.map((group, groupIndex) => (
        <div
          key={group.id}
          aria-label={group.label}
          className={cn(
            "flex flex-col gap-0.5",
            groupIndex > 0 && "border-border border-l pl-3",
          )}
          data-sketch-group-id={group.id}
          role="group"
        >
          <span className="text-muted-foreground px-1 text-[10px] font-medium tracking-wider uppercase">
            {group.label}
          </span>
          <div className="flex flex-wrap items-center gap-1">
            {group.toolIds.map((toolId) => {
              const globalIndex = flatToolIds.indexOf(toolId);
              const active = toolId === activeToolId;
              const toolLabels = labels.tools[toolId] ?? {
                label: toolId,
                tooltip: toolId,
              };
              const shortcut = shortcutForIndex(globalIndex);
              return (
                <Button
                  key={toolId}
                  aria-keyshortcuts={shortcut ?? undefined}
                  aria-pressed={active}
                  data-active={active || undefined}
                  data-sketch-tool-id={toolId}
                  disabled={onActivate === undefined || disabled.has(toolId)}
                  onClick={
                    onActivate === undefined
                      ? undefined
                      : () => {
                          onActivate(toolId);
                        }
                  }
                  size="xs"
                  title={toolLabels.tooltip}
                  variant={active ? "default" : "outline"}
                >
                  {toolLabels.label}
                  {shortcut !== null ? (
                    <kbd
                      aria-hidden="true"
                      className="border-current/40 ml-1 border px-1 font-mono text-[10px] leading-3 font-normal"
                    >
                      {shortcut}
                    </kbd>
                  ) : null}
                </Button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
