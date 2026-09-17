import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  // `host: true` binds 0.0.0.0 so the dev/preview servers are reachable
  // over the LAN from other devices (owner request). Config-level so every
  // invocation (pnpm dev, dev:web, --filter web dev) gets it.
  server: {
    port: 3001,
    host: true,
  },
  preview: {
    host: true,
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
    nitro({ preset: "node-server" }),
    viteReact(),
  ],
});
