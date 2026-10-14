/**
 * Streaming (Phase 63a): the push scheme over the SoA layout — every
 * live distribution moves one link along its discrete velocity into the
 * scratch set, solids included (full-way bounce-back's solids hold and
 * return populations; `./state`'s reflection runs after the boundary
 * conditions). The scratch is ZEROED before the push: slots no in-domain
 * population arrives in (the faces' inbound trios, and every slot of a
 * solid node whose source lies outside) must read zero, never stale
 * bytes — stale slots would leak into the fluid through boundary-touching
 * solids and poison the force ledger. Populations whose target falls
 * outside the domain are DROPPED, and their momentum is booked into the
 * per-step ledger — one of the three terms of the exact momentum audit
 * (dropped + face overwrites + solid impulses = ΔM), the sanity check
 * the force integration is pinned against.
 */

import type { LbmState } from "./state";

import { D2Q9_Q, D2Q9_VELOCITIES } from "./d2q9";

/**
 * Pushes every distribution from `f` into `fTmp` (f is left as-is; the
 * caller swaps after the boundary pass), accumulating the momentum that
 * left the domain through dropped populations. Rest populations copy.
 */
export function lbmStream(state: LbmState): {
  readonly droppedX: number;
  readonly droppedY: number;
} {
  const { f, fTmp, nx, ny } = state;
  const rest = f[0];
  const restTmp = fTmp[0];
  for (let i = 0; i < D2Q9_Q; i += 1) {
    fTmp[i]?.fill(0);
  }
  for (let index = 0; index < nx * ny; index += 1) {
    if (rest !== undefined && restTmp !== undefined) {
      restTmp[index] = rest[index] ?? 0;
    }
  }
  let droppedX = 0;
  let droppedY = 0;
  for (let i = 1; i < D2Q9_Q; i += 1) {
    const column = f[i];
    const target = fTmp[i];
    if (column === undefined || target === undefined) continue;
    const [cx, cy] = D2Q9_VELOCITIES[i] ?? [0, 0];
    for (let y = 0; y < ny; y += 1) {
      const ty = y + cy;
      const rowBase = y * nx;
      const targetRowBase = ty * nx;
      for (let x = 0; x < nx; x += 1) {
        const value = column[rowBase + x] ?? 0;
        const tx = x + cx;
        if (tx < 0 || tx >= nx || ty < 0 || ty >= ny) {
          droppedX += value * cx;
          droppedY += value * cy;
          continue;
        }
        target[targetRowBase + tx] = value;
      }
    }
  }
  return { droppedX, droppedY };
}

/**
 * Swaps the live and scratch distribution sets — the stepper's
 * end-of-step commit. A reference exchange, never a copy.
 */
export function lbmSwap(state: LbmState): void {
  const live = state.f;
  state.f = state.fTmp;
  state.fTmp = live;
}
