/**
 * The sketch editor reducer's unit tests (Phase 25): the pure pick flows —
 * line/circle/rectangle gestures producing entity.create transactions,
 * constraint tools committing at arity with kind-checked picks (incompatible
 * picks refused BEFORE they accumulate), trim's endpoint move to the nearest
 * intersection, construction toggling, and the delete composition
 * (referencing constraints first, then the entity).
 */

import { describe, expect, it } from "vitest";
import {
  applySketchTransaction,
  createCircleEntity,
  createHorizontalConstraint,
  createLineEntity,
  createParallelConstraint,
  createPointEntity,
  createRectangleEntity,
  createPolygonEntity,
  createSketch,
  createSketchConstraintId,
  createSketchEntityId,
  createSplineEntity,
  createStraightSlotEntity,
  xyWorkplane,
  type Sketch,
} from "@slopcad/cad-sketch";

import {
  createSketchEditorState,
  createWorkbenchSketch,
  deleteEntityCommands,
  sketchEditorReducer,
  sketchViewModel,
  SKETCH_EDITOR_STATUS_TEXT,
} from "./sketch-editor";

function sketchWithLines(): Sketch {
  const a = createSketchEntityId("skent_a");
  const b = createSketchEntityId("skent_b");
  const created = createSketch(
    xyWorkplane(),
    [
      createLineEntity(a, { x: 0, y: 0 }, { x: 60, y: 0 }),
      createLineEntity(b, { x: 30, y: -20 }, { x: 30, y: 40 }),
    ],
    [],
  );
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe("sketch editor drawing gestures", () => {
  it("draws a line in two picks as one entity.create transaction", () => {
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "line", type: "activate-tool" },
      sketchWithLines(),
    ).state;
    const first = sketchEditorReducer(
      state,
      { point: { x: 10, y: 10 }, entityId: null, type: "canvas-pick" },
      sketchWithLines(),
    );
    expect(first.transaction).toBeNull();
    expect(first.state.gesture).toMatchObject({ kind: "line" });
    const second = sketchEditorReducer(
      first.state,
      { point: { x: 70, y: 10 }, entityId: null, type: "canvas-pick" },
      sketchWithLines(),
    );
    expect(second.transaction).not.toBeNull();
    expect(second.transaction?.commands).toHaveLength(1);
    expect(second.transaction?.commands[0]).toMatchObject({
      type: "sketch.entity.create",
    });
    expect(second.state.gesture.kind).toBe("none");
    // The gesture preview state never leaked into the created geometry.
    const command = second.transaction?.commands[0];
    expect(command).toHaveProperty("entity");
  });

  it("refuses zero-length lines and lets Escape cancel a gesture", () => {
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "line", type: "activate-tool" },
      sketchWithLines(),
    ).state;
    state = sketchEditorReducer(
      state,
      { point: { x: 10, y: 10 }, entityId: null, type: "canvas-pick" },
      sketchWithLines(),
    ).state;
    const degenerate = sketchEditorReducer(
      state,
      { point: { x: 10, y: 10 }, entityId: null, type: "canvas-pick" },
      sketchWithLines(),
    );
    expect(degenerate.transaction).toBeNull();
    expect(degenerate.state.status.code).toBe("sketch/degenerate");
    const cancelled = sketchEditorReducer(
      degenerate.state,
      { type: "escape" },
      sketchWithLines(),
    );
    expect(cancelled.state.gesture.kind).toBe("none");
  });

  it("creates a rectangle as five entities in one atomic transaction", () => {
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "rectangle", type: "activate-tool" },
      createWorkbenchSketch(),
    ).state;
    state = sketchEditorReducer(
      state,
      { point: { x: 0, y: 0 }, entityId: null, type: "canvas-pick" },
      createWorkbenchSketch(),
    ).state;
    const done = sketchEditorReducer(
      state,
      { point: { x: 60, y: 40 }, entityId: null, type: "canvas-pick" },
      createWorkbenchSketch(),
    );
    expect(done.transaction?.commands).toHaveLength(5);
    const kinds = done.transaction?.commands.map((command) =>
      command.type === "sketch.entity.create" ? command.entity.kind : "?",
    );
    expect(kinds).toEqual(["line", "line", "line", "line", "rectangle"]);
    // The rectangle selects itself on commit.
    expect(done.state.selectedEntityIds).toHaveLength(1);
  });
});

describe("sketch editor constraint tools", () => {
  it("applies a horizontal constraint after one line pick", () => {
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "horizontal", type: "activate-tool" },
      sketchWithLines(),
    ).state;
    const applied = sketchEditorReducer(
      state,
      { point: { x: 30, y: 0 }, entityId: "skent_a", type: "canvas-pick" },
      sketchWithLines(),
    );
    expect(applied.transaction?.commands).toEqual([
      expect.objectContaining({ type: "sketch.constraint.create" }),
    ]);
    expect(applied.state.picks).toHaveLength(0);
    expect(applied.state.selectedConstraintId).not.toBeNull();
  });

  it("refuses a radius pick on a line before it accumulates", () => {
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "radius", type: "activate-tool" },
      sketchWithLines(),
    ).state;
    const refused = sketchEditorReducer(
      state,
      { point: { x: 30, y: 0 }, entityId: "skent_a", type: "canvas-pick" },
      sketchWithLines(),
    );
    expect(refused.transaction).toBeNull();
    expect(refused.state.picks).toHaveLength(0);
    expect(refused.state.status.severity).toBe("error");
    expect(refused.state.status.code).toBe("sketch/incompatible-pick");
  });

  it("refuses radius on a line and applies it on a circle", () => {
    const circle = createSketchEntityId("skent_circle");
    const sketch = createSketch(
      xyWorkplane(),
      [
        createLineEntity(
          createSketchEntityId("skent_a"),
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ),
        createCircleEntity(circle, { x: 30, y: 30 }, 12),
      ],
      [],
    );
    if (!sketch.ok) throw new Error(sketch.error.message);
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "radius", type: "activate-tool" },
      sketch.value,
    ).state;
    const refused = sketchEditorReducer(
      state,
      { point: { x: 5, y: 0 }, entityId: "skent_a", type: "canvas-pick" },
      sketch.value,
    );
    expect(refused.transaction).toBeNull();
    expect(refused.state.status.severity).toBe("error");
    const applied = sketchEditorReducer(
      refused.state,
      { point: { x: 42, y: 30 }, entityId: circle, type: "canvas-pick" },
      sketch.value,
    );
    expect(applied.transaction?.commands[0]).toMatchObject({
      type: "sketch.constraint.create",
    });
    if (applied.transaction?.commands[0]?.type === "sketch.constraint.create") {
      expect(applied.transaction.commands[0].constraint).toMatchObject({
        kind: "radius",
        value: { value: 12 },
      });
    }
  });

  it("measures a distance dimension from current geometry at commit", () => {
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "distance", type: "activate-tool" },
      sketchWithLines(),
    ).state;
    state = sketchEditorReducer(
      state,
      { point: { x: 0, y: 0 }, entityId: "skent_a", type: "canvas-pick" },
      sketchWithLines(),
    ).state;
    const applied = sketchEditorReducer(
      state,
      { point: { x: 60, y: 0 }, entityId: "skent_a", type: "canvas-pick" },
      sketchWithLines(),
    );
    const command = applied.transaction?.commands[0];
    if (command?.type !== "sketch.constraint.create") {
      throw new Error("expected a constraint.create command");
    }
    expect(command.constraint).toMatchObject({
      first: { entity: "skent_a", point: "start" },
      second: { entity: "skent_a", point: "end" },
      value: { value: 60 },
    });
  });
});

describe("sketch editor trim, construction, delete", () => {
  it("trims a line's clicked end to the nearest intersection", () => {
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "trim", type: "activate-tool" },
      sketchWithLines(),
    ).state;
    // Click skent_b near its bottom end (30, -20); it crosses skent_a at
    // (30, 0). The bottom end moves to the intersection.
    const trimmed = sketchEditorReducer(
      state,
      { point: { x: 30, y: -19 }, entityId: "skent_b", type: "canvas-pick" },
      sketchWithLines(),
    );
    const command = trimmed.transaction?.commands[0];
    if (command?.type !== "sketch.entity.update") {
      throw new Error("expected an entity.update command");
    }
    expect(command.entity).toMatchObject({
      kind: "line",
      x1: 30,
      y1: 0,
      x2: 30,
      y2: 40,
    });
  });

  it("refuses trim when the clicked end already sits exactly on the intersection", () => {
    const a = createSketchEntityId("skent_a");
    const b = createSketchEntityId("skent_b");
    const sketch = createSketch(
      xyWorkplane(),
      [
        createLineEntity(a, { x: 0, y: 0 }, { x: 60, y: 0 }),
        // skent_b's bottom end already lies exactly on skent_a.
        createLineEntity(b, { x: 30, y: 0 }, { x: 30, y: 40 }),
      ],
      [],
    );
    if (!sketch.ok) throw new Error(sketch.error.message);
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "trim", type: "activate-tool" },
      sketch.value,
    ).state;
    // Click skent_b near its bottom end: the nearest intersection is that
    // endpoint itself, so the trim must refuse, not commit a zero move.
    const refused = sketchEditorReducer(
      state,
      { point: { x: 30, y: 1 }, entityId: b, type: "canvas-pick" },
      sketch.value,
    );
    expect(refused.transaction).toBeNull();
    expect(refused.state.status.severity).toBe("error");
    expect(refused.state.status.code).toBe("sketch/no-intersection");
  });

  it("refuses trim when the nearest intersection sits exactly on the far endpoint", () => {
    const a = createSketchEntityId("skent_a");
    const b = createSketchEntityId("skent_b");
    const sketch = createSketch(
      xyWorkplane(),
      [
        createLineEntity(a, { x: 0, y: 0 }, { x: 30, y: 0 }),
        // skent_b crosses skent_a exactly at skent_a's far endpoint (30, 0).
        createLineEntity(b, { x: 30, y: -10 }, { x: 30, y: 10 }),
      ],
      [],
    );
    if (!sketch.ok) throw new Error(sketch.error.message);
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "trim", type: "activate-tool" },
      sketch.value,
    ).state;
    // Click skent_a near its left end: the nearest intersection IS the far
    // endpoint itself, so the trim must refuse, not commit a zero-length
    // replacement line.
    const refused = sketchEditorReducer(
      state,
      { point: { x: 1, y: 0 }, entityId: a, type: "canvas-pick" },
      sketch.value,
    );
    expect(refused.transaction).toBeNull();
    expect(refused.state.status.severity).toBe("error");
    expect(refused.state.status.code).toBe("sketch/no-intersection");
  });

  it("toggles construction geometry via entity.update", () => {
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "construction", type: "activate-tool" },
      sketchWithLines(),
    ).state;
    const toggled = sketchEditorReducer(
      state,
      { point: { x: 30, y: 0 }, entityId: "skent_a", type: "canvas-pick" },
      sketchWithLines(),
    );
    const command = toggled.transaction?.commands[0];
    if (command?.type !== "sketch.entity.update") {
      throw new Error("expected an entity.update command");
    }
    expect(command.entity.construction).toBe(true);
  });

  it("composes delete: referencing constraints first, then the entity", () => {
    const a = createSketchEntityId("skent_a");
    const constraintId = createSketchConstraintId("skcon_h");
    const sketch = createSketch(
      xyWorkplane(),
      [
        createPointEntity(createSketchEntityId("skent_p"), { x: 0, y: 0 }),
        createLineEntity(a, { x: 0, y: 0 }, { x: 60, y: 0 }),
      ],
      [createHorizontalConstraint(constraintId, a)],
    );
    if (!sketch.ok) throw new Error(sketch.error.message);
    const result = deleteEntityCommands(sketch.value, a);
    if (!("commands" in result)) throw new Error("expected commands");
    expect(result.commands).toHaveLength(2);
    expect(result.commands[0]).toMatchObject({
      type: "sketch.constraint.delete",
    });
    expect(result.commands[1]).toMatchObject({ type: "sketch.entity.delete" });
  });

  it("clears the constraint selection on delete so a repeated Delete emits nothing", () => {
    const a = createSketchEntityId("skent_a");
    const constraintId = createSketchConstraintId("skcon_h");
    const sketch = createSketch(
      xyWorkplane(),
      [createLineEntity(a, { x: 0, y: 0 }, { x: 60, y: 0 })],
      [createHorizontalConstraint(constraintId, a)],
    );
    if (!sketch.ok) throw new Error(sketch.error.message);
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { constraintId, type: "select-constraint" },
      sketch.value,
    ).state;
    const first = sketchEditorReducer(
      state,
      { type: "delete-selection" },
      sketch.value,
    );
    // The selection is cleared alongside the emitted delete (mirroring the
    // entity branch), so the id cannot dangle after the host applies it.
    expect(first.state.selectedConstraintId).toBeNull();
    expect(first.transaction?.commands).toEqual([
      { constraintId, type: "sketch.constraint.delete" },
    ]);
    if (first.transaction === null) throw new Error("expected a transaction");
    const applied = applySketchTransaction(sketch.value, first.transaction);
    if (!applied.ok) throw new Error(applied.error.message);
    const second = sketchEditorReducer(
      first.state,
      { type: "delete-selection" },
      applied.value,
    );
    // The repeated Delete finds nothing selected: no transaction is emitted
    // (nothing for the host to fail with sketch-command/constraint-unknown)
    // and the status carries no error code — the designed nothing-selected
    // branch, not a failure surfacing.
    expect(second.transaction).toBeNull();
    expect(second.state.status.code).toBeNull();
    expect(second.state.status.message).toBe(
      SKETCH_EDITOR_STATUS_TEXT.noSelection,
    );
  });

  it("deletes a shared constraint once when both of its entities are selected", () => {
    const a = createSketchEntityId("skent_a");
    const b = createSketchEntityId("skent_b");
    const constraintId = createSketchConstraintId("skcon_p");
    const sketch = createSketch(
      xyWorkplane(),
      [
        createLineEntity(a, { x: 0, y: 0 }, { x: 30, y: 0 }),
        createLineEntity(b, { x: 0, y: 10 }, { x: 30, y: 10 }),
      ],
      [createParallelConstraint(constraintId, a, b)],
    );
    if (!sketch.ok) throw new Error(sketch.error.message);
    // A multi-entity selection is the plural field's designed domain (reducer
    // consumers build it); both selected lines share the parallel constraint.
    const state = {
      ...createSketchEditorState(),
      selectedEntityIds: [a, b],
    };
    const transition = sketchEditorReducer(
      state,
      { type: "delete-selection" },
      sketch.value,
    );
    const transaction = transition.transaction;
    if (transaction === null) throw new Error("expected a transaction");
    // One constraint delete for the shared constraint, then both entity
    // deletes — a duplicated constraint delete would fail the batch
    // atomically (constraint-unknown on the second occurrence).
    expect(transaction.commands).toEqual([
      { constraintId, type: "sketch.constraint.delete" },
      { entityId: a, type: "sketch.entity.delete" },
      { entityId: b, type: "sketch.entity.delete" },
    ]);
    const applied = applySketchTransaction(sketch.value, transaction);
    if (!applied.ok) throw new Error(applied.error.message);
    expect(applied.value.entities).toHaveLength(0);
    expect(applied.value.constraints).toHaveLength(0);
    expect(transition.state.selectedEntityIds).toEqual([]);
  });

  it("refuses deleting a rectangle edge", () => {
    const bottom = createSketchEntityId("skent_bottom");
    const right = createSketchEntityId("skent_right");
    const top = createSketchEntityId("skent_top");
    const left = createSketchEntityId("skent_left");
    const sketch = createSketch(
      xyWorkplane(),
      [
        createLineEntity(bottom, { x: 0, y: 0 }, { x: 60, y: 0 }),
        createLineEntity(right, { x: 60, y: 0 }, { x: 60, y: 40 }),
        createLineEntity(top, { x: 60, y: 40 }, { x: 0, y: 40 }),
        createLineEntity(left, { x: 0, y: 40 }, { x: 0, y: 0 }),
        createRectangleEntity(createSketchEntityId("skent_rect"), [
          bottom,
          right,
          top,
          left,
        ]),
      ],
      [],
    );
    if (!sketch.ok) throw new Error(sketch.error.message);
    const result = deleteEntityCommands(sketch.value, bottom);
    expect(result).toMatchObject({
      problem: SKETCH_EDITOR_STATUS_TEXT.rectangleEdge,
    });
  });
});

describe("sketch view model", () => {
  it("styles entities by selection, construction, and diagnostics", () => {
    const sketch = sketchWithLines();
    const view = sketchViewModel(sketch, null, { entityIds: ["skent_a"] }, [
      {
        code: "sketch/constraints-conflicting",
        location: { primary: createSketchEntityId("skent_b") },
        message: "conflict",
        severity: "error",
      },
    ]);
    const a = view.entities.find((entity) => entity.id === "skent_a");
    const b = view.entities.find((entity) => entity.id === "skent_b");
    expect(a).toMatchObject({ selected: true, diagnostic: "none" });
    expect(b).toMatchObject({ diagnostic: "error" });
  });

  it("emits dimension annotations for dimensional constraints", () => {
    const a = createSketchEntityId("skent_a");
    const constraintId = createSketchConstraintId("skcon_d");
    const sketch = createSketch(
      xyWorkplane(),
      [createLineEntity(a, { x: 0, y: 0 }, { x: 60, y: 0 })],
      [],
    );
    if (!sketch.ok) throw new Error(sketch.error.message);
    const view = sketchViewModel(
      {
        workplane: sketch.value.workplane,
        entities: sketch.value.entities,
        constraints: [
          {
            first: { entity: a, point: "start" },
            id: constraintId,
            kind: "distance",
            second: { entity: a, point: "end" },
            value: { dimension: "length", unit: "mm", value: 60 },
          },
        ],
      },
      null,
      { entityIds: [] },
      [],
    );
    expect(view.annotations).toHaveLength(1);
    // The label rides the dimension PRESENTATION's text anchor (Phase 37):
    // the aligned dimension line offsets 8 mm along the left normal (+y of
    // the 0→60 x-run), so the text sits at its midpoint — (30, 8).
    expect(view.annotations[0]).toMatchObject({
      kind: "dimension",
      text: "60 mm",
      x: 30,
      y: 8,
    });
  });
});

describe("sketch editor phase 36 gestures and constraints", () => {
  it("draws an ellipse in three picks (center, axis end, minor extent)", () => {
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "ellipse", type: "activate-tool" },
      sketchWithLines(),
    ).state;
    const center = sketchEditorReducer(
      state,
      { point: { x: 0, y: 0 }, entityId: null, type: "canvas-pick" },
      sketchWithLines(),
    );
    expect(center.state.gesture).toMatchObject({
      kind: "pick",
      tool: "ellipse",
    });
    const axis = sketchEditorReducer(
      center.state,
      { point: { x: 8, y: 0 }, entityId: null, type: "canvas-pick" },
      sketchWithLines(),
    );
    expect(axis.state.gesture).toMatchObject({ kind: "ellipse" });
    const minor = sketchEditorReducer(
      axis.state,
      { point: { x: 0, y: 5 }, entityId: null, type: "canvas-pick" },
      sketchWithLines(),
    );
    expect(minor.transaction).not.toBeNull();
    expect(minor.transaction?.commands[0]).toMatchObject({
      type: "sketch.entity.create",
      entity: {
        kind: "ellipse",
        radiusX: 8,
        radiusY: 5,
        rotation: 0,
      },
    });
  });

  it("draws a straight slot in three picks (two cap centers, radius)", () => {
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "slot", type: "activate-tool" },
      sketchWithLines(),
    ).state;
    const start = sketchEditorReducer(
      state,
      { point: { x: -10, y: 0 }, entityId: null, type: "canvas-pick" },
      sketchWithLines(),
    );
    const end = sketchEditorReducer(
      start.state,
      { point: { x: 10, y: 0 }, entityId: null, type: "canvas-pick" },
      sketchWithLines(),
    );
    expect(end.state.gesture).toMatchObject({ kind: "slot" });
    const radius = sketchEditorReducer(
      end.state,
      { point: { x: 0, y: 3 }, entityId: null, type: "canvas-pick" },
      sketchWithLines(),
    );
    expect(radius.transaction?.commands[0]).toMatchObject({
      type: "sketch.entity.create",
      entity: {
        kind: "slot",
        variant: "straight",
        radius: 3,
      },
    });
  });

  it("commits collinear, pair alignments, and signed axis dimensions at arity", () => {
    const sketch = sketchWithLines();
    const commit = (
      tool: string,
      picks: readonly { x: number; y: number; entityId: string }[],
    ): { transaction: unknown } => {
      let state = createSketchEditorState();
      state = sketchEditorReducer(
        state,
        { tool: tool as never, type: "activate-tool" },
        sketch,
      ).state;
      let last = { transaction: null } as unknown as {
        transaction: unknown;
        state: ReturnType<typeof createSketchEditorState>;
      };
      for (const pick of picks) {
        last = sketchEditorReducer(
          state,
          { point: pick, entityId: pick.entityId, type: "canvas-pick" },
          sketch,
        );
        state = last.state;
      }
      return last;
    };
    const collinear = commit("collinear", [
      { x: 10, y: 0, entityId: "skent_a" },
      { x: 30, y: 10, entityId: "skent_b" },
    ]);
    expect(collinear.transaction).toMatchObject({
      commands: [
        {
          type: "sketch.constraint.create",
          constraint: { kind: "collinear" },
        },
      ],
    });
    const horizontalPair = commit("horizontalPair", [
      { x: 0, y: 0, entityId: "skent_a" },
      { x: 30, y: 10, entityId: "skent_b" },
    ]);
    expect(horizontalPair.transaction).toMatchObject({
      commands: [{ constraint: { kind: "horizontalPair" } }],
    });
    // distanceX measures the SIGNED x separation (b.start − a.start = 30).
    const distanceX = commit("distanceX", [
      { x: 0, y: 0, entityId: "skent_a" },
      { x: 30, y: -20, entityId: "skent_b" },
    ]);
    expect(distanceX.transaction).toMatchObject({
      commands: [
        {
          type: "sketch.constraint.create",
          constraint: { kind: "distanceX" },
        },
      ],
    });
    const command = (
      distanceX.transaction as {
        commands: { constraint: { value: { value: number } } }[];
      }
    ).commands[0];
    expect(command?.constraint.value.value).toBe(30);
  });

  it("applies pointOnEntity from a point pick and a curve pick in either order", () => {
    const point = createSketchEntityId("skent_p");
    const circle = createSketchEntityId("skent_c");
    const created = createSketch(
      xyWorkplane(),
      [
        createPointEntity(point, { x: 3, y: 4 }),
        createCircleEntity(circle, { x: 0, y: 0 }, 5),
      ],
      [],
    );
    if (!created.ok) throw new Error(created.error.message);
    const sketch = created.value;
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "pointOnEntity", type: "activate-tool" },
      sketch,
    ).state;
    state = sketchEditorReducer(
      state,
      { point: { x: 3, y: 4 }, entityId: "skent_p", type: "canvas-pick" },
      sketch,
    ).state;
    const commit = sketchEditorReducer(
      state,
      { point: { x: 0, y: 5 }, entityId: "skent_c", type: "canvas-pick" },
      sketch,
    );
    expect(commit.transaction).toMatchObject({
      commands: [
        {
          type: "sketch.constraint.create",
          constraint: {
            kind: "pointOnEntity",
            entity: "skent_c",
          },
        },
      ],
    });
  });

  it("refuses a pointOnEntity curve pick that is not a curve", () => {
    const sketch = sketchWithLines();
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "pointOnEntity", type: "activate-tool" },
      sketch,
    ).state;
    // First pick on a line (a valid curve) — fine.
    state = sketchEditorReducer(
      state,
      { point: { x: 10, y: 0 }, entityId: "skent_a", type: "canvas-pick" },
      sketch,
    ).state;
    // A rectangle record is not a curve — refused before accumulating.
    const edges = [
      createSketchEntityId("skent_e0"),
      createSketchEntityId("skent_e1"),
      createSketchEntityId("skent_e2"),
      createSketchEntityId("skent_e3"),
    ];
    const rectId = createSketchEntityId("skent_rect");
    const withRect = createSketch(
      xyWorkplane(),
      [
        ...sketch.entities,
        createLineEntity(edges[0]!, { x: 0, y: 0 }, { x: 1, y: 0 }),
        createLineEntity(edges[1]!, { x: 1, y: 0 }, { x: 1, y: 1 }),
        createLineEntity(edges[2]!, { x: 1, y: 1 }, { x: 0, y: 1 }),
        createLineEntity(edges[3]!, { x: 0, y: 1 }, { x: 0, y: 0 }),
        createRectangleEntity(rectId, [
          edges[0]!,
          edges[1]!,
          edges[2]!,
          edges[3]!,
        ]),
      ],
      [],
    );
    if (!withRect.ok) throw new Error(withRect.error.message);
    const refused = sketchEditorReducer(
      state,
      {
        point: { x: 0.5, y: 0.5 },
        entityId: "skent_rect",
        type: "canvas-pick",
      },
      withRect.value,
    );
    expect(refused.transaction).toBeNull();
    expect(refused.state.status.severity).toBe("error");
  });

  it("maps polyline entities into the canvas view model", () => {
    const splineId = createSketchEntityId("skent_s");
    const created = createSketch(
      xyWorkplane(),
      [
        createSplineEntity(splineId, "control", [
          { x: 0, y: 0 },
          { x: 2, y: 8 },
          { x: 6, y: 8 },
          { x: 10, y: 0 },
        ]),
      ],
      [],
    );
    if (!created.ok) throw new Error(created.error.message);
    const model = sketchViewModel(created.value, null, { entityIds: [] }, []);
    expect(model.entities).toHaveLength(1);
    expect(model.entities[0]).toMatchObject({
      id: "skent_s",
      kind: "polyline",
    });
    const points = (
      model.entities[0] as { points: readonly { x: number; y: number }[] }
    ).points;
    expect(points.length).toBeGreaterThan(5);
    expect(points[0]).toEqual({ x: 0, y: 0 });
    expect(points[points.length - 1]).toEqual({ x: 10, y: 0 });
  });
});

describe("sketch editor phase 37 gestures and constraints", () => {
  /** A sketch with a control spline, a line, a polygon, and a straight slot. */
  function sketchWithPhase37Entities(): Sketch {
    const spline = createSketchEntityId("skent_spline");
    const line = createSketchEntityId("skent_line");
    const polygon = createSketchEntityId("skent_polygon");
    const slot = createSketchEntityId("skent_slot");
    const created = createSketch(
      xyWorkplane(),
      [
        createSplineEntity(spline, "control", [
          { x: 0, y: 0 },
          { x: 1, y: 2 },
          { x: 3, y: 2 },
          { x: 4, y: 0 },
        ]),
        createLineEntity(line, { x: 8, y: 0 }, { x: 8, y: 6 }),
        createPolygonEntity(polygon, { x: 20, y: 0 }, 6, 5, 0, "inscribed"),
        createStraightSlotEntity(
          slot,
          { x: -20, y: -10 },
          { x: -10, y: -10 },
          2,
        ),
      ],
      [],
    );
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  }

  /** Activates `tool`, replays `picks`, returns the final transition. */
  function commitPicks(
    sketch: Sketch,
    tool: string,
    picks: readonly { x: number; y: number; entityId: string }[],
  ): ReturnType<typeof sketchEditorReducer> {
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: tool as never, type: "activate-tool" },
      sketch,
    ).state;
    let last = { transaction: null } as ReturnType<typeof sketchEditorReducer>;
    for (const pick of picks) {
      last = sketchEditorReducer(
        state,
        {
          point: { x: pick.x, y: pick.y },
          entityId: pick.entityId,
          type: "canvas-pick",
        },
        sketch,
      );
      state = last.state;
    }
    return last;
  }

  it("draws a control spline in four picks as one entity.create", () => {
    const sketch = createWorkbenchSketch();
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "spline", type: "activate-tool" },
      sketch,
    ).state;
    const points = [
      { x: -10, y: -5 },
      { x: -7, y: 3 },
      { x: -1, y: 3 },
      { x: 2, y: -5 },
    ];
    let last = { transaction: null } as ReturnType<typeof sketchEditorReducer>;
    for (const point of points) {
      last = sketchEditorReducer(
        state,
        { point, entityId: null, type: "canvas-pick" },
        sketch,
      );
      state = last.state;
    }
    expect(last.transaction).toMatchObject({
      commands: [
        {
          type: "sketch.entity.create",
          entity: {
            kind: "spline",
            flavor: "control",
            points: points.map((point) => ({ x: point.x, y: point.y })),
          },
        },
      ],
    });
  });

  it("refuses a spline whose first and last control points coincide", () => {
    const sketch = createWorkbenchSketch();
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "spline", type: "activate-tool" },
      sketch,
    ).state;
    const points = [
      { x: 0, y: 0 },
      { x: 1, y: 2 },
      { x: 3, y: 2 },
      { x: 0, y: 0 },
    ];
    for (const point of points.slice(0, 3)) {
      state = sketchEditorReducer(
        state,
        { point, entityId: null, type: "canvas-pick" },
        sketch,
      ).state;
    }
    const degenerate = sketchEditorReducer(
      state,
      {
        point: points[3] as { x: number; y: number },
        entityId: null,
        type: "canvas-pick",
      },
      sketch,
    );
    expect(degenerate.transaction).toBeNull();
    expect(degenerate.state.status.severity).toBe("error");
  });

  it("draws a polygon in two picks (center then vertex)", () => {
    const sketch = createWorkbenchSketch();
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "polygon", type: "activate-tool" },
      sketch,
    ).state;
    state = sketchEditorReducer(
      state,
      { point: { x: 10, y: 5 }, entityId: null, type: "canvas-pick" },
      sketch,
    ).state;
    const commit = sketchEditorReducer(
      state,
      { point: { x: 16, y: 5 }, entityId: null, type: "canvas-pick" },
      sketch,
    );
    expect(commit.transaction).toMatchObject({
      commands: [
        {
          type: "sketch.entity.create",
          entity: {
            kind: "polygon",
            sides: 6,
            fit: "inscribed",
            cx: 10,
            cy: 5,
            radius: 6,
            rotation: 0,
          },
        },
      ],
    });
  });

  it("commits tangent between a line and a spline (anywhere tangency)", () => {
    const commit = commitPicks(sketchWithPhase37Entities(), "tangent", [
      { x: 8, y: 3, entityId: "skent_line" },
      { x: 2, y: 1.5, entityId: "skent_spline" },
    ]);
    expect(commit.transaction).toMatchObject({
      commands: [
        {
          type: "sketch.constraint.create",
          constraint: {
            kind: "tangent",
            first: "skent_line",
            second: "skent_spline",
          },
        },
      ],
    });
  });

  it("commits tangent between two splines (a G1 joint)", () => {
    const a = createSketchEntityId("skent_a");
    const b = createSketchEntityId("skent_b");
    const created = createSketch(
      xyWorkplane(),
      [
        createSplineEntity(a, "control", [
          { x: 0, y: 0 },
          { x: 1, y: 2 },
          { x: 3, y: 2 },
          { x: 4, y: 0 },
        ]),
        createSplineEntity(b, "control", [
          { x: 4, y: 0 },
          { x: 5, y: -2 },
          { x: 7, y: -2 },
          { x: 8, y: 0 },
        ]),
      ],
      [],
    );
    if (!created.ok) throw new Error(created.error.message);
    const commit = commitPicks(created.value, "tangent", [
      { x: 2, y: 1, entityId: "skent_a" },
      { x: 6, y: -1, entityId: "skent_b" },
    ]);
    expect(commit.transaction).toMatchObject({
      commands: [
        {
          constraint: { kind: "tangent", first: "skent_a", second: "skent_b" },
        },
      ],
    });
  });

  it("addresses the spline end the direction tools pick (at = start near P0)", () => {
    const commit = commitPicks(sketchWithPhase37Entities(), "parallel", [
      { x: 8, y: 3, entityId: "skent_line" },
      { x: 0.2, y: 0.1, entityId: "skent_spline" },
    ]);
    expect(commit.transaction).toMatchObject({
      commands: [
        {
          constraint: {
            kind: "parallel",
            first: "skent_line",
            second: "skent_spline",
            at: "start",
          },
        },
      ],
    });
  });

  it("measures the angle between a line and a spline's start tangent", () => {
    const commit = commitPicks(sketchWithPhase37Entities(), "angle", [
      { x: 8, y: 3, entityId: "skent_line" },
      { x: 0.2, y: 0.1, entityId: "skent_spline" },
    ]);
    // Line direction (0,6) (90°); start tangent (1,2)·3 (63.4349°) —
    // measured angle 26.5651°.
    const command = (
      commit.transaction as unknown as {
        commands: { constraint: { value: { value: number } } }[];
      }
    ).commands[0];
    expect(command?.constraint.value.value).toBeCloseTo(26.56505117707799, 9);
  });

  it("pins a point onto a polygon and a straight slot through pointOnEntity", () => {
    const sketch = sketchWithPhase37Entities();
    const polygonCommit = commitPicks(sketch, "pointOnEntity", [
      { x: 8, y: 3, entityId: "skent_line" },
      { x: 20, y: 4, entityId: "skent_polygon" },
    ]);
    expect(polygonCommit.transaction).toMatchObject({
      commands: [
        { constraint: { kind: "pointOnEntity", entity: "skent_polygon" } },
      ],
    });
    const slotCommit = commitPicks(sketch, "pointOnEntity", [
      { x: 8, y: 3, entityId: "skent_line" },
      { x: -15, y: -8, entityId: "skent_slot" },
    ]);
    expect(slotCommit.transaction).toMatchObject({
      commands: [
        { constraint: { kind: "pointOnEntity", entity: "skent_slot" } },
      ],
    });
  });

  it("commits pointOnTangent with the picked spline end", () => {
    const commit = commitPicks(sketchWithPhase37Entities(), "pointOnTangent", [
      { x: 8, y: 3, entityId: "skent_line" },
      { x: 0.2, y: 0.1, entityId: "skent_spline" },
    ]);
    expect(commit.transaction).toMatchObject({
      commands: [
        {
          constraint: {
            kind: "pointOnTangent",
            spline: "skent_spline",
            at: "start",
          },
        },
      ],
    });
  });

  it("refuses two splines for parallel (no direction pair)", () => {
    const a = createSketchEntityId("skent_a");
    const b = createSketchEntityId("skent_b");
    const created = createSketch(
      xyWorkplane(),
      [
        createSplineEntity(a, "control", [
          { x: 0, y: 0 },
          { x: 1, y: 2 },
          { x: 3, y: 2 },
          { x: 4, y: 0 },
        ]),
        createSplineEntity(b, "control", [
          { x: 8, y: 0 },
          { x: 9, y: 2 },
          { x: 11, y: 2 },
          { x: 12, y: 0 },
        ]),
      ],
      [],
    );
    if (!created.ok) throw new Error(created.error.message);
    const commit = commitPicks(created.value, "parallel", [
      { x: 2, y: 1, entityId: "skent_a" },
      { x: 10, y: 1, entityId: "skent_b" },
    ]);
    expect(commit.transaction).toBeNull();
    expect(commit.state.status.severity).toBe("error");
  });
});

describe("sketch editor Phase 37 entity ops and drag", () => {
  it("offsets a picked line toward the second pick as one create transaction", () => {
    const sketch = sketchWithLines();
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "offset", type: "activate-tool" },
      sketch,
    ).state;
    const first = sketchEditorReducer(
      state,
      {
        entityId: "skent_a",
        point: { x: 20, y: 0 },
        type: "canvas-pick",
      },
      sketch,
    );
    expect(first.transaction).toBeNull();
    expect(first.state.gesture.kind).toBe("offset");
    const second = sketchEditorReducer(
      first.state,
      { entityId: null, point: { x: 20, y: 10 }, type: "canvas-pick" },
      sketch,
    );
    expect(second.transaction).not.toBeNull();
    expect(second.transaction?.commands).toHaveLength(1);
    const command = second.transaction?.commands[0];
    expect(command?.type).toBe("sketch.entity.create");
    if (command !== undefined && command.type === "sketch.entity.create") {
      expect(command.entity.kind).toBe("line");
      if (command.entity.kind === "line") {
        // The click sits 10 mm above the x-run: the copy offsets +y by 10.
        expect(command.entity.y1).toBeCloseTo(10, 9);
        expect(command.entity.y2).toBeCloseTo(10, 9);
      }
    }
  });

  it("mirrors about the picked axis line, each pick committing its copy", () => {
    const sketch = sketchWithLines();
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "mirror", type: "activate-tool" },
      sketch,
    ).state;
    const axis = sketchEditorReducer(
      state,
      { entityId: "skent_b", point: { x: 30, y: 0 }, type: "canvas-pick" },
      sketch,
    );
    expect(axis.transaction).toBeNull();
    expect(axis.state.gesture.kind).toBe("mirror");
    const mirrored = sketchEditorReducer(
      axis.state,
      { entityId: "skent_a", point: { x: 10, y: 0 }, type: "canvas-pick" },
      sketch,
    );
    expect(mirrored.transaction?.commands).toHaveLength(1);
    const command = mirrored.transaction?.commands[0];
    if (command !== undefined && command.type === "sketch.entity.create") {
      expect(command.entity.kind).toBe("line");
      if (command.entity.kind === "line") {
        // skent_a runs (0,0)→(60,0); mirrored across skent_b (x = 30):
        // (60,0)→(0,0).
        expect(command.entity.x1).toBeCloseTo(60, 9);
        expect(command.entity.x2).toBeCloseTo(0, 9);
      }
    }
  });

  it("extends the clicked end along its direction to the boundary", () => {
    const a = createSketchEntityId("skent_a");
    const wall = createSketchEntityId("skent_wall");
    const created = createSketch(
      xyWorkplane(),
      [
        createLineEntity(a, { x: 0, y: 0 }, { x: 20, y: 0 }),
        createLineEntity(wall, { x: -15, y: -10 }, { x: -15, y: 10 }),
      ],
      [],
    );
    if (!created.ok) throw new Error(created.error.message);
    const sketch = created.value;
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "extend", type: "activate-tool" },
      sketch,
    ).state;
    const commit = sketchEditorReducer(
      state,
      { entityId: "skent_a", point: { x: 0.5, y: 0 }, type: "canvas-pick" },
      sketch,
    );
    expect(commit.transaction?.commands).toHaveLength(1);
    const command = commit.transaction?.commands[0];
    expect(command?.type).toBe("sketch.entity.update");
    if (command !== undefined && command.type === "sketch.entity.update") {
      expect(command.entity.kind).toBe("line");
      if (command.entity.kind === "line") {
        expect(command.entity.x1).toBeCloseTo(-15, 9);
      }
    }
  });

  it("drag re-derives provisional geometry per move and commits once at end", () => {
    const sketch = sketchWithLines();
    let state = createSketchEditorState();
    // The drag grammar is the select tool's.
    state = sketchEditorReducer(
      state,
      { entityId: "skent_a", point: { x: 20, y: 0 }, type: "drag-start" },
      sketch,
    ).state;
    expect(state.drag?.entityId).toBe("skent_a");
    // A grab mid-line translates; a grab near an end moves that end. Here:
    // mid-line.
    const move = sketchEditorReducer(
      state,
      { point: { x: 25, y: 10 }, type: "drag-move" },
      sketch,
    );
    expect(move.transaction).toBeNull();
    expect(move.provisional).not.toBeNull();
    expect(move.provisional?.kind).toBe("line");
    if (move.provisional !== null && move.provisional.kind === "line") {
      // (0,0)→(60,0) translated by the move delta (+5, +10).
      expect(move.provisional.x1).toBeCloseTo(5, 9);
      expect(move.provisional.y1).toBeCloseTo(10, 9);
      expect(move.provisional.x2).toBeCloseTo(65, 9);
    }
    const end = sketchEditorReducer(
      move.state,
      { point: { x: 25, y: 10 }, type: "drag-end" },
      sketch,
    );
    expect(end.transaction?.commands).toHaveLength(1);
    expect(end.transaction?.commands[0]?.type).toBe("sketch.entity.update");
    expect(end.state.drag).toBeNull();
    expect(end.state.provisional).toBeNull();
  });

  it("a line-end drag moves only that endpoint", () => {
    const sketch = sketchWithLines();
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { entityId: "skent_a", point: { x: 0.5, y: 0 }, type: "drag-start" },
      sketch,
    ).state;
    expect(state.drag?.mode.kind).toBe("endpoint");
    const move = sketchEditorReducer(
      state,
      { point: { x: -5, y: 4 }, type: "drag-move" },
      sketch,
    );
    if (move.provisional !== null && move.provisional.kind === "line") {
      expect(move.provisional.x1).toBeCloseTo(-5, 9);
      expect(move.provisional.y1).toBeCloseTo(4, 9);
      expect(move.provisional.x2).toBeCloseTo(60, 9);
      expect(move.provisional.y2).toBeCloseTo(0, 9);
    }
  });

  it("ignores drags while a drawing tool is active", () => {
    let state = createSketchEditorState();
    state = sketchEditorReducer(
      state,
      { tool: "circle", type: "activate-tool" },
      sketchWithLines(),
    ).state;
    const ignored = sketchEditorReducer(
      state,
      { entityId: "skent_a", point: { x: 20, y: 0 }, type: "drag-start" },
      sketchWithLines(),
    );
    expect(ignored.state.drag).toBeNull();
  });
});
