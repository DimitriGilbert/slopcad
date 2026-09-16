import { createFileRoute } from "@tanstack/react-router";

import { WorkbenchFixturePage } from "@/workbench-fixture/WorkbenchFixturePage";

export const Route = createFileRoute("/workbench")({
  component: WorkbenchFixturePage,
});
