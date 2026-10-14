import { createFileRoute } from "@tanstack/react-router";

import { SimWorkbenchPage } from "@/sim-workbench/SimWorkbenchPage";

export const Route = createFileRoute("/workbench-sim")({
  component: SimWorkbenchPage,
});
