import { describe, expect, it } from "vitest";

import {
  type BodyId,
  CAD_PROJECTION_FORMAT_VERSION,
  createBodyId,
  createFeatureId,
  createRenderObjectId,
  createRenderProjection,
  type KernelTessellationSource,
  parseRenderCamera,
  parseRenderObjectId,
  parseRenderProjection,
  type ParseFailure,
  type ParseResult,
  PROJECTION_ERROR_CODES,
  projectTessellation,
  type RenderCamera,
  type RenderObject,
  type RenderProjection,
  renderObjectIdBodyId,
  serializeRenderProjection,
} from "./index";

const CODES = PROJECTION_ERROR_CODES;

const plateBody = createBodyId("body_plate");
const holeBody = createBodyId("body_hole");
const drillFeature = createFeatureId("feat_drill");

/**
 * A tetrahedron soup with kernel-style unit vertex normals: 4 vertices,
 * 4 triangles, bounds (0,0,0)–(10,10,10). Structurally identical to what
 * `@slopcad/cad-kernel`'s `tessellate` returns, so the conversion is judged
 * against the real kernel shape without importing the kernel package.
 */
const tetraSoup: KernelTessellationSource = {
  positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10],
  indices: [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2],
  normals: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0.6, 0.8, 0],
};

/** One triangle, no normals: the kernels-that-cannot-compute-normals shape. */
const flatSoup: KernelTessellationSource = {
  positions: [0, 0, 0, 2, 0, 0, 0, 2, 0],
  indices: [0, 1, 2],
};

const perspectiveCamera: RenderCamera = {
  kind: "perspective",
  position: [40, -40, 30],
  target: [0, 0, 0],
  up: [0, 0, 1],
  fovDeg: 45,
};

const orthoCamera: RenderCamera = {
  kind: "orthographic",
  position: [0, -60, 10],
  target: [0, 0, 10],
  up: [0, 0, 1],
  viewWidth: 40,
  viewHeight: 30,
};

function unwrap<T, F extends ParseFailure>(
  result: ParseResult<T, F>,
  action: string,
): T {
  if (!result.ok) throw new Error(`${action}: ${JSON.stringify(result.error)}`);
  return result.value;
}

function expectError(
  result: {
    readonly ok: boolean;
    readonly error?: { readonly code: string };
  },
  code: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error?.code).toBe(code);
}

function asRecord(input: unknown): Record<string, unknown> {
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  throw new Error("test fixture must be a record");
}

function projected(bodyId: BodyId = plateBody): RenderObject {
  return unwrap(
    projectTessellation(bodyId, tetraSoup, drillFeature),
    "projectTessellation",
  );
}

function sampleProjection(): RenderProjection {
  const plate = projected();
  const hole = unwrap(
    projectTessellation(holeBody, flatSoup),
    "projectTessellation",
  );
  return unwrap(
    createRenderProjection([plate, hole], perspectiveCamera),
    "createRenderProjection",
  );
}

describe("render object identity", () => {
  it("derives the same id for the same body across regenerations, independent of geometry", () => {
    const first = unwrap(projectTessellation(plateBody, tetraSoup), "first");
    const regenerated = unwrap(
      projectTessellation(plateBody, {
        ...tetraSoup,
        positions: [0, 0, 0, 20, 0, 0, 0, 20, 0, 0, 0, 20],
      }),
      "regenerated",
    );
    expect(regenerated.id).toBe(first.id);
    expect(first.id).toBe(createRenderObjectId(plateBody));
    expect(first.id).toBe("rend_plate");
  });

  it("derives different ids for different bodies", () => {
    expect(createRenderObjectId(plateBody)).not.toBe(
      createRenderObjectId(holeBody),
    );
  });

  it("round-trips a render object id through its body id", () => {
    for (const raw of ["body_plate", "body_000042", "body_body_x"]) {
      const bodyId = createBodyId(raw);
      expect(renderObjectIdBodyId(createRenderObjectId(bodyId))).toBe(bodyId);
    }
  });

  it("parses generated render object ids and rejects malformed ones", () => {
    expect(parseRenderObjectId("rend_plate")).toEqual({
      ok: true,
      value: "rend_plate",
    });
    expectError(parseRenderObjectId(42), CODES.idNotAString);
    for (const input of ["", "render_plate", "body_plate"]) {
      expectError(parseRenderObjectId(input), CODES.idWrongPrefix);
    }
    for (const input of [
      "rend_",
      "rend_-x",
      `rend_${"a".repeat(65)}`,
      "rend_up§per",
    ]) {
      expectError(parseRenderObjectId(input), CODES.idInvalidPayload);
    }
  });
});

describe("projectTessellation", () => {
  it("passes positions, indices, and normals through unchanged with computed bounds and stable identity", () => {
    const object = projected();
    expect(object.id).toBe(createRenderObjectId(plateBody));
    expect(object.positions).toEqual(tetraSoup.positions);
    expect(object.positions).not.toBe(tetraSoup.positions);
    expect(object.indices).toEqual(tetraSoup.indices);
    expect(object.normals).toEqual(tetraSoup.normals);
    expect(object.bounds).toEqual({ min: [0, 0, 0], max: [10, 10, 10] });
    expect(object.bodyId).toBe(plateBody);
    expect(object.featureId).toBe(drillFeature);
    expect(Object.isFrozen(object)).toBe(true);
  });

  it("omits normals when the kernel tessellation omits them", () => {
    const object = unwrap(
      projectTessellation(plateBody, flatSoup),
      "projectTessellation",
    );
    expect(object.normals).toBeUndefined();
    expect(object.positions).toEqual(flatSoup.positions);
    expect(object.bounds).toEqual({ min: [0, 0, 0], max: [2, 2, 0] });
  });

  it("rejects an empty tessellation with projection/empty-tessellation", () => {
    expectError(
      projectTessellation(plateBody, { positions: [], indices: [] }),
      CODES.emptyTessellation,
    );
    expectError(
      projectTessellation(plateBody, { positions: [0, 0, 0], indices: [] }),
      CODES.emptyTessellation,
    );
  });

  it("rejects malformed tessellations with projection/malformed", () => {
    const malformed: KernelTessellationSource[] = [
      { positions: [0, 0], indices: [0, 1] },
      { positions: [0, 0, 0, 1, 0, 0], indices: [0, 1] },
      { positions: [Number.NaN, 0, 0], indices: [0, 0, 0] },
      {
        positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
        indices: [0, 1, 5],
      },
      { ...flatSoup, indices: [0, -1, 2] },
      { ...tetraSoup, normals: [1, 0, 0] },
      { ...tetraSoup, normals: [1, 0, 0, 0, 2, 0, 0, 0, 1, 0.6, 0.8, 0] },
      {
        ...tetraSoup,
        normals: [1, 0, 0, Number.NaN, 1, 0, 0, 0, 1, 0.6, 0.8, 0],
      },
    ];
    for (const tessellation of malformed) {
      expectError(
        projectTessellation(plateBody, tessellation),
        CODES.malformed,
      );
    }
  });
});

describe("createRenderProjection", () => {
  it("builds a frozen projection from render objects and a camera", () => {
    const projection = unwrap(
      createRenderProjection([projected()], perspectiveCamera),
      "createRenderProjection",
    );
    expect(projection.objects).toHaveLength(1);
    expect(projection.camera).toEqual(perspectiveCamera);
    expect(Object.isFrozen(projection)).toBe(true);
  });

  it("rejects duplicate render object ids with projection/duplicate-object-id", () => {
    expectError(
      createRenderProjection([projected(), projected()], perspectiveCamera),
      CODES.duplicateObjectId,
    );
  });
});

describe("parseRenderCamera", () => {
  it("parses well-formed cameras of both kinds", () => {
    expect(parseRenderCamera(perspectiveCamera)).toEqual({
      ok: true,
      value: perspectiveCamera,
    });
    expect(parseRenderCamera(orthoCamera)).toEqual({
      ok: true,
      value: orthoCamera,
    });
  });

  it("rejects degenerate cameras with projection/camera-malformed", () => {
    const degenerate: unknown[] = [
      "camera",
      { ...perspectiveCamera, kind: "stereographic" },
      { ...perspectiveCamera, position: [40, -40] },
      { ...perspectiveCamera, position: [40, -40, Number.NaN] },
      { ...perspectiveCamera, up: [0, 0, 0] },
      { ...perspectiveCamera, up: [4, -4, 3] },
      { ...perspectiveCamera, position: [0, 0, 0] },
      { ...perspectiveCamera, fovDeg: 0 },
      { ...perspectiveCamera, fovDeg: 180 },
      { ...perspectiveCamera, fovDeg: Number.NaN },
      { ...perspectiveCamera, fovDeg: "45" },
      { ...orthoCamera, viewWidth: 0 },
      { ...orthoCamera, viewHeight: -30 },
    ];
    for (const input of degenerate) {
      expectError(parseRenderCamera(input), CODES.cameraMalformed);
    }
  });
});

describe("serializeRenderProjection / parseRenderProjection", () => {
  it("round-trips a projection exactly through JSON", () => {
    const projection = sampleProjection();
    const parsed = unwrap(
      parseRenderProjection(
        JSON.parse(JSON.stringify(serializeRenderProjection(projection))),
      ),
      "parseRenderProjection",
    );
    expect(parsed).toEqual(projection);
  });

  it("round-trips an orthographic camera exactly", () => {
    const projection = unwrap(
      createRenderProjection([projected()], orthoCamera),
      "createRenderProjection",
    );
    const parsed = unwrap(
      parseRenderProjection(
        JSON.parse(JSON.stringify(serializeRenderProjection(projection))),
      ),
      "parseRenderProjection",
    );
    expect(parsed.camera).toEqual(orthoCamera);
  });

  it("preserves stable render object ids across serialize → parse", () => {
    const projection = sampleProjection();
    const parsed = unwrap(
      parseRenderProjection(
        JSON.parse(JSON.stringify(serializeRenderProjection(projection))),
      ),
      "parseRenderProjection",
    );
    expect(parsed.objects.map((object) => object.id)).toEqual(
      projection.objects.map((object) => object.id),
    );
  });

  it("stamps formatVersion and emits a fixed key set", () => {
    const serialized = serializeRenderProjection(sampleProjection());
    expect(serialized.formatVersion).toBe(CAD_PROJECTION_FORMAT_VERSION);
    expect(Object.keys(serialized)).toEqual([
      "formatVersion",
      "objects",
      "camera",
    ]);
    expect(Object.keys(serialized.objects[0] ?? {})).toEqual([
      "formatVersion",
      "id",
      "positions",
      "indices",
      "bounds",
      "normals",
      "bodyId",
      "featureId",
    ]);
    expect(Object.keys(serialized.objects[1] ?? {})).toEqual([
      "formatVersion",
      "id",
      "positions",
      "indices",
      "bounds",
      "bodyId",
    ]);
    expect(Object.keys(serialized.objects[0]?.bounds ?? {})).toEqual([
      "min",
      "max",
    ]);
    expect(Object.keys(serialized.camera)).toEqual([
      "kind",
      "position",
      "target",
      "up",
      "fovDeg",
    ]);
  });

  it("rejects a wrong formatVersion with projection/version-unsupported", () => {
    const serialized = serializeRenderProjection(sampleProjection());
    expectError(
      parseRenderProjection({ ...serialized, formatVersion: 0 }),
      CODES.versionUnsupported,
    );
    expectError(
      parseRenderProjection({ ...serialized, formatVersion: 2 }),
      CODES.versionUnsupported,
    );
  });

  it("ignores unknown fields on the projection, objects, and camera", () => {
    const projection = sampleProjection();
    const serialized = serializeRenderProjection(projection);
    const tolerant = {
      ...serialized,
      extraSceneField: "future",
      camera: { ...serialized.camera, near: 0.1 },
      objects: serialized.objects.map((object) => ({
        ...object,
        futureField: true,
      })),
    };
    const parsed = unwrap(parseRenderProjection(tolerant), "parse");
    expect(parsed).toEqual(projection);
  });

  it("rejects malformed serialized projections with structured codes", () => {
    const serialized = serializeRenderProjection(sampleProjection());
    const firstObject = asRecord(serialized.objects[0]);
    const malformed: readonly [unknown, string][] = [
      ["not a record", CODES.malformed],
      [{ ...serialized, objects: "many" }, CODES.malformed],
      [{ ...serialized, objects: ["object"] }, CODES.malformed],
      [
        { ...serialized, objects: [{ ...firstObject, id: "render_plate" }] },
        CODES.malformed,
      ],
      [
        { ...serialized, objects: [{ ...firstObject, id: "rend_" }] },
        CODES.malformed,
      ],
      [
        {
          ...serialized,
          objects: [{ ...firstObject, positions: "0,0,0" }],
        },
        CODES.malformed,
      ],
      [
        {
          ...serialized,
          objects: [{ ...firstObject, positions: [Number.NaN, 0, 0] }],
        },
        CODES.malformed,
      ],
      [
        { ...serialized, objects: [{ ...firstObject, indices: [0, 1, 9] }] },
        CODES.malformed,
      ],
      [
        {
          ...serialized,
          objects: [
            { ...firstObject, positions: [...tetraSoup.positions], indices: [] },
          ],
        },
        CODES.emptyTessellation,
      ],
      [
        { ...serialized, objects: [{ ...firstObject, normals: [1, 0, 0] }] },
        CODES.malformed,
      ],
      [
        {
          ...serialized,
          objects: [{ ...firstObject, bounds: { min: [0, 0, 0] } }],
        },
        CODES.malformed,
      ],
      [
        {
          ...serialized,
          objects: [
            { ...firstObject, bounds: { min: [10, 10, 10], max: [0, 0, 0] } },
          ],
        },
        CODES.malformed,
      ],
      [
        { ...serialized, objects: [{ ...firstObject, bodyId: "feat_plate" }] },
        CODES.malformed,
      ],
      [
        {
          ...serialized,
          objects: [
            {
              ...firstObject,
              bodyId: holeBody,
            },
          ],
        },
        CODES.malformed,
      ],
      [
        {
          ...serialized,
          objects: [{ ...firstObject, featureId: "body_hole" }],
        },
        CODES.malformed,
      ],
      [{ ...serialized, camera: "perspective" }, CODES.cameraMalformed],
      [
        {
          ...serialized,
          objects: [serialized.objects[0], serialized.objects[0]],
        },
        CODES.duplicateObjectId,
      ],
    ];
    for (const [input, code] of malformed) {
      expectError(parseRenderProjection(input), code);
    }
  });
});
