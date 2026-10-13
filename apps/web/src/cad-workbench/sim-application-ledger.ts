/**
 * The sim committed-application ledger (Phase 61d, law S6): the bridge a
 * workbench engine applies streaming sim notifications through — the
 * `renderedFrames` discipline (`workbench-engine.tsx`) and the
 * `SettleLedger` precedent (`cad-scene.tsx`) restated for simulation: a
 * stable, created-once ledger object marked ONLY by the application path,
 * and a counter family that increments ONLY when a notification is
 * ACTUALLY applied — never when one merely arrives. An e2e await on the
 * `data-sim-*` attributes the engine stamps from these counters is an
 * await on committed applications, never on arrivals or timeouts.
 *
 * ## When a notification "applies"
 *
 * - **Progress** — the step counter strictly advances the applied
 *   high-water step. Engines emit monotone steps; a duplicate or
 *   retrograde step is a re-announcement, not an application, and commits
 *   nothing.
 * - **Field chunk** — the chunk continues its field's stream contiguously:
 *   chunk 0 (re-)establishes the stream (a new publishing round — the fake
 *   engine's rounds, a real solver's updated field), and a chunk whose
 *   index is exactly the stream's applied count — carrying the same
 *   header (unit, extent, origin, spacing, float width) and chunk count —
 *   extends it. A gap, a duplicate index, a header or chunk-count
 *   disagreement, or a mid-stream restart declines the chunk: it is not
 *   applicable, and the counters must not move for it (the same
 *   gapless-framing law `@slopcad/sim-core`'s reassembler pins).
 *
 * The ledger stores no field VALUES — overlay rendering is Phases 62+63's
 * work; this module is only the committed-application accounting those
 * phases ride.
 */

import type {
  SimEngineFieldChunk,
  SimWorkerNotification,
} from "@slopcad/sim-core";

/**
 * The `data-sim-*` attribute family the engine stamps synchronously with
 * each commit — the e2e await surface (law S6), beside the settle
 * attributes on the same workbench root element.
 */
export const SIM_APPLIED_NOTIFICATIONS_ATTRIBUTE =
  "data-sim-applied-notifications";
/** The applied field-chunk count, stamped with every commit. */
export const SIM_APPLIED_FIELD_CHUNKS_ATTRIBUTE =
  "data-sim-applied-field-chunks";
/** The last applied progress step, stamped from the first progress commit on. */
export const SIM_APPLIED_PROGRESS_STEP_ATTRIBUTE =
  "data-sim-applied-progress-step";
/**
 * The last applied optimization generation (Phase 70a), stamped from the
 * first best-of-generation commit on — the live-preview await surface.
 */
export const SIM_APPLIED_OPTIMIZATION_GENERATION_ATTRIBUTE =
  "data-sim-applied-optimization-generation";

/** The committed counter family — one immutable snapshot per application. */
export interface SimAppliedCounters {
  /** Total notifications applied — every progress and field-chunk application. */
  readonly notifications: number;
  /** The field-chunk notifications among them. */
  readonly fieldChunks: number;
  /** The last applied progress step, or `null` before one applies. */
  readonly progressStep: number | null;
  /** The last applied optimization generation, or `null` before one applies. */
  readonly optimizationGeneration: number | null;
}

/**
 * One field's applied stream state. Purely accounting — the header the
 * stream established, how many of the current round's chunks applied, and
 * how many rounds completed; never the values themselves.
 */
export interface SimAppliedField {
  readonly id: string;
  readonly unit?: string;
  readonly extent: readonly [number, number, number];
  readonly originMm: readonly [number, number, number];
  readonly spacingMm: readonly [number, number, number];
  readonly dataType: "float32" | "float64";
  /** The stream's declared chunk count (fixed per round). */
  readonly chunkCount: number;
  /** The current round's applied chunk count (contiguous from zero). */
  appliedChunks: number;
  /** Completed chunk rounds — full gapless streams this ledger applied. */
  roundsCompleted: number;
}

/**
 * The sim application ledger: the `SettleLedger` shape — a plain mutable
 * object created once per engine mount, marked only by
 * {@link applySimNotification}.
 */
export interface SimApplicationLedger {
  /** Total applied notifications (progress + field chunks). */
  notifications: number;
  /** Applied field chunks. */
  fieldChunks: number;
  /** The applied progress high-water step, or `null` before one applies. */
  progressStep: number | null;
  /** The applied optimization-generation high-water mark, or `null`. */
  optimizationGeneration: number | null;
  /** Per-field applied stream state, keyed by field id. */
  fields: Map<string, SimAppliedField>;
}

/** Creates the boot ledger: zero counters, no applied fields. */
export function createSimApplicationLedger(): SimApplicationLedger {
  return {
    notifications: 0,
    fieldChunks: 0,
    progressStep: null,
    optimizationGeneration: null,
    fields: new Map(),
  };
}

/** Freezes the ledger's current counters into an immutable snapshot. */
export function simAppliedCountersOf(
  ledger: SimApplicationLedger,
): SimAppliedCounters {
  return Object.freeze({
    notifications: ledger.notifications,
    fieldChunks: ledger.fieldChunks,
    progressStep: ledger.progressStep,
    optimizationGeneration: ledger.optimizationGeneration,
  });
}

/** The header every chunk of one stream shares (the reassembler's rule). */
interface SimChunkHeader {
  readonly unit?: string;
  readonly extent: readonly [number, number, number];
  readonly originMm: readonly [number, number, number];
  readonly spacingMm: readonly [number, number, number];
  readonly dataType: "float32" | "float64";
}

/** What a header reads from: a chunk or the ledger's applied field state. */
interface SimChunkHeaderSource {
  readonly unit?: string;
  readonly extent: readonly [number, number, number];
  readonly originMm: readonly [number, number, number];
  readonly spacingMm: readonly [number, number, number];
  readonly dataType: "float32" | "float64";
}

function headerOf(chunk: SimChunkHeaderSource): SimChunkHeader {
  return {
    ...(chunk.unit === undefined ? {} : { unit: chunk.unit }),
    extent: chunk.extent,
    originMm: chunk.originMm,
    spacingMm: chunk.spacingMm,
    dataType: chunk.dataType,
  };
}

function headersEqual(a: SimChunkHeader, b: SimChunkHeader): boolean {
  return (
    a.unit === b.unit &&
    a.dataType === b.dataType &&
    a.extent.every((value, axis) => value === b.extent[axis]) &&
    a.originMm.every((value, axis) => value === b.originMm[axis]) &&
    a.spacingMm.every((value, axis) => value === b.spacingMm[axis])
  );
}

/** Whether a chunk's framing numbers are usable at all. */
function framableChunk(chunk: SimEngineFieldChunk): boolean {
  return (
    Number.isInteger(chunk.chunkCount) &&
    chunk.chunkCount > 0 &&
    Number.isInteger(chunk.chunkIndex) &&
    chunk.chunkIndex >= 0 &&
    chunk.chunkIndex < chunk.chunkCount &&
    chunk.values.length > 0
  );
}

/** Applies one optimization-generation notice: strictly advancing generations apply. */
function applyOptimizationGeneration(
  ledger: SimApplicationLedger,
  generation: number,
): SimAppliedCounters | null {
  if (!Number.isInteger(generation) || generation < 0) return null;
  if (
    ledger.optimizationGeneration !== null &&
    generation <= ledger.optimizationGeneration
  ) {
    return null; // a duplicate or retrograde generation re-announces.
  }
  ledger.optimizationGeneration = generation;
  ledger.notifications += 1;
  return simAppliedCountersOf(ledger);
}

/** Applies one progress notification: strictly advancing steps apply. */
function applyProgress(
  ledger: SimApplicationLedger,
  step: number,
): SimAppliedCounters | null {
  if (!Number.isInteger(step) || step <= 0) return null;
  if (ledger.progressStep !== null && step <= ledger.progressStep) {
    return null; // a duplicate or retrograde step re-announces, applies not.
  }
  ledger.progressStep = step;
  ledger.notifications += 1;
  return simAppliedCountersOf(ledger);
}

/** Applies one field-chunk notification: contiguous same-header streams. */
function applyFieldChunk(
  ledger: SimApplicationLedger,
  chunk: SimEngineFieldChunk,
): SimAppliedCounters | null {
  if (!framableChunk(chunk)) return null;
  const established = ledger.fields.get(chunk.id);
  if (chunk.chunkIndex === 0) {
    // The stream's (re-)establishment: a fresh field, a new publishing
    // round, or a republished header — the newest truth for this field.
    const field: SimAppliedField = {
      id: chunk.id,
      ...(chunk.unit === undefined ? {} : { unit: chunk.unit }),
      extent: chunk.extent,
      originMm: chunk.originMm,
      spacingMm: chunk.spacingMm,
      dataType: chunk.dataType,
      chunkCount: chunk.chunkCount,
      appliedChunks: 1,
      roundsCompleted:
        chunk.chunkCount === 1
          ? (established?.roundsCompleted ?? 0) + 1
          : (established?.roundsCompleted ?? 0),
    };
    ledger.fields.set(chunk.id, field);
    ledger.fieldChunks += 1;
    ledger.notifications += 1;
    return simAppliedCountersOf(ledger);
  }
  if (established === undefined) return null; // mid-stream with no stream.
  if (
    established.chunkCount !== chunk.chunkCount ||
    !headersEqual(headerOf(established), headerOf(chunk))
  ) {
    return null; // a disagreement with the applied stream declines.
  }
  if (chunk.chunkIndex !== established.appliedChunks) {
    return null; // a gap or a duplicate index declines.
  }
  established.appliedChunks += 1;
  if (established.appliedChunks === established.chunkCount) {
    established.roundsCompleted += 1;
  }
  ledger.fieldChunks += 1;
  ledger.notifications += 1;
  return simAppliedCountersOf(ledger);
}

/**
 * Applies one decoded sim notification to the ledger. Returns the
 * committed counters snapshot when the notification APPLIED, or `null`
 * when it did not — the caller must not move any counter for a `null`.
 */
export function applySimNotification(
  ledger: SimApplicationLedger,
  notification: SimWorkerNotification,
): SimAppliedCounters | null {
  if (notification.kind === "progress") {
    return applyProgress(ledger, notification.step);
  }
  if (notification.kind === "optimization-generation") {
    return applyOptimizationGeneration(ledger, notification.generation);
  }
  return applyFieldChunk(ledger, notification);
}
