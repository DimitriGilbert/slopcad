import { createFileRoute } from "@tanstack/react-router";

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
  return <ComponentPreviewPage componentId={componentId} />;
}
