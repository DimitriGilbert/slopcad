import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

import { createTestConfig } from "../../packages/config/vitest/base";

/**
 * The docs-examples suite: every guide's runnable example runs here and its
 * documented outcome is asserted. Node environment by default (the headless
 * CAD surface); the React store example opts into jsdom through the
 * `@vitest-environment jsdom` docblock, the same per-file opt-in the base
 * factory's jsdom option exists for.
 */
export default defineConfig({
  ...createTestConfig({
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  }),
  resolve: {
    alias: {
      "@docs-examples/": `${resolve(__dirname, "src")}/`,
    },
  },
});
