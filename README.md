# slopcad

A browser-native parametric CAD stack, built with
[Better-T-Stack](https://github.com/AmanVarshney01/create-better-t-stack)
(TypeScript, TanStack Start, tRPC, Drizzle, Better Auth).

**Start with the documentation:** [`docs/README.md`](docs/README.md) maps
every topic (installation, the CAD core, kernels, workers, rendering,
exchange formats, sketches, components, the registry, testing, package
boundaries) with runnable, gate-verified examples in
`packages/docs-examples`, and the `/docs` route of the web app executes
the browser-safe examples live.

## Features

- **TypeScript** - For type safety and improved developer experience
- **TanStack Start** - SSR framework with TanStack Router
- **TailwindCSS** - Utility-first CSS for rapid UI development
- **Shared UI package** - shadcn/ui primitives live in `packages/ui`
- **tRPC** - End-to-end type-safe APIs
- **Drizzle** - TypeScript-first ORM
- **SQLite/Turso** - Database engine
- **Authentication** - Better-Auth
- **Turborepo** - Optimized monorepo build system

## Getting Started

First, install the dependencies:

```bash
pnpm install
```

## Database Setup

This project uses SQLite with Drizzle ORM.

1. Start the local SQLite database (optional):

```bash
pnpm run db:local
```

2. Update your `.env` file in the `apps/web` directory with the appropriate connection details if needed.

3. Apply the schema to your database:

```bash
pnpm run db:push
```

Then, run the development server:

```bash
pnpm run dev
```

Open [http://localhost:3201](http://localhost:3201) in your browser to see the fullstack application. The dev server binds port 3201; set `DEV_PORT` to override it.

## UI Customization

React web apps in this stack share shadcn/ui primitives through `packages/ui`.

- Change design tokens and global styles in `packages/ui/src/styles/globals.css`
- Update shared primitives in `packages/ui/src/components/*`
- Adjust shadcn aliases or style config in `packages/ui/components.json` and `apps/web/components.json`

### Add more shared components

Run this from the project root to add more primitives to the shared UI package:

```bash
npx shadcn@latest add accordion dialog popover sheet table -c packages/ui
```

Import shared components like this:

```tsx
import { Button } from "@slopcad/ui/components/button";
```

### Add app-specific blocks

If you want to add app-specific blocks instead of shared primitives, run the shadcn CLI from `apps/web`.

## Deployment

### Docker Compose

- Target: web + server
- Config: `docker-compose.yml` (app Dockerfiles live in `apps/*/Dockerfile`)
- Build images: pnpm run docker:build
- Start: pnpm run docker:up
- Logs: pnpm run docker:logs
- Stop: pnpm run docker:down

Environment variables come from the host environment or a `.env` file next to `docker-compose.yml`:
`BETTER_AUTH_SECRET` is mandatory (`openssl rand -base64 32`) — the stack refuses to start without
it — and `BETTER_AUTH_URL` must be the public origin (it is better-auth's baseURL and trusted
origin) for anything but local use. `DATABASE_URL` defaults to the SQLite file inside the stack's
persistent data.

Migrations run automatically at every container start against the SQLite file in the `slopcad-data`
Docker volume, so no host-side `db:push` or directory preparation is needed; data survives restarts
and rebuilds through that volume. The stack is plain Docker Compose — any host that runs compose
files (including Dokploy) can deploy it. It publishes **no host port**: point your reverse proxy at
the `web` service's port 3001 on the compose network (in Dokploy: Domains → service `web`, port
3001). To poke the stack from your own machine, create an untracked `docker-compose.override.yml`:

```yaml
services:
  web:
    ports:
      - "127.0.0.1:31001:3001"
```

For more details, see the guide on [Deploying with Docker Compose](https://www.better-t-stack.dev/docs/guides/docker).

## Project Structure

```
slopcad/
├── apps/
│   └── web/                 # Fullstack application (React + TanStack Start)
└── packages/
    ├── ui/                  # Shared shadcn/ui components and styles
    ├── api/                 # API layer / business logic (tRPC)
    ├── auth/                # Authentication configuration & logic
    ├── db/                  # Database schema & queries
    ├── env/                 # Typed environment validation
    ├── config/              # Shared tsconfig and build config
    ├── cad-core/            # CAD document model (commands, parameters, expressions, assemblies)
    ├── cad-kernel/          # Geometry-kernel contract
    ├── cad-kernel-manifold/ # Manifold kernel backend (default)
    ├── cad-kernel-occt/     # OpenCascade BREP kernel backend
    ├── cad-jscad/           # JSCAD reference kernel backend
    ├── cad-sketch/          # 2D parametric sketch domain
    ├── cad-react/           # CadStore + React hooks
    ├── cad-r3f/             # three.js / React Three Fiber rendering
    ├── cad-io/              # Geometry exchange (STL, OBJ, 3MF, GLB, DXF, SVG)
    ├── cad-jsx/             # JSX → CadCommand compiler
    ├── cad-components/      # Reusable parametric components
    └── docs-examples/       # Runnable, machine-verified docs examples
```

## Available Scripts

- `pnpm run dev`: Start all applications in development mode
- `pnpm run build`: Build all applications
- `pnpm run dev:web`: Start only the web application
- `pnpm run check-types`: Check TypeScript types across all apps
- `pnpm run db:push`: Push schema changes to database
- `pnpm run db:generate`: Generate database client/types
- `pnpm run db:migrate`: Run database migrations
- `pnpm run db:studio`: Open database studio UI
- `pnpm run db:local`: Start the local SQLite database
- `pnpm run docker:build`: Build the Docker Compose images
- `pnpm run docker:up`: Build and start the Docker Compose stack
- `pnpm run docker:logs`: Tail logs from the Docker Compose stack
- `pnpm run docker:down`: Stop the Docker Compose stack
