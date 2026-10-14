/**
 * The NSGA-II engine (Phase 70a, the committed algorithm): pure
 * TypeScript, ZERO runtime dependencies, bitwise deterministic given the
 * seed — the whole loop is a pure function of (spec, evaluator behavior,
 * draw order) with a single owned PRNG stream (`./random`), explicit-key
 * sorts (never locale or Map-iteration luck), and structural declines in
 * place of crashes.
 *
 * ## The owned operators (pinned, deliberately simple)
 *
 * - **Fast non-dominated sort** — Deb 2002's front assignment, O(M·N²),
 *   with the decline pin: a declined candidate is dominated by EVERY
 *   feasible candidate and dominates NOTHING (declined vs declined never
 *   dominates), so refusals sink to the last front — dominated/penalized,
 *   never a crash.
 * - **Crowding distance** — the standard per-front boundary-infinite
 *   measure over RAW objective values (direction-normalized internally);
 *   declined members carry 0 (no diversity information exists for them)
 *   and order deterministically by their evaluation index.
 * - **Selection** — binary tournament on (rank asc, crowding desc,
 *   evaluation index asc); every tie breaks deterministically.
 * - **Crossover** — simulated binary crossover (SBX) with distribution
 *   index η = {@link NSGA2_SBX_ETA} (15) on the unit slots, applied per
 *   mating with probability `crossoverRate`; discrete slots cross over by
 *   uniform parental choice — NEVER interpolation (the enumeration
 *   honesty pin). With probability `1 − crossoverRate` the children are
 *   parental copies (still subject to mutation).
 * - **Mutation** — polynomial mutation with distribution index
 *   η = {@link NSGA2_MUTATION_ETA} (20), per numeric slot with
 *   probability `mutationRate / numericSlotCount` (the study field scales
 *   the expected per-genome mutations; Deb's 1/n is the rate-1 case),
 *   clamped to [0, 1] (the boundary handling); a discrete slot hit by
 *   mutation re-picks its choice uniformly.
 *
 * ## Determinism and budget
 *
 * Identical spec + identical evaluator outcomes ⇒ identical results, bit
 * for bit. The evaluation budget counts DISTINCT canonical genomes (the
 * cache keys come from the caller-supplied canonicalizer — the authored
 * genome — so plateau duplicates cost nothing); when the budget exhausts
 * mid-generation the loop terminates early (the roadmap's
 * early-terminated-generations mitigation), logging the generations that
 * settled. Cancellation rides the `shouldAbort` poll: the engine throws
 * {@link SimOptimizationAbortedError} and owns no state a fresh run of
 * the same seed would not reproduce (determinism across pause/restart).
 *
 * Single-objective is the degenerate case: one objective makes the sort a
 * plain fitness ranking and the crowding distance degenerate — the same
 * code path, a plain GA, exactly as the roadmap commits.
 */

import {
  type AuthoredGenome,
  type GenomeSlots,
  type OptimizationGeneSpec,
  authoredGenomeKey,
  clampSlot,
  decodeGenome,
} from "./genome";
import {
  type SimOptimizationRandom,
  createSimOptimizationRandom,
} from "./random";

/** The SBX distribution index (the pinned operator constant). */
export const NSGA2_SBX_ETA = 15;

/** The polynomial-mutation distribution index (the pinned operator constant). */
export const NSGA2_MUTATION_ETA = 20;

/** The decline code a non-finite objective vector maps to (never a score). */
export const NSGA2_INVALID_OBJECTIVE_CODE = "sim/quantity-invalid";

/** One candidate evaluation: the objective vector, or the decline code. */
export type Nsga2Evaluation =
  | { readonly status: "ok"; readonly objectives: readonly number[] }
  | { readonly status: "declined"; readonly code: string };

/** The async evaluation seam the driver injects (solve → extract). */
export type Nsga2Evaluator = (
  genome: AuthoredGenome,
) => Promise<Nsga2Evaluation>;

/** The engine's knobs — the study record's algorithm/budget fields. */
export interface Nsga2Spec {
  readonly genes: readonly OptimizationGeneSpec[];
  /** The RAW objective directions (the engine negates maximize internally). */
  readonly directions: readonly ("minimize" | "maximize")[];
  readonly population: number;
  readonly generations: number;
  readonly mutationRate: number;
  readonly crossoverRate: number;
  readonly seed: number;
  readonly maxEvaluations: number;
}

/** Progress/emission callbacks; every one is optional and best-effort. */
export interface Nsga2RunCallbacks {
  /** Called after each distinct evaluation settles, with the cumulative count. */
  onEvaluation?(total: number): void;
  /** Called after each generation settles, with the full surviving population. */
  onGeneration?(record: Nsga2GenerationRecord): void;
  /** The cancellation poll, checked between candidates and generations. */
  shouldAbort?(): boolean;
}

/** One logged candidate: its evaluation identity and outcome. */
export interface Nsga2CandidateRecord {
  /** The evaluation index (distinct-candidate counter) that produced this outcome. */
  readonly index: number;
  readonly slots: GenomeSlots;
  readonly status: "ok" | "declined";
  readonly objectives: readonly number[];
  readonly declineCode?: string;
  /** The front the candidate landed in within its generation's population. */
  readonly rank: number;
}

/** One generation's log: the full surviving population, ordered. */
export interface Nsga2GenerationRecord {
  readonly generation: number;
  /** Cumulative distinct evaluations after this generation settled. */
  readonly evaluations: number;
  readonly candidates: readonly Nsga2CandidateRecord[];
}

/** The complete run log. */
export interface Nsga2RunResult {
  readonly generations: readonly Nsga2GenerationRecord[];
  /** Distinct evaluations spent (cache hits excluded). */
  readonly evaluations: number;
  /** Distinct evaluations that declined. */
  readonly declined: number;
  /** The final population, ordered (rank asc, crowding desc, index asc). */
  readonly population: readonly Nsga2CandidateRecord[];
  /** The final population's feasible non-dominated set (rank 0, status ok). */
  readonly pareto: readonly Nsga2CandidateRecord[];
}

/**
 * Thrown when `shouldAbort` turns true: the engine owns no persistent
 * state — a fresh run of the same spec reproduces the identical prefix,
 * so cancellation is pause, never corruption.
 */
export class SimOptimizationAbortedError extends Error {
  constructor() {
    super(
      "The optimization run was aborted between candidates; no outcome is emitted and a fresh run of the same seed reproduces the identical prefix.",
    );
    this.name = "SimOptimizationAbortedError";
  }
}

interface Individual {
  readonly slots: number[];
  readonly key: string;
  index: number;
  outcome: Nsga2Evaluation;
  rank: number;
  crowding: number;
}

function pollAbort(callbacks: Nsga2RunCallbacks): void {
  if (callbacks.shouldAbort?.()) throw new SimOptimizationAbortedError();
}

/** Normalizes an objective vector for comparison: maximize negates. */
function comparisonObjectives(
  raw: readonly number[],
  directions: readonly ("minimize" | "maximize")[],
): number[] {
  return raw.map((value, index) =>
    (directions[index] ?? "minimize") === "maximize" ? -value : value,
  );
}

/**
 * The domination rule with the decline pin: feasible dominates declined,
 * declined dominates nothing, and among feasible the standard weak
 * Pareto rule (no worse anywhere, strictly better somewhere). Equal
 * vectors dominate nothing (standard — diversity keeps them apart).
 */
function dominates(
  left: { readonly ok: boolean; readonly values: readonly number[] },
  right: { readonly ok: boolean; readonly values: readonly number[] },
): boolean {
  if (!left.ok) return false;
  if (!right.ok) return true;
  let strictlyBetter = false;
  for (let index = 0; index < left.values.length; index += 1) {
    const a = left.values[index] ?? 0;
    const b = right.values[index] ?? 0;
    if (a > b) return false;
    if (a < b) strictlyBetter = true;
  }
  return strictlyBetter;
}

/** The deterministic order individuals select and log by. */
function individualOrder(left: Individual, right: Individual): number {
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (left.crowding !== right.crowding) return right.crowding - left.crowding;
  return left.index - right.index;
}

/** Builds the run's canonical cache key from a slot vector. */
function keyOf(
  specs: readonly OptimizationGeneSpec[],
  slots: GenomeSlots,
): string {
  return authoredGenomeKey(decodeGenome(specs, slots));
}

/** Runs NSGA-II over the spec. Pure; never throws except the abort sentinel. */
export async function runNsga2(
  spec: Nsga2Spec,
  evaluate: Nsga2Evaluator,
  callbacks: Nsga2RunCallbacks = {},
): Promise<Nsga2RunResult> {
  const random = createSimOptimizationRandom(spec.seed);
  const cache = new Map<string, Individual>();
  let evaluations = 0;
  let declinedCount = 0;
  const numericSlots = spec.genes.filter(
    (gene) => gene.kind === "numeric",
  ).length;
  const numericMutationProbability =
    numericSlots === 0 ? 0 : Math.min(1, spec.mutationRate / numericSlots);
  const discreteSlots = spec.genes.length - numericSlots;
  const discreteMutationProbability =
    discreteSlots === 0 ? 0 : Math.min(1, spec.mutationRate / discreteSlots);

  const evaluateSlots = async (slots: number[]): Promise<Individual> => {
    const key = keyOf(spec.genes, slots);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    if (evaluations >= spec.maxEvaluations) {
      throw new Error(
        "The optimization engine was asked to evaluate past its budget; the caller's generation loop is the guard.",
      );
    }
    pollAbort(callbacks);
    const genome = decodeGenome(spec.genes, slots);
    const outcome = await evaluate(genome);
    evaluations += 1;
    let settled: Nsga2Evaluation;
    if (outcome.status === "ok") {
      const rawObjectives = outcome.objectives;
      const valid =
        rawObjectives.length === spec.directions.length &&
        rawObjectives.every(
          (value) => typeof value === "number" && Number.isFinite(value),
        );
      settled = valid
        ? { status: "ok", objectives: rawObjectives.map((value) => value) }
        : { status: "declined", code: NSGA2_INVALID_OBJECTIVE_CODE };
    } else {
      settled =
        typeof outcome.code === "string" && outcome.code.length > 0
          ? { status: "declined", code: outcome.code }
          : { status: "declined", code: NSGA2_INVALID_OBJECTIVE_CODE };
    }
    if (settled.status === "declined") declinedCount += 1;
    const individual: Individual = {
      slots: [...slots],
      key,
      index: evaluations - 1,
      outcome: settled,
      rank: 0,
      crowding: 0,
    };
    cache.set(key, individual);
    callbacks.onEvaluation?.(evaluations);
    return individual;
  };

  // --- The initial population: uniform draws over every slot. ---------
  const population: Individual[] = [];
  for (let index = 0; index < spec.population; index += 1) {
    if (evaluations >= spec.maxEvaluations) break;
    const slots = spec.genes.map((gene) =>
      gene.kind === "discrete"
        ? random.nextInt(gene.choiceCount)
        : random.nextUnit(),
    );
    // Plateau genomes collide on their canonical key; a collision reuses
    // the cached evaluation and the population keeps the shared
    // individual (honest — they are one candidate).
    population.push(await evaluateSlots(slots));
  }
  const generationRecords: Nsga2GenerationRecord[] = [];
  const logGeneration = (generation: number): Nsga2GenerationRecord => {
    const ordered = [...population].sort(individualOrder);
    const record: Nsga2GenerationRecord = {
      generation,
      evaluations,
      candidates: ordered.map(toCandidateRecord),
    };
    generationRecords.push(record);
    callbacks.onGeneration?.(record);
    return record;
  };

  assignRanksAndCrowding(population, spec.directions);
  logGeneration(0);

  for (
    let generation = 1;
    generation < spec.generations && evaluations < spec.maxEvaluations;
    generation += 1
  ) {
    pollAbort(callbacks);
    // --- Variation: N offspring, budget-capped. ----------------------
    const offspring: Individual[] = [];
    while (
      offspring.length < spec.population &&
      evaluations < spec.maxEvaluations
    ) {
      const parentA = tournament(population, random);
      const parentB = tournament(population, random);
      const children = crossover(
        parentA.slots,
        parentB.slots,
        spec,
        random,
        spec.crossoverRate,
      );
      for (const child of children) {
        if (offspring.length >= spec.population) break;
        if (evaluations >= spec.maxEvaluations) break;
        mutate(child, spec, random, {
          numeric: numericMutationProbability,
          discrete: discreteMutationProbability,
        });
        offspring.push(await evaluateSlots(child));
      }
    }
    // --- Environmental selection: fill by front, truncate by crowding.
    // The plateau world (stepped genes, voxelized geometry) produces
    // cache-hit CLONES in the offspring pool — identical candidates that
    // share one Individual — so selection keeps the N best DISTINCT
    // genomes first (in rank/crowding/index order) and only then tops up
    // from the clones. Without the dedupe a run's survivor set floods
    // with copies of a few individuals and diversity collapses.
    const combined = [...population, ...offspring];
    assignRanksAndCrowding(combined, spec.directions);
    const ordered = combined.sort(individualOrder);
    const survivorKeys = new Set<string>();
    const survivors: Individual[] = [];
    const clones: Individual[] = [];
    for (const individual of ordered) {
      if (survivorKeys.has(individual.key)) {
        clones.push(individual);
        continue;
      }
      survivorKeys.add(individual.key);
      survivors.push(individual);
      if (survivors.length >= spec.population) break;
    }
    for (const individual of clones) {
      if (survivors.length >= spec.population) break;
      survivors.push(individual);
    }
    population.length = 0;
    for (const individual of survivors) {
      population.push(individual);
    }
    // The survivors' ranks/crowding are already current (computed over
    // the combined pool); re-log in population order.
    logGeneration(generation);
  }

  const finalOrdered = [...population].sort(individualOrder);
  // The Pareto front is the final population's feasible rank-0 set,
  // DEDUPLICATED by objective vector (equal vectors never dominate each
  // other, so genome-distinct plateau members can share rank 0 — the front
  // lists each tradeoff point once, keeping the lowest evaluation index).
  const seenObjectiveVectors = new Set<string>();
  const pareto: Nsga2CandidateRecord[] = [];
  for (const individual of finalOrdered) {
    if (individual.rank !== 0 || individual.outcome.status !== "ok") continue;
    const key = JSON.stringify(individual.outcome.objectives);
    if (seenObjectiveVectors.has(key)) continue;
    seenObjectiveVectors.add(key);
    pareto.push(toCandidateRecord(individual));
  }
  return {
    generations: generationRecords,
    evaluations,
    declined: declinedCount,
    population: finalOrdered.map(toCandidateRecord),
    pareto,
  };
}

function toCandidateRecord(individual: Individual): Nsga2CandidateRecord {
  return {
    index: individual.index,
    slots: [...individual.slots],
    status: individual.outcome.status,
    objectives:
      individual.outcome.status === "ok"
        ? [...individual.outcome.objectives]
        : [],
    ...(individual.outcome.status === "declined"
      ? { declineCode: individual.outcome.code }
      : {}),
    rank: individual.rank,
  };
}

/**
 * Assigns front ranks (fast non-dominated sort) and crowding distances
 * over the pool, in place. The sort is the textbook two-loop algorithm;
 * ties keep first-seen order, and every later comparison breaks by
 * evaluation index, so the result is a pure function of the pool.
 */
function assignRanksAndCrowding(
  pool: Individual[],
  directions: readonly ("minimize" | "maximize")[],
): void {
  const normalized = pool.map((individual) => ({
    individual,
    ok: individual.outcome.status === "ok",
    values:
      individual.outcome.status === "ok"
        ? comparisonObjectives(individual.outcome.objectives, directions)
        : [],
  }));
  const dominatedBy = pool.map(() => 0);
  const dominators: number[][] = pool.map(() => []);
  for (let left = 0; left < normalized.length; left += 1) {
    for (let right = left + 1; right < normalized.length; right += 1) {
      const leftEntry = normalized[left];
      const rightEntry = normalized[right];
      if (leftEntry === undefined || rightEntry === undefined) continue;
      if (dominates(leftEntry, rightEntry)) {
        dominators[left]?.push(right);
        dominatedBy[right] = (dominatedBy[right] ?? 0) + 1;
      } else if (dominates(rightEntry, leftEntry)) {
        dominators[right]?.push(left);
        dominatedBy[left] = (dominatedBy[left] ?? 0) + 1;
      }
    }
  }
  let front = normalized
    .map((entry, index) => ({ entry, index }))
    .filter((slot) => (dominatedBy[slot.index] ?? 0) === 0)
    .map((slot) => slot.index);
  let rank = 0;
  while (front.length > 0) {
    const frontEntries = front
      .map((index) => normalized[index])
      .filter(
        (entry): entry is (typeof normalized)[number] => entry !== undefined,
      );
    for (const entry of frontEntries) entry.individual.rank = rank;
    assignCrowding(frontEntries);
    const next: number[] = [];
    for (const index of front) {
      for (const dominatedIndex of dominators[index] ?? []) {
        dominatedBy[dominatedIndex] = (dominatedBy[dominatedIndex] ?? 0) - 1;
        if ((dominatedBy[dominatedIndex] ?? 0) === 0) next.push(dominatedIndex);
      }
    }
    front = next;
    rank += 1;
  }
}

/**
 * The standard crowding distance over one front: boundary members get
 * Infinity, middles sum the normalized gaps per objective. Declined
 * members keep 0 — no objectives exist to spread them by.
 */
function assignCrowding(
  front: readonly {
    readonly individual: Individual;
    readonly ok: boolean;
    readonly values: readonly number[];
  }[],
): void {
  for (const entry of front) entry.individual.crowding = 0;
  const feasible = front.filter((entry) => entry.ok);
  if (feasible.length < 3) {
    for (const entry of feasible) {
      entry.individual.crowding = Number.POSITIVE_INFINITY;
    }
    return;
  }
  const objectiveCount = feasible[0]?.values.length ?? 0;
  for (let objective = 0; objective < objectiveCount; objective += 1) {
    const order = [...feasible].sort((left, right) => {
      const a = left.values[objective] ?? 0;
      const b = right.values[objective] ?? 0;
      if (a !== b) return a - b;
      return left.individual.index - right.individual.index;
    });
    const first = order[0];
    const last = order[order.length - 1];
    if (first === undefined || last === undefined) continue;
    first.individual.crowding = Number.POSITIVE_INFINITY;
    last.individual.crowding = Number.POSITIVE_INFINITY;
    const min = first.values[objective] ?? 0;
    const max = last.values[objective] ?? 0;
    const span = max - min;
    for (let position = 1; position < order.length - 1; position += 1) {
      const entry = order[position];
      if (entry === undefined) continue;
      if (entry.individual.crowding === Number.POSITIVE_INFINITY) continue;
      const previous = order[position - 1];
      const next = order[position + 1];
      if (previous === undefined || next === undefined) continue;
      const previousValue = previous.values[objective] ?? 0;
      const nextValue = next.values[objective] ?? 0;
      entry.individual.crowding +=
        span > 0 ? (nextValue - previousValue) / span : 0;
    }
  }
}

/** Binary tournament on (rank, crowding, index); deterministic. */
function tournament(
  population: Individual[],
  random: SimOptimizationRandom,
): Individual {
  const left = population[random.nextInt(population.length)];
  const right = population[random.nextInt(population.length)];
  if (left === undefined || right === undefined) {
    throw new Error("The tournament sampled an empty population.");
  }
  return individualOrder(left, right) <= 0 ? left : right;
}

/**
 * SBX on numeric slots + uniform parental choice on discrete slots;
 * returns exactly two children. `crossoverRate < 1` may return parental
 * copies (still mutated downstream).
 */
function crossover(
  parentA: GenomeSlots,
  parentB: GenomeSlots,
  spec: Nsga2Spec,
  random: SimOptimizationRandom,
  rate: number,
): [number[], number[]] {
  const childA = [...parentA];
  const childB = [...parentB];
  if (random.nextUnit() >= rate) return [childA, childB];
  for (let index = 0; index < spec.genes.length; index += 1) {
    const gene = spec.genes[index];
    if (gene === undefined) continue;
    if (gene.kind === "discrete") {
      // Enumeration honesty: children pick a parent's choice, uniformly —
      // there is no between-choices value to blend toward.
      if (random.nextUnit() < 0.5) {
        const a = childA[index] ?? 0;
        childA[index] = childB[index] ?? 0;
        childB[index] = a;
      }
      continue;
    }
    if (random.nextUnit() >= 0.5) continue;
    const left = childA[index] ?? 0;
    const right = childB[index] ?? 0;
    const spread = Math.abs(left - right);
    if (spread <= 1e-14) continue;
    const u = random.nextUnit();
    const beta =
      u <= 0.5
        ? Math.pow(2 * u, 1 / (NSGA2_SBX_ETA + 1))
        : Math.pow(1 / (2 * (1 - u)), 1 / (NSGA2_SBX_ETA + 1));
    childA[index] = clampSlot(
      gene,
      0.5 * ((1 + beta) * left + (1 - beta) * right),
    );
    childB[index] = clampSlot(
      gene,
      0.5 * ((1 - beta) * left + (1 + beta) * right),
    );
  }
  return [childA, childB];
}

/**
 * Polynomial mutation with boundary clamping on numeric slots; uniform
 * re-pick on discrete slots. Per-slot probabilities come pre-scaled from
 * the study's mutationRate.
 */
function mutate(
  slots: number[],
  spec: Nsga2Spec,
  random: SimOptimizationRandom,
  probabilities: { readonly numeric: number; readonly discrete: number },
): void {
  for (let index = 0; index < spec.genes.length; index += 1) {
    const gene = spec.genes[index];
    if (gene === undefined) continue;
    if (gene.kind === "discrete") {
      if (random.nextUnit() < probabilities.discrete) {
        slots[index] = random.nextInt(gene.choiceCount);
      }
      continue;
    }
    if (random.nextUnit() >= probabilities.numeric) continue;
    const u = random.nextUnit();
    const delta =
      u < 0.5
        ? Math.pow(2 * u, 1 / (NSGA2_MUTATION_ETA + 1)) - 1
        : 1 - Math.pow(2 * (1 - u), 1 / (NSGA2_MUTATION_ETA + 1));
    slots[index] = clampSlot(gene, (slots[index] ?? 0) + delta);
  }
}
