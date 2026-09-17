import { describe, expect, it } from "vitest";
import { angle, length, valueIn } from "@slopcad/cad-core";
import type { SketchConstraint } from "./constraints";

import { SKETCH_DIAGNOSTIC_CODES } from "./diagnostics";
import {
  SKETCH_CONSTRAINT_KINDS,
  SketchConstraintValidationError,
  createAngleConstraint,
  createCoincidentConstraint,
  createDiameterConstraint,
  createDistanceConstraint,
  createEqualConstraint,
  createHorizontalConstraint,
  createMidpointConstraint,
  createParallelConstraint,
  createPerpendicularConstraint,
  createRadiusConstraint,
  createSymmetryAboutLineConstraint,
  createSymmetryAboutPointConstraint,
  createTangentConstraint,
  createVerticalConstraint,
  isSketchConstraintKind,
  parseSketchConstraint,
  pointTarget,
  serializeSketchConstraint,
  validateConstraintReferences,
} from "./constraints";
import {
  createArcEntity,
  createCircleEntity,
  createLineEntity,
  createPointEntity,
  createRectangleEntity,
} from "./entities";
import {
  createSketchConstraintId,
  createSketchEntityId,
} from "./sketch-ids";

const cid = (raw: string) => createSketchConstraintId(raw);
const eid = (raw: string) => createSketchEntityId(raw);

const lineA = eid("skent_line-a");
const lineB = eid("skent_line-b");
const pointA = eid("skent_point-a");
const circleA = eid("skent_circle-a");
const arcA = eid("skent_arc-a");
const circleB = eid("skent_circle-b");

function allConstraintSamples(): SketchConstraint[] {
  return [
    createCoincidentConstraint(
      cid("skcon_c0"),
      pointTarget(lineA, "start"),
      pointTarget(pointA, "center"),
    ),
    createHorizontalConstraint(cid("skcon_c1"), lineA),
    createVerticalConstraint(cid("skcon_c2"), lineA),
    createParallelConstraint(cid("skcon_c3"), lineA, lineB),
    createPerpendicularConstraint(cid("skcon_c4"), lineA, lineB),
    createDistanceConstraint(
      cid("skcon_c5"),
      pointTarget(lineA, "start"),
      pointTarget(lineB, "end"),
      length(25.4, "mm"),
    ),
    createAngleConstraint(cid("skcon_c6"), lineA, lineB, angle(Math.PI / 6)),
    createRadiusConstraint(cid("skcon_c7"), circleA, length(10)),
    createDiameterConstraint(cid("skcon_c8"), arcA, length(20)),
    createEqualConstraint(cid("skcon_c9"), circleA, circleB),
    createTangentConstraint(cid("skcon_c10"), lineA, circleA),
    createTangentConstraint(cid("skcon_c11"), circleA, circleB, "internal"),
    createMidpointConstraint(cid("skcon_c12"), pointTarget(pointA, "center"), lineB),
    createSymmetryAboutPointConstraint(
      cid("skcon_c13"),
      pointTarget(lineA, "start"),
      pointTarget(lineB, "start"),
      pointTarget(pointA, "center"),
    ),
    createSymmetryAboutLineConstraint(
      cid("skcon_c14"),
      pointTarget(lineA, "start"),
      pointTarget(lineB, "start"),
      lineA,
    ),
  ];
}

describe("constraint builders", () => {
  it("rejects zero and negative dimensional values", () => {
    expect(() =>
      createDistanceConstraint(
        cid("skcon_x"),
        pointTarget(lineA, "start"),
        pointTarget(lineA, "end"),
        length(0),
      ),
    ).toThrow(SketchConstraintValidationError);
    expect(() =>
      createRadiusConstraint(cid("skcon_x"), circleA, length(-5, "cm")),
    ).toThrow(SketchConstraintValidationError);
    expect(() =>
      createDiameterConstraint(cid("skcon_x"), circleA, length(0, "in")),
    ).toThrow(SketchConstraintValidationError);
  });

  it("rejects angle values at or outside the open (0°, 180°) interval", () => {
    for (const degrees of [0, 180, -30, 270]) {
      expect(() =>
        createAngleConstraint(cid("skcon_x"), lineA, lineB, angle(degrees, "deg")),
      ).toThrow(SketchConstraintValidationError);
    }
    expect(
      createAngleConstraint(cid("skcon_x"), lineA, lineB, angle(179.5, "deg")).kind,
    ).toBe("angle");
  });

  it("defaults tangent variant to external", () => {
    const tangent = createTangentConstraint(cid("skcon_x"), lineA, circleA);
    expect(tangent.variant).toBe("external");
  });

  it("exposes the constraint kind list and type guard", () => {
    expect(SKETCH_CONSTRAINT_KINDS).toHaveLength(13);
    expect(SKETCH_CONSTRAINT_KINDS).toContain("coincident");
    expect(SKETCH_CONSTRAINT_KINDS).toContain("symmetry");
    expect(isSketchConstraintKind("tangent")).toBe(true);
    expect(isSketchConstraintKind("glue")).toBe(false);
  });
});

describe("constraint serialization", () => {
  it("round-trips every constraint kind exactly", () => {
    for (const constraint of allConstraintSamples()) {
      const serialized = serializeSketchConstraint(constraint);
      const parsed = parseSketchConstraint(JSON.parse(JSON.stringify(serialized)));
      expect(parsed.ok, constraint.kind).toBe(true);
      if (!parsed.ok) continue;
      expect(parsed.value, constraint.kind).toEqual(constraint);
      expect(serializeSketchConstraint(parsed.value), constraint.kind).toEqual(
        serialized,
      );
    }
  });

  it("serializes dimensional values canonically as mm and rad", () => {
    const distance = serializeSketchConstraint(
      createDistanceConstraint(
        cid("skcon_x"),
        pointTarget(lineA, "start"),
        pointTarget(lineB, "end"),
        length(2.54, "cm"),
      ),
    );
    expect(distance.value).toEqual({ dimension: "length", unit: "mm", value: 25.4 });
    const angleConstraint = serializeSketchConstraint(
      createAngleConstraint(cid("skcon_x"), lineA, lineB, angle(90, "deg")),
    );
    expect(angleConstraint.value).toEqual({
      dimension: "angle",
      unit: "rad",
      value: valueIn(angle(90, "deg"), "rad"),
    });
    const parsedAngle = parseSketchConstraint(angleConstraint);
    expect(
      parsedAngle.ok &&
        parsedAngle.value.kind === "angle" &&
        valueIn(parsedAngle.value.value, "deg"),
    ).toBeCloseTo(90, 12);
  });

  it("parses dimensional values in any unit of the right dimension", () => {
    const parsed = parseSketchConstraint({
      id: "skcon_x",
      kind: "radius",
      entity: "skent_circle-a",
      value: { dimension: "length", unit: "cm", value: 2 },
    });
    expect(parsed.ok).toBe(true);
  });

  it("rejects wrong dimensions and out-of-range values on parse", () => {
    expect(
      !parseSketchConstraint({
        id: "skcon_x",
        kind: "radius",
        entity: "skent_circle-a",
        value: { dimension: "angle", unit: "rad", value: 1 },
      }).ok,
    ).toBe(true);
    expect(
      !parseSketchConstraint({
        id: "skcon_x",
        kind: "distance",
        first: { entity: "skent_a", point: "start" },
        second: { entity: "skent_b", point: "end" },
        value: { dimension: "length", unit: "mm", value: -1 },
      }).ok,
    ).toBe(true);
    expect(
      !parseSketchConstraint({
        id: "skcon_x",
        kind: "angle",
        first: "skent_a",
        second: "skent_b",
        value: { dimension: "angle", unit: "deg", value: 180 },
      }).ok,
    ).toBe(true);
  });

  it("rejects unknown kinds, bad ids, bad point targets, and bad variants", () => {
    const unknownKind = parseSketchConstraint({ id: "skcon_x", kind: "glue" });
    expect(!unknownKind.ok && unknownKind.error.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.constraintUnknownKind,
    );
    expect(
      !parseSketchConstraint({ id: "feat_x", kind: "horizontal", entity: "skent_a" }).ok,
    ).toBe(true);
    expect(
      !parseSketchConstraint({
        id: "skcon_x",
        kind: "coincident",
        first: { entity: "skent_a", point: "middle" },
        second: { entity: "skent_b", point: "start" },
      }).ok,
    ).toBe(true);
    expect(
      !parseSketchConstraint({
        id: "skcon_x",
        kind: "tangent",
        first: "skent_a",
        second: "skent_b",
        variant: "sideways",
      }).ok,
    ).toBe(true);
    expect(
      !parseSketchConstraint({
        id: "skcon_x",
        kind: "symmetry",
        first: { entity: "skent_a", point: "start" },
        second: { entity: "skent_b", point: "start" },
        about: { type: "plane" },
      }).ok,
    ).toBe(true);
  });

  it("accepts a missing tangent variant as external", () => {
    const parsed = parseSketchConstraint({
      id: "skcon_x",
      kind: "tangent",
      first: "skent_line-a",
      second: "skent_circle-a",
    });
    expect(parsed.ok && parsed.value.kind === "tangent" && parsed.value.variant).toBe(
      "external",
    );
  });

  it("ignores unknown fields so future versions deserialize", () => {
    const parsed = parseSketchConstraint({
      id: "skcon_x",
      kind: "horizontal",
      entity: "skent_line-a",
      future: true,
    });
    expect(parsed.ok).toBe(true);
  });
});

describe("constraint reference validation", () => {
  const entities = [
    createPointEntity(pointA, { x: 0, y: 0 }),
    createLineEntity(lineA, { x: 0, y: 0 }, { x: 10, y: 0 }),
    createLineEntity(lineB, { x: 0, y: 5 }, { x: 5, y: 9 }),
    createCircleEntity(circleA, { x: 20, y: 0 }, 4),
    createCircleEntity(circleB, { x: 30, y: 0 }, 6),
    createArcEntity(arcA, { x: 0, y: 20 }, 8, 0.2, 2.9),
  ];

  it("accepts well-formed references for every kind", () => {
    for (const constraint of allConstraintSamples()) {
      expect(validateConstraintReferences(constraint, entities), constraint.kind).toBeNull();
    }
  });

  it("rejects references to missing entities with the malformed-reference code", () => {
    const constraint = createHorizontalConstraint(cid("skcon_x"), eid("skent_ghost"));
    const diagnostic = validateConstraintReferences(constraint, entities);
    expect(diagnostic?.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.constraintReferenceMalformed,
    );
    expect(diagnostic?.location?.primary).toBe("skcon_x");
  });

  it("rejects wrong operand kinds per constraint kind", () => {
    expect(
      validateConstraintReferences(
        createHorizontalConstraint(cid("skcon_x"), circleA),
        entities,
      ),
    ).not.toBeNull();
    expect(
      validateConstraintReferences(
        createParallelConstraint(cid("skcon_x"), lineA, circleA),
        entities,
      ),
    ).not.toBeNull();
    expect(
      validateConstraintReferences(
        createRadiusConstraint(cid("skcon_x"), lineA, length(4)),
        entities,
      ),
    ).not.toBeNull();
    expect(
      validateConstraintReferences(
        createEqualConstraint(cid("skcon_x"), lineA, circleA),
        entities,
      ),
    ).not.toBeNull();
    expect(
      validateConstraintReferences(
        createTangentConstraint(cid("skcon_x"), lineA, lineB),
        entities,
      ),
    ).not.toBeNull();
    expect(
      validateConstraintReferences(
        createMidpointConstraint(cid("skcon_x"), pointTarget(circleA, "start"), lineB),
        entities,
      ),
    ).not.toBeNull();
  });

  it("rejects invalid sub-parameters for point targets", () => {
    // A circle only offers its center; a rectangle has no point targets.
    expect(
      validateConstraintReferences(
        createCoincidentConstraint(
          cid("skcon_x"),
          pointTarget(circleA, "start"),
          pointTarget(circleB, "center"),
        ),
        entities,
      ),
    ).not.toBeNull();
    const rectangleEdges = [
      eid("skent_re0"),
      eid("skent_re1"),
      eid("skent_re2"),
      eid("skent_re3"),
    ] as const;
    const withRectangle = [
      ...entities,
      createLineEntity(rectangleEdges[0], { x: 0, y: 0 }, { x: 1, y: 0 }),
      createLineEntity(rectangleEdges[1], { x: 1, y: 0 }, { x: 1, y: 1 }),
      createLineEntity(rectangleEdges[2], { x: 1, y: 1 }, { x: 0, y: 1 }),
      createLineEntity(rectangleEdges[3], { x: 0, y: 1 }, { x: 0, y: 0 }),
      createRectangleEntity(eid("skent_rect"), rectangleEdges),
    ];
    expect(
      validateConstraintReferences(
        createCoincidentConstraint(
          cid("skcon_x"),
          pointTarget(eid("skent_rect"), "center"),
          pointTarget(pointA, "center"),
        ),
        withRectangle,
      ),
    ).not.toBeNull();
  });

  it("accepts arc endpoint and line center/midpoint sub-parameters", () => {
    expect(
      validateConstraintReferences(
        createCoincidentConstraint(
          cid("skcon_x"),
          pointTarget(arcA, "end"),
          pointTarget(lineA, "center"),
        ),
        entities,
      ),
    ).toBeNull();
  });
});
