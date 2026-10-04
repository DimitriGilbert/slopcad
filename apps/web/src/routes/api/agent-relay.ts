/**
 * The `/api/agent-relay` endpoint (PLAN-AGENT-CHAT Phase 1.5): the
 * server-emitted chat transport's HTTP door. All handling lives in
 * `@/agent/relay` (the io endpoints' file/route split); this route only
 * wires the REAL dependencies — the Better Auth session lookup, the D13
 * access resolver (`@slopcad/api/user-options`'s single `isServerAiAllowed`
 * implementation), the env provider keys, and the global transport — so
 * the handler's gates and streaming stay unit-testable with everything
 * injected.
 */

import { isServerAiAllowed } from "@slopcad/api/user-options";
import { auth } from "@slopcad/auth";
import { db } from "@slopcad/db";
import { env } from "@slopcad/env/server";
import { createFileRoute } from "@tanstack/react-router";

import { handleAgentRelayRequest, type AgentRelayDeps } from "@/agent/relay";

const deps: AgentRelayDeps = {
  getSession: (headers) => auth.api.getSession({ headers }),
  isServerAiAllowed: (userId) =>
    isServerAiAllowed(db, userId, env.AGENT_SERVER_AI_ALLOW_ALL),
  envKeys: {
    openAiKey: env.OPENAI_KEY,
    anthropicKey: env.ANTHROPIC_KEY,
    googleKey: env.GOOGLE_KEY,
    openRouterKey: env.OPENROUTER_KEY,
    openAiCompatibleKey: env.OPENAI_COMPATIBLE_KEY,
    openAiCompatibleBaseUrl: env.OPENAI_COMPATIBLE_BASE_URL,
  },
};

export const Route = createFileRoute("/api/agent-relay")({
  server: {
    handlers: {
      POST: ({ request }: { request: Request }): Promise<Response> =>
        handleAgentRelayRequest(request, deps),
    },
  },
});
