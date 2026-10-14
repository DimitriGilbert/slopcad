/**
 * The field overlay family's React mounts (ROADMAP-SIM Phase 62b): one
 * component per overlay kind — the colormap slice plane, the
 * iso-contours, the seeded streamlines, the vector glyphs — each
 * composing the same three disciplines the deterministic scene owns:
 *
 * - **Demand rendering (law S6)**: an overlay owns no frame loop. It
 *   builds its geometry from its props (a pure builder, memoized) and
 *   requests exactly one `invalidate()` per geometry change — the same
 *   trigger `SceneModel` issues for projection updates. No `useFrame`,
 *   no rAF, no clock reads: nothing frame-derived anywhere.
 * - **Geometry as data, disposed with its memo**: geometries are built
 *   only when the decoded field or the overlay parameters change, and
 *   the replaced/unmounted geometry is disposed through the effect
 *   cleanup (the face-highlight lifecycle), so a streaming field update
 *   sequence never strands GPU buffers.
 * - **Never in the pick path**: every overlay mounts with raycasting
 *   disabled — a field visualization lying inside the domain must never
 *   intercept a pick aimed at the model (the highlight-mesh rule).
 *
 * All overlays consume {@link DecodedFieldGrid}s — the S4-projected,
 * document-millimetre, explicitly-unit-labelled decode of a
 * `SimResultFieldBlock` (`field-grid.ts`) — and paint through the
 * colormap data table (`field-colormaps.ts`, the lighting-rig
 * precedent: pure data, selectable by name). Overlay props should be
 * identity-stable per data change (the palette-prop expectation): hosts
 * keep decoded fields and range windows in state, not inline literals.
 */

import { useThree } from "@react-three/fiber";
import * as THREE from "three";
import type { ReactElement } from "react";
import { useEffect, useMemo } from "react";
import type { DecodedFieldGrid, DecodedVectorField } from "./field-grid";

import { buildFieldSliceGeometry, type FieldSliceAxis } from "./field-slice";
import {
  CAD_FIELD_COLORMAP_VIRIDIS,
  type FieldColormap,
  type FieldColorScale,
} from "./field-colormaps";
import { buildFieldContourGeometry } from "./field-contours";
import { buildFieldStreamlinesGeometry } from "./field-streamlines";
import { buildFieldGlyphGeometry } from "./field-glyphs";

/**
 * Overlays never intersect rays (the highlight-mesh rule): a field
 * visualization inside the domain must not intercept picks aimed at the
 * model. Stable identity, no churn.
 */
const NO_RAYCAST = () => null;

/** The demand-render and disposal half every overlay shares. */
function useOverlayRenderCycle(geometry: THREE.BufferGeometry): void {
  const invalidate = useThree((state) => state.invalidate);
  // Law S6: one invalidate per APPLIED geometry — the request-render the
  // demand frame needs to draw the new overlay state, never an ambient loop.
  useEffect(() => {
    invalidate();
  }, [invalidate, geometry]);
  // Disposal: the replaced geometry (the memo rebuilt) and the unmounted
  // one both pass through here, exactly once each.
  useEffect(() => {
    return () => {
      geometry.dispose();
    };
  }, [geometry]);
}

/** Props every scalar overlay shares: the field, its color mapping. */
export interface FieldOverlayColorProps {
  /** The colormap to paint through; default viridis (the data table's default). */
  readonly colormap?: FieldColormap;
  /**
   * The value window mapped onto the colormap's [0, 1]; default the
   * field's own [min, max]. Identity-stable per legend (the palette
   * expectation) so ordinary renders never rebuild geometry.
   */
  readonly valueRange?: readonly [number, number];
}

/** Compiles the color props into the builders' scale (a stable memo input). */
function useFieldColorScale({
  colormap = CAD_FIELD_COLORMAP_VIRIDIS,
  valueRange,
}: FieldOverlayColorProps): FieldColorScale {
  return useMemo(() => ({ colormap, valueRange }), [colormap, valueRange]);
}

/** The colormap slice plane: a scalar field painted on an axis-aligned plane. */
export function FieldSlicePlane({
  axis,
  colormap,
  field,
  positionMm,
  valueRange,
}: FieldOverlayColorProps & {
  /** The decoded scalar field. */
  readonly field: DecodedFieldGrid;
  /** The plane's normal axis. */
  readonly axis: FieldSliceAxis;
  /** The plane's document-space position, mm. */
  readonly positionMm: number;
}): ReactElement {
  const scale = useFieldColorScale({ colormap, valueRange });
  const geometry = useMemo(
    () => buildFieldSliceGeometry(field, { axis, positionMm }, scale),
    [axis, field, positionMm, scale],
  );
  useOverlayRenderCycle(geometry);
  return (
    <mesh geometry={geometry} raycast={NO_RAYCAST}>
      {/* Unlit by design: the colors ARE the data, so no light rig
          participates and no shading can misreport a value. */}
      <meshBasicMaterial side={THREE.DoubleSide} vertexColors />
    </mesh>
  );
}

/** The iso-contours: threshold lines on an axis-aligned plane through a field. */
export function FieldIsoContours({
  axis,
  colormap,
  field,
  positionMm,
  thresholds,
  valueRange,
}: FieldOverlayColorProps & {
  /** The decoded scalar field. */
  readonly field: DecodedFieldGrid;
  /** The contour plane's normal axis. */
  readonly axis: FieldSliceAxis;
  /** The contour plane's document-space position, mm. */
  readonly positionMm: number;
  /** The iso-values to draw, in order. */
  readonly thresholds: readonly number[];
}): ReactElement {
  const scale = useFieldColorScale({ colormap, valueRange });
  const geometry = useMemo(
    () =>
      buildFieldContourGeometry(
        field,
        { slice: { axis, positionMm }, thresholds },
        scale,
      ),
    [axis, field, positionMm, scale, thresholds],
  );
  useOverlayRenderCycle(geometry);
  return (
    <lineSegments geometry={geometry} raycast={NO_RAYCAST}>
      {/* The feature-edge material discipline: lines depth-test against
          opaque geometry but never write depth, so an overlay never
          occludes anything drawn after it. Honest limitation: polygon
          offset is a filled-triangle mechanism in WebGL and does not
          apply to line primitives, so a contour lying exactly on a slice
          plane can still z-fight it. */}
      <lineBasicMaterial depthTest depthWrite={false} vertexColors />
    </lineSegments>
  );
}

/** The seeded streamlines: integral curves of a vector field from seed points. */
export function FieldStreamlines({
  colormap,
  field,
  seeds,
  stepCount,
  stepMm,
  valueRange,
}: FieldOverlayColorProps & {
  /** The decoded vector field. */
  readonly field: DecodedVectorField;
  /** The seed points, document millimetres. */
  readonly seeds: readonly (readonly [number, number, number])[];
  /** The fixed integration step, document mm (> 0). */
  readonly stepMm: number;
  /** The maximum number of steps per curve (≥ 0). */
  readonly stepCount: number;
}): ReactElement {
  const scale = useFieldColorScale({ colormap, valueRange });
  const geometry = useMemo(
    () =>
      buildFieldStreamlinesGeometry(field, seeds, { stepCount, stepMm }, scale),
    [field, scale, seeds, stepCount, stepMm],
  );
  useOverlayRenderCycle(geometry);
  return (
    <lineSegments geometry={geometry} raycast={NO_RAYCAST}>
      <lineBasicMaterial depthTest depthWrite={false} vertexColors />
    </lineSegments>
  );
}

/** The vector glyphs: needles subsampled from a vector field. */
export function FieldVectorGlyphs({
  colormap,
  field,
  scaleMm,
  stride,
  valueRange,
}: FieldOverlayColorProps & {
  /** The decoded vector field. */
  readonly field: DecodedVectorField;
  /** Keep every `stride`-th node per axis (a positive integer). */
  readonly stride: number;
  /** The needle length at the field's maximum magnitude, mm (> 0). */
  readonly scaleMm: number;
}): ReactElement {
  const scale = useFieldColorScale({ colormap, valueRange });
  const geometry = useMemo(
    () => buildFieldGlyphGeometry(field, { scaleMm, stride }, scale),
    [field, scale, scaleMm, stride],
  );
  useOverlayRenderCycle(geometry);
  return (
    <lineSegments geometry={geometry} raycast={NO_RAYCAST}>
      <lineBasicMaterial depthTest depthWrite={false} vertexColors />
    </lineSegments>
  );
}
