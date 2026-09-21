/**
 * The ISO metric thread vocabulary (Phase 40): the standard's coarse/fine
 * designation table as DATA, and the derived tooth geometry the real-thread
 * feature sweeps — the ONE source of the thread tool shape, shared verbatim
 * by the executor bridge (which composes `helixSweep` + boolean) and the
 * workbench's worker scene (which composes the identical cut through the
 * worker operation matrix) — `planHoleCut`'s discipline.
 *
 * ## The dimensional chain (ISO 68-1 basic profile, documented)
 *
 * All dimensions derive from the pitch `P` and the major diameter `d`:
 *
 * - The fundamental triangle: height `H = (√3/2)·P`, base `P`, flanks at
 *   30° to the radial direction (60° included angle).
 * - The crest truncation `H/8` leaves the ridge's crest flat `P/8` wide
 *   (a flank-truncation `t` cuts width `2·t·tan 30° = 2t/√3`; at `t =
 *   H/8` that is exactly `P/8`).
 * - The root truncation `H/4` leaves the groove's flat bottom `P/4` wide
 *   (at `t = H/4`: `2t/√3 = P/4`).
 * - The depth of engagement: `5H/8 = (√3/2)·P·5/8 ≈ 0.5413·P` radially,
 *   so the basic minor diameter is `d₁ = d − 2·(5H/8) = d − 1.0825·P`
 *   (M6×1: 4.917 mm — the standard's value).
 * - Per pitch, at the major line the ridge is `P/8` and the groove `7P/8`
 *   wide; at the minor line the ridge is `3P/4` and the groove `P/4`.
 *
 * The feature's TOOL is the ISO groove swept along the helix:
 *
 * - EXTERNAL thread (cut into a rod of diameter `d`): the groove trapezoid
 *   — radial span `[d₁/2, d/2]`, width `7P/8` at the rod surface narrowing
 *   to `P/4` at the groove bottom (the form tool that cuts a bolt).
 * - INTERNAL thread (cut into a hole wall out to the major diameter): the
 *   ridge trapezoid — the same radial span `[d₁/2, d/2]`, width `3P/4` at
 *   the hole wall narrowing to `P/8` at depth (the tap's shape, i.e. the
 *   material a bolt's ridge would occupy).
 *
 * The tap drill the table carries is the shop rule `d − P` (the nearest
 * standard drill to the basic minor for coarse pitches; documented as the
 * computed value, not a per-entry measurement).
 */

import { angle as angleValue, length as lengthValue } from "@slopcad/cad-core";
import type { HelixSweepInput, ProfileSegmentInput } from "./contract";
import type { CanonicalHelixSpine } from "./helix-geometry";

/** One ISO metric thread designation row. */
export interface IsoMetricThreadSize {
  /** The designation ("M6" for coarse, "M6x0.75" for fine). */
  readonly designation: string;
  /** The major diameter `d` (mm). */
  readonly majorDiameterMm: number;
  /** The pitch `P` (mm). */
  readonly pitchMm: number;
  /** The tap drill diameter `d − P` (mm, the shop rule — see the module doc). */
  readonly tapDrillMm: number;
}

function coarse(majorDiameterMm: number, pitchMm: number): IsoMetricThreadSize {
  return {
    designation: `M${trimNumber(majorDiameterMm)}`,
    majorDiameterMm,
    pitchMm,
    tapDrillMm: majorDiameterMm - pitchMm,
  };
}

function fine(majorDiameterMm: number, pitchMm: number): IsoMetricThreadSize {
  return {
    designation: `M${trimNumber(majorDiameterMm)}x${trimNumber(pitchMm)}`,
    majorDiameterMm,
    pitchMm,
    tapDrillMm: majorDiameterMm - pitchMm,
  };
}

/** Formats a table number without trailing zeros (6 not 6.0). */
function trimNumber(value: number): string {
  return String(value);
}

/**
 * The ISO metric thread table (ISO 261 coarse series M1.6–M64 plus the
 * common fine series), ordered by major diameter then pitch. Coarse rows
 * first at equal diameter (the standard's default choice).
 */
export const ISO_METRIC_THREAD_TABLE: readonly IsoMetricThreadSize[] =
  Object.freeze([
    coarse(1.6, 0.35),
    coarse(2, 0.4),
    coarse(2.5, 0.45),
    coarse(3, 0.5),
    fine(3, 0.35),
    coarse(4, 0.7),
    fine(4, 0.5),
    coarse(5, 0.8),
    fine(5, 0.5),
    coarse(6, 1),
    fine(6, 0.75),
    fine(6, 0.5),
    coarse(8, 1.25),
    fine(8, 1),
    fine(8, 0.75),
    coarse(10, 1.5),
    fine(10, 1.25),
    fine(10, 1),
    fine(10, 0.75),
    coarse(12, 1.75),
    fine(12, 1.5),
    fine(12, 1.25),
    fine(12, 1),
    coarse(16, 2),
    fine(16, 1.5),
    fine(16, 1),
    coarse(20, 2.5),
    fine(20, 2),
    fine(20, 1.5),
    fine(20, 1),
    coarse(24, 3),
    fine(24, 2),
    fine(24, 1.5),
    coarse(30, 3.5),
    fine(30, 3),
    fine(30, 2),
    fine(30, 1.5),
    coarse(36, 4),
    fine(36, 3),
    fine(36, 2),
    fine(36, 1.5),
    coarse(42, 4.5),
    fine(42, 3),
    fine(42, 2),
    fine(42, 1.5),
    coarse(48, 5),
    fine(48, 3),
    fine(48, 2),
    fine(48, 1.5),
    coarse(56, 5.5),
    fine(56, 3),
    fine(56, 2),
    coarse(64, 6),
    fine(64, 4),
    fine(64, 3),
    fine(64, 2),
  ]);

/** Looks one designation up in the ISO table (exact string match). */
export function isoMetricThreadByDesignation(
  designation: string,
): IsoMetricThreadSize | undefined {
  return ISO_METRIC_THREAD_TABLE.find(
    (size) => size.designation === designation,
  );
}

/** The thread feature's modes: real cuts and the cosmetic annotation. */
export const THREAD_MODES = ["external", "internal", "cosmetic"] as const;

/** A thread feature mode (see {@link THREAD_MODES}). */
export type ThreadMode = (typeof THREAD_MODES)[number];

/** The thread modes that cut real geometry (the cosmetic mode annotates). */
export const REAL_THREAD_MODES: readonly ThreadMode[] = [
  "external",
  "internal",
];

/**
 * The ISO basic-profile height of the fundamental triangle:
 * `H = (√3/2)·P`.
 */
export function isoThreadTriangleHeight(pitchMm: number): number {
  return (Math.sqrt(3) / 2) * pitchMm;
}

/** The thread's radial depth of engagement: `5H/8` (see the module doc). */
export function isoThreadDepth(pitchMm: number): number {
  return (isoThreadTriangleHeight(pitchMm) * 5) / 8;
}

/** The basic minor diameter: `d − 2·(5H/8)` (see the module doc). */
export function isoThreadMinorDiameter(
  majorDiameterMm: number,
  pitchMm: number,
): number {
  return majorDiameterMm - 2 * isoThreadDepth(pitchMm);
}

/**
 * The ISO groove tool LOOP, in the helix sweep's MERIDIAN coordinates:
 * `(u, v) = (radial, axial)` measured from the SPINE START POINT, which
 * sits ON THE THREAD'S MAJOR CYLINDER (radius `d/2`) — the tool's material
 * spans `u ∈ [−5H/8, 0]` (strictly inside the major cylinder), `v` centered
 * on zero. External mode returns the groove trapezoid (7P/8 at the
 * surface), internal mode the ridge trapezoid (3P/4 at the hole wall);
 * see the module doc for the widths' derivation.
 */
export function isoThreadToolLoop(input: {
  readonly pitchMm: number;
  readonly mode: Exclude<ThreadMode, "cosmetic">;
}): readonly ProfileSegmentInput[] {
  const P = input.pitchMm;
  const depth = isoThreadDepth(P);
  const outerWidth = input.mode === "external" ? (7 * P) / 8 : (3 * P) / 4;
  const innerWidth = input.mode === "external" ? P / 4 : P / 8;
  // The trapezoid, CCW in (u, v) starting at the bottom-left corner. The
  // flank slope check: Δu = depth carries Δv = (outerWidth − innerWidth)/2
  // = P·(mode factor)/2 each side; for external, Δv/Δu = (5P/16)/(5√3P/16)
  // = 1/√3 = tan 30° — the 60° included angle, exact.
  return [
    {
      kind: "line",
      start: [-depth, -innerWidth / 2],
      end: [0, -outerWidth / 2],
    },
    {
      kind: "line",
      start: [0, -outerWidth / 2],
      end: [0, outerWidth / 2],
    },
    {
      kind: "line",
      start: [0, outerWidth / 2],
      end: [-depth, innerWidth / 2],
    },
    {
      kind: "line",
      start: [-depth, innerWidth / 2],
      end: [-depth, -innerWidth / 2],
    },
  ];
}

/**
 * The canonical helix spine of one thread: the tool sweeps at the major
 * radius, `turns = length / pitch` (the thread's axial extent is exactly
 * its length — fractional final turns are honest thread vocabulary), full
 * axial advance per turn, no taper.
 */
export function threadHelixSpine(input: {
  readonly majorDiameterMm: number;
  readonly pitchMm: number;
  readonly lengthMm: number;
  readonly handedness: 1 | -1;
  readonly startAngleRad: number;
}): CanonicalHelixSpine {
  return {
    radiusMm: input.majorDiameterMm / 2,
    pitchMm: input.pitchMm,
    turns: input.lengthMm / input.pitchMm,
    handedness: input.handedness,
    startAngleRad: input.startAngleRad,
    taperMm: 0,
  };
}

/**
 * The planned thread cut (Phase 40) — the composed feature's ONE source of
 * tool geometry, shared by the executor bridge and the workbench's worker
 * scene. Pure and kernel-independent: the same inputs and target bounds
 * produce the identical {@link HelixSweepInput} at both consumers.
 *
 * ## Semantics (documented where the author reads them)
 *
 * - The thread axis runs PARALLEL to `advanceDirection` and STARTS at
 *   `axisBaseMm` (the entry point on the axis line, the hole precedent:
 *   axis-aligned threading enters through the + face and advances in).
 * - `lengthMm` is the thread's AXIAL extent: the spine advances exactly
 *   that far (`turns = length / pitch`) along `advanceDirection`.
 * - The tool's material spans radius `[d₁/2, d/2]` — strictly inside the
 *   major cylinder — so an EXTERNAL thread on a rod of diameter `d` cuts
 *   the groove exactly (the shop convention: model the nominal major,
 *   then thread it), and an INTERNAL thread in a hole of diameter ≤ d₁
 *   cuts the ridge-shaped grooves out to the major diameter.
 * - `advanceDirection` must be a unit vector (a resolved datum axis or a
 *   world-axis unit — the callers guarantee it); both mode tools are the
 *   ISO-derived trapezoids of the module doc.
 */
export interface ThreadCutPlan {
  /** The helix sweep input of the tool (loop + spine + placement). */
  readonly tool: HelixSweepInput;
  /** The rotation pointing local +z (the helix axis) along `axisDirection`. */
  readonly toolRotationAxis: readonly [number, number, number];
  readonly toolRotationAngleRad: number;
  /** The tool's axis-base translation (world mm). */
  readonly toolTranslationMm: readonly [number, number, number];
  /** The thread's turn count (`length / pitch`, possibly fractional). */
  readonly turns: number;
}

/** The rotation carrying local +z onto a unit direction (Rodrigues form). */
export function rotationAligningZTo(
  direction: readonly [number, number, number],
): {
  readonly axis: readonly [number, number, number];
  readonly angleRad: number;
} {
  const cross = [
    0 * direction[2] - 1 * direction[1],
    1 * direction[0] - 0 * direction[2],
    0 * direction[1] - 0 * direction[0],
  ];
  const sin = Math.hypot(cross[0] ?? 0, cross[1] ?? 0, cross[2] ?? 0);
  const cos = direction[2];
  if (sin < 1e-12) {
    return cos > 0
      ? { axis: [1, 0, 0], angleRad: 0 }
      : { axis: [1, 0, 0], angleRad: Math.PI };
  }
  return {
    axis: [(cross[0] ?? 0) / sin, (cross[1] ?? 0) / sin, (cross[2] ?? 0) / sin],
    angleRad: Math.atan2(sin, cos),
  };
}

/**
 * Plans one thread's tool sweep against the target's measured bounds (see
 * {@link ThreadCutPlan} for the semantics). The plan never judges whether
 * the cut removes material — the bridge's post-condition battery does, on
 * the measured volumes.
 *
 * `advanceDirection` must be a unit vector (a resolved datum axis or a
 * world-axis unit — the callers guarantee it): the thread advances INTO
 * the target along it from the `axisBaseMm` entry point on the axis line
 * (the hole precedent's entry-face rule, computed by the caller from the
 * target's bounds).
 */
export function planThreadCut(input: {
  readonly majorDiameterMm: number;
  readonly pitchMm: number;
  readonly lengthMm: number;
  readonly mode: Exclude<ThreadMode, "cosmetic">;
  readonly handedness: 1 | -1;
  readonly startAngleRad: number;
  readonly advanceDirection: readonly [number, number, number];
  readonly axisBaseMm: readonly [number, number, number];
}): ThreadCutPlan {
  const rotation = rotationAligningZTo(input.advanceDirection);
  const translation: readonly [number, number, number] = [...input.axisBaseMm];
  const spine = threadHelixSpine({
    majorDiameterMm: input.majorDiameterMm,
    pitchMm: input.pitchMm,
    lengthMm: input.lengthMm,
    handedness: input.handedness,
    startAngleRad: input.startAngleRad,
  });
  return {
    tool: {
      loop: isoThreadToolLoop({ pitchMm: input.pitchMm, mode: input.mode }),
      spine: {
        radius: lengthValue(spine.radiusMm),
        pitch: lengthValue(spine.pitchMm),
        turns: spine.turns,
        handedness: spine.handedness,
        startAngle: angleValue(spine.startAngleRad),
        taper: lengthValue(spine.taperMm),
      },
      placement: {
        rotation: {
          axis: rotation.axis,
          angle: angleValue(rotation.angleRad),
        },
        translation: {
          x: lengthValue(translation[0]),
          y: lengthValue(translation[1]),
          z: lengthValue(translation[2]),
        },
      },
    },
    toolRotationAxis: rotation.axis,
    toolRotationAngleRad: rotation.angleRad,
    toolTranslationMm: translation,
    turns: input.lengthMm / input.pitchMm,
  };
}
