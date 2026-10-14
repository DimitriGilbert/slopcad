import { createFileRoute } from "@tanstack/react-router";

import { CompleteWorkbenchPage } from "@/cad-workbench/CompleteWorkbenchPage";

/**
 * The complete workbench on its default backend — OpenCascade (see
 * `CompleteWorkbenchPage`'s `backend` default), the kernel that executes
 * the core CAD features Manifold declines.
 */
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
