/**
 * Canonical identifiers of the geometry kernel backends the kernel
 * abstraction targets, as fixed by the development plan: Manifold is the
 * first production kernel, OpenCascade the later advanced BREP/STEP
 * backend, and JSCAD the compatibility backend.
 */
export const KERNEL_BACKEND_IDS = [
  "manifold",
  "opencascade",
  "jscad",
] as const;

/** Identifier of a geometry kernel backend. */
export type KernelBackendId = (typeof KERNEL_BACKEND_IDS)[number];
