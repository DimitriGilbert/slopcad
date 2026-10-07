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
   a handler guard reject key-bearing message payloads with 400, and the
   client relay fetcher takes no key parameter; a unit test proves it.
   `modelOptions` is exempt from that deep credential scan BY STRUCTURE:
   the field accepts only a closed per-provider union of the native D8
   shapes (unknown fields 400, leaves bounded), so Anthropic's
   `thinking.budget_tokens` crosses verbatim while the scan keeps
   flagging `token`-fragment names inside `messages` (details in "Relay
   input contract" below).

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
   diffs — display only. Scope (2026-10-06 review fix): client-direct mode
   ONLY — server-emitted (relay) mode is text-only. The relay's keyless
   wire contract (`{provider, modelId, modelOptions, maxIterations,
messages}`) declares no tools to the server-side run, so the shipped
   system prompt states that unavailability there instead of the tool
   catalogue, and the settings UI qualifies the mode as text-only.
   Wiring tool declarations through the relay contract is future work;
   until it lands, driving the model's tools requires client mode.

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
- wa-sqlite worker+WASM through vite/nitro was UNPROVEN until the Phase
  3.1 spike: `openBrowserWASQLiteOPFSDatabase` spawns a worker and loads
  WASM, and neither the production bundle path nor OPFS inside the
  session harness's headless Chromium was demonstrated yet; the spike
  also had to identify the node-env test adapter for TanStack DB
  collections. PROVEN — see "Persistence spike results".
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
- Phase 1.2 plumbing verification (adapter sources + node tests driving the
  real SDK wire path with an injected transport, 2026-10-04): OpenAI and
  OpenAI-compatible pass `dangerouslyAllowBrowser` and `fetch` straight into
  `new OpenAI(...)` (verified: the bare library factory throws in a
  browser-like environment without the flag; the factories never do);
  Anthropic's `anthropic-dangerous-direct-browser-access` header and `fetch`
  pass through `ClientOptions` (verified on the wire, alongside
  `x-api-key`); Gemini needs no flag, and its fetch override point is
  `httpOptions.fetch` — not a top-level `fetch` (verified honored by the
  Google GenAI SDK's streaming path). One contradiction of
  `docs/research/tanstack-ai.md` §3 found and resolved: OpenRouter's config
  extends `@openrouter/sdk`'s `SDKOptions`, which has NO `fetch` field — the
  injection point is `httpClient`, and `request()` is the only surface the
  SDK base ever calls on it; `HTTPClient` itself is nominal over private
  fields in a transitive package pnpm forbids importing, so the factory
  injects a structural `{ request }` client with a single documented
  assertion. Also noted: OpenRouter takes `serverURL`, not `baseURL`.
  Remaining uncertainty (unchanged): live CORS behavior per provider is
  first confirmed at real use.
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
  Phase 3.1 additions (devDependencies of `web`, test adapter only — see
  "Persistence spike results"): `@tanstack/node-db-sqlite-persistence` ^0.2.28,
  `better-sqlite3` ^13.0.3, `@types/better-sqlite3` ^9.6.0.

## D11 gap audit (Phase 2.1, 2026-10-04)

The parity audit D11 demands: every user capability maps to a registry
tool, a Phase 2.2 planned tool, or an explicit decline recorded here. The
audit universe is the user-facing command-surface manifest
(`apps/web/e2e-workbench/command-surface.checklist.json` — all 53 entries
plus its 2 own documented declines) and the non-palette capabilities the
plan enumerates (the 17 `CAD_COMMAND_TYPES`, assemblies/occurrence trees
and the three workbenches, `$`-variable create/set/get, projects,
diagnostics). Convention: a row fills "Existing tool" and/or "Planned
(Phase 2.2)"; when a capability splits (document path exists, gesture
portion does not), both the mapping and the declined remainder are named.
The blanket parity argument underneath the rows: `cad_run_command` fires
any palette row's own `run()` and `cad_apply_commands` strictly parses and
atomically applies ANY of the 17 serialized command types — those two
tools alone carry every nullary verb and every document mutation the UI
can express; everything else is read-back (`cad_get_document_summary`,
`cad_measure`), image feedback (`cad_capture_views`), history
(`cad_undo`/`cad_redo`), and workspace (`projects_*`, `open_document`).

Findings summary: 60 rows land on existing tools (4 of them with a
declined gesture remainder), 9 rows carried Phase 2.2 planned work (7
whole-capability, 2 enhancements of existing reads), and 16 rows record
declines (12 whole-capability — of which 2 mirror the manifest's own
documented declines — plus the 4 gesture remainders).
`cad_capture_views` (this phase) covers all three snapshot manifest
entries.

**Phase 2.2 completion (2026-10-04):** every planned row is now checked
off — the 2.1 table below records the shipped mapping. The Phase 2.2
tooling: `cad_get_document` + `cad_get_diagnostics` join the workbench
registry (eleven tools on `/workbench-complete`), and the new assembly
module (`apps/web/src/webmcp/assembly-tools.ts`) binds where the assembly
documents live — ten tools on `/workbench-assembly` and
`/workbench-assembly-motion`, and the reads + the interference report only
on `/workbench-assembly-interference` (whose document is the fixture's
constant — no mutator mints where no user mutation exists). The compact
outline and the assembly diagnostics section are shared builders
(`apps/web/src/webmcp/document-outline.ts`) so both registries render the
same shapes. Two honest notes recorded rather than papered over: the
mate-solve read passes an empty anchor table (the executor's topology
seam does not exist yet — a document with mates reports the solver's own
`assembly/mate-unresolved`, never a fabricated solve), and
`updateOccurrence` stays unexposed because no page offers a user verb for
it (parity is user-facing; the door ships later with its first UI).
Output-field hygiene is pinned by unit tests: no field name in any new
tool's result contains an apiKey-like fragment (D1's deep-scan
constraint).

### Binding site (M2)

The workbench tools bind INSIDE the workbench-complete page (nine at
Phase 2.1; eleven since Phase 2.2) —
`useWorkbenchWebMcpTools({ capture, commands, engine })` in
`apps/web/src/cad-workbench/complete-workbench.tsx`, where `CadProvider`'s
store, the engine, and the page's view session (user-camera overlay,
convention) are all alive. The capture surface is the page's own
machinery: `viewportCanvas()` (the `#workbench-complete-viewport canvas`
selector), `handleViewUserCamera` (the session-overlay writer the view
tools and gesture commits use), `engine.renderedFrames` + the page root's
`data-rendered-frames` ledger (`waitForRenderedFrame`), and
`viewSession.convention`. The projects tools bind in the authenticated
projects/dashboard pages (`useProjectsWebMcpTools`). Phase 2.2's assembly
tools follow the same rule: they bind where the assembly documents live —
`useAssemblyWebMcpTools` in `assembly-workbench.tsx` and
`assembly-motion-workbench.tsx` (mutable documents: the ten-tool set) and
`interference-workbench.tsx` (the fixture's constant document: reads and
the interference report only, over the page's own analytic box kernel
seams).

### `cad_capture_views` shape notes (D10)

- Input: `views: Array<{ preset?: "front"|"top"|"right"|"iso" } | preset
XOR { azimuth?: number, elevation?: number }>` — a zod cross-field
  refine enforces preset XOR both-angles; elevation is bounded to the
  interactive orbit band (±88°, `CAD_ORBIT_*_ELEVATION_DEG`) because the
  poles are exactly the top/bottom presets; the batch is bounded (16) —
  each view is frame-settled.
- Angles follow the orbit controls' own frame (azimuth 0 = +X/right,
  −90 = front; elevation above the horizontal plane); preset cameras are
  the standard-views module's own, so azimuth −90/elevation 0 reproduces
  the `front` preset to floating-point exactness (≈1e-15) — IEEE
  cos(−90°) is ≈6.1e-17, not zero.
- Output: `{ ok: true, images: [{ name, mimeType: "image/png", data }] }`
  — one part per view, base64 of the LIVE canvas (the user's camera is
  restored and re-settled on every exit path). Per the Phase 1 phase-wide
  review constraint, no output field name contains an apiKey-like
  fragment (`token`/`secret`/`password`/`credential`/`key` as
  substrings) — pinned by a unit test, so the relay's D1 deep scan can
  never mistake a capture payload for a credential carrier.
- No `width`/`height` parameters (decision 4's roadmap note): the live
  viewport's size is used; custom-size/offscreen renders need new
  machinery the current capture path does not have.
- Errors follow D9 the way the other tools' errors do: the repo's
  structured refusal results (`{ ok: false, code, message }`, codes
  `workbench/capture-*`), which the Phase 2.3 bridge maps into full
  diagnostics and the Phase 4.3 renderers surface in the existing
  status-bar/timeline/toast diagnostic UIs. No separate error channel
  exists at this phase.

### The audit table

| Capability                                           | Existing tool                                                                                                                                                                                                                | Planned (Phase 2.2) | Decline (reason)                                                                                                                                                             |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| base-tool-select (arm select)                        | `cad_run_command`                                                                                                                                                                                                            | —                   | —                                                                                                                                                                            |
| base-tool-measure (arm measure)                      | `cad_run_command` + `cad_measure` (readout)                                                                                                                                                                                  | —                   | —                                                                                                                                                                            |
| base-tool-rotate (arm rotate)                        | `cad_run_command`                                                                                                                                                                                                            | —                   | —                                                                                                                                                                            |
| base-undo                                            | `cad_undo`                                                                                                                                                                                                                   | —                   | —                                                                                                                                                                            |
| base-redo                                            | `cad_redo`                                                                                                                                                                                                                   | —                   | —                                                                                                                                                                            |
| base-clear-rollback                                  | `cad_run_command`                                                                                                                                                                                                            | —                   | —                                                                                                                                                                            |
| base-clear-selection                                 | `cad_run_command`                                                                                                                                                                                                            | —                   | —                                                                                                                                                                            |
| base-export (export dialog)                          | —                                                                                                                                                                                                                            | —                   | Interactive dialog + browser file download; the agent's feedback channel is `cad_capture_views` (images to the model). Handing model/STEP bytes to the agent is future work. |
| base-import (import dialog)                          | —                                                                                                                                                                                                                            | —                   | File-picker flow; the agent has no file to give. Agent-fed DXF/SVG could ride a future tool — not v1.                                                                        |
| sketch-vocabulary-workspace                          | `cad_run_command` (enter sketch mode), `cad_apply_commands` (`sketch.create` record path)                                                                                                                                    | —                   | Interactive canvas authoring (entities/constraints by pointer) — the gesture vocabulary has no command path.                                                                 |
| sketch-solver-status                                 | `cad_get_diagnostics` (sketch-session solver status rides the same read)                                                                                                                                                     | —                   | —                                                                                                                                                                            |
| sketch-editing-operations                            | `cad_undo`/`cad_redo`, `cad_apply_commands` (`sketch.create`)                                                                                                                                                                | —                   | Drag-with-constraints re-solve, in-canvas dimension handles — pointer gestures.                                                                                              |
| sweep-feature                                        | `cad_apply_commands` (`feature.create`)                                                                                                                                                                                      | —                   | —                                                                                                                                                                            |
| loft-feature                                         | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| datum-geometry                                       | `cad_apply_commands` (`datum.create`)                                                                                                                                                                                        | —                   | —                                                                                                                                                                            |
| helix-feature                                        | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| thread-feature                                       | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| draft-taper-feature                                  | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| rib-feature                                          | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| scale-feature                                        | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| thicken-shell-feature                                | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| split-body-feature                                   | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| structured-hole-feature                              | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| plain-hole-bridge                                    | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| feature-pattern                                      | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| path-pattern-feature                                 | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| mirror-feature                                       | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| duplicate-transform                                  | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| boolean-commands                                     | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| body-management-move                                 | `cad_apply_commands` (`body.update`), `cad_get_document_summary` (visibility/name)                                                                                                                                           | —                   | —                                                                                                                                                                            |
| sketch-on-face-verb                                  | `cad_apply_commands` (`reference.create` + `sketch.create`)                                                                                                                                                                  | —                   | The selection-gated pick itself is a gesture; the derived-workplane document path is fully command-expressible.                                                              |
| camera-standard-views                                | `cad_capture_views` (presets + arbitrary angles, convention-aware)                                                                                                                                                           | —                   | Orbit/pan/zoom/zoom-window/look-at as user-viewport steering — pointer gestures; the agent's view channel is capture, not steering the user's camera.                        |
| display-modes                                        | —                                                                                                                                                                                                                            | —                   | Session display preference; captures render the CURRENT mode. Mode-switching for capture is future work if agents need wireframe feedback.                                   |
| section-clipping                                     | —                                                                                                                                                                                                                            | —                   | Interactive clip-plane placement + section panels; solid measurements are `cad_measure`'s.                                                                                   |
| curve-authoring-3d                                   | `cad_apply_commands` (`curve.create`)                                                                                                                                                                                        | —                   | —                                                                                                                                                                            |
| sheet-bodies-base-surfaces                           | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| surface-trim-op                                      | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| surface-thicken-op                                   | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| surface-knit-op                                      | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| surface-offset-op                                    | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| assembly-structure                                   | `cad_get_document` (occurrence trees) + `cad_assembly_add_occurrence` / `cad_assembly_remove_occurrence` (assembly pages)                                                                                                    | —                   | —                                                                                                                                                                            |
| mate-joint-solver                                    | `cad_assembly_add_mate` / `cad_assembly_remove_mate` / `cad_assembly_add_joint` / `cad_assembly_remove_joint` (mate/joint records); `cad_get_diagnostics` (`assembly/mate-*`)                                                | —                   | —                                                                                                                                                                            |
| interference-clearance                               | `cad_assembly_check_interference` (interference + clearance batches over the page's own seams)                                                                                                                               | —                   | —                                                                                                                                                                            |
| assembly-motion-explode                              | —                                                                                                                                                                                                                            | —                   | Interactive joint/explode scrub UIs. Explode states are parameter-driven and readable; authoring them by tool is future work.                                                |
| component-patterns-mirror                            | `cad_assembly_pattern` (linear / circular / mirror through the domain resolvers)                                                                                                                                             | —                   | —                                                                                                                                                                            |
| drawing-sheets-views                                 | —                                                                                                                                                                                                                            | —                   | The `/drawings` surface is a separate authoring domain; the v1 agent targets the 3D model workbench + assemblies. Revisit when the chat proves value in drawings.            |
| drawing-dimensions-annotations                       | —                                                                                                                                                                                                                            | —                   | Same as drawing-sheets-views.                                                                                                                                                |
| drawing-output-bom                                   | —                                                                                                                                                                                                                            | —                   | Same as drawing-sheets-views.                                                                                                                                                |
| exchange-import-formats                              | —                                                                                                                                                                                                                            | —                   | File IO (see base-import).                                                                                                                                                   |
| sketch-exchange-import                               | —                                                                                                                                                                                                                            | —                   | File IO (see base-import).                                                                                                                                                   |
| visualization-snapshot-png                           | `cad_capture_views` (single view)                                                                                                                                                                                            | —                   | —                                                                                                                                                                            |
| visualization-snapshot-turntable                     | `cad_capture_views` (8 azimuth views in one call)                                                                                                                                                                            | —                   | —                                                                                                                                                                            |
| visualization-snapshot-isometric                     | `cad_capture_views` (front+top+right+iso presets in one call)                                                                                                                                                                | —                   | —                                                                                                                                                                            |
| iges-export-dwg-import (manifest decline)            | —                                                                                                                                                                                                                            | —                   | Mirrors the manifest's own documented decline — no user verb exists either.                                                                                                  |
| local-face-operations-verb (manifest decline)        | —                                                                                                                                                                                                                            | —                   | Mirrors the manifest's own documented decline (kernel-reachable, no workbench verb).                                                                                         |
| command type `parameter.set`                         | `cad_set_parameter`, `cad_apply_commands`                                                                                                                                                                                    | —                   | —                                                                                                                                                                            |
| command type `parameter.create`                      | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| command type `parameter.rename`                      | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| command type `parameter.delete`                      | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| command type `feature.create`                        | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| command type `feature.update`                        | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| command type `feature.delete`                        | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| command type `feature.reorder`                       | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| command type `body.create`                           | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| command type `body.update`                           | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| command type `sketch.create`                         | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| command type `reference.create`                      | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| command type `datum.create`                          | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| command type `curve.create`                          | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| command type `configuration.create`                  | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| command type `configuration.update`                  | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| command type `configuration.delete`                  | `cad_apply_commands`                                                                                                                                                                                                         | —                   | —                                                                                                                                                                            |
| `$`-variable create                                  | `cad_apply_commands` (`parameter.create`)                                                                                                                                                                                    | —                   | —                                                                                                                                                                            |
| `$`-variable set                                     | `cad_set_parameter` (number or defining expression)                                                                                                                                                                          | —                   | —                                                                                                                                                                            |
| `$`-variable get                                     | `cad_get_document_summary` (values + expressions) + `cad_get_document` (compact model-oriented outline)                                                                                                                      | —                   | —                                                                                                                                                                            |
| assemblies: occurrence trees                         | `cad_get_document` (occurrence outline)                                                                                                                                                                                      | —                   | —                                                                                                                                                                            |
| workbench parity (complete/assembly/assembly-motion) | eleven tools bind in the complete workbench (see Binding site) + the Phase 2.2 assembly bindings on `/workbench-assembly`, `/workbench-assembly-motion` (ten tools), and `/workbench-assembly-interference` (reads + report) | —                   | —                                                                                                                                                                            |
| projects                                             | `projects_list`, `projects_create`, `open_document`                                                                                                                                                                          | —                   | —                                                                                                                                                                            |
| diagnostics                                          | `cad_get_diagnostics`                                                                                                                                                                                                        | —                   | —                                                                                                                                                                            |

## Bridge / tool-execution notes (Phase 2.3)

Two facts of the installed `@tanstack/ai-client` 0.36.1 that the bridge
(`apps/web/src/agent/tools.ts`) is built around, read from its sources
and recorded here so later phases and framework upgrades do not have to
re-derive them.

### The automatic client-tool path: no-op `emitCustomEvent`, no `abortSignal`

The chat client's automatic client-tool execution (the `onToolCall`
path in `@tanstack/ai-client`'s `chat-client`) invokes a client tool
with a context carrying `toolCallId`, the chat `context`, and a no-op
`emitCustomEvent` — and no `abortSignal`. The bridge emits its
per-step `progress` CUSTOM events through `context.emitCustomEvent`
anyway, and runs under a never-aborted signal when the framework
supplies none: it honors the `ToolExecutionContext` contract
unconditionally, so any wiring that starts honoring it (a framework
upgrade, the manual `addToolResult` path, server-relay execution)
receives the progress events with no bridge change.

### Only a thrown error survives as an error-state `ToolResultPart`

In that same path, only a thrown error produces an error-state
`ToolResultPart` (`state: "output-error"`), and the catch maps
`error.message` into the part — the message string is the only field
that survives. Hence `AgentToolRefusalError` carries the whole D9
diagnostic losslessly encoded as JSON in its message —
`{ code, message, location? }` — and `parseAgentToolRefusal()` decodes
it back; the Phase 4.3 error-part renderer (and the bridge's tests)
recover `code` and `location` through it instead of rendering an
opaque error string.

## Persistence spike results (Phase 3.1, 2026-10-04)

All three questions of PLAN §3.1 are PROVEN on this repo's real pipeline.
No D3 fallback is needed: client chat persistence proceeds on
`openBrowserWASQLiteOPFSDatabase` + `createBrowserWASQLitePersistence`
(Phase 3.4), with `@tanstack/node-db-sqlite-persistence` injected as the
node-env test adapter. Names verified against the INSTALLED packages
(`@tanstack/browser-db-sqlite-persistence` 0.2.28, `@tanstack/db`
0.11.3, `@journeyapps/wa-sqlite` 1.7.2 — the research doc's "2.0.6"
was a research-snapshot version; 1.7.2 is what pnpm resolved against
the peer range `^1.4.1`, and it is what all evidence below ran on).
One correction to `docs/research/tanstack-ai.md` §12's example: the
local-only flow is NOT bare `createCollection(persistedCollectionOptions(
…))` + preload only — writes go through `createTransaction` with
`collection.utils.acceptMutations(transaction)` awaited inside
`mutationFn` (API gotchas recorded below).

### (a) Browser adapter through the production vite/nitro build — PASS

How the package actually ships (read from
`node_modules/@tanstack/browser-db-sqlite-persistence/dist`): the
package entry imports a PREBUILT worker, not a Vite `?worker` module —
`dist/esm/opfs-worker.js` wraps
`new Worker(new URL("../assets/opfs-worker-accoEoax.js", import.meta.url).href)`
(a classic, IIFE worker), and that asset is fully self-contained: the
wa-sqlite WASM is EMBEDDED in the JS as an emscripten base64 payload
(`AGFzbQ…`), so there is no separate `.wasm` to serve and no postinstall
product required. The `?worker` import exists only in the package's
`src/` tree, which the exports map never resolves to.

Reproduction (scaffolding since removed from the tree; recipe is this
list): create `apps/web/src/routes/opfs-spike.tsx` exporting a
`createFileRoute("/opfs-spike")` component that, in a `useEffect`,
calls `openBrowserWASQLiteOPFSDatabase({ databaseName:
"slopcad-opfs-spike.sqlite" })`, wraps it in
`createBrowserWASQLitePersistence`, builds a local-only collection via
`persistedCollectionOptions` (`id: "spike-opfs-roundtrip"`, `getKey`,
`schemaVersion: 1`), `preload()`s, and inserts one `{ id, token }` row
through `createTransaction` + `await collection.utils.acceptMutations(
transaction)` + `tx.mutate(() => collection.insert(…))` + `await
tx.when("settled")`, writing `{phase: "inserted"|"persisted", count,
token}` into a `<pre data-spike-result>` (on reload a non-empty
collection reports `"persisted"` with the stored token). Then:

```
pnpm --filter web build
ls apps/web/.output/public/assets/ | grep opfs
# → opfs-spike-B2qqUmFk.js (276.15 kB client chunk)
# → opfs-worker-accoEoax-B2IN8tCs.js (1,698,634 bytes)
cmp apps/web/.output/public/assets/opfs-worker-accoEoax-B2IN8tCs.js \
  apps/web/node_modules/@tanstack/browser-db-sqlite-persistence/dist/assets/opfs-worker-accoEoax.js
# → byte-identical (no exit output)
grep -o 'new Worker[^)]*' apps/web/.output/public/assets/opfs-spike-B2qqUmFk.js
# → new Worker(``+new URL(`/assets/opfs-worker-accoEoax-B2IN8tCs.js`,``+import.meta.url).href,{name:e?.name})
```

Vite rewrote the dependency's relative worker URL to the absolutized
hashed asset and emitted the worker verbatim (byte-identical, WASM
embedded); nitro produced both the client chunk and an SSR chunk for
the route (`.output/server/_ssr/opfs-spike-*.mjs`) — the SSR build
tolerates the import because nothing worker-touching executes at module
scope. Runtime load is proven by (b), which ran this exact built route.

### (b) OPFS in the headless-Chromium harness environment — PASS

Boot the built output and probe it with Playwright's chromium using the
session harness's launch args
(`--use-angle=swiftshader --enable-unsafe-swiftshader`), one context,
1280×720, DPR 1 — mirroring `apps/web/playwright.session.config.ts`:

```
cd apps/web && PORT=3299 node --env-file-if-exists=.env .output/server/index.mjs
# poll http://localhost:3299/opfs-spike until HTTP 200
node .opfs-spike-probe.mjs   # chromium.launch headless, same args; script since removed
# FIRST LOAD: {"phase":"inserted","count":1,"token":"opfs-mutv2crn-skv8a3dhof"}
# RELOAD:     {"phase":"persisted","count":1,"token":"opfs-mutv2crn-skv8a3dhof"}
# OPFS SPIKE: PASS
curl -s -o /dev/null -w "%{http_code} %{size_download}" \
  http://localhost:3299/assets/opfs-worker-accoEoax-B2IN8tCs.js   # → 200 1698634
```

localhost satisfies the secure-context requirement; the wa-sqlite
OPFSCoopSyncVFS read the SAME row back after a full page reload inside
the worker — storage genuinely hit OPFS, not memory (a reload is a
fresh JS context; the worker and WASM were re-fetched from the built
assets). Scope note, deliberately honest: persistence is proven across
a RELOAD within one browser context — the session harness's exact
model (one user, one context); cross-launch durability was not probed
(Playwright's default fresh profiles are storage-isolated), but OPFS is
disk-backed per origin, so a reload round-trip is the harness-relevant
guarantee Phase 6 tests.

### (c) Node-env test adapter — PASS

The exact package is the official `@tanstack/node-db-sqlite-persistence`
0.2.28 (`createNodeSQLitePersistence`, re-exporting
`persistedCollectionOptions`) over a real `better-sqlite3` database —
NOT a `:memory:` wa-sqlite VFS path (running wa-sqlite in node would
need `@journeyapps/wa-sqlite` added explicitly, and pnpm isolation
forbids the current transitive). Both added via pnpm per D15:

```
pnpm --filter web add -D @tanstack/node-db-sqlite-persistence  # → ^0.2.28
pnpm --filter web add -D better-sqlite3                        # → ^13.0.3
```

`better-sqlite3` is explicit because the adapter takes a constructed
`Database` instance (`database:` option) and re-exports no constructor;
it ships no bundled types, so `@types/better-sqlite3` rides along the
same way (`pnpm --filter web add -D @types/better-sqlite3`). Three
honest notes: (1) the native binding needs the install script —
pnpm 10 blocks build scripts by default, so
`pnpm-workspace.yaml`'s `allowBuilds` map (the repo's existing esbuild/
sharp mechanism) gains a scoped `better-sqlite3: true` — the wa-sqlite
postinstall STAYS ignored per the Phase 0 posture; the binding is
prebuilt (`prebuild-install || node-gyp rebuild`, no toolchain
assumption beyond node-gyp). (2) the adapter depends on
`better-sqlite3@^12` while our explicit devDep resolved `^13.0.3`, so
two copies live in the store; the database instance crosses the
boundary structurally and the round-trip below runs green on 13 —
acceptable under D15's no-pinning rule, revisit only if a major
diverges. (3) `@types/better-sqlite3`'s latest is the v9-era ^9.6.0
(no peer declarations); its typings cover the constructor surface the
test uses, and `pnpm install` is warning-free as of this writing.

Standing evidence (KEPT, runs in `pnpm test`):
`apps/web/src/agent/persistence/node-adapter.spike.test.ts` — a
persisted-collection round-trip over a temp-FILE database where each
open mints a fresh `new Database(path)` + persistence + collection:
writer inserts, a second independent instance preloads the same row
back (plus a collection-id isolation check — the `id` IS the SQLite
table). File-backed rather than `:memory:` on purpose: reopening the
file proves the same durable-write contract the browser OPFS adapter
must satisfy; `:memory:` was separately smoke-verified to work for
fast, disposable suites if Phase 3.4 ever wants cheaper tests.

### API facts for Phase 3.4 (verified against @tanstack/db 0.11.3)

- Local-only writes: `const tx = createTransaction({ mutationFn: async
({ transaction }) => { await collection.utils.acceptMutations(
transaction) } })` → `tx.mutate(() => collection.insert(row))` →
  `await tx.when("settled")`. The `await` on `acceptMutations` is
  load-bearing: without it the transaction settles before the
  persist+confirm lands and the optimistic row is not yet visible.
- `tx.mutate` AUTO-COMMITS (autoCommit defaults true); calling
  `tx.commit()` afterwards throws "no longer pending" — reserve
  `commit()` for `autoCommit: false`.
- `collection.toArray` is a GETTER (an array property), not a method —
  `collection.toArray.map(…)`, never `collection.toArray()`.
  `await collection.toArrayWhenReady()` and `stateWhenReady()` exist
  for first-sync-aware reads.
- The local-only persisted collection id MUST be the stable string id
  (the SQLite table name) — a random id silently abandons data every
  reload (shipped skill doc's "CRITICAL" mistake; pinned by the
  isolation test above).
- Single-tab wiring (`SingleProcessCoordinator` semantics) is the
  default; multi-tab needs `new BrowserCollectionCoordinator({ dbName
})` passed to `createBrowserWASQLitePersistence` and disposed on
  shutdown — a Phase 3.4+ decision, not needed for the single-context
  session harness.

## Relay input contract (Phase 3 fix, 2026-10-04)

The Phase 3.3 runtime hook surfaced two gaps in the Phase 1.5 relay: the
D1 deep credential scan (field-NAME based, fragment list including
`token`) rejected Anthropic's D8-native `thinking.budget_tokens`
selection — so a server-mode Anthropic budget 400'd at the relay — and
the server run ignored the user's `maxIterations` setting. Both are
closed at the relay boundary (`apps/web/src/agent/relay.ts`):

- **`modelOptions` is closed per provider.** The open `record` became a
  closed union of the native shapes — the OpenAI-wire `reasoning.effort`
  (accepted for openai, openai-compatible, and openrouter alike, though
  the builder emits it only for openai/openrouter — openai-compatible
  offers no effort control, D8), Anthropic
  `thinking.{type, budget_tokens}` ∪ `output_config.effort`, Gemini
  `thinkingConfig.thinkingLevel` — every branch a strict object (an
  unknown field anywhere under `modelOptions` → 400) with bounded leaves
  (strings ≤ 64 chars; `budget_tokens` an integer in [1024, 2 000 000],
  1024 being the installed adapter's own floor), so no key VALUE can
  ride a legal field name either. D1 is satisfied by structure; D8 by
  taking the native shapes verbatim — a shape native to a provider other
  than the request's `provider` is still a 400.
- **The deep scan exempts exactly the root `modelOptions` subtree.** The
  zod refine and the raw-JSON handler guard both scan the payload with
  that single positional exemption; `messages` (and anything nested)
  stays under the full deep scan, so a `token`-fragment field inside a
  message is still refused with 400 before any database work. The
  exemption is structural, never lexical: `budget_tokens` as a field
  NAME inside `messages` remains a finding. Pinned from both sides: a
  native Anthropic budget body now streams end-to-end and reaches the
  provider wire verbatim (through the real adapter + real `chat()` under
  an injected transport), while a direct `findApiKeyLikeFields` pin
  keeps flagging `token`-fragment fields inside messages — and the
  client-side body-contract test parses the fetcher's exact emitted body
  against the relay's own schema with the same exemption.
- **The contract is bounded end to end.** Open does not mean unbounded:
  the ceiling constants and their rationale live in
  `packages/ui/src/agent/relay.ts` (the numbers below are read from
  there, not restated as independent truth). The request body caps at
  16 MiB (`AGENT_RELAY_MAX_BODY_BYTES`) — a declared oversize
  `content-length` is refused 413 before a byte is read, then the
  incremental read itself is cancelled past the cap — code
  `agent-relay/payload-too-large`; the cap sits one step above the api
  package's 10 MiB per-appended-message serialized-parts bound
  (`AGENT_MESSAGE_PARTS_MAX_SERIALIZED_LENGTH`,
  `packages/api/src/limits.ts`) so a real multi-message history still
  fits. `messages` ≤ 512; per-message `parts` ≤ 256 — the same
  per-message bound `AGENT_MESSAGE_MAX_PARTS` enforces in the api
  package; `modelId` ≤ 128 characters; part `type` ≤ 64. The credential
  scan is depth-bounded too (`API_KEY_SCAN_MAX_DEPTH`, 64 levels): a
  payload nesting deeper than the bound is answered 400
  (`agent-relay/payload-too-deep`) — once as a schema issue inside
  `safeParse`, once as a handler guard over the raw JSON — never an
  unhandled depth error surfacing as a 500.
- **`maxIterations` rides the contract.** An optional integer 1..25;
  omitted, `chat()`'s own library default (5 model turns — the engine's
  fallback, not a copy of it) applies. Present, the handler binds it
  onto the server-side run as `agentLoopStrategy: maxIterations(n)`. The
  client fetcher always sends the config store's (normalized, ≥ 1)
  value; a stored bound above 25 is refused loudly by the relay's 400
  rather than silently clamped.
- **No tools field exists — server mode is text-only.** (2026-10-06
  review fix) The five-field contract deliberately carries no tool
  declarations (the strict schema would refuse one with 400), so the
  server-side `chat()` runs with an empty tool set. The client relay
  fetcher therefore ships a DIFFERENT system prompt from client mode: no
  tool catalogue, and an explicit line that tool use is unavailable in
  server mode — the prompt must not promise tools the run was never
  offered. Declaring tools over the wire (name + description + JSON
  schema — not credentials, but contract surface that must re-pass this
  section's closed-universe scrutiny) is future work; until it lands,
  server mode answers in text only (D4's scope note above).

## Phase 4 UI notes (2026-10-04)

**Superseded 2026-10-07 — see the update note at the end of this
section.** The historical description:

One SSR render fallback existed on `/workbench-complete` and it was
PRE-EXISTING, not a Phase 4 regression: during server render, a Base UI
Tooltip `fastComponent` hits the `use-sync-external-store` shim against
a second React instance inlined via the `@react-three/fiber` chunk. The
phase-wide validator reproduced the failure byte-identical at commit
`adf8bb3` in a clean worktree, and it fires on non-agent routes too —
nothing the chat mounts changes it. TanStack Start serves the
client-render fallback shell harmlessly (the route hydrates and renders
normally), so the fallback is recorded here and left alone. Phase 4's
own UI ships with counter-measures already in code, so none of its
surface widens the gap:

- Browser storage is read only AFTER hydration: `view-state.ts`
  (`apps/web/src/agent/chat/`) applies the persisted sidebar view in an
  effect, and `right-sidebar-size.ts` (`apps/web/src/cad-workbench/`)
  applies the stored width the same way — the first render never
  depends on stored state, so persistence cannot cause a hydration
  mismatch.
- `session-slot.ts` passes the slot's own getter as the SERVER snapshot
  of its `useSyncExternalStore` (null during SSR — no panel mounts
  server-side), so server-rendered workbench routes never hit React's
  missing-getServerSnapshot error.
- The settings sheet (`agent-settings.tsx`) mounts ONLY while open (the
  io dialogs' `if (!open) return null` pattern), so the closed state
  runs no provider or catalog queries from hidden UI.

**Update (2026-10-07, commit `f2555ab`):** the fallback described above
no longer occurs — the paragraph's "left alone" disposition is
superseded. The root cause was structural, and never the chat: the
router chunk inlined `use-sync-external-store/shim` (CJS) with a runtime
`require("react")` that loaded a SECOND React instance from disk, and
Base UI's `useStore` read that instance's null dispatcher during
`renderToReadableStream` — throwing on every route that SSR-mounts a
Base UI root (`/workbench-complete`, `/workbench-complete-occt`,
`/drawings`). The fix is a vite `resolve.alias` pair
(`apps/web/vite.config.ts`): the plain shim routes to `react` itself
(React 19 exports the native hook) and the with-selector form —
including zustand's `.js`-suffixed ESM specifier — to a local canonical
implementation over the single bundled React. Zero `require("react")`
call sites remain in the built SSR output, the routes server-render
fully with silent logs, and the client graph is unaffected. The
hydration counter-measures above remain accurate and stay in code.

## Phase 6 walk findings (2026-10-04, fixed in-phase)

The session walk (loopback fixture, real production server + SQLite)
surfaced three real Phase 3/4 defects against the INSTALLED framework
versions; all three were fixed at the cause:

1. **Tool-result parts carry no `name` on the live path.** The framework
   builds a `tool-result` part as
   `{ type, toolCallId, content, state, outcome?, error? }` — no tool
   NAME. The Phase 4.3 renderer keyed its per-tool arms (the
   `cad_capture_views` gallery, the apply-commands diff title) on
   `part.name`, which is unset outside hand-built test parts, so the
   gallery never rendered. `message-parts.tsx` now resolves a result's
   tool name from its sibling tool-call part (same `toolCallId`, same
   message — the engine stamps the result onto the assistant message
   that holds the call) and hands it to the renderer.
2. **The interrupt-resolution arm delivers thrown refusals as CONTENT.**
   `@tanstack/ai-client` 0.36.1 has two client-tool arms: the direct
   `onToolCall` one maps a thrown error into an error-state
   `ToolResultPart` (what Phase 2.3's bridge design assumed), while the
   interrupt-resolution one (the run the browser actually takes after a
   RUN_FINISHED client-tool interrupt) hands the thrown text over as the
   result's CONTENT on a complete part. The renderer now decodes
   refusal-shaped content with `parseAgentToolRefusal` and renders the
   D9 diagnostics chip in BOTH arms.
3. **`useChat` never rebinds a changed transport.** The client memo keys
   on the thread id alone (`@tanstack/ai-react` 0.29.4 `use-chat.js`) —
   later `connection`/`fetcher` identities are ignored — so a
   client→server mode switch silently kept calling the provider
   browser-direct (user key and all), and the mount-time system prompt
   context was frozen forever. `use-agent-chat.ts` now (a) reads every
   run-scoped input through live getters (prompt, model options, config
   resolve per `connect()`/fetch), and (b) mints a new thread id — the
   one sanctioned rebuild trigger — when the transport CURRENCY flips,
   seeded with the live transcript so the swap loses no history.

One designed behavior the harness must respect (recorded here so no
later phase "fixes" it): the chat controller's `start()` resume loses to
live work by design ("a send or a lifecycle button raced the resume:
live work wins") — a send that beats the async OPFS resume starts a NEW
conversation. The walk therefore waits for the resumed transcript's tail
before each send, and waits for the sync line (the UI's unsynced-work
signal) to settle before navigating: the store commits at run
completion, and a reload mid-commit can tear the write (the resume then
finds the conversation row but not its messages).
