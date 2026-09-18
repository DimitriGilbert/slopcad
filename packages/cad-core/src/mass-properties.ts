/**
 * Mass-properties measurement (Phase 27.4): the domain core behind the
 * workbench's Volume and Area rows — the plan's "expose volume and
 * supported area/mass-related measurements from kernel capabilities".
 *
 * ## What is measured, and by whose semantics
 *
 * Both properties are WHOLE-SOLID kernel measurements, taken by the same
 * per-kernel semantics the kernel contract documents for its `volume` and
 * `area` operations (each kernel's honest exact/banded class):
 *
 * - **Volume** — the established `solid.volume` op: exact BREP integration
 *   on OCCT, the divergence theorem over the exact boundary mesh on
 *   Manifold, `measureVolume` over the polygon set on JSCAD, the analytic
 *   subset (plus the documented voxel quadrature for booleans) on the fake
 *   kernel.
 * - **Surface area** — the Phase 27.4 `solid.area` op (capability
 *   `surfaceArea`): exact BREP surface integration on OCCT (probed at the
 *   analytic plate-with-bore value, delta 0), the engine's own
 *   `Manifold.surfaceArea()` and JSCAD's `measureArea` over each kernel's
 *   own boundary representation (exact w.r.t. that boundary; curved
 *   primitives sit in the same inscribed band as their volumes), and the
 *   fake kernel's analytic primitive subset — which declines booleans and
 *   modelled shapes rather than guessing.
 *
 * ## Scoping honesty: no mass
 *
 * Mass itself is deliberately NOT a measurement here. The contract has no
 * density model, so `mass = density × volume` is a downstream consumer's
 * unit algebra (a density ratio times the {@link MassProperties.volume}
 * value), not a kernel measurement — inventing a default density would
 * fabricate physics. This module exposes the two kernel-observable
 * quantities and nothing more.
 *
 * ## Units
 *
 * Kernel numbers arrive in the registry's canonical units (mm³, mm²) and
 * are wrapped as typed {@link VolumeValue}/{@link AreaValue} dimensional
 * values — the Phase 4 infrastructure every measurement tool shares — so
 * conversion (cm³, m², …) and serialization stay the shared module's job.
 * Formatting is the fixtures' three-decimal, value-only convention (the
 * readouts render the `mm³`/`mm²` suffixes), byte-stable for identical
 * measurements.
 */

import {
  type AreaValue,
  type VolumeValue,
  area,
  valueIn,
  volume,
} from "./dimensional";

/** The kernel-measured mass-property pair, in canonical units. */
export interface MassProperties {
  /** The solid's volume, a canonical cubic-millimetre value. */
  readonly volume: VolumeValue;
  /** The solid's total surface area, a canonical square-millimetre value. */
  readonly surfaceArea: AreaValue;
}

/**
 * Wraps kernel-measured numbers as the mass-property pair. Inputs are the
 * canonical-unit numbers the kernel operations return (already validated
 * finite and non-negative at the worker protocol's trust boundary); a
 * non-finite value that slips past that boundary fails here in the
 * dimensional constructors' structured error, never as a silently
 * formatted NaN.
 */
export function massPropertiesOf(
  volumeMm3: number,
  surfaceAreaMm2: number,
): MassProperties {
  return Object.freeze({
    volume: volume(volumeMm3),
    surfaceArea: area(surfaceAreaMm2),
  });
}

/**
 * Formats a volume through the shared dimensional API — three decimals,
 * canonical cubic millimetres, the value only (the readout renders the
 * `mm³` suffix), the byte-stable convention the other measurement rows
 * carry. Any valid volume unit converts (the registry is the single unit
 * source of truth); the canonical extraction keeps identical measurements
 * byte-identical regardless of the unit they were built with.
 */
export function formatVolume(value: VolumeValue): string {
  return valueIn(value, "mm3").toFixed(3);
}

/**
 * Formats a surface area through the shared dimensional API — the volume
 * convention over square millimetres (the readout renders `mm²`).
 */
export function formatSurfaceArea(value: AreaValue): string {
  return valueIn(value, "mm2").toFixed(3);
}

/** The volume and area of a measurement, formatted as data. */
export function formatMassProperties(measured: MassProperties): {
  volume: string;
  surfaceArea: string;
} {
  return {
    volume: formatVolume(measured.volume),
    surfaceArea: formatSurfaceArea(measured.surfaceArea),
  };
}
