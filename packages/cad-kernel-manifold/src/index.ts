/**
 * Public entry of `@slopcad/cad-kernel-manifold`, the Manifold geometry
 * kernel adapter (Phase 9). It depends only on the kernel abstraction,
 * cad-core's dimensional values, and the Manifold runtime — never on React
 * or UI. No Manifold type crosses this surface: the runtime handle is
 * opaque, and geometry travels exclusively as kernel-neutral solids and
 * measurements.
 */

export { MANIFOLD_BACKEND_ID } from "./manifold-backend";

export {
  MANIFOLD_KERNEL_CAPABILITIES,
  MANIFOLD_NORMALS_MIN_SHARP_ANGLE_DEGREES,
  createManifoldKernel,
  manifoldKernelFromRuntime,
} from "./manifold-kernel";

export {
  buildBooleanChain,
  buildPlateWithHole,
  BOOLEAN_CHAIN,
  PLATE_WITH_HOLE,
} from "./manifold-fixtures";
export type {
  BooleanChainFixture,
  PlateWithHoleFixture,
} from "./manifold-fixtures";

export { createManifoldRuntime } from "./manifold-runtime";
export type { ManifoldRuntime } from "./manifold-runtime";
