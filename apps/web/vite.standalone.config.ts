/**
 * The standalone viewer build (Phase — shareable parametric pages): a
 * dedicated vite target that compiles `src/viewer/viewer-standalone.tsx` —
 * the SECOND mount of the same ViewerSurface the /viewer route mounts —
 * into ONE self-contained JS bundle plus its CSS, emitted into
 * `public/viewer-standalone/` so the site serves them like any public
 * asset. The viewer page's export button fetches both, inlines them with
 * the native document as a JS variable, and downloads a single HTML file
 * that opens offline by double-click.
 *
 * Why a separate config (reported decision): the app's own build is the
 * TanStack Start + nitro pipeline; wedging a second entry into it would
 * tangle the SSR graph with a bundle that must never know the router. This
 * target is plain vite + react + the same Tailwind plugin and the same app
 * CSS (`src/index.css`), so the standalone wears the site's real chrome
 * (the Machinist token system, the fonts — data-URL'd by the inline limit
 * below).
 *
 * The file:// constraints this config exists for:
 *
 * - the MAIN bundle stays a single-chunk ES module with every asset
 *   inlined — an inline `<script type="module">` on a `file://` page is
 *   legal exactly while it imports nothing external;
 * - the kernel worker cannot be a bundler-emitted worker FILE (a classic
 *   module worker URL cannot load from `file://`), so the worker graph is
 *   bundled in IIFE form and inlined as a blob worker at runtime
 *   (`?worker&inline`), and the default worker construction module is
 *   aliased out entirely (see the stub plugin below) so its module-worker
 *   URLs never enter this bundle;
 * - Manifold's WASM rides as a data URL (the `?url` import intercepted at
 *   load), and Manifold's ESM loader's Node-only branch (the one
 *   `import.meta` in the worker graph) is defused so the IIFE worker
 *   bundle stays legal — the build FAILS if the package's shape drifts.
 */

import { readFileSync } from "node:fs";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { fileURLToPath } from "node:url";

const APP_ROOT = fileURLToPath(new URL(".", import.meta.url));

/** The resolved stub that replaces the default worker construction. */
const WORKER_STUB = `${APP_ROOT}src/viewer/standalone-worker-stub.ts`;

/** The exact Node-branch initializer in manifold-3d's ESM loader. */
const MANIFOLD_NODE_SENTINEL =
  'var ENVIRONMENT_IS_NODE=globalThis.process?.versions?.node&&globalThis.process?.type!="renderer";';

/**
 * Aliases the session boot's default worker construction to the standalone
 * stub: the standalone always boots through the boot's `workerFactory`
 * (the inlined blob worker), and reaching the default is a loud runtime
 * error, never a silent fetch of an unloadable module-worker file.
 */
function standaloneWorkerStub(): Plugin {
  return {
    name: "slopcad-standalone-worker-stub",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        source.endsWith("fixture-worker-boot") &&
        importer?.includes("render-fixture") === true
      ) {
        return WORKER_STUB;
      }
      return null;
    },
  };
}

/**
 * Inlines Manifold's WASM as a data URL: the worker entry pins the asset
 * with `manifold-3d/manifold.wasm?url`, and a relative asset URL could
 * never resolve inside an inlined blob worker on a `file://` page. The
 * emscripten loader fetches data URLs natively, so `locateFile` needs no
 * other change.
 */
function inlineManifoldWasm(): Plugin {
  return {
    name: "slopcad-standalone-inline-manifold-wasm",
    enforce: "pre",
    load(id) {
      if (!id.endsWith("manifold-3d/manifold.wasm?url")) return null;
      const file = id.slice(0, -"?url".length);
      const base64 = readFileSync(file).toString("base64");
      return `export default "data:application/wasm;base64,${base64}";`;
    },
  };
}

/**
 * Defuses the single `import.meta` in the worker graph: Manifold's loader
 * takes a `createRequire(import.meta.url)` only inside its Node branch,
 * which a worker never runs — but rollup cannot prove that dead in an IIFE
 * bundle. Pinning the (runtime-false) Node probe to `false` lets the DCE
 * remove the branch; a shape drift fails the build instead of shipping.
 */
function defuseManifoldNodeBranch(): Plugin {
  return {
    name: "slopcad-standalone-defuse-manifold-node-branch",
    enforce: "pre",
    transform(code, id) {
      if (!id.endsWith("manifold-3d/manifold.js")) return null;
      if (!code.includes(MANIFOLD_NODE_SENTINEL)) {
        this.error(
          "manifold-3d's loader shape changed: the standalone build's Node-branch defuse needs its sentinel updated",
        );
      }
      return code.replaceAll(
        MANIFOLD_NODE_SENTINEL,
        "var ENVIRONMENT_IS_NODE=false;",
      );
    },
  };
}

export default defineConfig({
  // The standalone does not read the public directory (its own output
  // lands inside it — no recursion, no copy).
  publicDir: false,
  plugins: [
    standaloneWorkerStub(),
    inlineManifoldWasm(),
    defuseManifoldNodeBranch(),
    tailwindcss(),
    viteReact(),
  ],
  resolve: {
    alias: {
      "@": `${APP_ROOT}src`,
    },
  },
  build: {
    outDir: "public/viewer-standalone",
    // The directory is this target's own output; stale assets must go.
    emptyOutDir: true,
    // Everything travels inside the two files: fonts (and any other
    // asset the CSS references) become data URLs.
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 8_000,
    rollupOptions: {
      input: `${APP_ROOT}src/viewer/viewer-standalone.tsx`,
      output: {
        entryFileNames: "viewer-standalone.js",
        assetFileNames: "viewer-standalone[extname]",
        // One chunk: an inline module script may import nothing external.
        codeSplitting: false,
      },
    },
    // The module-preload polyfill references import.meta and buys nothing
    // for a single-chunk inline script.
    modulePreload: false,
  },
  // The kernel worker is bundled classic (IIFE) and inlined by the
  // entry's `?worker&inline` import — the only form that loads from a
  // `file://` page. The main bundle itself stays ES (vite default).
  worker: {
    format: "iife",
    plugins: () => [
      standaloneWorkerStub(),
      inlineManifoldWasm(),
      defuseManifoldNodeBranch(),
    ],
  },
});
