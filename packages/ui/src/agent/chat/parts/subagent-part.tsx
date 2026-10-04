/**
 * The subagent part renderer (PLAN-AGENT-CHAT Phase 4.3): a compact status
 * row for a child-agent invocation — the agent surface defines no subagents
 * today, but the part union carries the arm, so it renders name + status
 * (+ error) as an audit line. Nested child messages are NOT rendered here:
 * the Phase 4.4 orchestrator owns any deep transcript surface, and this
 * renderer only promises the parent-message view.
 */

import type { ReactElement } from "react";
import { BotIcon } from "lucide-react";
import type { AgentChatMessagePart } from "./part-types";

import { PartSpinner } from "./busy";

type SubagentPartOf = Extract<AgentChatMessagePart, { type: "subagent" }>;

/** Renders one subagent part as a status line. */
export function AgentSubagentPart({
  part,
}: {
  part: SubagentPartOf;
}): ReactElement {
  const handle = part.subagent;
  return (
    <div
      className="flex min-w-0 items-center gap-1.5 px-1.5 text-xs text-muted-foreground"
      data-testid="agent-subagent-part"
      data-status={handle.status}
    >
      <BotIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate font-medium">{handle.name}</span>
      {handle.status === "running" ? (
        <>
          <PartSpinner />
          <span className="leading-none">running…</span>
        </>
      ) : handle.status === "error" ? (
        <span className="wrap-break-word min-w-0 text-destructive">
          {handle.error?.message ?? "failed"}
        </span>
      ) : handle.status === "suspended" ? (
        <span className="leading-none">waiting on a question</span>
      ) : (
        <span className="leading-none">finished</span>
      )}
    </div>
  );
}
