/**
 * Shared section-face measurement over a triangle soup (Phase 46): the
 * mesh kernels' half of the `section` operation's coverage matrix. OCCT
 * measures its cap faces by exact BREP surface integration; a mesh kernel
 * (Manifold, JSCAD) composes the cut with its own exact box boolean and
 * then measures the cut solid's own boundary — the cap triangles are the
 * triangles whose every corner lies in the section plane (within a
 * scale-aware tolerance), and their area and area-weighted centroid are
 * summed exactly over that mesh.
 *
 * This is the "mesh-tessellated-honest" band the contract documents: the
 * value is exact with respect to the kernel's own boundary
 * representation, which for curved targets is that kernel's documented
 * discretization — the same class its own `volume`/`area` measurements
 * carry, never a silently wrong number.
 */

import type { SectionFaceMeasure, Tessellation } from "./contract";

/**
 * The plane-membership tolerance for cap triangles: 1e-9 relative to the
 * soup's own scale (its largest finite coordinate magnitude), with an
 * absolute floor of 1e-9 mm. The composed cut's cap corners sit on the
 * plane to floating-point exactness (the covering box's near face IS the
 * plane), while any real wall stands off by orders of magnitude more —
 * the tolerance separates the two geometry classes, not a judgment call.
 */
export const CAP_FACE_PLANE_TOLERANCE = 1e-9;

/**
 * Measures the cross-section face of an already-cut solid's triangle
 * soup: every triangle whose three corners all lie in the plane (within
 * {@link CAP_FACE_PLANE_TOLERANCE} scaled) contributes its area and its
 * area-weighted centroid. Returns `null` when no triangle qualifies — the
 * measured signature of a plane that misses or grazes the target, which
 * the caller surfaces as the structured `kernel/section-empty`.
 *
 * Pure and deterministic: same soup, same plane, same numbers.
 */
export function capFaceMeasure(
  soup: Tessellation,
  planeOrigin: readonly [number, number, number],
  planeNormal: readonly [number, number, number],
): SectionFaceMeasure | null {
  const positions = soup.positions;
  const indices = soup.indices;
  let scale = 1;
  for (let i = 0; i < positions.length; i += 1) {
    const value = Math.abs(positions[i] ?? 0);
    if (Number.isFinite(value) && value > scale) scale = value;
  }
  const tolerance = CAP_FACE_PLANE_TOLERANCE * scale;
  const distanceOf = (base: number): number =>
    planeNormal[0] * (positions[base] ?? 0) +
    planeNormal[1] * (positions[base + 1] ?? 0) +
    planeNormal[2] * (positions[base + 2] ?? 0) -
    (planeNormal[0] * planeOrigin[0] +
      planeNormal[1] * planeOrigin[1] +
      planeNormal[2] * planeOrigin[2]);
  let area = 0;
  let cx = 0;
  let cy = 0;
  let cz = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const i0 = (indices[t] ?? 0) * 3;
    const i1 = (indices[t + 1] ?? 0) * 3;
    const i2 = (indices[t + 2] ?? 0) * 3;
    if (
      Math.abs(distanceOf(i0)) > tolerance ||
      Math.abs(distanceOf(i1)) > tolerance ||
      Math.abs(distanceOf(i2)) > tolerance
    ) {
      continue;
    }
    const ax = positions[i0] ?? 0;
    const ay = positions[i0 + 1] ?? 0;
    const az = positions[i0 + 2] ?? 0;
    const bx = positions[i1] ?? 0;
    const by = positions[i1 + 1] ?? 0;
    const bz = positions[i1 + 2] ?? 0;
    const cxp = positions[i2] ?? 0;
    const cyp = positions[i2 + 1] ?? 0;
    const czp = positions[i2 + 2] ?? 0;
    const ux = bx - ax;
    const uy = by - ay;
    const uz = bz - az;
    const vx = cxp - ax;
    const vy = cyp - ay;
    const vz = czp - az;
    const crossX = uy * vz - uz * vy;
    const crossY = uz * vx - ux * vz;
    const crossZ = ux * vy - uy * vx;
    const triangleArea = Math.hypot(crossX, crossY, crossZ) / 2;
    if (!(triangleArea > 0)) continue;
    area += triangleArea;
    cx += ((ax + bx + cxp) / 3) * triangleArea;
    cy += ((ay + by + cyp) / 3) * triangleArea;
    cz += ((az + bz + czp) / 3) * triangleArea;
  }
  if (!(area > 0)) return null;
  return {
    areaMm2: area,
    centroidMm: [cx / area, cy / area, cz / area],
  };
}
