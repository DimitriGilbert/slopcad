# PLAN-AGENT-CHAT.md — adversarial review

Reviewed 2026-10-04, pre-execution. Method: every claim in the plan was checked
against (a) the repo at `/home/didi/workspace/slopcad` (file:line evidence below),
(b) live npm registry output (`npm view <pkg> version`, run today), (c) live
TanStack AI / TanStack DB documentation (fetched today), (d) a fresh live fetch of
`https://models.dev/api.json`, and (e) the template clone at `/tmp/chatbot-template`.
The five research docs in `docs/research/` were spot-checked, not trusted.

## Executive verdict

**1 blocker, 6 majors, 9 minors. The plan is NOT executable as written** — Phase 6's
session-e2e requirements reference machinery that does not exist in this repo (an
"in-memory DB fixture" inside a harness that boots the real production server) and
simultaneously forbid the production-code seams those requirements need. Everything
else is directionally sound: the dependency set, the TanStack AI API shapes, the
webMCP/snapshot/diagnostics/registry claims, and the D1–D15 decision compliance all
verified clean against ground truth. Fixing B1 + M1–M6 (mostly plan-text edits, one
redesign of Phase 6's test strategy and Phase 4.1's port list) makes the plan
executable.

Counts: BLOCKER 1 · MAJOR 6 · MINOR 9 · UNVERIFIED 7 (listed at the end).

---

## Findings

Severity: **BLOCKER** = a phase requirement cannot be satisfied as written.
**MAJOR** = breaks a repo rule, duplicates work at scale, or stores a landmine a
later phase steps on. **MINOR** = wrong name / stale wording / small gap.

### B1 — Phase 6's "no network" session-walk requirements are structurally impossible as written

- **Claim attacked (plan §Phase 6, Requirements/Outputs):** "catalog served from the
  in-memory DB fixture; no network", "server-mode conversation via the relay handler
  configured with the mock adapter", "with the session user's `user_options`
  `agent.server-ai` row seeded allowed", and Outputs: "no production code changes
  expected".
- **Evidence:**
  - `apps/web/playwright.session.config.ts:91` — the harness boots the REAL server:
    `pnpm --filter @slopcad/db db:migrate && pnpm build && PORT=… node --env-file-if-exists=.env .output/server/index.mjs`.
    There is no in-memory database in the session harness; it uses the real
    `DATABASE_URL` SQLite file.
  - `packages/db/src/index.ts:37` — `createInMemoryDb()` is a **unit-test** construct
    (ephemeral temp-file libsql DB applying committed migrations); nothing in the
    session harness wires it in.
  - Playwright `page.route` interception only covers browser-originated requests; the
    catalog `refresh` runs **server-side** (tRPC, plan §1.1), so the harness cannot
    mock it from the page, and the "force-refresh catalog" command the plan itself
    adds to the manifest would make the production server fetch
    `https://models.dev/api.json` for real.
  - The relay builds its adapter from env keys (plan §1.3); "configured with the mock
    adapter" on the production build requires an env/config-gated injection seam that
    no phase designs — and Phase 6's Outputs line forbids the production change that
    seam would be.
  - `user_options` seeding likewise needs DB write access the harness does not have
    today (its only server interaction is HTTP).
- **Why it breaks:** the Phase 6 requirements reference nonexistent machinery and
  forbid the changes needed to build it. An implementer cannot comply.
- **Strengthening (edit PLAN-AGENT-CHAT.md §Phase 6):** replace the three impossible
  clauses with a designed strategy, e.g. (1) add a harness seeding step — a
  `node` script via `@slopcad/db` that inserts `model_catalog_entries` rows and the
  session user's `agent.server-ai` row into the real DB before/inside the webServer
  command chain (the config already chains commands, so this is a config edit, not
  production code); (2) make Phase 1.3 design an explicit, documented relay test seam
  (e.g. `OPENAI_COMPATIBLE_BASE_URL` pointed at a loopback mock-SSE route served by
  the app itself, or an env-gated scripted relay adapter named in the ADR) and delete
  "no production code changes expected" from Phase 6 Outputs; (3) either drop "no
  network" (the no-network rule is unit-tests-only per
  `TEST-ALIGNMENT-PLAN.md` §2 "Fixture policy") or keep it and make the seeding step
  mandatory. State explicitly that `createInMemoryDb()` is unavailable to the session
  harness.

### M1 — Phase 4.1 ports five files that already exist in `packages/ui`

- **Claim attacked (plan §4.1 + `docs/research/chatbot-template-map.md` §5):** "Copy
  and adapt per the map doc §5: `ui/message.tsx`, `ui/bubble.tsx`,
  `ui/message-scroller.tsx`, `prompt-form.tsx`, `ui/spinner.tsx`, `app/typeset.css`,
  `lib/utils.ts#safeHttpUrl`" — i.e. these are gaps to fill from the template.
- **Evidence:** `packages/ui/src/components/` already ships `message.tsx`,
  `bubble.tsx`, `message-scroller.tsx`, `input-group.tsx`, `empty.tsx` (git log: from
  the repo's `7cae135 initial commit` era, file dates Sep 16). `diff` against the
  template shows the same lineage — `message.tsx` differs only in import paths
  (`@slopcad/ui/lib/utils`) plus `gap-1.5`/`text-xs` tweaks; `message-scroller.tsx`
  differs only in imports/formatting; `bubble/input-group/empty` diverge by 69/123/65
  diff lines of the same file. `@base-ui/react` (^1.6.0) and `@shadcn/react` (^0.2.1)
  are ALREADY `packages/ui` dependencies (`packages/ui/package.json:29,33`), and
  `packages/ui/src/components/message-scroller.tsx` already imports
  `@shadcn/react/message-scroller`. Only `spinner.tsx`, `prompt-form.tsx`,
  `typeset.css`, `safeHttpUrl` are genuine gaps.
- **Why it breaks:** following the plan as written creates a second, divergent copy
  of five primitives under `apps/web/src/components/chat/`, violating AGENTS.md
  ("Search for existing components, types, and utilities before creating new ones")
  and poisoning Phase 5 (a registry item that shadows `@slopcad/ui` primitives). The
  "Replace Base UI usages with `packages/ui` equivalents" instruction is also wrong —
  `packages/ui` IS Base UI-based (`button.tsx`, `popover.tsx`, `switch.tsx`, … all
  import `@base-ui/react`); the map doc's "Base UI vs Radix" assumption is stale.
- **Strengthening:** rewrite §4.1's list to: reuse `@slopcad/ui`
  `message`/`bubble`/`message-scroller`/`input-group`/`empty` as-is (reconcile the
  style drift deliberately if the newer template variants are wanted); port ONLY
  `spinner.tsx`, `prompt-form.tsx`, `app/typeset.css`, `lib/utils.ts#safeHttpUrl`
  (and `ui/questionnaire.tsx` if the ask-user pattern is wanted); delete the
  "Replace Base UI" instruction. Also correct map doc §4/§5 accordingly.

### M2 — New webMCP tools break the s27 exact-snapshot stage; tool-binding lifetime is unaddressed

- **Claim attacked (plan §Phase 2 adds tools to the workbench registry; §Phase 4.3
  mounts the chat panel "in the workbench layout"; neither mentions the session
  harness's WebMCP snapshot stage).**
- **Evidence:** `apps/web/e2e-session/session.spec.ts:214-223` pins
  `WORKBENCH_WEBMCP_TOOLS` to exactly the 8 existing tools, and stage s27
  (`session.spec.ts:3325-3339`) asserts `toEqual([...WORKBENCH_WEBMCP_TOOLS])` on the
  workbench page's `window.__slopcadWebMcpTools()` snapshot. Any new tool registered
  on `/workbench-complete` — or registered by a chat panel mounted there — changes
  that snapshot and fails s27. Separately, tool registration is per-page-lifetime
  (`use-webmcp-tools.ts` bind/cleanup; `complete-workbench.tsx:1517`
  `useWorkbenchWebMcpTools`), and the `CadStore` lives inside the workbench page via
  `CadProvider` (internals doc §10, "Gaps & risks") — the plan never states the chat
  panel must mount INSIDE the workbench page (not the route layout / app shell) for
  the tools and store to exist.
- **Why it breaks:** Phase 6 says "Modify: … session harness files" generically but
  never names s27, so the breakage surfaces as a mysterious red gate; and an
  implementer choosing the wrong mount point gets a tool-less chat silently.
- **Strengthening:** add to §Phase 2 Requirements: "update
  `WORKBENCH_WEBMCP_TOOLS`/s27's expected snapshot for the new tools and pin where
  they bind (workbench page binding for CAD tools; chat panel must mount within the
  workbench page so `CadProvider` + the registry binding are alive)". Add the same
  constraint to §4.3's mount bullet.

### M3 — "Denied-user variant asserting the 403" fights the session harness's ONE-user design

- **Claim attacked (plan §Phase 6):** "plus a denied-user variant asserting the 403".**
- **Evidence:** the harness is contractually ONE user / ONE context:
  `playwright.session.config.ts:4-15` docblock ("ONE user, ONE browser context"),
  `:58-62` (`fullyParallel: false`, `workers: 1`), `session.spec.ts:175-199`
  (worker-scoped `sessionPage` fixture creating the single context), `session.spec.ts:274-279`
  (`SESSION_USER` — a single fresh public-flow sign-up per run), and AGENTS.md's
  testing section. Technically a test CAN destructure Playwright's `browser` fixture
  and open a second context, but that contradicts the harness's documented invariant,
  needs a full second sign-up journey, and its video-encoder/frame-scheduling rationale
  (config docblock lines 38-45) only covers the one wired context.
- **Why it breaks:** as written the requirement either silently violates the harness
  design or gets invented-around. Denial is ALREADY unit-covered: Phase 1.3 requires
  "access-gating tests (user without the `agent.server-ai` row → 403 relay + server
  mode hidden)" against `createInMemoryDb()`.
- **Strengthening:** delete the denied-user e2e variant from §Phase 6; state
  "403-denial is covered by the Phase 1.3 unit tests against `createInMemoryDb()`;
  the session walk covers only the allowed path for its one user". If an e2e denial
  is genuinely wanted, specify it as an explicit, docblock-amended second-context
  exception (or a direct relay HTTP call with a fabricated second session), not as an
  offhand clause.

### M4 — The committed models.dev fixture: ~5.3 MB and a self-contradictory validation criterion

- **Claim attacked (plan §1.1):** "a fixture JSON captured from the live API
  (committed fixture…)", "The 6-month bound is computed at request time from
  `release_date` strings — no date is hardcoded", Validation: "Filter returns the
  doc's expected counts against the committed fixture".**
- **Evidence:** live fetch today: `api.json` = 5,317,307 bytes (matches
  `docs/research/models-dev-api.md` §5). Largest git-tracked file in the repo is
  503,034 bytes (`design-shots/docs-machinist-dark.png`, via `git ls-files` + `du`);
  the fixture would be ~10× the biggest committed asset. And the doc's expected
  counts (openrouter 111 / openai 14 / anthropic 8 / google 15) are functions of
  "today = 2026-10-04"; with a request-time 6-month bound, a committed fixture plus
  pinned counts is only satisfiable on the capture date — the test rots by design.
- **Why it breaks:** repo bloat at 10× norm, and a validation criterion that
  self-destructs as the calendar advances (or forces the hardcoded date the plan
  forbids).
- **Strengthening:** edit §1.1 to (1) commit a TRIMMED fixture — only the 4 named
  providers' model objects plus crafted entries preserving the gotchas
  (`gemini-embedding-2` vision false-positive, `~`-alias ids, a `status:
"deprecated"` entry) — well under 1 MB; (2) make the filter take `now: Date` as a
  parameter; tests pin `now` to the fixture's capture date and assert the doc's
  counts; production passes `new Date()`.

### M5 — Phase sizing claim is false: at least five phases/sub-phases exceed ~500 LOC

- **Claim attacked (plan Execution notes):** "Phase sizing respects the ≤15 files /
  ≤500 LOC guidance — Phase 4 is the largest and is already split into three
  sub-phases."**
- **Evidence (estimates from the plan's own file lists + repo analogues):**
  - §1.2: 5 provider modules + index + config store + model-options builder +
    colocated tests ≈ 10–12 files, ~900–1,000 LOC (for scale: `workbench-tools.ts`
    is 430 lines for 8 tools).
  - §1.3: 3 tables + router + relay server fn + zod guards + tests ≈ ~700 LOC.
  - §Phase 2: 3 new tools (capture tool alone: camera math + settle + dataURL
    ≈ 150) + bridge + tests ≈ ~650 LOC.
  - §Phase 3: hook + persistence + MockProvider + tests ≈ ~800 LOC.
  - §4.1: `app/typeset.css` is 490 lines BY ITSELF (map doc §1); with
    prompt-form/spinner/util vendoring ≈ ~1,000 LOC.
  - §4.2: 4+ part renderers + orchestrator + composer ≈ ~700 LOC.
- **Why it breaks:** dispatches sized by these phases overrun the orchestration
  skill's guidance the plan claims to respect; validators gate over-large diffs.
- **Strengthening:** split §1.2 (providers vs config vs model-options), §1.3 (schema
  vs relay), §Phase 2 (capture tool vs get_document/get_diagnostics vs bridge),
  §Phase 3 (runtime hook vs persistence vs MockProvider), §4.1 (styles vs components),
  §4.2 (part renderers vs orchestrator) — or explicitly annotate each with a
  realistic LOC estimate and state the deviation.

### M6 — OPFS persistence under the production vite build + node-test adapter: risk waved at, not de-risked

- **Claim attacked (plan §Phase 3):** "TanStack DB collections … with
  `@tanstack/browser-db-sqlite-persistence` (OPFS) — the persistence adapter is
  injected so node tests use an in-memory adapter (no OPFS outside the browser)".**
- **Evidence:** the official guide (fetched today,
  `raw.githubusercontent.com/TanStack/db/main/docs/guides/sqlite-persistence.md`):
  the browser database "uses a worker. Its OPFS setup needs a secure context and
  browser support for OPFS" — i.e. a web-worker + WASM bundle
  (`@journeyapps/wa-sqlite`) must survive the TanStack Start `vite build` + nitro
  pipeline. The repo ships wasm already (manifold/occt kernels), but NOT a
  third-party worker+wasm package through this build graph. The harness side is
  probably fine (baseURL `http://localhost:3212` is a secure context in Chromium),
  but nothing is verified. Additionally, "an in-memory adapter" for node tests names
  no package/API — the plan's dependency list contains no node/test persistence
  package, and pnpm strict isolation means `@ag-ui/core` and any node-persistence
  package must be explicit deps.
- **Why it breaks:** if the worker/wasm bundle fails or the node test adapter doesn't
  exist in that shape, Phase 3's persistence leg stalls mid-phase with no fallback
  designed (D3 settles TanStack DB, so the fallback must live inside that decision).
- **Strengthening:** make the FIRST deliverable of §Phase 3 a timeboxed build spike:
  "prove `openBrowserWASQLiteOPFSDatabase` loads in the production build and in the
  session harness; prove a node-env collection test adapter (name the exact package
  or a `:memory:` wa-sqlite VFS); record results in the ADR before writing the
  persistence glue". Add whatever test-runtime package is needed to the §Prerequisites
  dependency list.

### Minor findings

| ID  | Claim attacked                                                                                                        | Evidence                                                                                                                                                                                                                                                                                                                      | Strengthening                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| m1  | "unit tests … run in node env — **no jsdom anywhere**" (plan lines 60-61, 335, 373)                                   | `apps/web/vitest.config.ts` sets `environment: "jsdom"` for ALL apps/web tests; AGENTS.md documents jsdom for React component tests in apps/web + packages/ui                                                                                                                                                                 | Reword to "agent logic tests add `// @vitest-environment node` docblocks"; otherwise colocated apps/web tests silently run in jsdom         |
| m2  | Phase 0 heading "ADR + **dependency pinning**"                                                                        | D15 (plan line 33): "no version pinning"                                                                                                                                                                                                                                                                                      | Retitle Phase 0 "ADR + dependency installation"                                                                                             |
| m3  | D9/Success Criteria: errors "surface in the **problems panel**"                                                       | No problems panel exists — internals doc §5: status-bar alert, timeline chips, viewport overlay, toasts                                                                                                                                                                                                                       | Name the actual surfaces in D9 (status bar + timeline chips + toasts), as Phase 2 already does parenthetically                              |
| m4  | Phase 6 adds manifest entries for "open agent settings, force-refresh catalog, clear conversation"                    | `command-surface.spec.ts:91,95` asserts menu rows ↔ checklist entries match EXACTLY both directions; Phase 4.2/4.3 only author a panel "toggle command"                                                                                                                                                                       | State in §4.2/4.3 that all four commands must be authored as palette descriptors, not just listed in Phase 6                                |
| m5  | MockProvider/relay construct stream events                                                                            | TanStack comparison docs (fetched): AG-UI events are "imported directly from `@ag-ui/core`"; `@ag-ui/core` (1.0.1) is not in the lockfile or the plan's dependency list; pnpm strict isolation blocks transitive imports                                                                                                      | Add `@ag-ui/core` to §Prerequisites (D15 pnpm add) or specify constructing events via `@tanstack/ai` re-exports                             |
| m6  | Phase 5: "Install/dry-run check passes per existing pattern" + "docs-examples usage page … for parametric-cad-viewer" | Actual pattern: `pnpm registry:build` / `registry:validate` / `registry:regenerate` / `scripts/cad-registry-matrix.sh` (root package.json:32-35); `parametric-cad-viewer` has no docs-examples entry — its demo is the `/viewer` route + `component-preview/`; `packages/docs-examples` exists but contains no viewer example | Name the exact commands in §Phase 5 Validation; say where the usage demo actually goes (component-preview page or docs-examples — pick one) |
| m7  | Phase 4.2: "a11y follows the repo's existing e2e a11y rules"                                                          | `apps/web/playwright.a11y.config.ts` runs a keyboard-journey/focus-order/error-state harness on the production build — a new interactive chat surface is exactly its prey; plan plans no a11y-harness addition                                                                                                                | Add a line: decide explicitly whether e2e-a11y gets chat stages (composer keyboard path, focus order) or record a documented decline        |
| m8  | Phase 1.3 schema: "`userId` FK → **users**"                                                                           | Table is `user` (singular), `packages/db/src/schema/auth.ts:10`                                                                                                                                                                                                                                                               | Fix the name in the plan (follows repo convention anyway)                                                                                   |
| m9  | `cad_capture_views` input `width?/height?`                                                                            | Internals doc §4: "Offscreen/custom-size renders are untested territory (the current path only captures the live canvas)"; `snapshot-export.ts:92` `captureViewportPng(canvas)` reads the live canvas                                                                                                                         | Either drop width/height from v1 or flag them as new render machinery (canvas resize) in §Phase 2, not a free extension of camera math      |

---

## Attack surfaces verified clean (no finding)

Recorded so the orchestrator knows what was checked and held:

- **Repo file/API claims — all verified:** `executeWebMcpTool`
  (`apps/web/src/webmcp/registry.ts:212-245`), `defineWebMcpTool` (`:128-141`), the
  11 tools (8 in `workbench-tools.ts:180-415`, 3 in `projects-tools.ts:120-199`),
  `parseCommand` (`packages/cad-core/src/command.ts:1182`), `applyTransaction`
  (`packages/cad-react/src/store.ts:278`), the 17 `CAD_COMMAND_TYPES`
  (`command.ts:131-150`), snapshot machinery (`snapshot-export.ts`:
  `waitForRenderedFrame:71`, `captureViewportPng:92`, `turntableCameras:119`,
  `isometricSeriesCameras:169`), Diagnostic shape `{severity, code, message,
location}` (`diagnostics.ts:184-190`), workbench docks (`complete-workbench.tsx`
  left `w-60` @2762 / right `w-[272px]` @2790, commands useMemo @1105, WebMCP binding
  @1517), `appRouter` factory composition (`packages/api/src/routers/index.ts:7-19`),
  `createInMemoryDb` (`packages/db/src/index.ts:37`), fetch guards
  (`apps/web/src/test-setup.ts:16-18`, `packages/api/src/test-setup.ts:23-25`),
  `createServerFn` convention (`apps/web/src/functions/get-user.ts`), env package
  extensibility (`packages/env/src/server.ts` createEnv server block). The internals
  doc's line references are accurate.
- **Manifest capacity:** `command-surface.checklist.json` = 53 entries + 2 declines,
  kinds `command|command-panel|panel`; its `$comment` explicitly invites "phases 57
  and later couriers [to] extend this checklist as data" — it can hold agent
  commands.
- **npm ground truth (live today):** `@tanstack/ai` 0.64.0, `ai-react` 0.29.4,
  `ai-client` 0.36.1, `ai-openai` 0.26.0, `ai-anthropic` 0.19.4, `ai-gemini` 0.34.2,
  `ai-openrouter` 0.20.2, `@tanstack/db` 0.11.3,
  `@tanstack/browser-db-sqlite-persistence` 0.2.28, `@journeyapps/wa-sqlite` 2.0.6 —
  every name exists and matches `docs/research/tanstack-ai.md` §1 exactly. (`ai-google`
  indeed does not exist; the plan correctly uses `ai-gemini`.)
- **TanStack AI doc claims (live today):** `useChat` takes `connection` XOR
  `fetcher`; `stream()` takes a factory returning `AsyncIterable<StreamChunk>`
  synchronously (documented for in-process `chat()` and tests — the MockProvider seam
  is a documented extension point via custom `ConnectConnectionAdapter`);
  `fetchServerSentEvents`/`rpcStream`/`toServerSentEventsResponse` all real;
  `toolDefinition().server()/.client()`, `needsApproval`, `emitCustomEvent` real;
  default loop bound `maxIterations(5)` real; OpenAI adapter source confirms
  `OpenAIClientConfig extends Omit<ClientOptions, "apiKey">` (so `fetch`,
  `dangerouslyAllowBrowser`, `defaultHeaders` pass through); AG-UI
  (`RUN_STARTED`/`TEXT_MESSAGE_*`/`TOOL_CALL_*` from `@ag-ui/core`) real.
- **TanStack DB persistence API:** `openBrowserWASQLiteOPFSDatabase`,
  `createBrowserWASQLitePersistence`, `persistedCollectionOptions`,
  `await collection.preload()` — exact names verified against the official guide.
- **models.dev (live today):** 226 providers; openai 53 models; fields
  `modalities.input`, `release_date`, `reasoning_options` present; most models have
  no `status` field (only 332 do) — the plan's `!deprecated` filter is safe; payload
  5,317,307 bytes matches the research doc.
- **Template portability:** `ui/message.tsx` is pure (React + `cn` only);
  `prompt-form.tsx` has zero AI-SDK imports (imports `ModelSelect` + `GatewayModel`
  — adaptation expected); `ui/message-scroller.tsx` needs `@shadcn/react` — already
  a packages/ui dep. Map doc §5's per-file classifications hold for these.
- **Formedible expressiveness for §4.3:** password field
  (`fields/password-field.tsx`), textarea (`fields/textarea-field.tsx`), async
  searchable autocomplete (`fields/autocomplete-field.tsx` `asyncOptions` with
  request-id race guard), conditional visibility (`lib/types.ts:57-59,367`
  `conditional?: string | ((values) => boolean)`), function-valued `options`. The
  settings form is expressible as config.
- **Registry feasibility:** `scripts/registry-validate.mjs` requires dependencies to
  be external package names (no workspace/catalog protocols) — `@tanstack/*` deps on
  a chat registry item are legal; installability pattern exists
  (`fixtures/cad-consumer*` + `scripts/cad-registry-matrix.sh`).
- **D1–D15 compliance sweep:** no requirement sends a user key server-side (relay
  input schema has no key field + rejection test), nothing preselects a
  provider/model, no custom effort abstraction, no dedicated flag table, no
  propose-then-apply execution. Consistent throughout.
- **Stale-term grep:** no `agent_server_access`, no `effort.ts`, no
  `OPENAI_API_KEY`, no raw-string-ONLY remnants, no jsdom-era text beyond m1's
  wording issue, only the "pinning" heading (m2).
- **Omission checks:** no i18n system exists in the repo (nothing to comply with);
  theme/scheme two-axis inheritance is correctly planned; embed mode (`/viewer`) is
  untouched by the workbench-mounted panel.

## UNVERIFIED (epistemic gaps for the orchestrator)

1. **Anthropic/Gemini browser-direct runtime behavior** — the
   `anthropic-dangerous-direct-browser-access` header and Gemini browser safety are
   type-level inferences ([I] in tanstack-ai.md); TanStack docs are silent on CORS,
   and I could not exercise a real browser call here. The plan already orders
   per-provider verification at implementation time.
2. **`StreamChunk` public constructibility** — the type is documented as the
   stream/`fetcher` currency, and custom connection adapters are documented, but I
   did not confirm `StreamChunk` (vs `@ag-ui/core` events) is directly exported for
   consumer construction; affects MockProvider's exact shape.
3. **wa-sqlite worker+WASM through the TanStack Start `vite build`/nitro pipeline,
   and OPFS behavior inside the harness's headless SwiftShader Chromium** — secure
   context is satisfied (localhost), but the bundle path is unproven (see M6).
4. **models.dev expected counts (111/14/8/15)** — I confirmed the API's live schema
   and size today but did not re-run the 6-month filter; the counts are inherently
   date-bound (see M4).
5. **A node/in-memory TanStack DB persistence adapter's exact package/API** — the
   guide lists a node runtime; the precise name and in-memory capability were not
   verified.
6. **`pnpm add` lockstep resolution** — `@tanstack/ai-react` peer-depends on the
   `@tanstack/ai` minor (research §1); today's latests align, but whether a future
   `pnpm add` at latest stays conflict-free is unknowable now.
7. **`@shadcn/react` subpath (`/message-scroller`) as an apps/web-level import** —
   it works inside packages/ui today; whether the plan's apps-web-placed primitives
   should depend on it directly (vs re-export from packages/ui) is untested.
