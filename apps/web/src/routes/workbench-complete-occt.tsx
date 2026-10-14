import { createFileRoute } from "@tanstack/react-router";

import { CompleteWorkbenchPage } from "@/cad-workbench/CompleteWorkbenchPage";

/**
 * The complete workbench on the OpenCascade backend (Phase 38): the SAME
 * composition, engine, and document as `/workbench-complete`, booted with
 * the OCCT worker under its own root id. Since OCCT became the workbench's
 * default backend, `/workbench-complete` boots the same kernel; this route
 * keeps pinning `backend="occt"` explicitly so the suites addressing its
 * root (sweep, loft, helix, surface, pattern stages) stay on their
 * declared backend whatever the default is.
 */
export const Route = createFileRoute("/workbench-complete-occt")({
  head: () => ({
    meta: [
      {
        title: "Workbench (OpenCascade) · slopcad",
      },
    ],
  }),
  component: () => (
    <CompleteWorkbenchPage
      backend="occt"
      rootId="workbench-complete-occt-root"
    />
  ),
});
