import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 3001,
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
