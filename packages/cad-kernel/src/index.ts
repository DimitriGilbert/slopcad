/**
 * Public entry of `@slopcad/cad-kernel`, the pluggable geometry-kernel
 * abstraction (Phase 8). This package is React-free and UI-free; concrete
 * kernel adapters implement the contracts exported here.
 *
 * Surfaces:
 *
 * - `./contract` — the kernel-independent geometry contract (operations,
 *   inputs, measurements, structured errors).
 * - `./capabilities` — the declared-capability flags kernels report.
 * - `./opaque` — the opaque solid-handle type (and, for kernel implementers
 *   only, the handle-minting `createSolidTag`).
 * - `./fake-kernel` — the deterministic fake kernel.
 * - `./test-utils` — kernel-neutral semantic geometry assertions.
 * - `./contract-suite` — the shared suite any conforming kernel must pass.
 * - `./core-bridge` — the cad-core feature-executor bridge that executes a
 *   document's features against a kernel.
 */

export { KERNEL_BACKEND_IDS } from "./backend-ids";
export type { KernelBackendId } from "./backend-ids";

export type { KernelCapabilities } from "./capabilities";

export { KERNEL_ERROR_CODES, tessellationTriangleCount } from "./contract";
export type {
  BoxInput,
  ConeInput,
  CylinderInput,
  GeometryKernel,
  KernelBounds,
  KernelError,
  KernelErrorCode,
  KernelResult,
  SphereInput,
  Tessellation,
  TranslationInput,
} from "./contract";
export type { KernelSolid } from "./contract";

export {
  createFakeKernel,
  FAKE_KERNEL_CAPABILITIES,
  FAKE_KERNEL_ID,
  FAKE_KERNEL_VOLUME_RESOLUTION,
  FAKE_KERNEL_TESSELLATION_SEGMENTS,
  FAKE_KERNEL_TESSELLATION_RINGS,
  FAKE_BOX_TRIANGLE_COUNT,
} from "./fake-kernel";

export { createSolidTag } from "./opaque";
export type { SolidTag } from "./opaque";

export { defineKernelContractSuite } from "./contract-suite";

export {
  createKernelFeatureExecutor,
  BRIDGE_FEATURE_KINDS,
} from "./core-bridge";
export type {
  BridgeFeatureKind,
  KernelExecutionBridge,
  KernelExecutorContext,
} from "./core-bridge";

export {
  assertBoundsContain,
  assertBoundsEqual,
  assertTessellationValid,
  assertVolumeClose,
  assertVolumeLessThan,
  DEFAULT_BOUNDS_TOLERANCE_MM,
  expectKernelFailure,
  unwrapKernelResult,
} from "./test-utils";
export type { TessellationValidityOptions } from "./test-utils";
