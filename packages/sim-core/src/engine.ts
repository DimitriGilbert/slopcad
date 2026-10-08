/**
 * The SimEngine contract — PURE TYPES ONLY. This is the provider seam
 * the sim worker vocabulary builds on next (the `GeometryKernel` +
 * `fake-kernel` precedent): every solver domain ships an own
 * deterministic TypeScript reference kernel (the oracle, law S2/S5) and
 * high-performance implementations (WGSL compute, MuJoCo) are providers
 * behind THIS interface. No implementation lives in sim-core — the
 * package is data and contracts, never a solver.
 *
 * The contract's semantics: an engine declares the scenario kinds it can
 * solve (a kind it does not list declines with
 * `sim/scenario-kind-unsupported` — the `structural` carve until Phase
 * 69); it consumes a scenario the S4 boundary already compiled into
 * solver space; and it produces a {@link SimResult} whose summary
 * carries the compile-time regime report and scenario-snapshot hash, so
 * provenance survives the provider seam. A GPU-preferring engine on a
 * GPU-less host declines with `sim/backend-unavailable` unless it also
 * carries the CPU oracle.
 */

import type { SimError } from "./errors";
import type { SimParseResult } from "./result";
import type { SimResult } from "./sim-result";
import type { CompiledSimScenario } from "./units";
import type { SimScenarioKind } from "./vocabulary";

/** What an engine run consumes: the compiled scenario, nothing document-space. */
export interface SimEngineRequest {
  /** The scenario in solver space (output of the S4 compile boundary). */
  readonly compiled: CompiledSimScenario;
}

/** Progress notification an engine may emit between steps (data only). */
export interface SimEngineProgress {
  /** The engine's own step counter (monotone within one run). */
  readonly step: number;
  /** The engine's own total step budget, when it knows one. */
  readonly totalSteps?: number;
}

/**
 * One field-chunk emission between steps (the Phase 61b streaming seam): a
 * slice of a DOCUMENT-SPACE {@link SimResultFieldBlock} — the same header
 * fields, the same x-fastest value order, the same float width — so the
 * chunk stream a run publishes reassembles losslessly into exactly the
 * block the finalized result carries. This is the streaming shape Phase 63
 * publishes and the workbench applies as committed applications per law S6;
 * chunk framing (gapless indices, one header across a field's chunks) is
 * pinned by `./sim-field-chunks`' reassembler.
 */
export interface SimEngineFieldChunk {
  /** The field's id — the block id the finalized result will carry. */
  readonly id: string;
  /** The values' unit label (e.g. "mm/s"); absent = dimensionless. */
  readonly unit?: string;
  readonly extent: readonly [number, number, number];
  readonly originMm: readonly [number, number, number];
  readonly spacingMm: readonly [number, number, number];
  readonly dataType: "float32" | "float64";
  /** Zero-based index within the field's chunk stream. */
  readonly chunkIndex: number;
  /** The field's total chunk count (fixed for one run). */
  readonly chunkCount: number;
  /**
   * This chunk's slice of the field's values, x-fastest within the slice.
   * The concatenated slices across all chunks are the block's full values.
   */
  readonly values: readonly number[];
}

/**
 * One solver domain behind the provider seam. `run` is async because
 * real engines ride a worker; it is still deterministic — the same
 * request produces the same result (the CPU oracle's bitwise claim, law
 * S2), and a provider that cannot honor determinism says so in its own
 * documentation, never silently.
 *
 * The optional callbacks are the streaming seam (Phase 61b). `onProgress`
 * receives step-count progress; `onFieldChunk` receives the field-chunk
 * stream. Both are best-effort emission channels, never outcomes — the
 * run's single terminal value is still the returned {@link SimResult}. A
 * hosting wrapper MAY throw from either callback to deliver cooperative
 * cancellation (the worker server's abort sentinel): a conforming engine
 * does not catch callback throws, so the abort unwinds the run; an engine
 * that ignores the callbacks runs to completion and its outcome is
 * suppressed by the host instead (the pinned best-effort cancellation
 * rule, `./sim-worker-cancellation`).
 */
export interface SimEngine {
  /** The engine's stable id (e.g. "lbm-cpu-reference"). */
  readonly id: string;
  /** The scenario kinds this engine can solve; anything else declines. */
  readonly supportedKinds: readonly SimScenarioKind[];
  /** The engine's backend: the CPU oracle or a GPU provider. */
  readonly backend: "cpu" | "gpu";
  run(
    request: SimEngineRequest,
    onProgress?: (progress: SimEngineProgress) => void,
    onFieldChunk?: (chunk: SimEngineFieldChunk) => void,
  ): Promise<SimParseResult<SimResult, SimError>>;
}
