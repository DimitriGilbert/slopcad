/**
 * The worker operation vocabulary (Phase 10.1): every operation's input and
 * result serializes to canonical data and parses back, malformed payloads are
 * rejected with stable codes, and wire canonicalization follows cad-core's
 * dimensional-value conventions.
 */

import { describe, expect, it } from "vitest";
import { length, type ParseResult } from "@slopcad/cad-core";

import {
  isWorkerOperationId,
  parseWorkerOperationInput,
  parseWorkerOperationResult,
  serializeWorkerOperationInput,
  serializeWorkerOperationResult,
  type WorkerOperationId,
  type WorkerOperationInput,
  WORKER_OPERATION_IDS,
} from "./worker-operations";
import {
  WORKER_PROTOCOL_ERROR_CODES,
  type WorkerParseError,
} from "./worker-errors";
import { createWorkerSolidId, type WorkerSolidId } from "./worker-ids";

function failureOf(
  result: ParseResult<unknown, WorkerParseError>,
): WorkerParseError {
  if (result.ok) throw new Error("Expected the parse to fail.");
  return result.error;
}

function jsonRoundTrip<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const solidA = createWorkerSolidId("wsol_000001");
const solidB = createWorkerSolidId("wsol_000002");
const solidC = createWorkerSolidId("wsol_000003");
const mm = (value: number) => length(value, "mm");

describe("operation vocabulary", () => {
  it("covers exactly the kernel contract operations as data", () => {
    expect(WORKER_OPERATION_IDS).toEqual([
      "solid.createBox",
      "solid.createSphere",
      "solid.createCylinder",
      "solid.createCone",
      "solid.union",
      "solid.subtract",
      "solid.intersect",
      "solid.transform",
      "solid.bounds",
      "solid.volume",
      "solid.tessellate",
      "solid.dispose",
    ]);
  });

  it("recognizes known operation names and rejects unknown ones", () => {
    expect(isWorkerOperationId("solid.volume")).toBe(true);
    expect(isWorkerOperationId("document.rebuild")).toBe(false);
    expect(isWorkerOperationId(42)).toBe(false);
    expect(isWorkerOperationId(undefined)).toBe(false);
  });
});

describe("operation input round-trips", () => {
  function expectInputRoundTrip<O extends WorkerOperationId>(
    operation: O,
    input: WorkerOperationInput<O>,
  ): void {
    const wire = serializeWorkerOperationInput(operation, input);
    const parsed = parseWorkerOperationInput(operation, jsonRoundTrip(wire));
    expect(parsed).toEqual({ ok: true, value: input });
  }

  it("round-trips every primitive input", () => {
    expectInputRoundTrip("solid.createBox", {
      width: mm(10),
      depth: mm(20),
      height: mm(30),
    });
    expectInputRoundTrip("solid.createSphere", { radius: mm(4) });
    expectInputRoundTrip("solid.createCylinder", {
      radius: mm(2),
      height: mm(8),
    });
    expectInputRoundTrip("solid.createCone", {
      bottomRadius: mm(3),
      topRadius: mm(1),
      height: mm(9),
    });
  });

  it("round-trips boolean, transform, and single-solid inputs", () => {
    expectInputRoundTrip("solid.union", { operands: [solidA, solidB] });
    expectInputRoundTrip("solid.intersect", { operands: [solidA, solidB] });
    expectInputRoundTrip("solid.subtract", {
      target: solidA,
      tools: [solidB, solidC],
    });
    expectInputRoundTrip("solid.transform", {
      solid: solidA,
      translation: { x: mm(1), y: mm(-2), z: mm(3) },
    });
    expectInputRoundTrip("solid.bounds", { solid: solidA });
    expectInputRoundTrip("solid.volume", { solid: solidA });
    expectInputRoundTrip("solid.tessellate", { solid: solidA });
    expectInputRoundTrip("solid.dispose", { solid: solidA });
  });

  it("serializes lengths in the canonical key order and unit", () => {
    const wire = serializeWorkerOperationInput("solid.createSphere", {
      radius: length(2, "cm"),
    });
    expect(Object.keys(wire)).toEqual(["radius"]);
    expect(wire).toEqual({
      radius: { dimension: "length", unit: "mm", value: 20 },
    });
  });

  it("parses any length unit into the typed dimensional value", () => {
    const parsed = parseWorkerOperationInput("solid.createSphere", {
      radius: { dimension: "length", unit: "cm", value: 2 },
    });
    expect(parsed).toEqual({ ok: true, value: { radius: length(2, "cm") } });
  });

  it("keeps solid references in fixed wire key order", () => {
    const wire = serializeWorkerOperationInput("solid.subtract", {
      target: solidA,
      tools: [solidB],
    });
    expect(Object.keys(wire)).toEqual(["target", "tools"]);
    const transformWire = serializeWorkerOperationInput("solid.transform", {
      solid: solidA,
      translation: { x: mm(1), y: mm(2), z: mm(3) },
    });
    expect(Object.keys(transformWire)).toEqual(["solid", "translation"]);
    expect(Object.keys(transformWire.translation)).toEqual(["x", "y", "z"]);
  });
});

describe("operation input validation", () => {
  it("rejects non-object payloads with malformed-payload", () => {
    for (const payload of [null, 42, "box", [], true]) {
      expect(
        failureOf(parseWorkerOperationInput("solid.createBox", payload)).code,
      ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    }
  });

  it("rejects missing or invalid length fields", () => {
    expect(
      failureOf(parseWorkerOperationInput("solid.createBox", {})).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    expect(
      failureOf(
        parseWorkerOperationInput("solid.createBox", {
          width: { dimension: "length", unit: "mm", value: 1 },
          depth: { dimension: "length", unit: "mm", value: 1 },
          height: { dimension: "angle", unit: "deg", value: 90 },
        }),
      ).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    expect(
      failureOf(
        parseWorkerOperationInput("solid.createCylinder", {
          radius: { dimension: "length", unit: "km", value: 1 },
          height: "tall",
        }),
      ).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
  });

  it("rejects invalid solid references", () => {
    expect(
      failureOf(parseWorkerOperationInput("solid.volume", { solid: "box_1" }))
        .code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    expect(failureOf(parseWorkerOperationInput("solid.dispose", {})).code).toBe(
      WORKER_PROTOCOL_ERROR_CODES.malformedPayload,
    );
  });

  it("rejects malformed operand lists", () => {
    expect(
      failureOf(parseWorkerOperationInput("solid.union", { operands: "many" }))
        .code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    expect(
      failureOf(
        parseWorkerOperationInput("solid.intersect", {
          operands: [solidA, "wsol_not an id"],
        }),
      ).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    expect(
      failureOf(
        parseWorkerOperationInput("solid.subtract", {
          target: solidA,
          tools: [null],
        }),
      ).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
  });

  it("rejects malformed transform translations", () => {
    expect(
      failureOf(
        parseWorkerOperationInput("solid.transform", {
          solid: solidA,
          translation: { x: mm(1), y: mm(2) },
        }),
      ).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    expect(
      failureOf(
        parseWorkerOperationInput("solid.transform", {
          solid: solidA,
          translation: "up",
        }),
      ).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
  });

  it("is structurally tolerant: zero operands and negative lengths parse (kernel semantics decide)", () => {
    expect(parseWorkerOperationInput("solid.union", { operands: [] }).ok).toBe(
      true,
    );
    expect(
      parseWorkerOperationInput("solid.createSphere", {
        radius: { dimension: "length", unit: "mm", value: -5 },
      }).ok,
    ).toBe(true);
  });

  it("ignores unknown fields so newer payload revisions deserialize", () => {
    const parsed = parseWorkerOperationInput("solid.volume", {
      solid: solidA,
      futureField: { nested: true },
    });
    expect(parsed).toEqual({ ok: true, value: { solid: solidA } });
  });

  it("rejects a corrupted field for every operation in the vocabulary", () => {
    const malformedByOperation: Readonly<Record<WorkerOperationId, unknown>> = {
      "solid.createBox": { width: "wide", depth: 2, height: 3 },
      "solid.createSphere": { radius: null },
      "solid.createCylinder": { radius: 1, height: "tall" },
      "solid.createCone": {
        bottomRadius: 1,
        topRadius: "pointy",
        height: 2,
      },
      "solid.union": { operands: [solidA, 5] },
      "solid.subtract": { target: "not-an-id", tools: [] },
      "solid.intersect": { operands: {} },
      "solid.transform": {
        solid: solidA,
        translation: { x: "left", y: 2, z: 3 },
      },
      "solid.bounds": { solid: 42 },
      "solid.volume": {},
      "solid.tessellate": { solid: "wsol_" },
      "solid.dispose": { solid: [] },
    };
    for (const operation of WORKER_OPERATION_IDS) {
      expect(
        failureOf(
          parseWorkerOperationInput(operation, malformedByOperation[operation]),
        ).code,
        `operation ${operation}`,
      ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    }
  });

  it("rejects non-record payloads for every operation in the vocabulary", () => {
    for (const operation of WORKER_OPERATION_IDS) {
      for (const payload of [null, [], 42]) {
        expect(
          failureOf(parseWorkerOperationInput(operation, payload)).code,
          `operation ${operation}`,
        ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
      }
    }
  });
});

describe("operation result round-trips", () => {
  it("round-trips a solid result", () => {
    const wire = serializeWorkerOperationResult("solid.createBox", {
      solid: solidB,
    });
    expect(
      parseWorkerOperationResult("solid.createBox", jsonRoundTrip(wire)),
    ).toEqual({ ok: true, value: { solid: solidB } });
  });

  it("round-trips every solid-producing operation's result", () => {
    const solidOperations = [
      "solid.createBox",
      "solid.createSphere",
      "solid.createCylinder",
      "solid.createCone",
      "solid.union",
      "solid.subtract",
      "solid.intersect",
      "solid.transform",
    ] as const;
    for (const operation of solidOperations) {
      const wire = serializeWorkerOperationResult(operation, { solid: solidB });
      expect(
        parseWorkerOperationResult(operation, jsonRoundTrip(wire)),
        `operation ${operation}`,
      ).toEqual({ ok: true, value: { solid: solidB } });
    }
  });

  it("round-trips a bounds result", () => {
    const wire = serializeWorkerOperationResult("solid.bounds", {
      bounds: { min: [0, -1, 0], max: [10, 1, 4] },
    });
    expect(Object.keys(wire.bounds)).toEqual(["min", "max"]);
    expect(
      parseWorkerOperationResult("solid.bounds", jsonRoundTrip(wire)),
    ).toEqual({
      ok: true,
      value: { bounds: { min: [0, -1, 0], max: [10, 1, 4] } },
    });
  });

  it("round-trips a volume result", () => {
    expect(
      parseWorkerOperationResult(
        "solid.volume",
        jsonRoundTrip(
          serializeWorkerOperationResult("solid.volume", { volume: 8000 }),
        ),
      ),
    ).toEqual({ ok: true, value: { volume: 8000 } });
  });

  it("round-trips a tessellation result, with and without normals", () => {
    const withNormals = {
      tessellation: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
        normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
      },
    };
    expect(
      parseWorkerOperationResult(
        "solid.tessellate",
        jsonRoundTrip(
          serializeWorkerOperationResult("solid.tessellate", withNormals),
        ),
      ),
    ).toEqual({ ok: true, value: withNormals });
    const bare = {
      tessellation: {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 2],
      },
    };
    expect(
      parseWorkerOperationResult(
        "solid.tessellate",
        jsonRoundTrip(serializeWorkerOperationResult("solid.tessellate", bare)),
      ),
    ).toEqual({ ok: true, value: bare });
  });

  it("round-trips an empty-solid tessellation", () => {
    const empty = { tessellation: { positions: [], indices: [] } };
    expect(
      parseWorkerOperationResult(
        "solid.tessellate",
        jsonRoundTrip(
          serializeWorkerOperationResult("solid.tessellate", empty),
        ),
      ),
    ).toEqual({ ok: true, value: empty });
  });

  it("round-trips the null dispose result", () => {
    expect(serializeWorkerOperationResult("solid.dispose", null)).toBeNull();
    expect(parseWorkerOperationResult("solid.dispose", null)).toEqual({
      ok: true,
      value: null,
    });
  });
});

describe("operation result validation", () => {
  it("rejects a solid result without a valid solid id", () => {
    expect(
      failureOf(parseWorkerOperationResult("solid.union", { solid: 7 })).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    expect(
      failureOf(parseWorkerOperationResult("solid.transform", {})).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
  });

  it("rejects bounds that are not two triples of finite numbers", () => {
    expect(
      failureOf(
        parseWorkerOperationResult("solid.bounds", {
          bounds: { min: [0, 0], max: [1, 1, 1] },
        }),
      ).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    expect(
      failureOf(
        parseWorkerOperationResult("solid.bounds", {
          bounds: { min: [0, 0, Infinity], max: [1, 1, 1] },
        }),
      ).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    expect(
      failureOf(parseWorkerOperationResult("solid.bounds", { bounds: "big" }))
        .code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
  });

  it("rejects non-finite or negative volumes", () => {
    expect(
      failureOf(parseWorkerOperationResult("solid.volume", { volume: -1 }))
        .code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    expect(
      failureOf(parseWorkerOperationResult("solid.volume", { volume: NaN }))
        .code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
  });

  it("rejects tessellations that violate the contract's structural guarantees", () => {
    const cases: readonly unknown[] = [
      { tessellation: { positions: [0, 0], indices: [] } },
      { tessellation: { positions: [0, 0, 0], indices: [0, 0.5, 0] } },
      { tessellation: { positions: [0, 0, 0], indices: [0, 0, 3] } },
      { tessellation: { positions: [0, 0, 0], indices: [0, -1, 0] } },
      {
        tessellation: {
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          indices: [0, 1, 2],
          normals: [0, 0, 1],
        },
      },
      { tessellation: { positions: "flat", indices: [] } },
      { tessellation: { positions: [0, 0, 0], indices: "tri" } },
      {
        tessellation: {
          positions: [0, 0, 0],
          indices: [0, 0, 0],
          normals: "flat",
        },
      },
      {},
    ];
    for (const payload of cases) {
      expect(
        failureOf(parseWorkerOperationResult("solid.tessellate", payload)).code,
      ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    }
  });

  it("rejects a dispose result that is not null", () => {
    expect(
      failureOf(parseWorkerOperationResult("solid.dispose", { disposed: true }))
        .code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
  });
});

describe("solid id round-trip through the wire", () => {
  it("keeps solid references stable across serialize, JSON, and parse", () => {
    const id: WorkerSolidId = solidC;
    const wire = serializeWorkerOperationInput("solid.volume", { solid: id });
    const parsed = parseWorkerOperationInput(
      "solid.volume",
      jsonRoundTrip(wire),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.solid).toBe(id);
  });
});
