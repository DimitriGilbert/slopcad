/**
 * Boundary conditions (Phase 63a) — the real set, replacing cfd-ts's
 * four-edge equilibrium (its named flaw, and this module's spec):
 * Zou/He non-equilibrium-bounce velocity and pressure conditions, a
 * convective outflow, and the wall family (no-slip, free-slip,
 * symmetry). All conditions are stated in LATTICE units; the stepper
 * converts SI at its door.
 *
 * ## Where each condition applies
 *
 * After push-streaming (`./streaming`), a boundary node is missing
 * exactly the populations whose source node lies outside the domain:
 * west {1, 5, 8}, east {3, 6, 7}, south {2, 5, 6}, north {4, 7, 8} —
 * the inbound directions per face. Each condition reconstructs those
 * three from the six that arrived.
 *
 * - **velocity (Zou/He)**: (u_x, u_y) prescribed; ρ solved from the
 *   mass/momentum elimination ρ(1 − u_n) = Σknown + 2·Σoutbound, the
 *   normal component split by the bounce-back-like rule
 *   f_n = f_n̄ + (2/3)ρu_n, and the diagonal pair from the momentum
 *   sums (S = sum, D = difference → f± = (S±D)/2).
 * - **pressure (Zou/He)**: ρ prescribed (the ambient outlet, ρ = 1 in
 *   lattice density); u_n solved from the same elimination, the
 *   tangential component taken from the inward neighbour's macroscopic
 *   field (zero when that neighbour is solid — deterministic), then the
 *   same reconstruction.
 * - **convective-outflow**: f_i(t+dt) = f_i(t) − c·(f_i(t)|face −
 *   f_i(t)|neighbour) on the missing directions, with c the local
 *   outward-normal macroscopic Courant number clamped to [0, 0.5] —
 *   the wave-leaves-the-domain condition that does not reflect
 *   vortical structures the way a fixed outlet does.
 * - **wall (no-slip)**: half-way link bounce-back on the missing three —
 *   each takes its FULL reflection partner's POST-COLLISION value at the
 *   same node (f_2 ← f_4ᶜᵒˡˡ, f_5 ← f_7ᶜᵒˡˡ, f_6 ← f_8ᶜᵒˡˡ on the south
 *   face): the outgoing population streams toward the wall, bounces at
 *   the link's midpoint, and returns within the same step, so the
 *   effective wall sits half a link OUTSIDE the boundary node and a
 *   channel of ny nodes has height H = ny lattice units — the Poiseuille
 *   fixture's documented width (the TRT Λ = 1/4 exactness rides on this
 *   placement).
 * - **wall (free-slip) and symmetry**: specular reflection over the same
 *   post-collision source — the wall-normal component flips, the
 *   tangential survives (south face: f_2 ← f_4ᶜᵒˡˡ, f_5 ← f_8ᶜᵒˡˡ,
 *   f_6 ← f_7ᶜᵒˡˡ). Identical mathematics, distinct intent: symmetry
 *   planes exist to halve domains (the roadmap's compute saver); the
 *   slip wall is a friction statement. One code path.
 *
 * Solid boundary nodes are skipped — geometry bounce-back owns them.
 * Faces apply in the fixed order west, east, south, north; at a corner
 * the later face wins the shared diagonal, and a Zou/He reconstruction
 * whose "known" populations have out-of-domain sources (the corner
 * case) completes them from the node's equilibrium — `readKnown`'s
 * documented closure. Staircase honesty at corners is stated, not
 * hidden (law S3's posture).
 *
 * Every overwritten value is booked into the per-step face momentum
 * ledger — the second term of the exact momentum audit (see
 * `./streaming`).
 */

import type { LbmState } from "./state";

import { D2Q9_VELOCITIES, d2q9Equilibrium } from "./d2q9";

/** The four domain edges a 2D condition may address. */
export const LBM_FACES = ["west", "east", "south", "north"] as const;

export type LbmFace = (typeof LBM_FACES)[number];

/** A face condition in lattice units (the stepper converts SI → this). */
export type LbmFaceCondition =
  | { readonly kind: "velocity"; readonly ux: number; readonly uy: number }
  | { readonly kind: "pressure"; readonly rho: number }
  | { readonly kind: "convective-outflow" }
  | { readonly kind: "wall"; readonly slip: boolean }
  | { readonly kind: "symmetry" };

/** The fixed application order (corner ownership: later face wins). */
export const LBM_FACE_ORDER: readonly LbmFace[] = LBM_FACES;

/** One step's face-condition momentum ledger, lattice units. */
export interface LbmFaceMomentumLedger {
  /** Σ (new − old)·c_i over every value a face condition overwrote. */
  x: number;
  y: number;
}

/**
 * Applies the four face conditions to the streaming scratch
 * (`fTmp`, post-streaming; convective reads the pre-step `f`),
 * skipping solid nodes and accumulating the overwrite ledger. The
 * macroscopic fields (`state.ux/uy`) are the step-start values — the
 * standard lagged source for the convective speed and the pressure
 * condition's tangential component.
 */
export function lbmApplyFaceConditions(
  state: LbmState,
  conditions: Readonly<Record<LbmFace, LbmFaceCondition>>,
  ledger: LbmFaceMomentumLedger,
): void {
  ledger.x = 0;
  ledger.y = 0;
  for (const face of LBM_FACE_ORDER) {
    const condition = conditions[face];
    if (condition === undefined) continue;
    applyFace(state, face, condition, ledger);
  }
}

/**
 * Reads one of a Zou/He reconstruction's "known" populations: the
 * post-streaming value when its source node lies in the domain, and —
 * at a CORNER, where the source itself lies beyond the perpendicular
 * face and the slot is honestly zero — the equilibrium value at the
 * node's own (lagged) macroscopic state. That equilibrium completion is
 * the standard corner closure: it keeps the reconstruction's moments
 * physical instead of dividing zeros into ρ, and it is deterministic.
 */
function readKnown(state: LbmState, i: number, index: number): number {
  const [cx, cy] = D2Q9_VELOCITIES[i] ?? [0, 0];
  const sourceX = (index % state.nx) - cx;
  const sourceY = Math.floor(index / state.nx) - cy;
  if (
    sourceX >= 0 &&
    sourceX < state.nx &&
    sourceY >= 0 &&
    sourceY < state.ny
  ) {
    return state.fTmp[i]?.[index] ?? 0;
  }
  return d2q9Equilibrium(
    i,
    state.rho[index] ?? 1,
    state.ux[index] ?? 0,
    state.uy[index] ?? 0,
  );
}

/** Writes one value, booking its momentum change into the ledger. */
function write(
  state: LbmState,
  i: number,
  index: number,
  value: number,
  ledger: LbmFaceMomentumLedger,
): void {
  const column = state.fTmp[i];
  if (column === undefined) return;
  const previous = column[index] ?? 0;
  column[index] = value;
  const [cx, cy] = D2Q9_VELOCITIES[i] ?? [0, 0];
  ledger.x += (value - previous) * cx;
  ledger.y += (value - previous) * cy;
}

/** The macroscopic velocity at a node, zeroed over solids (stale there). */
function macroscopicVelocity(
  state: LbmState,
  index: number,
): { readonly ux: number; readonly uy: number } {
  if (state.solid.solid[index] === 1) return { ux: 0, uy: 0 };
  return { ux: state.ux[index] ?? 0, uy: state.uy[index] ?? 0 };
}

function applyFace(
  state: LbmState,
  face: LbmFace,
  condition: LbmFaceCondition,
  ledger: LbmFaceMomentumLedger,
): void {
  const { nx, ny } = state;
  if (face === "west") {
    for (let y = 0; y < ny; y += 1) {
      const index = y * nx;
      if (state.solid.solid[index] === 1) continue;
      const f0 = readKnown(state, 0, index);
      const f2 = readKnown(state, 2, index);
      const f4 = readKnown(state, 4, index);
      const f3 = readKnown(state, 3, index);
      const f6 = readKnown(state, 6, index);
      const f7 = readKnown(state, 7, index);
      const base = f0 + f2 + f4 + 2 * (f3 + f6 + f7);
      switch (condition.kind) {
        case "velocity":
          reconstructWest(
            state,
            index,
            condition.ux,
            condition.uy,
            base / (1 - condition.ux),
            f3,
            f6,
            f7,
            f2,
            f4,
            ledger,
          );
          break;
        case "pressure": {
          const tangential = macroscopicVelocity(state, index + 1);
          reconstructWest(
            state,
            index,
            1 - base / condition.rho,
            tangential.uy,
            condition.rho,
            f3,
            f6,
            f7,
            f2,
            f4,
            ledger,
          );
          break;
        }
        case "convective-outflow": {
          const speed = Math.max(
            0,
            Math.min(0.5, -macroscopicVelocity(state, index).ux),
          );
          convectiveCopy(state, "west", index, index + 1, speed, ledger);
          break;
        }
        case "wall":
        case "symmetry": {
          reflectInPlace(
            state,
            "west",
            index,
            condition.kind === "symmetry" || condition.slip,
            ledger,
          );
          break;
        }
      }
    }
    return;
  }
  if (face === "east") {
    for (let y = 0; y < ny; y += 1) {
      const index = y * nx + (nx - 1);
      if (state.solid.solid[index] === 1) continue;
      const f0 = readKnown(state, 0, index);
      const f2 = readKnown(state, 2, index);
      const f4 = readKnown(state, 4, index);
      const f1 = readKnown(state, 1, index);
      const f5 = readKnown(state, 5, index);
      const f8 = readKnown(state, 8, index);
      const base = f0 + f2 + f4 + 2 * (f1 + f5 + f8);
      switch (condition.kind) {
        case "velocity":
          reconstructEast(
            state,
            index,
            condition.ux,
            condition.uy,
            base / (1 + condition.ux),
            f1,
            f5,
            f8,
            f2,
            f4,
            ledger,
          );
          break;
        case "pressure": {
          const tangential = macroscopicVelocity(state, index - 1);
          reconstructEast(
            state,
            index,
            base / condition.rho - 1,
            tangential.uy,
            condition.rho,
            f1,
            f5,
            f8,
            f2,
            f4,
            ledger,
          );
          break;
        }
        case "convective-outflow": {
          const speed = Math.max(
            0,
            Math.min(0.5, macroscopicVelocity(state, index).ux),
          );
          convectiveCopy(state, "east", index, index - 1, speed, ledger);
          break;
        }
        case "wall":
        case "symmetry":
          reflectInPlace(
            state,
            "east",
            index,
            condition.kind === "symmetry" || condition.slip,
            ledger,
          );
          break;
      }
    }
    return;
  }
  if (face === "south") {
    for (let x = 0; x < nx; x += 1) {
      const index = x;
      if (state.solid.solid[index] === 1) continue;
      const f0 = readKnown(state, 0, index);
      const f1 = readKnown(state, 1, index);
      const f3 = readKnown(state, 3, index);
      const f4 = readKnown(state, 4, index);
      const f7 = readKnown(state, 7, index);
      const f8 = readKnown(state, 8, index);
      const base = f0 + f1 + f3 + 2 * (f4 + f7 + f8);
      switch (condition.kind) {
        case "velocity":
          reconstructSouth(
            state,
            index,
            condition.ux,
            condition.uy,
            base / (1 - condition.uy),
            f4,
            f7,
            f8,
            f1,
            f3,
            ledger,
          );
          break;
        case "pressure": {
          const tangential = macroscopicVelocity(state, index + nx);
          reconstructSouth(
            state,
            index,
            tangential.ux,
            1 - base / condition.rho,
            condition.rho,
            f4,
            f7,
            f8,
            f1,
            f3,
            ledger,
          );
          break;
        }
        case "convective-outflow": {
          const speed = Math.max(
            0,
            Math.min(0.5, -macroscopicVelocity(state, index).uy),
          );
          convectiveCopy(state, "south", index, index + nx, speed, ledger);
          break;
        }
        case "wall":
        case "symmetry":
          reflectInPlace(
            state,
            "south",
            index,
            condition.kind === "symmetry" || condition.slip,
            ledger,
          );
          break;
      }
    }
    return;
  }
  for (let x = 0; x < nx; x += 1) {
    const index = (ny - 1) * nx + x;
    if (state.solid.solid[index] === 1) continue;
    const f0 = readKnown(state, 0, index);
    const f1 = readKnown(state, 1, index);
    const f3 = readKnown(state, 3, index);
    const f2 = readKnown(state, 2, index);
    const f5 = readKnown(state, 5, index);
    const f6 = readKnown(state, 6, index);
    const base = f0 + f1 + f3 + 2 * (f2 + f5 + f6);
    switch (condition.kind) {
      case "velocity":
        reconstructNorth(
          state,
          index,
          condition.ux,
          condition.uy,
          base / (1 + condition.uy),
          f2,
          f5,
          f6,
          f1,
          f3,
          ledger,
        );
        break;
      case "pressure": {
        const tangential = macroscopicVelocity(state, index - nx);
        reconstructNorth(
          state,
          index,
          tangential.ux,
          base / condition.rho - 1,
          condition.rho,
          f2,
          f5,
          f6,
          f1,
          f3,
          ledger,
        );
        break;
      }
      case "convective-outflow": {
        const speed = Math.max(
          0,
          Math.min(0.5, macroscopicVelocity(state, index).uy),
        );
        convectiveCopy(state, "north", index, index - nx, speed, ledger);
        break;
      }
      case "wall":
      case "symmetry":
        reflectInPlace(
          state,
          "north",
          index,
          condition.kind === "symmetry" || condition.slip,
          ledger,
        );
        break;
    }
  }
}

/**
 * The west Zou/He reconstruction: solves the missing {1, 5, 8} from the
 * arrived {0, 2, 4, 3, 6, 7}, the prescribed (ux, uy), and ρ (solved by
 * the caller for the velocity form, fixed for the pressure form).
 */
function reconstructWest(
  state: LbmState,
  index: number,
  ux: number,
  uy: number,
  rho: number,
  f3: number,
  f6: number,
  f7: number,
  f2: number,
  f4: number,
  ledger: LbmFaceMomentumLedger,
): void {
  write(state, 1, index, f3 + (2 / 3) * rho * ux, ledger);
  const sum = (1 / 3) * rho * ux + f6 + f7;
  const difference = rho * uy - f2 + f4 - f6 + f7;
  write(state, 5, index, (sum + difference) / 2, ledger);
  write(state, 8, index, (sum - difference) / 2, ledger);
}

/** The east Zou/He reconstruction of the missing {3, 6, 7}. */
function reconstructEast(
  state: LbmState,
  index: number,
  ux: number,
  uy: number,
  rho: number,
  f1: number,
  f5: number,
  f8: number,
  f2: number,
  f4: number,
  ledger: LbmFaceMomentumLedger,
): void {
  write(state, 3, index, f1 - (2 / 3) * rho * ux, ledger);
  const sum = f5 + f8 - (1 / 3) * rho * ux;
  const difference = rho * uy - f2 + f4 - f5 + f8;
  write(state, 6, index, (sum + difference) / 2, ledger);
  write(state, 7, index, (sum - difference) / 2, ledger);
}

/** The south Zou/He reconstruction of the missing {2, 5, 6}. */
function reconstructSouth(
  state: LbmState,
  index: number,
  ux: number,
  uy: number,
  rho: number,
  f4: number,
  f7: number,
  f8: number,
  f1: number,
  f3: number,
  ledger: LbmFaceMomentumLedger,
): void {
  write(state, 2, index, f4 + (2 / 3) * rho * uy, ledger);
  const sum = (1 / 3) * rho * uy + f7 + f8;
  const difference = rho * ux - f1 + f3 + f7 - f8;
  write(state, 5, index, (sum + difference) / 2, ledger);
  write(state, 6, index, (sum - difference) / 2, ledger);
}

/** The north Zou/He reconstruction of the missing {4, 7, 8}. */
function reconstructNorth(
  state: LbmState,
  index: number,
  ux: number,
  uy: number,
  rho: number,
  f2: number,
  f5: number,
  f6: number,
  f1: number,
  f3: number,
  ledger: LbmFaceMomentumLedger,
): void {
  write(state, 4, index, f2 - (2 / 3) * rho * uy, ledger);
  const sum = f5 + f6 - (1 / 3) * rho * uy;
  const difference = rho * ux - f1 + f3 - f5 + f6;
  write(state, 8, index, (sum + difference) / 2, ledger);
  write(state, 7, index, (sum - difference) / 2, ledger);
}

/**
 * The half-way wall reflection of the face's missing trio: full
 * reflection (no-slip) or specular (free-slip/symmetry), sourced from
 * the boundary node's POST-COLLISION distributions (`f`, pre-streaming)
 * — the link-midpoint bounce that places the wall half a cell outside.
 */
function reflectInPlace(
  state: LbmState,
  face: LbmFace,
  index: number,
  specular: boolean,
  ledger: LbmFaceMomentumLedger,
): void {
  const read0 = (i: number): number => state.f[i]?.[index] ?? 0;
  if (face === "west") {
    const f3 = read0(3);
    write(state, 1, index, f3, ledger);
    if (specular) {
      write(state, 5, index, read0(6), ledger);
      write(state, 8, index, read0(7), ledger);
    } else {
      write(state, 5, index, read0(7), ledger);
      write(state, 8, index, read0(6), ledger);
    }
    return;
  }
  if (face === "east") {
    const f1 = read0(1);
    write(state, 3, index, f1, ledger);
    if (specular) {
      write(state, 6, index, read0(5), ledger);
      write(state, 7, index, read0(8), ledger);
    } else {
      write(state, 6, index, read0(8), ledger);
      write(state, 7, index, read0(5), ledger);
    }
    return;
  }
  if (face === "south") {
    const f4 = read0(4);
    write(state, 2, index, f4, ledger);
    if (specular) {
      write(state, 5, index, read0(8), ledger);
      write(state, 6, index, read0(7), ledger);
    } else {
      write(state, 5, index, read0(7), ledger);
      write(state, 6, index, read0(8), ledger);
    }
    return;
  }
  const f2 = read0(2);
  write(state, 4, index, f2, ledger);
  if (specular) {
    write(state, 7, index, read0(6), ledger);
    write(state, 8, index, read0(5), ledger);
  } else {
    write(state, 7, index, read0(5), ledger);
    write(state, 8, index, read0(6), ledger);
  }
}

/**
 * The convective outflow: the face's missing trio is extrapolated from
 * its pre-step values against the inward neighbour, at the clamped
 * outward Courant number. Reads `f` (pre-step), writes `fTmp`.
 */
function convectiveCopy(
  state: LbmState,
  face: LbmFace,
  index: number,
  neighborIndex: number,
  speed: number,
  ledger: LbmFaceMomentumLedger,
): void {
  const missing =
    face === "west"
      ? [1, 5, 8]
      : face === "east"
        ? [3, 6, 7]
        : face === "south"
          ? [2, 5, 6]
          : [4, 7, 8];
  for (const i of missing) {
    const column = state.f[i];
    if (column === undefined) continue;
    const faceValue = column[index] ?? 0;
    const neighborValue = column[neighborIndex] ?? 0;
    write(
      state,
      i,
      index,
      faceValue - speed * (faceValue - neighborValue),
      ledger,
    );
  }
}
