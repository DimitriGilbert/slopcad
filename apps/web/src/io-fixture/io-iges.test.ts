/**
 * Tests of the /io fixture's page-level IGES engine memo: a rejected boot
 * clears the memo so the next import re-boots the engine instead of
 * replaying the stale rejection until reload — the package runtime's twin
 * discipline (Phase 16 of the review fix plan), pinned here at the page
 * level. The engine entry and the reader are mocked so no wasm is fetched
 * or booted in a unit test.
 */

import { describe, expect, it, vi } from "vitest";

import { importIgesBytes } from "./io-iges";

const { engineFactory, readerMock } = vi.hoisted(() => ({
  engineFactory: vi.fn<() => Promise<Record<string, never>>>(),
  readerMock: vi.fn(),
}));

vi.mock("@slopcad/cad-kernel-occt/occt-iges-engine.web", () => ({
  createBrowserIgesEngine: () => engineFactory(),
}));

vi.mock("@slopcad/cad-kernel-occt/occt-iges-import", () => ({
  importIgesMeshes: readerMock,
}));

describe("the page-level IGES engine memo", () => {
  it("clears on rejection, re-boots on the next import, and memoizes success", async () => {
    // The reader's structured empty-input failure — the code string is the
    // stable public `iges-import/empty`: reaching it proves a call got
    // PAST the boot into the import boundary.
    readerMock.mockImplementation(() => ({
      ok: false as const,
      error: {
        code: "iges-import/empty",
        message:
          "The input is empty (0 bytes); there is no IGES file to import.",
        input: new Uint8Array(0),
      },
    }));
    const empty = new Uint8Array(0);

    // First boot rejects — the page surfaces the boot error.
    engineFactory.mockRejectedValueOnce(new Error("wasm boot boom"));
    await expect(importIgesBytes(empty)).rejects.toThrow("wasm boot boom");
    expect(engineFactory).toHaveBeenCalledTimes(1);

    // The rejected memo was cleared: the next import re-boots the engine
    // (second factory call) and proceeds to the reader.
    engineFactory.mockResolvedValue({});
    await expect(importIgesBytes(empty)).rejects.toThrow("iges-import/empty");
    expect(engineFactory).toHaveBeenCalledTimes(2);

    // The successful boot is memoized: a third import reuses the engine.
    await expect(importIgesBytes(empty)).rejects.toThrow("iges-import/empty");
    expect(engineFactory).toHaveBeenCalledTimes(2);
  });
});
