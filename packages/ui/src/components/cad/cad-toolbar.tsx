/**
 * `CadToolbar` (Phase 15.2): the shadcn-side CAD tool strip — one button
 * per registered tool, mirroring the `tools` concern of `@slopcad/cad-react`
 * and driving tool activation through the store's `arm` operation (the
 * host's documented re-arm composition: cancel-if-active, reset, activate),
 * so switching tools works from any lifecycle phase and every change rides
 * a store notification. Built on the cockpit `ToolButton` / `KeyCap`
 * primitives — no new primitives, no tool state of its own.
 *
 * The armed appearance is the primitive's, not this file's: `aria-pressed`
 * is the armed truth, and `ToolButton` renders it as the system's one
 * sanctioned signal appearance on a control (a wash plus a 1px edge). The
 * strip used to paint the live tool as a filled `--accent` slab with its
 * own inset signal ring — a second, louder dialect of the same state, and
 * the single biggest amber in the cockpit.
 *
 * ## State: two documented input modes, props first
 *
 * - **Prop-driven** — pass `toolIds`, `activeToolId`, and `onActivate`; the
 *   component is a pure display and event passthrough with no provider
 *   required.
 * - **Provider-driven** — mount below a `<CadProvider store={...}>` and
 *   omit the props: the button list mirrors `useCadTools().toolIds`, and
 *   activation calls `useCadTools().arm`.
 *
 * **Precedence**: explicit props always win, per group. `toolIds` overrides
 * the registry list, `activeToolId` overrides the mirrored active id, and
 * `onActivate` overrides the store `arm` as the activation surface — the
 * groups are independent, so a host can, say, take over activation while
 * still mirroring the registry. In provider mode a button is pressed
 * exactly while its tool is LIVE (phase `active` and the active id
 * matches); a completed or cancelled activation un-presses every button —
 * the strip reflects live tools, not last-used ones. Prop-driven hosts own
 * that truth entirely: the `activeToolId` prop is compared as given.
 * Rendering without a provider and without `toolIds` renders the labeled,
 * buttonless group; `toolIds` WITHOUT any activation surface (no provider,
 * no `onActivate`) renders the buttons `disabled` — the strip is inert, it
 * never pretends to activate anything.
 *
 * ## Keyboard
 *
 * One activation path serves both input modes: clicking a button and its
 * keyboard equivalent both funnel into the single `activate` function,
 * which is either `onActivate` or the store `arm` — keyboard activation is
 * never a parallel mechanism. The documented activation keys are the digit
 * keys `1`–`9`, mapped to registry order (the Nth tool id); each button
 * shows its digit as a small key cap (aria-hidden — the accessible name is
 * the tool label), and tools beyond the ninth have no shortcut. Modified
 * digit presses (ctrl/meta/alt) are ignored, and Enter/Space activate the
 * focused button natively — the same click handler. The digit keys are
 * handled on the toolbar container, so they work from any focus inside it.
 *
 * ## Presentation: icons by default, labels on request
 *
 * `presentation="icons"` (the default) renders icon-only `ToolButton`s
 * from {@link CAD_MODEL_TOOL_ICONS}: the label moves from the button's
 * text content to its `aria-label`, so the accessible name is unchanged
 * and the strip stops spending ~70px per tool on a word the mark already
 * says. This is what the cockpit's tool strip mounts.
 *
 * `presentation="labels"` is the previous appearance verbatim — text
 * labels, visible key caps, and the `rounded-md border bg-card/60` pill —
 * kept for the pinned render fixtures, which are baselines and are not
 * redesigned. A tool id with no icon in the map always falls back to its
 * label, in either presentation: an unknown mark is never a blank button.
 *
 * The toolbar is ONE CLUSTER of a strip, not a strip: it stays a named
 * `role="group"` rather than becoming a second `role="toolbar"` nested
 * inside the strip's, which would be an accessibility regression.
 *
 * ## Tooltips
 *
 * Each button carries its description as a native `title` attribute. The
 * `Tooltip` primitive is deliberately NOT used here: rendered inside a
 * route tree it trips the host's server render (the base-ui trigger
 * composition requires the render-prop merge onto our `Button`, and that
 * path destabilizes TanStack Start's SSR pass with an invalid-hook error),
 * while a plain title stays a zero-cost, SSR-safe description. The
 * `tooltip` label string is the documented override point either way.
 *
 * All user-facing strings live in {@link CAD_TOOLBAR_LABELS} (overridable
 * via the `labels` prop); a tool id missing from the labels map falls back
 * to the raw id — an identifier, not prose, and the documented extension
 * point for custom tools.
 */

import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  CadProviderError,
  useCadTools,
  type CadToolsApi,
} from "@slopcad/cad-react";
import { cn } from "cn";

import { KeyCap, ToolButton, ToolGroup } from "../cockpit/tool-button";
import { CAD_MODEL_TOOL_ICONS, type CadModelToolId } from "./cad-tool-icons";

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
  /** Icon-only strip cluster (default) or the pinned text appearance. */
  readonly presentation?: CadToolbarPresentation;
  /** Extends the container classes. */
  readonly className?: string;
}

/** The toolbar's two documented appearances (see the module doc). */
export type CadToolbarPresentation = "icons" | "labels";

/** Digit shortcuts cover the first nine tools; beyond that, none. */
const SHORTCUT_DIGIT_COUNT = 9;

/** The digit shortcut of the tool at `index`, or `null` beyond the ninth. */
function shortcutForIndex(index: number): string | null {
  return index < SHORTCUT_DIGIT_COUNT ? String(index + 1) : null;
}

/** Whether a tool id is one of the four the icon map knows a mark for. */
function isModelToolId(toolId: string): toolId is CadModelToolId {
  return Object.hasOwn(CAD_MODEL_TOOL_ICONS, toolId);
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
  presentation = "icons",
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

  const icons = presentation === "icons";

  return (
    <ToolGroup
      className={cn(
        icons
          ? "gap-(--gap-tight)"
          : "border-border bg-card/60 inline-flex items-center gap-0.5 rounded-md border p-0.5",
        className,
      )}
      data-slot="cad-toolbar"
      label={labels.toolbarLabel}
      onKeyDown={handleKeyDown}
      separated={false}
    >
      {toolIds.map((toolId, index) => {
        const active = toolId === pressedToolId;
        const toolLabels = labels.tools[toolId] ?? {
          label: toolId,
          tooltip: toolId,
        };
        const shortcut = shortcutForIndex(index);
        // An icon exists only for the four registry tools; a host's custom
        // tool keeps its word rather than becoming a blank square.
        const Mark = isModelToolId(toolId)
          ? CAD_MODEL_TOOL_ICONS[toolId].icon
          : null;
        const iconOnly = icons && Mark !== null;
        return (
          <ToolButton
            key={toolId}
            aria-keyshortcuts={shortcut ?? undefined}
            aria-label={iconOnly ? toolLabels.label : undefined}
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
            size={iconOnly ? "icon" : "sm"}
            title={toolLabels.tooltip}
          >
            {iconOnly && Mark !== null ? (
              // The mark carries the tool; the label carries the name, in
              // aria-label, so the accessible name never changed.
              <Mark aria-hidden="true" />
            ) : (
              <>
                {toolLabels.label}
                {shortcut !== null ? <KeyCap>{shortcut}</KeyCap> : null}
              </>
            )}
          </ToolButton>
        );
      })}
    </ToolGroup>
  );
}
