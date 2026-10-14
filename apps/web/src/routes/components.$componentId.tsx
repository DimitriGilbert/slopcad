import { createFileRoute } from "@tanstack/react-router";

import { AgentChatPreview } from "@/component-preview/agent-chat-preview";
import { ComponentPreviewPage } from "@/component-preview/ComponentPreviewPage";

export const Route = createFileRoute("/components/$componentId")({
  head: () => ({
    meta: [
      {
        title: "Component · slopcad",
      },
    ],
  }),
  component: ComponentPreviewRoute,
});

function ComponentPreviewRoute() {
  const { componentId } = Route.useParams();
  // The agent-chat registry item's demo: the shipped panel with a stub
  // transport, not a PHASE32 CAD component.
  if (componentId === "agent-chat") {
    return <AgentChatPreview />;
  }
  return <ComponentPreviewPage componentId={componentId} />;
}
