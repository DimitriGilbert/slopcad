import { createFileRoute } from "@tanstack/react-router";

import { AssemblyMotionWorkbenchPage } from "@/cad-workbench/assembly-motion-workbench";

export const Route = createFileRoute("/workbench-assembly-motion")({
  component: AssemblyMotionWorkbenchPage,
});
