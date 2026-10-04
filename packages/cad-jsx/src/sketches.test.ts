/**
 * The sketch suite: golden assertions for `<Sketch>` and its entity
 * children — the payload must be the cad-sketch CANONICAL SERIALIZED FORM
 * (formatVersion 2, workplane frame, entities in `serializeSketchEntity`'s
 * fixed key order, empty constraints) — plus the entity-validation
 * rejections that mirror the cad-sketch entity builders' own rules, the
 * applyCommand fold of a `sketch.create` onto a fresh document, and
 * determinism. Pure data: no DOM, no network, no database.
 */

import { CAD_DOCUMENT_FORMAT_VERSION } from "@slopcad/cad-core";
import {
  applyCommand,
  createDocument,
  createDocumentId,
  serializeTransaction,
} from "@slopcad/cad-core";
import { createElement, Fragment } from "react";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";

import { type CadJsxCompileError, compileModel } from "./compiler";
import {
  Arc,
  Box,
  Circle,
  Ellipse,
  Line,
  Parameter,
  Point,
  Polygon,
  Rectangle,
  Sketch,
  Slot,
  Sphere,
  Spline,
  Body,
  defineCadElement,
} from "./elements";

const V = CAD_DOCUMENT_FORMAT_VERSION;

/** The cad-sketch canonical serialized form's format version (v2). */
const SKETCH_V = 2;

/** Unwraps a successful compile into its canonical serialized transaction. */
function serializedOf(root: ReactElement<unknown>) {
  const result = compileModel(root);
  if (!result.ok) {
    throw new Error(
      `${result.error.code}: ${result.error.message} @ ${result.error.path.join(" > ")}`,
    );
  }
  return serializeTransaction(result.value);
}

/** Unwraps a failed compile (rejection fixtures never succeed). */
function rejectionOf(root: ReactElement<unknown>): CadJsxCompileError {
  const result = compileModel(root);
  if (result.ok) throw new Error("The fixture unexpectedly compiled.");
  return result.error;
}

describe("sketch golden commands", () => {
  it("compiles <Sketch> with a circle to the canonical serialized payload", () => {
    const result = serializedOf(
      createElement(
        Sketch,
        { id: "skd_profile" },
        createElement(Circle, { cx: 5, cy: 0, radius: 2 }),
      ),
    );
    expect(result.commands).toEqual([
      {
        formatVersion: V,
        type: "sketch.create",
        id: "skd_profile",
        name: "profile",
        sketch: {
          formatVersion: SKETCH_V,
          workplane: {
            origin: { x: 0, y: 0, z: 0 },
            normal: { x: 0, y: 0, z: 1 },
            xAxis: { x: 1, y: 0, z: 0 },
          },
          entities: [
            {
              id: "skent_circle-1",
              kind: "circle",
              construction: false,
              fixed: false,
              cx: 5,
              cy: 0,
              radius: 2,
            },
          ],
          constraints: [],
        },
      },
    ]);
  });

  it("derives default sketch ids and names by occurrence", () => {
    const result = serializedOf(
      createElement(
        Fragment,
        null,
        createElement(Sketch, null, createElement(Point, { x: 1, y: 2 })),
        createElement(Sketch, null, createElement(Point, { x: 3, y: 4 })),
      ),
    );
    const sketches = result.commands.map((command) =>
      command.type === "sketch.create"
        ? { id: command.id, name: command.name }
        : null,
    );
    expect(sketches).toEqual([
      { id: "skd_sketch-1", name: "sketch 1" },
      { id: "skd_sketch-2", name: "sketch 2" },
    ]);
    const entities = result.commands.map((command) =>
      command.type === "sketch.create" ? command.sketch.entities : null,
    );
    expect(entities).toEqual([
      [
        {
          id: "skent_point-1",
          kind: "point",
          construction: false,
          fixed: false,
          x: 1,
          y: 2,
        },
      ],
      [
        {
          id: "skent_point-2",
          kind: "point",
          construction: false,
          fixed: false,
          x: 3,
          y: 4,
        },
      ],
    ]);
  });

  it("accepts an explicit workplane frame and carries it verbatim", () => {
    const result = serializedOf(
      createElement(
        Sketch,
        {
          id: "skd_front",
          name: "front section",
          origin: { x: 0, y: 10, z: 0 },
          normal: { x: 0, y: 1, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
        },
        createElement(Line, { x1: 0, y1: 0, x2: 30, y2: 0 }),
      ),
    );
    const command = result.commands[0];
    if (command === undefined || command.type !== "sketch.create") {
      throw new Error("the sketch.create command is missing");
    }
    expect(command.name).toBe("front section");
    expect(command.sketch.workplane).toEqual({
      origin: { x: 0, y: 10, z: 0 },
      normal: { x: 0, y: 1, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 },
    });
  });

  it("compiles <Rectangle> to four chained lines plus the rectangle entity", () => {
    const result = serializedOf(
      createElement(
        Sketch,
        null,
        createElement(Rectangle, { x1: 0, y1: 0, x2: 60, y2: 40 }),
      ),
    );
    const command = result.commands[0];
    if (command === undefined || command.type !== "sketch.create") {
      throw new Error("the sketch.create command is missing");
    }
    expect(command.sketch.entities).toEqual([
      {
        id: "skent_rectangle-1-bottom",
        kind: "line",
        construction: false,
        fixed: false,
        x1: 0,
        y1: 0,
        x2: 60,
        y2: 0,
      },
      {
        id: "skent_rectangle-1-right",
        kind: "line",
        construction: false,
        fixed: false,
        x1: 60,
        y1: 0,
        x2: 60,
        y2: 40,
      },
      {
        id: "skent_rectangle-1-top",
        kind: "line",
        construction: false,
        fixed: false,
        x1: 60,
        y1: 40,
        x2: 0,
        y2: 40,
      },
      {
        id: "skent_rectangle-1-left",
        kind: "line",
        construction: false,
        fixed: false,
        x1: 0,
        y1: 40,
        x2: 0,
        y2: 0,
      },
      {
        id: "skent_rectangle-1",
        kind: "rectangle",
        construction: false,
        fixed: false,
        edges: [
          "skent_rectangle-1-bottom",
          "skent_rectangle-1-right",
          "skent_rectangle-1-top",
          "skent_rectangle-1-left",
        ],
      },
    ]);
  });

  it("serializes every entity kind in cad-sketch's fixed key order", () => {
    const result = serializedOf(
      createElement(
        Sketch,
        { id: "skd_zoo" },
        createElement(Point, { id: "skent_anchor", x: 1, y: 2 }),
        createElement(Line, { x1: 0, y1: 0, x2: 5, y2: 5 }),
        createElement(Arc, {
          cx: 0,
          cy: 0,
          radius: 4,
          startAngle: -Math.PI / 2,
          endAngle: 0,
        }),
        createElement(Ellipse, {
          cx: 0,
          cy: 0,
          radiusX: 6,
          radiusY: 3,
          rotation: 7,
        }),
        createElement(Slot, {
          variant: "straight",
          x1: 0,
          y1: 0,
          x2: 20,
          y2: 0,
          radius: 3,
        }),
        createElement(Slot, {
          variant: "arc3",
          x1: -10,
          y1: 0,
          x2: 0,
          y2: 8,
          x3: 10,
          y3: 0,
          radius: 2,
        }),
        createElement(Polygon, {
          cx: 0,
          cy: 0,
          radius: 5,
          sides: 6,
          rotation: Math.PI / 6,
          fit: "circumscribed",
        }),
        createElement(Spline, {
          flavor: "control",
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 2 },
            { x: 3, y: 2 },
            { x: 4, y: 0 },
          ],
        }),
        createElement(Spline, {
          flavor: "interpolated",
          points: [
            { x: 0, y: 0 },
            { x: 2, y: 1 },
            { x: 4, y: 0 },
          ],
        }),
      ),
    );
    const command = result.commands[0];
    if (command === undefined || command.type !== "sketch.create") {
      throw new Error("the sketch.create command is missing");
    }
    expect(command.sketch.entities).toEqual([
      {
        id: "skent_anchor",
        kind: "point",
        construction: false,
        fixed: false,
        x: 1,
        y: 2,
      },
      {
        id: "skent_line-1",
        kind: "line",
        construction: false,
        fixed: false,
        x1: 0,
        y1: 0,
        x2: 5,
        y2: 5,
      },
      {
        // Authored -π/2 → 0; cad-sketch canonicalizes both angles into [0, 2π).
        id: "skent_arc-1",
        kind: "arc",
        construction: false,
        fixed: false,
        cx: 0,
        cy: 0,
        radius: 4,
        startAngle: 2 * Math.PI - Math.PI / 2,
        endAngle: 0,
      },
      {
        // Authored rotation 7 rad; canonicalized into [0, 2π).
        id: "skent_ellipse-1",
        kind: "ellipse",
        construction: false,
        fixed: false,
        cx: 0,
        cy: 0,
        radiusX: 6,
        radiusY: 3,
        rotation: 7 % (2 * Math.PI),
      },
      {
        id: "skent_slot-1",
        kind: "slot",
        construction: false,
        fixed: false,
        variant: "straight",
        x1: 0,
        y1: 0,
        x2: 20,
        y2: 0,
        radius: 3,
      },
      {
        id: "skent_slot-2",
        kind: "slot",
        construction: false,
        fixed: false,
        variant: "arc3",
        x1: -10,
        y1: 0,
        x2: 0,
        y2: 8,
        x3: 10,
        y3: 0,
        radius: 2,
      },
      {
        id: "skent_polygon-1",
        kind: "polygon",
        construction: false,
        fixed: false,
        cx: 0,
        cy: 0,
        radius: 5,
        sides: 6,
        rotation: Math.PI / 6,
        fit: "circumscribed",
      },
      {
        id: "skent_spline-1",
        kind: "spline",
        construction: false,
        fixed: false,
        flavor: "control",
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 2 },
          { x: 3, y: 2 },
          { x: 4, y: 0 },
        ],
      },
      {
        id: "skent_spline-2",
        kind: "spline",
        construction: false,
        fixed: false,
        flavor: "interpolated",
        points: [
          { x: 0, y: 0 },
          { x: 2, y: 1 },
          { x: 4, y: 0 },
        ],
      },
    ]);
  });

  it("counts entity occurrences per kind across the whole tree", () => {
    const result = serializedOf(
      createElement(
        Fragment,
        null,
        createElement(
          Sketch,
          null,
          createElement(Circle, { cx: 0, cy: 0, radius: 1 }),
          createElement(Circle, { cx: 5, cy: 0, radius: 1 }),
        ),
        createElement(
          Sketch,
          null,
          createElement(Circle, { cx: 0, cy: 0, radius: 2 }),
        ),
      ),
    );
    const ids: string[] = [];
    for (const command of result.commands) {
      if (command.type !== "sketch.create") continue;
      const entities = command.sketch.entities;
      if (!Array.isArray(entities)) continue;
      for (const entity of entities) {
        ids.push(String((entity as { readonly id?: unknown }).id));
      }
    }
    expect(ids).toEqual(["skent_circle-1", "skent_circle-2", "skent_circle-3"]);
  });

  it("compiles byte-identical transactions for the same sketch tree", () => {
    const model = createElement(
      Sketch,
      { id: "skd_steady" },
      createElement(Rectangle, { x1: 0, y1: 0, x2: 10, y2: 5 }),
      createElement(Circle, { cx: 5, cy: 2.5, radius: 1 }),
    );
    expect(JSON.stringify(serializedOf(model))).toBe(
      JSON.stringify(serializedOf(model)),
    );
  });
});

describe("the sketch applyCommand fold", () => {
  it("applies a compiled sketch.create onto a fresh document", () => {
    const result = compileModel(
      createElement(
        Sketch,
        { id: "skd_folded", name: "folded sketch" },
        createElement(Rectangle, { x1: 0, y1: 0, x2: 25, y2: 12 }),
      ),
    );
    if (!result.ok) throw new Error(result.error.message);
    let document = createDocument(createDocumentId("doc_cad_jsx_sketch"));
    for (const command of result.value.commands) {
      const applied = applyCommand(document, command);
      if (!applied.ok) throw new Error(applied.error.message);
      document = applied.value;
    }
    expect(document.sketches).toHaveLength(1);
    const sketch = document.sketches[0];
    if (sketch === undefined) throw new Error("the sketch record is missing");
    expect(sketch.id).toBe("skd_folded");
    expect(sketch.name).toBe("folded sketch");
    // Four chained lines plus the rectangle entity, stored verbatim.
    expect(sketch.sketch.entities).toHaveLength(5);
    expect(document.features).toHaveLength(0);
  });
});

describe("sketch rejections", () => {
  it("rejects entities outside a sketch, of every kind", () => {
    for (const element of [
      createElement(Point, { x: 0, y: 0 }),
      createElement(Line, { x1: 0, y1: 0, x2: 1, y2: 1 }),
      createElement(Circle, { cx: 0, cy: 0, radius: 1 }),
      createElement(Arc, {
        cx: 0,
        cy: 0,
        radius: 1,
        startAngle: 0,
        endAngle: 1,
      }),
      createElement(Ellipse, { cx: 0, cy: 0, radiusX: 1, radiusY: 2 }),
      createElement(Slot, {
        variant: "straight",
        x1: 0,
        y1: 0,
        x2: 1,
        y2: 0,
        radius: 1,
      }),
      createElement(Polygon, {
        cx: 0,
        cy: 0,
        radius: 1,
        sides: 3,
        fit: "inscribed",
      }),
      createElement(Spline, {
        flavor: "interpolated",
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
      }),
      createElement(Rectangle, { x1: 0, y1: 0, x2: 1, y2: 1 }),
    ]) {
      const error = rejectionOf(element);
      expect(error.code).toBe("cadjsx/sketch-entity-outside");
    }
  });

  it("rejects non-entity children inside a sketch", () => {
    const box = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Box, { width: 1, depth: 1, height: 1 }),
      ),
    );
    expect(box.code).toBe("cadjsx/sketch-child-invalid");
    const parameter = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Parameter, { name: "w", value: 1 }),
      ),
    );
    expect(parameter.code).toBe("cadjsx/sketch-child-invalid");
    const body = rejectionOf(
      createElement(Sketch, null, createElement(Body, { name: "b" })),
    );
    expect(body.code).toBe("cadjsx/sketch-child-invalid");
    const sphere = rejectionOf(
      createElement(Sketch, null, createElement(Sphere, { radius: 1 })),
    );
    expect(sphere.code).toBe("cadjsx/sketch-child-invalid");
  });

  it("rejects sketches nested inside containers", () => {
    const inBody = rejectionOf(
      createElement(Body, { name: "b" }, createElement(Sketch, null)),
    );
    expect(inBody.code).toBe("cadjsx/sketch-nested");
    const inSketch = rejectionOf(
      createElement(Sketch, null, createElement(Sketch, null)),
    );
    expect(inSketch.code).toBe("cadjsx/sketch-nested");
  });

  it("rejects workplane frames that are not orthonormal and right-handed", () => {
    const notUnit = rejectionOf(
      createElement(Sketch, { normal: { x: 0, y: 0, z: 2 } }),
    );
    expect(notUnit.code).toBe("cadjsx/sketch-payload-invalid");
    expect(notUnit.message).toContain("unit");

    const notPerpendicular = rejectionOf(
      createElement(Sketch, {
        normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 0.6, y: 0, z: 0.8 },
      }),
    );
    expect(notPerpendicular.code).toBe("cadjsx/sketch-payload-invalid");
    expect(notPerpendicular.message).toContain("perpendicular");

    // A parallel xAxis carries no in-plane direction at all: the frame is
    // degenerate (the perpendicular rule catches it first — the right-
    // handed cross-product rule mirrors cad-sketch's stored-data check).
    const parallelAxis = rejectionOf(
      createElement(Sketch, {
        normal: { x: 0, y: 0, z: 1 },
        xAxis: { x: 0, y: 0, z: 1 },
      }),
    );
    expect(parallelAxis.code).toBe("cadjsx/sketch-payload-invalid");

    const looseSketch = defineCadElement<{
      readonly origin?: unknown;
      readonly normal?: unknown;
      readonly xAxis?: unknown;
    }>("sketch");
    const malformed = rejectionOf(
      createElement(looseSketch, { origin: { x: 0, y: 0 } }),
    );
    expect(malformed.code).toBe("cadjsx/sketch-payload-invalid");
  });

  it("rejects malformed entity geometry per the cad-sketch builder rules", () => {
    const zeroRadius = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Circle, { cx: 0, cy: 0, radius: 0 }),
      ),
    );
    expect(zeroRadius.code).toBe("cadjsx/sketch-payload-invalid");

    const zeroSweep = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Arc, {
          cx: 0,
          cy: 0,
          radius: 2,
          startAngle: 0,
          endAngle: 0,
        }),
      ),
    );
    expect(zeroSweep.code).toBe("cadjsx/sketch-payload-invalid");

    const fullSweep = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Arc, {
          cx: 0,
          cy: 0,
          radius: 2,
          startAngle: 0,
          endAngle: 2 * Math.PI,
        }),
      ),
    );
    expect(fullSweep.code).toBe("cadjsx/sketch-payload-invalid");

    const degenerateRectangle = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Rectangle, { x1: 0, y1: 0, x2: 0, y2: 5 }),
      ),
    );
    expect(degenerateRectangle.code).toBe("cadjsx/sketch-payload-invalid");

    const fewSides = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Polygon, {
          cx: 0,
          cy: 0,
          radius: 2,
          sides: 2,
          fit: "inscribed",
        }),
      ),
    );
    expect(fewSides.code).toBe("cadjsx/sketch-payload-invalid");

    const fractionalSides = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Polygon, {
          cx: 0,
          cy: 0,
          radius: 2,
          sides: 4.5,
          fit: "inscribed",
        }),
      ),
    );
    expect(fractionalSides.code).toBe("cadjsx/sketch-payload-invalid");

    const badControlCount = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Spline, {
          flavor: "control",
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 },
          ],
        }),
      ),
    );
    expect(badControlCount.code).toBe("cadjsx/sketch-payload-invalid");

    const coincidentFitPoints = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Spline, {
          flavor: "interpolated",
          points: [
            { x: 0, y: 0 },
            { x: 0, y: 0 },
          ],
        }),
      ),
    );
    expect(coincidentFitPoints.code).toBe("cadjsx/sketch-payload-invalid");

    const slotSameCentres = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Slot, {
          variant: "straight",
          x1: 1,
          y1: 1,
          x2: 1,
          y2: 1,
          radius: 2,
        }),
      ),
    );
    expect(slotSameCentres.code).toBe("cadjsx/sketch-payload-invalid");

    const slotCollinear = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Slot, {
          variant: "arc3",
          x1: 0,
          y1: 0,
          x2: 5,
          y2: 0,
          x3: 10,
          y3: 0,
          radius: 1,
        }),
      ),
    );
    expect(slotCollinear.code).toBe("cadjsx/sketch-payload-invalid");

    const slotMissingEnd = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Slot, {
          variant: "arc3",
          x1: 0,
          y1: 0,
          x2: 5,
          y2: 0,
          radius: 1,
        }),
      ),
    );
    expect(slotMissingEnd.code).toBe("cadjsx/sketch-payload-invalid");

    const notFinite = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Point, { x: Number.NaN, y: 0 }),
      ),
    );
    expect(notFinite.code).toBe("cadjsx/sketch-payload-invalid");
  });

  it("rejects duplicate and malformed entity ids within one sketch", () => {
    const duplicate = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Point, { id: "skent_same", x: 0, y: 0 }),
        createElement(Point, { id: "skent_same", x: 1, y: 1 }),
      ),
    );
    expect(duplicate.code).toBe("cadjsx/sketch-payload-invalid");
    expect(duplicate.message).toContain("skent_same");

    const badPrefix = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Point, { id: "entity_1", x: 0, y: 0 }),
      ),
    );
    expect(badPrefix.code).toBe("cadjsx/prop-value-invalid");

    const longPayload = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(Point, { id: `skent_${"a".repeat(65)}`, x: 0, y: 0 }),
      ),
    );
    expect(longPayload.code).toBe("cadjsx/id-invalid");
  });

  it("rejects sketch id and name misuse", () => {
    const badId = rejectionOf(createElement(Sketch, { id: "sketchy" }));
    expect(badId.code).toBe("cadjsx/id-invalid");

    const longName = rejectionOf(
      createElement(Sketch, { name: "n".repeat(65) }),
    );
    expect(longName.code).toBe("cadjsx/prop-value-invalid");

    const emptyName = rejectionOf(createElement(Sketch, { name: "" }));
    expect(emptyName.code).toBe("cadjsx/prop-value-invalid");

    const duplicateSketchIds = rejectionOf(
      createElement(
        Fragment,
        null,
        createElement(Sketch, { id: "skd_same" }),
        createElement(Sketch, { id: "skd_same" }),
      ),
    );
    expect(duplicateSketchIds.code).toBe("cadjsx/id-conflict");
  });

  it("rejects unknown props on sketch entities", () => {
    const looseCircle = defineCadElement<{
      readonly cx?: unknown;
      readonly cy?: unknown;
      readonly radius?: unknown;
      readonly bogus?: unknown;
    }>("circle");
    const error = rejectionOf(
      createElement(
        Sketch,
        null,
        createElement(looseCircle, { cx: 0, cy: 0, radius: 1, bogus: 2 }),
      ),
    );
    expect(error.code).toBe("cadjsx/prop-unknown");
    expect(error.message).toContain("bogus");
  });
});
