# Repository Baseline — slopcad

_Audited 2026-09-14 (pre-CAD work); testing baseline established 2026-09-15 (Phase 1.5)._

## Scaffold provenance

Better-T-Stack v3.40.5 (created 2026-09-05), `bts.jsonc` command:
`--frontend tanstack-start --backend self --runtime none --database sqlite --orm drizzle --api trpc --auth better-auth --payments none --addons turborepo --examples none --db-setup none --web-deploy docker --server-deploy none --git --package-manager pnpm`

## Exact paths

| Concern        | Path                                                                                                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend app   | `apps/web` (TanStack Start `^1.168.32`, Vite `^8.1.5`, Nitro node-server preset, dev port 3001)                                                                                                                                                             |
| Backend        | "self" — tRPC (`api/trpc/$.ts`) and better-auth (`api/auth/$.ts`) mounted as in-app routes; **no separate server app**                                                                                                                                      |
| tRPC routers   | `packages/api` (`src/index.ts`, `src/context.ts`, `src/routers/index.ts` → `appRouter` with `healthCheck`, `privateData`)                                                                                                                                   |
| Auth           | `packages/auth` (`src/index.ts` → better-auth + drizzle adapter + `tanstackStartCookies`)                                                                                                                                                                   |
| Database       | `packages/db` (Drizzle + libsql/SQLite; schema `src/schema/auth.ts`; migrations `src/migrations/`; env-driven `createDb()`; `createInMemoryDb()` for tests)                                                                                                 |
| UI             | `packages/ui` — shadcn on **Base UI** primitives (`@base-ui/react ^1.6.0`, `@shadcn/react ^0.2.1`, shadcn CLI `^4.16.0`, style `base-lyra`), Tailwind v4 CSS-first, 17 generic components; `components.json` `registries: {}` (registry not yet configured) |
| Env validation | `packages/env` (`@t3-oss/env-core`; `src/server.ts`, `src/web.ts`)                                                                                                                                                                                          |
| Shared config  | `packages/config` (`tsconfig.base.json` strict set; `vitest/base.ts` test factory since Phase 1.5)                                                                                                                                                          |
| Web routes     | `__root.tsx`, `index.tsx` (`/`), `login.tsx`, `_auth/route.tsx` + `_auth/dashboard.tsx` (auth-guarded), `api/auth/$.ts`, `api/trpc/$.ts`                                                                                                                    |
| Runtime pins   | `pnpm@10.34.5`, Node `24` via `.nvmrc`, React `19.2.8`, TypeScript `6.0.3`                                                                                                                                                                                  |
| CI             | **None, by owner policy (fleet D5) — local `pnpm verify` is the gate**                                                                                                                                                                                      |

## Environment

`.env` provides `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `DATABASE_URL` (gitignored). `drizzle.config.ts` loads `apps/web/.env` for db tooling.

## What the CAD plan may and may not touch

The existing scaffold (auth/backend/database/shadcn setup) stays; CAD packages layer on top. `packages/ui` remains the canonical UI package; the existing backend is retained for Phase 31 (projects/persistence) and stays outside the CAD-core dependency graph. Nothing CAD-related existed before Phase 1.5 (no three/R3F/manifold anywhere in the lockfile).
