/**
 * Phase 70b study-section tests (ROADMAP-SIM law S1, the finale): the
 * additive `studies` document section addressed exactly like
 * configurations and simulations — add/update/remove with the study
 * module's cross-checks and the in-use refusals that keep referenced
 * parameters, motors, and scenarios alive, the `study.*` command
 * vocabulary replaying through transactions, the native v11 round-trip
 * (byte-identical, including the replayed log), the v10→v11 identity
 * migration fixture, and the additive omission (a study-free document
 * serializes without the `studies` key, byte-identical to its pre-study
 * form).
 */

import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentMotor,
  addDocumentParameter,
  addDocumentSimulation,
  addDocumentStudy,
  applyCommand,
  applyTransaction,
  type CadCommand,
  type CadDocument,
  createDocument,
  createDocumentId,
  createMotorId,
  createNativeCadDocument,
  createParameterId,
  createSimulationId,
  createStudyId,
  DOCUMENT_ERROR_CODES,
  type DocumentHistory,
  encodeNativeCadDocument,
  length,
  migrateNativeCadDocument,
  parseCadDocument,
  parseCommand,
  parseExpression,
  parseNativeCadDocumentFromBytes,
  readNativeFormatVersion,
  removeDocumentMotor,
  removeDocumentParameter,
  removeDocumentSimulation,
  removeDocumentStudy,
  serializeCadDocument,
  serializeCommand,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  updateDocumentStudy,
  validateNativeCadDocument,
} from "./index";

function requireOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(`The study test rejected ${what}: ${result.error.message}`);
  }
  return result.value;
}

/** A document with a body, a scenario, a motor, and the gene parameters. */
function studyDocument(): {
  readonly document: CadDocument;
  readonly scenarioId: ReturnType<typeof createSimulationId>;
  readonly motorA: ReturnType<typeof createMotorId>;
  readonly motorB: ReturnType<typeof createMotorId>;
  readonly thicknessId: ReturnType<typeof createParameterId>;
  readonly heightId: ReturnType<typeof createParameterId>;
} {
  const withBody = requireOk(
    addBody(createDocument(createDocumentId("doc_study_test")), {
      name: "Bracket",
    }),
    "the body add",
  ).document;
  const thickness = requireOk(
    addDocumentParameter(withBody, {
      id: createParameterId("param_thickness"),
      name: "thickness",
      value: length(8),
    }),
    "the thickness parameter",
  ).document;
  const withHeight = requireOk(
    addDocumentParameter(thickness, {
      id: createParameterId("param_wall-height"),
      name: "wallHeight",
      value: length(80),
    }),
    "the wall-height parameter",
  );
  const motorA = createMotorId("mot_torquey");
  const motorB = createMotorId("mot_speedy");
  const withMotors = requireOk(
    addDocumentMotor(withHeight.document, {
      id: motorA,
      name: "Torquey",
      kind: "dc-brushed",
      stallTorqueMNm: 80,
      noLoadSpeedRpm: 4000,
      nominalVoltageV: 12,
    }),
    "the first motor",
  ).document;
  const withMotorB = requireOk(
    addDocumentMotor(withMotors, {
      id: motorB,
      name: "Speedy",
      kind: "bldc",
      stallTorqueMNm: 20,
      noLoadSpeedRpm: 20000,
      nominalVoltageV: 24,
    }),
    "the second motor",
  ).document;
  const scenarioId = createSimulationId("sim_bracket-load");
  const withScenario = requireOk(
    addDocumentSimulation(withMotorB, {
      id: scenarioId,
      name: "Bracket load",
      kind: "structural",
      domain: {
        kind: "explicit",
        min: [-60, -40, 0],
        max: [60, 40, 96],
        resolutionMm: 5,
      },
      conditions: [
        { kind: "fixed-support", face: "zMin" },
        {
          kind: "point-load",
          atWorldPointMm: [0, -36, 48],
          forceN: [0, -500, 0],
        },
      ],
      fluid: "air",
      materials: [],
      structural: { selfWeight: false },
    }),
    "the scenario",
  ).document;
  return {
    document: withScenario,
    scenarioId,
    motorA,
    motorB,
    thicknessId: createParameterId("param_thickness"),
    heightId: createParameterId("param_wall-height"),
  };
}

/** A study's authored fields over the fixture document's own records. */
function studyFields(fixed: ReturnType<typeof studyDocument>) {
  return {
    name: "Lightest bracket",
    scenarioId: fixed.scenarioId,
    genes: [
      {
        kind: "parameter" as const,
        parameterId: fixed.thicknessId,
        valueKind: "integer" as const,
        min: 4,
        max: 16,
        step: 2,
      },
      {
        kind: "parameter" as const,
        parameterId: fixed.heightId,
        valueKind: "integer" as const,
        min: 56,
        max: 88,
      },
      {
        kind: "discrete" as const,
        recordKind: "motor" as const,
        choices: [fixed.motorA, fixed.motorB],
      },
    ],
    objectives: [
      { quantity: "mass", direction: "minimize" as const },
      { quantity: "factor-of-safety", direction: "maximize" as const },
    ],
    constraints: [
      requireOk(
        parseExpression("wallHeight - 2 * thickness"),
        "the constraint",
      ),
    ],
    population: 6,
    generations: 3,
    seed: 7,
  };
}

describe("the studies document section", () => {
  it("adds a study with defaults and a generated id, and refuses duplicate names", () => {
    const fixed = studyDocument();
    const added = requireOk(
      addDocumentStudy(fixed.document, studyFields(fixed)),
      "the study add",
    );
    expect(added.study.id).toBe("study_000001");
    // The algorithm/budget defaults: mutation 0.25, crossover 0.9, seed
    // as authored, the budget = population × generations.
    expect(added.study.population).toBe(6);
    expect(added.study.mutationRate).toBe(0.25);
    expect(added.study.crossoverRate).toBe(0.9);
    expect(added.study.maxEvaluations).toBe(18);
    expect(added.document.studies).toHaveLength(1);
    const duplicate = addDocumentStudy(added.document, studyFields(fixed));
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.error.code).toBe(DOCUMENT_ERROR_CODES.studyInvalid);
  });

  it("cross-checks the scenario, the parameter genes, the choices, and the constraint identifiers", () => {
    const fixed = studyDocument();
    // An unknown scenario, an unknown parameter, an expression-driven
    // gene, an unknown choice, and a constraint naming no parameter —
    // one refusal names them all.
    const expressionDriven = requireOk(
      addDocumentParameter(fixed.document, {
        id: createParameterId("param_derived"),
        name: "derived",
        value: length(8),
        expression: requireOk(
          parseExpression("thickness * 2"),
          "the defining expression",
        ),
      }),
      "the expression-driven parameter",
    ).document;
    const refusal = addDocumentStudy(expressionDriven, {
      name: "Broken study",
      scenarioId: createSimulationId("sim_missing"),
      genes: [
        {
          kind: "parameter",
          parameterId: createParameterId("param_missing"),
          valueKind: "integer",
          min: 1,
          max: 2,
        },
        {
          kind: "parameter",
          parameterId: createParameterId("param_derived"),
          valueKind: "integer",
          min: 1,
          max: 2,
        },
        {
          kind: "discrete",
          recordKind: "motor",
          choices: [createMotorId("mot_missing"), fixed.motorA],
        },
      ],
      objectives: [{ quantity: "mass", direction: "minimize" }],
      constraints: [
        requireOk(parseExpression("notAParameter - 1mm"), "the bad constraint"),
      ],
    });
    expect(refusal.ok).toBe(false);
    if (refusal.ok) return;
    expect(refusal.error.code).toBe(DOCUMENT_ERROR_CODES.studyInvalid);
    const message = refusal.error.message;
    expect(message).toContain("sim_missing");
    expect(message).toContain("param_missing");
    // The expression-driven refusal names the parameter by NAME (the
    // human-facing form), the others by id.
    expect(message).toContain("derived");
    expect(message).toContain("mot_missing");
    expect(message).toContain("notAParameter");
  });

  it("refuses removing a parameter, motor, or scenario a study references (never cascades)", () => {
    const fixed = studyDocument();
    const withStudy = requireOk(
      addDocumentStudy(fixed.document, studyFields(fixed)),
      "the study add",
    ).document;
    const parameterRemoval = removeDocumentParameter(
      withStudy,
      fixed.thicknessId,
    );
    expect(parameterRemoval.ok).toBe(false);
    if (parameterRemoval.ok) return;
    expect(parameterRemoval.error.code).toBe(DOCUMENT_ERROR_CODES.studyInUse);
    const motorRemoval = removeDocumentMotor(withStudy, fixed.motorA);
    expect(motorRemoval.ok).toBe(false);
    if (motorRemoval.ok) return;
    expect(motorRemoval.error.code).toBe(DOCUMENT_ERROR_CODES.studyInUse);
    const scenarioRemoval = removeDocumentSimulation(
      withStudy,
      fixed.scenarioId,
    );
    expect(scenarioRemoval.ok).toBe(false);
    if (scenarioRemoval.ok) return;
    expect(scenarioRemoval.error.code).toBe(DOCUMENT_ERROR_CODES.studyInUse);
    // With the study gone every referenced record is free again — the
    // refusal is the study's, never a cascade.
    const withoutStudy = requireOk(
      removeDocumentStudy(withStudy, withStudy.studies[0]!.id),
      "the study removal",
    );
    const freed = requireOk(
      removeDocumentParameter(withoutStudy, fixed.thicknessId),
      "the freed parameter removal",
    );
    expect(freed.studies).toHaveLength(0);
  });

  it("updates a study in place keeping its id, and removes it by id", () => {
    const fixed = studyDocument();
    const added = requireOk(
      addDocumentStudy(fixed.document, studyFields(fixed)),
      "the study add",
    );
    const updated = requireOk(
      updateDocumentStudy(added.document, added.study.id, {
        ...studyFields(fixed),
        name: "Lightest bracket v2",
        population: 8,
      }),
      "the study update",
    );
    expect(updated.studies[0]?.name).toBe("Lightest bracket v2");
    expect(updated.studies[0]?.id).toBe(added.study.id);
    expect(updated.studies[0]?.population).toBe(8);
    expect(updated.studies[0]?.maxEvaluations).toBe(24);
    const removed = requireOk(
      removeDocumentStudy(updated, added.study.id),
      "the study removal",
    );
    expect(removed.studies).toHaveLength(0);
    // A missing id is a structured not-found, never a throw.
    const missing = removeDocumentStudy(removed, added.study.id);
    expect(missing.ok).toBe(false);
  });

  it("round-trips through serialize → parse byte-identically and omits the key when empty", () => {
    const fixed = studyDocument();
    const without = serializeCadDocument(fixed.document);
    expect("studies" in without && without.studies !== undefined).toBe(false);
    const revivedWithout = requireOk(
      parseCadDocument(without),
      "the study-free parse",
    );
    expect(JSON.stringify(serializeCadDocument(revivedWithout))).toBe(
      JSON.stringify(without),
    );

    const withStudy = requireOk(
      addDocumentStudy(fixed.document, studyFields(fixed)),
      "the study add",
    ).document;
    const serialized = serializeCadDocument(withStudy);
    expect(serialized.studies).toHaveLength(1);
    const revived = requireOk(parseCadDocument(serialized), "the study parse");
    expect(revived.studies).toEqual(withStudy.studies);
    expect(JSON.stringify(serializeCadDocument(revived))).toBe(
      JSON.stringify(serialized),
    );
  });
});

describe("the studies command vocabulary", () => {
  it("creates, updates, and deletes through commands", () => {
    const fixed = studyDocument();
    const studyId = createStudyId("study_cmd");
    const created = requireOk(
      applyCommand(fixed.document, {
        type: "study.create",
        id: studyId,
        study: studyFields(fixed),
      }),
      "the study.create command",
    );
    expect(created.studies[0]?.id).toBe(studyId);
    const updated = requireOk(
      applyCommand(created, {
        type: "study.update",
        id: studyId,
        study: { ...studyFields(fixed), name: "Renamed" },
      }),
      "the study.update command",
    );
    expect(updated.studies[0]?.name).toBe("Renamed");
    const deleted = requireOk(
      applyCommand(updated, { type: "study.delete", id: studyId }),
      "the study.delete command",
    );
    expect(deleted.studies).toHaveLength(0);
  });

  it("round-trips commands through serialize → parse deep-equal", () => {
    const fixed = studyDocument();
    const commands = [
      {
        type: "study.create",
        id: createStudyId("study_cmd"),
        study: studyFields(fixed),
      },
      {
        type: "study.update",
        id: createStudyId("study_cmd"),
        study: { ...studyFields(fixed), seed: 9 },
      },
      { type: "study.delete", id: createStudyId("study_cmd") },
    ] as const satisfies readonly CadCommand[];
    for (const command of commands) {
      const serialized = serializeCommand(command);
      const parsed = requireOk(
        parseCommand(JSON.parse(JSON.stringify(serialized))),
        "the command parse",
      );
      // The study payload parses through the module's build boundary, so
      // the command's absent algorithm fields land as the documented
      // defaults — the wire form already carried them canonically.
      if (command.type === "study.delete") {
        expect(parsed).toEqual(command);
        continue;
      }
      expect(parsed).toEqual({
        ...command,
        study: {
          ...command.study,
          mutationRate: 0.25,
          crossoverRate: 0.9,
          maxEvaluations: 18,
        },
      });
    }
  });
});

describe("the native format with the studies section (v11)", () => {
  function nativeWithStudyHistory() {
    const fixed = studyDocument();
    const commands: readonly CadCommand[] = [
      {
        type: "study.create",
        id: createStudyId("study_native"),
        study: studyFields(fixed),
      },
    ];
    const base = fixed.document;
    const applied = requireOk(
      applyTransaction(base, { commands }),
      "the transaction",
    );
    const history: DocumentHistory = Object.freeze({
      base,
      entries: Object.freeze([
        Object.freeze({ transaction: { commands }, document: applied }),
      ]),
      cursor: 1,
    });
    const native = requireOk(createNativeCadDocument(applied), "the wrap");
    return { ...native, history, document: applied };
  }

  it("saves and loads byte-identically, replaying the new commands", () => {
    const native = nativeWithStudyHistory();
    const bytes = encodeNativeCadDocument(native);
    const revived = requireOk(
      parseNativeCadDocumentFromBytes(bytes),
      "the native parse",
    );
    expect(revived.document.studies).toEqual(native.document.studies);
    expect(encodeNativeCadDocument(revived)).toEqual(bytes);
    const validated = validateNativeCadDocument(
      JSON.parse(
        stringifyNativeCadDocument(serializeNativeCadDocument(native)),
      ) as Record<string, unknown>,
    );
    expect(validated.valid).toBe(true);
    expect(validated.issues).toEqual([]);
  });

  it("migrates v10-stamped content through the identity step to v11", () => {
    const native = nativeWithStudyHistory();
    const text = stringifyNativeCadDocument(serializeNativeCadDocument(native));
    expect(readNativeFormatVersion(JSON.parse(text))).toBe(11);
    const asV10 = {
      ...(JSON.parse(text) as Record<string, unknown>),
      formatVersion: 10,
    };
    const migrated = requireOk(
      migrateNativeCadDocument(asV10),
      "the migration",
    );
    expect(readNativeFormatVersion(migrated)).toBe(11);
    // Identity: nothing but the stamp changed.
    const migratedRecord = migrated as Record<string, unknown>;
    const expected = JSON.parse(text) as Record<string, unknown>;
    const { formatVersion: migratedStamp, ...migratedContent } = migratedRecord;
    const { formatVersion: expectedStamp, ...expectedContent } = expected;
    expect(migratedStamp).toBe(11);
    expect(expectedStamp).toBe(11);
    expect(migratedContent).toEqual(expectedContent);
  });

  it("refuses malformed study rows through the native validation", () => {
    const native = nativeWithStudyHistory();
    const current = JSON.parse(
      stringifyNativeCadDocument(serializeNativeCadDocument(native)),
    ) as Record<string, unknown>;
    const document = current.document as Record<string, unknown>;
    const studies = document.studies as readonly Record<string, unknown>[];
    const invalid = validateNativeCadDocument({
      ...current,
      document: {
        ...document,
        studies: [{ ...studies[0], population: 1 }],
      },
    });
    expect(invalid.valid).toBe(false);
  });
});
