/**
 * OpenCascade WASM runtime initialization (Phase 21.1), mirroring the
 * Manifold runtime's shape.
 *
 * `replicad-opencascadejs` is an emscripten MODULARIZE module: the default
 * export is an async factory that downloads, compiles, and instantiates the
 * ~22 MB single-thread WASM binary (OCCT 8.0 via the maintained TauCAD
 * build chain — see docs/architecture/occt-prespike-findings.md) and returns
 * the fully populated instance. This module exposes an {@link OcctRuntime}
 * handle that the kernel constructor closes over, so kernels are created
 * synchronously from an already-initialized runtime.
 *
 * ## The heap floor
 *
 * The instance preallocates a 100 MB linear WASM heap at init (probed: the
 * heap stays exactly at its starting size through sustained boolean work
 * and never shrinks; growth beyond it is unbounded). Every kernel in a
 * JavaScript context therefore costs at least that floor once — the runtime
 * is memoized per context so it is paid once, not once per kernel.
 *
 * ## WASM resolution
 *
 * - Node / vitest (this package's test environment): the emscripten glue
 *   resolves `replicad_single.wasm` next to itself through `import.meta.url`
 *   fallback, so a plain `init()` call with no `locateFile` works — probed
 *   against `replicad-opencascadejs@1.1.0` under Node ESM.
 * - Browser bundling (the Phase 21.2 worker): Vite's dependency optimizer
 *   breaks the default `new URL(..., import.meta.url)` resolution, so the
 *   browser worker entry must pin the asset by passing
 *   `locateFile: () => wasmUrl` here, with the URL coming from
 *   `import wasmUrl from "replicad-opencascadejs/wasm?url"` (the exports
 *   map's `./wasm` subpath makes that import legal) — the same discipline
 *   as `manifold-worker.web.ts`.
 * - The CDN-first browser boot ({@link createOcctRuntimeWithFallback}): the
 *   worker entry resolves the asset from the version-pinned jsDelivr URL
 *   ({@link OCCT_WASM_CDN_URL}) first and, when that initialization fails
 *   (the emscripten glue's fetch of the binary rejected — offline, blocked,
 *   or a CDN outage), re-initializes from the bundled `?url` asset, which
 *   stays in the bundle as the spare.
 *
 * A failed initialization clears the memo so an environment fix can be
 * retried — the seam the CDN fallback rides; concurrent callers await the
 * same initialization.
 */

import init from "replicad-opencascadejs";
import type { OpenCascadeInstance } from "replicad-opencascadejs";

/**
 * Module-private brand of {@link OcctRuntime}. Exported for the sibling
 * kernel module (the only consumer allowed to read the instance) but NOT
 * re-exported from the package index — no OpenCascade type crosses the
 * package's public surface.
 */
export const RUNTIME_BRAND = Symbol("slopcad.cad-kernel-occt/OcctRuntime");

/**
 * An initialized OpenCascade WASM runtime. Opaque by construction: the brand
 * key never leaves this package, so consumers can pass the handle around
 * but cannot touch the OpenCascade instance inside it.
 */
export interface OcctRuntime {
  readonly [RUNTIME_BRAND]: OpenCascadeInstance;
}

/** Options of {@link createOcctRuntime}. */
export interface OcctRuntimeOptions {
  /**
   * Overrides how the emscripten factory locates `replicad_single.wasm` —
   * the browser bundling path's asset pin (see the module doc). Node needs
   * no override.
   */
  readonly locateFile?: () => string;
}

/**
 * The version-pinned jsDelivr URL of `replicad_single.wasm` — the exact
 * `replicad-opencascadejs` version this package depends on (`1.1.0`),
 * never a floating tag, so the CDN binary always matches the bundled glue
 * (jsDelivr serves it with `access-control-allow-origin: *`,
 * `application/wasm`, and an immutable one-year cache).
 */
export const OCCT_WASM_CDN_URL =
  "https://cdn.jsdelivr.net/npm/replicad-opencascadejs@1.1.0/dist/replicad_single.wasm";

let runtimePromise: Promise<OcctRuntime> | undefined;

/**
 * Returns the shared, initialized OpenCascade runtime of this JavaScript
 * context, instantiating the WASM module on first call. Concurrent callers
 * await the same initialization.
 */
export function createOcctRuntime(
  options: OcctRuntimeOptions = {},
): Promise<OcctRuntime> {
  if (runtimePromise === undefined) {
    const config =
      options.locateFile === undefined
        ? undefined
        : { locateFile: options.locateFile };
    runtimePromise = init(config)
      .then((instance) => {
        const runtime: OcctRuntime = { [RUNTIME_BRAND]: instance };
        return runtime;
      })
      .catch((error: unknown) => {
        runtimePromise = undefined;
        throw error;
      });
  }
  return runtimePromise;
}

/** Options of {@link createOcctRuntimeWithFallback}. */
export interface OcctRuntimeFallbackOptions {
  /** The asset URL tried first (the browser entry's CDN pin). */
  readonly primaryUrl: string;
  /** The asset URL tried when the primary initialization fails. */
  readonly fallbackUrl: string;
}

/** An initialized runtime together with the asset URL it booted from. */
export interface LocatedOcctRuntime {
  readonly runtime: OcctRuntime;
  /** The URL of the WASM binary the runtime was instantiated from. */
  readonly wasmUrl: string;
}

/**
 * Initializes the shared runtime from `primaryUrl`, falling back to
 * `fallbackUrl` when that initialization rejects — the emscripten glue
 * rejects its factory when fetching the binary fails, and the memo's
 * clear-on-failure makes the second attempt a fresh instantiation. Reports
 * which asset served the runtime; when both attempts fail the rejection
 * carries both causes.
 */
export async function createOcctRuntimeWithFallback(
  options: OcctRuntimeFallbackOptions,
): Promise<LocatedOcctRuntime> {
  const { primaryUrl, fallbackUrl } = options;
  try {
    const runtime = await createOcctRuntime({ locateFile: () => primaryUrl });
    return { runtime, wasmUrl: primaryUrl };
  } catch (primaryError: unknown) {
    try {
      const runtime = await createOcctRuntime({
        locateFile: () => fallbackUrl,
      });
      return { runtime, wasmUrl: fallbackUrl };
    } catch (fallbackError: unknown) {
      throw new AggregateError(
        [primaryError, fallbackError],
        `OpenCascade WASM initialization failed from both ${primaryUrl} and ${fallbackUrl}.`,
      );
    }
  }
}
