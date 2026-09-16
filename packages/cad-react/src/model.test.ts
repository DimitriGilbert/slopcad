/**
 * Model API tests: the composable React model API builds ONLY Phase 7
 * command data. The round-trip through the domain's own
 * `serializeTransaction`/`parseTransaction` is the pin — what the builders
 * emit is exactly the vocabulary the session commits and the command log
 * serializes; no second representation exists to test.
 */

import { describe, expect, it } from "vitest";
import {
  createBodyId,
  createFeatureId,
  createParameterId,
  length,
  parseTransaction,
  serializeTransaction,
} from "@slopcad/cad-core";

import {
  cadTransaction,
  createFeatureCommand,
  createPrimitiveTransaction,
  deleteFeatureCommand,
  removeFeatureTransaction,
  setParameterCommand,
  updateFeatureCommand,
  updatePrimitiveTransaction,
} from "./model";

const WIDTH = createParameterId("param_width");
const PLATE = createFeatureId("feat_plate");
const BODY = createBodyId("body_plate");

describe("command factories", () => {
  it("builds the exact Phase 7 vocabulary", () => {
    expect(setParameterCommand(WIDTH, length(10))).toEqual({
      type: "parameter.set",
      id: WIDTH,
      value: { dimension: "length", unit: "mm", value: 10 },
    });
    expect(
      createFeatureCommand({
        kind: "plate",
        inputs: [{ kind: "parameter", id: WIDTH }],
        outputs: [BODY],
      }),
    ).toEqual({
      type: "feature.create",
      kind: "plate",
      inputs: [{ kind: "parameter", id: WIDTH }],
      outputs: [BODY],
    });
    expect(
      createFeatureCommand({
        id: PLATE,
        kind: "plate",
        inputs: [],
        outputs: [BODY],
      }),
    ).toEqual({
      type: "feature.create",
      id: PLATE,
      kind: "plate",
      inputs: [],
      outputs: [BODY],
    });
    expect(
      updateFeatureCommand({
        id: PLATE,
        kind: "bracket",
        inputs: [],
        outputs: [BODY],
      }),
    ).toEqual({
      type: "feature.update",
      id: PLATE,
      kind: "bracket",
      inputs: [],
      outputs: [BODY],
    });
    expect(deleteFeatureCommand(PLATE)).toEqual({
      type: "feature.delete",
      id: PLATE,
    });
  });
});

describe("transaction factories", () => {
  it("orders a primitive's parameter assignments before its feature command", () => {
    const transaction = createPrimitiveTransaction({
      parameters: [
        { id: WIDTH, value: length(20) },
        { id: createParameterId("param_height"), value: length(5) },
      ],
      feature: {
        id: PLATE,
        kind: "plate",
        inputs: [{ kind: "parameter", id: WIDTH }],
        outputs: [BODY],
      },
    });
    expect(transaction.commands.map((command) => command.type)).toEqual([
      "parameter.set",
      "parameter.set",
      "feature.create",
    ]);
  });

  it("updatePrimitiveTransaction composes assignments with feature.update", () => {
    const transaction = updatePrimitiveTransaction({
      parameters: [{ id: WIDTH, value: length(30) }],
      feature: {
        id: PLATE,
        kind: "plate",
        inputs: [],
        outputs: [BODY],
      },
    });
    expect(transaction.commands.map((command) => command.type)).toEqual([
      "parameter.set",
      "feature.update",
    ]);
  });

  it("removeFeatureTransaction is the single delete command", () => {
    expect(removeFeatureTransaction(PLATE)).toEqual({
      commands: [{ type: "feature.delete", id: PLATE }],
    });
  });

  it("composes ad-hoc command lists in declared order", () => {
    const transaction = cadTransaction(
      setParameterCommand(WIDTH, length(1)),
      deleteFeatureCommand(PLATE),
    );
    expect(transaction.commands).toHaveLength(2);
  });
});

describe("no second representation", () => {
  it("built transactions round-trip through the domain's own canonical serialization", () => {
    const transaction = createPrimitiveTransaction({
      parameters: [{ id: WIDTH, value: length(20) }],
      feature: {
        id: PLATE,
        kind: "plate",
        inputs: [{ kind: "parameter", id: WIDTH }],
        outputs: [BODY],
      },
    });
    const serialized = serializeTransaction(transaction);
    const parsed = parseTransaction(JSON.parse(JSON.stringify(serialized)));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value).toEqual(transaction);
    }
  });
});
