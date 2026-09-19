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
    rectangle: {
      label: "Rectangle",
      tooltip: "Draw a rectangle: click two opposite corners",
    },
    trim: {
      label: "Trim",
      tooltip: "Trim a line to its nearest intersection: click the end to move",
    },
    construction: {
      label: "Construction",
      tooltip: "Toggle construction geometry on the selected entities",
    },
    coincident: { label: "Coincident", tooltip: "Make two points coincide" },
    horizontal: { label: "Horizontal", tooltip: "Make a line horizontal" },
    vertical: { label: "Vertical", tooltip: "Make a line vertical" },
    parallel: { label: "Parallel", tooltip: "Make two lines parallel" },
    perpendicular: {
      label: "Perpendicular",
      tooltip: "Make two lines perpendicular",
    },
    equal: { label: "Equal", tooltip: "Equal lengths or equal radii" },
    midpoint: {
      label: "Midpoint",
      tooltip: "Pin a point to a line's midpoint",
    },
    tangent: {
      label: "Tangent",
      tooltip: "Tangency between lines and circles/arcs",
    },
    distance: {
      label: "Distance",
      tooltip: "Dimension the distance between two points",
    },
    radius: { label: "Radius", tooltip: "Dimension a circle or arc radius" },
    diameter: {
      label: "Diameter",
      tooltip: "Dimension a circle or arc diameter",
    },
    angle: { label: "Angle", tooltip: "Dimension the angle between two lines" },
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

/** Digit shortcuts cover the first nine tools across all groups; beyond, none. */
const SHORTCUT_DIGIT_COUNT = 9;

/** The digit shortcut of the tool at `index`, or `null` beyond the ninth. */
function shortcutForIndex(index: number): string | null {
  return index < SHORTCUT_DIGIT_COUNT ? String(index + 1) : null;
}

/** The tool id a digit key activates, or `null` when the key maps to none. */
function shortcutToolId(
  key: string,
  toolIds: readonly string[],
): string | null {
  if (!/^[1-9]$/.test(key)) return null;
  const index = Number(key) - 1;
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
