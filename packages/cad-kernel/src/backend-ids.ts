/**
 * Canonical identifiers of the geometry kernel backends the kernel
 * abstraction targets: Manifold is the first production kernel, OpenCascade
 * the later advanced BREP/STEP backend, and JSCAD the compatibility backend.
 * `fake` is the deterministic fake kernel (Phase 8) that implements the full
 * contract for fast, dependency-free tests and the contract suite itself.
 */
export const KERNEL_BACKEND_IDS = [
  "manifold",
  "opencascade",
  "jscad",
  "fake",
] as const;

/** Identifier of a geometry kernel backend. */
export type KernelBackendId = (typeof KERNEL_BACKEND_IDS)[number];
