/**
 * Entity operations (Phase 37) against hand fixtures: offset (single line,
 * chain with miter rejoin, closed loop, rims, declines), mirror about a
 * line (every transformable kind, arc angle reversal, axis-kind refusal),
 * rectangular and circular arrays (placement, counts, declines), and extend
 * (the complement of trim: line and rim boundaries, beyond-the-end only).
 * Every suite asserts the command list AND applies it through the real
 * interpreter, so the produced commands commit.
 */

import { describe, expect, it } from "vitest";
import type { LineEntity, SketchEntity } from "./entities";

import { applySketchTransaction } from "./commands";
import {
  CHAIN_CONTACT_EPSILON_MM,
  OFFSET_COLLAPSE_EPSILON_MM,
  SKETCH_ENTITY_OP_ERROR_CODES,
  circularArrayCommands,
  createSketchOpIdAllocator,
  extendLineCommand,
  mirrorEntitiesCommands,
  offsetEntitiesCommands,
  rectangularArrayCommands,
} from "./entity-ops";
import {
  createArcEntity,
  createCircleEntity,
  createLineEntity,
  createPointEntity,
  createPolygonEntity,
  createSplineEntity,
  createStraightSlotEntity,
} from "./entities";
import { createSketch, type Sketch } from "./sketch";
import { createSketchEntityId, type SketchEntityId } from "./sketch-ids";
import { xyWorkplane } from "./workplane";

const id = createSketchEntityId;

function sketchOf(entities: readonly SketchEntity[]): Sketch {
  const created = createSketch(xyWorkplane(), [...entities], []);
  if (!created.ok) {
    throw new Error(`Fixture sketch rejected: ${created.error.message}`);
  }
  return created.value;
}

/** Applies the op's commands through the real interpreter, or throws. */
function applyAll(
  sketch: Sketch,
  run: () => ReturnType<typeof offsetEntitiesCommands>,
): Sketch {
  const result = run();
  if (!result.ok) throw new Error(`The op declined: ${result.error.code}`);
  const applied = applySketchTransaction(sketch, { commands: result.value });
  if (!applied.ok) throw new Error(`The commit failed: ${applied.error.code}`);
  return applied.value;
}

function lineById(
  sketch: Sketch,
  entityId: string,
): {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
} {
  const entity = sketch.entities.find((candidate) => candidate.id === entityId);
  if (entity === undefined || entity.kind !== "line") {
    throw new Error(`Expected line ${entityId} in the applied sketch.`);
  }
  return entity;
}

// ---------------------------------------------------------------------------
// Offset
// ---------------------------------------------------------------------------

describe("offsetEntitiesCommands", () => {
  it("offsets a single line to the clicked side by the measured distance", () => {
    const ab = id("skent_ab");
    const sketch = sketchOf([
      createLineEntity(ab, { x: 0, y: 0 }, { x: 40, y: 0 }),
    ]);
    // Click 5 mm above (left of) start→end: offset up by 5.
    const result = offsetEntitiesCommands(sketch, {
      entityIds: [ab],
      towards: { x: 20, y: 5 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    expect(result.value[0]?.type).toBe("sketch.entity.create");
    const applied = applyAll(sketch, () => result);
    const copy = applied.entities.find(
      (entity) => entity !== sketch.entities[0],
    );
    expect(copy?.kind).toBe("line");
    if (copy !== undefined && copy.kind === "line") {
      expect(copy.y1).toBeCloseTo(5, 9);
      expect(copy.y2).toBeCloseTo(5, 9);
    }
  });

  it("offsets a single line to the NEGATIVE side: the copy lands on the clicked side", () => {
    const ab = id("skent_ab");
    const sketch = sketchOf([
      createLineEntity(ab, { x: 0, y: 0 }, { x: 40, y: 0 }),
    ]);
    // Click 5 mm BELOW (right of) start→end: the copy must sit at y = −5 —
    // on the clicked side, never mirrored to the line's left normal.
    const result = offsetEntitiesCommands(sketch, {
      entityIds: [ab],
      towards: { x: 20, y: -5 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applyAll(sketch, () => result);
    const copy = applied.entities.find(
      (entity) => entity !== sketch.entities[0],
    );
    expect(copy?.kind).toBe("line");
    if (copy !== undefined && copy.kind === "line") {
      expect(copy.y1).toBeCloseTo(-5, 9);
      expect(copy.y2).toBeCloseTo(-5, 9);
      expect(copy.x1).toBeCloseTo(0, 9);
      expect(copy.x2).toBeCloseTo(40, 9);
    }
  });

  it("offsets a two-line open chain and rejoins the members at a miter", () => {
    const ab = id("skent_ab");
    const bc = id("skent_bc");
    const sketch = sketchOf([
      createLineEntity(ab, { x: 0, y: 0 }, { x: 30, y: 0 }),
      createLineEntity(bc, { x: 30, y: 0 }, { x: 30, y: 30 }),
    ]);
    // The click sits 5 above ab and 20 left of bc: the shared magnitude is
    // 5, each member translates along its own left normal toward the click,
    // and the corner rejoins at the offset lines' intersection (25, 5).
    const result = offsetEntitiesCommands(sketch, {
      entityIds: [ab, bc],
      towards: { x: 25, y: 5 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applyAll(sketch, () => result);
    const copies = applied.entities.filter(
      (entity): entity is LineEntity =>
        entity.kind === "line" && entity.id !== ab && entity.id !== bc,
    );
    expect(copies).toHaveLength(2);
    const byX = [...copies].sort((a, b) => a.x1 - b.x1);
    const horizontal = byX[0];
    const vertical = byX[1];
    expect(horizontal).toBeDefined();
    expect(vertical).toBeDefined();
    if (horizontal === undefined || vertical === undefined) return;
    expect(horizontal.y1).toBeCloseTo(5, 9);
    expect(horizontal.x2).toBeCloseTo(25, 9);
    expect(vertical.x1).toBeCloseTo(25, 9);
    expect(vertical.y2).toBeCloseTo(30, 9);
  });

  it("propagates a NEGATIVE-side chain offset through a member drawn against the chain", () => {
    const ab = id("skent_ab");
    const cb = id("skent_cb");
    const sketch = sketchOf([
      createLineEntity(ab, { x: 0, y: 0 }, { x: 40, y: 0 }),
      // cb is DRAWN right-to-left (against the chain run): its left normal
      // points opposite the anchor's. The click 5 below must still put BOTH
      // copies below.
      createLineEntity(cb, { x: 60, y: 0 }, { x: 40, y: 0 }),
    ]);
    const result = offsetEntitiesCommands(sketch, {
      entityIds: [ab, cb],
      towards: { x: 20, y: -5 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applyAll(sketch, () => result);
    const copies = applied.entities.filter(
      (entity): entity is LineEntity =>
        entity.kind === "line" && entity.id !== ab && entity.id !== cb,
    );
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      expect(copy.y1).toBeCloseTo(-5, 9);
      expect(copy.y2).toBeCloseTo(-5, 9);
    }
  });

  it("measures the chain offset from the FIRST-TARGETED entity, not the walk head", () => {
    const ab = id("skent_ab");
    const bc = id("skent_bc");
    const sketch = sketchOf([
      createLineEntity(ab, { x: 0, y: 0 }, { x: 40, y: 0 }),
      createLineEntity(bc, { x: 40, y: 0 }, { x: 40, y: 30 }),
    ]);
    // The click sits 10 below ab (the first-targeted anchor) but 20 left of
    // bc. The magnitude is 10 — measured from the anchor per the
    // OffsetEntitiesRequest contract — not the 20 the chain-walk head (bc)
    // would report. The chain offsets to the click's side of ab: ab down
    // 10, bc to the same side of the chain (x = 50), mitred at (50, −10).
    const result = offsetEntitiesCommands(sketch, {
      entityIds: [ab, bc],
      towards: { x: 20, y: -10 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applyAll(sketch, () => result);
    const copies = applied.entities.filter(
      (entity): entity is LineEntity =>
        entity.kind === "line" && entity.id !== ab && entity.id !== bc,
    );
    expect(copies).toHaveLength(2);
    const horizontal = copies.find((copy) => copy.y1 === copy.y2);
    const vertical = copies.find((copy) => copy.x1 === copy.x2);
    expect(horizontal).toBeDefined();
    expect(vertical).toBeDefined();
    if (horizontal === undefined || vertical === undefined) return;
    // 10 below — the clicked magnitude — never 20.
    expect(horizontal.y1).toBeCloseTo(-10, 9);
    expect(horizontal.y2).toBeCloseTo(-10, 9);
    expect(vertical.x1).toBeCloseTo(50, 9);
    expect(vertical.y2).toBeCloseTo(30, 9);
  });

  it("offsets a closed two-line… three-line loop and closes the rejoin", () => {
    const ab = id("skent_ab");
    const bc = id("skent_bc");
    const ca = id("skent_ca");
    const sketch = sketchOf([
      createLineEntity(ab, { x: 0, y: 0 }, { x: 30, y: 0 }),
      createLineEntity(bc, { x: 30, y: 0 }, { x: 30, y: 30 }),
      createLineEntity(ca, { x: 30, y: 30 }, { x: 0, y: 0 }),
    ]);
    // Click 5 above ab (the first-targeted anchor): every line offsets
    // 5 mm inward — within the triangle's inradius (~8.79 mm), so the
    // offset survives; the result must be a CLOSED triangle (each pair
    // rejoined).
    const result = offsetEntitiesCommands(sketch, {
      entityIds: [ab, bc, ca],
      towards: { x: 20, y: 5 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applyAll(sketch, () => result);
    const copies = applied.entities.filter(
      (entity): entity is LineEntity =>
        entity.kind === "line" && ![ab, bc, ca].includes(entity.id),
    );
    expect(copies).toHaveLength(3);
    const endpoints = new Set(
      copies.flatMap((entity) =>
        entity.kind === "line"
          ? [
              `${String(entity.x1)},${String(entity.y1)}`,
              `${String(entity.x2)},${String(entity.y2)}`,
            ]
          : [],
      ),
    );
    // Closed: every endpoint is shared by exactly two of the three lines.
    for (const key of endpoints) {
      const [xs, ys] = key.split(",");
      const x = Number(xs);
      const y = Number(ys);
      const count = copies.filter(
        (entity) =>
          entity.kind === "line" &&
          (Math.hypot(entity.x1 - x, entity.y1 - y) < 1e-9 ||
            Math.hypot(entity.x2 - x, entity.y2 - y) < 1e-9),
      ).length;
      expect(count).toBe(2);
    }
  });

  it("grows a circle outward and shrinks it inward, declining a collapse", () => {
    const c = id("skent_c");
    const sketch = sketchOf([createCircleEntity(c, { x: 0, y: 0 }, 10)]);
    const outward = offsetEntitiesCommands(sketch, {
      entityIds: [c],
      towards: { x: 16, y: 0 },
    });
    expect(outward.ok).toBe(true);
    if (outward.ok) {
      const applied = applyAll(sketch, () => outward);
      const copy = applied.entities.find((entity) => entity.id !== c);
      expect(copy?.kind).toBe("circle");
      if (copy !== undefined && copy.kind === "circle") {
        expect(copy.radius).toBeCloseTo(16, 9);
      }
    }
    const inward = offsetEntitiesCommands(sketch, {
      entityIds: [c],
      towards: { x: 3, y: 0 },
    });
    expect(inward.ok).toBe(true);
    if (inward.ok) {
      const applied = applyAll(sketch, () => inward);
      const copy = applied.entities.find((entity) => entity.id !== c);
      if (copy !== undefined && copy.kind === "circle") {
        expect(copy.radius).toBeCloseTo(3, 9);
      }
    }
    const collapsed = offsetEntitiesCommands(sketch, {
      entityIds: [c],
      towards: { x: 0, y: 0 },
    });
    expect(collapsed.ok).toBe(false);
    if (!collapsed.ok) {
      expect(collapsed.error.code).toBe(
        SKETCH_ENTITY_OP_ERROR_CODES.offsetCollapsed,
      );
    }
  });

  it("declines a closed loop inset to its EXACT collapse", () => {
    // A 40×40 square: insetting by exactly half the side (20 mm) leaves
    // every member a zero-length span — the op must refuse, not commit
    // four degenerate creates.
    const ab = id("skent_ab");
    const bc = id("skent_bc");
    const cd = id("skent_cd");
    const da = id("skent_da");
    const sketch = sketchOf([
      createLineEntity(ab, { x: 0, y: 0 }, { x: 40, y: 0 }),
      createLineEntity(bc, { x: 40, y: 0 }, { x: 40, y: 40 }),
      createLineEntity(cd, { x: 40, y: 40 }, { x: 0, y: 40 }),
      createLineEntity(da, { x: 0, y: 40 }, { x: 0, y: 0 }),
    ]);
    const result = offsetEntitiesCommands(sketch, {
      entityIds: [ab, bc, cd, da],
      towards: { x: 20, y: 20 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(
        SKETCH_ENTITY_OP_ERROR_CODES.offsetCollapsed,
      );
    }
  });

  it("declines a closed loop inset BEYOND its collapse (miters fold the members)", () => {
    // Inset 30 mm into the 40×40 square: past the collapse the rejoining
    // miters fold members end-for-end — reversed spans the op refuses.
    const ab = id("skent_ab");
    const bc = id("skent_bc");
    const cd = id("skent_cd");
    const da = id("skent_da");
    const sketch = sketchOf([
      createLineEntity(ab, { x: 0, y: 0 }, { x: 40, y: 0 }),
      createLineEntity(bc, { x: 40, y: 0 }, { x: 40, y: 40 }),
      createLineEntity(cd, { x: 40, y: 40 }, { x: 0, y: 40 }),
      createLineEntity(da, { x: 0, y: 40 }, { x: 0, y: 0 }),
    ]);
    const result = offsetEntitiesCommands(sketch, {
      entityIds: [ab, bc, cd, da],
      towards: { x: 20, y: 30 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(
        SKETCH_ENTITY_OP_ERROR_CODES.offsetCollapsed,
      );
    }
  });

  it("declines splines and rectangles with the unsupported-kind code", () => {
    const spline = id("skent_s");
    const sketch = sketchOf([
      createSplineEntity(spline, "control", [
        { x: 0, y: 0 },
        { x: 10, y: 10 },
        { x: 20, y: 0 },
        { x: 30, y: 10 },
      ]),
    ]);
    const result = offsetEntitiesCommands(sketch, {
      entityIds: [spline],
      towards: { x: 0, y: 5 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(
        SKETCH_ENTITY_OP_ERROR_CODES.unsupportedKind,
      );
    }
  });

  it("refuses unknown entities", () => {
    const sketch = sketchOf([]);
    const result = offsetEntitiesCommands(sketch, {
      entityIds: [id("skent_missing")],
      towards: { x: 0, y: 0 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(
        SKETCH_ENTITY_OP_ERROR_CODES.entityUnknown,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Mirror
// ---------------------------------------------------------------------------

describe("mirrorEntitiesCommands", () => {
  const axis = id("skent_axis");

  function mirrored(
    entities: readonly SketchEntity[],
    targets: readonly SketchEntityId[],
  ): ReturnType<typeof mirrorEntitiesCommands> {
    const sketch = sketchOf([
      createLineEntity(axis, { x: 0, y: 0 }, { x: 0, y: 40 }),
      ...entities,
    ]);
    return mirrorEntitiesCommands(sketch, {
      mirrorLineId: axis,
      entityIds: targets,
    });
  }

  it("mirrors a point across the y-axis line", () => {
    const p = id("skent_p");
    const result = mirrored([createPointEntity(p, { x: 12, y: 7 }, {})], [p]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const command = result.value[0];
    expect(command?.type).toBe("sketch.entity.create");
    if (command !== undefined && command.type === "sketch.entity.create") {
      expect(command.entity.kind).toBe("point");
      if (command.entity.kind === "point") {
        expect(command.entity.x).toBeCloseTo(-12, 9);
        expect(command.entity.y).toBeCloseTo(7, 9);
      }
    }
  });

  it("mirrors an arc by sweeping the mirrored endpoints in reverse", () => {
    const arc = id("skent_a");
    const quarter = createArcEntity(
      arc,
      { x: 10, y: 0 },
      5,
      0,
      Math.PI / 2,
      {},
    );
    const result = mirrored([quarter], [arc]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const command = result.value[0];
    if (command !== undefined && command.type === "sketch.entity.create") {
      expect(command.entity.kind).toBe("arc");
      if (command.entity.kind === "arc") {
        expect(command.entity.cx).toBeCloseTo(-10, 9);
        expect(command.entity.cy).toBeCloseTo(0, 9);
        expect(command.entity.radius).toBeCloseTo(5, 9);
        // Mirrored across x=0: the start (15, 0) maps to (−15, 0) — the new
        // END; the end (10, 5) maps to (−10, 5) — the new START.
        expect(command.entity.startAngle).toBeCloseTo(Math.PI / 2, 9);
        expect(command.entity.endAngle).toBeCloseTo(Math.PI, 9);
      }
    }
  });

  it("refuses a non-line mirror axis", () => {
    const circle = id("skent_c");
    const sketch = sketchOf([createCircleEntity(circle, { x: 0, y: 0 }, 5)]);
    const result = mirrorEntitiesCommands(sketch, {
      mirrorLineId: circle,
      entityIds: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(
        SKETCH_ENTITY_OP_ERROR_CODES.mirrorLineNeeded,
      );
    }
  });

  it("mirrors a slot and a polygon preserving their discrete parameters", () => {
    const slot = id("skent_slot");
    const polygon = id("skent_poly");
    const result = mirrored(
      [
        createStraightSlotEntity(slot, { x: 5, y: 5 }, { x: 15, y: 5 }, 2, {}),
        createPolygonEntity(
          polygon,
          { x: 8, y: 20 },
          4,
          6,
          0.3,
          "inscribed",
          {},
        ),
      ],
      [slot, polygon],
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(2);
    const entities = result.value.map((command) =>
      command.type === "sketch.entity.create" ? command.entity : undefined,
    );
    const mirroredSlot = entities[0];
    const mirroredPolygon = entities[1];
    expect(mirroredSlot?.kind).toBe("slot");
    if (mirroredSlot !== undefined && mirroredSlot.kind === "slot") {
      expect(mirroredSlot.x1).toBeCloseTo(-5, 9);
      expect(mirroredSlot.x2).toBeCloseTo(-15, 9);
      expect(mirroredSlot.radius).toBeCloseTo(2, 9);
    }
    expect(mirroredPolygon?.kind).toBe("polygon");
    if (mirroredPolygon !== undefined && mirroredPolygon.kind === "polygon") {
      expect(mirroredPolygon.cx).toBeCloseTo(-8, 9);
      expect(mirroredPolygon.sides).toBe(6);
      expect(mirroredPolygon.fit).toBe("inscribed");
    }
  });
});

// ---------------------------------------------------------------------------
// Arrays
// ---------------------------------------------------------------------------

describe("rectangularArrayCommands", () => {
  it("places countX·countY−1 translated copies in row-major order", () => {
    const p = id("skent_p");
    const sketch = sketchOf([createPointEntity(p, { x: 1, y: 1 }, {})]);
    const result = rectangularArrayCommands(sketch, {
      entityIds: [p],
      countX: 3,
      countY: 2,
      spacingX: 10,
      spacingY: 20,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(5);
    const expected: readonly (readonly [number, number])[] = [
      [11, 1],
      [21, 1],
      [1, 21],
      [11, 21],
      [21, 21],
    ];
    result.value.forEach((command, index) => {
      const cell = expected[index];
      expect(command.type).toBe("sketch.entity.create");
      if (command.type === "sketch.entity.create" && cell !== undefined) {
        expect(command.entity.kind).toBe("point");
        if (command.entity.kind === "point") {
          expect(command.entity.x).toBeCloseTo(cell[0], 9);
          expect(command.entity.y).toBeCloseTo(cell[1], 9);
        }
      }
    });
  });

  it("declines degenerate counts and zero spacings", () => {
    const p = id("skent_p");
    const sketch = sketchOf([createPointEntity(p, { x: 0, y: 0 }, {})]);
    const single = rectangularArrayCommands(sketch, {
      entityIds: [p],
      countX: 1,
      countY: 1,
      spacingX: 10,
      spacingY: 10,
    });
    expect(single.ok).toBe(false);
    if (!single.ok) {
      expect(single.error.code).toBe(
        SKETCH_ENTITY_OP_ERROR_CODES.arrayCountsInvalid,
      );
    }
    const zeroSpacing = rectangularArrayCommands(sketch, {
      entityIds: [p],
      countX: 2,
      countY: 1,
      spacingX: 0,
      spacingY: 10,
    });
    expect(zeroSpacing.ok).toBe(false);
    if (!zeroSpacing.ok) {
      expect(zeroSpacing.error.code).toBe(
        SKETCH_ENTITY_OP_ERROR_CODES.arraySpacingInvalid,
      );
    }
  });

  it("commits through the interpreter: 2×1 array of a circle yields two circles", () => {
    const c = id("skent_c");
    const sketch = sketchOf([createCircleEntity(c, { x: 0, y: 0 }, 3)]);
    const result = rectangularArrayCommands(sketch, {
      entityIds: [c],
      countX: 2,
      countY: 1,
      spacingX: 12,
      spacingY: 4,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applySketchTransaction(sketch, { commands: result.value });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const circles = applied.value.entities.filter(
      (entity) => entity.kind === "circle",
    );
    expect(circles).toHaveLength(2);
  });
});

describe("circularArrayCommands", () => {
  it("rotates copies about the center by k·step with the default full-circle step", () => {
    const p = id("skent_p");
    const sketch = sketchOf([createPointEntity(p, { x: 10, y: 0 }, {})]);
    const result = circularArrayCommands(sketch, {
      entityIds: [p],
      center: { x: 0, y: 0 },
      count: 4,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(3);
    const angles = result.value.map((command) => {
      if (command.type !== "sketch.entity.create") return Number.NaN;
      expect(command.entity.kind).toBe("point");
      return command.entity.kind === "point"
        ? Math.atan2(command.entity.y, command.entity.x)
        : Number.NaN;
    });
    expect(angles[0]).toBeCloseTo(Math.PI / 2, 9);
    expect(angles[1]).toBeCloseTo(Math.PI, 9);
    // atan2 reports (−π, π]: the third quarter appears as −π/2.
    expect(angles[2]).toBeCloseTo(-Math.PI / 2, 9);
  });

  it("honors an explicit angle step and declines bad counts", () => {
    const p = id("skent_p");
    const sketch = sketchOf([createPointEntity(p, { x: 10, y: 0 }, {})]);
    const half = circularArrayCommands(sketch, {
      entityIds: [p],
      center: { x: 0, y: 0 },
      count: 3,
      angleStepRad: Math.PI / 2,
    });
    expect(half.ok).toBe(true);
    if (half.ok) {
      // k=1 at π/2 → (0, 10); k=2 at π → (−10, 0) — every copy on the r=10
      // circle, stepped by the explicit angle, not the default 2π/3.
      const first = half.value[0];
      const second = half.value[1];
      if (
        first !== undefined &&
        first.type === "sketch.entity.create" &&
        first.entity.kind === "point"
      ) {
        expect(first.entity.x).toBeCloseTo(0, 9);
        expect(first.entity.y).toBeCloseTo(10, 9);
      }
      if (
        second !== undefined &&
        second.type === "sketch.entity.create" &&
        second.entity.kind === "point"
      ) {
        expect(second.entity.x).toBeCloseTo(-10, 9);
        expect(second.entity.y).toBeCloseTo(0, 9);
      }
    }
    const bad = circularArrayCommands(sketch, {
      entityIds: [p],
      center: { x: 0, y: 0 },
      count: 1,
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe(
        SKETCH_ENTITY_OP_ERROR_CODES.arrayCountInvalid,
      );
    }
  });

  it("rotates arcs with their angles (an arc stays itself, spun)", () => {
    const arc = id("skent_a");
    const sketch = sketchOf([
      createArcEntity(arc, { x: 20, y: 0 }, 5, 0, 1, {}),
    ]);
    const result = circularArrayCommands(sketch, {
      entityIds: [arc],
      center: { x: 0, y: 0 },
      count: 2,
      angleStepRad: Math.PI / 2,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const command = result.value[0];
    if (command !== undefined && command.type === "sketch.entity.create") {
      expect(command.entity.kind).toBe("arc");
      if (command.entity.kind === "arc") {
        expect(command.entity.cx).toBeCloseTo(0, 9);
        expect(command.entity.cy).toBeCloseTo(20, 9);
        expect(command.entity.startAngle).toBeCloseTo(Math.PI / 2, 9);
        expect(command.entity.endAngle).toBeCloseTo(1 + Math.PI / 2, 9);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Extend
// ---------------------------------------------------------------------------

describe("extendLineCommand", () => {
  it("extends the clicked end to a crossing line beyond it", () => {
    const ab = id("skent_ab");
    const wall = id("skent_wall");
    const sketch = sketchOf([
      createLineEntity(ab, { x: 0, y: 0 }, { x: 20, y: 0 }),
      // The wall lies beyond the ab START: growing the start end runs left
      // along −x (the direction away from the far end) into it.
      createLineEntity(wall, { x: -15, y: -10 }, { x: -15, y: 10 }),
    ]);
    // Click near the ab START (0,0).
    const result = extendLineCommand(sketch, ab, { x: 0.5, y: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applySketchTransaction(sketch, { commands: result.value });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const extended = lineById(applied.value, ab);
    expect(extended.x1).toBeCloseTo(-15, 9);
    expect(extended.y1).toBeCloseTo(0, 9);
    expect(extended.x2).toBeCloseTo(20, 9);
  });

  it("extends the clicked end onto a circle rim beyond it", () => {
    const ab = id("skent_ab");
    const circle = id("skent_c");
    const sketch = sketchOf([
      createLineEntity(ab, { x: 0, y: 0 }, { x: 10, y: 0 }),
      createCircleEntity(circle, { x: 30, y: 0 }, 8),
    ]);
    // Click near the ab END (10,0): grows right along +x to the rim at x=22.
    const result = extendLineCommand(sketch, ab, { x: 9.5, y: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const applied = applySketchTransaction(sketch, { commands: result.value });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const extended = lineById(applied.value, ab);
    expect(extended.x2).toBeCloseTo(22, 9);
  });

  it("declines when no boundary lies beyond the clicked end", () => {
    const ab = id("skent_ab");
    const wall = id("skent_wall");
    const sketch = sketchOf([
      createLineEntity(ab, { x: 0, y: 0 }, { x: 20, y: 0 }),
      // The wall lies BETWEEN the ends: trim's territory, not extend's.
      createLineEntity(wall, { x: 5, y: -10 }, { x: 5, y: 10 }),
    ]);
    const result = extendLineCommand(sketch, ab, { x: 19.5, y: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(
        SKETCH_ENTITY_OP_ERROR_CODES.extendNoIntersection,
      );
    }
  });

  it("refuses to extend a non-line", () => {
    const circle = id("skent_c");
    const sketch = sketchOf([createCircleEntity(circle, { x: 0, y: 0 }, 5)]);
    const result = extendLineCommand(sketch, circle, { x: 0, y: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(
        SKETCH_ENTITY_OP_ERROR_CODES.extendNeedsLine,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Id allocation
// ---------------------------------------------------------------------------

describe("createSketchOpIdAllocator", () => {
  it("mints deterministic, collision-free ids in op order", () => {
    const ab = id("skent_offset-1");
    const sketch = sketchOf([
      createLineEntity(ab, { x: 0, y: 0 }, { x: 1, y: 1 }),
    ]);
    const mint = createSketchOpIdAllocator(sketch);
    const first = mint("offset");
    const second = mint("offset");
    expect(first).toBe(createSketchEntityId("skent_offset-2"));
    expect(second).toBe(createSketchEntityId("skent_offset-3"));
  });

  it("documents the chain-contact epsilon as a small positive number", () => {
    expect(CHAIN_CONTACT_EPSILON_MM).toBeGreaterThan(0);
    expect(CHAIN_CONTACT_EPSILON_MM).toBeLessThan(1e-3);
  });

  it("documents the offset-collapse epsilon as a small positive number", () => {
    expect(OFFSET_COLLAPSE_EPSILON_MM).toBeGreaterThan(0);
    expect(OFFSET_COLLAPSE_EPSILON_MM).toBeLessThan(1e-3);
  });
});
