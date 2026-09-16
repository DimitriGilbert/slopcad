import { createFileRoute } from "@tanstack/react-router";

import { CadWorkbenchPage } from "@/cad-workbench/CadWorkbenchPage";

export const Route = createFileRoute("/workbench")({
  component: CadWorkbenchPage,
});
