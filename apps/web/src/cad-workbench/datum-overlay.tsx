/**
 * The viewport's datum overlay (Phase 39): the datum entities' visual
 * language, drawn as SVG over the canvas and projected through the SAME
 * deterministic spec camera the face anchors use
 * (`renderCameraScreenPoint`) — plane rectangles, axis lines, origin
 * points, and coordinate-system triads, each labeled with the datum's
 * name.
 *
 * The overlay is the workbench's datum display because the deterministic
 * render pipeline is projection-format-locked (the byte-pinned baselines;
 * the projection wire format would need a sanctioned bump to carry datum
 * geometry as scene content). What it guarantees: markers are a pure
 * function of (document, projection) — identical state draws identical
 * glyphs at identical pixels — and a datum whose session resolution fails
 * is NOT drawn (a datum with no honest geometry gets no marker, and the
 * machine surface carries its failure instead).
 *
 * Machine surface: every marker carries `data-datum-overlay-marker` and the
 * datum's id, so the e2e battery can assert presence and identity without
 * reading pixels.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  parseDatumPayload,
  resolveDatumPayload,
  type CadDocument,
  type RenderProjection,
} from "@slopcad/cad-core";
import { renderCameraScreenPoint } from "@slopcad/cad-r3f";

import { sessionDatumResolverOf } from "./datum";
import { sessionComputedFacesOf } from "./extrude";

/** Glyph sizing, in millimetres (projected through the spec camera). */
const PLANE_HALF_SIZE_MM = 12;
const AXIS_HALF_LENGTH_MM = 30;
const CSYS_ARM_MM = 15;

/** One resolved datum's overlay geometry, in world millimetres. */
interface DatumMarker {
  readonly id: string;
  readonly name: string;
  readonly kind: "plane" | "axis" | "point" | "cSys";
  readonly origin: readonly [number, number, number];
  /** Plane / cSys: the frame's x axis and y (normal × x). */
  readonly xAxis?: readonly [number, number, number];
  readonly yAxis?: readonly [number, number, number];
  /** Axis: the unit direction. */
  readonly direction?: readonly [number, number, number];
}

/**
 * Extracts the overlay markers of a document's datums (resolved ones only)
 * against one projection: the computed-face source derived from it lets a
 * datum anchored on a COMPUTED body (a boolean cavity floor, a holed
 * face) resolve — the same planes the marker is drawn over.
 */
function markersOf(
  document: CadDocument,
  projection: RenderProjection,
): readonly DatumMarker[] {
  const resolver = sessionDatumResolverOf(
    document,
    sessionComputedFacesOf(document, projection) ?? undefined,
  );
  const markers: DatumMarker[] = [];
  for (const datum of document.datums) {
    const payload = parseDatumPayload(datum.datum);
    if (!payload.ok) continue;
    const resolved = resolveDatumPayload(payload.value, resolver);
    if (!resolved.ok) continue;
    if (resolved.value.datumType === "plane") {
      const plane = resolved.value.plane;
      const yAxis: readonly [number, number, number] = [
        plane.normal[1] * plane.xAxis[2] - plane.normal[2] * plane.xAxis[1],
        plane.normal[2] * plane.xAxis[0] - plane.normal[0] * plane.xAxis[2],
        plane.normal[0] * plane.xAxis[1] - plane.normal[1] * plane.xAxis[0],
      ];
      markers.push({
        id: datum.id,
        name: datum.name,
        kind: "plane",
        origin: plane.origin,
        xAxis: plane.xAxis,
        yAxis,
      });
    } else if (resolved.value.datumType === "axis") {
      markers.push({
        id: datum.id,
        name: datum.name,
        kind: "axis",
        origin: resolved.value.axis.origin,
        direction: resolved.value.axis.direction,
      });
    } else if (resolved.value.datumType === "point") {
      markers.push({
        id: datum.id,
        name: datum.name,
        kind: "point",
        origin: resolved.value.point.position,
      });
    } else {
      markers.push({
        id: datum.id,
        name: datum.name,
        kind: "cSys",
        origin: resolved.value.cSys.origin,
        xAxis: resolved.value.cSys.xAxis,
        yAxis: resolved.value.cSys.yAxis,
      });
    }
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

/** Adds two world vectors. */
function add(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): [number, number, number] {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** Scales a world vector. */
function scale(
  a: readonly [number, number, number],
  s: number,
): [number, number, number] {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** The overlay's SVG body for one datum marker. */
function MarkerSvg({
  marker,
  projection,
  width,
  height,
}: {
  readonly marker: DatumMarker;
  readonly projection: RenderProjection;
  readonly width: number;
  readonly height: number;
}): ReactElement | null {
  const origin = project(marker.origin, projection, width, height);
  if (origin === null) return null;
  const [ox, oy] = origin;
  if (marker.kind === "point") {
    return (
      <g data-datum-overlay-marker={marker.id}>
        <circle
          cx={ox}
          cy={oy}
          r={4}
          className="fill-none stroke-signal"
          strokeWidth={1.5}
        />
        <text x={ox + 7} y={oy + 3} className="fill-signal text-[10px]">
          {marker.name}
        </text>
      </g>
    );
  }
  if (marker.kind === "axis" && marker.direction !== undefined) {
    const a = project(
      add(marker.origin, scale(marker.direction, AXIS_HALF_LENGTH_MM)),
      projection,
      width,
      height,
    );
    const b = project(
      add(marker.origin, scale(marker.direction, -AXIS_HALF_LENGTH_MM)),
      projection,
      width,
      height,
    );
    if (a === null || b === null) return null;
    // The dash pattern is the drafting convention for a construction line.
    return (
      <g data-datum-overlay-marker={marker.id}>
        <line
          x1={a[0]}
          y1={a[1]}
          x2={b[0]}
          y2={b[1]}
          className="stroke-signal"
          strokeWidth={1.25}
          strokeDasharray="6 3 1.5 3"
        />
        <text x={ox + 7} y={oy + 3} className="fill-signal text-[10px]">
          {marker.name}
        </text>
      </g>
    );
  }
  if (
    (marker.kind === "plane" || marker.kind === "cSys") &&
    marker.xAxis !== undefined &&
    marker.yAxis !== undefined
  ) {
    const half = marker.kind === "plane" ? PLANE_HALF_SIZE_MM : CSYS_ARM_MM;
    const corners = [
      add(
        marker.origin,
        add(scale(marker.xAxis, half), scale(marker.yAxis, half)),
      ),
      add(
        marker.origin,
        add(scale(marker.xAxis, -half), scale(marker.yAxis, half)),
      ),
      add(
        marker.origin,
        add(scale(marker.xAxis, -half), scale(marker.yAxis, -half)),
      ),
      add(
        marker.origin,
        add(scale(marker.xAxis, half), scale(marker.yAxis, -half)),
      ),
    ];
    const points: readonly (readonly [number, number] | null)[] = corners.map(
      (corner) => project(corner, projection, width, height),
    );
    if (points.some((point) => point === null)) return null;
    const path = points
      .map(
        (point) =>
          `${(point as readonly [number, number])[0]},${(point as readonly [number, number])[1]}`,
      )
      .join(" ");
    return (
      <g data-datum-overlay-marker={marker.id}>
        <polygon
          points={path}
          className="fill-none stroke-signal"
          strokeWidth={1.25}
          strokeDasharray={marker.kind === "plane" ? "5 3" : undefined}
        />
        <circle cx={ox} cy={oy} r={2} className="fill-signal" />
        <text x={ox + 7} y={oy + 3} className="fill-signal text-[10px]">
          {marker.name}
        </text>
      </g>
    );
  }
  return null;
}

/**
 * The datum overlay: an SVG layer sized to its own live rendered box —
 * the viewport's canvas frame. The markers project through the SAME live
 * size the scene camera renders with (it consumes the canvas's aspect), so
 * they stay on the geometry at every window size; the `viewBox` mirrors
 * the measured box for a 1:1 pixel mapping. Before the first measurement
 * (and where ResizeObserver is unavailable) it falls back to the fixture's
 * authored 800×520 frame.
 */
export function CadDatumOverlay({
  document,
  projection,
}: {
  readonly document: CadDocument;
  readonly projection: RenderProjection;
}): ReactElement {
  const markers = useMemo(
    () => markersOf(document, projection),
    [document, projection],
  );
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
        data-datum-overlay="empty"
        ref={frameRef}
        viewBox={`0 0 ${String(width)} ${String(height)}`}
      />
    );
  }
  return (
    <svg
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 h-full w-full"
      data-datum-overlay="markers"
      ref={frameRef}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
    >
      {markers.map((marker) => (
        <MarkerSvg
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
