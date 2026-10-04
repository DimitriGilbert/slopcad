# ADR: WebMCP — the page as a registered tool provider

Phases 7–8 agent-surface work. Status: accepted. Supersedes none;
complements `adr-simulation.md` (the same deterministic-kernel discipline
the CAD tools drive) and the `packages/cad-react/src/model.ts` hard rule
(no second parametric representation — WebMCP is a projection, never a
model). The phased execution plan lives in `ROADMAP-AGENT-SURFACE.md`.

## Context

WebMCP is the W3C Web Machine Learning CG draft protocol
(spec: `https://webmachinelearning.github.io/webmcp/`; Chrome docs:
`https://developer.chrome.com/docs/ai/webmcp`): a web PAGE registers
typed tools on `document.modelContext` — name, description, JSON-Schema
input, execute callback, usage annotations — for browser-resident AI
agents to discover and drive. The Chrome implementation ships imperative
registration first, behind an origin trial / testing flag, so the API may
be absent in every browser this app runs in today.

slopcad is an agent-operable CAD tool (see `ROADMAP-AGENT-SURFACE.md`):
the owner's ruling is that browser agents should operate the SAME
application the user sees — read the open document, run the command-menu
vocabulary, set parameters, create and open projects — not a parallel
API. The surfaces those actions ride already exist: the CadProvider store
and command verbs (Phase 7's eight `cad_*` tools), the tRPC client and
TanStack Router routes the authenticated projects/dashboard pages use
(Phase 8's `projects_list` / `projects_create` / `open_document`).

## Decision

1. **Imperative API only.** The app consumes the spec's imperative half
   (`registerTool` / `getTools` / `executeTool`, unregistration via
   AbortSignal). The declarative forms half (form annotations driving
   agent-filled UI) is spec-TODO and deferred — no speculative surface is
   built against an unsettled draft.

2. **The internal registry is the source of truth; the browser API is a
   best-effort mirror.** `apps/web/src/webmcp/registry.ts` is populated
   unconditionally on mount (no flag, no origin trial, no browser);
   `document.modelContext`, when present, receives a projection of the
   same entries (progressive enhancement — Chrome origin-trial reality).
   The spec IDL is mirrored by a minimal local interface
   (`model-context.ts`) with unknown-narrowing getters, so draft churn is
   one file's concern.

3. **Tools route exclusively through existing domain paths.** Handlers
   drive the CadProvider store and command-menu callbacks (Phase 7) and
   the tRPC client + router navigate the pages themselves use (Phase 8) —
   never a parallel write path. Tool input schemas reuse the domain's own
   zod contracts (e.g. the create-project form's schema verbatim).

4. **No server endpoint and no API keys.** The user's session is the
   auth: every tool handler inherits exactly the page's privileges —
   `protectedProcedure` ownership scoping on the tRPC side, session-gated
   routes on the navigation side. An unauthenticated page exposes no
   projects tools at all (they mount only on authenticated routes).

5. **`window.__slopcadWebMcpTools` is the test/inspection seam —
   snapshot-only.** It serves the registry's serializable snapshot (names,
   titles, descriptions, JSON Schemas, annotations; no handlers) so
   vitest and the session harness can assert registration without the
   Chrome flag. It deliberately exposes NO execution entry; driving tools
   stays with the registry (unit) and the host API (agents).

6. **SSR-safe mounting.** Hooks do nothing during render; all browser
   access lives inside effects the server never runs, and the binding
   re-guards `typeof document`/`typeof window`. Mirror rejections never
   throw into app code — they land in a debug counter
   (`webMcpMirrorDiagnostics`), never the console.

## Consequences

- Agents CAN today: discover and execute the mounted page's tools — the
  eight CAD tools on `/workbench-complete`, the three workspace tools on
  `/projects` and `/dashboard` — with schema-validated inputs and
  structured results/refusals. Agents CANNOT: see tools from pages they
  have not loaded (registration is per-route-lifetime), drive forms
  declaratively, or reach anything the page's own user cannot.
- Spec churn risk is contained: the local IDL mirror plus the
  registry-first design mean a host-API change is absorbed in
  `model-context.ts` and the binding, never in the tools.
- The snapshot seam is a stable contract for tests but an unstable one
  for agents-by-contract: it stays internal (underscored, undocumented in
  user docs) and never grows behavior.
- Deferred deliberately, recorded for later phases: declarative form
  annotations (spec-TODO), an `executeTool`-style execution seam if e2e
  ever needs to drive tools through the page (currently snapshot-only),
  and cross-origin exposure (`exposedTo`) — same-origin agents only,
  until the Permissions-Policy story in the draft settles.
