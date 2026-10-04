/**
 * The agent diagnostics chip (PLAN-AGENT-CHAT Phase 4.3, D9): the chat's
 * rendering of a structured tool refusal `{ code, message, location? }` in
 * the SAME visual language the workbench's existing diagnostic chips speak —
 * the feature timeline's severity-colored `rounded-sm border px-* text-xs`
 * chips (timeline `failed`/`stale` presentation), with the code in mono ink
 * and the location as a selectable id chip when the caller wires selection.
 *
 * Severity comes from the CALLER (the refusal payload itself carries no
 * severity field; the tool-result renderer derives it — error-state refusals
 * are errors, user-cancelled/denied outcomes render quiet). The mapping is
 * the repo's token vocabulary: `destructive` for error/fatal, `signal` for
 * warning, muted card for info.
 */

import type { ReactElement } from "react";
import type { DiagnosticSeverity } from "@slopcad/cad-core";
import type { AgentToolRefusalLocation } from "../../tools";

/** The chip's severity presentation, keyed by the domain's severities. */
const SEVERITY_PRESENTATION: Readonly<
  Record<DiagnosticSeverity, { readonly chip: string; readonly text: string }>
> = Object.freeze({
  info: Object.freeze({
    chip: "border-border bg-card/70",
    text: "text-muted-foreground",
  }),
  warning: Object.freeze({
    chip: "border-signal/40 bg-signal/8",
    text: "text-signal",
  }),
  error: Object.freeze({
    chip: "border-destructive/60 bg-destructive/8",
    text: "text-destructive",
  }),
  fatal: Object.freeze({
    chip: "border-destructive bg-destructive/10 font-medium",
    text: "text-destructive",
  }),
});

/** Everything the diagnostics chip renders; all of it is refusal data (D9). */
export interface AgentDiagnosticsChipProps {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly message: string;
  readonly location?: AgentToolRefusalLocation;
  /**
   * When provided, the location's ids render as buttons firing this callback
   * (the timeline chips' click-to-act behavior); without it they are plain
   * mono text — the chip never fabricates a selection target.
   */
  readonly onSelectLocation?: (id: string) => void;
}

/**
 * One severity-colored diagnostics chip: code + message (+ location), the
 * chat-side twin of the timeline and viewport error chips.
 */
export function AgentDiagnosticsChip({
  severity,
  code,
  message,
  location,
  onSelectLocation,
}: AgentDiagnosticsChipProps): ReactElement {
  const presentation = SEVERITY_PRESENTATION[severity];
  const primary = location?.primary;
  const locationIds =
    location === undefined
      ? []
      : [location.primary, ...(location.related ?? [])];
  return (
    <div
      className={`flex max-w-full min-w-0 flex-col gap-1 rounded-sm border px-2 py-1.5 text-xs leading-4 ${presentation.chip}`}
      data-testid="agent-diagnostic-chip"
      data-severity={severity}
      role={severity === "error" || severity === "fatal" ? "alert" : undefined}
    >
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span
          className={`shrink-0 font-mono text-[11px] font-medium ${presentation.text}`}
        >
          {code}
        </span>
      </div>
      <p className={`wrap-break-word ${presentation.text}`}>{message}</p>
      {locationIds.length > 0 ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          {locationIds.map((id) => {
            const label = id === primary ? id : `related: ${id}`;
            return onSelectLocation === undefined ? (
              <span
                key={id}
                className="rounded-sm border border-border/60 bg-background/60 px-1 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {label}
              </span>
            ) : (
              <button
                key={id}
                type="button"
                className="cursor-pointer rounded-sm border border-border/60 bg-background/60 px-1 py-0.5 font-mono text-[10px] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50"
                onClick={() => {
                  onSelectLocation(id);
                }}
              >
                {label}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
