/**
 * The Phase 29 performance measurement suite (in-page): the numbers the
 * `/perf` fixture publishes as one JSON surface for the Playwright perf
 * harness to collect. Every measurement here runs against the REAL
 * production pipeline — the real Manifold worker entry, the real worker
 * client/protocol, the real plate scene (`computePlateWithHole`), the real
 * projection boundary, and the real workbench document with its host diff
 * (`documentChangeInvalidations` → `markStale` → `regenerate`) — so each
 * published sample is a main-thread observation of shipped bytes, not a
 * synthetic kernel call.
 *
 * ## Metric catalog (the stable sample keys)
 *
 * - `startup.wasmBoot.workerMs` — the worker's OWN measurement (module
 *   evaluation → WASM runtime ready), read from the entry's boot report
 *   (the Phase 29 Manifold twin of the OCCT report).
 * - `startup.bootReport.mainThreadMs` — main thread, `new Worker()` → the
 *   boot report message received (script fetch + module eval + WASM boot).
 * - `startup.firstResponse.mainThreadMs` — main thread, `new Worker()` →
 *   the first protocol response settled (the usable-startup number).
 * - `op.<operation>.roundTripMs` — per-operation main-thread round trip
 *   (send → response settled) for each operation of the plate chain, plus
 *   `op.chain.plateWithHole.totalMs` for the whole production chain.
 * - `projection.plate.totalMs` — the main-thread projection boundary
 *   (`projectTessellation` + `createRenderProjection`) over the settled
 *   tessellation.
 * - `transfer.tessellateResponse.structuredCloneMs` — `structuredClone` of
 *   the exact captured tessellate wire response: the documented PROXY for
 *   the postMessage structured-clone transfer (same algorithm, same
 *   runtime, same payload; a postMessage itself cannot be timed from one
 *   thread).
 * - `invalidation.parameterEdit.transactionMs` — the document transaction
 *   alone (`parameter.set` on the hole diameter — no feature consumers).
 * - `invalidation.featureParamEdit.diffMarkRegenerateMs` — the host
 *   derivation pass (diff + stale marking + regeneration) for an edit that
 *   DOES invalidate features: the translate parameter, one minimal edit
 *   per sample, cursor threaded exactly like the workbench engine's loop.
 * - `invalidation.grownDoc.diffMarkRegenerateMs` — the same pass on a
 *   document grown with a 40-feature extrude chain whose head parameter is
 *   edited (the whole chain re-executes) — the scaling probe for the
 *   incremental-invalidation ledger.
 *
 * The page-level metrics (scene settle, the applied → frame window —
 * `applyToFrameMs`, the production-build stand-in for React commit work
 * since React's Profiler API is a no-op in production bundles) are
 * collected by the fixture page over the shared coordinator session, not
 * here.
 */

import {
  createBodyId,
  createFeatureId,
  createParameterId,
  createRenderProjection,
  createSketchDocumentId,
  length,
  projectTessellation,
  type RenderCamera,
} from "@slopcad/cad-core";
import {
  applySessionCommand,
  applySessionTransaction,
  documentChangeInvalidations,
  initialRegenerationStates,
  markStale,
  regenerate,
  type CadCommand,
  type CadDocument,
  type CadSession,
  type CadTransaction,
  type FeatureId,
  type RegenerationResultMap,
  type RegenerationStateMap,
} from "@slopcad/cad-react";
import {
  bootWorkerChannel,
  createRevisionTag,
  createWorkerClient,
  resultMintsSolids,
  type ComputationContext,
  type WorkerBootFailure,
  type WorkerClient,
  type WorkerCrashPort,
  type WorkerSolidId,
  type WorkerTransport,
} from "@slopcad/cad-kernel";
import { manifoldWorkerBootReport } from "@slopcad/cad-kernel-manifold/manifold-worker-boot-report";

import { computePlateWithHole } from "../worker-fixture/plate-scene";
import { PLATE_HOLE_DIAMETER_DEFAULT_MM } from "../worker-fixture/plate-scene";
import { createCadWorkbenchSession } from "../cad-workbench/session";
import { workbenchExecutor } from "../workbench-fixture/workbench-extended-document";

/** How many fresh worker boots the startup probe measures. */
const STARTUP_BOOT_COUNT = 7;
/** How many plate-chain iterations the operation probe runs. */
const OPERATION_ITERATIONS = 25;
/** How many samples the pure main-thread probes (projection, transfer) take. */
const MAINTHREAD_SAMPLE_COUNT = 25;
/** How many samples each invalidation probe takes. */
const INVALIDATION_SAMPLE_COUNT = 50;
/** How many extrude features the invalidation growth probe chains. */
const GROWN_CHAIN_FEATURES = 40;

/** The environment block published beside the samples (provenance). */
export interface PerfEnvironment {
  readonly userAgent: string;
  readonly hardwareConcurrency: number | null;
  readonly deviceMemoryGb: number | null;
}

/** The settled geometry context the samples were measured against. */
export interface PerfGeometryContext {
  readonly triangles: number;
  readonly positions: number;
  readonly indices: number;
  readonly normals: boolean;
  /** JSON byte size of the tessellate wire response (the transfer payload). */
  readonly wireJsonBytes: number;
}

/** The tessellation the transfer and projection probes measure against. */
interface CapturedTessellation {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly normals?: readonly number[];
}

/** What {@link runInPageMeasurements} publishes. */
export interface InPageMeasurements {
  readonly environment: PerfEnvironment;
  readonly geometry: PerfGeometryContext;
  readonly samples: Readonly<Record<string, readonly number[]>>;
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

function readEnvironment(): PerfEnvironment {
  const nav = navigator as Navigator & { readonly deviceMemory?: unknown };
  const deviceMemory = nav.deviceMemory;
  return {
    userAgent: navigator.userAgent,
    hardwareConcurrency:
      typeof navigator.hardwareConcurrency === "number"
        ? navigator.hardwareConcurrency
        : null,
    deviceMemoryGb:
      typeof deviceMemory === "number" && Number.isFinite(deviceMemory)
        ? deviceMemory
        : null,
  };
}

/** One fresh Manifold worker channel: the worker, its transport and client. */
interface FreshChannel {
  readonly worker: WorkerCrashPort;
  readonly transport: WorkerTransport;
  readonly client: WorkerClient;
  dispose(): void;
}

/**
 * Boots the real Manifold worker entry (the same bundler-hosted module the
 * fixtures use), crash-settled (Phase 35 hardening): the boot's own client
 * settles on a thread crash, and `onCrash` lets a probe that built ITS OWN
 * client over the tapped transport close that client too, so a dead
 * thread fails the probe honestly instead of hanging it. The raw port
 * listener a caller adds FIRST sees every message, including the plain
 * non-protocol boot report that the worker client's parse boundary drops.
 */
function bootChannel(
  onCrash: (failure: WorkerBootFailure) => void,
): FreshChannel {
  const boot = bootWorkerChannel(
    new Worker(
      new URL("../worker-fixture/manifold-worker-entry.ts", import.meta.url),
      { type: "module" },
    ),
    onCrash,
  );
  return {
    worker: boot.worker,
    transport: boot.transport,
    client: boot.client,
    dispose(): void {
      boot.dispose();
    },
  };
}

/**
 * The startup probe: `STARTUP_BOOT_COUNT` fresh boots, each measured three
 * ways (see the metric catalog). Each boot's first request is a trivial
 * `solid.createBox` so "first response" measures startup, not geometry.
 */
async function probeStartup(): Promise<Record<string, number[]>> {
  const workerSide: number[] = [];
  const reportArrival: number[] = [];
  const firstResponse: number[] = [];
  for (let boot = 0; boot < STARTUP_BOOT_COUNT; boot += 1) {
    const created = performance.now();
    let reportSeen = false;
    const onMessage = (event: { readonly data: unknown }): void => {
      if (reportSeen) return;
      const report = manifoldWorkerBootReport(event.data);
      if (report === null) return;
      reportSeen = true;
      workerSide.push(report.bootMs);
      reportArrival.push(performance.now() - created);
    };
    // This probe speaks through the boot's own client: a thread crash
    // settles it (worker/transport-closed) and fails the probe honestly —
    // no additional crash wiring needed.
    const channel = bootChannel(() => {});
    channel.worker.addEventListener("message", onMessage);
    const client = channel.client;
    const box = await client.request("solid.createBox", {
      width: length(30, "mm"),
      depth: length(20, "mm"),
      height: length(10, "mm"),
    });
    firstResponse.push(performance.now() - created);
    await client.request("solid.dispose", { solid: box.solid });
    client.close();
    channel.worker.removeEventListener("message", onMessage);
    channel.dispose();
    // Let the terminated worker's teardown land before the next boot.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return {
    "startup.wasmBoot.workerMs": workerSide,
    "startup.bootReport.mainThreadMs": reportArrival,
    "startup.firstResponse.mainThreadMs": firstResponse,
  };
}

/** What the operation probe captured for the later main-thread probes. */
interface OperationCapture {
  readonly samples: Record<string, number[]>;
  readonly tessellation: CapturedTessellation;
  readonly wireResponse: unknown;
}

/**
 * The operation probe: `OPERATION_ITERATIONS` runs of the REAL production
 * plate chain (`computePlateWithHole`) over a tapped transport — each
 * `ComputationContext.request` is timed (send → response settled) and each
 * minted solid is disposed after the iteration, so the worker session holds
 * nothing between iterations. The tap captures the last tessellate wire
 * response verbatim for the transfer probe.
 */
async function probeOperations(): Promise<OperationCapture> {
  const samples: Record<string, number[]> = {};
  const chainTotals: number[] = [];
  const mints: WorkerSolidId[] = [];
  let tessellation: CapturedTessellation | null = null;
  let wireResponse: unknown = null;

  // This probe builds its OWN client over the tapped transport (the tap
  // must sit between transport and client), so a thread crash must close
  // THAT client: the boot terminates the thread, this handler settles the
  // probe's in-flight requests (worker/transport-closed), and the probe
  // fails honestly instead of hanging.
  const tappedClient: { client?: WorkerClient } = {};
  const channel = bootChannel(() => {
    tappedClient.client?.close();
  });
  const timed: WorkerTransport = {
    send(data: unknown): void {
      channel.transport.send(data);
    },
    onMessage(listener: (data: unknown) => void): () => void {
      return channel.transport.onMessage((data: unknown) => {
        // The tap records the exact tessellate wire response for the
        // transfer probe — after the structured clone already happened, so
        // recording is free and the payload is the real main-thread object.
        if (
          isPlainRecord(data) &&
          data.kind === "response" &&
          data.status === "ok" &&
          isPlainRecord(data.result) &&
          isPlainRecord(data.result.tessellation)
        ) {
          const captured = data.result.tessellation;
          const positions = captured.positions;
          const indices = captured.indices;
          const normals = captured.normals;
          if (Array.isArray(positions) && Array.isArray(indices)) {
            wireResponse = data;
            tessellation = {
              positions,
              indices,
              ...(Array.isArray(normals) ? { normals } : {}),
            };
          }
        }
        listener(data);
      });
    },
  };
  const client: WorkerClient = createWorkerClient({ transport: timed });
  tappedClient.client = client;

  const context: ComputationContext = {
    revision: createRevisionTag(1),
    request(operation, input) {
      const started = performance.now();
      return client.request(operation, input).then((result) => {
        const key = `op.${operation}.roundTripMs`;
        (samples[key] ??= []).push(performance.now() - started);
        mints.push(...resultMintsSolids(operation, result));
        return result;
      });
    },
  };

  for (let iteration = 0; iteration < OPERATION_ITERATIONS; iteration += 1) {
    mints.length = 0;
    const started = performance.now();
    await computePlateWithHole(context, PLATE_HOLE_DIAMETER_DEFAULT_MM);
    chainTotals.push(performance.now() - started);
    for (const solid of mints) {
      await client.request("solid.dispose", { solid });
    }
  }
  client.close();
  channel.dispose();
  samples["op.chain.plateWithHole.totalMs"] = chainTotals;
  if (tessellation === null || wireResponse === null) {
    throw new Error(
      "The operation probe never observed a tessellate response.",
    );
  }
  return { samples, tessellation, wireResponse };
}

/** The plate fixture's deterministic camera (the /render fixture's spec). */
const PROBE_CAMERA: RenderCamera = {
  kind: "perspective",
  position: [44, -30, 47],
  target: [15, 10, 5],
  up: [0, 0, 1],
  fovDeg: 40,
};

/**
 * The projection probe: the public projection boundary over the settled
 * tessellation — `projectTessellation` then `createRenderProjection`, the
 * exact pair every fixture scene applies per settled state.
 */
function probeProjection(
  captured: CapturedTessellation,
): Record<string, number[]> {
  const samples: number[] = [];
  const bodyId = createBodyId("body_plate");
  for (let i = 0; i < MAINTHREAD_SAMPLE_COUNT; i += 1) {
    const started = performance.now();
    const object = projectTessellation(bodyId, captured);
    if (!object.ok) {
      throw new Error(`Projection rejected: ${object.error.message}`);
    }
    const projection = createRenderProjection([object.value], PROBE_CAMERA);
    if (!projection.ok) {
      throw new Error(`Projection rejected: ${projection.error.message}`);
    }
    samples.push(performance.now() - started);
  }
  return { "projection.plate.totalMs": samples };
}

/**
 * The transfer probe: `structuredClone` of the exact captured tessellate
 * wire response — the documented proxy for the postMessage structured
 * clone (identical algorithm and runtime on both sides of the port; a
 * cross-thread postMessage cannot itself be timed from one thread).
 */
function probeTransfer(wireResponse: unknown): Record<string, number[]> {
  const samples: number[] = [];
  for (let i = 0; i < MAINTHREAD_SAMPLE_COUNT; i += 1) {
    const started = performance.now();
    structuredClone(wireResponse);
    samples.push(performance.now() - started);
  }
  return { "transfer.tessellateResponse.structuredCloneMs": samples };
}

/** One (document, states, results) regeneration cursor. */
interface RegenerationCursor {
  readonly document: CadDocument;
  readonly states: RegenerationStateMap;
  readonly results: RegenerationResultMap;
}

/**
 * Runs the host's exact derivation pass (the workbench engine's loop,
 * verbatim semantics): diff the previous document into changed nodes, mark
 * exactly those stale, regenerate with the workbench executor.
 */
function runDerivationPass(
  previous: RegenerationCursor,
  next: CadDocument,
): RegenerationCursor {
  const changed = documentChangeInvalidations(previous.document, next);
  const states = markStale(next.features, previous.states, changed);
  const applied = regenerate({
    features: next.features,
    states,
    suppressed: [],
    execute: workbenchExecutor(next),
    results: previous.results,
  });
  if (!applied.ok) {
    throw new Error(`Regeneration rejected: ${applied.error.message}`);
  }
  return {
    document: next,
    states: applied.value.states,
    results: applied.value.results,
  };
}

/** Boots the workbench document to a fully valid regeneration cursor. */
function bootWorkbenchCursor(document: CadDocument): RegenerationCursor {
  const applied = regenerate({
    features: document.features,
    states: initialRegenerationStates(document.features),
    suppressed: [],
    execute: workbenchExecutor(document),
  });
  if (!applied.ok) {
    throw new Error(`Regeneration rejected: ${applied.error.message}`);
  }
  return {
    document,
    states: applied.value.states,
    results: applied.value.results,
  };
}

/** The workbench session's parameter ids the invalidation probes edit. */
const HOLE_PARAMETER_ID = createParameterId("param_hole_diameter");
const TRANSLATE_X_PARAMETER_ID = createParameterId("param_translate_x");

/** Requires a successful session transaction or throws its failure. */
function requireApplied(
  applied:
    | { readonly ok: true; readonly value: CadSession }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): CadSession {
  if (!applied.ok) {
    throw new Error(`Transaction rejected (${what}): ${applied.error.message}`);
  }
  return applied.value;
}

/** Applies one atomic multi-command transaction, or throws its failure. */
function commit(
  session: CadSession,
  commands: readonly CadCommand[],
  what: string,
): CadSession {
  const transaction: CadTransaction = { commands: Object.freeze(commands) };
  return requireApplied(applySessionTransaction(session, transaction), what);
}

/** Applies one single command, or throws its failure. */
function commitCommand(
  session: CadSession,
  command: CadCommand,
  what: string,
): CadSession {
  return requireApplied(applySessionCommand(session, command), what);
}

/**
 * The invalidation probes: (a) the transaction alone for a parameter edit
 * with no feature consumers, (b) the full host derivation pass for a
 * minimal edit that invalidates the translate feature (translate + rotate
 * re-execute), cursor threaded exactly like the engine's loop, and (c) the
 * same pass on a document grown by a 40-feature extrude chain whose head
 * parameter is edited (the whole chain re-executes) — the scaling probe.
 * All three are pure main-thread measurements over the real workbench
 * document and executor.
 */
function probeInvalidation(): Record<string, number[]> {
  const transactionSamples: number[] = [];
  const editSamples: number[] = [];

  // (a) + (b): the workbench document as booted.
  {
    const boot = createCadWorkbenchSession();
    let cursor = bootWorkbenchCursor(boot.document);
    let session: CadSession = boot;
    for (let i = 0; i < INVALIDATION_SAMPLE_COUNT; i += 1) {
      // (a) the transaction alone: parameter.set on the hole diameter (no
      // feature consumes it — the edit the parameter panel makes).
      let started = performance.now();
      session = commitCommand(
        session,
        {
          type: "parameter.set",
          id: HOLE_PARAMETER_ID,
          value: length(8 + (i % 5) * 0.5, "mm"),
        },
        "hole diameter edit",
      );
      transactionSamples.push(performance.now() - started);
      // (b) the host derivation pass for ONE minimal translate edit — the
      // transaction is not part of the metric, only the diff + mark +
      // regenerate pass over the committed change.
      session = commitCommand(
        session,
        {
          type: "parameter.set",
          id: TRANSLATE_X_PARAMETER_ID,
          value: length(i % 3, "mm"),
        },
        "translate edit",
      );
      started = performance.now();
      cursor = runDerivationPass(cursor, session.document);
      editSamples.push(performance.now() - started);
    }
  }

  // (c): the growth probe — chain GROWN_CHAIN_FEATURES extrude features
  // (each in its own atomic transaction, exactly the sketch → solid bridge
  // the workbench commits), then edit the HEAD parameter and measure the
  // derivation pass that re-executes the whole chain.
  const grownSamples: number[] = [];
  {
    const boot = createCadWorkbenchSession();
    let session: CadSession = boot;
    const headParameter = createParameterId("param_chain_head_depth");
    const headSketch = createSketchDocumentId("skd_chain_head");
    const headBody = createBodyId("body_chain_head");
    const headFeature = createFeatureId("feat_chain_head");
    session = commit(
      session,
      [
        {
          type: "sketch.create",
          id: headSketch,
          name: "chain head sketch",
          sketch: {},
        },
        {
          type: "parameter.create",
          id: headParameter,
          name: "chainHeadDepth",
          value: length(5, "mm"),
        },
        { type: "body.create", id: headBody, name: "chain head" },
        {
          type: "feature.create",
          id: headFeature,
          kind: "extrude",
          inputs: [
            { kind: "sketch", id: headSketch },
            { kind: "parameter", id: headParameter },
          ],
          outputs: [headBody],
        },
      ],
      "chain head feature",
    );
    let upstream: FeatureId = headFeature;
    for (let n = 1; n < GROWN_CHAIN_FEATURES; n += 1) {
      const suffix = String(n);
      const sketchId = createSketchDocumentId(`skd_chain_${suffix}`);
      const parameterId = createParameterId(`param_chain_${suffix}`);
      const bodyId = createBodyId(`body_chain_${suffix}`);
      const featureId = createFeatureId(`feat_chain_${suffix}`);
      session = commit(
        session,
        [
          {
            type: "sketch.create",
            id: sketchId,
            name: `chain sketch ${suffix}`,
            sketch: {},
          },
          {
            type: "parameter.create",
            id: parameterId,
            name: `chainDepth${suffix}`,
            value: length(5, "mm"),
          },
          { type: "body.create", id: bodyId, name: `chain ${suffix}` },
          {
            type: "feature.create",
            id: featureId,
            kind: "extrude",
            inputs: [
              { kind: "feature", id: upstream },
              { kind: "sketch", id: sketchId },
              { kind: "parameter", id: parameterId },
            ],
            outputs: [bodyId],
          },
        ],
        `chain feature ${suffix}`,
      );
      upstream = featureId;
    }
    let cursor: RegenerationCursor = {
      document: session.document,
      states: initialRegenerationStates(session.document.features),
      results: new Map(),
    };
    cursor = runDerivationPass(cursor, session.document);
    for (let i = 0; i < INVALIDATION_SAMPLE_COUNT; i += 1) {
      session = commitCommand(
        session,
        {
          type: "parameter.set",
          id: headParameter,
          value: length(5 + (i % 4) * 0.5, "mm"),
        },
        "chain head edit",
      );
      const started = performance.now();
      cursor = runDerivationPass(cursor, session.document);
      grownSamples.push(performance.now() - started);
    }
  }

  return {
    "invalidation.parameterEdit.transactionMs": transactionSamples,
    "invalidation.featureParamEdit.diffMarkRegenerateMs": editSamples,
    "invalidation.grownDoc.diffMarkRegenerateMs": grownSamples,
  };
}

/**
 * Runs every in-page measurement phase and returns the published surface.
 * The scene-level metrics (dispatch → settle, applied → frame) live in the
 * fixture page, which owns the coordinator session and the scene.
 */
export async function runInPageMeasurements(): Promise<InPageMeasurements> {
  const startup = await probeStartup();
  const operations = await probeOperations();
  const projection = probeProjection(operations.tessellation);
  const transfer = probeTransfer(operations.wireResponse);
  const invalidation = probeInvalidation();
  const combined: Record<string, number[]> = {
    ...startup,
    ...operations.samples,
    ...projection,
    ...transfer,
    ...invalidation,
  };
  const frozen: Record<string, readonly number[]> = {};
  for (const [key, values] of Object.entries(combined)) {
    frozen[key] = Object.freeze([...values]);
  }
  return {
    environment: readEnvironment(),
    geometry: {
      triangles: operations.tessellation.indices.length / 3,
      positions: operations.tessellation.positions.length,
      indices: operations.tessellation.indices.length,
      normals: operations.tessellation.normals !== undefined,
      wireJsonBytes: JSON.stringify(operations.wireResponse).length,
    },
    samples: Object.freeze(frozen),
  };
}
