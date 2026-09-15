import { createFileRoute } from "@tanstack/react-router";

import { SpikePage } from "@/spike/SpikePage";

export const Route = createFileRoute("/spike")({
  component: SpikePage,
});
