import { createFileRoute } from "@tanstack/react-router";

import { UiViewportFixturePage } from "@/ui-viewport-fixture/UiViewportFixturePage";

export const Route = createFileRoute("/ui-viewport")({
  component: UiViewportFixturePage,
});
