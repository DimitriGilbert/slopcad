import { createFileRoute } from "@tanstack/react-router";

import { AssemblyWorkbenchPage } from "@/cad-workbench/assembly-workbench";

export const Route = createFileRoute("/workbench-assembly")({
  component: AssemblyWorkbenchPage,
});
