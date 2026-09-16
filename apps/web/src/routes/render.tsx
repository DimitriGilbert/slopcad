import { createFileRoute } from "@tanstack/react-router";

import { RenderFixturePage } from "@/render-fixture/RenderFixturePage";

export const Route = createFileRoute("/render")({
  component: RenderFixturePage,
});
