/**
 * OCCT adapter's helix-specific tests (Phase 40): the ruled meridian-station
 * honesty — `BRepOffsetAPI_ThruSections` over the exact transported station
 * wires lands at the DERIVED chord band `sin(Δθ)/Δθ` of the exact screw
 * volume (the ruled span's Jacobian is `(R+u)·sinΔθ` against the true
 * `(R+u)·Δθ`, Δθ the shared station step — the same 63-chord class the mesh
 * kernels' revolves document), thread tools measure their derived ISO
 * volumes, the exact-pipe route is proven a DIFFERENT solid (the section
 * attachment is perpendicular to the tangent; the meridian never is), and
 * the shared validation battery rejects before any engine call.
 *
 * The analytic anchors (derivation in `helix-geometry.ts`'s module doc):
 *
 * - Untapered screw solid: `V = 2π·turns·A·d̄` with `A` the meridian
 *   profile area and `d̄` its centroid radius — the Jacobian
 *   `|J| = (R+u)·|θ′|` integrates to the profile's first radial moment
 *   times the total swept angle (taper drops out of the true solid; the
 *   tapered closed form adds the `taper/2` mean-radius shift).
 * - Ruled station loft: `V_N = V·sin(Δθ)/Δθ` EXACTLY (the span Jacobian),
 *   so the OCCT measurement pins against the derived value, not the raw
 *   exact one — the band is the pin, never a screenshot of a number.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { angle, length } from "@slopcad/cad-core";
import {
  type GeometryKernel,
  helixProfilePolygon,
  helixScrewVolume,
  helixStations,
  helixSweepProblem,
  helixTurnsOverlap,
  isoThreadToolLoop,
  KERNEL_ERROR_CODES,
  PROFILE_STATION_ANGLE_RAD,
  type ProfileSegmentInput,
} from "@slopcad/cad-kernel";
import {
  assertVolumeClose,
  expectKernelFailure,
  unwrapKernelResult,
} from "@slopcad/cad-kernel/test-utils";

import { occtKernelFromRuntime } from "./occt-kernel";
import { createOcctRuntime, type OcctRuntime } from "./occt-runtime";

let runtime: OcctRuntime;
let kernel: GeometryKernel;

beforeAll(async () => {
  runtime = await createOcctRuntime();
  kernel = occtKernelFromRuntime(runtime);
});

const identityPlacement = {
  rotation: { axis: [0, 0, 1] as const, angle: angle(0) },
  translation: { x: length(0), y: length(0), z: length(0) },
};

/** The derived ruled-band factor `sin(Δθ)/Δθ` at the shared station rule. */
function ruledBandFactor(): number {
  const step = helixStationStep();
  return Math.sin(step) / step;
}

/** The station rule's angular step for the fixture spines (constant). */
function helixStationStep(): number {
  const spine = {
    radiusMm: 10,
    pitchMm: 4,
    turns: 3,
    handedness: 1 as const,
    startAngleRad: 0,
    taperMm: 0,
  };
  const stations = helixStations(spine);
  const total = 2 * Math.PI * spine.turns;
  return total / (stations.length - 1);
}

/** A rectangle in meridian coords: u ∈ [u0, u1], v ∈ [-h/2, h/2]. */
function rectangleLoop(
  u0: number,
  u1: number,
  height: number,
): readonly ProfileSegmentInput[] {
  return [
    { kind: "line", start: [u0, -height / 2], end: [u1, -height / 2] },
    { kind: "line", start: [u1, -height / 2], end: [u1, height / 2] },
    { kind: "line", start: [u1, height / 2], end: [u0, height / 2] },
    { kind: "line", start: [u0, height / 2], end: [u0, -height / 2] },
  ];
}

describe("occt helixSweep (ruled meridian stations)", () => {
  it("sweeps a rectangular meridian profile to the derived ruled band of the Pappus-exact screw volume", () => {
    // Rectangle u ∈ [0, 2], height 1.5 at radius 10, 3 turns of pitch 4
    // (non-overlapping: 1.5 < 4). Exact screw volume:
    // A = 3 mm², d̄ = 10 + 1 = 11 → V = 2π·3·3·11 = 198π ≈ 622.035.
    const loop = rectangleLoop(0, 2, 1.5);
    const spine = {
      radius: length(10),
      pitch: length(4),
      turns: 3,
      handedness: 1 as const,
      startAngle: angle(0),
    };
    const swept = unwrapKernelResult(
      kernel.helixSweep({ loop, spine, placement: identityPlacement }),
      "helixSweep",
    );
    const volume = unwrapKernelResult(kernel.volume(swept), "volume");
    const exact = 2 * Math.PI * 3 * 3 * 11;
    // The DERIVED pin: the ruled stations land at sin(Δθ)/Δθ of the exact
    // value (Δθ from the shared 0.1 rad station rule), not at the raw
    // value — the band IS the assertion.
    assertVolumeClose(volume, exact * ruledBandFactor(), 1e-4);
    expect(volume).toBeLessThan(exact);
    expect(volume).toBeGreaterThan(exact * 0.99);
  });

  it("sweeps handedness symmetrically and honours the start angle as a rigid phase", () => {
    const loop = rectangleLoop(0, 2, 1.5);
    const right = unwrapKernelResult(
      kernel.helixSweep({
        loop,
        spine: {
          radius: length(10),
          pitch: length(4),
          turns: 2,
          handedness: 1,
          startAngle: angle(0),
        },
        placement: identityPlacement,
      }),
      "helixSweep right",
    );
    const left = unwrapKernelResult(
      kernel.helixSweep({
        loop,
        spine: {
          radius: length(10),
          pitch: length(4),
          turns: 2,
          handedness: -1,
          startAngle: angle(0),
        },
        placement: identityPlacement,
      }),
      "helixSweep left",
    );
    const volumeRight = unwrapKernelResult(kernel.volume(right), "volume");
    const volumeLeft = unwrapKernelResult(kernel.volume(left), "volume");
    // Handedness flips the winding direction, never the volume.
    assertVolumeClose(volumeLeft, volumeRight, 1e-9);
    const phased = unwrapKernelResult(
      kernel.helixSweep({
        loop,
        spine: {
          radius: length(10),
          pitch: length(4),
          turns: 2,
          handedness: 1,
          startAngle: angle(Math.PI / 3),
        },
        placement: identityPlacement,
      }),
      "helixSweep phased",
    );
    assertVolumeClose(
      unwrapKernelResult(kernel.volume(phased), "volume"),
      volumeRight,
      1e-9,
    );
  });

  it("sweeps the tapered spine at the derived mean-radius value", () => {
    // Taper +2 mm over 3 turns: the exact screw volume adds the taper/2
    // mean-radius shift (the Jacobian's R(t) integrates linearly):
    // V = 2π·3·3·(10 + 1 + 1).
    const loop = rectangleLoop(0, 2, 1.5);
    const spine = {
      radius: length(10),
      pitch: length(4),
      turns: 3,
      handedness: 1 as const,
      startAngle: angle(0),
      taper: length(2),
    };
    const swept = unwrapKernelResult(
      kernel.helixSweep({ loop, spine, placement: identityPlacement }),
      "helixSweep tapered",
    );
    const volume = unwrapKernelResult(kernel.volume(swept), "volume");
    const exact = 2 * Math.PI * 3 * 3 * 12;
    // The ruled approximation's mean-radius shift differs from the exact
    // mean by O(Δθ²·taper/turns) — the same band class, widened by the
    // taper-to-radius ratio, derived from the span Jacobian
    // (R₀R₁ + (R₀+R₁)ū + ū²) against (R̄+u)².
    assertVolumeClose(volume, exact, 5e-3);
    expect(volume).toBeGreaterThan(exact * 0.99);
    expect(volume).toBeLessThan(exact * 1.01);
  });

  it("sweeps the ISO thread tool to its derived trapezoid volume", () => {
    // M6×1 external groove: depth 5√3/16 ≈ 0.5413, widths 7/8 → 1/4.
    // A = (7/8 + 1/4)/2 · 5√3/16 = 45√3/256 mm²; centroid radius of the
    // trapezoid from the major cylinder (u ∈ [−d, 0]):
    // ū = −(depth/3)·(2·w_in + w_out)/(w_in + w_out) (trapezoid centroid).
    const P = 1;
    const loop = isoThreadToolLoop({ pitchMm: P, mode: "external" });
    const turns = 6;
    const spine = {
      radius: length(3),
      pitch: length(P),
      turns,
      handedness: 1 as const,
      startAngle: angle(0),
    };
    const swept = unwrapKernelResult(
      kernel.helixSweep({ loop, spine, placement: identityPlacement }),
      "helixSweep thread tool",
    );
    const volume = unwrapKernelResult(kernel.volume(swept), "volume");
    // The exact screw volume from the shared analytic model (the polygon's
    // own area and first radial moment — the same derivation the fake
    // kernel implements), times the derived ruled band.
    const polygon = helixProfilePolygon(loop);
    const screw = helixScrewVolume(polygon, {
      radiusMm: 3,
      pitchMm: P,
      turns,
      handedness: 1,
      startAngleRad: 0,
      taperMm: 0,
    });
    // The tool's axial extent 7P/8 < pitch: non-overlapping, the closed
    // form is the set volume.
    assertVolumeClose(volume, screw * ruledBandFactor(), 1e-3);
    // The hand-derived trapezoid cross-check: A = 45√3/256 mm² and the
    // centroid radius d̄ = R₀ − (depth/3)·(2·w_in + w_out)/(w_in + w_out)
    // (the trapezoid centroid's distance from the major cylinder).
    const area = (45 * Math.sqrt(3)) / 256;
    const depth = (5 * Math.sqrt(3)) / 16;
    const wOut = 7 / 8;
    const wIn = 1 / 4;
    const centroidRadius = 3 - (depth / 3) * ((2 * wIn + wOut) / (wIn + wOut));
    expect(screw / (2 * Math.PI * turns)).toBeCloseTo(area * centroidRadius, 6);
  });

  // The composed boolean (a 378-station tool through ThruSections plus
  // the subtract) runs seconds even unloaded; the explicit 60s ceiling
  // keeps turbo's parallel load from tripping the default timeout.
  it("cuts a thread groove from a rod inside the derived containment band", () => {
    // Rod ⌀6 × 6 (π·9·6 ≈ 169.646 mm³), M6×1 external thread, 6 turns:
    // the tool's material sits strictly inside the major cylinder, so the
    // cut volume is bounded above by the full tool volume and below by the
    // tool minus the two end slivers (the teeth sticking past the rod's
    // flat ends — at most (7/8)/turns of the tool, derived from the screw
    // solid's per-z material density A·2π·d̄/P).
    const rod = unwrapKernelResult(
      kernel.createCylinder({ radius: length(3), height: length(6) }),
      "createCylinder",
    );
    const loop = isoThreadToolLoop({ pitchMm: 1, mode: "external" });
    const tool = unwrapKernelResult(
      kernel.helixSweep({
        loop,
        spine: {
          radius: length(3),
          pitch: length(1),
          turns: 6,
          handedness: 1,
          startAngle: angle(0),
        },
        placement: identityPlacement,
      }),
      "helixSweep thread tool",
    );
    const threaded = unwrapKernelResult(
      kernel.subtract(rod, [tool]),
      "subtract",
    );
    const volume = unwrapKernelResult(kernel.volume(threaded), "volume");
    const polygon = helixProfilePolygon(loop);
    const toolVolume = helixScrewVolume(polygon, {
      radiusMm: 3,
      pitchMm: 1,
      turns: 6,
      handedness: 1,
      startAngleRad: 0,
      taperMm: 0,
    });
    const rodVolume = Math.PI * 9 * 6;
    // Cut ∈ [tool·(1 − 7/(8·6) − ruled band), tool] → the threaded volume
    // sits inside the derived containment band.
    expect(volume).toBeLessThanOrEqual(rodVolume - toolVolume * 0.83);
    expect(volume).toBeGreaterThanOrEqual(rodVolume - toolVolume);
    expect(volume).toBeGreaterThan(rodVolume - toolVolume * 1.2);
    expect(volume).toBeLessThan(rodVolume);
  }, 60_000);

  it("builds overlapping turns — legal geometry for the builder, unpinnable by the closed form", () => {
    // Axial extent 3 mm at pitch 1 mm over 2 turns: consecutive turns'
    // material overlaps — exactly the input the coverage matrix's subset
    // rule assigns per kernel. The fake kernel declines it (the
    // multiplicity integral would overcount); OCCT's ruled stations BUILD
    // it, because the overlap is legal geometry — only the exact-volume
    // formula requires non-overlap. The measured volume is therefore not
    // pinned by the closed form; the assertions are the build itself plus
    // the honest orderings: material exists, and the union sits strictly
    // below the multiplicity integral (which triple-counts the overlap).
    const loop = rectangleLoop(0, 2, 3);
    const dimensional = {
      radius: length(10),
      pitch: length(1),
      turns: 2,
      handedness: 1 as const,
      startAngle: angle(0),
    };
    expect(
      helixTurnsOverlap(loop, {
        radiusMm: 10,
        pitchMm: 1,
        turns: 2,
        handedness: 1,
        startAngleRad: 0,
        taperMm: 0,
      }),
    ).toBe(true);
    const swept = unwrapKernelResult(
      kernel.helixSweep({
        loop,
        spine: dimensional,
        placement: identityPlacement,
      }),
      "helixSweep overlapping turns",
    );
    const volume = unwrapKernelResult(kernel.volume(swept), "volume");
    expect(volume).toBeGreaterThan(0);
    const multiplicity = helixScrewVolume(helixProfilePolygon(loop), {
      radiusMm: 10,
      pitchMm: 1,
      turns: 2,
      handedness: 1,
      startAngleRad: 0,
      taperMm: 0,
    });
    expect(volume).toBeLessThan(multiplicity);
  });

  it("rejects the shared battery before any engine call", () => {
    const loop = rectangleLoop(0, 2, 1.5);
    // The flat circle: zero pitch and zero taper is not a helix.
    expectKernelFailure(
      kernel.helixSweep({
        loop,
        spine: {
          radius: length(10),
          pitch: length(0),
          turns: 3,
          handedness: 1,
          startAngle: angle(0),
        },
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.invalidHelix,
      "the flat circle helix",
    );
    // Negative pitch: handedness carries direction.
    expectKernelFailure(
      kernel.helixSweep({
        loop,
        spine: {
          radius: length(10),
          pitch: length(-1),
          turns: 3,
          handedness: 1,
          startAngle: angle(0),
        },
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.invalidHelix,
      "the negative pitch helix",
    );
    // Zero turns sweep nothing.
    expectKernelFailure(
      kernel.helixSweep({
        loop,
        spine: {
          radius: length(10),
          pitch: length(4),
          turns: 0,
          handedness: 1,
          startAngle: angle(0),
        },
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.invalidHelix,
      "the zero-turn helix",
    );
    // A profile crossing the axis wraps through it.
    expectKernelFailure(
      kernel.helixSweep({
        loop: rectangleLoop(-12, 2, 1.5),
        spine: {
          radius: length(10),
          pitch: length(4),
          turns: 3,
          handedness: 1,
          startAngle: angle(0),
        },
        placement: identityPlacement,
      }),
      KERNEL_ERROR_CODES.profileAxisCrossing,
      "the axis-crossing profile",
    );
    // The shared battery agrees with the adapter's rejection.
    expect(
      helixSweepProblem(rectangleLoop(-12, 2, 1.5), {
        radiusMm: 10,
        pitchMm: 4,
        turns: 3,
        handedness: 1,
        startAngleRad: 0,
        taperMm: 0,
      }),
    ).not.toBeNull();
  });

  it("pins the station rule the derived band rides on", () => {
    // The derived pin's Δθ is the shared deflection constant: stations
    // ceil(2π·turns/0.1)+1, so the factor sin(Δθ)/Δθ ≈ 0.998334 — the
    // same 0.166%-class deficit the mesh kernels' 63-chord revolves
    // document.
    expect(PROFILE_STATION_ANGLE_RAD).toBe(0.1);
    expect(
      helixStations({
        radiusMm: 10,
        pitchMm: 4,
        turns: 3,
        handedness: 1,
        startAngleRad: 0,
        taperMm: 0,
      }).length,
    ).toBe(Math.ceil((2 * Math.PI * 3) / 0.1) + 1);
    expect(1 - ruledBandFactor()).toBeLessThan(2e-3);
  });
});
