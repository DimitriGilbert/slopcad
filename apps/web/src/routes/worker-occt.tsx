import { createFileRoute } from "@tanstack/react-router";

import { OcctWorkerFixturePage } from "@/worker-fixture/OcctWorkerFixturePage";

export const Route = createFileRoute("/worker-occt")({
  component: OcctWorkerFixturePage,
});
