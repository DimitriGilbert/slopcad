import { createFileRoute } from "@tanstack/react-router";

import { AnalysisWorkbenchPage } from "@/cad-workbench/analysis-workbench";

export const Route = createFileRoute("/workbench-analysis")({
  component: AnalysisWorkbenchPage,
});
