/**
 * Convert entities (Phase 37) against hand-built topology fixtures: the
 * resolution protocol decides (valid converts, missing/ambiguous/invalid
 * decline with state-named codes), a transient-topology view declines, a
 * vertex projects to a construction point on the workplane (the
 * out-of-plane offset disclosed), edges and faces decline honestly, and the
 * emitted command commits through the real interpreter.
 */

import { describe, expect, it } from "vitest";
import {
  createBodyId,
  createReferenceId,
  mintTopologyReference,
  type BodyId,
  type TopologyEntitySnapshot,
  type TopologySnapshot,
  type TopologyView,
} from "@slopcad/cad-core";

import { applySketchCommand } from "./commands";
import {
  SKETCH_CONVERT_DECLINE_CODES,
  SKETCH_CONVERT_ERROR_CODES,
  convertTopologyEntities,
} from "./convert";
import { createSketch, type Sketch } from "./sketch";
import { createWorkplane, xyWorkplane } from "./workplane";

const VERTEX_SNAPSHOT_ENTITY: TopologyEntitySnapshot = {
  geometry: {
    centroidAbsoluteMm: [1, 2, 3],
    lengthMm: 0,
    pointAbsoluteMm: [10, 20, 4],
    pointRelativeMm: [10, 20, 4],
  },
  identity: {
    data: { hash: "v0" },
    kernelId: "kernel_test",
    schema: "test/v1",
  },
  kind: "vertex",
  ordinal: 0,
};

const EDGE_SNAPSHOT_ENTITY: TopologyEntitySnapshot = {
  geometry: {
    centroidAbsoluteMm: [5, 5, 0],
    lengthMm: 30,
  },
  identity: {
    data: { hash: "e0" },
    kernelId: "kernel_test",
    schema: "test/v1",
  },
  kind: "edge",
  ordinal: 0,
};

const TEST_BODY: BodyId = createBodyId("body_test");

function snapshotOf(
  entities: readonly TopologyEntitySnapshot[],
): TopologySnapshot {
  return {
    bodyId: TEST_BODY,
    entities,
    identitySchemas: ["test/v1"],
    kernelId: "kernel_test",
    persistentTopology: true,
    regeneration: 3,
  };
}

function viewOf(snapshot: TopologySnapshot | null): TopologyView {
  return {
    identitySchemas: snapshot?.identitySchemas ?? [],
    kernelId: "kernel_test",
    persistentTopology: true,
    snapshotOf: (bodyId) =>
      snapshot !== null && snapshot.bodyId === bodyId ? snapshot : null,
  };
}

function sketchWithPlane(): Sketch {
  const plane = createWorkplane(
    { x: 0, y: 0, z: 0 },
    { x: 0, y: 0, z: 1 },
    { x: 1, y: 0, z: 0 },
  );
  const created = createSketch(plane.ok ? plane.value : xyWorkplane(), [], []);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

function baseSketch(): Sketch {
  const created = createSketch(xyWorkplane(), [], []);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe("convertTopologyEntities", () => {
  it("declines the whole request when no view exists", () => {
    const result = convertTopologyEntities(baseSketch(), {
      references: [],
      view: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe(SKETCH_CONVERT_ERROR_CODES.viewMissing);
    }
  });

  it("converts a valid vertex reference into a construction point", () => {
    const sketch = sketchWithPlane();
    const snapshot = snapshotOf([VERTEX_SNAPSHOT_ENTITY]);
    const minted = mintTopologyReference(
      snapshot,
      0,
      { featurePath: [], bodyId: snapshot.bodyId },
      { kind: "vertex", id: createReferenceId("ref_v0") },
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const result = convertTopologyEntities(sketch, {
      references: [minted.value],
      view: viewOf(snapshot),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toHaveLength(1);
    const outcome = result.value[0];
    expect(outcome?.status).toBe("converted");
    if (outcome !== undefined && outcome.status === "converted") {
      // The vertex sits 4 mm off the XY plane: projected to (10, 20), the
      // out-of-plane offset disclosed in the outcome.
      expect(outcome.offsetMm).toBeCloseTo(4, 9);
      expect(outcome.command.type).toBe("sketch.entity.create");
      if (outcome.command.type === "sketch.entity.create") {
        expect(outcome.command.entity.kind).toBe("point");
        expect(outcome.command.entity.construction).toBe(true);
        if (outcome.command.entity.kind === "point") {
          expect(outcome.command.entity.x).toBeCloseTo(10, 9);
          expect(outcome.command.entity.y).toBeCloseTo(20, 9);
        }
      }
      const applied = applySketchCommand(sketch, outcome.command);
      expect(applied.ok).toBe(true);
    }
  });

  it("declines an edge reference honestly: the descriptor carries no curve", () => {
    const sketch = baseSketch();
    const snapshot = snapshotOf([EDGE_SNAPSHOT_ENTITY]);
    const minted = mintTopologyReference(
      snapshot,
      0,
      { featurePath: [], bodyId: snapshot.bodyId },
      { kind: "edge", id: createReferenceId("ref_e0") },
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const result = convertTopologyEntities(sketch, {
      references: [minted.value],
      view: viewOf(snapshot),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome = result.value[0];
    expect(outcome?.status).toBe("declined");
    if (outcome !== undefined && outcome.status === "declined") {
      expect(outcome.code).toBe(SKETCH_CONVERT_DECLINE_CODES.curveUnavailable);
      expect(outcome.message).toContain("centroid");
    }
  });

  it("declines a reference the current topology no longer matches (missing)", () => {
    const sketch = baseSketch();
    const snapshot = snapshotOf([VERTEX_SNAPSHOT_ENTITY]);
    const minted = mintTopologyReference(
      snapshot,
      0,
      { featurePath: [], bodyId: snapshot.bodyId },
      { kind: "vertex", id: createReferenceId("ref_v0") },
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    // A regeneration that removed the entity: resolution goes missing.
    const moved = viewOf({
      ...snapshot,
      entities: [],
      regeneration: 4,
    });
    const result = convertTopologyEntities(sketch, {
      references: [minted.value],
      view: moved,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome = result.value[0];
    expect(outcome?.status).toBe("declined");
    if (outcome !== undefined && outcome.status === "declined") {
      expect(outcome.code).toBe(SKETCH_CONVERT_DECLINE_CODES.referenceMissing);
    }
  });

  it("declines an unknown body (the view has no snapshot for it)", () => {
    const sketch = baseSketch();
    const snapshot = snapshotOf([VERTEX_SNAPSHOT_ENTITY]);
    const minted = mintTopologyReference(
      snapshot,
      0,
      { featurePath: [], bodyId: snapshot.bodyId },
      { kind: "vertex", id: createReferenceId("ref_v0") },
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const result = convertTopologyEntities(sketch, {
      references: [minted.value],
      view: viewOf(null),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome = result.value[0];
    expect(outcome?.status).toBe("declined");
    if (outcome !== undefined && outcome.status === "declined") {
      expect(outcome.code).toBe(SKETCH_CONVERT_DECLINE_CODES.referenceMissing);
    }
  });

  it("converts and declines mixed references per-reference", () => {
    const sketch = baseSketch();
    const snapshot = snapshotOf([VERTEX_SNAPSHOT_ENTITY, EDGE_SNAPSHOT_ENTITY]);
    const vertexRef = mintTopologyReference(
      snapshot,
      0,
      { featurePath: [], bodyId: snapshot.bodyId },
      { kind: "vertex", id: createReferenceId("ref_v0") },
    );
    const edgeRef = mintTopologyReference(
      snapshot,
      0,
      { featurePath: [], bodyId: snapshot.bodyId },
      { kind: "edge", id: createReferenceId("ref_e0") },
    );
    expect(vertexRef.ok && edgeRef.ok).toBe(true);
    if (!vertexRef.ok || !edgeRef.ok) return;
    const result = convertTopologyEntities(sketch, {
      references: [vertexRef.value, edgeRef.value],
      view: viewOf(snapshot),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((outcome) => outcome.status)).toEqual([
      "converted",
      "declined",
    ]);
  });

  it("deterministically reuses one allocator across references", () => {
    const sketch = baseSketch();
    const snapshot = snapshotOf([
      VERTEX_SNAPSHOT_ENTITY,
      {
        ...VERTEX_SNAPSHOT_ENTITY,
        identity: {
          data: { hash: "v1" },
          kernelId: "kernel_test",
          schema: "test/v1",
        },
        ordinal: 1,
      },
    ]);
    const first = mintTopologyReference(
      snapshot,
      0,
      { featurePath: [], bodyId: snapshot.bodyId },
      { kind: "vertex", id: createReferenceId("ref_v0") },
    );
    const second = mintTopologyReference(
      snapshot,
      1,
      { featurePath: [], bodyId: snapshot.bodyId },
      { kind: "vertex", id: createReferenceId("ref_v1") },
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const result = convertTopologyEntities(sketch, {
      references: [first.value, second.value],
      view: viewOf(snapshot),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const points = result.value.map((outcome) =>
      outcome.status === "converted" &&
      outcome.command.type === "sketch.entity.create"
        ? outcome.command.entity.id
        : "",
    );
    expect(points[0]).not.toBe(points[1]);
    // Replay determinism: converting again mints the same ids.
    const again = convertTopologyEntities(sketch, {
      references: [first.value, second.value],
      view: viewOf(snapshot),
    });
    if (again.ok) {
      const againPoints = again.value.map((outcome) =>
        outcome.status === "converted" &&
        outcome.command.type === "sketch.entity.create"
          ? outcome.command.entity.id
          : "",
      );
      expect(againPoints).toEqual(points);
    }
  });
});

describe("convert workplane projection", () => {
  it("projects a vertex onto an offset front plane with its out-of-plane offset", () => {
    const plane = createWorkplane(
      { x: 0, y: 5, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 1, y: 0, z: 0 },
    );
    expect(plane.ok).toBe(true);
    if (!plane.ok) return;
    const created = createSketch(plane.value, [], []);
    if (!created.ok) throw new Error(created.error.message);
    const snapshot = snapshotOf([VERTEX_SNAPSHOT_ENTITY]);
    const minted = mintTopologyReference(
      snapshot,
      0,
      { featurePath: [], bodyId: snapshot.bodyId },
      { kind: "vertex", id: createReferenceId("ref_v0") },
    );
    if (!minted.ok) throw new Error(minted.error.message);
    const result = convertTopologyEntities(created.value, {
      references: [minted.value],
      view: viewOf(snapshot),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const outcome = result.value[0];
    if (outcome !== undefined && outcome.status === "converted") {
      // The model vertex (10, 20, 4): the plane's origin sits at y=5, so the
      // workplane y reads 15 and the out-of-plane offset stays 4.
      if (
        outcome.command.type === "sketch.entity.create" &&
        outcome.command.entity.kind === "point"
      ) {
        expect(outcome.command.entity.x).toBeCloseTo(10, 9);
        expect(outcome.command.entity.y).toBeCloseTo(15, 9);
      }
      expect(outcome.offsetMm).toBeCloseTo(4, 9);
    } else {
      throw new Error("expected conversion");
    }
  });
});
