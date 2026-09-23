/**
 * Phase 52 explode-state fixtures: the serialization round-trip, the
 * deterministic scrub application, the offset/radial precedence, and the
 * structured refusals.
 */

import { describe, expect, it } from "vitest";

import {
  applyExplodeState,
  ASSEMBLY_EXPLODE_ERROR_CODES,
  createOccurrenceId,
  IDENTITY_PLACEMENT_TRANSFORM,
  parseExplodeState,
  radialExplodeOffsets,
  serializeExplodeState,
  type AssemblyExplodeInstance,
  type AssemblyExplodeState,
  type DatumVec3,
  type PlacementTransform,
} from "./index";

const PATH_A = [createOccurrenceId("occ_explode_a")] as const;
const PATH_B = [createOccurrenceId("occ_explode_b")] as const;

const dir = (x: number, y: number, z: number): DatumVec3 => [x, y, z];
const placedAt = (translation: DatumVec3): PlacementTransform => ({
  rotation: IDENTITY_PLACEMENT_TRANSFORM.rotation,
  translation,
});

/** Two instances at (10, 0, 0) and (−10, 0, 0), placed at their centroids. */
function fixtureInstances(): readonly AssemblyExplodeInstance[] {
  return [
    { path: [...PATH_A], centroid: [10, 0, 0] },
    { path: [...PATH_B], centroid: [-10, 0, 0] },
  ];
}

function fixtureTransforms(): ReadonlyMap<string, PlacementTransform> {
  return new Map([
    [PATH_A.join(">"), placedAt([10, 0, 0])],
    [PATH_B.join(">"), placedAt([-10, 0, 0])],
  ]);
}

describe("explode state round-trip", () => {
  it("parse(serialize(state)) preserves the state's meaning", () => {
    const state: AssemblyExplodeState = {
      entries: [
        {
          path: [...PATH_A],
          offset: { direction: dir(1, 0, 0), distanceMm: 40 },
        },
        {
          path: [...PATH_B],
          offset: { direction: dir(-1, 0, 0), distanceMm: 40 },
        },
      ],
    };
    const parsed = parseExplodeState(serializeExplodeState(state));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.entries).toHaveLength(2);
    expect(parsed.value.entries[0]?.path).toEqual(PATH_A);
    expect(parsed.value.entries[0]?.offset).toEqual({
      direction: dir(1, 0, 0),
      distanceMm: 40,
    });
    expect(parsed.value.radialDistanceMm).toBeUndefined();
    // Byte-determinism: the canonical JSON of the round-tripped state equals
    // the canonical JSON of the original.
    expect(JSON.stringify(serializeExplodeState(parsed.value))).toBe(
      JSON.stringify(serializeExplodeState(state)),
    );
  });

  it("normalizes directions on both write and read, so hand-built states round-trip", () => {
    const state: AssemblyExplodeState = {
      entries: [
        {
          path: [...PATH_A],
          offset: { direction: dir(3, 4, 0), distanceMm: 10 },
        },
      ],
    };
    const parsed = parseExplodeState(serializeExplodeState(state));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.entries[0]?.offset.direction).toEqual(dir(0.6, 0.8, 0));
  });

  it("refuses malformed states with structured codes", () => {
    const missingEntries = parseExplodeState({});
    expect(missingEntries).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_EXPLODE_ERROR_CODES.stateMalformed },
    });
    const badPath = parseExplodeState({
      entries: [
        {
          path: ["not-an-occurrence-id"],
          offset: { direction: dir(1, 0, 0), distanceMm: 1 },
        },
      ],
    });
    expect(badPath).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_EXPLODE_ERROR_CODES.stateMalformed },
    });
    const zeroDirection = parseExplodeState({
      entries: [
        {
          path: [...PATH_A],
          offset: { direction: dir(0, 0, 0), distanceMm: 1 },
        },
      ],
    });
    expect(zeroDirection).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_EXPLODE_ERROR_CODES.offsetInvalid },
    });
    const negativeRadial = parseExplodeState({
      entries: [],
      radialDistanceMm: -5,
    });
    expect(negativeRadial).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_EXPLODE_ERROR_CODES.stateMalformed },
    });
  });
});

describe("the deterministic scrub", () => {
  it("t=0 is the assembled pose, t=1 the authored offsets, t=0.5 halfway", () => {
    const state: AssemblyExplodeState = {
      entries: [
        {
          path: [...PATH_A],
          offset: { direction: dir(1, 0, 0), distanceMm: 40 },
        },
      ],
    };
    const instances = fixtureInstances();
    const transforms = fixtureTransforms();
    const assembled = applyExplodeState({
      state,
      instances,
      transforms,
      factor: 0,
      centroid: [0, 0, 0],
    });
    expect(assembled.ok).toBe(true);
    if (!assembled.ok) return;
    expect(assembled.value.get(PATH_A.join(">"))?.translation).toEqual([
      10, 0, 0,
    ]);
    const halfway = applyExplodeState({
      state,
      instances,
      transforms,
      factor: 0.5,
      centroid: [0, 0, 0],
    });
    expect(halfway.ok).toBe(true);
    if (!halfway.ok) return;
    expect(halfway.value.get(PATH_A.join(">"))?.translation).toEqual([
      30, 0, 0,
    ]);
    const full = applyExplodeState({
      state,
      instances,
      transforms,
      factor: 1,
      centroid: [0, 0, 0],
    });
    expect(full.ok).toBe(true);
    if (!full.ok) return;
    expect(full.value.get(PATH_A.join(">"))?.translation).toEqual([50, 0, 0]);
  });

  it("the same factor always yields bitwise-identical transforms (scrub determinism)", () => {
    const state: AssemblyExplodeState = {
      entries: [
        {
          path: [...PATH_A],
          offset: { direction: dir(1, 0, 0), distanceMm: 40 },
        },
      ],
      radialDistanceMm: 30,
    };
    const scrub = (): string => {
      const applied = applyExplodeState({
        state,
        instances: fixtureInstances(),
        transforms: fixtureTransforms(),
        factor: 0.37,
        centroid: [0, 0, 0],
      });
      expect(applied.ok).toBe(true);
      if (!applied.ok) return "";
      return JSON.stringify([...applied.value.entries()]);
    };
    expect(scrub()).toBe(scrub());
  });

  it("explicit entries win over the radial rule for their paths", () => {
    const state: AssemblyExplodeState = {
      entries: [
        {
          path: [...PATH_A],
          offset: { direction: dir(0, 1, 0), distanceMm: 100 },
        },
      ],
      radialDistanceMm: 25,
    };
    const applied = applyExplodeState({
      state,
      instances: fixtureInstances(),
      transforms: fixtureTransforms(),
      factor: 1,
      centroid: [0, 0, 0],
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    // A's explicit offset overrides its radial (radial would be +x).
    expect(applied.value.get(PATH_A.join(">"))?.translation).toEqual([
      10, 100, 0,
    ]);
    // B falls through to the radial rule: from the centroid (0,0,0) through
    // (−10, 0, 0), i.e. −x, 25 mm.
    expect(applied.value.get(PATH_B.join(">"))?.translation).toEqual([
      -35, 0, 0,
    ]);
  });

  it("factors outside [0, 1] clamp; non-finite factors refuse", () => {
    const state: AssemblyExplodeState = {
      entries: [
        {
          path: [...PATH_A],
          offset: { direction: dir(1, 0, 0), distanceMm: 40 },
        },
      ],
    };
    const clamped = applyExplodeState({
      state,
      instances: fixtureInstances(),
      transforms: fixtureTransforms(),
      factor: 7,
      centroid: [0, 0, 0],
    });
    expect(clamped.ok).toBe(true);
    if (!clamped.ok) return;
    expect(clamped.value.get(PATH_A.join(">"))?.translation).toEqual([
      50, 0, 0,
    ]);
    const refused = applyExplodeState({
      state,
      instances: fixtureInstances(),
      transforms: fixtureTransforms(),
      factor: Number.NaN,
      centroid: [0, 0, 0],
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { code: ASSEMBLY_EXPLODE_ERROR_CODES.factorInvalid },
    });
  });
});

describe("radial auto-explode derivation", () => {
  it("derives directions from the centroid through each instance", () => {
    const offsets = radialExplodeOffsets(fixtureInstances(), [0, 0, 0], 20);
    expect(offsets.get(PATH_A.join(">"))).toEqual({
      direction: dir(1, 0, 0),
      distanceMm: 20,
    });
    expect(offsets.get(PATH_B.join(">"))).toEqual({
      direction: dir(-1, 0, 0),
      distanceMm: 20,
    });
  });

  it("an instance AT the centroid gets no radial direction (never a NaN)", () => {
    const offsets = radialExplodeOffsets(
      [{ path: [...PATH_A], centroid: [5, 5, 5] }],
      [5, 5, 5],
      20,
    );
    expect(offsets.has(PATH_A.join(">"))).toBe(false);
  });
});
