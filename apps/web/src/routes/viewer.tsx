/**
 * The public viewer route (Phase — shareable parametric pages): a shared
 * parametric part, drawn live with its variables editable. The document
 * rides the URL fragment (the share codec's compressed payload), the local
 * load affordances cover everything else, and the page is framable — the
 * embed story is the point (see ./viewer/viewer-frame-policy).
 *
 * The viewer is a client instrument — WebGL, worker execution, the settle
 * protocol — so the route keeps the workbench routes' contract: server
 * shell only, the full tree on mount (the mount gate).
 */

import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import { ViewerSurface } from "@/viewer/ViewerSurface";

export const Route = createFileRoute("/viewer")({
  head: () => ({
    meta: [
      {
        title: "Viewer · slopcad",
      },
    ],
  }),
  component: ViewerRouteComponent,
});

/** The client-only mount gate (the projects page's discipline). */
function ViewerRouteComponent(): ReactElement | null {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) {
    return null;
  }
  return <ViewerSurface variant="page" />;
}
