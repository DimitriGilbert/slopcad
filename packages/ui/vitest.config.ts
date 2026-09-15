import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

import { createTestConfig } from "../../packages/config/vitest/base";

export default defineConfig({
  ...createTestConfig({
    environment: "jsdom",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  }),
  resolve: {
    alias: {
      "@slopcad/ui/": `${resolve(__dirname, "src")}/`,
    },
  },
});
