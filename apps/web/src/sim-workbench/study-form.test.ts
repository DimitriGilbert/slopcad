/**
 * The study form's tests (Phase 70b): the pure mapper pins — the genome
 * assembly (bounds sanity, the integer lattice, the optional second
 * gene, the discrete motor gene over the document's own records), the
 * objective list's distinctness rule, the constraint's parse boundary,
 * and the option builders' literal-parameter filter (the
 * `./structural-scenario-form` test precedent) — plus the FAN ORDERING
 * through the form component itself: a fresh fan document carries ONE
 * motor, the preset's LOAD path ensures the study motor before the form
 * maps, and the submit then saves (the Phase 70b validator's blocker —
 * the mapper refuses a one-choice discrete gene, so the ensure must
 * precede the map).
 */

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addDocumentSimulation,
  addDocumentStudy,
  createMotorId,
  createSimulationId,
  type SimStudyInput,
} from "@slopcad/cad-core";

import {
  STUDY_FORM_DEFAULT_VALUES,
  type StudyDraftProblem,
  StudyForm,
  type StudyValues,
  studyDraftOf,
  studyParameterOptions,
} from "./study-form";
import { bracketDemoDocument } from "./bracket-demo";
import { BRACKET_GENES } from "./bracket-study-demo";
import { fanDemoDocument } from "./fan-demo";
import {
  ensureFanStudyMotor,
  fanStudyInput,
  fanStudyScenarioDraft,
  fanWorkbenchDocument,
  FAN_STUDY_DEMO,
  FAN_STUDY_GENES,
} from "./fan-study-demo";

afterEach(cleanup);

/** The bracket demo values — the mass-vs-FoS preset the page boots. */
function bracketValues(): StudyValues {
  return {
    ...STUDY_FORM_DEFAULT_VALUES,
    name: "lightest-bracket",
    scenarioId: "sim_any",
    geneAParameterId: BRACKET_GENES.thickness,
    geneBEnabled: true,
    geneBParameterId: BRACKET_GENES.wallHeight,
    constraintEnabled: true,
    objectiveBEnabled: true,
  };
}

describe("the study form's option builders", () => {
  it("offers the document's LITERAL parameters only", () => {
    const literal = studyParameterOptions(bracketDemoDocument());
    expect(literal.map((option) => option.value)).toEqual([
      BRACKET_GENES.thickness,
      BRACKET_GENES.wallHeight,
    ]);
  });
});

describe("the study draft mapper", () => {
  it("assembles the bracket demo genome: two integer lattice genes, two objectives, the constraint", () => {
    const mapped = studyDraftOf(bracketValues(), bracketDemoDocument());
    if (!("draft" in mapped)) {
      throw new Error(
        `The bracket values refused: ${mapped.problems[0]?.message ?? ""}`,
      );
    }
    const genes = mapped.draft.genes ?? [];
    expect(genes).toEqual([
      {
        kind: "parameter",
        parameterId: BRACKET_GENES.thickness,
        valueKind: "integer",
        min: 4,
        max: 16,
        step: 2,
      },
      {
        kind: "parameter",
        parameterId: BRACKET_GENES.wallHeight,
        valueKind: "integer",
        min: 56,
        max: 88,
        step: 4,
      },
    ]);
    expect(mapped.draft.objectives).toEqual([
      { quantity: "mass", direction: "minimize" },
      { quantity: "factor-of-safety", direction: "maximize" },
    ]);
    expect(mapped.draft.constraints).toHaveLength(1);
  });

  it("refuses inverted bounds, non-integer integer bounds, a repeated gene parameter, and a repeated objective", () => {
    const document = bracketDemoDocument();
    const inverted = studyDraftOf(
      { ...bracketValues(), geneAMin: 20, geneAMax: 4 },
      document,
    );
    expect("problems" in inverted).toBe(true);
    const fractional = studyDraftOf(
      { ...bracketValues(), geneAMin: 4.5 },
      document,
    );
    expect("problems" in fractional).toBe(true);
    const repeatedGene = studyDraftOf(
      { ...bracketValues(), geneBParameterId: BRACKET_GENES.thickness },
      document,
    );
    expect("problems" in repeatedGene).toBe(true);
    const repeatedObjective = studyDraftOf(
      { ...bracketValues(), objectiveBQuantity: "mass" },
      document,
    );
    expect("problems" in repeatedObjective).toBe(true);
  });

  it("assembles the fan demo genome: a decimal gene with the motor gene, a single objective", () => {
    const withMotor = ensureFanStudyMotor(fanDemoDocument()).document;
    const mapped = studyDraftOf(
      {
        ...STUDY_FORM_DEFAULT_VALUES,
        name: "most-efficient-fan",
        scenarioId: "sim_any",
        geneAParameterId: FAN_STUDY_GENES.boreRadius,
        geneAKind: "decimal",
        geneAMin: 8,
        geneAMax: 12,
        geneAStep: 0.5,
        motorGeneEnabled: true,
        objectiveAQuantity: "airflow-per-electrical-watt",
        objectiveADirection: "maximize",
        maxEvaluations: 8,
      },
      withMotor,
    );
    if (!("draft" in mapped)) {
      throw new Error(
        `The fan values refused: ${mapped.problems[0]?.message ?? ""}`,
      );
    }
    const genes = mapped.draft.genes ?? [];
    expect(genes).toEqual([
      {
        kind: "parameter",
        parameterId: FAN_STUDY_GENES.boreRadius,
        valueKind: "decimal",
        min: 8,
        max: 12,
        step: 0.5,
      },
      {
        kind: "discrete",
        recordKind: "motor",
        choices: [
          createMotorId("mot_fan-demo"),
          createMotorId("mot_study-torquey"),
        ],
      },
    ]);
    expect(mapped.draft.objectives).toEqual([
      { quantity: "airflow-per-electrical-watt", direction: "maximize" },
    ]);
  });

  it("refuses a motor gene with fewer than two motor records and an unparseable constraint", () => {
    const motorGene = studyDraftOf(
      { ...STUDY_FORM_DEFAULT_VALUES, motorGeneEnabled: true },
      bracketDemoDocument(),
    );
    expect("problems" in motorGene).toBe(true);
    const badConstraint = studyDraftOf(
      { ...bracketValues(), constraintExpression: "12 * " },
      bracketDemoDocument(),
    );
    expect("problems" in badConstraint).toBe(true);
  });

  it("drops the lattice step when it is zero (the continuous gene)", () => {
    const mapped = studyDraftOf(
      { ...bracketValues(), geneAStep: 0 },
      bracketDemoDocument(),
    );
    if (!("draft" in mapped)) {
      throw new Error(
        `The continuous values refused: ${mapped.problems[0]?.message ?? ""}`,
      );
    }
    const firstGene = mapped.draft.genes?.[0];
    expect(firstGene).toMatchObject({
      kind: "parameter",
      valueKind: "integer",
      min: 4,
      max: 16,
    });
    expect(firstGene === undefined || "step" in firstGene).toBe(false);
  });
});

describe("the study form's fan ordering (the page's actual path)", () => {
  /**
   * The fan preset's form values — the page's `studyDefaults` for the
   * fan model (the bore gene, the motor gene, the air-per-watt
   * objective, the demo budget), derived from the fixture constants.
   */
  function fanPresetValues(scenarioId: string): StudyValues {
    return {
      ...STUDY_FORM_DEFAULT_VALUES,
      name: "most-efficient-fan",
      scenarioId,
      geneAParameterId: FAN_STUDY_GENES.boreRadius,
      geneAKind: "decimal",
      geneAMin: FAN_STUDY_DEMO.boreMin,
      geneAMax: FAN_STUDY_DEMO.boreMax,
      geneAStep: FAN_STUDY_DEMO.boreStep,
      geneBEnabled: false,
      motorGeneEnabled: true,
      objectiveAQuantity: "airflow-per-electrical-watt",
      objectiveADirection: "maximize",
      objectiveBEnabled: false,
      population: FAN_STUDY_DEMO.population,
      generations: FAN_STUDY_DEMO.generations,
      seed: FAN_STUDY_DEMO.seed,
      maxEvaluations: FAN_STUDY_DEMO.population * FAN_STUDY_DEMO.generations,
    };
  }

  it("refuses the motor gene over the FRESH fan document — the ensure must precede the map", async () => {
    // The fresh demo document carries ONE motor: submitting the fan
    // preset against it is exactly what the broken ordering produced —
    // the mapper refuses inside the form's own submit, and nothing saves.
    const submitted = vi.fn<(draft: SimStudyInput) => void>();
    const problems = vi.fn((values: readonly StudyDraftProblem[]) => values);
    render(
      createElement(StudyForm, {
        document: fanDemoDocument(),
        defaultValues: fanPresetValues("sim_any"),
        onSubmitStudy: submitted,
        onProblems: problems,
      }),
    );
    await waitFor(() => {
      fireEvent.click(screen.getByRole("button", { name: "Save study" }));
    });
    await waitFor(() => {
      expect(problems).toHaveBeenCalledTimes(1);
    });
    expect(submitted).not.toHaveBeenCalled();
    const reported = problems.mock.calls[0]?.[0] ?? [];
    expect(
      reported.some((problem) => problem.field === "motorGeneEnabled"),
    ).toBe(true);
  });

  it("saves the fan study through the preset-load document: fresh fan document → StudyForm → submit → saved", async () => {
    // THE PAGE'S FAN PRESET LOAD PATH: `fanWorkbenchDocument` is the
    // derivation SimWorkbenchPage's demo-model switch loads — the study
    // motor ensured BEFORE the form maps (no test-side pre-ensure beyond
    // the production one).
    const withScenario = addDocumentSimulation(fanWorkbenchDocument(), {
      id: createSimulationId("sim_fan-study"),
      ...fanStudyScenarioDraft(),
    });
    if (!withScenario.ok) {
      throw new Error(
        `The fan study scenario refused: ${withScenario.error.message}`,
      );
    }
    const submitted = vi.fn<(draft: SimStudyInput) => void>();
    render(
      createElement(StudyForm, {
        document: withScenario.value.document,
        defaultValues: fanPresetValues(String(withScenario.value.scenario.id)),
        onSubmitStudy: submitted,
      }),
    );
    await waitFor(() => {
      fireEvent.click(screen.getByRole("button", { name: "Save study" }));
    });
    await waitFor(() => {
      expect(submitted).toHaveBeenCalledTimes(1);
    });
    const draft = submitted.mock.calls[0]?.[0];
    if (draft === undefined) {
      throw new Error("The study form never submitted a draft.");
    }
    // The saved row: the document boundary accepts the mapped draft, and
    // the genome is the demo input's own (the bore + the motor pair).
    const added = addDocumentStudy(withScenario.value.document, draft);
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.value.study.name).toBe("most-efficient-fan");
    expect(added.value.study.genes).toEqual(
      fanStudyInput(withScenario.value.scenario.id).genes,
    );
    expect(added.value.document.motors.map((motor) => motor.id)).toEqual([
      createMotorId("mot_fan-demo"),
      createMotorId("mot_study-torquey"),
    ]);
  });
});
