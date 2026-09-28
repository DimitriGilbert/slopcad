/**
 * The `/api/health` liveness endpoint: a dependency-free JSON answer the
 * container healthcheck (docker-compose.yml) can poll cheaply, unlike the
 * full SSR homepage. Deliberately does not touch the database — it reports
 * "the server process is up and answering", which is what a restart/health
 * gate should key on.
 */

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/health")({
  server: {
    handlers: {
      GET: (): Response => Response.json({ ok: true }),
    },
  },
});
