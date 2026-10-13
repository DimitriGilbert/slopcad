/**
 * The `sim/*` structured-decline family (ROADMAP-SIM's ADR consequence:
 * "Simulation failure modes join the structured-decline family (`sim/*`
 * codes): an unsupported scenario is a loud decline, never a fake
 * result"). Every sim-core boundary — compile, projection, fluid
 * evaluation, payload decode, export, the Phase 61b `sim.*` worker
 * vocabulary's session addressing, and the Phase 62a voxelizer's mesh,
 * domain, and grid-semantics doors — refuses with one of these codes,
 * in the exact discipline the document (`document/*`), configuration
 * (`configuration/*`), and kernel (`kernel/*`) families established.
 */

import type { SimParseFailure } from "./result";

/** Stable failure codes produced by the sim-core boundaries. */
export const SIM_ERROR_CODES = {
  /** A serialized scenario did not structurally parse at the compile door. */
  scenarioInvalid: "sim/scenario-invalid",
  /**
   * The scenario kind is a valid record but no engine on this host
   * solves it (`structural` is live through its own engine — the
   * decline stays for genuinely unsupported kinds: loud, and the
   * run never fabricates a result).
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
   * A run's numerics diverged (NaN/negative density — the reference
   * kernel's divergence sentinel): the run froze at its last valid step
   * and persists as a FAILED result carrying this code, never as a
   * fabricated completed one (Phase 63b's persistence-honesty carve,
   * defined now so the code vocabulary never reworks).
   */
  runDiverged: "sim/run-diverged",
  /**
   * An owned iterative solver exhausted its iteration discipline without
   * reaching its residual tolerance (Phase 65a's preconditioned-CG
   * conduction solve, defined on the pre-date precedent of
   * `operatingPointAmbiguous`): the iteration cap is a loud decline
   * naming the residual it froze at, never a fabricated converged
   * result.
   */
  solverUnconverged: "sim/solver-unconverged",
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
  /**
   * The voxelizer's mesh door refused its tessellation (Phase 62a, law
   * S3): not a plain indexed triangle soup, a shape violation (lengths
   * not divisible by 3, indices out of vertex range, non-finite
   * coordinates, normals disagreement), or an empty/degenerate soup —
   * zero triangles bound no solid, and the voxelizer declines loudly
   * rather than emitting a fabricated all-empty grid.
   */
  tessellationInvalid: "sim/tessellation-invalid",
  /**
   * A scenario requested a boundary treatment no solver implements
   * (Phase 66c, the cut-cell decision): the record vocabulary reserves
   * `cut-cell` beside the implemented `staircase`, and the compile
   * boundary declines it loudly — pointing at the recorded raise-or-
   * decline verdict — instead of silently accepting the staircase. The
   * `scenarioKindUnsupported` discipline applied to law S3's geometry
   * half.
   */
  boundaryTreatmentUnsupported: "sim/boundary-treatment-unsupported",
  /**
   * The voxelizer's domain door refused (Phase 62a): a non-positive
   * resolution, an explicit box whose max corner does not exceed its min
   * corner, a negative body margin, a malformed slice plane, or a
   * resolution that would exceed the grid sample budget.
   */
  voxelDomainInvalid: "sim/voxel-domain-invalid",
  /**
   * The grid↔field-block bridge refused (Phase 62a): a field id that
   * carries no grid-semantic suffix, a unit that disagrees with the
   * declared semantics, non-binary occupancy values, malformed grid
   * geometry, or a grid name outside the block id budget — the
   * `result-payload-malformed` discipline extended to grid semantics.
   */
  gridFieldMalformed: "sim/grid-field-malformed",
  /**
   * The Phase 67 dynamics build door refused the mechanism (defined
   * 67a, pre-dated on the `operatingPointAmbiguous` precedent): a
   * malformed occurrence/mass/joint wire form, an occurrence without
   * mass properties, a joint addressing an unknown occurrence, a motor
   * riding a joint with no single rotational drive DOF, or a topology
   * the reference kernel declines (disconnected grounded fragments
   * beyond the forest stance) — a loud decline, never a guessed model.
   */
  mechanismInvalid: "sim/mechanism-invalid",
  /**
   * A mechanism's closed loop could not close (Phase 67a): the loop
   * projection exhausted its Levenberg–Marquardt discipline above the
   * closure tolerance — the run declines naming the residual it froze
   * at, never fabricates a snapped mechanism.
   */
  loopUnresolved: "sim/loop-unresolved",
  /**
   * A combustion surface was asked for a mode outside the premixed
   * line (Phase 68b, §6 of ROADMAP-SIM): spray / non-premixed /
   * mixing-controlled (diesel-class) combustion is declined at every
   * level — the 0D reactor, the flame-speed grounding, the engine
   * cycle, and every sweep — never approximated with a fitted burn
   * curve. Defined at the spine so the code vocabulary never reworks.
   */
  combustionModeUnsupported: "sim/combustion-mode-unsupported",
  /**
   * Phase 70a: a serialized optimization study (or its document context)
   * did not parse at the optimization door — the record, the parameter
   * table, or a referenced record is malformed. The run never starts.
   */
  studyInvalid: "sim/study-invalid",
  /**
   * Phase 70a: a candidate's genome violates the study's constraint
   * expressions (or the redrive could not evaluate them) — the
   * structured decline the engine counts as dominated/penalized, never
   * a crash.
   */
  optimizationConstraintViolated: "sim/optimization-constraint-violated",
  /** Phase 70a: the redrive of a candidate's parameter table left
   *  expression-driven values stale (an evaluation failure at the new
   *  literals) — the candidate declines, never fabricates values. */
  optimizationRedriveFailed: "sim/optimization-redrive-failed",
  /**
   * Phase 70a: a candidate solved but its result summary carries no
   * (or a non-finite) quantity for a study objective — the objective
   * selection and the engine's projection disagree, and the candidate
   * declines loudly instead of scoring a guessed number.
   */
  optimizationObjectiveMissing: "sim/optimization-objective-missing",
  /**
   * Phase 70a: a `sim.optimize` request reached a worker that hosts no
   * optimization executor (the engine-side seam is an injection, never
   * an assumption) — a loud decline, never a fabricated campaign.
   */
  optimizerUnavailable: "sim/optimizer-unavailable",
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
