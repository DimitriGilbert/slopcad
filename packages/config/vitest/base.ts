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
      // Sized for the turbo-parallel reality: `pnpm test` runs every
      // package suite at once, and suite boot (transform + import) can
      // triple a test's wall time on a fully loaded machine — measured
      // victims ran 6.5-7.4 s against vitest's 5 s default without ever
      // failing standalone. An infrastructure budget, not an assertion:
      // passing still requires passing.
      testTimeout: 20_000,
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
