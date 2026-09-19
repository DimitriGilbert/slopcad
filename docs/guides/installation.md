# Installation

Two ways to consume slopcad: as a monorepo contributor, or as an external
app installing through the shadcn-style registry. Both are exercised by
real gates — the commands below are the ones the gates run.

## Prerequisites

- Node 24+ (the Node worker channel relies on its native type stripping
  for the workspace's TypeScript sources).
- pnpm 10 (`packageManager: pnpm@10.34.5` in the root `package.json`).
- For browser gates: Chromium (Playwright installs it on demand).

## The monorepo (contributor)

```bash
git clone <this repository>
cd slopcad
pnpm install
pnpm run verify
```

`pnpm run verify` is the whole gate: `check-types` → `lint` →
`format:check` → `test` → `build`, across every workspace package through
the turbo graph. Nothing is considered done until it is green.

Run the app:

```bash
pnpm run dev        # every app
pnpm run dev:web    # the web app only (port 3001)
```

The browser suites are deliberately outside `verify` because they boot
the production build:

```bash
pnpm test:e2e        # smoke (2)
pnpm test:render     # render + workbench fixtures (87, byte-stable)
pnpm test:worker     # the Manifold and OCCT worker fixtures (5)
pnpm test:perf       # performance budgets (24; budgets.json untouched)
pnpm test:docs       # the /docs documentation application (14)
pnpm test:workbench  # the complete workbench suite (6)
pnpm test:a11y       # accessibility (37 + 1 skip)
pnpm test:projects   # project/document persistence (1)
pnpm test:components # registry component previews (12)
```

The registry pipeline:

```bash
pnpm registry:build      # build all three source registries into packages/ui/public/r
pnpm registry:validate   # validate sources + artifacts (no workspace refs, byte-fresh)
pnpm registry:regenerate # rebuild, reinstall the external consumer from scratch, gates
```

## The external consumer (registry install)

The CAD packages are **not on npm** (owner decree). An external app
installs the components, examples, and tools through the shadcn CLI from
locally generated registry artifacts — the identical code path a real
remote registry would use. `fixtures/cad-consumer` is the reference
consumer; `pnpm registry:regenerate` resets it to nothing and reinstalls
it end to end (see [registry.md](registry.md) for the full model).

The manual steps the script automates:

```bash
# 1. Build the artifacts (byte-reproducible) and serve them on loopback.
pnpm registry:build
cd packages/ui
python3 -m http.server 46219 --bind 127.0.0.1 --directory public/r &

# 2. In the consumer app: declare the registry namespace (components.json).
#    "@slopcad": "http://127.0.0.1:46219/{name}.json"

# 3. Install any category — UI components, CAD components, examples, tools.
pnpm exec shadcn add "@slopcad/cad-viewport" "@slopcad/nema17-mount" \
  "@slopcad/plate-workbench" "@slopcad/hole-tool" -y --overwrite

# 4. Gate the consumer.
pnpm check-types && pnpm build && pnpm smoke
```

Because the packages are not published, the consumer pre-declares them as
`file:` links to the workspace packages and registers them in a tiny
pnpm workspace so their internal `workspace:*`/`catalog:` protocols
resolve — the documented stand-in for real published packages, which
would need none of it. The consumer pins `react`/`react-dom`/`three` to
the monorepo's exact versions and dedupes them in `vite.config.ts`: the
kernel's opaque solid handles are nominal types, and two module
identities would break them.

## Browser requirements

- **Module workers.** The kernel worker entries are ES modules with
  bundle-split imports, so `vite.config.ts` pins `worker.format = "es"`;
  the IIFE default cannot carry them.
- **WASM.** Manifold ships a 541 KB wasm (pinned via
  `manifold-3d/manifold.wasm?url`); OpenCascade ships a
  **22,980,267-byte (≈23 MB) wasm** (`replicad_single.wasm`), which is
  why the OCCT package stays optional — nothing pulls it until a caller
  chooses the `opencascade` backend, and its heap has a 100 MB floor.
- **WebGL.** The renderers run under software WebGL (SwiftShader) in
  every test harness (`--use-angle=swiftshader
--enable-unsafe-swiftshader`), with a fixed viewport and DPR 1 for
  byte-stable screenshots. Real GPUs are faster; nothing requires one.
- **The 3MF importer is Node-targeted** (deflate through `node:zlib`).
  In a browser app, import 3MF through your server route — the `/io`
  fixture shows the pattern.
