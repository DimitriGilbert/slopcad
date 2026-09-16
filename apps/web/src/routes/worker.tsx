import { createFileRoute } from "@tanstack/react-router";

import { WorkerFixturePage } from "@/worker-fixture/WorkerFixturePage";

export const Route = createFileRoute("/worker")({
  component: WorkerFixturePage,
});
