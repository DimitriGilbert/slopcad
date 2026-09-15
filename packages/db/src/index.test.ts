import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createInMemoryDb } from "./index";
import * as schema from "./schema";

describe("db schema", () => {
  it("round-trips a user through the drizzle schema", async () => {
    const db = await createInMemoryDb();
    const inserted = await db
      .insert(schema.user)
      .values({
        id: "user-1",
        name: "Ada Lovelace",
        email: "ada@slopcad.dev",
      })
      .returning();

    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.email).toBe("ada@slopcad.dev");
    expect(inserted[0]?.emailVerified).toBe(false);
    expect(inserted[0]?.createdAt).toBeInstanceOf(Date);

    const found = await db.query.user.findFirst({
      where: eq(schema.user.email, "ada@slopcad.dev"),
    });
    expect(found?.name).toBe("Ada Lovelace");
  });

  it("enforces the unique email constraint", async () => {
    const db = await createInMemoryDb();
    const row = { id: "user-2", name: "Duplicate", email: "dup@slopcad.dev" };
    await db.insert(schema.user).values(row);

    await expect(
      db.insert(schema.user).values({ ...row, id: "user-3" }),
    ).rejects.toThrow();
  });
});
