/**
 * The viewport's curve overlay (Phase 47): the document's 3D curve
 * records drawn as SVG polylines over the canvas and projected through
 * the SAME deterministic spec camera the face anchors and the datum
 * overlay use (`renderCameraScreenPoint`) — the sanctioned display route
 * for non-body records (the datum overlay's Phase 39 precedent: the
 * projection wire format is byte-pinned and carries only triangle soups,
 * so record geometry rides the camera-projected SVG layer).
 *
 * The geometry is the SAME shared evaluation the kernel's `wire` op
 * answers (`curveSceneSegments` — one source of truth, no second math),
 * so what the overlay draws is exactly what sweeps and measurements
 * consume. Markers are a pure function of (document, projection):
 * identical state draws identical pixels, and a curve whose evaluation
 * refuses is NOT drawn (no honest geometry, no polyline).
 *
 * Machine surface: every curve carries one `<g>` with
 * `data-curve-overlay-marker` and the record's id plus a per-segment
 * count, so the e2e battery can assert presence and identity without
 * reading pixels.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import type { CadDocument, RenderProjection } from "@slopcad/cad-core";
import { renderCameraScreenPoint } from "@slopcad/cad-r3f";

import { curveSceneSegments } from "./curves";

/** One resolved curve's overlay geometry, in world millimetres. */
interface CurveMarker {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly segments: readonly {
    readonly start: readonly [number, number, number];
    readonly end: readonly [number, number, number];
  }[];
}

/** Extracts the overlay markers of a document's curve records. */
function markersOf(document: CadDocument): readonly CurveMarker[] {
  const markers: CurveMarker[] = [];
  for (const curve of document.curves) {
    const segments = curveSceneSegments(curve.curve);
    // An evaluation that refuses (or a degenerate walk) draws nothing —
    // the empty-segment curve gets no marker, exactly like a datum whose
    // session resolution fails.
    if (segments.length === 0) continue;
    markers.push({
      id: curve.id,
      name: curve.name,
      kind: curve.curve.kind,
      segments,
    });
  }
  return markers;
}

/** The workbench viewport's fixed CSS size (the fixture camera spec's frame). */
const VIEWPORT_CSS_WIDTH = 800;
const VIEWPORT_CSS_HEIGHT = 520;

/** Projects a world point; `null` when the camera mapping refuses it. */
function project(
  point: readonly [number, number, number],
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

/** The overlay's SVG body for one curve marker (the station polyline). */
function CurveSvg({
  marker,
  projection,
  width,
  height,
}: {
  readonly marker: CurveMarker;
  readonly projection: RenderProjection;
  readonly width: number;
  readonly height: number;
}): ReactElement | null {
  const projected: (readonly [number, number] | null)[] = marker.segments.map(
    (segment) => project(segment.start, projection, width, height),
  );
  const last = marker.segments[marker.segments.length - 1];
  if (last !== undefined) {
    projected.push(project(last.end, projection, width, height));
  }
  if (projected.length < 2 || projected.some((point) => point === null)) {
    return null;
  }
  const path = projected
    .map(
      (point) =>
        `${String((point as readonly [number, number])[0])},${String(
          (point as readonly [number, number])[1],
        )}`,
    )
    .join(" ");
  const first = projected[0] as readonly [number, number];
  return (
    <g data-curve-overlay-marker={marker.id}>
      {/* The drafting convention for a construction curve: a fine dashed
          polyline, distinct from the datum axis's phantom line. */}
      <polyline
        fill="none"
        points={path}
        strokeDasharray="8 3"
        strokeWidth={1.5}
        className="stroke-signal"
      />
      <circle className="fill-signal" cx={first[0]} cy={first[1]} r={2.5} />
      <text
        className="fill-signal text-[10px]"
        x={first[0] + 7}
        y={first[1] + 3}
      >
        {`${marker.name} (${marker.kind})`}
      </text>
    </g>
  );
}

/**
 * The curve overlay: an SVG layer sized to its own live rendered box —
 * the viewport's canvas frame (the datum overlay's measurement and
 * fallback discipline verbatim: the live size the scene camera renders
 * with, the fixture's authored 800×520 frame before the first
 * measurement or where ResizeObserver is unavailable).
 */
export function CadCurveOverlay({
  document,
  projection,
}: {
  readonly document: CadDocument;
  readonly projection: RenderProjection;
}): ReactElement {
  const markers = useMemo(() => markersOf(document), [document]);
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
  if (markers.length === 0) {
    return (
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 h-full w-full"
        data-curve-overlay="empty"
        ref={frameRef}
        viewBox={`0 0 ${String(width)} ${String(height)}`}
      />
    );
  }
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      data-curve-overlay="curves"
      data-curve-count={String(markers.length)}
      ref={frameRef}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
    >
      {markers.map((marker) => (
        <CurveSvg
          height={height}
          key={marker.id}
          marker={marker}
          projection={projection}
          width={width}
        />
      ))}
    </svg>
  );
}
