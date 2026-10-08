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
  applyCommand,
  applyTransaction,
  type CadCommand,
  type CadDocument,
  createBodyId,
  createDocument,
  createDocumentId,
  createMotorId,
  createNativeCadDocument,
  createSimulationId,
  DOCUMENT_ERROR_CODES,
  type DocumentHistory,
  type DocumentMaterialRecord,
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

  it("stores the reserved structural kind without a solver (the Phase 69 carve)", () => {
    const added = requireOk(
      addDocumentSimulation(baseDocument(), {
        ...scenarioFields(),
        kind: "structural",
        conditions: [{ kind: "fixed-support", face: "zMax" }],
      }),
      "the structural add",
    );
    expect(added.scenario.kind).toBe("structural");
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

  it("migrates v9-stamped content through the identity step to v10", () => {
    const native = nativeWithSimulationHistory();
    const text = stringifyNativeCadDocument(serializeNativeCadDocument(native));
    expect(readNativeFormatVersion(JSON.parse(text))).toBe(10);
    const asV9 = {
      ...(JSON.parse(text) as Record<string, unknown>),
      formatVersion: 9,
    };
    const migrated = requireOk(migrateNativeCadDocument(asV9), "the migration");
    expect(readNativeFormatVersion(migrated)).toBe(10);
    // Identity: nothing but the stamp changed.
    const migratedRecord = migrated as Record<string, unknown>;
    const expected = JSON.parse(text) as Record<string, unknown>;
    const { formatVersion: migratedStamp, ...migratedContent } = migratedRecord;
    const { formatVersion: expectedStamp, ...expectedContent } = expected;
    expect(migratedStamp).toBe(10);
    expect(expectedStamp).toBe(10);
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
