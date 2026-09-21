/**
 * The generic worker server (Phase 10.2): hosts the Phase 10.1 operation
 * vocabulary against any {@link GeometryKernel} — the fake kernel today, the
 * Manifold adapter in Phase 10.3 — over any {@link WorkerTransport}. It is a
 * generic adapter from the kernel contract to the worker protocol, and knows
 * no kernel specifics beyond the contract itself.
 *
 * ## The pipeline of one request
 *
 * 1. **Parse** — every arriving message crosses the Phase 10.1 trust boundary
 *    (`parseWorkerMessage`). An unparseable message gets one error response
 *    with `requestId: null` (correlation impossible — a version-gate failure
 *    cannot even trust the id field) and never reaches the kernel.
 * 2. **Admit** — a parsed request is admitted through the cancellation ledger
 *    (`start`): a duplicate id is refused with `worker/duplicate-request`,
 *    a cancelled id with the `worker/cancelled` ack, and neither executes
 *    anything. A cancel message is recorded in the ledger (`cancel`) and
 *    answered with nothing — the ack, when there is one, is the refused or
 *    suppressed request's own terminal error response. A message arriving in
 *    the responder role that is a *response* is misdirected and dropped.
 * 3. **Execute** — admitted requests execute in a separate microtask, after
 *    the receive callback returns (mirroring a real worker's non-reentrant
 *    message loop, and making the ledger's cancellation window observable:
 *    a cancel queued behind a request is recorded before the request runs).
 *    Execution decodes the operation (`decodeWorkerRequest`), resolves every
 *    {@link WorkerSolidId} input against the session's solid map, calls the
 *    kernel, and runs the computed outcome through `ledger.finish`: a
 *    suppressed outcome is dropped and replaced by the `worker/cancelled`
 *    ack, so a late success can never be emitted after a recorded
 *    cancellation.
 *
 * ## Solid-id mapping lifecycle
 *
 * The wire addresses solids by {@link WorkerSolidId}; the kernel by its
 * opaque `KernelSolid` handles. The server keeps the session's mapping and
 * mints ids with a deterministic {@link WorkerIdGenerator} *at delivery
 * time*: a solid id is assigned when a result is actually emitted, in
 * delivery order, so the same request sequence over a fresh session assigns
 * identical ids and a cancelled computation consumes none. `solid.dispose`
 * releases the mapping (after the kernel's own `dispose`); an input
 * referencing an unknown or disposed id fails before the kernel is called,
 * with the solid-not-owned equivalent structured error:
 * `worker/operation-failed` carrying `data.kernelCode = kernel/solid-not-owned`.
 * Every other kernel failure rides the same `worker/operation-failed` shape
 * with its kernel code in `data`; a kernel that breaks the contract and
 * throws is converted the same way instead of poisoning the channel.
 */

import type { WorkerCancellationLedger } from "./worker-cancellation";
import type { WorkerIdGenerator, WorkerSolidId } from "./worker-ids";
import type {
  DecodedWorkerRequest,
  WorkerRequestMessage,
  WorkerResponseMessage,
  WorkerSuccessResponseMessage,
} from "./worker-protocol";
import type { WorkerTransport } from "./worker-transport";

import {
  KERNEL_ERROR_CODES,
  type GeometryKernel,
  type KernelError,
  type KernelSolid,
  type TransformInput,
} from "./contract";
import { createWorkerCancellationLedger } from "./worker-cancellation";
import {
  toWorkerError,
  type WorkerError,
  workerError,
  WORKER_PROTOCOL_ERROR_CODES,
} from "./worker-errors";
import { createWorkerIdGenerator } from "./worker-ids";
import {
  createWorkerErrorResponse,
  createWorkerSuccessResponse,
  decodeWorkerRequest,
  parseWorkerMessage,
} from "./worker-protocol";
import {
  BREP_EXPORT_UNSUPPORTED_CODE,
  BREP_IMPORT_UNSUPPORTED_CODE,
  STEP_EXPORT_UNSUPPORTED_CODE,
  STEP_IMPORT_UNSUPPORTED_CODE,
  TOPOLOGY_UNSUPPORTED_CODE,
  type WorkerBrepExporter,
  type WorkerBrepImporter,
  type WorkerImportedBrepSolidRef,
  type WorkerImportedSolidRef,
  type WorkerStepExporter,
  type WorkerStepImporter,
  type WorkerTopologyReporter,
} from "./worker-operations";

/** The operations whose success mints a new session solid. */
type SolidProducingOperation =
  | "solid.createBox"
  | "solid.createSphere"
  | "solid.createCylinder"
  | "solid.createCone"
  | "solid.extrude"
  | "solid.revolve"
  | "solid.sweep"
  | "solid.helixSweep"
  | "solid.loft"
  | "solid.union"
  | "solid.subtract"
  | "solid.intersect"
  | "solid.transform"
  | "solid.fillet"
  | "solid.chamfer"
  | "solid.shell"
  | "solid.mirror";

/** What executing a request produced, before the ledger decides delivery. */
type ExecutionOutcome =
  | {
      readonly status: "solid";
      readonly operation: SolidProducingOperation;
      readonly handle: KernelSolid;
    }
  | {
      readonly status: "solids";
      /**
       * The import operation whose result these solids are — the response's
       * operation and provenance literal derive from it.
       */
      readonly operation: ImportOperation;
      readonly handles: readonly KernelSolid[];
    }
  | {
      readonly status: "value";
      readonly response: WorkerSuccessResponseMessage;
    }
  | { readonly status: "failed"; readonly error: WorkerError };

/** The file-import operations whose results mint provenance-marked solids. */
type ImportOperation = "step.import" | "brep.import";

/** Options of {@link createWorkerServer}. */
export interface WorkerServerOptions {
  /** The kernel that executes the operations — any contract implementation. */
  readonly kernel: GeometryKernel;
  /** The transport end the server listens on and answers from. */
  readonly transport: WorkerTransport;
  /**
   * Mints the session's {@link WorkerSolidId}s. Defaults to a fresh
   * generator; pass one to pin or inspect id assignment.
   */
  readonly ids?: WorkerIdGenerator;
  /** The responder-side cancellation ledger. Defaults to a fresh one. */
  readonly ledger?: WorkerCancellationLedger;
  /**
   * The optional `step.import` execution surface (the Phase 21.3 vocabulary
   * extension): file bytes in, kernel solids out. Only hosts whose kernel
   * actually imports STEP provide one — a server without the extension
   * answers `step.import` with the structured `step-import/unsupported`
   * failure instead of misdirecting the kernel.
   */
  readonly stepImport?: WorkerStepImporter;
  /**
   * The optional `step.export` execution surface (the Phase 21.4 vocabulary
   * extension): owned kernel solids plus optional unit/schema settings in,
   * STEP file bytes out. A server without the extension answers
   * `step.export` with the structured `step-export/unsupported` failure.
   */
  readonly stepExport?: WorkerStepExporter;
  /**
   * The optional `brep.import` execution surface (the Phase 21.5 vocabulary
   * extension): BREP file bytes in, kernel solids out. A server without the
   * extension answers `brep.import` with the structured
   * `brep-import/unsupported` failure.
   */
  readonly brepImport?: WorkerBrepImporter;
  /**
   * The optional `brep.export` execution surface (the Phase 21.5 vocabulary
   * extension): owned kernel solids in, BREP file bytes out. A server
   * without the extension answers `brep.export` with the structured
   * `brep-export/unsupported` failure.
   */
  readonly brepExport?: WorkerBrepExporter;
  /**
   * The optional `solid.topology` execution surface (the Phase 26.5
   * vocabulary extension): one owned kernel solid plus its labeling context
   * in, the kernel-neutral topology snapshot out — the edge-picking layer's
   * data source. A server without the extension answers `solid.topology`
   * with the structured `topology/unsupported` failure.
   */
  readonly topology?: WorkerTopologyReporter;
}

/** A hosted kernel: subscribed to its transport until closed. */
export interface WorkerServer {
  /** Unsubscribes from the transport; later messages are ignored. */
  close(): void;
}

/** Hosts `options.kernel` as a worker-protocol responder on its transport. */
export function createWorkerServer(options: WorkerServerOptions): WorkerServer {
  const {
    kernel,
    transport,
    stepImport,
    stepExport,
    brepImport,
    brepExport,
    topology,
  } = options;
  const ids = options.ids ?? createWorkerIdGenerator();
  const ledger = options.ledger ?? createWorkerCancellationLedger();
  const solids = new Map<WorkerSolidId, KernelSolid>();

  function cancelledAck(
    requestId: WorkerRequestMessage["requestId"],
    reason: string,
  ): WorkerResponseMessage {
    return createWorkerErrorResponse(
      requestId,
      workerError(
        WORKER_PROTOCOL_ERROR_CODES.cancelled,
        `The request "${requestId}" was cancelled (${reason}); its outcome is void.`,
      ),
    );
  }

  function solidNotOwnedError(
    operation: DecodedWorkerRequest["operation"],
    id: WorkerSolidId,
  ): WorkerError {
    return workerError(
      WORKER_PROTOCOL_ERROR_CODES.operationFailed,
      `The "${operation}" input references solid "${id}" that this worker session does not own (unknown or already disposed).`,
      { kernelCode: KERNEL_ERROR_CODES.solidNotOwned },
    );
  }

  function kernelFailure(
    operation: DecodedWorkerRequest["operation"],
    error: KernelError,
  ): WorkerError {
    return workerError(
      WORKER_PROTOCOL_ERROR_CODES.operationFailed,
      `The "${operation}" operation failed: ${error.message}`,
      { kernelCode: error.code },
    );
  }

  function unexpectedThrow(
    operation: DecodedWorkerRequest["operation"],
    error: unknown,
  ): WorkerError {
    const detail = error instanceof Error ? error.message : String(error);
    return workerError(
      WORKER_PROTOCOL_ERROR_CODES.operationFailed,
      `The "${operation}" operation threw unexpectedly: ${detail}`,
      { thrown: true },
    );
  }

  type SolidLookup =
    | { readonly status: "owned"; readonly handle: KernelSolid }
    | { readonly status: "failed"; readonly error: WorkerError };

  function ownedSolid(
    operation: DecodedWorkerRequest["operation"],
    id: WorkerSolidId,
  ): SolidLookup {
    const handle = solids.get(id);
    return handle === undefined
      ? { status: "failed", error: solidNotOwnedError(operation, id) }
      : { status: "owned", handle };
  }

  function execute(
    requestId: WorkerRequestMessage["requestId"],
    request: DecodedWorkerRequest,
  ): ExecutionOutcome {
    try {
      switch (request.operation) {
        case "solid.createBox": {
          const result = kernel.createBox(request.input);
          return result.ok
            ? {
                status: "solid",
                operation: "solid.createBox",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.createBox", result.error),
              };
        }
        case "solid.createSphere": {
          const result = kernel.createSphere(request.input);
          return result.ok
            ? {
                status: "solid",
                operation: "solid.createSphere",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.createSphere", result.error),
              };
        }
        case "solid.createCylinder": {
          const result = kernel.createCylinder(request.input);
          return result.ok
            ? {
                status: "solid",
                operation: "solid.createCylinder",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.createCylinder", result.error),
              };
        }
        case "solid.createCone": {
          const result = kernel.createCone(request.input);
          return result.ok
            ? {
                status: "solid",
                operation: "solid.createCone",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.createCone", result.error),
              };
        }
        case "solid.extrude": {
          const result = kernel.extrude(request.input);
          return result.ok
            ? {
                status: "solid",
                operation: "solid.extrude",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.extrude", result.error),
              };
        }
        case "solid.revolve": {
          const result = kernel.revolve(request.input);
          return result.ok
            ? {
                status: "solid",
                operation: "solid.revolve",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.revolve", result.error),
              };
        }
        case "solid.sweep": {
          const result = kernel.sweep(request.input);
          return result.ok
            ? {
                status: "solid",
                operation: "solid.sweep",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.sweep", result.error),
              };
        }
        case "solid.helixSweep": {
          const result = kernel.helixSweep(request.input);
          return result.ok
            ? {
                status: "solid",
                operation: "solid.helixSweep",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.helixSweep", result.error),
              };
        }
        case "solid.loft": {
          const result = kernel.loft(request.input);
          return result.ok
            ? {
                status: "solid",
                operation: "solid.loft",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.loft", result.error),
              };
        }
        case "solid.union": {
          const operands: KernelSolid[] = [];
          for (const id of request.input.operands) {
            const lookup = ownedSolid("solid.union", id);
            if (lookup.status === "failed") {
              return { status: "failed", error: lookup.error };
            }
            operands.push(lookup.handle);
          }
          const result = kernel.union(operands);
          return result.ok
            ? {
                status: "solid",
                operation: "solid.union",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.union", result.error),
              };
        }
        case "solid.subtract": {
          const target = ownedSolid("solid.subtract", request.input.target);
          if (target.status === "failed") {
            return { status: "failed", error: target.error };
          }
          const tools: KernelSolid[] = [];
          for (const id of request.input.tools) {
            const lookup = ownedSolid("solid.subtract", id);
            if (lookup.status === "failed") {
              return { status: "failed", error: lookup.error };
            }
            tools.push(lookup.handle);
          }
          const result = kernel.subtract(target.handle, tools);
          return result.ok
            ? {
                status: "solid",
                operation: "solid.subtract",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.subtract", result.error),
              };
        }
        case "solid.intersect": {
          const operands: KernelSolid[] = [];
          for (const id of request.input.operands) {
            const lookup = ownedSolid("solid.intersect", id);
            if (lookup.status === "failed") {
              return { status: "failed", error: lookup.error };
            }
            operands.push(lookup.handle);
          }
          const result = kernel.intersect(operands);
          return result.ok
            ? {
                status: "solid",
                operation: "solid.intersect",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.intersect", result.error),
              };
        }
        case "solid.transform": {
          const solid = ownedSolid("solid.transform", request.input.solid);
          if (solid.status === "failed") {
            return { status: "failed", error: solid.error };
          }
          // The full placement crosses into the kernel: translation plus
          // the optional rotation (Phase 21.2 wire extension), applied in
          // the contract's order — rotation first, translation second.
          const translation = request.input.translation;
          const input: TransformInput =
            request.input.rotation === undefined
              ? {
                  x: translation.x,
                  y: translation.y,
                  z: translation.z,
                }
              : {
                  x: translation.x,
                  y: translation.y,
                  z: translation.z,
                  rotation: request.input.rotation,
                };
          const result = kernel.transform(solid.handle, input);
          return result.ok
            ? {
                status: "solid",
                operation: "solid.transform",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.transform", result.error),
              };
        }
        case "solid.bounds": {
          const solid = ownedSolid("solid.bounds", request.input.solid);
          if (solid.status === "failed") {
            return { status: "failed", error: solid.error };
          }
          const result = kernel.bounds(solid.handle);
          return result.ok
            ? {
                status: "value",
                response: createWorkerSuccessResponse(
                  requestId,
                  "solid.bounds",
                  {
                    bounds: result.value,
                  },
                ),
              }
            : {
                status: "failed",
                error: kernelFailure("solid.bounds", result.error),
              };
        }
        case "solid.volume": {
          const solid = ownedSolid("solid.volume", request.input.solid);
          if (solid.status === "failed") {
            return { status: "failed", error: solid.error };
          }
          const result = kernel.volume(solid.handle);
          return result.ok
            ? {
                status: "value",
                response: createWorkerSuccessResponse(
                  requestId,
                  "solid.volume",
                  {
                    volume: result.value,
                  },
                ),
              }
            : {
                status: "failed",
                error: kernelFailure("solid.volume", result.error),
              };
        }
        case "solid.area": {
          const solid = ownedSolid("solid.area", request.input.solid);
          if (solid.status === "failed") {
            return { status: "failed", error: solid.error };
          }
          const result = kernel.area(solid.handle);
          return result.ok
            ? {
                status: "value",
                response: createWorkerSuccessResponse(requestId, "solid.area", {
                  area: result.value,
                }),
              }
            : {
                status: "failed",
                error: kernelFailure("solid.area", result.error),
              };
        }
        case "solid.tessellate": {
          const solid = ownedSolid("solid.tessellate", request.input.solid);
          if (solid.status === "failed") {
            return { status: "failed", error: solid.error };
          }
          const result = kernel.tessellate(solid.handle);
          return result.ok
            ? {
                status: "value",
                response: createWorkerSuccessResponse(
                  requestId,
                  "solid.tessellate",
                  {
                    tessellation: result.value,
                  },
                ),
              }
            : {
                status: "failed",
                error: kernelFailure("solid.tessellate", result.error),
              };
        }
        case "solid.dispose": {
          const solid = ownedSolid("solid.dispose", request.input.solid);
          if (solid.status === "failed") {
            return { status: "failed", error: solid.error };
          }
          kernel.dispose(solid.handle);
          solids.delete(request.input.solid);
          return {
            status: "value",
            response: createWorkerSuccessResponse(
              requestId,
              "solid.dispose",
              null,
            ),
          };
        }
        case "solid.fillet": {
          // The Phase 26.5 contract op, translated like its siblings: the
          // target resolves against the session map, the edges ride as
          // snapshot ordinals, and the kernel's own structured codes
          // (unknown ordinal, radius failure, unsupported engine) cross
          // back as `worker/operation-failed` data.
          const solid = ownedSolid("solid.fillet", request.input.target);
          if (solid.status === "failed") {
            return { status: "failed", error: solid.error };
          }
          const result = kernel.fillet({
            target: solid.handle,
            edges: request.input.edges,
            radius: request.input.radius,
          });
          return result.ok
            ? {
                status: "solid",
                operation: "solid.fillet",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.fillet", result.error),
              };
        }
        case "solid.chamfer": {
          // The Phase 26.6 contract op — the fillet dispatch verbatim, with
          // the symmetric distance in the radius's place: the kernel's own
          // structured codes (unknown ordinal, distance failure,
          // unsupported engine) cross back as `worker/operation-failed`
          // data.
          const solid = ownedSolid("solid.chamfer", request.input.target);
          if (solid.status === "failed") {
            return { status: "failed", error: solid.error };
          }
          const result = kernel.chamfer({
            target: solid.handle,
            edges: request.input.edges,
            distance: request.input.distance,
          });
          return result.ok
            ? {
                status: "solid",
                operation: "solid.chamfer",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.chamfer", result.error),
              };
        }
        case "solid.shell": {
          // The Phase 26.7 contract op — the edge-cut dispatch on the FACE
          // address: the target resolves against the session map, the
          // faces ride as snapshot ordinals, and the kernel's own
          // structured codes (unknown ordinal, thickness failure,
          // unsupported engine) cross back as `worker/operation-failed`
          // data.
          const solid = ownedSolid("solid.shell", request.input.target);
          if (solid.status === "failed") {
            return { status: "failed", error: solid.error };
          }
          const result = kernel.shell({
            target: solid.handle,
            faces: request.input.faces,
            thickness: request.input.thickness,
          });
          return result.ok
            ? {
                status: "solid",
                operation: "solid.shell",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.shell", result.error),
              };
        }
        case "solid.mirror": {
          // The Phase 26.9 contract op — the transform dispatch's
          // reflection sibling: the target resolves against the session
          // map, the world axis plane rides as its normal-axis literal
          // plus offset, and the kernel's own structured codes (foreign
          // handle, non-finite offset, unsupported engine) cross back as
          // `worker/operation-failed` data.
          const solid = ownedSolid("solid.mirror", request.input.target);
          if (solid.status === "failed") {
            return { status: "failed", error: solid.error };
          }
          const result = kernel.mirror(solid.handle, {
            axis: request.input.axis,
            offset: request.input.offset,
          });
          return result.ok
            ? {
                status: "solid",
                operation: "solid.mirror",
                handle: result.value,
              }
            : {
                status: "failed",
                error: kernelFailure("solid.mirror", result.error),
              };
        }
        case "solid.topology": {
          // The vocabulary's topology extension: executed through the
          // hosting extension when one exists (only a persistent-topology
          // kernel can report snapshots), and structurally unsupported
          // otherwise — the same honesty as the exchange extensions above.
          if (topology === undefined) {
            return {
              status: "failed",
              error: workerError(
                WORKER_PROTOCOL_ERROR_CODES.operationFailed,
                'The "solid.topology" operation has no topology reporter on this hosted kernel; topology snapshots are an optional backend capability.',
                { kernelCode: TOPOLOGY_UNSUPPORTED_CODE },
              ),
            };
          }
          const solid = ownedSolid("solid.topology", request.input.solid);
          if (solid.status === "failed") {
            return { status: "failed", error: solid.error };
          }
          const reported = topology(solid.handle, {
            bodyId: request.input.bodyId,
            regeneration: request.input.regeneration,
          });
          if (!reported.ok) {
            return {
              status: "failed",
              error: workerError(
                WORKER_PROTOCOL_ERROR_CODES.operationFailed,
                `The "solid.topology" operation failed: ${reported.error.message}`,
                { kernelCode: reported.error.code },
              ),
            };
          }
          return {
            status: "value",
            response: createWorkerSuccessResponse(requestId, "solid.topology", {
              snapshot: reported.value,
            }),
          };
        }
        case "step.import": {
          // The vocabulary's first extension operation: not a kernel-contract
          // method, so it executes through the hosting extension — and a
          // host without one says so structurally, never by throwing.
          if (stepImport === undefined) {
            return {
              status: "failed",
              error: workerError(
                WORKER_PROTOCOL_ERROR_CODES.operationFailed,
                'The "step.import" operation has no importer on this hosted kernel; STEP import is an optional backend capability.',
                { kernelCode: STEP_IMPORT_UNSUPPORTED_CODE },
              ),
            };
          }
          const imported = stepImport(request.input.data);
          if (!imported.ok) {
            return {
              status: "failed",
              error: workerError(
                WORKER_PROTOCOL_ERROR_CODES.operationFailed,
                `The "step.import" operation failed: ${imported.error.message}`,
                { kernelCode: imported.error.code },
              ),
            };
          }
          return {
            status: "solids",
            operation: "step.import",
            handles: imported.value,
          };
        }
        case "step.export": {
          // The export twin of the vocabulary extension: session solids in,
          // file bytes out — through the hosting extension when one exists,
          // and structurally unsupported otherwise. The input's solids
          // resolve against the session map exactly like boolean operands.
          if (stepExport === undefined) {
            return {
              status: "failed",
              error: workerError(
                WORKER_PROTOCOL_ERROR_CODES.operationFailed,
                'The "step.export" operation has no exporter on this hosted kernel; STEP export is an optional backend capability.',
                { kernelCode: STEP_EXPORT_UNSUPPORTED_CODE },
              ),
            };
          }
          const handles: KernelSolid[] = [];
          for (const id of request.input.solids) {
            const lookup = ownedSolid("step.export", id);
            if (lookup.status === "failed") {
              return { status: "failed", error: lookup.error };
            }
            handles.push(lookup.handle);
          }
          const exported = stepExport(handles, {
            unit: request.input.unit,
            schema: request.input.schema,
          });
          if (!exported.ok) {
            return {
              status: "failed",
              error: workerError(
                WORKER_PROTOCOL_ERROR_CODES.operationFailed,
                `The "step.export" operation failed: ${exported.error.message}`,
                { kernelCode: exported.error.code },
              ),
            };
          }
          // The result owns no solids: the exported geometry stays addressed
          // by the input ids the session still holds.
          return {
            status: "value",
            response: createWorkerSuccessResponse(requestId, "step.export", {
              data: exported.value,
            }),
          };
        }
        case "brep.import": {
          // The Phase 21.5 twin of the STEP import extension: identical
          // discipline — an optional hosting extension executes it, and a
          // host without one says so structurally.
          if (brepImport === undefined) {
            return {
              status: "failed",
              error: workerError(
                WORKER_PROTOCOL_ERROR_CODES.operationFailed,
                'The "brep.import" operation has no importer on this hosted kernel; BREP import is an optional backend capability.',
                { kernelCode: BREP_IMPORT_UNSUPPORTED_CODE },
              ),
            };
          }
          const imported = brepImport(request.input.data);
          if (!imported.ok) {
            return {
              status: "failed",
              error: workerError(
                WORKER_PROTOCOL_ERROR_CODES.operationFailed,
                `The "brep.import" operation failed: ${imported.error.message}`,
                { kernelCode: imported.error.code },
              ),
            };
          }
          return {
            status: "solids",
            operation: "brep.import",
            handles: imported.value,
          };
        }
        case "brep.export": {
          // The STEP export twin without settings: session solids in, BREP
          // file bytes out, through the hosting extension when one exists.
          if (brepExport === undefined) {
            return {
              status: "failed",
              error: workerError(
                WORKER_PROTOCOL_ERROR_CODES.operationFailed,
                'The "brep.export" operation has no exporter on this hosted kernel; BREP export is an optional backend capability.',
                { kernelCode: BREP_EXPORT_UNSUPPORTED_CODE },
              ),
            };
          }
          const handles: KernelSolid[] = [];
          for (const id of request.input.solids) {
            const lookup = ownedSolid("brep.export", id);
            if (lookup.status === "failed") {
              return { status: "failed", error: lookup.error };
            }
            handles.push(lookup.handle);
          }
          const exported = brepExport(handles);
          if (!exported.ok) {
            return {
              status: "failed",
              error: workerError(
                WORKER_PROTOCOL_ERROR_CODES.operationFailed,
                `The "brep.export" operation failed: ${exported.error.message}`,
                { kernelCode: exported.error.code },
              ),
            };
          }
          // Like step.export, the result owns no solids.
          return {
            status: "value",
            response: createWorkerSuccessResponse(requestId, "brep.export", {
              data: exported.value,
            }),
          };
        }
      }
    } catch (error) {
      return {
        status: "failed",
        error: unexpectedThrow(request.operation, error),
      };
    }
  }

  function finishAndRespond(
    requestId: WorkerRequestMessage["requestId"],
    outcome: ExecutionOutcome,
  ): void {
    const decision = ledger.finish(requestId);
    if (decision === "suppress") {
      // Cancellation wins ties: drop the computed outcome. Computed solids
      // that will never be addressed are released, so nothing leaks past the
      // void request — and no ids are minted for them. Each release is
      // contained per handle: the ledger already burned this id to terminal,
      // so a kernel dispose that breaks the contract and throws must not
      // cost the request its one terminal response — the cancelled ack below
      // is always reached, and the next handle's release still runs.
      const release = (handle: KernelSolid): void => {
        try {
          kernel.dispose(handle);
        } catch {
          // Best-effort release of a void outcome: the worst a throwing
          // dispose can cost here is its own handle, never the ack.
        }
      };
      if (outcome.status === "solid") release(outcome.handle);
      if (outcome.status === "solids") {
        for (const handle of outcome.handles) release(handle);
      }
      transport.send(cancelledAck(requestId, "while the request was running"));
      return;
    }
    if (outcome.status === "solid") {
      const id = ids.nextSolidId();
      solids.set(id, outcome.handle);
      transport.send(
        createWorkerSuccessResponse(requestId, outcome.operation, {
          solid: id,
        }),
      );
      return;
    }
    if (outcome.status === "solids") {
      // One id per imported solid, minted in file order; every ref carries
      // its import's provenance literal, the data-level marker that these
      // are geometry-only bodies with no parametric history behind them.
      const mint = (handle: KernelSolid): WorkerSolidId => {
        const id = ids.nextSolidId();
        solids.set(id, handle);
        return id;
      };
      if (outcome.operation === "step.import") {
        const refs: WorkerImportedSolidRef[] = outcome.handles.map(
          (handle): WorkerImportedSolidRef => ({
            solid: mint(handle),
            origin: "imported-step",
          }),
        );
        transport.send(
          createWorkerSuccessResponse(requestId, "step.import", {
            solids: refs,
          }),
        );
        return;
      }
      const refs: WorkerImportedBrepSolidRef[] = outcome.handles.map(
        (handle): WorkerImportedBrepSolidRef => ({
          solid: mint(handle),
          origin: "imported-brep",
        }),
      );
      transport.send(
        createWorkerSuccessResponse(requestId, "brep.import", {
          solids: refs,
        }),
      );
      return;
    }
    transport.send(
      outcome.status === "value"
        ? outcome.response
        : createWorkerErrorResponse(requestId, outcome.error),
    );
  }

  function respondExecuted(message: WorkerRequestMessage): void {
    // Decode failure is a computed outcome too: it routes through finish, so
    // a cancellation recorded between admission and execution still wins.
    const decoded = decodeWorkerRequest(message);
    const outcome: ExecutionOutcome = decoded.ok
      ? execute(message.requestId, decoded.value)
      : { status: "failed", error: toWorkerError(decoded.error) };
    finishAndRespond(message.requestId, outcome);
  }

  function receive(data: unknown): void {
    const parsed = parseWorkerMessage(data);
    if (!parsed.ok) {
      // Correlation is impossible for an unparseable message: answer with a
      // null request id so the sender can only log, never mis-correlate.
      transport.send(
        createWorkerErrorResponse(null, toWorkerError(parsed.error)),
      );
      return;
    }
    const message = parsed.value;
    if (message.kind === "response") {
      // A response arriving in the responder role is misdirected; the
      // protocol gives this end no way to act on it, so it is dropped.
      return;
    }
    if (message.kind === "cancel") {
      // Best-effort: record the intent; the cancelled request's own
      // terminal response is the acknowledgement, and a cancel for an
      // already-finished request reports "ignored" with no emission.
      ledger.cancel(message.requestId);
      return;
    }
    const decision = ledger.start(message.requestId);
    if (decision === "refuse-duplicate") {
      transport.send(
        createWorkerErrorResponse(
          message.requestId,
          workerError(
            WORKER_PROTOCOL_ERROR_CODES.duplicateRequest,
            `A request id is single-use per channel: "${message.requestId}" was already used (running, answered, or refused).`,
          ),
        ),
      );
      return;
    }
    if (decision === "refuse-cancelled") {
      transport.send(
        cancelledAck(message.requestId, "before the request arrived"),
      );
      return;
    }
    // Execute after the receive callback returns, mirroring a real worker's
    // non-reentrant message loop and keeping the cancellation window open
    // for cancels queued behind this request.
    queueMicrotask(() => respondExecuted(message));
  }

  const unsubscribe = transport.onMessage(receive);
  return {
    close(): void {
      unsubscribe();
    },
  };
}
