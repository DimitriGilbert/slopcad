import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

import { VIEWER_FRAME_HEADERS } from "./src/viewer/viewer-frame-policy";

export default defineConfig({
  // `host: true` binds 0.0.0.0 so the dev/preview servers are reachable
  // over the LAN from other devices (owner request). Config-level so every
  // invocation (pnpm dev, dev:web, --filter web dev) gets it. The port is
  // env-overridable (DEV_PORT) so isolated batteries — e.g. the clean
  // checkout verification — can boot their own dev server beside a live
  // one without reuse ambiguity.
  server: {
    port: Number(process.env.DEV_PORT ?? 3201),
    host: true,
  },
  preview: {
    host: true,
  },
  // esbuild must stay EXTERNAL in the server build: the /api/io/import-tsx
  // route reaches it through @slopcad/cad-jsx's loader (workspace source,
  // so the bundler would otherwise inline the whole package — and esbuild's
  // own guard refuses to run bundled, locating its binary relative to the
  // API file). apps/web declares the same pinned version so the external
  // import resolves at runtime from this package's node_modules.
  ssr: {
    external: ["esbuild"],
  },
  // Module workers: the kernel worker entries are ES modules with
  // bundle-split imports (`@slopcad/cad-kernel-manifold`'s
  // `manifold-worker.web`, hosted per its module doc), so worker bundles
  // must stay ES — the IIFE default cannot carry them.
  worker: {
    format: "es",
  },
  resolve: {
    tsconfigPaths: true,
    // The `use-sync-external-store` shims ride the SSR graph through Base
    // UI's `useStore` (and zustand / @tanstack/react-store): the package
    // is CJS, and the bundler inlines it with a runtime `__require("react")`
    // that loads a SECOND React instance from disk during SSR — the first
    // store hook through that instance then throws "Cannot read properties
    // of null (reading 'useSyncExternalStore')" and the route degrades to
    // the client-only shell (rolldown-vite CJS interop emit; see the local
    // with-selector shim under src/shims). React 19 always exports the
    // native `useSyncExternalStore` — which the shim itself delegates to
    // when present — so the shim subpath aliases onto the one bundled
    // React. ORDER MATTERS: the deeper `/shim/with-selector` specifier
    // must be listed BEFORE the bare `/shim` entry or the prefix match
    // would capture it (the anchored regex also covers the `.js`-suffixed
    // form zustand's ESM build imports).
    alias: [
      {
        find: /^use-sync-external-store\/shim\/with-selector(?:\.js)?$/,
        replacement: fileURLToPath(
          new URL(
            "./src/shims/use-sync-external-store-with-selector.ts",
            import.meta.url,
          ),
        ),
      },
      {
        find: "use-sync-external-store/shim",
        replacement: "react",
      },
    ],
  },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    // compressPublicAssets: precompress every client asset (hashed bundles,
    // workers, fonts) to .gz and .br at build time — the node-server preset
    // only serves them with Content-Encoding when precompressed; without it
    // a multi-MB workbench payload ships raw over the internet.
    // routeRules: the /viewer route carries the frame policy headers (see
    // viewer-frame-policy) — the route-scoped embeddability guarantee, kept
    // to exactly this path so no global relaxation ever leaks to the rest
    // of the site.
    nitro({
      preset: "node-server",
      compressPublicAssets: true,
      routeRules: {
        "/viewer": { headers: { ...VIEWER_FRAME_HEADERS } },
      },
    }),
    viteReact(),
  ],
});
