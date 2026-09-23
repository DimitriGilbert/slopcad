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
import * as THREE from "three";
import type { ReactElement } from "react";
import type {
  Appearance as RenderAppearance,
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

/**
 * The zebra mode's fixed stripe frequency (Phase 58): how many
 * normal-facing bands span the facing range. A constant, not a prop —
 * the stripes are a deterministic function of scene state, and the fixed
 * frequency is part of the mode's documented look.
 */
export const ZEBRA_STRIPE_COUNT = 12;

/**
 * The zebra shader patch (Phase 58): rewrites the standard material's
 * outgoing light just before the opaque pass — the band is a pure
 * function of the view-space surface normal against the view vector at
 * the fixed stripe frequency, so the same scene state always yields the
 * same stripes. Module-level and stable: the function identity is part of
 * three's program cache key, so a stable reference avoids recompiles.
 */
function zebraShaderPatch(
  shader: THREE.WebGLProgramParametersWithUniforms,
): void {
  shader.fragmentShader = shader.fragmentShader.replace(
    "#include <opaque_fragment>",
    [
      "float zebraFacing = abs(dot(normalize(normal), normalize(vViewPosition)));",
      `float zebraBand = step(0.5, fract(zebraFacing * ${String(
        ZEBRA_STRIPE_COUNT,
      )}.0));`,
      "outgoingLight = mix(vec3(0.03, 0.035, 0.045), vec3(0.88, 0.9, 0.94), zebraBand);",
      "#include <opaque_fragment>",
    ].join("\n"),
  );
}

/** Shared empty selection so the inert path never allocates. */
const NO_SELECTION: readonly SelectionReference[] = [];

/**
 * Deterministic procedural textures (Phase 59): the named patterns an
 * appearance record may reference, generated from code alone — fixed
 * dimensions, fixed texel values, nearest filtering — so a textured
 * appearance rasterizes byte-identically under the fixed-viewport/DPR
 * discipline. No image assets, no IO, no clock. Instances are cached and
 * shared per name (the data is immutable once built).
 */
const proceduralTextureCache = new Map<string, THREE.DataTexture>();

export function proceduralTexture(name: string): THREE.DataTexture {
  const cached = proceduralTextureCache.get(name);
  if (cached !== undefined) return cached;
  // The checker: an 8x8 black/white field — multiplied by the material
  // color it reads as the classic two-tone machinist checker.
  const size = 8;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const value = ((x + y) % 2 === 0 ? 255 : 0) as number;
      const offset = (y * size + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  proceduralTextureCache.set(name, texture);
  return texture;
}

/**
 * The stable "no clipping" value (Phase 46): the material host prop is
 * ALWAYS defined — `NO_CLIPPING_PLANES` when there is nothing to clip —
 * so it is never REMOVED between renders. R3F resets a removed host prop
 * by writing a literal `0` whenever the target class's constructor takes
 * parameters (`MeshStandardMaterial`'s does), which poisons
 * `material.clippingPlanes` with a Number and kills the mesh's draw;
 * a value swap between two arrays never touches that path. Empty is
 * byte-identical to absent for construction: three's local-clipping
 * contract treats `planes === null || planes.length === 0` as no
 * clipping, so the boot raster law holds.
 */
const NO_CLIPPING_PLANES: THREE.Plane[] = [];

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
   * clipping, the unchanged boot raster — the material host prop stays
   * DEFINED either way (an empty-but-present value, never a removed prop:
   * see `NO_CLIPPING_PLANES` for why removal is forbidden).
   */
  readonly clippingPlanes?: THREE.Plane[];
  /**
   * Quality mode's shadow participation (Phase 59): surface meshes cast
   * and receive. Default `false` — the boot raster has no shadow maps at
   * all; only the opt-in quality scene passes `true`.
   */
  readonly shadows?: boolean;
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
  shadows = false,
  clippingPlanes,
}: CadModelProps): ReactElement {
  const geometries = useRenderGeometry(projection, onSync);
  const materialProps: CadModelMaterialProps = {
    ...DEFAULT_MATERIAL,
    ...material,
  };
  // Section clipping (Phase 46): the host prop is ALWAYS defined — the
  // planes when any exist, `NO_CLIPPING_PLANES` otherwise — so toggling a
  // section off (or entering view mode) SWAPS the value instead of REMOVING
  // the prop. R3F's removed-prop reset writes a literal `0` for classes
  // whose constructor takes parameters (`MeshStandardMaterial`'s does);
  // a Number in `material.clippingPlanes` breaks three's local-clipping
  // state so badly the mesh stops drawing (see `NO_CLIPPING_PLANES`).
  // Empty is construction-identical to absent: three's clipping contract
  // reads `planes === null || planes.length === 0` as no clipping.
  const effectiveClippingPlanes: THREE.Plane[] =
    clippingPlanes !== undefined && clippingPlanes.length > 0
      ? clippingPlanes
      : NO_CLIPPING_PLANES;
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

  // Face-appearance overrides (Phase 59): per object, the overridden face
  // indices whose appearance differs from the object's own (body-level)
  // appearance — the per-face materials to mount as second-pass overlays.
  // Snapshot-scoped by construction: an override whose face index falls
  // outside the CURRENT synthetic grouping is skipped (rendered as nothing)
  // — never remapped onto an arbitrary neighbor.
  const faceOverrides = useMemo(() => {
    const map = new Map<
      RenderObjectId,
      readonly {
        readonly face: number;
        readonly appearance: RenderAppearance;
      }[]
    >();
    for (const [id, data] of renderData) {
      const overrides = data.object.faceAppearances;
      if (overrides === undefined) continue;
      const applicable = overrides.filter(
        (override) =>
          override.face < data.grouping.faces.length &&
          override.appearance !== data.object.appearance,
      );
      if (applicable.length === 0) continue;
      map.set(id, applicable);
    }
    return map;
  }, [renderData]);

  // Second-pass face-appearance geometries, the highlight lifecycle: built
  // only when the drawn geometry set or the overrides change, disposed with
  // the memo.
  const faceOverrideGeometries = useMemo(() => {
    const map = new Map<
      RenderObjectId,
      readonly {
        readonly face: number;
        readonly geometry: THREE.BufferGeometry;
      }[]
    >();
    for (const [id, overrides] of faceOverrides) {
      const base = geometries.get(id);
      const data = renderData.get(id);
      if (base === undefined || data === undefined) continue;
      if (
        !baseCoversSelectedFaces(
          base,
          data.grouping,
          overrides.map((override) => override.face),
        )
      ) {
        continue;
      }
      map.set(
        id,
        overrides.map((override) => ({
          face: override.face,
          geometry: buildFaceHighlightGeometry(base, data.grouping, [
            override.face,
          ]),
        })),
      );
    }
    return map;
  }, [faceOverrides, geometries, renderData]);

  // Placed-instance transforms (Phase 50): the projection carries each
  // instance's composed placement as DATA (rotation columns + translation,
  // world = transform x local); it is applied here as the mesh's OWN matrix
  // (`matrixAutoUpdate` off) so the shared soup uploads once and every
  // instance of a body reuses it. Rotation is rigid, so the kernel normals
  // stay valid without recomputation; instance bounds are already world,
  // so camera fitting reads the projection untouched.
  const instanceMatrices = useMemo(() => {
    const map = new Map<RenderObjectId, THREE.Matrix4>();
    for (const object of projection.objects) {
      const transform = object.occurrenceTransform;
      if (transform === undefined) continue;
      const r = transform.rotation;
      const t = transform.translation;
      map.set(
        object.id,
        new THREE.Matrix4().set(
          r[0],
          r[1],
          r[2],
          t[0],
          r[3],
          r[4],
          r[5],
          t[1],
          r[6],
          r[7],
          r[8],
          t[2],
          0,
          0,
          0,
          1,
        ),
      );
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

  useEffect(() => {
    return () => {
      for (const entries of faceOverrideGeometries.values()) {
        for (const entry of entries) {
          entry.geometry.dispose();
        }
      }
    };
  }, [faceOverrideGeometries]);

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
        const instanceMatrix = instanceMatrices.get(id);
        // Per-object appearance (Phase 59): the projection's record rides
        // OVER the host default material; the selection highlight still
        // wins (it spreads last below). Values are scene-space data —
        // metalness/roughness straight through, the sRGB hex as the color.
        const objectMaterial: CadModelMaterialProps &
          Partial<Pick<ThreeElements["meshStandardMaterial"], "map">> =
          data.object.appearance === undefined
            ? materialProps
            : {
                color: data.object.appearance.baseColor,
                metalness: data.object.appearance.metalness,
                roughness: data.object.appearance.roughness,
                ...(data.object.appearance.texture === undefined
                  ? {}
                  : { map: proceduralTexture(data.object.appearance.texture) }),
              };
        return (
          <mesh
            key={id}
            geometry={geometry}
            {...(instanceMatrix !== undefined
              ? { matrix: instanceMatrix, matrixAutoUpdate: false }
              : {})}
            {...(shadows ? { castShadow: true, receiveShadow: true } : {})}
            {...handlers}
          >
            <meshStandardMaterial
              // The key remounts the material when the stripe class
              // changes: three only consults `onBeforeCompile` when a
              // program is first acquired, so patching an
              // already-compiled material without a remount would render
              // the old program (the R3F property write never sets
              // `needsUpdate`).
              key={passes.surfaces.stripes === true ? "zebra" : "shaded"}
              clippingPlanes={effectiveClippingPlanes}
              colorWrite={passes.surfaces.colorWrite}
              depthWrite={passes.surfaces.depthWrite}
              // Phase 58 zebra: only the zebra pass attaches the shader
              // patch; every other mode's material is untouched, so the
              // boot raster and the render baselines stay their bytes.
              {...(passes.surfaces.stripes === true
                ? { onBeforeCompile: zebraShaderPatch }
                : {})}
              // Phase 48: an open sheet's soup renders BOTH sides — a
              // front-face-only material would eat every triangle viewed
              // from behind the sheet, and picking counts backface hits.
              side={
                data.object.openShell === true
                  ? THREE.DoubleSide
                  : THREE.FrontSide
              }
              {...objectMaterial}
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
          {...(instanceMatrices.has(id)
            ? {
                matrix: instanceMatrices.get(id),
                matrixAutoUpdate: false,
              }
            : {})}
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
          {...(instanceMatrices.has(id)
            ? {
                matrix: instanceMatrices.get(id),
                matrixAutoUpdate: false,
              }
            : {})}
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
      {[...faceOverrideGeometries].flatMap(([id, entries]) =>
        entries.map((entry) => {
          const override = faceOverrides
            .get(id)
            ?.find((candidate) => candidate.face === entry.face);
          return (
            <mesh
              key={`${id}-face-appearance-${String(entry.face)}`}
              geometry={entry.geometry}
              {...(instanceMatrices.has(id)
                ? {
                    matrix: instanceMatrices.get(id),
                    matrixAutoUpdate: false,
                  }
                : {})}
              renderOrder={1}
              raycast={NO_RAYCAST}
              {...(shadows ? { castShadow: true, receiveShadow: true } : {})}
            >
              <meshStandardMaterial
                clippingPlanes={effectiveClippingPlanes}
                color={override?.appearance.baseColor}
                metalness={override?.appearance.metalness}
                roughness={override?.appearance.roughness}
                {...(override?.appearance.texture === undefined
                  ? {}
                  : {
                      map: proceduralTexture(override.appearance.texture),
                    })}
                polygonOffset
                polygonOffsetFactor={CAD_FACE_HIGHLIGHT_POLYGON_OFFSET}
                polygonOffsetUnits={CAD_FACE_HIGHLIGHT_POLYGON_OFFSET}
              />
            </mesh>
          );
        }),
      )}
    </>
  );
}
