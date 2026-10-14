/**
 * The mechanism animation panel (Phase 67c): the ENGINE KINEMATICS
 * DEMO's motion surface — the assembly-motion path the dynamics run
 * drives. The run's own per-joint histories (crank angle, conrod
 * angle, piston slide per sample) become JOINT PARAMETERS through
 * cad-core's `applyMotionJoint` — the exact function the
 * `/workbench-assembly-motion` page composes occurrence placements
 * with — and the composed transforms place the mechanism's links in a
 * deterministic plan view (SVG-as-data, the fan chart's discipline).
 * A scrub input walks the samples: deterministic under scrub, exactly
 * the assembly-motion surface's own law — no ambient rAF loop, one
 * committed render per input event (law S6's spirit at the UI scale).
 *
 * Pure derivation: {@link mechanismMotionOf} maps a result's
 * histories + the demo's joint records into the sampled poses; the
 * panel renders them. The machine-readable surface:
 * `data-sim-motion-sample`, `data-sim-motion-samples`,
 * `data-sim-motion-crank-deg`, `data-sim-motion-slide-mm`, and
 * `data-sim-motion-time-s`.
 */

import {
  applyMotionJoint,
  composePlacementTransforms,
  type AssemblyMotionJoint,
  type PlacementTransform,
} from "@slopcad/cad-core";
import type { SimResult } from "@slopcad/sim-core";
import { useEffect, useState, type ReactElement } from "react";

import {
  SLIDER_DEMO,
  SLIDER_JOINT_IDS,
  SLIDER_OCCURRENCE_IDS,
} from "./slider-crank-demo";

/** The panel's deterministic geometry, px (the fan chart's discipline). */
const PANEL_WIDTH = 320;
const PANEL_HEIGHT = 150;
/** The plan view's world-to-pixel scale, px per mm. */
const SCALE = 1.8;
/** The plan view's world origin inside the panel, px. */
const ORIGIN_X = 30;
const ORIGIN_Y = PANEL_HEIGHT / 2;

/** One sampled pose of the mechanism's three moving links. */
export interface MechanismSamplePose {
  /** The sample's time, s. */
  readonly timeS: number;
  /** The crank bar's four plan-view corners, px. */
  readonly crank: readonly (readonly [number, number])[];
  /** The connecting rod's four corners, px. */
  readonly rod: readonly (readonly [number, number])[];
  /** The piston block's four corners, px. */
  readonly piston: readonly (readonly [number, number])[];
}

/** The derivation's outcome: the samples plus the current extents. */
export interface MechanismMotion {
  readonly poses: readonly MechanismSamplePose[];
  readonly crankAngleRad: readonly number[];
  readonly pistonSlideM: readonly number[];
}

/** One history series by exact name, or undefined. */
function historyOf(
  result: SimResult,
  name: string,
): readonly number[] | undefined {
  return result.histories.find((series) => series.name === name)?.samples;
}

/** Applies a point through a placement transform (the plan view's xy). */
function placePoint(
  transform: PlacementTransform,
  x: number,
  y: number,
): readonly [number, number] {
  const r = transform.rotation;
  return [
    (r[0] ?? 0) * x + (r[1] ?? 0) * y + (transform.translation[0] ?? 0),
    (r[3] ?? 0) * x + (r[4] ?? 0) * y + (transform.translation[1] ?? 0),
  ];
}

/** A link bar's four plan-view corners under a transform, world mm. */
function barCorners(
  transform: PlacementTransform,
  lengthMm: number,
  halfWidthMm: number,
): readonly (readonly [number, number])[] {
  return [
    placePoint(transform, 0, -halfWidthMm),
    placePoint(transform, lengthMm, -halfWidthMm),
    placePoint(transform, lengthMm, halfWidthMm),
    placePoint(transform, 0, halfWidthMm),
  ];
}

/** A centred block's four corners under a transform, world mm. */
function blockCorners(
  transform: PlacementTransform,
  halfXMm: number,
  halfYMm: number,
): readonly (readonly [number, number])[] {
  return [
    placePoint(transform, -halfXMm, -halfYMm),
    placePoint(transform, halfXMm, -halfYMm),
    placePoint(transform, halfXMm, halfYMm),
    placePoint(transform, -halfXMm, halfYMm),
  ];
}

/**
 * Derives the mechanism's sampled poses from a completed dynamics
 * run: the joint histories drive `applyMotionJoint` per joint (the
 * assembly-motion surface's own function — revolute parameters in
 * degrees, slider parameters in the joint frame's millimetres), the
 * transforms compose along the document's chain (the crank on the
 * base, the rod on the crank, the piston on the base's slide), and
 * the plan view projects the authored link geometry through them.
 */
export function mechanismMotionOf(result: SimResult): MechanismMotion | null {
  const times = historyOf(result, "time");
  const crank = historyOf(
    result,
    `joint:${String(SLIDER_JOINT_IDS.crank)}:dof0:position`,
  );
  const conrod = historyOf(
    result,
    `joint:${String(SLIDER_JOINT_IDS.conrod)}:dof0:position`,
  );
  const slide = historyOf(
    result,
    `joint:${String(SLIDER_JOINT_IDS.slide)}:dof0:position`,
  );
  if (
    times === undefined ||
    crank === undefined ||
    conrod === undefined ||
    slide === undefined ||
    times.length === 0
  ) {
    return null;
  }
  // The document's joint records as the assembly-motion surface reads
  // them: the demo's own frames, restated from the fixture data (the
  // parameters clamp to the authored limits — unbounded, the honest
  // default the demo authors).
  const crankJoint: AssemblyMotionJoint = {
    occurrenceId: SLIDER_OCCURRENCE_IDS.crank,
    kind: "revolute",
    axisOrigin: [0, 0, 0],
    axisDirection: [0, 0, 1],
    limitMin: -1e9,
    limitMax: 1e9,
  };
  const conrodJoint: AssemblyMotionJoint = {
    occurrenceId: SLIDER_OCCURRENCE_IDS.rod,
    kind: "revolute",
    // The rod's local frame origin IS the crank pin (the authored
    // body's own convention), so the local rotation is about the
    // local origin; the pin's WORLD position rides the crank's angle
    // through the composition below.
    axisOrigin: [0, 0, 0],
    axisDirection: [0, 0, 1],
    limitMin: -1e9,
    limitMax: 1e9,
  };
  const slideJoint: AssemblyMotionJoint = {
    occurrenceId: SLIDER_OCCURRENCE_IDS.piston,
    kind: "slider",
    axisOrigin: [SLIDER_DEMO.crankRadiusMm + SLIDER_DEMO.rodLengthMm, 0, 0],
    axisDirection: [1, 0, 0],
    limitMin: -1e9,
    limitMax: 1e9,
  };
  const pistonPlacement: PlacementTransform = {
    rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    translation: [SLIDER_DEMO.crankRadiusMm + SLIDER_DEMO.rodLengthMm, 0, 0],
  };
  const poses: MechanismSamplePose[] = [];
  for (const [index, crankAngleRad] of crank.entries()) {
    const timeS = times[index] ?? 0;
    const conrodAngleRad = conrod[index] ?? 0;
    const slideM = slide[index] ?? 0;
    // The assembly-motion surface: parameters in ITS units — degrees
    // on a revolute, the joint frame's millimetres on a slider. Each
    // link's local frame sits at its joint (the authored bodies' own
    // convention: the crank bar from the main bearing, the rod bar
    // from the crank pin, the piston block on its pin), so the motion
    // composes as the joint's rotation in the local frame carried to
    // the joint's world position — the same composition the
    // assembly-motion page performs over its occurrence chain.
    const pinX = SLIDER_DEMO.crankRadiusMm * Math.cos(crankAngleRad);
    const pinY = SLIDER_DEMO.crankRadiusMm * Math.sin(crankAngleRad);
    const crankMotion = applyMotionJoint(
      crankJoint,
      (crankAngleRad * 180) / Math.PI,
    );
    const rodRotation = applyMotionJoint(
      conrodJoint,
      ((crankAngleRad + conrodAngleRad) * 180) / Math.PI,
    );
    const slideMotion = applyMotionJoint(slideJoint, slideM * 1000);
    if (!crankMotion.ok || !rodRotation.ok || !slideMotion.ok) {
      return null;
    }
    const crankPose = crankMotion.value;
    const rodPose = composePlacementTransforms(
      {
        rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        translation: [pinX, pinY, 0],
      },
      rodRotation.value,
    );
    const pistonPose = composePlacementTransforms(
      pistonPlacement,
      slideMotion.value,
    );
    const px = (
      point: readonly [number, number],
    ): readonly [number, number] => [
      ORIGIN_X + point[0] * SCALE,
      ORIGIN_Y - point[1] * SCALE,
    ];
    poses.push({
      timeS,
      crank: barCorners(crankPose, SLIDER_DEMO.crankRadiusMm, 6).map(px),
      rod: barCorners(rodPose, SLIDER_DEMO.rodLengthMm, 5).map(px),
      piston: blockCorners(
        pistonPose,
        SLIDER_DEMO.pistonHalfXMm,
        SLIDER_DEMO.pistonHalfYMm,
      ).map(px),
    });
  }
  return { poses, crankAngleRad: [...crank], pistonSlideM: [...slide] };
}

/** One link's corners as an SVG points attribute. */
function pointsAttribute(
  corners: readonly (readonly [number, number])[],
): string {
  return corners.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
}

/**
 * The mechanism animation panel: the scrub surface over a completed
 * run's poses. Deterministic under scrub (one committed render per
 * input event); the current sample's numbers publish as the panel's
 * data attributes.
 */
export function MechanismMotionPanel({
  motion,
}: {
  readonly motion: MechanismMotion;
}): ReactElement {
  const [sample, setSample] = useState(0);
  const last = motion.poses.length - 1;
  const clamped = Math.min(Math.max(sample, 0), last);
  // A NEW result resets the scrub to the march's start — the panel
  // never animates from a stale sample of a previous run.
  useEffect(() => {
    setSample(0);
  }, [motion]);
  const pose = motion.poses[clamped];
  if (pose === undefined) {
    throw new Error("The mechanism motion carries no samples.");
  }
  return (
    <div className="space-y-1" data-testid="workbench-sim-mechanism-motion">
      <p className="font-medium">Mechanism motion (Phase 67 — scrub the run)</p>
      <svg
        width={PANEL_WIDTH}
        height={PANEL_HEIGHT}
        viewBox={`0 0 ${String(PANEL_WIDTH)} ${String(PANEL_HEIGHT)}`}
        role="img"
        aria-label="The slider-crank mechanism at the scrubbed dynamics sample"
        data-sim-motion-sample={String(clamped)}
        data-sim-motion-samples={String(motion.poses.length)}
        data-sim-motion-crank-deg={(
          ((motion.crankAngleRad[clamped] ?? 0) * 180) /
          Math.PI
        ).toFixed(3)}
        data-sim-motion-slide-mm={(
          (motion.pistonSlideM[clamped] ?? 0) * 1000
        ).toFixed(3)}
        data-sim-motion-time-s={pose.timeS.toFixed(3)}
      >
        {/* The base plate's plan-view outline (the grounded frame). */}
        <polyline
          data-part="base"
          fill="none"
          stroke="#71717a"
          strokeWidth={1}
          points={pointsAttribute([
            [ORIGIN_X - 18, ORIGIN_Y - 54],
            [ORIGIN_X + 252, ORIGIN_Y - 54],
            [ORIGIN_X + 252, ORIGIN_Y + 54],
            [ORIGIN_X - 18, ORIGIN_Y + 54],
            [ORIGIN_X - 18, ORIGIN_Y - 54],
          ])}
        />
        <polygon
          data-part="crank"
          fill="#dbeafe"
          stroke="#1d4ed8"
          strokeWidth={1}
          points={pointsAttribute(pose.crank)}
        />
        <polygon
          data-part="rod"
          fill="#dcfce7"
          stroke="#15803d"
          strokeWidth={1}
          points={pointsAttribute(pose.rod)}
        />
        <polygon
          data-part="piston"
          fill="#fee2e2"
          stroke="#b91c1c"
          strokeWidth={1}
          points={pointsAttribute(pose.piston)}
        />
      </svg>
      <label className="block text-xs" htmlFor="workbench-sim-motion-scrub">
        Sample
        <input
          id="workbench-sim-motion-scrub"
          data-testid="workbench-sim-motion-scrub"
          type="range"
          min={0}
          max={last}
          step={1}
          value={clamped}
          onChange={(event) => {
            setSample(Number(event.target.value));
          }}
        />
      </label>
    </div>
  );
}
