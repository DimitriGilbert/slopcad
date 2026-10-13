/**
 * The structured-output part renderer (PLAN-AGENT-CHAT Phase 4.3): the
 * schema-typed output arm — the agent surface does not currently declare an
 * `outputSchema`, but the part union carries the arm, so it renders honestly
 * wherever one appears: streaming shows the progressive JSON, complete shows
 * the validated payload (collapsed), error shows the failure message, and an
 * optional reasoning field reuses the thinking disclosure. The status switch
 * is exhaustive (never-checked).
 */

import type { ReactElement } from "react";
import type { AgentChatMessagePart } from "./part-types";

import { stableJson } from "./decoders";
import { AgentThinkingPart } from "./thinking-part";
import { PartStatusLine } from "./busy";

type StructuredOutputPartOf = Extract<
  AgentChatMessagePart,
  { type: "structured-output" }
>;

/** Renders one structured-output part by its status. */
export function AgentStructuredOutputPart({
  part,
}: {
  part: StructuredOutputPartOf;
}): ReactElement {
  return (
    <div
      className="flex w-full max-w-full flex-col gap-1.5"
      data-testid="agent-structured-output-part"
      data-status={part.status}
    >
      {part.reasoning === undefined ? null : (
        <AgentThinkingPart
          label="Reasoning"
          part={{ content: part.reasoning, type: "thinking" }}
          streaming={part.status === "streaming"}
        />
      )}
      {(() => {
        switch (part.status) {
          case "streaming":
            return (
              <PartStatusLine>Composing structured output…</PartStatusLine>
            );
          case "complete":
            return (
              <details className="px-1.5 text-xs">
                <summary className="cursor-pointer text-muted-foreground outline-none select-none focus-visible:ring-1 focus-visible:ring-ring/50">
                  Structured output
                </summary>
                <pre className="overflow-x-auto pt-1 font-mono text-[11px] leading-relaxed text-muted-foreground">
                  {stableJson(part.data ?? part.raw)}
                </pre>
              </details>
            );
          case "error":
            return (
              <div
                className="rounded-sm border border-destructive/40 bg-background/95 px-2 py-1 text-xs leading-4 text-destructive"
                role="alert"
              >
                {part.errorMessage === undefined
                  ? "The structured output failed."
                  : part.errorMessage}
              </div>
            );
          default: {
            // Exhaustiveness: a future status must be handled here.
            const exhaustive: never = part.status;
            void exhaustive;
            return null;
          }
        }
      })()}
    </div>
  );
}
