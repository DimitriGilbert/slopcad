# ROADMAP-AGENT-SURFACE — the agent interaction surface plan (Phases 0–14)

_Epoch: 2026-09-29, branch `agent-surface`, before any agent-surface work
lands. The plan was approved in an orchestration planning session and is
executed phase by phase through subagent implementation passes, each gated
by `pnpm run verify`. The owner rulings that shaped it are logged in §7.
It plans; it does not implement._

## 1. What this is — and what it is not

Three workstreams, one subject: the ways an agent — human, scripted, or
browser-resident — authors, drives, and learns slopcad.

- **`@slopcad/cad-jsx` — `.tsx` as a first-class exchange format.** The
  React binding the PRD recorded as missing: §23 "React layer" promised
  "declarative model definitions where useful", and §32 sketched the
  component ideal — `<Nema17Mount motorSize={17} plateThickness={3}
holeSpacing={31} units="mm" />` (`slopcad — Product & Technical
Requirements.md`) — which shipped as `packages/cad-components` WITHOUT
  JSX (the serialized component contract plus kernel surfaces,
  programmatic only). This workstream closes the gap: CAD models authored
  as `.tsx` React files, compiled deterministically to the existing
  CadCommand vocabulary (`packages/cad-core/src/command.ts`: 15 command
  types, `applyCommand` the sole interpreter). JSX is sugar over
  `applyCommand`; the "no second parametric representation" hard rule
  (`packages/cad-react/src/model.ts`) is respected by construction. Ships
  with a compile CLI, native-format emission
  (`packages/cad-core/src/native-format.ts`), and `.tsx` import/export in
  the workbench.
- **WebMCP — the page as a tool provider.** The W3C Web Machine Learning
  CG draft protocol (spec: `https://webmachinelearning.github.io/webmcp/`;
  Chrome docs: `https://developer.chrome.com/docs/ai/webmcp` and
  `.../imperative-api`, currently behind a Chrome origin trial): the web
  PAGE registers typed tools on `document.modelContext` for
  browser-resident agents. Imperative API only — `registerTool` with
  name/description/inputSchema/execute/annotations, unregistration via
  AbortSignal, `toolchange`/`toolactivated`/`toolcancel` events,
  Permissions-Policy `tools`, SecureContext. Handlers drive the same
  domain state as the UI (the CadProvider store, the tRPC client, the
  command-surface verbs). No server endpoint, no API keys — the user's
  session is the auth. Safe no-op where the API is absent; an internal
  registry is the testable source of truth.
- **Tutorial studio — the product taught by video.** Teaching videos
  ("where to find what, where to click, what to change and why") built on
  the session-harness driving code (`apps/web/e2e-session/session.spec.ts`
  — 56 serial stages, `s01 home` → `s26b persistence`, over the production
  build; the Phase 60 command-surface checklist at
  `apps/web/e2e-workbench/command-surface.checklist.json` — 52 capability
  entries plus two documented declines — whose ids and capability
  sentences seed chapter keys and narration). Gliding visible cursor +
  click ripples (an `addInitScript` overlay + `humanClick` glides),
  deliberate pacing, per-chapter educational narration, WebVTT captions +
  chapter index + ffmpeg cutting. Caption cues are the single narration
  source, so TTS can be muxed in later without re-recording.

What it is not: not a second parametric language (everything compiles to
`applyCommand`), not a server-side agent backend or key store, not a
video-production suite (ffmpeg cutting is the whole pipeline).

## 2. The laws every agent-surface phase obeys

All nine laws of ROADMAP-CAD-PARITY §1 are inherited unchanged (capability
flags with honest declines, byte-determinism of persisted data, budgets
discipline, public-API UI composition, Formedible forms, the `pnpm run
verify` gate, OCCT-first where BREP is required, docs-follow-code, OCCT
memory discipline). The agent surface adds its own:

- **A1 — JSX is sugar over `applyCommand`.** The compiler emits only the
  15-type CadCommand vocabulary; the document stays the sole model (the
  `packages/cad-react/src/model.ts` hard rule). Function components only —
  class components and hooks are rejected with structured errors. No
  react-reconciler, no DOM.
- **A2 — Byte-stable round-trip is the exchange gate.** `model.tsx` →
  native → document → `generated.tsx` → native must be byte-identical.
  Records a generator cannot represent honestly get structured decline
  notes in the emitted file — never silent approximation.
- **A3 — WebMCP is a projection, not a second API.** Tool handlers drive
  the same domain state as the UI (CadProvider store, tRPC client,
  command-surface verbs). No server endpoint, no API keys, and no new auth
  surface anywhere.
- **A4 — Safe no-op where `document.modelContext` is absent.** The
  internal registry is the source of truth; the browser API is one
  listener in front of it.
- **A5 — Captions are the single narration source.** WebVTT cues carry the
  chapter timing and text; a later TTS pass muxes against them without
  re-recording. Videos are gitignored under `docs/tutorials/media/`;
  transcripts, chapters, VTT, and the index are committed.
- **A6 — The command-surface checklist changes only as data, and only if
  the audit requires.** `pnpm audit:command-surface` stays green.

## 3. Verified inventory — what the agent surface builds on

Everything below exists in code on this branch; paths are the anchors.

- **The command substrate**: `CAD_COMMAND_TYPES` — 15 command types
  (`parameter.set`/`parameter.create`, `feature.create`/`update`/`delete`/
  `reorder`, `body.create`/`update`, `sketch.create`, `reference.create`,
  `datum.create`, `curve.create`, `configuration.create`/`update`/`delete`)
  with `applyCommand` as the sole interpreter
  (`packages/cad-core/src/command.ts`). This is the compiler's entire
  output vocabulary.
- **The hard rule, already written**: `packages/cad-react/src/model.ts` —
  "No second parametric representation": React describes, `applyCommand`
  executes, and nothing becomes a parallel model. The JSX binding is
  designed inside this sentence.
- **Native format**: `packages/cad-core/src/native-format.ts` +
  `native-migration.ts` (byte-deterministic resave is pinned by suite) —
  the compilation target and the round-trip anchor.
- **The components precedent**: `packages/cad-components` (`enclosure`,
  `nema17Mount`, `arduinoMount`) — the PRD §32 idea shipped programmatic;
  the JSX binding makes the §32 syntax real without touching the
  component contract.
- **The import-route precedent**: `apps/web/src/routes/api/io/import-3mf.ts`
  delegating to `apps/web/src/io-fixture/import-3mf-endpoint.ts` — session
  gate (401), 64 MiB body cap (413), structured adapter failures passing
  through (422). The `/api/io/import-tsx` route copies this shape.
- **The session harness**: `apps/web/e2e-session/session.spec.ts` (3,369
  lines, 56 serial stages `s01`→`s26b` over the production build) with
  `apps/web/playwright.session.config.ts` (ONE context, workers 1,
  1280×720, DPR 1, SwiftShader flags, video on as a rendering primitive,
  webServer = committed migrations → `pnpm build` → the production server).
  The tutorial harness clones these knobs.
- **The checklist**: `apps/web/e2e-workbench/command-surface.checklist.json`
  — the Phase 60 audit data (52 entries, each with
  id/phase/capability/route/kind/target/keywords, plus two documented
  declines), kept honest by `scripts/command-surface-audit.mjs`
  (`pnpm audit:command-surface`).
- **React + tRPC state**: the CadProvider store
  (`packages/cad-react/src/provider.tsx`, `store.ts`) and the tRPC client
  (`apps/web/src/utils/trpc.ts`) — exactly what WebMCP handlers drive.
- **Routes for registry assertions**: `/workbench-complete`
  (`apps/web/src/routes/workbench-complete.tsx`) and `/projects`
  (`apps/web/src/routes/_auth/projects.index.tsx`).
- **Docs machinery**: `docs/README.md` ("The topic map") and the
  `docs/guides/` family; the dangling reference —
  `packages/docs-examples/src/react/store.tsx` cites `docs/guides/react.md`,
  which does not exist yet. Phase 5 closes it.
- **Dependency facts**: the `pnpm-workspace.yaml` catalog carries
  `react` ^19.2.8 / `react-dom` / `zod` ^4.5.4; esbuild 0.28.2 is already
  in `pnpm-lock.yaml` through vite (and `allowBuilds` lists it).

## 4. Execution plan — 15 phases (Phase 0 → Phase 14)

Validation baseline for EVERY phase: `pnpm run verify` green; fix every
error at the cause. Each phase lists Requirements (file-anchored),
Validation, Dependencies, and Risk.

### Phase 0 — This document

**Requirements**: `ROADMAP-AGENT-SURFACE.md` at the repo root, structural
shape of `ROADMAP-SIM.md`, the nine laws inherited from
ROADMAP-CAD-PARITY §1, every existing-code claim verified on this branch.

**Validation**: `pnpm run format:check`; inventory anchors re-checked by
grep before writing.

**Dependencies**: none.

**Risk**: drift — every later phase re-verifies its anchors at entry.

### Phase 1 — cad-jsx scaffold + compiler core

**Requirements**: the workspace package `packages/cad-jsx`
(`@slopcad/cad-jsx`), package deps `@slopcad/cad-core` only; the element
type system for `Parameter`/`Body`/`Box`/`Sphere`/`Cylinder`/`Cone`/
`Translate`; `compileModel` as a deterministic tree-walk — function
components only; class components and hooks rejected with structured
errors; no react-reconciler, no DOM.

**Validation**: deterministic golden tests (same tree in → same command
list out, pinned); rejection specs (class component, hook call); package
boundary (no imports beyond cad-core).

**Dependencies**: none.

**Risk**: low — a pure function over an existing vocabulary.

### Phase 2 — The full element vocabulary

**Requirements**: `Union`/`Subtract`/`Intersect` with children as
FeatureInputRefs; `Fillet`/`Chamfer`/`Shell`/`Thicken`/`Split`/`Hole`/
`Rib`/`Thread`/`Helix`/`Scale`/`MoveFace`/`ReplaceFace`/`DeleteFace`;
`PatternLinear`/`PatternCircular`/`PatternPath`/`Mirror`; `Sketch` with
`Line`/`Rectangle`/`Circle`/`Arc`/`Ellipse`/`Slot`/`Polygon`/`Spline`/
`Point` entity children emitting cad-sketch canonical payloads (the
`SKETCH_ENTITY_KINDS` vocabulary, `packages/cad-sketch/src/entities.ts`);
input refs by explicit id or document order; shared subtrees stay
top-level (referenced, never duplicated).

**Validation**: golden command lists per element kind; equivalence
fixtures against hand-built documents where kinds overlap; sketch payload
fixtures against the cad-sketch builders.

**Dependencies**: 1.

**Risk**: medium — the ref-resolution rules (id vs document order) must be
pinned by fixtures before Phase 4's generator mirrors them.

### Phase 2b — Amendment: the sketch-driven producers (2026-09-29)

An orchestrator amendment, executed after Phase 2 with the same
implement→validate discipline: the approved Phase 2 element list omitted
the sketch-driven PRODUCER features — the most fundamental CAD verbs. Scope:
`Extrude`/`Revolve`/`Sweep`/`SweepWire`/`Loft` in `packages/cad-jsx`,
each prop/input layout derived from the kernel bridge's feature-kind
dispatch (sketch inputs via in-scope `<Sketch id=…>` references; the
`crv_…` spine addressed by record id, the datum discipline). Phase 2's
honest-decline note for these kinds is retired; curve-record declaration
remains declined. No plan dependencies change (Phases 3–4 consume the
vocabulary as-is).

### Phase 3 — Native emission + compile CLI

**Requirements**: `compileToNative` emitting through
`packages/cad-core/src/native-format.ts`; a compile CLI (file/stdin →
native string); a runnable `packages/docs-examples` example.

**Validation**: CLI output → load → `applyCommand` equals the in-process
compile; byte-determinism of the emitted native; the docs example typechecks,
builds, and runs with the examples gate.

**Dependencies**: 2.

**Risk**: low.

### Phase 4 — `.tsx` import/export in the workbench

**Requirements**: the server route `/api/io/import-tsx` on the import-3mf
pattern (session gate 401, body cap, esbuild transpile → `node:vm` sandbox
exposing only react + the cad-jsx element runtime → `compileModel` →
native string → the existing import apply); the pure document→TSX generator
`generateTsx` (feature DAG → JSX tree, shared inputs as top-level
id-referenced elements, honest structured decline notes for
non-representable records); a Formedible import dialog entry + an export
dialog format. Hard gate: byte-stable round-trip `model.tsx` → native →
document → `generated.tsx` → native.

**Validation**: sandbox unit tests (no host globals reachable); round-trip
byte suites; a session e2e stage; `pnpm audit:command-surface` green —
checklist extension only as data if the audit requires.

**Dependencies**: 3.

**Risk**: medium-high — the sandbox and the round-trip honesty (§6, R2/R3).

### Phase 5 — Docs guides

**Requirements**: `docs/guides/react.md` (closes the dangling reference
from `packages/docs-examples/src/react/store.tsx`); `docs/guides/cad-jsx.md`;
`docs/README.md` topic-map rows for both.

**Validation**: `pnpm test:docs`; the docs-follow-code law — every claim
anchored to shipped code.

**Dependencies**: 4 (documents what shipped).

**Risk**: low.

### Phase 6 — The agent skill

**Requirements**: `skills/slopcad-cad-jsx/SKILL.md` in a `skills/`
directory at the project root — a committed repo artifact that distributes
with the repository; an AGENTS.md load rule pointing at it. Nothing in
`.zcode/`.

**Validation**: the skill's instructions run against the repo as-is
(compile a fixture `.tsx` through the CLI).

**Dependencies**: 3 (the CLI must exist); parallel with 4–5.

**Risk**: low.

### Phase 7 — WebMCP core

**Requirements**: `apps/web/src/webmcp/`: `model-context.ts` (a minimal
local TS interface for `document.modelContext` — the spec IDL subset this
repo consumes), `registry.ts` (the source-of-truth registry with
zod → JSON Schema conversion), `use-webmcp-tools` (the registration hook
with AbortSignal unregistration); the workbench tools
`cad_get_document_summary` / `cad_list_commands` / `cad_run_command` /
`cad_set_parameter` / `cad_undo` / `cad_redo` / `cad_apply_commands` /
`cad_measure`, driving the same CadProvider store and command verbs as the
UI.

**Validation**: unit tests with a fake `modelContext` (registry →
registerTool calls, schema conversion, execute round-trips); the safe
no-op path when the API is absent.

**Dependencies**: none code-wise (parallel with 1–6; the command surface
it drives is present).

**Risk**: medium — spec draft churn (§6, R1); the local interface +
registry seam absorbs it.

### Phase 8 — WebMCP projects tools + ADR

**Requirements**: `projects_list` / `projects_create` / `open_document`
via the tRPC client (`apps/web/src/utils/trpc.ts`); session e2e registry
assertions on `/workbench-complete` and `/projects`;
`docs/architecture/adr-webmcp.md` recording the imperative-only scope, the
deferral of declarative form annotations, and the no-server ruling.

**Validation**: the session harness extended and still at 100% manifest
coverage; the ADR in the family style of the existing
`docs/architecture/adr-*` records.

**Dependencies**: 7.

**Risk**: low-medium.

### Phase 9 — Session helpers extraction

**Requirements**: mechanical extraction of the session spec's helper
blocks (~lines 229–536: the canvas-point helpers and the session user
identity; ~lines 1744–1783: `collectDownloads`) into
`apps/web/e2e-session/helpers.ts` — zero behavior change, a pure move.

**Validation**: the session harness green at 100% manifest coverage with
untouched stage semantics; move-only diff discipline.

**Dependencies**: none — land it before Phase 10 clones the driving code.

**Risk**: low (§6, R7).

### Phase 10 — Tutorial harness core + pilot chapters

**Requirements**: `apps/web/e2e-tutorial/` with a config cloning the
session knobs (1280×720, DPR 1, SwiftShader, video on, production
webServer); the cursor overlay via `addInitScript` — a visible gliding
cursor with click ripples; `humanClick` glides + dwell pacing; the
narration timeline bound to step ids; a reporter publishing `master.webm` +
`master.vtt` + `chapters.vtt` + `chapters.json`; three pilot chapters:
home tour, sketch workspace, extrude.

**Validation**: pilot review by the owner before any batch (§6, R5);
artifacts under `docs/tutorials/` with media gitignored.

**Dependencies**: 9.

**Risk**: medium — narration quality and pacing are editorial; the pilots
exist to calibrate them.

### Phase 11 — Tutorial batch: workbench fundamentals

**Requirements**: chapters for base tools; selection/measure/rotate;
undo/redo/rollback; display modes; camera; section clip.

**Validation**: per-chapter VTT + ripple/cursor assertions in the harness;
narration seeded from the manifest capability sentences.

**Dependencies**: 10.

**Risk**: low once the pilots are approved.

### Phase 12 — Tutorial batch: the feature authoring tour

**Requirements**: chapters for sketch-on-face, sweep, loft, helix, thread,
draft, rib, scale, split, holes, patterns, mirror, booleans, surfaces,
curves.

**Validation**: as Phase 11; chapter keys derived from manifest ids.

**Dependencies**: 10.

**Risk**: low; volume is the only cost.

### Phase 13 — Tutorial batch: assemblies & documents + full coverage

**Requirements**: chapters for the assembly tree, motion/explode,
interference, analysis, drawings, BOM, import/export (including the `.tsx`
round-trip), projects/version history. The full chapter set must cover
every command-surface manifest entry id.

**Validation**: a coverage assertion — chapter keys ⊇ manifest entry ids
(52 entries; the two documented declines are narrated as the honest
declines they are, mirroring the checklist's own declines section).

**Dependencies**: 10–12 (batch order flexible; the coverage gate closes
here).

**Risk**: medium — long tail of small chapters; the manifest-seeded keys
keep scoping mechanical.

### Phase 14 — Cutting, scripts, docs, and the final gate

**Requirements**: `scripts/tutorial-cut.mjs` wired as `tutorial:cut`
(ffmpeg — a system prerequisite for cutting only): per-chapter clips +
re-timed VTT from `master.webm` + `chapters.vtt`; a `tutorial:record`
script; `docs/tutorials/index.md` (the generated chapter index);
`docs/guides/tutorials.md`; the final gate — `pnpm run verify` +
`pnpm audit:command-surface` + the full session harness + the full
tutorial record/cut cycle.

**Validation**: the final gate, run end to end from a clean tree.

**Dependencies**: 13.

**Risk**: low — ffmpeg availability is the only environment dependency
(documented prerequisite).

### Sequencing

```
0 this doc
│
├─ JSX line:    1 compiler core → 2 vocabulary → 3 native + CLI
│                                              → 4 workbench .tsx io → 5 docs → 6 skill
│
├─ WebMCP line: 7 core → 8 projects tools + ADR      (parallel with the JSX line)
│
└─ studio line: 9 helpers → 10 harness + pilots → 11 fundamentals → 12 authoring
                                                    → 13 assemblies + coverage → 14 cutting + gate
```

Milestones for the owner: **M-A1 "JSX is commands"** (1–3), **M-A2
"round-trip in the workbench"** (4–6), **M-A3 "the page speaks"** (7–8),
**M-A4 "it teaches"** (9–13), **M-A5 "the cuts ship"** (14).

## 5. Success criteria

`pnpm run verify` green; `pnpm audit:command-surface` green; the session
harness (`pnpm --filter web test:session`) green at 100% manifest
coverage; a `.tsx` compiles via the CLI, imports/exports through the
workbench dialogs byte-stably, and applies live via the WebMCP
`cad_apply_commands` tool; the tutorial master video exists with a visible
gliding cursor + click ripples + per-chapter VTT + an index covering every
manifest functionality; the skill ships from the repo's own `skills/`
directory.

## 6. Risk register

| #   | Risk                                                                       | Phases | Severity | Mitigation                                                                                               |
| --- | -------------------------------------------------------------------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------- |
| R1  | WebMCP spec draft churn (CG draft; Chrome docs record ongoing API changes) | 7, 8   | medium   | local minimal interface; the registry seam; the ADR records deferrals                                    |
| R2  | Sandboxed TSX evaluation security                                          | 4      | high     | `node:vm` isolation; allowlist (react + cad-jsx element runtime only); body cap; session gate            |
| R3  | Byte-stable round-trip across the full vocabulary                          | 2–4    | high     | incremental golden tests per kind; honest structured decline notes for non-representable records         |
| R4  | esbuild/vite version coupling                                              | 4      | medium   | esbuild pinned to the lockfile version (0.28.2, already present via vite); direct dep for the route only |
| R5  | Tutorial narration quality at scale                                        | 10–13  | medium   | pilot review before batches; manifest capability sentences as narration seeds                            |
| R6  | Video artifact size in CI-less local runs                                  | 10–14  | medium   | media gitignored under `docs/tutorials/media/`; transcripts/chapters/VTT/index committed                 |
| R7  | Session harness regression during helpers extraction                       | 9      | medium   | pure-move discipline; the full session run at 100% manifest coverage as the gate                         |

## 7. Decision log (owner rulings, 2026-09-29)

1. **The skill lives in a `skills/` directory at the project root**
   (`skills/slopcad-cad-jsx/SKILL.md`) — a committed repo artifact that
   distributes with the repository; AGENTS.md gets a load rule pointing at
   it. Nothing in `.zcode/`.
2. **`.tsx` import/export are workbench features, not just a CLI.** Import
   via `/api/io/import-tsx` (the import-3mf pattern: session gate 401,
   body cap, esbuild transpile → `node:vm` sandbox exposing only react +
   the cad-jsx element runtime → `compileModel` → native string → the
   existing import apply); export via a pure document→TSX generator
   (feature DAG → JSX tree, shared inputs as top-level id-referenced
   elements, honest structured decline notes for non-representable
   records). Hard gate: byte-stable round-trip `model.tsx` → native →
   document → `generated.tsx` → native.
3. **WebMCP = the browser-native spec, imperative only.** Declarative form
   annotations are deferred (that spec half is TODO); a server-side MCP
   endpoint / API keys are rejected and out of scope.
4. **No new auth surface anywhere.**
5. **Tutorials: master recording + chapter cuts, silent video + captions.**
   The TTS extension point is designed but not built. Videos are
   gitignored under `docs/tutorials/media/`; transcripts, chapters, VTT,
   and the index are committed.
6. **Dependencies:** react/zod from the pnpm catalog; esbuild as a direct
   dep only for the TSX import route (already in the lockfile via vite); a
   local minimal TS interface for `document.modelContext`; ffmpeg a system
   prerequisite for cutting only.
7. **The command-surface checklist changes only as data if the audit
   requires; `pnpm audit:command-surface` must stay green.**

## 8. Out-of-scope boundary (explicit, overridable by the owner)

Declarative WebMCP form annotations; TTS generation/muxing; a server-side
MCP endpoint / API keys; committing video binaries; dev-server automation
beyond the existing harness webServer patterns. Raising any of these
re-opens this document.
