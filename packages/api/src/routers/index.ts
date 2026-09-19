import { db } from "@slopcad/db";

import { protectedProcedure, publicProcedure, router } from "../index";
import { createDocumentsRouter } from "./documents";
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
});
export type AppRouter = typeof appRouter;
