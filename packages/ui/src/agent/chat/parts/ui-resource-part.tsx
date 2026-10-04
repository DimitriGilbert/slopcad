/**
 * The ui-resource part renderer (PLAN-AGENT-CHAT Phase 4.3): the MCP-native
 * `ui://` widget arm — this surface's tools are plain webMCP JSON tools and
 * never mint UI resources, but the part union carries the arm, so it renders
 * an honest one-line pointer (tool + resource uri) instead of nothing. The
 * widget rendering itself (`@mcp-ui/client`'s renderer) is deliberately out
 * of scope for the slopcad chat.
 */

import type { ReactElement } from "react";
import { FrameIcon } from "lucide-react";
import type { AgentChatMessagePart } from "./part-types";

type UIResourcePartOf = Extract<AgentChatMessagePart, { type: "ui-resource" }>;

/** Renders one ui-resource part as a muted pointer row. */
export function AgentUIResourcePart({
  part,
}: {
  part: UIResourcePartOf;
}): ReactElement {
  return (
    <div className="flex min-w-0 items-center gap-1.5 px-1.5 text-xs text-muted-foreground">
      <FrameIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="truncate">
        {`${part.toolName}: ${part.resource.uri} (${part.resource.mimeType})`}
      </span>
    </div>
  );
}
