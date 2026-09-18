/**
 * OCCT-adapter-specific semantic geometry fixtures (Phase 21.1): the same
 * kernel-neutral scenes and analytic expectations the Manifold adapter's
 * fixtures judge it by (kept as a mirrored copy rather than a cross-adapter
 * dependency, so each kernel package stands alone for cross-kernel runs).
 * Everything here is kernel-neutral — fixtures build through the
 * {@link GeometryKernel} interface only.
 *
 * Judgement follows the plan's semantic rule: volumes against analytic
 * formulas within documented tolerances — exact bands (1e-9) where OCCT's
 * BREP integration is exact, which is everywhere the geometry is analytic:
 * the plate-with-hole measures its box-minus-cylinder volume at 0 relative
 * error (probed), unlike Manifold's mesh-divergence band.
 */

import { length } from "@slopcad/cad-core";
import type {
  GeometryKernel,
  KernelBounds,
  KernelSolid,
} from "@slopcad/cad-kernel";
import { unwrapKernelResult } from "@slopcad/cad-kernel";

function boxOf(
  kernel: GeometryKernel,
  width: number,
  depth: number,
  height: number,
): KernelSolid {
  return unwrapKernelResult(
    kernel.createBox({
      width: length(width),
      depth: length(depth),
      height: length(height),
    }),
    "createBox",
  );
}

function translated(
  kernel: GeometryKernel,
  solid: KernelSolid,
  x: number,
  y: number,
  z: number,
): KernelSolid {
  return unwrapKernelResult(
    kernel.transform(solid, { x: length(x), y: length(y), z: length(z) }),
    "transform",
  );
}

/**
 * The plate-with-hole scene from the Phase 1.6 spike (and the Phase 21
 * binding pre-spike): a 30×20×10 plate with a ⌀8 through-bore at (15, 10).
 * All faces of the true result lie on the plate's box, so bounds are exact;
 * OCCT integrates the curved bore exactly, so the volume compares against
 * the analytic box-minus-cylinder value inside the EXACT band (probed at 0
 * relative error — the pre-spike's headline exactness result).
 */
export interface PlateWithHoleFixture {
  readonly plate: KernelSolid;
  readonly bore: KernelSolid;
  readonly result: KernelSolid;
  /** Analytic plate volume minus the analytic cylinder, mm³. */
  readonly analyticVolumeMm3: number;
  /**
   * The analytic plate surface area (Phase 27.4): the box faces minus the
   * two bore-circle openings plus the cylinder wall — `2(wd+dh+wh) − 2πr²
   * + 2πrh`, mm² (probed EXACT under the BREP surface integration).
   */
  readonly analyticAreaMm2: number;
  /** The true tight bounds of the drilled plate. */
  readonly tightBounds: KernelBounds;
}

/** Dimensions of the plate-with-hole scene, in canonical millimetres. */
export const PLATE_WITH_HOLE = {
  widthMm: 30,
  depthMm: 20,
  heightMm: 10,
  boreRadiusMm: 4,
  boreCenterXYMm: [15, 10] as const,
} as const;

export function buildPlateWithHole(
  kernel: GeometryKernel,
): PlateWithHoleFixture {
  const plate = boxOf(
    kernel,
    PLATE_WITH_HOLE.widthMm,
    PLATE_WITH_HOLE.depthMm,
    PLATE_WITH_HOLE.heightMm,
  );
  const [boreX, boreY] = PLATE_WITH_HOLE.boreCenterXYMm;
  const bore = translated(
    kernel,
    unwrapKernelResult(
      kernel.createCylinder({
        radius: length(PLATE_WITH_HOLE.boreRadiusMm),
        height: length(PLATE_WITH_HOLE.heightMm),
      }),
      "createCylinder",
    ),
    boreX,
    boreY,
    0,
  );
  const result = unwrapKernelResult(kernel.subtract(plate, [bore]), "subtract");
  const { widthMm, depthMm, heightMm, boreRadiusMm } = PLATE_WITH_HOLE;
  return {
    plate,
    bore,
    result,
    analyticVolumeMm3:
      widthMm * depthMm * heightMm - Math.PI * boreRadiusMm ** 2 * heightMm,
    analyticAreaMm2:
      2 * (widthMm * depthMm + widthMm * heightMm + depthMm * heightMm) -
      2 * Math.PI * boreRadiusMm ** 2 +
      2 * Math.PI * boreRadiusMm * heightMm,
    tightBounds: {
      min: [0, 0, 0],
      max: [widthMm, depthMm, heightMm],
    },
  };
}

/**
 * A boolean chain exercising every contract boolean plus translation on
 * one scene: two disjoint 10³ blocks (x ∈ [0,10] and [30,40]) unioned, a
 * ⌀6 bore drilled through the left block only, then intersected with a
 * clipping box that drops the untouched right block entirely.
 *
 * Every step is analytic to OCCT's BREP integration, so all volumes are
 * judged in the exact band; all bounds are the tight boxes of the true
 * results.
 */
export interface BooleanChainFixture {
  readonly left: KernelSolid;
  readonly right: KernelSolid;
  readonly union: KernelSolid;
  readonly cut: KernelSolid;
  readonly trimmed: KernelSolid;
  /** Exact expected union volume: two disjoint 10³ blocks, mm³. */
  readonly unionVolumeMm3: number;
  /** Analytic union volume minus the analytic bore, mm³. */
  readonly cutAnalyticVolumeMm3: number;
  /** Analytic left-block volume minus the analytic bore, mm³. */
  readonly trimmedAnalyticVolumeMm3: number;
  /** Tight bounds of the union step. */
  readonly unionTightBounds: KernelBounds;
  /** Tight bounds of the trimmed result (the left block alone). */
  readonly trimmedTightBounds: KernelBounds;
}

/** Dimensions of the boolean-chain scene, in canonical millimetres. */
export const BOOLEAN_CHAIN = {
  blockEdgeMm: 10,
  /** x offset placing the right block disjointly at x ∈ [30, 40]. */
  blockOffsetMm: 30,
  boreRadiusMm: 3,
  /** Clip width dropping the right block: covers x ∈ [0, 20] only. */
  clipWidthMm: 20,
} as const;

export function buildBooleanChain(kernel: GeometryKernel): BooleanChainFixture {
  const { blockEdgeMm, blockOffsetMm, boreRadiusMm, clipWidthMm } =
    BOOLEAN_CHAIN;
  const left = boxOf(kernel, blockEdgeMm, blockEdgeMm, blockEdgeMm);
  const right = translated(
    kernel,
    boxOf(kernel, blockEdgeMm, blockEdgeMm, blockEdgeMm),
    blockOffsetMm,
    0,
    0,
  );
  const union = unwrapKernelResult(kernel.union([left, right]), "union");
  const bore = translated(
    kernel,
    unwrapKernelResult(
      kernel.createCylinder({
        radius: length(boreRadiusMm),
        height: length(blockEdgeMm),
      }),
      "createCylinder",
    ),
    blockEdgeMm / 2,
    blockEdgeMm / 2,
    0,
  );
  const cut = unwrapKernelResult(kernel.subtract(union, [bore]), "subtract");
  const clip = boxOf(kernel, clipWidthMm, blockEdgeMm, blockEdgeMm);
  const trimmed = unwrapKernelResult(
    kernel.intersect([cut, clip]),
    "intersect",
  );
  const blockVolume = blockEdgeMm ** 3;
  const boreVolume = Math.PI * boreRadiusMm ** 2 * blockEdgeMm;
  const unionTightBounds: KernelBounds = {
    min: [0, 0, 0],
    max: [blockOffsetMm + blockEdgeMm, blockEdgeMm, blockEdgeMm],
  };
  return {
    left,
    right,
    union,
    cut,
    trimmed,
    unionVolumeMm3: 2 * blockVolume,
    cutAnalyticVolumeMm3: 2 * blockVolume - boreVolume,
    trimmedAnalyticVolumeMm3: blockVolume - boreVolume,
    unionTightBounds,
    trimmedTightBounds: {
      min: [0, 0, 0],
      max: [blockEdgeMm, blockEdgeMm, blockEdgeMm],
    },
  };
}
