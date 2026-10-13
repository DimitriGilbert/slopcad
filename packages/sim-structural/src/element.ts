/**
 * The uniform 8-node hexahedral element (Phase 69a): linear elasticity
 * in B-matrix form over an axis-aligned brick of size hx × hy × hz —
 * the element shape every occupied voxel node hosts (`./mesh`). All
 * quadrature is the 2×2×2 Gauss product rule, which is EXACT for every
 * integrand this package forms (stiffness BᵀDB and the load integrands
 * are polynomial of degree ≤ 3 per natural coordinate; the centrifugal
 * body force is linear in x, the thermal initial strain constant), so
 * the assembly carries no quadrature error — the discretization error
 * is the element's own coarseness, which the accuracy bands state.
 *
 * ## The honest coarseness of the derived stress
 *
 * Strain/stress recovery is CENTER-POINT per element: at the element
 * center each shape-function derivative collapses to ±1/8, the strain
 * components become the classical corner-combination forms (e.g.
 * ε_xx = Σ ±ₓ u_ax / (4·h_x)), and one constant stress state represents
 * the whole voxel — the "plane-stress-equivalent honest form": the
 * stress evaluated is the FULL three-dimensional isotropic state
 * (σ = D(ε − ε₀) with the 3D Hooke D), reduced to the standard 3D von
 * Mises invariant
 *
 *   σ_vm = √( ½[(σxx−σyy)² + (σyy−σzz)² + (σzz−σxx)²]
 *             + 3(τxy² + τyz² + τzx²) )
 *
 * No hourglass control, no reduced integration, no extra assumptions —
 * one value per voxel, staircase-banded, exactly what the convergence
 * fixtures pin. A constant-strain field is reproduced EXACTLY by these
 * center forms (the patch test's ground truth).
 */

/** The 2-point Gauss abscissa per natural axis (±1/√3, weight 1). */
const GAUSS_2 = 1 / Math.sqrt(3);

/**
 * The corner natural-coordinate signs in the CANONICAL hex order
 * (`./mesh`'s HEX_CORNER_DIRECTIONS — the bottom face counter-clockwise
 * in (x, y), then the top face): corner c's signs are
 * `HEX_CORNER_SIGNS[c]`. Every corner-indexed loop in this module walks
 * THIS order so the stiffness rows line up with the mesh's corner node
 * ids exactly.
 */
const HEX_CORNER_SIGNS: readonly (readonly [-1 | 1, -1 | 1, -1 | 1])[] = [
  [-1, -1, -1],
  [1, -1, -1],
  [1, 1, -1],
  [-1, 1, -1],
  [-1, -1, 1],
  [1, -1, 1],
  [1, 1, 1],
  [-1, 1, 1],
] as const;

/** The Voigt order every strain/stress vector in this package uses. */
export const HEX_VOIGT_ORDER = ["xx", "yy", "zz", "xy", "yz", "zx"] as const;

/**
 * The isotropic 3D Hooke constitutive matrix D (6×6 row-major, the
 * Voigt order above): λ + 2G on the normal diagonal, λ on the normal
 * off-diagonals, G on the shear diagonal, with the Lamé pair
 * λ = Eν/((1+ν)(1−2ν)) and G = E/(2(1+ν)). The caller owns E/ν
 * validation (the material door); a ν outside (−1, 0.5) would divide by
 * zero here and never reaches this function.
 */
export function hexDMatrix(
  youngsModulusPa: number,
  poissonRatio: number,
): Float64Array {
  const lambda =
    (youngsModulusPa * poissonRatio) /
    ((1 + poissonRatio) * (1 - 2 * poissonRatio));
  const shear = youngsModulusPa / (2 * (1 + poissonRatio));
  const d = new Float64Array(36);
  const normal = lambda + 2 * shear;
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      d[row * 6 + col] = row === col ? normal : lambda;
    }
    d[(row + 3) * 6 + (row + 3)] = shear;
  }
  return d;
}

/** Multiplies D (6×6) into a strain vector (6) — σ = D·ε, row-major. */
export function hexStressApply(
  d: Float64Array,
  strain: readonly number[],
): readonly [number, number, number, number, number, number] {
  const out: [number, number, number, number, number, number] = [
    0, 0, 0, 0, 0, 0,
  ];
  for (let row = 0; row < 6; row += 1) {
    let value = 0;
    for (let col = 0; col < 6; col += 1) {
      value += (d[row * 6 + col] ?? 0) * (strain[col] ?? 0);
    }
    out[row] = value;
  }
  return out;
}

/**
 * The element stiffness matrix Kₑ (24×24 row-major) — Σ over the eight
 * Gauss points of w·detJ·BᵀDB with detJ = hx·hy·hz/8. Pure arithmetic
 * over the sizes and D: two elements of equal size and equal D share an
 * identical Kₑ, which the assembly caches per material.
 */
export function hexStiffness(
  d: Float64Array,
  hx: number,
  hy: number,
  hz: number,
): Float64Array {
  const ke = new Float64Array(24 * 24);
  const detJ = (hx * hy * hz) / 8;
  const dNdxCached = new Float64Array(8);
  const dNdyCached = new Float64Array(8);
  const dNdzCached = new Float64Array(8);
  for (const gx of [-GAUSS_2, GAUSS_2]) {
    for (const gy of [-GAUSS_2, GAUSS_2]) {
      for (const gz of [-GAUSS_2, GAUSS_2]) {
        shapeDerivatives(
          gx,
          gy,
          gz,
          hx,
          hy,
          hz,
          dNdxCached,
          dNdyCached,
          dNdzCached,
        );
        accumulateStiffness(ke, d, dNdxCached, dNdyCached, dNdzCached, detJ);
      }
    }
  }
  return ke;
}

/** Fills the per-Gauss-point shape-function cartesian derivatives. */
function shapeDerivatives(
  gx: number,
  gy: number,
  gz: number,
  hx: number,
  hy: number,
  hz: number,
  dNdx: Float64Array,
  dNdy: Float64Array,
  dNdz: Float64Array,
): void {
  for (let corner = 0; corner < 8; corner += 1) {
    const signs = HEX_CORNER_SIGNS[corner];
    if (signs === undefined) continue;
    const [ex, ey, ez] = signs;
    // ∂N/∂ξ = ex(1+eyη)(1+ezζ)/8 and cycles; cartesian via ×(2/h).
    dNdx[corner] = ((ex * (1 + ey * gy) * (1 + ez * gz)) / 8) * (2 / hx);
    dNdy[corner] = ((ey * (1 + ex * gx) * (1 + ez * gz)) / 8) * (2 / hy);
    dNdz[corner] = ((ez * (1 + ex * gx) * (1 + ey * gy)) / 8) * (2 / hz);
  }
}

/** Accumulates w·detJ·BᵀDB into Kₑ for one Gauss point (B implicit). */
function accumulateStiffness(
  ke: Float64Array,
  d: Float64Array,
  dNdx: Float64Array,
  dNdy: Float64Array,
  dNdz: Float64Array,
  weightVolume: number,
): void {
  // The strain-direction vector of unit displacement in dof c at a
  // corner with derivatives (dx, dy, dz): the B-matrix column block.
  // rows [xx, yy, zz, xy, yz, zx]:
  //   dof x: [dx, 0, 0, dy, 0, dz]
  //   dof y: [0, dy, 0, dx, dz, 0]
  //   dof z: [0, 0, dz, 0, dy, dx]
  const strainOf = (
    dx: number,
    dy: number,
    dz: number,
    c: number,
  ): readonly number[] =>
    c === 0
      ? [dx, 0, 0, dy, 0, dz]
      : c === 1
        ? [0, dy, 0, dx, dz, 0]
        : [0, 0, dz, 0, dy, dx];
  // Pre-form D·ε_b for every (corner, dof) — the row side of the
  // bilinear, reused by all 24 a-side dofs.
  const dEb = new Float64Array(24 * 6);
  for (let b = 0; b < 8; b += 1) {
    const bx = dNdx[b] ?? 0;
    const by = dNdy[b] ?? 0;
    const bz = dNdz[b] ?? 0;
    for (let cb = 0; cb < 3; cb += 1) {
      const eb = strainOf(bx, by, bz, cb);
      for (let row = 0; row < 6; row += 1) {
        let value = 0;
        for (let col = 0; col < 6; col += 1) {
          value += (d[row * 6 + col] ?? 0) * (eb[col] ?? 0);
        }
        dEb[(b * 3 + cb) * 6 + row] = value;
      }
    }
  }
  for (let a = 0; a < 8; a += 1) {
    const ax = dNdx[a] ?? 0;
    const ay = dNdy[a] ?? 0;
    const az = dNdz[a] ?? 0;
    for (let ca = 0; ca < 3; ca += 1) {
      const ea = strainOf(ax, ay, az, ca);
      for (let b = 0; b < 8; b += 1) {
        for (let cb = 0; cb < 3; cb += 1) {
          let bilinear = 0;
          for (let row = 0; row < 6; row += 1) {
            bilinear += (dEb[(b * 3 + cb) * 6 + row] ?? 0) * (ea[row] ?? 0);
          }
          const keRow = (a * 3 + ca) * 24 + (b * 3 + cb);
          ke[keRow] = (ke[keRow] ?? 0) + weightVolume * bilinear;
        }
      }
    }
  }
}

/**
 * The consistent uniform body-force load (24): ∫Nₐ dV = V/8 exactly, so
 * each corner takes V/8·b — exact for the constant body force of
 * self-weight (the caller multiplies by ρ).
 */
export function hexUniformBodyLoad(
  hx: number,
  hy: number,
  hz: number,
  bodyForcePerVolume: readonly [number, number, number],
): Float64Array {
  const f = new Float64Array(24);
  const perNode = (hx * hy * hz) / 8;
  for (let corner = 0; corner < 8; corner += 1) {
    f[corner * 3] = perNode * (bodyForcePerVolume[0] ?? 0);
    f[corner * 3 + 1] = perNode * (bodyForcePerVolume[1] ?? 0);
    f[corner * 3 + 2] = perNode * (bodyForcePerVolume[2] ?? 0);
  }
  return f;
}

/**
 * The consistent centrifugal body-force load (24): b(x) =
 * multiplier·(r − (r·â)â) with r = x − axisPoint — the acceleration
 * field of rotation at angular-rate-squared scale, INTEGRATED with the
 * same 2×2×2 Gauss rule (b is linear in x, the rule is exact). The
 * caller passes multiplier = ρ·ω².
 */
export function hexCentrifugalLoad(
  hx: number,
  hy: number,
  hz: number,
  centerX: number,
  centerY: number,
  centerZ: number,
  axisPoint: readonly [number, number, number],
  axisDirection: readonly [number, number, number],
  multiplier: number,
): Float64Array {
  const f = new Float64Array(24);
  const detJ = (hx * hy * hz) / 8;
  const [ax, ay, az] = axisDirection;
  for (const gx of [-GAUSS_2, GAUSS_2]) {
    for (const gy of [-GAUSS_2, GAUSS_2]) {
      for (const gz of [-GAUSS_2, GAUSS_2]) {
        const x = centerX + (gx * hx) / 2;
        const y = centerY + (gy * hy) / 2;
        const z = centerZ + (gz * hz) / 2;
        const rx = x - (axisPoint[0] ?? 0);
        const ry = y - (axisPoint[1] ?? 0);
        const rz = z - (axisPoint[2] ?? 0);
        const along = rx * (ax ?? 0) + ry * (ay ?? 0) + rz * (az ?? 0);
        const bx = multiplier * (rx - along * (ax ?? 0));
        const by = multiplier * (ry - along * (ay ?? 0));
        const bz = multiplier * (rz - along * (az ?? 0));
        for (let corner = 0; corner < 8; corner += 1) {
          const signs = HEX_CORNER_SIGNS[corner];
          if (signs === undefined) continue;
          const [sx, sy, sz] = signs;
          const shape = ((1 + sx * gx) * (1 + sy * gy) * (1 + sz * gz)) / 8;
          f[corner * 3] = (f[corner * 3] ?? 0) + detJ * shape * bx;
          f[corner * 3 + 1] = (f[corner * 3 + 1] ?? 0) + detJ * shape * by;
          f[corner * 3 + 2] = (f[corner * 3 + 2] ?? 0) + detJ * shape * bz;
        }
      }
    }
  }
  return f;
}

/**
 * The consistent thermal-expansion load (24): the initial strain
 * ε₀ = αΔT·[1, 1, 1, 0, 0, 0] carried as fₑ = ∫BᵀDε₀ dV — exact for
 * the per-element constant ΔT this package consumes (the Phase 65
 * temperature field is per-cell). Self-equilibrated on an unconstrained
 * element (Σₐ fₐ = 0), so an unconstrained uniform-ΔT body carries zero
 * stress — the free-thermal ground truth.
 */
export function hexThermalLoad(
  hx: number,
  hy: number,
  hz: number,
  d: Float64Array,
  alphaDeltaT: number,
): Float64Array {
  const f = new Float64Array(24);
  const detJ = (hx * hy * hz) / 8;
  const strain0 = [alphaDeltaT, alphaDeltaT, alphaDeltaT, 0, 0, 0] as const;
  const dE0 = hexStressApply(d, strain0);
  const dNdx = new Float64Array(8);
  const dNdy = new Float64Array(8);
  const dNdz = new Float64Array(8);
  for (const gx of [-GAUSS_2, GAUSS_2]) {
    for (const gy of [-GAUSS_2, GAUSS_2]) {
      for (const gz of [-GAUSS_2, GAUSS_2]) {
        shapeDerivatives(gx, gy, gz, hx, hy, hz, dNdx, dNdy, dNdz);
        for (let corner = 0; corner < 8; corner += 1) {
          // (Bᵀ Dε₀) over the three strain rows the derivatives enter.
          f[corner * 3] =
            (f[corner * 3] ?? 0) +
            detJ *
              ((dNdx[corner] ?? 0) * (dE0[0] ?? 0) +
                (dNdy[corner] ?? 0) * (dE0[3] ?? 0) +
                (dNdz[corner] ?? 0) * (dE0[5] ?? 0));
          f[corner * 3 + 1] =
            (f[corner * 3 + 1] ?? 0) +
            detJ *
              ((dNdy[corner] ?? 0) * (dE0[1] ?? 0) +
                (dNdx[corner] ?? 0) * (dE0[3] ?? 0) +
                (dNdz[corner] ?? 0) * (dE0[4] ?? 0));
          f[corner * 3 + 2] =
            (f[corner * 3 + 2] ?? 0) +
            detJ *
              ((dNdz[corner] ?? 0) * (dE0[2] ?? 0) +
                (dNdy[corner] ?? 0) * (dE0[4] ?? 0) +
                (dNdx[corner] ?? 0) * (dE0[5] ?? 0));
        }
      }
    }
  }
  return f;
}

/**
 * The center-point strain (6) of one element from its 24 corner
 * displacements — the exact corner-combination forms stated in the
 * module doc (constant strain reproduced exactly).
 */
export function hexCenterStrain(
  hx: number,
  hy: number,
  hz: number,
  u: ArrayLike<number>,
): readonly [number, number, number, number, number, number] {
  let exxDx = 0;
  let eyyDy = 0;
  let ezzDz = 0;
  let gammaXyX = 0;
  let gammaXyY = 0;
  let gammaYzY = 0;
  let gammaYzZ = 0;
  let gammaZxZ = 0;
  let gammaZxX = 0;
  for (let corner = 0; corner < 8; corner += 1) {
    const signs = HEX_CORNER_SIGNS[corner];
    if (signs === undefined) continue;
    const [sx, sy, sz] = signs;
    const ux = u[corner * 3] ?? 0;
    const uy = u[corner * 3 + 1] ?? 0;
    const uz = u[corner * 3 + 2] ?? 0;
    exxDx += sx * ux;
    eyyDy += sy * uy;
    ezzDz += sz * uz;
    gammaXyX += sy * ux;
    gammaXyY += sx * uy;
    gammaYzY += sz * uy;
    gammaYzZ += sy * uz;
    gammaZxZ += sx * uz;
    gammaZxX += sz * ux;
  }
  return [
    exxDx / (4 * hx),
    eyyDy / (4 * hy),
    ezzDz / (4 * hz),
    gammaXyX / (4 * hy) + gammaXyY / (4 * hx),
    gammaYzY / (4 * hz) + gammaYzZ / (4 * hy),
    gammaZxZ / (4 * hx) + gammaZxX / (4 * hz),
  ];
}

/**
 * The von Mises equivalent stress of a 3D stress state (the module
 * doc's formula) — the scalar the factor-of-safety arithmetic divides
 * the yield strength by.
 */
export function hexVonMises(
  stress: readonly [number, number, number, number, number, number],
): number {
  const [sxx, syy, szz, txy, tyz, tzx] = stress;
  const normal = 0.5 * ((sxx - syy) ** 2 + (syy - szz) ** 2 + (szz - sxx) ** 2);
  const shear = 3 * (txy * txy + tyz * tyz + tzx * tzx);
  return Math.sqrt(normal + shear);
}
