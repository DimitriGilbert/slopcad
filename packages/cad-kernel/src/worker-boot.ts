/**
 * The crash-settling worker boot (Phase 35 hardening): one place that
 * turns a freshly constructed `new Worker(...)` into a channel whose
 * THREAD CRASH settles its in-flight requests.
 *
 * The worker entries document the hazard (see
 * `@slopcad/cad-kernel-manifold`'s `manifold-worker.web`): a hosting
 * failure used to reject as an unhandled rejection inside the worker while
 * the main-thread channel stayed silent — a request dispatched to the dead
 * channel simply never settled on its own, hanging the hosting surface
 * forever. The client already owns the settlement rule (`close()` settles
 * every still-pending request with the structured `worker/transport-closed`
 * failure — "the termination rule a real-worker host relies on when its
 * thread exits, deliberately or by crash"); this boot wires the three
 * triggers that prove the channel dead to exactly that rule:
 *
 * - `error` — the entry script failed to load or threw uncaught;
 * - `messageerror` — a message could not be deserialized on the main
 *   thread; the channel is no longer trustworthy;
 * - the worker-side boot-failure report (see
 *   `./worker-boot-failure-report`) — the plain message a web entry posts
 *   when its own hosting (the WASM boot) rejects. That rejection is a
 *   *handled* rejection inside the worker, so it never fires the main
 *   thread's `error` event; the report is the entry's death note, posted
 *   while the thread can still speak, followed by the entry closing itself.
 *
 * Either event settles the channel TERMINALLY, exactly once: the client
 * closes (in-flight requests reject with `worker/transport-closed`), the
 * thread is terminated, and the crash is reported once through `onCrash`
 * so the hosting surface can display it through its own error
 * conventions. `dispose()` is the deliberate sibling — same settlement,
 * no crash report — and is idempotent with it.
 *
 * The port is a structural interface (the `worker-web-transport` pattern):
 * this module typechecks under any `lib` configuration and the unit tests
 * drive it with a fake port; the real DOM `Worker` satisfies it. The
 * `new Worker(new URL(<entry>, import.meta.url), { type: "module" })`
 * construction stays at each hosting site — the bundler's static
 * analysis of the entry URL requires the literal there.
 */

import type { WorkerClient } from "./worker-client";
import type { WorkerTransport } from "./worker-transport";
import type { WebWorkerMessagePort } from "./worker-web-transport";

import { createWorkerClient } from "./worker-client";
import { parseWorkerBootFailureReport } from "./worker-boot-failure-report";
import { createWebWorkerTransport } from "./worker-web-transport";

/**
 * The main-thread end of a dedicated worker channel this boot needs: the
 * message port plus the crash-relevant surface (`terminate`, the `error`
 * and `messageerror` events). The real DOM `Worker` satisfies it.
 */
export interface WorkerCrashPort extends WebWorkerMessagePort {
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

/** Why a channel settled terminally by itself. */
export interface WorkerBootFailure {
  /** Which trigger proved the channel dead (a DOM event or the worker's own boot-failure report). */
  readonly kind: "error" | "messageerror" | "boot-failure";
  /** The honest failure text (`messageerror` has none; it says so). */
  readonly message: string;
}

/** A booted worker channel: the worker, its transport and client, and the terminal settle. */
export interface BootedWorkerChannel {
  readonly worker: WorkerCrashPort;
  readonly transport: WorkerTransport;
  readonly client: WorkerClient;
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
  "A worker message could not be deserialized on the main thread; the channel is no longer trustworthy.";

/** The `error` settlement text when the event carries an empty message. */
const EMPTY_ERROR_TEXT =
  "The worker thread failed before or while running its entry (no error message was provided).";

/**
 * Boots a worker channel whose crash settles its in-flight requests:
 * wraps the ALREADY-CONSTRUCTED worker (see the module doc for why the
 * `new Worker` stays at the hosting site) in the web transport + worker
 * client and wires `error`/`messageerror` plus the worker-side
 * boot-failure report to terminal settlement.
 */
export function bootWorkerChannel(
  port: WorkerCrashPort,
  onCrash: (failure: WorkerBootFailure) => void,
): BootedWorkerChannel {
  // Terminal exactly once: the first of {crash, boot-failure report,
  // deliberate dispose} wins; later triggers (a queued crash after dispose,
  // a second error) are no-ops.
  let settled = false;
  const settle = (report: WorkerBootFailure | null): void => {
    if (settled) return;
    settled = true;
    client.close();
    port.terminate();
    if (report !== null) onCrash(report);
  };
  // Subscribed FIRST, before the transport: the boot-failure report is the
  // worker's death note and must settle the channel before (and instead of)
  // reaching the client — which would drop it as non-protocol data and let
  // the pending requests it exists to settle keep hanging. A listener
  // removed during dispatch is not invoked, so close()'s unsubscribe inside
  // settle() keeps the transport from seeing the report at all.
  port.addEventListener("message", (event) => {
    const report = parseWorkerBootFailureReport(event.data);
    if (report !== null) {
      settle({ kind: "boot-failure", message: report.message });
    }
  });
  const transport = createWebWorkerTransport(port);
  const client = createWorkerClient({ transport });
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
