import { describe, expect, it, vi } from "vitest";

const VALID_ENV = {
  DATABASE_URL: "file::memory:",
  BETTER_AUTH_SECRET: "unit-test-secret-0123456789abcdef0123456789",
  BETTER_AUTH_URL: "http://localhost:3001",
} as const;

async function importServerEnv() {
  vi.resetModules();
  const mod = await import("./server");
  return mod.env;
}

function withMockedEnv(
  vars: Record<string, string | undefined>,
  run: () => Promise<void>,
) {
  const snapshot = { ...process.env };
  const previousSkip = process.env.SKIP_ENV_VALIDATION;
  delete process.env.SKIP_ENV_VALIDATION;
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return run().finally(() => {
    process.env.SKIP_ENV_VALIDATION = previousSkip;
    for (const key of Object.keys(process.env)) {
      if (!(key in snapshot)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, snapshot);
  });
}

describe("server env", () => {
  it("exposes validated values when every required variable is set", async () => {
    await withMockedEnv({ ...VALID_ENV }, async () => {
      const env = await importServerEnv();
      expect(env.DATABASE_URL).toBe(VALID_ENV.DATABASE_URL);
      expect(env.BETTER_AUTH_URL).toBe(VALID_ENV.BETTER_AUTH_URL);
    });
  });

  it("rejects a missing BETTER_AUTH_SECRET with a structured error", async () => {
    await withMockedEnv(
      {
        ...VALID_ENV,
        BETTER_AUTH_SECRET: undefined,
      },
      async () => {
        await expect(importServerEnv()).rejects.toThrow(
          /Invalid environment variables/,
        );
      },
    );
  });

  it("skips validation and passes raw values through when SKIP_ENV_VALIDATION is set", async () => {
    await withMockedEnv({ ...VALID_ENV }, async () => {
      process.env.SKIP_ENV_VALIDATION = "1";
      process.env.BETTER_AUTH_URL = "not-a-valid-url";
      const env = await importServerEnv();
      expect(env.BETTER_AUTH_URL).toBe("not-a-valid-url");
    });
  });
});
