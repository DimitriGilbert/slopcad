/**
 * Assembly interference detection tests (Phase 51): the deterministic
 * pairwise batch — bounding-box pre-filter, exact-volume pairs, tolerance
 * rule, kernel-declined skips, structured refusals — plus the walk-to-
 * report integration over a real Phase 50 instance resolution.
 */

import { describe, expect, it } from "vitest";

import {
  addBody,
  addOccurrence,
  checkAssemblyInterference,
  checkResolvedAssemblyInterference,
  createBodyId,
  createDocument,
  createDocumentId,
  createOccurrenceId,
  IDENTITY_PLACEMENT_TRANSFORM,
  resolveAssemblyInstances,
  type InterferenceInstance,
  type InterferenceVolumeFn,
  type OccurrenceId,
  type PlacementTransform,
} from "./index";

const UNIT_BOX_BOUNDS = { min: [0, 0, 0] as const, max: [10, 10, 10] as const };

function translate(x: number, y: number, z: number): PlacementTransform {
  return {
    rotation: IDENTITY_PLACEMENT_TRANSFORM.rotation,
    translation: [x, y, z],
  };
}

function instance(
  path: readonly string[],
  transform: PlacementTransform,
  bodyId = "body_block",
): InterferenceInstance {
  return {
    path: path.map((segment): OccurrenceId =>
      createOccurrenceId(`occ_${segment}`),
    ),
    bodyId: createBodyId(bodyId),
    transform,
    bounds: UNIT_BOX_BOUNDS,
  };
}

/**
 * The exact analytic seam for axis-aligned unit test boxes: the boolean
 * intersection volume of two boxes is the product of the per-axis
 * overlaps of their WORLD boxes (the local box under a translation).
 */
function analyticBoxVolume(
  first: InterferenceInstance,
  second: InterferenceInstance,
): number | null {
  const overlap = (aMin: number, aMax: number, bMin: number, bMax: number) =>
    Math.max(0, Math.min(aMax, bMax) - Math.max(aMin, bMin));
  const world = (instance_: InterferenceInstance, axis: 0 | 1 | 2) => ({
    min: instance_.bounds.min[axis] + instance_.transform.translation[axis],
    max: instance_.bounds.max[axis] + instance_.transform.translation[axis],
  });
  let volume = 1;
  for (const axis of [0, 1, 2] as const) {
    const a = world(first, axis);
    const b = world(second, axis);
    volume *= overlap(a.min, a.max, b.min, b.max);
  }
  return volume;
}

const seamFrom =
  (instances: readonly InterferenceInstance[]): InterferenceVolumeFn =>
  (a, b) => {
    const find = (bodyId: string, transform: PlacementTransform) =>
      instances.find(
        (candidate) =>
          candidate.bodyId === bodyId && candidate.transform === transform,
      );
    const first = find(a.bodyId, a.transform);
    const second = find(b.bodyId, b.transform);
    if (first === undefined || second === undefined) return null;
    return analyticBoxVolume(first, second);
  };

describe("assembly interference batch", () => {
  it("detects overlapping boxes with the exact intersection volume", () => {
    const instances = [
      instance(["root"], IDENTITY_PLACEMENT_TRANSFORM),
      instance(["moved"], translate(5, 0, 0)),
    ];
    const report = checkAssemblyInterference({
      instances,
      intersectVolume: seamFrom(instances),
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checkedPairs).toBe(1);
    expect(report.value.pairs).toHaveLength(1);
    const pair = report.value.pairs[0];
    expect(pair).toBeDefined();
    if (pair === undefined) return;
    // Two 10mm boxes offset 5mm along x overlap in a 5 x 10 x 10 slab.
    expect(pair.volume).toBe(500);
    expect(pair.firstPath).toEqual([createOccurrenceId("occ_root")]);
    expect(pair.secondPath).toEqual([createOccurrenceId("occ_moved")]);
    expect(pair.firstBounds.min).toEqual([0, 0, 0]);
    expect(pair.firstBounds.max).toEqual([10, 10, 10]);
    expect(pair.secondBounds.min).toEqual([5, 0, 0]);
    expect(pair.secondBounds.max).toEqual([15, 10, 10]);
  });

  it("skips provably disjoint pairs before the kernel is ever asked", () => {
    const instances = [
      instance(["root"], IDENTITY_PLACEMENT_TRANSFORM),
      instance(["far"], translate(1000, 0, 0)),
    ];
    let seamCalls = 0;
    const report = checkAssemblyInterference({
      instances,
      intersectVolume: (a, b) => {
        seamCalls += 1;
        return seamFrom(instances)(a, b);
      },
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.pairs).toHaveLength(0);
    expect(report.value.checkedPairs).toBe(0);
    expect(seamCalls).toBe(0);
  });

  it("treats touching at or below the tolerance as not interfering", () => {
    const instances = [
      instance(["root"], IDENTITY_PLACEMENT_TRANSFORM),
      instance(["touching"], translate(10, 0, 0)),
    ];
    const report = checkAssemblyInterference({
      instances,
      intersectVolume: seamFrom(instances),
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checkedPairs).toBe(1);
    expect(report.value.pairs).toHaveLength(0);
  });

  it("records kernel-declined pairs instead of folding them into clear", () => {
    const report = checkAssemblyInterference({
      instances: [
        instance(["root"], IDENTITY_PLACEMENT_TRANSFORM),
        instance(["moved"], translate(5, 0, 0)),
      ],
      intersectVolume: () => null,
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.pairs).toHaveLength(0);
    expect(report.value.skipped).toEqual([
      {
        firstPath: [createOccurrenceId("occ_root")],
        secondPath: [createOccurrenceId("occ_moved")],
        reason: "kernel-declined",
      },
    ]);
  });

  it("refuses malformed instances structurally", () => {
    const emptyPath = checkAssemblyInterference({
      instances: [{ ...instance([], IDENTITY_PLACEMENT_TRANSFORM) }],
      intersectVolume: () => null,
    });
    expect(emptyPath).toMatchObject({
      ok: false,
      error: { code: "assembly/interference-malformed" },
    });
    const inverted = checkAssemblyInterference({
      instances: [
        {
          ...instance(["root"], IDENTITY_PLACEMENT_TRANSFORM),
          bounds: { min: [5, 0, 0] as const, max: [0, 10, 10] as const },
        },
      ],
      intersectVolume: () => null,
    });
    expect(inverted).toMatchObject({
      ok: false,
      error: { code: "assembly/interference-malformed" },
    });
  });

  it("reports identically for identical inputs (deterministic batch order)", () => {
    const instances = [
      instance(["root"], IDENTITY_PLACEMENT_TRANSFORM),
      instance(["moved"], translate(5, 0, 0)),
      instance(["other"], translate(0, 5, 0)),
    ];
    const run = () =>
      checkAssemblyInterference({
        instances,
        intersectVolume: seamFrom(instances),
      });
    const first = run();
    const second = run();
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(JSON.stringify(first.value)).toBe(JSON.stringify(second.value));
  });

  it("runs over a real instance resolution end to end", () => {
    let document = createDocument(createDocumentId("doc_interference"));
    const withBlock = addBody(document, { name: "Block" });
    expect(withBlock.ok).toBe(true);
    if (!withBlock.ok) return;
    document = withBlock.value.document;
    const blockId = document.bodies[0]?.id;
    expect(blockId).toBeDefined();
    if (blockId === undefined) return;
    const first = addOccurrence(document, {
      name: "Base",
      source: { kind: "body", bodyId: blockId },
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = addOccurrence(first.value.document, {
      name: "Overlapping",
      source: { kind: "body", bodyId: blockId },
      placement: { kind: "offset", translation: [5, 0, 0] },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    const resolution = resolveAssemblyInstances(second.value.document);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) return;
    expect(resolution.instances).toHaveLength(2);
    const instances: InterferenceInstance[] = resolution.instances.map(
      (placed) => ({
        path: placed.path,
        bodyId: placed.bodyId,
        transform: placed.transform,
        bounds: UNIT_BOX_BOUNDS,
      }),
    );
    const report = checkResolvedAssemblyInterference({
      instances,
      boundsOf: () => UNIT_BOX_BOUNDS,
      intersectVolume: seamFrom(instances),
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.pairs).toHaveLength(1);
    const pair = report.value.pairs[0];
    expect(pair?.volume).toBe(500);
    expect(pair?.firstPath).toEqual([first.value.occurrence.id]);
    expect(pair?.secondPath).toEqual([second.value.occurrence.id]);
  });

  it("refuses the resolved form when a body has no supplied bounds", () => {
    const report = checkResolvedAssemblyInterference({
      instances: [
        {
          path: [createOccurrenceId("occ_root")],
          bodyId: createBodyId("body_block"),
          transform: IDENTITY_PLACEMENT_TRANSFORM,
        },
      ],
      boundsOf: () => undefined,
      intersectVolume: () => null,
    });
    expect(report).toMatchObject({
      ok: false,
      error: { code: "assembly/interference-malformed" },
    });
  });
});
