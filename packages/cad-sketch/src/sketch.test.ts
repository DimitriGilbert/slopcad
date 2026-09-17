import { describe, expect, it } from "vitest";
import { length } from "@slopcad/cad-core";
import type { SolvedSketchParameters } from "./solver";

import { SKETCH_DIAGNOSTIC_CODES } from "./diagnostics";
import {
  SKETCH_FORMAT_VERSION,
  applySolvedParameters,
  createSketch,
  parseSketch,
  serializeSketch,
} from "./sketch";
import {
  createCoincidentConstraint,
  createDistanceConstraint,
  createHorizontalConstraint,
  pointTarget,
} from "./constraints";
import {
  createArcEntity,
  createCircleEntity,
  createLineEntity,
  createPointEntity,
  createRectangleEntity,
} from "./entities";
import { createSketchConstraintId, createSketchEntityId } from "./sketch-ids";
import { xyWorkplane } from "./workplane";

const eid = (raw: string) => createSketchEntityId(raw);
const cid = (raw: string) => createSketchConstraintId(raw);

function rectangleEdges() {
  return [
    createLineEntity(eid("skent_re0"), { x: 0, y: 0 }, { x: 30, y: 1 }),
    createLineEntity(eid("skent_re1"), { x: 30, y: 1 }, { x: 29, y: 21 }),
    createLineEntity(eid("skent_re2"), { x: 29, y: 21 }, { x: -1, y: 20 }),
    createLineEntity(eid("skent_re3"), { x: -1, y: 20 }, { x: 0, y: 0 }),
  ] as const;
}

describe("sketch integrity", () => {
  it("accepts a consistent sketch", () => {
    const line = createLineEntity(eid("skent_l"), { x: 0, y: 0 }, { x: 10, y: 4 });
    const constraint = createHorizontalConstraint(cid("skcon_h"), eid("skent_l"));
    const result = createSketch(xyWorkplane(), [line], [constraint]);
    expect(result.ok).toBe(true);
  });

  it("rejects duplicate entity and constraint ids", () => {
    const a = createPointEntity(eid("skent_p"), { x: 0, y: 0 });
    const b = createPointEntity(eid("skent_p"), { x: 1, y: 1 });
    const duplicateEntity = createSketch(xyWorkplane(), [a, b], []);
    expect(!duplicateEntity.ok && duplicateEntity.error.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.entityDuplicateId,
    );
    const point = createPointEntity(eid("skent_p"), { x: 0, y: 0 });
    const other = createPointEntity(eid("skent_q"), { x: 1, y: 1 });
    const first = createCoincidentConstraint(
      cid("skcon_c"),
      pointTarget(eid("skent_p"), "center"),
      pointTarget(eid("skent_q"), "center"),
    );
    const second = createDistanceConstraint(
      cid("skcon_c"),
      pointTarget(eid("skent_p"), "center"),
      pointTarget(eid("skent_q"), "center"),
      length(5),
    );
    const duplicateConstraint = createSketch(xyWorkplane(), [point, other], [
      first,
      second,
    ]);
    expect(!duplicateConstraint.ok && duplicateConstraint.error.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.constraintDuplicateId,
    );
  });

  it("rejects rectangles whose edges are missing or not lines", () => {
    const edges = rectangleEdges();
    const rect = createRectangleEntity(
      eid("skent_rect"),
      [edges[0].id, edges[1].id, edges[2].id, edges[3].id],
    );
    const missingEdge = createSketch(xyWorkplane(), [...edges.slice(0, 3), rect], []);
    expect(!missingEdge.ok && missingEdge.error.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.rectangleEdgesMalformed,
    );
    const pointImposter = createPointEntity(eid("skent_point-imposter"), { x: 0, y: 0 });
    const wrongKind = createSketch(
      xyWorkplane(),
      [...edges.slice(0, 3), pointImposter, rect],
      [],
    );
    expect(!wrongKind.ok && wrongKind.error.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.rectangleEdgesMalformed,
    );
  });

  it("rejects constraints whose references do not resolve", () => {
    const line = createLineEntity(eid("skent_l"), { x: 0, y: 0 }, { x: 10, y: 4 });
    const constraint = createHorizontalConstraint(cid("skcon_h"), eid("skent_ghost"));
    const result = createSketch(xyWorkplane(), [line], [constraint]);
    expect(!result.ok && result.error.code).toBe(
      SKETCH_DIAGNOSTIC_CODES.constraintReferenceMalformed,
    );
  });
});

describe("sketch serialization", () => {
  it("round-trips a full sketch exactly, byte-for-byte on re-serialize", () => {
    const edges = rectangleEdges();
    const rectangle = createRectangleEntity(
      eid("skent_rect"),
      [edges[0].id, edges[1].id, edges[2].id, edges[3].id],
      { construction: false },
    );
    const anchor = createPointEntity(eid("skent_anchor"), { x: 0, y: 0 }, {
      construction: true,
      fixed: true,
    });
    const arc = createArcEntity(eid("skent_arc"), { x: 5, y: 5 }, 3, 0.25, 2.5);
    const circle = createCircleEntity(eid("skent_circle"), { x: -5, y: -5 }, 2, {
      fixed: true,
    });
    const constraints = [
      createCoincidentConstraint(
        cid("skcon_join"),
        pointTarget(edges[0].id, "start"),
        pointTarget(anchor.id, "center"),
      ),
      createHorizontalConstraint(cid("skcon_horiz"), edges[0].id),
      createDistanceConstraint(
        cid("skcon_width"),
        pointTarget(edges[0].id, "start"),
        pointTarget(edges[0].id, "end"),
        length(30),
      ),
    ];
    const sketch = createSketch(xyWorkplane(), [
      anchor,
      ...edges,
      rectangle,
      arc,
      circle,
    ], constraints);
    expect(sketch.ok).toBe(true);
    if (!sketch.ok) return;
    const serialized = serializeSketch(sketch.value);
    expect(Object.keys(serialized)).toEqual([
      "formatVersion",
      "workplane",
      "entities",
      "constraints",
    ]);
    const parsed = parseSketch(JSON.parse(JSON.stringify(serialized)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeSketch(parsed.value)).toEqual(serialized);
    expect(parsed.value).toEqual(sketch.value);
  });

  it("stamps and enforces the format version", () => {
    expect(SKETCH_FORMAT_VERSION).toBe(1);
    const sketch = createSketch(xyWorkplane(), [], []);
    expect(sketch.ok && serializeSketch(sketch.value).formatVersion).toBe(1);
    for (const formatVersion of [0, 2, "1", null]) {
      const result = parseSketch({ formatVersion, workplane: null, entities: [], constraints: [] });
      expect(!result.ok && result.error.code).toBe(
        SKETCH_DIAGNOSTIC_CODES.versionUnsupported,
      );
    }
  });

  it("rejects structurally malformed envelopes", () => {
    expect(!parseSketch(null).ok).toBe(true);
    const valid = createSketch(xyWorkplane(), [], []);
    expect(valid.ok).toBe(true);
    if (!valid.ok) return;
    const validSerialized = serializeSketch(valid.value);
    expect(
      !parseSketch({
        ...validSerialized,
        workplane: null,
      }).ok,
    ).toBe(true);
    expect(
      !parseSketch({ ...validSerialized, entities: {} }).ok,
    ).toBe(true);
    expect(
      !parseSketch({ ...validSerialized, constraints: "none" }).ok,
    ).toBe(true);
  });
});

describe("applySolvedParameters", () => {
  it("replaces parameters in place, preserving flags and composition", () => {
    const edges = rectangleEdges();
    const rectangle = createRectangleEntity(
      eid("skent_rect"),
      [edges[0].id, edges[1].id, edges[2].id, edges[3].id],
    );
    const anchor = createPointEntity(eid("skent_anchor"), { x: 0, y: 0 }, { fixed: true });
    const arc = createArcEntity(eid("skent_arc"), { x: 5, y: 5 }, 3, 0.25, 2.5, {
      construction: true,
    });
    const sketch = createSketch(xyWorkplane(), [anchor, ...edges, rectangle, arc], []);
    expect(sketch.ok).toBe(true);
    if (!sketch.ok) return;
    const solved: SolvedSketchParameters = {
      entities: [
        { id: anchor.id, kind: "point", x: 9, y: 9 },
        { id: edges[0].id, kind: "line", x1: 1, y1: 2, x2: 3, y2: 4 },
        { id: edges[1].id, kind: "line", x1: 3, y1: 4, x2: 5, y2: 6 },
        { id: edges[2].id, kind: "line", x1: 5, y1: 6, x2: 7, y2: 8 },
        { id: edges[3].id, kind: "line", x1: 7, y1: 8, x2: 1, y2: 2 },
        { id: rectangle.id, kind: "rectangle" },
        {
          id: arc.id,
          kind: "arc",
          cx: 1,
          cy: 1,
          radius: 2,
          startAngle: 0,
          endAngle: 1,
        },
      ],
    };
    const applied = applySolvedParameters(sketch.value, solved);
    expect(applied.entities[1]).toEqual({
      id: edges[0].id,
      kind: "line",
      construction: false,
      fixed: false,
      x1: 1,
      y1: 2,
      x2: 3,
      y2: 4,
    });
    expect(applied.entities[0]).toEqual({
      id: anchor.id,
      kind: "point",
      construction: false,
      fixed: true,
      x: 9,
      y: 9,
    });
    expect(applied.entities[5]).toEqual(rectangle);
    const solvedArc = applied.entities[6];
    expect(solvedArc?.kind).toBe("arc");
    expect(solvedArc?.construction).toBe(true);
  });

  it("throws on missing or mismatched solved entries", () => {
    const point = createPointEntity(eid("skent_p"), { x: 0, y: 0 });
    const sketch = createSketch(xyWorkplane(), [point], []);
    expect(sketch.ok).toBe(true);
    if (!sketch.ok) return;
    expect(() => applySolvedParameters(sketch.value, { entities: [] })).toThrow(
      RangeError,
    );
    expect(() =>
      applySolvedParameters(sketch.value, {
        entities: [
          { id: point.id, kind: "line", x1: 0, y1: 0, x2: 1, y2: 1 },
        ],
      }),
    ).toThrow(RangeError);
  });
});
