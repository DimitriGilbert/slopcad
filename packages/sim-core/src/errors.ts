/**
 * The `sim/*` structured-decline family (ROADMAP-SIM's ADR consequence:
 * "Simulation failure modes join the structured-decline family (`sim/*`
 * codes): an unsupported scenario is a loud decline, never a fake
 * result"). Every sim-core boundary — compile, projection, fluid
 * evaluation, payload decode, export, and the Phase 61b `sim.*` worker
 * vocabulary's session addressing — refuses with one of these codes,
 * in the exact discipline the document (`document/*`), configuration
 * (`configuration/*`), and kernel (`kernel/*`) families established.
 */

import type { SimParseFailure } from "./result";

/** Stable failure codes produced by the sim-core boundaries. */
export const SIM_ERROR_CODES = {
  /** A serialized scenario did not structurally parse at the compile door. */
  scenarioInvalid: "sim/scenario-invalid",
  /**
   * The scenario kind is a valid record but no solver for it exists yet —
   * `structural` until Phase 69 lands (the vocabulary is carved now, the
   * decline is loud, and the run never fabricates a result).
   */
  scenarioKindUnsupported: "sim/scenario-kind-unsupported",
  /** The scenario's fluid names no record of the starter fluid property set. */
  fluidUnknown: "sim/fluid-unknown",
  /** A fluid property was requested outside the record's stated valid range. */
  fluidTemperatureOutOfRange: "sim/fluid-temperature-out-of-range",
  /** A body-derived domain (or regime characteristic length) needs geometry
   *  measurements the caller did not supply. */
  geometryUnavailable: "sim/geometry-unavailable",
  /** A motor record did not structurally parse or does not match the selection. */
  motorInvalid: "sim/motor-invalid",
  /** A projected or exported quantity is non-finite or dimensionally malformed. */
  quantityInvalid: "sim/quantity-invalid",
  /** The binary result payload did not decode (bad magic, version, or shape). */
  resultPayloadMalformed: "sim/result-payload-malformed",
  /** A snapshot hash was requested over content that cannot canonicalize. */
  snapshotInvalid: "sim/snapshot-invalid",
  /**
   * Phase 66's named carve: a motor/fan pairing whose operating point is
   * genuinely ambiguous (no stable intersection) declines rather than
   * guessing. Defined now so the code vocabulary never reworks.
   */
  operatingPointAmbiguous: "sim/operating-point-ambiguous",
  /** The requested backend has no provider on this host (the CPU oracle
   *  always exists; a GPU-less host running a `gpu`-preferred scenario
   *  with no fallback declines loudly). */
  backendUnavailable: "sim/backend-unavailable",
  /**
   * The worker session does not know the referenced compiled problem
   * (Phase 61b): `sim.run` addressed a problem id this session never
   * minted, or one from a dead channel.
   */
  problemUnknown: "sim/problem-unknown",
  /**
   * The worker session does not know the referenced completed run
   * (Phase 61b): `sim.finalize` addressed a run id this session never
   * minted, or one whose run failed or was cancelled (nothing finalized).
   */
  runUnknown: "sim/run-unknown",
  /**
   * A field-chunk stream did not reassemble (Phase 61b): gap, duplicate,
   * header disagreement, or value-count mismatch across a field's chunks.
   */
  fieldChunksInvalid: "sim/field-chunks-invalid",
  /**
   * A persisted run did not parse against the result model (Phase 61c):
   * summary, histories, run record, or the run/payload pairing is
   * malformed — a store boundary refuses it instead of guessing, the
   * `result-payload-malformed` discipline extended to the whole record.
   */
  resultRecordMalformed: "sim/result-record-malformed",
  /**
   * A SimResultStore backend call itself failed (Phase 61c, law S7): the
   * transport threw — a refused request, an unreachable server, a storage
   * error. The store surfaces the failure, never a fabricated run.
   */
  storeUnavailable: "sim/store-unavailable",
} as const;

export type SimErrorCode =
  (typeof SIM_ERROR_CODES)[keyof typeof SIM_ERROR_CODES];

/** Structured failure describing why a sim-core boundary refused. */
export interface SimError extends SimParseFailure {
  readonly code: SimErrorCode;
}

/** Builds a {@link SimError}. */
export function simError(
  code: SimErrorCode,
  message: string,
  input: unknown,
): SimError {
  return { code, message, input };
}
