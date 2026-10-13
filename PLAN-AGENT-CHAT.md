# Plan: Agent Chat Surface for slopcad

In-app AI agent for the CAD workbench: a chat view inside the workbench's RIGHT
sidebar (a top-of-sidebar button switches between the sidebar's existing content —
properties/vars/… — and the chat), driven by **TanStack AI**
(not the Vercel AI SDK), with BYOK multi-provider calls where **the browser calls the
provider directly**, an optional server-relay mode for server-emitted chat, full agent
access to every CAD tool through the webMCP registry, one-call-capable multi-angle
image feedback, LSP-style error reporting, a models.dev-driven model picker with zero
defaults, and the chat UI published as a shadcn-style registry component.

Executed with the subagent-orchestration protocol: 1 implementer → 1 validator per
phase (fixer loop up to 3 attempts), NO-SLOP policy pasted into every dispatch,
`pnpm run verify` as the gatekeeping command every implementer runs before reporting
done. The orchestrator never writes code.

**Provenance:** strengthened after the adversarial review
(`docs/research/plan-adversarial-review.md`): findings B1, M1–M6, m1–m9 all adopted;
phases re-split to respect the ≤ ~500 LOC sizing guidance; Phase 6's test strategy
redesigned around the real session-harness machinery.

## Settled decisions (user-confirmed — do not relitigate)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Client-side AI = browser calls the provider itself.** The user's key lives in browser storage and never crosses to the slopcad server. No pass-through, no exceptions.                                                                                                                                                                                                                                                                                                                           |
| D2  | **Two call modes.** Client-direct (D1) and server-emitted: the server calls the provider using its own env-configured keys. User keys are never used server-side.                                                                                                                                                                                                                                                                                                                                  |
| D3  | **Storage follows the mode.** Server-emitted chat → server DB (Drizzle/SQLite). Client-emitted chat → TanStack DB persisted on WASM SQLite (OPFS), client-only, with an opt-in sync to the server.                                                                                                                                                                                                                                                                                                 |
| D4  | **The agent uses the real tools** — the webMCP registry (`executeWebMcpTool`) and the command paths the UI uses. Missing capabilities are added as new registry tools. Direct execution on the existing undo stack; **no propose-then-apply execution path**. The chat UI may _display_ executed tool calls as readable diffs — display only.                                                                                                                                                      |
| D5  | **Nothing preselected, ever.** No provider, model, or gateway id hardcoded anywhere in code. The picker remembers the user's last selection. A raw model string is always typable.                                                                                                                                                                                                                                                                                                                 |
| D6  | **Providers:** OpenRouter, OpenAI, Anthropic, Google, and arbitrary OpenAI-compatible (custom baseURL).                                                                                                                                                                                                                                                                                                                                                                                            |
| D7  | **Model catalog from models.dev**, filtered to vision-capable + released within 6 months + non-deprecated; cached server-side 24h with ETag revalidation, stale-on-error, and a force-refresh button. MIT attribution retained.                                                                                                                                                                                                                                                                    |
| D8  | **Effort level and system prompt are first-class user controls, shaped exactly the way TanStack AI shapes them.** Effort controls build TanStack AI's native per-provider `modelOptions` directly — no normalized enum, no custom mapping layer; offered values come from the model's models.dev `reasoning_options`. The system prompt is user-editable; a dynamic context block (document state + tool catalogue) is auto-appended and marked as such.                                           |
| D9  | **Errors report like an LSP:** agent tool errors reuse the existing structured diagnostics (`{severity, code, message, location}`) and surface in the SAME UI surfaces users already get — status-bar alert, timeline chips, viewport overlay, toasts — AND as structured tool results back to the model.                                                                                                                                                                                          |
| D10 | **Image feedback:** `cad_capture_views` captures the current object from one view — and CAN capture several angles in a single call when asked (named presets + arbitrary azimuth/elevation), frame-settled. Multiple angles per call is an option, not a requirement.                                                                                                                                                                                                                             |
| D11 | **Everything the user can do is available to the agent.** The audit criterion is parity with the user-facing command-surface manifest: all command types, assemblies, creating and setting `$`-variables, projects, diagnostics, snapshots — everything. If a user can do it, the agent gets a tool for it; anything missing is added as a tool.                                                                                                                                                   |
| D12 | **The chat UI becomes a registry component** following the existing `parametric-cad-viewer` registry pattern; the host app injects transport and tools.                                                                                                                                                                                                                                                                                                                                            |
| D13 | **Server AI is per-user gated via a generic `user_options(id, userId, name, value, …)` table** — a row `agent.server-ai = "true"` grants it. No dedicated table for a single flag. Enforcement ships now; how rows get written (admin UI, entitlements, …) is deliberately deferred, and future per-user toggles ride the same table. An instance-level env override `AGENT_SERVER_AI_ALLOW_ALL` (default off) grants all authenticated users — a self-host posture, also used by the e2e harness. |
| D14 | **The model catalog is provider-scoped:** the picker only ever lists models for the user's configured provider — never an aggregated cross-provider list. For `openai-compatible`, the list comes from the configured endpoint's own `/models` API (fetched browser-direct with the user's key); raw-string input is the fallback only when an endpoint has no `/models`.                                                                                                                          |
| D15 | **Dependencies install at latest via pnpm commands** (`pnpm --filter <pkg> add <dep>`). No manual package.json edits, no version pinning; resolved versions are recorded in the ADR for information only.                                                                                                                                                                                                                                                                                          |
| D16 | **Chat placement:** the agent chat lives in the workbench's RIGHT sidebar as a view, not a new dock — a button at the top of the sidebar switches between the sidebar's current content (properties/vars/…) and the chat. The chat replaces the sidebar content while active; the sidebar itself is USER-RESIZABLE by drag (no hardcoded width) with the size persisted.                                                                                                                           |

## Prerequisites

- **Research docs (written 2026-10-04, read before implementing):**
  - `docs/research/slopcad-internals-for-agent.md` — repo map: webMCP registry, command paths, snapshot machinery, diagnostics, registry pattern, layout, test constraints
  - `docs/research/tanstack-ai.md` — package names, browser-BYOK pass-through flags, tool API, effort params, SSE patterns, TanStack DB persistence (versions there are a research snapshot, NOT install targets — D15)
  - `docs/research/models-dev-api.md` — exact schema fields, filter recipe, ETag/caching design, licensing
  - `docs/research/chatbot-template-map.md` — copy/rewrite/drop classification (see its post-review addendum: five "port" files already exist in `packages/ui`)
  - `docs/research/cad-agent-landscape.md` — competitive bar + edge features (informs the base system prompt and UI polish only)
  - `docs/research/plan-adversarial-review.md` — evidence for every constraint below marked (B#/M#/m#)
- **Reference template clone:** `/tmp/chatbot-template` (MIT) — copy sources only per the map doc + addendum.
- **Existing code this plan builds on** (all file/API claims verified by the review):
  `apps/web/src/webmcp/registry.ts` (`executeWebMcpTool`, `defineWebMcpTool`), the 11
  tools (8 in `workbench-tools.ts`, 3 in `projects-tools.ts`),
  `cad-core/src/command.ts` (`parseCommand`, 17 `CAD_COMMAND_TYPES`),
  `cad-react/src/store.ts` (`applyTransaction`), `snapshot-export.ts`
  (`waitForRenderedFrame`, `captureViewportPng` — live-canvas capture only),
  `cad-core/src/diagnostics.ts`, workbench layout + docks (`complete-workbench.tsx`),
  the WebMCP binding lifetime (`use-webmcp-tools.ts`, bound inside the workbench page),
  `packages/api/src/routers/index.ts` (router factory composition), `packages/db`
  (migrations, `createInMemoryDb` — **unit tests only; unavailable to the session
  harness**, which boots the real production server + real SQLite file),
  `apps/web/e2e-workbench/command-surface.checklist.json` (53 entries, exact-match
  both directions), `apps/web/e2e-session/` (ONE user / ONE context contract;
  `WORKBENCH_WEBMCP_TOOLS` + stage s27 pin the exact tool list),
  `packages/ui/src/components/` (message, bubble, message-scroller, input-group,
  empty already shipped — template lineage), Formedible (password, textarea, async
  autocomplete with race guard, conditional fields — the settings form is expressible
  as config), registry tooling (`registry:build|validate|regenerate`,
  `scripts/cad-registry-matrix.sh`).
- **New dependencies — installed at LATEST via pnpm commands only (D15), never by
  hand-editing package.json:** `@tanstack/ai`, `@tanstack/ai-react`,
  `@tanstack/ai-client`, `@tanstack/ai-openai`, `@tanstack/ai-anthropic`,
  `@tanstack/ai-gemini`, `@tanstack/ai-openrouter`, `@tanstack/db`,
  `@tanstack/browser-db-sqlite-persistence` (+ its `@journeyapps/wa-sqlite` peer,
  auto-resolved). `@ag-ui/core` is added explicitly (pnpm add) IF Phase 3.2's
  MockProvider constructs AG-UI events directly rather than via `@tanstack/ai`
  re-exports — pnpm strict isolation forbids relying on transitives (m5). Any
  node-test persistence package surfaced by the Phase 3.1 spike is added the same way.
- **Test constraints that shape implementation (m1):** unit tests stub `fetch` to
  throw (all provider transports injectable; the catalog service mocks its fetch).
  apps/web's vitest config defaults to jsdom env, so every agent-logic test file
  colocated there carries a `// @vitest-environment node` docblock — no new
  jsdom-dependent tests are written; UI behavior is verified in the browser e2e
  (session harness, production build, SwiftShader). Every new user-facing command
  must enter the command-surface manifest (exact-match gate) and the session walk,
  or `pnpm test:session` fails.

---

## Phase 0: ADR + dependency installation

**Type**: Sequential (small)

**Requirements**:

- Write `docs/architecture/adr-agent-chat.md` following the conventions of
  `docs/architecture/adr-simulation.md`: context, decision (loop runs in the browser
  with selectable transport: client-direct vs server relay; D1–D15 table above),
  alternatives considered and rejected (Vercel AI SDK, key pass-through,
  propose-then-apply execution, normalized-effort abstraction, dedicated flag table),
  consequences (pre-1.0 churn accepted — latest via pnpm per D15, lockstep peer-risk
  recorded; AG-UI protocol; wa-sqlite worker+WASM through vite/nitro to be proven by
  the Phase 3.1 spike). Record resolved dependency versions informationally.
- Install the new `@tanstack/*` dependencies at latest with pnpm commands
  (`pnpm --filter web add ...`, `pnpm --filter @slopcad/api add ...` from the repo
  root). Zero manual edits to package.json files or lockfiles.
- Extend `@slopcad/env` with OPTIONAL server vars: provider keys `OPENAI_KEY`,
  `ANTHROPIC_KEY`, `GOOGLE_KEY`, `OPENROUTER_KEY`, `OPENAI_COMPATIBLE_BASE_URL` /
  `OPENAI_COMPATIBLE_KEY` (server supports all five providers — D6/D2);
  `AGENT_SERVER_AI_ALLOW_ALL` (boolean, default false — D13 instance posture);
  `MODEL_CATALOG_URL` (default `https://models.dev/api.json` — self-hostable mirror,
  also used by the e2e harness). All optional; absence of provider keys = server mode
  disabled. No defaults that pick providers, no fallbacks between providers.

**Inputs**: Read: `docs/research/tanstack-ai.md`, `docs/architecture/adr-simulation.md`.

**Outputs**:

- Create: `docs/architecture/adr-agent-chat.md`
- Modify: `apps/web/package.json`, `packages/api/package.json` (by pnpm commands
  only — the git diff must show pnpm-style ranges, not hand-written pins),
  `packages/env/src/*.ts` (env schema)

**Validation Criteria**:

- `pnpm install` clean from repo root; `pnpm run verify` green
- Dependency additions came from `pnpm --filter ... add ...` (no manual version edits)
- Env schema rejects nothing that previously passed (all new vars optional)

**Dependencies**: None (first phase)

---

## Phase 1: Foundations

**Type**: Parallel — five sub-phases; 1.1, 1.2, 1.4 start together; 1.3 after 1.2
(types); 1.5 after 1.4. Each sub-phase gets implementer → validator, then a
phase-wide validator. Splits per review M5 (~LOC: 1.1 ≈ 400, 1.2 ≈ 450, 1.3 ≈ 350,
1.4 ≈ 350, 1.5 ≈ 300).

### 1.1: models.dev catalog service

**Requirements**:

- Drizzle table `model_catalog_entries` in `packages/db`: `provider` (string id),
  `modelId`, `name`, `releaseDate` (string `YYYY-MM-DD`), `vision` (bool),
  `contextLimit` (int nullable), `reasoningOptions` (JSON), `deprecated` (bool),
  `fetchedAt` — plus a `model_catalog_meta` row (`provider`, `etag`, `fetchedAt`).
  Migration generated via `pnpm db:generate` (never hand-edit migration SQL).
- tRPC router `modelCatalog` in `packages/api` (registered in `routers/index.ts`,
  `protectedProcedure`):
  - `list({ provider })` → filtered entries; empty array (not an error) when the
    provider has no cache yet
  - `refresh({ provider, force })` → refetch `MODEL_CATALOG_URL` (env, default
    models.dev) server-side with `If-None-Match` ETag (304 ⇒ keep rows, bump
    `fetchedAt`), TTL 24h unless `force`, stale-on-error (upstream failure keeps
    last good rows)
  - `providers()` → which of the 5 supported providers exist in the catalog
- **Provider scoping (D14):** `list({ provider })` is the picker's model source for
  the four named providers — entries for the user's configured provider alone;
  nothing in the API or UI aggregates models across providers. `openai-compatible`
  is served client-side instead (Phase 1.2): `list` returns an empty array for it.
- Filter per `docs/research/models-dev-api.md` §4, parameterized by time (M4):
  the filter takes `now: Date`; production passes `new Date()`, tests pin `now` to
  the fixture's capture date. Rules: `"image" in modalities.input[]`,
  `release_date ≥ now − 6 months`, `!deprecated`, exclude embedding families (the
  `gemini-embedding-2` gotcha), strip OpenRouter `~` alias ids.
- **Trimmed committed fixture (M4):** NOT the 5.3 MB live payload. A hand-trimmed
  fixture containing only the 4 named providers' model objects plus crafted entries
  preserving the gotchas (embedding false-positive, `~` alias, a deprecated entry),
  well under 1 MB, with its capture date recorded inside it. Expected-count
  assertions are computed from a fixture run at implementation time and pinned with
  the pinned `now`.
- MIT attribution for models.dev data in the router module docs and the settings UI
  footnote (Phase 4.5).
- Unit tests (node env): filter logic against the trimmed fixture (fetch mocked),
  TTL/ETag/force/stale-on-error paths, routers against `createInMemoryDb()`.

**Outputs**: Create: `packages/db/src/schema.ts` additions, generated migration,
`packages/api/src/routers/model-catalog.ts` + tests, fixture file. Modify:
`packages/api/src/routers/index.ts`.

**Validation**: Unit tests green with fetch mocked; zero network; `pnpm run verify` green.

### 1.2: Provider factories + openai-compatible model discovery

**Requirements**:

- `apps/web/src/agent/providers/`: one module per provider (openrouter, openai,
  anthropic, google, openai-compatible) each exporting a factory building the
  TanStack AI adapter from `{ apiKey, baseURL?, fetch? }` per
  `docs/research/tanstack-ai.md` §2–3 (review-verified: adapter configs extend the
  SDK client options, so `fetch` overrides, `dangerouslyAllowBrowser` for
  OpenAI/OpenAI-compatible, and Anthropic's
  `anthropic-dangerous-direct-browser-access` header pass through). Anthropic and
  Gemini browser-direct runtime behavior is type-level inference (review UNVERIFIED
  #1) — implementer verifies the header/plumbing and records remaining uncertainty
  in the ADR; first live confirmation happens at real use.
- **Injectable transport:** every factory takes a `fetch` override (default
  `globalThis.fetch`); tests and the session e2e inject a mock. No call site uses a
  non-injected fetch.
- **Model discovery for `openai-compatible` (D14):** `listModels({ baseURL, apiKey, fetch })`
  queries the endpoint's own OpenAI-compatible `GET {baseURL}/models` browser-direct
  and normalizes the standard `{ data: [{ id }] }` rows. No vision/date filtering is
  possible there — list shows as-is, raw model string stays primary. Any failure
  (no `/models`, CORS, auth) degrades to raw-string-only, surfaced inline, never an
  error wall.
- No provider or model string literal exists in these modules except the catalog
  provider ids.

**Outputs**: Create: `apps/web/src/agent/providers/*.ts` (5 + index) + tests.

**Validation**: Adapter construction tests (transport injected, key applied to
provider not our origin, browser flags per provider); `listModels` tests (fixture
success, empty `data`, fetch failure → raw-string-only). `pnpm run verify` green.

### 1.3: Client config store + native model-options builder

**Requirements**:

- Config storage `apps/web/src/agent/config/`: localStorage-backed, namespaced store
  for `{ provider?, apiKeyByProvider, modelId?, reasoning?, systemPrompt?, mode,
syncEnabled, maxIterations }`. `provider`/`modelId` are `null` until chosen (D5) —
  "unconfigured" is a distinct type state. Keys are only ever read by the provider
  factories; the relay fetcher (1.5) takes no key parameter at all.
- Model-options builder `apps/web/src/agent/model-options.ts` (D8): emits the
  provider's NATIVE `modelOptions` shapes verbatim per `docs/research/tanstack-ai.md`
  §7 (OpenAI `reasoning.effort`, Anthropic `thinking.budget_tokens` /
  `output_config.effort`, Gemini `thinkingConfig.thinkingLevel`, OpenRouter
  `reasoning.effort`) — no normalized enum, no custom mapping layer. Offered values
  come from the selected model's catalog `reasoning_options` (`values[]` for
  effort-type, ranges for budget-type); nothing offered when the model declares none,
  nothing preselected.

**Outputs**: Create: `apps/web/src/agent/config/*.ts`, `apps/web/src/agent/model-options.ts` + tests.

**Validation**: Config round-trip + "never defaults provider/model" tests;
model-options builder tests (native shapes per provider; values restricted to catalog
`reasoning_options`; nothing offered when unsupported). `pnpm run verify` green.

### 1.4: DB schema + conversation persistence + serverProviders

**Requirements**:

- Drizzle table `user_options` (D13): (`id` PK, `userId` FK → `user` — the repo's
  auth table is `user`, singular, `packages/db/src/schema/auth.ts` (m8) —
  `name` string, `value` TEXT, `updatedAt`), unique(`userId`, `name`) + migration —
  a GENERIC per-user key/value store, not a dedicated flag table. Server AI is gated
  by the row `name = "agent.server-ai"`, `value = "true"`, OR the instance env
  `AGENT_SERVER_AI_ALLOW_ALL` (D13). Typed read accessor ships now; no write path
  until the toggle UX is decided.
- Drizzle tables: `agent_conversations` (`id`, `userId` → `user`, `projectId`
  nullable, `title`, `createdAt`, `updatedAt`) and `agent_messages` (`id`,
  `conversationId`, `role`, `parts` JSON, `createdAt`) + migration. Server-emitted
  chat only (D3).
- tRPC router `agentConversations` (`protectedProcedure`): `list`, `create`, `append`
  (zod-validated parts), `delete`.
- tRPC query `serverProviders()`: which providers have env keys configured AND
  whether the caller is server-AI-allowed (row or allow-all env); drives UI
  availability of server mode.
- Unit tests against `createInMemoryDb()`: routers; access resolution
  (row / allow-all / neither).

**Outputs**: Create: schema additions + migrations, `packages/api/src/routers/agent-conversations.ts` (+ `serverProviders`) + tests. Modify: `packages/api/src/routers/index.ts`.

**Validation**: Unit tests green; `pnpm run verify` green.

### 1.5: Server relay endpoint

**Requirements**:

- TanStack Start server function under `apps/web/src/routes/api/` accepting
  `{ provider, modelId, modelOptions, messages }` — **no key field exists in the
  input schema**; a zod refine + handler guard rejects any payload carrying
  `apiKey`-like fields with 400. Builds the server-side adapter from env keys
  (Phase 0), streams via `toServerSentEventsResponse` per
  `docs/research/tanstack-ai.md` §8, coexists with tRPC.
- Access order: caller's `user_options` row `agent.server-ai = "true"` OR
  `AGENT_SERVER_AI_ALLOW_ALL` — otherwise structured 403 (D13). Then provider env
  key present — otherwise structured 4xx naming the missing provider, never a
  fallback to another provider.
- **E2E seam (B1):** the relay itself needs NO mock injection — the harness points
  `OPENAI_COMPATIBLE_BASE_URL` at a loopback mock-SSE server (harness tooling,
  Phase 6) and exercises the real code path. Document this in the ADR.
- Unit tests (fetch/adapter mocked at the handler boundary — no network): the
  apiKey-rejection test; missing-env-key test; access-gating tests (no row + no
  allow-all → 403; allow-all env → pass; row → pass).

**Outputs**: Create: `apps/web/src/routes/api/agent-relay.*` (+ handler module) + tests.

**Validation**: All unit tests green, zero network; relay input schema provably has
no key field. `pnpm run verify` green.

**Phase-level Validation (after all sub-phases pass individually)**:

- Phase-wide validator reads everything together: no duplicate provider-id literals,
  catalog `reasoningOptions` types (1.1) == consumer types (1.3), relay part types
  forward-compatible with Phase 3, no key field anywhere in client→server surfaces.
- `pnpm run verify` green across the monorepo.

**Dependencies**: Phase 0 must complete successfully.

---

## Phase 2: Agent tools — webMCP extensions + TanStack AI bridge

**Type**: Sequential sub-phases (M5 splits: 2.1 ≈ 350, 2.2 ≈ 300, 2.3 ≈ 250).

### 2.1: Gap audit + `cad_capture_views`

**Requirements**:

- **Gap audit** (result appended as a table to `docs/architecture/adr-agent-chat.md`):
  compare the existing 11 webMCP tools against D11's parity criterion — EVERY entry
  of the user-facing command-surface manifest (`command-surface.checklist.json`)
  plus non-palette capabilities: 17 command types, assemblies (occurrence trees, 3
  workbenches), `$`-variable CREATION and set/get, projects, diagnostics.
- `cad_capture_views` (D10): input `{ views: Array<{ preset?: "front"|"top"|"right"|"iso", azimuth?: number, elevation?: number }> }`
  — the common case is ONE view; several angles CAN be requested in the same call.
  Extends the snapshot exporter's camera math and `waitForRenderedFrame` settle;
  captures the LIVE canvas (`captureViewportPng`) — no `width`/`height` params in
  v1: custom-size/offscreen renders are new machinery the current path does not
  support (m9; recorded as a roadmap note in the ADR). Returns
  `{ name, mimeType: "image/png", data }` TanStack AI image content parts — one per
  requested view.
- Every new tool follows the registry pattern (zod v4 input, JSON-schema derivation,
  never-throws `execute`, diagnostics-shaped errors — D9 — which ALSO surface in the
  existing status-bar/timeline/toast UIs).
- **s27 pin (M2):** any tool added here updates `WORKBENCH_WEBMCP_TOOLS` and stage
  s27's expected snapshot in `apps/web/e2e-session/session.spec.ts`, and documents
  its binding site: CAD tools bind inside the workbench page
  (`useWorkbenchWebMcpTools`), where `CadProvider` and the store are alive.
- Node-env unit tests (angle math + result shape with the snapshot fn mocked; no
  WebGL in unit tests).

**Outputs**: Modify: `apps/web/src/webmcp/workbench-tools.ts` (or sibling tool files
per existing organization), `apps/web/e2e-session/session.spec.ts` (s27 + tool list),
`docs/architecture/adr-agent-chat.md` (audit table). Create: colocated tests.

**Validation**: `executeWebMcpTool` dispatches the new tool; one image for a single
view, N for N views (mocked snapshot); bad input → diagnostics-shaped error, never
throws; s27 updated. `pnpm run verify` green.

### 2.2: Remaining audited tools

**Requirements**:

- Implement every tool the 2.1 audit flagged missing against D11 parity (expected at
  minimum: `cad_get_document` — workbench, feature tree outline, parameter
  names/values, selection, assembly occurrences, compact and model-oriented;
  `cad_get_diagnostics`; `$`-variable create/set if not already covered by existing
  tools; assembly-level operations per the audit). Same registry pattern, same
  diagnostics error contract, same s27 update discipline.
- Node-env unit tests per tool.

**Outputs**: Modify: webMCP tool files, `session.spec.ts` (s27), ADR (audit table
check-offs). Create: colocated tests.

**Validation**: Audit table fully checked (every manifest capability maps to a tool
or an explicit ADR-recorded decline with reason); `pnpm run verify` green.

### 2.3: TanStack AI bridge

**Requirements**:

- `apps/web/src/agent/tools.ts`: webMCP registry entry → TanStack AI
  `toolDefinition` (`.client()` implementations — the loop runs in the browser per
  the ADR; input schema reused, output schema where it adds value),
  `emitCustomEvent` progress on multi-step tools, `needsApproval: false` (D4).
- Node-env unit tests: bridge drives `executeWebMcpTool` and maps results/errors to
  TanStack AI result parts.

**Outputs**: Create: `apps/web/src/agent/tools.ts` + tests.

**Validation**: `pnpm run verify` green.

**Dependencies**: Phase 1 must complete successfully.

---

## Phase 3: Chat runtime — spike, mock, loop, persistence

**Type**: Sequential sub-phases (M5/M6: 3.1 spike, 3.2 ≈ 200, 3.3 ≈ 350, 3.4 ≈ 350).

### 3.1: Build spike — TanStack DB persistence through the real pipeline (M6)

**Requirements**:

- Timeboxed spike, results recorded in the ADR BEFORE any persistence glue is
  written: (a) prove `openBrowserWASQLiteOPFSDatabase` +
  `createBrowserWASQLitePersistence` load and persist through the TanStack Start
  `vite build`/nitro production pipeline (worker + wa-sqlite WASM bundle); (b) prove
  OPFS works inside the session harness's headless Chromium (secure context is
  satisfied at localhost — verify storage actually persists across a reload);
  (c) identify the node-env test adapter for TanStack DB collections (exact package
  or a `:memory:` wa-sqlite VFS) and add it via pnpm (D15) if external.
- If (a) or (b) fails, the spike records the failure and the fallback INSIDE D3
  (e.g. localStorage-backed persist adapter for the same collections API) — the
  decision stays with the orchestrator/user before Phase 3.4 proceeds.

**Outputs**: ADR section "Persistence spike results". Possibly one added dev/test dep via pnpm.

**Validation**: ADR records verified results with commands/evidence; the chosen
adapter path is proven or the fallback decision is escalated before 3.4.

### 3.2: MockProvider

**Requirements**:

- `apps/web/src/agent/testing/mock-provider.ts`: deterministic stream double —
  scripted turns (text → tool call → tool result → text; an error turn producing a
  diagnostics part). Construction currency decided here (review UNVERIFIED #2): if
  `@tanstack/ai` re-exports the needed event/chunk constructors, use them; otherwise
  `pnpm add @ag-ui/core` explicitly (m5). Test double in `testing/`, never imported
  by production paths; used by node unit tests and the browser e2e.

**Outputs**: Create: `apps/web/src/agent/testing/mock-provider.ts` + tests.

**Validation**: A scripted conversation replays deterministically in a node test;
`pnpm run verify` green.

### 3.3: Runtime hook

**Requirements**:

- `apps/web/src/agent/use-agent-chat.ts` on `@tanstack/ai-react`'s `useChat`
  (review-verified: `connection` XOR `fetcher`):
  - Transport selected by mode: client-direct (adapter from 1.2 + injected fetch) or
    server relay (SSE fetcher from 1.5 — takes NO key, D1/D2).
  - System prompt assembly: the user's editable prompt (D8) + auto-appended,
    clearly-delimited context block (current `cad_get_document` summary + tool
    catalogue generated from the registry). Empty user prompt ⇒ context block only.
    The base instruction text lives with this module, fully replaceable via config;
    no model ids; instructs optional multi-angle capture after geometry changes.
  - Native modelOptions from 1.3 merged; loop strategy `maxIterations` configurable
    (named default 5 — the TanStack default — overridable in settings); stop/retry.
- Node-env tests with MockProvider: transport selection, prompt assembly,
  modelOptions merge, loop-bound behavior.

**Outputs**: Create: `apps/web/src/agent/use-agent-chat.ts` + tests.

**Validation**: `pnpm run verify` green; no real `fetch` reachable in unit tests.

### 3.4: Persistence + sync

**Requirements**:

- TanStack DB collections `agentConversations`/`agentMessages` with the persistence
  path proven by 3.1 — the adapter is injected so node tests use the 3.1 test
  adapter. Message-parts ↔ rows mapping is our glue per
  `docs/research/tanstack-ai.md` §12. Resume on panel reopen; delete clears rows.
- Opt-in sync: when `syncEnabled`, appends push the same rows through the 1.4 tRPC
  router (outbox pattern; failures surface in the chat UI, never silent).
- Node-env tests: persistence round-trip via injected adapter; sync outbox
  success/failure.

**Outputs**: Create: `apps/web/src/agent/persistence/*.ts` + tests.

**Validation**: `pnpm run verify` green.

**Dependencies**: Phases 1 and 2 must complete successfully; 3.4 additionally blocked
on the 3.1 spike outcome.

---

## Phase 4: Chat UI

**Type**: Sub-phases 4.1–4.3 may proceed in parallel after Phase 3.3 (they need the
parts model, not persistence); 4.4 after 4.2/4.3; 4.5 last. Phase-wide validator at
the end. (M5 splits: 4.1 ≈ 500 lines of CSS, 4.2 ≈ 400, 4.3 ≈ 450, 4.4 ≈ 350,
4.5 ≈ 450.)

### 4.1: Vendored styles

**Requirements**:

- Port `app/typeset.css` from the template (MIT header) and vendor the missing
  Tailwind utilities (`shimmer`, `scroll-fade-b`, `scrollbar-thin`,
  `data-autoscrolling:` variants) into the app's styles ONLY where `packages/ui`
  lacks them (M1/m6 of the map doc addendum).

**Outputs**: Create/modify: style files only.

**Validation**: Styles compile; no duplicated utilities that `packages/ui` already
ships; `pnpm run verify` green.

### 4.2: Ported components — only the genuine gaps (M1)

**Requirements**:

- **REUSE, do not port:** `@slopcad/ui` already ships `message`, `bubble`,
  `message-scroller`, `input-group`, `empty` (same template lineage — diffs are
  import paths + minor style drift). Reconcile style drift deliberately only if the
  newer template variants matter; do NOT create a second copy. `@base-ui/react` and
  `@shadcn/react` are already `packages/ui` deps — the map doc's "replace Base UI"
  assumption is stale (see its addendum).
- Port ONLY the genuine gaps: `ui/spinner.tsx`, `prompt-form.tsx` (zero AI-SDK
  imports, but imports `ModelSelect`/`GatewayModel` — adapt to our picker),
  `lib/utils.ts#safeHttpUrl`, and `ui/questionnaire.tsx` if the ask-user pattern is
  adopted. MIT headers on ported files. Chat-specific components land under the
  registry source layout (internals doc §6).

**Outputs**: Create: chat component files (spinner/prompt-form/safeHttpUrl ±
questionnaire) under the chat dir.

**Validation**: Zero AI-SDK/AI-Gateway imports (grep gate); no duplicate of any
`packages/ui` component (grep gate); `pnpm run verify` green.

### 4.3: Part renderers

**Requirements**:

- Part renderers for the TanStack AI parts model: text (markdown + GFM + code),
  thinking/reasoning (collapsible), tool-call with typed per-tool renderers:
  `cad_apply_commands` → readable command/JSX diff view (display only, D4);
  `cad_capture_views` → image gallery with angle captions; generic tool → name +
  collapsed JSON; error parts → diagnostics chips (severity-colored, code + message,
  click behavior consistent with existing diagnostic chips). Typed exhaustive
  switch over part types — no silent fallback.
- Behavior states (streaming, tool running, tool error, final) are verified in the
  Phase 6 browser walk against MockProvider-driven sessions — no jsdom.

**Outputs**: Create: parts renderers under the chat dir.

**Validation**: Exhaustive typing (compile-time); `pnpm run verify` green.

### 4.4: Chat orchestrator + composer

**Requirements**:

- Orchestrator consuming Phase 3.3's hook: streaming states, stop/retry, status
  lines that become persistent history, per-user-message scroll anchoring,
  send/stop morphing button with IME guard (map doc §7 patterns). Composer:
  free-text, multi-line, disabled-with-reason until configured (D5).
- The four user-facing commands (switch right sidebar to/from chat, open agent
  settings, force-refresh catalog, clear conversation) are authored HERE as palette
  command descriptors (m4) — the command-surface spec asserts menu rows ↔ checklist
  entries match exactly, both directions.

**Outputs**: Create: chat panel component + composer; Modify: palette command
registry files per existing patterns.

**Validation**: Commands appear in the palette and match the manifest exactly;
`pnpm run verify` green.

### 4.5: Right-sidebar chat view + settings (Formedible) + empty state

**Requirements**:

- **Chat is a view inside the existing RIGHT sidebar (D16)**, not a new dock: a
  button/segmented control at the top of the right sidebar switches between the
  sidebar's current content (properties/vars/…) and the chat. While chat is active
  it replaces the sidebar content; switching back restores the previous content and
  its state. **The right sidebar becomes resizable by dragging** — the hardcoded
  width goes away; a drag handle (min/max clamped, keyboard-operable per the
  separator a11y pattern) sets the width, and the size persists with the layout
  state. Search-first: reuse any existing resizer/panel-resize pattern in the repo
  before building one. Collapse idioms stay. **Mount INSIDE the workbench page**
  (M2) — not the route layout — so `CadProvider` and the WebMCP tool binding are
  alive; the view selection persists like sibling panel state.
- **Settings sheet as a Formedible form** (implementer loads the `formedible`
  skill first; review-verified the field system covers it): mode (client / server —
  server option rendered only if `serverProviders()` allows), provider, API key
  (password field, "stored only in this browser" note), model picker fed by
  `modelCatalog.list` for the four named providers or the client-direct `/models`
  fetch for `openai-compatible` (D14) — searchable async autocomplete, NOTHING
  preselected, remembers last selection, always-visible raw model string input,
  force-refresh button (catalog) / re-fetch (compatible endpoint),
  reasoning/effort control offering exactly the native values TanStack AI accepts
  for the provider+model (from catalog `reasoning_options`; hidden when unsupported,
  never preselected), system prompt textarea, maxIterations, sync toggle (client
  mode only). models.dev MIT footnote.
- Empty state: setup walkthrough pointing at settings; zero vendor/marketing copy.
- **A11y (m7):** extend the repo's e2e a11y harness with chat stages (composer
  keyboard journey, sidebar view-switch focus order, keyboard sidebar resize) —
  recorded as a deliberate inclusion, not left implicit.

**Outputs**: Create: settings form + sidebar view-switch and resize wiring + a11y
harness stage; Modify: workbench layout file(s) (right sidebar container only).

**Validation**: Form is Formedible config (not hand-rolled fields); unconfigured
state blocks sending with a clear reason; switching views preserves both sides'
state; drag-resize clamps to min/max and the size survives reload; a11y harness
passes with the new stages; `pnpm run verify` green.

**Phase-level Validation**: Phase-wide validator reads all chat UI together:
theme/scheme correctness, no hardcoded model/provider strings anywhere in UI code
(grep gate: `claude|gpt-|gemini|sonnet|o[13]-|gateway` case-insensitive with
allowlist for catalog provider ids and doc comments), MIT headers on ported files,
registry readiness (no app-only imports inside primitive files).

**Dependencies**: Phase 3.3 for 4.2–4.4; all of Phase 4 for Phase 5.

---

## Phase 5: Registry extraction

**Type**: Sequential

**Requirements**:

- Package the chat UI as registry item(s) following the `parametric-cad-viewer`
  pattern: registry build config entries; host-injected transport/tools/catalog via
  props (the component never imports the app's stores or tRPC client).
- Validation via the repo's ACTUAL registry tooling (m6): `pnpm registry:build`,
  `pnpm registry:validate` (external-package deps — `@tanstack/*` are legal),
  `pnpm registry:regenerate`, and the installability matrix
  (`scripts/cad-registry-matrix.sh`).
- Usage demo follows the existing pattern: a `component-preview` page for the chat
  item with a stub transport (parametric-cad-viewer's demo lives at `/viewer` +
  component-preview, NOT docs-examples — match that).

**Inputs**: Read: registry config + component-preview patterns for
`parametric-cad-viewer`.

**Outputs**: Modify: registry config; Create: component-preview page; component
files adjusted for host injection.

**Validation Criteria**: `registry:build`/`registry:validate`/`registry:regenerate`
and the matrix script all pass; standalone preview renders with a stub transport;
`pnpm run verify` green.

**Dependencies**: Phase 4 must complete successfully.

---

## Phase 6: Session e2e, manifest, full gate

**Type**: Sequential

**Requirements** (strategy redesigned per B1 — the harness boots the REAL production
server with the REAL SQLite file; `createInMemoryDb()` does not exist there; Playwright
`page.route` cannot intercept server-side fetches):

- **Harness seeding + loopback fixtures as HARNESS TOOLING (config/scripts, not
  production seams):**
  - A seed script (`apps/web/e2e-session/scripts/…`) run in the webServer command
    chain via `@slopcad/db` against the real `DATABASE_URL`: inserts
    `model_catalog_entries` + meta rows for the named providers from the trimmed
    fixture (picker works with zero network), and relies on
    `AGENT_SERVER_AI_ALLOW_ALL=1` (D13 env) for the session user's server access —
    no per-user row seeding needed for a user created at runtime (B1).
  - A loopback fixture server (harness tooling) serving the trimmed models.dev JSON
    and scripted OpenAI-compatible SSE responses; `MODEL_CATALOG_URL` and
    `OPENAI_COMPATIBLE_BASE_URL` envs point the real production code at it, so the
    walk exercises the real catalog refresh and the real relay code path with zero
    external network.
- Add manifest entries for the four commands (authored in 4.4) to
  `command-surface.checklist.json`; update `WORKBENCH_WEBMCP_TOOLS`/s27 (done in
  Phase 2 — re-verified here).
- ONE serial walk for the harness's ONE user (M3 — the denied-user variant is
  DELETED; 403-denial is covered by Phase 1.5 unit tests): switch the right sidebar
  to chat (D16) → settings
  with MockProvider-backed config → send message → tool call executes real commands
  on the real store → deliberately bad command produces a diagnostics chip AND a
  structured error part → `cad_capture_views` single view, then a multi-angle call
  (SwiftShader, frame-settle) → drag-resize the sidebar and reload: size persists →
  local persistence survives switching the sidebar
  away and back, and a reload (OPFS per the 3.1 spike) → server-mode conversation
  through the real relay against
  the loopback mock → sync push → delete conversation → a11y stages green.
- Production code changes ARE allowed in this phase if the walk finds bugs (fix
  loop applies; the old "no production code changes expected" line is removed — B1).
- `pnpm test:session` green including the coverage gate; then final `pnpm run verify`.

**Inputs**: Read: `apps/web/playwright.session.config.ts` (webServer chain),
`session.spec.ts` structure, `TEST-ALIGNMENT-PLAN.md`.

**Outputs**: Modify: checklist JSON, session harness files + new harness scripts;
production fixes only as the walk demands.

**Validation Criteria**: `pnpm test:session` green with coverage gate;
`pnpm run verify` green end-to-end.

**Dependencies**: All previous phases must complete.

---

## Success Criteria

- `pnpm run verify` green; `pnpm test:session` green including the manifest coverage gate.
- **No-defaults audit passes:** a repo grep for model-id patterns
  (`claude|gpt-|gemini|sonnet|o[13]-` etc.) returns only catalog provider ids,
  fixtures, and documentation; the type system forces "unconfigured" until the user
  chooses; the picker remembers the last selection.
- **BYOK audit passes:** unit test proves the relay input schema has no key field and
  rejects key-bearing payloads; user keys exist only in the client config module and
  provider factories; server-emitted chat uses env keys only.
- Agent tool errors appear as the same diagnostics objects users get from their own
  actions, in the same surfaces (status bar, timeline chips, viewport overlay,
  toasts) and to the model.
- `cad_capture_views` returns one image per requested view (one or many); the D11
  audit table maps every command-surface manifest capability to a tool or an
  ADR-recorded decline.
- The chat UI installs as a registry component with host-injected transport/tools,
  validated by the repo's registry tooling.
- Docs shipped: `docs/architecture/adr-agent-chat.md` (incl. gap-audit table +
  persistence-spike results) + the six research docs remain the authoritative
  references.

## Execution notes (for the orchestrator)

- **Branch:** new branch off `agent-surface` before Phase 0. **Commit after each
  main phase (0–6) passes validation** (phase-wide validator included), message
  style per repo history (concise + "(validated)").
- Dispatch policy: NO-SLOP verbatim in every implementer/fixer dispatch; validators
  read code line-by-line and enforce it. **general-purpose for large phases; vision
  agents for smaller tasks and all visual/rendering verification.**
- e2e AI is ALWAYS mocked — scripted outputs and tool calls (MockProvider §3.2,
  loopback SSE §Phase 6).
- **Never block-wait:** no `sleep N && …` anywhere. To await a result, poll on a
  5–10 s interval loop and proceed the moment it's ready. Orchestrator AND every
  dispatch.
- **Concision protocol (orchestrator + every agent):** do not repeat AGENTS.md or
  prior instructions — agents already have AGENTS.md; no long file lists, no pasted
  output — give commands (`git diff --stat`, `ls`, `git log --oneline`) and
  file:line pointers instead. Dispatches and reports stay minimal.
- Skill loads: `formedible` before 4.5; webMCP registry code before Phase 2;
  registry pattern before Phase 5.
- Per sub-phase: implementer → validator; per phase: phase-wide validator; fixer
  loops ≤ 3.
- Deviations from D1–D16 or phase requirements stop the line and come back to the
  user — never decided in-flight.
- No dev servers (assume one runs); no CI — `pnpm run verify` + `pnpm test:session`
  are the gates.
