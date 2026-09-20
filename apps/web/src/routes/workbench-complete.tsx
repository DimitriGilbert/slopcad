import { createFileRoute } from "@tanstack/react-router";

import { CompleteWorkbenchPage } from "@/cad-workbench/CompleteWorkbenchPage";

export const Route = createFileRoute("/workbench-complete")({
  head: () => ({
    meta: [
      {
        title: "Workbench · slopcad",
      },
    ],
  }),
  component: CompleteWorkbenchPage,
});
