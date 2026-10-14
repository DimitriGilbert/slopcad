/**
 * Parametric optimization studies as document records (Phase 70a of
 * ROADMAP-SIM, the finale): a {@link SimStudy} is a named row of
 * optimization intent over the SAME document, addressed on the
 * configurations/scenarios precedent — the genome a bounded subset of the
 * document parameter table, the objectives selections among result-store
 * summary scalars, the constraints parameter expressions the document
 * already validates. cad-core stores the INTENT; the NSGA-II engine and
 * the batch-spine evaluation driver live in `@slopcad/sim-optimization`
 * (never here — this package is data and vocabulary, the exact split of
 * `simulation.ts` vs the sim packages).
 *
 * ## The genome
 *
 * Two gene kinds, in authored order (the order IS the genome's coordinate
 * system — the engine addresses genes by index):
 *
 * - `parameter` — one LITERAL parameter of the document's parameter table,
 *   varied inside declared bounds. `valueKind` pins the number line
 *   (`integer` demands integral bounds and step; `decimal` is continuous
 *   when no `step` is given). Bounds and step are CANONICAL magnitudes of
 *   the parameter's own dimension (the `units.ts` discipline: lengths in
 *   mm, angles in deg, dimensionless plain), so a length gene's `min: 5`
 *   means 5 mm — the same reading every serialized dimensional value has.
 *   A parameter carrying a defining expression is REFUSED as a gene at
 *   cross-check: overriding an expression-driven value would be undone by
 *   the re-drive recompute, and the study says so loudly instead.
 * - `discrete` — an enum-valued gene: a choice among NAMED RECORDS. The
 *   record families ride the additive-section vocabulary (`motor` — a
 *   `DocumentMotorRecord` — today); choices are record ids, existence
 *   cross-checked against the document, and the engine treats the gene as
 *   an enumeration (crossover and mutation pick choices, never blend
 *   them).
 *
 * ## Objectives and constraints
 *
 * An objective selects ONE result-summary scalar by its quantity name
 * (mass, drag, deflection, air-per-watt — whatever the scenario's engine
 * projects) and a direction. Constraints are expression ASTs on the
 * parameter-expression surface (`expression.ts` — parsed, validated, and
 * evaluated by the existing machinery): a constraint HOLDS when it
 * evaluates to a strictly positive canonical magnitude (`clearance -
 * 0.2mm`, `200mm2 - width * height`). A genome whose constraints fail —
 * or whose evaluation declines — is a structured `sim/*` decline the
 * optimization counts as dominated/penalized, never a crash (the roadmap
 * pin).
 *
 * ## Algorithm and budget fields
 *
 * NSGA-II's knobs are study fields, not runtime knobs: population,
 * generations, mutation and crossover rates, and the SEED — a u32 whose
 * whole driving loop is bitwise deterministic (law S2/S5): same study
 * bytes + same seed + same deterministic kernels ⇒ the same front, every
 * time. `maxEvaluations` caps the solve cost; the driver terminates
 * early when it is exhausted (the roadmap's early-terminated-generations
 * mitigation).
 *
 * ## The fitness-landscape caveat (law-adjacent guidance)
 *
 * The voxel staircase quantizes objectives into plateaus and jumps: a
 * candidate whose geometry voxelizes identically to its neighbor scores
 * identically, and one extra occupied cell row steps every objective at
 * once. Mitigations, named here so every study author meets them: a
 * RESOLUTION LADDER per study (re-run the champion at finer
 * `resolutionMm` rungs and compare — the scenario record's own field),
 * and MULTI-SEED CAMPAIGNS (the same study at several seeds; agreement
 * across seeds is the trust signal, disagreement is the plateau talking).
 * Distance-field-smoothed objectives arrive only with a future cut-cell
 * phase; until then the staircase is stated, never hidden.
 *
 * Serialization is canonical (fixed key order, declaration order
 * preserved) and parsing validates untrusted input strictly with stable
 * `study/*` failure codes.
 */

import type { DocumentMotorRecord } from "./motors";
import type { SimScenario } from "./simulation";

import {
  type ExpressionNode,
  isBinaryOperator,
  isExpressionFunction,
  isExpressionIdentifierName,
  isValidCallArity,
} from "./expression";
import {
  type MotorId,
  type ParameterId,
  type SimulationId,
  type StudyId,
  parseMotorId,
  parseParameterId,
  parseSimulationId,
  parseStudyId,
} from "./ids";
import { type ParameterCollection, type Parameter } from "./parameter";
import { type ParseFailure, type ParseResult, fail, ok } from "./result";

/** The named-record families a discrete gene may choose among. */
export const SIM_STUDY_GENE_RECORD_KINDS = ["motor"] as const;

/** A discrete gene's named-record family (`DocumentMotorRecord` today). */
export type SimStudyGeneRecordKind =
  (typeof SIM_STUDY_GENE_RECORD_KINDS)[number];

/** The number line a parameter gene varies on. */
export const SIM_STUDY_VALUE_KINDS = ["integer", "decimal"] as const;

/** Whether a gene's values are integral or continuous. */
export type SimStudyValueKind = (typeof SIM_STUDY_VALUE_KINDS)[number];

/**
 * A parameter gene: one literal document parameter varied inside bounds.
 * Bounds and step are canonical magnitudes of the parameter's dimension.
 */
export interface SimStudyParameterGene {
  readonly kind: "parameter";
  readonly parameterId: ParameterId;
  readonly valueKind: SimStudyValueKind;
  /** The inclusive lower bound (canonical magnitude; strictly below `max`). */
  readonly min: number;
  /** The inclusive upper bound (canonical magnitude; strictly above `min`). */
  readonly max: number;
  /**
   * The lattice step (canonical magnitude, strictly positive); absent = a
   * continuous gene. On the lattice, values are `min + k·step` with k an
   * integer in `[0, floor((max-min)/step)]`.
   */
  readonly step?: number;
}

/** A discrete gene: an enum-valued choice among named records. */
export interface SimStudyDiscreteGene {
  readonly kind: "discrete";
  readonly recordKind: SimStudyGeneRecordKind;
  /** The candidate record ids; at least two, all distinct. */
  readonly choices: readonly MotorId[];
}

/** One gene of the study's genome, in authored (genome-coordinate) order. */
export type SimStudyGene = SimStudyParameterGene | SimStudyDiscreteGene;

/** The objective directions. */
export const SIM_STUDY_OBJECTIVE_DIRECTIONS = ["minimize", "maximize"] as const;

/** Which way an objective drives. */
export type SimStudyObjectiveDirection =
  (typeof SIM_STUDY_OBJECTIVE_DIRECTIONS)[number];

/** One objective: a result-summary scalar by quantity name, and a direction. */
export interface SimStudyObjective {
  /** The summary quantity's name exactly as the engine projects it. */
  readonly quantity: string;
  readonly direction: SimStudyObjectiveDirection;
}

/** The most genes one study may carry (the genome's coordinate budget). */
export const SIM_STUDY_MAX_GENES = 16;

/** The most objectives one study may carry (multi-objective, not many). */
export const SIM_STUDY_MAX_OBJECTIVES = 8;

/** The most constraints one study may carry. */
export const SIM_STUDY_MAX_CONSTRAINTS = 16;

/** The largest population a study may declare (the memory/CPU pin). */
export const SIM_STUDY_MAX_POPULATION = 512;

/** The most generations a study may declare. */
export const SIM_STUDY_MAX_GENERATIONS = 512;

/** The largest evaluation budget a study may declare. */
export const SIM_STUDY_MAX_EVALUATIONS = 1_000_000;

/** A study seed is a u32 (the PRNG's entire state space). */
export const SIM_STUDY_MAX_SEED = 4_294_967_295;

/** The documented default population of a study's absent field. */
export const SIM_STUDY_DEFAULT_POPULATION = 20;
/** The documented default generation count of a study's absent field. */
export const SIM_STUDY_DEFAULT_GENERATIONS = 12;
/** The documented default mutation rate of a study's absent field. */
export const SIM_STUDY_DEFAULT_MUTATION_RATE = 0.25;
/** The documented default crossover rate of a study's absent field. */
export const SIM_STUDY_DEFAULT_CROSSOVER_RATE = 0.9;
/** The documented default seed of a study's absent field. */
export const SIM_STUDY_DEFAULT_SEED = 0;

/** The objective quantity-name budget (the summary label budget). */
export const SIM_STUDY_QUANTITY_MAX_LENGTH = 255;

/** The study record's authored fields. */
export interface SimStudyBody {
  /** The study's name (1-64 characters after trimming; unique in the document). */
  readonly name: string;
  /** The scenario every candidate runs (the objectives' source). */
  readonly scenarioId: SimulationId;
  /** The genome, in authored order; 1-{@link SIM_STUDY_MAX_GENES} genes. */
  readonly genes: readonly SimStudyGene[];
  /** 1-{@link SIM_STUDY_MAX_OBJECTIVES} objectives over distinct quantities. */
  readonly objectives: readonly SimStudyObjective[];
  /**
   * Constraint expressions over the parameter table; each must hold
   * (evaluate to a strictly positive canonical magnitude) on a valid
   * genome. 0-{@link SIM_STUDY_MAX_CONSTRAINTS} ASTs.
   */
  readonly constraints: readonly ExpressionNode[];
  /** The population size (even-numbered NSGA-II pool), 2-512. */
  readonly population: number;
  /** The generation count, 1-512. */
  readonly generations: number;
  /** The per-gene mutation probability scale, [0, 1]. */
  readonly mutationRate: number;
  /** The crossover probability per mating, [0, 1]. */
  readonly crossoverRate: number;
  /** The deterministic seed, a u32. */
  readonly seed: number;
  /**
   * The evaluation budget: the driver stops (early-terminated
   * generations) once this many candidates have been evaluated.
   * `population` … 1,000,000.
   */
  readonly maxEvaluations: number;
}

/** A study record: a {@link SimStudyBody} with its identity. */
export interface SimStudy extends SimStudyBody {
  readonly id: StudyId;
}

/** Input accepted by {@link buildSimStudyBody} and the record builders. */
export interface SimStudyInput {
  /** An explicit id (`study_…`), or absent to generate the next one. */
  readonly id?: StudyId;
  readonly name: string;
  readonly scenarioId: SimulationId;
  readonly genes?: readonly SimStudyGene[];
  readonly objectives?: readonly SimStudyObjective[];
  readonly constraints?: readonly ExpressionNode[];
  readonly population?: number;
  readonly generations?: number;
  readonly mutationRate?: number;
  readonly crossoverRate?: number;
  readonly seed?: number;
  readonly maxEvaluations?: number;
}

/** A study's authored fields minus its identity (the scenario-draft rule). */
export type SimStudyDraft = Omit<SimStudyInput, "id">;

/** Stable failure codes produced when study input is rejected. */
export const STUDY_ERROR_CODES = {
  malformed: "study/malformed",
  idInvalid: "study/id-invalid",
  nameInvalid: "study/name-invalid",
  geneInvalid: "study/gene-invalid",
  objectiveInvalid: "study/objective-invalid",
  constraintInvalid: "study/constraint-invalid",
  algorithmInvalid: "study/algorithm-invalid",
  budgetInvalid: "study/budget-invalid",
  scenarioInvalid: "study/scenario-invalid",
  parameterGeneExpressionDriven: "study/parameter-gene-expression-driven",
  parameterGeneUnknown: "study/parameter-gene-unknown",
  choiceUnknown: "study/choice-unknown",
  constraintIdentifierUnknown: "study/constraint-identifier-unknown",
} as const;

export type StudyErrorCode =
  (typeof STUDY_ERROR_CODES)[keyof typeof STUDY_ERROR_CODES];

/** Structured failure describing why study input was rejected. */
export interface StudyError extends ParseFailure {
  readonly code: StudyErrorCode;
}

function studyError(
  code: StudyErrorCode,
  message: string,
  input: unknown,
): StudyError {
  return { code, message, input };
}

function isPlainRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input);
}

/** The study naming rule: 1-64 characters after trimming (the scenario rule). */
export function isValidStudyName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length >= 1 && trimmed.length <= 64;
}

function isFiniteNumber(input: unknown): input is number {
  return typeof input === "number" && Number.isFinite(input);
}

/** Whether the input is one of the declared value kinds. */
export function isSimStudyValueKind(
  input: unknown,
): input is SimStudyValueKind {
  return (
    typeof input === "string" &&
    SIM_STUDY_VALUE_KINDS.includes(input as SimStudyValueKind)
  );
}

/** Whether the input is one of the declared record families. */
export function isSimStudyGeneRecordKind(
  input: unknown,
): input is SimStudyGeneRecordKind {
  return (
    typeof input === "string" &&
    SIM_STUDY_GENE_RECORD_KINDS.includes(input as SimStudyGeneRecordKind)
  );
}

/**
 * Structurally validates a constraint AST — the expression node shapes of
 * `expression.ts`, checked by the same guards the parser enforces (finite
 * numbers, identifier vocabulary, operator/function vocabulary, call
 * arity). Refuses anything else with `study/constraint-invalid`; never
 * guesses a malformed node's meaning.
 */
function validateConstraintNode(
  node: ExpressionNode,
  path: string,
): StudyError | undefined {
  if (!isPlainRecord(node)) {
    return studyError(
      STUDY_ERROR_CODES.constraintInvalid,
      `A study constraint's ${path} must be an expression node object.`,
      node,
    );
  }
  switch (node.kind) {
    case "number":
      if (!isFiniteNumber(node.value)) {
        return studyError(
          STUDY_ERROR_CODES.constraintInvalid,
          `A study constraint's ${path} number literal must be finite.`,
          node.value,
        );
      }
      return undefined;
    case "unitLiteral":
      if (
        !isFiniteNumber(node.value) ||
        typeof node.unit !== "string" ||
        node.unit.length === 0
      ) {
        return studyError(
          STUDY_ERROR_CODES.constraintInvalid,
          `A study constraint's ${path} unit literal must carry a finite value and a non-empty unit.`,
          node,
        );
      }
      return undefined;
    case "identifier":
      if (!isExpressionIdentifierName(node.name)) {
        return studyError(
          STUDY_ERROR_CODES.constraintInvalid,
          `A study constraint's ${path} identifier must be a valid expression identifier name.`,
          node.name,
        );
      }
      return undefined;
    case "unary":
      if (node.operator !== "-") {
        return studyError(
          STUDY_ERROR_CODES.constraintInvalid,
          `A study constraint's ${path} unary operator must be "-".`,
          node.operator,
        );
      }
      return validateConstraintNode(node.operand, `${path}.operand`);
    case "binary":
      if (!isBinaryOperator(node.operator)) {
        return studyError(
          STUDY_ERROR_CODES.constraintInvalid,
          `A study constraint's ${path} binary operator is not part of the expression vocabulary.`,
          node.operator,
        );
      }
      return (
        validateConstraintNode(node.left, `${path}.left`) ??
        validateConstraintNode(node.right, `${path}.right`)
      );
    case "call": {
      if (!isExpressionFunction(node.callee)) {
        return studyError(
          STUDY_ERROR_CODES.constraintInvalid,
          `A study constraint's ${path} callee is not part of the expression function vocabulary.`,
          node.callee,
        );
      }
      // The arity gate runs on the ARRAY check alone, so the element walk
      // below keeps the declared node type (never a narrowed-away `any`).
      const argCount = Array.isArray(node.args) ? node.args.length : -1;
      if (!isValidCallArity(node.callee, argCount)) {
        return studyError(
          STUDY_ERROR_CODES.constraintInvalid,
          `A study constraint's ${path} call must satisfy its arity contract.`,
          node,
        );
      }
      for (let index = 0; index < node.args.length; index += 1) {
        const argument = node.args[index];
        if (argument === undefined) continue;
        const failure = validateConstraintNode(
          argument,
          `${path}.args[${String(index)}]`,
        );
        if (failure !== undefined) return failure;
      }
      return undefined;
    }
    default:
      return studyError(
        STUDY_ERROR_CODES.constraintInvalid,
        `A study constraint's ${path} kind must be one of the expression node kinds.`,
        (node as Record<string, unknown>).kind,
      );
  }
}

function buildParameterGene(
  input: unknown,
): ParseResult<SimStudyParameterGene, StudyError> {
  if (!isPlainRecord(input)) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.geneInvalid,
        "A parameter gene must be a plain object with parameterId, valueKind, min, and max fields.",
        input,
      ),
    );
  }
  const parameterId = parseParameterId(input.parameterId);
  if (!parameterId.ok) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.geneInvalid,
        `A parameter gene's parameterId must be a valid parameter id: ${parameterId.error.message}`,
        input.parameterId,
      ),
    );
  }
  if (!isSimStudyValueKind(input.valueKind)) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.geneInvalid,
        `A parameter gene's valueKind must be one of: ${SIM_STUDY_VALUE_KINDS.join(", ")}.`,
        input.valueKind,
      ),
    );
  }
  const valueKind = input.valueKind;
  if (
    !isFiniteNumber(input.min) ||
    !isFiniteNumber(input.max) ||
    !(input.min < input.max)
  ) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.geneInvalid,
        "A parameter gene's bounds must be finite numbers with min strictly below max.",
        { min: input.min, max: input.max },
      ),
    );
  }
  const min = input.min;
  const max = input.max;
  if (
    valueKind === "integer" &&
    (!Number.isInteger(min) || !Number.isInteger(max))
  ) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.geneInvalid,
        "An integer gene's bounds must be integers.",
        { min, max },
      ),
    );
  }
  let step: number | undefined;
  if (input.step !== undefined && input.step !== null) {
    if (!isFiniteNumber(input.step) || !(input.step > 0)) {
      return fail(
        studyError(
          STUDY_ERROR_CODES.geneInvalid,
          "A parameter gene's step must be a strictly positive finite number.",
          input.step,
        ),
      );
    }
    if (valueKind === "integer" && !Number.isInteger(input.step)) {
      return fail(
        studyError(
          STUDY_ERROR_CODES.geneInvalid,
          "An integer gene's step must be an integer.",
          input.step,
        ),
      );
    }
    step = input.step;
  }
  return ok(
    Object.freeze({
      kind: "parameter" as const,
      parameterId: parameterId.value,
      valueKind,
      min,
      max,
      ...(step === undefined ? {} : { step }),
    }),
  );
}

function buildDiscreteGene(
  input: unknown,
): ParseResult<SimStudyDiscreteGene, StudyError> {
  if (!isPlainRecord(input)) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.geneInvalid,
        "A discrete gene must be a plain object with recordKind and choices fields.",
        input,
      ),
    );
  }
  if (!isSimStudyGeneRecordKind(input.recordKind)) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.geneInvalid,
        `A discrete gene's recordKind must be one of: ${SIM_STUDY_GENE_RECORD_KINDS.join(", ")}.`,
        input.recordKind,
      ),
    );
  }
  if (!Array.isArray(input.choices) || input.choices.length < 2) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.geneInvalid,
        "A discrete gene must carry at least two choices (a one-choice gene is not a gene).",
        input.choices,
      ),
    );
  }
  if (input.choices.length > SIM_STUDY_MAX_GENES * 4) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.geneInvalid,
        `A discrete gene carries more than ${String(SIM_STUDY_MAX_GENES * 4)} choices.`,
        input.choices.length,
      ),
    );
  }
  const choices: MotorId[] = [];
  const seen = new Set<string>();
  for (const entry of input.choices) {
    const parsed = parseMotorId(entry);
    if (!parsed.ok) {
      return fail(
        studyError(
          STUDY_ERROR_CODES.geneInvalid,
          `A discrete gene's choice must be a valid motor id: ${parsed.error.message}`,
          entry,
        ),
      );
    }
    if (seen.has(parsed.value)) {
      return fail(
        studyError(
          STUDY_ERROR_CODES.geneInvalid,
          `A discrete gene's choices must be distinct; "${parsed.value}" repeats.`,
          input.choices,
        ),
      );
    }
    seen.add(parsed.value);
    choices.push(parsed.value);
  }
  return ok(
    Object.freeze({
      kind: "discrete" as const,
      recordKind: input.recordKind,
      choices: Object.freeze(choices),
    }),
  );
}

function buildGene(input: unknown): ParseResult<SimStudyGene, StudyError> {
  if (!isPlainRecord(input)) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.geneInvalid,
        "A gene must be a plain object discriminated by a kind field.",
        input,
      ),
    );
  }
  if (input.kind === "parameter") return buildParameterGene(input);
  if (input.kind === "discrete") return buildDiscreteGene(input);
  return fail(
    studyError(
      STUDY_ERROR_CODES.geneInvalid,
      'A gene\'s kind must be "parameter" or "discrete".',
      input.kind,
    ),
  );
}

function buildObjective(
  input: unknown,
): ParseResult<SimStudyObjective, StudyError> {
  if (!isPlainRecord(input)) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.objectiveInvalid,
        "An objective must be a plain object with quantity and direction fields.",
        input,
      ),
    );
  }
  if (
    typeof input.quantity !== "string" ||
    input.quantity.length === 0 ||
    input.quantity.length > SIM_STUDY_QUANTITY_MAX_LENGTH
  ) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.objectiveInvalid,
        `An objective's quantity must be a non-empty name of at most ${String(SIM_STUDY_QUANTITY_MAX_LENGTH)} characters.`,
        input.quantity,
      ),
    );
  }
  if (input.direction !== "minimize" && input.direction !== "maximize") {
    return fail(
      studyError(
        STUDY_ERROR_CODES.objectiveInvalid,
        `An objective's direction must be one of: ${SIM_STUDY_OBJECTIVE_DIRECTIONS.join(", ")}.`,
        input.direction,
      ),
    );
  }
  return ok(
    Object.freeze({
      quantity: input.quantity,
      direction: input.direction,
    }),
  );
}

/**
 * Builds a study's authored fields from untrusted-shaped input, applying
 * the documented defaults (a single-objective minimize GA on a one-gene
 * study is expressible with every algorithm field defaulted). Every
 * refusal is a structured `study/*` failure; the result is frozen.
 */
export function buildSimStudyBody(
  name: unknown,
  scenarioId: unknown,
  genes: unknown,
  objectives: unknown,
  constraints: unknown,
  population: unknown,
  generations: unknown,
  mutationRate: unknown,
  crossoverRate: unknown,
  seed: unknown,
  maxEvaluations: unknown,
): ParseResult<SimStudyBody, StudyError> {
  if (typeof name !== "string" || !isValidStudyName(name)) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.nameInvalid,
        "A study's name must be 1-64 characters after trimming.",
        name,
      ),
    );
  }
  const parsedScenarioId = parseSimulationId(scenarioId);
  if (!parsedScenarioId.ok) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.scenarioInvalid,
        `A study's scenarioId must be a valid simulation id: ${parsedScenarioId.error.message}`,
        scenarioId,
      ),
    );
  }
  if (genes !== undefined && genes !== null && !Array.isArray(genes)) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.geneInvalid,
        "A study's genes must be an array of gene records.",
        genes,
      ),
    );
  }
  const geneList = genes === undefined || genes === null ? [] : genes;
  if (geneList.length < 1 || geneList.length > SIM_STUDY_MAX_GENES) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.geneInvalid,
        `A study must carry 1-${String(SIM_STUDY_MAX_GENES)} genes.`,
        geneList.length,
      ),
    );
  }
  const builtGenes: SimStudyGene[] = [];
  const parameterGeneIds = new Set<string>();
  const discreteRecordKinds = new Set<string>();
  for (const entry of geneList) {
    const gene = buildGene(entry);
    if (!gene.ok) return gene;
    if (gene.value.kind === "parameter") {
      if (parameterGeneIds.has(gene.value.parameterId)) {
        return fail(
          studyError(
            STUDY_ERROR_CODES.geneInvalid,
            `A study's parameter genes must address distinct parameters; "${gene.value.parameterId}" repeats.`,
            gene.value.parameterId,
          ),
        );
      }
      parameterGeneIds.add(gene.value.parameterId);
    } else {
      if (discreteRecordKinds.has(gene.value.recordKind)) {
        return fail(
          studyError(
            STUDY_ERROR_CODES.geneInvalid,
            `A study may carry at most one discrete gene per record family; "${gene.value.recordKind}" repeats.`,
            gene.value.recordKind,
          ),
        );
      }
      discreteRecordKinds.add(gene.value.recordKind);
    }
    builtGenes.push(gene.value);
  }
  if (
    objectives !== undefined &&
    objectives !== null &&
    !Array.isArray(objectives)
  ) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.objectiveInvalid,
        "A study's objectives must be an array of objective records.",
        objectives,
      ),
    );
  }
  const objectiveList =
    objectives === undefined || objectives === null ? [] : objectives;
  if (
    objectiveList.length < 1 ||
    objectiveList.length > SIM_STUDY_MAX_OBJECTIVES
  ) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.objectiveInvalid,
        `A study must carry 1-${String(SIM_STUDY_MAX_OBJECTIVES)} objectives.`,
        objectiveList.length,
      ),
    );
  }
  const builtObjectives: SimStudyObjective[] = [];
  const quantities = new Set<string>();
  for (const entry of objectiveList) {
    const objective = buildObjective(entry);
    if (!objective.ok) return objective;
    if (quantities.has(objective.value.quantity)) {
      return fail(
        studyError(
          STUDY_ERROR_CODES.objectiveInvalid,
          `A study's objectives must select distinct quantities; "${objective.value.quantity}" repeats.`,
          objective.value.quantity,
        ),
      );
    }
    quantities.add(objective.value.quantity);
    builtObjectives.push(objective.value);
  }
  if (
    constraints !== undefined &&
    constraints !== null &&
    !Array.isArray(constraints)
  ) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.constraintInvalid,
        "A study's constraints must be an array of expression ASTs.",
        constraints,
      ),
    );
  }
  const constraintList =
    constraints === undefined || constraints === null ? [] : constraints;
  if (constraintList.length > SIM_STUDY_MAX_CONSTRAINTS) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.constraintInvalid,
        `A study carries more than ${String(SIM_STUDY_MAX_CONSTRAINTS)} constraints.`,
        constraintList.length,
      ),
    );
  }
  for (let index = 0; index < constraintList.length; index += 1) {
    const failure = validateConstraintNode(
      constraintList[index] as ExpressionNode,
      `constraints[${String(index)}]`,
    );
    if (failure !== undefined) return fail(failure);
  }
  const resolvedPopulation = resolveNumberField(
    population,
    SIM_STUDY_DEFAULT_POPULATION,
  );
  if (
    resolvedPopulation === undefined ||
    !Number.isInteger(resolvedPopulation) ||
    resolvedPopulation < 2 ||
    resolvedPopulation > SIM_STUDY_MAX_POPULATION
  ) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.algorithmInvalid,
        `A study's population must be an integer in [2, ${String(SIM_STUDY_MAX_POPULATION)}].`,
        population,
      ),
    );
  }
  const populationValue = resolvedPopulation;
  const resolvedGenerations = resolveNumberField(
    generations,
    SIM_STUDY_DEFAULT_GENERATIONS,
  );
  if (
    resolvedGenerations === undefined ||
    !Number.isInteger(resolvedGenerations) ||
    resolvedGenerations < 1 ||
    resolvedGenerations > SIM_STUDY_MAX_GENERATIONS
  ) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.algorithmInvalid,
        `A study's generations must be an integer in [1, ${String(SIM_STUDY_MAX_GENERATIONS)}].`,
        generations,
      ),
    );
  }
  const generationsValue = resolvedGenerations;
  const resolvedMutationRate = resolveNumberField(
    mutationRate,
    SIM_STUDY_DEFAULT_MUTATION_RATE,
  );
  if (
    resolvedMutationRate === undefined ||
    resolvedMutationRate < 0 ||
    resolvedMutationRate > 1
  ) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.algorithmInvalid,
        "A study's mutationRate must be a finite number in [0, 1].",
        mutationRate,
      ),
    );
  }
  const mutationRateValue = resolvedMutationRate;
  const resolvedCrossoverRate = resolveNumberField(
    crossoverRate,
    SIM_STUDY_DEFAULT_CROSSOVER_RATE,
  );
  if (
    resolvedCrossoverRate === undefined ||
    resolvedCrossoverRate < 0 ||
    resolvedCrossoverRate > 1
  ) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.algorithmInvalid,
        "A study's crossoverRate must be a finite number in [0, 1].",
        crossoverRate,
      ),
    );
  }
  const crossoverRateValue = resolvedCrossoverRate;
  const resolvedSeed = resolveNumberField(seed, SIM_STUDY_DEFAULT_SEED);
  if (
    resolvedSeed === undefined ||
    !Number.isInteger(resolvedSeed) ||
    resolvedSeed < 0 ||
    resolvedSeed > SIM_STUDY_MAX_SEED
  ) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.algorithmInvalid,
        `A study's seed must be an integer u32 in [0, ${String(SIM_STUDY_MAX_SEED)}].`,
        seed,
      ),
    );
  }
  const seedValue = resolvedSeed;
  const resolvedMaxEvaluations = resolveNumberField(
    maxEvaluations,
    populationValue * generationsValue,
  );
  if (
    resolvedMaxEvaluations === undefined ||
    !Number.isInteger(resolvedMaxEvaluations) ||
    resolvedMaxEvaluations < populationValue ||
    resolvedMaxEvaluations > SIM_STUDY_MAX_EVALUATIONS
  ) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.budgetInvalid,
        `A study's maxEvaluations must be an integer at least the population (${String(populationValue)}) and at most ${String(SIM_STUDY_MAX_EVALUATIONS)}.`,
        maxEvaluations,
      ),
    );
  }
  const maxEvaluationsValue = resolvedMaxEvaluations;
  return ok(
    Object.freeze({
      name,
      scenarioId: parsedScenarioId.value,
      genes: Object.freeze(builtGenes),
      objectives: Object.freeze(builtObjectives),
      constraints: Object.freeze(constraintList as readonly ExpressionNode[]),
      population: populationValue,
      generations: generationsValue,
      mutationRate: mutationRateValue,
      crossoverRate: crossoverRateValue,
      seed: seedValue,
      maxEvaluations: maxEvaluationsValue,
    }),
  );
}

/**
 * Resolves an optional numeric field: absent/null yields the fallback;
 * a finite number yields itself; ANYTHING ELSE yields `undefined`, which
 * the caller turns into its structured refusal (never a guessed default
 * for a malformed value).
 */
function resolveNumberField(
  input: unknown,
  fallback: number,
): number | undefined {
  if (input === undefined || input === null) return fallback;
  if (!isFiniteNumber(input)) return undefined;
  return input;
}

/** Canonical JSON form of a parameter gene; fixed key order. */
export interface SerializedSimStudyParameterGene {
  readonly kind: "parameter";
  readonly parameterId: string;
  readonly valueKind: SimStudyValueKind;
  readonly min: number;
  readonly max: number;
  readonly step?: number;
}

/** Canonical JSON form of a discrete gene; fixed key order. */
export interface SerializedSimStudyDiscreteGene {
  readonly kind: "discrete";
  readonly recordKind: SimStudyGeneRecordKind;
  readonly choices: readonly string[];
}

/** Canonical JSON form of a gene. */
export type SerializedSimStudyGene =
  SerializedSimStudyParameterGene | SerializedSimStudyDiscreteGene;

/** Canonical JSON form of an objective; fixed key order. */
export interface SerializedSimStudyObjective {
  readonly quantity: string;
  readonly direction: SimStudyObjectiveDirection;
}

/** Canonical JSON form of a study's authored fields; fixed key order. */
export interface SerializedSimStudyBody {
  readonly name: string;
  readonly scenarioId: string;
  readonly genes: readonly SerializedSimStudyGene[];
  readonly objectives: readonly SerializedSimStudyObjective[];
  readonly constraints: readonly ExpressionNode[];
  readonly population: number;
  readonly generations: number;
  readonly mutationRate: number;
  readonly crossoverRate: number;
  readonly seed: number;
  readonly maxEvaluations: number;
}

function serializeGene(gene: SimStudyGene): SerializedSimStudyGene {
  if (gene.kind === "parameter") {
    return {
      kind: "parameter",
      parameterId: gene.parameterId,
      valueKind: gene.valueKind,
      min: gene.min,
      max: gene.max,
      ...(gene.step === undefined ? {} : { step: gene.step }),
    };
  }
  return {
    kind: "discrete",
    recordKind: gene.recordKind,
    choices: [...gene.choices],
  };
}

/** Serializes a study's authored fields to the canonical, deterministic JSON form. */
export function serializeSimStudyBody(
  study: SimStudyBody,
): SerializedSimStudyBody {
  return {
    name: study.name,
    scenarioId: study.scenarioId,
    genes: study.genes.map(serializeGene),
    objectives: study.objectives.map((objective) => ({
      quantity: objective.quantity,
      direction: objective.direction,
    })),
    constraints: study.constraints.map((node) => node),
    population: study.population,
    generations: study.generations,
    mutationRate: study.mutationRate,
    crossoverRate: study.crossoverRate,
    seed: study.seed,
    maxEvaluations: study.maxEvaluations,
  };
}

/**
 * Serializes a study DRAFT (the command payload's model shape) to the
 * canonical form: the absent algorithm and budget fields serialize as
 * the same documented defaults {@link buildSimStudyBody} resolves, so a
 * serialized command and its replayed document row agree byte-for-byte
 * (the `serializeSimScenarioBody` gravity precedent).
 */
export function serializeSimStudyDraft(
  study: SimStudyDraft,
): SerializedSimStudyBody {
  const population = study.population ?? SIM_STUDY_DEFAULT_POPULATION;
  const generations = study.generations ?? SIM_STUDY_DEFAULT_GENERATIONS;
  return serializeSimStudyBody({
    name: study.name,
    scenarioId: study.scenarioId,
    genes: study.genes ?? [],
    objectives: study.objectives ?? [],
    constraints: study.constraints ?? [],
    population,
    generations,
    mutationRate: study.mutationRate ?? SIM_STUDY_DEFAULT_MUTATION_RATE,
    crossoverRate: study.crossoverRate ?? SIM_STUDY_DEFAULT_CROSSOVER_RATE,
    seed: study.seed ?? SIM_STUDY_DEFAULT_SEED,
    maxEvaluations: study.maxEvaluations ?? population * generations,
  });
}

/**
 * Parses untrusted input as a study's authored fields. Ids are validated
 * for wire shape; whether they name records the document owns is the
 * caller's (the cross-check below).
 */
export function parseSimStudyBody(
  input: unknown,
): ParseResult<SimStudyBody, StudyError> {
  if (!isPlainRecord(input)) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.malformed,
        "A serialized study must be a plain object with name and scenarioId fields.",
        input,
      ),
    );
  }
  return buildSimStudyBody(
    input.name,
    input.scenarioId,
    input.genes,
    input.objectives,
    input.constraints,
    input.population,
    input.generations,
    input.mutationRate,
    input.crossoverRate,
    input.seed,
    input.maxEvaluations,
  );
}

/** Canonical JSON form of a study record; fixed key order, additive discipline. */
export interface SerializedSimStudy extends SerializedSimStudyBody {
  readonly id: string;
}

/** Serializes a study record to its canonical, deterministic JSON form. */
export function serializeSimStudy(study: SimStudy): SerializedSimStudy {
  return { id: study.id, ...serializeSimStudyBody(study) };
}

/**
 * Parses untrusted input (e.g. a study revived from persisted JSON) as a
 * {@link SimStudy}: the id must be wire-valid and every authored field
 * parses through {@link parseSimStudyBody}.
 */
export function parseSimStudy(
  input: unknown,
): ParseResult<SimStudy, StudyError> {
  if (!isPlainRecord(input)) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.malformed,
        "A serialized study must be a plain object with an id field.",
        input,
      ),
    );
  }
  const parsedId = parseStudyId(input.id);
  if (!parsedId.ok) {
    return fail(
      studyError(
        STUDY_ERROR_CODES.idInvalid,
        `A study id must be a valid study id: ${parsedId.error.message}`,
        input.id,
      ),
    );
  }
  const body = parseSimStudyBody(input);
  if (!body.ok) return body;
  return ok(Object.freeze({ id: parsedId.value, ...body.value }));
}

/** Returns the study with the given id, or undefined. */
export function getSimStudy(
  studies: readonly SimStudy[],
  id: StudyId,
): SimStudy | undefined {
  return studies.find((study) => study.id === id);
}

// ---------------------------------------------------------------------------
// Cross-checks against the document's own records
// ---------------------------------------------------------------------------

/** The document data a study cross-checks against. */
export interface SimStudyCrossCheckInput {
  /** The document's parameter table (the gene addresses and constraint names). */
  readonly parameters: ParameterCollection;
  /** The document's motor records (the discrete gene's choices). */
  readonly motors: readonly DocumentMotorRecord[];
  /** The document's simulation scenarios (the study's run target). */
  readonly simulations: readonly SimScenario[];
}

/** One cross-check problem: the code, the message, and the offending value. */
export interface SimStudyCrossCheckProblem {
  readonly code: StudyErrorCode;
  readonly message: string;
  readonly input: unknown;
}

/**
 * Cross-checks a study against the document records it addresses: the
 * scenario must exist; every parameter gene must address an existing
 * LITERAL parameter (an expression-driven parameter is refused loudly —
 * the re-drive recompute would overwrite an override); every discrete
 * choice must name an existing record of its family; and every constraint
 * identifier must resolve to a parameter name. Returns the problem list —
 * empty means the study is runnable against this document.
 */
export function crossCheckSimStudy(
  study: SimStudyBody,
  input: SimStudyCrossCheckInput,
): readonly SimStudyCrossCheckProblem[] {
  const problems: SimStudyCrossCheckProblem[] = [];
  if (!input.simulations.some((scenario) => scenario.id === study.scenarioId)) {
    problems.push({
      code: STUDY_ERROR_CODES.scenarioInvalid,
      message: `The study addresses scenario "${study.scenarioId}", which this document does not own.`,
      input: study.scenarioId,
    });
  }
  const byName = new Map<string, Parameter>(
    input.parameters.parameters.map((parameter) => [parameter.name, parameter]),
  );
  for (const gene of study.genes) {
    if (gene.kind === "parameter") {
      const parameter = input.parameters.parameters.find(
        (candidate) => candidate.id === gene.parameterId,
      );
      if (parameter === undefined) {
        problems.push({
          code: STUDY_ERROR_CODES.parameterGeneUnknown,
          message: `The study's gene addresses parameter "${gene.parameterId}", which this document does not own.`,
          input: gene.parameterId,
        });
        continue;
      }
      if (parameter.expression !== null) {
        problems.push({
          code: STUDY_ERROR_CODES.parameterGeneExpressionDriven,
          message: `The study's gene addresses parameter "${parameter.name}", which is defined by an expression; only literal parameters are genes (the re-drive recompute would overwrite an override).`,
          input: gene.parameterId,
        });
      }
      continue;
    }
    for (const choice of gene.choices) {
      if (!input.motors.some((motor) => motor.id === choice)) {
        problems.push({
          code: STUDY_ERROR_CODES.choiceUnknown,
          message: `The study's discrete gene offers choice "${choice}", which this document's motors section does not own.`,
          input: choice,
        });
      }
    }
  }
  for (let index = 0; index < study.constraints.length; index += 1) {
    const constraint = study.constraints[index];
    if (constraint === undefined) continue;
    const names = constraintIdentifierNames(constraint);
    for (const name of names) {
      if (!byName.has(name)) {
        problems.push({
          code: STUDY_ERROR_CODES.constraintIdentifierUnknown,
          message: `The study's constraint ${String(index)} references "${name}", which is not a parameter of this document.`,
          input: name,
        });
      }
    }
  }
  return Object.freeze(problems);
}

/**
 * Walks a constraint AST collecting identifier names in deterministic
 * (depth-first, left-to-right) order. Local restatement of the dependency
 * walk `expression.ts` performs for parameters, shared here so the
 * cross-check reports the same name set the evaluator will resolve.
 */
function constraintIdentifierNames(node: ExpressionNode): readonly string[] {
  switch (node.kind) {
    case "identifier":
      return [node.name];
    case "unary":
      return constraintIdentifierNames(node.operand);
    case "binary":
      return [
        ...constraintIdentifierNames(node.left),
        ...constraintIdentifierNames(node.right),
      ];
    case "call":
      return node.args.flatMap((argument) =>
        constraintIdentifierNames(argument),
      );
    default:
      return [];
  }
}
