/**
 * The public viewer route (Phase — shareable parametric pages): a shared
 * parametric part, drawn live with its variables editable. The document
 * rides the URL fragment (the share codec's compressed payload) or,
 * when the link is an id-based server share, the `?p=<id>` search param
 * the surface fetches through the shares API — the fragment form stays
 * the self-contained default and wins when a URL carries both. The local
 * load affordances cover everything else, and the page is framable —
 * the embed story is the point (see ./viewer/viewer-frame-policy).
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
  // The router's default search parser may realize `?embed=1` as either
  // the string or the number `1` (the header's flag guard documents the
  // same); every realization is the one flag.
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    embed: boolean;
    p: string | undefined;
  } => ({
    embed:
      search["embed"] === "1" ||
      search["embed"] === 1 ||
      search["embed"] === true,
    p: typeof search["p"] === "string" ? search["p"] : undefined,
  }),
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
  const { embed, p } = Route.useSearch();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) {
    return null;
  }
  return <ViewerSurface embed={embed} serverShareId={p} variant="page" />;
}
