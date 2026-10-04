import { db } from "@slopcad/db";

import { protectedProcedure, publicProcedure, router } from "../index";
import {
  createAgentConversationsRouter,
  createServerProvidersProcedure,
} from "./agent-conversations";
import { createDocumentsRouter } from "./documents";
import { createModelCatalogRouter } from "./model-catalog";
import { createProjectsRouter } from "./projects";

export const appRouter = router({
  healthCheck: publicProcedure.query(() => {
    return "OK";
  }),
  privateData: protectedProcedure.query(({ ctx }) => {
    return {
      message: "This is private",
      user: ctx.session.user,
    };
  }),
  projects: createProjectsRouter({ db }),
  documents: createDocumentsRouter({ db }),
  modelCatalog: createModelCatalogRouter({ db }),
  agentConversations: createAgentConversationsRouter({ db }),
  serverProviders: createServerProvidersProcedure({ db }),
});
export type AppRouter = typeof appRouter;
