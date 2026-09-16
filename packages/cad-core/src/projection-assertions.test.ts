import { describe, expect, it } from "vitest";

import {
  assertBoundsClose,
  assertCameraClose,
  assertIndicesEqual,
  assertPositionsClose,
  assertProjectionValid,
  assertRenderObjectValid,
  createBodyId,
  createFeatureId,
  createRenderProjection,
  type KernelTessellationSource,
  type ParseFailure,
  type ParseResult,
  projectTessellation,
  type RenderCamera,
  type RenderObject,
  type RenderProjection,
} from "./index";

const plateBody = createBodyId("body_plate");
const holeBody = createBodyId("body_hole");
const drillFeature = createFeatureId("feat_drill");

/** A tetrahedron soup with kernel-style unit vertex normals. */
const tetraSoup: KernelTessellationSource = {
  positions: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 10],
  indices: [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2],
  normals: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0.6, 0.8, 0],
};

/** One triangle, no normals. */
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

function unwrap<T, F extends ParseFailure>(
  result: ParseResult<T, F>,
  action: string,
): T {
  if (!result.ok) throw new Error(`${action}: ${JSON.stringify(result.error)}`);
  return result.value;
}

function validObject(): RenderObject {
  return unwrap(
    projectTessellation(plateBody, tetraSoup, drillFeature),
    "projectTessellation",
  );
}

function validProjection(): RenderProjection {
  const plate = validObject();
  const hole = unwrap(
    projectTessellation(holeBody, flatSoup),
    "projectTessellation",
  );
  return unwrap(
    createRenderProjection([plate, hole], perspectiveCamera),
    "createRenderProjection",
  );
}

describe("assertRenderObjectValid", () => {
  it("accepts a well-formed object with kernel normals", () => {
    expect(() => assertRenderObjectValid(validObject())).not.toThrow();
  });

  it("accepts an object without normals", () => {
    const object = unwrap(
      projectTessellation(plateBody, flatSoup),
      "projectTessellation",
    );
    expect(() => assertRenderObjectValid(object)).not.toThrow();
  });

  it("is winding-agnostic: reversed triangle windings stay valid", () => {
    const object = validObject();
    const rewoundIndices: number[] = [];
    for (let i = 0; i < object.indices.length; i += 3) {
      const a = object.indices[i];
      const b = object.indices[i + 1];
      const c = object.indices[i + 2];
      if (a === undefined || b === undefined || c === undefined) {
        throw new Error("fixture indices must be complete triples");
      }
      rewoundIndices.push(c, b, a);
    }
    const rewound: RenderObject = { ...object, indices: rewoundIndices };
    expect(() => assertRenderObjectValid(rewound)).not.toThrow();
  });

  it("rejects a smuggled invalid render object id", () => {
    // Simulates ill-typed input crossing a trust boundary post-parse: the
    // brand is forged, so only the runtime id check can catch it.
    const object: RenderObject = {
      ...validObject(),
      id: "render_plate" as RenderObject["id"],
    };
    expect(() => assertRenderObjectValid(object)).toThrow(/render object id/iu);
  });

  it("rejects positions whose length is not divisible by 3", () => {
    const object: RenderObject = {
      ...validObject(),
      positions: tetraSoup.positions.slice(0, 11),
    };
    expect(() => assertRenderObjectValid(object)).toThrow(/divisible/u);
  });

  it("rejects an index outside the vertex range", () => {
    const object: RenderObject = { ...validObject(), indices: [0, 1, 7] };
    expect(() => assertRenderObjectValid(object)).toThrow(/vertex range/u);
  });

  it("rejects a non-finite position", () => {
    const object: RenderObject = {
      ...validObject(),
      positions: [0, 0, Number.NaN, 10, 0, 0, 0, 10, 0, 0, 0, 10],
    };
    expect(() => assertRenderObjectValid(object)).toThrow(/finite/u);
  });

  it("rejects normals that do not pair with positions", () => {
    const object: RenderObject = { ...validObject(), normals: [1, 0, 0] };
    expect(() => assertRenderObjectValid(object)).toThrow(/normals/u);
  });

  it("rejects a non-unit normal", () => {
    const object: RenderObject = {
      ...validObject(),
      normals: [1, 0, 0, 0, 2, 0, 0, 0, 1, 0.6, 0.8, 0],
    };
    expect(() => assertRenderObjectValid(object)).toThrow(/unit/u);
  });

  it("rejects vertices outside the object's own bounds", () => {
    const object: RenderObject = {
      ...validObject(),
      bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    };
    expect(() => assertRenderObjectValid(object)).toThrow(
      /outside its own bounds/u,
    );
  });

  it("rejects an empty object unless triangles are not required", () => {
    const object: RenderObject = {
      ...validObject(),
      positions: [],
      indices: [],
      normals: undefined,
    };
    expect(() => assertRenderObjectValid(object)).toThrow(/empty/u);
    expect(() =>
      assertRenderObjectValid(object, { requireTriangles: false }),
    ).not.toThrow();
  });
});

describe("assertProjectionValid", () => {
  it("accepts a well-formed projection", () => {
    expect(() => assertProjectionValid(validProjection())).not.toThrow();
  });

  it("rejects duplicate object ids", () => {
    const projection: RenderProjection = {
      ...validProjection(),
      objects: [validObject(), validObject()],
    };
    expect(() => assertProjectionValid(projection)).toThrow(/duplicate/iu);
  });

  it("rejects a projection with a non-finite camera field", () => {
    const projection: RenderProjection = {
      ...validProjection(),
      camera: { ...perspectiveCamera, fovDeg: Number.NaN },
    };
    expect(() => assertProjectionValid(projection)).toThrow(/camera/iu);
  });
});

describe("assertPositionsClose", () => {
  const base = [0, 0, 0, 10, 5, 2];

  it("passes within tolerance and fails beyond", () => {
    const within = base.map((value) => value + 5e-7);
    const beyond = base.map((value) => value + 2e-6);
    expect(() => assertPositionsClose(within, base)).not.toThrow();
    expect(() => assertPositionsClose(beyond, base)).toThrow(/within/u);
  });

  it("fails on length mismatch", () => {
    expect(() => assertPositionsClose([0, 0, 0], base)).toThrow(/length/u);
  });
});

describe("assertIndicesEqual", () => {
  it("requires exact index equality", () => {
    expect(() => assertIndicesEqual([0, 1, 2], [0, 1, 2])).not.toThrow();
    expect(() => assertIndicesEqual([0, 1, 2], [0, 2, 1])).toThrow(/index/u);
    expect(() => assertIndicesEqual([0, 1, 2], [0, 1])).toThrow(/length/u);
  });
});

describe("assertBoundsClose", () => {
  it("passes within tolerance and fails beyond", () => {
    const expected = { min: [0, 0, 0], max: [10, 10, 10] } as const;
    const within = { min: [-5e-7, 0, 0], max: [10, 10 + 5e-7, 10] } as const;
    const beyond = { min: [0, 0, 0], max: [10, 10, 10 + 2e-6] } as const;
    expect(() => assertBoundsClose(within, expected)).not.toThrow();
    expect(() => assertBoundsClose(beyond, expected)).toThrow(/beyond/u);
  });
});

describe("assertCameraClose", () => {
  it("passes when every field is within tolerance", () => {
    const nudged: RenderCamera = {
      ...perspectiveCamera,
      position: [40 + 5e-7, -40, 30],
      target: [5e-7, 0, 0],
      up: [0, 5e-7, 1],
      fovDeg: 45 + 5e-7,
    };
    expect(() => assertCameraClose(nudged, perspectiveCamera)).not.toThrow();
  });

  it("fails when position, fov, or up drift beyond tolerance", () => {
    const moved: RenderCamera = {
      ...perspectiveCamera,
      position: [41, -40, 30],
    };
    expect(() => assertCameraClose(moved, perspectiveCamera)).toThrow(
      /position/u,
    );
    const zoomed: RenderCamera = { ...perspectiveCamera, fovDeg: 45.001 };
    expect(() => assertCameraClose(zoomed, perspectiveCamera)).toThrow(/fov/u);
    const tilted: RenderCamera = { ...perspectiveCamera, up: [0, 1, 0] };
    expect(() => assertCameraClose(tilted, perspectiveCamera)).toThrow(/up/u);
  });

  it("fails on kind mismatch", () => {
    const ortho: RenderCamera = {
      kind: "orthographic",
      position: [40, -40, 30],
      target: [0, 0, 0],
      up: [0, 0, 1],
      viewWidth: 40,
      viewHeight: 30,
    };
    expect(() => assertCameraClose(ortho, perspectiveCamera)).toThrow(/kind/u);
  });

  it("compares orthographic view sizes within tolerance", () => {
    const base: RenderCamera = {
      kind: "orthographic",
      position: [0, -60, 10],
      target: [0, 0, 10],
      up: [0, 0, 1],
      viewWidth: 40,
      viewHeight: 30,
    };
    const within: RenderCamera = {
      ...base,
      viewWidth: 40 + 5e-7,
      viewHeight: 30 - 5e-7,
    };
    expect(() => assertCameraClose(within, base)).not.toThrow();
    const beyond: RenderCamera = { ...base, viewWidth: 40.01 };
    expect(() => assertCameraClose(beyond, base)).toThrow(/viewWidth/u);
  });
});
