import { describe, expect, it } from "vitest";
import type { SketchEntity } from "./entities";

import { SKETCH_DIAGNOSTIC_CODES } from "./diagnostics";
import {
  SKETCH_ENTITY_KINDS,
  SketchEntityValidationError,
  arcSweep,
  createArc3SlotEntity,
  createArcEntity,
  createCircleEntity,
  createEllipseEntity,
  createEllipticalArcEntity,
  createLineEntity,
  createPointEntity,
  createPolygonEntity,
  createRectangleEntity,
  createSplineEntity,
  createStraightSlotEntity,
  isSketchEntityKind,
  parseSketchEntity,
  serializeSketchEntity,
} from "./entities";
import { createSketchEntityId } from "./sketch-ids";

const id = (raw: string) => createSketchEntityId(raw);

function expectRoundTrip(entity: SketchEntity): void {
  const serialized = serializeSketchEntity(entity);
  const parsed = parseSketchEntity(JSON.parse(JSON.stringify(serialized)));
  expect(parsed.ok).toBe(true);
  if (!parsed.ok) return;
  expect(parsed.value).toEqual(entity);
  expect(serializeSketchEntity(parsed.value)).toEqual(serialized);
}

describe("entity builders", () => {
  it("builds a point with default flags", () => {
    const point = createPointEntity(id("skent_p"), { x: 1, y: -2 });
    expect(point).toEqual({
      id: "skent_p",
      kind: "point",
      construction: false,
      fixed: false,
      x: 1,
      y: -2,
    });
  });

  it("builds a line, circle, and arc with options", () => {
    const line = createLineEntity(
      id("skent_l"),
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      {
        construction: true,
      },
    );
    expect(line.construction).toBe(true);
    expect(line.fixed).toBe(false);
    const circle = createCircleEntity(id("skent_c"), { x: 3, y: 4 }, 5, {
      fixed: true,
    });
    expect(circle.fixed).toBe(true);
    const arc = createArcEntity(
      id("skent_a"),
      { x: 0, y: 0 },
      2,
      Math.PI / 2,
      Math.PI,
    );
    expect(arc.startAngle).toBeCloseTo(Math.PI / 2, 15);
    expect(arc.endAngle).toBeCloseTo(Math.PI, 15);
    expect(arcSweep(arc)).toBeCloseTo(Math.PI / 2, 15);
  });

  it("canonicalizes arc angles into [0, 2π) and wraps negative sweeps", () => {
    const arc = createArcEntity(
      id("skent_a"),
      { x: 0, y: 0 },
      1,
      -Math.PI / 2,
      Math.PI / 2,
    );
    expect(arc.startAngle).toBeCloseTo((3 * Math.PI) / 2, 15);
    expect(arc.endAngle).toBeCloseTo(Math.PI / 2, 15);
    expect(arcSweep(arc)).toBeCloseTo(Math.PI, 15);
  });

  it("rejects non-finite parameters", () => {
    expect(() =>
      createPointEntity(id("skent_p"), { x: Number.NaN, y: 0 }),
    ).toThrow(SketchEntityValidationError);
    expect(() =>
      createLineEntity(id("skent_l"), { x: 0, y: 0 }, { x: Infinity, y: 0 }),
    ).toThrow(SketchEntityValidationError);
    expect(() =>
      createArcEntity(id("skent_a"), { x: 0, y: 0 }, 1, Number.NaN, 1),
    ).toThrow(SketchEntityValidationError);
  });

  it("rejects non-positive radii with the parameters-invalid code", () => {
    try {
      createCircleEntity(id("skent_c"), { x: 0, y: 0 }, 0);
      expect.unreachable("circle with radius 0 must throw");
    } catch (error) {
      expect(error).toBeInstanceOf(SketchEntityValidationError);
      expect((error as SketchEntityValidationError).error.code).toBe(
        SKETCH_DIAGNOSTIC_CODES.entityParametersInvalid,
      );
    }
    expect(() => createCircleEntity(id("skent_c"), { x: 0, y: 0 }, -3)).toThrow(
      SketchEntityValidationError,
    );
  });

  it("rejects a zero/full-turn arc sweep", () => {
    expect(() =>
      createArcEntity(
        id("skent_a"),
        { x: 0, y: 0 },
        1,
        0.75,
        0.75 + 2 * Math.PI,
      ),
    ).toThrow(SketchEntityValidationError);
  });

  it("rejects a rectangle with duplicate edges", () => {
    const e0 = id("skent_e0");
    expect(() =>
      createRectangleEntity(id("skent_r"), [e0, e0, e0, e0]),
    ).toThrow(SketchEntityValidationError);
  });

  it("exposes the entity kind list and type guard", () => {
    expect(SKETCH_ENTITY_KINDS).toEqual([
      "point",
      "line",
      "circle",
      "arc",
      "rectangle",
      "ellipse",
      "ellipticalArc",
      "spline",
      "polygon",
      "slot",
    ]);
    expect(isSketchEntityKind("arc")).toBe(true);
    expect(isSketchEntityKind("ellipse")).toBe(true);
    expect(isSketchEntityKind("glue")).toBe(false);
  });
});

describe("entity serialization", () => {
  it("round-trips every entity kind exactly", () => {
    const rect = createRectangleEntity(
      id("skent_r"),
      [id("skent_e0"), id("skent_e1"), id("skent_e2"), id("skent_e3")],
      { construction: true },
    );
    expectRoundTrip(createPointEntity(id("skent_p"), { x: 1.5, y: -2 }));
    expectRoundTrip(
      createLineEntity(
        id("skent_l"),
        { x: 0, y: 0 },
        { x: 4, y: 3 },
        { fixed: true },
      ),
    );
    expectRoundTrip(createCircleEntity(id("skent_c"), { x: -1, y: 2 }, 7.5));
    expectRoundTrip(
      createArcEntity(id("skent_a"), { x: 2, y: 2 }, 3, 0.5, 2.5, {
        construction: true,
      }),
    );
    expectRoundTrip(rect);
  });

  it("emits fixed key order per kind", () => {
    expect(
      Object.keys(
        serializeSketchEntity(createPointEntity(id("skent_p"), { x: 0, y: 0 })),
      ),
    ).toEqual(["id", "kind", "construction", "fixed", "x", "y"]);
    expect(
      Object.keys(
        serializeSketchEntity(
          createLineEntity(id("skent_l"), { x: 0, y: 0 }, { x: 1, y: 1 }),
        ),
      ),
    ).toEqual(["id", "kind", "construction", "fixed", "x1", "y1", "x2", "y2"]);
    expect(
      Object.keys(
        serializeSketchEntity(
          createCircleEntity(id("skent_c"), { x: 0, y: 0 }, 1),
        ),
      ),
    ).toEqual(["id", "kind", "construction", "fixed", "cx", "cy", "radius"]);
    expect(
      Object.keys(
        serializeSketchEntity(
          createArcEntity(id("skent_a"), { x: 0, y: 0 }, 1, 0, 1),
        ),
      ),
    ).toEqual([
      "id",
      "kind",
      "construction",
      "fixed",
      "cx",
      "cy",
      "radius",
      "startAngle",
      "endAngle",
    ]);
  });

  it("parses strictly: unknown kind, bad ids, bad numbers, bad rectangles", () => {
    const unknownKind = parseSketchEntity({ id: "skent_x", kind: "glue" });
    expect(!unknownKind.ok && unknownKind.error.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.entityUnknownKind,
    );
    expect(
      !parseSketchEntity({ id: "nope", kind: "point", x: 0, y: 0 }).ok,
    ).toBe(true);
    expect(
      !parseSketchEntity({ id: "skent_p", kind: "point", x: "3", y: 0 }).ok,
    ).toBe(true);
    expect(
      !parseSketchEntity({
        id: "skent_c",
        kind: "circle",
        cx: 0,
        cy: 0,
        radius: -1,
      }).ok,
    ).toBe(true);
    expect(
      !parseSketchEntity({
        id: "skent_r",
        kind: "rectangle",
        edges: ["skent_a", "skent_b", "skent_c"],
      }).ok,
    ).toBe(true);
    expect(!parseSketchEntity(null).ok).toBe(true);
    expect(
      !parseSketchEntity({
        id: "skent_a",
        kind: "arc",
        cx: 0,
        cy: 0,
        radius: 1,
        startAngle: 1,
        endAngle: 1,
      }).ok,
    ).toBe(true);
  });

  it("treats missing flags as false and ignores unknown fields", () => {
    const parsed = parseSketchEntity({
      id: "skent_p",
      kind: "point",
      x: 1,
      y: 2,
      future: "field",
    });
    expect(parsed.ok && parsed.value.construction).toBe(false);
    expect(parsed.ok && parsed.value.fixed).toBe(false);
    expect(
      !parseSketchEntity({
        id: "skent_p",
        kind: "point",
        x: 1,
        y: 2,
        fixed: "yes",
      }).ok,
    ).toBe(true);
  });

  it("adopts stored arc angles verbatim so round-trips stay exact", () => {
    const parsed = parseSketchEntity({
      id: "skent_a",
      kind: "arc",
      cx: 0,
      cy: 0,
      radius: 5,
      startAngle: 4.5,
      endAngle: 6.0,
    });
    expect(
      parsed.ok && parsed.value.kind === "arc" && parsed.value.startAngle,
    ).toBe(4.5);
    expect(
      parsed.ok && parsed.value.kind === "arc" && parsed.value.endAngle,
    ).toBe(6.0);
  });
});

describe("phase 36 entity builders", () => {
  it("builds an ellipse and canonicalizes its rotation", () => {
    const ellipse = createEllipseEntity(
      id("skent_e"),
      { x: 1, y: -2 },
      8,
      5,
      -Math.PI / 4,
    );
    expect(ellipse).toMatchObject({
      cx: 1,
      cy: -2,
      kind: "ellipse",
      radiusX: 8,
      radiusY: 5,
      rotation: (2 * Math.PI * 7) / 8,
    });
    expect(() =>
      createEllipseEntity(id("skent_e"), { x: 0, y: 0 }, -1, 5, 0),
    ).toThrow(SketchEntityValidationError);
  });

  it("builds an elliptical arc and rejects degenerate sweeps", () => {
    const arc = createEllipticalArcEntity(
      id("skent_ea"),
      { x: 0, y: 0 },
      6,
      3,
      0.2,
      0.5,
      2.5,
    );
    expect(arc).toMatchObject({
      kind: "ellipticalArc",
      radiusX: 6,
      radiusY: 3,
      startAngle: 0.5,
      endAngle: 2.5,
    });
    expect(() =>
      createEllipticalArcEntity(
        id("skent_ea"),
        { x: 0, y: 0 },
        6,
        3,
        0,
        1,
        1 + 2 * Math.PI,
      ),
    ).toThrow(SketchEntityValidationError);
  });

  it("builds both spline flavors and rejects malformed point lists", () => {
    const control = createSplineEntity(
      id("skent_s"),
      "control",
      [
        { x: 0, y: 0 },
        { x: 2, y: 6 },
        { x: 6, y: -6 },
        { x: 10, y: 0 },
      ],
      { construction: true },
    );
    expect(control).toMatchObject({ construction: true, flavor: "control" });
    const fit = createSplineEntity(id("skent_s"), "interpolated", [
      { x: 0, y: 0 },
      { x: 5, y: 5 },
    ]);
    expect(fit.flavor).toBe("interpolated");
    expect(() =>
      createSplineEntity(id("skent_s"), "control", [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]),
    ).toThrow(SketchEntityValidationError);
    expect(() =>
      createSplineEntity(id("skent_s"), "interpolated", [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ]),
    ).toThrow(SketchEntityValidationError);
  });

  it("builds polygons with fit modes and bounds the side count", () => {
    const hex = createPolygonEntity(
      id("skent_pg"),
      { x: 0, y: 0 },
      10,
      6,
      Math.PI / 6,
      "inscribed",
    );
    expect(hex).toMatchObject({ fit: "inscribed", radius: 10, sides: 6 });
    expect(() =>
      createPolygonEntity(
        id("skent_pg"),
        { x: 0, y: 0 },
        10,
        2,
        0,
        "inscribed",
      ),
    ).toThrow(SketchEntityValidationError);
    expect(() =>
      createPolygonEntity(
        id("skent_pg"),
        { x: 0, y: 0 },
        10,
        6,
        0,
        "round" as "inscribed",
      ),
    ).toThrow(SketchEntityValidationError);
  });

  it("builds straight and 3-point-arc slots with their invariants", () => {
    const straight = createStraightSlotEntity(
      id("skent_sl"),
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      3,
    );
    expect(straight).toMatchObject({
      kind: "slot",
      radius: 3,
      variant: "straight",
    });
    expect(() =>
      createStraightSlotEntity(
        id("skent_sl"),
        { x: 1, y: 1 },
        { x: 1, y: 1 },
        3,
      ),
    ).toThrow(SketchEntityValidationError);
    const arc3 = createArc3SlotEntity(
      id("skent_sl"),
      { x: -10, y: 0 },
      { x: 0, y: 6 },
      { x: 10, y: 0 },
      2,
    );
    expect(arc3).toMatchObject({ kind: "slot", radius: 2, variant: "arc3" });
    // Collinear centerline → the straight slot's job, refused here.
    expect(() =>
      createArc3SlotEntity(
        id("skent_sl"),
        { x: -10, y: 0 },
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        2,
      ),
    ).toThrow(SketchEntityValidationError);
    // A cap radius that would invert the inner offset arc (the centerline's
    // circumradius is 50.5 mm here).
    expect(() =>
      createArc3SlotEntity(
        id("skent_sl"),
        { x: -10, y: 0 },
        { x: 0, y: 1 },
        { x: 10, y: 0 },
        60,
      ),
    ).toThrow(SketchEntityValidationError);
  });
});

describe("phase 36 entity serialization", () => {
  it("round-trips every new entity kind exactly", () => {
    expectRoundTrip(
      createEllipseEntity(id("skent_e"), { x: 1, y: 2 }, 8, 5, 0.3),
    );
    expectRoundTrip(
      createEllipticalArcEntity(
        id("skent_ea"),
        { x: 1, y: 2 },
        8,
        5,
        0.3,
        0.5,
        1.5,
      ),
    );
    expectRoundTrip(
      createSplineEntity(id("skent_s"), "control", [
        { x: 0, y: 0 },
        { x: 2, y: 6 },
        { x: 6, y: -6 },
        { x: 10, y: 0 },
      ]),
    );
    expectRoundTrip(
      createSplineEntity(id("skent_s"), "interpolated", [
        { x: 0, y: 0 },
        { x: 5, y: 5 },
        { x: 10, y: 0 },
      ]),
    );
    expectRoundTrip(
      createPolygonEntity(
        id("skent_pg"),
        { x: -3, y: 4 },
        7,
        5,
        1.1,
        "circumscribed",
      ),
    );
    expectRoundTrip(
      createStraightSlotEntity(
        id("skent_sl"),
        { x: 0, y: 0 },
        { x: 20, y: 4 },
        3,
      ),
    );
    expectRoundTrip(
      createArc3SlotEntity(
        id("skent_sl"),
        { x: -10, y: 0 },
        { x: 0, y: 6 },
        { x: 10, y: 0 },
        2,
      ),
    );
  });

  it("emits fixed key order for the new kinds", () => {
    expect(
      Object.keys(
        serializeSketchEntity(
          createEllipseEntity(id("skent_e"), { x: 0, y: 0 }, 1, 2, 0),
        ),
      ),
    ).toEqual([
      "id",
      "kind",
      "construction",
      "fixed",
      "cx",
      "cy",
      "radiusX",
      "radiusY",
      "rotation",
    ]);
    expect(
      Object.keys(
        serializeSketchEntity(
          createSplineEntity(id("skent_s"), "control", [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
            { x: 2, y: -1 },
            { x: 3, y: 0 },
          ]),
        ),
      ),
    ).toEqual(["id", "kind", "construction", "fixed", "flavor", "points"]);
    expect(
      Object.keys(
        serializeSketchEntity(
          createStraightSlotEntity(
            id("skent_sl"),
            { x: 0, y: 0 },
            { x: 5, y: 0 },
            1,
          ),
        ),
      ),
    ).toEqual([
      "id",
      "kind",
      "construction",
      "fixed",
      "variant",
      "x1",
      "y1",
      "x2",
      "y2",
      "radius",
    ]);
    expect(
      Object.keys(
        serializeSketchEntity(
          createArc3SlotEntity(
            id("skent_sl"),
            { x: -10, y: 0 },
            { x: 0, y: 6 },
            { x: 10, y: 0 },
            2,
          ),
        ),
      ),
    ).toEqual([
      "id",
      "kind",
      "construction",
      "fixed",
      "variant",
      "x1",
      "y1",
      "x2",
      "y2",
      "x3",
      "y3",
      "radius",
    ]);
    expect(
      Object.keys(
        serializeSketchEntity(
          createPolygonEntity(
            id("skent_pg"),
            { x: 0, y: 0 },
            1,
            3,
            0,
            "inscribed",
          ),
        ),
      ),
    ).toEqual([
      "id",
      "kind",
      "construction",
      "fixed",
      "cx",
      "cy",
      "radius",
      "sides",
      "rotation",
      "fit",
    ]);
  });

  it("parses the new kinds strictly", () => {
    expect(
      !parseSketchEntity({
        id: "skent_e",
        kind: "ellipse",
        cx: 0,
        cy: 0,
        radiusX: 0,
        radiusY: 5,
        rotation: 0,
      }).ok,
    ).toBe(true);
    expect(
      !parseSketchEntity({
        id: "skent_s",
        kind: "spline",
        flavor: "control",
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      }).ok,
    ).toBe(true);
    expect(
      !parseSketchEntity({
        id: "skent_pg",
        kind: "polygon",
        cx: 0,
        cy: 0,
        radius: 5,
        sides: 2.5,
        rotation: 0,
        fit: "inscribed",
      }).ok,
    ).toBe(true);
    expect(
      !parseSketchEntity({
        id: "skent_sl",
        kind: "slot",
        variant: "arc3",
        x1: -10,
        y1: 0,
        x2: 0,
        y2: 6,
        radius: 2,
      }).ok,
    ).toBe(true);
    expect(
      parseSketchEntity({
        id: "skent_sl",
        kind: "slot",
        variant: "straight",
        x1: 0,
        y1: 0,
        x2: 5,
        y2: 0,
        radius: 1,
      }).ok,
    ).toBe(true);
  });
});
