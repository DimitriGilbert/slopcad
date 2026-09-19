import { createServerFn } from "@tanstack/react-start";

import { authMiddleware } from "@/middleware/auth";

export const getUser = createServerFn({ method: "POST" })
  .middleware([authMiddleware])
  .handler(({ context }) => {
    if (context.session === null) {
      return null;
    }
    return { user: context.session.user };
  });
