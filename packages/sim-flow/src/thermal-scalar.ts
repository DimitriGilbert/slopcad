/**
 * The fluid-side thermal field (Phase 65b): a cell-centred
 * finite-volume ADVECTION–DIFFUSION march of one scalar temperature
 * over the LBM grid's FLUID cells — the winner of the in-phase
 * double-distribution-vs-passive-scalar decision (`thermal-decision`
 * fixtures; the matrix and its numbers are pinned there). The
 * decision in one paragraph: a second lattice for T (the
 * double-distribution form) couples to conjugate solid cells through
 * anti-bounce-back, whose interface exchange is NOT conservative (a
 * closed chain's inventory drifts 3–7 % — measured, naive and
 * τ-corrected forms alike) and whose interface placement is
 * structurally wrong at material contrast (4.5 K at 10:1 — measured,
 * τ-independent) — while the finite-volume scalar's interface face
 * flux is ONE number, the harmonic-mean conductance against the
 * adjacent solid cell's temperature, applied with opposite signs on
 * the two sides of the face. That is exactly the roadmap risk note's
 * default answer ("conservative interpolation"), and it is what makes
 * the Phase 65b energy ledger close by construction: what the fluid
 * gains at an interface face, the solid solve receives as its source,
 * the same joules.
 *
 * ## The scheme (per unit depth, SI, law S4)
 *
 * Boussinesq constant-property energy balance over fluid cell P:
 *
 *   ρ₀·cp·V·dT_P/dt = Σ_faces [ G·(T_N − T_P)  (diffusion)
 *                                + ṁ·cp·θ_up    (donor-cell advection,
 *                                  ṁ = ρ₀·u_face·A, θ = T − T_ref) ],
 *
 * with the conservative face set, each face computed ONCE and applied
 * to both cells in the into-P convention — diffusion G·(T_N − T_P)
 * plus the donor-cell advection −ρ₀cp·u_face·θ_up (the +x-directed
 * flux ρ₀cp·u·θ_up LEAVES the pair's left cell; θ_up is the donor's
 * DEVIATION from the Boussinesq reference, the side material comes
 * from) — so the internal pair cancels identically and global
 * advection conserves Σρ₀cpV·(T − T_ref) exactly regardless of
 * divergence, the property the ledger's fluid half rides on.
 *
 * **Why the donor carries θ, not the absolute kelvin** (measured, the
 * Phase 65b stability finding): the LBM's face-mean velocity
 * reconstruction carries a small grid-scale divergence error χ; a
 * conservative flux of the ABSOLUTE temperature turns that error into
 * a source −T·χ ≈ −300 K·χ — a 2e-7 m/s checkerboard velocity
 * divergence pumped 0.5 mW per cell, closing an exponential
 * buoyancy-coupled loop (T checkerboard → per-node Boussinesq force
 * → velocity checkerboard → baseline-amplified divergence → T
 * checkerboard, ×4 per coupling interval, measured). Advecting the
 * deviation — the Boussinesq equation's own variable, whose baseline
 * is ~0 — removes the amplification exactly: for a truly
 * incompressible field (∇·u = 0) the two forms are identical, and
 * the dropped term is nothing but the reconstruction's numerical
 * garbage acting on a constant.
 *
 * - **Fluid–fluid** — G = k_f·A/d (uniform fluid, A = dx·1 m of
 *   depth); the face velocity is the two-node mean.
 * - **Fluid–solid (the CHT interface)** — the HARMONIC mean
 *   conductance G = 2·k_f·k_s/(k_f + k_s)·A/d: the series resistance
 *   of the two half-cells, the identical expression the Phase 65a
 *   assembly uses between two solid cells — the fluid acts as a
 *   conduction cell of conductivity k_f, which is exactly what a
 *   conjugate interface means. No advection (no flow through a
 *   solid).
 * - **Domain walls** — Dirichlet: G = k_f·A/(d/2) = 2·k_f (the wall
 *   sits half a cell outside the boundary node — the same half-way
 *   placement the LBM's bounce-back walls use, the two solvers'
 *   boundary geometry agreeing by construction), CONDUCTION ONLY:
 *   the no-slip wall's normal velocity is zero, and carrying
 *   advection at the boundary node's velocity would double-count
 *   bounce-back's half-cell slip (measured: it pumped the
 *   differentially-heated cavity's mean above both walls). Adiabatic
 *   walls exchange nothing.
 *
 * The march is EXPLICIT (forward Euler, frozen pre-step field — the
 * Jacobi discipline the 65a transient states) with the timestep from
 * the same row-sum criterion the 65a explicit march uses: dt ≤
 * safety·min_P ρ₀cpV_P/Σ_faces(G + ρ₀cp·A·|u_face|), every face
 * coefficient — interface and Dirichlet wall included — counted
 * once. A non-finite temperature is the divergence sentinel: the
 * march freezes and reports itself, never fabricates a field.
 *
 * Determinism (law S2): fixed face-visit order (rows, east faces then
 * north faces, then the interface/wall pass in row-major node order),
 * float64 arithmetic, no state beyond the field and the cumulative
 * ledgers — the same inputs march bitwise-identically.
 */

import {
  type SimError,
  SIM_ERROR_CODES,
  type SimParseResult,
  simError,
  simFail,
  simOk,
} from "@slopcad/sim-core";
import type { LbmSolidMask } from "./state";

/** The scalar's domain-wall vocabulary (closed buoyant fixtures' walls). */
export type LbmThermalFaceCondition =
  | {
      /** Dirichlet: the fixed wall temperature, K (the wall half a cell out). */
      readonly kind: "fixed-temperature";
      readonly temperatureK: number;
    }
  | { readonly kind: "adiabatic" };

/** What {@link createLbmThermalScalar} consumes — SI at the door, law S4. */
export interface LbmThermalScalarConfig {
  readonly mask: LbmSolidMask;
  /** The lattice cell size, m — the control volume's in-plane extent. */
  readonly cellSizeM: number;
  /** The Boussinesq reference density ρ₀, kg/m³ (constant property). */
  readonly referenceDensityKgPerM3: number;
  /**
   * The Boussinesq reference temperature T_ref, K — the ADVECTION's
   * zero point: the donor cell carries T − T_ref (the deviation the
   * coupling's own buoyancy term linearizes around), never the
   * absolute kelvin baseline. See the header's advection paragraph.
   */
  readonly referenceTemperatureK: number;
  /** The fluid's specific heat, J/(kg·K). */
  readonly specificHeatJPerKgK: number;
  /** The fluid's conductivity k_f, W/(m·K) — the diffusion coefficient with cp. */
  readonly thermalConductivityWPerMK: number;
  /** Per-node solid conductivity, W/(m·K) — read at solid neighbours (interface G). */
  readonly solidConductivityWPerMK: Float64Array;
  /** The uniform initial temperature, K (fluid and solid columns alike). */
  readonly initialTemperatureK: number;
  readonly west: LbmThermalFaceCondition;
  readonly east: LbmThermalFaceCondition;
  readonly south: LbmThermalFaceCondition;
  readonly north: LbmThermalFaceCondition;
}

/**
 * The harmonic-mean interface conductance per unit depth, W/(K·m):
 * 2·k_f·k_s/(k_f + k_s) — the two half-cells' series resistance, the
 * Phase 65a interior-face expression evaluated on the fluid–solid
 * pair. Degenerate k = 0 (a perfect insulator solid) gives G = 0, the
 * honest insulated interface.
 */
export function lbmInterfaceConductanceWPerMK(
  fluidConductivityWPerMK: number,
  solidConductivityWPerMK: number,
): number {
  const sum = fluidConductivityWPerMK + solidConductivityWPerMK;
  return sum > 0
    ? (2 * fluidConductivityWPerMK * solidConductivityWPerMK) / sum
    : 0;
}

/** The passive-scalar march state — owned by the CHT driver, exported for tests. */
export interface LbmThermalScalar {
  readonly nx: number;
  readonly ny: number;
  /**
   * The shared temperature field, K per node (`x + y·nx`): FLUID
   * columns are this march's own state; SOLID columns are the CHT
   * solid solve's cell temperatures, written between coupling
   * intervals by the coupled driver (`./cht`) and read here as the
   * frozen interface neighbour. The buoyancy force (`./buoyancy`)
   * reads the same array — one field, three consumers, zero copies.
   */
  readonly temperatureK: Float64Array;
  /** Whether the march froze at a non-finite temperature (the sentinel). */
  get diverged(): boolean;
  /** The completed substep count (frozen on divergence). */
  get steps(): number;
  /**
   * The cumulative wall-exchange ledger, J per metre of depth:
   * Σ dt·Q over every domain-wall face (Dirichlet diffusion and wall
   * advection alike; positive = into the fluid). The audit's fluid
   * boundary term.
   */
  get boundaryEnergyInJPerM(): number;
  /**
   * The cumulative interface exchange per SOLID node, J per metre:
   * positive = energy that left the solid into the fluid. The CHT
   * driver subtracts exactly this from the solid solve's source — the
   * by-construction cancellation the ledger closes on.
   */
  interfaceExchangeJPerM(): Float64Array;
  /**
   * One explicit substep at `dtS` seconds under the given SI velocity
   * snapshot (m/s per node, full-grid; solid columns ignored). A
   * no-op once diverged.
   */
  advance(
    dtS: number,
    velocityXMPerS: Float64Array,
    velocityYMPerS: Float64Array,
  ): void;
  /**
   * The row-sum stability timestep at the current field and the given
   * velocity snapshot, seconds: safety · min_P ρ₀cpV_P/Σ_faces(G +
   * ρ₀cp|u|A), interface and Dirichlet conductances counted. Infinity
   * when nothing couples any fluid cell (the sample interval bounds
   * the march).
   */
  stabilityTimeStepS(
    velocityXMPerS: Float64Array,
    velocityYMPerS: Float64Array,
    safetyFactor: number,
  ): number;
  /** The fluid cells' total energy above a reference, J/m (ρ₀cpV·(T − T_ref)). */
  fluidEnergyJPerM(referenceK: number): number;
}

/**
 * Creates the scalar march at the uniform initial temperature,
 * refusing the inputs an honest march cannot run: mask shape and
 * values, non-positive fluid properties, a mismatched conductivity
 * array, non-finite boundary temperatures.
 */
export function createLbmThermalScalar(
  config: LbmThermalScalarConfig,
): SimParseResult<LbmThermalScalar, SimError> {
  const refuse = (
    message: string,
    at: unknown,
  ): SimParseResult<never, SimError> =>
    simFail(simError(SIM_ERROR_CODES.scenarioInvalid, message, at));
  const { mask } = config;
  const nx = mask.nx;
  const ny = mask.ny;
  if (nx < 3 || ny < 3 || mask.solid.length !== nx * ny) {
    return refuse(
      `A thermal scalar's mask needs integer extents of at least 3 and nx·ny values, received ${String(nx)}×${String(ny)} with ${String(mask.solid.length)} values.`,
      { nx, ny, length: mask.solid.length },
    );
  }
  for (const value of mask.solid) {
    if (value !== 0 && value !== 1) {
      return refuse(
        `A thermal scalar's mask values must each be exactly 0 or 1, received ${String(value)}.`,
        value,
      );
    }
  }
  for (const [name, value] of [
    ["cell size", config.cellSizeM],
    ["reference density", config.referenceDensityKgPerM3],
    ["reference temperature", config.referenceTemperatureK],
    ["specific heat", config.specificHeatJPerKgK],
    ["thermal conductivity", config.thermalConductivityWPerMK],
    ["initial temperature", config.initialTemperatureK],
  ] as const) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      return refuse(
        `A thermal scalar's ${name} must be a positive finite SI value, received ${String(value)}.`,
        value,
      );
    }
  }
  if (
    !(config.solidConductivityWPerMK instanceof Float64Array) ||
    config.solidConductivityWPerMK.length !== nx * ny
  ) {
    return refuse(
      `A thermal scalar's solid conductivity array must be a Float64Array of exactly ${String(nx * ny)} values, received ${String(config.solidConductivityWPerMK.length)}.`,
      config.solidConductivityWPerMK.length,
    );
  }
  for (
    let index = 0;
    index < config.solidConductivityWPerMK.length;
    index += 1
  ) {
    const value = config.solidConductivityWPerMK[index] ?? 0;
    if (!Number.isFinite(value) || value < 0) {
      return refuse(
        `A thermal scalar's solid conductivities must be finite ≥ 0 (0 = perfect insulator), received ${String(value)} at node ${String(index)}.`,
        index,
      );
    }
  }
  const faceConditions = {
    west: config.west,
    east: config.east,
    south: config.south,
    north: config.north,
  } as const;
  for (const face of ["west", "east", "south", "north"] as const) {
    const condition = faceConditions[face];
    if (
      condition.kind === "fixed-temperature" &&
      (!Number.isFinite(condition.temperatureK) || condition.temperatureK <= 0)
    ) {
      return refuse(
        `A thermal scalar's ${face} fixed wall temperature must be a positive finite kelvin value, received ${String(condition.temperatureK)}.`,
        condition,
      );
    }
  }

  const count = nx * ny;
  const temperatureK = new Float64Array(count).fill(config.initialTemperatureK);
  const interfaceExchange = new Float64Array(count);
  const dx = config.cellSizeM;
  // Per unit depth: face area A = dx·1 m, capacity C = ρ₀·cp·dx²·1.
  const capacityJPerKPerM =
    config.referenceDensityKgPerM3 * config.specificHeatJPerKgK * dx * dx;
  const fluidG = config.thermalConductivityWPerMK; // k_f·A/d with A = dx, d = dx.
  const wallG = 2 * config.thermalConductivityWPerMK; // k_f·A/(d/2).
  const advectiveG =
    config.referenceDensityKgPerM3 * config.specificHeatJPerKgK * dx; // ρ₀cp·A.
  const referenceK = config.referenceTemperatureK; // the advection's zero point.
  let diverged = false;
  let steps = 0;
  let boundaryEnergyInJPerM = 0;

  // The four in-plane directions as (dx, dy) offsets with their stride,
  // in the fixed order the interface/wall pass walks.
  const directions = [
    { dx: -1, dy: 0 },
    { dx: 1, dy: 0 },
    { dx: 0, dy: -1 },
    { dx: 0, dy: 1 },
  ] as const;

  const faceWallConductance = (
    x: number,
    y: number,
    axis: "x" | "y",
    sign: -1 | 1,
  ):
    | { kind: "dirichlet"; g: number; temperatureK: number }
    | { kind: "adiabatic" } => {
    const onBoundary =
      axis === "x"
        ? sign < 0
          ? x === 0
          : x === nx - 1
        : sign < 0
          ? y === 0
          : y === ny - 1;
    if (!onBoundary) return { kind: "adiabatic" };
    const condition =
      axis === "x"
        ? sign < 0
          ? faceConditions.west
          : faceConditions.east
        : sign < 0
          ? faceConditions.south
          : faceConditions.north;
    return condition.kind === "fixed-temperature"
      ? { kind: "dirichlet", g: wallG, temperatureK: condition.temperatureK }
      : { kind: "adiabatic" };
  };

  const advance = (
    dtS: number,
    velocityXMPerS: Float64Array,
    velocityYMPerS: Float64Array,
  ): void => {
    if (diverged) return;
    const netW = new Float64Array(count);
    // Pass 1 — internal fluid–fluid faces, each visited once (east and
    // north ownership): Q is the signed flux flowing in the +x/+y
    // direction, applied with opposite signs to the two cells.
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const p = x + y * nx;
        if (mask.solid[p] === 1) continue;
        const tp = temperatureK[p] ?? 0;
        if (x + 1 < nx && mask.solid[p + 1] === 0) {
          const tn = temperatureK[p + 1] ?? 0;
          const uFace =
            ((velocityXMPerS[p] ?? 0) + (velocityXMPerS[p + 1] ?? 0)) / 2;
          // q is the ONE face flux in the INTO-P convention the pair
          // update applies: diffusion G·(T_N − T_P) plus the
          // donor-cell advection −ρ₀cp·u_face·θ_up — the +x-directed
          // advective flux LEAVES P, and the donor cell carries the
          // DEVIATION θ = T − T_ref (the header's advection
          // paragraph: the absolute-kelvin baseline must never meet a
          // velocity difference).
          const q =
            fluidG * (tn - tp) -
            advectiveG *
              uFace *
              (uFace >= 0 ? tp - referenceK : tn - referenceK);
          netW[p] = (netW[p] ?? 0) + q;
          netW[p + 1] = (netW[p + 1] ?? 0) - q;
        }
        if (y + 1 < ny && mask.solid[p + nx] === 0) {
          const tn = temperatureK[p + nx] ?? 0;
          const uFace =
            ((velocityYMPerS[p] ?? 0) + (velocityYMPerS[p + nx] ?? 0)) / 2;
          const q =
            fluidG * (tn - tp) -
            advectiveG *
              uFace *
              (uFace >= 0 ? tp - referenceK : tn - referenceK);
          netW[p] = (netW[p] ?? 0) + q;
          netW[p + nx] = (netW[p + nx] ?? 0) - q;
        }
      }
    }
    // Pass 2 — interface and wall faces, row-major node order: every
    // flux lands only in the fluid cell's row (the solid's copy is the
    // interface ledger; the wall's copy is the boundary ledger).
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const p = x + y * nx;
        if (mask.solid[p] === 1) continue;
        for (const direction of directions) {
          const nxp = x + direction.dx;
          const nyp = y + direction.dy;
          const inBounds = nxp >= 0 && nxp < nx && nyp >= 0 && nyp < ny;
          if (!inBounds) {
            const wall = faceWallConductance(
              x,
              y,
              direction.dx !== 0 ? "x" : "y",
              direction.dx + direction.dy > 0 ? 1 : -1,
            );
            if (wall.kind === "dirichlet") {
              // The wall exchanges heat by CONDUCTION only: the
              // no-slip wall's normal velocity is zero, and carrying
              // advection at the boundary NODE's velocity would
              // double-count the half-cell slip of bounce-back
              // placement (measured: it pumped the differentially-
              // heated cavity's mean above both walls).
              const q = wall.g * (wall.temperatureK - (temperatureK[p] ?? 0));
              netW[p] = (netW[p] ?? 0) + q;
              boundaryEnergyInJPerM += dtS * q;
            }
            continue;
          }
          const n = nxp + nyp * nx;
          if (mask.solid[n] !== 1) continue;
          const g = lbmInterfaceConductanceWPerMK(
            config.thermalConductivityWPerMK,
            config.solidConductivityWPerMK[n] ?? 0,
          );
          const q = g * ((temperatureK[n] ?? 0) - (temperatureK[p] ?? 0));
          netW[p] = (netW[p] ?? 0) + q;
          interfaceExchange[n] = (interfaceExchange[n] ?? 0) + dtS * q;
        }
      }
    }
    // Pass 3 — the frozen-field forward-Euler update.
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const p = x + y * nx;
        if (mask.solid[p] === 1) continue;
        temperatureK[p] =
          (temperatureK[p] ?? 0) + (dtS * (netW[p] ?? 0)) / capacityJPerKPerM;
      }
    }
    steps += 1;
    for (let index = 0; index < count; index += 1) {
      if (mask.solid[index] === 1) continue;
      if (!Number.isFinite(temperatureK[index] ?? 0)) {
        diverged = true;
        return;
      }
    }
  };

  const rowSum = (
    velocityXMPerS: Float64Array,
    velocityYMPerS: Float64Array,
  ): Float64Array => {
    const sums = new Float64Array(count);
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const p = x + y * nx;
        if (mask.solid[p] === 1) continue;
        let sum = 0;
        for (const direction of directions) {
          const nxp = x + direction.dx;
          const nyp = y + direction.dy;
          const inBounds = nxp >= 0 && nxp < nx && nyp >= 0 && nyp < ny;
          if (!inBounds) {
            const wall = faceWallConductance(
              x,
              y,
              direction.dx !== 0 ? "x" : "y",
              direction.dx + direction.dy > 0 ? 1 : -1,
            );
            // The wall face's coefficient: the Dirichlet conductance
            // alone — walls exchange heat by conduction only.
            if (wall.kind === "dirichlet") sum += wall.g;
            continue;
          }
          const n = nxp + nyp * nx;
          if (mask.solid[n] === 1) {
            sum += lbmInterfaceConductanceWPerMK(
              config.thermalConductivityWPerMK,
              config.solidConductivityWPerMK[n] ?? 0,
            );
            continue;
          }
          sum += fluidG;
          const faceSpeed =
            direction.dx !== 0
              ? Math.abs(
                  ((velocityXMPerS[p] ?? 0) + (velocityXMPerS[n] ?? 0)) / 2,
                )
              : Math.abs(
                  ((velocityYMPerS[p] ?? 0) + (velocityYMPerS[n] ?? 0)) / 2,
                );
          sum += advectiveG * faceSpeed;
        }
        sums[p] = sum;
      }
    }
    return sums;
  };

  return simOk({
    nx,
    ny,
    temperatureK,
    get diverged() {
      return diverged;
    },
    get steps() {
      return steps;
    },
    get boundaryEnergyInJPerM() {
      return boundaryEnergyInJPerM;
    },
    interfaceExchangeJPerM: () => Float64Array.from(interfaceExchange),
    advance,
    stabilityTimeStepS(
      velocityXMPerS: Float64Array,
      velocityYMPerS: Float64Array,
      safetyFactor: number,
    ): number {
      const sums = rowSum(velocityXMPerS, velocityYMPerS);
      let limit = Number.POSITIVE_INFINITY;
      for (let index = 0; index < count; index += 1) {
        if (mask.solid[index] === 1) continue;
        const sum = sums[index] ?? 0;
        if (sum <= 0) continue;
        const cellLimit = capacityJPerKPerM / sum;
        if (cellLimit < limit) limit = cellLimit;
      }
      return safetyFactor * limit;
    },
    fluidEnergyJPerM(referenceK: number): number {
      let total = 0;
      for (let index = 0; index < count; index += 1) {
        if (mask.solid[index] === 1) continue;
        total += capacityJPerKPerM * ((temperatureK[index] ?? 0) - referenceK);
      }
      return total;
    },
  });
}
