/**
 * The tool-call part renderer (PLAN-AGENT-CHAT Phase 4.3): the REQUEST side
 * of a tool invocation — the chat's audit trail of what the agent asked the
 * workbench to do, displayed only (D4: the commands already executed through
 * the registry; this view never re-runs them).
 *
 * Three per-tool renderers over the bridged webMCP surface, plus the generic
 * fallback every other registry tool gets:
 *
 * - `cad_apply_commands` — the readable command/JSX diff: every entry is
 *   re-parsed by the domain's own `parseCommand` and rendered as one `+`
 *   row (an applied mutation) with a per-type human summary; entries the
 *   strict parser refuses render with their structured reason instead of a
 *   fabricated line.
 * - `cad_capture_views` — the requested angles as label chips (D10).
 * - generic — tool name + collapsed input JSON.
 *
 * The state machine switch is exhaustive over `ToolCallState` (never-checked):
 * a framework state this renderer cannot present fails the build rather than
 * silently rendering nothing. Streaming is per-part here — the state IS the
 * stream position (`awaiting-input` → `input-streaming` → `input-complete`),
 * so no message-level flag is needed.
 */

import type { ReactElement, ReactNode } from "react";
import { BoxesIcon, CameraIcon, WrenchIcon } from "lucide-react";
import type { AgentChatToolCallPart } from "./part-types";

import {
  APPLY_COMMANDS_TOOL,
  CAPTURE_VIEWS_TOOL,
  decodeApplyCommandsInput,
  decodeCaptureViewsInput,
  formatCadCommand,
  parseLooseJson,
  stableJson,
} from "./decoders";
import { PartStatusLine } from "./busy";

/** Everything the tool-call renderer takes (the part is its whole world). */
export interface AgentToolCallPartProps {
  readonly part: AgentChatToolCallPart;
}

/** The tool-call block's outer frame: one bordered card per invocation. */
function ToolFrame({
  icon,
  title,
  children,
}: {
  icon: ReactNode;
  title: string;
  children?: ReactNode;
}): ReactElement {
  return (
    <div
      className="w-full max-w-full rounded-sm border border-border/70 bg-card/50"
      data-testid="agent-tool-call-part"
    >
      <div className="flex min-w-0 items-center gap-1.5 px-2 py-1 text-xs text-muted-foreground">
        {icon}
        <span className="min-w-0 truncate font-medium text-foreground">
          {title}
        </span>
      </div>
      {children === undefined ? null : (
        <div className="border-t border-border/60 px-2 py-1.5">{children}</div>
      )}
    </div>
  );
}

/** A collapsed raw-JSON disclosure, the fallback body everywhere. */
function RawJsonDisclosure({
  label,
  value,
}: {
  label: string;
  value: unknown;
}): ReactElement {
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-muted-foreground outline-none select-none focus-visible:ring-1 focus-visible:ring-ring/50">
        {label}
      </summary>
      <pre className="overflow-x-auto pt-1 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {stableJson(value)}
      </pre>
    </details>
  );
}

/** The `cad_apply_commands` body: the readable command diff (display only, D4). */
function ApplyCommandsBody({ input }: { input: unknown }): ReactElement {
  const decoded = decodeApplyCommandsInput(input);
  if (decoded === null) {
    return <RawJsonDisclosure label="Raw commands JSON" value={input} />;
  }
  return (
    <ol className="flex flex-col gap-0.5 font-mono text-[11px] leading-4">
      {decoded.commands.map((entry, index) =>
        entry.ok ? (
          <li
            key={index}
            className="flex min-w-0 items-baseline gap-1.5 text-foreground"
            data-testid="agent-command-row"
          >
            <span aria-hidden="true" className="shrink-0 text-primary">
              +
            </span>
            <span className="wrap-break-word min-w-0">
              {formatCadCommand(entry.command)}
            </span>
          </li>
        ) : (
          <li
            key={index}
            className="flex min-w-0 items-baseline gap-1.5 text-destructive"
            data-testid="agent-command-row"
            data-refused="true"
          >
            <span aria-hidden="true" className="shrink-0">
              ?
            </span>
            <span className="wrap-break-word min-w-0">
              {`commands[${String(index)}]: ${entry.message}`}
            </span>
          </li>
        ),
      )}
    </ol>
  );
}

/** The `cad_capture_views` body: the requested angle labels (D10). */
function CaptureViewsBody({ input }: { input: unknown }): ReactElement {
  const views = decodeCaptureViewsInput(input);
  if (views === null) {
    return <RawJsonDisclosure label="Raw views JSON" value={input} />;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {views.map((view, index) => (
        <span
          key={`${view.label}-${String(index)}`}
          className="rounded-sm border border-border bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
          data-testid="agent-view-label"
        >
          {view.label}
        </span>
      ))}
    </div>
  );
}

/** The generic tool body: collapsed input JSON. */
function GenericToolBody({ input }: { input: unknown }): ReactElement {
  return <RawJsonDisclosure label="Input" value={input} />;
}

/** Derives the per-tool request count for the frame's title, when it has one. */
function requestCountOf(name: string, rawInput: unknown): number | undefined {
  if (name === APPLY_COMMANDS_TOOL) {
    return decodeApplyCommandsInput(rawInput)?.commands.length;
  }
  if (name === CAPTURE_VIEWS_TOOL) {
    return decodeCaptureViewsInput(rawInput)?.length;
  }
  return undefined;
}

/**
 * Renders one tool-call part: the status line by state, then the per-tool
 * request body once the input is readable.
 */
export function AgentToolCallPart({
  part,
}: AgentToolCallPartProps): ReactElement {
  const rawInput: unknown =
    part.input === undefined ? parseLooseJson(part.arguments) : part.input;
  const count = requestCountOf(part.name, rawInput);
  const title =
    part.name === APPLY_COMMANDS_TOOL
      ? count === undefined
        ? "Apply commands"
        : `Apply ${String(count)} command${count === 1 ? "" : "s"}`
      : part.name === CAPTURE_VIEWS_TOOL
        ? count === undefined
          ? "Capture views"
          : `Capture ${String(count)} view${count === 1 ? "" : "s"}`
        : part.name;

  const icon =
    part.name === APPLY_COMMANDS_TOOL ? (
      <BoxesIcon aria-hidden="true" className="size-3.5 shrink-0" />
    ) : part.name === CAPTURE_VIEWS_TOOL ? (
      <CameraIcon aria-hidden="true" className="size-3.5 shrink-0" />
    ) : (
      <WrenchIcon aria-hidden="true" className="size-3.5 shrink-0" />
    );

  switch (part.state) {
    case "awaiting-input":
    case "input-streaming":
      return <PartStatusLine>{`Calling ${part.name}\u2026`}</PartStatusLine>;
    case "input-complete":
    case "complete":
      return (
        <ToolFrame icon={icon} title={title}>
          {part.name === APPLY_COMMANDS_TOOL ? (
            <ApplyCommandsBody input={rawInput} />
          ) : part.name === CAPTURE_VIEWS_TOOL ? (
            <CaptureViewsBody input={rawInput} />
          ) : (
            <GenericToolBody input={rawInput} />
          )}
        </ToolFrame>
      );
    case "approval-requested":
      return (
        <PartStatusLine>{`Waiting to run ${part.name}\u2026`}</PartStatusLine>
      );
    case "approval-responded":
      return <PartStatusLine>{`Starting ${part.name}\u2026`}</PartStatusLine>;
    case "error":
      // The error text itself lives on the paired tool-result part; this arm
      // keeps the request visible while that part renders the diagnostics.
      return (
        <ToolFrame icon={icon} title={`${title} (failed)`}>
          <GenericToolBody input={rawInput} />
        </ToolFrame>
      );
    default: {
      // Exhaustiveness: a future ToolCallState must be handled here.
      const exhaustive: never = part.state;
      void exhaustive;
      return <PartStatusLine>{`Calling ${part.name}\u2026`}</PartStatusLine>;
    }
  }
}
