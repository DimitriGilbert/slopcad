import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

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
  },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    // compressPublicAssets: precompress every client asset (hashed bundles,
    // workers, fonts) to .gz and .br at build time — the node-server preset
    // only serves them with Content-Encoding when precompressed; without it
    // a multi-MB workbench payload ships raw over the internet.
    nitro({ preset: "node-server", compressPublicAssets: true }),
    viteReact(),
  ],
});
