/**
 * Tests that the contract suite itself honours kernel capabilities: the
 * boolean assertion helpers branch on `tightBooleanBounds` and
 * `exactBooleanVolumes` (the true branches are exercised here directly — no
 * current kernel declares them), and the full suite passes against a stub
 * kernel that returns deliberately conservative boolean containers while
 * declaring `tightBooleanBounds: false` — the scenario a capability-blind
 * suite would reject.
 */

import { describe, expect, it } from "vitest";
import { ok } from "@slopcad/cad-core";
import type { KernelCapabilities } from "./capabilities";
import type {
  GeometryKernel,
  KernelBounds,
  KernelResult,
  KernelSolid,
} from "./contract";

import {
  assertBooleanBounds,
  assertBooleanVolume,
  CURVED_VOLUME_TOLERANCE,
  defineKernelContractSuite,
} from "./contract-suite";
import {
  createFakeKernel,
  FAKE_BOX_EDGE_TABLE,
  FAKE_BOX_FACE_TABLE,
  FAKE_KERNEL_CAPABILITIES,
} from "./fake-kernel";

/** A capability profile with both branched flags off; tests override one. */
const BASE_CAPABILITIES: KernelCapabilities = {
  booleans: true,
  transformTranslation: true,
  transformRotation: false,
  transformScale: false,
  exactPrimitiveVolumes: true,
  exactBooleanVolumes: false,
  tightBooleanBounds: false,
  persistentTopology: false,
  sweep: false,
  loft: false,
  sheets: false,
  surfaceOps: false,
  thicken: false,
  section: false,
  extrudeTaper: false,
  helix: false,
  fillet: false,
  chamfer: false,
  shell: false,
  mirror: false,
  surfaceArea: false,
  localFaceOps: false,
  sweepWire: false,
  intersectionCurve: false,
  hiddenLineRemoval: false,
};

function capabilities(
  overrides: Partial<
    Pick<KernelCapabilities, "exactBooleanVolumes" | "tightBooleanBounds">
  >,
): KernelCapabilities {
  return { ...BASE_CAPABILITIES, ...overrides };
}

describe("assertBooleanBounds honours tightBooleanBounds", () => {
  const tight: KernelBounds = { min: [0, 0, 0], max: [40, 10, 10] };
  const looser: KernelBounds = { min: [-1, -1, -1], max: [41, 11, 11] };

  it("demands exact equality when the kernel declares tight boolean bounds", () => {
    expect(() =>
      assertBooleanBounds(
        capabilities({ tightBooleanBounds: true }),
        tight,
        tight,
      ),
    ).not.toThrow();
    expect(() =>
      assertBooleanBounds(
        capabilities({ tightBooleanBounds: true }),
        looser,
        tight,
      ),
    ).toThrow(/Bounds mismatch/);
  });

  it("accepts a deliberately looser container when bounds are conservative", () => {
    expect(() =>
      assertBooleanBounds(capabilities({}), looser, tight),
    ).not.toThrow();
  });

  it("still demands containment of the true result when bounds are conservative", () => {
    const shifted: KernelBounds = { min: [1, 1, 1], max: [41, 11, 11] };
    expect(() => assertBooleanBounds(capabilities({}), shifted, tight)).toThrow(
      /do not contain/,
    );
  });
});

describe("assertBooleanVolume honours exactBooleanVolumes", () => {
  it("demands exact agreement when the kernel declares exact boolean volumes", () => {
    expect(() =>
      assertBooleanVolume(
        capabilities({ exactBooleanVolumes: true }),
        2000,
        2000,
      ),
    ).not.toThrow();
    expect(() =>
      assertBooleanVolume(
        capabilities({ exactBooleanVolumes: true }),
        2001,
        2000,
      ),
    ).toThrow(/not within/);
  });

  it("allows the documented band when volumes are estimated", () => {
    const withinBand = 2000 * (1 + CURVED_VOLUME_TOLERANCE / 2);
    expect(() =>
      assertBooleanVolume(capabilities({}), withinBand, 2000),
    ).not.toThrow();
  });

  it("rejects beyond the documented band when volumes are estimated", () => {
    const beyondBand = 2000 * (1 + 2 * CURVED_VOLUME_TOLERANCE);
    expect(() =>
      assertBooleanVolume(capabilities({}), beyondBand, 2000),
    ).toThrow(/not within/);
  });
});

/** Margin (mm) by which the stub's boolean containers exceed the true result. */
const CONTAINER_MARGIN_MM = 1;

/**
 * A stub kernel over the fake kernel that reports the fake's conservative
 * capability profile and returns deliberately looser bounds for every
 * boolean result. A suite that unconditionally demanded exact boolean bounds
 * would fail against it; the branched assertion path must pass.
 */
function createConservativeBoundsStubKernel(): GeometryKernel {
  const inner = createFakeKernel();
  const booleanResults = new Set<KernelSolid>();
  const track = (
    result: KernelResult<KernelSolid>,
  ): KernelResult<KernelSolid> => {
    if (result.ok) booleanResults.add(result.value);
    return result;
  };
  const expanded = (bounds: KernelBounds): KernelBounds => ({
    min: [
      bounds.min[0] - CONTAINER_MARGIN_MM,
      bounds.min[1] - CONTAINER_MARGIN_MM,
      bounds.min[2] - CONTAINER_MARGIN_MM,
    ],
    max: [
      bounds.max[0] + CONTAINER_MARGIN_MM,
      bounds.max[1] + CONTAINER_MARGIN_MM,
      bounds.max[2] + CONTAINER_MARGIN_MM,
    ],
  });
  return {
    ...inner,
    capabilities: {
      ...FAKE_KERNEL_CAPABILITIES,
      tightBooleanBounds: false,
      exactBooleanVolumes: false,
    },
    union: (operands) => track(inner.union(operands)),
    subtract: (target, tools) => track(inner.subtract(target, tools)),
    intersect: (operands) => track(inner.intersect(operands)),
    bounds: (solid) => {
      const result = inner.bounds(solid);
      if (!result.ok || !booleanResults.has(solid)) return result;
      return ok(expanded(result.value));
    },
    dispose: (solid) => {
      booleanResults.delete(solid);
      inner.dispose(solid);
    },
  };
}

defineKernelContractSuite(
  createConservativeBoundsStubKernel,
  "conservative-bounds stub",
  {
    // The stub delegates to the fake kernel, whose fillet and chamfer pass
    // through — the fake's own documented box-edge hint applies verbatim.
    fillet: {
      cornerEdge: [FAKE_BOX_EDGE_TABLE.length - 1],
      oppositeEdges: [
        FAKE_BOX_EDGE_TABLE.length - 1,
        FAKE_BOX_EDGE_TABLE.length - 4,
      ],
    },
    chamfer: {
      cornerEdge: [FAKE_BOX_EDGE_TABLE.length - 1],
      oppositeEdges: [
        FAKE_BOX_EDGE_TABLE.length - 1,
        FAKE_BOX_EDGE_TABLE.length - 4,
      ],
    },
    // The stub's shell also passes through to the fake kernel — the
    // fake's own box-face hint applies verbatim.
    shell: { openFace: FAKE_BOX_FACE_TABLE.length - 1 },
  },
);
