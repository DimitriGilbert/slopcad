import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
    // The linked CAD packages resolve their peers through the monorepo's
    // node_modules while the fixture pins its own copies; dedupe forces one
    // module instance per package in the bundle.
    dedupe: ["react", "react-dom", "three", "@react-three/fiber"],
  },
  optimizeDeps: {
    // The CAD packages are linked workspace sources (raw TS); Vite must
    // transform them instead of pre-bundling them as JS-only deps.
    exclude: [
      "@slopcad/cad-core",
      "@slopcad/cad-kernel",
      "@slopcad/cad-kernel-manifold",
      "@slopcad/cad-react",
      "@slopcad/cad-r3f",
    ],
  },
});
