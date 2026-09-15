# slopcad

## Overview

Build `slopcad`, a modular, browser-native, parametric CAD SDK for TypeScript and React.

The system is intended to provide the programming model of a modern web framework around CAD:

- kernel-independent parametric document model
- typed parameters and expressions
- feature/dependency graph
- pluggable geometry kernels
- Manifold as the first production kernel
- OpenCascade as a later advanced BREP/STEP backend
- React integration
- React Three Fiber renderer
- headless CAD tools and interaction model
- shadcn-based CAD components in the existing `packages/ui`
- source-distributed CAD UI through a shadcn registry
- native parametric document persistence
- standard geometry/file interoperability
- eventual profiles/projects persistence using the already-existing backend/auth/database
- rigorous TDD
- browser E2E testing
- screenshot regression testing
- video capture for interaction-heavy workflows

The existing Better-T-Stack bootstrap is complete and is **not a project phase**.

The existing generic shadcn setup in `packages/ui` is complete and is **not a project phase**.

The existing backend/auth/database is retained for later application persistence but remains outside the CAD-core dependency graph.

Owner decisions incorporated into this plan:

```text
- License: MIT.
- No CI, ever: quality gates are local commands (root `pnpm verify`) run by
  implementer/validator agents per the fleet test-alignment policy (D1–D7).
- Nothing is published to npm or any registry until the owner explicitly
  decides; consumer fixtures use locally generated artifacts.
- The CAD domain executes client-side in a Web Worker; the server never
  computes or renders geometry. Future AI integration acts through the
  client command bus only.
- Browser matrix: evergreen trio (Chromium every phase; Firefox + WebKit at
  hardening phases). No SharedArrayBuffer / crossOriginIsolation requirement;
  COOP/COEP is a documented future opt-in. Node >= 22 LTS pinned via .nvmrc.
- Evidence semantics: geometry correctness is proven by semantic numeric
  assertions; pixel screenshots (software WebGL / SwiftShader, fixed DPR)
  cover UI chrome and composed scenes; videos are artifacts whose existence
  and duration validators check — content review is human and optional.
- Roadmap commitments (not non-goals): assemblies, i18n (labels externalized
  from the first CAD components), 2D drawings later. Permanent non-goal:
  CAM/toolpaths — export STEP/3MF to dedicated slicers/CAM tools instead.
```

Execution state:

```text
Phase 1    COMPLETED 2026-09-15 — deliverables in docs/architecture/
           (repository-baseline.md, dependency-map.md, testing-baseline.md);
           do not re-execute.
Phase 1.5  COMPLETED 2026-09-15 — full harness built and validated
           (adversarial validator PASS, all findings fixed): pnpm verify
           green, 17 unit tests, Playwright smoke with screenshot/video/trace
           evidence, coverage+CRAP+jscpd pipeline, strict lint/format.
           Evidence and policy: TEST-ALIGNMENT-PLAN.md; do not re-execute.
ENTRY POINT: Phase 1.6 (Architecture Spike). Everything from Phase 1.6 on
           executes per the rules below, full auto, three-strike halt.
```

The development workflow is governed by the `subagent-orchestration` skill:

```text
User approves plan once
        ↓
Phase
        ↓
Implementer
        ↓
Implementer gate
        ↓
Validator
        ↓
PASS ─────────────→ next phase
        │
       FAIL
        ↓
Fixer
        ↓
Validator
        ↓
up to 3 validation attempts
```

For parallel phases, each sub-task receives its own implementer and immediate validator, followed by a phase-level validator. This separation and the three-attempt validation loop are requirements of the orchestration skill.

No phase may advance while its validation gate is failing.

---

# Prerequisites

- The existing `slopcad` Better-T-Stack repository exists.
- The existing Better-T-Stack scaffold is functional.
- `pnpm` is installed.
- The repository's TypeScript and build tooling is functional. Test, lint, and E2E tooling does **not** exist yet (verified 2026-09-14: no Vitest, no Playwright, no lint, no CI anywhere in the repo) and is bootstrapped by Phase 1.5 before any CAD phase runs.
- `packages/ui` exists and contains the existing shadcn setup.
- The existing backend/auth/database remains available for later phases.
- Browser automation: Playwright is absent today and is bootstrapped in Phase 1.5.
- A working browser environment is available for visual/E2E validation.
- The repository is under version control.
- Agents have permission to create and modify project files.
- Agents must follow the NO-SLOP policy from the orchestration skill.
- Every created package must expose a `check-types` command and a `test` script wired into the root verify chain; this is explicitly required by the orchestration workflow. `apps/web` gains its missing `check-types` in Phase 1.5.
- The geometry implementation may use WebAssembly.
- No OCCT installation is required for the early phases.
- No external CAD application is required for the early phases.

---

# Phase 1: Repository Baseline and Existing Architecture

**Status**: COMPLETED 2026-09-15 — deliverables exist in `docs/architecture/`; do not re-execute.

**Type**: Sequential

**Requirements**:

- Inspect the actual repository before any CAD implementation begins.
- Identify the exact Better-T-Stack workspace structure produced by the user's bootstrap command.
- Identify the exact frontend application path.
- Identify the exact backend/server application path.
- Identify the exact `packages/ui` structure.
- Identify existing TypeScript configuration and path aliases.
- Identify existing lint and formatting configuration.
- Confirm the absence of unit/integration test configuration (none exists today; bootstrapped in Phase 1.5).
- Confirm the absence of Playwright configuration (none exists today; bootstrapped in Phase 1.5).
- Document that browser test conventions start from zero in Phase 1.5.
- Identify current build commands; confirm no CI exists and none will be created (owner policy — local verify gates only).
- Identify existing package naming conventions.
- Identify how package-level `check-types` scripts are currently implemented.
- Verify the repository is green before CAD work begins.
- Do not redesign the existing scaffold.
- Do not replace existing auth/backend/database.
- Do not replace existing shadcn setup.

**Inputs**:

- Read: repository root
- Read: root `package.json`
- Read: workspace configuration
- Read: Turborepo configuration
- Read: all relevant `tsconfig` files
- Read: existing application package manifests
- Read: `packages/ui/**`
- Read: existing test configuration
- Read: existing Playwright configuration
- Read: existing CI configuration

**Outputs**:

- Create: `docs/architecture/repository-baseline.md`
- Create: `docs/architecture/dependency-map.md`
- Create: `docs/architecture/testing-baseline.md`
- Modify: none unless a pre-existing configuration is demonstrably broken and the validator requires its repair

**Validation Criteria**:

- Type check: Zero errors.
- Absence of tests/Playwright/lint/CI is documented as the baseline (verified 2026-09-14: none of these exist); nothing is fabricated to pass.
- Existing build: Success.
- (No Playwright suite exists yet — bootstrapped in Phase 1.5; nothing to run here.)
- Exact repository paths are documented.
- Existing frontend/backend/UI boundaries are documented.
- No CAD implementation is introduced.
- Validator has read all generated documentation and confirms it matches the repository.
- Repository remains functionally unchanged.

**Dependencies**: None

---

# Phase 1.5: Test and Quality Baseline

**Status**: COMPLETED 2026-09-15 — built and adversarially validated (PASS, findings fixed); see `TEST-ALIGNMENT-PLAN.md`; do not re-execute.

**Type**: Sequential

**Requirements**:

- Adopt the fleet test-alignment policy (D1–D7) adapted to this zero-test repository; no CI is created, ever.
- Bootstrap Vitest (v4 line) with a `createTestConfig()` factory in `packages/config` (`@slopcad/config`): node environment by default, jsdom only where React/DOM is under test, colocated `*.test.ts(x)` layout.
- Bootstrap ESLint 9 flat config + typescript-eslint + `eslint-plugin-react-hooks` (apps/web, packages/ui) + `import/order`; zero errors, zero suppressions.
- Add Prettier 3 with one isolated whitespace-only format pass.
- Bootstrap Playwright (Chromium first) with one real smoke test; deterministic configuration (fixed viewport/DPR 1, software WebGL via SwiftShader for later visual tiers) and trace-on-retry enabled so failures leave inspectable traces.
- Coverage via `@vitest/coverage-v8`, report-only (zero-test repo — fleet state 3); thresholds arrive later via the measure-then-ratchet policy.
- knip + jscpd, local and report-only (knip is required long-term: this repo publishes packages).
- Once coverage output exists, add `crap-score` over the coverage data to the local quality report (report-only, CRAP >= 30 flagged) — completing the fleet's metric trio of coverage, duplication, and complexity.
- Root headless verification entrypoint: `pnpm verify` = `check-types` → `lint` → `test` → `build`, extended as tiers arrive; this is the gate implementer/validator agents run at every phase boundary.
- `apps/web` gains its missing `check-types` script; the currently dead turbo `lint` task becomes live.
- Pin Node >= 22 LTS via `.nvmrc`.
- Wire the currently unused `@testing-library/*` + `jsdom` devDependencies in `apps/web` into real tests or remove them.

**Outputs**:

- Create: vitest factory + per-package configs
- Create: eslint flat config, prettier config
- Create: playwright config + smoke test
- Create: `.nvmrc`, `TEST-ALIGNMENT-PLAN.md` (fleet pattern)
- Create: root `verify` script
- Modify: root package scripts, `packages/config`, `apps/web` scripts, turbo tasks

**Validation Criteria**:

- `pnpm verify` exits 0 from the repo root and chains check-types → lint → test → build.
- `pnpm test` runs at least one real, non-tautological test per test-bearing package.
- `pnpm lint` exits 0 with zero errors and no new suppressions.
- Playwright smoke passes headlessly under software WebGL.
- The smoke test produces a screenshot artifact and a video artifact (and a trace on forced failure), proving the inspectable-evidence pipeline end to end before any CAD phase relies on it.
- No `.github/workflows` exists; no CI is created.
- No `passWithNoTests`, no `echo` test scripts, no fake-green runners.
- `TEST-ALIGNMENT-PLAN.md` matches the repository's actual state.

**Dependencies**: Phase 1 must complete successfully

---

# Phase 1.6: Architecture Spike (kept as reference)

**Status**: NEXT — the execution entry point.

**Type**: Sequential

**Requirements**:

- Build end-to-end with deliberately small scope: `param` → `box` → `subtract` → Manifold (WASM) → worker or in-memory transport → R3F `CadModel` → deterministic screenshot.
- Draft the authoring API (`cad({ parameters, build })`, `feature()`); it is expected to be redesigned during the core phases, not defended.
- Smoke-test the real bundling path: Vite + `manifold-3d` WASM inside a Worker under the TanStack Start build.
- Validate the screenshot determinism strategy under software WebGL.
- The spike code is **kept** under a clearly-marked non-production path (e.g. `spike/`), excluded from the published build graph and the verify chain; it is referenced from `docs/architecture/spike-findings.md` so implementers of later phases build on its findings instead of starting from scratch.

**Outputs**:

- Create: spike implementation (non-production path)
- Create: `docs/architecture/spike-findings.md` (contracts draft: kernel boundary, projection boundary, authoring API, bundler notes, screenshot determinism)

**Validation Criteria**:

- Changing a parameter visibly updates the rendered model in the browser.
- The rendered screenshot is reproducible across two consecutive runs under software WebGL.
- The findings document answers: what a parameter looks like, what a feature graph looks like, what the kernel boundary is, what the render projection boundary is.
- Spike code is preserved and referenced; nothing from the spike leaks into production package source.

**Dependencies**: Phase 1.5 must complete successfully

---

# Phase 2: CAD Package Boundaries

**Type**: Sequential

**Requirements**:

- Create only the minimum initial CAD packages required for the architecture.
- Establish a kernel-neutral CAD core.
- Establish the kernel abstraction package.
- Establish the Manifold adapter package.
- Establish the React integration package.
- Establish the R3F package.
- Every package must expose `check-types`.
- Every new package is born with a Vitest config (via the `@slopcad/config` factory), lint coverage, and a `test` script wired into the root verify chain.
- Every package must have a build path consistent with repository conventions.
- `cad-core` must not depend on React, Three.js, R3F, browser APIs, or a kernel implementation.
- `cad-kernel` must not depend on React or UI.
- `cad-kernel-manifold` may depend on `cad-kernel` and the Manifold runtime.
- `cad-react` may depend on `cad-core`.
- `cad-r3f` may depend on `cad-react`, `cad-core`, and Three/R3F.
- `packages/ui` may consume the public React/R3F APIs but must not consume kernel internals.
- No CAD package may depend directly on the application's database/auth layer.

**Inputs**:

- Read: outputs of Phase 1
- Read: existing package naming/build conventions
- Reference: existing workspace package structure

**Outputs**:

- Create: `packages/cad-core/**`
- Create: `packages/cad-kernel/**`
- Create: `packages/cad-kernel-manifold/**`
- Create: `packages/cad-react/**`
- Create: `packages/cad-r3f/**`
- Modify: root workspace configuration where required
- Modify: Turborepo/package configuration where required

**Validation Criteria**:

- All new packages have `check-types`.
- Type check: Zero errors.
- Build: Success.
- Package dependency graph respects the specified direction.
- No forbidden imports.
- Unit test smoke files exist for each package where behavior is introduced.
- Validator reads every created package manifest and source file.

**Dependencies**: Phases 1, 1.5, and 1.6 must complete successfully

---

# Phase 3: CAD Identity, Diagnostics, and Fundamental Types

**Type**: Sequential

**Requirements**:

- Implement stable branded identifiers for documents, parameters, features, bodies, and references.
- Implement structured CAD diagnostics.
- Implement diagnostic severity levels.
- Implement stable diagnostic codes.
- Implement diagnostic locations that can refer to domain objects without depending on UI.
- Ensure all domain objects are serializable at the data level.
- Prevent accidental mixing of branded identifier types in TypeScript.
- Do not introduce React, Three.js, or kernel dependencies.

**Inputs**:

- Read: `packages/cad-core/**`
- Reference: repository TypeScript conventions
- Reference: Phase 1 dependency rules

**Outputs**:

- Create: CAD ID modules under `packages/cad-core`
- Create: diagnostics modules under `packages/cad-core`
- Create: corresponding unit tests

**Validation Criteria**:

- IDs are type-distinct.
- IDs round-trip through serialization.
- Generated IDs are unique within document scope.
- Explicit IDs remain stable.
- Diagnostics contain structured severity/code/location information.
- Unit tests cover normal and invalid cases.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 2 must complete successfully

---

# Phase 4: Units and Dimensional Values

**Type**: Sequential

**Requirements**:

- Implement typed dimensional values.
- Support at minimum:
  - length
  - angle
  - area
  - volume
  - dimensionless values
- Support common units required by CAD workflows:
  - mm
  - cm
  - m
  - inch
  - deg
  - rad
- Establish one canonical internal representation.
- Implement conversion.
- Implement compatible arithmetic.
- Reject incompatible dimensional arithmetic.
- Serialize dimensional values deterministically.
- Ensure expressions and parameters can use dimensional values.

**Inputs**:

- Read: `packages/cad-core/**`
- Reference: existing TypeScript conventions

**Outputs**:

- Create: unit/value implementation under `packages/cad-core`
- Create: unit/value tests

**Validation Criteria**:

- `length + length` succeeds.
- `length - length` succeeds.
- `length / length` produces dimensionless output.
- `length + angle` fails correctly.
- Unit conversions are numerically correct within documented tolerances.
- Serialization round-trips.
- Invalid unit input produces structured failure.
- Type check: Zero errors.
- Unit tests: Pass.
- Build: Success.

**Dependencies**: Phase 3 must complete successfully

---

# Phase 5: Parameters and Expression Engine

**Type**: Sequential

**Requirements**:

- Implement first-class parameters.
- Parameters must have:
  - stable ID
  - name
  - typed value
  - dimensional type
  - optional expression
  - metadata
- Implement immutable or transaction-compatible parameter updates.
- Implement a serializable expression AST.
- Initial operators:
  - addition
  - subtraction
  - multiplication
  - division
  - modulo
  - square root
  - minimum
  - maximum
- Permit references to parameters.
- Extract parameter dependencies from expressions.
- Reject unknown identifiers.
- Reject invalid dimensional operations.
- Reject division by zero.
- V1 grammar is pinned (settled): identifiers, numbers, unit-literal tokens (`10mm`, `45deg`, `2.5in`), operators `+ - * / % ^`, parentheses, and the function set above; no unicode operator sugar (`width^2`, not `width²`).
- Do not evaluate arbitrary JavaScript.
- Expression evaluation must be deterministic.

**Inputs**:

- Read: Phase 3 CAD types
- Read: Phase 4 units
- Reference: existing package test conventions

**Outputs**:

- Create: parameter modules
- Create: expression AST modules
- Create: parser/evaluator modules
- Create: parameter/expression unit tests

**Validation Criteria**:

- Parameter CRUD behavior passes tests.
- Expression evaluation returns correct values.
- Expressions serialize and deserialize.
- Parameter dependencies are extracted correctly.
- Cycles are detectable.
- Invalid dimensional expressions fail.
- Arbitrary JavaScript is not executed.
- Type check: Zero errors.
- Build: Success.
- All expression tests pass.

**Dependencies**: Phase 4 must complete successfully

---

# Phase 6: Document, Feature Graph, and Regeneration

**Type**: Multi-sub-phase

### 6.1: Document Model

**Requirements**:

- Implement `CadDocument`.
- Implement bodies.
- Implement feature records.
- Implement feature inputs and outputs.
- Implement document-level parameter ownership.
- Implement document lookup by stable ID.
- Keep document state independent from React and kernels.

**Outputs**:

- Create: document model files under `packages/cad-core`
- Create: document tests

**Validation**:

- Documents can be created.
- Bodies/features can be added and removed.
- IDs resolve correctly.
- Serialization round-trips.
- Type check: Zero errors.
- Unit tests: Pass.

### 6.2: Feature Dependency Graph

**Requirements**:

- Implement dependency edges.
- Implement topological evaluation ordering.
- Implement cycle detection.
- Implement downstream invalidation.
- Implement affected-node discovery.

**Outputs**:

- Create: dependency graph implementation
- Create: graph tests

**Validation**:

- Linear graph works.
- Branched graph works.
- Disconnected graph works.
- Cycles are rejected.
- A changed upstream node invalidates downstream nodes only.

### 6.3: Regeneration State

**Requirements**:

- Features support:
  - valid
  - stale
  - failed
  - suppressed
- Preserve upstream valid state when downstream features fail.
- Attach diagnostics to failed features.

**Outputs**:

- Create: regeneration state implementation
- Create: failure-path tests

**Validation**:

- Valid graph regenerates.
- Downstream failure does not corrupt unrelated upstream state.
- Recovery after fixing a feature works.

**Phase-level Validation**:

- All sub-phases pass individual validation.
- Document, parameters, expressions, and features share the same IDs and diagnostics.
- No circular dependency exists between document and expression/units infrastructure.
- Full CAD core test suite passes.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 5 must complete successfully

---

# Phase 7: Commands, Transactions, Undo, and Redo

**Type**: Sequential

**Requirements**:

- Implement document transactions.
- Implement atomic commit/rollback.
- Implement serializable commands.
- Initial commands:
  - parameter.set
  - feature.create
  - feature.update
  - feature.delete
- Commands must be replayable.
- Implement undo.
- Implement redo.
- A new mutation after undo must invalidate the redo branch.
- Document changes must not bypass the command/transaction boundary for supported operations.

**Inputs**:

- Read: document and feature graph from Phase 6
- Reference: diagnostics and IDs

**Outputs**:

- Create: transaction modules
- Create: command modules
- Create: undo/redo modules
- Create: corresponding tests

**Validation Criteria**:

- Transactions commit atomically.
- Failed transactions roll back.
- Commands serialize.
- Commands replay deterministically.
- Undo and redo restore previous states.
- Branching behavior is correct.
- Type check: Zero errors.
- Build: Success.
- Full core tests pass.

**Dependencies**: Phase 6 must complete successfully

---

# Phase 8: Kernel Contract and Fake Kernel

**Type**: Sequential

**Requirements**:

- Define a kernel-independent CAD geometry contract.
- Support:
  - box
  - sphere
  - cylinder
  - cone
  - union
  - subtract
  - intersect
  - transform
  - bounds
  - volume
  - tessellation
- Define kernel capabilities.
- Keep kernel object types opaque outside the kernel package.
- Create a deterministic fake kernel for fast tests.
- Create reusable semantic geometry assertions.
- Never use exact triangle-buffer equality as the sole geometry correctness criterion.

**Inputs**:

- Read: Phase 6 document model
- Read: Phase 7 command model
- Reference: existing package conventions

**Outputs**:

- Modify: `packages/cad-kernel/**`
- Create: fake-kernel implementation
- Create: semantic geometry test utilities
- Create: kernel contract tests

**Validation Criteria**:

- Fake kernel satisfies all declared contracts.
- Core can execute against fake kernel.
- Kernel-specific types do not leak into `cad-core`.
- Semantic geometry assertions cover bounds, volume and validity where applicable.
- Type check: Zero errors.
- Build: Success.
- Contract tests: Pass.

**Dependencies**: Phase 7 must complete successfully

---

# Phase 9: Manifold Kernel

**Type**: Sequential

**Requirements**:

- Implement the kernel contract using Manifold.
- Implement:
  - box
  - sphere
  - cylinder
  - cone
  - union
  - subtract
  - intersect
  - transforms
  - bounds
  - volume
  - tessellation
- Normalize Manifold results into the kernel contract.
- Do not leak Manifold types outside the adapter.
- Add semantic geometry fixtures.
- Include invalid geometry/error-path tests.
- Keep Manifold isolated so it can later be replaced or supplemented by other kernels.

Manifold is chosen as the first backend because its current JS/WASM ecosystem is appropriate for browser-based solid modeling and now includes a broader CAD-oriented layer.

**Inputs**:

- Read: `packages/cad-kernel/**`
- Read: Phase 8 fake kernel and contract tests
- Reference: current Manifold JS/WASM documentation

**Outputs**:

- Modify: `packages/cad-kernel-manifold/**`
- Create: Manifold adapter source
- Create: geometry fixtures
- Create: Manifold integration tests

**Validation Criteria**:

- All supported primitives are valid.
- Boolean operations produce correct semantic results.
- Bounds and volume are correct within documented tolerance.
- Tessellation output is usable by later renderer phases.
- Invalid operations produce structured errors.
- No Manifold types leak through public kernel-neutral interfaces.
- Type check: Zero errors.
- Build: Success.
- Kernel contract suite: Pass.

**Dependencies**: Phase 8 must complete successfully

---

# Phase 10: Worker Execution Protocol

**Type**: Multi-sub-phase

**Architecture (settled)**: the entire CAD domain — document, parameters, expressions, feature graph, regeneration — executes client-side in the worker; the main thread is a command/projection client. The server never computes or renders geometry. Future AI integration issues commands through this client command bus only.

### 10.1: Worker Protocol

**Requirements**:

- Define versioned serializable worker requests.
- Define versioned serializable worker responses.
- Define structured worker errors.
- Define operation/request IDs.
- Define cancellation semantics.

**Outputs**:

- Create: worker protocol modules
- Create: protocol tests

**Validation**:

- All messages serialize.
- Unknown message versions fail predictably.
- Error responses are structured.

### 10.2: Generic Worker Client/Server

**Requirements**:

- Implement generic worker transport.
- Keep transport separate from Manifold.
- Permit a mock/in-memory transport for unit tests.
- The engine is first hosted behind the in-memory transport (domain callable in-process); flipping to the real worker transport changes no public API.

**Outputs**:

- Create: worker client/server modules
- Create: mocked transport tests

**Validation**:

- Request/response correlation is deterministic.
- Errors propagate.
- Cancellation behaves correctly.

### 10.3: Manifold Worker

**Requirements**:

- Execute real Manifold operations in a Worker.
- Return kernel-neutral results.
- Do not block the main thread for kernel execution.

**Outputs**:

- Modify: Manifold worker package
- Create: Worker integration tests

**Validation**:

- Primitive operation works.
- Boolean operation works.
- Tessellation works.
- Measurement works.
- Kernel errors reach the caller.

### 10.4: Stale Result Protection

**Requirements**:

- Every computation carries a request/revision identity.
- A stale result cannot replace newer document state.
- Rapid parameter updates do not corrupt the visible result.

**Outputs**:

- Create: stale-result handling
- Create: race-condition tests

**Validation**:

- Request A followed by B with A completing later leaves B visible.
- Cancellation/replacement does not corrupt worker state.

**Phase-level Validation**:

- Worker protocol is kernel-neutral.
- Real Manifold executes off-thread.
- Core remains usable without a browser.
- Browser stress test confirms stale-result protection.
- Type check: Zero errors.
- Build: Success.
- Playwright worker integration test: Pass.
- Video recorded for rapid parameter-update workflow.

**Dependencies**: Phase 9 must complete successfully

---

# Phase 11: Renderer Projection and R3F Foundation

**Type**: Multi-sub-phase

### 11.1: Render Projection Contract

**Requirements**:

- Define renderer-neutral render data.
- Include:
  - vertex positions
  - normals
  - indices
  - bounds
  - stable render object IDs
- Allow optional feature/body/topology metadata.
- Do not include Three.js classes in the contract.
- Provide semantic numeric assertion utilities over projections (positions/indices/bounds + camera serialized and compared with tolerance) — the primary geometry-correctness evidence, GPU-independent.

**Outputs**:

- Create: renderer projection interfaces
- Create: projection tests

**Validation**:

- Kernel output converts without Three.js.
- Projection is serializable/transferable as appropriate.

### 11.2: R3F Model Renderer

**Requirements**:

- Implement a `CadModel` renderer.
- Consume public CAD projection APIs.
- Never call kernel implementations directly.
- Update when projection changes.

**Outputs**:

- Create: R3F renderer components
- Create: renderer tests

**Validation**:

- Model renders.
- Updated model replaces previous result.
- No kernel-specific imports exist in renderer.

### 11.3: Deterministic CAD Scene

**Requirements**:

- Implement:
  - CAD scene
  - grid
  - axes
  - origin
- Establish deterministic camera/light/viewport configuration for visual tests.
- Pixel evidence runs under forced software WebGL (SwiftShader) with fixed viewport, DPR 1, and canvas masking where needed; pixel screenshots cover UI chrome and composed scenes, not raw geometry assertions.

**Outputs**:

- Create: scene components
- Create: screenshot fixture configuration

**Validation**:

- Scene is deterministic across test runs.
- Screenshot baseline is stable.

**Phase-level Validation**:

- Kernel → projection → R3F boundary is clean.
- Browser renders a parameterized model.
- Screenshot regression passes.
- Video captures model creation/update.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 10 must complete successfully

---

# Phase 12: Selection and Picking

**Type**: Sequential

**Requirements**:

- Implement selection as a CAD-domain concern, not as Three.js state.
- Support selection categories:
  - body
  - feature
  - solid
  - face
  - edge
  - vertex
- Map rendered objects/picks back to stable CAD references.
- Support:
  - hover
  - select
  - toggle
  - multi-select
  - clear
- Do not use transient triangle indices as public selection identity.
- In the Manifold era, face/edge/vertex selection is geometric (triangle regions grouped by normal/curvature into synthetic faces) and **transient**: valid for the current regeneration only, never persisted. Kernel capabilities advertise `persistentTopology: false`.

**Inputs**:

- Read: renderer projection from Phase 11
- Read: CAD IDs/references from Phase 3+
- Reference: current R3F renderer

**Outputs**:

- Create: selection modules
- Modify: R3F picking integration
- Create: selection tests
- Create: Playwright selection tests

**Validation Criteria**:

- Face can be selected.
- Selection state survives rerender.
- Multi-selection works.
- Selection can be cleared.
- Browser test synchronizes viewport selection with domain state.
- Screenshot verifies selection highlight.
- Video captures the principal selection flow.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 11 must complete successfully

---

# Phase 13: Headless CAD Tool System

**Type**: Sequential

**Requirements**:

- Define a headless tool contract.
- Define tool context.
- Define tool lifecycle.
- Define tool manager.
- Tools must issue commands rather than mutate domain state directly.
- Initial tools:
  - select
  - measure
  - translate
  - rotate
- Normalize pointer and keyboard events before tools consume them.
- Tools must be callable without the shadcn UI.

**Inputs**:

- Read: command system
- Read: selection system
- Read: R3F interaction layer

**Outputs**:

- Create: tool interfaces
- Create: tool manager
- Create: initial tools
- Create: unit/integration tests
- Create: browser interaction tests

**Validation Criteria**:

- Tool lifecycle is deterministic.
- Tool cancellation works.
- Tool completion emits expected commands.
- A tool can be exercised without UI components.
- Browser E2E verifies at least selection and transform interactions.
- Screenshot/video evidence exists for interaction-heavy behavior.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 12 must complete successfully

---

# Phase 14: React CAD Integration

**Type**: Sequential

**Requirements**:

- Implement a CAD React provider/context.
- Implement hooks for:
  - document
  - selection
  - parameters
  - tools
  - history
- React state must mirror CAD domain state rather than become its canonical source.
- Provide a composable React model API for supported CAD primitives.
- Do not create a second independent parametric model representation.
- Ensure R3F integration consumes the React/domain boundary cleanly.

**Inputs**:

- Read: `packages/cad-core/**`
- Read: `packages/cad-react/**`
- Read: `packages/cad-r3f/**`
- Reference: existing application React conventions

**Outputs**:

- Modify: `packages/cad-react/**`
- Modify: `packages/cad-r3f/**` where required
- Create: React hook tests
- Create: browser integration fixture

**Validation Criteria**:

- React can subscribe to document changes.
- React can observe parameter changes.
- React can observe selection.
- React can activate tools.
- CAD domain remains usable without React.
- Type check: Zero errors.
- Build: Success.
- React integration tests pass.

**Dependencies**: Phase 13 must complete successfully

---

# Phase 15: CAD shadcn Components

**Type**: Parallel

### 15.1: CAD Viewport Component

**Requirements**:

- Add a CAD viewport component to the existing `packages/ui`.
- Compose the public CAD React/R3F interfaces.
- Allow externally supplied model/document state.
- Support overlays and tool interaction.

**Outputs**:

- Modify: `packages/ui/**` CAD component area
- Create: component tests

**Validation**:

- Component renders.
- It can consume the public CAD API.
- It does not import kernels.

### 15.2: CAD Toolbar

**Requirements**:

- Provide reusable CAD tool buttons.
- Reflect active tool state.
- Support keyboard activation.
- Use existing shadcn primitives.

**Outputs**:

- Modify: `packages/ui/**`
- Create: component tests

**Validation**:

- Tool activation works.
- Active state renders correctly.
- Keyboard access works.

### 15.3: CAD Model Tree

**Requirements**:

- Display document/body/feature hierarchy.
- Synchronize tree selection and viewport selection.
- Display feature status.
- Support collapsed/expanded state.

**Outputs**:

- Modify: `packages/ui/**`
- Create: component tests

**Validation**:

- Tree renders actual document state.
- Selecting tree nodes updates CAD selection.
- Feature failures are visible.

### 15.4: CAD Parameter Panel

**Requirements**:

- Display parameters.
- Edit values.
- Display units.
- Display expressions.
- Display validation/diagnostic errors.
- Apply changes through commands/transactions.

**Outputs**:

- Modify: `packages/ui/**`
- Create: component tests

**Validation**:

- Parameter editing updates the model.
- Invalid values show errors.
- Units are displayed correctly.
- No direct kernel access exists.

**Phase-level Validation**:

- All four components work together in one browser workbench.
- All user-facing strings in CAD components are externalized (props or a labels token object) — the registry's source-copy model makes retrofitting i18n a breaking change for consumers; i18n is a roadmap commitment.
- Browser scenario:
  - load model
  - select feature
  - edit parameter
  - observe regenerated geometry
- Screenshot baselines cover:
  - initial state
  - selected state
  - parameter editor
  - regenerated model
  - error state
- Full workflow video is captured.
- Type check: Zero errors.
- Build: Success.
- Existing `packages/ui` components remain unaffected.

**Dependencies**: Phase 14 must complete successfully

---

# Phase 16: CAD Registry Distribution

**Type**: Sequential

**Requirements**:

- Add CAD components to the existing shadcn registry architecture.
- Registry items must be source-oriented.
- Registry packaging must not create a second manually-maintained implementation.
- Declare registry dependencies correctly.
- Declare npm dependencies correctly.
- Ensure installed registry components do not import monorepo-internal paths.
- Provide a consumer fixture that installs CAD components as a real external consumer would.
- The consumer fixture installs from **locally generated registry artifacts** (top-level `shadcn build` output validated by `shadcn registry validate`); nothing is published to any remote registry or npm — publishing happens only if/when the owner explicitly decides.

**Inputs**:

- Read: Phase 15 components
- Read: existing `packages/ui` registry configuration
- Reference: current shadcn registry documentation

Current shadcn registry infrastructure supports modular registry items and dependency declarations; the plan uses that model rather than inventing a separate CAD package installer.

**Outputs**:

- Modify: existing registry configuration under `packages/ui`
- Create: CAD registry item definitions
- Create: external consumer fixture
- Create: registry validation tests/scripts where required

**Validation Criteria**:

- Registry validates successfully.
- Every CAD registry item declares required dependencies.
- A clean consumer can install:
  - CAD viewport
  - CAD toolbar
  - CAD model tree
  - CAD parameter panel
- Consumer typecheck passes.
- Consumer build succeeds.
- Consumer browser smoke test renders a CAD component.
- No monorepo-internal import remains after installation.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 15 must complete successfully

---

# Phase 17: Native Parametric Document Format

**Type**: Sequential

**Requirements**:

- Define the canonical native `slopcad` document format.
- Document format must preserve:
  - parameters
  - expressions
  - feature graph
  - bodies
  - history/state
  - references when supported
  - diagnostics/state where appropriate
  - metadata
- Format must be versioned.
- Format must be schema-validatable.
- Serialization must be deterministic.
- Implement migration infrastructure before future schema changes exist.
- Derived kernel objects must not become the canonical source of truth.

**Inputs**:

- Read: document model
- Read: feature graph
- Read: transaction/command model
- Reference: all persistent domain types

**Outputs**:

- Create: native document schema
- Create: serializer/deserializer
- Create: validator
- Create: migration framework
- Create: golden fixtures

**Validation Criteria**:

- Documents serialize deterministically.
- Documents deserialize correctly.
- Round-trip tests pass.
- Invalid documents produce structured diagnostics.
- Fixture documents remain readable.
- Schema version is explicit.
- Migration framework exists.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 16 must complete successfully

---

# Phase 18: Mesh Import/Export

**Type**: Parallel

### 18.1: STL Export

**Requirements**:

- Export supported solids to STL.
- Support deterministic output where practical.
- Validate geometry semantically.

**Outputs**:

- Create: STL exporter package/module
- Create: STL export tests

**Validation**:

- Exported files are parseable.
- Bounds and triangle counts are sane.
- Semantic geometry remains within documented tolerance.

### 18.2: STL Import

**Requirements**:

- Import valid STL.
- Reject malformed input safely.
- Convert to supported CAD representation without pretending it contains parametric history.

**Outputs**:

- Create: STL importer
- Create: importer tests

**Validation**:

- Valid fixture imports.
- Invalid fixture fails safely.
- Imported result is selectable/renderable where supported.

### 18.3: 3MF Export

**Requirements**:

- Export supported mesh geometry to 3MF.
- Preserve units where supported.
- Preserve relevant metadata where supported.

3MF is preferred to STL as the richer mesh interchange path; Manifold's own documentation distinguishes the richer semantics of 3MF from STL.

**Outputs**:

- Create: 3MF exporter
- Create: export tests

**Validation**:

- Generated 3MF parses correctly.
- Semantic geometry survives export.

### 18.4: 3MF Import

**Requirements**:

- Import supported 3MF geometry.
- Preserve supported metadata.
- Do not fabricate parametric history.

**Outputs**:

- Create: 3MF importer
- Create: round-trip fixtures

**Validation**:

- Export → import semantic round-trip succeeds.

**Phase-level Validation**:

- All four adapters are independently validated.
- No I/O format dependency leaks into `cad-core`.
- Native document format remains unaffected.
- Browser export/import workflow succeeds.
- Screenshots verify imported/exported geometry.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 17 must complete successfully

---

# Phase 19: GLB Export

**Type**: Sequential

**Requirements**:

- Export rendered CAD geometry to GLB.
- Preserve useful object naming where practical.
- Preserve supported materials where practical.
- Keep GLB export separate from the native document representation.

**Inputs**:

- Read: render projection
- Read: Manifold/tessellation interfaces
- Read: Phase 18 I/O conventions

**Outputs**:

- Create: GLB exporter
- Create: GLB tests
- Create: browser GLB round-trip fixture

**Validation Criteria**:

- GLB parses successfully.
- Reference viewer can load the result.
- Screenshot of loaded GLB matches expected geometry.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 18 must complete successfully

---

# Phase 20: Feature History and Robust Regeneration

**Type**: Sequential

**Requirements**:

- Formalize first-class feature nodes.
- Implement explicit feature ordering.
- Implement rollback point.
- Implement feature suppression.
- Implement downstream regeneration.
- Preserve diagnostics on failure.
- Support recovery after correcting a failed feature.
- Ensure earlier parameter changes regenerate later features deterministically.
- Preserve last-known-valid upstream state where possible.

**Inputs**:

- Read: Phase 6 document/graph
- Read: Phase 7 transactions
- Read: Phase 17 document format

**Outputs**:

- Modify: feature graph/regeneration modules
- Create: history implementation
- Create: failure/recovery tests
- Create: browser history fixtures

**Validation Criteria**:

- Editing an upstream parameter updates downstream features.
- Rollback works.
- Suppression works.
- Failure state is visible.
- Recovery works.
- Browser scenario passes.
- Screenshot baseline covers history and error state.
- Video captures failure/recovery workflow.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 17 must complete successfully

---

# Phase 21: OpenCascade Backend and STEP/IGES

**Type**: Multi-sub-phase

### 21.1: OpenCascade Kernel Adapter

**Requirements**:

- Implement `CadKernel` using OpenCascade.
- Target the maintained `replicad-opencascadejs` binding — `opencascade.js` upstream is unmaintained since 2023 and is excluded; dormant `occt-import-js` is an import-only fallback at most.
- Open the phase with a short binding pre-spike before adapter code is written.
- Keep OCCT types inside the adapter.
- Expose BREP/NURBS capabilities through generic capabilities.
- Keep OCCT optional.

**Outputs**:

- Create: OpenCascade kernel package
- Create: adapter tests

**Validation**:

- Kernel contract tests pass.
- No OCCT types leak into kernel-neutral APIs.

### 21.2: OpenCascade Worker

**Requirements**:

- Execute OCCT operations off the UI thread.
- Reuse worker protocol semantics.

**Outputs**:

- Create: OCCT worker adapter
- Create: worker tests

**Validation**:

- Browser can execute a supported OCCT operation without UI freeze.

### 21.3: STEP Import

**Requirements**:

- Import STEP.
- Preserve supported body/topology/unit/name/color metadata.
- Clearly distinguish imported geometry from native parametric history.

**Outputs**:

- Create: STEP importer
- Create: STEP fixtures/tests

**Validation**:

- Known STEP fixtures import.
- Bounds/topology/body data pass semantic assertions.
- Browser import workflow passes.
- Screenshot/video evidence exists.

### 21.4: STEP Export

**Requirements**:

- Export supported BREP models to STEP.
- Use the most appropriate supported STEP application protocol for the implementation.

**Outputs**:

- Create: STEP exporter
- Create: export fixtures/tests

**Validation**:

- Exported STEP reimports successfully.
- Semantic geometry survives round-trip.

### 21.5: IGES/BREP

**Requirements**:

- Add IGES import.
- Add BREP import/export where supported.
- Keep both optional.

**Outputs**:

- Create: IGES adapter
- Create: BREP adapter
- Create: fixtures/tests

**Validation**:

- Valid fixtures import.
- Invalid files fail safely.

**Phase-level Validation**:

- Manifold and OCCT can implement common kernel contracts.
- Supported models produce equivalent semantic results within documented differences.
- STEP browser round-trip succeeds.
- No OCCT type leaks into core/react/r3f/UI.
- Type check: Zero errors.
- Build: Success.
- Full CAD regression suite passes.

**Dependencies**: Phase 20 must complete successfully

---

# Phase 22: Persistent References and Topology Identity

**Type**: Sequential

**Requirements**:

- Define public CAD references separate from raw kernel topology.
- Persistent references land after OCCT by design — real BREP faces/edges exist here; Manifold advertises `persistentTopology: false` (transient geometric selection only).
- Support references to:
  - feature
  - body
  - solid
  - face
  - edge
  - vertex
- Define reference validity states.
- Investigate how topology changes affect references.
- Prototype reference provenance through the feature graph.
- Prototype bounded repair strategies.
- Explicitly distinguish:
  - valid
  - missing
  - ambiguous
  - invalid
  - repaired
- Never expose kernel-specific handles as stable public references.

**Inputs**:

- Read: document model
- Read: feature history
- Read: Manifold topology capabilities
- Read: OCCT topology capabilities
- Read: existing kernel abstraction
- Reference: OneCAD/topological reference approaches
- Reference: OpenCascade topology/reference approaches where relevant

OneCAD is a useful architectural reference because its implementation explicitly separates domain/regeneration concerns from kernel/frontend protocols.

**Outputs**:

- Create: reference model
- Create: topology/reference fixtures
- Create: identity experiments
- Create: reference invalidation/repair tests
- Create: architecture decision record documenting chosen strategy

**Validation Criteria**:

- Reference identity survives supported harmless changes.
- Reference invalidation is explicit.
- Ambiguous references cannot silently resolve to the wrong entity.
- Repair behavior is deterministic where implemented.
- Tests cover topology-changing operations.
- Phase-wide architecture review passes.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 21 must complete successfully

---

# Phase 23: JSCAD Backend Compatibility

**Type**: Sequential

**Requirements**:

- Implement a JSCAD adapter for the common supported modeling operations.
- Keep JSCAD-specific types inside the adapter.
- Use JSCAD for compatibility/reference testing rather than as the native document model.
- Reuse semantic cross-kernel assertions.

`jscad-fiber` demonstrates the viability of combining JSCAD geometry with React/R3F; this phase deliberately places JSCAD one layer lower, behind the kernel abstraction.

**Inputs**:

- Read: kernel contract
- Read: Manifold adapter
- Reference: JSCAD APIs
- Reference: existing JSCAD/React integration work

**Outputs**:

- Create: JSCAD kernel package
- Create: adapter tests
- Create: cross-kernel fixtures

**Validation Criteria**:

- Supported common operations work.
- Semantic geometry tests pass.
- No JSCAD types leak.
- Cross-kernel comparison suite passes.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 22 must complete successfully

---

# Phase 24: Sketch Domain

**Type**: Sequential

**Requirements**:

- Implement workplanes.
- Implement sketch entities:
  - point
  - line
  - arc
  - circle
  - rectangle
- Implement sketch constraints:
  - coincident
  - horizontal
  - vertical
  - parallel
  - perpendicular
  - distance
  - angle
  - radius
  - diameter
  - equal
  - tangent
  - midpoint
  - symmetry
- Define a solver-neutral interface.
- Sketches must be serializable.
- Constraint diagnostics must be structured.
- Solver implementation must be replaceable.

`three.cad` demonstrates browser parametric sketching with constraints; SolveSpace provides a useful reference model for constraint solving.

**Inputs**:

- Read: core domain
- Read: reference model
- Reference: SolveSpace/constraint-solving concepts
- Reference: browser sketch implementations

**Outputs**:

- Create: `packages/cad-sketch/**`
- Create: sketch domain tests
- Create: solver interface
- Create: solver integration fixture

**Validation Criteria**:

- Sketch entities serialize.
- Constraints serialize.
- Valid constraints solve.
- Invalid/unsatisfied constraints produce diagnostics.
- Solver internals do not leak into public sketch APIs.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 22 must complete successfully

---

# Phase 25: Sketch Browser Interaction

**Type**: Sequential

**Requirements**:

- Add sketch mode to the browser application.
- Implement:
  - create line
  - create circle
  - create rectangle
  - select entity
  - create constraint
  - edit dimension
  - delete entity
  - construction geometry
  - trim
- Support pointer and keyboard interaction.
- Integrate with undo/redo.
- Preserve diagnostics.
- Add CAD-specific shadcn sketch toolbar components.

**Inputs**:

- Read: sketch domain
- Read: headless tools
- Read: command/transaction system
- Read: `packages/ui` CAD components

**Outputs**:

- Modify: `packages/ui/**`
- Modify: sketch/react/r3f packages
- Create: sketch interaction tests
- Create: Playwright workflows
- Create: screenshots
- Create: videos

**Validation Criteria**:

- Rectangle sketch can be created.
- Dimensions can be edited.
- Constraints can be added and removed.
- Undo/redo works.
- Browser screenshots match stable baselines.
- Full sketch workflow video passes review.
- Type check: Zero errors.
- Build: Success.
- Playwright suite passes.

**Dependencies**: Phase 24 must complete successfully

---

# Phase 26: Advanced Modeling Features

**Type**: Parallel

### 26.1: Extrude

**Requirements**:

- Support positive/negative extrusion.
- Support parameterized distance.
- Support sketch/profile input.
- Handle invalid profiles.

**Outputs**:

- Create: extrusion feature implementation/tests
- Create: browser workflow

**Validation**:

- Geometry semantics pass.
- Failure state passes.
- Browser test and screenshot pass.

### 26.2: Revolve

**Requirements**:

- Support axis and angle.
- Support full and partial revolve.
- Validate invalid profiles/axes.

**Outputs**:

- Create: revolve feature/tests
- Create: browser workflow

**Validation**:

- Semantic geometry pass.
- Browser test pass.

### 26.3: Sweep

**Requirements**:

- Support profile/path.
- Support valid orientation.
- Diagnose failures.

**Outputs**:

- Create: sweep implementation/tests

**Validation**:

- Semantic geometry pass.
- Failure fixtures pass.

### 26.4: Loft

**Requirements**:

- Support multiple profiles.
- Validate invalid profile collections.

**Outputs**:

- Create: loft implementation/tests

**Validation**:

- Semantic geometry and failure tests pass.

### 26.5: Fillet

**Requirements**:

- Support selected edges.
- Support radius.
- Diagnose unsupported/failing cases.

**Outputs**:

- Create: fillet implementation/tests
- Create: browser workflow

**Validation**:

- Semantic geometry pass.
- Failure cases pass.

### 26.6: Chamfer

**Requirements**:

- Support selected edges.
- Support distance.
- Diagnose failures.

**Outputs**:

- Create: chamfer implementation/tests

**Validation**:

- Semantic geometry pass.

### 26.7: Shell

**Requirements**:

- Support face removal.
- Support thickness.
- Diagnose failure cases.

**Outputs**:

- Create: shell implementation/tests

**Validation**:

- Semantic geometry pass.

### 26.8: Pattern

**Requirements**:

- Support linear pattern.
- Support circular pattern.
- Parameters must remain editable.

**Outputs**:

- Create: pattern implementation/tests

**Validation**:

- Parameter mutation regenerates pattern correctly.

### 26.9: Mirror

**Requirements**:

- Support feature/body mirroring.
- Support plane selection.

**Outputs**:

- Create: mirror implementation/tests

**Validation**:

- Geometry semantics pass.

### 26.10: Hole

**Requirements**:

- Support diameter/depth/position.
- Parameterize hole dimensions.

**Outputs**:

- Create: hole implementation/tests
- Create: browser workflow

**Validation**:

- Parameter edits regenerate geometry.

**Phase-level Validation**:

- Every sub-task passes individual validation.
- Cross-feature workflow passes:
  - sketch
  - extrude
  - hole
  - fillet
  - parameter edit
  - regenerate
- Failure propagation works.
- Feature history remains correct.
- Playwright suite passes.
- Required screenshots pass.
- Interaction videos pass.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phases 21 and 25 must complete successfully

---

# Phase 27: Measurement and Inspection

**Type**: Parallel

### 27.1: Bounds

**Requirements**:

- Measure and display bounding dimensions.

**Outputs**:

- measurement implementation/tests

**Validation**:

- Units correct.
- Browser test passes.

### 27.2: Distance

**Requirements**:

- Measure distance between supported references.

**Outputs**:

- distance tool/tests

**Validation**:

- Known fixture measurements pass.

### 27.3: Radius/Diameter

**Requirements**:

- Measure circles/arcs/cylindrical geometry where supported.

**Outputs**:

- radial measurement tool/tests

**Validation**:

- Semantic values and units pass.

### 27.4: Mass Properties

**Requirements**:

- Expose volume and supported area/mass-related measurements from kernel capabilities.

**Outputs**:

- measurement implementation/tests

**Validation**:

- Values agree with kernel semantics.

**Phase-level Validation**:

- All tools use the same unit infrastructure.
- All browser measurement workflows pass.
- Screenshot coverage exists.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 26 must complete successfully

---

# Phase 28: Complete CAD Workbench

**Type**: Sequential

**Requirements**:

- Compose the independent CAD components into a complete workbench.
- Include:
  - toolbar
  - command menu
  - viewport
  - model tree
  - property panel
  - parameter panel
  - history timeline
  - status bar
- Preserve component independence.
- Allow consumers to replace individual UI pieces.
- Support complete create/edit/select/regenerate workflow.
- Support import/export dialogs for supported formats.
- Ensure all UI interactions route through public CAD APIs/tools.

**Inputs**:

- Read: all public CAD React/R3F APIs
- Read: `packages/ui` components
- Read: registry-installed versions where applicable

**Outputs**:

- Create: workbench composition
- Create: workbench route/example
- Create: E2E workflow suite
- Create: screenshots
- Create: videos

**Validation Criteria**:

- Complete workbench opens successfully.
- Create/edit/select/regenerate works.
- Undo/redo works.
- History works.
- Import/export UI works for supported formats.
- Keyboard interaction works.
- Screenshots pass.
- Videos pass.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 27 must complete successfully

---

# Phase 29: Performance and Incremental Regeneration

**Type**: Sequential

**Requirements**:

- Establish measurable performance baselines.
- Define numeric budgets from the measured baselines in this phase and record them in the docs (no speculative targets).
- Measure:
  - WASM startup
  - worker startup
  - kernel operation time
  - tessellation time
  - transfer time
  - React render time
  - selection latency
  - parameter update latency
- Add caching only where measurements justify it.
- Add tessellation caching where useful.
- Improve incremental graph invalidation.
- Add worker batching for rapid updates where beneficial.
- Maintain correctness throughout optimization.

**Inputs**:

- Read: complete CAD system
- Read: existing browser performance fixtures
- Reference: earlier worker metrics

**Outputs**:

- Create: benchmark fixtures
- Create: benchmark tooling/results
- Modify: regeneration/cache implementation where measured
- Create: performance regression tests

**Validation Criteria**:

- Baselines are recorded.
- Optimizations have before/after measurements.
- No semantic geometry regressions.
- No stale-result regressions.
- Browser interaction remains functional.
- Type check: Zero errors.
- Build: Success.
- Performance regression suite passes.

**Dependencies**: Phase 28 must complete successfully

---

# Phase 30: Accessibility and Interaction Hardening

**Type**: Sequential

**Requirements**:

- Keyboard navigation for primary CAD UI.
- Correct focus management.
- Accessible labels and roles for controls where applicable.
- Correct focus handling for dialogs/popovers.
- Validate light/dark states.
- Validate:
  - hover
  - focus
  - selected
  - active
  - disabled
  - error
  - warning
- Do not sacrifice CAD interaction ergonomics for generic UI patterns.
- The hardening matrix is the evergreen trio: Chromium (already covered every phase) plus Firefox and WebKit here and in Phase 35.3.

**Inputs**:

- Read: complete `packages/ui` CAD components
- Read: workbench
- Reference: existing accessibility conventions

**Outputs**:

- Modify: CAD UI components
- Create: accessibility tests
- Create: browser accessibility workflows
- Create: visual baselines

**Validation Criteria**:

- Keyboard-only workflow works.
- Focus order is sensible.
- Error states are accessible.
- Browser accessibility checks pass.
- Screenshots pass.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 29 must complete successfully

---

# Phase 31: Account, Project, and Document Persistence

**Type**: Sequential

The existing backend/auth/database is now brought into the product.

**Requirements**:

- Introduce project persistence using the existing backend stack.
- Introduce:
  - Project
  - Document
  - DocumentVersion
- Persist the native slopcad document representation rather than kernel objects.
- Associate projects with authenticated users.
- Preserve CAD packages as database-independent.
- Support:
  - create project
  - create document
  - save
  - reload
  - reopen
- Preserve document version history.

**Inputs**:

- Read: existing backend/auth/database
- Read: native document format
- Read: current server/application conventions
- Read: authentication conventions

**Outputs**:

- Modify: existing database schema
- Modify: existing tRPC/backend project routes according to actual repository structure
- Modify: frontend project UI according to actual repository structure
- Create: persistence tests
- Create: E2E project workflow

**Validation Criteria**:

- Authenticated user can create a project.
- User can save a CAD document.
- Reload retrieves the document.
- Native document round-trip remains valid.
- Unauthorized access is rejected.
- Browser workflow passes.
- Screenshot/video evidence exists.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 30 must complete successfully

---

# Phase 32: Reusable Parametric CAD Components

**Type**: Parallel

### 32.1: Component Contract

**Requirements**:

- Define reusable CAD component metadata:
  - name
  - description
  - parameters
  - references/ports where supported
  - version
  - preview metadata

**Outputs**:

- Create: component contract
- Create: component validation tests

**Validation**:

- Contract serializes.
- Components expose parameters correctly.

### 32.2: NEMA17 Mount

**Requirements**:

- Implement a parameterized mount using public APIs only.

**Outputs**:

- Create: component
- Create: geometry fixture
- Create: browser preview

**Validation**:

- Parameter edits regenerate correctly.
- Screenshot passes.

### 32.3: Arduino Mount

**Requirements**:

- Implement a parameterized mounting component.

**Outputs**:

- Create: component
- Create: tests

**Validation**:

- Semantic geometry and browser preview pass.

### 32.4: Enclosure

**Requirements**:

- Implement a parameterized enclosure component.

**Outputs**:

- Create: component
- Create: tests

**Validation**:

- Parameter changes regenerate.
- Browser preview passes.

**Phase-level Validation**:

- Components use only public slopcad APIs.
- Components are independently usable.
- Parameter metadata is consistent.
- Geometry fixtures pass.
- Browser previews pass.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 31 must complete successfully

---

# Phase 33: Component and Tool Registry

**Type**: Parallel

### 33.1: UI Registry

**Requirements**:

- Publish CAD UI components through the existing shadcn registry.

**Outputs**:

- Registry entries
- Consumer fixtures

**Validation**:

- Clean consumer install succeeds.

### 33.2: CAD Component Registry

**Requirements**:

- Publish reusable parametric components through the project's registry mechanism.

**Outputs**:

- Component registry definitions
- Consumer fixture

**Validation**:

- Consumer can install and render components.

### 33.3: Example Registry

**Requirements**:

- Publish complete examples/workbench compositions.

**Outputs**:

- Example registry entries

**Validation**:

- Examples install and build.

### 33.4: Tool Registry

**Requirements**:

- Publish reusable headless tools where the distribution model supports them.

**Outputs**:

- Tool registry entries

**Validation**:

- Consumer can install and typecheck tools.

**Phase-level Validation**:

- Registry artifacts build.
- Registry validation passes.
- External consumer installs each category.
- No monorepo-internal dependencies remain.
- Consumer typecheck/build/browser smoke test passes.

**Dependencies**: Phase 32 must complete successfully

---

# Phase 34: Documentation and Developer Experience

**Type**: Sequential

**Requirements**:

- Document:
  - installation
  - CAD core
  - parameters
  - expressions
  - units
  - primitives
  - booleans
  - features
  - kernels
  - workers
  - R3F
  - selection
  - tools
  - UI
  - registry
  - native files
  - STL/3MF/GLB
  - STEP/IGES
  - sketches
  - constraints
  - reusable components
  - custom tools
  - custom kernel adapters
  - testing
- Every primary public API must have a working example where applicable.
- Explain which formats preserve parametric history and which do not.
- Document kernel capability differences.
- Document browser/worker requirements.
- Document public package boundaries.

**Inputs**:

- Read: all public package APIs
- Read: workbench examples
- Read: registry artifacts

**Outputs**:

- Modify: existing documentation application
- Create: API guides
- Create: runnable examples
- Create: architecture documentation

**Validation Criteria**:

- Documentation examples typecheck.
- Documentation examples build.
- Installation instructions work from a clean consumer.
- Registry examples install.
- Browser examples work.
- Type check: Zero errors.
- Build: Success.

**Dependencies**: Phase 33 must complete successfully

---

# Phase 35: Compatibility and Release Hardening

**Type**: Multi-sub-phase

### 35.1: Public API Audit

**Requirements**:

- Audit public exports.
- Identify unstable APIs.
- Remove accidental exports.
- Verify package boundary rules.
- Verify no kernel implementation types leak.
- Verify no React dependency leaks into `cad-core`.

**Outputs**:

- API audit report
- API modifications where required

**Validation**:

- Public API matches documented surface.

### 35.2: Native Document Compatibility

**Requirements**:

- Validate all native document fixtures.
- Validate migrations.
- Validate deterministic serialization.

**Outputs**:

- Compatibility suite

**Validation**:

- All fixtures pass.

### 35.3: Browser Matrix

**Requirements**:

- Validate supported browsers using the project's feasible automation matrix.

**Outputs**:

- Browser compatibility suite

**Validation**:

- Core workbench workflows pass.

### 35.4: Registry Consumer Matrix

**Requirements**:

- Test registry artifacts in clean external-style projects.

**Outputs**:

- Consumer fixtures

**Validation**:

- Install/typecheck/build/browser smoke pass.

### 35.5: Clean Checkout

**Requirements**:

- Validate from a clean repository checkout.
- No developer-local/generated artifacts may be required.

**Outputs**:

- Local clean-checkout verification script (no CI — owner policy; the gate is `pnpm verify` run from a fresh clone)

**Validation**:

- Install succeeds.
- Typecheck succeeds.
- Lint succeeds.
- Unit tests succeed.
- E2E succeeds.
- Build succeeds.
- Registry validation succeeds.
- Consumer build succeeds.

**Phase-level Validation**:

- All sub-tasks pass individual validation.
- Complete test suite passes.
- Complete E2E suite passes.
- Screenshot suite passes.
- Required videos are captured and reviewed.
- Registry validation passes.
- Clean checkout passes.
- Type check: Zero errors across all packages.
- Build: Success.

**Dependencies**: Phase 34 must complete successfully

---

# Success Criteria

Overall success requires:

- All phases complete and validate successfully.
- No validation phase remains unresolved.
- No phase reaches the three-attempt validation limit.
- The initial CAD core remains framework-independent.
- The initial CAD core remains kernel-independent.
- Manifold provides a working browser-capable first kernel.
- R3F provides the reference renderer.
- CAD selection and tools are independent of the shadcn UI.
- CAD-specific shadcn components live in the existing `packages/ui`.
- CAD components are installable through the registry.
- Native documents preserve parametric intent.
- STL/3MF/GLB workflows function.
- STEP/IGES/BREP workflows function once the OCCT phase is complete.
- Sketches and constraints are parametric and persistent.
- Advanced feature operations are independently tested.
- Browser workflows are covered by Playwright.
- Visual workflows have screenshot regression coverage.
- Interaction-heavy workflows have video evidence.
- Existing authentication/backend/database infrastructure remains usable for projects and profiles.
- CAD packages remain database-independent.
- Clean consumer installation works.
- Final type check has zero errors.
- Final build succeeds.
- Full test suite passes.
- Full E2E suite passes.
- Registry validation passes.
- Native document compatibility tests pass.
- No known critical architectural or functional regression remains.
- slopcad is MIT-licensed.
- No CI exists anywhere (local verify gates only).
- Nothing is published without an explicit owner decision.

## Permanent Regression Requirements

After each phase introduces a new layer, its tests become part of the permanent regression suite.

At minimum, the permanent suite must eventually include:

```text
Core:
  IDs
  diagnostics
  units
  parameters
  expressions
  dependency graph
  transactions
  commands
  undo/redo
  serialization
  migration

Geometry:
  kernel contract
  Manifold
  OCCT
  JSCAD
  semantic geometry fixtures

Runtime:
  worker protocol
  cancellation
  stale-result protection

Rendering:
  projection
  R3F
  deterministic viewport

Interaction:
  selection
  tools
  keyboard interaction

UI:
  viewport
  toolbar
  model tree
  parameter panel
  property panel
  history

Browser:
  create
  parameter edit
  selection
  regeneration
  failure/recovery
  save/load
  import/export
  sketches
  advanced features

Distribution:
  registry validation
  consumer installation
  consumer build
```

## Execution Rule

For every phase:

```text
IMPLEMENT
→ IMPLEMENTER GATE
→ VALIDATE
→ FIX ALL FINDINGS IF NECESSARY
→ REVALIDATE
→ PASS
→ NEXT PHASE
```

For every multi-sub-phase parallel phase:

```text
SUB-TASK A
→ IMPLEMENT
→ VALIDATE

SUB-TASK B
→ IMPLEMENT
→ VALIDATE

SUB-TASK C
→ IMPLEMENT
→ VALIDATE

ALL PASS
→ PHASE-WIDE VALIDATOR
→ FIX LOOP IF NECESSARY
→ PHASE PASS
```

Validators must read the implementation rather than merely trust automated tests, and fixers must address all validator findings together. The workflow permits up to three total validation attempts before the phase is halted.

No subsequent phase may begin while a dependency phase is incomplete.

Once this plan is approved, execution proceeds automatically through the phases without requesting additional user approval between phases, as required by the orchestration skill.
