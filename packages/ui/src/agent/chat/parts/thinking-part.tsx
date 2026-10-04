/**
 * The thinking/reasoning part renderer (PLAN-AGENT-CHAT Phase 4.3): a
 * collapsible the shadcn chatbot template lacked entirely. A native
 * `<details>` keeps it keyboard-operable and dependency-free: open while the
 * run streams the part (the `streaming` prop drives `open`, so it collapses
 * itself when the answer starts), collapsed afterwards.
 *
 * The same component renders the structured-output part's `reasoning` field
 * (its label prop), which is the identical affordance over a different part.
 */

import type { ReactElement } from "react";
import { BrainCircuitIcon } from "lucide-react";
import type { AgentChatMessagePart } from "./part-types";

/** Everything the thinking renderer takes; `streaming` is message-run state. */
export interface AgentThinkingPartProps {
  readonly part: Extract<AgentChatMessagePart, { type: "thinking" }>;
  /** True while the owning message's run is still streaming this part. */
  readonly streaming?: boolean;
  /** The summary label (defaults to "Reasoning"; structured output overrides it). */
  readonly label?: string;
}

/** Renders one thinking part as a collapsible reasoning disclosure. */
export function AgentThinkingPart({
  part,
  streaming = false,
  label = "Reasoning",
}: AgentThinkingPartProps): ReactElement {
  return (
    <details
      open={streaming}
      className="group/thinking w-full max-w-full rounded-sm border border-border/60 bg-card/40 text-xs"
      data-testid="agent-thinking-part"
      data-streaming={streaming}
    >
      <summary className="flex cursor-pointer items-center gap-1.5 px-2 py-1 text-muted-foreground outline-none select-none transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50">
        <BrainCircuitIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="leading-none">
          {streaming ? `${label}\u2026` : label}
        </span>
      </summary>
      <p className="wrap-break-word border-t border-border/60 px-2 py-1.5 leading-relaxed text-muted-foreground">
        {part.content}
      </p>
    </details>
  );
}
