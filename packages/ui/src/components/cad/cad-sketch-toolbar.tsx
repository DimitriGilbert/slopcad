/**
 * `CadSketchToolbar` — the SKETCH mode's tool strip, in the cockpit's one
 * tool dialect.
 *
 * ## What this replaces
 *
 * Thirty-six text-label `Button`s in `border-border bg-background` rows
 * that WRAPPED: three clusters of words, each word ~70–110px, stacked two
 * and three lines deep inside the sketch command row. It was the loudest
 * remaining surface in the product and the reason the redesign pass
 * exists — a sketch editor whose toolbar read as a paragraph of verbs
 * while the model mode's strip had already become marks.
 *
 * It is now icon-first, on the cockpit primitives: `ToolGroup` clusters of
 * icon-only `ToolButton`s, and `ToolFlyout` for the FAMILIES — the
 * coincidence, orientation and relation constraint kinds, the dimension
 * kinds, the arrays and the entity transforms. There is NO visible tool
 * label anywhere in this file: the `aria-label` carries the name the text
 * printed, the `title` carries what the tool does, and the key cap carries
 * the shortcut. Nothing is hidden by viewport width — a family is one slot
 * at every width.
 *
 * ## The contract this keeps, exactly
 *
 * `groups` is still host DATA (ordered clusters of tool ids), the active
 * tool is still a prop, activation is still the single `onActivate` path,
 * `disabledToolIds` still renders a tool inert, and `labels` still
 * overrides every string. The container is still ONE named
 * `role="group"` ("Sketch tools" by default) — a cluster of a strip, not
 * a second nested `role="toolbar"`.
 *
 * Every tool keeps `data-sketch-tool-id` — on a lone button, on a
 * family's face, and on each member inside a family's menu (see
 * `ToolFlyout`'s `itemAttribute`), so the machine handle survives the
 * fold. A tool id the icon record has never heard of renders with the
 * fallback mark and the raw id as its accessible name: an identifier, not
 * prose, and the documented extension point for custom tools.
 *
 * ## Keyboard
 *
 * The shortcut row is positional and unchanged: the first ten tools
 * across all groups sit on `1`–`9`,`0`, the next ten on `q w e r t y u i
 * o p`, counted over the FLAT order of `groups` — folding tools into
 * families changes not one assignment, because the fold is a rendering
 * decision and the order is the host's. Shortcuts are handled on the
 * strip container so they work from any focus inside it, through the same
 * single `activate` path a click takes. Modified presses (ctrl/meta/alt)
 * are ignored; Enter/Space activate the focused control natively.
 *
 * ## Arming a family member
 *
 * A family's face FOLLOWS the armed tool: arm `radius` from the dimension
 * menu and the dimension slot shows the radius mark, pressed. That is why
 * `aria-pressed` is still true for exactly the armed tool, and why the
 * armed tool is always visible on the strip without opening anything.
 *
 * All user-facing strings live in {@link CAD_SKETCH_TOOLBAR_LABELS}
 * (overridable via the `labels` prop).
 */

import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from "react";
import { cn } from "cn";
import type { ToolFlyoutItem } from "../cockpit/tool-flyout";

import { KeyCap, ToolButton, ToolGroup } from "../cockpit/tool-button";
import { ToolFlyout } from "../cockpit/tool-flyout";
import {
  CAD_SKETCH_TOOL_ICONS,
  CAD_TOOL_ICON_FALLBACK,
  cadSketchToolFamilyOf,
  isCadSketchToolId,
  type CadSketchToolFamily,
} from "./cad-tool-icons";

/** The user-facing strings of one tool's button. */
export interface CadSketchToolLabels {
  /** The tool's accessible name (the string the button used to print). */
  readonly label: string;
  /** The button's `title` — what activating the tool does. */
  readonly tooltip: string;
}

/** One labeled cluster of tools. */
export interface CadSketchToolbarGroup {
  /** Stable group id (`data-sketch-group-id`). */
  readonly id: string;
  /** The cluster's name (e.g. "Draw", "Constrain") — its accessible name. */
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
 * Documented label defaults for the sketch tool set; every render-output
 * string lives here. Constraint tools carry the constraint kind's name —
 * the same vocabulary the sketch domain uses.
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
   * The activation surface. Without it the strip is inert: every control
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
 * One cluster slot: either a lone tool, or a family rendered once at the
 * position of its first member in that cluster. A family present in two
 * clusters (a host's choice) renders once in each, with that cluster's
 * members only — the fold never moves a tool between clusters.
 */
type ClusterSlot =
  | { readonly kind: "tool"; readonly toolId: string }
  | {
      readonly kind: "family";
      readonly family: CadSketchToolFamily;
      readonly toolIds: readonly string[];
    };

/** The cluster's slots, in render order (the host's tool order). */
export function sketchClusterSlots(
  toolIds: readonly string[],
): readonly ClusterSlot[] {
  const slots: ClusterSlot[] = [];
  const familyIndexById = new Map<string, number>();
  for (const toolId of toolIds) {
    const family = cadSketchToolFamilyOf(toolId);
    if (family === undefined) {
      slots.push({ kind: "tool", toolId });
      continue;
    }
    const existing = familyIndexById.get(family.id);
    if (existing === undefined) {
      familyIndexById.set(family.id, slots.length);
      slots.push({ family, kind: "family", toolIds: [toolId] });
      continue;
    }
    const slot = slots[existing];
    if (slot === undefined || slot.kind !== "family") continue;
    slots[existing] = {
      family: slot.family,
      kind: "family",
      toolIds: [...slot.toolIds, toolId],
    };
  }
  // A family's members render in the FAMILY's documented menu order, not
  // in the order the host happened to list them.
  return slots.map((slot) =>
    slot.kind === "tool"
      ? slot
      : {
          family: slot.family,
          kind: "family",
          toolIds: slot.family.memberIds.filter((member) =>
            slot.toolIds.includes(member),
          ),
        },
  );
}

/**
 * The sketch tool strip: icon clusters of activation controls, families
 * behind flyouts, the active tool pressed, positional key activation.
 */
export function CadSketchToolbar({
  activeToolId,
  className,
  disabledToolIds = [],
  groups,
  labels: labelOverrides,
  onActivate,
}: CadSketchToolbarProps): ReactElement {
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

  /** Everything one tool renders with, whatever slot shape hosts it. */
  const describe = (
    toolId: string,
  ): {
    readonly label: string;
    readonly tooltip: string;
    readonly icon: ToolFlyoutItem["icon"];
    readonly shortcut: string | null;
    readonly inert: boolean;
  } => {
    const toolLabels = labels.tools[toolId] ?? {
      label: toolId,
      tooltip: toolId,
    };
    return {
      icon: isCadSketchToolId(toolId)
        ? CAD_SKETCH_TOOL_ICONS[toolId].icon
        : CAD_TOOL_ICON_FALLBACK,
      inert: onActivate === undefined || disabled.has(toolId),
      label: toolLabels.label,
      shortcut: shortcutForIndex(flatToolIds.indexOf(toolId)),
      tooltip: toolLabels.tooltip,
    };
  };

  const activate = (toolId: string): void => {
    onActivate?.(toolId);
  };

  return (
    <div
      aria-label={labels.toolbarLabel}
      className={cn("flex min-w-0 items-center gap-(--gap)", className)}
      data-slot="cad-sketch-toolbar"
      onKeyDown={handleKeyDown}
      role="group"
    >
      {groups.map((group) => (
        <ToolGroup
          data-sketch-group-id={group.id}
          key={group.id}
          label={group.label}
        >
          {sketchClusterSlots(group.toolIds).map((slot) => {
            if (slot.kind === "tool") {
              const tool = describe(slot.toolId);
              const active = slot.toolId === activeToolId;
              return (
                <ToolButton
                  aria-keyshortcuts={tool.shortcut ?? undefined}
                  aria-label={tool.label}
                  aria-pressed={active}
                  data-active={active || undefined}
                  data-sketch-tool-id={slot.toolId}
                  disabled={tool.inert}
                  key={slot.toolId}
                  onClick={() => {
                    activate(slot.toolId);
                  }}
                  size="icon"
                  title={tool.tooltip}
                >
                  <tool.icon aria-hidden="true" />
                  {/* The binding, as a corner hint. The cap keeps its
                      primitive (and its aria-hidden contract — the
                      control publishes `aria-keyshortcuts`) but drops the
                      cap CHROME here: a bordered key cap beside a 28px
                      mark would be wider than the mark it annotates. */}
                  {tool.shortcut === null ? null : (
                    <KeyCap className="absolute right-0 bottom-0 h-auto min-w-0 rounded-none border-0 bg-transparent px-[2px] leading-none">
                      {tool.shortcut}
                    </KeyCap>
                  )}
                </ToolButton>
              );
            }
            const items = slot.toolIds.map((toolId): ToolFlyoutItem => {
              const tool = describe(toolId);
              return {
                description: tool.tooltip,
                disabled: tool.inert,
                icon: tool.icon,
                id: toolId,
                label: tool.label,
                onSelect: () => {
                  activate(toolId);
                },
                shortcut: tool.shortcut ?? undefined,
              };
            });
            // The face follows the ARMED tool, so the strip always shows
            // what is live without the operator opening the family.
            const armedHere = slot.toolIds.find(
              (toolId) => toolId === activeToolId,
            );
            return (
              <ToolFlyout
                facedId={armedHere}
                itemAttribute="data-sketch-tool-id"
                items={items}
                key={slot.family.id}
                label={slot.family.label}
                pressedId={activeToolId}
                triggerTestId={`sketch-family-${slot.family.id}`}
              />
            );
          })}
        </ToolGroup>
      ))}
    </div>
  );
}
