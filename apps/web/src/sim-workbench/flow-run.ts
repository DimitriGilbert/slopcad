/**
 * The workbench's flow-run controller (Phase 63c): the pure orchestration
 * that turns one saved scenario record into a persisted run — `sim.compile`
 * (the scenario and the document's merged tessellation across the wire,
 * the geometry-aware compile inside the worker), `sim.run` (the streamed
 * notification class applied through the Phase 61d committed-application
 * ledger, law S6), `sim.finalize` (the persisted form's bytes decoded
 * back into a {@link SimResult}), and the SimResultStore `put` (law S7,
 * keyed by the scenario-snapshot hash the summary carries). No React, no
 * DOM — the page wires the events; the tests drive it over the in-memory
 * transport pair against the in-memory storage seam.
 *
 * The preview chunks a run publishes ride the SAME application door the
 * workbench engine's sim client rides: every notification applies through
 * {@link applySimNotification}, the counters move only on committed
 * applications, and each COMPLETED chunk round reassembles into the
 * document-space block the overlays render — overlay application IS
 * committed application, exactly as the Phase 62 fixture established.
 */

import type {
  SimAppliedCounters,
  SimApplicationLedger,
} from "../cad-workbench/sim-application-ledger";
import type {
  SimEngineFieldChunk,
  SimResult,
  SimResultFieldBlock,
  SimResultRunRecord,
  SimResultStore,
  SimWorkerClient,
} from "@slopcad/sim-core";
import type { Tessellation } from "@slopcad/cad-kernel";
import {
  SimRequestFailure,
  decodeSimResultPayload,
  reassembleSimFieldChunks,
} from "@slopcad/sim-core";

import { applySimNotification } from "../cad-workbench/sim-application-ledger";

/** The run's user-visible phases, in order. */
export type FlowRunPhase =
  | "compiling"
  | "running"
  | "finalizing"
  | "persisting"
  | "completed"
  | "failed";

/** One committed application, with the round's reassembled block when one completed. */
export interface FlowRunAppliedEvent {
  readonly counters: SimAppliedCounters;
  /** The completed round's document-space block, when the application completed a round. */
  readonly block: SimResultFieldBlock | null;
}

/** The controller's event surface (all optional; the page wires what it shows). */
export interface FlowRunEvents {
  onPhase?: (phase: FlowRunPhase, detail: string) => void;
  onApplied?: (event: FlowRunAppliedEvent) => void;
}

/** The completed run: the persisted record plus the full decoded result. */
export interface FlowRunOutcome {
  readonly record: SimResultRunRecord;
  readonly result: SimResult;
}

/** A run's structured failure: the wire code (or store code), and its message. */
export class FlowRunFailure extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "FlowRunFailure";
    this.code = code;
  }
}

/**
 * The per-field round assembler: chunks of one field's stream group into
 * rounds (a round starts at chunk index 0 and completes at the declared
 * count), and a completed round reassembles through the 61b lossless
 * reassembler — the same law the ledger's contiguity applies.
 */
class SimFieldRoundAssembler {
  private readonly rounds = new Map<string, SimEngineFieldChunk[]>();

  constructor(private readonly onRound: (block: SimResultFieldBlock) => void) {}

  feed(chunk: SimEngineFieldChunk): void {
    if (chunk.chunkIndex === 0) {
      this.rounds.set(chunk.id, [chunk]);
    } else {
      const current = this.rounds.get(chunk.id);
      if (current === undefined) return; // mid-stream with no stream.
      current.push(chunk);
    }
    if (chunk.chunkIndex + 1 === chunk.chunkCount) {
      const round = this.rounds.get(chunk.id);
      this.rounds.delete(chunk.id);
      if (round === undefined) return;
      const reassembled = reassembleSimFieldChunks(round);
      if (reassembled.ok) {
        this.onRound(reassembled.value);
      }
    }
  }
}

/** Options of {@link runFlowScenario}. */
export interface FlowRunOptions {
  /** The booted sim worker channel's client (the real routed engine). */
  readonly client: SimWorkerClient;
  /** The scenario record's canonical serialized JSON (document space). */
  readonly scenario: unknown;
  /**
   * The document's merged tessellation (the voxelizer's wire shape).
   * Absent on a geometry-less run — the flow engine declines those
   * loudly (`sim/geometry-unavailable`), never fabricates a tunnel.
   */
  readonly tessellation?: Tessellation;
  /**
   * Phase 65c (the thermal runs ride the same controller): the
   * serialized material records the scenario's assignments reference,
   * and the referenced bodies' OWN tessellations (one per body — the
   * per-cell material map needs per-body geometry). Both cross the
   * `sim.compile` wire verbatim; the thermal compile door consumes them.
   */
  readonly materials?: readonly unknown[];
  readonly bodyTessellations?: readonly {
    readonly bodyId: string;
    readonly tessellation: Tessellation;
  }[];
  /**
   * Phase 66c (the fan runs ride the same controller): the serialized
   * motor record the scenario's selection references — across the
   * `sim.compile` wire verbatim, the compile door's own `motor` seam.
   */
  readonly motor?: unknown;
  /** The run persists against this document version id. */
  readonly documentVersionId: string;
  /** The law-S7 store the completed run persists through. */
  readonly store: SimResultStore;
  /** The Phase 61d ledger the notifications apply through (law S6). */
  readonly ledger: SimApplicationLedger;
  readonly events?: FlowRunEvents;
}

function wireFailure(error: unknown): FlowRunFailure {
  if (error instanceof SimRequestFailure) {
    const simCode =
      typeof error.error.data?.simCode === "string"
        ? error.error.data.simCode
        : error.error.code;
    return new FlowRunFailure(simCode, error.error.message);
  }
  const detail = error instanceof Error ? error.message : String(error);
  return new FlowRunFailure("sim/run-failed", detail);
}

/**
 * Runs one scenario to a persisted result: compile → stream → finalize →
 * put. Every notification the run emits applies through the ledger
 * BEFORE anything renders (the committed-application law), and the store
 * receives the same decoded result the finalize bytes carried.
 */
export async function runFlowScenario(
  options: FlowRunOptions,
): Promise<FlowRunOutcome> {
  const { client, ledger, events } = options;
  const phase = (step: FlowRunPhase, detail = ""): void => {
    events?.onPhase?.(step, detail);
  };
  // The round assembler's completion lands on the chunk event that
  // closed the round — only that event carries the block (a sticky
  // "last block" would repaint progress events as overlay updates).
  let completedBlock: SimResultFieldBlock | null = null;
  const assembler = new SimFieldRoundAssembler((block) => {
    completedBlock = block;
  });
  const unsubscribe = client.onNotification((delivery) => {
    const committed = applySimNotification(ledger, delivery.notification);
    if (committed === null) return;
    let block: SimResultFieldBlock | null = null;
    if (delivery.notification.kind === "field-chunk") {
      assembler.feed(delivery.notification);
      block = completedBlock;
      completedBlock = null;
    }
    events?.onApplied?.({ counters: committed, block });
  });
  try {
    phase("compiling");
    let compiled;
    try {
      compiled = await client.request("sim.compile", {
        scenario: options.scenario,
        ...(options.tessellation === undefined
          ? {}
          : { tessellation: options.tessellation }),
        ...(options.materials === undefined
          ? {}
          : { materials: options.materials }),
        ...(options.bodyTessellations === undefined
          ? {}
          : { bodyTessellations: options.bodyTessellations }),
        ...(options.motor === undefined ? {} : { motor: options.motor }),
      });
    } catch (error) {
      throw wireFailure(error);
    }
    phase("running");
    let runResult;
    try {
      runResult = await client.request("sim.run", {
        problem: compiled.problem,
      });
    } catch (error) {
      throw wireFailure(error);
    }
    phase("finalizing");
    let finalized;
    try {
      finalized = await client.request("sim.finalize", {
        run: runResult.run,
      });
    } catch (error) {
      throw wireFailure(error);
    }
    const fields = decodeSimResultPayload(finalized.payload);
    if (!fields.ok) {
      throw new FlowRunFailure(
        "sim/result-payload-malformed",
        fields.error.message,
      );
    }
    const result: SimResult = {
      summary: finalized.summary,
      fields: fields.value,
      histories: finalized.histories,
    };
    phase("persisting");
    let record;
    try {
      const put = await options.store.put(options.documentVersionId, result);
      if (!put.ok) {
        throw new FlowRunFailure(put.error.code, put.error.message);
      }
      record = put.value;
    } catch (error) {
      if (error instanceof FlowRunFailure) throw error;
      throw wireFailure(error);
    }
    phase("completed");
    return { record, result };
  } catch (error) {
    const failure =
      error instanceof FlowRunFailure ? error : wireFailure(error);
    phase("failed", failure.message);
    throw failure;
  } finally {
    unsubscribe();
  }
}
