import { describe, expect, it } from "vitest";

import {
  addParameter,
  buildDocumentMotorBody,
  buildSimScenarioBody,
  buildSimStudyBody,
  type Parameter,
  type ParameterCollection,
  type ParseResult,
  createMotorId,
  createParameterId,
  createSimulationId,
  createStudyId,
  crossCheckSimStudy,
  dimensionless,
  EMPTY_PARAMETER_COLLECTION,
  type ExpressionNode,
  length,
  parseExpression,
  parseSimStudy,
  parseSimStudyBody,
  serializeSimStudy,
  serializeSimStudyBody,
  type SimStudyBody,
  STUDY_ERROR_CODES,
  type StudyError,
} from "./index";

const scenarioId = createSimulationId("sim_wind-tunnel");
const widthId = createParameterId("param_width");
const heightId = createParameterId("param_height");
const derivedId = createParameterId("param_derived");
const motorA = createMotorId("mot_torquey");
const motorB = createMotorId("mot_speedy");
const motorC = createMotorId("mot_tiny");

function parse(source: string): ExpressionNode {
  const parsed = parseExpression(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

function collectionWith(
  ...parameters: readonly Parameter[]
): ParameterCollection {
  let collection: ParameterCollection = EMPTY_PARAMETER_COLLECTION;
  for (const parameter of parameters) {
    const added = addParameter(collection, parameter);
    if (!added.ok) throw new Error(added.error.message);
    collection = added.value;
  }
  return collection;
}

function literalParameters(): ParameterCollection {
  return collectionWith(
    {
      id: widthId,
      name: "width",
      value: length(30),
      expression: null,
      metadata: {},
    },
    {
      id: heightId,
      name: "height",
      value: length(12),
      expression: null,
      metadata: {},
    },
  );
}

function expressionDrivenParameters(): ParameterCollection {
  return collectionWith(
    {
      id: widthId,
      name: "width",
      value: length(30),
      expression: null,
      metadata: {},
    },
    {
      id: heightId,
      name: "height",
      value: length(12),
      expression: null,
      metadata: {},
    },
    {
      id: derivedId,
      name: "derived",
      value: length(10),
      expression: parse("width / 2"),
      metadata: {},
    },
  );
}

function motors() {
  const a = buildDocumentMotorBody(
    "torquey",
    "dc-brushed",
    80,
    4000,
    12,
    undefined,
    undefined,
  );
  if (!a.ok) throw new Error(a.error.message);
  const b = buildDocumentMotorBody(
    "speedy",
    "bldc",
    20,
    20000,
    24,
    undefined,
    undefined,
  );
  if (!b.ok) throw new Error(b.error.message);
  return [
    { ...a.value, id: motorA },
    { ...b.value, id: motorB },
  ];
}

function scenario() {
  const built = buildSimScenarioBody(
    "wind-tunnel",
    "flow",
    {
      kind: "explicit",
      min: [-100, -50, -50],
      max: [100, 50, 50],
      resolutionMm: 4,
    },
    [],
    "air",
    [],
    [0, -9.80665, 0],
    undefined,
    undefined,
    120,
    undefined,
  );
  if (!built.ok) throw new Error(built.error.message);
  return built.value;
}

const widthGene = {
  kind: "parameter" as const,
  parameterId: widthId,
  valueKind: "decimal" as const,
  min: 5,
  max: 60,
};

const massObjective = { quantity: "mass", direction: "minimize" as const };

function expectFail(
  result: ParseResult<SimStudyBody, StudyError>,
  code: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok || result.error === undefined) {
    throw new Error("expected failure");
  }
  expect(result.error.code).toBe(code);
}

/** The build boundary with the six algorithm/budget fields defaulted. */
function build(
  name: unknown,
  scenarioIdOfStudy: unknown,
  genes: unknown,
  objectives: unknown,
  constraints: unknown,
): ParseResult<SimStudyBody, StudyError> {
  return buildSimStudyBody(
    name,
    scenarioIdOfStudy,
    genes,
    objectives,
    constraints,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
  );
}

/** Narrows a successful build result or fails the test with its message. */
function buildOk(result: ParseResult<SimStudyBody, StudyError>): SimStudyBody {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("the SimStudy record", () => {
  it("builds with defaults and freezes", () => {
    const value = buildOk(
      build("lightest bracket", scenarioId, [widthGene], [massObjective], []),
    );
    expect(value.population).toBe(20);
    expect(value.generations).toBe(12);
    expect(value.mutationRate).toBe(0.25);
    expect(value.crossoverRate).toBe(0.9);
    expect(value.seed).toBe(0);
    expect(value.maxEvaluations).toBe(240);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.genes)).toBe(true);
  });

  it("round-trips serialize → parse byte-identically", () => {
    const study = {
      ...buildOk(
        buildSimStudyBody(
          "efficient fan",
          scenarioId,
          [
            {
              kind: "parameter",
              parameterId: widthId,
              valueKind: "integer",
              min: 4,
              max: 40,
              step: 2,
            },
            {
              kind: "discrete",
              recordKind: "motor",
              choices: [motorA, motorB],
            },
          ],
          [
            { quantity: "mass", direction: "minimize" },
            { quantity: "airPerWatt", direction: "maximize" },
          ],
          [parse("width - 5mm")],
          16,
          8,
          0.5,
          0.8,
          123456,
          128,
        ),
      ),
      id: createStudyId("study_fan"),
    };
    const serialized = serializeSimStudy(study);
    expect(JSON.stringify(serializeSimStudy(study))).toBe(
      JSON.stringify(serialized),
    );
    expect(JSON.stringify(serialized.genes[1])).toBe(
      '{"kind":"discrete","recordKind":"motor","choices":["mot_torquey","mot_speedy"]}',
    );
    const parsed = parseSimStudy(JSON.parse(JSON.stringify(serialized)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(JSON.stringify(serializeSimStudy(parsed.value))).toBe(
      JSON.stringify(serialized),
    );
  });

  it("refuses the documented invalid inputs with stable codes", () => {
    expectFail(
      build("", scenarioId, [widthGene], [massObjective], []),
      STUDY_ERROR_CODES.nameInvalid,
    );
    expectFail(
      build("x", "not-an-id", [widthGene], [massObjective], []),
      STUDY_ERROR_CODES.scenarioInvalid,
    );
    expectFail(
      build("x", scenarioId, [], [massObjective], []),
      STUDY_ERROR_CODES.geneInvalid,
    );
    expectFail(
      build(
        "x",
        scenarioId,
        [{ ...widthGene, min: 60, max: 5 }],
        [massObjective],
        [],
      ),
      STUDY_ERROR_CODES.geneInvalid,
    );
    expectFail(
      build(
        "x",
        scenarioId,
        [{ ...widthGene, valueKind: "integer", min: 0.5, max: 4 }],
        [massObjective],
        [],
      ),
      STUDY_ERROR_CODES.geneInvalid,
    );
    expectFail(
      build("x", scenarioId, [{ ...widthGene, step: 0 }], [massObjective], []),
      STUDY_ERROR_CODES.geneInvalid,
    );
    expectFail(
      build("x", scenarioId, [widthGene, widthGene], [massObjective], []),
      STUDY_ERROR_CODES.geneInvalid,
    );
    expectFail(
      build(
        "x",
        scenarioId,
        [{ kind: "discrete", recordKind: "motor", choices: [motorA] }],
        [massObjective],
        [],
      ),
      STUDY_ERROR_CODES.geneInvalid,
    );
    expectFail(
      build(
        "x",
        scenarioId,
        [
          { kind: "discrete", recordKind: "motor", choices: [motorA, motorB] },
          { kind: "discrete", recordKind: "motor", choices: [motorA, motorC] },
        ],
        [massObjective],
        [],
      ),
      STUDY_ERROR_CODES.geneInvalid,
    );
    expectFail(
      build("x", scenarioId, [widthGene], [], []),
      STUDY_ERROR_CODES.objectiveInvalid,
    );
    expectFail(
      build(
        "x",
        scenarioId,
        [widthGene],
        [
          { quantity: "mass", direction: "minimize" },
          { quantity: "mass", direction: "maximize" },
        ],
        [],
      ),
      STUDY_ERROR_CODES.objectiveInvalid,
    );
    expectFail(
      build(
        "x",
        scenarioId,
        [widthGene],
        [{ quantity: "mass", direction: "sideways" }],
        [],
      ),
      STUDY_ERROR_CODES.objectiveInvalid,
    );
    expectFail(
      build("x", scenarioId, [widthGene], [massObjective], [{}]),
      STUDY_ERROR_CODES.constraintInvalid,
    );
    expectFail(
      buildSimStudyBody(
        "x",
        scenarioId,
        [widthGene],
        [massObjective],
        [],
        1,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
      STUDY_ERROR_CODES.algorithmInvalid,
    );
    expectFail(
      buildSimStudyBody(
        "x",
        scenarioId,
        [widthGene],
        [massObjective],
        [],
        undefined,
        undefined,
        1.5,
        undefined,
        undefined,
        undefined,
      ),
      STUDY_ERROR_CODES.algorithmInvalid,
    );
    expectFail(
      buildSimStudyBody(
        "x",
        scenarioId,
        [widthGene],
        [massObjective],
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        -1,
        undefined,
      ),
      STUDY_ERROR_CODES.algorithmInvalid,
    );
    expectFail(
      buildSimStudyBody(
        "x",
        scenarioId,
        [widthGene],
        [massObjective],
        [],
        10,
        undefined,
        undefined,
        undefined,
        undefined,
        5,
      ),
      STUDY_ERROR_CODES.budgetInvalid,
    );
  });

  it("refuses a present-but-non-number algorithm field, never a guessed default", () => {
    expectFail(
      buildSimStudyBody(
        "x",
        scenarioId,
        [widthGene],
        [massObjective],
        [],
        "twelve",
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
      ),
      STUDY_ERROR_CODES.algorithmInvalid,
    );
    expectFail(
      buildSimStudyBody(
        "x",
        scenarioId,
        [widthGene],
        [massObjective],
        [],
        undefined,
        "many",
        undefined,
        undefined,
        undefined,
        undefined,
      ),
      STUDY_ERROR_CODES.algorithmInvalid,
    );
    expectFail(
      buildSimStudyBody(
        "x",
        scenarioId,
        [widthGene],
        [massObjective],
        [],
        undefined,
        undefined,
        "fast",
        undefined,
        undefined,
        undefined,
      ),
      STUDY_ERROR_CODES.algorithmInvalid,
    );
    expectFail(
      buildSimStudyBody(
        "x",
        scenarioId,
        [widthGene],
        [massObjective],
        [],
        undefined,
        undefined,
        undefined,
        true,
        undefined,
        undefined,
      ),
      STUDY_ERROR_CODES.algorithmInvalid,
    );
    expectFail(
      buildSimStudyBody(
        "x",
        scenarioId,
        [widthGene],
        [massObjective],
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        "seven",
        undefined,
      ),
      STUDY_ERROR_CODES.algorithmInvalid,
    );
    expectFail(
      buildSimStudyBody(
        "x",
        scenarioId,
        [widthGene],
        [massObjective],
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        "lots",
      ),
      STUDY_ERROR_CODES.budgetInvalid,
    );
    // The same refusal rides the parse (wire) boundary: a non-finite
    // number is as malformed as a string.
    expectFail(
      parseSimStudyBody({
        name: "x",
        scenarioId,
        genes: [widthGene],
        objectives: [massObjective],
        population: Number.NaN,
      }),
      STUDY_ERROR_CODES.algorithmInvalid,
    );
    expectFail(
      parseSimStudy({
        id: "study_wire",
        name: "x",
        scenarioId,
        genes: [widthGene],
        objectives: [massObjective],
        mutationRate: Number.POSITIVE_INFINITY,
      }),
      STUDY_ERROR_CODES.algorithmInvalid,
    );
    // Absent and null still take the documented defaults.
    const defaulted = parseSimStudyBody({
      name: "x",
      scenarioId,
      genes: [widthGene],
      objectives: [massObjective],
      population: null,
      mutationRate: null,
      seed: null,
    });
    expect(defaulted.ok).toBe(true);
    if (!defaulted.ok) return;
    expect(defaulted.value.population).toBe(20);
    expect(defaulted.value.mutationRate).toBe(0.25);
    expect(defaulted.value.seed).toBe(0);
  });

  it("parses a record id and refuses a foreign one", () => {
    const body = serializeSimStudyBody(
      buildOk(build("x", scenarioId, [widthGene], [massObjective], [])),
    );
    const parsed = parseSimStudy({
      id: "study_lightest",
      ...JSON.parse(JSON.stringify(body)),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.id).toBe("study_lightest");
    expectFail(
      parseSimStudy({ id: "sim_lightest", ...body }),
      STUDY_ERROR_CODES.idInvalid,
    );
  });

  it("defaults an absent maxEvaluations from population × generations", () => {
    const parsed = parseSimStudyBody({
      name: "budget default",
      scenarioId,
      genes: [widthGene],
      objectives: [massObjective],
      population: 10,
      generations: 5,
      maxEvaluations: 10,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.maxEvaluations).toBe(10);
  });

  it("cross-checks against the document's records", () => {
    const study = {
      ...buildOk(
        build(
          "cross",
          scenarioId,
          [
            widthGene,
            {
              kind: "discrete",
              recordKind: "motor",
              choices: [motorA, motorB],
            },
          ],
          [massObjective],
          [parse("width * height - 300mm2")],
        ),
      ),
      id: createStudyId("study_cross"),
    };
    expect(
      crossCheckSimStudy(study, {
        parameters: literalParameters(),
        motors: motors(),
        simulations: [{ ...scenario(), id: scenarioId }],
      }),
    ).toEqual([]);
    // The expression-driven table still cross-checks: the genes address
    // literals; only `derived` carries an expression.
    expect(
      crossCheckSimStudy(study, {
        parameters: expressionDrivenParameters(),
        motors: motors(),
        simulations: [{ ...scenario(), id: scenarioId }],
      }),
    ).toEqual([]);
    const missingEverything = crossCheckSimStudy(
      { ...study, scenarioId: createSimulationId("sim_elsewhere") },
      {
        parameters: EMPTY_PARAMETER_COLLECTION,
        motors: [],
        simulations: [],
      },
    );
    expect(missingEverything.map((problem) => problem.code)).toEqual([
      STUDY_ERROR_CODES.scenarioInvalid,
      STUDY_ERROR_CODES.parameterGeneUnknown,
      STUDY_ERROR_CODES.choiceUnknown,
      STUDY_ERROR_CODES.choiceUnknown,
      STUDY_ERROR_CODES.constraintIdentifierUnknown,
      STUDY_ERROR_CODES.constraintIdentifierUnknown,
    ]);
    const expressionDrivenGene = {
      ...buildOk(
        build(
          "derived gene",
          scenarioId,
          [
            {
              kind: "parameter",
              parameterId: derivedId,
              valueKind: "decimal",
              min: 1,
              max: 20,
            },
          ],
          [massObjective],
          [],
        ),
      ),
      id: createStudyId("study_derived"),
    };
    expect(
      crossCheckSimStudy(expressionDrivenGene, {
        parameters: expressionDrivenParameters(),
        motors: motors(),
        simulations: [{ ...scenario(), id: scenarioId }],
      }).map((problem) => problem.code),
    ).toEqual([STUDY_ERROR_CODES.parameterGeneExpressionDriven]);
  });

  it("keeps a dimensionless gene's bounds unit-free", () => {
    const countParameter: Parameter = {
      id: createParameterId("param_fins"),
      name: "fins",
      value: dimensionless(6),
      expression: null,
      metadata: {},
    };
    const study = {
      ...buildOk(
        build(
          "fins",
          scenarioId,
          [
            {
              kind: "parameter",
              parameterId: countParameter.id,
              valueKind: "integer",
              min: 2,
              max: 12,
            },
          ],
          [massObjective],
          [],
        ),
      ),
      id: createStudyId("study_fins"),
    };
    expect(
      crossCheckSimStudy(study, {
        parameters: collectionWith(countParameter),
        motors: motors(),
        simulations: [{ ...scenario(), id: scenarioId }],
      }),
    ).toEqual([]);
  });
});
