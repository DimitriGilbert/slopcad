import { createFileRoute } from "@tanstack/react-router";

import { InterferenceWorkbenchPage } from "@/cad-workbench/interference-workbench";

export const Route = createFileRoute("/workbench-assembly-interference")({
  component: InterferenceWorkbenchPage,
});
