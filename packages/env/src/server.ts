import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * The documented dev-only placeholder from `.env.example` (the README's
 * setup step): a well-formed 54-character string, so the length rule alone
 * would happily accept it as a production secret. A deployment that ships
 * it has skipped the template's own instruction ("replace it with a fresh
 * `openssl rand -base64 32` for any shared deployment") — validation fails
 * fast in production instead of authenticating real traffic with a
 * publicly-known key. Development keeps accepting it (copy-paste setup
 * must keep working).
 */
export const DEV_ONLY_PLACEHOLDER_BETTER_AUTH_SECRET =
  "dev-only-placeholder-replace-with-openssl-rand-base64-32";

export const env = createEnv({
  server: {
    DATABASE_URL: z.string().min(1),
    BETTER_AUTH_SECRET: z
      .string()
      .min(32)
      .refine(
        (value) =>
          process.env.NODE_ENV !== "production" ||
          value !== DEV_ONLY_PLACEHOLDER_BETTER_AUTH_SECRET,
        {
          message:
            "BETTER_AUTH_SECRET is still the .env.example dev-only placeholder; generate a real secret (openssl rand -base64 32) before running in production.",
        },
      ),
    BETTER_AUTH_URL: z.url(),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
