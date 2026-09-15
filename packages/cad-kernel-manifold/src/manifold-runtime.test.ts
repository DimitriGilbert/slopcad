/**
 * Tests of the Manifold runtime initialization semantics: memoization of
 * the shared WASM module and the retry-after-failure behaviour. The
 * manifold-3d module is mocked with a stateful factory so a rejected
 * initialization (and only that) can be exercised without breaking the
 * environment; every other test file uses the real WASM module in its own
 * isolated module registry.
 */

import { describe, expect, it, vi } from "vitest";

import { createManifoldRuntime } from "./manifold-runtime";

const { moduleMock } = vi.hoisted(() => ({
  moduleMock: vi.fn<() => Promise<{ setup: () => void }>>(),
}));

vi.mock("manifold-3d", () => ({ default: () => moduleMock() }));

describe("manifold runtime initialization", () => {
  it("retries initialization after a failure and then memoizes success", async () => {
    moduleMock.mockRejectedValueOnce(new Error("wasm instantiate boom"));
    await expect(createManifoldRuntime()).rejects.toThrow(
      "wasm instantiate boom",
    );

    const setup = vi.fn();
    moduleMock.mockResolvedValue({ setup });
    const runtime = await createManifoldRuntime();
    expect(setup).toHaveBeenCalledOnce();

    // The successful runtime is memoized: a later call returns the same
    // instance without re-instantiating the WASM module.
    moduleMock.mockResolvedValue({ setup: vi.fn() });
    await expect(createManifoldRuntime()).resolves.toBe(runtime);
  });
});
