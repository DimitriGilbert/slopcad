/**
 * The message-parts dispatcher (PLAN-AGENT-CHAT Phase 4.3): the typed,
 * EXHAUSTIVE switch over the installed `@tanstack/ai` part union — one case
 * per `part.type`, and a `never`-checked default so a future part type FAILS
 * THE BUILD instead of silently rendering nothing (the plan's no-silent-
 * fallback rule; the shadcn template's `default: return null` is exactly the
 * slop this replaces).
 *
 * Adjacent text parts are merged before dispatch (the template's
 * `mergeTextParts` discipline: providers that emit per-delta parts render as
 * one markdown document, not a stack of fragments). The dispatcher is the
 * presentational seam the Phase 4.4 orchestrator mounts inside a message
 * layout — it takes parts, nothing else.
 */

import type { ReactElement } from "react";
import type { AgentChatMessagePart } from "./part-types";

import { AgentStructuredOutputPart } from "./structured-output-part";
import { AgentSubagentPart } from "./subagent-part";
import { AgentTextPart } from "./text-part";
import { AgentThinkingPart } from "./thinking-part";
import { AgentToolCallPart } from "./tool-call-part";
import { AgentToolResultPart } from "./tool-result-part";
import { AgentUIResourcePart } from "./ui-resource-part";
import {
  AgentAudioPart,
  AgentDocumentPart,
  AgentImagePart,
  AgentVideoPart,
} from "./media-parts";

/** Everything the dispatcher takes; `streaming` is the owning run's state. */
export interface AgentMessagePartsProps {
  /** The message's parts, in order — as the hook streams them. */
  readonly parts: readonly AgentChatMessagePart[];
  /** True while the owning message's run is still streaming. */
  readonly streaming?: boolean;
}

/**
 * Merges runs of adjacent text parts into single parts so markdown renders
 * as one document (non-text parts break the run). Returns a new array; the
 * input is never mutated.
 */
export function mergeTextParts(
  parts: readonly AgentChatMessagePart[],
): AgentChatMessagePart[] {
  return parts.reduce<AgentChatMessagePart[]>((merged, part) => {
    const last = merged.at(-1);
    if (part.type === "text" && last?.type === "text") {
      merged[merged.length - 1] = {
        ...part,
        content: `${last.content}${part.content}`,
      };
      return merged;
    }
    merged.push(part);
    return merged;
  }, []);
}

/** Renders one part through the exhaustive switch. */
function renderPart(
  part: AgentChatMessagePart,
  streaming: boolean,
): ReactElement | null {
  switch (part.type) {
    case "text":
      return <AgentTextPart part={part} />;
    case "thinking":
      return <AgentThinkingPart part={part} streaming={streaming} />;
    case "tool-call":
      return <AgentToolCallPart part={part} />;
    case "tool-result":
      return <AgentToolResultPart part={part} />;
    case "image":
      return <AgentImagePart part={part} />;
    case "audio":
      return <AgentAudioPart part={part} />;
    case "video":
      return <AgentVideoPart part={part} />;
    case "document":
      return <AgentDocumentPart part={part} />;
    case "structured-output":
      return <AgentStructuredOutputPart part={part} />;
    case "subagent":
      return <AgentSubagentPart part={part} />;
    case "ui-resource":
      return <AgentUIResourcePart part={part} />;
    default: {
      // Exhaustiveness: a future part type must grow a renderer HERE — the
      // assignment below is the compile-time tripwire.
      const exhaustive: never = part;
      void exhaustive;
      return null;
    }
  }
}

/** Renders a message's parts as the ordered stack of typed part blocks. */
export function AgentMessageParts({
  parts,
  streaming = false,
}: AgentMessagePartsProps): ReactElement {
  return (
    <>
      {mergeTextParts(parts).map((part, index) => {
        const rendered = renderPart(part, streaming);
        return rendered === null ? null : (
          <div key={index} className="flex w-full min-w-0 flex-col">
            {rendered}
          </div>
        );
      })}
    </>
  );
}
