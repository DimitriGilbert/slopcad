/**
 * Public entry of `@slopcad/sim-optimization` (Phase 70a of ROADMAP-SIM,
 * the finale): the NSGA-II optimization engine over the simulation spine.
 *
 * Runtime dependencies (stated per the roadmap §4 rules): `@slopcad/sim-core`
 * (the spine — engine contract, compile boundary, result model, store,
 * worker vocabulary) and `@slopcad/cad-core` (the document parameter and
 * expression machinery plus the SimStudy record — the genome's address
 * space and the constraint surface; pure data, no React, no solver). This
 * package is a batch-spine DRIVER, not a solver package: it never imports
 * another sim solver, a renderer, or the app.
 *
 * ## The staircase caveat (law-adjacent guidance, stated not hidden)
 *
 * The voxel staircase quantizes every geometry-derived objective into
 * plateaus and jumps: candidates whose geometry voxelizes identically
 * score identically, and one extra occupied cell row steps all geometry
 * objectives at once. Two mitigations are committed and named:
 *
 * - **Resolution ladders per study** — re-run the champion at finer
 *   `resolutionMm` rungs of the scenario record and compare; a champion
 *   that survives the ladder is trustworthy, one that reshuffles was a
 *   staircase artifact.
 * - **Multi-seed campaigns** — the same study at several seeds (the
 *   campaign family id encodes the seed); agreement across seeds is the
 *   trust signal, disagreement is the plateau talking.
 *
 * Distance-field-smoothed objectives arrive only with a future cut-cell
 * phase; until then the staircase is part of the accuracy band, stated
 * here and in the study record's own docs.
 */

export {
  type SimOptimizationRandom,
  createSimOptimizationRandom,
} from "./random";
export {
  type AuthoredGenome,
  type DiscreteGeneSpec,
  type GenomeSlots,
  type NumericGeneSpec,
  type OptimizationGeneSpec,
  authoredGenomeKey,
  clampSlot,
  decodeGenome,
  decodeNumericSlot,
  encodeNumericSlot,
  numericGeneLevels,
} from "./genome";
export {
  type Nsga2CandidateRecord,
  type Nsga2Evaluation,
  type Nsga2Evaluator,
  type Nsga2GenerationRecord,
  type Nsga2RunCallbacks,
  type Nsga2RunResult,
  type Nsga2Spec,
  NSGA2_INVALID_OBJECTIVE_CODE,
  NSGA2_MUTATION_ETA,
  NSGA2_SBX_ETA,
  SimOptimizationAbortedError,
  runNsga2,
} from "./nsga2";
export {
  type SimOptimizationCandidateEvaluation,
  type SimOptimizationGeometry,
  type SimOptimizationGeometryProvider,
  type SimOptimizationHostServices,
  type SimOptimizationRunContext,
  type SimOptimizationRunOutcome,
  buildSimOptimizationRunContext,
  evaluateAuthoredGenome,
  runSimOptimization,
  simCampaignFamilyId,
  studyGeneSpecs,
} from "./evaluate";
export {
  type SimOptimizationExecutorOptions,
  createSimOptimizationExecutor,
} from "./executor";
export {
  type SimCampaignFamily,
  type SimCampaignSelection,
  type SimCampaignSelectionEntry,
  type SimParetoCsvColumns,
  authoredGenomeFromAssignments,
  exportSimParetoCsv,
  groupSimCampaignFamilies,
  persistSimCampaign,
  replaySimCandidate,
  selectSimCampaignCandidates,
} from "./campaign";
