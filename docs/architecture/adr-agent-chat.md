# ADR: Agent Chat — browser-owned BYOK agent loop over the webMCP tools

Phase 0 groundwork. Status: accepted. Supersedes none; complements
`adr-webmcp.md` (the tool registry the agent drives — same registry, no
parallel tool surface). The phased execution plan lives in
`PLAN-AGENT-CHAT.md`; the research base is `docs/research/*` (2026-10-04).
Settled decisions D1–D16 of the plan are restated here as architecture;
relitigating them is out of scope for implementation phases.

## Context

The owner asked for an in-app AI agent for the CAD workbench: a chat view
inside the workbench's right sidebar, with full access to every CAD
capability, BYOK multi-provider calls, a models.dev-driven model picker
with zero defaults, and the chat UI published as a shadcn-style registry
component.

Exploration (2026-10-04) established the load-bearing facts. First,
TanStack AI is isomorphic by construction: `chat()` runs in the browser,
and `useChat`'s `stream()` connection adapter wraps a browser-side call
with no server; adapter configs extend the official SDK client options, so
`dangerouslyAllowBrowser`, Anthropic's
`anthropic-dangerous-direct-browser-access` header, and `fetch` overrides
all pass through. Its wire format is AG-UI. It is v0 "RC" with heavy churn
(94 core releases since Dec 2025) and minor-coupled peers. Second, the
BYOK system TanStack ships (`x-byok-*` headers) is a _relay_ — keys cross
to the server — which is precisely what the owner rejected; pure
client-direct BYOK is unsupported-but-unblocked (keep keys in our own
storage, pass them into `create*Chat` factories). Third, models.dev's API
exposes everything the picker needs (modalities, release dates,
deprecation, reasoning options) under MIT. Fourth, this repo already owns
the hard part of tool access: the webMCP registry (`adr-webmcp.md`) binds
11 tools inside the workbench page over the same command paths the UI
uses, with structured diagnostics — the agent reuses it rather than
forking a tool surface. The obvious alternative, the Vercel AI SDK, was
considered and rejected: the agent loop must run browser-direct with BYOK
keys that never cross the server, and TanStack AI is AG-UI-native whereas
Vercel's UI message stream would need a translation layer (mapping in
`docs/research/tanstack-ai.md` §10).

## Decision

1. **The loop runs in the browser; the transport is selectable.** (D1/D2)
   Client-direct mode: the browser calls the provider itself with the
   user's key from local storage — the key never crosses to the slopcad
   server, no pass-through, no exceptions (TanStack's shipped `x-byok-*`
   relay included). Server-emitted mode: the server calls the provider
   with its own env-configured keys; user keys are never used server-side.
   The relay endpoint's input schema has no key field — a zod refine plus
   a handler guard reject key-bearing payloads with 400, and the client
   relay fetcher takes no key parameter; a unit test proves it.

2. **Storage follows the mode.** (D3) Server-emitted chat persists to the
   server DB (`agent_conversations`/`agent_messages`, Drizzle/SQLite).
   Client-emitted chat persists client-only in TanStack DB over WASM
   SQLite (OPFS) with opt-in sync to the server. The OPFS path through
   the production vite/nitro pipeline is proven by the Phase 3.1 spike
   BEFORE persistence glue is written; on failure the fallback stays
   inside this decision (a localStorage-backed adapter for the same
   collections API) and the choice is escalated to the orchestrator/user.

3. **The agent drives the real tools.** (D4) Through the webMCP registry
   (`executeWebMcpTool`) — the command paths the UI uses, executing
   directly on the existing undo stack. There is no propose-then-apply
   execution path; the chat may _display_ executed tool calls as readable
   diffs — display only.

4. **Parity is the audit criterion.** (D11) Every command-surface manifest
   capability maps to a registry tool or to a decline recorded in this
   ADR's gap-audit table (appended by Phase 2.1). `cad_capture_views`
   (D10) captures the live canvas from one view — and CAN capture several
   angles (named presets or arbitrary azimuth/elevation) in a single
   frame-settled call. v1 has no width/height parameters: custom-size and
   offscreen renders are new machinery the current capture path does not
   support (roadmap note, declined for v1).

5. **Nothing preselected, ever.** (D5) No provider, model, or gateway id
   is hardcoded anywhere; "unconfigured" is a distinct type state; the
   picker remembers the user's last selection; a raw model string is
   always typable.

6. **Five providers, provider-scoped catalog.** (D6/D14) OpenRouter,
   OpenAI, Anthropic, Google, and arbitrary OpenAI-compatible (custom
   baseURL). The picker lists only the configured provider's models: the
   four named providers from the models.dev-derived catalog, and
   `openai-compatible` from the endpoint's own `/models` API fetched
   browser-direct with the user's key, degrading to raw-string-only when
   the endpoint has no `/models`. Server env stays optional and
   provider-shaped (`OPENAI_KEY`, `ANTHROPIC_KEY`, `GOOGLE_KEY`,
   `OPENROUTER_KEY`, `OPENAI_COMPATIBLE_KEY` +
   `OPENAI_COMPATIBLE_BASE_URL`): no key, no server mode for that
   provider — no defaults pick a provider, no fallback between providers.

7. **The model catalog comes from models.dev.** (D7) Filtered to
   vision-capable, released within 6 months, non-deprecated (embedding
   families excluded; OpenRouter `~` alias ids stripped; the filter is
   parameterized by time). Server-cached 24 h with `If-None-Match` ETag
   revalidation, stale-on-error, and a force-refresh button.
   `MODEL_CATALOG_URL` (default `https://models.dev/api.json`) makes the
   source self-hostable and lets the e2e harness point it at a loopback
   fixture. models.dev's MIT attribution is retained in the router docs
   and the settings UI.

8. **Effort and system prompt are native, not normalized.** (D8) Effort
   controls emit TanStack AI's per-provider `modelOptions` shapes
   verbatim (OpenAI `reasoning.effort`; Anthropic
   `thinking`/`output_config.effort`; Gemini
   `thinkingConfig.thinkingLevel`; OpenRouter `reasoning.effort`) — no
   normalized enum, no mapping layer. Offered values come from the
   selected model's catalog `reasoning_options`; nothing is offered when
   the model declares none. The system prompt is user-editable; a
   dynamic context block (document state + tool catalogue) is
   auto-appended and marked as such.

9. **Errors report like an LSP.** (D9) Agent tool errors reuse the
   existing structured diagnostics (`{severity, code, message,
location}`) and surface in the SAME UI surfaces users already get —
   status-bar alert, timeline chips, viewport overlay, toasts — AND as
   structured tool results back to the model.

10. **Server AI is gated by a generic per-user option row.** (D13) A
    `user_options(id, userId, name, value, updatedAt)` table, unique on
    (`userId`, `name`): the row `agent.server-ai = "true"` grants; the
    instance env `AGENT_SERVER_AI_ALLOW_ALL` (boolean, default off)
    grants all authenticated users — the self-host posture, also used by
    the e2e harness. Enforcement ships now; how rows get written (admin
    UI, entitlements) is deliberately deferred, and future per-user
    toggles ride the same table. A dedicated single-flag table was
    rejected: one boolean does not justify a schema.

11. **Chat placement: a view inside the RIGHT sidebar.** (D16) Not a new
    dock — a top-of-sidebar switch flips between the sidebar's existing
    content (properties/vars/…) and the chat; the chat replaces the
    content while active, and switching back restores it with state. The
    sidebar becomes user-resizable by drag (the hardcoded width goes
    away; min/max clamped, keyboard-operable) and the size persists with
    the layout state. The chat mounts inside the workbench page so
    `CadProvider` and the WebMCP bindings are alive.

12. **The chat UI ships as a registry component.** (D12) Following the
    `parametric-cad-viewer` pattern: the component never imports the
    app's stores or tRPC client; the host injects transport, tools, and
    catalog via props.

13. **Dependencies enter at latest via pnpm commands.** (D15)
    `pnpm --filter web add …` only — no hand-edited package.json files,
    no lockfile edits, no version pins; resolved versions are recorded
    below for information only. Anything surfaced later by a phase (a
    Phase 3.1 node test adapter; `@ag-ui/core` if the Phase 3.2
    MockProvider constructs AG-UI events directly) enters the same way —
    pnpm strict isolation forbids relying on transitives. All nine
    packages live in `apps/web`: the provider factories, model-options
    builder, runtime hook, tools bridge, relay handler, and persistence
    glue are all web-app modules; `packages/api`'s routers use plain
    fetch and Drizzle and import none of the set.

## Consequences

- Pre-1.0 churn is accepted. `@tanstack/ai-react` peer-couples to
  `@tanstack/ai` minors, so the family upgrades in lockstep, re-reading
  the migration docs each time; D15's unpinned caret ranges are a
  deliberate trade against the May 2026 TanStack-ecosystem supply-chain
  incident, which stays on record — upgrade diffs get reviewed.
- The wire format is AG-UI. Renderers and the Phase 3.2 MockProvider are
  written against TanStack's part model; if raw event constructors are
  needed and `@tanstack/ai` does not re-export them, `@ag-ui/core` is
  added explicitly via pnpm.
- wa-sqlite worker+WASM through vite/nitro is UNPROVEN until the Phase
  3.1 spike: `openBrowserWASQLiteOPFSDatabase` spawns a worker and loads
  WASM, and neither the production bundle path nor OPFS inside the
  session harness's headless Chromium is demonstrated yet; the spike must
  also identify the node-env test adapter for TanStack DB collections.
  For the record: pnpm currently ignores `@journeyapps/wa-sqlite`'s
  postinstall (a PowerSync dynamic-core download); the shipped `dist`
  WASM builds cover the TanStack OPFS adapter's needs, and the spike
  re-verifies — if a dynamic core is ever required, the build must be
  approved explicitly.
- Browser-direct Anthropic/Gemini runtime behavior is verified at the
  type level only (config pass-through per adapter sources; CORS is the
  provider's policy and theirs to enforce). Phase 1.2 verifies the header
  plumbing and records any remaining uncertainty back here; first live
  confirmation happens at real use.
- Server mode degrades loudly, never sideways: a missing per-provider env
  key is a structured per-provider refusal naming the provider — never a
  silent switch to another provider.
- The e2e harness exercises real code paths with zero external network:
  `MODEL_CATALOG_URL` and `OPENAI_COMPATIBLE_BASE_URL` point the
  production code at a loopback fixture server, and
  `AGENT_SERVER_AI_ALLOW_ALL=1` covers the harness's runtime-created user
  (no per-user row seeding).
- The no-defaults audit stays green by construction: a repo grep for
  model-id patterns may return only catalog provider ids, fixtures, and
  documentation.
- Resolved dependency versions (informational, installed 2026-10-04 at
  latest via pnpm — D15):

  | Package                                   | Resolved |
  | ----------------------------------------- | -------- |
  | `@tanstack/ai`                            | ^0.64.0  |
  | `@tanstack/ai-client`                     | ^0.36.1  |
  | `@tanstack/ai-react`                      | ^0.29.4  |
  | `@tanstack/ai-openai`                     | ^0.26.0  |
  | `@tanstack/ai-anthropic`                  | ^0.19.4  |
  | `@tanstack/ai-gemini`                     | ^0.34.2  |
  | `@tanstack/ai-openrouter`                 | ^0.20.2  |
  | `@tanstack/db`                            | ^0.11.3  |
  | `@tanstack/browser-db-sqlite-persistence` | ^0.2.28  |

  Transitive peer auto-resolved by pnpm: `@journeyapps/wa-sqlite` 1.7.2.
