/**
 * The crash-settling sim worker boot (Phase 61b): one place that turns a
 * freshly constructed `new Worker(...)` into a sim channel whose THREAD
 * CRASH settles its in-flight requests — the kernel protocol's
 * `worker-boot` (`@slopcad/cad-kernel`), restated for the sim protocol and
 * its client (the kernel boot wires the kernel client, which would drop
 * every sim notification).
 *
 * Three triggers prove the channel dead, each settling it TERMINALLY,
 * exactly once: the client closes (in-flight requests reject with
 * `worker/transport-closed`), the thread is terminated, and the crash is
 * reported once through `onCrash` so the hosting surface can display it:
 *
 * - `error` — the entry script failed to load or threw uncaught;
 * - `messageerror` — a message could not be deserialized on the main
 *   thread; the channel is no longer trustworthy;
 * - the worker-side boot-failure report (see `./sim-boot-failure-report`)
 *   — the plain message a sim entry posts when its own hosting rejects,
 *   followed by the entry closing itself.
 *
 * `dispose()` is the deliberate sibling — same settlement, no crash report
 * — and is idempotent with it.
 *
 * The port is a structural interface (the `sim-web-transport` pattern):
 * this module typechecks under any `lib` configuration and the unit tests
 * drive it with a fake port; the real DOM `Worker` satisfies it. The
 * `new Worker(new URL(<entry>, import.meta.url), { type: "module" })`
 * construction stays at each hosting site — the bundler's static analysis
 * of the entry URL requires the literal there.
 */

import type { SimWorkerClient } from "./sim-worker-client";
import type { SimWorkerTransport } from "./sim-transport";
import type { SimWebWorkerMessagePort } from "./sim-web-transport";

import { createSimWorkerClient } from "./sim-worker-client";
import { parseSimWorkerBootFailureReport } from "./sim-boot-failure-report";
import { createSimWebWorkerTransport } from "./sim-web-transport";

/**
 * The main-thread end of a dedicated sim worker channel this boot needs: the
 * message port plus the crash-relevant surface (`terminate`, the `error`
 * and `messageerror` events). The real DOM `Worker` satisfies it.
 */
export interface SimWorkerCrashPort extends SimWebWorkerMessagePort {
  /** Kills the worker thread (the terminal half of crash settlement). */
  terminate(): void;
  /** The port's own message subscription (redeclared: the overloads below join it). */
  addEventListener(
    type: "message",
    listener: (event: { readonly data: unknown }) => void,
  ): void;
  /** The thread crashed: the entry failed to load or threw uncaught. */
  addEventListener(
    type: "error",
    listener: (event: { readonly message: string }) => void,
  ): void;
  /** A message could not be deserialized on the main thread. */
  addEventListener(type: "messageerror", listener: () => void): void;
}

/** Why a sim channel settled terminally by itself. */
export interface SimWorkerBootFailure {
  /** Which trigger proved the channel dead (a DOM event or the worker's own boot-failure report). */
  readonly kind: "error" | "messageerror" | "boot-failure";
  /** The honest failure text (`messageerror` has none; it says so). */
  readonly message: string;
}

/** A booted sim worker channel: the worker, its transport and client, and the terminal settle. */
export interface BootedSimWorkerChannel {
  readonly worker: SimWorkerCrashPort;
  readonly transport: SimWorkerTransport;
  readonly client: SimWorkerClient;
  /**
   * Settles the channel terminally without a crash report: closes the
   * client (in-flight requests reject with `worker/transport-closed`) and
   * terminates the thread. Idempotent, and a no-op report-wise after a
   * crash already settled the channel.
   */
  dispose(): void;
}

/** The `messageerror` settlement text: the event carries no message of its own. */
const MESSAGE_ERROR_TEXT =
  "A sim worker message could not be deserialized on the main thread; the channel is no longer trustworthy.";

/** The `error` settlement text when the event carries an empty message. */
const EMPTY_ERROR_TEXT =
  "The sim worker thread failed before or while running its entry (no error message was provided).";

/**
 * Boots a sim worker channel whose crash settles its in-flight requests:
 * wraps the ALREADY-CONSTRUCTED worker (see the module doc for why the
 * `new Worker` stays at the hosting site) in the web transport + sim worker
 * client and wires `error`/`messageerror` plus the worker-side
 * boot-failure report to terminal settlement.
 */
export function bootSimWorkerChannel(
  port: SimWorkerCrashPort,
  onCrash: (failure: SimWorkerBootFailure) => void,
): BootedSimWorkerChannel {
  // Terminal exactly once: the first of {crash, boot-failure report,
  // deliberate dispose} wins; later triggers (a queued crash after dispose,
  // a second error) are no-ops.
  let settled = false;
  const settle = (report: SimWorkerBootFailure | null): void => {
    if (settled) return;
    settled = true;
    client.close();
    port.terminate();
    if (report !== null) onCrash(report);
  };
  // Subscribed FIRST, before the transport: the boot-failure report is the
  // worker's death note and must settle the channel before (and instead of)
  // reaching the client — which would drop it as non-protocol data and let
  // the pending requests it exists to settle keep hanging.
  port.addEventListener("message", (event) => {
    const report = parseSimWorkerBootFailureReport(event.data);
    if (report !== null) {
      settle({ kind: "boot-failure", message: report.message });
    }
  });
  const transport = createSimWebWorkerTransport(port);
  const client = createSimWorkerClient({ transport });
  port.addEventListener("error", (event) => {
    settle({
      kind: "error",
      message: event.message === "" ? EMPTY_ERROR_TEXT : event.message,
    });
  });
  port.addEventListener("messageerror", () => {
    settle({ kind: "messageerror", message: MESSAGE_ERROR_TEXT });
  });
  return {
    worker: port,
    transport,
    client,
    dispose(): void {
      settle(null);
    },
  };
}
