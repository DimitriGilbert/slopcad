/**
 * The Phase 70a evaluation driver on the batch spine: the per-candidate
 * pipeline PARAMETRIC RE-DRIVE → CONSTRAINTS → COMPILE → SOLVE →
 * OBJECTIVE EXTRACTION, and the campaign runner that wires it under the
 * NSGA-II engine. Every refusal along the pipeline is a STRUCTURED
 * `sim/*` decline the engine counts as dominated/penalized — a candidate
 * that cannot re-drive, violates a constraint expression, fails to
 * compile, meets no engine for its kind, or solves without the
 * objective's quantity NEVER crashes the loop (the roadmap pin); it
 * sinks to the last front.
 *
 * The re-drive is the document's own parameter machinery, verbatim:
 * parameter genes write CANONICAL-magnitude literals into the table
 * (`updateParameterValue`), then the expression commit gate
 * (`installParameterExpression`) re-derives every expression-driven value
 * in topological order — the exact commit path a `parameter.set` rides.
 * A redrive that leaves stale values (an expression that fails at the new
 * literals, e.g. a division by a now-zero width) declines loudly.
 *
 * Constraints are the study's expression ASTs over the RE-DRIVEN table:
 * a constraint holds when it evaluates to a strictly positive canonical
 * magnitude (`clearance - 0.2mm`, `200mm2 - width * height`).
 *
 * Geometry rides the host seam: the wire carries static document context
 * (the compile field family), and a host-side `geometry` provider
 * re-drives the document's tessellation per candidate (parameters →
 * features → tessellation — the CAD side the sim worker never owns); a
 * host that provides none runs the study against the static context (a
 * motor-gene-only study needs nothing else).
 *
 * Cancellation is cooperative and bounded: the driver polls between
 * candidates and throws from the engine's progress callback mid-solve
 * (the engine contract's documented unwind); an engine that never emits
 * progress still cannot outlive its step budget, and the campaign stops
 * at the next poll.
 */

import {
  CANONICAL_UNITS,
  type DocumentMotorRecord,
  type ParameterCollection,
  type SimStudy,
  crossCheckSimStudy,
  evaluateExpression,
  installParameterExpression,
  parameterEnvironment,
  parseDocumentMotor,
  parseParameterCollection,
  parseSimScenarioBody,
  parseSimStudy,
  serializeDocumentMotor,
  serializeSimStudy,
  toCanonical,
  updateParameterValue,
} from "@slopcad/cad-core";
import {
  type CompiledSimScenario,
  type SimBodyBoundsMm,
  type SimEngine,
  type SimEngineOptimizationGeneration,
  type SimError,
  SIM_ERROR_CODES,
  type SimResult,
  type WorkerSimOptimizeCandidate,
  type WorkerSimOptimizeGeneration,
  type WorkerSimOptimizeResult,
  compileSimScenarioWithGeometry,
  simError,
  simFail,
  simOk,
  type SimParseResult,
  simScenarioSnapshotHash,
} from "@slopcad/sim-core";

import {
  type AuthoredGenome,
  type OptimizationGeneSpec,
  authoredGenomeKey,
  decodeGenome,
} from "./genome";
import {
  type Nsga2RunCallbacks,
  type Nsga2RunResult,
  SimOptimizationAbortedError,
  runNsga2,
} from "./nsga2";

/** The document context a study runs against (the worker wire's typed form). */
export interface SimOptimizationRunContext {
  readonly study: SimStudy;
  /** The serialized scenario every candidate runs (revalidated at build). */
  readonly scenario: unknown;
  /** The document's parameter table (the genome address space). */
  readonly parameters: ParameterCollection;
  /** The document's motor records (the discrete gene's choices). */
  readonly motors: readonly DocumentMotorRecord[];
  readonly bodyBounds?: readonly SimBodyBoundsMm[];
  readonly tessellation?: unknown;
  readonly materials?: readonly unknown[];
  readonly bodyTessellations?: readonly {
    readonly bodyId: string;
    readonly tessellation: unknown;
  }[];
}

/** The per-candidate geometry a host's re-drive service returns. */
export interface SimOptimizationGeometry {
  readonly tessellation?: unknown;
  readonly bodyBounds?: readonly SimBodyBoundsMm[];
  readonly bodyTessellations?: readonly {
    readonly bodyId: string;
    readonly tessellation: unknown;
  }[];
}

/**
 * The host's per-candidate geometry re-drive: given the re-driven
 * parameter table and the candidate's motor choice, the tessellation
 * forms the compile consumes. Absent fields fall back to the run
 * context's statics. The provider may resolve SYNCHRONOUSLY (an analytic
 * twin, the toy campaign's plate) or through a PROMISE — a browser host
 * re-drives its kernel worker per candidate, and the candidate's
 * evaluation awaits the settle before compiling (determinism is the
 * VALUES, never the scheduling).
 */
export type SimOptimizationGeometryProvider = (candidate: {
  readonly parameters: ParameterCollection;
  readonly motor: DocumentMotorRecord | undefined;
}) => SimOptimizationGeometry | Promise<SimOptimizationGeometry>;

/** The host services the driver injects (engines, geometry, streaming). */
export interface SimOptimizationHostServices {
  /** The routed engines, searched by scenario kind, backend-preferring. */
  readonly engines: readonly SimEngine[];
  readonly geometry?: SimOptimizationGeometryProvider;
  /** Called after each distinct evaluation settles (cumulative count). */
  readonly onEvaluation?: (total: number, budget: number) => void;
  /** Called after each generation settles (the best-of-generation notice). */
  readonly onGeneration?: (notice: SimEngineOptimizationGeneration) => void;
  /** The cooperative cancellation poll. */
  readonly shouldAbort?: () => boolean;
}

/** One candidate's full evaluation products (the persistence payload). */
export interface SimOptimizationCandidateEvaluation {
  readonly status: "ok" | "declined";
  readonly objectives: readonly number[];
  readonly declineCode?: string;
  /** The engine's result, carried for persistence when the candidate scored. */
  readonly result?: SimResult;
}

/** The campaign run outcome. */
export interface SimOptimizationRunOutcome {
  readonly status: "completed" | "aborted";
  /** The deterministic campaign family id (study content + seed hash). */
  readonly campaign: string;
  readonly result?: WorkerSimOptimizeResult;
  /** The ok candidates' results, keyed by evaluation index (persistence). */
  readonly candidateResults?: ReadonlyMap<number, SimResult>;
}

/** Maps a study record to the engine's gene specs (authored → unit slots). */
export function studyGeneSpecs(
  study: SimStudy,
): readonly OptimizationGeneSpec[] {
  return study.genes.map((gene) =>
    gene.kind === "parameter"
      ? {
          kind: "numeric" as const,
          valueKind: gene.valueKind,
          min: gene.min,
          max: gene.max,
          ...(gene.step === undefined ? {} : { step: gene.step }),
        }
      : { kind: "discrete" as const, choiceCount: gene.choices.length },
  );
}

/**
 * Builds the run context from the worker wire's document context: every
 * record re-parses through its cad-core boundary, the scenario parses AND
 * is paired to the study's scenario selection, and the study cross-checks
 * against the parameter table, motor records, and the paired scenario —
 * one structured `sim/study-invalid` refusal naming every problem, never
 * a guess.
 */
export function buildSimOptimizationRunContext(input: {
  readonly study: unknown;
  readonly scenario: unknown;
  readonly parameters: unknown;
  readonly motors?: readonly unknown[];
  readonly bodyBounds?: readonly SimBodyBoundsMm[];
  readonly tessellation?: unknown;
  readonly materials?: readonly unknown[];
  readonly bodyTessellations?: readonly {
    readonly bodyId: string;
    readonly tessellation: unknown;
  }[];
}): SimParseResult<SimOptimizationRunContext, SimError> {
  const study = parseSimStudy(input.study);
  if (!study.ok) {
    return simFail(
      simError(
        SIM_ERROR_CODES.studyInvalid,
        `The optimization study did not parse: ${study.error.message}`,
        study.error.input,
      ),
    );
  }
  const parameters = parseParameterCollection(input.parameters);
  if (!parameters.ok) {
    return simFail(
      simError(
        SIM_ERROR_CODES.studyInvalid,
        `The document parameter table did not parse: ${parameters.error.message}`,
        parameters.error.input,
      ),
    );
  }
  const motors: DocumentMotorRecord[] = [];
  for (const entry of input.motors ?? []) {
    const motor = parseDocumentMotor(entry);
    if (!motor.ok) {
      return simFail(
        simError(
          SIM_ERROR_CODES.studyInvalid,
          `A referenced motor record did not parse: ${motor.error.message}`,
          motor.error.input,
        ),
      );
    }
    motors.push(motor.value);
  }
  const scenario = parseSimScenarioBody(input.scenario);
  if (!scenario.ok) {
    return simFail(
      simError(
        SIM_ERROR_CODES.studyInvalid,
        `The study's scenario did not parse: ${scenario.error.message}`,
        scenario.error.input,
      ),
    );
  }
  const problems = crossCheckSimStudy(study.value, {
    parameters: parameters.value,
    motors,
    simulations: [{ ...scenario.value, id: study.value.scenarioId }],
  });
  if (problems.length > 0) {
    return simFail(
      simError(
        SIM_ERROR_CODES.studyInvalid,
        `The study does not cross-check against its document context: ${problems
          .map((problem) => problem.message)
          .join(" ")}`,
        problems,
      ),
    );
  }
  return simOk({
    study: study.value,
    scenario: input.scenario,
    parameters: parameters.value,
    motors,
    ...(input.bodyBounds === undefined ? {} : { bodyBounds: input.bodyBounds }),
    ...(input.tessellation === undefined
      ? {}
      : { tessellation: input.tessellation }),
    ...(input.materials === undefined ? {} : { materials: input.materials }),
    ...(input.bodyTessellations === undefined
      ? {}
      : { bodyTessellations: input.bodyTessellations }),
  });
}

/**
 * The deterministic campaign family id: the djb2 content hash of the
 * serialized study record plus its seed — the scenario-snapshot-hash
 * precedent applied to campaigns. Same study bytes + seed ⇒ same family;
 * any authored change, or a different seed (a multi-seed campaign rung),
 * keys a different family.
 */
export function simCampaignFamilyId(study: SimStudy): string {
  const hashed = simScenarioSnapshotHash({
    study: serializeSimStudy(study),
    seed: study.seed,
  });
  // Serialized records are canonical JSON by construction, so the hash
  // cannot refuse; the fallback stays deterministic and honest anyway.
  return hashed.ok ? hashed.value : `seed${String(study.seed)}`;
}

/** Routes the compiled scenario to a host engine: kind-supporting, backend-preferring. */
function routeEngine(
  engines: readonly SimEngine[],
  compiled: CompiledSimScenario,
): SimEngine | undefined {
  let fallback: SimEngine | undefined;
  for (const engine of engines) {
    if (!engine.supportedKinds.includes(compiled.kind)) continue;
    if (engine.backend === compiled.backend) return engine;
    fallback = fallback ?? engine;
  }
  return fallback;
}

/** Reads the scenario's own motor selection off its serialized record. */
function scenarioMotorId(scenario: unknown): string | undefined {
  if (typeof scenario !== "object" || scenario === null) return undefined;
  const motorId = (scenario as { readonly motorId?: unknown }).motorId;
  return typeof motorId === "string" ? motorId : undefined;
}

/**
 * Evaluates one AUTHORED genome against the document context: the full
 * re-drive → constraints → compile → solve → extract pipeline, every
 * refusal a structured decline. Deterministic with respect to (context,
 * host, genome) — the replay path calls exactly this.
 */
export async function evaluateAuthoredGenome(
  context: SimOptimizationRunContext,
  host: SimOptimizationHostServices,
  genome: AuthoredGenome,
): Promise<SimOptimizationCandidateEvaluation> {
  // --- Re-drive: gene literals in, expressions re-derived. ------------
  let numericIndex = 0;
  let choiceIndex = 0;
  let chosenMotor: DocumentMotorRecord | undefined;
  let collection = context.parameters;
  for (const gene of context.study.genes) {
    if (gene.kind === "parameter") {
      const value = genome.numericValues[numericIndex];
      numericIndex += 1;
      if (value === undefined) {
        return {
          status: "declined",
          declineCode: SIM_ERROR_CODES.studyInvalid,
          objectives: [],
        };
      }
      const parameter = collection.parameters.find(
        (candidate) => candidate.id === gene.parameterId,
      );
      if (parameter === undefined) {
        return {
          status: "declined",
          declineCode: SIM_ERROR_CODES.studyInvalid,
          objectives: [],
        };
      }
      const override = {
        dimension: parameter.value.dimension,
        unit: CANONICAL_UNITS[parameter.value.dimension],
        value,
      };
      const updated = updateParameterValue(collection, parameter.id, override);
      if (!updated.ok) {
        return {
          status: "declined",
          declineCode: SIM_ERROR_CODES.optimizationRedriveFailed,
          objectives: [],
        };
      }
      collection = updated.value;
      continue;
    }
    const choice = gene.choices[genome.choiceIndices[choiceIndex] ?? 0];
    choiceIndex += 1;
    const record = context.motors.find((motor) => motor.id === choice);
    if (record === undefined) {
      return {
        status: "declined",
        declineCode: SIM_ERROR_CODES.studyInvalid,
        objectives: [],
      };
    }
    chosenMotor = record;
  }
  // The expression recompute rides the commit gate itself: re-installing
  // the first expression's own AST re-derives every expression-driven
  // value in one topological pass (a parameter.set's exact path).
  const expressionDriven = collection.parameters.find(
    (parameter) => parameter.expression !== null,
  );
  if (expressionDriven !== undefined && expressionDriven.expression !== null) {
    const commit = installParameterExpression(
      collection,
      expressionDriven.id,
      expressionDriven.expression,
    );
    if (!commit.ok || commit.value.stale.length > 0) {
      return {
        status: "declined",
        declineCode: SIM_ERROR_CODES.optimizationRedriveFailed,
        objectives: [],
      };
    }
    collection = commit.value.collection;
  }
  // --- Constraints: strictly positive canonical magnitude. ------------
  const environment = parameterEnvironment(collection);
  for (const constraint of context.study.constraints) {
    const evaluated = evaluateExpression(constraint, environment);
    if (!evaluated.ok || toCanonical(evaluated.value).value <= 0) {
      return {
        status: "declined",
        declineCode: SIM_ERROR_CODES.optimizationConstraintViolated,
        objectives: [],
      };
    }
  }
  // --- Geometry (host re-drive) and compile. --------------------------
  // The same cooperative poll as runNsga2's pollAbort and the engine's
  // onProgress throw below: the host re-drive is the expensive step this
  // side of the solve, so cancellation lands BEFORE the work, never after.
  if (host.shouldAbort?.()) throw new SimOptimizationAbortedError();
  const scenarioMotor = context.motors.find(
    (motor) => motor.id === scenarioMotorId(context.scenario),
  );
  const motor = chosenMotor ?? scenarioMotor;
  // A discrete motor gene re-drives the scenario's motor SELECTION: the
  // compile boundary pairs the motor payload with the scenario record's
  // own motorId, so the candidate's scenario is the study's scenario with
  // the chosen selection (the same delta a document edit would make).
  const candidateScenario =
    chosenMotor === undefined
      ? context.scenario
      : {
          ...(context.scenario as Record<string, unknown>),
          motorId: chosenMotor.id,
        };
  const geometrySync = host.geometry?.({
    parameters: collection,
    motor: chosenMotor,
  });
  const geometry =
    geometrySync === undefined ? {} : await Promise.resolve(geometrySync);
  const compiled = compileSimScenarioWithGeometry({
    scenario: candidateScenario,
    ...(motor === undefined ? {} : { motor: serializeDocumentMotor(motor) }),
    ...(geometry.bodyBounds === undefined && context.bodyBounds === undefined
      ? {}
      : { bodyBounds: geometry.bodyBounds ?? context.bodyBounds }),
    ...(geometry.tessellation === undefined &&
    context.tessellation === undefined
      ? {}
      : { tessellation: geometry.tessellation ?? context.tessellation }),
    ...(context.materials === undefined
      ? {}
      : { materials: context.materials }),
    ...(geometry.bodyTessellations === undefined &&
    context.bodyTessellations === undefined
      ? {}
      : {
          bodyTessellations:
            geometry.bodyTessellations ?? context.bodyTessellations,
        }),
  });
  if (!compiled.ok) {
    return {
      status: "declined",
      declineCode: compiled.error.code,
      objectives: [],
    };
  }
  // --- Solve via the routed engine. -----------------------------------
  const engine = routeEngine(host.engines, compiled.value);
  if (engine === undefined) {
    return {
      status: "declined",
      declineCode: SIM_ERROR_CODES.scenarioKindUnsupported,
      objectives: [],
    };
  }
  const shouldAbort = host.shouldAbort;
  const onProgress = shouldAbort
    ? (): void => {
        if (shouldAbort()) throw new SimOptimizationAbortedError();
      }
    : undefined;
  const solved = await engine.run({ compiled: compiled.value }, onProgress);
  if (!solved.ok) {
    return {
      status: "declined",
      declineCode: solved.error.code,
      objectives: [],
    };
  }
  const result = solved.value;
  if (result.summary.status !== "completed") {
    return {
      status: "declined",
      declineCode: result.summary.failureCode ?? SIM_ERROR_CODES.runDiverged,
      objectives: [],
    };
  }
  // --- Objective extraction from the result summary scalars. ----------
  const objectives: number[] = [];
  for (const objective of context.study.objectives) {
    const quantity = result.summary.quantities.find(
      (entry) => entry.name === objective.quantity,
    );
    if (
      quantity === undefined ||
      typeof quantity.value !== "number" ||
      !Number.isFinite(quantity.value)
    ) {
      return {
        status: "declined",
        declineCode: SIM_ERROR_CODES.optimizationObjectiveMissing,
        objectives: [],
      };
    }
    objectives.push(quantity.value);
  }
  return { status: "ok", objectives, result };
}

/** Builds the wire candidate record of an engine candidate log entry. */
function toWireCandidate(
  study: SimStudy,
  motors: readonly DocumentMotorRecord[],
  candidate: {
    readonly index: number;
    readonly slots: readonly number[];
    readonly status: "ok" | "declined";
    readonly objectives: readonly number[];
    readonly declineCode?: string;
    readonly rank: number;
  },
): WorkerSimOptimizeCandidate {
  const authored = decodeGenome(studyGeneSpecs(study), candidate.slots);
  const genomeParameters: { parameterId: string; value: number }[] = [];
  const genomeRecords: { recordKind: string; recordId: string }[] = [];
  let numericIndex = 0;
  let choiceIndex = 0;
  for (const gene of study.genes) {
    if (gene.kind === "parameter") {
      genomeParameters.push({
        parameterId: gene.parameterId,
        value: authored.numericValues[numericIndex] ?? 0,
      });
      numericIndex += 1;
      continue;
    }
    const choice = gene.choices[authored.choiceIndices[choiceIndex] ?? 0];
    genomeRecords.push({
      recordKind: gene.recordKind,
      recordId: motors.find((motor) => motor.id === choice)?.id ?? choice ?? "",
    });
    choiceIndex += 1;
  }
  return {
    index: candidate.index,
    genomeParameters,
    genomeRecords,
    status: candidate.status,
    objectives: [...candidate.objectives],
    ...(candidate.declineCode === undefined
      ? {}
      : { declineCode: candidate.declineCode }),
    rank: candidate.rank,
  };
}

/**
 * Runs one optimization campaign: NSGA-II over the study's genome, the
 * evaluation driver per candidate, generation-logged, budget-capped,
 * best-of-generation notices streamed. Deterministic end to end given the
 * study seed and deterministic engines (law S2/S5).
 */
export async function runSimOptimization(
  context: SimOptimizationRunContext,
  host: SimOptimizationHostServices,
): Promise<SimOptimizationRunOutcome> {
  const { study } = context;
  const campaign = simCampaignFamilyId(study);
  const specs = studyGeneSpecs(study);
  // The evaluator records each scored candidate's result keyed by its
  // AUTHORED genome; the run log's indices re-associate them afterwards
  // (the engine owns index assignment — cache hits share the first
  // evaluation's index, and the key is the engine's canonical key too).
  const resultsByGenome = new Map<string, SimResult>();
  const callbacks: Nsga2RunCallbacks = {
    onEvaluation: (total) => host.onEvaluation?.(total, study.maxEvaluations),
    shouldAbort: () => host.shouldAbort?.() ?? false,
    onGeneration: (record) => {
      const best = record.candidates.find(
        (candidate) => candidate.status === "ok",
      );
      host.onGeneration?.({
        generation: record.generation,
        evaluated: record.evaluations,
        budget: study.maxEvaluations,
        ...(best === undefined ? {} : { best: [...best.objectives] }),
      });
    },
  };
  let run: Nsga2RunResult;
  try {
    run = await runNsga2(
      {
        genes: specs,
        directions: study.objectives.map((objective) => objective.direction),
        population: study.population,
        generations: study.generations,
        mutationRate: study.mutationRate,
        crossoverRate: study.crossoverRate,
        seed: study.seed,
        maxEvaluations: study.maxEvaluations,
      },
      async (genome) => {
        const evaluation = await evaluateAuthoredGenome(context, host, genome);
        if (evaluation.status === "ok" && evaluation.result !== undefined) {
          resultsByGenome.set(authoredGenomeKey(genome), evaluation.result);
        }
        return evaluation.status === "ok"
          ? { status: "ok", objectives: [...evaluation.objectives] }
          : {
              status: "declined",
              code:
                evaluation.declineCode ??
                SIM_ERROR_CODES.optimizationObjectiveMissing,
            };
      },
      callbacks,
    );
  } catch (error) {
    if (error instanceof SimOptimizationAbortedError) {
      return { status: "aborted", campaign };
    }
    throw error;
  }
  const candidateResults = new Map<number, SimResult>();
  const wireCandidate = (candidate: {
    readonly index: number;
    readonly slots: readonly number[];
    readonly status: "ok" | "declined";
    readonly objectives: readonly number[];
    readonly declineCode?: string;
    readonly rank: number;
  }): WorkerSimOptimizeCandidate => {
    if (candidate.status === "ok") {
      const result = resultsByGenome.get(
        authoredGenomeKey(decodeGenome(specs, candidate.slots)),
      );
      if (result !== undefined) candidateResults.set(candidate.index, result);
    }
    return toWireCandidate(study, context.motors, candidate);
  };
  const generations: WorkerSimOptimizeGeneration[] = run.generations.map(
    (generation) => ({
      generation: generation.generation,
      evaluations: generation.evaluations,
      candidates: generation.candidates.map(wireCandidate),
    }),
  );
  const outcome: SimOptimizationRunOutcome = {
    status: "completed",
    campaign,
    result: {
      campaign,
      generations,
      evaluations: run.evaluations,
      declined: run.declined,
      pareto: run.pareto.map(wireCandidate),
    },
    candidateResults,
  };
  return outcome;
}
