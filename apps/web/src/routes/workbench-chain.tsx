import { createFileRoute } from "@tanstack/react-router";

import { CadChainWorkbenchPage } from "@/cad-workbench/CadChainWorkbenchPage";

export const Route = createFileRoute("/workbench-chain")({
  component: CadChainWorkbenchPage,
});
