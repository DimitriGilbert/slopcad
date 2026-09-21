import { createFileRoute } from "@tanstack/react-router";

import { CompleteWorkbenchPage } from "@/cad-workbench/CompleteWorkbenchPage";

/**
 * The complete workbench on the OpenCascade backend (Phase 38): the SAME
 * composition, engine, and document as `/workbench-complete`, booted with
 * the OCCT worker so the sweep and loft features execute as real BREP
 * solids — on the default Manifold backend both are honest structured
 * declines (`kernel/unsupported-operation`), which the default route
 * surfaces verbatim. Boot-time configuration: the default routes' boot
 * state (and every baseline pinned to it) is untouched.
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
