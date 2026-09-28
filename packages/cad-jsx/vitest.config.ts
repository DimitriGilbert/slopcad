import { defineConfig } from "vitest/config";

import { createTestConfig } from "../../packages/config/vitest/base";

/**
 * The compiler suite is pure tree walking (the node tier of the test
 * alignment policy — same tier as `packages/cad-core` and
 * `packages/cad-sketch`): React elements are consumed as plain data, so no
 * DOM environment is needed.
 */
export default defineConfig(createTestConfig());
