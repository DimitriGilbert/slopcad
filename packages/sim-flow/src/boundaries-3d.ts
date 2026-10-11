/**
 * 3D boundary conditions (Phase 66a) — the 63a set carried to the six
 * faces of the D3Q19 lattice's boundary planes: Zou/He
 * non-equilibrium-bounce velocity and pressure conditions, a convective
 * outflow, and the wall family (no-slip, free-slip, symmetry). All
 * conditions are stated in LATTICE units; the 3D stepper converts SI at
 * its door.
 *
 * ## Where each condition applies
 *
 * After push-streaming (`./streaming-3d`), a boundary node is missing
 * exactly the FIVE populations whose source node lies outside the
 * domain — on the west face {1, 7, 10, 11, 14}, the directions with
 * c_x = +1, and likewise per face for the inward-pointing set. Each
 * condition reconstructs those five from the fourteen that arrived.
 *
 * ## The reconstruction (Zou/He, generalized per axis)
 *
 * The 2D kernel hand-unrolled four faces; six faces × five unknowns
 * would be thirty hand-written blocks, so this module states the
 * reconstruction ONCE per axis orientation and instantiates it for the
 * six faces — the same algebra, one implementation, and the WGSL
 * provider (`./wgsl-shader-3d`) mirrors this generic core rather than
 * thirty blocks of its own. For a face with inward normal n (unit axis
 * vector), the prescribed velocity's normal component u_n = u·n, and
 * the tangential axes t, u:
 *
 * - **mass**: ρ(1 − u_n) = Σ_{c·n ≤ 0} f + Σ_{c·n = −1} f — the
 *   velocity form solves ρ from it; the pressure form solves u_n.
 * - **normal population**: f_axis,in = f_axis,out + (1/3)·ρ·u_n — the
 *   D3Q19 axis weight (1/18) halves the D2Q9 closure's (2/3)·ρu_n.
 * - **diagonal pairs**: per tangential axis t, the two unknown
 *   diagonals carrying c_t = ±1 take
 *     f(c_t=+1) = (S_t + D_t)/2,  f(c_t=−1) = (S_t − D_t)/2, with
 *     S_t = (mirror pair sum) + (1/3)·ρ·u_n  and
 *     D_t = ρ·u_t − Σ_{arrived, c_t ≠ 0} c_t·f,
 *   the x-momentum split giving each tangential plane's pair sum half
 *   the diagonal normal flux (each of the four +n diagonals pairs with
 *   its −n mirror at weight 1/36 → 6·w per pair). Mass, all three
 *   momentum components, and the first-order equilibrium are identities
 *   of this closure — the moment identities the unit tests pin.
 * - **pressure tangentials**: taken from the inward neighbour's
 *   macroscopic field (zero when that neighbour is solid —
 *   deterministic), the lagged source the 2D kernel uses.
 * - **convective outflow**: f_i(t+dt) = f_i(t) − c·(f_i(t)|face −
 *   f_i(t)|neighbour) on the missing five, with c the local
 *   outward-normal macroscopic Courant number clamped to [0, 0.5].
 * - **wall (no-slip)**: half-way link bounce-back on the missing five —
 *   each takes its FULL reflection partner's POST-COLLISION value at
 *   the same node: the wall sits half a link OUTSIDE the boundary node,
 *   so a channel of ny nodes has height H = ny lattice units (the
 *   Poiseuille fixture's documented width; the TRT Λ = 1/4 exactness
 *   rides on this placement).
 * - **wall (free-slip) and symmetry**: specular reflection over the
 *   same post-collision source — the wall-normal component flips, the
 *   tangential survives. Identical mathematics, distinct intent;
 *   one code path.
 *
 * Solid boundary nodes are skipped — geometry bounce-back owns them.
 * Faces apply in the fixed order west, east, south, north, bottom,
 * top; at an edge the later face wins the shared diagonals, and a
 * Zou/He reconstruction whose "known" populations have out-of-domain
 * sources (the edge case) completes them from the node's equilibrium —
 * `readKnown`'s documented closure, deterministic, the 2D precedent.
 *
 * Every overwritten value is booked into the per-step face momentum
 * ledger (three components) — the second term of the exact momentum
 * audit (see `./streaming-3d`).
 */

import type { Lbm3dState } from "./state-3d";

import {
  D3Q19_OPPOSITE,
  D3Q19_Q,
  D3Q19_VELOCITIES,
  d3q19Equilibrium,
} from "./d3q19";

/** The six domain faces a 3D condition may address. */
export const LBM3D_FACES = [
  "west",
  "east",
  "south",
  "north",
  "bottom",
  "top",
] as const;

export type Lbm3dFace = (typeof LBM3D_FACES)[number];

/** A face condition in lattice units (the 3D stepper converts SI → this). */
export type Lbm3dFaceCondition =
  | {
      readonly kind: "velocity";
      readonly ux: number;
      readonly uy: number;
      readonly uz: number;
    }
  | { readonly kind: "pressure"; readonly rho: number }
  | { readonly kind: "convective-outflow" }
  | { readonly kind: "wall"; readonly slip: boolean }
  | { readonly kind: "symmetry" };

/** The fixed application order (edge ownership: later face wins). */
export const LBM3D_FACE_ORDER: readonly Lbm3dFace[] = LBM3D_FACES;

/** One step's face-condition momentum ledger, lattice units. */
export interface Lbm3dFaceMomentumLedger {
  /** Σ (new − old)·c_i over every value a face condition overwrote. */
  x: number;
  y: number;
  z: number;
}

/** One face's geometry: the boundary-normal axis and the inward sign. */
interface FaceGeometry {
  readonly axis: 0 | 1 | 2;
  readonly inward: 1 | -1;
}

const FACE_GEOMETRY: Readonly<Record<Lbm3dFace, FaceGeometry>> = {
  west: { axis: 0, inward: 1 },
  east: { axis: 0, inward: -1 },
  south: { axis: 1, inward: 1 },
  north: { axis: 1, inward: -1 },
  bottom: { axis: 2, inward: 1 },
  top: { axis: 2, inward: -1 },
};

/** One tangential axis's share of the Zou/He reconstruction. */
interface TangentialClosure {
  /** The tangential axis index (0 = x, 1 = y, 2 = z). */
  readonly axis: 0 | 1 | 2;
  /** The unknown diagonal with c_t = +1. */
  readonly dPlus: number;
  /** The unknown diagonal with c_t = −1. */
  readonly dMinus: number;
  /** The arrived mirror diagonal with c_t = +1 (c·n = −1). */
  readonly mPlus: number;
  /** The arrived mirror diagonal with c_t = −1 (c·n = −1). */
  readonly mMinus: number;
  /** Every arrived direction with c_t ≠ 0 (the D_t sum's members). */
  readonly knownMoment: readonly number[];
}

/** One face's precomputed direction classification (pure table work). */
interface FaceDirections {
  readonly geometry: FaceGeometry;
  /** The missing (inbound) axis direction. */
  readonly axisIn: number;
  /** Its outbound reflection partner. */
  readonly axisOut: number;
  /** All five missing directions. */
  readonly missing: readonly number[];
  /** Arrived directions with c·n ≤ 0 (the mass base's single-counted set). */
  readonly knownBase: readonly number[];
  /** Arrived directions with c·n = −1 (double-counted in the base). */
  readonly knownOutbound: readonly number[];
  /** The two tangential closures. */
  readonly tangential: readonly TangentialClosure[];
  /**
   * Specular-reflection partner per direction (index i → the direction
   * whose velocity is c_i with the face-normal component flipped; only
   * the missing entries are meaningful).
   */
  readonly specularPartner: readonly number[];
}

function velocityOf(i: number): readonly [number, number, number] {
  return D3Q19_VELOCITIES[i] ?? [0, 0, 0];
}

/** Classifies all nineteen directions for one face (module-load work). */
function faceDirections(face: Lbm3dFace): FaceDirections {
  const geometry = FACE_GEOMETRY[face];
  const { axis, inward } = geometry;
  const normalComponent = (i: number): number =>
    (velocityOf(i)[axis] ?? 0) * inward;
  const missing: number[] = [];
  const knownBase: number[] = [];
  const knownOutbound: number[] = [];
  let axisIn = 0;
  for (let i = 0; i < D3Q19_Q; i += 1) {
    const [cx, cy, cz] = velocityOf(i);
    const components = [cx, cy, cz];
    const cn = normalComponent(i);
    if (cn > 0) {
      missing.push(i);
      if (components.every((value, index) => index === axis || value === 0)) {
        axisIn = i;
      }
      continue;
    }
    knownBase.push(i);
    if (cn === -1) knownOutbound.push(i);
  }
  const axisOut = D3Q19_OPPOSITE[axisIn] ?? 0;
  const tangentialAxes = ([0, 1, 2] as const).filter((index) => index !== axis);
  const tangential: TangentialClosure[] = tangentialAxes.map((t) => {
    let dPlus = 0;
    let dMinus = 0;
    let mPlus = 0;
    let mMinus = 0;
    for (let i = 0; i < D3Q19_Q; i += 1) {
      const [cx, cy, cz] = velocityOf(i);
      const components = [cx, cy, cz];
      const ct = components[t] ?? 0;
      if (ct === 0) continue;
      const others = components.every(
        (value, index) => index === t || index === axis || value === 0,
      );
      if (!others) continue;
      if (normalComponent(i) > 0) {
        if (ct > 0) dPlus = i;
        else dMinus = i;
      } else if (normalComponent(i) < 0) {
        if (ct > 0) mPlus = i;
        else mMinus = i;
      }
    }
    const knownMoment: number[] = [];
    for (let i = 0; i < D3Q19_Q; i += 1) {
      const cn = normalComponent(i);
      if (cn > 0) continue;
      if ((velocityOf(i)[t] ?? 0) !== 0) knownMoment.push(i);
    }
    return { axis: t, dPlus, dMinus, mPlus, mMinus, knownMoment };
  });
  const specularPartner: number[] = [];
  for (let i = 0; i < D3Q19_Q; i += 1) specularPartner.push(i);
  for (const i of missing) {
    const [cx, cy, cz] = velocityOf(i);
    const flipped: [number, number, number] = [cx, cy, cz];
    flipped[axis] = -(flipped[axis] ?? 0);
    let partner = D3Q19_OPPOSITE[i] ?? 0;
    for (let j = 0; j < D3Q19_Q; j += 1) {
      const [jx, jy, jz] = velocityOf(j);
      if (jx === flipped[0] && jy === flipped[1] && jz === flipped[2]) {
        partner = j;
        break;
      }
    }
    specularPartner[i] = partner;
  }
  return {
    geometry,
    axisIn,
    axisOut,
    missing,
    knownBase,
    knownOutbound,
    tangential,
    specularPartner,
  };
}

const FACE_DIRECTIONS: Readonly<Record<Lbm3dFace, FaceDirections>> =
  Object.fromEntries(
    LBM3D_FACES.map((face) => [face, faceDirections(face)]),
  ) as Readonly<Record<Lbm3dFace, FaceDirections>>;

/**
 * Applies the six face conditions to the streaming scratch (`fTmp`,
 * post-streaming; convective reads the pre-step `f`), skipping solid
 * nodes and accumulating the overwrite ledger. The macroscopic fields
 * (`state.ux/uy/uz`) are the step-start values — the standard lagged
 * source for the convective speed and the pressure condition's
 * tangential components.
 */
export function lbm3dApplyFaceConditions(
  state: Lbm3dState,
  conditions: Readonly<Record<Lbm3dFace, Lbm3dFaceCondition>>,
  ledger: Lbm3dFaceMomentumLedger,
): void {
  ledger.x = 0;
  ledger.y = 0;
  ledger.z = 0;
  for (const face of LBM3D_FACE_ORDER) {
    const condition = conditions[face];
    if (condition === undefined) continue;
    applyFace(state, face, condition, ledger);
  }
}

/**
 * Reads one of a Zou/He reconstruction's "known" populations: the
 * post-streaming value when its source node lies in the domain, and —
 * at an EDGE, where the source itself lies beyond the perpendicular
 * face and the slot is honestly zero — the equilibrium value at the
 * node's own (lagged) macroscopic state. That equilibrium completion
 * keeps the reconstruction's moments physical instead of dividing
 * zeros into ρ, and it is deterministic (the 2D corner closure).
 */
function readKnown(
  state: Lbm3dState,
  i: number,
  index: number,
  x: number,
  y: number,
  z: number,
): number {
  const [cx, cy, cz] = velocityOf(i);
  const sourceX = x - cx;
  const sourceY = y - cy;
  const sourceZ = z - cz;
  if (
    sourceX >= 0 &&
    sourceX < state.nx &&
    sourceY >= 0 &&
    sourceY < state.ny &&
    sourceZ >= 0 &&
    sourceZ < state.nz
  ) {
    return state.fTmp[i]?.[index] ?? 0;
  }
  return d3q19Equilibrium(
    i,
    state.rho[index] ?? 1,
    state.ux[index] ?? 0,
    state.uy[index] ?? 0,
    state.uz[index] ?? 0,
  );
}

/** Writes one value, booking its momentum change into the ledger. */
function write(
  state: Lbm3dState,
  i: number,
  index: number,
  value: number,
  ledger: Lbm3dFaceMomentumLedger,
): void {
  const column = state.fTmp[i];
  if (column === undefined) return;
  const previous = column[index] ?? 0;
  column[index] = value;
  const [cx, cy, cz] = velocityOf(i);
  ledger.x += (value - previous) * cx;
  ledger.y += (value - previous) * cy;
  ledger.z += (value - previous) * cz;
}

/** The macroscopic velocity at a node, zeroed over solids (stale there). */
function macroscopicVelocity(
  state: Lbm3dState,
  index: number,
): readonly [number, number, number] {
  if (state.solid.solid[index] === 1) return [0, 0, 0];
  return [state.ux[index] ?? 0, state.uy[index] ?? 0, state.uz[index] ?? 0];
}

function applyFace(
  state: Lbm3dState,
  face: Lbm3dFace,
  condition: Lbm3dFaceCondition,
  ledger: Lbm3dFaceMomentumLedger,
): void {
  const directions = FACE_DIRECTIONS[face];
  const { axis, inward } = directions.geometry;
  const { nx, ny, nz } = state;
  const extents = [nx, ny, nz] as const;
  const strides = [1, nx, nx * ny] as const;
  const fixed = inward === 1 ? 0 : (extents[axis] ?? 1) - 1;
  const tangentialAxes = ([0, 1, 2] as const).filter((index) => index !== axis);
  const [t1, t2] = tangentialAxes;
  if (t1 === undefined || t2 === undefined) return;
  for (let u2 = 0; u2 < (extents[t2] ?? 1); u2 += 1) {
    for (let u1 = 0; u1 < (extents[t1] ?? 1); u1 += 1) {
      const coords: [number, number, number] = [0, 0, 0];
      coords[axis] = fixed;
      coords[t1] = u1;
      coords[t2] = u2;
      const index =
        (coords[0] ?? 0) * strides[0] +
        (coords[1] ?? 0) * strides[1] +
        (coords[2] ?? 0) * strides[2];
      if (state.solid.solid[index] === 1) continue;
      const x = coords[0] ?? 0;
      const y = coords[1] ?? 0;
      const z = coords[2] ?? 0;
      // The arrived values, read once (the edge closure rides inside).
      const arrived: number[] = [];
      for (let i = 0; i < D3Q19_Q; i += 1) {
        arrived.push(readKnown(state, i, index, x, y, z));
      }
      const neighborIndex = index + inward * (strides[axis] ?? 1);
      switch (condition.kind) {
        case "velocity": {
          const velocity: [number, number, number] = [
            condition.ux,
            condition.uy,
            condition.uz,
          ];
          reconstruct(
            state,
            directions,
            index,
            velocity,
            solveDensity(
              directions,
              arrived,
              normalComponentOf(axis, inward, velocity),
            ),
            arrived,
            ledger,
          );
          break;
        }
        case "pressure": {
          const normal = solveNormal(directions, arrived, condition.rho);
          const tangential = macroscopicVelocity(state, neighborIndex);
          const velocity: [number, number, number] = [
            tangential[0],
            tangential[1],
            tangential[2],
          ];
          velocity[axis] = normal * inward;
          reconstruct(
            state,
            directions,
            index,
            velocity,
            condition.rho,
            arrived,
            ledger,
          );
          break;
        }
        case "convective-outflow": {
          const own = macroscopicVelocity(state, index);
          const speed = Math.max(0, Math.min(0.5, -(own[axis] ?? 0) * inward));
          for (const i of directions.missing) {
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
          break;
        }
        case "wall":
        case "symmetry": {
          const specular = condition.kind === "symmetry" || condition.slip;
          for (const i of directions.missing) {
            const partner = specular
              ? (directions.specularPartner[i] ?? D3Q19_OPPOSITE[i] ?? 0)
              : (D3Q19_OPPOSITE[i] ?? 0);
            write(state, i, index, state.f[partner]?.[index] ?? 0, ledger);
          }
          break;
        }
      }
    }
  }
}

/** The velocity's normal component along the face's inward direction. */
function normalComponentOf(
  axis: 0 | 1 | 2,
  inward: 1 | -1,
  velocity: readonly [number, number, number],
): number {
  return (velocity[axis] ?? 0) * inward;
}

/** The mass elimination's density solve (velocity form). */
function solveDensity(
  directions: FaceDirections,
  arrived: readonly number[],
  normalVelocity: number,
): number {
  let base = 0;
  for (const i of directions.knownBase) base += arrived[i] ?? 0;
  for (const i of directions.knownOutbound) base += arrived[i] ?? 0;
  return base / (1 - normalVelocity);
}

/** The mass elimination's normal-velocity solve (pressure form). */
function solveNormal(
  directions: FaceDirections,
  arrived: readonly number[],
  rho: number,
): number {
  let base = 0;
  for (const i of directions.knownBase) base += arrived[i] ?? 0;
  for (const i of directions.knownOutbound) base += arrived[i] ?? 0;
  return 1 - base / rho;
}

/**
 * The Zou/He reconstruction proper: writes the five missing populations
 * from (u, ρ) — the axis pair, then each tangential plane's diagonal
 * pair from its sum/difference split (the module contract's closure).
 */
function reconstruct(
  state: Lbm3dState,
  directions: FaceDirections,
  index: number,
  velocity: readonly [number, number, number],
  rho: number,
  arrived: readonly number[],
  ledger: Lbm3dFaceMomentumLedger,
): void {
  const { axis, inward } = directions.geometry;
  const uNormal = (velocity[axis] ?? 0) * inward;
  write(
    state,
    directions.axisIn,
    index,
    (arrived[directions.axisOut] ?? 0) + (1 / 3) * rho * uNormal,
    ledger,
  );
  for (const closure of directions.tangential) {
    const t = closure.axis;
    let moment = 0;
    for (const i of closure.knownMoment) {
      moment += (arrived[i] ?? 0) * (velocityOf(i)[t] ?? 0);
    }
    const difference = rho * (velocity[t] ?? 0) - moment;
    const sum =
      (arrived[closure.mPlus] ?? 0) +
      (arrived[closure.mMinus] ?? 0) +
      (1 / 3) * rho * uNormal;
    write(state, closure.dPlus, index, (sum + difference) / 2, ledger);
    write(state, closure.dMinus, index, (sum - difference) / 2, ledger);
  }
}
