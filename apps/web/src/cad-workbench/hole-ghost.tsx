/**
 * The structured hole dialog's PREVIEW GHOST (Phase 42): the planned hole's
 * footprint drawn as SVG over the canvas — the datum overlay's discipline
 * verbatim. The ghost is a PURE function of (dialog values, document,
 * bounds, projection): per position, the entry circle on the entry face's
 * plane (the type's ENTRY radius — the counterbore's, the countersink's
 * rim, the taper's, the ISO major for threaded), the hole's axis dashed
 * from above the entry face down to the authored depth, and the drill-tip
 * point at that depth. Identical state draws identical glyphs at identical
 * pixels — never serialized, never a scene dispatch, never a kernel call.
 *
 * The layer is sized to its own live rendered box (the datum overlay's
 * rule): the glyphs project through the SAME live size the scene camera
 * renders with, so they stay on the geometry at every window size; the
 * `viewBox` mirrors the measured box for a 1:1 pixel mapping. Before the
 * first measurement (and where ResizeObserver is unavailable) it falls
 * back to the fixture's authored 800×520 frame.
 *
 * Machine surface: the SVG carries `data-hole-preview-ghost` and one
 * `data-hole-preview-position` group per position, so the e2e battery
 * asserts presence and count without reading pixels.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { CadDocument, RenderProjection } from "@slopcad/cad-core";
import { renderCameraScreenPoint } from "@slopcad/cad-r3f";
import {
  structuredHoleDatumInPlaneAxes,
  structuredHoleWorldInPlaneAxes,
} from "@slopcad/cad-kernel";
import type { HoleFormValues } from "./feature-forms";

import { resolveSessionDatumAxis } from "./datum";
import { sketchPointsResolverOf } from "./hole";

/** The workbench viewport's fixed CSS size (the fixture camera spec's frame
 * — the fallback before the live box's first measurement). */
const VIEWPORT_CSS_WIDTH = 800;
const VIEWPORT_CSS_HEIGHT = 520;

/** The entry circle's sampling count (deterministic glyph geometry). */
const CIRCLE_SAMPLES = 48;

/** How far the axis line stands off past the entry face (mm). */
const AXIS_STANDOFF_MM = 1.5;

/** The hole type's ENTRY radius (mm) — the footprint the ghost circles. */
function entryRadiusMm(values: HoleFormValues): number {
  if (values.holeType === "counterbore") return values.cboreDiameterMm / 2;
  if (values.holeType === "countersink") return values.csinkDiameterMm / 2;
  if (values.holeType === "threaded") return values.threadMajorMm / 2;
  return values.diameterMm / 2;
}

type Vec3 = readonly [number, number, number];

/** `a + s·u + t·v + w·n` — the world point builder over one frame. */
function framePoint(
  origin: Vec3,
  u: Vec3,
  v: Vec3,
  n: Vec3,
  s: number,
  t: number,
  w: number,
): Vec3 {
  return [
    origin[0] + s * u[0] + t * v[0] + w * n[0],
    origin[1] + s * u[1] + t * v[1] + w * n[1],
    origin[2] + s * u[2] + t * v[2] + w * n[2],
  ];
}

/** Projects a world point; `null` when the camera mapping refuses it. */
function project(
  point: Vec3,
  projection: RenderProjection,
  width: number,
  height: number,
): readonly [number, number] | null {
  try {
    const [x, y] = renderCameraScreenPoint(
      projection.camera,
      point,
      width,
      height,
    );
    return [x, y];
  } catch {
    return null;
  }
}

/** One resolved position's ghost geometry, in world millimetres. */
interface HoleGlyph {
  /** The entry circle's world points, closed (first repeated last). */
  readonly circle: readonly Vec3[];
  /** The axis line's two ends: above the entry face, at the authored depth. */
  readonly axisEnds: readonly [Vec3, Vec3];
  /** The drill-tip point at the authored depth. */
  readonly tip: Vec3;
}

/**
 * The preview ghost. `bounds` is the scene solid's measured bounds (the
 * entry face is its extreme along the hole axis); `null` bounds or an
 * unresolvable axis/positions input draws NOTHING (no guessed geometry).
 */
export function CadHolePreviewGhost({
  values,
  document,
  bounds,
  projection,
}: {
  readonly values: HoleFormValues;
  readonly document: CadDocument;
  readonly bounds: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  } | null;
  readonly projection: RenderProjection;
}): ReactElement {
  const glyphs = useMemo(() => {
    if (bounds === null) return [];
    // The axis: the datum's resolved direction, else the world selector —
    // the same in-plane basis resolution the cut itself composes with.
    let axisDirection: Vec3;
    let basis: { readonly u: Vec3; readonly v: Vec3 };
    if (values.datumAxisId !== "") {
      const resolved = resolveSessionDatumAxis(document, values.datumAxisId);
      if (!resolved.ok) return [];
      axisDirection = [
        resolved.direction[0],
        resolved.direction[1],
        resolved.direction[2],
      ];
      basis = structuredHoleDatumInPlaneAxes(axisDirection);
    } else {
      axisDirection =
        values.axis === "x"
          ? [1, 0, 0]
          : values.axis === "y"
            ? [0, 1, 0]
            : [0, 0, 1];
      basis = structuredHoleWorldInPlaneAxes(
        values.axis === "x" ? 1 : values.axis === "y" ? 2 : 3,
      );
    }
    // The positions: the picked sketch's points, else the parameter pair.
    let positions: readonly { readonly x: number; readonly y: number }[];
    if (values.positionsSketchId !== "") {
      const resolved = sketchPointsResolverOf(document)(
        values.positionsSketchId,
      );
      if (!resolved.ok) return [];
      positions = resolved.points;
    } else {
      positions = [{ x: values.positionXMm, y: values.positionYMm }];
    }
    // The entry face's plane: the bounds' extreme projection along the axis.
    let entry = -Infinity;
    for (const x of [bounds.min[0], bounds.max[0]]) {
      for (const y of [bounds.min[1], bounds.max[1]]) {
        for (const z of [bounds.min[2], bounds.max[2]]) {
          entry = Math.max(
            entry,
            x * axisDirection[0] + y * axisDirection[1] + z * axisDirection[2],
          );
        }
      }
    }
    const radius = entryRadiusMm(values);
    const depth = values.depthMm;
    return positions.map((position): HoleGlyph => {
      // The entry-plane circle centre: the position offset onto the axis
      // line, lifted to the entry plane.
      const center = framePoint(
        [0, 0, 0],
        basis.u,
        basis.v,
        axisDirection,
        position.x,
        position.y,
        entry,
      );
      const circle: Vec3[] = [];
      for (let sample = 0; sample <= CIRCLE_SAMPLES; sample += 1) {
        const angle = (sample / CIRCLE_SAMPLES) * 2 * Math.PI;
        circle.push(
          framePoint(
            center,
            basis.u,
            basis.v,
            axisDirection,
            radius * Math.cos(angle),
            radius * Math.sin(angle),
            0,
          ),
        );
      }
      return {
        circle,
        axisEnds: [
          framePoint(
            center,
            basis.u,
            basis.v,
            axisDirection,
            0,
            0,
            AXIS_STANDOFF_MM,
          ),
          framePoint(center, basis.u, basis.v, axisDirection, 0, 0, -depth),
        ],
        tip: framePoint(center, basis.u, basis.v, axisDirection, 0, 0, -depth),
      };
    });
  }, [bounds, document, values]);

  const frameRef = useRef<SVGSVGElement | null>(null);
  const [frame, setFrame] = useState<{
    readonly width: number;
    readonly height: number;
  } | null>(null);
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const element = frameRef.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => {
      const { clientWidth, clientHeight } = element;
      if (clientWidth > 0 && clientHeight > 0) {
        setFrame({ width: clientWidth, height: clientHeight });
      }
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);
  const width = frame?.width ?? VIEWPORT_CSS_WIDTH;
  const height = frame?.height ?? VIEWPORT_CSS_HEIGHT;
  if (glyphs.length === 0) {
    return (
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
        data-hole-preview-ghost="empty"
        ref={frameRef}
        viewBox={`0 0 ${String(width)} ${String(height)}`}
      />
    );
  }
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      data-hole-preview-ghost="glyphs"
      ref={frameRef}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
    >
      {glyphs.map((glyph, index) => (
        <HoleGlyphSvg
          glyph={glyph}
          height={height}
          key={index}
          projection={projection}
          width={width}
        />
      ))}
    </svg>
  );
}

/** One position's ghost: the entry circle, the dashed axis, the tip point. */
function HoleGlyphSvg({
  glyph,
  projection,
  width,
  height,
}: {
  readonly glyph: HoleGlyph;
  readonly projection: RenderProjection;
  readonly width: number;
  readonly height: number;
}): ReactElement | null {
  const circle = glyph.circle
    .map((point) => project(point, projection, width, height))
    .map((point) =>
      point === null ? null : `${String(point[0])},${String(point[1])}`,
    );
  if (circle.some((point) => point === null)) return null;
  const axisA = project(glyph.axisEnds[0], projection, width, height);
  const axisB = project(glyph.axisEnds[1], projection, width, height);
  const tip = project(glyph.tip, projection, width, height);
  if (axisA === null || axisB === null || tip === null) return null;
  return (
    <g data-hole-preview-position="">
      <polyline
        points={circle.join(" ")}
        className="fill-none stroke-signal"
        strokeWidth={1.25}
        strokeDasharray="5 3"
      />
      <line
        x1={axisA[0]}
        y1={axisA[1]}
        x2={axisB[0]}
        y2={axisB[1]}
        className="stroke-signal"
        strokeWidth={1}
        strokeDasharray="2 3"
      />
      <circle cx={tip[0]} cy={tip[1]} r={2} className="fill-signal" />
    </g>
  );
}
