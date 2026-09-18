import { createFileRoute } from "@tanstack/react-router";

import { CompleteWorkbenchPage } from "@/cad-workbench/CompleteWorkbenchPage";

export const Route = createFileRoute("/workbench-complete")({
  component: CompleteWorkbenchPage,
});
