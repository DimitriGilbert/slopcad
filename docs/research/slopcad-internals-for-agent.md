# slopcad internals for the in-app AI agent — a factual map

Researched 2026-10-04 on branch `agent-surface` (tip `adf8bb3`); counts and the agent-surface
state re-verified 2026-10-06 on `fixes/review-2026-10-06` (tip `c014e99`). Everything below was
read from the shipped code; every claim names a file, line numbers where load-bearing.

**Executive summary.** slopcad has a working, tested agent tool layer: the WebMCP
registry (`apps/web/src/webmcp/`) exposes 14 zod-schema'd tools on the main workbench surface
(11 workbench + 3 projects; the assembly workbenches add 10 more registrations — 22 distinct
tool names repo-wide) through a host-agnostic registry whose `executeWebMcpTool(name, input)`
is a ready-made, validated, never-throws execution seam an in-app chat agent can call
directly — no re-plumbing needed.
The command palette is 35 nullary descriptors built in `complete-workbench.tsx:1132` (dispatch
= `command.run()`, no parametrized by-id store action); parametrized writes must instead ride
`parseCommand` → `store.applyTransaction` (the same path `cad_apply_commands` uses). The
document model is a single immutable `CadDocument` behind a custom (non-zustand) `CadStore`
with committed undo/redo, 17 command types, and a full `$`-variable/expression system;
assemblies are resolved occurrence trees with dedicated workbenches. PNG image export exists
today — single snapshot, 8-frame turntable, 4-view isometric — over a three.js /
@react-three/fiber viewport with `preserveDrawingBuffer: true`, so custom-angle offscreen
renders are a small extension of `snapshot-export.ts`. Errors are structured
(`{severity, code, message, location}` diagnostics + `ParseResult` refusals) surfaced via
status-bar alert, timeline chips, and toasts — an agent tool can report through the same
objects. The in-app chat agent is SHIPPED (`PLAN-AGENT-CHAT.md` phases 1–6, all committed):
the chat panel lives in `apps/web/src/agent/chat/` over the `@tanstack/ai*` packages, and
`/api/agent-relay` (`apps/web/src/routes/api/agent-relay.ts`) does the session-gated,
env-keyed provider calls server-side, with tRPC routers (`agent-conversations`,
`model-catalog`) persisting through Drizzle. The prior "agent-surface" phases shipped
cad-jsx, WebMCP, and tutorial videos, and the server side (tRPC router factory + TanStack
Start routes + Better Auth session + Drizzle migrations) is small and convention-following.

## 1. webMCP support (recently added)

- Lives in `apps/web/src/webmcp/` — ADR: `docs/architecture/adr-webmcp.md` (accepted;
  branch phases 7–8 of `ROADMAP-AGENT-SURFACE.md`).
- Architecture: an INTERNAL registry is the source of truth, populated unconditionally
  (no Chrome flag needed); `document.modelContext` (W3C WebMCP draft) receives a mirror
  projection when present (`registry.ts:1-25`, `use-webmcp-tools.ts:1-28`). The spec IDL is
  mirrored by a hand-written minimal interface in `model-context.ts` (draft churn is one
  file's concern).
- Tool declaration: `defineWebMcpTool({ name, title?, description, inputSchema (zod v4),
annotations?, execute })` — `registry.ts:128-141`. `registerWebMcpTool` eagerly derives JSON
  Schema via `z.toJSONSchema` (`registry.ts:149-156`); names must match `[A-Za-z0-9._-]{1,128}`.
- Execution: `executeWebMcpTool(name, input, options)` (`registry.ts:212-245`) — parse →
  handler → `JSON.stringify`; never throws; structured failures
  `webmcp/unknown-tool`, `webmcp/invalid-input`, `webmcp/tool-failure` (`registry.ts:97-102`).
- Exposed tools — 14 on the main workbench surface, 22 distinct names repo-wide:
  - Workbench (11, `workbench-tools.ts:512-805`, mounted at `complete-workbench.tsx:1560`):
    `cad_get_document_summary`, `cad_list_commands`, `cad_run_command` (by id, nullary),
    `cad_set_parameter` (number or expression string), `cad_undo`, `cad_redo`,
    `cad_apply_commands` (batch of serialized commands, strict `parseCommand`, ONE atomic
    `store.applyTransaction`), `cad_measure` (volume/area/bounds from the settled scene),
    `cad_capture_views` (snapshot/turntable/isometric PNG), `cad_get_document`,
    `cad_get_diagnostics`.
  - Projects (3, `projects-tools.ts:120-157`, mounted in
    `routes/_auth/dashboard.tsx:43` and `routes/_auth/projects.index.tsx:56`):
    `projects_list`, `projects_create` (reuses the form's zod schema verbatim), `open_document`.
  - Assembly workbenches (10 registrations — 8 distinct new names plus per-route re-binds of
    `cad_get_document`/`cad_get_diagnostics`; `assembly-tools.ts:285-710`, mounted via
    `useAssemblyWebMcpTools` in `assembly-workbench.tsx:181`,
    `assembly-motion-workbench.tsx:186`, `interference-workbench.tsx:431`):
    `cad_assembly_check_interference`, `cad_assembly_add_occurrence`,
    `cad_assembly_remove_occurrence`, `cad_assembly_pattern`, `cad_assembly_add_mate`,
    `cad_assembly_remove_mate`, `cad_assembly_add_joint`, `cad_assembly_remove_joint`.
- Test/inspection seam: `window.__slopcadWebMcpTools()` returns a snapshot (no handlers);
  installed once per page (`use-webmcp-tools.ts:124-141`). Deliberately execution-free (ADR §5).
- Reusability verdict for an in-app agent: HIGH. `defineWebMcpTool` entries + `webMcpToolSnapshot()`
  (names/descriptions/JSON Schemas) are a ready tool registry to feed an LLM, and
  `executeWebMcpTool` is a ready validated dispatcher — no WebMCP browser API needed. Caveats:
  registration is per-route-lifetime (`bindWebMcpTools` cleanup, `use-webmcp-tools.ts:137-141`),
  so a chat panel mounted at the app shell needs its own binding; results are JSON strings, not
  objects; `AbortSignal` plumbing exists but nothing cancels mid-handler today.

## 2. Command surface manifest

- UI source of truth: the `commands` useMemo in
  `apps/web/src/cad-workbench/complete-workbench.tsx:1132-1552` — 35 `CadCommandDescriptor`s
  (ids at lines 1144-1503): tool arming (`tool-*`), history (`undo`, `redo`, `clear-rollback`),
  workspace/feature verbs (`sketch`, `surface-*`, `hole`, `sweep`, `loft`, `helix`, `draft`,
  `rib`, `scale`, `thicken`, `split`, `pattern`, `pattern-path`, `mirror`, `thread`,
  `sketch-on-face`, `boolean`, `move-body`, `duplicate`, `create-datum`, `create-curve`),
  file verbs (`export`, `import`), and Phase 59 image exports (`export-snapshot-png`,
  `export-turntable`, `export-isometric`).
- Entry shape: `CadCommandDescriptor { id, label, group, keywords?, shortcut?, disabled?,
run(): void }` — `packages/ui/src/components/cad/cad-command-menu.tsx:88-103`. ALL commands
  are nullary; parameters are collected by dialogs/forms each `run()` opens.
- The palette (`CadCommandMenu`, cmdk-based, self-ranked search) renders them; dispatch is
  literally `command.run()` after closing (`cad-command-menu.tsx:296-299`).
- The durable manifest is the Phase 60 audit data
  `apps/web/e2e-workbench/command-surface.checklist.json`: 57 entries
  `{id, phase, capability, route, kind: "command"|"command-panel"|"panel", target?, keywords?}`
  plus 2 documented declines; kept honest against `ROADMAP-CAD-PARITY.md` by
  `scripts/command-surface-audit.mjs` (`pnpm audit:command-surface`), and against the DOM by
  `apps/web/e2e-workbench/command-surface.spec.ts` (menu rows == command entries, both
  directions).
- Programmatic/headless execution: NO single `runCommandById(params)` store action exists.
  What exists:
  - By id, nullary: the WebMCP `cad_run_command` handler finds the descriptor and calls
    `command.run()` (`workbench-tools.ts:231-257`).
  - With params: `parseCommand(raw)` (`packages/cad-core/src/command.ts:1182`) →
    `store.applyTransaction({ commands })` (`packages/cad-react/src/store.ts:278-290`) — the
    exact path `cad_apply_commands` and the cad-jsx compiler use. An agent feature should
    build parametrized tools on this, not on the palette.
- Session harness use (`apps/web/e2e-session/session.spec.ts`): loads the checklist JSON
  (lines 108-116), walks every production route (`PLANNED_ROUTES`, lines 119-134), drives
  commands by clicking `[data-cad-command-id="${id}"]`
  (`helpers.ts:229-235`), records coverage in a ledger (`cover`/`walk`, lines 137-160), and
  the final stage `s99 THE COVERAGE GATE` (lines 4378-4402) FAILS on any manifest entry,
  decline, or route not exercised. Any new command/route added for an agent feature must be
  added to the checklist and walked, or the gate goes red.

## 3. CAD engine & document model

- Packages: `packages/cad-core` (immutable document, commands, parameters, expressions,
  diagnostics, assemblies), `packages/cad-react` (store + hooks), `packages/cad-kernel`
  (kernel contract + feature-executor bridge) with backends `packages/cad-kernel-manifold`
  (default WebGL-era kernel) and `packages/cad-kernel-occt` (BREP, `/workbench-complete-occt`),
  plus `cad-sketch`, `cad-io`, `cad-jscad`, `cad-jsx`, `cad-r3f`, `cad-react`, `cad-components`.
- State: NOT zustand. `CadStore` (`packages/cad-react/src/store.ts`) is a custom, React-free
  hub over immutable domain values with per-concern pub/sub (`document`, `parameters`,
  `history`, `selection`, `tools`; lines 47-79) consumed via `useSyncExternalStore` hooks
  (`use-cad-document.ts`, `use-cad-history.ts`, `use-cad-parameters.ts`, `use-cad-selection.ts`,
  `use-cad-tools.ts`), wired by `CadProvider` (`provider.tsx`). Canonicality rule: "the domain
  is canonical; React only mirrors it" — no setState into the domain; whole-session swaps go
  through `store.replaceSession` (`store.ts:323`). `packages/cad-react/src/model.ts` pins the
  hard rule: no second parametric representation; `applyCommand` is the sole interpreter.
- Mutations: `applyCommand` / `applyTransaction` (`store.ts:278-291`) over the 17-type
  vocabulary `CAD_COMMAND_TYPES` (`packages/cad-core/src/command.ts:131-149`: parameter
  set/create/rename/delete, feature create/update/delete/reorder, body create/update,
  sketch.create, reference.create, datum.create, curve.create, configuration create/update/delete).
- Undo/redo: committed history in the session; `store.undo()/redo()/getHistoryView()`
  (`store.ts:254`, `workbench-tools.ts:419-430` returns `{canUndo, canRedo, cursor, depth}`);
  surfaced by `useCadHistory` and the palette/history commands.
- Regeneration: threaded loop in `apps/web/src/cad-workbench/workbench-engine.tsx` — diffs
  changed graph nodes, `markStale`, one `regenerate` pass producing `RegenerationStateMap`
  with per-feature `diagnostics`; the worker's kernel verdicts join via
  `sceneVerdictAdjustedStates` (lines 345-367).
- Assemblies: shipped — occurrence-tree resolution with composed world transforms, cycles and
  depth limits refused structurally (`packages/cad-core/src/assembly.ts:1-40`); staleness
  across transitive source documents; dedicated routes `/workbench-assembly`,
  `/workbench-assembly-motion`, `/workbench-assembly-interference`; explode/clearance/
  interference/pattern/motion modules in cad-core.
- Parametric `$`-var system: parameters live in a `ParameterCollection` where each parameter
  carries a stored value AND/OR a defining expression AST (`packages/cad-core/src/parameter.ts`,
  `expression-parser.ts`, `expression-evaluator.ts`); `$name` tokens work in feature value
  fields and sketch dimensions with click-to-autocomplete; dependency-aware recompute with
  cycle refusal; rename rewrites dependents' expressions, delete refuses while referenced
  (`packages/cad-core/src/document.ts:1757-1850`). The in-app sessions s28–s32 of
  `session.spec.ts` pin all of this end-to-end.
- Where commands get compiled/executed: `applyCommand` (`command.ts:439`) is the sole
  interpreter; `@slopcad/cad-jsx` compiles TSX trees into command transactions (CLI:
  `pnpm --filter @slopcad/cad-jsx compile`); the kernel bridge in `@slopcad/cad-kernel`
  interprets feature records into kernel ops (codes `kernel/*`,
  `packages/cad-core/src/diagnostics.ts:29-34`); browser execution rides worker sessions
  (`apps/web/src/render-fixture/fixture-session.ts`, `apps/web/src/worker-fixture/`).

## 4. Image export / rendering

- Viewport: three.js `0.186.0` + `@react-three/fiber` `9.7.0`
  (`packages/cad-r3f/package.json:25-27`); scene/camera/picking/orbit/display-mode modules in
  `packages/cad-r3f/src/` (notably `standard-views.ts` — azimuth/elevation convention +
  fit-distance framing; free orbit below the world plane per commit `61157d3`). The UI wrapper
  is `CadViewport` (`packages/ui/src/components/cad/cad-viewport.tsx`).
- PNG export EXISTS (`apps/web/src/cad-workbench/snapshot-export.ts`): the scene renders on a
  deterministic `preserveDrawingBuffer: true` canvas at DPR 1, so `canvas.toBlob` captures
  settled pixels (`captureViewportPng`, lines 92-100). Three commands in the palette
  (`complete-workbench.tsx:1474-1510`): single snapshot; turntable series (8 × 45° about z,
  `turntableCameras`, lines 119-154); isometric series (front/top/right/iso via
  `standardViewCamera`, lines 169-181). Series drives each camera through the session's
  user-camera overlay, waits for the `data-rendered-frames` ledger
  (`waitForRenderedFrame`, lines 71-89), captures, and restores the previous camera
  (`complete-workbench.tsx:625-659`).
- Custom-angle offscreen render: FEASIBLE and small — the camera math is pure
  (`RenderCamera` records in cad-core; `turntableCameras`/`isometricSeriesCameras` are
  templates for arbitrary azimuth/elevation/distance), the frame ledger gives a
  settled-pixels guarantee, and a data-URL return (instead of `downloadBlob`) is the obvious
  agent-tool adaptation. Same-doc determinism is already pinned by suites.
- `skills/slopcad-cad-jsx/SKILL.md` exists (312 lines). In 5 lines: CAD models are `.tsx`
  React element trees compiled deterministically to the 17-type CadCommand vocabulary
  (`applyCommand` is the sole interpreter — JSX is sugar). 43 element kinds
  (`packages/cad-jsx/src/elements.ts`); parameters, sketches, features, booleans, `<Use>`
  sharing. Compile via `pnpm --filter @slopcad/cad-jsx compile <file.tsx> [--out]` → native
  document JSON (the exact `nativeContent` the documents API stores). Workbench import posts
  to `POST /api/io/import-tsx` (vm-sandboxed loader, 1 MiB cap); export runs `generateTsx`
  client-side with structured declines, never silent drops. Determinism gate: compile twice,
  byte-identical or the model is defective.

## 5. Diagnostics surface

- The diagnostic object is pure cad-core data: `{ severity: "info"|"warning"|"error"|"fatal",
code: "<domain>/<name>", message, location: { primary: CadId, ... } }`
  (`packages/cad-core/src/diagnostics.ts:44-49` + registry of stable codes; codes are persisted
  data — never rename). Example emission: `workbench-engine.tsx:355-365`.
- The universal result convention is `ParseResult`: `{ ok: true, value }` |
  `{ ok: false, error: { code, message } }` (`packages/cad-core/src/result.ts`). Store
  operations, command parsing, expressions, and every WebMCP tool refusal (`workbench-tools.ts`
  refusal codes `workbench/*`) return it — nothing throws across boundaries.
- Where users see errors today (no dedicated "problems panel"):
  - Status bar error span — a live `role="alert"` region the session writer writes the error
    text into (`packages/ui/src/components/cad/cad-status-bar.tsx:79-80, 233-236`).
  - Feature timeline chips — per-feature `state` + `diagnostics` rendered by
    `apps/web/src/cad-workbench/feature-timeline-strip.tsx:260-262`.
  - Viewport error overlay — destructive-bordered chip top-right of the viewport
    (`complete-workbench.tsx:1750`).
  - Toasts (sonner) for async/app-level events, e.g. project create success/failure
    (`projects-tools.ts:220-224`), and dialog error regions for form refusals
    (`feature-forms.tsx:9-11`).
- For an agent: the goal state already exists — tool errors should carry the SAME
  `{code, message}` (plus `DiagnosticSeverity`/location where known) so the chat can render
  them exactly like the timeline/status bar do; `applyTransaction` failures already return
  structured codes (`workbench-tools.ts:112-117` maps them verbatim).

## 6. shadcn-style registry

- Registry authoring is per-package `registry.json` in shadcn schema:
  `packages/ui/registry.json` (UI + example blocks), `packages/cad-components/registry.json`
  (parametric components + `parametric-cad-viewer` block), `apps/web/registry.json` (8
  headless workbench tool libs, e.g. `extrude-tool`, `hole-tool`).
- Build: `scripts/registry-build.sh` runs `shadcn build registry.json -o packages/ui/public/r`
  for each source registry, then `scripts/registry-index.mjs` merges the index;
  `scripts/registry-validate.mjs` validates. Nothing is published — artifacts are served on
  loopback for consumer installs. Commit `7a6bc65` made `parametric-cad-viewer` installable.
- The `parametric-cad-viewer` pattern (`packages/cad-components/registry.json`, item at the
  end): `type: "registry:block"`, `registryDependencies: ["@slopcad/cad-viewport",
"@slopcad/cad-parameter-panel"]`, `dependencies: ["@slopcad/cad-core", "@slopcad/cad-kernel",
"@slopcad/cad-react"]`, and `files[]` mapping source paths to consumer targets
  (`src/cad/viewer/...`). Its honest boundary is stated in the description: it renders and
  edits but does not evaluate geometry; re-drive rides a consumer-supplied rebuild callback.
- Pattern a NEW registry component (an agent chat) must follow: add a source `registry.json`
  item in the owning package (for app-level code, `apps/web/registry.json`; for reusable UI,
  `packages/ui/registry.json`), declare `registryDependencies` on existing `@slopcad/*` items,
  keep the block self-contained with explicit file targets, then run
  `scripts/registry-build.sh` and land the regenerated `packages/ui/public/r/` artifacts.
  Demo/preview pages live under `apps/web/src/component-preview/` and
  `apps/web/src/routes/components.$componentId.tsx`.

## 7. Existing AI/agent scaffolding

- What EXISTS for agents: the WebMCP layer (section 1), the agent skill
  `skills/slopcad-cad-jsx/SKILL.md`, the plan documents `ROADMAP-AGENT-SURFACE.md` (15
  phases, 0–14: cad-jsx, WebMCP, tutorial studio; its laws A1–A6 bind the WEBMCP surface:
  tools drive the same domain paths, no second API, no API keys there) and
  `PLAN-AGENT-CHAT.md` (phases 1–6, all committed and validated), and the ADRs
  `docs/architecture/adr-webmcp.md` and `docs/architecture/adr-agent-chat.md`.
- The in-app agent chat is SHIPPED (PLAN-AGENT-CHAT):
  - Chat UI: `apps/web/src/agent/chat/` — `workbench-chat-view.tsx`
    (`AgentChatSidebarView`, mounted in the workbench's right dock via
    `cad-workbench/right-sidebar.tsx`), `chat-commands.ts`, `agent-settings.tsx`
    (provider/model settings), `view-state.ts`.
  - Transport: the `@tanstack/ai*` packages — all seven in both `apps/web/package.json` and
    `packages/ui/package.json` (`ai`, `ai-anthropic`, `ai-client`, `ai-gemini`, `ai-openai`,
    `ai-openrouter`, `ai-react`).
  - Server: `POST /api/agent-relay` (`apps/web/src/routes/api/agent-relay.ts`, handler in
    `@slopcad/ui/agent/relay`) — Better Auth session gate, the per-user `isServerAiAllowed`
    check, and provider keys from `@slopcad/env` (`OPENAI_KEY`, `ANTHROPIC_KEY`,
    `GOOGLE_KEY`, `OPENROUTER_KEY`, `OPENAI_COMPATIBLE_KEY`/`_BASE_URL`). Provider calls
    stay server-side, so the unit-test fetch guard is respected by construction.
  - Persistence: tRPC routers `agent-conversations` and `model-catalog`
    (`packages/api/src/routers/`, with `packages/api/src/providers.ts` for the provider
    registry) over the
    Drizzle tables in `packages/db/src/schema/` (`agent.ts`: `agentConversations`,
    `agentMessages`; `model-catalog.ts`) — migration `0002_broad_sentinels.sql`.

## 8. Formedible forms

- Library: `packages/ui/src/components/formedible/` (vendored source; `form.tsx`,
  `field-renderer.tsx`, `fields/`, `hooks/use-formedible`, `lib/types.ts` exporting
  `FormedibleFieldConfig`). AGENTS.md rule: ALL new forms must use it.
- The pattern (representative: `apps/web/src/cad-projects/project-forms.tsx:20-81`):
  1. a zod schema (`createProjectSchema`, lines 19-36) — single source of validation truth
     (the WebMCP `projects_create` tool reuses it verbatim);
  2. a `fields` const array of `FormedibleFieldConfig` objects — `{name, type: "text"|
"textarea"|..., label, placeholder, required, maxLength, rows}` (lines 40-57);
  3. `useFormedible<Values>({ schema, fields, formOptions: { defaultValues, onSubmit },
resetOnSuccess, submitLabel, submitButtonClassName })` (lines 67-79);
  4. render `<form.Form aria-label=... className="space-y-3" />` — the hook returns the
     component; submit delivers typed values to `onSubmitted`.
- Feature dialogs use the same pattern with richer field types
  (`apps/web/src/cad-workbench/feature-forms.tsx` — selects, ordered rows, an
  `expression-number-field` that validates `$`-expressions); refusals surface verbatim in the
  dialog's error region. The shipped "AI provider settings" form is exactly this pattern:
  zod schema + field list + `useFormedible`
  (`apps/web/src/agent/chat/agent-settings.tsx` + `agent-settings-form.ts`).

## 9. Server side

- tRPC: routers live in `packages/api/src/routers/` (`projects.ts`, `documents.ts`); the app
  router composes them with factory injection —
  `packages/api/src/routers/index.ts:7-19`: `appRouter = router({ healthCheck, privateData,
projects: createProjectsRouter({ db }), documents: createDocumentsRouter({ db }) })`. A new
  router = a `createXRouter({ db })` factory in `routers/`, exported DTO interfaces (e.g.
  `ProjectDto`, `projects.ts:28-45`), and one line in `appRouter`.
- Auth: `protectedProcedure` middleware reads `ctx.session` and throws UNAUTHORIZED
  (`packages/api/src/index.ts:10-21`); every project/document read/write scopes by
  `ownerId === ctx.session.user.id` (`projects.ts:1-10` header comment). Context:
  `packages/api/src/context.ts` calls `auth.api.getSession({ headers })` (Better Auth,
  `packages/auth/src/index.ts` with `tanstackStartCookies()` plugin).
- TanStack Start server routes: file routes under `apps/web/src/routes/api/` using
  `createFileRoute(...).server.handlers` — the tRPC mount is
  `apps/web/src/routes/api/trpc/$.ts` (`fetchRequestHandler`, endpoint `/api/trpc`); REST-ish
  endpoints follow `routes/api/io/import-3mf.ts` → `apps/web/src/io-fixture/import-3mf-endpoint.ts`
  (session gate 401, 64 MiB cap 413, structured 422s). A new server endpoint (e.g. an LLM
  proxy) should copy the io-endpoint shape or, preferably, be a tRPC procedure. Client:
  `apps/web/src/utils/trpc.ts` (`@trpc/tanstack-react-query`); components use `useTRPC()` +
  `queryClient.fetchQuery` / `useMutation` (see `projects-tools.ts:210-258`).
- DB: Drizzle + libsql/SQLite. Schema in `packages/db/src/schema/` (`auth.ts`, `projects.ts`,
  re-exported by `index.ts`); migrations are generated SQL in `packages/db/src/migrations/`
  (currently `0000_*.sql`, `0001_*.sql` + `meta/`). Flow: edit `schema/*.ts` →
  `pnpm db:generate` (drizzle-kit, config `packages/db/drizzle.config.ts`) → commit the SQL →
  `pnpm db:migrate` (or `db:push` for local iteration). Tests use `createInMemoryDb()`
  (`packages/db/src/index.ts:37`) which applies committed migrations to a temp-file db —
  a new table for agent chat persistence must ship with a committed migration or tests fail.

## 10. App layout / where a chat panel mounts

- Routes (`apps/web/src/routes/`): public — `/` (index), `/login`, `/docs`, `/viewer` (public
  parametric viewer, iframe-embeddable, `viewer.tsx`), demo/fixture routes (`/workbench*`,
  `/render`, `/io`, `/perf`, `/spike`, ...); authenticated under `_auth/route.tsx`
  (`beforeLoad` → `getUser()` → redirect `/login`): `/dashboard`, `/projects`,
  `/projects/$projectId`, `/documents/$documentId` (the persisted-document workbench,
  `ProjectWorkbenchPage`).
- The editor workspace: `/workbench-complete` → `CompleteWorkbenchPage`
  (`apps/web/src/cad-workbench/complete-workbench.tsx`). Layout (lines ~2733-2830): a header
  toolbar strip, the viewport owning the center, a LEFT dock (model tree, `w-60`, line 2762)
  and a RIGHT dock (property + parameter panels, `w-[272px]`, line 2790), regions divided by
  hairlines; on narrow screens the docks become overlay drawers toggled by
  `data-testid="workbench-toggle-panels"`; `CadStatusBar` below. A chat panel naturally mounts
  as a third dock (right, beside/below the parameter dock) or a floating overlay panel — the
  drawer pattern (absolute → `xl:static`) is the established responsive idiom.
- Styling: Tailwind CSS v4 (`@import "@slopcad/ui/globals.css"` — `apps/web/src/index.css:1`;
  `@tailwindcss/vite`), primitives from `@slopcad/ui` (shadcn-style: Button, Dialog, Command,
  Sonner Toaster, ScrollArea...). Dark mode: TWO appearance axes in `apps/web/src/theme.ts` —
  MODE (`.dark` class on `<html>`) and SCHEME (`data-scheme`, 4 named palettes), persisted in
  localStorage, applied pre-paint by `APPEARANCE_BOOTSTRAP_SCRIPT` mounted in
  `routes/__root.tsx`; no React provider — components just use the tokens. A chat panel must
  use semantic tokens (`bg-card`, `border-border`, `text-muted-foreground`...) to inherit both
  axes; the CAD scene re-inks via `cad-studio-palette` MutationObserver.
- App chrome: `apps/web/src/components/header.tsx:54-58` — nav Home/Dashboard/Projects/
  Workbench/Docs, `h-11` header; the `Toaster` mounts in `__root.tsx`.

## 11. Testing constraints

- Gate: `pnpm run verify` (check-types → lint → format:check → test → build) before
  declaring done; no CI,
  ever (`TEST-ALIGNMENT-PLAN.md` §1 D5, D7; `AGENTS.md`). Browser e2e is the session harness
  `pnpm test:session` (`apps/web/e2e-session/`, Playwright, ONE context, serial, 1280×720
  DPR 1, SwiftShader, video on, production build).
- No live network in unit tests — runtime-enforced: `fetch` is stubbed to THROW
  "TEST FORBIDS LIVE NETWORK" in `apps/web/src/test-setup.ts` and
  `packages/api/src/test-setup.ts`. Any client-side LLM call will fail tests unless mocked;
  provider calls stay server-side (the shipped `/api/agent-relay` route) — mock the handler
  deps in unit tests.
- No real database: `createInMemoryDb()` + committed migrations (`TEST-ALIGNMENT-PLAN.md`
  §2.8); no env validation at import time (`SKIP_ENV_VALIDATION=1` in every `test-setup.ts`).
- jsdom only where React/DOM is under test: `apps/web`, `packages/ui`, `packages/cad-r3f`,
  `packages/cad-react` use jsdom vitest environments; everything else is node
  (`packages/config/vitest/base.ts`, `createTestConfig()`; timeout 20s). Chat UI component
  tests go in `apps/web` or `packages/ui` (jsdom); agent-orchestration logic should be pure
  node-env modules.
- Session coverage gate: any new route must be appended to `PLANNED_ROUTES`
  (`session.spec.ts:119-134`) and walked; any new command-menu id must be added to
  `apps/web/e2e-workbench/command-surface.checklist.json` (and audited by
  `pnpm audit:command-surface`) and exercised — `s99` fails otherwise (lines 4378-4402).
  The WebMCP surface already has its own session stage (`s27`, line 3325) asserting registry
  snapshots on the workbench and projects pages — a chat panel exposing new tools would extend
  that stage. Coverage is report-only istanbul today; never lower a threshold once set.

## Gaps & risks

- **No headless parametrized command dispatch**: the palette is nullary by design; an agent
  that must "fillet with r=3" needs new tool handlers over `parseCommand`+`applyTransaction`
  (and the feature-dialog logic they mirror), not palette reuse. Dialog-only flows (sketch
  editing, `sketch-on-face`) have no non-UI path at all.
- **Provider keys are server-side env keys, gated**: the WebMCP ADR still rules out API keys
  for that surface; the chat backend's keys live in `@slopcad/env`, and every relay call
  passes the `isServerAiAllowed` gate (`agent-relay.ts`) — server-side by construction, so
  the unit-test fetch guard holds.
- **Per-route tool registration lifetime**: tools bind/unbind per page mount
  (`use-webmcp-tools.ts:149-151`); an app-shell chat panel needs either a shell-level binding
  or cross-route state for document tools, since the CadStore lives inside the workbench
  pages (via `CadProvider`), not globally.
- **Session gate tax**: every new visible surface (route, command id, panel) must enter the
  checklist and be walked serially by `pnpm test:session`, or the coverage gate fails — a
  chat panel with its own actions is a non-trivial harness addition.
- **Rendering determinism vs. live screenshots**: PNG capture depends on the deterministic
  DPR-1 `preserveDrawingBuffer` canvas and the frame-settle ledger; an agent screenshot tool
  must reuse `waitForRenderedFrame` or it will return stale frames. Offscreen/custom-size
  renders are untested territory (the current path only captures the live canvas).
- **Chat streaming bypasses tRPC**: token streaming rides the dedicated Start server route
  `/api/agent-relay` (the server-emitted chat transport), not tRPC v11's HTTP batch — keep
  chat streaming out of the tRPC routers.
- **Assembly tools are scoped to the assembly workbenches**: the main workbench's CAD tools
  operate on the single open document; `cad_assembly_*` binds only on the three assembly
  workbench routes (section 1), and drawings/configurations still have WebMCP read paths only
  via `cad_get_document_summary`.
