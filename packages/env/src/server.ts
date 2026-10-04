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
    /**
     * Extra origins (comma-separated) that may call the auth API besides
     * `BETTER_AUTH_URL` itself — e.g. reaching the dev server over LAN
     * (`http://192.168.1.41:3001`) while `BETTER_AUTH_URL` stays localhost.
     */
    BETTER_AUTH_TRUSTED_ORIGINS: z.string().optional(),
    /**
     * Agent-chat server vars (docs/architecture/adr-agent-chat.md) — all
     * OPTIONAL. Server-emitted chat (D2) is available for a provider only
     * when that provider's key is present; with no keys at all the server
     * relay mode is simply disabled. Client keys never reach the server
     * (D1) and there is no fallback between providers (D6) — a missing key
     * is a structured per-provider refusal, never a silent switch.
     */
    OPENAI_KEY: z.string().optional(),
    ANTHROPIC_KEY: z.string().optional(),
    GOOGLE_KEY: z.string().optional(),
    OPENROUTER_KEY: z.string().optional(),
    OPENAI_COMPATIBLE_KEY: z.string().optional(),
    /** Base URL of the OpenAI-compatible endpoint used in server mode. */
    OPENAI_COMPATIBLE_BASE_URL: z.url().optional(),
    /**
     * Instance-level posture (D13): when true, every authenticated user
     * may use server-emitted chat without a `user_options` row — the
     * self-host override also used by the e2e harness. Default off.
     */
    AGENT_SERVER_AI_ALLOW_ALL: z.stringbool().default(false),
    /**
     * Source of the model catalog (D7) — the models.dev API by default;
     * point it at a self-hosted mirror (the e2e harness points it at a
     * loopback fixture). models.dev data is MIT-licensed; attribution is
     * retained in the UI that presents it.
     */
    MODEL_CATALOG_URL: z.url().default("https://models.dev/api.json"),
    NODE_ENV: z
      .enum(["development", "production", "test"])
      .default("development"),
  },
  runtimeEnv: process.env,
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,
  emptyStringAsUndefined: true,
});
