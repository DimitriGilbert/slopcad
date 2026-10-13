/**
 * The `simulation` guide's KNOWN-CASES GALLERY (ROADMAP-SIM Phase 63d,
 * the §7.11 completeness ruling): runnable, machine-verified examples
 * pinned to PUBLISHED answers — the trust-made-visible layer the
 * docs-follow-code law demands. Every case is a deterministic scenario
 * (fixed lattice, fluid, budget; the real air record from
 * `@slopcad/sim-core`'s starter set) driven through the Phase 63a CPU
 * reference kernel, with the measured answer stated against its
 * published reference and an HONEST band that names every confounder
 * (tunnel confinement, staircase boundaries, low-Mach lattice,
 * low-Reynolds viscous effects). The suite runs each case and asserts
 * the guide's sentences.
 *
 * Three cases, per the roadmap's validation block and the AngeTheGreat
 * prior-art note (docs/research/ange-engine-sim/global-report.md
 * §Phase 63/66 — "lead the known-cases gallery with the shock tube"):
 *
 * 1. **Cylinder vortex shedding** — the Strouhal number against the Re
 *    band (Roshko's public-domain correlation).
 * 2. **NACA 0012 airfoil** — lift slope against the public-domain
 *    thin-airfoil/`NACA Report 824` reference, blockage stated.
 * 3. **Shock tube (the Sod Riemann problem)** — DECLINED LOUDLY, with
 *    the machine-verified regime honesty that justifies the decline:
 *    the D2Q9 weakly-compressible kernel is valid only at low lattice
 *    Mach, and the canonical shock tube lives far outside that regime.
 *    The prior art's canonical fixture is named and declined here
 *    rather than run dishonestly.
 */

import {
  type SimFluidState,
  SIM_FLUID_AIR,
  simFluidState,
  simMach,
  simPrandtl,
  simRegimeReport,
  simReynolds,
  compileSimScenario,
} from "@slopcad/sim-core";
import {
  type LbmStepper,
  type LbmStepperConfig,
  createLbmStepper,
} from "@slopcad/sim-flow";

/** Unwraps a parse result or throws (a guide example fails loud). */
function unwrap<T, E extends { readonly message: string }>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: E },
  what: string,
): T {
  if (!result.ok) {
    throw new Error(`The gallery rejected ${what}: ${result.error.message}`);
  }
  return result.value;
}

/** The gallery's fluid: real air at the record's own 300 K reference. */
function air(): SimFluidState {
  return unwrap(simFluidState(SIM_FLUID_AIR, 300), "the air record");
}

// ---------------------------------------------------------------------------
// Case 1 — cylinder vortex shedding (Strouhal vs the Re band)
// ---------------------------------------------------------------------------

/**
 * Roshko's Strouhal–Reynolds correlation for the circular cylinder
 * (NACA TN 3169, 1954 — US government work, public domain):
 * St = 0.212·(1 − 21.2/Re), valid over the regular laminar shedding
 * range 50 ≲ Re ≲ 150 for the UNCONFINED cylinder.
 */
export function roshkoStrouhal(reynolds: number): number {
  return 0.212 * (1 - 21.2 / reynolds);
}

/** What the shedding case reports back to the guide and the suite. */
export interface SimGallerySheddingSummary {
  /** The run's Reynolds number (u∞·D/ν, the air record's own ν). */
  readonly reynolds: number;
  /** The run's Mach number (u∞/c — honest low-Mach physical flow). */
  readonly mach: number;
  /** The lattice Mach of the run (u_lat/c_s — the compressibility knob). */
  readonly latticeMach: number;
  /** The qualitative S9 flags the regime report raises (none expected). */
  readonly qualitative: readonly string[];
  /** Shedding cycles counted in the measurement window. */
  readonly cycles: number;
  /** The mean lift-oscillation period, completed steps. */
  readonly periodSteps: number;
  /** The measured Strouhal number St = D/(T·u∞). */
  readonly strouhal: number;
  /** Roshko's unconfined published correlation at this Re. */
  readonly roshkoStrouhal: number;
  /** The stated band [lo, hi] as multiples of the Roshko value. */
  readonly band: readonly [number, number];
  /** Whether the measured St sits inside the stated band. */
  readonly withinBand: boolean;
  /** The run completed its budget without divergence. */
  readonly completed: boolean;
}

/**
 * The shedding lattice: 128 × 48 nodes, disc D = 12 cells (blockage
 * D/H = 25%), u_lat = 0.15 (lattice Ma ≈ 0.26 — inside the weakly
 * compressible window), free-slip walls (the free-stream tunnel: no
 * wall boundary layers to confound the wake), convective outflow
 * (vortex structures leave without reflection), and the disc centre
 * offset from the channel centreline by 0.3 cells so the deterministic
 * staircase seeds the asymmetry the instability needs — the kernel has
 * no random perturbation, by law S2.
 */
const SHED_NX = 128;
const SHED_NY = 48;
const SHED_R = 6;
const SHED_CX = 30;
const SHED_CY_OFFSET = 0.3;
const SHED_ULAT = 0.15;
const SHED_RE = 100;
const SHED_STEPS = 16000;
/** The measurement window: the second half of the budget. */
const SHED_WINDOW_FROM = 8000;
/** The stated band, in multiples of Roshko's unconfined value. */
const SHED_BAND: readonly [number, number] = [0.9, 1.8];

function sheddingStepper(fluid: SimFluidState): LbmStepper {
  const diameterM = 2 * SHED_R * 0.001;
  const speed = (SHED_RE * fluid.kinematicViscosityM2PerS) / diameterM;
  const cy = (SHED_NY - 1) / 2 + SHED_CY_OFFSET;
  const cells = new Uint8Array(SHED_NX * SHED_NY);
  for (let y = 0; y < SHED_NY; y += 1) {
    for (let x = 0; x < SHED_NX; x += 1) {
      cells[x + y * SHED_NX] =
        (x - SHED_CX) ** 2 + (y - cy) ** 2 <= SHED_R * SHED_R ? 1 : 0;
    }
  }
  const config: LbmStepperConfig = {
    mask: { nx: SHED_NX, ny: SHED_NY, solid: cells },
    fluid,
    cellSizeM: 0.001,
    characteristicVelocityMPerS: speed,
    latticeVelocity: SHED_ULAT,
    collision: { kind: "trt" },
    west: { kind: "velocity-inlet", velocityMPerS: [speed, 0] },
    east: { kind: "convective-outflow" },
    south: { kind: "wall", slip: true },
    north: { kind: "wall", slip: true },
  };
  return unwrap(createLbmStepper(config), "the shedding lattice");
}

/**
 * Runs the shedding case: steps the kernel to its budget, then measures
 * the dominant lift-oscillation period from the positive-going zero
 * crossings inside the measurement window — a deterministic estimator
 * (fixed order, no fitting) whose input is the bit-stable history the
 * kernel produces.
 */
export function runCylinderSheddingExample(): SimGallerySheddingSummary {
  const fluid = air();
  const run = sheddingStepper(fluid);
  run.run(SHED_STEPS);
  const diameterM = 2 * SHED_R * 0.001;
  const speed = (SHED_RE * fluid.kinematicViscosityM2PerS) / diameterM;
  const regime = simRegimeReport({
    reynolds: simReynolds(
      fluid.densityKgPerM3,
      speed,
      diameterM,
      fluid.dynamicViscosityPaS,
    ),
    mach: simMach(speed, fluid.speedOfSoundMPerS),
    prandtl: simPrandtl(
      fluid.dynamicViscosityPaS,
      fluid.specificHeatJPerKgK,
      fluid.thermalConductivityWPerMK,
    ),
  });
  const lift = run.forceState().history[1]?.samples ?? [];
  const crossings: number[] = [];
  for (let i = SHED_WINDOW_FROM + 1; i < lift.length; i += 1) {
    if ((lift[i - 1] ?? 0) < 0 && (lift[i] ?? 0) >= 0) {
      crossings.push(i);
    }
  }
  if (crossings.length < 3) {
    throw new Error(
      `The shedding case counted only ${String(crossings.length)} lift cycles in its window; the period estimate needs at least three.`,
    );
  }
  let span = 0;
  for (let i = 1; i < crossings.length; i += 1) {
    span += (crossings[i] ?? 0) - (crossings[i - 1] ?? 0);
  }
  const periodSteps = span / (crossings.length - 1);
  // St = D/(T·u∞), all in lattice terms (D cells, T steps, u_lat).
  const strouhal =
    (2 * SHED_R) / (periodSteps * run.meta.units.latticeVelocity);
  const published = roshkoStrouhal(SHED_RE);
  return {
    reynolds: regime.reynolds ?? NaN,
    mach: regime.mach ?? NaN,
    latticeMach: run.meta.units.latticeVelocity * Math.sqrt(3),
    qualitative: regime.qualitative,
    cycles: crossings.length - 1,
    periodSteps,
    strouhal,
    roshkoStrouhal: published,
    band: SHED_BAND,
    withinBand:
      strouhal >= SHED_BAND[0] * published &&
      strouhal <= SHED_BAND[1] * published,
    completed: !run.diverged && run.step === SHED_STEPS,
  };
}

// ---------------------------------------------------------------------------
// Case 2 — NACA 0012 lift slope (public-domain airfoil data)
// ---------------------------------------------------------------------------

/**
 * The NACA 4-digit half-thickness distribution (the public-domain
 * shape family of NACA Report 460, 1933), with the −0.1036 trailing
 * constant that closes the trailing edge: yt(x̄) = 5t·(0.2969√x̄ −
 * 0.1260x̄ − 0.3516x̄² + 0.2843x̄³ − 0.1036x̄⁴). Evaluated in NODE
 * units (scaled by the chord); the symmetric 0012 section has t = 0.12
 * and zero camber.
 */
export function nacaHalfThicknessNodes(
  chordFraction: number,
  thicknessRatio: number,
  chordNodes: number,
): number {
  return (
    5 *
    thicknessRatio *
    (0.2969 * Math.sqrt(chordFraction) -
      0.126 * chordFraction -
      0.3516 * chordFraction ** 2 +
      0.2843 * chordFraction ** 3 -
      0.1036 * chordFraction ** 4) *
    chordNodes
  );
}

/** What the airfoil case reports back to the guide and the suite. */
export interface SimGalleryAirfoilSummary {
  /** The run's chord-based Reynolds number (air at 300 K). */
  readonly reynolds: number;
  /** The run's Mach number (honest low-Mach physical flow). */
  readonly mach: number;
  /** The measured Cl at α = 0 (exactly zero by the mirror-symmetric mask). */
  readonly clAtZeroAlpha: number;
  /** The measured Cl at α = 8°. */
  readonly clAtEightDeg: number;
  /** The measured Cd at α = 0. */
  readonly cdAtZeroAlpha: number;
  /** The measured Cd at α = 8°. */
  readonly cdAtEightDeg: number;
  /** The lift slope dCl/dα per radian, from the two measured points. */
  readonly liftSlopePerRad: number;
  /** The public-domain inviscid reference slope (thin-airfoil theory). */
  readonly thinAirfoilSlopePerRad: number;
  /** The measured slope as a fraction of the reference. */
  readonly slopeRatio: number;
  /** The stated band on the slope ratio. */
  readonly band: readonly [number, number];
  /** Whether the measured slope sits inside the stated band. */
  readonly withinBand: boolean;
  /** The tunnel's vertical blockage at α = 8° (the stated confounder). */
  readonly blockage: number;
  /** Both runs completed without divergence. */
  readonly completed: boolean;
}

/**
 * The airfoil lattice: 160 × 64 nodes, chord 48 cells at 40 cells from
 * the inlet, free-slip walls, convective outflow, u_lat = 0.1, Re = 200
 * (chord-based, real air). The 0012 occupancy is the analytic
 * thickness predicate evaluated per node under rotation by α (the
 * leading edge stays at the domain centreline; positive α pitches the
 * chord nose-up against the +x stream). At α = 0 the mask is exactly
 * mirror-symmetric about the centre half-row, so the lift is zero to
 * float-accumulation residue — the deterministic zero the slope's
 * second point does not need a run to establish, though this case runs
 * one anyway and asserts it.
 */
const NACA_NX = 160;
const NACA_NY = 64;
const NACA_CHORD = 48;
const NACA_X_LE = 40;
const NACA_Y_MID = 31.5;
const NACA_ULAT = 0.1;
const NACA_RE = 200;
const NACA_ALPHA_DEG = 8;
const NACA_STEPS = 8000;
const NACA_ZERO_STEPS = 2400;
/** The stated slope band, as a fraction of the 2π thin-airfoil slope. */
const NACA_BAND: readonly [number, number] = [0.7, 1.1];

function airfoilStepper(
  fluid: SimFluidState,
  alphaDeg: number,
  steps: number,
): { readonly run: LbmStepper; readonly steps: number } {
  const chordM = NACA_CHORD * 0.001;
  const speed = (NACA_RE * fluid.kinematicViscosityM2PerS) / chordM;
  const alpha = (alphaDeg * Math.PI) / 180;
  const cos = Math.cos(alpha);
  const sin = Math.sin(alpha);
  const cells = new Uint8Array(NACA_NX * NACA_NY);
  for (let y = 0; y < NACA_NY; y += 1) {
    for (let x = 0; x < NACA_NX; x += 1) {
      const dx = x - NACA_X_LE;
      const dy = y - NACA_Y_MID;
      // Tunnel → airfoil frame: the inverse of the nose-up rotation,
      // so 0 ≤ X ≤ chord spans the section and |Y| ≤ yt(X/chord) is
      // the public-domain thickness predicate.
      const chordX = dx * cos - dy * sin;
      const normalY = dx * sin + dy * cos;
      cells[x + y * NACA_NX] =
        chordX >= 0 &&
        chordX <= NACA_CHORD &&
        Math.abs(normalY) <=
          nacaHalfThicknessNodes(chordX / NACA_CHORD, 0.12, NACA_CHORD)
          ? 1
          : 0;
    }
  }
  const config: LbmStepperConfig = {
    mask: { nx: NACA_NX, ny: NACA_NY, solid: cells },
    fluid,
    cellSizeM: 0.001,
    characteristicVelocityMPerS: speed,
    latticeVelocity: NACA_ULAT,
    collision: { kind: "trt" },
    west: { kind: "velocity-inlet", velocityMPerS: [speed, 0] },
    east: { kind: "convective-outflow" },
    south: { kind: "wall", slip: true },
    north: { kind: "wall", slip: true },
  };
  const run = unwrap(
    createLbmStepper(config),
    `the airfoil at ${String(alphaDeg)}°`,
  );
  run.run(steps);
  return { run, steps };
}

/** The late-window mean of one history series (the last 30% of it). */
function windowMean(samples: readonly number[]): number {
  const from = Math.floor(samples.length * 0.7);
  let sum = 0;
  let count = 0;
  for (let index = from; index < samples.length; index += 1) {
    sum += samples[index] ?? 0;
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

/** Runs the airfoil case at α = 0 and α = 8° and forms the slope. */
export function runNacaAirfoilExample(): SimGalleryAirfoilSummary {
  const fluid = air();
  const chordM = NACA_CHORD * 0.001;
  const speed = (NACA_RE * fluid.kinematicViscosityM2PerS) / chordM;
  const dynPressureChord = 0.5 * fluid.densityKgPerM3 * speed * speed * chordM;

  const zero = airfoilStepper(fluid, 0, NACA_ZERO_STEPS);
  const incidence = airfoilStepper(fluid, NACA_ALPHA_DEG, NACA_STEPS);
  const coefficients = (stepped: {
    readonly run: LbmStepper;
    readonly steps: number;
  }): { readonly cl: number; readonly cd: number } => {
    const histories = stepped.run.forceState().history;
    return {
      cl: windowMean(histories[1]?.samples ?? []) / dynPressureChord,
      cd: windowMean(histories[0]?.samples ?? []) / dynPressureChord,
    };
  };
  const atZero = coefficients(zero);
  const atEight = coefficients(incidence);

  const alphaRad = (NACA_ALPHA_DEG * Math.PI) / 180;
  const liftSlope = (atEight.cl - atZero.cl) / alphaRad;
  const reference = 2 * Math.PI;
  const projectedHeightM =
    NACA_CHORD * Math.sin(alphaRad) * 0.001 +
    0.12 * NACA_CHORD * Math.cos(alphaRad) * 0.001;
  return {
    reynolds: simReynolds(
      fluid.densityKgPerM3,
      speed,
      chordM,
      fluid.dynamicViscosityPaS,
    ),
    mach: simMach(speed, fluid.speedOfSoundMPerS),
    clAtZeroAlpha: atZero.cl,
    clAtEightDeg: atEight.cl,
    cdAtZeroAlpha: atZero.cd,
    cdAtEightDeg: atEight.cd,
    liftSlopePerRad: liftSlope,
    thinAirfoilSlopePerRad: reference,
    slopeRatio: liftSlope / reference,
    band: NACA_BAND,
    withinBand:
      liftSlope / reference >= NACA_BAND[0] &&
      liftSlope / reference <= NACA_BAND[1],
    blockage: projectedHeightM / (NACA_NY * 0.001),
    completed:
      !zero.run.diverged &&
      zero.run.step === NACA_ZERO_STEPS &&
      !incidence.run.diverged &&
      incidence.run.step === NACA_STEPS,
  };
}

// ---------------------------------------------------------------------------
// Case 3 — the shock tube, declined loudly (regime honesty per law S9)
// ---------------------------------------------------------------------------

/**
 * The classic Sod shock tube's shock Mach number (Sod 1978, J. Comput.
 * Phys. 20 — the canonical public reference state: p_L/p_R = 10,
 * ρ_L/ρ_R = 8, u = 0): the shock propagates at Ma ≈ 1.75 relative to
 * the quiescent right state. The D2Q9 weakly-compressible kernel is
 * honest only at lattice Ma ≲ 0.3 (density variations O(Ma²)); a Ma-1.75
 * discontinuity is far outside, and this case declines to present it.
 */
export const SOD_SHOCK_MACH = 1.75;

/** What the shock-tube decline reports back to the guide and the suite. */
export interface SimGalleryShockTubeDeclineSummary {
  /** The canonical shock Mach number the decline reasons from. */
  readonly shockMach: number;
  /** The S9 compile flags for a shock-tube-shaped scenario. */
  readonly qualitative: readonly string[];
  /** The compile boundary flagged compressibility (the decline's ground). */
  readonly flaggedCompressible: boolean;
  /**
   * The stepper REFUSES the Ma-1.75 inlet at the gallery closure: the
   * unit closure maps the flow's enormous Reynolds number onto a
   * lattice viscosity at the τ⁺ stability floor, and the kernel
   * declines rather than running an effectively inviscid lattice.
   */
  readonly inletAccepted: boolean;
  /**
   * The stepper also REFUSES the Sod 10:1 pressure ratio at a slow,
   * viscosity-feasible closure: the atmospheric ratio drives the
   * lattice density far outside the positive regime.
   */
  readonly pressureRatioAccepted: boolean;
  /** The stated decline reason (the guide prints it verbatim). */
  readonly declineReason: string;
}

export const SHOCK_TUBE_DECLINE_REASON = [
  "The canonical Sod shock tube (shock Ma ≈ 1.75, p ratio 10:1) is",
  "outside the D2Q9 kernel's weakly-compressible validity: the lattice",
  "is honest at Mach numbers well below 0.3, where density variations",
  "are O(Ma²). The kernel's own mechanical checks refuse the scenario",
  "at every closure scale small enough to run — the Ma-1.75 stream",
  "collapses the lattice viscosity onto the τ⁺ stability floor, and the",
  "atmospheric pressure ratio drives the lattice density non-positive —",
  "and the S9 regime report flags compressibility-affected besides. A",
  "lattice large enough to sneak under the mechanical checks would run",
  "the discontinuity into a viscously smeared, physically meaningless",
  "wave — silent garbage — so the gallery declines the case loudly and",
  "states this reasoning instead.",
].join(" ");

/**
 * Runs the shock-tube DECLINE: compiles a shock-tube-shaped scenario
 * (a velocity inlet at the Sod shock speed) through the S9 boundary and
 * pins the compressibility flag, then demonstrates BOTH mechanical
 * refusals — the Ma-1.75 inlet against the τ⁺ stability floor, and the
 * 10:1 atmospheric pressure ratio against the outlet-density positivity
 * check at a slow, viscosity-feasible closure. Three independent walls,
 * all machine-verified: this decline is stated, not assumed.
 */
export function runShockTubeDeclineExample(): SimGalleryShockTubeDeclineSummary {
  const fluid = air();
  const shockSpeed = SOD_SHOCK_MACH * fluid.speedOfSoundMPerS;
  const compiled = unwrap(
    compileSimScenario({
      scenario: {
        id: "sim_shocktube",
        name: "Sod shock tube (declined)",
        kind: "flow",
        domain: {
          kind: "explicit",
          min: [-100, -50, -50],
          max: [100, 50, 50],
          resolutionMm: 2,
        },
        conditions: [
          {
            kind: "velocity-inlet",
            face: "xMin",
            speedMPerS: shockSpeed,
            direction: [1, 0, 0],
          },
          { kind: "pressure-outlet", face: "xMax", pressurePa: 101325 },
        ],
        fluid: "air",
        materials: [],
        gravityMPerS2: [0, -9.80665, 0],
      },
    }),
    "the shock-tube scenario compile",
  );
  // Wall 2: the Ma-1.75 inlet at the gallery closure — the lattice
  // Reynolds number the physical flow implies drives τ⁺ to its floor.
  const inletAccepted = createLbmStepper({
    mask: { nx: 16, ny: 8, solid: new Uint8Array(16 * 8) },
    fluid,
    cellSizeM: 0.002,
    characteristicVelocityMPerS: shockSpeed,
    west: { kind: "velocity-inlet", velocityMPerS: [shockSpeed, 0] },
    east: { kind: "pressure-outlet", pressurePa: 101325 },
    south: { kind: "wall", slip: true },
    north: { kind: "wall", slip: true },
  }).ok;
  // Wall 3: the Sod 10:1 pressure ratio at a SLOW closure where the
  // viscosity is lattice-feasible — the ratio alone still drives the
  // lattice density far outside the positive regime.
  const pressureRatioAccepted = createLbmStepper({
    mask: { nx: 16, ny: 8, solid: new Uint8Array(16 * 8) },
    fluid,
    cellSizeM: 0.002,
    characteristicVelocityMPerS: 1,
    referencePressurePa: 10 * 101325,
    west: { kind: "velocity-inlet", velocityMPerS: [1, 0] },
    east: { kind: "pressure-outlet", pressurePa: 101325 },
    south: { kind: "wall", slip: true },
    north: { kind: "wall", slip: true },
  }).ok;
  return {
    shockMach: SOD_SHOCK_MACH,
    qualitative: compiled.regime.qualitative,
    flaggedCompressible: compiled.regime.qualitative.includes(
      "compressibility-affected",
    ),
    inletAccepted,
    pressureRatioAccepted,
    declineReason: SHOCK_TUBE_DECLINE_REASON,
  };
}
