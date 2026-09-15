`slopcad` is a TypeScript monorepo — fullstack TanStack Start app (tRPC-backed server routes inside the app), Drizzle ORM on SQLite, and Better Auth authentication. Use `pnpm` for all package operations — never a different package manager or another project's lockfile. Run commands and git operations from the repo root.

Scaffolded with Better-T-Stack — treat `bts.jsonc` as the stack source of truth.

## Monorepo

pnpm workspaces monorepo, with Turborepo running cross-package tasks.

| Path              | Package           | Purpose                                                   |
| ----------------- | ----------------- | --------------------------------------------------------- |
| `apps/web`        | `web`             | Fullstack TanStack Start app: UI, server routes, tRPC API |
| `packages/api`    | `@slopcad/api`    | tRPC routers and client                                   |
| `packages/db`     | `@slopcad/db`     | Drizzle schema + migrations (SQLite)                      |
| `packages/auth`   | `@slopcad/auth`   | Better Auth                                               |
| `packages/ui`     | `@slopcad/ui`     | Shared UI components (Tailwind CSS v4)                    |
| `packages/env`    | `@slopcad/env`    | Typed environment validation                              |
| `packages/config` | `@slopcad/config` | Shared tsconfig and build config                          |

## Commands

Dev: `pnpm dev` (all apps), `pnpm dev:web` (web only)
Build & typecheck: `pnpm build`, `pnpm run check-types`
Test & quality: `pnpm test` (all unit suites via turbo), `pnpm test:e2e` (Playwright smoke), `pnpm run test:coverage`, `pnpm run lint`, `pnpm run format` / `format:check`, `pnpm run quality` (coverage → CRAP → duplication → HTML report in `reports/quality/`), `pnpm run quality:knip` (report-only)
The gate: `pnpm run verify` runs check-types → lint → test → build in one headless command — run it before declaring any work done
Database (`packages/db`): `pnpm db:push` pushes the schema, `pnpm db:generate` generates migration SQL from the schema, `pnpm db:migrate` applies migrations, `pnpm db:studio` opens the data browser, `pnpm db:local` starts a local database
Docker Compose: `pnpm docker:build`, `docker:up`, `docker:logs`, `docker:down`
Per package: `pnpm --filter <name> <script>` — e.g. `pnpm --filter web dev`; across packages: `pnpm turbo run <task>`

## Testing

Runner: Vitest v4, tests colocated as `src/**/*.test.ts(x)`; shared `createTestConfig()` factory in `packages/config/vitest/base.ts` (node env by default, jsdom only for React component tests in `apps/web` and `packages/ui`). Playwright covers browser journeys from `apps/web/e2e/` (Chromium, software WebGL/SwiftShader, fixed viewport/DPR, trace on first retry, video on).

Hard rules: no live network in unit tests (runtime-enforced fetch guard in `apps/web` and `packages/api` setups), no real database (`createInMemoryDb()` from `@slopcad/db` applies committed migrations to an ephemeral temp-file libsql database), no env validation at import time (`SKIP_ENV_VALIDATION=1` in per-package `src/test-setup.ts`).

Coverage: istanbul provider, report-only (measure-then-ratchet thresholds arrive once suites grow — never lower a threshold). Quality metrics (CRAP ≥ 30, jscpd duplication, knip dead code) are report-only local commands.

No CI, ever — the headless local verification command (`pnpm verify`) is the quality gate, run by the owner/agents; git hooks are local convenience and none are installed. See `TEST-ALIGNMENT-PLAN.md` for the full policy and donor provenance.

## Working agreements

Before reporting work done, run `pnpm run verify` (check-types, lint, tests, build in one command).
Fix every TypeScript/LSP error your changes introduce; never silence an error — fix the cause.
No `any`, `as any`, or `: any` — use proper types, `unknown`, inference, or validated schemas.
With verbatimModuleSyntax on, use `import type` for type-only imports.
Keep imports ordered: external/workspace imports first, a blank line, then local imports.
All new forms must use Formedible (`packages/ui/src/components/formedible`) — a schema-driven form renderer on top of TanStack Form. Forms are config objects (schema + field list + options), not long TSX files, so they can be combined, reused and adapted easily. Load the `formedible` skill before building or modifying Formedible forms.
Search for existing components, types, and utilities before creating new ones; keep one source of truth for types, and never hand-edit generated files.
Check the `pnpm-workspace.yaml` catalog and existing `package.json` files before adding a dependency, and use `catalog:` references when available.
Do not start long-running dev servers — assume one is already running; start one only if the user explicitly asks or none is clearly running.
Never run `git stash`, `git reset --hard`, `git clean`, or anything else that destroys uncommitted work; no commits or pushes unless the user asks.
Treat everything as production code: no placeholders, `TODO`/`FIXME`, unused imports or variables, fake success states, or hardcoded secrets.
Only run scripts that exist in a package.json — inspect before inventing, and report anything you couldn't run with the reason.
