import { defineConfig } from "vitest/config";

import { createTestConfig } from "../../packages/config/vitest/base";

/**
 * The hook tests are React component tests (the jsdom tier of the test
 * alignment policy — same tier as `packages/ui` and `packages/cad-r3f`);
 * the store/model suites run fine under the same environment.
 */
export default defineConfig(
  createTestConfig({
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  }),
);
