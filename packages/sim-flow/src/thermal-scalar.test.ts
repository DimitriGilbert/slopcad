/**
 * The passive-scalar thermal march's unit pins (Phase 65b): the
 * harmonic interface conductance against hand values, the pure-diffusion
 * steady state against the exact discrete profile (the half-cell wall
 * placement), the conservative face set's exact internal cancellation
 * (a closed adiabatic box conserves its energy to float rounding), the
 * donor-cell advection's centroid velocity (exactly u, the scheme's
 * transport statement), the interface ledger's by-construction identity
 * (the fluid's gain IS the solid's bookkeeping, one flux), the
 * stability timestep against the documented row-sum formula, and the
 * honest refusals. Node-env vitest, no network — the law-S2 stance.
 */

import { describe, expect, it } from "vitest";

import { analyticOccupancy } from "./fixtures";
import {
  createLbmThermalScalar,
  lbmInterfaceConductanceWPerMK,
  type LbmThermalFaceCondition,
  type LbmThermalScalar,
  type LbmThermalScalarConfig,
} from "./thermal-scalar";

const NX = 12;
const NY = 3;
const DX = 0.01;
const RHO0 = 1.2;
const CP = 1006;
const K_FLUID = 0.026;
const T_INITIAL = 300;
const ADIABATIC: LbmThermalFaceCondition = { kind: "adiabatic" };

function allFluidMask(nx = NX, ny = NY): Uint8Array {
  return analyticOccupancy(nx, ny, () => false);
}

function scalarConfig(
  overrides: Partial<LbmThermalScalarConfig> = {},
): LbmThermalScalarConfig {
  const nx = overrides.mask?.nx ?? NX;
  const ny = overrides.mask?.ny ?? NY;
  return {
    mask: { nx, ny, solid: allFluidMask(nx, ny) },
    cellSizeM: DX,
    referenceDensityKgPerM3: RHO0,
    referenceTemperatureK: T_INITIAL,
    specificHeatJPerKgK: CP,
    thermalConductivityWPerMK: K_FLUID,
    solidConductivityWPerMK: new Float64Array(nx * ny).fill(1),
    initialTemperatureK: T_INITIAL,
    west: ADIABATIC,
    east: ADIABATIC,
    south: ADIABATIC,
    north: ADIABATIC,
    ...overrides,
  };
}

function zeroVelocity(count: number): {
  vx: Float64Array;
  vy: Float64Array;
} {
  return { vx: new Float64Array(count), vy: new Float64Array(count) };
}

function make(config: LbmThermalScalarConfig): LbmThermalScalar {
  const created = createLbmThermalScalar(config);
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

describe("the harmonic interface conductance", () => {
  it("equals the series-resistance hand value and degenerates to the insulator", () => {
    // Air against steel: 2·k_f·k_s/(k_f + k_s) — fluid-side dominated.
    expect(lbmInterfaceConductanceWPerMK(0.026, 45)).toBeCloseTo(
      (2 * 0.026 * 45) / (0.026 + 45),
      15,
    );
    // Symmetric in its arguments.
    expect(lbmInterfaceConductanceWPerMK(45, 0.026)).toBe(
      lbmInterfaceConductanceWPerMK(0.026, 45),
    );
    // Equal conductivities: the plain cell conductance 2kA/d factor.
    expect(lbmInterfaceConductanceWPerMK(0.026, 0.026)).toBeCloseTo(0.026, 15);
    // A perfect insulator solid couples nothing.
    expect(lbmInterfaceConductanceWPerMK(0.026, 0)).toBe(0);
    expect(lbmInterfaceConductanceWPerMK(0, 45)).toBe(0);
  });
});

describe("the passive-scalar march", () => {
  it("settles at the exact discrete linear profile between Dirichlet walls", () => {
    const hot = 310;
    const cold = 290;
    const scalar = make(
      scalarConfig({
        west: { kind: "fixed-temperature", temperatureK: hot },
        east: { kind: "fixed-temperature", temperatureK: cold },
      }),
    );
    const { vx, vy } = zeroVelocity(NX * NY);
    const dt = scalar.stabilityTimeStepS(vx, vy, 0.5);
    expect(dt).toBeGreaterThan(0);
    // March past the diffusive settling time (capacity/k · n² at the
    // stability limit decays the slowest mode geometrically).
    for (let substep = 0; substep < 6000; substep += 1) {
      scalar.advance(dt, vx, vy);
    }
    expect(scalar.diverged).toBe(false);
    // The discrete steady state: each node sits half a cell in from
    // its wall, T_i = T_h + (i + 1/2)·(T_c − T_h)/nx — the same
    // half-way placement the LBM's bounce-back walls use.
    const slope = (cold - hot) / NX;
    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        expect(scalar.temperatureK[x + y * NX]).toBeCloseTo(
          hot + (x + 0.5) * slope,
          8,
        );
      }
    }
    // The wall ledger booked the flux the profile implies (positive:
    // the hot wall heated the fluid overall? net over both walls the
    // box gained nothing at steady — the transient net is positive
    // since the box started at 300, between the walls' mean of 300:
    // the ledger measures the transient integral; pin it against the
    // inventory by the closed-wall balance).
    const capacity = RHO0 * CP * DX * DX;
    let inventory = 0;
    for (let index = 0; index < NX * NY; index += 1) {
      inventory += capacity * (scalar.temperatureK[index] ?? 0);
    }
    const initial = capacity * NX * NY * T_INITIAL;
    expect(scalar.boundaryEnergyInJPerM).toBeCloseTo(inventory - initial, 9);
  });

  it("conserves a closed adiabatic box's energy exactly (internal faces cancel pairwise)", () => {
    const scalar = make(scalarConfig());
    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        const index = x + y * NX;
        scalar.temperatureK[index] =
          T_INITIAL + 8 * Math.sin((2 * Math.PI * (2 * x + 1)) / (2 * NX));
      }
    }
    const energy0 = scalar.fluidEnergyJPerM(T_INITIAL);
    const { vx, vy } = zeroVelocity(NX * NY);
    const dt = scalar.stabilityTimeStepS(vx, vy, 0.5);
    for (let substep = 0; substep < 200; substep += 1) {
      scalar.advance(dt, vx, vy);
    }
    expect(scalar.diverged).toBe(false);
    // No boundary, no interface: the only faces are internal, each
    // applied to both cells — the total is conserved to float rounding.
    expect(scalar.fluidEnergyJPerM(T_INITIAL)).toBeCloseTo(energy0, 9);
    expect(scalar.boundaryEnergyInJPerM).toBe(0);
    expect(scalar.interfaceExchangeJPerM().every((value) => value === 0)).toBe(
      true,
    );
  });

  it("transports a block at the driving velocity, pinned against the 1D recurrence", () => {
    const nx = 20;
    const ny = 5;
    const scalar = make(
      scalarConfig({ mask: { nx, ny, solid: allFluidMask(nx, ny) } }),
    );
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const index = x + y * nx;
        scalar.temperatureK[index] =
          x >= 2 && x <= 5 ? T_INITIAL + 12 : T_INITIAL;
      }
    }
    const centroid = (): number => {
      let weighted = 0;
      let total = 0;
      for (let y = 0; y < ny; y += 1) {
        for (let x = 0; x < nx; x += 1) {
          const index = x + y * nx;
          weighted += (x + 0.5) * (scalar.temperatureK[index] ?? 0);
          total += scalar.temperatureK[index] ?? 0;
        }
      }
      return weighted / total;
    };
    const centroid0 = centroid();
    const vx = new Float64Array(nx * ny).fill(0.03);
    const vy = new Float64Array(nx * ny);
    const dt = scalar.stabilityTimeStepS(vx, vy, 0.5);
    // The independent 1D mirror of the march's own face statement —
    // same faces, same donor rule (upwind = the side material comes
    // from), written column-wise: any sign, donor, or coefficient
    // error in the 2D march breaks the bitwise-band agreement.
    const capacity = RHO0 * CP * DX * DX;
    const gDiffusive = K_FLUID;
    const advective = RHO0 * CP * DX;
    const u = 0.03;
    let profile: number[] = [];
    for (let x = 0; x < nx; x += 1)
      profile.push(T_INITIAL + (x >= 2 && x <= 5 ? 12 : 0));
    const mirrorStep = (): void => {
      const next = [...profile];
      for (let x = 0; x < nx; x += 1) {
        // Each interior face's ONE flux, into-P convention: diffusion
        // plus donor-cell advection of the DEVIATION θ = T − T_ref
        // (the +x-directed advective flux ρ₀cp·u·θ_up LEAVES the left
        // cell of the pair) — the march's own statement, mirrored.
        const east =
          x + 1 < nx
            ? gDiffusive * ((profile[x + 1] ?? 0) - (profile[x] ?? 0)) -
              advective * u * ((profile[x] ?? 0) - T_INITIAL)
            : 0;
        const west =
          x - 1 >= 0
            ? gDiffusive * ((profile[x - 1] ?? 0) - (profile[x] ?? 0)) +
              advective * u * ((profile[x - 1] ?? 0) - T_INITIAL)
            : 0;
        next[x] = (profile[x] ?? 0) + (dt * (east + west)) / capacity;
      }
      profile = next;
    };
    const substeps = Math.max(1, Math.round(2 / dt));
    for (let substep = 0; substep < substeps; substep += 1) {
      scalar.advance(dt, vx, vy);
      mirrorStep();
    }
    expect(scalar.diverged).toBe(false);
    for (let x = 0; x < nx; x += 1) {
      let columnMean = 0;
      for (let y = 0; y < ny; y += 1) {
        columnMean += scalar.temperatureK[x + y * nx] ?? 0;
      }
      columnMean /= ny;
      expect(columnMean).toBeCloseTo(profile[x] ?? 0, 9);
    }
    // The transport statement itself, qualitative (the precision is
    // the mirror above): the blob's centroid advances WITH the flow —
    // the drift is diluted by the 300 K background in the absolute-T
    // centroid (the θ-mass itself moves at u, the mirror shows the
    // full profile), so only the direction is pinned here.
    const drift = centroid() - centroid0;
    expect(drift).toBeGreaterThan(0.01);
    // And the domain total is untouched: internal faces only.
    expect(scalar.boundaryEnergyInJPerM).toBe(0);
  });

  it("is blind to the kelvin baseline under a divergent checkerboard velocity", () => {
    // The Phase 65b stability finding, pinned: advecting the ABSOLUTE
    // temperature turned a 2e-7 m/s checkerboard velocity divergence
    // into a −T·χ ≈ −0.5 mW per cell source that closed an exponential
    // buoyancy loop (measured ×4 per coupling interval in the sealed
    // heated-block fixture). The donor carries the DEVIATION, whose
    // baseline is zero: a uniform field under the same velocity stays
    // EXACTLY uniform.
    const scalar = make(scalarConfig());
    const vx = new Float64Array(NX * NY);
    const vy = new Float64Array(NX * NY);
    for (let y = 0; y < NY; y += 1) {
      for (let x = 0; x < NX; x += 1) {
        const index = x + y * NX;
        const sign = x % 2 === 0 ? 1 : -1;
        vx[index] = sign * 2e-7;
        vy[index] = sign * 2e-7;
      }
    }
    const energy0 = scalar.fluidEnergyJPerM(T_INITIAL);
    const dt = scalar.stabilityTimeStepS(vx, vy, 0.5);
    for (let substep = 0; substep < 500; substep += 1) {
      scalar.advance(dt, vx, vy);
    }
    expect(scalar.diverged).toBe(false);
    expect(scalar.fluidEnergyJPerM(T_INITIAL)).toBeCloseTo(energy0, 9);
    expect(scalar.boundaryEnergyInJPerM).toBe(0);
    // The guard itself, not just its totals: on a uniform field the
    // θ-form's donor value is exactly zero at every face, so the field
    // stays EXACTLY uniform — max|T − T_ref| = 0 to the last bit. The
    // kelvin donor passes the two pins above (its −T_ref·χ checkerboard
    // sources sum to zero and cross no boundary); it cannot pass this
    // one — the divergence error acting on the baseline is a per-cell
    // source that moves the field off T_ref the moment it acts.
    let worstDeviationK = 0;
    for (let index = 0; index < NX * NY; index += 1) {
      worstDeviationK = Math.max(
        worstDeviationK,
        Math.abs((scalar.temperatureK[index] ?? 0) - T_INITIAL),
      );
    }
    expect(worstDeviationK).toBe(0);
  });

  it("books the interface exchange as the fluid's exact gain (one flux, both books)", () => {
    const nx = 7;
    const ny = 4;
    const solidMask = analyticOccupancy(nx, ny, (x) => x >= 5);
    const kSolid = 45;
    const scalar = make(
      scalarConfig({
        mask: { nx, ny, solid: solidMask },
        solidConductivityWPerMK: new Float64Array(nx * ny).fill(kSolid),
      }),
    );
    // The CHT driver's write: hot solid columns against cooler fluid.
    for (let index = 0; index < nx * ny; index += 1) {
      if (solidMask[index] === 1) scalar.temperatureK[index] = T_INITIAL + 40;
    }
    const energy0 = scalar.fluidEnergyJPerM(T_INITIAL);
    const { vx, vy } = zeroVelocity(nx * ny);
    const dt = 0.1 * scalar.stabilityTimeStepS(vx, vy, 1);
    scalar.advance(dt, vx, vy);
    expect(scalar.diverged).toBe(false);
    const gain = scalar.fluidEnergyJPerM(T_INITIAL) - energy0;
    const exchange = scalar.interfaceExchangeJPerM();
    let exchangeTotal = 0;
    for (const value of exchange) exchangeTotal += value;
    // The conservative identity: the fluid gained exactly the joules
    // the ledger says left the solid — one flux, applied to both books.
    expect(gain).toBeCloseTo(exchangeTotal, 12);
    expect(exchangeTotal).toBeGreaterThan(0);
    expect(scalar.boundaryEnergyInJPerM).toBe(0);
    // The ledger returns a copy (mutation of one read changes nothing).
    exchange[0] = 1e9;
    expect(scalar.interfaceExchangeJPerM()[0]).not.toBe(1e9);
  });

  it("computes the documented row-sum stability timestep", () => {
    const nx = 5;
    const ny = 3;
    const solidMask = analyticOccupancy(nx, ny, (x) => x === 0);
    const kSolid = 45;
    const scalar = make(
      scalarConfig({
        mask: { nx, ny, solid: solidMask },
        solidConductivityWPerMK: new Float64Array(nx * ny).fill(kSolid),
        north: { kind: "fixed-temperature", temperatureK: 305 },
      }),
    );
    const capacity = RHO0 * CP * DX * DX;
    const gFluid = K_FLUID;
    const gInterface = lbmInterfaceConductanceWPerMK(K_FLUID, kSolid);
    const gWall = 2 * K_FLUID;
    const advective = RHO0 * CP * DX;
    const mean = (a: number, b: number): number => (a + b) / 2;
    // Under motion the critical row is the four-fluid-face interior
    // cell (2, 1): Σ (G + ρ₀cp·A·|u_face|) with mean face velocities.
    const vx = new Float64Array(nx * ny).fill(0.02);
    const vy = new Float64Array(nx * ny).fill(-0.01);
    const p = 2 + 1 * nx;
    const interiorSum =
      4 * gFluid +
      advective *
        (Math.abs(mean(vx[p] ?? 0, vx[p + 1] ?? 0)) +
          Math.abs(mean(vx[p - 1] ?? 0, vx[p] ?? 0)) +
          Math.abs(mean(vy[p] ?? 0, vy[p - nx] ?? 0)) +
          Math.abs(mean(vy[p] ?? 0, vy[p + nx] ?? 0)));
    expect(scalar.stabilityTimeStepS(vx, vy, 0.5)).toBeCloseTo(
      (0.5 * capacity) / interiorSum,
      15,
    );
    // At rest the critical row becomes the north-west corner fluid cell
    // (1, 2): the harmonic INTERFACE west (no advection — no flow
    // through a solid), a fluid east, a fluid south, and the half-cell
    // DIRICHLET wall north — every face kind the row sum must count.
    const still = scalar.stabilityTimeStepS(
      new Float64Array(nx * ny),
      new Float64Array(nx * ny),
      0.5,
    );
    const cornerSum = gInterface + 2 * gFluid + gWall;
    expect(still).toBeCloseTo((0.5 * capacity) / cornerSum, 15);
  });

  it("refuses the inputs an honest march cannot run", () => {
    const badMask = createLbmThermalScalar(
      scalarConfig({ mask: { nx: 2, ny: 2, solid: new Uint8Array(4) } }),
    );
    expect(badMask.ok).toBe(false);

    const badSolidValues = createLbmThermalScalar(
      scalarConfig({
        mask: { nx: NX, ny: NY, solid: new Uint8Array(NX * NY).fill(2) },
      }),
    );
    expect(badSolidValues.ok).toBe(false);

    const badConductivity = createLbmThermalScalar(
      scalarConfig({ thermalConductivityWPerMK: -0.1 }),
    );
    expect(badConductivity.ok).toBe(false);

    const badArray = createLbmThermalScalar(
      scalarConfig({
        solidConductivityWPerMK: new Float64Array(3),
      }),
    );
    expect(badArray.ok).toBe(false);

    const badSolidK = createLbmThermalScalar(
      scalarConfig({
        solidConductivityWPerMK: new Float64Array(NX * NY).fill(-1),
      }),
    );
    expect(badSolidK.ok).toBe(false);

    const badInitial = createLbmThermalScalar(
      scalarConfig({ initialTemperatureK: 0 }),
    );
    expect(badInitial.ok).toBe(false);

    const badWall = createLbmThermalScalar(
      scalarConfig({
        west: { kind: "fixed-temperature", temperatureK: -5 },
      }),
    );
    expect(badWall.ok).toBe(false);

    const nonFiniteSolidK = createLbmThermalScalar(
      scalarConfig({
        solidConductivityWPerMK: new Float64Array(NX * NY).fill(Number.NaN),
      }),
    );
    expect(nonFiniteSolidK.ok).toBe(false);
  });
});
