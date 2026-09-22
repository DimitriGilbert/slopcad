/**
 * The worker operation vocabulary (Phase 10.1): every operation's input and
 * result serializes to canonical data and parses back, malformed payloads are
 * rejected with stable codes, and wire canonicalization follows cad-core's
 * dimensional-value conventions.
 */

import { describe, expect, it } from "vitest";
import {
  angle,
  createBodyId,
  length,
  type ParseResult,
} from "@slopcad/cad-core";

import { decodeBase64Strict, encodeBase64 } from "./worker-base64";
import {
  isWorkerOperationId,
  parseWorkerOperationInput,
  parseWorkerOperationResult,
  resultMintsSolids,
  serializeWorkerOperationInput,
  serializeWorkerOperationResult,
  type WorkerBrepImportResult,
  type WorkerOperationId,
  type WorkerOperationInput,
  type WorkerStepImportResult,
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
  it("covers exactly the kernel contract operations as data plus the disclosed step and brep extension groups", () => {
    expect(WORKER_OPERATION_IDS).toEqual([
      "solid.createBox",
      "solid.createSphere",
      "solid.createCylinder",
      "solid.createCone",
      "solid.extrude",
      "solid.revolve",
      "solid.sweep",
      "solid.helixSweep",
      "solid.loft",
      "solid.union",
      "solid.subtract",
      "solid.intersect",
      "solid.transform",
      "solid.bounds",
      "solid.volume",
      "solid.area",
      "solid.tessellate",
      "solid.dispose",
      "solid.fillet",
      "solid.chamfer",
      "solid.shell",
      "solid.thicken",
      "solid.mirror",
      "solid.moveFace",
      "solid.replaceFace",
      "solid.deleteFace",
      "solid.topology",
      "step.import",
      "step.export",
      "brep.import",
      "brep.export",
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

  it("round-trips the fillet input with its snapshot ordinals and radius", () => {
    expectInputRoundTrip("solid.fillet", {
      target: solidA,
      edges: [0, 2],
      radius: mm(3),
    });
  });

  it("round-trips the chamfer input with its snapshot ordinals and distance", () => {
    expectInputRoundTrip("solid.chamfer", {
      target: solidA,
      edges: [0, 2],
      distance: mm(3),
    });
  });

  it("round-trips the shell input with its snapshot face ordinals and thickness", () => {
    expectInputRoundTrip("solid.shell", {
      target: solidA,
      faces: [5],
      thickness: mm(2),
    });
  });

  it("round-trips the extrude input with the optional draft taper (Phase 41)", () => {
    const placement = {
      rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
      translation: { x: mm(0), y: mm(0), z: mm(0) },
    };
    const loop = [
      { kind: "line" as const, start: [0, 0] as const, end: [4, 0] as const },
      { kind: "line" as const, start: [4, 0] as const, end: [4, 4] as const },
      { kind: "line" as const, start: [4, 4] as const, end: [0, 4] as const },
      { kind: "line" as const, start: [0, 4] as const, end: [0, 0] as const },
    ];
    // Without the taper: the pre-extension byte shape (no field).
    const plain = serializeWorkerOperationInput("solid.extrude", {
      loop,
      height: mm(10),
      direction: 1,
      placement,
    });
    expect("taper" in (plain as Record<string, unknown>)).toBe(false);
    expectInputRoundTrip("solid.extrude", {
      loop,
      height: mm(10),
      direction: 1,
      placement,
      taper: angle(0.08726646259971647),
    });
  });

  it("round-trips the transform input with the optional uniform scale (Phase 41)", () => {
    const plain = serializeWorkerOperationInput("solid.transform", {
      solid: solidA,
      translation: { x: mm(1), y: mm(-2), z: mm(3) },
    });
    expect("scale" in (plain as Record<string, unknown>)).toBe(false);
    expectInputRoundTrip("solid.transform", {
      solid: solidA,
      translation: { x: mm(1), y: mm(-2), z: mm(3) },
      scale: 2,
    });
    expectInputRoundTrip("solid.transform", {
      solid: solidA,
      translation: { x: mm(1), y: mm(-2), z: mm(3) },
      rotation: { axis: [0, 0, 1], angle: angle(Math.PI / 2) },
      scale: 0.5,
    });
  });

  it("round-trips the thicken input with its wall thickness (Phase 41)", () => {
    expectInputRoundTrip("solid.thicken", {
      target: solidA,
      thickness: mm(2),
    });
  });

  it("round-trips the mirror input with its plane axis and offset", () => {
    expectInputRoundTrip("solid.mirror", {
      target: solidA,
      axis: "x",
      offset: mm(-7),
    });
  });

  it("round-trips the topology input with its labeled body and regeneration", () => {
    expectInputRoundTrip("solid.topology", {
      solid: solidA,
      bodyId: createBodyId("body_fillet_fixture"),
      regeneration: 7,
    });
  });

  it("round-trips the topology result snapshot verbatim", () => {
    const snapshot = {
      kernelId: "opencascade",
      persistentTopology: true,
      identitySchemas: ["occt-shape-hash-v1"],
      bodyId: createBodyId("body_fillet_fixture"),
      regeneration: 7,
      entities: [
        {
          kind: "edge",
          ordinal: 5,
          identity: {
            kernelId: "opencascade",
            schema: "occt-shape-hash-v1",
            data: { hash: 123456789 },
          },
          geometry: {
            lengthMm: 20,
            centroidAbsoluteMm: [30, 10, 0],
            centroidRelativeMm: [15, 0, -5],
          },
        },
        {
          kind: "vertex",
          ordinal: 0,
          identity: null,
          geometry: {
            pointAbsoluteMm: [30, 20, 10],
            pointRelativeMm: [15, 10, 5],
          },
        },
      ],
    } as const;
    const wire = serializeWorkerOperationResult("solid.topology", {
      snapshot,
    });
    const parsed = parseWorkerOperationResult("solid.topology", wire);
    expect(parsed).toEqual({ ok: true, value: { snapshot } });
  });

  it("rejects a topology result whose entity carries a malformed geometry", () => {
    const failure = parseWorkerOperationResult("solid.topology", {
      kernelId: "opencascade",
      persistentTopology: true,
      identitySchemas: ["occt-shape-hash-v1"],
      bodyId: "body_fillet_fixture",
      regeneration: 0,
      entities: [
        {
          kind: "edge",
          ordinal: 0,
          identity: null,
          geometry: { lengthMm: "long" },
        },
      ],
    });
    expect(failure.ok).toBe(false);
    if (!failure.ok) {
      expect(failure.error.code).toBe(
        WORKER_PROTOCOL_ERROR_CODES.malformedPayload,
      );
    }
  });

  it("round-trips a transform carrying the rotation extension", () => {
    // A non-unit axis survives verbatim; the angle rides canonical radians
    // (the same convention the mm lengths follow — non-canonical units are
    // the canonicalization test's business below).
    expectInputRoundTrip("solid.transform", {
      solid: solidA,
      translation: { x: mm(1), y: mm(-2), z: mm(3) },
      rotation: { axis: [0, 0, 7], angle: angle(Math.PI / 2) },
    });
    expectInputRoundTrip("solid.transform", {
      solid: solidB,
      translation: { x: mm(0), y: mm(0), z: mm(0) },
      rotation: { axis: [-0.3, 0.4, Math.SQRT2], angle: angle(1) },
    });
  });

  it("round-trips the revolve input with its axis line and sweep angle", () => {
    expectInputRoundTrip("solid.revolve", {
      loop: [
        { kind: "line", start: [0, 0], end: [30, 0] },
        { kind: "line", start: [30, 0], end: [30, 25] },
        { kind: "line", start: [30, 25], end: [0, 25] },
        { kind: "line", start: [0, 25], end: [0, 0] },
      ],
      axis: { point: [3, -4], direction: [0.6, 0.8] },
      angle: angle(Math.PI / 2),
      placement: {
        rotation: { axis: [0, 0, 1], angle: angle(0) },
        translation: { x: mm(1), y: mm(2), z: mm(3) },
      },
    });
  });

  it("round-trips the sweep input with its XZ path chain and signed-sweep arcs", () => {
    expectInputRoundTrip("solid.sweep", {
      loop: [
        { kind: "line", start: [-5, -5], end: [5, -5] },
        { kind: "line", start: [5, -5], end: [5, 5] },
        { kind: "line", start: [5, 5], end: [-5, 5] },
        { kind: "line", start: [-5, 5], end: [-5, -5] },
      ],
      path: [
        { kind: "line", start: [0, 0], end: [0, 10] },
        {
          kind: "arc",
          center: [-10, 10],
          radius: 10,
          startAngle: angle(0),
          endAngle: angle(Math.PI / 2),
        },
      ],
      placement: {
        rotation: { axis: [0, 0, 1], angle: angle(0) },
        translation: { x: mm(0), y: mm(0), z: mm(0) },
      },
    });
  });

  it("round-trips the loft input with its ordered sections and stations", () => {
    expectInputRoundTrip("solid.loft", {
      sections: [
        {
          loop: [{ kind: "circle", center: [0, 0], radius: 10 }],
          z: mm(0),
        },
        {
          loop: [{ kind: "circle", center: [0, 0], radius: 4 }],
          z: mm(20),
        },
      ],
      placement: {
        rotation: { axis: [0, 0, 1], angle: angle(0) },
        translation: { x: mm(0), y: mm(0), z: mm(0) },
      },
    });
  });

  it("round-trips the helixSweep input with the taper PRESENT on the wire", () => {
    expectInputRoundTrip("solid.helixSweep", {
      loop: [
        { kind: "line", start: [0, -0.75], end: [2, -0.75] },
        { kind: "line", start: [2, -0.75], end: [2, 0.75] },
        { kind: "line", start: [2, 0.75], end: [0, 0.75] },
        { kind: "line", start: [0, 0.75], end: [0, -0.75] },
      ],
      spine: {
        radius: mm(10),
        pitch: mm(4),
        turns: 3,
        handedness: 1,
        startAngle: angle(0),
        taper: mm(2),
      },
      placement: {
        rotation: { axis: [0, 0, 1], angle: angle(0) },
        translation: { x: mm(0), y: mm(0), z: mm(0) },
      },
    });
  });

  it("round-trips the helixSweep input with the taper ABSENT — the byte discipline", () => {
    // `spine.taper` is optional: a caller that omits it must see it stay
    // omitted across the wire — the serializer's exactly-when-present
    // branch (always sending `taper: 0` would silently canonicalize every
    // untapered sweep onto the tapered code path).
    expectInputRoundTrip("solid.helixSweep", {
      loop: [
        { kind: "line", start: [0, -0.75], end: [2, -0.75] },
        { kind: "line", start: [2, -0.75], end: [2, 0.75] },
        { kind: "line", start: [2, 0.75], end: [0, 0.75] },
        { kind: "line", start: [0, 0.75], end: [0, -0.75] },
      ],
      spine: {
        radius: mm(6),
        pitch: mm(1),
        turns: 6,
        handedness: -1,
        startAngle: angle(Math.PI / 3),
      },
      placement: {
        rotation: { axis: [0.3, -0.4, Math.sqrt(0.75)], angle: angle(1) },
        translation: { x: mm(1), y: mm(2), z: mm(3) },
      },
    });
  });

  it("normalizes loft stations to canonical millimetres across units", () => {
    const wire = serializeWorkerOperationInput("solid.loft", {
      sections: [
        { loop: [{ kind: "circle", center: [0, 0], radius: 10 }], z: mm(0) },
        {
          loop: [{ kind: "circle", center: [0, 0], radius: 4 }],
          z: length(2, "cm"),
        },
      ],
      placement: {
        rotation: { axis: [0, 0, 1], angle: angle(0) },
        translation: { x: mm(0), y: mm(0), z: mm(0) },
      },
    });
    const sections = wire.sections;
    expect(sections).toHaveLength(2);
    expect(sections[1]?.z).toEqual({
      dimension: "length",
      unit: "mm",
      value: 20,
    });
  });

  it("rejects a sweep path segment that is not line or arc", () => {
    const failure = failureOf(
      parseWorkerOperationInput("solid.sweep", {
        loop: [{ kind: "circle", center: [0, 0], radius: 5 }],
        path: [
          {
            kind: "spline",
            points: [
              [0, 0],
              [1, 1],
            ],
          },
        ],
        placement: {
          rotation: { axis: [0, 0, 1], angle: angle(0) },
          translation: { x: mm(0), y: mm(0), z: mm(0) },
        },
      }),
    );
    expect(failure.code).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
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

  it("serializes the rotation canonically, in the fixed key order, after the translation", () => {
    const wire = serializeWorkerOperationInput("solid.transform", {
      solid: solidA,
      translation: { x: mm(1), y: mm(2), z: mm(3) },
      rotation: { axis: [0, 0, 2], angle: angle(90, "deg") },
    });
    expect(Object.keys(wire)).toEqual(["solid", "translation", "rotation"]);
    expect(wire.rotation).toEqual({
      axis: [0, 0, 2],
      // 90 deg canonicalizes to π/2 rad — the angle twin of the length
      // serializer's cm→mm normalization.
      angle: { dimension: "angle", unit: "rad", value: Math.PI / 2 },
    });
  });

  it("serializes a rotation-less transform to the pre-extension wire shape", () => {
    const wire = serializeWorkerOperationInput("solid.transform", {
      solid: solidA,
      translation: { x: mm(1), y: mm(2), z: mm(3) },
    });
    expect("rotation" in wire).toBe(false);
  });

  it("parses a pre-extension transform payload as translation-only (backward compatibility)", () => {
    const parsed = parseWorkerOperationInput("solid.transform", {
      solid: solidA,
      translation: {
        x: { dimension: "length", unit: "mm", value: 1 },
        y: { dimension: "length", unit: "mm", value: 2 },
        z: { dimension: "length", unit: "mm", value: 3 },
      },
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        solid: solidA,
        translation: { x: mm(1), y: mm(2), z: mm(3) },
      },
    });
  });

  it("parses any angle unit into the typed dimensional value", () => {
    const parsed = parseWorkerOperationInput("solid.transform", {
      solid: solidA,
      translation: {
        x: { dimension: "length", unit: "mm", value: 0 },
        y: { dimension: "length", unit: "mm", value: 0 },
        z: { dimension: "length", unit: "mm", value: 0 },
      },
      rotation: {
        axis: [1, 0, 0],
        angle: { dimension: "angle", unit: "deg", value: 180 },
      },
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        solid: solidA,
        translation: { x: mm(0), y: mm(0), z: mm(0) },
        rotation: { axis: [1, 0, 0], angle: angle(180, "deg") },
      },
    });
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

  it("rejects malformed transform rotations", () => {
    const translation = { x: mm(0), y: mm(0), z: mm(0) };
    // A non-record rotation (null included) is malformed — only the field's
    // ABSENCE means translation-only.
    expect(
      failureOf(
        parseWorkerOperationInput("solid.transform", {
          solid: solidA,
          translation,
          rotation: null,
        }),
      ).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    // Axis: not an array, wrong length, non-number, non-finite entries.
    for (const axis of ["z", [0, 0], [0, 0, 1, 0], [0, 0, "1"], [0, 0, null]]) {
      expect(
        failureOf(
          parseWorkerOperationInput("solid.transform", {
            solid: solidA,
            translation,
            rotation: {
              axis,
              angle: { dimension: "angle", unit: "rad", value: 1 },
            },
          }),
        ).code,
        `axis ${JSON.stringify(axis)}`,
      ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    }
    // JSON cannot carry NaN, but the parse boundary must still reject it if
    // it ever arrives through a structured clone.
    expect(
      failureOf(
        parseWorkerOperationInput("solid.transform", {
          solid: solidA,
          translation,
          rotation: {
            axis: [0, Number.NaN, 0],
            angle: { dimension: "angle", unit: "rad", value: 1 },
          },
        }),
      ).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    // Angle: not a dimensional value, or the wrong dimension.
    for (const badAngle of [
      90,
      { dimension: "angle", unit: "grad", value: 1 },
      { dimension: "length", unit: "mm", value: 1 },
      { dimension: "angle", unit: "rad", value: "quarter turn" },
    ]) {
      expect(
        failureOf(
          parseWorkerOperationInput("solid.transform", {
            solid: solidA,
            translation,
            rotation: { axis: [0, 0, 1], angle: badAngle },
          }),
        ).code,
        `angle ${JSON.stringify(badAngle)}`,
      ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    }
  });

  it("is structurally tolerant of a zero rotation axis (the kernel decides semantics)", () => {
    const parsed = parseWorkerOperationInput("solid.transform", {
      solid: solidA,
      translation: { x: mm(0), y: mm(0), z: mm(0) },
      rotation: {
        axis: [0, 0, 0],
        angle: { dimension: "angle", unit: "rad", value: 1 },
      },
    });
    expect(parsed.ok).toBe(true);
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
      "solid.extrude": { loop: "not-a-loop", height: 2, direction: 1 },
      "solid.revolve": { loop: [], axis: { point: [0, 0] }, angle: 2 },
      "solid.sweep": {
        loop: [],
        path: [{ kind: "circle", center: [0, 0], radius: 2 }],
        placement: {},
      },
      "solid.helixSweep": {
        loop: [],
        spine: { radius: "wide", pitch: 1, turns: 2, handedness: 1 },
        placement: {},
      },
      "solid.loft": { sections: [{ loop: [], z: "elevated" }], placement: {} },
      "solid.union": { operands: [solidA, 5] },
      "solid.subtract": { target: "not-an-id", tools: [] },
      "solid.intersect": { operands: {} },
      "solid.transform": {
        solid: solidA,
        translation: { x: "left", y: 2, z: 3 },
      },
      "solid.bounds": { solid: 42 },
      "solid.volume": {},
      "solid.area": {},
      "solid.tessellate": { solid: "wsol_" },
      "solid.dispose": { solid: [] },
      "solid.fillet": { target: solidA, edges: "edges", radius: 2 },
      "solid.chamfer": { target: solidA, edges: "edges", distance: 2 },
      "solid.shell": { target: solidA, faces: "faces", thickness: 2 },
      "solid.thicken": { target: solidA, thickness: "thick" },
      "solid.mirror": { target: solidA, axis: "diagonal", offset: 2 },
      "solid.moveFace": {
        target: solidA,
        face: -1,
        direction: [0, 0, 1],
        distance: 2,
      },
      "solid.replaceFace": { target: solidA, face: 0.5, plane: "flat" },
      "solid.deleteFace": { target: solidA, face: 0, heal: "yes" },
      "solid.topology": {
        solid: solidA,
        bodyId: "not-a-body",
        regeneration: -1,
      },
      "step.import": { data: "not!!!valid!!!base64" },
      "step.export": { solids: [solidA, "not-an-id"] },
      "brep.import": { data: 42 },
      "brep.export": { solids: "many" },
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

  it("round-trips an area result (Phase 27.4)", () => {
    expect(
      parseWorkerOperationResult(
        "solid.area",
        jsonRoundTrip(
          serializeWorkerOperationResult("solid.area", { area: 2200 }),
        ),
      ),
    ).toEqual({ ok: true, value: { area: 2200 } });
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

  it("round-trips a step.import result and keeps the provenance literal", () => {
    const result: WorkerStepImportResult = {
      solids: [
        { solid: solidA, origin: "imported-step" },
        { solid: solidB, origin: "imported-step" },
      ],
    };
    const wire = serializeWorkerOperationResult("step.import", result);
    expect(wire).toEqual({
      solids: [
        { solid: solidA, origin: "imported-step" },
        { solid: solidB, origin: "imported-step" },
      ],
    });
    expect(
      parseWorkerOperationResult("step.import", jsonRoundTrip(wire)),
    ).toEqual({
      ok: true,
      value: result,
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

  it("rejects non-finite or negative areas (Phase 27.4)", () => {
    expect(
      failureOf(parseWorkerOperationResult("solid.area", { area: -1 })).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    expect(
      failureOf(parseWorkerOperationResult("solid.area", { area: NaN })).code,
    ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    expect(failureOf(parseWorkerOperationResult("solid.area", {})).code).toBe(
      WORKER_PROTOCOL_ERROR_CODES.malformedPayload,
    );
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

  it("rejects step.import results with broken solid refs or foreign origins", () => {
    const broken: readonly unknown[] = [
      { solids: "many" },
      { solids: [42] },
      { solids: [{ solid: solidA }] },
      { solids: [{ solid: solidA, origin: "feature-built" }] },
      { solids: [{ solid: 42, origin: "imported-step" }] },
    ];
    for (const payload of broken) {
      expect(
        failureOf(parseWorkerOperationResult("step.import", payload)).code,
        `payload ${JSON.stringify(payload)}`,
      ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    }
  });
});

describe("the step.import extension (Phase 21.3)", () => {
  const fileBytes = new Uint8Array([0x49, 0x53, 0x4f, 0x2d, 0, 0xff, 0x0a]);

  it("round-trips file bytes through the canonical base64 wire form", () => {
    const wire = serializeWorkerOperationInput("step.import", {
      data: fileBytes,
    });
    expect(wire).toEqual({ data: encodeBase64(fileBytes) });
    const parsed = parseWorkerOperationInput(
      "step.import",
      jsonRoundTrip(wire),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect([...parsed.value.data]).toEqual([...fileBytes]);
  });

  it("carries the empty file as the empty byte string (kernel semantics decide emptiness)", () => {
    const parsed = parseWorkerOperationInput("step.import", { data: "" });
    expect(parsed).toEqual({ ok: true, value: { data: new Uint8Array(0) } });
  });

  it("rejects non-string and non-canonical base64 payloads", () => {
    for (const data of [
      undefined,
      42,
      null,
      "short",
      "with space",
      "AB=C",
      "!!!!",
    ]) {
      expect(
        failureOf(parseWorkerOperationInput("step.import", { data })).code,
        `data ${JSON.stringify(data)}`,
      ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    }
  });

  it("is tolerant of unknown fields like every other input", () => {
    const wire = serializeWorkerOperationInput("step.import", {
      data: fileBytes,
    });
    const parsed = parseWorkerOperationInput("step.import", {
      ...wire,
      fileName: "plate.step",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect([...parsed.value.data]).toEqual([...fileBytes]);
  });

  it("mints every ref's solid in order and nothing for empty results", () => {
    const result: WorkerStepImportResult = {
      solids: [
        { solid: solidC, origin: "imported-step" },
        { solid: solidA, origin: "imported-step" },
      ],
    };
    expect(resultMintsSolids("step.import", result)).toEqual([solidC, solidA]);
    expect(resultMintsSolids("step.import", { solids: [] })).toEqual([]);
    // The single-solid producers still mint exactly one.
    expect(resultMintsSolids("solid.createBox", { solid: solidB })).toEqual([
      solidB,
    ]);
    // The measurements own none.
    expect(resultMintsSolids("solid.volume", { volume: 5 })).toEqual([]);
  });
});

describe("the step.export extension (Phase 21.4)", () => {
  const fileBytes = new Uint8Array([
    0x49, 0x53, 0x4f, 0x2d, 0x31, 0x30, 0x33, 0x30, 0x33, 0x2d, 0x32, 0x31,
    0x3b, 0x0a,
  ]);

  it("round-trips solid ids and settings through the canonical wire form", () => {
    const wire = serializeWorkerOperationInput("step.export", {
      solids: [solidA, solidB],
    });
    expect(wire).toEqual({ solids: [solidA, solidB] });
    const withSettings = serializeWorkerOperationInput("step.export", {
      solids: [solidC],
      unit: "INCH",
      schema: "AP203",
    });
    expect(withSettings).toEqual({
      solids: [solidC],
      unit: "INCH",
      schema: "AP203",
    });
    expect(
      parseWorkerOperationInput("step.export", jsonRoundTrip(withSettings)),
    ).toEqual({
      ok: true,
      value: { solids: [solidC], unit: "INCH", schema: "AP203" },
    });
  });

  it("carries the empty solid list as structurally valid (kernel semantics decide emptiness)", () => {
    const parsed = parseWorkerOperationInput("step.export", { solids: [] });
    expect(parsed).toEqual({ ok: true, value: { solids: [] } });
  });

  it("rejects non-array solids and non-string settings", () => {
    for (const payload of [
      { solids: "many" },
      { solids: [42] },
      { solids: [solidA], unit: 3 },
      { solids: [solidA], schema: null },
    ]) {
      expect(
        failureOf(parseWorkerOperationInput("step.export", payload)).code,
        `payload ${JSON.stringify(payload)}`,
      ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    }
  });

  it("round-trips the result bytes through the canonical base64 wire form", () => {
    const wire = serializeWorkerOperationResult("step.export", {
      data: fileBytes,
    });
    expect(wire).toEqual({ data: encodeBase64(fileBytes) });
    const parsed = parseWorkerOperationResult(
      "step.export",
      jsonRoundTrip(wire),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect([...parsed.value.data]).toEqual([...fileBytes]);
  });

  it("rejects result payloads that are not canonical base64 text", () => {
    for (const data of [undefined, 42, null, "with space", "!!!!", "short"]) {
      expect(
        failureOf(parseWorkerOperationResult("step.export", { data })).code,
        `data ${JSON.stringify(data)}`,
      ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    }
  });

  it("is tolerant of unknown fields like every other input", () => {
    const parsed = parseWorkerOperationInput("step.export", {
      solids: [solidA],
      fileName: "plate.step",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.solids).toEqual([solidA]);
  });

  it("mints no session solids (the exported geometry keeps its input ids)", () => {
    expect(resultMintsSolids("step.export", { data: fileBytes })).toEqual([]);
  });
});

describe("the brep.import extension (Phase 21.5)", () => {
  const fileBytes = new Uint8Array([
    0x0a, 0x43, 0x41, 0x53, 0x43, 0x41, 0x44, 0x45, 0x20, 0x54, 0x6f, 0x70,
    0x6f, 0x6c, 0x6f, 0x67, 0x79, 0x20, 0x56, 0x33, 0x0a,
  ]);

  it("round-trips file bytes through the canonical base64 wire form", () => {
    const wire = serializeWorkerOperationInput("brep.import", {
      data: fileBytes,
    });
    expect(wire).toEqual({ data: encodeBase64(fileBytes) });
    const parsed = parseWorkerOperationInput(
      "brep.import",
      jsonRoundTrip(wire),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect([...parsed.value.data]).toEqual([...fileBytes]);
  });

  it("carries the empty file as the empty byte string (kernel semantics decide emptiness)", () => {
    const parsed = parseWorkerOperationInput("brep.import", { data: "" });
    expect(parsed).toEqual({ ok: true, value: { data: new Uint8Array(0) } });
  });

  it("rejects non-string and non-canonical base64 payloads", () => {
    for (const data of [undefined, 42, null, "with space", "AB=C", "!!!!"]) {
      expect(
        failureOf(parseWorkerOperationInput("brep.import", { data })).code,
        `data ${JSON.stringify(data)}`,
      ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    }
  });

  it("round-trips the result refs with the imported-brep provenance literal", () => {
    const wire = serializeWorkerOperationResult("brep.import", {
      solids: [{ solid: solidA, origin: "imported-brep" }],
    });
    expect(wire).toEqual({
      solids: [{ solid: solidA, origin: "imported-brep" }],
    });
    const parsed = parseWorkerOperationResult(
      "brep.import",
      jsonRoundTrip(wire),
    );
    expect(parsed).toEqual({
      ok: true,
      value: { solids: [{ solid: solidA, origin: "imported-brep" }] },
    });
  });

  it("rejects brep.import results with broken refs or foreign origins", () => {
    const broken: readonly unknown[] = [
      { solids: "many" },
      { solids: [42] },
      { solids: [{ solid: solidA }] },
      { solids: [{ solid: solidA, origin: "imported-step" }] },
      { solids: [{ solid: 42, origin: "imported-brep" }] },
    ];
    for (const payload of broken) {
      expect(
        failureOf(parseWorkerOperationResult("brep.import", payload)).code,
        `payload ${JSON.stringify(payload)}`,
      ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    }
  });

  it("mints every ref's solid in order and nothing for empty results", () => {
    const result: WorkerBrepImportResult = {
      solids: [
        { solid: solidC, origin: "imported-brep" },
        { solid: solidA, origin: "imported-brep" },
      ],
    };
    expect(resultMintsSolids("brep.import", result)).toEqual([solidC, solidA]);
    expect(resultMintsSolids("brep.import", { solids: [] })).toEqual([]);
  });
});

describe("the brep.export extension (Phase 21.5)", () => {
  const fileBytes = new Uint8Array([
    0x0a, 0x43, 0x41, 0x53, 0x43, 0x2d, 0x56, 0x33,
  ]);

  it("round-trips solid ids through the canonical wire form (no settings fields exist)", () => {
    const wire = serializeWorkerOperationInput("brep.export", {
      solids: [solidA, solidB],
    });
    expect(wire).toEqual({ solids: [solidA, solidB] });
    expect(
      parseWorkerOperationInput("brep.export", jsonRoundTrip(wire)),
    ).toEqual({ ok: true, value: { solids: [solidA, solidB] } });
  });

  it("carries the empty solid list as structurally valid (kernel semantics decide emptiness)", () => {
    const parsed = parseWorkerOperationInput("brep.export", { solids: [] });
    expect(parsed).toEqual({ ok: true, value: { solids: [] } });
  });

  it("rejects non-array solids and ignores unknown fields like every other input", () => {
    for (const payload of [
      { solids: "many" },
      { solids: [42] },
      { solids: 3 },
    ]) {
      expect(
        failureOf(parseWorkerOperationInput("brep.export", payload)).code,
        `payload ${JSON.stringify(payload)}`,
      ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    }
    const parsed = parseWorkerOperationInput("brep.export", {
      solids: [solidA],
      unit: "MM",
    });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.solids).toEqual([solidA]);
  });

  it("round-trips the result bytes through the canonical base64 wire form", () => {
    const wire = serializeWorkerOperationResult("brep.export", {
      data: fileBytes,
    });
    expect(wire).toEqual({ data: encodeBase64(fileBytes) });
    const parsed = parseWorkerOperationResult(
      "brep.export",
      jsonRoundTrip(wire),
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect([...parsed.value.data]).toEqual([...fileBytes]);
  });

  it("rejects result payloads that are not canonical base64 text", () => {
    for (const data of [undefined, 42, null, "with space", "!!!!", "short"]) {
      expect(
        failureOf(parseWorkerOperationResult("brep.export", { data })).code,
        `data ${JSON.stringify(data)}`,
      ).toBe(WORKER_PROTOCOL_ERROR_CODES.malformedPayload);
    }
  });

  it("mints no session solids (the exported geometry keeps its input ids)", () => {
    expect(resultMintsSolids("brep.export", { data: fileBytes })).toEqual([]);
  });
});

describe("the base64 wire codec", () => {
  it("matches the RFC 4648 test vectors", () => {
    const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
    expect(encodeBase64(utf8(""))).toBe("");
    expect(encodeBase64(utf8("f"))).toBe("Zg==");
    expect(encodeBase64(utf8("fo"))).toBe("Zm8=");
    expect(encodeBase64(utf8("foo"))).toBe("Zm9v");
    expect(encodeBase64(utf8("foob"))).toBe("Zm9vYg==");
    expect(encodeBase64(utf8("fooba"))).toBe("Zm9vYmE=");
    expect(encodeBase64(utf8("foobar"))).toBe("Zm9vYmFy");
  });

  it("decodes every canonical padding form and rejects the rest", () => {
    expect(decodeBase64Strict("Zg==")).toEqual(new Uint8Array([0x66]));
    expect(decodeBase64Strict("Zm8=")).toEqual(new Uint8Array([0x66, 0x6f]));
    expect(decodeBase64Strict("")).toEqual(new Uint8Array(0));
    for (const bad of [
      "Zg=",
      "Zg===",
      "Z g=",
      "Zm8\n",
      "Zg===",
      "A",
      "AB=C",
      "====",
    ]) {
      expect(decodeBase64Strict(bad), `bad text "${bad}"`).toBeNull();
    }
  });

  it("round-trips arbitrary byte strings, empty included", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) bytes[i] = i;
    expect(decodeBase64Strict(encodeBase64(bytes))).toEqual(bytes);
    expect(decodeBase64Strict(encodeBase64(new Uint8Array(0)))).toEqual(
      new Uint8Array(0),
    );
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
