import { createFileRoute } from "@tanstack/react-router";

import { PerfFixturePage } from "@/perf-fixture/PerfFixturePage";

export const Route = createFileRoute("/perf")({
  component: PerfFixturePage,
});
