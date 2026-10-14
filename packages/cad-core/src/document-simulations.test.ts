/**
 * Phase 61 simulation-spine tests (ROADMAP-SIM law S1): the additive
 * `simulations` and `motors` document sections addressed exactly like
 * configurations — add/update/remove with cross-checks and in-use
 * refusals, the `motor.*`/`simulation.*` command vocabulary replaying
 * through transactions, the native v10 round-trip (byte-identical,
 * including the replayed log), the v9→v10 identity migration fixture,
 * and the thermal material fields on DocumentMaterialRecord.
 */

import { describe, expect, it } from "vitest";

import {
  addBody,
  addDocumentMotor,
  addDocumentSimulation,
  addJoint,
  addOccurrence,
  applyCommand,
  applyTransaction,
  type CadCommand,
  type CadDocument,
  createBodyId,
  createDocument,
  createDocumentId,
  createJointId,
  createMotorId,
  createNativeCadDocument,
  createOccurrenceId,
  createSimulationId,
  DOCUMENT_ERROR_CODES,
  type DocumentHistory,
  type DocumentMaterialRecord,
  type SimScenarioCombustionSpec,
  type SimScenarioDynamicsSpec,
  type SimScenarioInput,
  type SimScenarioStructuralSpec,
  type SimScenarioThermalSpec,
  encodeNativeCadDocument,
  MATERIAL_RECORD_ERROR_CODES,
  type MotorId,
  migrateNativeCadDocument,
  parseCadDocument,
  parseCommand,
  parseDocumentMaterialRecord,
  parseMaterialId,
  parseNativeCadDocumentFromBytes,
  readNativeFormatVersion,
  removeBody,
  removeDocumentMotor,
  removeDocumentSimulation,
  serializeCadDocument,
  serializeCommand,
  serializeNativeCadDocument,
  stringifyNativeCadDocument,
  updateDocumentMotor,
  updateDocumentSimulation,
  validateNativeCadDocument,
} from "./index";

function requireOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: { readonly message: string } },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(
      `The simulation test rejected ${what}: ${result.error.message}`,
    );
  }
  return result.value;
}

/** A document carrying one body for scenarios to reference. */
function baseDocument(): CadDocument {
  return requireOk(
    addBody(createDocument(createDocumentId("doc_sim_test")), {
      name: "Fuselage",
    }),
    "the body add",
  ).document;
}

function withMotor(): { document: CadDocument; motorId: MotorId } {
  const added = requireOk(
    addDocumentMotor(baseDocument(), {
      id: createMotorId("mot_fan-drive"),
      name: "Fan drive",
      kind: "dc-brushed",
      stallTorqueMNm: 100,
      noLoadSpeedRpm: 6000,
      nominalVoltageV: 12,
    }),
    "the motor add",
  );
  return { document: added.document, motorId: added.motor.id };
}

/** A wind-tunnel scenario's authored fields (the module's canonical shape). */
function scenarioFields() {
  return {
    name: "Wind tunnel",
    kind: "flow" as const,
    domain: {
      kind: "explicit" as const,
      min: [-500, -250, -250] as const,
      max: [500, 250, 250] as const,
      resolutionMm: 2,
    },
    conditions: [
      {
        kind: "velocity-inlet" as const,
        face: "xMin" as const,
        speedMPerS: 10,
        direction: [1, 0, 0] as const,
      },
      {
        kind: "pressure-outlet" as const,
        face: "xMax" as const,
        pressurePa: 0,
      },
    ],
    fluid: "air",
    materials: [],
  };
}

describe("the motors document section", () => {
  it("adds analytic and tabulated motor records with generated ids", () => {
    const first = requireOk(
      addDocumentMotor(baseDocument(), {
        name: "Fan drive",
        kind: "dc-brushed",
        stallTorqueMNm: 100,
        noLoadSpeedRpm: 6000,
        nominalVoltageV: 12,
      }),
      "the analytic add",
    );
    expect(first.motor.id).toBe("mot_000001");
    expect(first.motor.kind).toBe("dc-brushed");
    if (first.motor.kind !== "dc-brushed" && first.motor.kind !== "bldc") {
      throw new Error("The analytic motor stored as a table.");
    }
    expect(first.motor.stallTorqueMNm).toBe(100);
    const second = requireOk(
      addDocumentMotor(first.document, {
        name: "Measured",
        kind: "tabulated",
        points: [
          { speedRpm: 0, torqueMNm: 80 },
          { speedRpm: 6000, torqueMNm: 0 },
        ],
        rotorInertiaKgM2: 1.2e-5,
      }),
      "the tabulated add",
    );
    expect(second.motor.kind).toBe("tabulated");
    expect(second.document.motors).toHaveLength(2);
    expect(second.document.idGeneratorState.motor).toBe(2);
  });

  it("refuses duplicate names, bad parameters, and unsorted tables", () => {
    const document = withMotor().document;
    expect(
      addDocumentMotor(document, {
        name: "Fan drive",
        kind: "bldc",
        stallTorqueMNm: 50,
        noLoadSpeedRpm: 3000,
        nominalVoltageV: 24,
      }).ok,
    ).toBe(false);
    expect(
      addDocumentMotor(document, {
        name: "Bad torque",
        kind: "bldc",
        stallTorqueMNm: -1,
        noLoadSpeedRpm: 3000,
        nominalVoltageV: 24,
      }).ok,
    ).toBe(false);
    expect(
      addDocumentMotor(document, {
        name: "Unsorted",
        kind: "tabulated",
        points: [
          { speedRpm: 6000, torqueMNm: 0 },
          { speedRpm: 0, torqueMNm: 80 },
        ],
      }).ok,
    ).toBe(false);
  });

  it("updates keeping identity and removes when unreferenced", () => {
    const { document, motorId } = withMotor();
    const updated = requireOk(
      updateDocumentMotor(document, motorId, {
        name: "Fan drive (derated)",
        kind: "dc-brushed",
        stallTorqueMNm: 90,
        noLoadSpeedRpm: 5400,
        nominalVoltageV: 12,
      }),
      "the motor update",
    );
    expect(updated.motors[0]?.name).toBe("Fan drive (derated)");
    expect(updated.motors[0]?.id).toBe(motorId);
    const removed = requireOk(
      removeDocumentMotor(updated, motorId),
      "the motor remove",
    );
    expect(removed.motors).toEqual([]);
  });
});

describe("the simulations document section", () => {
  it("adds a scenario with defaults (gravity, backend) and a generated id", () => {
    const added = requireOk(
      addDocumentSimulation(baseDocument(), scenarioFields()),
      "the scenario add",
    );
    expect(added.scenario.id).toBe("sim_000001");
    expect(added.scenario.gravityMPerS2).toEqual([0, -9.80665, 0]);
    expect(added.scenario.backend).toBeUndefined();
    expect(added.scenario.conditions).toHaveLength(2);
  });

  it("stores the structural kind with its stance (Phase 69 live)", () => {
    const added = requireOk(
      addDocumentSimulation(baseDocument(), {
        ...scenarioFields(),
        kind: "structural",
        conditions: [{ kind: "fixed-support", face: "zMax" }],
        structural: { selfWeight: false },
      }),
      "the structural add",
    );
    expect(added.scenario.kind).toBe("structural");
    expect(added.scenario.structural?.selfWeight).toBe(false);
  });

  it("carries the Phase 63c run controls additively through add, serialize, and parse", () => {
    const added = requireOk(
      addDocumentSimulation(baseDocument(), {
        ...scenarioFields(),
        stepBudget: 240,
        gridConvergence: true,
      }),
      "the run-controlled add",
    );
    expect(added.scenario.stepBudget).toBe(240);
    expect(added.scenario.gridConvergence).toBe(true);
    const serialized = serializeCadDocument(added.document);
    const parsed = requireOk(
      parseCadDocument(JSON.parse(JSON.stringify(serialized))),
      "the serialized round-trip",
    );
    const scenario = parsed.simulations[0];
    expect(scenario?.stepBudget).toBe(240);
    expect(scenario?.gridConvergence).toBe(true);
    // Absent controls stay absent (the additive discipline: old records
    // parse unchanged, new optionals serialize only when authored).
    const plain = requireOk(
      addDocumentSimulation(baseDocument(), scenarioFields()),
      "the plain add",
    );
    expect(plain.scenario.stepBudget).toBeUndefined();
    expect(plain.scenario.gridConvergence).toBeUndefined();
    const plainKeys = Object.keys(
      (serializeCadDocument(plain.document).simulations ?? [])[0] ?? {},
    );
    expect(plainKeys).not.toContain("stepBudget");
    expect(plainKeys).not.toContain("gridConvergence");
  });

  it("refuses malformed run controls with the structured code", () => {
    for (const bad of [0, -4, 1.5] as const) {
      const refused = addDocumentSimulation(baseDocument(), {
        ...scenarioFields(),
        stepBudget: bad,
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.message).toContain("step budget");
      }
    }
    const refusedFlag = addDocumentSimulation(baseDocument(), {
      ...scenarioFields(),
      gridConvergence: "yes" as unknown as boolean,
    });
    expect(refusedFlag.ok).toBe(false);
  });

  it("cross-checks referenced bodies and motors at the add boundary", () => {
    const unknownBody = addDocumentSimulation(baseDocument(), {
      ...scenarioFields(),
      domain: {
        kind: "body",
        bodyIds: [createBodyId("body_ghost")],
        marginMm: 10,
        resolutionMm: 2,
      },
    });
    expect(unknownBody.ok).toBe(false);
    if (!unknownBody.ok) {
      expect(unknownBody.error.code).toBe(
        DOCUMENT_ERROR_CODES.simulationUnknownBody,
      );
    }

    const wingAdded = requireOk(
      addBody(baseDocument(), { name: "Wing" }),
      "the wing add",
    );
    const knownBody = requireOk(
      addDocumentSimulation(wingAdded.document, {
        ...scenarioFields(),
        domain: {
          kind: "body",
          bodyIds: [wingAdded.body.id],
          marginMm: 10,
          resolutionMm: 2,
        },
      }),
      "the known-body add",
    );
    expect(knownBody.scenario.domain.kind).toBe("body");

    const { document, motorId } = withMotor();
    const unknownMotor = addDocumentSimulation(document, {
      ...scenarioFields(),
      motorId: createMotorId("mot_ghost"),
    });
    expect(unknownMotor.ok).toBe(false);
    if (!unknownMotor.ok) {
      expect(unknownMotor.error.code).toBe(
        DOCUMENT_ERROR_CODES.simulationUnknownMotor,
      );
    }
    const knownMotor = requireOk(
      addDocumentSimulation(document, { ...scenarioFields(), motorId }),
      "the motor-selected add",
    );
    expect(knownMotor.scenario.motorId).toBe(motorId);
  });

  it("refuses body removal while a scenario references it (in-use, never cascade)", () => {
    const bodyAdded = requireOk(
      addBody(baseDocument(), { name: "Wing" }),
      "the wing add",
    );
    const wingId = bodyAdded.body.id;
    const viaDomain = requireOk(
      addDocumentSimulation(bodyAdded.document, {
        ...scenarioFields(),
        domain: {
          kind: "body",
          bodyIds: [wingId],
          marginMm: 10,
          resolutionMm: 2,
        },
      }),
      "the domain reference",
    ).document;
    const blocked = removeBody(viaDomain, wingId);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.code).toBe(DOCUMENT_ERROR_CODES.simulationInUse);
    }

    const viaMaterial = requireOk(
      addDocumentSimulation(bodyAdded.document, {
        ...scenarioFields(),
        materials: [
          {
            bodyId: wingId,
            materialId: requireOk(
              parseMaterialId("mat_alu"),
              "the material id",
            ),
          },
        ],
      }),
      "the material reference",
    ).document;
    const blockedMaterial = removeBody(viaMaterial, wingId);
    expect(blockedMaterial.ok).toBe(false);
  });

  it("refuses motor removal while a scenario selects it", () => {
    const { document, motorId } = withMotor();
    const withScenario = requireOk(
      addDocumentSimulation(document, { ...scenarioFields(), motorId }),
      "the scenario add",
    ).document;
    const blocked = removeDocumentMotor(withScenario, motorId);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.error.code).toBe(DOCUMENT_ERROR_CODES.simulationInUse);
    }
  });

  it("updates and removes scenario rows keeping their identity discipline", () => {
    const added = requireOk(
      addDocumentSimulation(baseDocument(), {
        ...scenarioFields(),
        id: createSimulationId("sim_tunnel"),
      }),
      "the add",
    );
    const updated = requireOk(
      updateDocumentSimulation(added.document, added.scenario.id, {
        ...scenarioFields(),
        name: "Wind tunnel (fast)",
        backend: "gpu",
      }),
      "the update",
    );
    expect(updated.simulations[0]?.name).toBe("Wind tunnel (fast)");
    expect(updated.simulations[0]?.backend).toBe("gpu");
    expect(updated.simulations[0]?.id).toBe(added.scenario.id);
    const removed = requireOk(
      removeDocumentSimulation(updated, added.scenario.id),
      "the remove",
    );
    expect(removed.simulations).toEqual([]);
  });

  it("round-trips through serialize → parse byte-identically", () => {
    const { document, motorId } = withMotor();
    const withScenario = requireOk(
      addDocumentSimulation(document, {
        ...scenarioFields(),
        motorId,
        backend: "gpu",
      }),
      "the scenario add",
    ).document;
    const serialized = JSON.stringify(serializeCadDocument(withScenario));
    const revived = requireOk(
      parseCadDocument(JSON.parse(serialized)),
      "the document parse",
    );
    expect(revived.simulations).toEqual(withScenario.simulations);
    expect(revived.motors).toEqual(withScenario.motors);
    expect(JSON.stringify(serializeCadDocument(revived))).toBe(serialized);
  });
});

describe("the motor/simulation command vocabulary", () => {
  it("creates, updates, and deletes through commands", () => {
    const motorCreate: CadCommand = {
      type: "motor.create",
      id: createMotorId("mot_cmd"),
      motor: {
        name: "Command drive",
        kind: "bldc",
        stallTorqueMNm: 40,
        noLoadSpeedRpm: 9000,
        nominalVoltageV: 24,
      },
    };
    const withMotorDoc = requireOk(
      applyCommand(baseDocument(), motorCreate),
      "the motor command",
    );
    expect(withMotorDoc.motors[0]?.id).toBe("mot_cmd");
    const simulationCreate: CadCommand = {
      type: "simulation.create",
      id: createSimulationId("sim_cmd"),
      scenario: scenarioFields(),
    };
    const withScenarioDoc = requireOk(
      applyCommand(withMotorDoc, simulationCreate),
      "the scenario command",
    );
    expect(withScenarioDoc.simulations[0]?.id).toBe("sim_cmd");
    const updated = requireOk(
      applyCommand(withScenarioDoc, {
        type: "simulation.update",
        id: createSimulationId("sim_cmd"),
        scenario: { ...scenarioFields(), name: "Renamed" },
      }),
      "the update command",
    );
    expect(updated.simulations[0]?.name).toBe("Renamed");
    const deleted = requireOk(
      applyCommand(updated, {
        type: "simulation.delete",
        id: createSimulationId("sim_cmd"),
      }),
      "the delete command",
    );
    expect(deleted.simulations).toEqual([]);
    const motorDeleted = requireOk(
      applyCommand(deleted, {
        type: "motor.delete",
        id: createMotorId("mot_cmd"),
      }),
      "the motor delete command",
    );
    expect(motorDeleted.motors).toEqual([]);
  });

  it("round-trips commands through serialize → parse deep-equal", () => {
    const commands: CadCommand[] = [
      {
        type: "motor.create",
        id: createMotorId("mot_cmd"),
        motor: {
          name: "Command drive",
          kind: "tabulated",
          points: [
            { speedRpm: 0, torqueMNm: 50 },
            { speedRpm: 4500, torqueMNm: 25 },
          ],
        },
      },
      {
        type: "simulation.create",
        scenario: scenarioFields(),
      },
    ];
    for (const command of commands) {
      const serialized = serializeCommand(command);
      const parsed = requireOk(
        parseCommand(JSON.parse(JSON.stringify(serialized))),
        "the command parse",
      );
      // The scenario payload parses through the module's build boundary,
      // so its defaults (gravity) land — the wire form already carried
      // them canonically, and the normalized command deep-equals.
      const expected =
        command.type === "simulation.create"
          ? {
              ...command,
              scenario: {
                ...command.scenario,
                gravityMPerS2: [0, -9.80665, 0],
              },
            }
          : command;
      expect(parsed).toEqual(expected);
    }
  });
});

describe("the native format with the simulation spine (v10)", () => {
  function nativeWithSimulationHistory() {
    const commands: readonly CadCommand[] = [
      {
        type: "motor.create",
        id: createMotorId("mot_fan-drive"),
        motor: {
          name: "Fan drive",
          kind: "dc-brushed",
          stallTorqueMNm: 100,
          noLoadSpeedRpm: 6000,
          nominalVoltageV: 12,
        },
      },
      {
        type: "simulation.create",
        id: createSimulationId("sim_tunnel"),
        scenario: scenarioFields(),
      },
    ];
    const base = baseDocument();
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
    const native = nativeWithSimulationHistory();
    const bytes = encodeNativeCadDocument(native);
    const revived = requireOk(
      parseNativeCadDocumentFromBytes(bytes),
      "the native parse",
    );
    expect(revived.document.simulations).toEqual(native.document.simulations);
    expect(revived.document.motors).toEqual(native.document.motors);
    expect(encodeNativeCadDocument(revived)).toEqual(bytes);
  });

  it("validates a history whose transactions delete what earlier ones created", () => {
    // Deletes serialize identity-only ({formatVersion, type, id}) — the
    // validator must not demand a scenario/motor payload for them, or
    // every saved document that ever removed a row would decline.
    const createCommands: readonly CadCommand[] = [
      {
        type: "motor.create",
        id: createMotorId("mot_fan-drive"),
        motor: {
          name: "Fan drive",
          kind: "dc-brushed",
          stallTorqueMNm: 100,
          noLoadSpeedRpm: 6000,
          nominalVoltageV: 12,
        },
      },
      {
        type: "simulation.create",
        id: createSimulationId("sim_tunnel"),
        scenario: scenarioFields(),
      },
    ];
    const deleteCommands: readonly CadCommand[] = [
      {
        type: "simulation.delete",
        id: createSimulationId("sim_tunnel"),
      },
      { type: "motor.delete", id: createMotorId("mot_fan-drive") },
    ];
    const base = baseDocument();
    const created = requireOk(
      applyTransaction(base, { commands: createCommands }),
      "the creating transaction",
    );
    const emptied = requireOk(
      applyTransaction(created, { commands: deleteCommands }),
      "the deleting transaction",
    );
    const history: DocumentHistory = Object.freeze({
      base,
      entries: Object.freeze([
        Object.freeze({
          transaction: { commands: createCommands },
          document: created,
        }),
        Object.freeze({
          transaction: { commands: deleteCommands },
          document: emptied,
        }),
      ]),
      cursor: 2,
    });
    const native = requireOk(createNativeCadDocument(emptied), "the wrap");
    const withHistory = { ...native, history, document: emptied };
    const serialized = JSON.parse(
      stringifyNativeCadDocument(serializeNativeCadDocument(withHistory)),
    ) as Record<string, unknown>;
    const validated = validateNativeCadDocument(serialized);
    expect(validated.valid).toBe(true);
    expect(validated.issues).toEqual([]);
    // The persisted log round-trips too: the deletes replay over the base.
    const revived = requireOk(
      parseNativeCadDocumentFromBytes(encodeNativeCadDocument(withHistory)),
      "the native parse",
    );
    expect(revived.document.simulations).toEqual([]);
    expect(revived.document.motors).toEqual([]);
  });

  it("migrates v9-stamped content through the identity steps to v11", () => {
    const native = nativeWithSimulationHistory();
    const text = stringifyNativeCadDocument(serializeNativeCadDocument(native));
    expect(readNativeFormatVersion(JSON.parse(text))).toBe(11);
    const asV9 = {
      ...(JSON.parse(text) as Record<string, unknown>),
      formatVersion: 9,
    };
    const migrated = requireOk(migrateNativeCadDocument(asV9), "the migration");
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

  it("validates present simulation and motor lists through their parse boundaries", () => {
    const native = nativeWithSimulationHistory();
    const current = JSON.parse(
      stringifyNativeCadDocument(serializeNativeCadDocument(native)),
    ) as Record<string, unknown>;
    const valid = validateNativeCadDocument(current);
    expect(valid.valid).toBe(true);
    expect(valid.issues).toEqual([]);

    const document = current.document as Record<string, unknown>;
    const malformed = validateNativeCadDocument({
      ...current,
      document: {
        ...document,
        simulations: [{ id: "sim_x", name: "", kind: "flow" }],
      },
    });
    expect(malformed.valid).toBe(false);
    expect(
      malformed.issues.some(
        (issue) => issue.code === "native-format/field-invalid",
      ),
    ).toBe(true);

    const malformedMotors = validateNativeCadDocument({
      ...current,
      document: {
        ...document,
        motors: [{ id: "mot_x", name: "X", kind: "tabulated", points: [] }],
      },
    });
    expect(malformedMotors.valid).toBe(false);
  });
});

describe("the thermal material fields", () => {
  it("parse additively with physical ordering enforced", () => {
    const record: DocumentMaterialRecord = requireOk(
      parseDocumentMaterialRecord({
        id: "mat_alu",
        name: "Aluminium 6061",
        densityGPerCm3: 2.7,
        thermalConductivityWPerMK: 167,
        specificHeatJPerKgK: 896,
        emissivity: 0.09,
      }),
      "the material parse",
    );
    expect(record.thermalConductivityWPerMK).toBe(167);
    expect(record.specificHeatJPerKgK).toBe(896);
    expect(record.emissivity).toBe(0.09);

    const sparse = requireOk(
      parseDocumentMaterialRecord({
        id: "mat_plain",
        name: "Unnamed alloy",
        densityGPerCm3: 1.2,
      }),
      "the sparse parse",
    );
    expect(sparse.thermalConductivityWPerMK).toBeUndefined();

    const badEmissivity = parseDocumentMaterialRecord({
      id: "mat_bad",
      name: "Over-emissive",
      densityGPerCm3: 1.2,
      emissivity: 1.5,
    });
    expect(badEmissivity.ok).toBe(false);
    if (!badEmissivity.ok) {
      expect(badEmissivity.error.code).toBe(
        MATERIAL_RECORD_ERROR_CODES.thermalInvalid,
      );
    }
    const badConductivity = parseDocumentMaterialRecord({
      id: "mat_bad",
      name: "Insulating conductor",
      densityGPerCm3: 1.2,
      thermalConductivityWPerMK: -1,
    });
    expect(badConductivity.ok).toBe(false);
  });
});

describe("the structural material fields (Phase 69, the thermal precedent)", () => {
  it("parse additively with physical ordering enforced", () => {
    const record: DocumentMaterialRecord = requireOk(
      parseDocumentMaterialRecord({
        id: "mat_steel",
        name: "Steel S235",
        densityGPerCm3: 7.85,
        youngsModulusPa: 210e9,
        poissonRatio: 0.3,
        yieldStrengthPa: 235e6,
        thermalExpansionPerK: 1.2e-5,
      }),
      "the structural material parse",
    );
    expect(record.youngsModulusPa).toBe(210e9);
    expect(record.poissonRatio).toBe(0.3);
    expect(record.yieldStrengthPa).toBe(235e6);
    expect(record.thermalExpansionPerK).toBe(1.2e-5);

    // A negative expansion coefficient is physical (shrinkage materials);
    // only non-finite values decline.
    const shrinker = requireOk(
      parseDocumentMaterialRecord({
        id: "mat_shrink",
        name: "Shrinking polymer",
        densityGPerCm3: 1.1,
        youngsModulusPa: 3e9,
        poissonRatio: 0.4,
        thermalExpansionPerK: -5e-5,
      }),
      "the negative-expansion parse",
    );
    expect(shrinker.thermalExpansionPerK).toBe(-5e-5);
    expect(shrinker.yieldStrengthPa).toBeUndefined();

    // The thermal fields ride beside the structural ones unchanged.
    expect(record.thermalConductivityWPerMK).toBeUndefined();

    const decline = (
      input: Record<string, unknown>,
    ): { code: string; message: string } | undefined => {
      const parsed = parseDocumentMaterialRecord({
        id: "mat_bad",
        name: "Bad alloy",
        densityGPerCm3: 1.2,
        ...input,
      });
      if (parsed.ok) return undefined;
      return parsed.error;
    };
    expect(decline({ youngsModulusPa: 0 })?.code).toBe(
      MATERIAL_RECORD_ERROR_CODES.structuralInvalid,
    );
    expect(decline({ youngsModulusPa: Number.NaN })?.code).toBe(
      MATERIAL_RECORD_ERROR_CODES.structuralInvalid,
    );
    expect(decline({ poissonRatio: 0.5 })?.code).toBe(
      MATERIAL_RECORD_ERROR_CODES.structuralInvalid,
    );
    expect(decline({ poissonRatio: -1 })?.code).toBe(
      MATERIAL_RECORD_ERROR_CODES.structuralInvalid,
    );
    expect(decline({ yieldStrengthPa: -1 })?.code).toBe(
      MATERIAL_RECORD_ERROR_CODES.structuralInvalid,
    );
    expect(
      decline({ thermalExpansionPerK: Number.POSITIVE_INFINITY })?.code,
    ).toBe(MATERIAL_RECORD_ERROR_CODES.structuralInvalid);
    // An absent Poisson ratio alone is additive-honest: the record parses.
    expect(
      decline({ youngsModulusPa: 210e9, poissonRatio: undefined }),
    ).toBeUndefined();
  });

  it("serialize and round-trip through canonical JSON byte-identically", () => {
    const record: DocumentMaterialRecord = requireOk(
      parseDocumentMaterialRecord({
        id: "mat_ti",
        name: "Titanium Ti-6Al-4V",
        densityGPerCm3: 4.43,
        thermalConductivityWPerMK: 6.7,
        youngsModulusPa: 113.8e9,
        poissonRatio: 0.342,
        yieldStrengthPa: 880e6,
        thermalExpansionPerK: 8.6e-6,
      }),
      "the structural material parse",
    );
    const wire = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
    expect(JSON.stringify(wire)).toBe(JSON.stringify(record));
    const reparsed = requireOk(
      parseDocumentMaterialRecord(wire),
      "the round-trip parse",
    );
    expect(reparsed).toEqual(record);
    // The sparse record stays sparse through the same ride: no structural
    // key is fabricated on the wire.
    const sparse = requireOk(
      parseDocumentMaterialRecord({
        id: "mat_plain",
        name: "Plain alloy",
        densityGPerCm3: 1.2,
      }),
      "the sparse parse",
    );
    expect(
      Object.keys(JSON.parse(JSON.stringify(sparse)) as object).sort(),
    ).toEqual(["densityGPerCm3", "id", "name"]);
  });
});

describe("the thermal solve stance (Phase 65c)", () => {
  /** The stove stance's authored fields. */
  function thermalStance(
    overrides?: Partial<SimScenarioThermalSpec>,
  ): SimScenarioThermalSpec {
    return {
      radiationMode: "linearized",
      solveMode: "steady",
      cht: false,
      sourceW: 20,
      initialTemperatureK: 293.15,
      ambientConvectionWPerM2K: 5,
      ...overrides,
    };
  }

  /** A thermal scenario over the base document's body. */
  function thermalFields(stance?: SimScenarioThermalSpec) {
    return {
      name: "Stove",
      kind: "thermal" as const,
      domain: {
        kind: "explicit" as const,
        min: [-100, -100, -100] as const,
        max: [100, 100, 100] as const,
        resolutionMm: 5,
      },
      conditions: [],
      fluid: "air",
      materials: [],
      ...(stance === undefined ? {} : { thermal: stance }),
    };
  }

  it("adds a thermal scenario with its stance and round-trips it canonically", () => {
    const added = requireOk(
      addDocumentSimulation(baseDocument(), thermalFields(thermalStance())),
      "the thermal add",
    );
    const scenario = added.scenario;
    expect(scenario.thermal).toBeDefined();
    if (scenario.thermal === undefined) return;
    expect(scenario.thermal.radiationMode).toBe("linearized");
    expect(scenario.thermal.solveMode).toBe("steady");
    expect(scenario.thermal.durationS).toBeUndefined();
    const serialized = requireOk(
      parseCadDocument(serializeCadDocument(added.document)),
      "the serialized round-trip",
    );
    const restored = serialized.simulations[0];
    if (restored === undefined) throw new Error("the scenario did not survive");
    expect(restored.thermal).toEqual(scenario.thermal);
  });

  it("kind-locks the stance: thermal requires it, every other kind refuses it", () => {
    const missing = addDocumentSimulation(baseDocument(), thermalFields());
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.message).toContain("thermal solve stance");
    }
    const stray = addDocumentSimulation(baseDocument(), {
      ...scenarioFields(),
      thermal: thermalStance(),
    });
    expect(stray.ok).toBe(false);
    if (!stray.ok) {
      expect(stray.error.message).toContain("thermal kind's alone");
    }
  });

  it("declines a steady coupled stance and a transient budget off cadence", () => {
    const steadyCoupled = addDocumentSimulation(
      baseDocument(),
      thermalFields(
        thermalStance({
          solveMode: "transient",
          cht: true,
          durationS: 30,
          sampleIntervalS: 5,
        }),
      ),
    );
    expect(steadyCoupled.ok).toBe(true);
    const badCoupled = addDocumentSimulation(
      baseDocument(),
      thermalFields(thermalStance({ solveMode: "steady", cht: true })),
    );
    expect(badCoupled.ok).toBe(false);
    if (!badCoupled.ok) {
      expect(badCoupled.error.message).toContain("transient by construction");
    }
    const missingBudget = addDocumentSimulation(
      baseDocument(),
      thermalFields(thermalStance({ solveMode: "transient" })),
    );
    expect(missingBudget.ok).toBe(false);
    if (!missingBudget.ok) {
      expect(missingBudget.error.message).toContain("duration");
    }
    const offCadence = addDocumentSimulation(
      baseDocument(),
      thermalFields(
        thermalStance({
          solveMode: "transient",
          durationS: 30,
          sampleIntervalS: 4,
        }),
      ),
    );
    expect(offCadence.ok).toBe(false);
    if (!offCadence.ok) {
      expect(offCadence.error.message).toContain("integer multiple");
    }
  });

  it("updates a scenario's stance through the update path", () => {
    const added = requireOk(
      addDocumentSimulation(baseDocument(), thermalFields(thermalStance())),
      "the thermal add",
    );
    const updated = requireOk(
      updateDocumentSimulation(added.document, added.scenario.id, {
        ...thermalFields(
          thermalStance({
            solveMode: "transient",
            durationS: 60,
            sampleIntervalS: 5,
          }),
        ),
      }),
      "the update",
    );
    const scenario = updated.simulations[0];
    if (scenario === undefined) throw new Error("the update lost the scenario");
    if (scenario.thermal === undefined) return;
    expect(scenario.thermal.solveMode).toBe("transient");
    expect(scenario.thermal.durationS).toBe(60);
  });
});

describe("the combustion solve stance (Phase 68c)", () => {
  /** The stove-with-fire stance: a lit methane charge in the 65 domain. */
  function stoveStance(): SimScenarioCombustionSpec {
    return {
      mode: "stove",
      fuel: "CH4",
      equivalenceRatio: 1,
      chargeTemperatureK: 1400,
      chargePressureBar: 1,
      wallConvectionWPerM2K: 30,
      radiationMode: "linearized",
      initialTemperatureK: 293.15,
      ambientConvectionWPerM2K: 5,
      durationS: 30,
      sampleIntervalS: 1,
    };
  }

  /** The Otto engine stance: the demo 0.5 L single at CR 10. */
  function engineStance(): SimScenarioCombustionSpec {
    return {
      mode: "engine",
      fuel: "C8H18-ISO",
      geometry: {
        boreMm: 86,
        crankRadiusMm: 43,
        rodLengthMm: 143,
        compressionRatio: 10,
      },
      speedRpm: 1500,
      charge: { intakePressureBar: 1, intakeTK: 300, equivalenceRatio: 1 },
      spark: { timingBTDCDeg: 25 },
      wallHeat: { mode: "woschni", wallTemperatureK: 450 },
      sweep: { kind: "sparkTiming", from: 10, to: 50, steps: 4 },
    };
  }

  /** A combustion scenario over the base document. */
  function combustionFields(stance: SimScenarioCombustionSpec) {
    return {
      name: "Fire",
      kind: "combustion" as const,
      domain: {
        kind: "explicit" as const,
        min: [0, 0, 0] as const,
        max: [100, 40, 10] as const,
        resolutionMm: 5,
      },
      conditions: [],
      fluid: "air",
      materials: [],
      combustion: stance,
    };
  }

  /** The malformed-stance decline harness (the wire form, untrusted). */
  const declinedAdd = (
    document: CadDocument,
    stance: unknown,
    conditions: readonly unknown[] = [],
  ): ReturnType<typeof addDocumentSimulation> =>
    addDocumentSimulation(document, {
      name: "Fire",
      kind: "combustion",
      domain: {
        kind: "explicit",
        min: [0, 0, 0],
        max: [100, 40, 10],
        resolutionMm: 5,
      },
      conditions,
      fluid: "air",
      materials: [],
      combustion: stance,
    } as unknown as SimScenarioInput);

  it("adds both modes and round-trips them canonically", () => {
    for (const stance of [stoveStance(), engineStance()]) {
      const added = requireOk(
        addDocumentSimulation(baseDocument(), combustionFields(stance)),
        `the ${stance.mode} add`,
      );
      expect(added.scenario.kind).toBe("combustion");
      expect(added.scenario.combustion).toEqual(stance);
      // The canonical round-trip: serialize → parse is the identity.
      const reparsed = requireOk(
        parseCadDocument(
          JSON.parse(
            JSON.stringify(serializeCadDocument(added.document)),
          ) as unknown,
        ),
        `the ${stance.mode} document round-trip`,
      );
      const scenario = reparsed.simulations[0];
      expect(scenario).toBeDefined();
      if (scenario !== undefined) {
        expect(scenario.combustion).toEqual(stance);
      }
    }
  });

  it("kind-locks the stance: absent on combustion declines, present on others declines", () => {
    const missing = declinedAdd(baseDocument(), undefined);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe(DOCUMENT_ERROR_CODES.simulationInvalid);
      expect(missing.error.message).toContain("combustion solve stance");
    }
    const wrongKind = addDocumentSimulation(baseDocument(), {
      ...scenarioFields(),
      combustion: stoveStance(),
    });
    expect(wrongKind.ok).toBe(false);
    if (!wrongKind.ok) {
      expect(wrongKind.error.message).toContain(
        "cannot carry a combustion solve stance",
      );
    }
  });

  it("refuses engine-mode domain-face conditions (the dynamics kind's rule)", () => {
    const declined = declinedAdd(baseDocument(), engineStance(), [
      { kind: "fixed-temperature", face: "xMin", temperatureK: 300 },
    ]);
    expect(declined.ok).toBe(false);
    if (!declined.ok) {
      expect(declined.error.message).toContain(
        "no domain-face boundary conditions",
      );
    }
    // The stove mode consumes the thermal set.
    const stoveWithWall = declinedAdd(baseDocument(), stoveStance(), [
      { kind: "fixed-temperature", face: "xMin", temperatureK: 300 },
    ]);
    expect(stoveWithWall.ok).toBe(true);
  });

  it("refuses the engine mode's unphysical fields loudly", () => {
    // A rod shorter than the crank cannot assemble.
    const shortRod = declinedAdd(baseDocument(), {
      ...engineStance(),
      geometry: {
        boreMm: 86,
        crankRadiusMm: 43,
        rodLengthMm: 40,
        compressionRatio: 10,
      },
    });
    expect(shortRod.ok).toBe(false);
    if (!shortRod.ok) {
      expect(shortRod.error.message).toContain("rod must be longer");
    }
    // Methane has no published flame-speed fit — the burn-duration
    // grounding declines to guess one.
    const methane = declinedAdd(baseDocument(), {
      ...engineStance(),
      fuel: "CH4" as never,
    });
    expect(methane.ok).toBe(false);
    if (!methane.ok) {
      expect(methane.error.message).toContain("flame-speed fit");
    }
    // Spark outside the compression stroke.
    const lateSpark = declinedAdd(baseDocument(), {
      ...engineStance(),
      spark: { timingBTDCDeg: 200 },
    });
    expect(lateSpark.ok).toBe(false);
  });

  it("refuses the stove mode's off-lattice cadence", () => {
    const offLattice = declinedAdd(baseDocument(), {
      ...stoveStance(),
      sampleIntervalS: 0.7,
    });
    expect(offLattice.ok).toBe(false);
    if (!offLattice.ok) {
      expect(offLattice.error.message).toContain("integer multiple");
    }
  });
});

describe("the structural solve stance (Phase 69)", () => {
  /** The bracket stance's authored fields. */
  function structuralStance(
    overrides?: Partial<SimScenarioStructuralSpec>,
  ): SimScenarioStructuralSpec {
    return { selfWeight: false, ...overrides };
  }

  /** A structural scenario over the base document's body. */
  function structuralFields(stance?: SimScenarioStructuralSpec) {
    return {
      name: "Bracket",
      kind: "structural" as const,
      domain: {
        kind: "explicit" as const,
        min: [-60, -40, 0] as const,
        max: [60, 40, 80] as const,
        resolutionMm: 5,
      },
      conditions: [
        { kind: "fixed-support" as const, face: "zMin" as const },
        {
          kind: "point-load" as const,
          atWorldPointMm: [0, -36, 80] as const,
          forceN: [0, -500, 0] as const,
        },
      ],
      fluid: "air",
      materials: [],
      ...(stance === undefined ? {} : { structural: stance }),
    };
  }

  /**
   * The malformed-stance decline harness (the wire form, untrusted):
   * a valid self-weight-off stance by default, so condition-only cases
   * exercise the conditions array alone.
   */
  const declinedAdd = (
    stance: unknown = { selfWeight: false },
    conditions: readonly unknown[] = [{ kind: "fixed-support", face: "zMin" }],
  ): ReturnType<typeof addDocumentSimulation> =>
    addDocumentSimulation(baseDocument(), {
      name: "Bracket",
      kind: "structural",
      domain: {
        kind: "explicit",
        min: [-60, -40, 0],
        max: [60, 40, 80],
        resolutionMm: 5,
      },
      conditions,
      fluid: "air",
      materials: [],
      structural: stance,
    } as unknown as SimScenarioInput);

  it("adds a structural scenario with its stance and conditions, round-tripping canonically", () => {
    const added = requireOk(
      addDocumentSimulation(
        baseDocument(),
        structuralFields(
          structuralStance({
            selfWeight: true,
            centrifugal: {
              axisPointMm: [0, 0, 0],
              axisDirection: [0, 0, 1],
              rpmMode: "fan-run",
            },
            thermal: { referenceTemperatureK: 293.15 },
          }),
        ),
      ),
      "the structural add",
    );
    const scenario = added.scenario;
    expect(scenario.structural).toBeDefined();
    if (scenario.structural === undefined) return;
    expect(scenario.structural.selfWeight).toBe(true);
    expect(scenario.structural.centrifugal?.rpmMode).toBe("fan-run");
    expect(scenario.structural.centrifugal?.fixedRpm).toBeUndefined();
    expect(scenario.structural.thermal?.referenceTemperatureK).toBe(293.15);
    expect(scenario.conditions).toHaveLength(2);
    const serialized = requireOk(
      parseCadDocument(serializeCadDocument(added.document)),
      "the serialized round-trip",
    );
    const restored = serialized.simulations[0];
    if (restored === undefined) throw new Error("the scenario did not survive");
    expect(restored.structural).toEqual(scenario.structural);
    expect(restored.conditions).toEqual(scenario.conditions);
  });

  it("kind-locks the stance: structural requires it, every other kind refuses it", () => {
    const missing = addDocumentSimulation(
      baseDocument(),
      structuralFields(undefined),
    );
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.message).toContain("structural solve stance");
    }
    const stray = addDocumentSimulation(baseDocument(), {
      ...scenarioFields(),
      structural: structuralStance(),
    });
    expect(stray.ok).toBe(false);
    if (!stray.ok) {
      expect(stray.error.message).toContain("structural kind's alone");
    }
  });

  it("cross-checks the stance's own fields (the iff rules)", () => {
    const noRpm = declinedAdd({
      selfWeight: false,
      centrifugal: {
        axisPointMm: [0, 0, 0],
        axisDirection: [0, 0, 1],
        rpmMode: "fixed",
      },
    });
    expect(noRpm.ok).toBe(false);
    const bothRates = declinedAdd({
      selfWeight: false,
      centrifugal: {
        axisPointMm: [0, 0, 0],
        axisDirection: [0, 0, 1],
        rpmMode: "fan-run",
        fixedRpm: 3000,
      },
    });
    expect(bothRates.ok).toBe(false);
    if (!bothRates.ok) {
      expect(bothRates.error.message).toContain("operating point");
    }
    const zeroAxis = declinedAdd({
      selfWeight: false,
      centrifugal: {
        axisPointMm: [0, 0, 0],
        axisDirection: [0, 0, 0],
        rpmMode: "fixed",
        fixedRpm: 3000,
      },
    });
    expect(zeroAxis.ok).toBe(false);
    const badMode = declinedAdd({
      selfWeight: false,
      centrifugal: {
        axisPointMm: [0, 0, 0],
        axisDirection: [0, 0, 1],
        rpmMode: "motor" as unknown as never,
        fixedRpm: 3000,
      },
    });
    expect(badMode.ok).toBe(false);
    const badSwitch = declinedAdd({ selfWeight: "no" });
    expect(badSwitch.ok).toBe(false);
    const badReference = declinedAdd({
      selfWeight: false,
      thermal: { referenceTemperatureK: -40 },
    });
    expect(badReference.ok).toBe(false);
  });

  it("stores the point-set conditions kind-locked to structural, one per face among the face set", () => {
    // The roller and the point fix parse and round-trip.
    const rolled = requireOk(
      addDocumentSimulation(baseDocument(), {
        ...structuralFields(
          structuralStance({
            centrifugal: {
              axisPointMm: [0, 0, 0],
              axisDirection: [0, 0, 1],
              rpmMode: "fixed",
              fixedRpm: 3000,
            },
          }),
        ),
        conditions: [
          { kind: "axis-fix" as const, face: "yMin" as const, axis: "y" },
          { kind: "point-fix" as const, atWorldPointMm: [10, 0, 0] as const },
        ],
      }),
      "the roller add",
    );
    const kinds = rolled.scenario.conditions.map((condition) => condition.kind);
    expect(kinds).toEqual(["axis-fix", "point-fix"]);

    // A structural condition on another kind declines; a foreign
    // condition on the structural kind declines.
    const stray = addDocumentSimulation(baseDocument(), {
      ...scenarioFields(),
      conditions: [{ kind: "fixed-support", face: "zMin" }],
    });
    expect(stray.ok).toBe(false);
    const foreign = declinedAdd(undefined, [
      {
        kind: "velocity-inlet",
        face: "xMin",
        speedMPerS: 1,
        direction: [1, 0, 0],
      },
    ]);
    expect(foreign.ok).toBe(false);

    // Two face-bearing conditions on one face decline; a point pair
    // beside a face condition does not (the point set is exempt).
    const duplicateFace = declinedAdd(undefined, [
      { kind: "fixed-support", face: "zMin" },
      { kind: "pressure-load", face: "zMin", pressurePa: 1e5 },
    ]);
    expect(duplicateFace.ok).toBe(false);
    if (!duplicateFace.ok) {
      // The document add path wraps the simulation module's structured
      // failure as simulation-invalid, keeping its message — the add
      // boundary's own discipline, asserted by content.
      expect(duplicateFace.error.code).toBe(
        DOCUMENT_ERROR_CODES.simulationInvalid,
      );
      expect(duplicateFace.error.message).toContain(
        "More than one boundary condition",
      );
    }
    const pointPair = declinedAdd(undefined, [
      { kind: "fixed-support", face: "zMin" },
      {
        kind: "point-load",
        atWorldPointMm: [0, -36, 80],
        forceN: [0, -500, 0],
      },
      { kind: "point-fix", atWorldPointMm: [0, -36, 80] },
    ]);
    expect(pointPair.ok).toBe(true);
  });
});

describe("the 3D flow stance (Phase 66c)", () => {
  it("adds a flow scenario with its rotation stance and round-trips it canonically", () => {
    const added = requireOk(
      addDocumentSimulation(baseDocument(), {
        ...scenarioFields(),
        flow3d: {
          boundaryTreatment: "staircase",
          rotation: {
            kind: "mrf",
            axisPointMm: [0, 0, 0],
            axisDirection: [0, 1, 0],
            zoneRadiusMm: 80,
            rpmMode: "fixed",
            fixedRpm: 3000,
            bladeCount: 7,
          },
        },
      }),
      "the 3D stance add",
    );
    const scenario = added.scenario;
    expect(scenario.flow3d).toBeDefined();
    if (scenario.flow3d === undefined) return;
    expect(scenario.flow3d.boundaryTreatment).toBe("staircase");
    expect(scenario.flow3d.rotation?.kind).toBe("mrf");
    expect(scenario.flow3d.rotation?.fixedRpm).toBe(3000);
    expect(scenario.flow3d.rotation?.bladeCount).toBe(7);
    const serialized = requireOk(
      parseCadDocument(serializeCadDocument(added.document)),
      "the serialized round-trip",
    );
    const restored = serialized.simulations[0];
    if (restored === undefined) throw new Error("the scenario did not survive");
    expect(restored.flow3d?.rotation).toEqual(scenario.flow3d.rotation);
    // The default boundary treatment normalizes to absent in canonical
    // form (the provider: "reference" discipline) — semantics preserved.
    expect(restored.flow3d?.boundaryTreatment).toBeUndefined();
  });

  it("round-trips the static 3D door and the motor-driven mode stance", () => {
    const staticAdded = requireOk(
      addDocumentSimulation(baseDocument(), {
        ...scenarioFields(),
        flow3d: {},
      }),
      "the static 3D add",
    );
    const staticSerialized = requireOk(
      parseCadDocument(serializeCadDocument(staticAdded.document)),
      "the static round-trip",
    );
    const staticRestored = staticSerialized.simulations[0];
    if (staticRestored === undefined) {
      throw new Error("the static scenario did not survive");
    }
    expect(staticRestored.flow3d).toEqual(staticAdded.scenario.flow3d);
    expect(staticRestored.flow3d?.rotation).toBeUndefined();

    const { document, motorId } = withMotor();
    const motorDriven = requireOk(
      addDocumentSimulation(document, {
        ...scenarioFields(),
        flow3d: {
          boundaryTreatment: "cut-cell",
          rotation: {
            kind: "resolved-rotation",
            axisPointMm: [10, 0, 0],
            axisDirection: [0.5, 1, 0],
            zoneRadiusMm: 45,
            rpmMode: "motor",
            bladeCount: 5,
          },
        },
        motorId,
      }),
      "the motor-driven add",
    );
    const motorSerialized = requireOk(
      parseCadDocument(serializeCadDocument(motorDriven.document)),
      "the motor round-trip",
    );
    const motorRestored = motorSerialized.simulations[0];
    if (motorRestored === undefined) {
      throw new Error("the motor scenario did not survive");
    }
    expect(motorRestored.flow3d).toEqual(motorDriven.scenario.flow3d);
    expect(motorRestored.flow3d?.rotation?.rpmMode).toBe("motor");
    expect(motorRestored.flow3d?.rotation?.fixedRpm).toBeUndefined();
  });
});

describe("the dynamics solve stance (Phase 67c)", () => {
  /** The demo march's stance: 1 ms steps, 2 s, sampled every 40 ms. */
  function dynamicsStance(
    overrides?: Partial<SimScenarioDynamicsSpec>,
  ): SimScenarioDynamicsSpec {
    return {
      timeStepS: 0.001,
      durationS: 2,
      sampleIntervalS: 0.04,
      ...overrides,
    };
  }

  /** A dynamics scenario over the base document. */
  function dynamicsFields(stance?: SimScenarioDynamicsSpec) {
    return {
      name: "Slider-crank",
      kind: "dynamics" as const,
      domain: {
        kind: "explicit" as const,
        min: [-20, -40, -12] as const,
        max: [150, 40, 12] as const,
        resolutionMm: 2,
      },
      conditions: [],
      fluid: "air",
      materials: [],
      ...(stance === undefined ? {} : { dynamics: stance }),
    };
  }

  /**
   * The malformed-wire decline harness: a stance of untrusted data
   * through the add boundary — the seam the serialized-document parse
   * defends, so the malformed declines are exercised exactly as they
   * arrive off the wire.
   */
  const declinedAdd = (
    document: CadDocument,
    stance: unknown,
    motorId?: MotorId,
  ): ReturnType<typeof addDocumentSimulation> =>
    addDocumentSimulation(document, {
      name: "Slider-crank",
      kind: "dynamics",
      domain: {
        kind: "explicit",
        min: [-20, -40, -12],
        max: [150, 40, 12],
        resolutionMm: 2,
      },
      conditions: [],
      fluid: "air",
      materials: [],
      dynamics: stance,
      ...(motorId === undefined ? {} : { motorId }),
    } as unknown as SimScenarioInput);

  /**
   * A document the stance's references can address: two joined
   * occurrences (a crank and a rod on a z revolute) plus a motor
   * record — the load couplings' and the motor joint's own home.
   */
  function mechanismDocument(): {
    document: CadDocument;
    motorId: MotorId;
  } {
    const crankBody = requireOk(
      addBody(baseDocument(), { name: "Crank" }),
      "the crank body",
    );
    const rodBody = requireOk(
      addBody(crankBody.document, { name: "Rod" }),
      "the rod body",
    );
    const withCrank = requireOk(
      addOccurrence(rodBody.document, {
        id: createOccurrenceId("occ_crank"),
        name: "Crank",
        source: { kind: "body", bodyId: crankBody.body.id },
        placement: { kind: "offset", translation: [0, 0, 0] },
      }),
      "the crank occurrence",
    );
    const withRod = requireOk(
      addOccurrence(withCrank.document, {
        id: createOccurrenceId("occ_rod"),
        name: "Rod",
        source: { kind: "body", bodyId: rodBody.body.id },
        placement: { kind: "offset", translation: [30, 0, 0] },
      }),
      "the rod occurrence",
    );
    const joined = requireOk(
      addJoint(withRod.document, {
        id: createJointId("jnt_crank"),
        name: "Crank main bearing",
        kind: "revolute",
        baseOccurrenceId: createOccurrenceId("occ_crank"),
        occurrenceId: createOccurrenceId("occ_rod"),
        frame: { origin: [0, 0, 0], axis: [0, 0, 1] },
      }),
      "the crank joint",
    );
    const motored = requireOk(
      addDocumentMotor(joined.document, {
        id: createMotorId("mot_crank-drive"),
        name: "Crank drive",
        kind: "dc-brushed",
        stallTorqueMNm: 80,
        noLoadSpeedRpm: 1500,
        nominalVoltageV: 12,
      }),
      "the motor add",
    );
    return { document: motored.document, motorId: motored.motor.id };
  }

  it("adds a dynamics scenario with its stance and round-trips it canonically", () => {
    const { document, motorId } = mechanismDocument();
    const added = requireOk(
      addDocumentSimulation(document, {
        ...dynamicsFields(
          dynamicsStance({
            motorJointId: createJointId("jnt_crank"),
            loads: [
              {
                kind: "flow-force",
                occurrenceId: createOccurrenceId("occ_rod"),
                samples: [
                  { tS: 0, forceN: [1, 0, 0], atWorldPointMm: [10, 0, 0] },
                  { tS: 2, forceN: [2, 0, 0] },
                ],
              },
              {
                kind: "joint-torque",
                name: "combustion estimate",
                jointId: createJointId("jnt_crank"),
                samples: [
                  { tS: 0, effortNPerM: 0 },
                  { tS: 2, effortNPerM: 0.01 },
                ],
              },
            ],
          }),
        ),
        motorId,
      }),
      "the dynamics add",
    );
    const scenario = added.scenario;
    expect(scenario.dynamics).toBeDefined();
    if (scenario.dynamics === undefined) return;
    expect(scenario.dynamics.timeStepS).toBe(0.001);
    expect(scenario.dynamics.durationS).toBe(2);
    expect(scenario.dynamics.sampleIntervalS).toBe(0.04);
    expect(scenario.dynamics.provider).toBeUndefined();
    expect(scenario.dynamics.loads).toHaveLength(2);
    const serialized = requireOk(
      parseCadDocument(serializeCadDocument(added.document)),
      "the serialized round-trip",
    );
    const restored = serialized.simulations[0];
    if (restored === undefined) throw new Error("the scenario did not survive");
    expect(restored.dynamics).toEqual(scenario.dynamics);
  });

  it("kind-locks the stance: dynamics requires it, every other kind refuses it", () => {
    const missing = addDocumentSimulation(baseDocument(), dynamicsFields());
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.message).toContain("dynamics solve stance");
    }
    const stray = addDocumentSimulation(baseDocument(), {
      ...scenarioFields(),
      dynamics: dynamicsStance(),
    });
    expect(stray.ok).toBe(false);
    if (!stray.ok) {
      expect(stray.error.message).toContain("dynamics kind's alone");
    }
    const malformed = declinedAdd(baseDocument(), "not an object");
    expect(malformed.ok).toBe(false);
  });

  it("declines budgets off the step lattice and cadences off the step grid", () => {
    const offLattice = declinedAdd(
      baseDocument(),
      dynamicsStance({ timeStepS: 0.003, durationS: 1 }),
    );
    expect(offLattice.ok).toBe(false);
    if (!offLattice.ok) {
      expect(offLattice.error.message).toContain("integer multiple");
    }
    const offGrid = declinedAdd(
      baseDocument(),
      dynamicsStance({ sampleIntervalS: 0.0005 }),
    );
    expect(offGrid.ok).toBe(false);
    if (!offGrid.ok) {
      expect(offGrid.error.message).toContain("integer number of time steps");
    }
    const pastDuration = declinedAdd(
      baseDocument(),
      dynamicsStance({ sampleIntervalS: 4 }),
    );
    expect(pastDuration.ok).toBe(false);
    const badStep = declinedAdd(
      baseDocument(),
      dynamicsStance({ timeStepS: 0 }),
    );
    expect(badStep.ok).toBe(false);
    const badProvider = declinedAdd(baseDocument(), {
      ...dynamicsStance(),
      provider: "warp",
    });
    expect(badProvider.ok).toBe(false);
  });

  it("rides the motor joint exactly when the record selects a motor (the iff rule)", () => {
    const { document, motorId } = mechanismDocument();
    const withoutMotor = declinedAdd(
      document,
      dynamicsStance({ motorJointId: createJointId("jnt_crank") }),
    );
    expect(withoutMotor.ok).toBe(false);
    if (!withoutMotor.ok) {
      expect(withoutMotor.error.message).toContain("exactly when");
    }
    const withoutJoint = declinedAdd(document, dynamicsStance(), motorId);
    expect(withoutJoint.ok).toBe(false);
    if (!withoutJoint.ok) {
      expect(withoutJoint.error.message).toContain("names no motor joint");
    }
    const malformedJoint = declinedAdd(
      document,
      { ...dynamicsStance(), motorJointId: "crank" },
      motorId,
    );
    expect(malformedJoint.ok).toBe(false);
    const paired = addDocumentSimulation(document, {
      ...dynamicsFields(
        dynamicsStance({ motorJointId: createJointId("jnt_crank") }),
      ),
      motorId,
    });
    expect(paired.ok).toBe(true);
    if (paired.ok) {
      expect(paired.value.scenario.motorId).toBe(motorId);
      expect(paired.value.scenario.dynamics?.motorJointId).toBe("jnt_crank");
    }
  });

  it("validates the load couplings' kinds, samples, and names", () => {
    const declined = (entry: unknown, fragment: string): void => {
      const refused = declinedAdd(baseDocument(), {
        ...dynamicsStance(),
        loads: [entry],
      });
      expect(refused.ok).toBe(false);
      if (!refused.ok) {
        expect(refused.error.message).toContain(fragment);
      }
    };
    declined(
      { kind: "wind-force", occurrenceId: "occ_piston", samples: [] },
      '"flow-force" or "joint-torque"',
    );
    declined("not a record", "plain object");
    declined(
      {
        kind: "flow-force",
        occurrenceId: "piston",
        samples: [
          { tS: 0, forceN: [1, 0, 0] },
          { tS: 1, forceN: [1, 0, 0] },
        ],
      },
      "valid occurrence id",
    );
    declined(
      {
        kind: "flow-force",
        occurrenceId: "occ_piston",
        samples: [{ tS: 0, forceN: [1, 0, 0] }],
      },
      "at least two samples",
    );
    declined(
      {
        kind: "flow-force",
        occurrenceId: "occ_piston",
        samples: [
          { tS: 1, forceN: [1, 0, 0] },
          { tS: 0, forceN: [1, 0, 0] },
        ],
      },
      "strictly increasing",
    );
    declined(
      {
        kind: "flow-force",
        occurrenceId: "occ_piston",
        samples: [
          { tS: 0, forceN: [1, 0, 0] },
          { tS: 3, forceN: [1, 0, 0] },
        ],
      },
      "inside the stance's duration",
    );
    declined(
      {
        kind: "flow-force",
        occurrenceId: "occ_piston",
        samples: [
          { tS: 0, forceN: [1, 0] },
          { tS: 1, forceN: [1, 0, 0] },
        ],
      },
      "force",
    );
    declined(
      {
        kind: "joint-torque",
        name: "estimate",
        jointId: "crank",
        samples: [
          { tS: 0, effortNPerM: 0 },
          { tS: 1, effortNPerM: 0 },
        ],
      },
      "valid joint id",
    );
    declined(
      {
        kind: "joint-torque",
        name: "estimate",
        jointId: "jnt_crank",
        samples: [
          { tS: 0, effortNPerM: 0 },
          { tS: 1, effortNPerM: Number.NaN },
        ],
      },
      "finite number",
    );
    declined(
      {
        kind: "joint-torque",
        name: "   ",
        jointId: "jnt_crank",
        samples: [
          { tS: 0, effortNPerM: 0 },
          { tS: 1, effortNPerM: 0 },
        ],
      },
      "1-64 characters",
    );
    // One name per estimate: two torques on the SAME joint still split
    // by name, a repeated name is the ambiguity the boundary refuses.
    const twice = declinedAdd(baseDocument(), {
      ...dynamicsStance(),
      loads: [
        {
          kind: "joint-torque",
          name: "estimate",
          jointId: "jnt_crank",
          samples: [
            { tS: 0, effortNPerM: 0 },
            { tS: 1, effortNPerM: 0 },
          ],
        },
        {
          kind: "joint-torque",
          name: "estimate",
          jointId: "jnt_crank",
          samples: [
            { tS: 0, effortNPerM: 0 },
            { tS: 1, effortNPerM: 0 },
          ],
        },
      ],
    });
    expect(twice.ok).toBe(false);
    if (!twice.ok) {
      expect(twice.error.message).toContain("appears twice");
    }
  });

  it("cross-checks the stance's joint and load references at the document boundary", () => {
    const { document, motorId } = mechanismDocument();

    const unknownJoint = addDocumentSimulation(document, {
      ...dynamicsFields(
        dynamicsStance({ motorJointId: createJointId("jnt_ghost") }),
      ),
      motorId,
    });
    expect(unknownJoint.ok).toBe(false);
    if (!unknownJoint.ok) {
      expect(unknownJoint.error.code).toBe(
        DOCUMENT_ERROR_CODES.simulationInvalid,
      );
      expect(unknownJoint.error.message).toContain("does not exist");
    }

    const knownJoint = addDocumentSimulation(document, {
      ...dynamicsFields(
        dynamicsStance({ motorJointId: createJointId("jnt_crank") }),
      ),
      motorId,
    });
    expect(knownJoint.ok).toBe(true);

    const unknownOccurrenceLoad = addDocumentSimulation(
      document,
      dynamicsFields(
        dynamicsStance({
          loads: [
            {
              kind: "flow-force",
              occurrenceId: createOccurrenceId("occ_ghost"),
              samples: [
                { tS: 0, forceN: [1, 0, 0] },
                { tS: 1, forceN: [1, 0, 0] },
              ],
            },
          ],
        }),
      ),
    );
    expect(unknownOccurrenceLoad.ok).toBe(false);
    if (!unknownOccurrenceLoad.ok) {
      expect(unknownOccurrenceLoad.error.message).toContain(
        "flow-force load to occurrence",
      );
    }

    const unknownJointLoad = addDocumentSimulation(
      document,
      dynamicsFields(
        dynamicsStance({
          loads: [
            {
              kind: "joint-torque",
              name: "estimate",
              jointId: createJointId("jnt_ghost"),
              samples: [
                { tS: 0, effortNPerM: 0 },
                { tS: 1, effortNPerM: 0 },
              ],
            },
          ],
        }),
      ),
    );
    expect(unknownJointLoad.ok).toBe(false);
    if (!unknownJointLoad.ok) {
      expect(unknownJointLoad.error.message).toContain(
        "torque estimate to joint",
      );
    }

    const knownLoads = addDocumentSimulation(document, {
      ...dynamicsFields(
        dynamicsStance({
          loads: [
            {
              kind: "flow-force",
              occurrenceId: createOccurrenceId("occ_rod"),
              samples: [
                { tS: 0, forceN: [1, 0, 0] },
                { tS: 1, forceN: [1, 0, 0] },
              ],
            },
            {
              kind: "joint-torque",
              name: "estimate",
              jointId: createJointId("jnt_crank"),
              samples: [
                { tS: 0, effortNPerM: 0 },
                { tS: 1, effortNPerM: 0 },
              ],
            },
          ],
        }),
      ),
    });
    expect(knownLoads.ok).toBe(true);
  });
});
