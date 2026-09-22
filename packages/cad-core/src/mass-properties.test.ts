/**
 * Mass-properties measurement tests (Phase 27.4): the kernel-measured
 * volume + surface-area pair wrapping, its formatting through the shared
 * unit infrastructure, and the known-fixture truths the plan's validation
 * ("values agree with kernel semantics") is answered by — the analytic
 * box, the hand-derivable plate-with-bore, and the cylinder.
 */

import { describe, expect, it } from "vitest";

import {
  formatMassProperties,
  formatSectionCentroid,
  formatSurfaceArea,
  formatVolume,
  massPropertiesOf,
  sectionFacePropertiesOf,
  type MassProperties,
} from "./mass-properties";
import { length, valueIn } from "./dimensional";

describe("mass properties (Phase 27.4)", () => {
  it("wraps kernel-measured numbers as canonical mm³/mm² dimensional values", () => {
    const measured = massPropertiesOf(6000, 2200);
    expect(measured.volume.dimension).toBe("volume");
    expect(measured.volume.unit).toBe("mm3");
    expect(valueIn(measured.volume, "mm3")).toBe(6000);
    expect(measured.surfaceArea.dimension).toBe("area");
    expect(measured.surfaceArea.unit).toBe("mm2");
    expect(valueIn(measured.surfaceArea, "mm2")).toBe(2200);
    // Frozen data: a measurement is a value, not a mutable accumulator.
    expect(Object.isFrozen(measured)).toBe(true);
  });

  it("converts through the shared unit infrastructure (cm³/cm² views of the same measurement)", () => {
    const measured = massPropertiesOf(6000, 2200);
    expect(valueIn(measured.volume, "cm3")).toBeCloseTo(6, 12);
    expect(valueIn(measured.surfaceArea, "cm2")).toBeCloseTo(22, 12);
  });

  it("formats the analytic box exactly: 6000.000 mm³ and 2200.000 mm²", () => {
    // The 30×20×10 box: volume w·d·h and area 2(wd + wh + dh) — exact for
    // every kernel (BREP integration, boundary mesh, and the fake's
    // analytic subset all measure these closed forms to float precision).
    const measured = massPropertiesOf(30 * 20 * 10, 2 * (600 + 300 + 200));
    expect(formatVolume(measured.volume)).toBe("6000.000");
    expect(formatSurfaceArea(measured.surfaceArea)).toBe("2200.000");
    expect(formatMassProperties(measured)).toEqual({
      volume: "6000.000",
      surfaceArea: "2200.000",
    });
  });

  it("formats the hand-derivable plate-with-bore pair from kernel-precision numbers", () => {
    // The 30×20×10 plate with a ⌀8 through bore: volume = w·d·h − πr²h,
    // area = box faces − 2 bore circles + the bore wall. The kernel-
    // measured numbers are two probed mesh-kernel pairs — JSCAD's
    // 32-segment inscribed boundary and Manifold's 28-chord default bore —
    // and each formats to its displayed readout; the analytic values
    // themselves sit inside the kernels' documented curved bands.
    const analyticVolume = 6000 - Math.PI * 16 * 10;
    const analyticArea = 2200 - 2 * Math.PI * 16 + 2 * Math.PI * 4 * 10;
    const jscad = massPropertiesOf(5500.5687756387115, 2351.0376343714165);
    expect(formatVolume(jscad.volume)).toBe("5500.569");
    expect(formatSurfaceArea(jscad.surfaceArea)).toBe("2351.038");
    const manifold = massPropertiesOf(5501.553107937856, 2351.111048058981);
    expect(formatVolume(manifold.volume)).toBe("5501.553");
    expect(formatSurfaceArea(manifold.surfaceArea)).toBe("2351.111");
    // The analytic truth agrees with each measured readout within one
    // final-displayed digit of the kernels' curved bands.
    expect(
      Math.abs(Number(formatVolume(jscad.volume)) - analyticVolume),
    ).toBeLessThan(5);
    expect(
      Math.abs(Number(formatSurfaceArea(jscad.surfaceArea)) - analyticArea),
    ).toBeLessThan(5);
    expect(
      Math.abs(Number(formatVolume(manifold.volume)) - analyticVolume),
    ).toBeLessThan(5);
    expect(
      Math.abs(Number(formatSurfaceArea(manifold.surfaceArea)) - analyticArea),
    ).toBeLessThan(5);
  });

  it("formats the analytic cylinder pair 2πr²h-volume and 2πr(r+h)-area", () => {
    const measured = massPropertiesOf(
      Math.PI * 16 * 10,
      2 * Math.PI * 4 * (4 + 10),
    );
    expect(formatVolume(measured.volume)).toBe("502.655");
    expect(formatSurfaceArea(measured.surfaceArea)).toBe("351.858");
  });

  it("formats zero measurements (an empty solid measures nothing)", () => {
    const measured = massPropertiesOf(0, 0);
    expect(formatMassProperties(measured)).toEqual({
      volume: "0.000",
      surfaceArea: "0.000",
    });
  });

  it("rejects a non-finite kernel measurement through the dimensional constructors", () => {
    // The worker protocol validates finiteness at the trust boundary; a
    // non-finite number that slips past it is the dimensional module's
    // structured error, never a silently formatted NaN.
    expect(() => massPropertiesOf(Number.NaN, 2200)).toThrow();
    expect(() => massPropertiesOf(6000, Number.POSITIVE_INFINITY)).toThrow();
  });

  it("measures are plain data readable without coupling to the kernel", () => {
    const measured: MassProperties = massPropertiesOf(1000, 600);
    expect(measured.volume.value).toBe(1000);
    expect(measured.surfaceArea.value).toBe(600);
  });

  it("wraps the section face's measurements as typed values (Phase 46)", () => {
    const section = sectionFacePropertiesOf(600, [15, 10, 5]);
    expect(section.area.value).toBe(600);
    expect(section.centroid.map((component) => component.value)).toEqual([
      15, 10, 5,
    ]);
    expect(section.area.unit).toBe("mm2");
  });

  it("formats the section centroid components byte-stably", () => {
    expect(formatSectionCentroid([length(15), length(10), length(5)])).toEqual([
      "15.000",
      "10.000",
      "5.000",
    ]);
  });

  it("rejects a non-finite section measurement through the constructors", () => {
    expect(() => sectionFacePropertiesOf(Number.NaN, [0, 0, 0])).toThrow();
    expect(() => sectionFacePropertiesOf(600, [0, Number.NaN, 0])).toThrow();
  });
});
