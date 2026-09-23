/**
 * The drawing workbench's geometry derivation (Phase 55): resolves every
 * view on a sheet to its projected geometry through the cad-core derived
 * view functions — base overlays, fold-line projections, auxiliary views,
 * sections (with hatching), details (circle crops), and broken-out bands —
 * recursing through projection parents with cycle guarding.
 *
 * The derivation is honest about its inputs: a view whose parent chain
 * cannot be resolved yields `undefined` — the canvas renders the empty
 * frame, never a fabricated picture. The fidelity class stays
 * `edges-overlay` throughout: the demo mesh path has no hidden-line
 * removal, and the canvas says so.
 */

import {
  type DrawingSheet,
  type DrawingView,
  type DrawingViewGeometry,
  auxiliaryViewBasis,
  brokenOutOverlayProjection,
  detailCropGeometry,
  edgesOverlayProjection,
  edgesOverlayProjectionForKind,
  projectedViewBasis,
  sectionOverlayProjection,
  viewBasis,
  viewBasisForKind,
} from "@slopcad/cad-core";

import { type DemoMesh } from "./drawing-demo-body";

/** A view direction: the eye vector and the sheet-up hint, world axes. */
interface EyeUp {
  readonly eye: readonly [number, number, number];
  readonly up: readonly [number, number, number];
}

/** The demo section plane: cuts the boss at mid-height, keeping the top. */
export const DEMO_SECTION_PLANE = {
  origin: [0, 0, 12] as const,
  normal: [0, 0, 1] as const,
  keepSide: 1 as const,
};

/** The demo inclined edge for the auxiliary view (the boss's top front edge). */
export const DEMO_AUX_EDGE = {
  edgeFrom: [20, 10, 25] as const,
  edgeTo: [40, 10, 25] as const,
};

/** The demo broken-out band: the boss footprint's u-range in the top view. */
export const DEMO_BREAKOUT_BAND = { minU: 10, maxU: 50 };

const DEMO_HATCH_SPACING_MM = 3;

const negLook = (
  look: readonly [number, number, number],
): readonly [number, number, number] => [-look[0], -look[1], -look[2]];

function kindEyeUp(view: DrawingView): EyeUp {
  const basis = viewBasisForKind(view.kind);
  return { eye: negLook(basis.look), up: basis.up };
}

/**
 * Resolves a view's direction through its projection chain (cycle-guarded
 * by `seen`); `null` when the chain is unresolvable.
 */
function resolveEyeUp(
  view: DrawingView,
  sheet: DrawingSheet,
  seen: ReadonlySet<string>,
): EyeUp | null {
  const projection = view.projection;
  if (projection === undefined) return kindEyeUp(view);
  if (
    projection.method === "section" ||
    projection.method === "broken-out" ||
    projection.method === "detail"
  ) {
    return kindEyeUp(view);
  }
  if (seen.has(view.id)) return null;
  const parent = sheet.views.find((v) => v.id === projection.parentViewId);
  if (parent === undefined) return null;
  const nextSeen = new Set([...seen, view.id]);
  const parentEyeUp = resolveEyeUp(parent, sheet, nextSeen);
  if (parentEyeUp === null) return null;
  const parentBasis = viewBasis(parentEyeUp.eye, parentEyeUp.up);
  if (projection.method === "projected") {
    const basis = projectedViewBasis(parentBasis, projection.direction);
    return { eye: negLook(basis.look), up: basis.up };
  }
  const aux = auxiliaryViewBasis(
    parentBasis,
    projection.edgeFrom,
    projection.edgeTo,
  );
  return aux === null ? null : { eye: negLook(aux.look), up: aux.up };
}

function deriveGeometry(
  view: DrawingView,
  sheet: DrawingSheet,
  mesh: DemoMesh,
  seen: ReadonlySet<string>,
): DrawingViewGeometry | undefined {
  const projection = view.projection;
  if (projection === undefined) {
    return edgesOverlayProjectionForKind(mesh, view.kind);
  }
  if (projection.method === "section") {
    const eyeUp = kindEyeUp(view);
    return sectionOverlayProjection(
      mesh,
      {
        origin: projection.planeOrigin,
        normal: projection.planeNormal,
        keepSide: projection.keepSide,
      },
      eyeUp.eye,
      eyeUp.up,
      projection.hatchSpacingMm,
      projection.hatchAngleRad,
    );
  }
  if (projection.method === "broken-out") {
    const eyeUp = kindEyeUp(view);
    return brokenOutOverlayProjection(
      mesh,
      {
        origin: projection.planeOrigin,
        normal: projection.planeNormal,
        keepSide: projection.keepSide,
      },
      projection.bandMinU,
      projection.bandMaxU,
      eyeUp.eye,
      eyeUp.up,
      projection.hatchSpacingMm,
    );
  }
  const parent = sheet.views.find((v) => v.id === projection.parentViewId);
  if (parent === undefined) return undefined;
  if (projection.method === "detail") {
    if (seen.has(view.id)) return undefined;
    const parentGeometry = deriveGeometry(
      parent,
      sheet,
      mesh,
      new Set([...seen, view.id]),
    );
    if (parentGeometry === undefined) return undefined;
    return detailCropGeometry(
      parentGeometry,
      projection.centreU,
      projection.centreV,
      projection.radiusMm,
    );
  }
  const eyeUp = resolveEyeUp(view, sheet, seen);
  if (eyeUp === null) return undefined;
  return edgesOverlayProjection(mesh, eyeUp.eye, eyeUp.up);
}

/**
 * Resolves the geometry of every view on the sheet (the canvas/export
 * input). Views that fail to resolve are simply absent from the map.
 */
export function deriveSheetGeometry(
  sheet: DrawingSheet,
  mesh: DemoMesh,
): Map<string, DrawingViewGeometry> {
  const map = new Map<string, DrawingViewGeometry>();
  for (const view of sheet.views) {
    const geometry = deriveGeometry(view, sheet, mesh, new Set());
    if (geometry !== undefined) map.set(view.id, geometry);
  }
  return map;
}

export { DEMO_HATCH_SPACING_MM };
