import { createFileRoute } from "@tanstack/react-router";

import { DrawingWorkbenchPage } from "@/cad-workbench/drawing-workbench";

export const Route = createFileRoute("/drawings")({
  head: () => ({
    meta: [
      {
        title: "Drawings · slopcad",
      },
    ],
  }),
  component: DrawingWorkbenchPage,
});
