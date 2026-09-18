/**
 * The web worker entry's boot report (Phase 21.2): the browser twin of the
 * node entry's thread echo — one plain non-protocol message, posted before
 * hosting starts, that the `/worker-occt` fixture reads to surface the
 * documented boot cost as data instead of hiding it.
 *
 * The message carries the worker's own measurements and nothing else: the
 * OpenCascade initialization time (module evaluation → WASM runtime ready)
 * and the bundler-pinned URL of the WASM asset the worker fetched — the
 * main thread never imports the binding, so the worker is the only side
 * that knows the asset's hashed URL. It has no protocol shape: every
 * protocol endpoint's parse boundary drops it, so it can never be
 * mis-correlated with a request.
 */

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** Message key of the boot report: maps to the init time in milliseconds. */
export const OCCT_WORKER_BOOT_REPORT_KEY = "slopcadOcctWorkerBootMs";

/** Message key of the boot report: maps to the pinned WASM asset URL. */
export const OCCT_WORKER_BOOT_WASM_URL_KEY = "slopcadOcctWorkerWasmUrl";

/** What the boot report carries. */
export interface OcctWorkerBootReport {
  /** The worker's own init measurement (module evaluation → runtime ready). */
  readonly bootMs: number;
  /** The bundler-emitted URL of the ~22 MB WASM asset the worker fetched. */
  readonly wasmUrl: string;
}

/**
 * Reads the web entry's boot report out of a channel message, or `null` for
 * every other message (protocol traffic included — the report is plain
 * non-protocol data the client's parse boundary drops). A report missing
 * either field, or carrying a non-finite time, reads as `null` — the
 * fixture treats that as absent data rather than a zero cost.
 */
export function occtWorkerBootReport(
  data: unknown,
): OcctWorkerBootReport | null {
  if (!isPlainRecord(data)) return null;
  const bootMs = data[OCCT_WORKER_BOOT_REPORT_KEY];
  const wasmUrl = data[OCCT_WORKER_BOOT_WASM_URL_KEY];
  if (
    typeof bootMs !== "number" ||
    !Number.isFinite(bootMs) ||
    bootMs < 0 ||
    typeof wasmUrl !== "string" ||
    wasmUrl === ""
  ) {
    return null;
  }
  return { bootMs, wasmUrl };
}
