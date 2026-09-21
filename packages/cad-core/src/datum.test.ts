/**
 * The datum payload suite (Phase 39): parse/serialize round-trips for every
 * datum kind and definition, the deterministic resolution math (explicit
 * frames, three points, two points, the coordinate system frame), and the
 * structured failure taxonomy — degenerate frames, collinear points, wrong
 * payload stamps, unknown kinds.
 */

import { describe, expect, it } from "vitest";

import {
  DATUM_ERROR_CODES,
  DATUM_FORMAT_VERSION,
  datumCross,
  datumDot,
  parseDatumPayload,
  resolveDatumPayload,
  serializeDatumPayload,
  type DatumTopologyResolver,
} from "./index";

const faceReference = {
  kind: "face",
  bodyId: "body_base",
  ordinal: 2,
} as const;

const resolverStubs: DatumTopologyResolver = {
  facePlane: () => ({
    ok: false,
    error: { code: "datum-test/no-face", message: "no face", input: null },
  }),
  faceCylinderAxis: () => ({
    ok: false,
    error: { code: "datum-test/no-face", message: "no face", input: null },
  }),
  edgeLine: () => ({
    ok: false,
    error: { code: "datum-test/no-edge", message: "no edge", input: null },
  }),
};

describe("datum payload parsing", () => {
  it("round-trips an originFrame datum plane verbatim", () => {
    const payload = {
      formatVersion: DATUM_FORMAT_VERSION,
      datumType: "plane" as const,
      definition: "originFrame" as const,
      origin: [1, 2, 3] as const,
      normal: [0, 0, 2] as const,
      xAxis: [0, 3, 0] as const,
    };
    const parsed = parseDatumPayload(payload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const serialized = serializeDatumPayload(parsed.value);
    expect(serialized).toEqual({
      formatVersion: DATUM_FORMAT_VERSION,
      datumType: "plane",
      definition: "originFrame",
      origin: [1, 2, 3],
      normal: [0, 0, 2],
      xAxis: [0, 3, 0],
    });
  });

  it("round-trips a faceOffset datum plane with its reference verbatim", () => {
    const payload = {
      formatVersion: DATUM_FORMAT_VERSION,
      datumType: "plane" as const,
      definition: "faceOffset" as const,
      reference: faceReference,
      normalAtDefinition: [0, 0, 1] as const,
      offsetMm: -4.5,
    };
    const parsed = parseDatumPayload(payload);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const facePayload = parsed.value;
    if (
      facePayload.datumType !== "plane" ||
      facePayload.definition !== "faceOffset"
    ) {
      throw new Error("expected a plane payload");
    }
    // Serialization copies the payload key-for-key — identity on the data.
    expect(serializeDatumPayload(facePayload)).toEqual(facePayload);
    expect(facePayload.reference).toEqual(faceReference);
    expect(facePayload.offsetMm).toBe(-4.5);
  });

  it("parses every datum kind and definition", () => {
    const payloads: readonly unknown[] = [
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "plane",
        definition: "threePoints",
        origin: [0, 0, 0],
        xAxisPoint: [1, 0, 0],
        yAxisPoint: [0, 1, 0],
      },
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "axis",
        definition: "twoPoints",
        first: [0, 0, 0],
        second: [0, 0, 5],
      },
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "axis",
        definition: "edge",
        reference: faceReference,
      },
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "axis",
        definition: "faceCylinder",
        reference: faceReference,
      },
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "point",
        position: [1, 1, 1],
      },
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "cSys",
        origin: [0, 0, 0],
        xAxis: [1, 0, 0],
        normal: [0, 0, 1],
      },
    ];
    for (const payload of payloads) {
      expect(parseDatumPayload(payload).ok, JSON.stringify(payload)).toBe(true);
    }
  });

  it("rejects a wrong payload stamp predictably", () => {
    const result = parseDatumPayload({
      formatVersion: DATUM_FORMAT_VERSION + 1,
      datumType: "point",
      position: [0, 0, 0],
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: DATUM_ERROR_CODES.versionUnsupported },
    });
  });

  it("rejects unknown kinds and definitions", () => {
    expect(
      parseDatumPayload({
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "torus",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: DATUM_ERROR_CODES.kindInvalid },
    });
    expect(
      parseDatumPayload({
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "plane",
        definition: "magic",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: DATUM_ERROR_CODES.definitionInvalid },
    });
  });

  it("rejects non-finite vectors and offsets", () => {
    expect(
      parseDatumPayload({
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "point",
        position: [0, Number.NaN, 0],
      }),
    ).toMatchObject({
      ok: false,
      error: { code: DATUM_ERROR_CODES.fieldInvalid },
    });
    expect(
      parseDatumPayload({
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "plane",
        definition: "faceOffset",
        reference: faceReference,
        normalAtDefinition: [0, 0, 1],
        offsetMm: Number.POSITIVE_INFINITY,
      }),
    ).toMatchObject({
      ok: false,
      error: { code: DATUM_ERROR_CODES.fieldInvalid },
    });
  });

  it("rejects a reference definition without a plain-object reference", () => {
    expect(
      parseDatumPayload({
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "axis",
        definition: "edge",
        reference: "body_base:edge:2",
      }),
    ).toMatchObject({
      ok: false,
      error: { code: DATUM_ERROR_CODES.referenceInvalid },
    });
  });
});

describe("datum resolution", () => {
  it("orthonormalizes an explicit plane frame and completes the basis", () => {
    const resolved = resolveDatumPayload(
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "plane",
        definition: "originFrame",
        origin: [5, 5, 0],
        normal: [0, 0, 3],
        xAxis: [2, 2, 2],
      },
      resolverStubs,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || resolved.value.datumType !== "plane") return;
    const { plane } = resolved.value;
    expect(plane.normal[0]).toBeCloseTo(0);
    expect(plane.normal[1]).toBeCloseTo(0);
    expect(plane.normal[2]).toBeCloseTo(1);
    // xAxis orthonormalized onto the plane: the (1,1,0)/√2 direction.
    expect(plane.xAxis[0]).toBeCloseTo(Math.SQRT1_2);
    expect(plane.xAxis[1]).toBeCloseTo(Math.SQRT1_2);
    expect(plane.xAxis[2]).toBeCloseTo(0);
    expect(datumDot(plane.normal, plane.xAxis)).toBeCloseTo(0);
    // y completes the right-handed frame: y = z × x.
    const yAxis = datumCross(plane.normal, plane.xAxis);
    expect(yAxis[0]).toBeCloseTo(-Math.SQRT1_2);
    expect(yAxis[1]).toBeCloseTo(Math.SQRT1_2);
    expect(yAxis[2]).toBeCloseTo(0);
  });

  it("resolves a three-point plane with +x toward the second point", () => {
    const resolved = resolveDatumPayload(
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "plane",
        definition: "threePoints",
        origin: [0, 0, 0],
        xAxisPoint: [4, 0, 0],
        yAxisPoint: [4, 3, 0],
      },
      resolverStubs,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || resolved.value.datumType !== "plane") return;
    expect(resolved.value.plane.xAxis).toEqual([1, 0, 0]);
    expect(resolved.value.plane.normal).toEqual([0, 0, 1]);
  });

  it("refuses collinear three-point input with frame-degenerate", () => {
    const resolved = resolveDatumPayload(
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "plane",
        definition: "threePoints",
        origin: [0, 0, 0],
        xAxisPoint: [1, 0, 0],
        yAxisPoint: [2, 0, 0],
      },
      resolverStubs,
    );
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: DATUM_ERROR_CODES.frameDegenerate },
    });
  });

  it("resolves a two-point axis with a unit direction", () => {
    const resolved = resolveDatumPayload(
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "axis",
        definition: "twoPoints",
        first: [1, 1, 1],
        second: [1, 1, 6],
      },
      resolverStubs,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || resolved.value.datumType !== "axis") return;
    expect(resolved.value.axis).toEqual({
      origin: [1, 1, 1],
      direction: [0, 0, 1],
    });
  });

  it("refuses coincident two-point input", () => {
    const resolved = resolveDatumPayload(
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "axis",
        definition: "twoPoints",
        first: [1, 1, 1],
        second: [1, 1, 1],
      },
      resolverStubs,
    );
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: DATUM_ERROR_CODES.frameDegenerate },
    });
  });

  it("resolves a point and a coordinate system frame", () => {
    const point = resolveDatumPayload(
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "point",
        position: [7, 8, 9],
      },
      resolverStubs,
    );
    expect(point.ok).toBe(true);
    if (!point.ok || point.value.datumType !== "point") return;
    expect(point.value.point.position).toEqual([7, 8, 9]);

    const cSys = resolveDatumPayload(
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "cSys",
        origin: [0, 1, 0],
        xAxis: [0, 1, 0],
        normal: [1, 0, 0],
      },
      resolverStubs,
    );
    expect(cSys.ok).toBe(true);
    if (!cSys.ok || cSys.value.datumType !== "cSys") return;
    expect(cSys.value.cSys.xAxis).toEqual([0, 1, 0]);
    expect(cSys.value.cSys.yAxis).toEqual([0, 0, 1]);
    expect(cSys.value.cSys.zAxis).toEqual([1, 0, 0]);
  });

  it("resolves a faceOffset plane through the topology seam and applies the offset", () => {
    const resolver: DatumTopologyResolver = {
      ...resolverStubs,
      facePlane: (reference) => {
        expect(reference).toEqual(faceReference);
        return {
          ok: true,
          value: { origin: [0, 0, 10], normal: [0, 0, 1], xAxis: [1, 0, 0] },
        };
      },
    };
    const resolved = resolveDatumPayload(
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "plane",
        definition: "faceOffset",
        reference: faceReference,
        normalAtDefinition: [0, 0, 1],
        offsetMm: 4,
      },
      resolver,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || resolved.value.datumType !== "plane") return;
    expect(resolved.value.plane.origin).toEqual([0, 0, 14]);
  });

  it("surfaces the resolver's structured failure verbatim for an unresolved face", () => {
    const resolved = resolveDatumPayload(
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "plane",
        definition: "faceOffset",
        reference: faceReference,
        normalAtDefinition: [0, 0, 1],
        offsetMm: 0,
      },
      resolverStubs,
    );
    expect(resolved).toMatchObject({
      ok: false,
      error: { code: DATUM_ERROR_CODES.referenceInvalid },
    });
  });

  it("aligns a re-resolved face whose mesh normal flipped to the definition normal", () => {
    const resolver: DatumTopologyResolver = {
      ...resolverStubs,
      facePlane: () => ({
        ok: true,
        value: { origin: [0, 0, 10], normal: [0, 0, -1], xAxis: [1, 0, 0] },
      }),
    };
    const resolved = resolveDatumPayload(
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "plane",
        definition: "faceOffset",
        reference: faceReference,
        normalAtDefinition: [0, 0, 1],
        offsetMm: 2,
      },
      resolver,
    );
    expect(resolved.ok).toBe(true);
    if (!resolved.ok || resolved.value.datumType !== "plane") return;
    // The frame flips normal AND xAxis (right-handedness preserved) and the
    // offset rides the definition-aligned normal: origin 10 + 2 up.
    expect(resolved.value.plane.normal[0]).toBeCloseTo(0);
    expect(resolved.value.plane.normal[1]).toBeCloseTo(0);
    expect(resolved.value.plane.normal[2]).toBeCloseTo(1);
    expect(resolved.value.plane.xAxis[0]).toBeCloseTo(-1);
    expect(resolved.value.plane.xAxis[1]).toBeCloseTo(0);
    expect(resolved.value.plane.xAxis[2]).toBeCloseTo(0);
    expect(resolved.value.plane.origin[0]).toBeCloseTo(0);
    expect(resolved.value.plane.origin[1]).toBeCloseTo(0);
    expect(resolved.value.plane.origin[2]).toBeCloseTo(12);
  });

  it("routes edge and cylinder-axis definitions through the seam", () => {
    const edgeResolver: DatumTopologyResolver = {
      ...resolverStubs,
      edgeLine: () => ({
        ok: true,
        value: { origin: [0, 0, 0], direction: [1, 0, 0] },
      }),
    };
    const edge = resolveDatumPayload(
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "axis",
        definition: "edge",
        reference: faceReference,
      },
      edgeResolver,
    );
    expect(edge.ok).toBe(true);
    if (!edge.ok || edge.value.datumType !== "axis") return;
    expect(edge.value.axis.direction).toEqual([1, 0, 0]);

    const cylinderResolver: DatumTopologyResolver = {
      ...resolverStubs,
      faceCylinderAxis: () => ({
        ok: true,
        value: { origin: [2, 2, 0], direction: [0, 0, 1] },
      }),
    };
    const cylinder = resolveDatumPayload(
      {
        formatVersion: DATUM_FORMAT_VERSION,
        datumType: "axis",
        definition: "faceCylinder",
        reference: faceReference,
      },
      cylinderResolver,
    );
    expect(cylinder.ok).toBe(true);
    if (!cylinder.ok || cylinder.value.datumType !== "axis") return;
    expect(cylinder.value.axis.origin).toEqual([2, 2, 0]);
  });
});
