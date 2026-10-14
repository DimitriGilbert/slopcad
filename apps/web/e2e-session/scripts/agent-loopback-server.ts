/**
 * The session harness's loopback agent-fixture server (PLAN-AGENT-CHAT
 * Phase 6, B1): harness tooling ONLY — config/scripts, never a production
 * seam. It serves, on one loopback port, everything the walk's real
 * production code needs with zero external network:
 *
 * - `GET /api.json` — the trimmed models.dev fixture
 *   (`packages/api/src/routers/model-catalog.fixture.json`) that
 *   `MODEL_CATALOG_URL` points the real catalog refresh at. A constant ETag
 *   is advertised but conditional requests are deliberately NOT honored
 *   (always 200), so a force-refresh answers `refetched`, exercising the
 *   router's real fetch/filter/insert path.
 * - `GET /v1/models` — the OpenAI-compatible model list the browser-direct
 *   picker (D14) fetches with the user's key (any `Authorization: Bearer …`
 *   is accepted; none is a 401, the honest endpoint answer).
 * - `POST /v1/chat/completions` — SCRIPTED OpenAI Chat Completions SSE
 *   responses: a text turn, a tool-call turn (what makes the real
 *   browser-resident loop execute a bridged webMCP tool), or an HTTP error
 *   turn. Each POST consumes the next response from a queue the test
 *   scripts through the control API; an unscripted POST is a loud 500, not
 *   a silent repeat — a walk bug must be visible.
 *
 * The control API (test-only, plain loopback JSON):
 * `POST /__script` (enqueue responses), `GET /__calls` (the recorded
 * chat-completions requests — the D1/D2 evidence: the RELAY's calls must
 * carry the env key, never the browser's), `POST /__reset`.
 *
 * CORS: the browser page (localhost) calls this server (127.0.0.1)
 * cross-origin in client-direct mode, so every /v1 + /api.json response
 * carries the open CORS headers and OPTIONS preflights answer 204.
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** One scripted SSE chat-completions response: text, tool call, or error. */
export type AgentFixtureResponse =
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "tool-call";
      readonly name: string;
      /** The call's arguments object; JSON-serialized onto the wire. */
      readonly input: unknown;
    }
  | {
      readonly kind: "http-error";
      readonly status: number;
      readonly message: string;
    };

/** Narrowing guard for control-API payloads (the wire is untrusted JSON). */
function isAgentFixtureResponse(value: unknown): value is AgentFixtureResponse {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "text") {
    return typeof candidate.text === "string";
  }
  if (candidate.kind === "tool-call") {
    return (
      typeof candidate.name === "string" &&
      typeof candidate.input === "object" &&
      candidate.input !== null
    );
  }
  return (
    candidate.kind === "http-error" &&
    typeof candidate.status === "number" &&
    typeof candidate.message === "string"
  );
}

/** One recorded chat-completions request, as the walk asserts over. */
export interface AgentFixtureCall {
  readonly index: number;
  /** The Authorization header verbatim (the D1/D2 key-custody evidence). */
  readonly authorization: string | null;
  /** The request model id. */
  readonly model: string;
  /** The message roles in order (a `tool` role proves a client tool ran). */
  readonly roles: readonly string[];
  /** True when the request carried OpenAI tool definitions. */
  readonly declaredTools: boolean;
}

/** The trimmed fixture, served verbatim from the committed api fixture. */
const FIXTURE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../packages/api/src/routers/model-catalog.fixture.json",
);

/** The endpoint's own model list (D14): deliberately vendor-neutral ids. */
const ENDPOINT_MODEL_IDS = ["fixture-primary", "fixture-secondary"] as const;

const CORS_BASE_HEADERS: Readonly<Record<string, string>> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-max-age": "86400",
};

/**
 * The per-response CORS headers. `access-control-allow-headers` reflects
 * the preflight's OWN ask: the OpenAI SDK rides a stack of
 * `x-stainless-*` instrumentation headers on every request, and any
 * fixed allow-list would refuse the next SDK's next header mid-walk.
 */
function corsHeaders(request: IncomingMessage): Record<string, string> {
  const asked = request.headers["access-control-request-headers"];
  return {
    ...CORS_BASE_HEADERS,
    "access-control-allow-headers":
      typeof asked === "string" && asked.length > 0
        ? asked
        : "authorization, content-type",
  };
}

/** One OpenAI chat.completion.chunk, the only SSE payload this server emits. */
interface ChatChunkDelta {
  readonly role?: string;
  readonly content?: string;
  readonly tool_calls?: readonly {
    readonly index: number;
    readonly id?: string;
    readonly type?: string;
    readonly function: { readonly name?: string; readonly arguments?: string };
  }[];
}

function chatChunk(
  model: string,
  delta: ChatChunkDelta,
  finishReason: string | null,
): string {
  return JSON.stringify({
    id: "chatcmpl-agent-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

/** The SSE-producing half of the script (everything but the HTTP errors). */
export type AgentFixtureSseResponse = Exclude<
  AgentFixtureResponse,
  { readonly kind: "http-error" }
>;

/** The SSE body of one scripted response. */
function sseBodyOf(response: AgentFixtureSseResponse, model: string): string {
  if (response.kind === "text") {
    return [
      `data: ${chatChunk(model, { role: "assistant", content: response.text }, null)}`,
      `data: ${chatChunk(model, {}, "stop")}`,
      "data: [DONE]",
      "",
    ].join("\n\n");
  }
  return [
    `data: ${chatChunk(
      model,
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_agent_fixture",
            type: "function",
            function: {
              name: response.name,
              arguments: JSON.stringify(response.input),
            },
          },
        ],
      },
      null,
    )}`,
    `data: ${chatChunk(model, {}, "tool_calls")}`,
    "data: [DONE]",
    "",
  ].join("\n\n");
}

export interface AgentLoopbackServer {
  readonly server: Server;
  readonly port: number;
  /** Stops accepting connections and closes idle sockets. */
  readonly close: () => Promise<void>;
}

export interface AgentLoopbackServerOptions {
  readonly port: number;
  /** Bind host; the default is loopback only. */
  readonly host?: string;
}

/** Starts the fixture server. Rejects on bind errors (a taken port is loud). */
export function startAgentLoopbackServer(
  options: AgentLoopbackServerOptions,
): Promise<AgentLoopbackServer> {
  const fixtureBytes = readFileSync(FIXTURE_PATH, "utf8");
  const queue: AgentFixtureResponse[] = [];
  const calls: AgentFixtureCall[] = [];

  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      response.destroy(
        error instanceof Error ? error : new Error(String(error)),
      );
    });
  });

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    if (request.method === "OPTIONS") {
      response.writeHead(204, corsHeaders(request));
      response.end();
      return;
    }

    if (path === "/api.json" && request.method === "GET") {
      response.writeHead(200, {
        ...corsHeaders(request),
        "content-type": "application/json",
        etag: '"agent-fixture-v1"',
        "cache-control": "no-cache",
      });
      response.end(fixtureBytes);
      return;
    }

    if (path === "/v1/models" && request.method === "GET") {
      const authorization = request.headers.authorization ?? null;
      if (authorization === null || !authorization.startsWith("Bearer ")) {
        response.writeHead(401, corsHeaders(request));
        response.end(
          JSON.stringify({
            error: { message: "A bearer key is required." },
          }),
        );
        return;
      }
      response.writeHead(200, {
        ...corsHeaders(request),
        "content-type": "application/json",
      });
      response.end(
        JSON.stringify({
          object: "list",
          data: ENDPOINT_MODEL_IDS.map((id) => ({ id, object: "model" })),
        }),
      );
      return;
    }

    if (path === "/v1/chat/completions" && request.method === "POST") {
      const authorization = request.headers.authorization ?? null;
      const rawBody = await readBody(request);
      const body = parseJson(rawBody);
      const model =
        typeof body?.model === "string" && body.model.length > 0
          ? body.model
          : "fixture-unknown";
      const roles = messageRolesOf(body?.messages);
      const tools = body?.tools;
      calls.push({
        index: calls.length,
        authorization,
        model,
        roles,
        declaredTools:
          Array.isArray(tools) &&
          tools.length > 0 &&
          typeof tools[0] === "object" &&
          tools[0] !== null,
      });
      const next = queue.shift();
      if (next === undefined) {
        response.writeHead(500, {
          ...corsHeaders(request),
          "content-type": "application/json",
        });
        response.end(
          JSON.stringify({
            error: {
              message:
                "agent fixture: no scripted response was queued for this chat completion",
            },
          }),
        );
        return;
      }
      if (next.kind === "http-error") {
        response.writeHead(next.status, {
          ...corsHeaders(request),
          "content-type": "application/json",
        });
        response.end(JSON.stringify({ error: { message: next.message } }));
        return;
      }
      response.writeHead(200, {
        ...corsHeaders(request),
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      });
      response.end(sseBodyOf(next, model));
      return;
    }

    if (path === "/__script" && request.method === "POST") {
      const body = parseJson(await readBody(request));
      const rawResponses = Array.isArray(body?.responses) ? body.responses : [];
      const validated: AgentFixtureResponse[] = [];
      for (const entry of rawResponses) {
        if (!isAgentFixtureResponse(entry)) {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({ error: { message: "malformed response script" } }),
          );
          return;
        }
        validated.push(entry);
      }
      // `replace: true` swaps the queue (stage isolation — a prior stage's
      // unconsumed script can never leak into the next one's runs); the
      // default appends.
      if (body?.replace === true) {
        queue.length = 0;
      }
      for (const entry of validated) {
        queue.push(entry);
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ queued: validated.length }));
      return;
    }

    if (path === "/__calls" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ calls }));
      return;
    }

    if (path === "/__reset" && request.method === "POST") {
      queue.length = 0;
      calls.length = 0;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ reset: true }));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: `no ${path}` } }));
  }

  return new Promise<AgentLoopbackServer>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      reject(
        new Error(
          `the agent fixture server could not bind port ${String(options.port)}: ${error.message}`,
          { cause: error },
        ),
      );
    });
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      resolve({
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => {
              if (error === undefined) {
                done();
              } else {
                fail(error);
              }
            });
          }),
        port: options.port,
        server,
      });
    });
  });
}

/** Reads one request body to a string (bounded — chat bodies are small). */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
      if (body.length > 8_000_000) {
        rejectBody(new Error("agent fixture: request body exceeded 8 MB"));
        request.destroy();
      }
    });
    request.on("end", () => {
      resolveBody(body);
    });
    request.on("error", (error: Error) => {
      rejectBody(error);
    });
  });
}

/** Parses JSON into a record, null on anything unparsable or non-object. */
function parseJson(raw: string): Record<string, unknown> | null {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** Narrows an unknown value into a plain string-keyed record. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** The `role` of every object message in the array, "?" for odd entries. */
function messageRolesOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => {
    const role = asRecord(entry)?.role;
    return typeof role === "string" ? role : "?";
  });
}
