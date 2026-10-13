/**
 * The optimization-study authoring form (Phase 70b): a Formedible
 * CONFIG OBJECT — zod schema + field list + options — never a
 * hand-rolled TSX form (the working-agreement law), the
 * `./structural-scenario-form` precedent applied to studies. The form
 * authors the demo-scale genome the two named demos need: up to TWO
 * parameter genes with bounds (the document's own LITERAL parameter
 * table, an expression-driven parameter is refused at the document
 * boundary and never offered), ONE discrete motor gene (a choice among
 * the document's motor records), up to TWO objectives with directions,
 * ONE parameter-expression constraint, and the NSGA-II algorithm and
 * budget fields. The genome-coordinate order is fixed: gene A, gene B,
 * then the motor gene (the record order the engine addresses genes by).
 *
 * Submission maps the flat form values onto a cad-core
 * {@link SimStudyInput} through the pure {@link studyDraftOf} — the
 * mapper the config tests pin (bounds sanity, the integer/decimal
 * kinds, the lattice step's optionality, the constraint's parse).
 */

import {
  type CadDocument,
  type ExpressionNode,
  type ParameterId,
  type SimStudyGene,
  type SimStudyInput,
  type SimStudyObjective,
  parseExpression,
} from "@slopcad/cad-core";
import { useFormedible } from "@slopcad/ui/components/formedible/hooks/use-formedible";
import type { FormedibleFieldConfig } from "@slopcad/ui/components/formedible/lib/types";
import type { ReactElement } from "react";
import { z } from "zod";

/** The objective directions, the study vocabulary verbatim. */
export const STUDY_DIRECTION_OPTIONS = [
  { value: "minimize", label: "Minimize" },
  { value: "maximize", label: "Maximize" },
] as const;

/** The gene number lines. */
export const STUDY_VALUE_KIND_OPTIONS = [
  { value: "integer", label: "Integer (a lattice)" },
  { value: "decimal", label: "Decimal (continuous)" },
] as const;

/**
 * The objective quantity vocabulary the panel offers — the summary
 * scalar families the engines actually project (the guide's studies
 * section documents the same list): the Phase 69 structural family, the
 * Phase 63/66 flow and fan families, and the Phase 70 air-per-watt
 * system objective.
 */
export const STUDY_QUANTITY_OPTIONS = [
  { value: "mass", label: "mass (kg, structural)" },
  { value: "factor-of-safety", label: "factor of safety (structural)" },
  { value: "max-deflection", label: "max deflection (mm, structural)" },
  { value: "von-mises-max", label: "von Mises max (Pa, structural)" },
  { value: "mean-drag-force", label: "mean drag (N, flow)" },
  { value: "mean-lift-force", label: "mean lift (N, flow)" },
  { value: "operating-rpm", label: "operating rpm (fan)" },
  { value: "airflow", label: "airflow (m³/s, fan)" },
  { value: "pressure-rise", label: "pressure rise (Pa, fan)" },
  { value: "electrical-power", label: "electrical power (W, fan)" },
  {
    value: "airflow-per-electrical-watt",
    label: "airflow per electrical watt (m³/J, fan)",
  },
] as const;

/**
 * The document's LITERAL parameters, in table order (the gene
 * candidates — an expression-driven parameter is refused as a gene and
 * never offered).
 */
export function studyParameterOptions(document: CadDocument) {
  return document.parameters.parameters
    .filter((parameter) => parameter.expression === null)
    .map((parameter) => ({
      value: parameter.id,
      label: `${parameter.name} (${parameter.id})`,
    }));
}

/** The document's scenarios, in section order (the study's run target). */
export function studyScenarioOptions(document: CadDocument) {
  return document.simulations.map((scenario) => ({
    value: scenario.id,
    label: `${scenario.name} (${scenario.kind})`,
  }));
}

const finite = z.number();

export const studySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Give the study a name")
    .max(64, "Keep the name under 64 characters"),
  scenarioId: z.string().min(1, "Pick the scenario every candidate runs"),
  geneAParameterId: z.string().min(1, "Pick the first gene's parameter"),
  geneAKind: z.enum(["integer", "decimal"]),
  geneAMin: finite,
  geneAMax: finite,
  geneAStep: finite,
  geneBEnabled: z.boolean(),
  geneBParameterId: z.string(),
  geneBKind: z.enum(["integer", "decimal"]),
  geneBMin: finite,
  geneBMax: finite,
  geneBStep: finite,
  motorGeneEnabled: z.boolean(),
  objectiveAQuantity: z.string().min(1, "Pick the first objective"),
  objectiveADirection: z.enum(["minimize", "maximize"]),
  objectiveBEnabled: z.boolean(),
  objectiveBQuantity: z.string(),
  objectiveBDirection: z.enum(["minimize", "maximize"]),
  constraintEnabled: z.boolean(),
  constraintExpression: z.string(),
  population: z.number().int().min(2).max(512),
  generations: z.number().int().min(1).max(512),
  seed: z.number().int().min(0).max(4_294_967_295),
  mutationRate: finite,
  crossoverRate: finite,
  maxEvaluations: z.number().int().min(2).max(1_000_000),
});

export type StudyValues = z.infer<typeof studySchema>;

/** The boot values: a one-gene single-objective study, every knob default. */
export const STUDY_FORM_DEFAULT_VALUES: StudyValues = {
  name: "study",
  scenarioId: "",
  geneAParameterId: "",
  geneAKind: "integer",
  geneAMin: 4,
  geneAMax: 16,
  geneAStep: 2,
  geneBEnabled: false,
  geneBParameterId: "",
  geneBKind: "integer",
  geneBMin: 56,
  geneBMax: 88,
  geneBStep: 4,
  motorGeneEnabled: false,
  objectiveAQuantity: "mass",
  objectiveADirection: "minimize",
  objectiveBEnabled: false,
  objectiveBQuantity: "factor-of-safety",
  objectiveBDirection: "maximize",
  constraintEnabled: false,
  constraintExpression: "12 * thickness - wallHeight",
  population: 6,
  generations: 3,
  seed: 7,
  mutationRate: 0.25,
  crossoverRate: 0.9,
  maxEvaluations: 18,
};

/** The form's field list — one entry per schema key, in panel order. */
export function studyFields(
  parameters: ReturnType<typeof studyParameterOptions>,
  scenarios: ReturnType<typeof studyScenarioOptions>,
  motorChoiceCount: number,
): readonly FormedibleFieldConfig<StudyValues>[] {
  return [
    { name: "name", type: "text", label: "Study name", required: true },
    {
      name: "scenarioId",
      type: "select",
      label: "Scenario (every candidate runs it)",
      required: true,
      options: scenarios,
    },
    {
      name: "geneAParameterId",
      type: "select",
      label: "Gene A — parameter",
      required: true,
      options: parameters,
    },
    {
      name: "geneAKind",
      type: "select",
      label: "Gene A — number line",
      required: true,
      options: STUDY_VALUE_KIND_OPTIONS,
    },
    { name: "geneAMin", type: "number", label: "Gene A — min", required: true },
    { name: "geneAMax", type: "number", label: "Gene A — max", required: true },
    {
      name: "geneAStep",
      type: "number",
      label: "Gene A — lattice step (0 = continuous)",
      required: true,
    },
    {
      name: "geneBEnabled",
      type: "checkbox",
      label: "Gene B — a second parameter gene",
    },
    {
      name: "geneBParameterId",
      type: "select",
      label: "Gene B — parameter",
      required: true,
      options: parameters,
      conditional: "geneBEnabled",
    },
    {
      name: "geneBKind",
      type: "select",
      label: "Gene B — number line",
      required: true,
      options: STUDY_VALUE_KIND_OPTIONS,
      conditional: "geneBEnabled",
    },
    {
      name: "geneBMin",
      type: "number",
      label: "Gene B — min",
      required: true,
      conditional: "geneBEnabled",
    },
    {
      name: "geneBMax",
      type: "number",
      label: "Gene B — max",
      required: true,
      conditional: "geneBEnabled",
    },
    {
      name: "geneBStep",
      type: "number",
      label: "Gene B — lattice step (0 = continuous)",
      required: true,
      conditional: "geneBEnabled",
    },
    {
      name: "motorGeneEnabled",
      type: "checkbox",
      label: `Motor gene — a choice among the document's ${String(motorChoiceCount)} motor records`,
      description:
        "An enum-valued gene: every candidate selects one motor record (fan co-optimization — the motor is a gene).",
    },
    {
      name: "objectiveAQuantity",
      type: "select",
      label: "Objective A — quantity",
      required: true,
      options: STUDY_QUANTITY_OPTIONS,
    },
    {
      name: "objectiveADirection",
      type: "select",
      label: "Objective A — direction",
      required: true,
      options: STUDY_DIRECTION_OPTIONS,
    },
    {
      name: "objectiveBEnabled",
      type: "checkbox",
      label: "Objective B — a second objective (the Pareto axis)",
    },
    {
      name: "objectiveBQuantity",
      type: "select",
      label: "Objective B — quantity",
      required: true,
      options: STUDY_QUANTITY_OPTIONS,
      conditional: "objectiveBEnabled",
    },
    {
      name: "objectiveBDirection",
      type: "select",
      label: "Objective B — direction",
      required: true,
      options: STUDY_DIRECTION_OPTIONS,
      conditional: "objectiveBEnabled",
    },
    {
      name: "constraintEnabled",
      type: "checkbox",
      label: "Constraint — one parameter expression",
      description:
        "Holds when it evaluates strictly positive (e.g. 12 * thickness - wallHeight); a violated candidate declines and sinks, never crashes.",
    },
    {
      name: "constraintExpression",
      type: "text",
      label: "Constraint expression",
      required: true,
      conditional: "constraintEnabled",
    },
    { name: "population", type: "number", label: "Population", required: true },
    {
      name: "generations",
      type: "number",
      label: "Generations",
      required: true,
    },
    {
      name: "seed",
      type: "number",
      label: "Seed (determinism)",
      required: true,
    },
    {
      name: "mutationRate",
      type: "number",
      label: "Mutation rate",
      required: true,
    },
    {
      name: "crossoverRate",
      type: "number",
      label: "Crossover rate",
      required: true,
    },
    {
      name: "maxEvaluations",
      type: "number",
      label: "Evaluation budget",
      required: true,
    },
  ];
}

/** The pure mapper's failure: a field key plus the human message. */
export interface StudyDraftProblem {
  readonly field: string;
  readonly message: string;
}

/**
 * Maps the form's values onto the study input the document boundary
 * consumes: the genome in coordinate order (gene A, gene B, the motor
 * gene), the objective list, the parsed constraint AST, and the
 * algorithm and budget fields. Pure — the config tests pin every
 * refusal (bounds sanity, the integer lattice, the expression parse).
 */
export function studyDraftOf(
  values: StudyValues,
  document: CadDocument,
):
  | { readonly draft: SimStudyInput }
  | { readonly problems: readonly StudyDraftProblem[] } {
  const problems: StudyDraftProblem[] = [];
  const genes: SimStudyGene[] = [];
  const pushParameterGene = (
    key: string,
    parameterId: string,
    kind: StudyValues["geneAKind"],
    min: number,
    max: number,
    step: number,
  ): void => {
    if (!(min < max)) {
      problems.push({
        field: key,
        message: "The gene's min must be strictly below its max.",
      });
      return;
    }
    if (
      kind === "integer" &&
      (!Number.isInteger(min) || !Number.isInteger(max))
    ) {
      problems.push({
        field: key,
        message: "An integer gene's bounds must be integers.",
      });
      return;
    }
    let lattice: { readonly step: number } | undefined;
    if (step > 0) {
      if (kind === "integer" && !Number.isInteger(step)) {
        problems.push({
          field: key,
          message: "An integer gene's step must be an integer.",
        });
        return;
      }
      lattice = { step };
    }
    genes.push({
      kind: "parameter",
      parameterId: parameterId as ParameterId,
      valueKind: kind,
      min,
      max,
      ...(lattice === undefined ? {} : lattice),
    });
  };
  pushParameterGene(
    "geneA",
    values.geneAParameterId,
    values.geneAKind,
    values.geneAMin,
    values.geneAMax,
    values.geneAStep,
  );
  if (values.geneBEnabled) {
    if (values.geneBParameterId === values.geneAParameterId) {
      problems.push({
        field: "geneB",
        message: "Gene B must address a different parameter than gene A.",
      });
    } else {
      pushParameterGene(
        "geneB",
        values.geneBParameterId,
        values.geneBKind,
        values.geneBMin,
        values.geneBMax,
        values.geneBStep,
      );
    }
  }
  if (values.motorGeneEnabled) {
    if (document.motors.length < 2) {
      problems.push({
        field: "motorGeneEnabled",
        message:
          "A discrete motor gene needs at least two motor records to choose among.",
      });
    } else {
      genes.push({
        kind: "discrete",
        recordKind: "motor",
        choices: document.motors.map((motor) => motor.id),
      });
    }
  }
  const objectives: SimStudyObjective[] = [
    {
      quantity: values.objectiveAQuantity,
      direction: values.objectiveADirection,
    },
  ];
  if (values.objectiveBEnabled) {
    if (values.objectiveBQuantity === values.objectiveAQuantity) {
      problems.push({
        field: "objectiveBQuantity",
        message: "Objective B must select a different quantity than A.",
      });
    } else {
      objectives.push({
        quantity: values.objectiveBQuantity,
        direction: values.objectiveBDirection,
      });
    }
  }
  let constraints: readonly ExpressionNode[] = [];
  if (values.constraintEnabled) {
    const parsed = parseExpression(values.constraintExpression);
    if (!parsed.ok) {
      problems.push({
        field: "constraintExpression",
        message: `The constraint did not parse: ${parsed.error.message}`,
      });
    } else {
      constraints = [parsed.value];
    }
  }
  if (problems.length > 0) return { problems };
  return {
    draft: {
      name: values.name.trim(),
      scenarioId: values.scenarioId as SimStudyInput["scenarioId"],
      genes,
      objectives,
      constraints,
      population: values.population,
      generations: values.generations,
      mutationRate: values.mutationRate,
      crossoverRate: values.crossoverRate,
      seed: values.seed,
      maxEvaluations: values.maxEvaluations,
    },
  };
}

/** The optimization-study form: config object in, typed draft out. */
export function StudyForm({
  document,
  defaultValues,
  onSubmitStudy,
  onProblems,
  submitLabel = "Save study",
}: {
  /** The working document the study's records address. */
  readonly document: CadDocument;
  /** The boot values (the demo presets restated; the mapper's defaults otherwise). */
  readonly defaultValues: StudyValues;
  readonly onSubmitStudy: (draft: SimStudyInput) => void | Promise<void>;
  /** Receives the mapper's refusals (the page's error surface). */
  readonly onProblems?: (problems: readonly StudyDraftProblem[]) => void;
  readonly submitLabel?: string;
}): ReactElement {
  const parameters = studyParameterOptions(document);
  const scenarios = studyScenarioOptions(document);
  const form = useFormedible<StudyValues>({
    schema: studySchema,
    fields: studyFields(parameters, scenarios, document.motors.length),
    formOptions: {
      defaultValues,
      onSubmit: async ({ value }) => {
        const mapped = studyDraftOf(value, document);
        if ("problems" in mapped) {
          onProblems?.(mapped.problems);
          return;
        }
        await onSubmitStudy(mapped.draft);
      },
    },
    resetOnSubmitSuccess: false,
    submitLabel,
  });
  return <form.Form aria-label="Optimization study" className="space-y-2" />;
}
