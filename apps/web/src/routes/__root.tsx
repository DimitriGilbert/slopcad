import type { AppRouter } from "@slopcad/api/routers/index";
import { Toaster } from "@slopcad/ui/components/sonner";
import type { QueryClient } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRouteWithContext,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";
import type { TRPCOptionsProxy } from "@trpc/tanstack-react-query";

import Header from "../components/header";
import { APPEARANCE_BOOTSTRAP_SCRIPT } from "../theme";
import appCss from "../index.css?url";

interface RouterAppContext {
  trpc: TRPCOptionsProxy<AppRouter>;
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "slopcad: parametric CAD workbench",
      },
      {
        name: "description",
        content:
          "A parametric CAD workbench: kernel-neutral geometry, documents with real history, and reusable components.",
      },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
    scripts: [
      {
        children: APPEARANCE_BOOTSTRAP_SCRIPT,
      },
    ],
  }),

  component: RootDocument,
});

function RootDocument() {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        {/* The column track floors at 0 (never the content's min-width), so
            a dense nowrap surface — the workbench DRO, a long breadcrumb —
            can never widen the document past the viewport. */}
        <div className="grid h-svh grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr]">
          <Header />
          <Outlet />
        </div>
        <Toaster richColors />
        <TanStackRouterDevtools position="bottom-left" />
        <ReactQueryDevtools position="bottom" buttonPosition="bottom-right" />
        <Scripts />
      </body>
    </html>
  );
}
