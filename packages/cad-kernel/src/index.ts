/**
 * Public entry of `@slopcad/cad-kernel`, the pluggable geometry-kernel
 * abstraction. This package is React-free and UI-free; concrete kernel
 * adapters implement against the contracts exported here.
 */
export { KERNEL_BACKEND_IDS } from "./backend-ids";
export type { KernelBackendId } from "./backend-ids";
