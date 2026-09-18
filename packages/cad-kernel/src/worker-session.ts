/**
 * In-process kernel hosting (Phase 10.2): wires a {@link GeometryKernel}
 * behind the full worker stack — in-memory transport, server, client — so
 * the domain is callable in-process today while every call already speaks the
 * worker protocol. This is the settled architecture's first landing: flipping
 * to the Phase 10.3 real-worker transport swaps the pair for a
 * `postMessage` adapter and changes no public API above it, because the
 * client and server here depend only on the {@link WorkerTransport} interface
 * and the Phase 10.1 protocol types.
 */

import type { GeometryKernel } from "./contract";
import type { WorkerCancellationLedger } from "./worker-cancellation";
import type { WorkerClient } from "./worker-client";
import type { WorkerIdGenerator } from "./worker-ids";
import type { WorkerServer } from "./worker-server";
import type { InMemoryWorkerTransportPair } from "./worker-transport";

import { createWorkerClient } from "./worker-client";
import { createWorkerIdGenerator } from "./worker-ids";
import { createWorkerServer } from "./worker-server";
import { createInMemoryTransportPair } from "./worker-transport";

/** Options of {@link createInMemoryKernelSession}. */
export interface InMemoryKernelSessionOptions {
  /**
   * The channel's id generator — one generator serves both ends, minting
   * request ids (client) and solid ids (server) from its two counters.
   * Defaults to a fresh generator; pass one to pin or inspect assignment.
   */
  readonly ids?: WorkerIdGenerator;
  /** The responder-side cancellation ledger, injected to observe or seed it. */
  readonly ledger?: WorkerCancellationLedger;
}

/**
 * A fully wired in-process channel: `client` is the callable surface,
 * `server` the hosted kernel, `transport` the pair between them (kept for
 * tests and diagnostics that need to observe or inject at the wire).
 */
export interface InMemoryKernelSession {
  readonly client: WorkerClient;
  readonly server: WorkerServer;
  readonly transport: InMemoryWorkerTransportPair;
}

/** Hosts `kernel` behind an in-memory worker channel and returns its client. */
export function createInMemoryKernelSession(
  kernel: GeometryKernel,
  options: InMemoryKernelSessionOptions = {},
): InMemoryKernelSession {
  const ids = options.ids ?? createWorkerIdGenerator();
  const transport = createInMemoryTransportPair();
  const server = createWorkerServer({
    kernel,
    transport: transport.server,
    ids,
    ledger: options.ledger,
  });
  const client = createWorkerClient({ transport: transport.client, ids });
  return { client, server, transport };
}
