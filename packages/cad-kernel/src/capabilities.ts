/**
 * Declared kernel capabilities (Phase 8): what a kernel implementation can
 * actually promise, so callers and later phases can adapt instead of
 * discovering limits through failures.
 *
 * Every flag exists because a later phase branches on it:
 *
 * - `booleans`: whether union/subtract/intersect produce meaningful solids.
 *   A tessellation-only kernel would declare `false` and stay render-only.
 * - `transform*`: which transform kinds the kernel accepts through the
 *   contract's `transform` operation. The Phase 8 contract carries
 *   translation only; rotation and scale flags exist so a kernel that
 *   implements more can declare readiness before the contract input types
 *   grow to carry them.
 * - `exactPrimitiveVolumes`: primitive volumes are analytic (box, sphere,
 *   cylinder, cone), not mesh-discretized. Fake and Manifold both hold this;
 *   a tessellation-only kernel would not.
 * - `exactBooleanVolumes`: boolean volumes are exact (BREP integration),
 *   not estimated. The fake kernel computes boolean volumes by deterministic
 *   voxel quadrature and declares `false`; Manifold computes exact mesh
 *   volumes and declares `true`. Semantic test utilities therefore compare
 *   boolean volumes with documented relative tolerances, never exactly.
 * - `tightBooleanBounds`: bounds of boolean results are the tight
 *   axis-aligned bounding boxes of the true result. The fake kernel returns
 *   conservative containers for subtract/intersect (the target's box, the
 *   operand boxes' intersection) and declares `false`; assertions on boolean
 *   bounds use containment plus tightness only where this flag is set.
 * - `persistentTopology`: faces/edges/vertices keep stable identities across
 *   operations — required for persistent selection and feature references
 *   (`ref_*` ids in cad-core). No current kernel provides it; per the
 *   development plan it arrives with the OpenCascade backend. Declaring it
 *   now keeps the flag vocabulary fixed while every kernel reports `false`.
 */
export interface KernelCapabilities {
  readonly booleans: boolean;
  readonly transformTranslation: boolean;
  readonly transformRotation: boolean;
  readonly transformScale: boolean;
  readonly exactPrimitiveVolumes: boolean;
  readonly exactBooleanVolumes: boolean;
  readonly tightBooleanBounds: boolean;
  readonly persistentTopology: boolean;
}
