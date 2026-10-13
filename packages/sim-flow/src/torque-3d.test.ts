/**
 * The torque integration's tests (Phase 66b): hand-value pins of the
 * momentum-exchange moment — a known velocity field's moment about the
 * axis, computed by hand against the sink arithmetic — for the static
 * wall (MRF's rotor-in-frame) and the rotating wall (resolved
 * rotation's moving-boundary correction), plus the accumulator's SI
 * conversion and series shape. Node env, no LBM run: the state is
 * hand-built and the reflection pass is called directly.
 */

import { describe, expect, it } from "vitest";
import type { Lbm3dRotationAxis } from "./rotation-3d";

import {
  D3Q19_OPPOSITE,
  D3Q19_Q,
  D3Q19_VELOCITIES,
  D3Q19_WEIGHTS,
} from "./d3q19";
import { testFluid } from "./fixtures";
import { lbm3dUnitSystem } from "./lattice-units-3d";
import {
  createLbm3dState,
  lbm3dReflectSolids,
  type Lbm3dSolidMask,
} from "./state-3d";
import {
  Lbm3dTorqueAccumulator,
  lbm3dRotatingWallTorqueSink,
  lbm3dStaticWallTorqueSink,
  type Lbm3dTorqueLedger,
} from "./torque-3d";

/**
 * The hand fixture: a 5×5×3 lattice with one solid node at (3, 2, 1),
 * the rotation axis +z through the origin corner (0, 0). The lever
 * arms are then the raw coordinates of the link midpoints — easy to
 * cross by hand.
 */
const NX = 5;
const NY = 5;
const NZ = 3;
const SOLID_INDEX = 3 + 2 * NX + 1 * NX * NY;
const AXIS: Lbm3dRotationAxis = {
  pointLattice: [0, 0, 0],
  direction: [0, 0, 1],
};

function handState(): ReturnType<typeof createLbm3dState> {
  const solid = new Uint8Array(NX * NY * NZ);
  solid[SOLID_INDEX] = 1;
  const mask: Lbm3dSolidMask = { nx: NX, ny: NY, nz: NZ, solid };
  return createLbm3dState(mask);
}

/** The direction index of a velocity triple (the fixture's arrivals). */
function directionOf(
  velocity: readonly [number, number, number],
): number | undefined {
  for (let i = 0; i < D3Q19_Q; i += 1) {
    const table = D3Q19_VELOCITIES[i];
    if (
      table !== undefined &&
      table[0] === velocity[0] &&
      table[1] === velocity[1] &&
      table[2] === velocity[2]
    ) {
      return i;
    }
  }
  return undefined;
}

/**
 * A post-streaming shape at the solid node: every column zero except
 * the named arrival (the streaming pass zeroes the scratch, so a hand
 * fixture must too — the constructor's equilibrium fill is not a
 * streamed state).
 */
function seedArrival(
  state: ReturnType<typeof createLbm3dState>,
  direction: number,
  value: number,
): void {
  for (let i = 0; i < D3Q19_Q; i += 1) {
    state.fTmp[i]![SOLID_INDEX] = 0;
  }
  state.fTmp[direction]![SOLID_INDEX] = value;
}

describe("the static-wall torque sink (MRF's rotor moment)", () => {
  it("pins the hand-computed axial moment of a diagonal arrival", () => {
    const state = handState();
    // One arrival: direction (1, 1, 0), value v = 0.02, streamed into
    // the solid node from the fluid source (2, 1, 1).
    const v = 0.02;
    const direction = directionOf([1, 1, 0]);
    if (direction === undefined) throw new Error("fixture direction absent");
    seedArrival(state, direction, v);
    // Hand values: impulse = 2v·c = (0.04, 0.04, 0); the link midpoint
    // is (3 − 0.5, 2 − 0.5) = (2.5, 1.5) from the axis, so the axial
    // moment is 2v·(r_x·c_y − r_y·c_x) = 0.04·(2.5 − 1.5) = 0.04.
    const ledger: Lbm3dTorqueLedger = { tauLat: 0 };
    const impulse = lbm3dReflectSolids(
      state,
      lbm3dStaticWallTorqueSink(ledger, AXIS),
    );
    expect(impulse.impulseX).toBeCloseTo(2 * v, 8);
    expect(impulse.impulseY).toBeCloseTo(2 * v, 8);
    expect(impulse.impulseZ).toBe(0);
    expect(ledger.tauLat).toBeCloseTo(2 * v, 8);
    // An axis-aligned arrival (1, 0, 0) from source (2, 2, 1): the
    // couple identity gives x·c_y − y·c_x = −2, so the axial moment is
    // −2·(2v) = −0.08 — the link line y = 2 sits two cells off the axis.
    const axial = handState();
    const axisDirection = directionOf([1, 0, 0]);
    if (axisDirection === undefined)
      throw new Error("fixture direction absent");
    seedArrival(axial, axisDirection, v);
    const axialLedger: Lbm3dTorqueLedger = { tauLat: 0 };
    lbm3dReflectSolids(axial, lbm3dStaticWallTorqueSink(axialLedger, AXIS));
    expect(axialLedger.tauLat).toBeCloseTo(-4 * v, 8);
  });
});

describe("the rotating-wall torque sink (resolved rotation's correction)", () => {
  /**
   * The moving wall corrects EVERY boundary link of the solid node —
   * the seeded arrival plus the eighteen links' own corrections. The
   * hand sum is closed-form through two exact identities of the linear
   * wall-velocity field u_w = Ω·(ê × r): (1) c·u_w at the link
   * midpoint equals c·u_w at the node (the correction term is
   * c·(Ω×c)/2 = 0), and (2) the axial couple of direction i is
   * ê·(r_mid × c) = x·c_y − y·c_x at the node (the half-link shifts
   * cancel). Every source except the seeded one carries ρ = 1; the
   * seeded source carries 1.3.
   */
  const OMEGA = 0.01;
  const RHO_SEED_SOURCE = 1.3;
  const SEEDED_VALUE = 0.02;

  function handRotatingTotals(): {
    impulseX: number;
    impulseY: number;
    impulseZ: number;
    tauLat: number;
  } {
    // u_w at the solid node (3, 2, 1), axis +z through the origin:
    // Ω·(ê × r) = Ω·(−2, 3, 0).
    const wx = OMEGA * -2;
    const wy = OMEGA * 3;
    let impulseX = 0;
    let impulseY = 0;
    let impulseZ = 0;
    let tauLat = 0;
    for (let i = 1; i < D3Q19_Q; i += 1) {
      const [cx, cy, cz] = D3Q19_VELOCITIES[i] ?? [0, 0, 0];
      const isSeed = cx === 1 && cy === 1 && cz === 0;
      const rho = isSeed ? RHO_SEED_SOURCE : 1;
      const value = isSeed ? SEEDED_VALUE : 0;
      const delta = -6 * (D3Q19_WEIGHTS[i] ?? 0) * rho * (cx * wx + cy * wy);
      impulseX += (2 * value + delta) * cx;
      impulseY += (2 * value + delta) * cy;
      impulseZ += (2 * value + delta) * cz;
      // Axial couple: x·c_y − y·c_x at the node.
      tauLat += (2 * value + delta) * (3 * cy - 2 * cx);
    }
    return { impulseX, impulseY, impulseZ, tauLat };
  }

  it("pins the hand-computed moving-wall corrections and moment", () => {
    const state = handState();
    const direction = directionOf([1, 1, 0]);
    if (direction === undefined) throw new Error("fixture direction absent");
    seedArrival(state, direction, SEEDED_VALUE);
    state.rho[2 + 1 * NX + 1 * NX * NY] = RHO_SEED_SOURCE;
    const rotor = new Uint8Array(NX * NY * NZ);
    rotor[SOLID_INDEX] = 1;
    const ledger: Lbm3dTorqueLedger = { tauLat: 0 };
    const impulse = lbm3dReflectSolids(
      state,
      lbm3dRotatingWallTorqueSink(
        ledger,
        AXIS,
        OMEGA,
        rotor,
        state.rho,
        NX,
        NY,
      ),
    );
    const hand = handRotatingTotals();
    expect(impulse.impulseX).toBeCloseTo(hand.impulseX, 8);
    expect(impulse.impulseY).toBeCloseTo(hand.impulseY, 8);
    expect(impulse.impulseZ).toBeCloseTo(hand.impulseZ, 8);
    expect(ledger.tauLat).toBeCloseTo(hand.tauLat, 8);
    // The seeded population's parked value carries its own correction:
    // δ_seed = −(1/6)·1.3·((1,1,0)·(−0.02, 0.03, 0)) = −1.3/600.
    expect(
      state.fTmp[D3Q19_OPPOSITE[direction] ?? 0]![SOLID_INDEX],
    ).toBeCloseTo(SEEDED_VALUE - RHO_SEED_SOURCE / 600, 8);
  });

  it("leaves static-solid links uncorrected and off the rotor ledger", () => {
    const state = handState();
    const direction = directionOf([1, 1, 0]);
    if (direction === undefined) throw new Error("fixture direction absent");
    seedArrival(state, direction, SEEDED_VALUE);
    // The solid node is NOT rotor: no correction, no rotor torque.
    const rotor = new Uint8Array(NX * NY * NZ);
    const ledger: Lbm3dTorqueLedger = { tauLat: 0 };
    const impulse = lbm3dReflectSolids(
      state,
      lbm3dRotatingWallTorqueSink(
        ledger,
        AXIS,
        OMEGA,
        rotor,
        state.rho,
        NX,
        NY,
      ),
    );
    expect(impulse.impulseX).toBeCloseTo(2 * SEEDED_VALUE, 8);
    expect(impulse.impulseY).toBeCloseTo(2 * SEEDED_VALUE, 8);
    expect(impulse.impulseZ).toBe(0);
    expect(ledger.tauLat).toBe(0);
  });
});

describe("the axial-torque accumulator", () => {
  it("converts lattice torque to SI once and owns the series", () => {
    const units = lbm3dUnitSystem({
      cellSizeM: 0.001,
      characteristicVelocityMPerS: 0.075,
      kinematicViscosityM2PerS: testFluid(1.2, 1.5e-4).kinematicViscosityM2PerS,
      referenceDensityKgPerM3: 1.2,
    });
    if (!units.ok) throw new Error(units.error.message);
    const accumulator = new Lbm3dTorqueAccumulator(units.value);
    expect(accumulator.length).toBe(0);
    expect(accumulator.current().torqueNPerM).toBe(0);
    accumulator.record(0.5);
    accumulator.record(-0.25);
    const factor = units.value.forceFactor * units.value.cellSizeM;
    expect(accumulator.length).toBe(2);
    expect(accumulator.current().torqueNPerM).toBeCloseTo(-0.25 * factor, 15);
    const series = accumulator.history();
    expect(series).toHaveLength(1);
    expect(series[0]?.name).toBe("torque");
    expect(series[0]?.unit).toBe("N·m");
    expect(series[0]?.samples).toEqual([0.5 * factor, -0.25 * factor]);
  });
});
