import { randomUUID } from "node:crypto";
import { createInMemoryDb } from "@slopcad/db";
import { beforeAll, describe, expect, it } from "vitest";

import { createAuth } from "./index";

beforeAll(async () => {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("test setup must define DATABASE_URL");
  }
  await createInMemoryDb(dbUrl);
});

describe("createAuth", () => {
  it("signs a user up and authenticates them end to end against the migrated database", async () => {
    const auth = createAuth();
    const email = `ada-${randomUUID()}@slopcad.dev`;
    const password = "supercalifragilistic";

    await auth.api.signUpEmail({
      body: { email, password, name: "Ada Lovelace" },
      headers: new Headers(),
    });

    const result = await auth.api.signInEmail({
      body: { email, password },
      headers: new Headers(),
    });
    expect(result.user.email).toBe(email);
    expect(result.user.name).toBe("Ada Lovelace");
    expect(typeof result.token).toBe("string");
  });

  it("rejects a sign-in for an unknown user against the migrated database", async () => {
    const auth = createAuth();
    const attempt = auth.api.signInEmail({
      body: { email: "nobody@slopcad.dev", password: "irrelevant-password" },
      headers: new Headers(),
    });
    await expect(attempt).rejects.toMatchObject({
      status: "UNAUTHORIZED",
      statusCode: 401,
      body: { message: "Invalid email or password" },
    });
  });
});
