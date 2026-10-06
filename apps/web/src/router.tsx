import type { AppRouter } from "@slopcad/api/routers/index";
import { QueryCache, QueryClient } from "@tanstack/react-query";
import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { setupRouterSsrQueryIntegration } from "@tanstack/react-router-ssr-query";
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { createTRPCOptionsProxy } from "@trpc/tanstack-react-query";
import { toast } from "sonner";

import Loader from "./components/loader";
import RouterErrorScreen from "./components/router-error";
import { routeTree } from "./routeTree.gen";
import { TRPCProvider } from "./utils/trpc";

function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        toast.error(error.message, {
          action: {
            label: "retry",
            onClick: () => {
              query.invalidate();
            },
          },
        });
      },
    }),
    defaultOptions: { queries: { staleTime: 60 * 1000 } },
  });
}

const trpcClient = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      fetch(url, options) {
        return fetch(url, {
          ...options,
          credentials: "include",
        });
      },
    }),
  ],
});

export const getRouter = () => {
  const queryClient = createQueryClient();
  const trpc = createTRPCOptionsProxy({
    client: trpcClient,
    queryClient,
  });

  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    context: { trpc, queryClient },
    defaultPendingComponent: () => <Loader />,
    defaultNotFoundComponent: () => <div>Not Found</div>,
    defaultErrorComponent: RouterErrorScreen,
    Wrap: ({ children }) => (
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        {children}
      </TRPCProvider>
    ),
  });

  setupRouterSsrQueryIntegration({
    router,
    queryClient,
  });

  return router;
};

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
