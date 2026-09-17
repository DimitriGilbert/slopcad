/**
 * Public entry of `@slopcad/cad-jscad`, the JSCAD geometry kernel adapter
 * (Phase 23) — the compatibility/reference backend, deliberately one layer
 * lower than the native model: it depends only on the kernel abstraction,
 * cad-core's dimensional values, and the pure-JavaScript `@jscad/modeling`
 * library. No JSCAD type crosses this surface: geometry travels exclusively
 * as kernel-neutral solids and measurements. No worker entry exists for
 * this adapter — JSCAD needs no runtime boot and runs in-process.
 */

export { JSCAD_BACKEND_ID } from "./jscad-backend";

export {
  createJscadKernel,
  JSCAD_CURVED_SEGMENTS,
  JSCAD_KERNEL_CAPABILITIES,
} from "./jscad-kernel";

export {
  buildBooleanChain,
  buildPlateWithHole,
  BOOLEAN_CHAIN,
  PLATE_WITH_HOLE,
} from "./jscad-fixtures";
export type {
  BooleanChainFixture,
  PlateWithHoleFixture,
} from "./jscad-fixtures";
