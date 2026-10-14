/**
 * 3D streaming (Phase 66a): the push scheme over the SoA layout — every
 * live distribution moves one link along its discrete velocity into the
 * scratch set, solids included (full-way bounce-back's solids hold and
 * return populations; `./state-3d`'s reflection runs after the boundary
 * conditions). The scratch is ZEROED before the push: slots no
 * in-domain population arrives in (the faces' inbound sets, and every
 * slot of a solid node whose source lies outside) must read zero, never
 * stale bytes — the 63a leak discipline carried to 3D. Populations
 * whose target falls outside the domain are DROPPED, and their momentum
 * is booked into the per-step ledger (three components) — one of the
 * three terms of the exact momentum audit (dropped + face overwrites +
 * solid impulses = ΔM).
 */

import type { Lbm3dState } from "./state-3d";

import { D3Q19_Q, D3Q19_VELOCITIES } from "./d3q19";

/**
 * Pushes every distribution from `f` into `fTmp` (f is left as-is; the
 * caller swaps after the boundary pass), accumulating the momentum that
 * left the domain through dropped populations. Rest populations copy.
 */
export function lbm3dStream(state: Lbm3dState): {
  readonly droppedX: number;
  readonly droppedY: number;
  readonly droppedZ: number;
} {
  const { f, fTmp, nx, ny, nz } = state;
  const rest = f[0];
  const restTmp = fTmp[0];
  for (let i = 0; i < D3Q19_Q; i += 1) {
    fTmp[i]?.fill(0);
  }
  for (let index = 0; index < nx * ny * nz; index += 1) {
    if (rest !== undefined && restTmp !== undefined) {
      restTmp[index] = rest[index] ?? 0;
    }
  }
  let droppedX = 0;
  let droppedY = 0;
  let droppedZ = 0;
  for (let i = 1; i < D3Q19_Q; i += 1) {
    const column = f[i];
    const target = fTmp[i];
    if (column === undefined || target === undefined) continue;
    const [cx, cy, cz] = D3Q19_VELOCITIES[i] ?? [0, 0, 0];
    const plane = nx * ny;
    for (let z = 0; z < nz; z += 1) {
      const tz = z + cz;
      const planeBase = z * plane;
      const targetPlaneBase = tz * plane;
      for (let y = 0; y < ny; y += 1) {
        const ty = y + cy;
        const rowBase = planeBase + y * nx;
        const targetRowBase = targetPlaneBase + ty * nx;
        for (let x = 0; x < nx; x += 1) {
          const value = column[rowBase + x] ?? 0;
          const tx = x + cx;
          if (tx < 0 || tx >= nx || ty < 0 || ty >= ny || tz < 0 || tz >= nz) {
            droppedX += value * cx;
            droppedY += value * cy;
            droppedZ += value * cz;
            continue;
          }
          target[targetRowBase + tx] = value;
        }
      }
    }
  }
  return { droppedX, droppedY, droppedZ };
}

/**
 * Swaps the live and scratch distribution sets — the stepper's
 * end-of-step commit. A reference exchange, never a copy.
 */
export function lbm3dSwap(state: Lbm3dState): void {
  const live = state.f;
  state.f = state.fTmp;
  state.fTmp = live;
}
