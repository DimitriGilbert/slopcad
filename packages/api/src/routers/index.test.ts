import { describe, expect, it } from "vitest";

import { t } from "../index";
import { appRouter } from "./index";

const createCaller = t.createCallerFactory(appRouter);

function anonymousCaller() {
  return createCaller({ auth: null, session: null });
}

describe("appRouter", () => {
  it("answers healthCheck with OK for anonymous callers", async () => {
    await expect(anonymousCaller().healthCheck()).resolves.toBe("OK");
  });

  it("rejects privateData for anonymous callers as UNAUTHORIZED", async () => {
    await expect(anonymousCaller().privateData()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
