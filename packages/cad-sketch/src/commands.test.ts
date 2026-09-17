/**
 * Phase 25 sketch command vocabulary tests: application semantics (create /
 * update / delete with reference protection, constraint create / delete,
 * dimension edit), atomic transactions, and the wire-format round-trip and
 * replay discipline — the same pins the cad-core command suite makes, one
 * domain down.
 */

import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";

import {
  SKETCH_COMMAND_ERROR_CODES,
  applySketchCommand,
  applySketchTransaction,
  parseSketchCommand,
  serializeSketchCommand,
} from "./commands";
import {
  createDistanceConstraint,
  createEqualConstraint,
  createHorizontalConstraint,
  createLineEntity,
  createPointEntity,
  createRectangleEntity,
  pointTarget,
} from "./index";
import { createSketch } from "./sketch";
import {
  createSketchConstraintId,
  createSketchEntityId,
} from "./sketch-ids";
import { xyWorkplane } from "./workplane";
import {
  applySketchSessionTransaction,
  createSketchSession,
  redoSketchSession,
  undoSketchSession,
} from "./sketch-session";

const anchorId = createSketchEntityId("skent_anchor");
const lineId = createSketchEntityId("skent_line");
const otherId = createSketchEntityId("skent_other");
const distanceId = createSketchConstraintId("skcon_distance");
const horizontalId = createSketchConstraintId("skcon_horizontal");

function baseSketch() {
  const entities = [
    createPointEntity(anchorId, { x: 0, y: 0 }, { fixed: true, construction: true }),
    createLineEntity(lineId, { x: 0, y: 0 }, { x: 60, y: 0 }),
    createLineEntity(otherId, { x: 0, y: 40 }, { x: 60, y: 40 }),
  ];
  const constraints = [
    createHorizontalConstraint(horizontalId, lineId),
    createDistanceConstraint(
      distanceId,
      pointTarget(lineId, "start"),
      pointTarget(lineId, "end"),
      length(60),
    ),
  ];
  const sketch = createSketch(xyWorkplane(), entities, constraints);
  if (!sketch.ok) throw new Error(sketch.error.message);
  return sketch.value;
}

describe("sketch command application", () => {
  it("creates an entity and appends it in order", () => {
    const sketch = baseSketch();
    const extra = createSketchEntityId("skent_extra");
    const applied = applySketchCommand(sketch, {
      type: "sketch.entity.create",
      entity: createPointEntity(extra, { x: 5, y: 5 }),
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.value.entities.map((entity) => entity.id)).toEqual([
      anchorId,
      lineId,
      otherId,
      extra,
    ]);
    expect(sketch.entities).toHaveLength(3);
  });

  it("refuses a duplicate entity id", () => {
    const applied = applySketchCommand(baseSketch(), {
      type: "sketch.entity.create",
      entity: createPointEntity(lineId, { x: 1, y: 1 }),
    });
    expect(applied).toMatchObject({
      ok: false,
      error: { code: SKETCH_COMMAND_ERROR_CODES.entityDuplicate },
    });
  });

  it("updates an entity's parameters and refuses unknown ids", () => {
    const moved = applySketchCommand(baseSketch(), {
      type: "sketch.entity.update",
      entity: createLineEntity(lineId, { x: 0, y: 0 }, { x: 45, y: 0 }),
    });
    expect(moved.ok).toBe(true);
    if (moved.ok) {
      const line = moved.value.entities.find((entity) => entity.id === lineId);
      expect(line).toMatchObject({ kind: "line", x2: 45, y2: 0 });
    }
    const unknown = applySketchCommand(baseSketch(), {
      type: "sketch.entity.update",
      entity: createPointEntity(createSketchEntityId("skent_ghost"), { x: 0, y: 0 }),
    });
    expect(unknown).toMatchObject({
      ok: false,
      error: { code: SKETCH_COMMAND_ERROR_CODES.entityUnknown },
    });
  });

  it("refuses deleting an entity a constraint or rectangle references", () => {
    const constrained = applySketchCommand(baseSketch(), {
      type: "sketch.entity.delete",
      entityId: lineId,
    });
    expect(constrained).toMatchObject({
      ok: false,
      error: { code: SKETCH_COMMAND_ERROR_CODES.entityReferenced },
    });

    const bottomId = createSketchEntityId("skent_rect-bottom");
    const rightId = createSketchEntityId("skent_rect-right");
    const topId = createSketchEntityId("skent_rect-top");
    const leftId = createSketchEntityId("skent_rect-left");
    const rectSketch = createSketch(
      xyWorkplane(),
      [
        createLineEntity(bottomId, { x: 0, y: 0 }, { x: 60, y: 0 }),
        createLineEntity(rightId, { x: 60, y: 0 }, { x: 60, y: 40 }),
        createLineEntity(topId, { x: 60, y: 40 }, { x: 0, y: 40 }),
        createLineEntity(leftId, { x: 0, y: 40 }, { x: 0, y: 0 }),
        createRectangleEntity(createSketchEntityId("skent_rect"), [
          bottomId,
          rightId,
          topId,
          leftId,
        ]),
      ],
      [],
    );
    if (!rectSketch.ok) throw new Error(rectSketch.error.message);
    const edgeDelete = applySketchCommand(rectSketch.value, {
      type: "sketch.entity.delete",
      entityId: bottomId,
    });
    expect(edgeDelete).toMatchObject({
      ok: false,
      error: { code: SKETCH_COMMAND_ERROR_CODES.entityReferenced },
    });
  });

  it("deletes an unreferenced entity", () => {
    const applied = applySketchCommand(baseSketch(), {
      type: "sketch.entity.delete",
      entityId: otherId,
    });
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(
        applied.value.entities.some((entity) => entity.id === otherId),
      ).toBe(false);
    }
  });

  it("creates a constraint with resolvable references and refuses dangling ones", () => {
    const good = applySketchCommand(baseSketch(), {
      type: "sketch.constraint.create",
      constraint: createEqualConstraint(
        createSketchConstraintId("skcon_equal"),
        lineId,
        otherId,
      ),
    });
    expect(good.ok).toBe(true);

    const bad = applySketchCommand(baseSketch(), {
      type: "sketch.constraint.create",
      constraint: createEqualConstraint(
        createSketchConstraintId("skcon_bad"),
        lineId,
        anchorId,
      ),
    });
    expect(bad).toMatchObject({
      ok: false,
      error: { code: SKETCH_COMMAND_ERROR_CODES.integrity },
    });
  });

  it("deletes a constraint", () => {
    const applied = applySketchCommand(baseSketch(), {
      type: "sketch.constraint.delete",
      constraintId: distanceId,
    });
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.value.constraints.map((c) => c.id)).toEqual([horizontalId]);
    }
  });

  it("edits a dimensional value and refuses non-dimensional and unknown constraints", () => {
    const applied = applySketchCommand(baseSketch(), {
      type: "sketch.dimension.set",
      constraintId: distanceId,
      value: length(80),
    });
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      const distance = applied.value.constraints.find(
        (constraint) => constraint.id === distanceId,
      );
      expect(distance).toMatchObject({ kind: "distance", value: { value: 80 } });
    }

    const notDimensional = applySketchCommand(baseSketch(), {
      type: "sketch.dimension.set",
      constraintId: horizontalId,
      value: length(80),
    });
    expect(notDimensional).toMatchObject({
      ok: false,
      error: { code: SKETCH_COMMAND_ERROR_CODES.notDimensional },
    });

    const unknown = applySketchCommand(baseSketch(), {
      type: "sketch.dimension.set",
      constraintId: createSketchConstraintId("skcon_ghost"),
      value: length(80),
    });
    expect(unknown).toMatchObject({
      ok: false,
      error: { code: SKETCH_COMMAND_ERROR_CODES.constraintUnknown },
    });
  });
});

describe("sketch transactions", () => {
  it("applies an ordered batch atomically: every command lands or nothing does", () => {
    const sketch = baseSketch();
    const newLine = createSketchEntityId("skent_new-line");
    const applied = applySketchTransaction(sketch, {
      commands: [
        {
          type: "sketch.entity.create",
          entity: createLineEntity(newLine, { x: 0, y: 80 }, { x: 60, y: 80 }),
        },
        {
          type: "sketch.constraint.create",
          constraint: createHorizontalConstraint(
            createSketchConstraintId("skcon_new-horizontal"),
            newLine,
          ),
        },
      ],
    });
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.value.entities).toHaveLength(4);
      expect(applied.value.constraints).toHaveLength(3);
    }

    // The second command dangles (its entity never existed): nothing lands.
    const failed = applySketchTransaction(sketch, {
      commands: [
        {
          type: "sketch.entity.create",
          entity: createPointEntity(createSketchEntityId("skent_tmp"), { x: 9, y: 9 }),
        },
        {
          type: "sketch.constraint.create",
          constraint: createHorizontalConstraint(
            createSketchConstraintId("skcon_tmp"),
            createSketchEntityId("skent_missing"),
          ),
        },
      ],
    });
    expect(failed.ok).toBe(false);
  });
});

describe("sketch command wire format", () => {
  it("round-trips: serialize → parse yields a command that serializes identically", () => {
    const commands = [
      {
        type: "sketch.entity.create",
        entity: createPointEntity(anchorId, { x: 0, y: 0 }),
      },
      {
        type: "sketch.entity.update",
        entity: createLineEntity(lineId, { x: 1, y: 2 }, { x: 3, y: 4 }),
      },
      { type: "sketch.entity.delete", entityId: otherId },
      {
        type: "sketch.constraint.create",
        constraint: createHorizontalConstraint(horizontalId, lineId),
      },
      { type: "sketch.constraint.delete", constraintId: distanceId },
      {
        type: "sketch.dimension.set",
        constraintId: distanceId,
        value: length(42),
      },
    ] as const;
    for (const command of commands) {
      const serialized = serializeSketchCommand(command);
      const parsed = parseSketchCommand(serialized);
      expect(parsed.ok, JSON.stringify(serialized)).toBe(true);
      if (!parsed.ok) continue;
      expect(serializeSketchCommand(parsed.value)).toEqual(serialized);
    }
  });

  it("rejects unknown types, wrong versions, and malformed payloads", () => {
    const wrongType = parseSketchCommand({
      formatVersion: 1,
      type: "feature.create",
    });
    expect(wrongType).toMatchObject({
      ok: false,
      error: { code: SKETCH_COMMAND_ERROR_CODES.typeUnknown },
    });
    const wrongVersion = parseSketchCommand({
      formatVersion: 99,
      type: "sketch.entity.delete",
      entityId: "skent_line",
    });
    expect(wrongVersion).toMatchObject({
      ok: false,
      error: { code: SKETCH_COMMAND_ERROR_CODES.versionUnsupported },
    });
    const malformed = parseSketchCommand({
      formatVersion: 1,
      type: "sketch.dimension.set",
      constraintId: "skcon_distance",
      value: { dimension: "length", unit: "mm", value: -5 },
    });
    expect(malformed).toMatchObject({
      ok: false,
      error: { code: SKETCH_COMMAND_ERROR_CODES.integrity },
    });
  });

  it("replays a serialized log onto the base sketch and lands on the same state", () => {
    const base = createSketch(xyWorkplane(), [], []);
    if (!base.ok) throw new Error(base.error.message);
    const log = [
      {
        type: "sketch.entity.create",
        entity: createLineEntity(lineId, { x: 0, y: 0 }, { x: 60, y: 0 }),
      },
      {
        type: "sketch.entity.create",
        entity: createLineEntity(otherId, { x: 0, y: 40 }, { x: 60, y: 40 }),
      },
      {
        type: "sketch.constraint.create",
        constraint: createDistanceConstraint(
          distanceId,
          pointTarget(lineId, "start"),
          pointTarget(lineId, "end"),
          length(60),
        ),
      },
      {
        type: "sketch.dimension.set",
        constraintId: distanceId,
        value: length(75),
      },
    ] as const;

    // Direct application…
    let direct = base.value;
    for (const command of log) {
      const applied = applySketchCommand(direct, command);
      if (!applied.ok) throw new Error(applied.error.message);
      direct = applied.value;
    }
    // …versus replay through the parsed wire forms: serialization-identical.
    let replayed = base.value;
    for (const command of log) {
      const parsed = parseSketchCommand(serializeSketchCommand(command));
      if (!parsed.ok) throw new Error(parsed.error.message);
      const applied = applySketchCommand(replayed, parsed.value);
      if (!applied.ok) throw new Error(applied.error.message);
      replayed = applied.value;
    }
    expect(JSON.stringify(direct)).toBe(JSON.stringify(replayed));
  });
});

describe("sketch session undo/redo", () => {
  it("commits atomically, truncates the redo branch, and restores exact snapshots", () => {
    const session = createSketchSession(baseSketch());
    expect(undoSketchSession(session).ok).toBe(false);

    const shrink = applySketchSessionTransaction(session, {
      commands: [
        {
          type: "sketch.dimension.set",
          constraintId: distanceId,
          value: length(40),
        },
      ],
    });
    expect(shrink.ok).toBe(true);
    if (!shrink.ok) return;

    const grow = applySketchSessionTransaction(shrink.value, {
      commands: [
        {
          type: "sketch.dimension.set",
          constraintId: distanceId,
          value: length(90),
        },
      ],
    });
    expect(grow.ok).toBe(true);
    if (!grow.ok) return;
    expect(grow.value.sketch).not.toBe(session.sketch);

    // Undo restores the exact intermediate snapshot…
    const undone = undoSketchSession(grow.value);
    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.value.session.sketch).toBe(shrink.value.sketch);
    // …and again reaches the base (by reference).
    const undoneTwice = undoSketchSession(undone.value.session);
    expect(undoneTwice.ok).toBe(true);
    if (!undoneTwice.ok) return;
    expect(undoneTwice.value.session.sketch).toBe(session.sketch);
    expect(undoSketchSession(undoneTwice.value.session).ok).toBe(false);

    // Redo walks forward again.
    const redone = redoSketchSession(undoneTwice.value.session);
    expect(redone.ok).toBe(true);
    if (!redone.ok) return;
    expect(redone.value.session.sketch).toBe(shrink.value.sketch);

    // A new commit truncates the redo branch.
    const committed = applySketchSessionTransaction(redone.value.session, {
      commands: [
        {
          type: "sketch.constraint.delete",
          constraintId: horizontalId,
        },
      ],
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) return;
    expect(redoSketchSession(committed.value).ok).toBe(false);
  });
});
