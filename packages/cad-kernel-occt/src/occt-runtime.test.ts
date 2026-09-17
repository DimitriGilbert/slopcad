/**
 * Tests of the OpenCascade runtime initialization semantics: memoization
 * of the shared WASM module and the retry-after-failure behaviour. The
 * replicad-opencascadejs module is mocked with a stateful factory so a
 * rejected initialization (and only that) can be exercised without paying
 * the ~180 ms / 100 MB-heap real boot in this file; every other test file
 * uses the real WASM module in its own isolated module registry.
 */

import { describe, expect, it, vi } from "vitest";

import { createOcctRuntime } from "./occt-runtime";

const { moduleMock } = vi.hoisted(() => ({
  moduleMock: vi.fn<() => Promise<Record<string, never>>>(),
}));

vi.mock("replicad-opencascadejs", () => ({ default: () => moduleMock() }));

describe("occt runtime initialization", () => {
  it("retries initialization after a failure and then memoizes success", async () => {
    moduleMock.mockRejectedValueOnce(new Error("wasm instantiate boom"));
    await expect(createOcctRuntime()).rejects.toThrow("wasm instantiate boom");

    moduleMock.mockResolvedValue({});
    const runtime = await createOcctRuntime();

    // The successful runtime is memoized: a later call returns the same
    // instance without re-instantiating the WASM module.
    moduleMock.mockResolvedValue({});
    await expect(createOcctRuntime()).resolves.toBe(runtime);
    expect(moduleMock).toHaveBeenCalledTimes(2);
  });
});
