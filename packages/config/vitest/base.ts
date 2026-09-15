import { configDefaults, type TestUserConfig } from "vitest/config";

export interface TestConfigOptions {
  environment?: "node" | "jsdom";
  include?: string[];
  setupFiles?: string[];
}

/**
 * Shared vitest configuration for every workspace package
 * (LearnABee donor pattern: one factory in packages/config, one config per package).
 */
export function createTestConfig(options: TestConfigOptions = {}): {
  test: TestUserConfig;
} {
  return {
    test: {
      environment: options.environment ?? "node",
      include: options.include ?? ["src/**/*.test.ts"],
      setupFiles: options.setupFiles ?? [],
      exclude: [...configDefaults.exclude, "**/e2e/**"],
      coverage: {
        provider: "istanbul",
        reporter: ["text", "json", "html"],
        include: ["src/**"],
        exclude: [
          "src/**/*.test.*",
          "src/test-setup.ts",
          "src/migrations/**",
          "**/*.gen.ts",
          "**/*.sql",
        ],
      },
    },
  };
}
