/**
 * Manifold-specific semantic geometry fixtures (Phase 9): the kernel-
 * neutral scenes and analytic expectations the adapter's own tests judge
 * it by, beyond what the shared contract suite already proves. Everything
 * here is kernel-neutral — fixtures build through the {@link GeometryKernel}
 * interface only, so the same scenes could judge any future kernel.
 *
 * Judgement follows the plan's semantic rule: volumes against analytic
 * formulas within documented tolerances (exact bands only where geometry
 * is axis-aligned, curved bands where a polygonal bore deviates from π),
 * bounds exact where Manifold declares tight boolean bounds.
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
 * The plate-with-hole scene from the Phase 1.6 spike: a 30×20×10 plate
 * with a ⌀8 through-bore at (15, 10). All faces of the true result lie on
 * the plate's box, so bounds are exact; the bore is curved, so volume
 * compares against the analytic box-minus-cylinder value within the
 * curved tolerance (the polygonal bore slightly undercuts πr²h).
 */
export interface PlateWithHoleFixture {
  readonly plate: KernelSolid;
  readonly bore: KernelSolid;
  readonly result: KernelSolid;
  /** Analytic plate volume minus the analytic cylinder, mm³. */
  readonly analyticVolumeMm3: number;
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
 * The union step is axis-aligned, so its volume and bounds are judged
 * exactly (Manifold declares exact boolean volumes and tight boolean
 * bounds). The drilled and trimmed steps carry the curved bore, so their
 * volumes use the curved tolerance band; the trimmed bounds stay exact —
 * every face of the result lies on the clip or block faces.
 */
export interface BooleanChainFixture {
  readonly left: KernelSolid;
  readonly right: KernelSolid;
  readonly union: KernelSolid;
  readonly cut: KernelSolid;
  readonly trimmed: KernelSolid;
  /** Exact expected union volume: two disjoint 10³ blocks, mm³. */
  readonly unionVolumeMm3: number;
  /** Analytic union volume minus the analytic bore, mm³ (curved band). */
  readonly cutAnalyticVolumeMm3: number;
  /** Analytic left-block volume minus the analytic bore, mm³ (curved band). */
  readonly trimmedAnalyticVolumeMm3: number;
  /** Tight bounds of the union and drilled steps. */
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
