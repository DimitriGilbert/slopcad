/**
 * `CadModel` — the Phase 11.2 R3F model renderer, extended in Phase 12 with
 * picking and selection highlight. Consumes the public {@link
 * RenderProjection} from `@slopcad/cad-core` as data and renders one keyed
 * `<mesh>` per render object into whatever R3F canvas it is mounted in. It
 * never imports kernel or worker modules (the import allowlist is enforced
 * by a structural test), adds no camera, no lights, and no framing of its
 * own — the deterministic scene around it is Phase 11.3 — and holds no
 * randomness or clock-dependent state, so the same projection and the same
 * selection always produce the same scene graph.
 *
 * ## Update semantics
 *
 * Geometry creation, same-id in-place buffer updates, and disposal are
 * delegated to {@link useRenderGeometry}. Meshes are keyed by the stable
 * render object id, so R3F instance identity follows body identity: an
 * updated body swaps buffer contents in place, a removed body unmounts,
 * and unrelated bodies are left untouched.
 *
 * ## Material and display modes (Phase 45)
 *
 * One documented default — `MeshStandardMaterial` with the spike's fixed
 * parameters (color `#8aadf4`, metalness 0.15, roughness 0.55) — applied
 * per mesh. The `material` prop overrides individual parameters; anything
 * beyond these three parameters needs a renderer decision, not a prop
 * escape hatch, so the override surface is deliberately narrow. The Phase 12
 * exception is body-level selection, which applies the documented highlight
 * color/emissive change (see `selection-highlight.ts`). The Phase 45
 * `displayMode` prop cycles the pass states (`display-mode.ts`): the
 * surface meshes stay MOUNTED in every mode (picking never changes), and
 * only the write masks plus the feature-edge overlay change — the honest
 * consequence being that the body-level selection highlight, a surface
 * color effect, does not read in the two surface-invisible modes
 * (wireframe, hidden-line), while the face-level highlight mesh (its own
 * always-writing material) still does.
 *
 * ## Picking and highlight (Phase 12)
 *
 * With `onPick`/`onHover` attached, each mesh resolves R3F raycast hits
 * through the synthetic face grouping (`picking.ts`) and reports a domain
 * `CadPick` — a stable body reference or a regeneration-tagged synthetic
 * face reference, NEVER a raw triangle index. Hover is deduplicated by
 * reference key so continuous pointer movement reports only changes. The
 * `selection` prop (references validated by the domain model) drives the
 * documented highlight: body-level selection changes the base material;
 * face-level selection mounts a second-pass highlight mesh containing only
 * the selected faces (`selection-highlight.ts`); highlight meshes disable
 * raycasting so an overlay can never intercept a pick aimed at the base
 * surface. Synthetic references tagged for any `regeneration` other than
 * the one passed here are stale and are never highlighted.
 *
 * Geometry data materializes in the commit after mount (standard effect
 * timing); demand-framed scenes should invalidate on the {@link onSync}
 * callback, which reports each changed snapshot exactly once.
 */

import type { ThreeElements, ThreeEvent } from "@react-three/fiber";
import type * as THREE from "three";
import type { ReactElement } from "react";
import type {
  RenderObject,
  RenderObjectId,
  RenderProjection,
  SelectionReference,
  SyntheticFaceGrouping,
} from "@slopcad/cad-core";
import type { RenderGeometrySnapshot } from "./geometry";
import type { CadPick, CadPickCategory } from "./picking";
import { useEffect, useMemo, useRef } from "react";
import {
  groupSyntheticFaces,
  renderObjectIdBodyId,
  selectionReferenceKey,
} from "@slopcad/cad-core";

import { resolvePickReference } from "./picking";
import {
  buildFaceHighlightGeometry,
  CAD_BODY_SELECTION_EMISSIVE_INTENSITY,
  CAD_FACE_HIGHLIGHT_POLYGON_OFFSET,
  CAD_SELECTION_HIGHLIGHT_COLOR,
  isBodySelected,
  selectedFaceIndices,
} from "./selection-highlight";
import {
  buildFeatureEdgeGeometry,
  CAD_MODEL_EDGE_COLOR,
  displayModePasses,
  type CadDisplayMode,
} from "./display-mode";
import { useRenderGeometry } from "./use-render-geometry";

/** The overridable subset of the default material. */
export type CadModelMaterialProps = Pick<
  ThreeElements["meshStandardMaterial"],
  "color" | "metalness" | "roughness"
>;

/**
 * The documented default material: a light machinist steel that reads
 * clearly against the studio-graphite scene background (the Phase 1.6
 * spike's deterministic parameter set, recolored with the scene).
 */
const DEFAULT_MATERIAL: CadModelMaterialProps = {
  color: "#aabdd6",
  metalness: 0.15,
  roughness: 0.55,
};

/** Shared empty selection so the inert path never allocates. */
const NO_SELECTION: readonly SelectionReference[] = [];

/**
 * Generation-mismatch guard for the highlight memo: `renderData`/`grouping`
 * memoize on the NEW projection while `geometries` lags one effect flush, so
 * one render can cross the new grouping's selected faces with the previous
 * generation's base geometry. A highlight may only be built when the base's
 * index buffer covers every triangle those faces reference (and every
 * selected face is inside the grouping); otherwise the overlay is skipped
 * for this render and rebuilt from the next flush's matching base — never
 * thrown together from mismatched generations inside `useMemo`.
 */
function baseCoversSelectedFaces(
  base: THREE.BufferGeometry,
  grouping: SyntheticFaceGrouping,
  faceIndices: readonly number[],
): boolean {
  const indexCount = base.getIndex()?.count ?? 0;
  for (const faceIndex of faceIndices) {
    const face = grouping.faces[faceIndex];
    if (face === undefined) {
      return false;
    }
    for (const triangle of face.triangleIndices) {
      if (triangle * 3 + 2 >= indexCount) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Highlight meshes never intersect rays: an overlay lying exactly on the
 * base surface must not intercept a pick aimed at it (and its index space
 * would resolve to the wrong triangles). Stable identity, no churn.
 */
const NO_RAYCAST = () => null;

/** Per-object render data derived once per projection. */
interface ObjectRenderData {
  readonly object: RenderObject;
  readonly grouping: SyntheticFaceGrouping;
}

export interface CadModelProps {
  /** The validated render projection (see `@slopcad/cad-core`). */
  readonly projection: RenderProjection;
  /** Per-parameter overrides applied over {@link DEFAULT_MATERIAL}. */
  readonly material?: CadModelMaterialProps;
  /**
   * The display mode (Phase 45): how surfaces and feature edges render.
   * Default `"shaded"` — the established deterministic bytes; every other
   * mode is a documented pass-state change (see `display-mode.ts`), never
   * a different scene graph: the surface meshes stay mounted (picking
   * works in every mode) and only their write masks and the edge overlay
   * change.
   */
  readonly displayMode?: CadDisplayMode;
  /** Reports each changed geometry snapshot exactly once, post-commit. */
  readonly onSync?: (geometries: RenderGeometrySnapshot) => void;
  /**
   * The current regeneration identity, stamped into synthetic face
   * references this component produces and matched against the selection's
   * synthetic references when highlighting. Defaults to 0.
   */
  readonly regeneration?: number;
  /**
   * The selected references (domain state, validated by the selection
   * model). Drives the highlight; inert when absent.
   */
  readonly selection?: readonly SelectionReference[];
  /** Which domain reference a click resolves to. Defaults to `"face"`. */
  readonly pickCategory?: CadPickCategory;
  /** Reports a resolved pick (clicks) as a domain reference payload. */
  readonly onPick?: (pick: CadPick) => void;
  /** Reports a resolved pick for pointer-down events (the Phase 13 drag anchor). */
  readonly onPickDown?: (pick: CadPick) => void;
  /** Reports a resolved pick for pointer-up events (the Phase 13 gesture commit). */
  readonly onPickUp?: (pick: CadPick) => void;
  /**
   * Reports hover changes (pointer entering a new reference, or leaving
   * the model) — deduplicated, `null` when the pointer leaves.
   */
  readonly onHover?: (pick: CadPick | null) => void;
  /**
   * Section clipping planes (Phase 46): applied to every body material
   * when non-empty (three.js local clipping). Absent or empty = no
   * clipping, the unchanged boot raster.
   */
  readonly clippingPlanes?: THREE.Plane[];
}

export function CadModel({
  displayMode = "shaded",
  material,
  onHover,
  onPick,
  onPickDown,
  onPickUp,
  onSync,
  pickCategory,
  projection,
  regeneration,
  selection,
  clippingPlanes,
}: CadModelProps): ReactElement {
  const geometries = useRenderGeometry(projection, onSync);
  const materialProps: CadModelMaterialProps = {
    ...DEFAULT_MATERIAL,
    ...material,
    // Section clipping (Phase 46): applied ONLY when planes exist, so an
    // unclipped scene constructs byte-identical materials (the boot raster
    // law) — three.js treats an absent `clippingPlanes` as no clipping.
    ...(clippingPlanes !== undefined && clippingPlanes.length > 0
      ? { clippingPlanes }
      : {}),
  };
  const selectionList = selection ?? NO_SELECTION;
  const regenerationValue = regeneration ?? 0;
  const categoryValue: CadPickCategory = pickCategory ?? "face";
  const passes = displayModePasses(displayMode);
  const interactive =
    onPick !== undefined ||
    onPickDown !== undefined ||
    onPickUp !== undefined ||
    onHover !== undefined;

  const renderData = useMemo(() => {
    const map = new Map<RenderObjectId, ObjectRenderData>();
    for (const object of projection.objects) {
      map.set(object.id, { object, grouping: groupSyntheticFaces(object) });
    }
    return map;
  }, [projection]);

  // Second-pass highlight geometries, rebuilt only when the drawn geometry
  // set, the selection, or the regeneration identity changes.
  const highlights = useMemo(() => {
    const map = new Map<RenderObjectId, THREE.BufferGeometry>();
    for (const [id, data] of renderData) {
      const faceIndices = selectedFaceIndices(
        selectionList,
        data.object.bodyId ?? renderObjectIdBodyId(data.object.id),
        regenerationValue,
      );
      if (faceIndices.length === 0) continue;
      const base = geometries.get(id);
      if (base === undefined) continue;
      if (!baseCoversSelectedFaces(base, data.grouping, faceIndices)) continue;
      map.set(id, buildFaceHighlightGeometry(base, data.grouping, faceIndices));
    }
    return map;
  }, [geometries, regenerationValue, renderData, selectionList]);

  useEffect(() => {
    return () => {
      for (const geometry of highlights.values()) {
        geometry.dispose();
      }
    };
  }, [highlights]);

  // Feature-edge geometries, one per object, rebuilt when the drawn
  // geometry set or the edge visibility changes (the same lifecycle as
  // the highlights: built only when the mode draws edges, disposed with
  // the memo).
  const edges = useMemo(() => {
    if (!passes.edges.visible)
      return new Map<RenderObjectId, THREE.BufferGeometry>();
    const map = new Map<RenderObjectId, THREE.BufferGeometry>();
    for (const [id, geometry] of geometries) {
      map.set(id, buildFeatureEdgeGeometry(geometry));
    }
    return map;
  }, [geometries, passes.edges.visible]);

  useEffect(() => {
    return () => {
      for (const geometry of edges.values()) {
        geometry.dispose();
      }
    };
  }, [edges]);

  // Latest-ref pattern: callers may pass inline closures without rebinding
  // the (already registered) R3F event handlers on every render.
  const onPickRef = useRef(onPick);
  const onPickDownRef = useRef(onPickDown);
  const onPickUpRef = useRef(onPickUp);
  const onHoverRef = useRef(onHover);
  useEffect(() => {
    onPickRef.current = onPick;
    onPickDownRef.current = onPickDown;
    onPickUpRef.current = onPickUp;
    onHoverRef.current = onHover;
  });

  const hoverKeyRef = useRef<string | null>(null);
  const reportHover = (pick: CadPick | null): void => {
    const key = pick === null ? null : selectionReferenceKey(pick.reference);
    if (hoverKeyRef.current === key) return;
    hoverKeyRef.current = key;
    onHoverRef.current?.(pick);
  };

  const resolveHit = (
    data: ObjectRenderData,
    event: ThreeEvent<MouseEvent> | ThreeEvent<PointerEvent>,
  ): CadPick | null => {
    const triangleIndex = event.faceIndex;
    if (triangleIndex === undefined || triangleIndex === null) return null;
    const result = resolvePickReference({
      object: data.object,
      grouping: data.grouping,
      triangleIndex,
      regeneration: regenerationValue,
      category: categoryValue,
    });
    if (!result.ok) return null;
    return {
      reference: result.value,
      renderObjectId: data.object.id,
      featureId: data.object.featureId,
      worldPoint: [event.point.x, event.point.y, event.point.z],
    };
  };

  return (
    <>
      {[...geometries].map(([id, geometry]) => {
        const data = renderData.get(id);
        if (data === undefined) return null;
        // The body id is total over the projection contract (picking.ts
        // resolves body picks the same way): renderer-owned objects may omit
        // `bodyId`, and their body-level selections must still highlight.
        const selected = isBodySelected(
          selectionList,
          data.object.bodyId ?? renderObjectIdBodyId(data.object.id),
          data.object.featureId,
        );
        const handlers = interactive
          ? {
              onClick: (event: ThreeEvent<MouseEvent>) => {
                event.stopPropagation();
                const pick = resolveHit(data, event);
                if (pick !== null) onPickRef.current?.(pick);
              },
              onPointerDown: (event: ThreeEvent<PointerEvent>) => {
                event.stopPropagation();
                const pick = resolveHit(data, event);
                if (pick !== null) onPickDownRef.current?.(pick);
              },
              onPointerUp: (event: ThreeEvent<PointerEvent>) => {
                event.stopPropagation();
                const pick = resolveHit(data, event);
                if (pick !== null) onPickUpRef.current?.(pick);
              },
              onPointerMove: (event: ThreeEvent<PointerEvent>) => {
                event.stopPropagation();
                reportHover(resolveHit(data, event));
              },
              onPointerOut: () => {
                reportHover(null);
              },
            }
          : {};
        return (
          <mesh key={id} geometry={geometry} {...handlers}>
            <meshStandardMaterial
              colorWrite={passes.surfaces.colorWrite}
              depthWrite={passes.surfaces.depthWrite}
              {...materialProps}
              {...(selected
                ? {
                    color: CAD_SELECTION_HIGHLIGHT_COLOR,
                    emissive: CAD_SELECTION_HIGHLIGHT_COLOR,
                    emissiveIntensity: CAD_BODY_SELECTION_EMISSIVE_INTENSITY,
                  }
                : {})}
            />
          </mesh>
        );
      })}
      {[...edges].map(([id, geometry]) => (
        <lineSegments
          key={`${id}-feature-edges`}
          geometry={geometry}
          raycast={NO_RAYCAST}
          renderOrder={1}
        >
          {/* Edges ride the depth buffer (occluded edges drop out under
              hidden-line) but never write it: two coincident edge sets
              must not fight each other, and the small negative polygon
              offset lifts feature edges off their own surfaces so
              shaded-edges reads crisp at AA-off rasterization. */}
          <lineBasicMaterial
            color={CAD_MODEL_EDGE_COLOR}
            depthTest
            depthWrite={false}
            polygonOffset
            polygonOffsetFactor={-1}
            polygonOffsetUnits={-1}
          />
        </lineSegments>
      ))}
      {[...highlights].map(([id, geometry]) => (
        <mesh
          key={`${id}-face-highlight`}
          geometry={geometry}
          renderOrder={1}
          raycast={NO_RAYCAST}
        >
          <meshBasicMaterial
            color={CAD_SELECTION_HIGHLIGHT_COLOR}
            depthWrite={false}
            polygonOffset
            polygonOffsetFactor={CAD_FACE_HIGHLIGHT_POLYGON_OFFSET}
            polygonOffsetUnits={CAD_FACE_HIGHLIGHT_POLYGON_OFFSET}
          />
        </mesh>
      ))}
    </>
  );
}
