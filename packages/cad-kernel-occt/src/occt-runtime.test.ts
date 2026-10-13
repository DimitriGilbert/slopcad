/**
 * Tests of the OpenCascade runtime initialization semantics: memoization
 * of the shared WASM module, the retry-after-failure behaviour, and the
 * CDN-first boot's fallback to the bundled asset. The
 * replicad-opencascadejs module is mocked with a stateful factory so a
 * rejected initialization (and only that) can be exercised without paying
 * the ~180 ms / 100 MB-heap real boot in this file; every other test file
 * uses the real WASM module in its own isolated module registry.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOcctRuntime, OCCT_WASM_CDN_URL } from "./occt-runtime";

/** The emscripten factory's config: only the asset hook is read here. */
interface GlueConfig {
  readonly locateFile?: () => string;
}

const { moduleMock } = vi.hoisted(() => ({
  moduleMock: vi.fn<(config?: GlueConfig) => Promise<Record<string, never>>>(),
}));

vi.mock("replicad-opencascadejs", () => ({
  default: (config?: GlueConfig) => moduleMock(config),
}));

/** The bundled spare's URL, as the bundler's `?url` import would emit it. */
const LOCAL_WASM_URL = "/assets/replicad_single-B_1cTsn_.wasm";

/**
 * The glue's real asset path, modelled: resolve the binary through
 * `locateFile`, fetch it, and reject the factory when the fetch fails (the
 * emscripten abort the shipped glue raises when both its streaming and
 * ArrayBuffer fetches of the wasm fail).
 */
async function fetchingGlue(
  config?: GlueConfig,
): Promise<Record<string, never>> {
  const url = config?.locateFile?.() ?? "replicad_single.wasm";
  await fetch(url);
  return {};
}

/** Reads the installed `replicad-opencascadejs` version off its manifest. */
function installedBindingVersion(): string {
  const manifestPath = createRequire(import.meta.url).resolve(
    "replicad-opencascadejs/package.json",
  );
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string"
  ) {
    throw new Error("replicad-opencascadejs/package.json carries no version");
  }
  return manifest.version;
}

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

describe("occt runtime CDN-first boot", () => {
  const fetchMock = vi.fn<(input: string) => Promise<Response>>();

  beforeEach(() => {
    // A fresh module registry per test: the memoized runtime of an earlier
    // test must not answer this one's initialization.
    vi.resetModules();
    moduleMock.mockReset();
    moduleMock.mockImplementation(fetchingGlue);
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("pins the CDN URL to the installed binding version, never a floating tag", () => {
    expect(OCCT_WASM_CDN_URL).toBe(
      `https://cdn.jsdelivr.net/npm/replicad-opencascadejs@${installedBindingVersion()}/dist/replicad_single.wasm`,
    );
    expect(OCCT_WASM_CDN_URL).not.toContain("@latest");
  });

  it("boots from the CDN when its fetch succeeds", async () => {
    fetchMock.mockResolvedValue(new Response());
    const { createOcctRuntimeWithFallback } = await import("./occt-runtime");

    const located = await createOcctRuntimeWithFallback({
      primaryUrl: OCCT_WASM_CDN_URL,
      fallbackUrl: LOCAL_WASM_URL,
    });

    expect(located.wasmUrl).toBe(OCCT_WASM_CDN_URL);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      OCCT_WASM_CDN_URL,
    ]);
  });

  it("falls back to the bundled asset when the CDN fetch fails", async () => {
    fetchMock.mockImplementation((url) =>
      url === OCCT_WASM_CDN_URL
        ? Promise.reject(new TypeError("Failed to fetch"))
        : Promise.resolve(new Response()),
    );
    const { createOcctRuntime: freshRuntime, createOcctRuntimeWithFallback } =
      await import("./occt-runtime");

    const located = await createOcctRuntimeWithFallback({
      primaryUrl: OCCT_WASM_CDN_URL,
      fallbackUrl: LOCAL_WASM_URL,
    });

    // The CDN was tried first, then the spare served the runtime — and the
    // spare's runtime is the memoized shared one.
    expect(located.wasmUrl).toBe(LOCAL_WASM_URL);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      OCCT_WASM_CDN_URL,
      LOCAL_WASM_URL,
    ]);
    await expect(freshRuntime()).resolves.toBe(located.runtime);
    expect(moduleMock).toHaveBeenCalledTimes(2);
  });

  it("rejects with both causes when the CDN and the bundled asset both fail", async () => {
    const cdnFailure = new TypeError("Failed to fetch (cdn)");
    const localFailure = new TypeError("Failed to fetch (local)");
    fetchMock.mockImplementation((url) =>
      Promise.reject(url === OCCT_WASM_CDN_URL ? cdnFailure : localFailure),
    );
    const { createOcctRuntimeWithFallback } = await import("./occt-runtime");

    const failure = await createOcctRuntimeWithFallback({
      primaryUrl: OCCT_WASM_CDN_URL,
      fallbackUrl: LOCAL_WASM_URL,
    }).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure instanceof AggregateError ? failure.errors : []).toEqual([
      cdnFailure,
      localFailure,
    ]);
  });
});
