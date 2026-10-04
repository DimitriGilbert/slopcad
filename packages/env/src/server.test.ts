import { describe, expect, it, vi } from "vitest";

const VALID_ENV = {
  DATABASE_URL: "file::memory:",
  BETTER_AUTH_SECRET: "unit-test-secret-0123456789abcdef0123456789",
  BETTER_AUTH_URL: "http://localhost:3001",
} as const;

/**
 * The documented dev-only placeholder (`.env.example`), restated here so
 * the tests never import the module at collection time (createEnv runs at
 * import); the dev-acceptance test pins the exported constant to it.
 */
const DEV_ONLY_PLACEHOLDER_SECRET =
  "dev-only-placeholder-replace-with-openssl-rand-base64-32";

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

  it("rejects the documented dev-only placeholder secret in production", async () => {
    // The placeholder is 54 characters, so the length rule alone accepts
    // it — only the production gate refuses the publicly-known value.
    expect(DEV_ONLY_PLACEHOLDER_SECRET.length).toBeGreaterThanOrEqual(32);
    await withMockedEnv(
      {
        ...VALID_ENV,
        BETTER_AUTH_SECRET: DEV_ONLY_PLACEHOLDER_SECRET,
        NODE_ENV: "production",
      },
      async () => {
        await expect(importServerEnv()).rejects.toThrow(
          /Invalid environment variables/,
        );
      },
    );
  });

  it("accepts the documented dev-only placeholder secret outside production", async () => {
    await withMockedEnv(
      {
        ...VALID_ENV,
        BETTER_AUTH_SECRET: DEV_ONLY_PLACEHOLDER_SECRET,
        NODE_ENV: "development",
      },
      async () => {
        vi.resetModules();
        const mod = await import("./server");
        // One source of truth: the module's exported constant IS the
        // documented placeholder this suite restates.
        expect(mod.DEV_ONLY_PLACEHOLDER_BETTER_AUTH_SECRET).toBe(
          DEV_ONLY_PLACEHOLDER_SECRET,
        );
        expect(mod.env.BETTER_AUTH_SECRET).toBe(DEV_ONLY_PLACEHOLDER_SECRET);
      },
    );
  });

  it("accepts a real secret in production", async () => {
    await withMockedEnv(
      {
        ...VALID_ENV,
        NODE_ENV: "production",
      },
      async () => {
        const env = await importServerEnv();
        expect(env.BETTER_AUTH_SECRET).toBe(VALID_ENV.BETTER_AUTH_SECRET);
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

describe("agent chat env", () => {
  const AGENT_VARS = [
    "OPENAI_KEY",
    "ANTHROPIC_KEY",
    "GOOGLE_KEY",
    "OPENROUTER_KEY",
    "OPENAI_COMPATIBLE_KEY",
    "OPENAI_COMPATIBLE_BASE_URL",
    "AGENT_SERVER_AI_ALLOW_ALL",
    "MODEL_CATALOG_URL",
  ] as const;

  function absentAgentVars(): Record<(typeof AGENT_VARS)[number], undefined> {
    return Object.fromEntries(AGENT_VARS.map((name) => [name, undefined])) as {
      [K in (typeof AGENT_VARS)[number]]: undefined;
    };
  }

  it("accepts an env with no agent vars and applies the documented defaults", async () => {
    await withMockedEnv({ ...VALID_ENV, ...absentAgentVars() }, async () => {
      const env = await importServerEnv();
      expect(env.OPENAI_KEY).toBeUndefined();
      expect(env.ANTHROPIC_KEY).toBeUndefined();
      expect(env.GOOGLE_KEY).toBeUndefined();
      expect(env.OPENROUTER_KEY).toBeUndefined();
      expect(env.OPENAI_COMPATIBLE_KEY).toBeUndefined();
      expect(env.OPENAI_COMPATIBLE_BASE_URL).toBeUndefined();
      expect(env.AGENT_SERVER_AI_ALLOW_ALL).toBe(false);
      expect(env.MODEL_CATALOG_URL).toBe("https://models.dev/api.json");
    });
  });

  it("enables server mode for exactly the providers whose keys are present", async () => {
    await withMockedEnv(
      {
        ...VALID_ENV,
        ...absentAgentVars(),
        OPENAI_KEY: "sk-test",
      },
      async () => {
        const env = await importServerEnv();
        expect(env.OPENAI_KEY).toBe("sk-test");
        expect(env.ANTHROPIC_KEY).toBeUndefined();
      },
    );
  });

  it("parses AGENT_SERVER_AI_ALLOW_ALL as a boolean", async () => {
    await withMockedEnv(
      { ...VALID_ENV, ...absentAgentVars(), AGENT_SERVER_AI_ALLOW_ALL: "true" },
      async () => {
        const env = await importServerEnv();
        expect(env.AGENT_SERVER_AI_ALLOW_ALL).toBe(true);
      },
    );
    await withMockedEnv(
      { ...VALID_ENV, ...absentAgentVars(), AGENT_SERVER_AI_ALLOW_ALL: "1" },
      async () => {
        const env = await importServerEnv();
        expect(env.AGENT_SERVER_AI_ALLOW_ALL).toBe(true);
      },
    );
    await withMockedEnv(
      {
        ...VALID_ENV,
        ...absentAgentVars(),
        AGENT_SERVER_AI_ALLOW_ALL: "false",
      },
      async () => {
        const env = await importServerEnv();
        expect(env.AGENT_SERVER_AI_ALLOW_ALL).toBe(false);
      },
    );
  });

  it("accepts a MODEL_CATALOG_URL override for self-hosted mirrors", async () => {
    await withMockedEnv(
      {
        ...VALID_ENV,
        ...absentAgentVars(),
        MODEL_CATALOG_URL: "http://127.0.0.1:9999/models.json",
      },
      async () => {
        const env = await importServerEnv();
        expect(env.MODEL_CATALOG_URL).toBe("http://127.0.0.1:9999/models.json");
      },
    );
  });

  it("rejects a malformed OPENAI_COMPATIBLE_BASE_URL", async () => {
    await withMockedEnv(
      {
        ...VALID_ENV,
        ...absentAgentVars(),
        OPENAI_COMPATIBLE_BASE_URL: "not-a-url",
      },
      async () => {
        await expect(importServerEnv()).rejects.toThrow(
          /Invalid environment variables/,
        );
      },
    );
  });
});
