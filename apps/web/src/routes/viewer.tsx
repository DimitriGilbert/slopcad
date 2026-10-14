/**
 * The public viewer route (Phase — shareable parametric pages): a shared
 * parametric part, drawn live with its variables editable. The document
 * rides the URL fragment (the share codec's compressed payload) or,
 * when the link is an id-based server share, the `?p=<id>` search param
 * — fetched HERE, under the app's tRPC and query providers, because the
 * surface itself must stay provider-free (the standalone export mounts
 * it in a file://-opened single HTML with no providers at all). The
 * fragment form stays the self-contained default and wins when a URL
 * carries both; the local load affordances cover everything else, and
 * the page is framable — the embed story is the point (see
 * ./viewer/viewer-frame-policy).
 *
 * The viewer is a client instrument — WebGL, worker execution, the settle
 * protocol — so the route keeps the workbench routes' contract: server
 * shell only, the full tree on mount (the mount gate).
 */

import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";

import {
  ViewerSurface,
  NO_SERVER_SHARE,
  type ServerShareState,
} from "@/viewer/ViewerSurface";
import { useTRPC } from "@/utils/trpc";

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
  const trpc = useTRPC();
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  // The id-based server share's document, fetched only when `?p=` rides
  // the URL. A missing share is a dead link, not a transient: no retry,
  // and the resolved answer never goes stale (no refetch on focus).
  const shareQuery = useQuery({
    ...trpc.shares.get.queryOptions({ id: p ?? "" }),
    enabled: p !== undefined,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const serverShare: ServerShareState =
    p === undefined
      ? NO_SERVER_SHARE
      : shareQuery.isError
        ? { kind: "error", message: shareQuery.error.message }
        : shareQuery.data === undefined
          ? { kind: "pending" }
          : { kind: "text", text: shareQuery.data.nativeContent };

  if (!mounted) {
    return null;
  }
  return (
    <ViewerSurface embed={embed} serverShare={serverShare} variant="page" />
  );
}
