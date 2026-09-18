import { createFileRoute } from "@tanstack/react-router";

import { OcctFilletFixturePage } from "@/worker-fixture/OcctFilletFixturePage";

export const Route = createFileRoute("/worker-fillet")({
  component: OcctFilletFixturePage,
});
