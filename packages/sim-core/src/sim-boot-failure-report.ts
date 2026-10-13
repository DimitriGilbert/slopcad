/**
 * The worker-side boot-failure report of the sim worker (Phase 61b): one
 * plain non-protocol message a sim worker entry posts when hosting its
 * engine fails — the kernel protocol's `worker-boot-failure-report`
 * (`@slopcad/cad-kernel`), restated with a sim-namespace message key under
 * sim-core's zero-runtime-dependency stance. It is the shape
 * `bootSimWorkerChannel` (see `./sim-worker-boot`) settles a channel
 * terminally on, closing the gap a hosting failure otherwise opens: a
 * handled rejection inside the worker never fires the main thread's Worker
 * `error` event, so without this report a dead channel would hang every
 * in-flight and future request forever.
 *
 * The message carries the honest failure text and nothing else. It has no
 * protocol shape: every protocol endpoint's parse boundary drops it, so it
 * can never be mis-correlated with a request. The sim key is deliberately
 * distinct from the kernel's (`slopcadWorkerBootFailure`) so a kernel-side
 * watcher never mistakes a sim death note for its own.
 */

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** Message key of the sim boot-failure report: maps to the failure text. */
export const SIM_WORKER_BOOT_FAILURE_KEY = "slopcadSimWorkerBootFailure";

/** What the sim boot-failure report carries. */
export interface SimWorkerBootFailureReport {
  /** The hosting failure's honest text, for the hosting surface's error state. */
  readonly message: string;
}

/**
 * Reads the sim worker entry's boot-failure report out of a channel message,
 * or `null` for every other message (protocol traffic included — the report
 * is plain non-protocol data the client's parse boundary drops). A report
 * missing its failure text, or carrying an empty or non-string one, reads
 * as `null` — a malformed death note must never crash the settlement path
 * on its own.
 */
export function parseSimWorkerBootFailureReport(
  data: unknown,
): SimWorkerBootFailureReport | null {
  if (!isPlainRecord(data)) return null;
  const message = data[SIM_WORKER_BOOT_FAILURE_KEY];
  if (typeof message !== "string" || message === "") return null;
  return { message };
}
