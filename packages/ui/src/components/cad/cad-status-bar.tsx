/**
 * `CadStatusBar` (Phase 28): the shadcn-side CAD status bar — the settled
 * numbers the operator works against, in one dense mono strip. The
 * component mirrors the store's live concerns (the active tool and its
 * lifecycle phase, the selection count, the committed command count)
 * through the same optional-hooks read discipline as its siblings, and
 * renders the host's session-owned surfaces as labeled spans: a `status`
 * span, a `volume` span (with the canonical unit), and an `error` span —
 * the ids a worker session's surface writer updates in place, so the bar
 * composes with the established settle protocol without owning it. The
 * session writer owns the VALUES; the bar owns the layout.
 *
 * ## State: two documented input modes, props first
 *
 * - **Prop-driven** — pass `toolId`, `toolPhase`, `selectionCount`, and
 *   `commandCount`; the component is a pure display with no provider
 *   required. Per group, explicit props always win.
 * - **Provider-driven** — mount below a `<CadProvider store={...}>` and
 *   omit the props: tool/phase mirror `useCadTools()`, the selection count
 *   mirrors `useCadSelection().selected.length`, and the command count
 *   mirrors `store.commandLog.length`.
 *
 * Without a provider AND without overrides the mirrored fields render
 * nothing — the bar degrades to its host spans rather than pretending to
 * mirror a store it cannot see (the CAD components' documented inert
 * discipline).
 *
 * All user-facing strings live in {@link CAD_STATUS_BAR_LABELS}
 * (overridable via the `labels` prop); tool ids, phases, and error text
 * are domain data rendered verbatim.
 */

import type { ReactElement, ReactNode } from "react";
import {
  CadProviderError,
  useCadSelection,
  useCadStore,
  useCadTools,
} from "@slopcad/cad-react";
import { cn } from "cn";

/** The user-facing strings of {@link CadStatusBar}. Overridable via props. */
export interface CadStatusBarLabels {
  /** Label before the host's status span. */
  readonly status: string;
  /** Label before the host's volume span. */
  readonly volume: string;
  /** The unit rendered after the volume value. */
  readonly volumeUnit: string;
  /** Label before the mirrored tool readout. */
  readonly tool: string;
  /** Label before the mirrored selection count. */
  readonly selection: string;
  /** Label before the mirrored command count. */
  readonly commands: string;
}

/** Documented label defaults; every component-authored string lives here. */
export const CAD_STATUS_BAR_LABELS: CadStatusBarLabels = {
  status: "status",
  volume: "volume",
  volumeUnit: "mm³",
  tool: "tool",
  selection: "selection",
  commands: "commands",
};

/** The host surface spans the bar renders as labeled ids. */
export interface CadStatusBarSurfaceIds {
  /** Id of the span the host's session writer writes the status into. */
  readonly statusId?: string;
  /** Id of the span the host's session writer writes the volume into. */
  readonly volumeId?: string;
  /** Id of the span the host's session writer writes errors into. */
  readonly errorId?: string;
}

/** Props of {@link CadStatusBar}. */
export interface CadStatusBarProps {
  /** The host surface ids to render as labeled spans. */
  readonly surfaceIds?: CadStatusBarSurfaceIds;
  /** The active tool id, or `null`; overrides the mirrored value. */
  readonly toolId?: string | null;
  /** The tool lifecycle phase; overrides the mirrored value. */
  readonly toolPhase?: string;
  /** The selection count; overrides the mirrored value. */
  readonly selectionCount?: number;
  /** The committed command count; overrides the mirrored value. */
  readonly commandCount?: number;
  /** Label token overrides, merged over {@link CAD_STATUS_BAR_LABELS}. */
  readonly labels?: Partial<CadStatusBarLabels>;
  /** Extends the container classes. */
  readonly className?: string;
}

/**
 * Reads the tools hook, mapping the structured "no provider" error to
 * `null` — the same optional-read discipline as the viewport's, toolbar's,
 * tree's, and parameter panel's (the structured error is thrown before any
 * stateful hook, so removing a provider above a mounted bar re-renders
 * fewer hooks and fails loudly in React, a programming error reported as
 * one).
 */
function useOptionalCadTools(): ReturnType<typeof useCadTools> | null {
  try {
    return useCadTools();
  } catch (error) {
    if (error instanceof CadProviderError) return null;
    throw error;
  }
}

/** The selection-concern counterpart of {@link useOptionalCadTools}. */
function useOptionalCadSelection(): ReturnType<typeof useCadSelection> | null {
  try {
    return useCadSelection();
  } catch (error) {
    if (error instanceof CadProviderError) return null;
    throw error;
  }
}

/** The store counterpart of {@link useOptionalCadTools}. */
function useOptionalCadStore(): ReturnType<typeof useCadStore> | null {
  try {
    return useCadStore("CadStatusBar");
  } catch (error) {
    if (error instanceof CadProviderError) return null;
    throw error;
  }
}

/** One labeled field of the bar: label, space, value. */
function StatusField({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <span>
      {label} = {children}
    </span>
  );
}

/**
 * The CAD status bar: the mirrored tool, selection, and command counts,
 * plus the host's session-owned status/volume/error spans, in one
 * mountable component.
 */
export function CadStatusBar({
  commandCount: commandCountProp,
  labels: labelOverrides,
  selectionCount: selectionCountProp,
  surfaceIds,
  toolId: toolIdProp,
  toolPhase: toolPhaseProp,
  className,
}: CadStatusBarProps) {
  const labels: CadStatusBarLabels = {
    ...CAD_STATUS_BAR_LABELS,
    ...labelOverrides,
  };
  const toolsApi = useOptionalCadTools();
  const selectionApi = useOptionalCadSelection();
  const store = useOptionalCadStore();

  const toolId =
    toolIdProp !== undefined ? toolIdProp : (toolsApi?.activeToolId ?? null);
  const toolPhase =
    toolPhaseProp !== undefined ? toolPhaseProp : toolsApi?.phase;
  const selectionCount =
    selectionCountProp !== undefined
      ? selectionCountProp
      : selectionApi?.selected.length;
  const commandCount =
    commandCountProp !== undefined
      ? commandCountProp
      : store?.commandLog.length;

  return (
    <div
      className={cn(
        "border-border bg-background text-muted-foreground flex h-7 shrink-0 items-center gap-4 border-t px-3 font-mono text-xs",
        className,
      )}
      data-slot="cad-status-bar"
    >
      {surfaceIds?.statusId !== undefined ? (
        <StatusField label={labels.status}>
          <span data-testid="cad-status-bar-status" id={surfaceIds.statusId} />
        </StatusField>
      ) : null}
      {surfaceIds?.volumeId !== undefined ? (
        <StatusField label={labels.volume}>
          <span id={surfaceIds.volumeId} />
          {"\u00A0"}
          {labels.volumeUnit}
        </StatusField>
      ) : null}
      {toolPhase !== undefined ? (
        <StatusField label={labels.tool}>
          {`${toolId ?? "none"} (${toolPhase})`}
        </StatusField>
      ) : null}
      {selectionCount !== undefined ? (
        <StatusField label={labels.selection}>
          {String(selectionCount)}
        </StatusField>
      ) : null}
      {commandCount !== undefined ? (
        <StatusField label={labels.commands}>
          {String(commandCount)}
        </StatusField>
      ) : null}
      {surfaceIds?.errorId !== undefined ? (
        <span className="text-destructive" data-testid="cad-status-bar-error">
          <span id={surfaceIds.errorId} />
        </span>
      ) : null}
    </div>
  );
}
