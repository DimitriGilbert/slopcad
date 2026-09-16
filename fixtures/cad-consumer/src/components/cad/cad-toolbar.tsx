import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  CadProviderError,
  useCadTools,
  type CadToolsApi,
} from "@slopcad/cad-react";
import { cn } from "cn";

import { Button } from "../button";

/** The user-facing strings of one tool's button. */
export interface CadToolbarToolLabels {
  /** The button's visible text and accessible name. */
  readonly label: string;
  /** The button's `title` — what activating the tool does. */
  readonly tooltip: string;
}

/** The user-facing strings of {@link CadToolbar}. Overridable via props. */
export interface CadToolbarLabels {
  /** Accessible name of the toolbar group. */
  readonly toolbarLabel: string;
  /** Per-tool labels keyed by tool id. */
  readonly tools: Readonly<Record<string, CadToolbarToolLabels>>;
}

/** Documented label defaults; every render-output string lives here. */
export const CAD_TOOLBAR_LABELS: CadToolbarLabels = {
  toolbarLabel: "CAD tools",
  tools: {
    select: { label: "Select", tooltip: "Select geometry" },
    measure: { label: "Measure", tooltip: "Measure a distance" },
    translate: { label: "Translate", tooltip: "Move a body by dragging" },
    rotate: { label: "Rotate", tooltip: "Rotate a body by dragging" },
  },
};

/** Props of {@link CadToolbar}. */
export interface CadToolbarProps {
  /** The tool ids to render; overrides the provider registry list. */
  readonly toolIds?: readonly string[];
  /** The active tool id, or `null` for none; overrides the mirrored value. */
  readonly activeToolId?: string | null;
  /**
   * The activation surface; overrides the provider `arm` (see the
   * precedence rule in the module doc).
   */
  readonly onActivate?: (toolId: string) => void;
  /** Label token overrides, merged over {@link CAD_TOOLBAR_LABELS}. */
  readonly labels?: Partial<CadToolbarLabels>;
  /** Extends the container classes. */
  readonly className?: string;
}

/** Digit shortcuts cover the first nine tools; beyond that, none. */
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
 * Reads the tools hook, mapping the structured "no provider" error to
 * `null` — the same optional-read discipline as the viewport's (the
 * structured error is thrown before any stateful hook, so removing a
 * provider above a mounted toolbar re-renders fewer hooks and fails loudly
 * in React, a programming error reported as one).
 */
function useOptionalCadTools(): CadToolsApi | null {
  try {
    return useCadTools();
  } catch (error) {
    if (error instanceof CadProviderError) return null;
    throw error;
  }
}

/**
 * The CAD toolbar: one activation button per registered tool, with the
 * live tool pressed, digit-key activation, and per-tool descriptions.
 */
export function CadToolbar({
  activeToolId: activeToolIdProp,
  className,
  labels: labelOverrides,
  onActivate,
  toolIds: toolIdsProp,
}: CadToolbarProps) {
  const labels: CadToolbarLabels = { ...CAD_TOOLBAR_LABELS, ...labelOverrides };
  const toolsApi = useOptionalCadTools();

  const toolIds = toolIdsProp ?? toolsApi?.toolIds ?? [];
  const pressedToolId =
    activeToolIdProp !== undefined
      ? activeToolIdProp
      : toolsApi !== null && toolsApi.phase === "active"
        ? toolsApi.activeToolId
        : null;
  const activate =
    onActivate ??
    (toolsApi === null ? undefined : (toolId: string) => toolsApi.arm(toolId));

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (activate === undefined) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const toolId = shortcutToolId(event.key, toolIds);
    if (toolId === null) return;
    event.preventDefault();
    activate(toolId);
  };

  return (
    <div
      aria-label={labels.toolbarLabel}
      className={cn(
        "border-border bg-background inline-flex items-center gap-1 border p-1",
        className,
      )}
      data-slot="cad-toolbar"
      role="group"
      onKeyDown={handleKeyDown}
    >
      {toolIds.map((toolId, index) => {
        const active = toolId === pressedToolId;
        const toolLabels = labels.tools[toolId] ?? {
          label: toolId,
          tooltip: toolId,
        };
        const shortcut = shortcutForIndex(index);
        return (
          <Button
            key={toolId}
            aria-keyshortcuts={shortcut ?? undefined}
            aria-pressed={active}
            data-active={active || undefined}
            data-tool-id={toolId}
            disabled={activate === undefined}
            onClick={
              activate === undefined
                ? undefined
                : () => {
                    activate(toolId);
                  }
            }
            size="sm"
            title={toolLabels.tooltip}
            variant={active ? "default" : "outline"}
          >
            {toolLabels.label}
            {shortcut !== null ? (
              <kbd
                aria-hidden="true"
                className="ml-1 border-current/40 border px-1 font-mono text-[10px] font-normal leading-4"
              >
                {shortcut}
              </kbd>
            ) : null}
          </Button>
        );
      })}
    </div>
  );
}
