/**
 * The §7.12 radiation forms (Phase 65a): surface-to-ambient
 * Stefan–Boltzmann loss — the full quartic law and the standard
 * linearized coefficient — plus the grey-diffuse surface-to-surface
 * exchange inside an enclosure, in the honest coarse in-scope form the
 * owner ruling names.
 *
 * ## The ambient loss
 *
 * q/A = ε·σ·(T_s⁴ − T_amb⁴), positive = loss. The LINEARIZED option
 * (the solver-friendly standard, Incropera & DeWitt eq. 1.9's move)
 * fixes a linearization coefficient ONCE about an estimated surface
 * temperature T_ref:
 *
 *   h_rad = ε·σ·(T_ref + T_amb)·(T_ref² + T_amb²)   [W/(m²·K)]
 *
 * so the steady system stays linear. Its honesty is stated: the
 * coefficient — and therefore the settled temperature — depends on the
 * estimate; the cross-check fixture pins the band against the full law.
 *
 * ## The enclosure exchange — uniform radiosity (view-factor-free)
 *
 * Every surface of one enclosure is assumed to see the SAME irradiation
 * G (the uniform-radiosity / mean-beam approximation — the coarse form
 * §6 names as in-scope). With grey-diffuse surfaces, radiosity
 * J_i = ε_i·σ·T_i⁴ + (1 − ε_i)·G and the enclosure balance Σ A_i·(J_i − G) = 0
 * close in closed form:
 *
 *   T_enc⁴ = Σ(ε_i·A_i·T_i⁴) / Σ(ε_i·A_i)
 *   q_i = ε_i·σ·A_i·(T_i⁴ − T_enc⁴)
 *
 * The exchange conserves energy IDENTICALLY (Σ q_i = 0 by construction
 * of T_enc — the property the energy audit pins exactly). The stated
 * coarseness: no view factors — every surface sees the enclosure's mean
 * radiosity, which is accurate for compact enclosures (a stove's firebox)
 * and wrong for long, slender, or baffled ones; participating media and
 * spectral radiation stay declined (§6) and cavity-air convection is
 * 65b's buoyancy coupling, not this phase's.
 */

/** The Stefan–Boltzmann constant, W/(m²·K⁴) — CODATA 2018. */
export const STEFAN_BOLTZMANN_W_PER_M2_K4 = 5.670374419e-8;

/** The full Stefan–Boltzmann exchange flux, W/m² — positive = loss to the environment. */
export function stefanBoltzmannFluxWPerM2(
  emissivity: number,
  surfaceK: number,
  environmentK: number,
): number {
  return (
    emissivity *
    STEFAN_BOLTZMANN_W_PER_M2_K4 *
    (surfaceK ** 4 - environmentK ** 4)
  );
}

/**
 * The linearized radiation coefficient about a FIXED surface-temperature
 * estimate: h_rad = ε·σ·(T_ref + T_env)·(T_ref² + T_env²), W/(m²·K).
 * The same form serves the ambient loss (T_env = T_amb) and the
 * enclosure exchange (T_env = T_enc).
 */
export function linearizedRadiationCoefficientWPerM2K(
  emissivity: number,
  surfaceReferenceK: number,
  environmentReferenceK: number,
): number {
  return (
    emissivity *
    STEFAN_BOLTZMANN_W_PER_M2_K4 *
    (surfaceReferenceK + environmentReferenceK) *
    (surfaceReferenceK ** 2 + environmentReferenceK ** 2)
  );
}

/** The tangent-linearized full-law boundary: its conductance and environment. */
export interface TangentRadiationBoundary {
  /** The tangent slope 4·ε·σ·T_k³, W/(m²·K). */
  readonly coefficientWPerM2K: number;
  /**
   * The equivalent linear environment: the temperature the tangent line
   * crosses zero loss at — T_k − (T_k⁴ − T_env⁴)/(4·T_k³). Pairing the
   * coefficient with this environment reproduces the full quartic flux
   * EXACTLY at T = T_k (the Picard fixed point) while keeping the
   * boundary inside the matrix (convexity ⇒ monotone convergence).
   */
  readonly environmentK: number;
}

/**
 * The FULL law's Picard linearization — the quartic's TANGENT at the
 * current iterate, not the naive lagged-source form: for
 * radiation-dominated boundaries (h_rad ≫ h) a purely lagged source
 * oscillates with |map derivative| = 4εσT³A/G_conv ≫ 1 and diverges,
 * while the tangent boundary converges monotonically (the loss is
 * convex increasing) and evaluates to the exact Stefan–Boltzmann flux
 * at the fixed point. Requires tangentK > 0 (kelvin temperatures are).
 */
export function tangentRadiationBoundary(
  emissivity: number,
  tangentK: number,
  environmentK: number,
): TangentRadiationBoundary {
  const coefficientWPerM2K =
    4 * emissivity * STEFAN_BOLTZMANN_W_PER_M2_K4 * tangentK ** 3;
  const equivalentEnvironmentK =
    tangentK - (tangentK ** 4 - environmentK ** 4) / (4 * tangentK ** 3);
  return { coefficientWPerM2K, environmentK: equivalentEnvironmentK };
}

/** One enclosure surface: the exchange's per-face inputs. */
export interface EnclosureRadiositySurface {
  /** The surface patch area, m². */
  readonly areaM2: number;
  readonly emissivity: number;
  /** The patch's surface temperature, K. */
  readonly temperatureK: number;
}

/**
 * The uniform-radiosity enclosure temperature of one enclosure's
 * surfaces: (Σ ε·A·T⁴ / Σ ε·A)^(1/4). Surfaces with zero emissivity
 * contribute to neither sum (they neither emit nor reflect in the grey
 * exchange — a ε = 0 patch is a no-exchange patch); an enclosure whose
 * Σ ε·A vanishes has no exchange at all and declines to NaN here, which
 * the caller treats as "no enclosure term".
 */
export function enclosureRadiosityTemperatureK(
  surfaces: readonly EnclosureRadiositySurface[],
): number {
  let weightSum = 0;
  let weightedQuartic = 0;
  for (const surface of surfaces) {
    const weight = surface.emissivity * surface.areaM2;
    weightSum += weight;
    weightedQuartic += weight * surface.temperatureK ** 4;
  }
  if (weightSum <= 0) return Number.NaN;
  return (weightedQuartic / weightSum) ** 0.25;
}

/** The per-surface net exchange of one enclosure, W — positive = the surface LOSES. */
export function enclosureNetExchangeW(
  surfaces: readonly EnclosureRadiositySurface[],
): readonly number[] {
  const enclosureK = enclosureRadiosityTemperatureK(surfaces);
  return surfaces.map((surface) =>
    Number.isNaN(enclosureK)
      ? 0
      : stefanBoltzmannFluxWPerM2(
          surface.emissivity,
          surface.temperatureK,
          enclosureK,
        ) * surface.areaM2,
  );
}
