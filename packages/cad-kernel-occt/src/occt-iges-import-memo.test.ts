/**
 * Tests of the IGES engine initialization semantics: the memo's
 * retry-after-failure behaviour (the twin discipline of `./occt-runtime`,
 * mirroring `occt-runtime.test.ts`). The occt-import-js module is mocked
 * with a stateful factory so a rejected initialization (and only that) can
 * be exercised without paying the ~7.3 MB real wasm boot in this file; the
 * sibling `occt-iges-import.test.ts` uses the real engine in its own
 * isolated module registry.
 */

import { describe, expect, it, vi } from "vitest";

import { createIgesEngine } from "./occt-iges-import";

const { moduleMock } = vi.hoisted(() => ({
  moduleMock: vi.fn<() => Promise<Record<string, never>>>(),
}));

vi.mock("occt-import-js", () => ({ default: () => moduleMock() }));

describe("iges engine initialization", () => {
  it("retries initialization after a failure and then memoizes success", async () => {
    moduleMock.mockRejectedValueOnce(new Error("wasm instantiate boom"));
    await expect(createIgesEngine()).rejects.toThrow("wasm instantiate boom");

    moduleMock.mockResolvedValue({});
    const engine = await createIgesEngine();

    // The successful engine is memoized: a later call returns the same
    // instance without re-instantiating the WASM module.
    moduleMock.mockResolvedValue({});
    await expect(createIgesEngine()).resolves.toBe(engine);
    expect(moduleMock).toHaveBeenCalledTimes(2);
  });
});
