/**
 * The worker-side boot-failure report: one plain non-protocol message a web
 * worker entry posts when hosting its kernel fails — the WASM boot's
 * rejection reaching the main thread while the thread can still post. This
 * is the shape `bootWorkerChannel` (see `./worker-boot`) settles a channel
 * terminally on, closing the gap a hosting failure otherwise opens: the
 * rejection never fires the main thread's Worker `error` event (it happens
 * inside the worker, caught by the entry itself), so without this report a
 * dead channel would hang every in-flight and future request forever.
 *
 * The message carries the honest failure text and nothing else. It has no
 * protocol shape: every protocol endpoint's parse boundary drops it, so it
 * can never be mis-correlated with a request — the same discipline as the
 * kernel boot reports (`@slopcad/cad-kernel-occt`'s
 * `occt-worker-boot-report`, `@slopcad/cad-kernel-manifold`'s
 * `manifold-worker-boot-report`). The shape lives HERE, in the shared
 * kernel, because both ends of the contract already depend on this package:
 * the worker entries build the message, the main-thread channel reads it.
 */

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** Message key of the boot-failure report: maps to the failure text. */
export const WORKER_BOOT_FAILURE_KEY = "slopcadWorkerBootFailure";

/** What the boot-failure report carries. */
export interface WorkerBootFailureReport {
  /** The hosting failure's honest text, for the hosting surface's error state. */
  readonly message: string;
}

/**
 * Reads the web entry's boot-failure report out of a channel message, or
 * `null` for every other message (protocol traffic included — the report is
 * plain non-protocol data the client's parse boundary drops). A report
 * missing its failure text, or carrying an empty or non-string one, reads as
 * `null` — a malformed death note must never crash the settlement path on
 * its own.
 */
export function parseWorkerBootFailureReport(
  data: unknown,
): WorkerBootFailureReport | null {
  if (!isPlainRecord(data)) return null;
  const message = data[WORKER_BOOT_FAILURE_KEY];
  if (typeof message !== "string" || message === "") return null;
  return { message };
}
